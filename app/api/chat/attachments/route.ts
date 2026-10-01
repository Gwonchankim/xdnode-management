import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";
import {
  CHAT_ATTACHMENT_MAX_BYTES, attachmentDto, attachmentKey, attachmentTypeOf, chatArchived, chatForbidden, chatNotFound, chatValidation,
  cleanFileName, contentDisposition, loadChannelAccess, newAttachmentId, type ChatAttachmentRow, type ChatFileItem,
} from "../../../chat-server";

// Design §4.2.8·§7.8 채팅 첨부. PUT(chat:write + 멤버, raw body), GET(chat:read + 멤버), DELETE(chat:write + 업로더, 전송 전만).
// 크기는 본문을 읽기 전에 Content-Length 로 판정하고(411·413), 읽은 뒤 실제 길이로 다시 본다. 413 경로에서는 R2 가 바뀌지 않는다.
// content_type 은 서버가 확장자로 정한다. R2 키는 서버가 만든 chat/<channelId>/<attachmentId> 이고 사용자 입력은 들어가지 않는다.
// 감사에는 파일 이름을 남기지 않는다.
// messenger-enhancement ME-FR-12: GET ?channelId= 는 그 채널의 파일 목록이다(내려받기와 같은 멤버 조건, 지워진 메시지의 첨부 제외).
const bindings = env as unknown as { DB: D1Database; HR_AUDIO: R2Bucket };
const db = bindings.DB;

const tooLarge = () => erpError(413, "PAYLOAD_TOO_LARGE", "파일은 25MB까지 올릴 수 있습니다.");

export async function PUT(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const params = new URL(request.url).searchParams;

  const access = await loadChannelAccess(db, principal, params.get("channelId"));
  if (!access) return chatNotFound();
  if (!access.member) return chatForbidden("채널에 참여한 뒤 올려 주세요.");
  if (access.channel.archived_at !== null) return chatArchived();

  const requestHeaders = await headers();
  const declaredText = request.headers.get("content-length") ?? requestHeaders.get("content-length");
  if (!declaredText || !/^\d{1,12}$/.test(declaredText.trim())) return erpError(411, "LENGTH_REQUIRED", "파일 크기를 확인할 수 없습니다.");
  const declared = Number(declaredText.trim());
  if (declared > CHAT_ATTACHMENT_MAX_BYTES) return tooLarge();

  let rawName = params.get("name") ?? "";
  try { rawName = decodeURIComponent(rawName); } catch { /* 이미 디코드된 이름 */ }
  const fileName = cleanFileName(rawName);
  const type = fileName ? attachmentTypeOf(fileName) : null;
  if (!type) return erpError(415, "UNSUPPORTED_MEDIA_TYPE", "올릴 수 없는 파일 형식입니다.");
  if (declared === 0) return chatValidation("빈 파일은 올릴 수 없습니다.");

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== declared || bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) return tooLarge();

  const id = newAttachmentId();
  const key = attachmentKey(access.channel.id, id);
  await bindings.HR_AUDIO.put(key, bytes, { httpMetadata: { contentType: type.contentType } });
  const now = Date.now();
  try {
    await db.prepare(`INSERT INTO chat_attachments (id, channel_id, message_id, uploader_account_id, file_name, content_type, size, storage_key, created_at, deleted_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`).bind(id, access.channel.id, principal.accountId, fileName, type.contentType, bytes.byteLength, key, now).run();
  } catch (error) {
    await bindings.HR_AUDIO.delete(key);
    throw error;
  }
  await writeErpAudit(db, { principal, module: "chat", action: "CHAT_ATTACHMENT_UPLOADED", entityType: "CHAT_ATTACHMENT", entityId: id,
    after: { attachmentId: id, channelId: access.channel.id, size: bytes.byteLength, contentType: type.contentType } });
  return Response.json({ attachment: attachmentDto({ id, fileName, size: bytes.byteLength, contentType: type.contentType }) }, { status: 201 });
}

async function loadAttachment(id: string | null) {
  if (!id || !id.startsWith("att_") || id.length > 80) return null;
  return db.prepare(`SELECT * FROM chat_attachments WHERE id = ?`).bind(id).first<ChatAttachmentRow>();
}

const FILES_PAGE = 50;
const FILES_CURSOR = /^(\d{1,15})_(att_[A-Za-z0-9-]{1,76})$/;

