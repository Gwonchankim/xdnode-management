import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import {
  CHAT_REACTIONS, chatArchived, chatConflict, chatForbidden, chatNotFound, chatValidation, eventStatement, loadChannelAccess, messageDto, positiveInt,
  readJsonBody, unreadableBody, type ChatMessageRow,
} from "../../../chat-server";

// messenger-enhancement Design §4.2 POST /api/chat/reactions (chat:write). ME-FR-07 고정 8개 반응 토글(ME-MD4).
// 변경은 새 이벤트 종류 대신 message.edited(DTO 재전송)로 알린다(ME-MD7, DD5). edited_at 은 바꾸지 않으므로 '(수정됨)'이 뜨지 않는다.
// 남에게 보이는 변화라 감사한다(ME-MD9). 감사에는 이모지와 id 만 남긴다.
const db = (env as unknown as { DB: D1Database }).DB;

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();

  const messageId = positiveInt(payload.messageId);
  if (messageId === null) return chatValidation("메시지를 확인해 주세요.", "messageId");
  const emoji = payload.emoji;
  if (typeof emoji !== "string" || !(CHAT_REACTIONS as readonly string[]).includes(emoji)) return chatValidation("반응을 확인해 주세요.", "emoji");

  const message = await db.prepare(`SELECT id, channel_id, deleted_at FROM chat_messages WHERE id = ?`).bind(messageId)
    .first<Pick<ChatMessageRow, "id" | "channel_id" | "deleted_at">>();
  if (!message) return chatNotFound();
  const access = await loadChannelAccess(db, principal, message.channel_id);
  if (!access) return chatNotFound();
  if (access.channel.archived_at !== null) return chatArchived();
  if (message.deleted_at !== null) return chatConflict();
  if (!access.member) return chatForbidden("채널에 참여한 뒤 반응할 수 있습니다.");

  const now = Date.now();
  const inserted = await db.prepare(`INSERT OR IGNORE INTO chat_reactions (message_id, account_id, emoji, channel_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(messageId, principal.accountId, emoji, message.channel_id, now).run();
  const added = Boolean(inserted.meta?.changes);
  await db.batch([
    ...(added ? [] : [db.prepare(`DELETE FROM chat_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?`).bind(messageId, principal.accountId, emoji)]),
    eventStatement(db, { channelId: message.channel_id, kind: "message.edited", messageId, now }),
  ]);
  await writeErpAudit(db, {
    principal, module: "chat", action: added ? "CHAT_REACTION_ADDED" : "CHAT_REACTION_REMOVED", entityType: "CHAT_MESSAGE", entityId: String(messageId),
    after: { messageId, channelId: message.channel_id, emoji },
  });
  return Response.json({ message: await messageDto(db, messageId), added });
}
