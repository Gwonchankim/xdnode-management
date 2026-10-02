// messenger-enhancement(Design §8): R5 메신저 개선. 하니스(메모리 SQLite + 가짜 R2)로 실제 라우트를 실행한다.
// M1 공용 기반: 이동(around·after), 스레드 참여(chat_thread_reads)와 백필, DTO 확장(reactions·pinnedAt), 스키마 위치.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { callApi, createAccount, db, login, resetDatabase, setAccess } from './helpers/hr-api-harness.mjs';

const { ensureErpPlatformSchema } = await import('../app/erp-platform.ts');

async function person(name, tabs = { chat: 'edit' }) {
  const account = await createAccount({ displayName: name, tabs });
  const session = await login(account.email, account.password);
  const call = (path, method = 'GET', body, query = '', options = {}) => callApi(`chat/${path}`, method, body, query, { ...options, cookie: session.cookie });
  return { ...account, name, call };
}

async function world() {
  await resetDatabase();
  setAccess({}, { isAdmin: true });
  return { kim: await person('김하나'), lee: await person('이두리'), park: await person('박세나') };
}
const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

async function channel(owner, name, kind = 'public', memberIds = []) {
  const created = await owner.call('channels', 'POST', { action: 'CREATE_CHANNEL', name, kind, memberIds });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.channel.id;
}
async function post(user, channelId, body, threadRootId) {
  const sent = await user.call('messages', 'POST', { channelId, body, ...(threadRootId ? { threadRootId } : {}) });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return sent.body.message;
}
async function postMany(user, channelId, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push((await post(user, channelId, `글 ${index + 1}`)).id);
  return ids;
}

