// R3(r3-auth): 계정·세션·잠금·부트스트랩·CSRF 동작 테스트(Design §8.2 #1~#19, FR-06·07·08·11, SC-3·SC-10).
// 실제 라우트를 메모리 SQLite 에서 돌린다. 기본 peer 는 비루프백 192.0.2.10 이다(fail closed).
// 주의: 하니스에는 local-peer 플러그인이 없어서 x-xdm-peer 가 곧 'Node 가 확인한 주소'다. 클라이언트가 이 헤더를 위조하지
// 못한다는 보장은 플러그인(r3-runtime, tests/local-peer-plugin.test.mjs)이 맡는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  resetDatabase, callApi, callRoute, setAccess, setPeer, setClock, setSessionCookie, createAccount, login, beforeBatch,
  TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_SESSION_TOKEN,
} from './helpers/hr-api-harness.mjs';

const { verifyPassword, TEMP_PASSWORD_LENGTH } = await import('../app/auth-password.ts');
const { peerOf, readSessionToken } = await import('../app/auth-session.ts');

const DAY = 86_400_000;
const me = (cookie) => callApi('me', 'GET', undefined, '', cookie === undefined ? {} : { cookie });
const admin = (body, options) => callApi('admin/accounts', 'POST', body, '', options);
const rows = (sql, action) => sql.prepare('SELECT * FROM erp_audit_logs WHERE action = ? ORDER BY created_at, rowid').all(action);
const after = (row) => JSON.parse(row.after_json);
const account = (sql, id) => sql.prepare('SELECT * FROM auth_accounts WHERE id = ?').get(id);
const expectCode = (result, status, code) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body.code, code, JSON.stringify(result.body));
  return result.body;
};
async function emptyAccounts(sql) {
  sql.exec('DELETE FROM auth_sessions; DELETE FROM auth_accounts;');
  setSessionCookie(null);
}
const bootstrapBody = { email: 'First.Admin@Example.test', displayName: '첫 관리자', password: 'first-admin-pw' };
const bootstrap = (body = bootstrapBody, options = {}) => callApi('auth/bootstrap', 'POST', body, '', { cookie: null, ...options });

// ── 순수 함수 ─────────────────────────────────────────────────────────
// PBKDF2 상수·교차 출처 판정표는 tests/access-policy.test.mjs 로 옮겼다(Design §8.6).
test('peerOf trusts only a single x-xdm-peer value and never Host, Origin or CF-Connecting-IP', () => {
  assert.deepEqual(peerOf(new Headers({ 'x-xdm-peer': '127.0.0.1' })), { address: '127.0.0.1', loopback: true });
  assert.deepEqual(peerOf(new Headers({ 'x-xdm-peer': '::1' })), { address: '::1', loopback: true });
  assert.equal(peerOf(new Headers({ 'x-xdm-peer': '192.0.2.10' })).loopback, false);
  assert.deepEqual(peerOf(new Headers({ 'x-xdm-peer': '192.0.2.10, 127.0.0.1' })), { address: '', loopback: false });
  assert.deepEqual(peerOf(new Headers({ host: 'localhost', 'cf-connecting-ip': '127.0.0.1' })), { address: '', loopback: false });
  assert.equal(readSessionToken(`xdm_session=${TEST_SESSION_TOKEN}`), TEST_SESSION_TOKEN);
  assert.equal(readSessionToken('xdm_session=short'), null);
  assert.equal(readSessionToken(`xdm_session=${TEST_SESSION_TOKEN}; xdm_session=${TEST_SESSION_TOKEN}`), null);
});

// ── #1~#4 부트스트랩 ─────────────────────────────────────────────────
test('#1 bootstrap from a loopback peer with zero accounts creates the admin, one session cookie and an audit row', async () => {
  const sql = await resetDatabase(); await emptyAccounts(sql);
  const required = expectCode(await me(null), 401, 'BOOTSTRAP_REQUIRED');
  assert.equal(required.bootstrapAllowedHere, false);
  setPeer('127.0.0.1');
  assert.equal(expectCode(await me(null), 401, 'BOOTSTRAP_REQUIRED').bootstrapAllowedHere, true);
  const result = await bootstrap();
  const body = expectCode(result, 201);
  assert.equal(body.user.email, 'first.admin@example.test');
  assert.equal(body.mustChangePassword, false);
  assert.equal(result.setCookies.length, 1);
  const token = /^xdm_session=([A-Za-z0-9_-]{43});/.exec(result.setCookies[0])[1];
  const session = expectCode(await me(token), 200);
  assert.equal(session.isAdmin, true);
  assert.deepEqual(session.tabs, { hr: 'edit', compensation: 'edit', chat: 'edit', general: 'edit', quote: 'edit', audit: 'edit', admin: 'edit' });
  const [audit] = rows(sql, 'BOOTSTRAP_ADMIN_CREATED');
  assert.equal(audit.module, 'auth'); assert.equal(after(audit).peer, '127.0.0.1');
  const created = sql.prepare('SELECT * FROM auth_accounts').get();
  assert.equal(created.is_admin, 1); assert.equal(created.must_change_password, 0); assert.equal(created.tabs_json, '{}');
  assert.equal(created.created_by, 'bootstrap');
});

