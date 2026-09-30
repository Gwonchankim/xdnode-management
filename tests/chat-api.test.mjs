// R5(Design §8.2 #39~#52, FR-12~FR-15): 메신저 라우트를 실제 코드·SQL 로 실행한다(하니스의 메모리 SQLite + 가짜 R2).
// 사람마다 실제 로그인으로 받은 세션 쿠키를 쓴다. 비공개·DM 비멤버는 관리자라도 404, 첨부는 멤버만 받는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEST_ADMIN_ACCOUNT_ID, TEST_SESSION_TOKEN, callApi, createAccount, db, login, objects, resetDatabase, setAccess,
} from './helpers/hr-api-harness.mjs';

async function person(name, tabs = { chat: 'edit' }, extra = {}) {
  const account = await createAccount({ displayName: name, tabs, ...extra });
  const session = extra.active === false ? { cookie: null } : await login(account.email, account.password);
  const call = (path, method = 'GET', body, query = '', options = {}) => callApi(`chat/${path}`, method, body, query, { ...options, cookie: session.cookie });
  return { ...account, name, cookie: session.cookie, call };
}
const admin = { id: TEST_ADMIN_ACCOUNT_ID, call: (path, method = 'GET', body, query = '', options = {}) => callApi(`chat/${path}`, method, body, query, { ...options, cookie: TEST_SESSION_TOKEN }) };

async function world() {
  const sqlite = await resetDatabase();
  setAccess({}, { isAdmin: true });
  const kim = await person('김하나');
  const lee = await person('이두리');
  const park = await person('박세나');
  return { sqlite, kim, lee, park };
}
const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const cursorOf = async (user) => (await user.call('poll', 'GET', undefined, '?since=0')).body.cursor;

test('R5 channels: ch_general is seeded and joinable; people lists only active chat accounts without email', async () => {
  const { kim } = await world();
  await person('보기없음', { hr: 'edit' });
  await person('비활성', { chat: 'edit' }, { active: false });
  const listed = await kim.call('channels');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.channels, []);
  assert.deepEqual(listed.body.joinable.map((channel) => channel.id), ['ch_general']);
  const names = listed.body.people.map((entry) => entry.name);
  assert.ok(names.includes('김하나') && names.includes('이두리'));
  assert.ok(!names.includes('보기없음') && !names.includes('비활성'));
  assert.ok(listed.body.people.every((entry) => Object.keys(entry).sort().join() === 'accountId,name'));
  assert.deepEqual(listed.body.me, { canWrite: true, isAdmin: false });

  const joined = await kim.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.channel.id, 'ch_general');
  assert.equal(joined.body.channel.memberCount, 1);
  const again = await kim.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  assert.equal(again.status, 200);
  assert.equal((await rows(`SELECT * FROM chat_events WHERE kind = 'member.joined'`)).length, 1, 'no second join event');
});

test('R5 #39: a private channel is invisible to non-members, even the administrator', async () => {
  const { kim, lee, park } = await world();
  const created = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '경영지원', kind: 'private', memberIds: [lee.id] });
  assert.equal(created.status, 201);
  const id = created.body.channel.id;
  assert.equal(created.body.channel.myRole, 'owner');
  assert.equal(created.body.channel.memberCount, 2);
  assert.equal((await lee.call('channels')).body.channels.some((channel) => channel.id === id), true);
  const parkList = await park.call('channels');
  assert.equal(parkList.body.channels.some((channel) => channel.id === id), false);
  assert.equal(parkList.body.joinable.some((channel) => channel.id === id), false);
  for (const [user, method, body, query] of [
    [park, 'GET', undefined, `?channelId=${id}`],
    [park, 'POST', { channelId: id, body: '안녕' }, ''],
    [admin, 'GET', undefined, `?channelId=${id}`],
  ]) assert.equal((await user.call('messages', method, body, query)).status, 404);
  assert.equal((await admin.call('channels', 'POST', { action: 'RENAME', channelId: id, name: '다른 이름' })).body.code, 'NOT_FOUND');
  assert.equal((await admin.call('channels', 'POST', { action: 'REMOVE_MEMBER', channelId: id, accountId: lee.id })).status, 404);
  assert.equal((await admin.call('channels', 'DELETE', undefined, `?id=${id}`)).status, 404);
  assert.equal((await park.call('channels', 'POST', { action: 'JOIN', channelId: id })).status, 404);
  const duplicate = await lee.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '경영지원', kind: 'public' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE');
  const audit = await rows(`SELECT after_json FROM erp_audit_logs WHERE action = 'CHANNEL_CREATED'`);
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0].after_json, /경영지원/, 'the audit row never carries the channel name');
});