test('ME-FR-01 around: 25 before, the target and 25 after, with hasMore/hasNewer and focusId', async () => {
  const { kim } = await world();
  const id = await channel(kim, '이동');
  const ids = await postMany(kim, id, 70);
  const target = ids[30];
  const result = await kim.call('messages', 'GET', undefined, `?channelId=${id}&around=${target}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.focusId, target);
  assert.equal(result.body.focusReplyId, undefined);
  assert.deepEqual(result.body.messages.map((message) => message.id), ids.slice(5, 56));
  assert.equal(result.body.hasMore, true);
  assert.equal(result.body.hasNewer, true);

  const nearEnd = await kim.call('messages', 'GET', undefined, `?channelId=${id}&around=${ids[65]}`);
  assert.deepEqual(nearEnd.body.messages.map((message) => message.id), ids.slice(40, 70));
  assert.equal(nearEnd.body.hasNewer, false, 'the window reaches the latest message');

  const latest = await kim.call('messages', 'GET', undefined, `?channelId=${id}`);
  assert.equal(latest.body.hasNewer, false, 'the default window is always the latest');
});

test('ME-FR-01 around a reply opens its root window and names the reply', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '스레드이동');
  const ids = await postMany(kim, id, 5);
  const reply = await post(lee, id, '답글', ids[2]);
  const result = await kim.call('messages', 'GET', undefined, `?channelId=${id}&around=${reply.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.focusId, ids[2]);
  assert.equal(result.body.focusReplyId, reply.id);
  assert.ok(result.body.messages.every((message) => message.threadRootId === null), 'replies stay out of the channel window');
});

test('ME-FR-01 around refuses ids from other channels, hides private channels and takes one window only', async () => {
  const { kim, lee, park } = await world();
  const open = await channel(kim, '공개');
  const secret = await channel(kim, '비공개', 'private', [lee.id]);
  const [openId] = await postMany(kim, open, 1);
  const [secretId] = await postMany(kim, secret, 1);
  assert.equal((await kim.call('messages', 'GET', undefined, `?channelId=${open}&around=${secretId}`)).status, 404, 'a message from another channel is not found');
  assert.equal((await park.call('messages', 'GET', undefined, `?channelId=${secret}&around=${secretId}`)).status, 404, 'non-members cannot jump into a private channel');
  assert.equal((await kim.call('messages', 'GET', undefined, `?channelId=${open}&around=999999`)).status, 404);
  assert.equal((await kim.call('messages', 'GET', undefined, `?channelId=${open}&around=abc`)).status, 400);
  assert.equal((await kim.call('messages', 'GET', undefined, `?channelId=${open}&around=${openId}&before=${openId}`)).status, 400);
});

test('ME-DD15 after: reads newer top-level messages in order and reports hasNewer', async () => {
  const { kim } = await world();
  const id = await channel(kim, '이어읽기');
  const ids = await postMany(kim, id, 60);
  const first = await kim.call('messages', 'GET', undefined, `?channelId=${id}&after=${ids[4]}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.messages.map((message) => message.id), ids.slice(5, 55));
  assert.equal(first.body.hasNewer, true);
  const rest = await kim.call('messages', 'GET', undefined, `?channelId=${id}&after=${ids[49]}`);
  assert.deepEqual(rest.body.messages.map((message) => message.id), ids.slice(50));
  assert.equal(rest.body.hasNewer, false);
});

test('ME-DD13 replying makes you a thread participant; the root author joins at 0 on the first reply', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '참여');
  const [rootId, lonelyId] = await postMany(kim, id, 2);
  assert.equal((await rows(`SELECT * FROM chat_thread_reads`)).length, 0, 'top-level messages alone create no rows');

  const leeReply = await post(lee, id, '제가 할게요', rootId);
  const afterLee = await rows(`SELECT account_id, last_read_reply_id FROM chat_thread_reads WHERE thread_root_id = ? ORDER BY account_id`, rootId);
  assert.deepEqual(afterLee.map((row) => [row.account_id, Number(row.last_read_reply_id)]).sort(),
    [[kim.id, 0], [lee.id, leeReply.id]].sort());

  const kimReply = await post(kim, id, '고마워요', rootId);
  const kimRow = (await rows(`SELECT last_read_reply_id FROM chat_thread_reads WHERE thread_root_id = ? AND account_id = ?`, rootId, kim.id))[0];
  assert.equal(Number(kimRow.last_read_reply_id), kimReply.id, 'your own reply moves your thread read position');
  assert.equal((await rows(`SELECT * FROM chat_thread_reads WHERE thread_root_id = ?`, lonelyId)).length, 0);
});

test('ME §3.3 backfill: threads written before this feature become participation, idempotently', async () => {
  const { kim, lee, park } = await world();
  const id = await channel(kim, '백필');
  const [rootId, quietId] = await postMany(kim, id, 2);
  const first = await post(lee, id, '1', rootId);
  const second = await post(park, id, '2', rootId);
  const third = await post(lee, id, '3', rootId);
  await db.prepare(`DELETE FROM chat_thread_reads`).run();

  await ensureErpPlatformSchema(db);
  await ensureErpPlatformSchema(db);
  const got = await rows(`SELECT account_id, thread_root_id, last_read_reply_id FROM chat_thread_reads ORDER BY account_id`);
  const byAccount = Object.fromEntries(got.map((row) => [row.account_id, [Number(row.thread_root_id), Number(row.last_read_reply_id)]]));
  assert.equal(got.length, 3);
  assert.deepEqual(byAccount[lee.id], [rootId, third.id], 'repliers have read up to their own last reply');
  assert.deepEqual(byAccount[park.id], [rootId, second.id]);
  assert.deepEqual(byAccount[kim.id], [rootId, third.id], 'the root author has read the thread as it stood');
  assert.ok(first.id < second.id);
  assert.equal(got.some((row) => Number(row.thread_root_id) === quietId), false, 'roots without replies are not backfilled');
});

test('ME-DD2/DD4 message DTOs carry reactions grouped by emoji in click order and pinnedAt; deleted messages carry neither', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '디티오');
  const [plainId, reactedId] = await postMany(kim, id, 2);
  const plain = (await kim.call('messages', 'GET', undefined, `?channelId=${id}`)).body.messages.find((message) => message.id === plainId);
  assert.deepEqual(plain.reactions, []);
  assert.equal(plain.pinnedAt, null);

  const insert = (accountId, emoji, at) => db.prepare(`INSERT INTO chat_reactions (message_id, account_id, emoji, channel_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(reactedId, accountId, emoji, id, at).run();
  await insert(lee.id, '✅', 10);
  await insert(kim.id, '👍', 20);
  await insert(lee.id, '👍', 30);
  await db.prepare(`INSERT INTO chat_pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)`).bind(id, reactedId, kim.id, 1234).run();
  const reacted = (await kim.call('messages', 'GET', undefined, `?channelId=${id}`)).body.messages.find((message) => message.id === reactedId);
  assert.deepEqual(reacted.reactions, [{ emoji: '✅', accountIds: [lee.id] }, { emoji: '👍', accountIds: [kim.id, lee.id] }]);
  assert.equal(reacted.pinnedAt, 1234);

  assert.equal((await kim.call('messages', 'DELETE', undefined, `?id=${reactedId}`)).status, 200);
  const deleted = (await kim.call('messages', 'GET', undefined, `?channelId=${id}`)).body.messages.find((message) => message.id === reactedId);
  assert.deepEqual(deleted.reactions, []);
  assert.equal(deleted.pinnedAt, null);
});

test('ME G7 schema placement: the new chat tables are created only in app/chat-schema.ts', () => {
  const schema = readFileSync(new URL('../app/chat-schema.ts', import.meta.url), 'utf8');
  const tables = ['chat_reactions', 'chat_pins', 'chat_bookmarks', 'chat_member_prefs', 'chat_thread_reads'];
  for (const table of tables) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  assert.doesNotMatch(schema, /\b(DROP|ALTER) TABLE\b/, 'add only (D4, ME-MD8)');
  const routes = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'route.ts') routes.push(path);
    }
  };
  walk(fileURLToPath(new URL('../app/api', import.meta.url)));
  assert.ok(routes.some((route) => route.endsWith('chat/messages/route.ts') || route.endsWith('chat\\messages/route.ts')), 'the walk found the chat routes');
  for (const route of routes) {
    const source = readFileSync(route, 'utf8');
    for (const table of tables) assert.doesNotMatch(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${route} must not create ${table}`);
  }
});

test('ME-FR-01 client: search results and the focus highlight go through openTarget and around', () => {
  const workspace = readFileSync(new URL('../app/chat-workspace.tsx', import.meta.url), 'utf8');
  const message = readFileSync(new URL('../app/chat-message.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /openTarget\(result\.channel\.id, result\.message\.id\)/);
  assert.match(workspace, /&around=\$\{target\.messageId\}/);
  assert.match(workspace, /if \(mode === "replace" \|\| current\.hasNewer\) return current;/, 'poll does not append to an old window');
  assert.match(workspace, /최신 메시지로 ↓/);
  assert.match(message, /focused \? "focus" : ""/);
});

// ── M2 알림·활동함 ──────────────────────────────────────────────────────────
const summaryOf = async (user) => (await user.call('poll', 'GET', undefined, '?since=0&summary=1')).body.unread;
const channelRow = (summary, id) => summary.channels.find((row) => row.channelId === id);

test('ME-FR-04 §3.4 notify levels: all counts unread, mentions counts mentions, mute counts only direct mentions', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '알림수준', 'public', [lee.id]);
  await post(kim, id, '일반 글 1');
  await post(kim, id, '일반 글 2');
  await post(kim, id, '@channel 공지');
  await post(kim, id, '@이두리 확인 부탁해요');

  const all = await summaryOf(lee);
  assert.deepEqual({ ...channelRow(all, id) }, { channelId: id, unread: 4, mentions: 2, lastMessageId: channelRow(all, id).lastMessageId, kind: 'public', name: '알림수준', notifyLevel: 'all' });
  assert.equal(all.total, 4);
  assert.equal(all.threads, 0);

  const toMentions = await lee.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: id, level: 'mentions' });
  assert.equal(toMentions.status, 200);
  assert.equal(toMentions.body.unread.total, 2, 'mentions-only counts @이두리 and @channel');
  const toMute = await lee.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: id, level: 'mute' });
  assert.equal(toMute.body.unread.total, 1, 'mute still counts the direct mention');
  assert.equal(channelRow(toMute.body.unread, id).unread, 4, 'the channel badge keeps its unread count');
  assert.equal(channelRow(toMute.body.unread, id).notifyLevel, 'mute');
  assert.equal((await lee.call('channels')).body.channels.find((row) => row.id === id).notifyLevel, 'mute');
  assert.equal((await summaryOf(kim)).total, 0, 'my own messages never count');
  const audits = await rows(`SELECT action FROM erp_audit_logs WHERE module = 'chat'`);
  assert.equal(audits.filter((row) => /NOTIFY/.test(row.action)).length, 0, 'personal state is not audited (ME-MD9)');
});

test('ME-FR-04 SET_NOTIFY validates the level, hides channels I am not in and is open to view-only members', async () => {
  const { kim, lee, park } = await world();
  const secret = await channel(kim, '비밀', 'private', [lee.id]);
  assert.equal((await lee.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: secret, level: 'loud' })).status, 400);
  assert.equal((await park.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: secret, level: 'mute' })).status, 404);
  assert.equal((await park.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: 'ch_general', level: 'mute' })).status, 404, 'public but not joined');
  assert.equal((await lee.call('me', 'PUT', { action: 'NOPE' })).status, 400);
  assert.equal((await lee.call('me', 'GET')).status, 400, 'view is required');
  const viewer = await person('보기전용', { chat: 'view' });
  assert.equal((await viewer.call('channels', 'POST', { action: 'JOIN', channelId: 'ch_general' })).status, 200);
  assert.equal((await viewer.call('me', 'PUT', { action: 'SET_NOTIFY', channelId: 'ch_general', level: 'mentions' })).status, 200);
});

test('ME-FR-05 threads and activity: participants see new replies; mentions are listed once; THREAD_READ only moves forward', async () => {
  const { kim, lee, park } = await world();
  const id = await channel(kim, '활동', 'public', [lee.id, park.id]);
  const root = await post(kim, id, '이번 주 마감 정리');
  const leeReply = await post(lee, id, '제가 급여대장 볼게요', root.id);
  const parkReply = await post(park, id, '저는 4대보험', root.id);
  const mentionReply = await post(park, id, '@이두리 이것도 봐 주세요', root.id);
  const topMention = await post(kim, id, '@이두리 회의 10시');

  assert.equal((await summaryOf(kim)).threads, 3, 'the root author follows every reply from the first');
  const leeSummary = await summaryOf(lee);
  assert.equal(leeSummary.threads, 1, 'own replies are read; the mention reply is counted as a mention instead');

  const feed = await lee.call('me', 'GET', undefined, '?view=activity');
  assert.equal(feed.status, 200);
  const shape = feed.body.items.map((item) => [item.kind, item.message.id, item.unread]);
  assert.deepEqual(shape, [['mention', topMention.id, true], ['mention', mentionReply.id, true], ['thread_reply', parkReply.id, true]]);
  assert.equal(feed.body.items[0].channel.name, '활동');
  assert.ok(!shape.some(([, messageId]) => messageId === leeReply.id), 'my own replies are not activity');

  const read = await lee.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: root.id, lastReadReplyId: mentionReply.id });
  assert.equal(read.status, 200);
  assert.equal(read.body.unread.threads, 0);
  await lee.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: root.id, lastReadReplyId: 0 });
  const stored = (await rows(`SELECT last_read_reply_id FROM chat_thread_reads WHERE account_id = ? AND thread_root_id = ?`, lee.id, root.id))[0];
  assert.equal(Number(stored.last_read_reply_id), mentionReply.id, 'THREAD_READ never moves backwards');
  const after = (await lee.call('me', 'GET', undefined, '?view=activity')).body.items;
  assert.equal(after.find((item) => item.kind === 'thread_reply').unread, false);

  assert.equal((await lee.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: leeReply.id, lastReadReplyId: 1 })).status, 400, 'replies have no thread');
  assert.equal((await lee.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: root.id, lastReadReplyId: -1 })).status, 400);
});

test('ME-FR-05 THREAD_READ and activity never reach into private channels I am not in', async () => {
  const { kim, lee, park } = await world();
  const secret = await channel(kim, '비공개활동', 'private', [lee.id]);
  const root = await post(kim, secret, '@박세나 보이면 안 됨');
  await post(lee, secret, '답글', root.id);
  assert.equal((await park.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: root.id, lastReadReplyId: 999 })).status, 404);
  assert.deepEqual((await park.call('me', 'GET', undefined, '?view=activity')).body.items, []);
  assert.equal((await rows(`SELECT * FROM chat_thread_reads WHERE account_id = ?`, park.id)).length, 0);
});

test('ME G4 shouldNotify follows the §3.4 table; toasts carry place and preview', async () => {
  const { shouldNotify, toastFor, badgeText } = await import('../app/chat-notify.ts');
  const me = 'me';
  const message = (extra = {}) => ({
    id: 7, channelId: 'c', threadRootId: null, author: { accountId: 'other', name: '이두리' }, body: '내일  마감\n입니다', mentions: [], mentionChannel: false,
    attachments: [], replyCount: 0, lastReplyAt: null, createdAt: 0, editedAt: null, deleted: false, reactions: [], pinnedAt: null, ...extra,
  });
  const event = (extra = {}, kind = 'message.created') => ({ seq: 1, kind, channelId: 'c', message: message(extra) });
  const meta = (notifyLevel, kind = 'public') => ({ kind, name: '경영지원', notifyLevel });
  const decide = (e, level, viewing = null) => shouldNotify(e, { me, channel: level ? meta(level) : undefined, viewingChannelId: viewing });

  assert.equal(decide(event(), 'all'), true);
  assert.equal(decide(event({ threadRootId: 3 }), 'all'), false, 'plain replies do not ring');
  assert.equal(decide(event({ threadRootId: 3, mentions: [me] }), 'all'), true);
  assert.equal(decide(event(), 'mentions'), false);
  assert.equal(decide(event({ mentionChannel: true }), 'mentions'), true);
  assert.equal(decide(event({ mentionChannel: true }), 'mute'), false, 'mute ignores @channel');
  assert.equal(decide(event({ mentions: [me] }), 'mute'), true);
  assert.equal(decide(event(), undefined), false, 'unknown (not joined) channels ring only for direct mentions');
  assert.equal(decide(event({ mentions: [me] }), undefined), true);
  assert.equal(decide(event({ author: { accountId: me, name: '나' } }), 'all'), false, 'never for my own message');
  assert.equal(decide(event({ deleted: true }), 'all'), false);
  assert.equal(decide(event({}, 'message.edited'), 'all'), false, 'reactions and pins arrive as message.edited and never ring');
  assert.equal(decide(event({ mentions: [me] }), 'all', 'c'), false, 'the conversation on screen never rings');
  assert.equal(decide(event(), 'all', 'other-channel'), true);

  const toast = toastFor(event(), meta('all'), 1000);
  assert.deepEqual([toast.author, toast.place, toast.preview, toast.messageId, toast.expiresAt], ['이두리', '# 경영지원', '내일 마감 입니다', 7, 7000]);
  assert.equal(toastFor(event({ threadRootId: 3 }), meta('all', 'dm'), 0).place, '1:1 대화 · 스레드');
  assert.equal(toastFor(event({ body: '', attachments: [{ id: 'a' }] }), meta('all', 'group_dm'), 0).preview, '📎 파일');
  assert.deepEqual([badgeText(5), badgeText(99), badgeText(100)], ['5', '99', '99+']);
});

test('ME-FR-02 shell wiring: the notifier and toasts are mounted in page.tsx and the chat screen reports what it shows', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const page = read('app/page.tsx');
  const workspace = read('app/chat-workspace.tsx');
  const notify = read('app/chat-notify.ts');
  assert.match(page, /useChatNotifier\(\{/);
  assert.match(page, /<ChatToasts /);
  assert.match(page, /chatPoll\.requestOpen\(channelId, messageId\)/);
  assert.match(workspace, /setViewing\(/);
  assert.match(workspace, /consumeOpen\(openRequest\.seq\)/);
  // 회귀 가드: poll 객체는 셸이 다시 그려질 때마다 새로 생긴다. 의존성에 넣으면 읽음 PUT → 기록 재요청이 되풀이된다.
  for (const [file, source] of [['app/chat-workspace.tsx', workspace], ['app/chat-notify.ts', notify]]) {
    assert.deepEqual(source.match(/\[[^\]\n]*\bpoll\b[^\]\n]*\]\)/g) ?? [], [], `${file}: no hook may depend on the poll object`);
  }
  assert.match(workspace, /action: "THREAD_READ"/);
  assert.match(notify, /window\.isSecureContext && "Notification" in window/, 'system notifications only in a secure context (ME-MD2)');
  for (const file of ['app/chat-notify.ts', 'app/chat-toasts.tsx', 'app/chat-panels.tsx']) assert.doesNotMatch(read(file), /dangerouslySetInnerHTML|innerHTML/, file);
});

// ── M3 확인 문화 ─────────────────────────────────────────────────────────────
const react = (user, messageId, emoji) => user.call('reactions', 'POST', { messageId, emoji });

test('ME-FR-07 reactions toggle, arrive as message.edited without (edited), and are audited', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '반응', 'public', [lee.id]);
  const message = await post(kim, id, '내일 마감입니다');
  const cursor = (await lee.call('poll', 'GET', undefined, '?since=0')).body.cursor;

  const added = await react(lee, message.id, '👍');
  assert.equal(added.status, 200);
  assert.equal(added.body.added, true);
  assert.deepEqual(added.body.message.reactions, [{ emoji: '👍', accountIds: [lee.id] }]);
  assert.equal(added.body.message.editedAt, null, 'a reaction is not an edit');
  // 누른 순서는 created_at(ms)이다. 같은 ms 면 계정 id 순이라 테스트에서는 간격을 둔다.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  await tick();
  await react(kim, message.id, '👍');
  await tick();
  const both = await react(kim, message.id, '✅');
  assert.deepEqual(both.body.message.reactions, [{ emoji: '👍', accountIds: [lee.id, kim.id] }, { emoji: '✅', accountIds: [kim.id] }]);

  const polled = await lee.call('poll', 'GET', undefined, `?since=${cursor}`);
  const edited = polled.body.events.filter((event) => event.kind === 'message.edited' && event.message?.id === message.id);
  assert.equal(edited.length, 3);
  assert.deepEqual(edited.at(-1).message.reactions, both.body.message.reactions);

  const removed = await react(lee, message.id, '👍');
  assert.equal(removed.body.added, false);
  assert.deepEqual(removed.body.message.reactions, [{ emoji: '👍', accountIds: [kim.id] }, { emoji: '✅', accountIds: [kim.id] }]);
  const audits = await rows(`SELECT action, after_json FROM erp_audit_logs WHERE action LIKE 'CHAT_REACTION_%' ORDER BY rowid`);
  assert.deepEqual(audits.map((row) => row.action), ['CHAT_REACTION_ADDED', 'CHAT_REACTION_ADDED', 'CHAT_REACTION_ADDED', 'CHAT_REACTION_REMOVED']);
  assert.doesNotMatch(audits[0].after_json, /마감/, 'the audit row never carries the message text');
});

test('ME-FR-07 reactions are refused outside the fixed eight, in hidden, archived, deleted or unjoined conversations and for view-only accounts', async () => {
  const { kim, lee, park } = await world();
  const open = await channel(kim, '공개반응');
  const secret = await channel(kim, '비공개반응', 'private', [lee.id]);
  const openMessage = await post(kim, open, '공개 글');
  const secretMessage = await post(kim, secret, '비밀 글');
  assert.equal((await react(kim, openMessage.id, '🔥')).status, 400);
  assert.equal((await react(kim, openMessage.id, '👍🏻')).status, 400, 'skin-tone variants are not in the list');
  assert.equal((await react(kim, 'x', '👍')).status, 400);
  assert.equal((await react(park, secretMessage.id, '👍')).status, 404, 'private non-members get 404');
  assert.equal((await react(park, openMessage.id, '👍')).status, 403, 'public non-members must join first');
  assert.equal((await react(kim, 999999, '👍')).status, 404);
  const viewer = await person('보기만', { chat: 'view' });
  assert.equal((await react(viewer, openMessage.id, '👍')).status, 403);

  const deleted = await post(kim, open, '지울 글');
  await kim.call('messages', 'DELETE', undefined, `?id=${deleted.id}`);
  assert.equal((await react(kim, deleted.id, '👍')).status, 409);
  setAccess({}, { isAdmin: true });
  const { callApi: adminCall, TEST_SESSION_TOKEN } = await import('./helpers/hr-api-harness.mjs');
  assert.equal((await adminCall('chat/channels', 'DELETE', undefined, `?id=${open}`, { cookie: TEST_SESSION_TOKEN })).status, 200);
  assert.equal((await react(kim, openMessage.id, '👍')).status, 409, 'archived conversations are read-only');
});

test('ME-FR-08 poll reads: members of the active channel get read positions, others get null, and reading shows up on the next poll', async () => {
  const { kim, lee, park } = await world();
  const id = await channel(kim, '읽음', 'private', [lee.id]);
  const message = await post(kim, id, '확인해 주세요');
  const before = (await kim.call('poll', 'GET', undefined, `?since=0&active=${id}`)).body.reads;
  assert.equal(before.channelId, id);
  const leeBefore = before.members.find((member) => member.accountId === lee.id);
  assert.equal(leeBefore.lastReadMessageId, 0);
  assert.equal(before.members.find((member) => member.accountId === kim.id).lastReadMessageId, message.id, 'the author has read their own message');
  assert.deepEqual(Object.keys(leeBefore).sort(), ['accountId', 'joinedAt', 'lastReadMessageId'], 'positions only, no names or times of reading');

  assert.equal((await park.call('poll', 'GET', undefined, `?since=0&active=${id}`)).body.reads, null, 'non-members learn nothing about a private channel');
  assert.equal((await kim.call('poll', 'GET', undefined, '?since=0')).body.reads, null, 'no active channel, no snapshot');

  const cursor = (await kim.call('poll', 'GET', undefined, '?since=0')).body.cursor;
  assert.equal((await lee.call('read-state', 'PUT', { channelId: id, lastReadMessageId: message.id })).status, 200);
  const after = await kim.call('poll', 'GET', undefined, `?since=${cursor}&active=${id}`);
  assert.deepEqual(after.body.events, [], 'reading is still not an event (R5 #48)');
  assert.equal(after.body.reads.members.find((member) => member.accountId === lee.id).lastReadMessageId, message.id);
});

test('ME-FR-09 poll presence: every poll touches memory only; summary polls fill the rest from sessions for chat users only', async () => {
  const { kim, lee } = await world();
  const hrOnly = await person('인사만', { hr: 'edit' });
  await kim.call('poll', 'GET', undefined, '?since=0');
  const statements = [];
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => { statements.push(sql); return originalPrepare(sql); };
  try {
    for (let index = 0; index < 5; index += 1) await lee.call('poll', 'GET', undefined, `?since=1&active=ch_general`);
  } finally {
    db.prepare = originalPrepare;
  }
  const writes = statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/auth_sessions/.test(sql));
  assert.deepEqual(writes, [], 'polls write nothing but the hourly session touch (ME NFR)');
  const light = await lee.call('poll', 'GET', undefined, '?since=1');
  assert.ok(light.body.presence[kim.id] > 0 && light.body.presence[lee.id] > 0);
  assert.equal(light.body.presence[hrOnly.id], undefined);

  const { resetPresence } = await import('../app/chat-presence.ts');
  resetPresence();
  const summary = await lee.call('poll', 'GET', undefined, '?since=0&summary=1');
  assert.ok(summary.body.presence[kim.id] > 0, 'after a restart the session last_seen_at fills in');
  assert.equal(summary.body.presence[hrOnly.id], undefined, 'accounts without chat access are never listed');
});

test('ME G3/G5/G6 reaction lists match; unreadCountFor and presenceLabel follow the rules', async () => {
  const server = await import('../app/chat-server.ts');
  const { CHAT_REACTIONS, unreadCountFor, presenceLabel, CHAT_PRESENCE_ONLINE_MS } = await import('../app/chat-client.ts');
  assert.deepEqual([...CHAT_REACTIONS], [...server.CHAT_REACTIONS]);
  assert.equal(CHAT_REACTIONS.length, 8);

  const message = { id: 10, channelId: 'c', threadRootId: null, author: { accountId: 'a' }, createdAt: 1000, deleted: false };
  const reads = { channelId: 'c', members: [
    { accountId: 'a', lastReadMessageId: 10, joinedAt: 0 },
    { accountId: 'b', lastReadMessageId: 9, joinedAt: 0 },
    { accountId: 'c', lastReadMessageId: 10, joinedAt: 0 },
    { accountId: 'd', lastReadMessageId: 0, joinedAt: 5000 },
  ] };
  assert.equal(unreadCountFor(message, reads), 1, 'b has not read; the author, c and the later joiner d do not count');
  assert.equal(unreadCountFor({ ...message, threadRootId: 3 }, reads), null);
  assert.equal(unreadCountFor({ ...message, deleted: true }, reads), null);
  assert.equal(unreadCountFor(message, { ...reads, channelId: 'other' }), null);
  assert.equal(unreadCountFor(message, null), null);

  const now = Date.UTC(2026, 8, 30, 3, 0, 0);
  assert.deepEqual(presenceLabel(now - CHAT_PRESENCE_ONLINE_MS, now), { online: true, short: '', long: '온라인' });
  assert.equal(presenceLabel(now - CHAT_PRESENCE_ONLINE_MS - 1, now).online, false);
  assert.deepEqual(presenceLabel(now - 5 * 60_000, now), { online: false, short: '5분', long: '5분 전 활동' });
  assert.equal(presenceLabel(now - 50_000, now).short, '1분', 'just past the online window reads as 1 minute');
  assert.equal(presenceLabel(undefined, now).long, '');
  assert.match(presenceLabel(now - 3 * 86_400_000, now).long, /활동$/);
});

test('ME-FR-07/08/09 UI wiring: reaction bar, read count and presence dots are rendered from poll state', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const message = read('app/chat-message.tsx');
  const workspace = read('app/chat-workspace.tsx');
  assert.match(message, /CHAT_REACTIONS\.map\(\(emoji\)/);
  assert.match(message, /aria-label=\{`안 읽은 사람 \$\{unreadCount\}명`\}/);
  assert.doesNotMatch(message + workspace, /읽은 사람:|안 읽은 사람:/, 'no list of readers anywhere (ME-MD3)');
  assert.match(workspace, /unreadCount=\{unreadCountFor\(message, reads\)\}/);
  assert.match(workspace, /"\/api\/chat\/reactions"/);
  assert.match(workspace, /<PresenceDot lastSeen=\{poll\.presence\[/);
});

// ── M4 정보 정리 ─────────────────────────────────────────────────────────────
const pin = (user, messageId, action = 'PIN') => user.call('pins', 'POST', { action, messageId });
function uploadFile(user, channelId, name, text = 'FILE-BYTES') {
  const bytes = new TextEncoder().encode(text);
  return user.call('attachments', 'PUT', undefined, `?channelId=${channelId}&name=${encodeURIComponent(name)}`,
    { rawBody: bytes, contentType: 'application/octet-stream', headers: { 'content-length': String(bytes.byteLength) } });
}
async function postWithFiles(user, channelId, body, names) {
  const ids = [];
  for (const name of names) {
    const uploaded = await uploadFile(user, channelId, name);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    ids.push(uploaded.body.attachment.id);
  }
  const sent = await user.call('messages', 'POST', { channelId, body, attachmentIds: ids });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return sent.body.message;
}

test('ME-FR-10 pins: owners pin and unpin, members see the list and count, events and audit follow', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '공지', 'public', [lee.id]);
  const notice = await post(kim, id, '10월 급여 마감은 25일입니다');
  assert.equal((await pin(lee, notice.id)).status, 403, 'members cannot pin (ME-MD5)');
  const cursor = (await lee.call('poll', 'GET', undefined, '?since=0')).body.cursor;

  const pinned = await pin(kim, notice.id);
  assert.equal(pinned.status, 200);
  assert.ok(pinned.body.message.pinnedAt > 0);
  assert.equal((await pin(kim, notice.id)).status, 200, 'pinning twice is fine');
  const list = await lee.call('pins', 'GET', undefined, `?channelId=${id}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.pins.map((item) => [item.message.id, item.pinnedBy.name]), [[notice.id, '김하나']]);
  assert.equal((await lee.call('channels')).body.channels.find((row) => row.id === id).pinCount, 1);
  const kinds = (await lee.call('poll', 'GET', undefined, `?since=${cursor}`)).body.events.map((event) => event.kind);
  assert.ok(kinds.includes('message.edited') && kinds.includes('channel.updated'));

  const unpinned = await pin(kim, notice.id, 'UNPIN');
  assert.equal(unpinned.body.message.pinnedAt, null);
  assert.equal((await lee.call('pins', 'GET', undefined, `?channelId=${id}`)).body.pins.length, 0);
  const audits = await rows(`SELECT action FROM erp_audit_logs WHERE action LIKE 'CHAT_MESSAGE_%PINNED' ORDER BY rowid`);
  assert.deepEqual(audits.map((row) => row.action), ['CHAT_MESSAGE_PINNED', 'CHAT_MESSAGE_PINNED', 'CHAT_MESSAGE_UNPINNED']);
});

test('ME-FR-10 pins are limited to 10 top-level messages in rooms; hidden channels stay 404 even for admins', async () => {
  const { kim, lee, park } = await world();
  const id = await channel(kim, '한도');
  const ids = await postMany(kim, id, 11);
  for (const messageId of ids.slice(0, 10)) assert.equal((await pin(kim, messageId)).status, 200);
  const over = await pin(kim, ids[10]);
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'PIN_LIMIT');
  const reply = await post(kim, id, '답글', ids[0]);
  assert.equal((await pin(kim, reply.id)).status, 400, 'replies cannot be pinned');
  assert.equal((await pin(kim, ids[0], 'MOVE')).status, 400);

  await kim.call('messages', 'DELETE', undefined, `?id=${ids[0]}`);
  assert.equal((await kim.call('pins', 'GET', undefined, `?channelId=${id}`)).body.pins.length, 9, 'deleted messages drop out of the list');
  assert.equal((await pin(kim, ids[10])).status, 200, 'and free their slot');

  const dm = await kim.call('channels', 'POST', { action: 'OPEN_DM', accountIds: [lee.id] });
  const dmMessage = await post(kim, dm.body.channel.id, 'DM');
  assert.equal((await pin(kim, dmMessage.id)).status, 400, 'no pins in DMs (ME-MD5)');

  const secret = await channel(lee, '관리자도못봄', 'private');
  const secretMessage = await post(lee, secret, '비밀');
  const { callApi: adminCall, TEST_SESSION_TOKEN } = await import('./helpers/hr-api-harness.mjs');
  setAccess({}, { isAdmin: true });
  assert.equal((await adminCall('chat/pins', 'POST', { action: 'PIN', messageId: secretMessage.id }, '', { cookie: TEST_SESSION_TOKEN })).status, 404);
  assert.equal((await park.call('pins', 'GET', undefined, `?channelId=${secret}`)).status, 404);
  assert.equal((await adminCall('chat/pins', 'POST', { action: 'PIN', messageId: ids[1] }, '', { cookie: TEST_SESSION_TOKEN })).status, 200, 'admins may pin in public rooms');
});

