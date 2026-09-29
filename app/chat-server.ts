// 메신저 서버 공용(R5, Design §4.2.8). 라우트 5개(channels·messages·poll·attachments·read-state)가 쓴다.
// 접근 판정은 loadChannelAccess 하나로 한다. 비공개·DM 의 비멤버와 없는 채널은 같은 404 로 답해 존재를 숨긴다.
import { erpError, type ErpPrincipal } from "./erp-platform";
import { resolveTabs } from "./access-tabs";
import type { MentionPerson } from "./chat-mentions";

export const CHAT_POLL_EVENT_LIMIT = 200;
export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_PAGE_SIZE = 50;
export const CHAT_SEARCH_MIN = 2;
export const CHAT_SEARCH_MAX = 80;
export const CHAT_SEARCH_LIMIT = 50;
export const CHAT_GROUP_DM_MAX_MEMBERS = 8;
export const CHAT_ATTACHMENT_MAX_BYTES = 26_214_400;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 10;
export const CHAT_R2_PREFIX = "chat/";
export const CHAT_CHANNEL_NAME_MAX = 40;
export const CHAT_TOPIC_MAX = 200;

/** D1 은 문장당 바인드 값이 100개까지다. IN 목록은 이 크기로 나눈다. */
const IN_CHUNK = 90;

export type ChatChannelKind = "public" | "private" | "dm" | "group_dm";
export type ChatEventKind = "message.created" | "message.edited" | "message.deleted"
  | "channel.updated" | "channel.archived" | "member.joined" | "member.left";

export interface ChatChannelRow {
  id: string; kind: ChatChannelKind; name: string; topic: string; dm_key: string | null;
  created_by: string; created_at: number; updated_at: number; archived_at: number | null;
}
export interface ChatMemberRow {
  channel_id: string; account_id: string; role: "owner" | "member";
  joined_at: number; left_at: number | null; last_read_message_id: number; last_read_at: number | null;
}
export interface ChatMessageRow {
  id: number; client_key: string; channel_id: string; thread_root_id: number | null; author_account_id: string;
  body: string; mention_channel: 0 | 1; reply_count: number; last_reply_at: number | null;
  created_at: number; edited_at: number | null; deleted_at: number | null; deleted_by: string | null;
}
export interface ChatAttachmentRow {
  id: string; channel_id: string; message_id: number | null; uploader_account_id: string; file_name: string;
  content_type: string; size: number; storage_key: string; created_at: number; deleted_at: number | null;
}

export interface ChatAttachmentDto { id: string; fileName: string; size: number; contentType: string; isImage: boolean; url: string }
export interface ChatMessageDto {
  id: number; channelId: string; threadRootId: number | null;
  author: { accountId: string; name: string };
  body: string | null; mentions: string[]; mentionChannel: boolean; attachments: ChatAttachmentDto[];
  replyCount: number; lastReplyAt: number | null; createdAt: number; editedAt: number | null; deleted: boolean;
}
export interface ChatChannelDto {
  id: string; kind: ChatChannelKind; name: string; topic: string; memberCount: number; dmMemberIds?: string[];
  unread: number; mentions: number;
  lastMessage: { id: number; authorName: string; preview: string | null; createdAt: number } | null;
  myRole: "owner" | "member"; archived: boolean;
}
export interface UnreadSummary { total: number; mentions: number; channels: Array<{ channelId: string; unread: number; mentions: number; lastMessageId: number }> }