test('R5 #40: OPEN_DM returns the same channel for the same people (1:1 and group), and rejects 1 or 9+ people', async () => {
  const { kim, lee, park } = await world();
  const first = await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [lee.id] });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.channel.kind, 'dm');
  assert.deepEqual([...first.body.channel.dmMemberIds].sort(), [kim.id, lee.id].sort());
  const second = await lee.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [kim.id, kim.id] });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.channel.id, first.body.channel.id);
  const group = await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [lee.id, park.id] });
  assert.equal(group.body.channel.kind, 'group_dm');
  const groupAgain = await park.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [lee.id, kim.id] });
  assert.deepEqual([groupAgain.status, groupAgain.body.channel.id], [200, group.body.channel.id]);
  assert.equal((await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [kim.id] })).status, 400);
  const many = [];
  for (let index = 0; index < 8; index += 1) many.push((await person(`사람${index}`)).id);
  assert.equal((await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: many })).status, 400);
  const noChat = await person('채팅없음', { hr: 'view' });
  assert.equal((await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [noChat.id] })).status, 400);
  assert.equal((await rows(`SELECT id FROM chat_channels WHERE kind IN ('dm','group_dm')`)).length, 2);
});

test('R5 #41: reply-to-reply, 4001 characters, non-member send and archived channel are refused', async () => {
  const { kim, lee } = await world();
  const root = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '원글' });
  assert.equal(root.status, 201);
  assert.equal(root.body.message.body, '원글');
  const reply = await lee.call('messages', 'POST', { channelId: 'ch_general', body: '답글', threadRootId: root.body.message.id });
  assert.equal(reply.status, 201);
  const nested = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '답글의 답글', threadRootId: reply.body.message.id });
  assert.equal(nested.status, 400);
  assert.equal(nested.body.error, '답글에는 다시 답글을 달 수 없습니다.');
  assert.equal((await kim.call('messages', 'POST', { channelId: 'ch_general', body: 'x'.repeat(4001) })).status, 400);
  assert.equal((await kim.call('messages', 'POST', { channelId: 'ch_general', body: '   ' })).status, 400);
  const thread = await kim.call('messages', 'GET', undefined, `?threadRootId=${root.body.message.id}`);
  assert.equal(thread.body.root.replyCount, 1);
  assert.deepEqual(thread.body.replies.map((message) => message.body), ['답글']);
  const history = await kim.call('messages', 'GET', undefined, '?channelId=ch_general');
  assert.deepEqual(history.body.messages.map((message) => message.body), ['원글'], 'history holds top-level messages only');
  // lee joined ch_general automatically by sending.
  assert.equal((await rows(`SELECT * FROM chat_members WHERE channel_id = 'ch_general' AND left_at IS NULL`)).length, 2);

  const archivedChannel = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '보관 예정', kind: 'public' });
  assert.equal((await admin.call('channels', 'POST', { action: 'JOIN', channelId: archivedChannel.body.channel.id })).status, 200);
  assert.equal((await admin.call('channels', 'DELETE', undefined, `?id=${archivedChannel.body.channel.id}`)).status, 200);
  const blocked = await kim.call('messages', 'POST', { channelId: archivedChannel.body.channel.id, body: '안녕' });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'CHANNEL_ARCHIVED']);
  assert.equal((await kim.call('channels')).body.channels.find((channel) => channel.id === archivedChannel.body.channel.id).archived, true);
  assert.equal((await kim.call('messages', 'GET', undefined, `?channelId=${archivedChannel.body.channel.id}`)).status, 200, 'archived is read-only');
});

test('R5 #42: resending the same clientKey returns the first message with duplicate:true', async () => {
  const { kim } = await world();
  const first = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '한 번만', clientKey: 'client-key-0001' });
  const second = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '한 번만', clientKey: 'client-key-0001' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.message.id, first.body.message.id);
  assert.equal((await rows(`SELECT id FROM chat_messages`)).length, 1);
  assert.equal((await rows(`SELECT seq FROM chat_events WHERE kind = 'message.created'`)).length, 1);
});