test('ME-FR-11 bookmarks are personal, survive in the list only while the conversation is visible, and are not audited', async () => {
  const { kim, lee } = await world();
  const secret = await channel(kim, '저장', 'private', [lee.id]);
  const message = await post(kim, secret, '나중에 볼 글');
  const saved = await lee.call('me', 'PUT', { action: 'BOOKMARK', messageId: message.id });
  assert.deepEqual([saved.status, saved.body.bookmarked], [200, true]);
  assert.equal((await lee.call('me', 'PUT', { action: 'BOOKMARK', messageId: message.id })).status, 200, 'saving twice is fine');
  const list = await lee.call('me', 'GET', undefined, '?view=bookmarks');
  assert.deepEqual(list.body.bookmarks.map((item) => [item.message.id, item.channel.name]), [[message.id, '저장']]);
  assert.deepEqual((await kim.call('me', 'GET', undefined, '?view=bookmarks')).body.bookmarks, [], 'only mine');

  assert.equal((await kim.call('channels', 'POST', { action: 'REMOVE_MEMBER', channelId: secret, accountId: lee.id })).status, 200);
  assert.deepEqual((await lee.call('me', 'GET', undefined, '?view=bookmarks')).body.bookmarks, [], 'hidden after losing access');
  assert.equal((await rows(`SELECT * FROM chat_bookmarks WHERE account_id = ?`, lee.id)).length, 1, 'but the row stays');
  assert.equal((await lee.call('me', 'PUT', { action: 'BOOKMARK', messageId: message.id })).status, 404);

  const open = await channel(kim, '공개저장');
  const gone = await post(kim, open, '지울 글');
  await kim.call('me', 'PUT', { action: 'BOOKMARK', messageId: gone.id });
  await kim.call('messages', 'DELETE', undefined, `?id=${gone.id}`);
  assert.deepEqual((await kim.call('me', 'GET', undefined, '?view=bookmarks')).body.bookmarks, [], 'deleted messages drop out');
  assert.equal((await kim.call('me', 'PUT', { action: 'BOOKMARK', messageId: gone.id })).status, 409);
  assert.equal((await kim.call('me', 'PUT', { action: 'UNBOOKMARK', messageId: gone.id })).body.bookmarked, false);
  assert.equal((await rows(`SELECT * FROM erp_audit_logs WHERE action LIKE '%BOOKMARK%'`)).length, 0);
});

