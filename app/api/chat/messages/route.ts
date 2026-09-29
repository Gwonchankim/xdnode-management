import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { extractMentions, type MentionPerson } from "../../../chat-mentions";
import {
  CHAT_ATTACHMENTS_PER_MESSAGE, CHAT_MESSAGE_MAX_LENGTH, CHAT_PAGE_SIZE, CHAT_SEARCH_LIMIT, CHAT_SEARCH_MAX, CHAT_SEARCH_MIN,
  chatArchived, chatConflict, chatForbidden, chatNotFound, chatPeople, chatValidation, currentMemberIds, escapeLike, eventStatement,
  isUniqueViolation, joinStatements, loadChannelAccess, messageDto, positiveInt, queryMessageDtos, readJsonBody, unreadableBody,
  type ChannelAccess, type ChatMessageRow,
} from "../../../chat-server";

// Design §4.2.8 메시지. GET(chat:read) 기록·스레드·검색, POST·PATCH·DELETE(chat:write, 수정·삭제는 작성자만).
// 전송과 읽음은 감사하지 않는다. 수정·삭제 감사에는 본문 대신 길이만 남긴다.
const db = (env as unknown as { DB: D1Database }).DB;
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const params = new URL(request.url).searchParams;
  const selectors = ["channelId", "threadRootId", "q"].filter((key) => params.has(key));
  if (selectors.length !== 1) return chatValidation("channelId·threadRootId·q 가운데 하나만 보내 주세요.");

  if (params.has("channelId")) {
    const access = await loadChannelAccess(db, principal, params.get("channelId"));
    if (!access) return chatNotFound();
    const before = params.has("before") ? positiveInt(params.get("before")) : Number.MAX_SAFE_INTEGER;
    if (before === null) return chatValidation("before 값을 확인해 주세요.");
    const limit = Math.min(positiveInt(params.get("limit")) ?? CHAT_PAGE_SIZE, CHAT_PAGE_SIZE);
    const rows = await queryMessageDtos(db, "m.channel_id = ? AND m.thread_root_id IS NULL AND m.id < ?", [access.channel.id, before], "m.id DESC", limit + 1);
    return Response.json({ messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit });
  }

  if (params.has("threadRootId")) {
    const rootId = positiveInt(params.get("threadRootId"));
    if (rootId === null) return chatValidation("threadRootId 값을 확인해 주세요.");
    const rootRow = await db.prepare(`SELECT channel_id, thread_root_id FROM chat_messages WHERE id = ?`).bind(rootId).first<{ channel_id: string; thread_root_id: number | null }>();
    if (!rootRow) return chatNotFound();
    const access = await loadChannelAccess(db, principal, rootRow.channel_id);
    if (!access) return chatNotFound();
    if (rootRow.thread_root_id !== null) return chatValidation("답글에는 스레드가 없습니다.");
    const after = params.has("after") ? positiveInt(params.get("after")) ?? 0 : 0;
    const [root, replies] = await Promise.all([
      messageDto(db, rootId),
      queryMessageDtos(db, "m.thread_root_id = ? AND m.id > ?", [rootId, after], "m.id ASC", CHAT_PAGE_SIZE + 1),
    ]);
    return Response.json({ root, replies: replies.slice(0, CHAT_PAGE_SIZE), hasMore: replies.length > CHAT_PAGE_SIZE });
  }

  const q = (params.get("q") ?? "").trim();
  if (q.length < CHAT_SEARCH_MIN || q.length > CHAT_SEARCH_MAX) return chatValidation(`검색어는 ${CHAT_SEARCH_MIN}~${CHAT_SEARCH_MAX}자로 입력해 주세요.`, "q");
  // 범위: 내가 현재 멤버인 채널 + public 전부. 삭제된 메시지는 뺀다.
  const messages = await queryMessageDtos(db, `m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\' AND m.channel_id IN (
      SELECT channel_id FROM chat_members WHERE account_id = ? AND left_at IS NULL
      UNION SELECT id FROM chat_channels WHERE kind = 'public')`, [`%${escapeLike(q)}%`, principal.accountId], "m.id DESC", CHAT_SEARCH_LIMIT);
  const channelIds = [...new Set(messages.map((message) => message.channelId))];
  const channels = new Map<string, { id: string; kind: string; name: string }>();
  for (const id of channelIds) {
    const row = await db.prepare(`SELECT id, kind, name FROM chat_channels WHERE id = ?`).bind(id).first<{ id: string; kind: string; name: string }>();
    if (row) channels.set(id, row);
  }
  return Response.json({ results: messages.map((message) => ({ message, channel: channels.get(message.channelId) ?? null })) });
}

