import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";
import { hasTabLevel } from "../../../access-tabs";
import {
  CHAT_CHANNEL_NAME_MAX, CHAT_GROUP_DM_MAX_MEMBERS, CHAT_TOPIC_MAX, chatArchived, chatForbidden, chatNotFound, chatPeople, chatValidation,
  currentMemberIds, eventStatement, isUniqueViolation, joinStatements, loadChannelAccess, myChannelDto, myChannelDtos, newChannelId,
  readJsonBody, unreadableBody, type ChatChannelRow,
} from "../../../chat-server";

// Design §4.2.8 채널. GET(chat:read), POST(chat:read 로 인가 → 본문 → JOIN·LEAVE 가 아니면 chat:write 를 한 번 더), DELETE(chat:admin, 보관).
// 비공개·DM 은 멤버에게만 보이고, 비멤버에게는 관리자라도 404 다. 감사에는 채널 이름을 남기지 않는다(id·개수만).
const db = (env as unknown as { DB: D1Database }).DB;
const DUPLICATE_NAME = () => erpError(409, "DUPLICATE", "같은 이름의 채널이 이미 있습니다.");
const VIEW_ACTIONS = new Set(["JOIN", "LEAVE"]);

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  // ?members=<channelId>: 멤버 관리 화면용 현재 멤버 id. 접근 규칙은 다른 경로와 같다(비공개·DM 비멤버 404).
  const membersOf = new URL(request.url).searchParams.get("members");
  if (membersOf !== null) {
    const access = await loadChannelAccess(db, principal, membersOf);
    if (!access) return chatNotFound();
    return Response.json({ members: await currentMemberIds(db, access.channel.id) });
  }
  const [channels, joinable, people] = await Promise.all([
    myChannelDtos(db, principal.accountId),
    db.prepare(`SELECT c.id, c.name, c.topic, (SELECT COUNT(*) FROM chat_members m WHERE m.channel_id = c.id AND m.left_at IS NULL) AS member_count
      FROM chat_channels c WHERE c.kind = 'public' AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.account_id = ? AND m.left_at IS NULL)
      ORDER BY c.name`).bind(principal.accountId).all<{ id: string; name: string; topic: string; member_count: number }>(),
    chatPeople(db),
  ]);
  return Response.json({
    channels,
    joinable: joinable.results.map((row) => ({ id: row.id, name: row.name, topic: row.topic, memberCount: Number(row.member_count) })),
    people,
    me: { canWrite: hasTabLevel(principal, "chat", "edit"), isAdmin: principal.isAdmin },
  });
}

function textField(value: unknown, max: number, { required }: { required: boolean }) {
  if (value === undefined || value === null) return required ? null : undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  return trimmed.length > max ? null : trimmed;
}

/** 요청의 계정 id 목록 → chat 보기 이상 활성 계정인지 확인한 고유 목록. 하나라도 아니면 null(→ 400). */
async function eligibleAccounts(value: unknown, exclude?: string): Promise<string[] | null> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((id) => typeof id !== "string")) return null;
  const eligible = new Set((await chatPeople(db)).map((person) => person.accountId));
  const ids = [...new Set(value as string[])].filter((id) => id !== exclude);
  return ids.every((id) => eligible.has(id)) ? ids : null;
}