test('ME-FR-12 files: members list the channel files newest first with paging; deleted messages and other channels stay out', async () => {
  const { kim, lee, park } = await world();
  const id = await channel(kim, '파일방', 'private', [lee.id]);
  const first = await postWithFiles(kim, id, '보고서', ['보고서.pdf', '사진.png']);
  const second = await postWithFiles(lee, id, '', ['명단.xlsx']);
  const removed = await postWithFiles(kim, id, '지울 파일', ['지울.txt']);
  await kim.call('messages', 'DELETE', undefined, `?id=${removed.id}`);
  await uploadFile(kim, id, '보내지않음.txt');

  const list = await lee.call('attachments', 'GET', undefined, `?channelId=${id}`);
  assert.equal(list.status, 200);
  const names = list.body.files.map((item) => item.attachment.fileName);
  assert.equal(names[0], '명단.xlsx', 'newest message first');
  // 같은 밀리초에 올라간 첨부끼리는 id 순서라 정해져 있지 않다.
  assert.deepEqual(names.slice(1).sort(), ['보고서.pdf', '사진.png'].sort());
  assert.equal(list.body.files[0].messageId, second.id);
  assert.equal(list.body.files[0].uploaderName, '이두리');
  assert.equal(list.body.files.find((item) => item.attachment.fileName === '사진.png').attachment.isImage, true);
  assert.equal(list.body.files.find((item) => item.attachment.fileName === '보고서.pdf').messageId, first.id);
  assert.equal(list.body.nextBefore, null);

  assert.equal((await park.call('attachments', 'GET', undefined, `?channelId=${id}`)).status, 404);
  assert.equal((await park.call('attachments', 'GET', undefined, '?channelId=ch_general')).status, 403, 'public non-members must join, as for downloads');
  assert.equal((await lee.call('attachments', 'GET', undefined, `?channelId=${id}&id=att_x`)).status, 400);
  assert.equal((await lee.call('attachments', 'GET', undefined, `?channelId=${id}&before=nope`)).status, 400);
});

