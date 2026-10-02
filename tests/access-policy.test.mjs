// R3(r3-tabs): 탭 레지스트리와 순수 판정 함수(Design §4.3.1, §8.6 access-policy 행, FR-16, D12·D13·D20·D23).
// 레지스트리 무결성, canAccess·resolveTabs·requiredLevel 판정표, 그리고 r3-auth 의 순수 판정표(PBKDF2 상수, 교차 출처)를 둔다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// 하니스가 .ts 로더 훅을 등록한다(DB 는 쓰지 않는다).
import './helpers/hr-api-harness.mjs';

const tabs = await import('../app/access-tabs.ts');
const {
  TAB_REGISTRY, MODULE_TAB, ASSISTANT_MODULES, GRANTABLE_TABS, deriveModuleTab, tabOfModule, requiredLevel, resolveTabs,
  canAccess, accessDecision, hasTabLevel, isHrManager, permittedTabs, firstPermittedTab, isAssistantModule, isGrantableTabKey,
} = tabs;
const { verifyPassword, hashPassword, PBKDF2_ITERATIONS } = await import('../app/auth-password.ts');
const { crossOriginWriteViolation, crossSiteViolation } = await import('../app/request-guard.ts');

const none = { hr: 'none', compensation: 'none', chat: 'none', general: 'none', quote: 'none', audit: 'none', admin: 'none' };
const principal = (grants = {}, isAdmin = false) => ({ isAdmin, tabs: { ...none, ...grants } });
const ACTIONS = ['read', 'write', 'approve', 'delete', 'admin'];

// ── 레지스트리 무결성 ─────────────────────────────────────────────────
test('registry: unique keys, R5 tabs in order, audit and admin are admin-only, every entry has the declared fields', () => {
  const keys = TAB_REGISTRY.map((tab) => tab.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, ['hr', 'compensation', 'chat', 'general', 'quote', 'audit', 'admin']);
  for (const tab of TAB_REGISTRY) {
    assert.deepEqual(Object.keys(tab).sort(), ['adminOnly', 'apiPrefixes', 'glyph', 'key', 'label', 'modules', 'shellClass']);
    assert.ok(tab.modules.length > 0 && tab.apiPrefixes.every((prefix) => prefix.startsWith('/api/')), tab.key);
  }
  assert.deepEqual(TAB_REGISTRY.filter((tab) => tab.adminOnly).map((tab) => tab.key), ['audit', 'admin']);
  assert.deepEqual(GRANTABLE_TABS, [{ key: 'hr', label: '인사관리' }, { key: 'compensation', label: '임금 계산' }, { key: 'chat', label: '메신저' }, { key: 'general', label: '총무' }, { key: 'quote', label: '견적' }]);
  for (const key of ['hr', 'compensation', 'chat', 'general', 'quote']) assert.equal(isGrantableTabKey(key), true);
  for (const key of ['audit', 'admin', 'quotes', '__proto__', 'constructor']) assert.equal(isGrantableTabKey(key), false, key);
});

test('registry: MODULE_TAB is derived from the modules arrays, and a module on two tabs or a duplicate key throws', () => {
  assert.ok(MODULE_TAB instanceof Map);
  assert.deepEqual([...MODULE_TAB], [['hr', 'hr'], ['recruitment', 'hr'], ['compensation', 'compensation'], ['chat', 'chat'], ['general', 'general'], ['quote', 'quote'], ['audit', 'audit'], ['admin', 'admin']]);
  assert.throws(() => deriveModuleTab([{ key: 'hr', modules: ['hr'] }, { key: 'quote', modules: ['quote', 'hr'] }]), /두 탭/);
  assert.throws(() => deriveModuleTab([{ key: 'hr', modules: ['hr'] }, { key: 'hr', modules: ['other'] }]), /중복/);
  assert.equal(deriveModuleTab([{ key: 'quote', modules: ['quote'] }]).get('quote'), 'quote', 'a new tab needs only a registry entry (FR-16)');
});

test('registry: removed and prototype-looking modules have no tab', () => {
  for (const moduleName of ['finance', 'sales', 'operations', 'settings', 'quotes', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'HR']) {
    assert.equal(tabOfModule(moduleName), null, moduleName);
  }
  assert.equal(tabOfModule('recruitment'), 'hr');
  assert.equal(tabOfModule('chat'), 'chat');
  assert.equal(tabOfModule('general'), 'general');
  assert.equal(tabOfModule('quote'), 'quote');
});

test('ASSISTANT_MODULES maps only hr, compensation and incentive onto registry modules, guarded by Object.hasOwn', () => {
  assert.deepEqual({ ...ASSISTANT_MODULES }, { hr: 'hr', compensation: 'compensation', incentive: 'compensation' });
  for (const moduleName of Object.values(ASSISTANT_MODULES)) assert.ok(MODULE_TAB.has(moduleName), moduleName);
  for (const value of ['hr', 'compensation', 'incentive']) assert.equal(isAssistantModule(value), true);
  for (const value of ['sales', '__proto__', 'constructor', 'toString', 'valueOf', '', null, undefined, 1, {}]) assert.equal(isAssistantModule(value), false, String(value));
});

