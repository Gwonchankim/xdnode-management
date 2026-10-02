import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import {
  COUNT_SQL, IMPORT_MAX_ROWS, SOURCE_COUNT_KEYS, SOURCE_KEYS, VERSIONED_TABLES, VERSION_RE, isImportTable, parseImportSource, planImportRows,
  type ImportSource, type SourceKey,
} from "../../../quote-import";
import {
  TEMPLATE_MAX_BYTES, TEMPLATE_PREFIX, quoteConflict, quoteValidation, readBytesCapped, readJsonCapped, readQuoteMeta, unsupportedMedia,
} from "../../../quote-server";
import { XLSX_MIME, inspectTemplate, sha256Hex, unzipTemplate } from "../../../quote-xlsx";

// quote-tool Design §3.2·§9.2 POST/PUT /api/quote/import (관리자 전용). 옛 툴 내보내기를 scripts/import-quote-data.mjs 가 청크로 보낸다.
//   BEGIN → ROWS(표별, ≤500행·2MB) → ACTIVATE(카탈로그 현재 버전 바꿔 끼우기) → FINISH(행 수·스냅샷 해시 대조)
//   PUT ?part=template → R2 quote/template/v{N}.xlsx + quote_meta 에 sha256(QT-Q2)
// 같은 입력을 다시 넣어도 행이 늘지 않는다(멱등, §9.2 표). 감사 행에는 건수·id·해시만 넣는다(행 내용·고객명 없음, QT-FR-17).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket };
const db = bindings.DB;
const ROWS_CAP = 2 * 1_048_576;

type RunRow = { id: string; status: string; source_json: string };