test('#2 bootstrap from a LAN peer is 403 even with forged Host, Origin and CF-Connecting-IP', async () => {
  const sql = await resetDatabase(); await emptyAccounts(sql);
  const forged = { host: 'localhost', origin: 'http://localhost', 'cf-connecting-ip': '127.0.0.1' };
  expectCode(await bootstrap(bootstrapBody, { headers: forged }), 403, 'BOOTSTRAP_LOCAL_ONLY');
  expectCode(await bootstrap(bootstrapBody, { headers: { ...forged, 'x-xdm-peer': '192.0.2.10, 127.0.0.1' } }), 403, 'BOOTSTRAP_LOCAL_ONLY');
  setPeer(null);
  expectCode(await bootstrap(bootstrapBody, { headers: forged }), 403, 'BOOTSTRAP_LOCAL_ONLY');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get().n, 0);
});

test('#3 two concurrent bootstraps create exactly one account and one session', async () => {
  const sql = await resetDatabase(); await emptyAccounts(sql); setPeer('127.0.0.1');
  const results = await Promise.all([bootstrap(), bootstrap({ ...bootstrapBody, email: 'second@example.test' })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, 'BOOTSTRAP_CLOSED');
  assert.equal(results.find((result) => result.status === 409).setCookies.length, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get().n, 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
});

test('#4 bootstrap is 409 once an account exists, 400 with Upgrade, 415 without JSON, 400 for a bad employee link', async () => {
  const sql = await resetDatabase(); setPeer('127.0.0.1');
  expectCode(await bootstrap(), 409, 'BOOTSTRAP_CLOSED');
  await emptyAccounts(sql);
  expectCode(await bootstrap(bootstrapBody, { headers: { upgrade: 'websocket' } }), 400, 'VALIDATION');
  expectCode(await callApi('auth/bootstrap', 'POST', undefined, '', { cookie: null, rawBody: 'email=a', contentType: 'application/x-www-form-urlencoded' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  expectCode(await bootstrap({ ...bootstrapBody, password: 'short' }), 400, 'VALIDATION');
  expectCode(await bootstrap({ ...bootstrapBody, employeeId: 'acct_forged' }), 400, 'VALIDATION');
  expectCode(await bootstrap({ ...bootstrapBody, employeeId: 'missing-employee' }), 400, 'VALIDATION');
  expectCode(await bootstrap(bootstrapBody, { headers: { origin: 'http://evil.invalid' } }), 403, 'CROSS_ORIGIN');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get().n, 0);
});

// ── #5~#10 로그인 ────────────────────────────────────────────────────
test('#5 login issues an HttpOnly Lax session cookie without Secure and records LOGIN_SUCCEEDED with the peer', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'viewer@example.test', tabs: { hr: 'view' } });
  const result = await login('  VIEWER@example.test ', user.password);
  const body = expectCode(result, 200);
  assert.equal(body.mustChangePassword, false);
  assert.equal(body.user.accountId, user.id); assert.equal(body.user.linkedEmployee, false); assert.equal(body.user.employeeId, user.id);
  assert.equal(result.setCookies.length, 1);
  assert.match(result.setCookies[0], /^xdm_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.doesNotMatch(result.setCookies[0], /Secure|__Host-/i);
  const [audit] = rows(sql, 'LOGIN_SUCCEEDED');
  assert.equal(audit.actor_user_id, user.id); assert.equal(after(audit).peer, '192.0.2.10');
  const session = expectCode(await me(result.cookie), 200);
  assert.deepEqual(session.tabs, { hr: 'view', compensation: 'none', chat: 'none', general: 'none', quote: 'none', audit: 'none', admin: 'none' });
  assert.equal(session.isAdmin, false);
  const stored = sql.prepare('SELECT * FROM auth_sessions WHERE account_id = ?').get(user.id);
  assert.equal(stored.peer, '192.0.2.10'); assert.equal(stored.expires_at - stored.created_at, 30 * DAY);
});

test('#6 twenty concurrent wrong passwords from a LAN peer verify at most five times, then 429 with Retry-After', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'target@example.test', tabs: { hr: 'view' } });
  const subtle = globalThis.crypto.subtle;
  const deriveBits = subtle.deriveBits;
  let verifications = 0;
  subtle.deriveBits = function (...args) { verifications += 1; return deriveBits.apply(this, args); };
  let results;
  try {
    results = await Promise.all(Array.from({ length: 20 }, () => login(user.email, 'wrong-password')));
  } finally {
    subtle.deriveBits = deriveBits;
  }
  assert.ok(verifications <= 5, `verified ${verifications} times`);
  assert.equal(results.filter((result) => result.status === 401).length, 5);
  const blocked = results.filter((result) => result.status === 429);
  assert.equal(blocked.length, 15);
  for (const result of blocked) {
    assert.equal(result.body.code, 'LOCKED');
    assert.ok(result.body.retryAfterSeconds > 0 && result.body.retryAfterSeconds <= 300);
    assert.equal(result.headers.get('retry-after'), String(result.body.retryAfterSeconds));
  }
  assert.equal(account(sql, user.id).failed_attempts, 5);
  assert.equal(rows(sql, 'ACCOUNT_LOCKED').length, 1);
  assert.equal(rows(sql, 'LOGIN_BLOCKED').length, 15);
  assert.equal(rows(sql, 'LOGIN_FAILED').length, 5);
  assert.ok(rows(sql, 'LOGIN_FAILED').every((row) => after(row).reason === 'WRONG_PASSWORD' && after(row).lockExempt === undefined));
});

