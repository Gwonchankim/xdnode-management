import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import { ensureGaSchema } from "../../../ga-schema";
import { attachmentDownloadHeaders, checkUploadRequest, uploadedLengthOk } from "../../../attachment-rules";
import { gaId, gaNotFound } from "../../../ga-server";

// general-affairs Design §4·§8(GD-10). 스캔본·사진·증빙. 메신저 첨부와 같은 규칙이다:
// 크기는 본문을 읽기 전에 판정하고(411·413), 형식은 확장자로 서버가 정하며(415, 인증서 비밀키 파일은 표에 없다),
// 다운로드는 nosniff·sandbox CSP·이미지 4종만 inline 이다. R2 키는 ga/<ownerType>/<ownerId>/<id> 이고 사용자 입력이 들어가지 않는다.
// 감사에는 파일 이름을 남기지 않는다. 다운로드는 감사하지 않는다(R-GA2, 접근은 총무 보기 권한으로 막는다).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket };
const db = bindings.DB;

type AttachmentRow = { id: string; owner_type: string; owner_id: string; file_name: string; content_type: string; size: number; storage_key: string; deleted_at: number | null };

async function ownerExists(ownerType: string, ownerId: string) {
  const table = ownerType === "ASSET" ? "ga_assets" : ownerType === "DOCUMENT" ? "ga_documents" : null;
  if (!table || !ownerId || ownerId.length > 80) return false;
  return Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(ownerId).first());
}

export async function PUT(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const params = new URL(request.url).searchParams;
  const ownerType = params.get("ownerType") ?? "";
  const ownerId = params.get("ownerId") ?? "";
  if (!(await ownerExists(ownerType, ownerId))) return gaNotFound("첨부할 항목");
  const requestHeaders = await headers();
  const check = checkUploadRequest(request.headers.get("content-length") ?? requestHeaders.get("content-length"), params.get("name") ?? "");
  if (!check.ok) return erpError(check.status, check.code, check.error);
  const bytes = await request.arrayBuffer();
  if (!uploadedLengthOk(bytes, check.declared)) return erpError(413, "PAYLOAD_TOO_LARGE", "파일은 25MB까지 올릴 수 있습니다.");
  const id = gaId("gaf");
  const key = `ga/${ownerType}/${ownerId}/${id}`;
  await bindings.HR_AUDIO.put(key, bytes, { httpMetadata: { contentType: check.contentType } });
  try {
    await db.prepare(`INSERT INTO ga_attachments (id, owner_type, owner_id, file_name, content_type, size, storage_key, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ownerType, ownerId, check.fileName, check.contentType, bytes.byteLength, key, principal.userId, Date.now()).run();
  } catch (error) {
    await bindings.HR_AUDIO.delete(key);
    throw error;
  }
  await writeErpAudit(db, { principal, module: "general", action: "GA_ATTACHMENT_UPLOADED", entityType: "GA_ATTACHMENT", entityId: id,
    after: { ownerType, ownerId, size: bytes.byteLength, contentType: check.contentType } });
  return Response.json({ attachment: { id, fileName: check.fileName, contentType: check.contentType, size: bytes.byteLength,
    isImage: check.contentType.startsWith("image/"), url: `/api/general/attachments?id=${encodeURIComponent(id)}` } }, { status: 201 });
}

async function loadAttachment(id: string | null) {
  if (!id || !id.startsWith("gaf_") || id.length > 80) return null;
  return db.prepare(`SELECT * FROM ga_attachments WHERE id = ? AND deleted_at IS NULL`).bind(id).first<AttachmentRow>();
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "read");
  if (authorization.response) return authorization.response;
  await ensureGaSchema(db);
  const attachment = await loadAttachment(new URL(request.url).searchParams.get("id"));
  if (!attachment || !(await ownerExists(attachment.owner_type, attachment.owner_id))) return gaNotFound("첨부 파일");
  const object = await bindings.HR_AUDIO.get(attachment.storage_key);
  if (!object) return gaNotFound("첨부 파일");
  return new Response(object.body, { headers: attachmentDownloadHeaders(attachment.file_name, attachment.content_type) });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeErpRequest(db, "general", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  await ensureGaSchema(db);
  const attachment = await loadAttachment(new URL(request.url).searchParams.get("id"));
  if (!attachment) return gaNotFound("첨부 파일");
  const result = await db.prepare(`UPDATE ga_attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(Date.now(), attachment.id).run();
  if (result.meta.changes) await bindings.HR_AUDIO.delete(attachment.storage_key);
  await writeErpAudit(db, { principal, module: "general", action: "GA_ATTACHMENT_DELETED", entityType: "GA_ATTACHMENT", entityId: attachment.id,
    after: { ownerType: attachment.owner_type, ownerId: attachment.owner_id } });
  return Response.json({ ok: true });
}
