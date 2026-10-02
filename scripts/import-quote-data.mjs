// 옛 견적 툴 내보내기 → XDnode management 견적 탭 이전(quote-tool Design §9.2, QT-FR-03).
//
//   node scripts/import-quote-data.mjs --base http://127.0.0.1:3000 --export C:\xdm\work\quote-export-20261002
//        [--out report.json] [--dry-run] [--only <table>] [--no-template] [--cookie "xdm_session=…"] [--markers-out [path]]
//
// 입력은 옛 툴 저장소 tools/export_xdm_import.py 가 만든 폴더다(corpus.sqlite 사본, corpus_quote_json.jsonl, 카탈로그 JSON, template.xlsx, manifest.json).
// 로그인은 scripts/xdm-login.mjs 의 connectXdm(XDM_EMAIL·XDM_PASSWORD 또는 --cookie)이고, 비GET 에는 Origin 이 자동으로 붙는다. 관리자 계정이어야 한다.
//
// 안전장치
//   - 옛 툴의 실제 data 폴더(…\견적서 자동화\data)를 가리키거나 sqlite 옆에 -wal 파일이 있으면(살아 있는 DB) 거부한다.
//   - corpus.sqlite 는 immutable·readOnly 로 연다(사본 폴더에 -wal·-shm 을 만들지 않는다). sha256 이 manifest 와 다르면 거부한다.
//   - --dry-run 은 읽기·검증·묶음 나누기만 하고 서버에 아무것도 보내지 않는다.
//   - 화면·보고서에는 표 이름과 수·해시만 쓴다. 행 내용·고객명은 쓰지 않는다. --markers-out 파일(저장소 밖)만 예외이고 그 값도 출력하지 않는다.
// 같은 입력으로 다시 돌려도 행이 늘지 않는다(서버의 멱등 규칙). 불일치가 있으면 종료 코드 1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { connectXdm } from "./xdm-login.mjs";

const REPO = resolve(import.meta.dirname, "..");
const MAX_ROWS = 500;
const MAX_CHUNK_BYTES = 1_500_000;
const SNAPSHOT_PART_BYTES = 1_000_000;
const DEFAULT_MARKERS = "C:\\xdm\\secure\\quote-markers.json";
const SNAPSHOT_FILES = ["price_points.json", "pdf_quotes.json", "products_seed_raw.json"];
const TABLE_ORDER = ["corpus_files", "corpus_sheets", "corpus_items", "corpus_margin_items", "catalog_products", "catalog_legacy", "spec_library", "customers",
  "bom_library", "vocab", "issued", "price_log", "staff", "source_snapshots"];
const VERSION_SOURCE = { catalog_products: "catalog_v2", catalog_legacy: "catalog", spec_library: "catalog", customers: "catalog", vocab: "catalog", bom_library: "bom_library" };
const SOURCE_FILE = { catalog_v2: "catalog_v2.json", catalog: "catalog.json", bom_library: "bom_library.json" };
/** 표 → FINISH 가 대조하는 행 수 키. */
const COUNT_KEYS = {
  corpus_files: ["corpus_files"], corpus_sheets: ["corpus_sheets"], corpus_items: ["corpus_items"], corpus_margin_items: ["corpus_margin_items"],
  catalog_products: ["catalog_products"], catalog_legacy: ["catalog_legacy"], spec_library: ["spec_library"], customers: ["customers", "customer_orgs"],
  bom_library: ["bom_library"], issued: ["issued"], price_log: ["price_log"], staff: ["staff"],
};