test('#7 a locked account refuses the right password on the LAN but not from the server PC (D21), which still counts failures', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'locked@example.test', tabs: { hr: 'view' } });
  for (let attempt = 0; attempt < 5; attempt += 1) expectCode(await login(user.email, 'wrong-password'), 401, 'INVALID_CREDENTIALS');
  expectCode(await login(user.email, user.password), 429, 'LOCKED');
  const lockedUntil = account(sql, user.id).locked_until;
  expectCode(await login(user.email, 'wrong-again', { peer: '127.0.0.1' }), 401, 'INVALID_CREDENTIALS');
  assert.equal(account(sql, user.id).failed_attempts, 6);
  assert.ok(account(sql, user.id).locked_until >= lockedUntil, 'a server-PC failure keeps (or extends) the LAN lock');
  const exempt = rows(sql, 'LOGIN_FAILED').at(-1);
  assert.equal(after(exempt).lockExempt, true); assert.equal(after(exempt).peer, '127.0.0.1');
  expectCode(await login(user.email, user.password, { peer: '::1' }), 200);
  assert.equal(account(sql, user.id).failed_attempts, 0);
  assert.equal(account(sql, user.id).locked_until, null, 'a server-PC login clears the LAN lock');
  expectCode(await login(user.email, user.password), 200);
});

test('#8 the lock expires after five minutes and the next failure starts the counter at one', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'clock@example.test', tabs: { hr: 'view' } });
  const start = Date.now();
  setClock(start);
  for (let attempt = 0; attempt < 5; attempt += 1) await login(user.email, 'wrong-password');
  assert.equal(account(sql, user.id).locked_until, start + 300_000);
  setClock(start + 299_999);
  expectCode(await login(user.email, user.password), 429, 'LOCKED');
  setClock(start + 300_000);
  expectCode(await login(user.email, 'wrong-password'), 401, 'INVALID_CREDENTIALS');
  assert.equal(account(sql, user.id).failed_attempts, 1);
  assert.equal(account(sql, user.id).locked_until, null);
  expectCode(await login(user.email, user.password), 200);
  setClock(null);
});

test('#9 unknown and inactive accounts get the same 401, an anonymous audit actor and no counter change', async () => {
  const sql = await resetDatabase();
  const inactive = await createAccount({ email: 'inactive@example.test', active: false, tabs: { hr: 'edit' } });
  for (const email of ['nobody@example.test', inactive.email]) {
    const body = expectCode(await login(email, inactive.password), 401, 'INVALID_CREDENTIALS');
    assert.equal(body.error, '이메일 또는 비밀번호가 올바르지 않습니다.');
  }
  for (let attempt = 0; attempt < 6; attempt += 1) expectCode(await login(inactive.email, 'wrong-password'), 401, 'INVALID_CREDENTIALS');
  assert.equal(account(sql, inactive.id).failed_attempts, 0);
  assert.equal(account(sql, inactive.id).locked_until, null);
  const failures = rows(sql, 'LOGIN_FAILED');
  assert.ok(failures.every((row) => row.actor_user_id === 'anonymous' && row.actor_employee_id === 'anonymous'));
  assert.equal(failures[0].actor_email, 'nobody@example.test');
  assert.ok(failures.every((row) => after(row).reason === 'UNKNOWN_OR_INACTIVE'));
});

