import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import {
  CHAT_PIN_LIMIT, chatArchived, chatConflict, chatForbidden, chatNotFound, chatPinLimit, chatValidation, eventStatement, loadChannelAccess, messageDto,
  messageDtos, positiveInt, readJsonBody, unreadableBody, type ChatMessageRow, type ChatPinItem,
} from "../../../chat-server";

// messenger-enhancement Design §4.2 /api/chat/pins. ME-FR-10 채널 고정(공지). GET(chat:read), POST(chat:write + 채널 소유자 또는 관리자, ME-MD5).
// public·private 채널의 최상위 메시지만, 채널당 CHAT_PIN_LIMIT 개. 관리자라도 멤버가 아닌 비공개 채널은 404 다(R5 원칙).
// 변경은 message.edited(그 메시지의 pinnedAt) + channel.updated(pinCount) 로 알린다(ME-MD7, DD5). 감사한다(ME-MD9).
const db = (env as unknown as { DB: D1Database }).DB;

type PinRow = { message_id: number; pinned_by: string; pinned_at: number; pinned_by_name: string | null };

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const access = await loadChannelAccess(db, authorization.principal, new URL(request.url).searchParams.get("channelId"));
  if (!access) return chatNotFound();
  const rows = await db.prepare(`SELECT p.message_id, p.pinned_by, p.pinned_at, a.display_name AS pinned_by_name
    FROM chat_pins p JOIN chat_messages m ON m.id = p.message_id AND m.deleted_at IS NULL
      LEFT JOIN auth_accounts a ON a.id = p.pinned_by
    WHERE p.channel_id = ? ORDER BY p.pinned_at DESC, p.message_id DESC`).bind(access.channel.id).all<PinRow>();
  const messages = await messageDtos(db, rows.results.map((row) => Number(row.message_id)));
  const pins: ChatPinItem[] = rows.results.flatMap((row) => {
    const message = messages.get(Number(row.message_id));
    return message ? [{ message, pinnedBy: { accountId: row.pinned_by, name: row.pinned_by_name ?? "알 수 없는 사용자" }, pinnedAt: Number(row.pinned_at) }] : [];
  });
  return Response.json({ pins });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();
  const action = payload.action;
  if (action !== "PIN" && action !== "UNPIN") return chatValidation("요청한 동작을 확인해 주세요.", "action");
  const messageId = positiveInt(payload.messageId);
  if (messageId === null) return chatValidation("메시지를 확인해 주세요.", "messageId");

  const message = await db.prepare(`SELECT id, channel_id, thread_root_id, deleted_at FROM chat_messages WHERE id = ?`).bind(messageId)
    .first<Pick<ChatMessageRow, "id" | "channel_id" | "thread_root_id" | "deleted_at">>();
  if (!message) return chatNotFound();
  const access = await loadChannelAccess(db, principal, message.channel_id);
  if (!access) return chatNotFound();
  const { channel, member } = access;
  if (channel.kind !== "public" && channel.kind !== "private") return chatValidation("대화방에서는 고정할 수 없습니다.", "messageId");
  if (!principal.isAdmin && member?.role !== "owner") return chatForbidden("채널을 만든 사람이나 관리자만 고정할 수 있습니다.");
  if (channel.archived_at !== null) return chatArchived();
  if (message.thread_root_id !== null) return chatValidation("답글은 고정할 수 없습니다.", "messageId");
  if (message.deleted_at !== null) return chatConflict();

  const now = Date.now();
  if (action === "PIN") {
    // 한도는 INSERT 조건으로 건다(동시에 두 번 눌러도 넘지 않게). 이미 고정돼 있으면 그대로 성공이다.
    const already = await db.prepare(`SELECT 1 FROM chat_pins WHERE message_id = ?`).bind(messageId).first();
    if (!already) {
      const inserted = await db.prepare(`INSERT OR IGNORE INTO chat_pins (channel_id, message_id, pinned_by, pinned_at)
        SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM chat_pins p JOIN chat_messages m ON m.id = p.message_id AND m.deleted_at IS NULL
          WHERE p.channel_id = ?1) < ?5`).bind(channel.id, messageId, principal.accountId, now, CHAT_PIN_LIMIT).run();
      if (!inserted.meta?.changes) return chatPinLimit();
    }
  } else {
    await db.prepare(`DELETE FROM chat_pins WHERE channel_id = ? AND message_id = ?`).bind(channel.id, messageId).run();
  }
  await db.batch([
    eventStatement(db, { channelId: channel.id, kind: "message.edited", messageId, now }),
    eventStatement(db, { channelId: channel.id, kind: "channel.updated", now }),
  ]);
  await writeErpAudit(db, {
    principal, module: "chat", action: action === "PIN" ? "CHAT_MESSAGE_PINNED" : "CHAT_MESSAGE_UNPINNED", entityType: "CHAT_MESSAGE", entityId: String(messageId),
    after: { messageId, channelId: channel.id },
  });
  return Response.json({ message: await messageDto(db, messageId) });
}