async function readRun(runId: unknown): Promise<{ run: RunRow; source: ImportSource } | null> {
  if (typeof runId !== "string" || !/^qir_[0-9a-f-]{36}$/.test(runId)) return null;
  const run = await db.prepare(`SELECT id, status, source_json FROM quote_import_runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!run) return null;
  try {
    const source = parseImportSource(JSON.parse(run.source_json));
    return source ? { run, source } : null;
  } catch {
    return null;
  }
}

async function countOf(key: string, versions: Partial<Record<SourceKey, string | null>>) {
  const spec = COUNT_SQL[key];
  if (!spec) return null;
  if (spec.source) {
    const version = versions[spec.source];
    if (!version) return 0;
    const row = await db.prepare(spec.sql).bind(version).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }
  const row = await db.prepare(spec.sql).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function currentVersions() {
  const meta = await readQuoteMeta(db, SOURCE_KEYS.map((key) => `version:${key}`));
  return Object.fromEntries(SOURCE_KEYS.map((key) => [key, meta.get(`version:${key}`) ?? null])) as Record<SourceKey, string | null>;
}

async function rows(principal: ErpPrincipal, body: Record<string, unknown>) {
  const found = await readRun(body.runId);
  if (!found) return quoteValidation("이전 실행을 찾을 수 없습니다.", "runId");
  if (found.run.status !== "RUNNING") return quoteConflict("이미 끝난 이전 실행입니다. BEGIN 부터 다시 해 주세요.");
  const table = body.table;
  if (!isImportTable(table)) return quoteValidation("알 수 없는 표입니다.", "table");
  if (!Array.isArray(body.rows) || body.rows.length > IMPORT_MAX_ROWS) return quoteValidation(`행 목록을 읽을 수 없습니다(한 번에 ${IMPORT_MAX_ROWS}행까지).`, "rows");
  const version = typeof body.version === "string" ? body.version : null;
  if (VERSIONED_TABLES[table] && (!version || !VERSION_RE.test(version))) return quoteValidation("version(원천 sha256)을 확인해 주세요.", "version");
  const now = Date.now();
  const plan = planImportRows(table, body.rows, { runId: found.run.id, now, version: VERSIONED_TABLES[table] ? version : null, newId: () => crypto.randomUUID() });
  if (!plan.ok) return quoteValidation(plan.index >= 0 ? `${plan.index + 1}번째 행: ${plan.error}` : plan.error, "rows");

  // 발행 행: 이미 있던 legacy_id 와 앱 행과 겹치는 dedup_key 를 먼저 본다(inserted·updated·skipped 구분, skipped legacy id 보고).
  let existingLegacy = new Set<number>();
  const dedupOwners = new Map<string, number | null>();
  if (table === "issued" || table === "price_log") {
    const ids = plan.statements.map((statement) => statement.legacyId).filter((id): id is number => typeof id === "number");
    const target = table === "issued" ? "quote_issued" : "quote_price_log";
    const existing = await db.prepare(`SELECT legacy_id FROM ${target} WHERE legacy_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all<{ legacy_id: number }>();
    existingLegacy = new Set(existing.results.map((row) => Number(row.legacy_id)));
  }
  if (table === "issued") {
    const keys = plan.statements.map((statement) => statement.dedupKey).filter((key): key is string => typeof key === "string");
    const owners = await db.prepare(`SELECT dedup_key, legacy_id FROM quote_issued WHERE dedup_key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys))
      .all<{ dedup_key: string; legacy_id: number | null }>();
    for (const row of owners.results) dedupOwners.set(row.dedup_key, row.legacy_id === null ? null : Number(row.legacy_id));
  }

  const results = plan.statements.length ? await db.batch(plan.statements.map((statement) => db.prepare(statement.sql).bind(...statement.binds))) : [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const skippedLegacyIds: number[] = [];
  results.forEach((result, index) => {
    const changes = Number(result.meta?.changes ?? 0);
    const statement = plan.statements[index];
    const existed = typeof statement.legacyId === "number" && existingLegacy.has(statement.legacyId);
    if (changes > 0 && existed) updated += 1;
    else if (changes > 0) inserted += 1;
    else {
      skipped += 1;
      if (table === "issued" && typeof statement.legacyId === "number" && statement.dedupKey && dedupOwners.has(statement.dedupKey)
        && dedupOwners.get(statement.dedupKey) !== statement.legacyId) skippedLegacyIds.push(statement.legacyId);
    }
  });
  const received = plan.statements.length;
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_IMPORTED", entityType: "QUOTE_IMPORT", entityId: found.run.id,
    after: { runId: found.run.id, table, received, inserted, updated, skipped },
  });
  return Response.json({ received, inserted, updated, skipped, ...(skippedLegacyIds.length ? { skippedLegacyIds } : {}) });
}

async function activate(principal: ErpPrincipal, body: Record<string, unknown>) {
  const found = await readRun(body.runId);
  if (!found) return quoteValidation("이전 실행을 찾을 수 없습니다.", "runId");
  if (found.run.status !== "RUNNING") return quoteConflict("이미 끝난 이전 실행입니다.");
  const versionsIn = body.versions && typeof body.versions === "object" && !Array.isArray(body.versions) ? body.versions as Record<string, unknown> : null;
  const expected = body.expected && typeof body.expected === "object" && !Array.isArray(body.expected) ? body.expected as Record<string, unknown> : {};
  if (!versionsIn) return quoteValidation("versions 를 확인해 주세요.", "versions");
  const versions: Partial<Record<SourceKey, string>> = {};
  for (const [key, value] of Object.entries(versionsIn)) {
    if (!(SOURCE_KEYS as readonly string[]).includes(key) || typeof value !== "string" || !VERSION_RE.test(value)) return quoteValidation("versions 를 확인해 주세요.", "versions");
    versions[key as SourceKey] = value;
  }
  const keys = Object.keys(versions) as SourceKey[];
  if (!keys.length) return quoteValidation("바꿔 끼울 원천이 없습니다.", "versions");
  const mismatches: Array<{ table: string; expected: number; actual: number }> = [];
  for (const source of keys) {
    for (const key of SOURCE_COUNT_KEYS[source]) {
      const want = expected[key];
      if (want === undefined) continue;
      const actual = await countOf(key, versions);
      if (typeof want !== "number" || actual !== want) mismatches.push({ table: key, expected: Number(want), actual: actual ?? -1 });
    }
    if (source === "catalog") {
      const vocab = await readQuoteMeta(db, [`vocab:${versions.catalog}`]);
      if (!vocab.size) mismatches.push({ table: "vocab", expected: 1, actual: 0 });
    }
  }
  if (mismatches.length) return quoteConflict("그 버전의 행 수가 기대와 다릅니다. 이전을 다시 확인해 주세요.", { mismatches });
  const now = Date.now();
  await db.batch(keys.map((source) => db.prepare(`INSERT INTO quote_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(`version:${source}`, versions[source], now)));
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_CATALOG_ACTIVATED", entityType: "QUOTE_IMPORT", entityId: found.run.id,
    after: { runId: found.run.id, versions },
  });
  return Response.json({ activated: versions });
}

