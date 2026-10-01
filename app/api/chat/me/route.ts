import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import {
  CHAT_BOOKMARK_LIMIT, CHAT_NOTIFY_LEVELS, chatConflict, chatNotFound, chatValidation, loadChannelAccess, messageDtos, positiveInt, readJsonBody,
  unreadableBody, unreadSummary, type ChatActivityItem, type ChatBookmarkItem, type ChatActivityKind, type ChatChannelKind, type ChatMessageRow, type ChatNotifyLevel,
} from "../../../chat-server";

// messenger-enhancement Design §4.2 /api/chat/me (chat:read). 나만 보는 개인 상태: 알림 수준·스레드 읽음·활동함(M2), 북마크(M4).
// read-state 와 같은 이유로 감사하지 않는다(ME-MD9, DD14). tests/erp-platform.test.mjs 의 감사 예외 목록에 이 파일이 있다.
// 메시지·채널 id 를 받는 모든 동작은 loadChannelAccess 를 거친다. 볼 수 없는 대화는 없는 것과 같은 404 다.
const db = (env as unknown as { DB: D1Database }).DB;

const ACTIVITY_DAYS = 30;
const ACTIVITY_LIMIT = 100;

type ActivityRow = { id: number; kind: ChatActivityKind; unread: number; channel_id: string; channel_kind: ChatChannelKind; channel_name: string };

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const accountId = authorization.principal.accountId;
  const view = new URL(request.url).searchParams.get("view");
  if (view === "activity") return Response.json({ items: await activity(accountId) });
  if (view === "bookmarks") return Response.json({ bookmarks: await bookmarks(accountId) });
  return chatValidation("view 값을 확인해 주세요.", "view");
}

/**
 * ME-FR-05 활동함: 최근 30일, 내가 현재 멤버인 대화만.
 * (a) 나를 멘션했거나 @channel 인 글. 안 읽음 판정은 unreadSummary 와 같은 채널 읽음 위치다.
 * (b) 참여 스레드(chat_thread_reads 행)의 남이 쓴 답글. (a)에 이미 든 답글은 뺀다. 안 읽음은 스레드 읽음 위치다.
 */
async function activity(accountId: string): Promise<ChatActivityItem[]> {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const mine = `SELECT 1 FROM chat_mentions n WHERE n.message_id = m.id AND n.account_id = ?1`;
  const rows = await db.prepare(`SELECT * FROM (
      SELECT m.id AS id, CASE WHEN EXISTS (${mine}) THEN 'mention' ELSE 'channel_mention' END AS kind,
        CASE WHEN m.id > mem.last_read_message_id THEN 1 ELSE 0 END AS unread,
        c.id AS channel_id, c.kind AS channel_kind, c.name AS channel_name
      FROM chat_messages m
        JOIN chat_members mem ON mem.channel_id = m.channel_id AND mem.account_id = ?1 AND mem.left_at IS NULL
        JOIN chat_channels c ON c.id = m.channel_id
      WHERE m.deleted_at IS NULL AND m.author_account_id != ?1 AND m.created_at >= ?2
        AND (m.mention_channel = 1 OR EXISTS (${mine}))
      UNION ALL
      SELECT m.id AS id, 'thread_reply' AS kind, CASE WHEN m.id > tr.last_read_reply_id THEN 1 ELSE 0 END AS unread,
        c.id AS channel_id, c.kind AS channel_kind, c.name AS channel_name
      FROM chat_thread_reads tr
        JOIN chat_members mem ON mem.channel_id = tr.channel_id AND mem.account_id = ?1 AND mem.left_at IS NULL
        JOIN chat_channels c ON c.id = tr.channel_id
        JOIN chat_messages m ON m.thread_root_id = tr.thread_root_id
      WHERE tr.account_id = ?1 AND m.deleted_at IS NULL AND m.author_account_id != ?1 AND m.created_at >= ?2
        AND m.mention_channel = 0 AND NOT EXISTS (${mine})
    ) ORDER BY id DESC LIMIT ?3`).bind(accountId, since, ACTIVITY_LIMIT).all<ActivityRow>();
  const messages = await messageDtos(db, rows.results.map((row) => Number(row.id)));
  return rows.results.flatMap((row) => {
    const message = messages.get(Number(row.id));
    return message ? [{
      kind: row.kind, message, unread: Number(row.unread) === 1,
      channel: { id: row.channel_id, kind: row.channel_kind, name: row.channel_name },
    }] : [];
  });
}

/**
 * ME-FR-11 저장됨: 지금 볼 수 있는 대화(내가 현재 멤버이거나 public)의 지워지지 않은 메시지만, 최신 저장순.
 * 접근을 잃은 행은 지우지 않고 숨긴다(다시 들어오면 돌아온다).
 */