test('ME-FR-12 files paging: 50 per page with a createdAt_id cursor', async () => {
  const { kim } = await world();
  const id = await channel(kim, '많은파일');
  for (let index = 0; index < 6; index += 1) {
    const names = Array.from({ length: 10 }, (_, inner) => `f${index}-${inner}.txt`);
    await postWithFiles(kim, id, `묶음 ${index}`, names);
  }
  const first = await kim.call('attachments', 'GET', undefined, `?channelId=${id}`);
  assert.equal(first.body.files.length, 50);
  assert.match(first.body.nextBefore, /^\d+_att_/);
  const second = await kim.call('attachments', 'GET', undefined, `?channelId=${id}&before=${encodeURIComponent(first.body.nextBefore)}`);
  assert.equal(second.body.files.length, 10);
  assert.equal(second.body.nextBefore, null);
  const all = [...first.body.files, ...second.body.files].map((item) => item.attachment.id);
  assert.equal(new Set(all).size, 60, 'no file is skipped or repeated');
});

test('ME-FR-13 search filters narrow by conversation, author, period and files, match file names, and allow filter-only searches', async () => {
  const { kim, lee, park } = await world();
  const a = await channel(kim, '가채널', 'public', [lee.id]);
  const b = await channel(kim, '나채널', 'public', [lee.id]);
  const secret = await channel(park, '비밀검색', 'private');
  await post(kim, a, '예산 회의 자료');
  await post(lee, a, '예산 확인했습니다');
  await post(lee, b, '예산 외 이야기');
  await postWithFiles(kim, b, '첨부 보냅니다', ['2026-예산안.xlsx']);
  await post(park, secret, '예산 비밀');
  const search = (user, query) => user.call('messages', 'GET', undefined, `?${new URLSearchParams(query)}`);
  const bodies = (result) => result.body.results.map((item) => item.message.body).sort();

  assert.deepEqual(bodies(await search(kim, { q: '예산' })), ['예산 외 이야기', '예산 확인했습니다', '예산 회의 자료', '첨부 보냅니다'].sort(),
    'file names match too; the private channel stays hidden');
  assert.deepEqual(bodies(await search(kim, { q: '예산', in: a })), ['예산 확인했습니다', '예산 회의 자료'].sort());
  assert.deepEqual(bodies(await search(kim, { q: '예산', authorId: lee.id })), ['예산 외 이야기', '예산 확인했습니다'].sort());
  assert.deepEqual(bodies(await search(kim, { q: '', hasFile: '1' })), ['첨부 보냅니다'], 'filters alone are enough');
  assert.deepEqual((await search(kim, { q: '예산', in: secret })).body.results, [], 'an out-of-scope conversation is empty, not 404');

  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  assert.equal((await search(kim, { q: '예산', from: today, to: today })).body.results.length, 4);
  assert.equal((await search(kim, { q: '예산', from: '2020-01-01', to: '2020-01-31' })).body.results.length, 0);
  assert.equal((await search(kim, { q: '' })).status, 400, 'no text and no filter');
  assert.equal((await search(kim, { q: '예', in: a })).status, 400, 'a short query is still refused');
  assert.equal((await search(kim, { q: '예산', from: '2026-02-30' })).status, 400, 'impossible dates');
  assert.equal((await search(kim, { q: '예산', from: '2026-09-01', to: '2026-08-01' })).status, 400);
  assert.equal((await search(kim, { q: '예산', from: '2024-01-01', to: '2026-01-01' })).status, 400, 'at most 366 days');
});

