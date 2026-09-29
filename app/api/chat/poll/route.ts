import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { CHAT_POLL_EVENT_LIMIT, chatValidation, messageDtos, unreadSummary, type ChatEventKind, type ChatMessageDto } from "../../../chat-server";

// Design §4.2.8 GET /api/chat/poll?since=<seq>&summary=0|1&watch=<publicChannelId?> (chat:read).
// hot path: 게이트(메모, 0쿼리) → 세션(1) → 이벤트(1). DDL·감사·쓰기가 없다(세션 last_seen_at 시간당 1회만 예외).
// 대상 이벤트: 내가 현재 멤버인 채널, watch(보관되지 않은 public 일 때만), 나를 대상으로 한 member.*.
// 읽음 위치는 이벤트가 아니므로 남이 읽어도 증분이 생기지 않는다.
const db = (env as unknown as { DB: D1Database }).DB;

type EventRow = { head: number; seq: number | null; kind: ChatEventKind | null; channel_id: string | null; message_id: number | null; subject_account_id: string | null };
type PollEvent = { seq: number; kind: ChatEventKind; channelId: string; message?: ChatMessageDto; subjectAccountId?: string };

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

  const rows = await db.prepare(`WITH head AS (SELECT COALESCE(MAX(seq), 0) AS head FROM chat_events)
    SELECT head.head AS head, e.seq AS seq, e.kind AS kind, e.channel_id AS channel_id, e.message_id AS message_id, e.subject_account_id AS subject_account_id
    FROM head LEFT JOIN chat_events e ON e.seq > ?1 AND e.seq <= head.head AND ?1 > 0 AND (
         e.channel_id IN (SELECT channel_id FROM chat_members WHERE account_id = ?2 AND left_at IS NULL)
      OR (e.channel_id = ?3 AND EXISTS (SELECT 1 FROM chat_channels c WHERE c.id = ?3 AND c.kind = 'public' AND c.archived_at IS NULL))
      OR e.subject_account_id = ?2)
    ORDER BY e.seq LIMIT ?4`).bind(since, accountId, watch, CHAT_POLL_EVENT_LIMIT + 1).all<EventRow>();
  const head = Number(rows.results[0]?.head ?? 0);

  // since=0: 커서만 잡는다. since > head: 백업 복구 뒤 등 → resync.
  if (since === 0 || since > head) {
    return Response.json({ cursor: head, hasMore: false, ...(since > head ? { resync: true } : {}), events: [], unread: await unreadSummary(db, accountId) });
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
  return Response.json({ cursor, hasMore, events: payload, unread });
}