// ── 판정표 ───────────────────────────────────────────────────────────
test('requiredLevel: read→view, write·approve·delete→edit (D13), admin→admin, unknown→null', () => {
  assert.deepEqual(ACTIONS.map((action) => requiredLevel(action)), ['view', 'edit', 'edit', 'edit', 'admin']);
  for (const action of ['READ', 'export', '__proto__', '']) assert.equal(requiredLevel(action), null, action);
});

test('resolveTabs: missing keys are none, non-admins never get audit/admin or unknown values, admins get edit everywhere', () => {
  assert.deepEqual(resolveTabs('{}', false), none);
  assert.deepEqual(resolveTabs('{"hr":"view","compensation":"edit"}', false), { ...none, hr: 'view', compensation: 'edit' });
  assert.deepEqual(resolveTabs('{"hr":"edit","audit":"edit","admin":"edit","chat":"edit","quotes":"view"}', false), { ...none, hr: 'edit', chat: 'edit' });
  assert.deepEqual(resolveTabs('{"hr":"admin","compensation":true}', false), none);
  for (const broken of ['', 'not json', '[]', 'null', '"hr"', '{"__proto__":{"hr":"edit"}}']) assert.deepEqual(resolveTabs(broken, false), none, broken);
  assert.deepEqual(resolveTabs('{}', true), { hr: 'edit', compensation: 'edit', chat: 'edit', general: 'edit', quote: 'edit', audit: 'edit', admin: 'edit' });
  assert.deepEqual(resolveTabs('not json', true), { hr: 'edit', compensation: 'edit', chat: 'edit', general: 'edit', quote: 'edit', audit: 'edit', admin: 'edit' });
});

test('canAccess: full module × action × grant table for non-admins', () => {
  const rank = { none: 0, view: 1, edit: 2 };
  for (const moduleName of ['hr', 'recruitment', 'compensation', 'chat', 'general', 'quote']) {
    const tab = MODULE_TAB.get(moduleName);
    for (const level of ['none', 'view', 'edit']) {
      for (const action of ACTIONS) {
        const required = requiredLevel(action);
        // 다른 탭은 모두 edit 로 두어, 권한이 새지 않는지(그 탭의 부여만 본다) 함께 확인한다.
        const others = Object.fromEntries(['hr', 'compensation', 'chat', 'general', 'quote'].filter((key) => key !== tab).map((key) => [key, 'edit']));
        const allowed = required !== 'admin' && rank[level] >= rank[required];
        assert.equal(canAccess(principal({ ...others, [tab]: level }), moduleName, action), allowed, `${moduleName}:${action} with ${tab}=${level}`);
      }
    }
  }
});

test('canAccess: admin-only tabs and the admin action need isAdmin even when the grants say edit', () => {
  const forged = principal({ hr: 'edit', compensation: 'edit', chat: 'edit', general: 'edit', quote: 'edit', audit: 'edit', admin: 'edit' });
  for (const moduleName of ['audit', 'admin']) for (const action of ACTIONS) assert.equal(canAccess(forged, moduleName, action), false, `${moduleName}:${action}`);
  for (const moduleName of ['hr', 'recruitment', 'compensation', 'chat', 'general', 'quote']) assert.equal(canAccess(forged, moduleName, 'admin'), false, moduleName);
  const admin = principal({}, true);
  for (const moduleName of ['hr', 'recruitment', 'compensation', 'chat', 'general', 'quote', 'audit', 'admin']) for (const action of ACTIONS) assert.equal(canAccess(admin, moduleName, action), true, `${moduleName}:${action}`);
});

test('canAccess fails closed: unknown modules and actions are refused even for administrators, before the isAdmin check', () => {
  const admin = principal({}, true);
  for (const moduleName of ['finance', 'sales', 'settings', 'operations', 'quotes', '__proto__', 'constructor', 'toString', '']) {
    for (const action of ACTIONS) assert.equal(canAccess(admin, moduleName, action), false, `${moduleName}:${action}`);
    assert.deepEqual(accessDecision(admin, moduleName, 'read'), { allowed: false, tab: null, required: 'view', granted: 'none' });
  }
  for (const action of ['export', 'READ', '__proto__', '']) assert.equal(canAccess(admin, 'hr', action), false, action);
  // isAdmin 은 정확히 true 여야 한다(문자열 "true"·1 은 관리자가 아니다).
  assert.equal(canAccess({ isAdmin: 'true', tabs: none }, 'audit', 'read'), false);
  assert.equal(canAccess({ isAdmin: 1, tabs: none }, 'hr', 'read'), false);
});

