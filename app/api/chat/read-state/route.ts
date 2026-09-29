import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { chatNotFound, chatValidation, loadChannelAccess, readJsonBody, unreadableBody, unreadSummary } from "../../../chat-server";

// Design §4.2.8 PUT /api/chat/read-state (chat:read). 읽음 위치는 MAX() 로만 전진한다.
// 이벤트와 감사를 남기지 않는다(남의 읽음이 poll 증분이 되지 않게, 읽을 때마다 감사 행이 쌓이지 않게).
// tests/erp-platform.test.mjs 의 "모든 쓰기 라우트는 writeErpAudit" 가드에서 이 파일만 예외다.
const db = (env as unknown as { DB: D1Database }).DB;

export async function PUT(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();
  const value = payload.lastReadMessageId;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return chatValidation("읽음 위치를 확인해 주세요.", "lastReadMessageId");
  const access = await loadChannelAccess(db, principal, payload.channelId);
  if (!access?.member) return chatNotFound();
  const channelId = access.channel.id;
  const max = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE channel_id = ?`).bind(channelId).first<{ id: number }>();
  const position = Math.min(value, Number(max?.id ?? 0));
  await db.prepare(`UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, ?), last_read_at = ?
    WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`).bind(position, Date.now(), channelId, principal.accountId).run();
  return Response.json({ unread: await unreadSummary(db, principal.accountId) });
}