async function finish(principal: ErpPrincipal, body: Record<string, unknown>) {
  const found = await readRun(body.runId);
  if (!found) return quoteValidation("이전 실행을 찾을 수 없습니다.", "runId");
  if (found.run.status !== "RUNNING") return quoteConflict("이미 끝난 이전 실행입니다.");
  const versions = await currentVersions();
  const counts: Record<string, number> = {};
  for (const key of Object.keys(COUNT_SQL)) counts[key] = (await countOf(key, versions)) ?? 0;
  const mismatches: Array<Record<string, unknown>> = [];
  for (const [key, expected] of Object.entries(found.source.counts)) {
    if (counts[key] !== expected) mismatches.push({ table: key, expected, actual: counts[key] ?? null });
  }
  // 스냅샷: 조각을 이어 sha256 을 다시 계산해 version 과 비교한다(QT-SC-06).
  const snapshots: Record<string, boolean> = {};
  for (const [name, version] of Object.entries(found.source.snapshots)) {
    const parts = await db.prepare(`SELECT part, part_count, body FROM quote_source_snapshots WHERE name = ?1 AND version = ?2 ORDER BY part`)
      .bind(name, version).all<{ part: number; part_count: number; body: string }>();
    const list = parts.results;
    const complete = list.length > 0 && list.length === Number(list[0].part_count) && list.every((row, index) => Number(row.part) === index);
    const ok = complete && await sha256Hex(list.map((row) => row.body).join("")) === version;
    snapshots[name] = ok;
    if (!ok) mismatches.push({ snapshot: name, parts: list.length });
  }
  const status = mismatches.length ? "MISMATCH" : "OK";
  const result = { counts, mismatches, snapshots, lastLegacyIssuedId: found.source.lastLegacyIssuedId, versions };
  const now = Date.now();
  const update = await db.prepare(`UPDATE quote_import_runs SET status = ?1, finished_at = ?2, result_json = ?3 WHERE id = ?4 AND status = 'RUNNING'`)
    .bind(status, now, JSON.stringify(result), found.run.id).run();
  if (!update.meta?.changes) return quoteConflict("이미 끝난 이전 실행입니다.");
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_IMPORT_FINISHED", entityType: "QUOTE_IMPORT", entityId: found.run.id,
    after: { runId: found.run.id, status, mismatchCount: mismatches.length },
  });
  return Response.json({ status, counts, mismatches, snapshots, lastLegacyIssuedId: found.source.lastLegacyIssuedId });
}

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "admin");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const read = await readJsonCapped(request, ROWS_CAP);
  if (read.response) return read.response;
  const body = read.body;
  switch (body.action) {
    case "BEGIN": {
      const source = parseImportSource(body.source);
      if (!source) return quoteValidation("이전 원천 요약(source)을 확인해 주세요.", "source");
      const runId = `qir_${crypto.randomUUID()}`;
      await db.prepare(`INSERT INTO quote_import_runs (id, started_at, finished_at, actor_account_id, source_json, result_json, status)
        VALUES (?1, ?2, NULL, ?3, ?4, NULL, 'RUNNING')`).bind(runId, Date.now(), principal.userId, JSON.stringify(source)).run();
      await writeErpAudit(db, {
        principal, module: "quote", action: "QUOTE_IMPORT_STARTED", entityType: "QUOTE_IMPORT", entityId: runId,
        after: { runId, tables: Object.keys(source.counts) },
      });
      return Response.json({ runId });
    }
    case "ROWS": return rows(principal, body);
    case "ACTIVATE": return activate(principal, body);
    case "FINISH": return finish(principal, body);
    default: return quoteValidation("알 수 없는 요청입니다.", "action");
  }
}

/** 템플릿 업로드(?part=template). sha 가 같으면 R2 를 건드리지 않고 unchanged:true. 바뀌면 v{N+1} 로 올린다(§8). */
export async function PUT(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "admin");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  if (new URL(request.url).searchParams.get("part") !== "template") return quoteValidation("알 수 없는 업로드입니다.", "part");
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type && type !== XLSX_MIME && type !== "application/octet-stream") return unsupportedMedia("견적서 양식은 xlsx 파일만 올릴 수 있습니다.");
  const read = await readBytesCapped(request, TEMPLATE_MAX_BYTES);
  if (read.response) return read.response;
  const files = unzipTemplate(read.bytes);
  if (!files) return unsupportedMedia("견적서 양식은 xlsx 파일만 올릴 수 있습니다.");
  const check = inspectTemplate(files);
  if (!check.ok) return erpError(400, "TEMPLATE_INVALID", "견적서 양식의 구조가 예상과 다릅니다(시트 이름·셀 위치를 확인해 주세요).");
  const sha256 = await sha256Hex(read.bytes);
  const bytes = read.bytes.byteLength;
  const meta = await readQuoteMeta(db, ["template:key", "template:sha256"]);
  const currentKey = meta.get("template:key") ?? null;
  if (currentKey && meta.get("template:sha256") === sha256 && await bindings.HR_AUDIO.get(currentKey)) {
    return Response.json({ key: currentKey, sha256, bytes, unchanged: true });
  }
  const currentVersion = Number(/\/v(\d+)\.xlsx$/.exec(currentKey ?? "")?.[1] ?? 0);
  const key = `${TEMPLATE_PREFIX}v${currentVersion + 1}.xlsx`;
  const body = read.bytes.buffer.slice(read.bytes.byteOffset, read.bytes.byteOffset + bytes);
  await bindings.HR_AUDIO.put(key, body, { httpMetadata: { contentType: XLSX_MIME }, customMetadata: { sha256 } });
  const now = Date.now();
  await db.batch([
    ["template:key", key], ["template:sha256", sha256], ["template:bytes", String(bytes)],
  ].map(([name, value]) => db.prepare(`INSERT INTO quote_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(name, value, now)));
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_TEMPLATE_UPLOADED", entityType: "QUOTE_TEMPLATE", entityId: key,
    after: { key, sha256, bytes },
  });
  return Response.json({ key, sha256, bytes, unchanged: false });
}