test('ME-FR-10~13 UI wiring: pin/save buttons, side panels, saved view and search filters', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const message = read('app/chat-message.tsx');
  const workspace = read('app/chat-workspace.tsx');
  const panels = read('app/chat-panels.tsx');
  assert.match(message, /☆ 즐겨찾기/);
  assert.match(message, /"고정 해제"/);
  assert.match(workspace, /<PinsPanel /);
  assert.match(workspace, /<FilesPanel /);
  assert.match(workspace, /<SavedPanel /);
  assert.match(workspace, /<SearchFilters /);
  assert.match(workspace, /\/api\/chat\/messages\?\$\{searchQuery\(q, filters\)\}/);
  assert.match(panels, /query\.set\("in", filters\.in\)/, 'the conversation filter is "in", not the channelId selector');
});

// ── Check 단계 보완(Act-1) ──────────────────────────────────────────────────
test('ME Act-1: a mention in a thread reply is read once the thread is read, in the badge and in activity', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '스레드멘션', 'public', [lee.id]);
  const root = await post(kim, id, '보고서 검토');
  const reply = await post(kim, id, '@이두리 2쪽 확인 부탁', root.id);
  const before = await summaryOf(lee);
  assert.equal(channelRow(before, id).mentions, 1);
  const read = await lee.call('me', 'PUT', { action: 'THREAD_READ', threadRootId: root.id, lastReadReplyId: reply.id });
  assert.equal(channelRow(read.body.unread, id).mentions, 0, 'reading the thread clears the reply mention even though the channel was not read past it');
  const items = (await lee.call('me', 'GET', undefined, '?view=activity')).body.items;
  assert.equal(items.find((item) => item.message.id === reply.id).unread, false);
});

