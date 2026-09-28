import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../erp-platform";

type Bindings = { DB: D1Database; HR_AUDIO: R2Bucket };
const bindings = env as unknown as Bindings;
const db = bindings.DB;

type DocumentRow = {
  id: string; module: string; entity_type: string; entity_id: string; category: string; version: number;
  file_name: string; content_type: string; storage_key: string; uploaded_by: string; created_at: number; deleted_at: number | null;
};

// 문서를 둘 수 있는 모듈. 재무·영업이 없어져(D2) hr·recruitment만 남는다. 그 밖의 module 로 남은
// 과거 행(finance·sales)은 관리자에게도 404다(fail closed, Design §4.3.2).
// R3(§4.3.2, 부록 B #27): 두 모듈 모두 hr 탭이므로 인가는 메서드마다 리터럴 hr:<action> 으로 가장 먼저 하고,
// 그다음에 행 조회·폼·본문을 읽는다. 행이 있다는 사실은 hr 보기 이상인 사용자에게만 드러난다. 감사 module 은 행의 module 이다.
type DocumentModule = "hr" | "recruitment";
const DOCUMENT_MODULES: ReadonlySet<DocumentModule> = new Set<DocumentModule>(["hr", "recruitment"]);
const isDocumentModule = (value: unknown): value is DocumentModule =>
  typeof value === "string" && DOCUMENT_MODULES.has(value as DocumentModule);
const allowedTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png", "image/jpeg", "text/plain", "text/csv",
]);

async function ensureSchema() {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS erp_documents (
      id TEXT PRIMARY KEY NOT NULL, module TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      category TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, file_name TEXT NOT NULL,
      content_type TEXT NOT NULL, storage_key TEXT NOT NULL, uploaded_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, deleted_at INTEGER
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_erp_documents_entity ON erp_documents(entity_type, entity_id)"),
  ]);
}