test('#10 cross-site requests are refused with 403 CROSS_ORIGIN by the auth routes and the guard', async () => {
  await resetDatabase();
  const user = await createAccount({ email: 'csrf@example.test', tabs: { hr: 'edit' } });
  const attacks = [{ origin: 'http://evil.invalid' }, { origin: 'null' }, { origin: null, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }];
  for (const headers of attacks) {
    expectCode(await callApi('auth/login', 'POST', { email: user.email, password: user.password }, '', { cookie: null, headers }), 403, 'CROSS_ORIGIN');
    expectCode(await callApi('auth/logout', 'POST', undefined, '', { headers }), 403, 'CROSS_ORIGIN');
    expectCode(await callApi('auth/password', 'PUT', { currentPassword: TEST_ADMIN_PASSWORD, newPassword: 'another-password' }, '', { headers }), 403, 'CROSS_ORIGIN');
    expectCode(await callApi('me', 'GET', undefined, '', { headers }), 403, 'CROSS_ORIGIN');
    expectCode(await callRoute('employee-records', 'GET', undefined, '', { headers }), 403, 'CROSS_ORIGIN');
    expectCode(await callApi('admin/accounts', 'GET', undefined, '', { headers }), 403, 'CROSS_ORIGIN');
  }
  // 로그아웃이 막혔으므로 기본 세션은 살아 있다.
  expectCode(await me(), 200);
});

// ── #11~#13 비밀번호 변경 ────────────────────────────────────────────
test('#11 an account that must change its password gets 403 PASSWORD_CHANGE_REQUIRED everywhere but /api/me, password and logout', async () => {
  await resetDatabase();
  setAccess({ hr: 'edit', compensation: 'edit' }, { mustChangePassword: true });
  expectCode(await callRoute('employee-records'), 403, 'PASSWORD_CHANGE_REQUIRED');
  expectCode(await callRoute('payroll', 'GET', undefined, '?period=2026-09'), 403, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(expectCode(await me(), 200).mustChangePassword, true);
  expectCode(await callApi('auth/password', 'PUT', { currentPassword: TEST_ADMIN_PASSWORD, newPassword: 'changed-password-1' }), 200);
  expectCode(await callRoute('employee-records'), 200);
  assert.equal(expectCode(await me(), 200).mustChangePassword, false);
});

test('#12 password change validates input, keeps the session on a wrong current password, and D21 never exempts it', async () => {
  const sql = await resetDatabase();
  const change = (currentPassword, newPassword, options) => callApi('auth/password', 'PUT', { currentPassword, newPassword }, '', options);
  const short = expectCode(await change(TEST_ADMIN_PASSWORD, 'seven77'), 400, 'VALIDATION');
  assert.equal(short.error, '비밀번호는 8자 이상 200자 이하로 입력해 주세요.');
  const same = expectCode(await change(TEST_ADMIN_PASSWORD, TEST_ADMIN_PASSWORD), 400, 'VALIDATION');
  assert.equal(same.error, '새 비밀번호는 현재 비밀번호와 달라야 합니다.');
  const wrong = expectCode(await change('not-the-password', 'brand-new-password'), 401, 'INVALID_CREDENTIALS');
  assert.equal(wrong.error, '현재 비밀번호가 올바르지 않습니다.');
  expectCode(await me(), 200);
  expectCode(await change(undefined, 'brand-new-password'), 400, 'VALIDATION');
  expectCode(await callApi('auth/password', 'PUT', { currentPassword: 'x', newPassword: 'brand-new-password' }, '', { cookie: null }), 401, 'UNAUTHENTICATED');
  for (let attempt = 0; attempt < 4; attempt += 1) expectCode(await change('not-the-password', 'brand-new-password'), 401, 'INVALID_CREDENTIALS');
  assert.equal(rows(sql, 'ACCOUNT_LOCKED').length, 1);
  setPeer('127.0.0.1');
  const locked = expectCode(await change(TEST_ADMIN_PASSWORD, 'brand-new-password'), 429, 'LOCKED');
  assert.ok(locked.retryAfterSeconds > 0);
  // 복구 경로: 서버 PC에서 로그인(D21)하면 잠금이 풀리고, 그 뒤 비밀번호 변경이 된다.
  const recovered = expectCode(await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, { peer: '127.0.0.1' }), 200);
  assert.equal(recovered.user.accountId, TEST_ADMIN_ACCOUNT_ID);
  expectCode(await change(TEST_ADMIN_PASSWORD, 'brand-new-password'), 200);
});