/** 멘션 대상: private·DM 이면 현재 멤버, public 이면 chat 보기 이상 활성 계정. */
async function mentionPeople(access: ChannelAccess): Promise<MentionPerson[]> {
  const people = await chatPeople(db);
  if (access.channel.kind === "public") return people;
  const members = new Set(await currentMemberIds(db, access.channel.id));
  return people.filter((person) => members.has(person.accountId));
}

function mentionStatements(messageSql: { where: string; binds: unknown[] }, accountIds: string[], channelId: string, now: number) {
  return accountIds.map((accountId) => db.prepare(`INSERT OR IGNORE INTO chat_mentions (message_id, account_id, channel_id, created_at)
    SELECT id, ?, ?, ? FROM chat_messages WHERE ${messageSql.where}`).bind(accountId, channelId, now, ...messageSql.binds));
}

function bodyText(value: unknown) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : null;
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();

  const body = bodyText(payload.body);
  if (body === null) return chatValidation("메시지를 입력해 주세요.", "body");
  const attachmentIds = payload.attachmentIds === undefined ? [] : payload.attachmentIds;
  if (!Array.isArray(attachmentIds) || attachmentIds.length > CHAT_ATTACHMENTS_PER_MESSAGE || attachmentIds.some((id) => typeof id !== "string")) {
    return chatValidation("첨부 파일을 확인해 주세요.", "attachmentIds");
  }
  const uniqueAttachments = [...new Set(attachmentIds as string[])];
  if (body.length > CHAT_MESSAGE_MAX_LENGTH) return chatValidation(`메시지는 ${CHAT_MESSAGE_MAX_LENGTH}자까지 쓸 수 있습니다.`, "body");
  if (!body.trim() && uniqueAttachments.length === 0) return chatValidation("메시지를 입력해 주세요.", "body");

  const access = await loadChannelAccess(db, principal, payload.channelId);
  if (!access) return chatNotFound();
  if (access.channel.archived_at !== null) return chatArchived();
  const channelId = access.channel.id;

  let rootId: number | null = null;
  if (payload.threadRootId !== undefined && payload.threadRootId !== null) {
    rootId = positiveInt(payload.threadRootId);
    const root = rootId === null ? null : await db.prepare(`SELECT channel_id, thread_root_id, deleted_at FROM chat_messages WHERE id = ?`)
      .bind(rootId).first<Pick<ChatMessageRow, "channel_id" | "thread_root_id" | "deleted_at">>();
    if (!root || root.channel_id !== channelId || root.deleted_at !== null) return chatValidation("답글을 달 메시지를 찾을 수 없습니다.", "threadRootId");
    if (root.thread_root_id !== null) return chatValidation("답글에는 다시 답글을 달 수 없습니다.", "threadRootId");
  }

  if (uniqueAttachments.length) {
    const rows = await db.prepare(`SELECT id FROM chat_attachments WHERE id IN (${uniqueAttachments.map(() => "?").join(",")})
      AND uploader_account_id = ? AND channel_id = ? AND message_id IS NULL AND deleted_at IS NULL`)
      .bind(...uniqueAttachments, principal.accountId, channelId).all<{ id: string }>();
    if (rows.results.length !== uniqueAttachments.length) return chatValidation("첨부 파일을 확인해 주세요.", "attachmentIds");
  }

  const clientKey = typeof payload.clientKey === "string" && CLIENT_KEY.test(payload.clientKey) ? payload.clientKey : crypto.randomUUID();
  const ck = `${principal.accountId}:${clientKey}`;
  const mentions = extractMentions(body, await mentionPeople(access));
  const now = Date.now();
  const byKey = { where: "client_key = ?", binds: [ck] };
  const statements = [
    ...(access.channel.kind === "public" && !access.member ? joinStatements(db, channelId, principal.accountId, "member", now) : []),
    db.prepare(`INSERT INTO chat_messages (client_key, channel_id, thread_root_id, author_account_id, body, mention_channel, reply_count, last_reply_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`).bind(ck, channelId, rootId, principal.accountId, body, mentions.channel ? 1 : 0, now),
    ...(rootId !== null ? [db.prepare(`UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = ?
      WHERE id = ? AND thread_root_id IS NULL AND deleted_at IS NULL`).bind(now, rootId)] : []),
    ...mentionStatements(byKey, mentions.accountIds, channelId, now),
    ...(uniqueAttachments.length ? [db.prepare(`UPDATE chat_attachments SET message_id = (SELECT id FROM chat_messages WHERE client_key = ?)
      WHERE id IN (${uniqueAttachments.map(() => "?").join(",")}) AND uploader_account_id = ? AND channel_id = ? AND message_id IS NULL`)
      .bind(ck, ...uniqueAttachments, principal.accountId, channelId)] : []),
    db.prepare(`INSERT INTO chat_events (channel_id, kind, message_id, subject_account_id, created_at)
      SELECT ?, 'message.created', id, NULL, ? FROM chat_messages WHERE client_key = ?`).bind(channelId, now, ck),
    ...(rootId === null ? [db.prepare(`UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, (SELECT id FROM chat_messages WHERE client_key = ?)),
      last_read_at = ? WHERE channel_id = ? AND account_id = ?`).bind(ck, now, channelId, principal.accountId)] : []),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.prepare(`SELECT id FROM chat_messages WHERE client_key = ?`).bind(ck).first<{ id: number }>();
    if (!existing) throw error;
    return Response.json({ message: await messageDto(db, Number(existing.id)), duplicate: true });
  }
  const created = await db.prepare(`SELECT id FROM chat_messages WHERE client_key = ?`).bind(ck).first<{ id: number }>();
  return Response.json({ message: await messageDto(db, Number(created?.id)) }, { status: 201 });
}