const toDocument = (row: DocumentRow) => ({
  id: row.id, module: row.module, entityType: row.entity_type, entityId: row.entity_id,
  category: row.category, version: row.version, fileName: row.file_name, contentType: row.content_type,
  uploadedBy: row.uploaded_by, createdAt: row.created_at,
  downloadUrl: `/api/documents?downloadId=${encodeURIComponent(row.id)}`,
});

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const url = new URL(request.url);
  const downloadId = url.searchParams.get("downloadId")?.trim();
  if (downloadId) {
    const row = await db.prepare("SELECT * FROM erp_documents WHERE id = ? AND deleted_at IS NULL")
      .bind(downloadId).first<DocumentRow>();
    if (!row || !isDocumentModule(row.module)) return new Response("문서를 찾을 수 없습니다.", { status: 404 });
    const object = await bindings.HR_AUDIO.get(row.storage_key);
    if (!object) return new Response("문서 원본을 찾을 수 없습니다.", { status: 404 });
    await writeErpAudit(db, { principal: authorization.principal, module: row.module, action: "DOCUMENT_DOWNLOADED", entityType: row.entity_type, entityId: row.entity_id, after: { documentId: row.id, fileName: row.file_name, version: row.version } });
    const encodedName = encodeURIComponent(row.file_name);
    return new Response(object.body, { headers: { "Content-Type": row.content_type, "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`, "Cache-Control": "private, no-store" } });
  }

  const moduleName = url.searchParams.get("module")?.trim() ?? "";
  const entityType = url.searchParams.get("entityType")?.trim() ?? "";
  const entityId = url.searchParams.get("entityId")?.trim() ?? "";
  if (!isDocumentModule(moduleName) || !entityType || !entityId) return Response.json({ error: "문서 모듈과 대상 정보가 필요합니다." }, { status: 400 });
  const result = await db.prepare(`SELECT * FROM erp_documents
    WHERE module = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
    ORDER BY category, version DESC, created_at DESC`).bind(moduleName, entityType, entityId).all<DocumentRow>();
  return Response.json({ documents: result.results.map(toDocument) });
}

export async function POST(request: Request) {
  // 폼을 읽기 전에 인가한다. hr·recruitment 는 같은 hr 탭이라 리터럴 hr:write 한 번으로 충분하다(R3, 부록 C #20의 R1 임시 이중 인가 대체).
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  }
  const moduleName = String(form.get("module") ?? "");
  const entityType = String(form.get("entityType") ?? "").trim();
  const entityId = String(form.get("entityId") ?? "").trim();
  const category = String(form.get("category") ?? "").trim();
  const file = form.get("file");
  if (!isDocumentModule(moduleName) || !entityType || !entityId || !category || !(file instanceof File && file.size)) {
    return Response.json({ error: "문서 대상·분류·파일이 필요합니다." }, { status: 400 });
  }
  if (file.size > 25 * 1024 * 1024) return Response.json({ error: "파일은 25MB 이하만 저장할 수 있습니다." }, { status: 413 });
  const contentType = file.type || "application/octet-stream";
  if (!allowedTypes.has(contentType)) return Response.json({ error: "PDF, DOCX, XLSX, PNG, JPG, TXT, CSV 파일만 저장할 수 있습니다." }, { status: 415 });

  const latest = await db.prepare(`SELECT MAX(version) AS version FROM erp_documents
    WHERE module = ? AND entity_type = ? AND entity_id = ? AND category = ?`)
    .bind(moduleName, entityType, entityId, category).first<{ version: number | null }>();
  const version = (latest?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const storageKey = `erp-documents/${moduleName}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/${id}.${extension}`;
  await bindings.HR_AUDIO.put(storageKey, await file.arrayBuffer(), { httpMetadata: { contentType } });
  const now = Date.now();
  try {
    await db.prepare(`INSERT INTO erp_documents
      (id, module, entity_type, entity_id, category, version, file_name, content_type, storage_key, uploaded_by, created_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .bind(id, moduleName, entityType, entityId, category, version, file.name.slice(0, 240), contentType, storageKey, authorization.principal.employeeId, now).run();
  } catch (error) {
    await bindings.HR_AUDIO.delete(storageKey);
    throw error;
  }
  const document = { id, module: moduleName, entityType, entityId, category, version, fileName: file.name.slice(0, 240), contentType, uploadedBy: authorization.principal.employeeId, createdAt: now, downloadUrl: `/api/documents?downloadId=${encodeURIComponent(id)}` };
  await writeErpAudit(db, { principal: authorization.principal, module: moduleName, action: "DOCUMENT_UPLOADED", entityType, entityId, after: document });
  return Response.json({ document }, { status: 201 });
}

// 이미 등록된 문서의 분류만 바꾼다. 원본 파일과 등록 이력은 건드리지 않는다.
export async function PATCH(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  let body: { id?: unknown; category?: unknown };
  try {
    body = await request.json() as { id?: unknown; category?: unknown };
  } catch {
    return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const category = typeof body?.category === "string" ? body.category.trim().slice(0, 60) : "";
  if (!id || !category) return Response.json({ error: "문서와 분류가 필요합니다." }, { status: 400 });

  const row = await db.prepare("SELECT * FROM erp_documents WHERE id = ? AND deleted_at IS NULL").bind(id).first<DocumentRow>();
  if (!row || !isDocumentModule(row.module)) return Response.json({ error: "수정할 문서를 찾을 수 없습니다." }, { status: 404 });
  if (row.category === category) return Response.json({ document: toDocument(row) });

  // 버전은 (대상, 분류)별로 매겨진다. 분류를 옮기면 옮겨간 분류 기준으로 번호를 다시 받아야
  // 같은 분류 안에서 번호가 겹치지 않는다.
  const latest = await db.prepare(`SELECT MAX(version) AS version FROM erp_documents
    WHERE module = ? AND entity_type = ? AND entity_id = ? AND category = ? AND deleted_at IS NULL`)
    .bind(row.module, row.entity_type, row.entity_id, category).first<{ version: number | null }>();
  const version = (latest?.version ?? 0) + 1;

  await db.prepare("UPDATE erp_documents SET category = ?, version = ? WHERE id = ?").bind(category, version, id).run();
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: row.module,
    action: "DOCUMENT_CATEGORY_CHANGED",
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: { documentId: id, fileName: row.file_name, category: row.category, version: row.version },
    after: { documentId: id, fileName: row.file_name, category, version },
  });
  return Response.json({ document: toDocument({ ...row, category, version }) });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "delete");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  let body: { id?: unknown };
  try {
    body = await request.json() as { id?: unknown };
  } catch {
    return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const row = id ? await db.prepare("SELECT * FROM erp_documents WHERE id = ? AND deleted_at IS NULL").bind(id).first<DocumentRow>() : null;
  if (!row || !isDocumentModule(row.module)) return Response.json({ error: "삭제할 문서를 찾을 수 없습니다." }, { status: 404 });
  const deletedAt = Date.now();
  await db.prepare("UPDATE erp_documents SET deleted_at = ? WHERE id = ?").bind(deletedAt, id).run();
  await writeErpAudit(db, { principal: authorization.principal, module: row.module, action: "DOCUMENT_SOFT_DELETED", entityType: row.entity_type, entityId: row.entity_id, before: toDocument(row), after: { deletedAt }, reason: "원본 파일은 복구를 위해 보존" });
  return Response.json({ id, deletedAt });
}