test('accessDecision reports the tab, required and granted levels that ACCESS_DENIED records', () => {
  assert.deepEqual(accessDecision(principal({ hr: 'view' }), 'recruitment', 'delete'), { allowed: false, tab: 'hr', required: 'edit', granted: 'view' });
  assert.deepEqual(accessDecision(principal({ compensation: 'view' }), 'compensation', 'read'), { allowed: true, tab: 'compensation', required: 'view', granted: 'view' });
  assert.deepEqual(accessDecision(principal(), 'admin', 'read'), { allowed: false, tab: 'admin', required: 'view', granted: 'none' });
});

test('isHrManager, hasTabLevel, permittedTabs and firstPermittedTab follow the registry', () => {
  assert.equal(isHrManager(principal({}, true)), true);
  assert.equal(isHrManager(principal({ hr: 'edit' })), true);
  assert.equal(isHrManager(principal({ hr: 'view', compensation: 'edit' })), false);
  assert.equal(isHrManager(principal()), false);
  assert.equal(hasTabLevel(principal({ hr: 'view' }), 'hr', 'view'), true);
  assert.equal(hasTabLevel(principal({ hr: 'view' }), 'hr', 'edit'), false);
  assert.equal(hasTabLevel(principal({ audit: 'edit' }), 'audit', 'view'), false);
  assert.equal(hasTabLevel(principal({}, true), 'admin', 'edit'), true);
  assert.deepEqual(permittedTabs({ ...none, compensation: 'view' }).map((tab) => tab.key), ['compensation']);
  assert.deepEqual(permittedTabs(resolveTabs('{}', true)).map((tab) => tab.key), ['hr', 'compensation', 'chat', 'general', 'quote', 'audit', 'admin']);
  assert.equal(firstPermittedTab({ ...none, compensation: 'edit', hr: 'view' }), 'hr');
  assert.equal(firstPermittedTab(none), null);
});

test('access-tabs.ts is a pure module with no imports (shared by client and server)', () => {
  const source = readFileSync(new URL('../app/access-tabs.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /require\(|from\s+["']/);
});

// ── r3-auth 의 순수 판정표(Design §8.6 access-policy 행) ───────────────
test('password hashes use PBKDF2-SHA256 at the workerd limit and reject out-of-range iteration counts', async () => {
  assert.ok(PBKDF2_ITERATIONS <= 100_000);
  const script = readFileSync(new URL('../scripts/reset-admin-password.mjs', import.meta.url), 'utf8');
  assert.equal(Number(/export const PBKDF2_ITERATIONS = ([\d_]+);/.exec(script)[1].replace(/_/g, '')), PBKDF2_ITERATIONS);
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^pbkdf2_sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  const [, , salt, digest] = hash.split('$');
  assert.equal(await verifyPassword('correct horse', `pbkdf2_sha256$100001$${salt}$${digest}`), false);
  assert.equal(await verifyPassword('correct horse', `pbkdf2_sha256$0$${salt}$${digest}`), false);
  assert.equal(await verifyPassword('correct horse', 'not-a-hash'), false);
});

test('request-guard decision tables (worker layer requires Origin or same-origin fetch metadata on writes)', () => {
  const h = (values) => new Headers(values);
  const same = { host: 'erp.local:3000', origin: 'http://erp.local:3000' };
  assert.equal(crossOriginWriteViolation('GET', h({})), false);
  assert.equal(crossOriginWriteViolation('HEAD', h({ origin: 'http://evil.invalid', host: 'erp.local:3000' })), false);
  assert.equal(crossOriginWriteViolation('POST', h(same)), false);
  assert.equal(crossOriginWriteViolation('POST', h({ host: 'erp.local:3000', origin: 'http://erp.local:8765' })), true);
  assert.equal(crossOriginWriteViolation('PUT', h({ host: 'erp.local:3000', origin: 'null' })), true);
  assert.equal(crossOriginWriteViolation('DELETE', h({ host: 'erp.local:3000', 'sec-fetch-site': 'same-origin' })), false);
  assert.equal(crossOriginWriteViolation('POST', h({ host: 'erp.local:3000', 'sec-fetch-site': 'same-site' })), true);
  assert.equal(crossOriginWriteViolation('POST', h({ host: 'erp.local:3000' })), true, 'no Origin and no Sec-Fetch-Site on a write is a violation');
  assert.equal(crossSiteViolation(h({ host: 'erp.local:3000' })), false, 'the guard layer passes when both headers are absent');
  assert.equal(crossSiteViolation(h(same)), false);
  assert.equal(crossSiteViolation(h({ host: 'erp.local:3000', origin: 'http://evil.invalid' })), true);
  assert.equal(crossSiteViolation(h({ host: 'erp.local:3000', origin: 'null' })), true);
  assert.equal(crossSiteViolation(h({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })), true);
  assert.equal(crossSiteViolation(h({ host: 'localhost:3000', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })), true);
  assert.equal(crossSiteViolation(h({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), false);
});