test('ME Act-1: presence drops accounts that lost chat access on the next summary poll', async () => {
  const { kim, lee } = await world();
  await lee.call('poll', 'GET', undefined, '?since=0');
  assert.ok((await kim.call('poll', 'GET', undefined, '?since=1')).body.presence[lee.id] > 0);
  await db.prepare(`UPDATE auth_accounts SET tabs_json = '{}' WHERE id = ?`).bind(lee.id).run();
  await kim.call('poll', 'GET', undefined, '?since=0&summary=1');
  assert.equal((await kim.call('poll', 'GET', undefined, '?since=1')).body.presence[lee.id], undefined);
});

test('ME Act-1 UI: mentioning a non-member in a public channel offers an invite; poll is never a hook dependency', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const workspace = read('app/chat-workspace.tsx');
  const message = read('app/chat-message.tsx');
  assert.match(workspace, /void offerInvite\(message\);/);
  assert.match(workspace, /님은 이 채널에 없어 알림을 받지 못합니다\. 채널에 초대할까요\?/);
  assert.match(workspace, /action: "ADD_MEMBERS", channelId, accountIds: missing/);
  assert.match(workspace, /presence=\{poll\.presence\}/, 'the composer shows presence next to @ suggestions');
  assert.ok(message.indexOf('chat-read-count') > message.indexOf('<Attachments attachments'), 'the read count sits under the bubble');
});

