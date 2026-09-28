import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { companyJobTitles, companyRanks } from "../../../hr-company-data";

type HrBindings = {
  DB: D1Database;
};

const db = (env as unknown as HrBindings).DB;

/** 인사기록카드에서 고르는 기준 목록 — 직무(JOB_TITLE)와 직위(RANK). 조직관리에서 더하고 빼며, 인사기록카드·처우 확정·
 *  입사 정보 수정이 모두 이 목록을 쓴다. 예전에는 화면 상태에만 담겨 새로고침하면 사라졌다.
 *  종류별로 표가 비어 있을 때만 회사 기준자료로 한 번 채운다 — 그 뒤로는 이 표가 기준이라 지운 항목이 되살아나지 않는다. */
type CatalogKind = "JOB_TITLE" | "RANK";

const CATALOGS: Record<CatalogKind, { label: string; seed: readonly string[]; protectedValues: string[]; column: "job_title" | "position" }> = {
  // 미지정은 빈값 대신 쓰는 자리이고, 조직장은 조직장 지정에서 자동으로 붙는 값이라 목록에서 뺄 수 없다.
  JOB_TITLE: { label: "직무", seed: companyJobTitles, protectedValues: ["미지정", "조직장"], column: "job_title" },
  RANK: { label: "직위", seed: companyRanks, protectedValues: [], column: "position" },
};

const MAX_VALUE_LENGTH = 30;

function kindOf(value: string | null): CatalogKind | null {
  return value === "JOB_TITLE" || value === "RANK" ? value : null;
}

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS hr_catalog_items (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, value)
  )`).run();
  const now = Date.now();
  for (const kind of Object.keys(CATALOGS) as CatalogKind[]) {
    const count = await db.prepare("SELECT COUNT(*) AS count FROM hr_catalog_items WHERE kind = ?").bind(kind).first<{ count: number }>();
    if (count?.count) continue;
    // 직무는 이 라우트 이전에 hr_job_titles 표를 잠시 썼다. 그 표에 내용이 있으면 사용자가 더한 항목까지 그대로 옮긴다.
    let seed: string[] = [...CATALOGS[kind].seed];
    if (kind === "JOB_TITLE") {
      const legacy = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hr_job_titles'").first<{ name: string }>();
      if (legacy) {
        const rows = await db.prepare("SELECT title FROM hr_job_titles ORDER BY sort_order, created_at").all<{ title: string }>();
        if (rows.results.length) seed = rows.results.map((row) => row.title);
      }
    }
    await db.batch(seed.map((value, index) => db.prepare(
      "INSERT OR IGNORE INTO hr_catalog_items (kind, value, sort_order, created_at) VALUES (?, ?, ?, ?)").bind(kind, value, index, now)));
  }
}

async function listValues(kind: CatalogKind) {
  const result = await db.prepare("SELECT value FROM hr_catalog_items WHERE kind = ? ORDER BY sort_order, created_at").bind(kind).all<{ value: string }>();
  return result.results.map((row) => row.value);
}

export async function GET(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  const kind = kindOf(new URL(request.url).searchParams.get("kind"));
  if (kind) return Response.json({ kind, values: await listValues(kind) });
  return Response.json({ JOB_TITLE: await listValues("JOB_TITLE"), RANK: await listValues("RANK") });
}

export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const payload = await request.json() as { kind?: unknown; value?: unknown };
  const kind = kindOf(typeof payload.kind === "string" ? payload.kind : null);
  if (!kind) return Response.json({ error: "목록 종류를 확인해 주세요." }, { status: 400 });
  const catalog = CATALOGS[kind];
  const value = typeof payload.value === "string" ? payload.value.trim() : "";
  if (!value) return Response.json({ error: `${catalog.label}명을 입력해 주세요.` }, { status: 400 });
  if (value.length > MAX_VALUE_LENGTH) return Response.json({ error: `${catalog.label}명은 ${MAX_VALUE_LENGTH}자를 넘을 수 없습니다.` }, { status: 400 });

  const existing = await db.prepare("SELECT value FROM hr_catalog_items WHERE kind = ? AND value = ?").bind(kind, value).first<{ value: string }>();
  if (existing) return Response.json({ error: `이미 있는 ${catalog.label}입니다.` }, { status: 409 });

  const last = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS max FROM hr_catalog_items WHERE kind = ?").bind(kind).first<{ max: number }>();
  await db.prepare("INSERT INTO hr_catalog_items (kind, value, sort_order, created_at) VALUES (?, ?, ?, ?)")
    .bind(kind, value, (last?.max ?? -1) + 1, Date.now()).run();

  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "hr",
    action: "CATALOG_ITEM_ADDED",
    entityType: "catalogItem",
    entityId: `${kind}:${value}`,
    before: null,
    after: { kind, value },
  });
  return Response.json({ kind, values: await listValues(kind) }, { status: 201 });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const url = new URL(request.url);
  const kind = kindOf(url.searchParams.get("kind"));
  const value = url.searchParams.get("value")?.trim() ?? "";
  if (!kind || !value) return Response.json({ error: "삭제할 항목을 확인해 주세요." }, { status: 400 });
  const catalog = CATALOGS[kind];
  if (catalog.protectedValues.includes(value)) return Response.json({ error: `「${value}」은 필수 항목이라 삭제할 수 없습니다.` }, { status: 400 });

  // 화면도 같은 검사를 하지만, 다른 사람이 그 사이 배정했을 수 있어 서버에서 다시 본다.
  const inUse = await db.prepare(`SELECT COUNT(*) AS count FROM hr_employee_records WHERE ${catalog.column} = ?`).bind(value).first<{ count: number }>();
  if (inUse?.count) return Response.json({ error: `「${value}」 ${catalog.label}를 쓰는 직원이 ${inUse.count}명 있어 삭제할 수 없습니다.` }, { status: 409 });

  const existing = await db.prepare("SELECT value FROM hr_catalog_items WHERE kind = ? AND value = ?").bind(kind, value).first<{ value: string }>();
  if (!existing) return Response.json({ kind, values: await listValues(kind) });

  await db.prepare("DELETE FROM hr_catalog_items WHERE kind = ? AND value = ?").bind(kind, value).run();
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "hr",
    action: "CATALOG_ITEM_REMOVED",
    entityType: "catalogItem",
    entityId: `${kind}:${value}`,
    before: { kind, value },
    after: null,
  });
  return Response.json({ kind, values: await listValues(kind) });
}