test('#13 a successful password change revokes the other sessions only and clears must_change_password', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'rotate@example.test', tabs: { hr: 'view' }, mustChangePassword: true });
  const first = (await login(user.email, user.password)).cookie;
  const second = (await login(user.email, user.password)).cookie;
  assert.equal(expectCode(await me(first), 200).mustChangePassword, true);
  const result = expectCode(await callApi('auth/password', 'PUT', { currentPassword: user.password, newPassword: 'rotated-password-1' }, '', { cookie: second }), 200);
  assert.deepEqual(result, { ok: true, mustChangePassword: false });
  expectCode(await me(first), 401, 'UNAUTHENTICATED');
  expectCode(await me(second), 200);
  assert.equal(account(sql, user.id).must_change_password, 0);
  assert.equal(after(rows(sql, 'PASSWORD_CHANGED')[0]).revokedSessions, 1);
  assert.equal(sql.prepare("SELECT revoked_reason FROM auth_sessions WHERE account_id = ? AND revoked_at IS NOT NULL").get(user.id).revoked_reason, 'PASSWORD_CHANGED');
  expectCode(await login(user.email, user.password), 401, 'INVALID_CREDENTIALS');
  expectCode(await login(user.email, 'rotated-password-1'), 200);
});

// ── #14 세션 수명과 폐기 ─────────────────────────────────────────────
test('#14 sessions end after 30 days, on logout, deactivation, password reset and admin revoke', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'lifetime@example.test', tabs: { hr: 'view' } });
  const start = Date.now();
  setClock(start);
  const aging = (await login(user.email, user.password)).cookie;
  setClock(start + 30 * DAY - 1);
  expectCode(await me(aging), 200);
  setClock(start + 30 * DAY);
  expectCode(await me(aging), 401, 'UNAUTHENTICATED');
  setClock(null);

  const loggedOut = (await login(user.email, user.password)).cookie;
  const logout = await callApi('auth/logout', 'POST', undefined, '', { cookie: loggedOut });
  expectCode(logout, 200);
  assert.deepEqual(logout.setCookies, ['xdm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
  expectCode(await me(loggedOut), 401, 'UNAUTHENTICATED');
  assert.equal(rows(sql, 'LOGOUT').length, 1);
  expectCode(await callApi('auth/logout', 'POST', undefined, '', { cookie: null }), 200);
  assert.equal(rows(sql, 'LOGOUT').length, 1, 'logout without a session is 200 and not audited');

  const reasons = { DEACTIVATE: 'DEACTIVATED', RESET_PASSWORD: 'PASSWORD_RESET', REVOKE_SESSIONS: 'ADMIN_REVOKE' };
  for (const [action, reason] of Object.entries(reasons)) {
    const target = await createAccount({ email: `${action.toLowerCase()}@example.test`, tabs: { hr: 'view' } });
    const live = [(await login(target.email, target.password)).cookie, (await login(target.email, target.password)).cookie];
    for (const cookie of live) expectCode(await me(cookie), 200);
    const response = expectCode(await admin({ action, id: target.id }), 200);
    for (const cookie of live) expectCode(await me(cookie), 401, 'UNAUTHENTICATED');
    const revoked = sql.prepare('SELECT revoked_reason FROM auth_sessions WHERE account_id = ?').all(target.id).map((row) => row.revoked_reason);
    assert.deepEqual(revoked, [reason, reason], action);
    if (action === 'RESET_PASSWORD') {
      assert.equal(response.temporaryPassword.length, 12);
      assert.equal(response.account.mustChangePassword, true);
      expectCode(await login(target.email, target.password), 401, 'INVALID_CREDENTIALS');
      assert.equal(expectCode(await login(target.email, response.temporaryPassword), 200).mustChangePassword, true);
    }
    if (action === 'DEACTIVATE') {
      expectCode(await login(target.email, target.password), 401, 'INVALID_CREDENTIALS');
      expectCode(await admin({ action: 'REACTIVATE', id: target.id }), 200);
      for (const cookie of live) expectCode(await me(cookie), 401, 'UNAUTHENTICATED');
      expectCode(await login(target.email, target.password), 200);
    }
  }
});