function canManage(principal: ErpPrincipal, role: "owner" | "member") {
  return role === "owner" || principal.isAdmin;
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "read");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const payload = await readJsonBody(request);
  if (!payload) return unreadableBody();
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!VIEW_ACTIONS.has(action)) {
    const write = await authorizeErpRequest(db, "chat", "write");
    if (write.response) return write.response;
  }
  const now = Date.now();

  if (action === "JOIN" || action === "LEAVE") {
    const access = await loadChannelAccess(db, principal, payload.channelId);
    if (!access) return chatNotFound();
    if (access.channel.kind !== "public") return chatValidation("공개 채널만 참여하거나 나갈 수 있습니다.");
    if (action === "JOIN") {
      if (access.channel.archived_at !== null) return chatArchived();
      if (!access.member) await db.batch(joinStatements(db, access.channel.id, principal.accountId, "member", now));
      return Response.json({ channel: await myChannelDto(db, principal.accountId, access.channel.id) });
    }
    if (!access.member) return chatValidation("참여하지 않은 채널입니다.");
    await db.batch([
      db.prepare(`UPDATE chat_members SET left_at = ? WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`).bind(now, access.channel.id, principal.accountId),
      eventStatement(db, { channelId: access.channel.id, kind: "member.left", subject: principal.accountId, now }),
    ]);
    return Response.json({ ok: true });
  }

  if (action === "CREATE_CHANNEL") {
    const name = textField(payload.name, CHAT_CHANNEL_NAME_MAX, { required: true });
    if (!name) return chatValidation(`채널 이름은 1~${CHAT_CHANNEL_NAME_MAX}자로 입력해 주세요.`, "name");
    if (payload.kind !== "public" && payload.kind !== "private") return chatValidation("채널 종류를 확인해 주세요.", "kind");
    const topic = textField(payload.topic, CHAT_TOPIC_MAX, { required: false });
    if (topic === null) return chatValidation(`주제는 ${CHAT_TOPIC_MAX}자까지 입력할 수 있습니다.`, "topic");
    const memberIds = await eligibleAccounts(payload.memberIds, principal.accountId);
    if (!memberIds) return chatValidation("멤버로 추가할 수 없는 계정이 있습니다.", "memberIds");
    const taken = await db.prepare(`SELECT 1 FROM chat_channels WHERE name = ? AND kind IN ('public','private') AND archived_at IS NULL`).bind(name).first();
    if (taken) return DUPLICATE_NAME();
    const id = newChannelId();
    try {
      await db.batch([
        db.prepare(`INSERT INTO chat_channels (id, kind, name, topic, dm_key, created_by, created_at, updated_at, archived_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)`).bind(id, payload.kind, name, topic ?? "", principal.accountId, now, now),
        ...joinStatements(db, id, principal.accountId, "owner", now),
        ...memberIds.flatMap((accountId) => joinStatements(db, id, accountId, "member", now)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return DUPLICATE_NAME();
      throw error;
    }
    await writeErpAudit(db, { principal, module: "chat", action: "CHANNEL_CREATED", entityType: "CHAT_CHANNEL", entityId: id,
      after: { channelId: id, kind: payload.kind, memberCount: memberIds.length + 1 } });
    return Response.json({ channel: await myChannelDto(db, principal.accountId, id) }, { status: 201 });
  }

  if (action === "OPEN_DM") {
    const others = await eligibleAccounts(payload.accountIds, principal.accountId);
    if (!others) return chatValidation("대화할 수 없는 계정이 있습니다.", "accountIds");
    const participants = [...new Set([...others, principal.accountId])].sort();
    if (participants.length < 2) return chatValidation("대화할 사람을 한 명 이상 골라 주세요.", "accountIds");
    if (participants.length > CHAT_GROUP_DM_MAX_MEMBERS) return chatValidation(`그룹 대화는 본인 포함 ${CHAT_GROUP_DM_MAX_MEMBERS}명까지입니다.`, "accountIds");
    const dmKey = participants.join(",");
    const existing = async () => {
      const row = await db.prepare(`SELECT id FROM chat_channels WHERE dm_key = ?`).bind(dmKey).first<{ id: string }>();
      return row ? Response.json({ channel: await myChannelDto(db, principal.accountId, row.id), created: false }) : null;
    };
    const found = await existing();
    if (found) return found;
    const id = newChannelId();
    const kind = participants.length === 2 ? "dm" : "group_dm";
    try {
      await db.batch([
        db.prepare(`INSERT INTO chat_channels (id, kind, name, topic, dm_key, created_by, created_at, updated_at, archived_at)
          VALUES (?, ?, '', '', ?, ?, ?, ?, NULL)`).bind(id, kind, dmKey, principal.accountId, now, now),
        ...participants.flatMap((accountId) => joinStatements(db, id, accountId, "member", now)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await existing();
        if (raced) return raced;
      }
      throw error;
    }
    await writeErpAudit(db, { principal, module: "chat", action: "DM_OPENED", entityType: "CHAT_CHANNEL", entityId: id,
      after: { channelId: id, memberCount: participants.length } });
    return Response.json({ channel: await myChannelDto(db, principal.accountId, id), created: true }, { status: 201 });
  }

  if (action === "ADD_MEMBERS" || action === "REMOVE_MEMBER" || action === "RENAME") {
    const access = await loadChannelAccess(db, principal, payload.channelId);
    if (!access) return chatNotFound();
    const { channel, member } = access;
    if (channel.kind !== "public" && channel.kind !== "private") return chatValidation("1:1·그룹 대화는 멤버나 이름을 바꿀 수 없습니다.");
    if (!member) return chatForbidden("채널에 참여한 뒤 바꿀 수 있습니다.");
    if (channel.archived_at !== null) return chatArchived();
    if (action === "ADD_MEMBERS") return addMembers(principal, channel, payload.accountIds, now);
    if (!canManage(principal, member.role)) return chatForbidden();
    if (action === "REMOVE_MEMBER") return removeMember(principal, channel, payload.accountId, now);
    return rename(principal, channel, payload, now);
  }

  return chatValidation("알 수 없는 요청입니다.", "action");
}

async function addMembers(principal: ErpPrincipal, channel: ChatChannelRow, accountIds: unknown, now: number) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) return chatValidation("추가할 사람을 골라 주세요.", "accountIds");
  const targets = await eligibleAccounts(accountIds, principal.accountId);
  if (!targets || targets.length === 0) return chatValidation("멤버로 추가할 수 없는 계정이 있습니다.", "accountIds");
  const current = new Set(await currentMemberIds(db, channel.id));
  const added = targets.filter((id) => !current.has(id));
  if (added.length) await db.batch(added.flatMap((accountId) => joinStatements(db, channel.id, accountId, "member", now)));
  await writeErpAudit(db, { principal, module: "chat", action: "CHANNEL_MEMBERS_CHANGED", entityType: "CHAT_CHANNEL", entityId: channel.id,
    after: { channelId: channel.id, added: added.length, removed: 0 } });
  return Response.json({ channel: await myChannelDto(db, principal.accountId, channel.id) });
}

async function removeMember(principal: ErpPrincipal, channel: ChatChannelRow, accountId: unknown, now: number) {
  if (typeof accountId !== "string") return chatValidation("내보낼 사람을 골라 주세요.", "accountId");
  const target = await db.prepare(`SELECT role FROM chat_members WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`)
    .bind(channel.id, accountId).first<{ role: string }>();
  if (!target) return chatValidation("채널 멤버가 아닙니다.", "accountId");
  if (target.role === "owner") return chatValidation("채널을 만든 사람은 내보낼 수 없습니다.", "accountId");
  await db.batch([
    db.prepare(`UPDATE chat_members SET left_at = ? WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`).bind(now, channel.id, accountId),
    eventStatement(db, { channelId: channel.id, kind: "member.left", subject: accountId, now }),
  ]);
  await writeErpAudit(db, { principal, module: "chat", action: "CHANNEL_MEMBERS_CHANGED", entityType: "CHAT_CHANNEL", entityId: channel.id,
    after: { channelId: channel.id, added: 0, removed: 1 } });
  return Response.json({ channel: await myChannelDto(db, principal.accountId, channel.id) });
}

async function rename(principal: ErpPrincipal, channel: ChatChannelRow, payload: Record<string, unknown>, now: number) {
  const name = payload.name === undefined ? undefined : textField(payload.name, CHAT_CHANNEL_NAME_MAX, { required: true });
  if (name === null) return chatValidation(`채널 이름은 1~${CHAT_CHANNEL_NAME_MAX}자로 입력해 주세요.`, "name");
  const topic = textField(payload.topic, CHAT_TOPIC_MAX, { required: false });
  if (topic === null) return chatValidation(`주제는 ${CHAT_TOPIC_MAX}자까지 입력할 수 있습니다.`, "topic");
  if (name === undefined && topic === undefined) return chatValidation("바꿀 내용을 입력해 주세요.");
  if (name !== undefined && name !== channel.name) {
    const taken = await db.prepare(`SELECT 1 FROM chat_channels WHERE name = ? AND kind IN ('public','private') AND archived_at IS NULL AND id != ?`)
      .bind(name, channel.id).first();
    if (taken) return DUPLICATE_NAME();
  }
  try {
    await db.batch([
      db.prepare(`UPDATE chat_channels SET name = ?, topic = ?, updated_at = ? WHERE id = ?`)
        .bind(name ?? channel.name, topic ?? channel.topic, now, channel.id),
      eventStatement(db, { channelId: channel.id, kind: "channel.updated", now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return DUPLICATE_NAME();
    throw error;
  }
  await writeErpAudit(db, { principal, module: "chat", action: "CHANNEL_RENAMED", entityType: "CHAT_CHANNEL", entityId: channel.id,
    after: { channelId: channel.id } });
  return Response.json({ channel: await myChannelDto(db, principal.accountId, channel.id) });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeErpRequest(db, "chat", "admin");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const access = await loadChannelAccess(db, principal, new URL(request.url).searchParams.get("id"));
  if (!access) return chatNotFound();
  if (access.channel.archived_at === null) {
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE chat_channels SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`).bind(now, now, access.channel.id),
      eventStatement(db, { channelId: access.channel.id, kind: "channel.archived", now }),
    ]);
    await writeErpAudit(db, { principal, module: "chat", action: "CHANNEL_ARCHIVED", entityType: "CHAT_CHANNEL", entityId: access.channel.id,
      after: { channelId: access.channel.id } });
  }
  return Response.json({ ok: true });
}