class ImportError extends Error {}

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:3000", export: "", out: "", dryRun: false, only: "", template: true, cookie: "", markersOut: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ImportError(`${arg} 다음에 값이 필요합니다.`);
      index += 1;
      return value;
    };
    if (arg === "--base") options.base = next();
    else if (arg === "--export") options.export = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--only") options.only = next();
    else if (arg === "--no-template") options.template = false;
    else if (arg === "--cookie") options.cookie = next();
    else if (arg === "--markers-out") {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) { options.markersOut = value; index += 1; } else options.markersOut = DEFAULT_MARKERS;
    } else throw new ImportError(`알 수 없는 인자: ${arg}`);
  }
  if (!options.export) throw new ImportError("--export <내보내기 폴더> 가 필요합니다.");
  if (options.only && !TABLE_ORDER.includes(options.only) && options.only !== "template") throw new ImportError(`--only 는 ${[...TABLE_ORDER, "template"].join(", ")} 중 하나입니다.`);
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isInside = (child, parent) => {
  const a = resolve(child).toLowerCase();
  const b = resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/** 살아 있는 옛 툴 DB·저장소 안 경로를 거부한다. */
function refuseLive(exportDir) {
  const normalized = resolve(exportDir).toLowerCase().replaceAll("/", "\\");
  if (/\\견적서 자동화\\data(\\|$)/.test(normalized)) throw new ImportError("거부: 옛 툴의 실제 data 폴더입니다. tools/export_xdm_import.py 로 만든 내보내기 사본을 지정하세요.");
  if (existsSync(join(exportDir, "..", "quote_gen")) || existsSync(join(exportDir, "quote_gen"))) throw new ImportError("거부: 옛 툴 저장소 안의 폴더입니다.");
  if (isInside(exportDir, REPO)) throw new ImportError("거부: 내보내기 폴더는 이 저장소 밖이어야 합니다(고객 데이터).");
  const sqlite = join(exportDir, "corpus.sqlite");
  if (!existsSync(sqlite)) throw new ImportError("내보내기 폴더에 corpus.sqlite 가 없습니다.");
  if (existsSync(`${sqlite}-wal`) || existsSync(`${sqlite}-journal`)) throw new ImportError("거부: corpus.sqlite 옆에 -wal/-journal 파일이 있습니다(살아 있는 DB 일 수 있음).");
}

function openReadOnly(file) {
  // readOnly 만으로는 WAL 형식 파일 옆에 -wal·-shm 이 생긴다. immutable=1 이면 아무 파일도 만들지 않는다.
  const url = pathToFileURL(resolve(file));
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url, { readOnly: true });
}

function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

/** UTF-8 1,000,000바이트 이하 조각으로 코드 포인트 경계에서 자른다. BOM 도 그대로 둔다(조각을 이으면 원문 바이트와 같은 sha256). */
export function splitUtf8(bytes, limit = SNAPSHOT_PART_BYTES) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parts = [];
  let current = "";
  let size = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character, "utf8");
    if (size + length > limit && current) { parts.push(current); current = ""; size = 0; }
    current += character;
    size += length;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}