// ── #15~#17 해시·감사·게이트 ─────────────────────────────────────────
test('#15 stored hashes use the PBKDF2 format and no table holds a plaintext password or session token', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'secret@example.test', password: 'Plaintext-Canary-9', tabs: { hr: 'view' } });
  const session = await login(user.email, user.password);
  await login(user.email, 'Wrong-Canary-7');
  const created = expectCode(await admin({ action: 'CREATE', email: 'temp@example.test', displayName: '임시', tabs: { hr: 'view' } }), 201);
  assert.ok(sql.prepare('SELECT password_hash FROM auth_accounts').all().every((row) => row.password_hash.startsWith('pbkdf2_sha256$100000$')));
  const dump = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map(({ name }) => JSON.stringify(sql.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
  for (const secret of ['Plaintext-Canary-9', 'Wrong-Canary-7', session.cookie, TEST_SESSION_TOKEN, created.temporaryPassword]) {
    assert.equal(dump.includes(secret), false, `found a secret in the database: ${secret.slice(0, 4)}…`);
  }
});

test('#16 audit rows name the real account that acted (SC-3)', async () => {
  const sql = await resetDatabase();
  const other = await createAccount({ email: 'second.admin@example.test', isAdmin: true });
  const target = await createAccount({ email: 'target@example.test', tabs: { hr: 'view' } });
  expectCode(await admin({ action: 'UNLOCK', id: target.id }), 200);
  const cookie = (await login(other.email, other.password)).cookie;
  expectCode(await admin({ action: 'UNLOCK', id: target.id }, { cookie }), 200);
  const actors = rows(sql, 'ACCOUNT_UNLOCKED').map((row) => row.actor_user_id);
  assert.deepEqual(actors, [TEST_ADMIN_ACCOUNT_ID, other.id]);
  assert.ok(rows(sql, 'ACCOUNT_UNLOCKED').every((row) => row.module === 'admin' && after(row).peer === '192.0.2.10'));
});

test('#16b a denied request is audited as ACCESS_DENIED with the required and granted levels', async () => {
  const sql = await resetDatabase();
  setAccess({ hr: 'view' });
  expectCode(await callRoute('employee-records', 'PUT', { employeeId: 'x', name: 'x' }), 403, 'FORBIDDEN');
  expectCode(await callApi('admin/accounts'), 403, 'FORBIDDEN');
  const denied = rows(sql, 'ACCESS_DENIED').map(after);
  assert.deepEqual(denied[0], { module: 'hr', action: 'write', tab: 'hr', required: 'edit', granted: 'view' });
  assert.deepEqual(denied[1], { module: 'admin', action: 'read', tab: 'admin', required: 'view', granted: 'none' });
  assert.equal(rows(sql, 'ACCESS_DENIED')[0].actor_user_id, TEST_ADMIN_ACCOUNT_ID);
});

test('#17 the schema gate survives repeated resetDatabase calls', async () => {
  await resetDatabase();
  expectCode(await me(), 200);
  await resetDatabase();
  const body = expectCode(await me(), 200);
  assert.deepEqual(body.user, { accountId: TEST_ADMIN_ACCOUNT_ID, email: TEST_ADMIN_EMAIL, name: body.user.name, employeeId: 'gc.kim', linkedEmployee: true });
  assert.equal(body.isAdmin, true);
});

test('unlinked accounts pass the guard without an HR record (D14) and act under their account id', async () => {
  await resetDatabase();
  setAccess({ hr: 'view', compensation: 'view' }, { employeeId: null });
  const body = expectCode(await me(), 200);
  assert.equal(body.user.linkedEmployee, false);
  assert.equal(body.user.employeeId, TEST_ADMIN_ACCOUNT_ID);
  expectCode(await callRoute('employee-records'), 200);
  setAccess({});
  expectCode(await callRoute('employee-records'), 403, 'FORBIDDEN');
  setAccess(null);
  expectCode(await callRoute('employee-records'), 401, 'UNAUTHENTICATED');
});