test('ME QA: reselecting the open conversation keeps its history; the tab badge stays inside the tab', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const workspace = read('app/chat-workspace.tsx');
  const css = read('app/chat-workspace.css');
  assert.match(workspace, /if \(id !== activeRef\.current\) setHistory\(/, 'same id → the history effect does not rerun, so do not blank it');
  assert.ok(workspace.indexOf('selectChannel(visible ? saved') < workspace.indexOf('"/api/chat/me?view=bookmarks"'), 'bookmarks load after the first conversation is chosen');
  assert.match(css, /\.erp-tab-badge \{ position: absolute; top: 4px; right: 4px;/, 'a badge outside the tab adds a horizontal scrollbar to the tab row');
});

test('ME QA: the search-box style targets only the search input, so filter checkboxes and dates keep their size', () => {
  const css = readFileSync(new URL('../app/chat-workspace.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.chat-search input \{/, 'a bare ".chat-search input" also styles the filter checkbox and date inputs');
  assert.match(css, /\.chat-search input\[type="search"\] \{ width: 100%;/);
  assert.match(css, /\.chat-search-filters input\[type="checkbox"\] \{ width: 16px; height: 16px;/);
});

test('ME QA: @ suggestions list only members (public channels too); the composer colours recognised mentions', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const workspace = read('app/chat-workspace.tsx');
  const css = read('app/chat-workspace.css');
  assert.doesNotMatch(workspace, /return \[\.\.\.inChannel, \.\.\.others\.filter/, 'non-members are no longer suggested in public channels');
  assert.match(workspace, /className="chat-composer-highlight"/);
  assert.match(workspace, /highlightMentions\(body, known\)/);
  assert.match(workspace, /mentionKnown=\{mentionKnown\}/, 'typed @names the server accepts are still coloured');
  assert.match(css, /\.chat-composer-field > textarea \{ position: relative; z-index: 1; color: transparent; caret-color:/);
  assert.doesNotMatch(css.match(/\.chat-composer-highlight mark \{[^}]*\}/)?.[0] ?? '', /font-weight/, 'bold mentions would shift the caret');
});

test('ME × 총무: a system:ga message works with the enhancement DTO, unread count, notifier and read count', async () => {
  const { kim, lee } = await world();
  const id = await channel(kim, '총무알림', 'public', [lee.id]);
  const now = Date.now();
  await db.prepare(`INSERT INTO chat_messages (client_key, channel_id, thread_root_id, author_account_id, body, mention_channel, reply_count, last_reply_at, created_at)
    VALUES ('system:ga:test', ?, NULL, 'system:ga', '오늘 만료 1건', 0, 0, NULL, ?)`).bind(id, now).run();
  const message = (await lee.call('messages', 'GET', undefined, `?channelId=${id}`)).body.messages.at(-1);
  assert.equal(message.author.name, 'XDnode 알림');
  assert.deepEqual([message.reactions, message.pinnedAt], [[], null]);
  assert.equal(channelRow(await summaryOf(lee), id).unread, 1, 'system messages count as unread like any other author');

  const { shouldNotify } = await import('../app/chat-notify.ts');
  const event = { seq: 1, kind: 'message.created', channelId: id, message };
  assert.equal(shouldNotify(event, { me: lee.id, channel: { kind: 'public', name: '총무알림', notifyLevel: 'all' }, viewingChannelId: null }), true);
  assert.equal(shouldNotify(event, { me: lee.id, channel: { kind: 'public', name: '총무알림', notifyLevel: 'mute' }, viewingChannelId: null }), false, 'a muted 총무 channel stays quiet');

  const { unreadCountFor } = await import('../app/chat-client.ts');
  const reads = (await kim.call('poll', 'GET', undefined, `?since=0&active=${id}`)).body.reads;
  assert.equal(unreadCountFor(message, reads), 2, 'both members still have to read the system message');
  assert.equal((await lee.call('reactions', 'POST', { messageId: message.id, emoji: '✅' })).status, 200, 'members can acknowledge a 총무 alert with a reaction');
});

test('ME 2026-10-02: archived channels move to a collapsible "보관된 채널" section between 채널 and 대화', () => {
  const workspace = readFileSync(new URL('../app/chat-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /const rooms = allRooms\.filter\(\(channel\) => !channel\.archived\);/, 'the 채널 list shows only live channels');
  assert.match(workspace, /const archivedRooms = allRooms\.filter\(\(channel\) => channel\.archived\);/);
  const channels = workspace.indexOf('<header><span>채널</span>');
  const archived = workspace.indexOf('보관된 채널 <small>');
  const dms = workspace.indexOf('<header><span>대화</span>');
  assert.ok(channels > 0 && channels < archived && archived < dms, 'the section sits between 채널 and 대화');
  assert.match(workspace, /archivedRooms\.some\(\(channel\) => channel\.id === activeId\)/, 'it opens when an archived channel is on screen');
});
