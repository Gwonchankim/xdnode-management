import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { CHAT_POLL_EVENT_LIMIT, chatPeople, chatValidation, messageDtos, unreadSummary, type ChatEventKind, type ChatMessageDto, type ChatReadsSnapshot } from "../../../chat-server";
import { presenceSnapshot, prunePresence, touchPresence } from "../../../chat-presence";

// Design §4.2.8 GET /api/chat/poll?since=<seq>&summary=0|1&watch=<publicChannelId?> (chat:read).
// hot path: 게이트(메모, 0쿼리) → 세션(1) → 이벤트(1). DDL·감사·쓰기가 없다(세션 last_seen_at 시간당 1회만 예외).
// 대상 이벤트: 내가 현재 멤버인 채널, watch(보관되지 않은 public 일 때만), 나를 대상으로 한 member.*.
// 읽음 위치는 이벤트가 아니므로 남이 읽어도 증분이 생기지 않는다.
// messenger-enhancement(Design §4.2 poll): active=<channelId> 면 그 채널 멤버의 읽음 위치 스냅샷(reads, 쿼리 1개, ME-DD7)을,
// 매번 접속 상태(presence, 메모리, ME-DD6)를 싣는다. 쓰기는 늘지 않는다.
const db = (env as unknown as { DB: D1Database }).DB;

type EventRow = { head: number; seq: number | null; kind: ChatEventKind | null; channel_id: string | null; message_id: number | null; subject_account_id: string | null };
type PollEvent = { seq: number; kind: ChatEventKind; channelId: string; message?: ChatMessageDto; subjectAccountId?: string };
type ReadRow = { account_id: string; last_read_message_id: number; joined_at: number };

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const accountId = authorization.principal.accountId;
  const params = new URL(request.url).searchParams;
  const sinceText = params.get("since") ?? "";
  if (!/^\d{1,15}$/.test(sinceText)) return chatValidation("since 값을 확인해 주세요.", "since");
  const since = Number(sinceText);
  const wantSummary = params.get("summary") === "1";
  const watch = (params.get("watch") ?? "").slice(0, 80);
  const active = (params.get("active") ?? "").slice(0, 80);
  const now = Date.now();
  touchPresence(accountId, now);

  const rows = await db.prepare(`WITH head AS (SELECT COALESCE(MAX(seq), 0) AS head FROM chat_events)
    SELECT head.head AS head, e.seq AS seq, e.kind AS kind, e.channel_id AS channel_id, e.message_id AS message_id, e.subject_account_id AS subject_account_id
    FROM head LEFT JOIN chat_events e ON e.seq > ?1 AND e.seq <= head.head AND ?1 > 0 AND (
         e.channel_id IN (SELECT channel_id FROM chat_members WHERE account_id = ?2 AND left_at IS NULL)
      OR (e.channel_id = ?3 AND EXISTS (SELECT 1 FROM chat_channels c WHERE c.id = ?3 AND c.kind = 'public' AND c.archived_at IS NULL))
      OR e.subject_account_id = ?2)
    ORDER BY e.seq LIMIT ?4`).bind(since, accountId, watch, CHAT_POLL_EVENT_LIMIT + 1).all<EventRow>();
  const head = Number(rows.results[0]?.head ?? 0);
  const [reads, presence] = await Promise.all([active ? readsSnapshot(active, accountId) : null, presenceFor(wantSummary, now)]);

  // since=0: 커서만 잡는다. since > head: 백업 복구 뒤 등 → resync.
  if (since === 0 || since > head) {
    return Response.json({ cursor: head, hasMore: false, ...(since > head ? { resync: true } : {}), events: [], unread: await unreadSummary(db, accountId), reads, presence });
  }

  const found = rows.results.filter((row) => row.seq !== null) as Array<EventRow & { seq: number; kind: ChatEventKind; channel_id: string }>;
  const hasMore = found.length > CHAT_POLL_EVENT_LIMIT;
  const events = found.slice(0, CHAT_POLL_EVENT_LIMIT);
  const cursor = hasMore ? Number(events[events.length - 1].seq) : head;
  const messageIds = events.filter((row) => row.kind.startsWith("message.") && row.message_id !== null).map((row) => Number(row.message_id));
  const messages = messageIds.length ? await messageDtos(db, messageIds) : new Map<number, ChatMessageDto>();
  const payload: PollEvent[] = events.map((row) => {
    const event: PollEvent = { seq: Number(row.seq), kind: row.kind, channelId: row.channel_id };
    const message = row.message_id === null ? undefined : messages.get(Number(row.message_id));
    if (message) event.message = message;
    if (row.subject_account_id) event.subjectAccountId = row.subject_account_id;
    return event;
  });
  const unread = events.length || wantSummary ? await unreadSummary(db, accountId) : null;
  return Response.json({ cursor, hasMore, events: payload, unread, reads, presence });
}

/** ME-FR-08: 내가 현재 멤버인 채널일 때만 멤버 전원의 읽음 위치. 아니면 null(존재를 숨긴다). 쿼리 1개. */
async function readsSnapshot(channelId: string, accountId: string): Promise<ChatReadsSnapshot | null> {
  const rows = await db.prepare(`SELECT m.account_id, m.last_read_message_id, m.joined_at FROM chat_members m
    WHERE m.channel_id = ?1 AND m.left_at IS NULL
      AND EXISTS (SELECT 1 FROM chat_members me WHERE me.channel_id = ?1 AND me.account_id = ?2 AND me.left_at IS NULL)
    ORDER BY m.joined_at, m.account_id`).bind(channelId, accountId).all<ReadRow>();
  if (!rows.results.length) return null;
  return {
    channelId,
    members: rows.results.map((row) => ({ accountId: row.account_id, lastReadMessageId: Number(row.last_read_message_id), joinedAt: Number(row.joined_at) })),
  };
}

/**
 * ME-FR-09: 메모리 맵. summary poll(첫 호출·focus)에서만 맵에 없는 메신저 사용자를 활성 세션의 last_seen_at(시간 단위로 거칠다)으로 채운다.
 * 메신저 권한이 없는 계정의 접속 시각은 싣지 않는다(chatPeople 범위).
 */
async function presenceFor(wantSummary: boolean, now: number) {
  const snapshot = presenceSnapshot(now);
  if (!wantSummary) return snapshot;
  const [people, sessions] = await Promise.all([
    chatPeople(db),
    db.prepare(`SELECT account_id, MAX(last_seen_at) AS seen FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY account_id`)
      .bind(now).all<{ account_id: string; seen: number }>(),
  ]);
  const allowed = new Set(people.map((person) => person.accountId));
  // 맵에는 chat:read 를 통과한 poll 만 들어온다. 권한을 잃은 계정은 여기서 걷어 다음 일반 poll 에도 나오지 않게 한다(Check Minor).
  prunePresence(allowed);
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(snapshot)) if (allowed.has(id)) out[id] = at;
  for (const row of sessions.results) if (allowed.has(row.account_id) && out[row.account_id] === undefined) out[row.account_id] = Number(row.seen);
  return out;
}