async function bookmarks(accountId: string): Promise<ChatBookmarkItem[]> {
  const rows = await db.prepare(`SELECT b.message_id, b.created_at AS saved_at, c.id AS channel_id, c.kind AS channel_kind, c.name AS channel_name
    FROM chat_bookmarks b
      JOIN chat_messages m ON m.id = b.message_id AND m.deleted_at IS NULL
      JOIN chat_channels c ON c.id = b.channel_id
    WHERE b.account_id = ?1 AND (c.kind = 'public'
      OR EXISTS (SELECT 1 FROM chat_members mem WHERE mem.channel_id = c.id AND mem.account_id = ?1 AND mem.left_at IS NULL))
    ORDER BY b.created_at DESC, b.message_id DESC LIMIT ?2`).bind(accountId, CHAT_BOOKMARK_LIMIT)
    .all<{ message_id: number; saved_at: number; channel_id: string; channel_kind: ChatChannelKind; channel_name: string }>();
  const messages = await messageDtos(db, rows.results.map((row) => Number(row.message_id)));
  return rows.results.flatMap((row) => {
    const message = messages.get(Number(row.message_id));
    return message ? [{ message, savedAt: Number(row.saved_at), channel: { id: row.channel_id, kind: row.channel_kind, name: row.channel_name } }] : [];
  });
}

export async function PUT(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();
  const now = Date.now();

  if (payload.action === "SET_NOTIFY") {
    const level = payload.level;
    if (typeof level !== "string" || !CHAT_NOTIFY_LEVELS.includes(level as ChatNotifyLevel)) return chatValidation("알림 설정을 확인해 주세요.", "level");
    const access = await loadChannelAccess(db, principal, payload.channelId);
    if (!access?.member) return chatNotFound();
    await db.prepare(`INSERT INTO chat_member_prefs (channel_id, account_id, notify_level, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id, account_id) DO UPDATE SET notify_level = excluded.notify_level, updated_at = excluded.updated_at`)
      .bind(access.channel.id, principal.accountId, level, now).run();
    return Response.json({ ok: true, notifyLevel: level, unread: await unreadSummary(db, principal.accountId) });
  }

  if (payload.action === "THREAD_READ") {
    // ME-DD13: 스레드를 열어 본 사람도 참여자가 된다. 읽음 위치는 MAX() 로만 전진하고, 그 스레드의 마지막 답글을 넘지 않는다.
    const rootId = positiveInt(payload.threadRootId);
    const value = payload.lastReadReplyId;
    if (rootId === null) return chatValidation("스레드를 확인해 주세요.", "threadRootId");
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return chatValidation("읽음 위치를 확인해 주세요.", "lastReadReplyId");
    const root = await db.prepare(`SELECT id, channel_id, thread_root_id FROM chat_messages WHERE id = ?`).bind(rootId)
      .first<Pick<ChatMessageRow, "id" | "channel_id" | "thread_root_id">>();
    if (!root) return chatNotFound();
    const access = await loadChannelAccess(db, principal, root.channel_id);
    if (!access) return chatNotFound();
    if (root.thread_root_id !== null) return chatValidation("답글에는 스레드가 없습니다.", "threadRootId");
    const max = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE thread_root_id = ?`).bind(rootId).first<{ id: number }>();
    const position = Math.min(value, Number(max?.id ?? 0));
    await db.prepare(`INSERT INTO chat_thread_reads (account_id, thread_root_id, channel_id, last_read_reply_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, thread_root_id) DO UPDATE SET last_read_reply_id = MAX(last_read_reply_id, excluded.last_read_reply_id), updated_at = excluded.updated_at`)
      .bind(principal.accountId, rootId, root.channel_id, position, now).run();
    return Response.json({ ok: true, unread: await unreadSummary(db, principal.accountId) });
  }

  if (payload.action === "BOOKMARK" || payload.action === "UNBOOKMARK") {
    const messageId = positiveInt(payload.messageId);
    if (messageId === null) return chatValidation("메시지를 확인해 주세요.", "messageId");
    const message = await db.prepare(`SELECT id, channel_id, deleted_at FROM chat_messages WHERE id = ?`).bind(messageId)
      .first<Pick<ChatMessageRow, "id" | "channel_id" | "deleted_at">>();
    if (!message) return chatNotFound();
    const access = await loadChannelAccess(db, principal, message.channel_id);
    if (!access) return chatNotFound();
    if (payload.action === "UNBOOKMARK") {
      await db.prepare(`DELETE FROM chat_bookmarks WHERE account_id = ? AND message_id = ?`).bind(principal.accountId, messageId).run();
      return Response.json({ ok: true, bookmarked: false });
    }
    if (message.deleted_at !== null) return chatConflict();
    await db.prepare(`INSERT OR IGNORE INTO chat_bookmarks (account_id, message_id, channel_id, created_at) VALUES (?, ?, ?, ?)`)
      .bind(principal.accountId, messageId, message.channel_id, now).run();
    return Response.json({ ok: true, bookmarked: true });
  }

  return chatValidation("요청한 동작을 확인해 주세요.", "action");
}