test('R5 #43: @name and @channel mentions feed the unread mention count; replies count only when they mention me', async () => {
  const { kim, lee, park } = await world();
  for (const user of [kim, lee, park]) await user.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '@이두리 확인 부탁드려요' });
  assert.deepEqual(sent.body.message.mentions, [lee.id]);
  const everyone = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '@채널 공지입니다' });
  assert.equal(everyone.body.message.mentionChannel, true);
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: '그냥 답글', threadRootId: sent.body.message.id });
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: '@박세나 답글에서 부름', threadRootId: sent.body.message.id });
  const leeUnread = (await lee.call('poll', 'GET', undefined, '?since=0')).body.unread;
  assert.deepEqual([leeUnread.total, leeUnread.mentions], [2, 2]);
  const parkUnread = (await park.call('poll', 'GET', undefined, '?since=0')).body.unread;
  assert.deepEqual([parkUnread.total, parkUnread.mentions], [3, 2]);
  const kimUnread = (await kim.call('poll', 'GET', undefined, '?since=0')).body.unread;
  assert.equal(kimUnread.total, 0, 'my own messages are never unread');
  const read = await lee.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: everyone.body.message.id });
  assert.deepEqual([read.status, read.body.unread.total], [200, 0]);
});

test('R5 #44: only the author edits or deletes; a deleted message has no body and its audit row has no text', async () => {
  const { kim, lee } = await world();
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '비밀스러운 본문입니다' });
  const id = sent.body.message.id;
  assert.equal((await lee.call('messages', 'PATCH', { id, body: '바꿈' })).status, 403);
  assert.equal((await lee.call('messages', 'DELETE', undefined, `?id=${id}`)).status, 403);
  const edited = await kim.call('messages', 'PATCH', { id, body: '고친 본문입니다' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.body, '고친 본문입니다');
  assert.ok(edited.body.message.editedAt);
  const removed = await kim.call('messages', 'DELETE', undefined, `?id=${id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.body.message.body, removed.body.message.deleted, removed.body.message.attachments], [null, true, []]);
  assert.equal((await kim.call('messages', 'PATCH', { id, body: '다시' })).status, 409);
  const audit = await rows(`SELECT action, after_json FROM erp_audit_logs WHERE module = 'chat' ORDER BY created_at`);
  assert.deepEqual(audit.map((row) => row.action), ['CHAT_MESSAGE_EDITED', 'CHAT_MESSAGE_DELETED']);
  assert.deepEqual(JSON.parse(audit[1].after_json), { messageId: id, channelId: 'ch_general', length: '고친 본문입니다'.length, attachmentCount: 0 });
  for (const row of audit) assert.doesNotMatch(row.after_json, /본문/);
  const history = await lee.call('messages', 'GET', undefined, '?channelId=ch_general');
  assert.equal(history.body.messages[0].body, null);
});

test('R5 #45: search escapes % and _, skips deleted messages and channels I cannot read', async () => {
  const { kim, lee, park } = await world();
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: '할인율 50% 적용' });
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: '할인율 50 적용' });
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: 'file_name 확인' });
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: 'fileXname 확인' });
  const secret = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '비공개', kind: 'private', memberIds: [lee.id] });
  await kim.call('messages', 'POST', { channelId: secret.body.channel.id, body: '50% 비공개 내용' });
  const gone = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '50% 지운 글' });
  await kim.call('messages', 'DELETE', undefined, `?id=${gone.body.message.id}`);
  const percent = await park.call('messages', 'GET', undefined, `?q=${encodeURIComponent('50%')}`);
  assert.deepEqual(percent.body.results.map((result) => result.message.body), ['할인율 50% 적용']);
  assert.equal(percent.body.results[0].channel.name, '일반');
  const underscore = await park.call('messages', 'GET', undefined, `?q=${encodeURIComponent('file_')}`);
  assert.deepEqual(underscore.body.results.map((result) => result.message.body), ['file_name 확인']);
  const member = await lee.call('messages', 'GET', undefined, `?q=${encodeURIComponent('50%')}`);
  assert.equal(member.body.results.length, 2, 'a member also finds the private channel match');
  assert.equal((await park.call('messages', 'GET', undefined, '?q=5')).status, 400);
  assert.equal((await park.call('messages', 'GET', undefined, `?q=${'가'.repeat(81)}`)).status, 400);
  assert.equal((await park.call('messages', 'GET', undefined, '?q=할인&channelId=ch_general')).status, 400);
});

test('R5 #46: poll since=0 returns only the cursor, then increments, hasMore past 200 events, and resync after the head', async () => {
  const { kim, lee } = await world();
  await lee.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const start = await lee.call('poll', 'GET', undefined, '?since=0');
  assert.equal(start.status, 200);
  assert.deepEqual(start.body.events, []);
  const cursor = start.body.cursor;
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '새 글' });
  const next = await lee.call('poll', 'GET', undefined, `?since=${cursor}`);
  assert.deepEqual(next.body.events.map((event) => event.kind), ['member.joined', 'message.created']);
  assert.equal(next.body.events[1].message.id, sent.body.message.id);
  assert.equal(next.body.events[1].message.body, '새 글');
  assert.equal(next.body.unread.total, 1);
  const quiet = await lee.call('poll', 'GET', undefined, `?since=${next.body.cursor}`);
  assert.deepEqual([quiet.body.events.length, quiet.body.unread], [0, null]);
  assert.notEqual((await lee.call('poll', 'GET', undefined, `?since=${next.body.cursor}&summary=1`)).body.unread, null);

  const from = next.body.cursor;
  for (let index = 0; index < 201; index += 1) await kim.call('messages', 'POST', { channelId: 'ch_general', body: `글 ${index}` });
  const page = await lee.call('poll', 'GET', undefined, `?since=${from}`);
  assert.equal(page.body.hasMore, true);
  assert.equal(page.body.events.length, 200);
  assert.equal(page.body.cursor, page.body.events[199].seq);
  const rest = await lee.call('poll', 'GET', undefined, `?since=${page.body.cursor}`);
  assert.deepEqual([rest.body.hasMore, rest.body.events.length], [false, 1]);

  const future = await lee.call('poll', 'GET', undefined, `?since=${rest.body.cursor + 1000}`);
  assert.deepEqual([future.body.resync, future.body.cursor, future.body.events.length], [true, rest.body.cursor, 0]);
  assert.equal((await lee.call('poll', 'GET', undefined, '?since=-1')).status, 400);
  assert.equal((await lee.call('poll', 'GET', undefined, '')).status, 400);
});

test('R5 #47: watching a private channel id yields none of its events; a public channel can be watched without joining', async () => {
  const { kim, lee, park } = await world();
  const secret = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '비밀', kind: 'private', memberIds: [lee.id] });
  const cursor = await cursorOf(park);
  await kim.call('messages', 'POST', { channelId: secret.body.channel.id, body: '비밀 글' });
  await kim.call('messages', 'POST', { channelId: 'ch_general', body: '공개 글' });
  const watchedPrivate = await park.call('poll', 'GET', undefined, `?since=${cursor}&watch=${secret.body.channel.id}`);
  assert.equal(watchedPrivate.body.events.length, 0);
  const watchedPublic = await park.call('poll', 'GET', undefined, `?since=${cursor}&watch=ch_general`);
  assert.deepEqual(watchedPublic.body.events.filter((event) => event.kind === 'message.created').map((event) => event.message.body), ['공개 글']);
  // A removed member still gets the member.left that names them.
  const leeCursor = await cursorOf(lee);
  assert.equal((await kim.call('channels', 'POST', { action: 'REMOVE_MEMBER', channelId: secret.body.channel.id, accountId: lee.id })).status, 200);
  const removed = await lee.call('poll', 'GET', undefined, `?since=${leeCursor}`);
  assert.deepEqual(removed.body.events.map((event) => [event.kind, event.subjectAccountId]), [['member.left', lee.id]]);
  assert.equal((await lee.call('messages', 'GET', undefined, `?channelId=${secret.body.channel.id}`)).status, 404);
});

test('R5 #48: someone else moving their read position produces no poll increment for me', async () => {
  const { kim, lee } = await world();
  for (const user of [kim, lee]) await user.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '읽어 주세요' });
  const cursor = await cursorOf(kim);
  assert.equal((await lee.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: sent.body.message.id })).status, 200);
  const poll = await kim.call('poll', 'GET', undefined, `?since=${cursor}`);
  assert.deepEqual([poll.body.events.length, poll.body.unread], [0, null]);
  // The position only moves forward and never past the newest message.
  await lee.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: 999999 });
  await lee.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: 0 });
  const [member] = await rows(`SELECT last_read_message_id FROM chat_members WHERE account_id = ? AND channel_id = 'ch_general'`, lee.id);
  assert.equal(member.last_read_message_id, sent.body.message.id);
  const outsider = await person('외부인');
  assert.equal((await outsider.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: 1 })).status, 404);
  assert.equal((await rows(`SELECT id FROM erp_audit_logs WHERE module = 'chat'`)).length, 0, 'read-state is never audited');
});

test('R5 #49: chat=view may JOIN, LEAVE and mark read but not send, upload or create; archive is admin-only', async () => {
  const { kim, lee } = await world();
  const viewer = await person('보기만', { chat: 'view' });
  assert.equal((await viewer.call('channels')).body.me.canWrite, false);
  assert.equal((await viewer.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' })).status, 200);
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '공지' });
  assert.equal((await viewer.call('read-state', 'PUT', { channelId: 'ch_general', lastReadMessageId: sent.body.message.id })).status, 200);
  assert.equal((await viewer.call('messages', 'POST', { channelId: 'ch_general', body: '못 씀' })).status, 403);
  const upload = await viewer.call('attachments', 'PUT', undefined, `?channelId=ch_general&name=a.png`, { rawBody: new Uint8Array([1, 2]), contentType: 'image/png', headers: { 'content-length': '2' } });
  assert.equal(upload.status, 403);
  assert.equal((await viewer.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '새 채널', kind: 'public' })).status, 403);
  assert.equal((await viewer.call('channels', 'POST', { action: 'LEAVE', channelId: 'ch_general' })).status, 200);
  assert.equal((await kim.call('channels', 'DELETE', undefined, '?id=ch_general')).status, 403);
  const denied = await rows(`SELECT after_json FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' AND module = 'chat'`);
  assert.ok(denied.length >= 3);

  const room = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '방', kind: 'public' });
  const roomId = room.body.channel.id;
  const none = await person('권한없음', { hr: 'edit' });
  const inactive = await person('비활성', { chat: 'edit' }, { active: false });
  for (const target of [none.id, inactive.id]) {
    assert.equal((await kim.call('channels', 'POST', { action: 'ADD_MEMBERS', channelId: roomId, accountIds: [target] })).status, 400);
  }
  assert.equal((await rows(`SELECT * FROM chat_members WHERE channel_id = ? AND account_id IN (?, ?)`, roomId, none.id, inactive.id)).length, 0);
  assert.equal((await none.call('channels')).status, 403, 'chat=none cannot even list');
  const added = await kim.call('channels', 'POST', { action: 'ADD_MEMBERS', channelId: roomId, accountIds: [lee.id] });
  assert.equal(added.body.channel.memberCount, 2);
  assert.equal((await lee.call('channels', 'POST', { action: 'RENAME', channelId: roomId, name: '남의 방' })).status, 403, 'only the owner renames');
  assert.equal((await kim.call('channels', 'POST', { action: 'REMOVE_MEMBER', channelId: roomId, accountId: kim.id })).status, 400, 'the owner stays');
  const renamed = await kim.call('channels', 'POST', { action: 'RENAME', channelId: roomId, name: '회의실', topic: '주간 회의' });
  assert.deepEqual([renamed.body.channel.name, renamed.body.channel.topic], ['회의실', '주간 회의']);
});