// ── #18~#19 계정 관리 ────────────────────────────────────────────────
test('#18 an admin-created account gets a one-time 12-character temporary password and must change it first', async () => {
  const sql = await resetDatabase();
  await callRoute('employee-records');
  const created = expectCode(await admin({ action: 'CREATE', email: 'New.Hire@Example.test', displayName: '신규 입사자', tabs: { hr: 'view', compensation: 'edit' } }), 201);
  assert.equal(created.temporaryPassword.length, TEMP_PASSWORD_LENGTH);
  assert.match(created.temporaryPassword, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{12}$/);
  assert.equal(created.account.email, 'new.hire@example.test');
  assert.equal(created.account.mustChangePassword, true);
  assert.deepEqual(created.account.tabs, { hr: 'view', compensation: 'edit', chat: 'none', general: 'none', quote: 'none' });
  const [audit] = rows(sql, 'ACCOUNT_CREATED');
  assert.equal(after(audit).temporaryPasswordIssued, true);
  assert.equal(audit.after_json.includes(created.temporaryPassword), false);
  const list = expectCode(await callApi('admin/accounts'), 200);
  assert.equal(JSON.stringify(list).includes(created.temporaryPassword), false);
  assert.deepEqual(list.grantableTabs, [{ key: 'hr', label: '인사관리' }, { key: 'compensation', label: '임금 계산' }, { key: 'chat', label: '메신저' }, { key: 'general', label: '총무' }, { key: 'quote', label: '견적' }]);
  assert.ok(list.employees.length > 0 && list.employees.some((row) => row.linkedAccountId === TEST_ADMIN_ACCOUNT_ID));
  const session = await login(created.account.email, created.temporaryPassword);
  assert.equal(expectCode(session, 200).mustChangePassword, true);
  expectCode(await callRoute('employee-records', 'GET', undefined, '', { cookie: session.cookie }), 403, 'PASSWORD_CHANGE_REQUIRED');
  expectCode(await callApi('auth/password', 'PUT', { currentPassword: created.temporaryPassword, newPassword: 'my-own-password' }, '', { cookie: session.cookie }), 200);
  expectCode(await callRoute('employee-records', 'GET', undefined, '', { cookie: session.cookie }), 200);
  expectCode(await admin({ action: 'CREATE', email: 'new.hire@example.test', displayName: '중복' }), 409, 'DUPLICATE');
  expectCode(await admin({ action: 'CREATE', email: 'linked@example.test', employeeId: 'gc.kim' }), 409, 'DUPLICATE');
  expectCode(await admin({ action: 'CREATE', email: 'forged@example.test', employeeId: 'acct_forged', displayName: 'x' }), 400, 'VALIDATION');
  expectCode(await admin({ action: 'CREATE', email: 'tabs@example.test', displayName: 'x', tabs: { audit: 'edit' } }), 400, 'VALIDATION');
  expectCode(await admin({ action: 'CREATE', email: 'tabs@example.test', displayName: 'x', tabs: { admin: 'view' } }), 400, 'VALIDATION');
  expectCode(await admin({ action: 'CREATE', email: 'tabs@example.test', displayName: 'x', tabs: { hr: 'owner' } }), 400, 'VALIDATION');
  setAccess({ hr: 'edit', compensation: 'edit' });
  expectCode(await admin({ action: 'CREATE', email: 'nope@example.test', displayName: 'x' }), 403, 'FORBIDDEN');
});

test('#19 the last active administrator cannot be demoted or deactivated', async () => {
  const sql = await resetDatabase();
  expectCode(await admin({ action: 'UPDATE_PROFILE', id: TEST_ADMIN_ACCOUNT_ID, isAdmin: false }), 409, 'LAST_ADMIN');
  expectCode(await admin({ action: 'DEACTIVATE', id: TEST_ADMIN_ACCOUNT_ID }), 400, 'VALIDATION');
  const second = await createAccount({ email: 'backup.admin@example.test', isAdmin: true });
  // 동시에 다른 관리자가 비활성화되는 경쟁: batch 직전에 호출자를 비활성으로 바꾸면 원자적 가드가 막는다.
  beforeBatch((statements, db) => { db.prepare('UPDATE auth_accounts SET active = 0 WHERE id = ?').run(TEST_ADMIN_ACCOUNT_ID); beforeBatch(null); });
  expectCode(await admin({ action: 'DEACTIVATE', id: second.id }), 409, 'LAST_ADMIN');
  assert.equal(account(sql, second.id).active, 1);
  sql.prepare('UPDATE auth_accounts SET active = 1 WHERE id = ?').run(TEST_ADMIN_ACCOUNT_ID);
  const demoted = expectCode(await admin({ action: 'UPDATE_PROFILE', id: second.id, isAdmin: false }), 200);
  assert.equal(demoted.account.isAdmin, false);
  expectCode(await admin({ action: 'UPDATE_PROFILE', id: second.id, isAdmin: true }), 200);
  expectCode(await admin({ action: 'DEACTIVATE', id: second.id }), 200);
  expectCode(await admin({ action: 'UPDATE_PROFILE', id: TEST_ADMIN_ACCOUNT_ID, isAdmin: false }), 409, 'LAST_ADMIN');
  expectCode(await admin({ action: 'UNLOCK', id: 'acct_missing' }), 404, 'NOT_FOUND');
  expectCode(await admin({ action: 'RESET_PASSWORD', id: TEST_ADMIN_ACCOUNT_ID }), 400, 'VALIDATION');
});

// UPDATE_TABS 부여 규칙(§8.2 #20)은 tests/tab-permissions.test.mjs 로 옮겼다.