/** 내보내기 폴더를 읽어 표별 행·기대 수·원천 해시를 만든다(행 내용은 메모리에만). */
export function loadExport(exportDir) {
  refuseLive(exportDir);
  const manifest = readJson(exportDir, "manifest.json");
  const files = manifest?.files ?? {};
  const fileSha = (name) => {
    const path = join(exportDir, name);
    if (!existsSync(path)) throw new ImportError(`내보내기에 ${name} 이(가) 없습니다.`);
    const actual = sha256(readFileSync(path));
    if (files[name]?.sha256 && files[name].sha256 !== actual) throw new ImportError(`${name} 의 sha256 이 manifest 와 다릅니다.`);
    return actual;
  };
  const corpusSha = fileSha("corpus.sqlite");
  const db = openReadOnly(join(exportDir, "corpus.sqlite"));
  const tables = {};
  let lastLegacyIssuedId = null;
  try {
    const all = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));
    const quoteJson = new Map();
    for (const line of readFileSync(join(exportDir, "corpus_quote_json.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      quoteJson.set(entry.id, entry);
    }
    fileSha("corpus_quote_json.jsonl");
    tables.corpus_files = all("SELECT id, file, quote_date, customer_from_name, model_hint, contact_from_name, suffix, mtime FROM quotes ORDER BY id").map((row) => {
      const entry = quoteJson.get(row.id);
      return { ...row, quote_json: entry?.ok ? entry.quote_json : null, reverse_error: entry && !entry.ok ? String(entry.error ?? "Error").slice(0, 120) : entry ? null : "NotExported" };
    });
    tables.corpus_sheets = all("SELECT * FROM sheets ORDER BY id");
    tables.corpus_items = all("SELECT * FROM items ORDER BY id");
    tables.corpus_margin_items = all("SELECT * FROM margin_items ORDER BY id");
    tables.issued = all("SELECT * FROM issued_quotes ORDER BY id");
    tables.price_log = all("SELECT * FROM price_log ORDER BY id");
    lastLegacyIssuedId = db.prepare("SELECT MAX(id) AS n FROM issued_quotes").get().n ?? null;
    const sourceCounts = { quotes: tables.corpus_files.length, sheets: tables.corpus_sheets.length, items: tables.corpus_items.length,
      margin_items: tables.corpus_margin_items.length, issued_quotes: tables.issued.length, price_log: tables.price_log.length };
    for (const [name, count] of Object.entries(manifest?.tables ?? {})) {
      if (sourceCounts[name] !== undefined && sourceCounts[name] !== count) throw new ImportError(`${name} 행 수가 manifest 와 다릅니다.`);
    }
  } finally {
    db.close();
  }

  const versions = {};
  for (const [source, name] of Object.entries(SOURCE_FILE)) versions[source] = fileSha(name);
  const catalogV2 = readJson(exportDir, "catalog_v2.json");
  tables.catalog_products = catalogV2.products.map((product, ord) => ({ ...product, ord }));
  const catalog = readJson(exportDir, "catalog.json");
  tables.catalog_legacy = catalog.products.map((product, ord) => ({ ...product, ord }));
  tables.spec_library = Object.entries(catalog.spec_library ?? {}).map(([name, entry], ord) => ({ ord, name, spec: entry.spec, date: entry.date ?? null, category: entry.category ?? null }));
  tables.customers = [];
  for (const [org, contacts] of Object.entries(catalog.customers ?? {})) {
    for (const contact of contacts) tables.customers.push({ ord: tables.customers.length, org, contact: contact.contact ?? null, tel: contact.tel ?? null,
      email: contact.email ?? null, last_date: contact.last_date ?? null, n: contact.n ?? null });
  }
  tables.vocab = [catalog.vocab];
  tables.bom_library = readJson(exportDir, "bom_library.json").map((entry, ord) => ({ ...entry, ord }));
  fileSha("staff.json");
  tables.staff = readJson(exportDir, "staff.json").map((entry, sort) => ({ name: entry.name, tel: entry.tel ?? "", email: entry.email ?? "", sort }));

  const snapshotNames = [...SNAPSHOT_FILES];
  const normalizedDir = join(exportDir, "normalized");
  if (existsSync(normalizedDir)) for (const name of readdirSync(normalizedDir).sort()) snapshotNames.push(`normalized/${name}`);
  tables.source_snapshots = [];
  const snapshots = {};
  const snapshotParts = {};
  for (const name of snapshotNames) {
    const bytes = readFileSync(join(exportDir, ...name.split("/")));
    const version = fileSha(name);
    let parts;
    try {
      parts = splitUtf8(bytes);
    } catch {
      throw new ImportError(`${name} 이(가) UTF-8 이 아닙니다.`);
    }
    snapshots[name] = version;
    snapshotParts[name] = parts.length;
    parts.forEach((body, part) => tables.source_snapshots.push({ name, version, part, part_count: parts.length, body }));
  }

  const counts = {
    corpus_files: tables.corpus_files.length, corpus_sheets: tables.corpus_sheets.length, corpus_items: tables.corpus_items.length,
    corpus_margin_items: tables.corpus_margin_items.length, issued: tables.issued.length, price_log: tables.price_log.length,
    catalog_products: tables.catalog_products.length, catalog_legacy: tables.catalog_legacy.length, spec_library: tables.spec_library.length,
    customers: tables.customers.length, customer_orgs: new Set(tables.customers.map((row) => row.org)).size, bom_library: tables.bom_library.length,
    staff: new Set(tables.staff.map((row) => row.name.trim())).size,
  };
  const template = existsSync(join(exportDir, "template.xlsx")) ? readFileSync(join(exportDir, "template.xlsx")) : null;
  const reverse = { ok: tables.corpus_files.filter((row) => row.quote_json).length, failed: tables.corpus_files.filter((row) => !row.quote_json).length };
  const sourceFiles = Object.fromEntries(Object.entries(files).filter(([, info]) => typeof info?.sha256 === "string").map(([name, info]) => [name, info.sha256]));
  return { tables, counts, versions, snapshots, snapshotParts, lastLegacyIssuedId, template, templateSha: template ? sha256(template) : null,
    corpusSha, reverse, sourceFiles };
}