const png = new TextEncoder().encode('PNG-BYTES-FOR-TEST');
const pdf = new TextEncoder().encode('%PDF-1.4 test');
function upload(user, channelId, name, bytes, headers = { 'content-length': String(bytes.byteLength) }) {
  return user.call('attachments', 'PUT', undefined, `?channelId=${channelId}&name=${encodeURIComponent(name)}`, { rawBody: bytes, contentType: 'text/html', headers });
}

test('R5 #50: png and pdf round-trip for members with nosniff, sandbox CSP and the right disposition', async () => {
  const { kim, lee } = await world();
  for (const user of [kim, lee]) await user.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const image = await upload(kim, 'ch_general', '사진.PNG', png);
  assert.equal(image.status, 201);
  assert.deepEqual([image.body.attachment.contentType, image.body.attachment.isImage], ['image/png', true], 'type comes from the extension, not the request');
  const doc = await upload(kim, 'ch_general', '보고서 (최종).pdf', pdf);
  assert.equal(doc.status, 201);
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '', attachmentIds: [image.body.attachment.id, doc.body.attachment.id] });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.attachments.length, 2);
  const gotImage = await lee.call('attachments', 'GET', undefined, `?id=${image.body.attachment.id}`);
  assert.equal(gotImage.status, 200);
  assert.equal(gotImage.body, 'PNG-BYTES-FOR-TEST');
  assert.equal(gotImage.headers.get('content-type'), 'image/png');
  assert.equal(gotImage.headers.get('content-disposition'), 'inline');
  assert.equal(gotImage.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(gotImage.headers.get('cache-control'), 'private, no-store');
  assert.equal(gotImage.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  const gotPdf = await lee.call('attachments', 'GET', undefined, `?id=${doc.body.attachment.id}`);
  assert.equal(gotPdf.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('보고서 (최종).pdf').replace(/\(/g, '%28').replace(/\)/g, '%29')}`);
  assert.ok([...objects.keys()].every((key) => key.startsWith('chat/ch_general/att_')));
  const audit = await rows(`SELECT after_json FROM erp_audit_logs WHERE action = 'CHAT_ATTACHMENT_UPLOADED'`);
  assert.equal(audit.length, 2);
  for (const row of audit) assert.doesNotMatch(row.after_json, /사진|보고서/);
  // Deleting the message hides its attachments.
  await kim.call('messages', 'DELETE', undefined, `?id=${sent.body.message.id}`);
  assert.equal((await lee.call('attachments', 'GET', undefined, `?id=${image.body.attachment.id}`)).status, 404);
});

test('R5 #51: missing Content-Length 411, over 25MB 413 before reading (R2 untouched), svg/html/no-extension 415, length mismatch 413', async () => {
  const { kim } = await world();
  await kim.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const missing = await upload(kim, 'ch_general', 'a.png', png, {});
  assert.deepEqual([missing.status, missing.body.code], [411, 'LENGTH_REQUIRED']);
  const huge = await upload(kim, 'ch_general', 'a.png', png, { 'content-length': '26214401' });
  assert.deepEqual([huge.status, huge.body.code], [413, 'PAYLOAD_TOO_LARGE']);
  assert.equal(objects.size, 0);
  for (const name of ['a.svg', 'page.html', 'noext', 'photo.png.exe', 'script.js']) {
    const refused = await upload(kim, 'ch_general', name, png);
    assert.deepEqual([refused.status, refused.body.code], [415, 'UNSUPPORTED_MEDIA_TYPE'], name);
  }
  const mismatch = await upload(kim, 'ch_general', 'a.png', png, { 'content-length': String(png.byteLength + 5) });
  assert.equal(mismatch.status, 413);
  assert.equal(objects.size, 0);
  assert.equal((await rows(`SELECT id FROM chat_attachments`)).length, 0);
  const cleaned = await upload(kim, 'ch_general', '../../etc/pass\u0001wd.txt', png);
  assert.equal(cleaned.status, 201);
  assert.equal(cleaned.body.attachment.fileName, '....etcpasswd.txt');
});

test('R5 #52: someone else\'s attachment cannot be bound; non-members cannot download (404 private/DM, 403 public)', async () => {
  const { kim, lee, park } = await world();
  for (const user of [kim, lee]) await user.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' });
  const mine = await upload(kim, 'ch_general', 'a.png', png);
  const stolen = await lee.call('messages', 'POST', { channelId: 'ch_general', body: '내 것처럼', attachmentIds: [mine.body.attachment.id] });
  assert.equal(stolen.status, 400);
  assert.equal((await lee.call('attachments', 'GET', undefined, `?id=${mine.body.attachment.id}`)).status, 404, 'an unsent attachment is the uploader\'s only');
  assert.equal((await lee.call('attachments', 'DELETE', undefined, `?id=${mine.body.attachment.id}`)).status, 404);
  const sent = await kim.call('messages', 'POST', { channelId: 'ch_general', body: '첨부', attachmentIds: [mine.body.attachment.id] });
  const publicOutsider = await park.call('attachments', 'GET', undefined, `?id=${mine.body.attachment.id}`);
  assert.deepEqual([publicOutsider.status, publicOutsider.body.code], [403, 'FORBIDDEN']);
  assert.equal((await kim.call('attachments', 'DELETE', undefined, `?id=${sent.body.message.attachments[0].id}`)).status, 400, 'sent attachments go with the message');

  const dm = await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [lee.id] });
  const secret = await upload(kim, dm.body.channel.id, 'b.pdf', pdf);
  await kim.call('messages', 'POST', { channelId: dm.body.channel.id, body: '비밀 파일', attachmentIds: [secret.body.attachment.id] });
  assert.equal((await lee.call('attachments', 'GET', undefined, `?id=${secret.body.attachment.id}`)).status, 200);
  assert.equal((await park.call('attachments', 'GET', undefined, `?id=${secret.body.attachment.id}`)).status, 404);
  assert.equal((await admin.call('attachments', 'GET', undefined, `?id=${secret.body.attachment.id}`)).status, 404);
  assert.equal((await upload(park, dm.body.channel.id, 'c.png', png)).status, 404);
  assert.equal((await upload(park, 'ch_general', 'c.png', png)).status, 403, 'join a public channel before uploading');
  // Cancelling an unsent upload removes the R2 object.
  const draft = await upload(kim, 'ch_general', 'draft.png', png);
  const before = objects.size;
  assert.equal((await kim.call('attachments', 'DELETE', undefined, `?id=${draft.body.attachment.id}`)).status, 200);
  assert.equal(objects.size, before - 1);
});

test('R5 channels?members=: lists current members for members only (private non-members 404)', async () => {
  const { kim, lee, park } = await world();
  const room = await kim.call('channels', 'POST', { action: 'CREATE_CHANNEL', name: '비공개방', kind: 'private', memberIds: [lee.id] });
  const listed = await lee.call('channels', 'GET', undefined, `?members=${room.body.channel.id}`);
  assert.deepEqual([...listed.body.members].sort(), [kim.id, lee.id].sort());
  assert.equal((await park.call('channels', 'GET', undefined, `?members=${room.body.channel.id}`)).status, 404);
  assert.equal((await park.call('channels', 'GET', undefined, '?members=ch_general')).status, 200, 'public channels are readable');
});

test('R5 source guards: no raw HTML in chat UI, Enter respects Korean IME composition, title shows the unread count', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const file of ['app/chat-workspace.tsx', 'app/chat-client.ts', 'app/chat-mentions.ts']) {
    assert.doesNotMatch(read(file), /dangerouslySetInnerHTML|innerHTML/, file);
  }
  const workspace = read('app/chat-workspace.tsx');
  assert.match(workspace, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  assert.match(workspace, /rel="noopener noreferrer"/);
  assert.match(workspace, /url\.protocol === "http:" \|\| url\.protocol === "https:"/);
  assert.match(workspace, /clientKey: randomId\(\)/);
  const { chatTitle, CHAT_POLL_VISIBLE_MS, CHAT_POLL_IDLE_MS, CHAT_POLL_BACKOFF_MS } = await import('../app/chat-client.ts');
  assert.equal(chatTitle(0), 'XDnode management');
  assert.equal(chatTitle(3), '(3) XDnode management');
  assert.deepEqual([CHAT_POLL_VISIBLE_MS, CHAT_POLL_IDLE_MS, [...CHAT_POLL_BACKOFF_MS]], [2000, 15000, [5000, 10000, 30000]]);
  const { highlightMentions, extractMentions } = await import('../app/chat-mentions.ts');
  const people = [{ accountId: 'a', name: '김철' }, { accountId: 'b', name: '김철수' }, { accountId: 'c', name: '예시 직원A' }];
  assert.deepEqual(extractMentions('@김철수 님, @예시 직원A 와 @김철 에게 @channel', people), { accountIds: ['b', 'c', 'a'], channel: true });
  assert.deepEqual(extractMentions('메일 a@김철수회사.com', people).accountIds, [], 'a name followed by more letters is not a mention');
  assert.deepEqual(highlightMentions('안녕 @김철수!', people), [{ text: '안녕 ', mention: false }, { text: '@김철수', mention: true }, { text: '!', mention: false }]);
});

test('R5 bubbles and paste: my messages are right-aligned bubbles with their own colour; pasted captures become named image attachments', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const workspace = read('app/chat-workspace.tsx');
  const css = read('app/chat-workspace.css');
  assert.match(workspace, /"chat-message", mine \? "mine" : "theirs"/);
  assert.match(workspace, /className=\{editing \? "chat-bubble editing" : "chat-bubble"\}/);
  assert.match(css, /\.chat-bubble \{ width: fit-content; max-width: min\(560px, 75%\);/);
  assert.match(css, /\.chat-message\.mine \{ align-items: flex-end; \}/);
  const mine = /\.chat-message\.mine \.chat-bubble \{[^}]*background: (#[0-9a-f]+)/.exec(css)?.[1];
  const theirs = /\.chat-message\.theirs \.chat-bubble \{[^}]*background: (#[0-9a-f]+)/.exec(css)?.[1];
  assert.ok(mine && theirs && mine !== theirs, `bubble colours differ (${mine} / ${theirs})`);
  // 붙여넣기: 글이 함께 있으면 글 붙여넣기를 막지 않는다.
  assert.match(workspace, /onPaste=\{onPaste\}/);
  assert.match(workspace, /if \(!images\.length \|\| event\.clipboardData\.getData\("text\/plain"\)\.trim\(\)\) return;/);
  const { pastedImageFile, fileExtensionAllowed } = await import('../app/chat-client.ts');
  const when = new Date(2026, 8, 30, 9, 5, 7);
  const png = pastedImageFile(new File([new Uint8Array([1, 2])], 'image.png', { type: 'image/png' }), 0, when);
  assert.equal(png.name, '캡처-20260930-090507.png');
  assert.equal(png.size, 2);
  assert.equal(pastedImageFile(new File(['x'], 'image.png', { type: 'image/jpeg' }), 1, when).name, '캡처-20260930-090507-2.jpg');
  assert.ok(fileExtensionAllowed(png.name));
  const bmp = new File(['x'], 'image.bmp', { type: 'image/bmp' });
  assert.equal(pastedImageFile(bmp, 0, when), bmp, 'unsupported types keep their name and are refused by the extension check');
  assert.equal(fileExtensionAllowed(bmp.name), false);
});

test('R5 @ autocomplete: query detection, Hangul-in-progress matching, members first, @채널 and insertion', async () => {
  const { mentionQueryAt, mentionSuggestions, applyMention, hangulPrefixMatch, CHANNEL_MENTION } = await import('../app/chat-mentions.ts');
  // 커서 앞 '@질의'
  assert.deepEqual(mentionQueryAt('안녕 @김', 5), { start: 3, query: '김' });
  assert.deepEqual(mentionQueryAt('@', 1), { start: 0, query: '' });
  assert.equal(mentionQueryAt('mail a@b', 8), null, 'an @ inside a word (e-mail) is not a mention');
  assert.equal(mentionQueryAt('@김\n다음', 6), null, 'no newline inside the query');
  assert.equal(mentionQueryAt('@ 김', 3), null, 'a space right after @ closes it');
  assert.equal(mentionQueryAt('안녕', 2), null);
  // 한글 조합 중(ㄱ → 기 → 김)에도 맞는다
  for (const typed of ['ㄱ', '기', '김', '김철', '김처']) assert.equal(hangulPrefixMatch('김철수', typed), true, typed);
  for (const typed of ['ㄴ', '가', '김ㅊ철', '박']) assert.equal(hangulPrefixMatch('김철수', typed), false, typed);
  const people = [{ accountId: 'm1', name: '이두리' }, { accountId: 'm2', name: '김하나' }, { accountId: 'o1', name: '김철수' }, { accountId: 'o2', name: '박김치' }];
  // 넘겨준 순서(멤버 먼저)를 지키고, 앞부분 일치 → 중간 일치 순. @채널은 맨 뒤
  assert.deepEqual(mentionSuggestions(people, '').map((p) => p.accountId), ['m1', 'm2', 'o1', 'o2', CHANNEL_MENTION.accountId]);
  assert.deepEqual(mentionSuggestions(people, 'ㄱ').map((p) => p.accountId), ['m2', 'o1']);
  assert.deepEqual(mentionSuggestions(people, '김').map((p) => p.accountId), ['m2', 'o1', 'o2']);
  assert.deepEqual(mentionSuggestions(people, '채').map((p) => p.accountId), [CHANNEL_MENTION.accountId]);
  assert.deepEqual(mentionSuggestions(people, '', { includeChannel: false }).length, 4, '1:1 DM has no @채널');
  assert.deepEqual(mentionSuggestions(people, '김하나 안녕'), [], 'typing past a full name closes the list');
  // 넣기: '@질의'를 '@이름 '으로 바꾸고 커서는 뒤로
  assert.deepEqual(applyMention('확인 @김하 부탁', 3, 6, '김하나'), { text: '확인 @김하나 부탁', caret: 8 });
  assert.deepEqual(applyMention('@', 0, 1, '채널'), { text: '@채널 ', caret: 4 });
  // 넣은 이름은 서버 멘션 규칙(extractMentions)으로 그대로 잡힌다
  const { extractMentions } = await import('../app/chat-mentions.ts');
  assert.deepEqual(extractMentions(applyMention('@김', 0, 2, '김하나').text + '확인', people), { accountIds: ['m2'], channel: false });
  const { readFileSync } = await import('node:fs');
  const workspace = readFileSync(new URL('../app/chat-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /if \(menuOpen && !event\.nativeEvent\.isComposing\) \{/, 'menu keys wait for IME composition to finish');
  assert.match(workspace, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/, 'clicking a name keeps focus in the composer');
  assert.match(workspace, /if \(joined\?\.kind === "private"\) return inChannel;/, 'private channels suggest members only');
});

test('R5 the last opened conversation is remembered per account and restored only while it is still visible', async () => {
  const { readFileSync } = await import('node:fs');
  const workspace = readFileSync(new URL('../app/chat-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /export const ACTIVE_CHANNEL_KEY = "xdnode-chat-active-channel";/);
  assert.match(workspace, /if \(id\) writeScoped\(ACTIVE_CHANNEL_KEY, id\);/, 'every channel switch is saved under the account-scoped key');
  assert.match(workspace, /const saved = readScoped\(ACTIVE_CHANNEL_KEY, \[\]\);/, 'no unscoped legacy key is read');
  assert.match(workspace, /loaded\.channels\.some\(\(channel\) => channel\.id === saved\) \|\| loaded\.joinable\.some\(\(channel\) => channel\.id === saved\)/,
    'a saved channel I was removed from (or that disappeared) falls back to the first conversation');
  assert.doesNotMatch(workspace, /localStorage/, 'storage goes through the scoped helpers');
  const runtime = readFileSync(new URL('../app/client-runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime.slice(runtime.indexOf('SCOPED_DATA_KEYS')), /xdnode-chat-active-channel/, 'a view setting, not pay data: kept on logout like the active tab');
});