test('/api/me is 401 UNAUTHENTICATED for missing, malformed, revoked and inactive sessions, with no-store', async () => {
  const sql = await resetDatabase();
  const missing = await me(null);
  expectCode(missing, 401, 'UNAUTHENTICATED');
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(missing.headers.get('www-authenticate'), null);
  expectCode(await me('not-a-token'), 401, 'UNAUTHENTICATED');
  expectCode(await me('A'.repeat(43)), 401, 'UNAUTHENTICATED');
  sql.prepare('UPDATE auth_accounts SET active = 0 WHERE id = ?').run(TEST_ADMIN_ACCOUNT_ID);
  expectCode(await me(), 401, 'UNAUTHENTICATED');
});

// ── 오프라인 초기화 스크립트 ─────────────────────────────────────────
test('reset-admin-password resets one account offline in the app hash format and audits it as SYSTEM', async () => {
  const { resetAccountPassword } = await import('../scripts/reset-admin-password.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'xdm-reset-'));
  try {
    const d1 = join(dir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
    mkdirSync(d1, { recursive: true });
    const file = join(d1, 'synthetic.sqlite');
    const sqlite = new DatabaseSync(file);
    const source = await resetDatabase();
    for (const { sql } of source.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name IN ('auth_accounts','auth_sessions','erp_audit_logs')").all()) sqlite.exec(sql);
    const now = Date.now();
    sqlite.prepare(`INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password, failed_attempts,
      locked_until, tabs_json, created_by, created_at, updated_at) VALUES ('acct_offline', 'offline@example.test', 'x', 'pbkdf2_sha256$1$AA$AA', NULL, 1, 1, 0, 5, ?, '{}', 'bootstrap', 1, 1)`)
      .run(now + 300_000);
    sqlite.prepare(`INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at) VALUES ('s1', 'acct_offline', 1, ?, 1)`).run(now + DAY);
    sqlite.close();
    const { findAppDatabase } = await import('../scripts/lib/d1-state.mjs');
    const result = await resetAccountPassword(findAppDatabase(dir), ' Offline@Example.test ');
    assert.equal(result.temporaryPassword.length, 12); assert.equal(result.revokedSessions, 1);
    const check = new DatabaseSync(file, { readOnly: true });
    const row = check.prepare("SELECT * FROM auth_accounts WHERE id = 'acct_offline'").get();
    assert.equal(await verifyPassword(result.temporaryPassword, row.password_hash), true);
    assert.equal(row.must_change_password, 1); assert.equal(row.failed_attempts, 0); assert.equal(row.locked_until, null);
    assert.equal(check.prepare("SELECT revoked_reason FROM auth_sessions WHERE id = 's1'").get().revoked_reason, 'PASSWORD_RESET');
    const audit = check.prepare("SELECT * FROM erp_audit_logs WHERE action = 'ACCOUNT_PASSWORD_RESET_OFFLINE'").get();
    assert.equal(audit.actor_user_id, 'SYSTEM'); assert.equal(audit.module, 'admin');
    assert.deepEqual(JSON.parse(audit.after_json), { temporaryPasswordIssued: true, revokedSessions: 1 });
    assert.equal(audit.after_json.includes(result.temporaryPassword), false);
    check.close();
    await assert.rejects(resetAccountPassword(findAppDatabase(dir), 'nobody@example.test'), /계정이 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth source rules: no cookies() import, Set-Cookie on the Response, chatgpt-auth is gone', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../app/chatgpt-auth.ts', import.meta.url)), false);
  const files = ['app/erp-platform.ts', 'app/auth-session.ts', 'app/api/me/route.ts', 'app/api/auth/login/route.ts', 'app/api/auth/logout/route.ts',
    'app/api/auth/password/route.ts', 'app/api/auth/bootstrap/route.ts', 'app/api/admin/accounts/route.ts'];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\bcookies\s*\(|['"]use server['"]|chatgpt-auth|oai-authenticated|LOCAL_ERP_USER/, file);
    assert.doesNotMatch(source, /import\s*\{[^}]*\bcookies\b[^}]*\}\s*from\s*["']next\/headers["']/, file);
  }
  const platform = readFileSync(new URL('../app/erp-platform.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(platform, /CREATE TABLE IF NOT EXISTS (hr_authorized_users|erp_user_access)/);
  assert.doesNotMatch(readFileSync(new URL('../app/auth-session.ts', import.meta.url), 'utf8'), /from ["']\.\/erp-platform["']/);
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
  assert.match(worker, /crossOriginWriteViolation\(request\.method, request\.headers\)[\s\S]*url\.pathname === "\/_vinext\/image"/, 'CSRF runs before the image branch');
  assert.match(worker, /return finalize\(url\.pathname, await handleImageOptimization/);
  assert.match(worker, /return finalize\(url\.pathname, await handler\.fetch/);
});