/** 최신순 50개씩. 커서는 "<createdAt>_<attachmentId>"(같은 시각의 첨부도 빠지지 않게). */
async function listFiles(principal: ErpPrincipal, params: URLSearchParams) {
  const access = await loadChannelAccess(db, principal, params.get("channelId"));
  if (!access) return chatNotFound();
  if (!access.member) return chatForbidden("채널에 참여한 뒤 볼 수 있습니다.");
  const before = params.get("before");
  const cursor = before === null ? null : FILES_CURSOR.exec(before);
  if (before !== null && !cursor) return chatValidation("before 값을 확인해 주세요.", "before");
  const rows = await db.prepare(`SELECT t.id, t.file_name, t.size, t.content_type, t.created_at, t.message_id, m.thread_root_id, a.display_name AS uploader_name
    FROM chat_attachments t
      JOIN chat_messages m ON m.id = t.message_id AND m.deleted_at IS NULL
      LEFT JOIN auth_accounts a ON a.id = t.uploader_account_id
    WHERE t.channel_id = ?1 AND t.deleted_at IS NULL AND t.message_id IS NOT NULL
      AND (?2 IS NULL OR t.created_at < ?2 OR (t.created_at = ?2 AND t.id < ?3))
    ORDER BY t.created_at DESC, t.id DESC LIMIT ?4`)
    .bind(access.channel.id, cursor ? Number(cursor[1]) : null, cursor ? cursor[2] : "", FILES_PAGE + 1)
    .all<{ id: string; file_name: string; size: number; content_type: string; created_at: number; message_id: number; thread_root_id: number | null; uploader_name: string | null }>();
  const page = rows.results.slice(0, FILES_PAGE);
  const files: ChatFileItem[] = page.map((row) => ({
    attachment: attachmentDto({ id: row.id, fileName: row.file_name, size: row.size, contentType: row.content_type }),
    messageId: Number(row.message_id), threadRootId: row.thread_root_id === null ? null : Number(row.thread_root_id),
    uploaderName: row.uploader_name ?? "알 수 없는 사용자", createdAt: Number(row.created_at),
  }));
  const last = page[page.length - 1];
  return Response.json({ files, nextBefore: rows.results.length > FILES_PAGE && last ? `${Number(last.created_at)}_${last.id}` : null });
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const params = new URL(request.url).searchParams;
  if (params.has("channelId")) {
    if (params.has("id")) return chatValidation("id·channelId 가운데 하나만 보내 주세요.");
    return listFiles(principal, params);
  }
  const attachment = await loadAttachment(params.get("id"));
  if (!attachment || attachment.deleted_at !== null) return chatNotFound();
  const access = await loadChannelAccess(db, principal, attachment.channel_id);
  if (!access) return chatNotFound();
  if (!access.member) return chatForbidden("채널에 참여한 뒤 받을 수 있습니다.");
  if (attachment.message_id === null) {
    if (attachment.uploader_account_id !== principal.accountId) return chatNotFound();
  } else {
    const message = await db.prepare(`SELECT deleted_at FROM chat_messages WHERE id = ?`).bind(attachment.message_id).first<{ deleted_at: number | null }>();
    if (!message || message.deleted_at !== null) return chatNotFound();
  }
  const object = await bindings.HR_AUDIO.get(attachment.storage_key);
  if (!object) return chatNotFound();
  const inline = attachmentTypeOf(attachment.file_name)?.inline === true && attachment.content_type.startsWith("image/");
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.content_type,
      "Content-Disposition": contentDisposition(attachment.file_name, inline),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const attachment = await loadAttachment(new URL(request.url).searchParams.get("id"));
  if (!attachment || attachment.deleted_at !== null || attachment.uploader_account_id !== principal.accountId) return chatNotFound();
  const access = await loadChannelAccess(db, principal, attachment.channel_id);
  if (!access) return chatNotFound();
  if (attachment.message_id !== null) return chatValidation("이미 보낸 첨부는 메시지를 삭제해 지워 주세요.");
  const result = await db.prepare(`UPDATE chat_attachments SET deleted_at = ? WHERE id = ? AND message_id IS NULL AND deleted_at IS NULL`)
    .bind(Date.now(), attachment.id).run();
  if (result.meta.changes) await bindings.HR_AUDIO.delete(attachment.storage_key);
  await writeErpAudit(db, { principal, module: "chat", action: "CHAT_ATTACHMENT_DELETED", entityType: "CHAT_ATTACHMENT", entityId: attachment.id,
    after: { attachmentId: attachment.id, channelId: attachment.channel_id } });
  return Response.json({ ok: true });
}