/** 500행 또는 1.5MB 중 먼저 닿는 쪽에서 끊는다. 스냅샷은 1행(1MB 조각)씩. */
export function chunk(table, rows) {
  if (table === "source_snapshots") return rows.map((row) => [row]);
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (current.length && (current.length >= MAX_ROWS || bytes + size > MAX_CHUNK_BYTES)) { chunks.push(current); current = []; bytes = 0; }
    current.push(row);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function writeMarkers(path, data) {
  if (isInside(path, REPO)) throw new ImportError("거부: 표지 파일은 저장소 밖에 둡니다.");
  const orgs = [...new Set(data.tables.customers.map((row) => String(row.org ?? "").trim()).filter((org) => org.length >= 3))];
  const step = Math.max(1, Math.floor(orgs.length / 20));
  const sample = orgs.filter((_, index) => index % step === 0).slice(0, 20);
  const phones = [...new Set(data.tables.staff.map((row) => String(row.tel ?? "").trim()).filter((tel) => tel.replace(/\D/g, "").length >= 9))];
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ createdAt: new Date().toISOString(), orgs: sample, phones }, null, 2)}\n`, "utf8");
  return { orgs: sample.length, phones: phones.length };
}

async function call(client, method, body) {
  const raw = JSON.stringify(body);
  const response = await client.fetch("/api/quote/import", { method, headers: { "Content-Type": "application/json" }, body: raw });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const where = body.action === "ROWS" ? ` (${body.table})` : "";
    throw new ImportError(`${body.action}${where} 실패: ${response.status} ${payload.code ?? ""} ${payload.error ?? ""}`.trim());
  }
  return payload;
}

async function main(argv) {
  const options = parseArgs(argv);
  const exportDir = resolve(options.export);
  const data = loadExport(exportDir);
  const selected = options.only ? TABLE_ORDER.filter((table) => table === options.only) : TABLE_ORDER;
  const plan = Object.fromEntries(selected.map((table) => [table, { rows: data.tables[table].length, chunks: chunk(table, data.tables[table]).length }]));
  const expected = Object.fromEntries(selected.flatMap((table) => (COUNT_KEYS[table] ?? []).map((key) => [key, data.counts[key]])));
  const snapshotsExpected = selected.includes("source_snapshots") ? data.snapshots : {};
  const summary = {
    export: exportDir, corpusSha256: data.corpusSha, versions: data.versions, lastLegacyIssuedId: data.lastLegacyIssuedId,
    reverse: data.reverse, expected, snapshotParts: data.snapshotParts, templateSha256: data.templateSha, plan,
  };
  if (options.markersOut) summary.markers = { path: options.markersOut, ...writeMarkers(options.markersOut, data) };

  if (options.dryRun) {
    const report = { createdAt: new Date().toISOString(), dryRun: true, ...summary };
    if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const client = await connectXdm(options.base, { cookie: options.cookie });
  const source = { files: data.sourceFiles, counts: expected, snapshots: snapshotsExpected, lastLegacyIssuedId: data.lastLegacyIssuedId };
  const { runId } = await call(client, "POST", { action: "BEGIN", source });
  console.error(`이전 실행 ${runId}`);
  const results = {};
  const activateSources = new Set(selected.map((table) => VERSION_SOURCE[table]).filter(Boolean));
  for (const table of selected) {
    const totals = { source: data.tables[table].length, inserted: 0, updated: 0, skipped: 0, skippedLegacyIds: [] };
    const version = VERSION_SOURCE[table] ? data.versions[VERSION_SOURCE[table]] : undefined;
    for (const rows of chunk(table, data.tables[table])) {
      const result = await call(client, "POST", { action: "ROWS", runId, table, ...(version ? { version } : {}), rows });
      totals.inserted += result.inserted;
      totals.updated += result.updated;
      totals.skipped += result.skipped;
      if (Array.isArray(result.skippedLegacyIds)) totals.skippedLegacyIds.push(...result.skippedLegacyIds);
    }
    if (!totals.skippedLegacyIds.length) delete totals.skippedLegacyIds;
    results[table] = totals;
    console.error(`  ${table}: ${totals.source}행 → 추가 ${totals.inserted}, 갱신 ${totals.updated}, 건너뜀 ${totals.skipped}`);
    // 카탈로그 표를 다 보낸 뒤(vocab 다음, 또는 --only 로 한 표만 보낸 뒤) 현재 버전을 바꿔 끼운다.
    if ((table === "vocab" || (options.only && VERSION_SOURCE[table])) && activateSources.size) {
      const versions = Object.fromEntries([...activateSources].map((key) => [key, data.versions[key]]));
      const activateExpected = Object.fromEntries(Object.entries(expected).filter(([key]) => ["catalog_products", "catalog_legacy", "spec_library", "customers", "customer_orgs", "bom_library"].includes(key)));
      await call(client, "POST", { action: "ACTIVATE", runId, versions, expected: activateExpected });
      console.error(`  카탈로그 현재 버전 바꿔 끼움: ${Object.keys(versions).join(", ")}`);
    }
  }
  let template = null;
  if (options.template && data.template && (!options.only || options.only === "template")) {
    const response = await client.fetch("/api/quote/import?part=template", {
      method: "PUT", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: data.template,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ImportError(`템플릿 업로드 실패: ${response.status} ${payload.code ?? ""}`);
    template = { key: payload.key, sha256: payload.sha256, bytes: payload.bytes, unchanged: payload.unchanged };
    console.error(`  템플릿: ${payload.key}${payload.unchanged ? " (변경 없음)" : ""}`);
  }
  const finish = await call(client, "POST", { action: "FINISH", runId });
  const tables = Object.fromEntries(Object.entries(results).map(([table, totals]) => {
    const keys = COUNT_KEYS[table] ?? [];
    return [table, { ...totals, app: keys.length ? Object.fromEntries(keys.map((key) => [key, finish.counts?.[key] ?? null])) : null }];
  }));
  const report = {
    createdAt: new Date().toISOString(), base: client.base, runId, status: finish.status, ...summary, tables,
    snapshotsMatch: finish.snapshots ?? {}, mismatches: finish.mismatches ?? [], template,
  };
  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ runId, status: finish.status, mismatches: (finish.mismatches ?? []).length, lastLegacyIssuedId: data.lastLegacyIssuedId,
    template: template?.key ?? null, ...(options.out ? { report: relative(process.cwd(), options.out) || options.out } : {}) }));
  return finish.status === "OK" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof ImportError ? error.message : `실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
