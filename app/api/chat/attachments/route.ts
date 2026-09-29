import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import {
  CHAT_ATTACHMENT_MAX_BYTES, attachmentDto, attachmentKey, attachmentTypeOf, chatArchived, chatForbidden, chatNotFound, chatValidation,
  cleanFileName, contentDisposition, loadChannelAccess, newAttachmentId, type ChatAttachmentRow,
} from "../../../chat-server";

// Design §4.2.8·§7.8 채팅 첨부. PUT(chat:write + 멤버, raw body), GET(chat:read + 멤버), DELETE(chat:write + 업로더, 전송 전만).
// 크기는 본문을 읽기 전에 Content-Length 로 판정하고(411·413), 읽은 뒤 실제 길이로 다시 본다. 413 경로에서는 R2 가 바뀌지 않는다.
// content_type 은 서버가 확장자로 정한다. R2 키는 서버가 만든 chat/<channelId>/<attachmentId> 이고 사용자 입력은 들어가지 않는다.
// 감사에는 파일 이름을 남기지 않는다.
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

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const attachment = await loadAttachment(new URL(request.url).searchParams.get("id"));
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