/** 수정·삭제 공통: 메시지와 채널 접근. 비멤버 404, 보관 409, 삭제됨 409, 작성자가 아니면 403. */
async function editableMessage(principal: { accountId: string }, id: number | null) {
  if (id === null) return { response: chatValidation("메시지를 찾을 수 없습니다.", "id") };
  const message = await db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).bind(id).first<ChatMessageRow>();
  if (!message) return { response: chatNotFound() };
  const access = await loadChannelAccess(db, principal, message.channel_id);
  if (!access) return { response: chatNotFound() };
  if (access.channel.archived_at !== null) return { response: chatArchived() };
  if (message.deleted_at !== null) return { response: chatConflict() };
  if (message.author_account_id !== principal.accountId) return { response: chatForbidden("본인이 쓴 메시지만 바꿀 수 있습니다.") };
  return { message, access };
}

export async function PATCH(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();
  const target = await editableMessage(principal, positiveInt(payload.id));
  if (target.response) return target.response;
  const { message, access } = target;
  const body = bodyText(payload.body);
  if (body === null || body.length > CHAT_MESSAGE_MAX_LENGTH) return chatValidation(`메시지는 1~${CHAT_MESSAGE_MAX_LENGTH}자로 입력해 주세요.`, "body");
  const hasAttachments = await db.prepare(`SELECT 1 FROM chat_attachments WHERE message_id = ? AND deleted_at IS NULL LIMIT 1`).bind(message.id).first();
  if (!body.trim() && !hasAttachments) return chatValidation("메시지를 입력해 주세요.", "body");
  const mentions = extractMentions(body, await mentionPeople(access));
  const now = Date.now();
  const results = await db.batch([
    db.prepare(`UPDATE chat_messages SET body = ?, mention_channel = ?, edited_at = ? WHERE id = ? AND author_account_id = ? AND deleted_at IS NULL`)
      .bind(body, mentions.channel ? 1 : 0, now, message.id, principal.accountId),
    db.prepare(`DELETE FROM chat_mentions WHERE message_id = ?`).bind(message.id),
    ...mentionStatements({ where: "id = ? AND deleted_at IS NULL", binds: [message.id] }, mentions.accountIds, message.channel_id, now),
    eventStatement(db, { channelId: message.channel_id, kind: "message.edited", messageId: message.id, now }),
  ]);
  if (!results[0]?.meta?.changes) return chatConflict();
  await writeErpAudit(db, { principal, module: "chat", action: "CHAT_MESSAGE_EDITED", entityType: "CHAT_MESSAGE", entityId: String(message.id),
    after: { messageId: message.id, channelId: message.channel_id, beforeLength: message.body.length, afterLength: body.length } });
  return Response.json({ message: await messageDto(db, message.id) });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const target = await editableMessage(principal, positiveInt(new URL(request.url).searchParams.get("id")));
  if (target.response) return target.response;
  const { message } = target;
  const attachments = await db.prepare(`SELECT COUNT(*) AS n FROM chat_attachments WHERE message_id = ? AND deleted_at IS NULL`).bind(message.id).first<{ n: number }>();
  const now = Date.now();
  // R2 객체는 지우지 않는다(백업 단위 유지). 행에만 deleted_at 을 채운다.
  const results = await db.batch([
    db.prepare(`UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND author_account_id = ? AND deleted_at IS NULL`)
      .bind(now, principal.accountId, message.id, principal.accountId),
    db.prepare(`UPDATE chat_attachments SET deleted_at = ? WHERE message_id = ? AND deleted_at IS NULL`).bind(now, message.id),
    eventStatement(db, { channelId: message.channel_id, kind: "message.deleted", messageId: message.id, now }),
  ]);
  if (!results[0]?.meta?.changes) return chatConflict();
  await writeErpAudit(db, { principal, module: "chat", action: "CHAT_MESSAGE_DELETED", entityType: "CHAT_MESSAGE", entityId: String(message.id),
    after: { messageId: message.id, channelId: message.channel_id, length: message.body.length, attachmentCount: Number(attachments?.n ?? 0) } });
  return Response.json({ message: await messageDto(db, message.id) });
}