// ── 오류 ─────────────────────────────────────────────────────────────────
export const chatNotFound = () => erpError(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
export const chatArchived = () => erpError(409, "CHANNEL_ARCHIVED", "보관된 대화에는 새 글을 쓰거나 바꿀 수 없습니다.");
export const chatValidation = (error: string, field?: string) => erpError(400, "VALIDATION", error, field ? { field } : {});
export const chatForbidden = (error = "이 작업을 수행할 권한이 없습니다.") => erpError(403, "FORBIDDEN", error);
export const chatConflict = () => erpError(409, "CONFLICT", "다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요.");

/** 본문 JSON. 객체가 아니면 null(→ 400 "요청 내용을 읽을 수 없습니다."). 인가 뒤에만 부른다. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
export const unreadableBody = () => chatValidation("요청 내용을 읽을 수 없습니다.");

export function isUniqueViolation(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function newChannelId() { return `ch_${crypto.randomUUID()}`; }
export function newAttachmentId() { return `att_${crypto.randomUUID()}`; }
export function attachmentKey(channelId: string, attachmentId: string) { return `${CHAT_R2_PREFIX}${channelId}/${attachmentId}`; }

/** LIKE 패턴 이스케이프(`app/api/audit-log/route.ts` 와 같다). `ESCAPE '\'` 와 함께 쓴다. */
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function positiveInt(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function chunks<T>(items: T[]) {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += IN_CHUNK) out.push(items.slice(index, index + IN_CHUNK));
  return out;
}
const marks = (count: number) => Array.from({ length: count }, () => "?").join(",");

// ── 사람 ─────────────────────────────────────────────────────────────────
/** chat 보기 이상인 활성 계정. email·employeeId 는 싣지 않는다. */
export async function chatPeople(db: D1Database): Promise<MentionPerson[]> {
  const rows = await db.prepare(`SELECT id, display_name, is_admin, tabs_json FROM auth_accounts WHERE active = 1 ORDER BY display_name, id`)
    .all<{ id: string; display_name: string; is_admin: number; tabs_json: string }>();
  return rows.results
    .filter((row) => resolveTabs(row.tabs_json, row.is_admin === 1).chat !== "none")
    .map((row) => ({ accountId: row.id, name: row.display_name }));
}

// ── 채널 접근 ─────────────────────────────────────────────────────────────
export type ChannelAccess = { channel: ChatChannelRow; member: ChatMemberRow | null };

/**
 * 채널과 현재 멤버 행(left_at IS NULL). private·dm·group_dm 의 비멤버와 없는 채널은 null(→ 404).
 * public 은 비멤버도 channel 을 돌려준다(member = null). 관리자라도 멤버가 아닌 비공개 채널에는 null 이다.
 */
export async function loadChannelAccess(db: D1Database, principal: Pick<ErpPrincipal, "accountId">, channelId: unknown): Promise<ChannelAccess | null> {
  if (typeof channelId !== "string" || !channelId || channelId.length > 80) return null;
  const channel = await db.prepare(`SELECT * FROM chat_channels WHERE id = ?`).bind(channelId).first<ChatChannelRow>();
  if (!channel) return null;
  const member = await db.prepare(`SELECT * FROM chat_members WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`)
    .bind(channelId, principal.accountId).first<ChatMemberRow>();
  if (!member && channel.kind !== "public") return null;
  return { channel, member: member ?? null };
}

export async function currentMemberIds(db: D1Database, channelId: string) {
  const rows = await db.prepare(`SELECT account_id FROM chat_members WHERE channel_id = ? AND left_at IS NULL ORDER BY joined_at, account_id`)
    .bind(channelId).all<{ account_id: string }>();
  return rows.results.map((row) => row.account_id);
}

// ── 이벤트 ────────────────────────────────────────────────────────────────
export function eventStatement(db: D1Database, input: { channelId: string; kind: ChatEventKind; messageId?: number | null; subject?: string | null; now: number }) {
  return db.prepare(`INSERT INTO chat_events (channel_id, kind, message_id, subject_account_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.channelId, input.kind, input.messageId ?? null, input.subject ?? null, input.now);
}

/** 현재 멤버가 아닐 때만 member.joined 를 남기고 멤버로 올린다(재참여면 left_at = NULL). 이벤트 문장이 먼저다. */
export function joinStatements(db: D1Database, channelId: string, accountId: string, role: "owner" | "member", now: number) {
  return [
    db.prepare(`INSERT INTO chat_events (channel_id, kind, message_id, subject_account_id, created_at)
      SELECT ?, 'member.joined', NULL, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM chat_members WHERE channel_id = ? AND account_id = ? AND left_at IS NULL)`)
      .bind(channelId, accountId, now, channelId, accountId),
    db.prepare(`INSERT INTO chat_members (channel_id, account_id, role, joined_at, left_at, last_read_message_id, last_read_at)
      VALUES (?, ?, ?, ?, NULL, 0, NULL)
      ON CONFLICT(channel_id, account_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at WHERE chat_members.left_at IS NOT NULL`)
      .bind(channelId, accountId, role, now),
  ];
}

// ── 메시지 DTO ────────────────────────────────────────────────────────────
type MessageQueryRow = ChatMessageRow & { author_name: string | null; attachments_json: string; mentions_json: string };

const MESSAGE_SELECT = `SELECT m.*, a.display_name AS author_name,
  (SELECT json_group_array(json_object('id', t.id, 'fileName', t.file_name, 'size', t.size, 'contentType', t.content_type))
     FROM (SELECT * FROM chat_attachments WHERE message_id = m.id AND deleted_at IS NULL ORDER BY created_at, id) t) AS attachments_json,
  (SELECT json_group_array(n.account_id) FROM chat_mentions n WHERE n.message_id = m.id) AS mentions_json
  FROM chat_messages m LEFT JOIN auth_accounts a ON a.id = m.author_account_id`;

export function attachmentDto(row: { id: string; fileName: string; size: number; contentType: string }): ChatAttachmentDto {
  return {
    id: row.id, fileName: row.fileName, size: Number(row.size), contentType: row.contentType,
    isImage: row.contentType.startsWith("image/"), url: `/api/chat/attachments?id=${encodeURIComponent(row.id)}`,
  };
}

function parseArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function toMessageDto(row: MessageQueryRow): ChatMessageDto {
  const deleted = row.deleted_at !== null;
  return {
    id: Number(row.id),
    channelId: row.channel_id,
    threadRootId: row.thread_root_id === null ? null : Number(row.thread_root_id),
    author: { accountId: row.author_account_id, name: row.author_name ?? "알 수 없는 사용자" },
    body: deleted ? null : row.body,
    mentions: deleted ? [] : parseArray<string>(row.mentions_json),
    mentionChannel: !deleted && row.mention_channel === 1,
    attachments: deleted ? [] : parseArray<{ id: string; fileName: string; size: number; contentType: string }>(row.attachments_json).map(attachmentDto),
    replyCount: Number(row.reply_count),
    lastReplyAt: row.last_reply_at === null ? null : Number(row.last_reply_at),
    createdAt: Number(row.created_at),
    editedAt: row.edited_at === null ? null : Number(row.edited_at),
    deleted,
  };
}

/** id 목록 → DTO(Map). 삭제된 메시지는 body:null·attachments:[] 로 내린다. */
export async function messageDtos(db: D1Database, ids: number[]): Promise<Map<number, ChatMessageDto>> {
  const unique = [...new Set(ids)];
  const out = new Map<number, ChatMessageDto>();
  for (const group of chunks(unique)) {
    const rows = await db.prepare(`${MESSAGE_SELECT} WHERE m.id IN (${marks(group.length)})`).bind(...group).all<MessageQueryRow>();
    for (const row of rows.results) out.set(Number(row.id), toMessageDto(row));
  }
  return out;
}

/** 조건(where)에 맞는 메시지를 DTO 배열로. where 는 m. 별칭 기준이다. */
export async function queryMessageDtos(db: D1Database, where: string, binds: unknown[], order: string, limit: number) {
  const rows = await db.prepare(`${MESSAGE_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ?`).bind(...binds, limit).all<MessageQueryRow>();
  return rows.results.map(toMessageDto);
}

export async function messageDto(db: D1Database, id: number) {
  return (await messageDtos(db, [id])).get(id) ?? null;
}

// ── 안 읽은 수 ────────────────────────────────────────────────────────────
/**
 * 내가 현재 멤버인 채널(보관 제외).
 * unread: id > 읽음 위치, 삭제 안 됨, 남이 씀, 최상위이거나 나를 멘션한 답글. mentions: 그 가운데 @channel 이거나 나를 멘션.
 */
export async function unreadSummary(db: D1Database, accountId: string): Promise<UnreadSummary> {
  const rows = await db.prepare(`SELECT mem.channel_id AS channel_id,
      (SELECT COUNT(*) FROM chat_messages x WHERE x.channel_id = mem.channel_id AND x.id > mem.last_read_message_id
         AND x.deleted_at IS NULL AND x.author_account_id != ?1
         AND (x.thread_root_id IS NULL OR EXISTS (SELECT 1 FROM chat_mentions n WHERE n.message_id = x.id AND n.account_id = ?1))) AS unread,
      (SELECT COUNT(*) FROM chat_messages x WHERE x.channel_id = mem.channel_id AND x.id > mem.last_read_message_id
         AND x.deleted_at IS NULL AND x.author_account_id != ?1
         AND (x.thread_root_id IS NULL OR EXISTS (SELECT 1 FROM chat_mentions n WHERE n.message_id = x.id AND n.account_id = ?1))
         AND (x.mention_channel = 1 OR EXISTS (SELECT 1 FROM chat_mentions n WHERE n.message_id = x.id AND n.account_id = ?1))) AS mentions,
      (SELECT COALESCE(MAX(x.id), 0) FROM chat_messages x WHERE x.channel_id = mem.channel_id AND x.thread_root_id IS NULL AND x.deleted_at IS NULL) AS last_message_id
    FROM chat_members mem JOIN chat_channels c ON c.id = mem.channel_id
    WHERE mem.account_id = ?1 AND mem.left_at IS NULL AND c.archived_at IS NULL
    ORDER BY mem.channel_id`).bind(accountId).all<{ channel_id: string; unread: number; mentions: number; last_message_id: number }>();
  const channels = rows.results.map((row) => ({
    channelId: row.channel_id, unread: Number(row.unread), mentions: Number(row.mentions), lastMessageId: Number(row.last_message_id),
  }));
  return {
    total: channels.reduce((sum, row) => sum + row.unread, 0),
    mentions: channels.reduce((sum, row) => sum + row.mentions, 0),
    channels,
  };
}

// ── 채널 DTO ──────────────────────────────────────────────────────────────
const PREVIEW_LENGTH = 80;

/** 내가 현재 멤버인 채널(보관 포함)의 DTO. onlyId 를 주면 그 채널만. */
export async function myChannelDtos(db: D1Database, accountId: string, onlyId?: string): Promise<ChatChannelDto[]> {
  const idFilter = onlyId ? "AND c.id = ?2" : "";
  const binds = onlyId ? [accountId, onlyId] : [accountId];
  const [channels, members, lastMessages, unread] = await Promise.all([
    db.prepare(`SELECT c.*, mem.role AS my_role FROM chat_members mem JOIN chat_channels c ON c.id = mem.channel_id
      WHERE mem.account_id = ?1 AND mem.left_at IS NULL ${idFilter} ORDER BY c.archived_at IS NOT NULL, c.kind, c.name, c.created_at`)
      .bind(...binds).all<ChatChannelRow & { my_role: "owner" | "member" }>(),
    db.prepare(`SELECT channel_id, account_id FROM chat_members WHERE left_at IS NULL AND channel_id IN
      (SELECT channel_id FROM chat_members WHERE account_id = ?1 AND left_at IS NULL) ORDER BY joined_at, account_id`)
      .bind(accountId).all<{ channel_id: string; account_id: string }>(),
    db.prepare(`SELECT m.channel_id, m.id, m.body, m.deleted_at, m.created_at, a.display_name AS author_name
      FROM chat_messages m LEFT JOIN auth_accounts a ON a.id = m.author_account_id
      WHERE m.id IN (SELECT MAX(id) FROM chat_messages WHERE thread_root_id IS NULL AND channel_id IN
        (SELECT channel_id FROM chat_members WHERE account_id = ?1 AND left_at IS NULL) GROUP BY channel_id)`)
      .bind(accountId).all<{ channel_id: string; id: number; body: string; deleted_at: number | null; created_at: number; author_name: string | null }>(),
    unreadSummary(db, accountId),
  ]);
  const memberMap = new Map<string, string[]>();
  for (const row of members.results) memberMap.set(row.channel_id, [...(memberMap.get(row.channel_id) ?? []), row.account_id]);
  const lastMap = new Map(lastMessages.results.map((row) => [row.channel_id, row]));
  const unreadMap = new Map(unread.channels.map((row) => [row.channelId, row]));
  return channels.results.map((channel) => {
    const ids = memberMap.get(channel.id) ?? [];
    const last = lastMap.get(channel.id);
    const counts = unreadMap.get(channel.id);
    return {
      id: channel.id, kind: channel.kind, name: channel.name, topic: channel.topic, memberCount: ids.length,
      ...(channel.kind === "dm" || channel.kind === "group_dm" ? { dmMemberIds: ids } : {}),
      unread: counts?.unread ?? 0, mentions: counts?.mentions ?? 0,
      lastMessage: last ? {
        id: Number(last.id), authorName: last.author_name ?? "알 수 없는 사용자",
        preview: last.deleted_at === null ? last.body.slice(0, PREVIEW_LENGTH) : null, createdAt: Number(last.created_at),
      } : null,
      myRole: channel.my_role, archived: channel.archived_at !== null,
    };
  });
}

export async function myChannelDto(db: D1Database, accountId: string, channelId: string) {
  return (await myChannelDtos(db, accountId, channelId))[0] ?? null;
}

/** 채널 머리 표시용(비멤버가 보는 public 채널). 멤버면 myChannelDto 를 쓴다. */
export async function publicChannelSummary(db: D1Database, channel: ChatChannelRow) {
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM chat_members WHERE channel_id = ? AND left_at IS NULL`).bind(channel.id).first<{ n: number }>();
  return { id: channel.id, kind: channel.kind, name: channel.name, topic: channel.topic, memberCount: Number(count?.n ?? 0), archived: channel.archived_at !== null };
}

// ── 첨부 형식 (§7.8) ──────────────────────────────────────────────────────
/** 확장자 → { contentType, inline }. 서버가 정한다. 클라이언트 Content-Type 은 무시한다. 표 밖은 415 다. */
export const CHAT_ATTACHMENT_TYPES: ReadonlyMap<string, { contentType: string; inline: boolean }> = new Map([
  ["png", { contentType: "image/png", inline: true }],
  ["jpg", { contentType: "image/jpeg", inline: true }],
  ["jpeg", { contentType: "image/jpeg", inline: true }],
  ["gif", { contentType: "image/gif", inline: true }],
  ["webp", { contentType: "image/webp", inline: true }],
  ["pdf", { contentType: "application/pdf", inline: false }],
  ["docx", { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false }],
  ["xlsx", { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false }],
  ["pptx", { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", inline: false }],
  ["hwp", { contentType: "application/x-hwp", inline: false }],
  ["hwpx", { contentType: "application/hwp+zip", inline: false }],
  ["txt", { contentType: "text/plain; charset=utf-8", inline: false }],
  ["csv", { contentType: "text/csv; charset=utf-8", inline: false }],
  ["zip", { contentType: "application/zip", inline: false }],
]);

/** 파일 이름 정리: 제어문자·경로 구분자를 빼고 200자에서 자른다. */
export function cleanFileName(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 200);
}

/** 마지막 확장자(소문자)의 형식. 확장자가 없거나 표 밖이면 null. */
export function attachmentTypeOf(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return CHAT_ATTACHMENT_TYPES.get(fileName.slice(dot + 1).toLowerCase()) ?? null;
}

/** RFC 5987 filename*. */
export function contentDisposition(fileName: string, inline: boolean) {
  if (inline) return "inline";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
