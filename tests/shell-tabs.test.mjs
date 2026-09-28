// R3(r3-shell, Design §8.3 #1~#4, FR-09, SC-2 의 DOM 절반): 셸 상단 내비는 권한 있는 탭만 DOM 에 만든다.
// ShellTopNav 와 resolveActiveTab 을 /api/me 모양 입력으로 react-dom/server 에 그대로 렌더한다(브라우저 도구 없음).
import './helpers/tsx-loader.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { default: ShellTopNav, resolveActiveTab } = await import('../app/shell-top-nav.tsx');
const { TAB_REGISTRY } = await import('../app/access-tabs.ts');

const none = { hr: 'none', compensation: 'none', audit: 'none', admin: 'none' };
const noop = () => {};
const render = (tabs, active = resolveActiveTab(tabs, null)) => renderToStaticMarkup(createElement(ShellTopNav, {
  tabs, active, onSelect: noop, userName: '테스트 사용자', userEmail: 'someone@example.test', onChangePassword: noop, onLogout: noop,
}));
const tabButtons = (html) => [...html.matchAll(/<button[^>]*class="erp-module-tab( active)?"[^>]*data-tab="([a-z]+)"/g)].map((match) => match[2]);

test('#1 an hr=view account sees exactly one tab button and no other tab label', () => {
  const html = render({ ...none, hr: 'view' });
  assert.deepEqual(tabButtons(html), ['hr']);
  assert.match(html, /<strong>인사관리<\/strong>/);
  for (const label of ['임금 계산', '감사 로그', '계정 관리']) assert.equal(html.includes(label), false, label);
  assert.match(html, /aria-label="업무 탭"/);
  assert.match(html, /class="erp-module-tab active"[^>]*aria-current="page"/);
  assert.match(html, /<strong>XDnode management<\/strong>/);
  assert.match(html, /src="\/brand\/xdnode-symbol\.png"/);
  // 계정 칩: 이름, 비밀번호 변경, 로그아웃(항상 보임)
  assert.match(html, /테스트 사용자/);
  assert.match(html, />비밀번호 변경</);
  assert.match(html, />로그아웃</);
});

test('#2 an admin sees every registry tab, in registry order', () => {
  const all = Object.fromEntries(TAB_REGISTRY.map((tab) => [tab.key, 'edit']));
  const html = render(all, 'admin');
  assert.deepEqual(tabButtons(html), TAB_REGISTRY.map((tab) => tab.key));
  assert.equal(TAB_REGISTRY.length, 4, 'R3: hr, compensation, audit, admin (R5 adds chat)');
  assert.match(html, /class="erp-module-tab active"[^>]*data-tab="admin"[^>]*aria-current="page"/);
  for (const tab of TAB_REGISTRY) assert.match(html, new RegExp(`<strong>${tab.label}</strong>`));
});

test('#3 resolveActiveTab falls back to the first permitted tab, or null when every tab is none', () => {
  assert.equal(resolveActiveTab({ ...none, compensation: 'view', hr: 'edit' }, 'audit'), 'hr');
  assert.equal(resolveActiveTab({ ...none, compensation: 'view' }, 'hr'), 'compensation');
  assert.equal(resolveActiveTab({ ...none, compensation: 'view' }, null), 'compensation');
  assert.equal(resolveActiveTab({ ...none, hr: 'view', compensation: 'edit' }, 'compensation'), 'compensation');
  assert.equal(resolveActiveTab({ ...none, hr: 'view' }, '__proto__'), 'hr');
  assert.equal(resolveActiveTab(none, 'hr'), null);
});

test('empty shell: with every tab none there is no tab DOM and only logout in the account chip', () => {
  const html = render(none, null);
  assert.deepEqual(tabButtons(html), []);
  assert.doesNotMatch(html, /erp-module-tabs|erp-module-tab|aria-label="업무 탭"/);
  for (const tab of TAB_REGISTRY) assert.equal(html.includes(tab.label), false, tab.label);
  assert.match(html, />로그아웃</);
  assert.doesNotMatch(html, /비밀번호 변경/);
  return readFile(new URL('../app/page.tsx', import.meta.url), 'utf8').then((page) => {
    assert.match(page, /허용된 탭이 없습니다\. 관리자에게 문의해 주세요\./);
  });
});

test('#4 page.tsx declares TAB_PANELS as Record<TabKey, …> with a panel for every registry key', async () => {
  const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /const TAB_PANELS: Record<TabKey, /);
  const body = page.slice(page.indexOf('const TAB_PANELS'), page.indexOf('};', page.indexOf('const TAB_PANELS')));
  for (const tab of TAB_REGISTRY) assert.match(body, new RegExp(`\\n  ${tab.key}: \\(`), `TAB_PANELS.${tab.key}`);
  // 탭 셸은 레지스트리의 shellClass 로 고른다. 패널 렌더는 권한 해석(resolveActiveTab) 결과로만 한다.
  assert.match(page, /TAB_REGISTRY\.find\(\(tab\) => tab\.key === active\)/);
  assert.match(page, /const active = resolveActiveTab\(me\.tabs, selected\);/);
  assert.match(page, /\{TAB_PANELS\[active\]\(/);
  // ShellTopNav 는 CSS 와 서버 모듈을 import 하지 않는다(이 테스트가 그대로 렌더한다).
  const nav = await readFile(new URL('../app/shell-top-nav.tsx', import.meta.url), 'utf8');
  const imports = [...nav.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./access-tabs']);
});

test('session state machine and storage helpers follow Design §5.2 and §5.5', async () => {
  const [session, runtime, screens, incentivePage] = await Promise.all([
    readFile(new URL('../app/session-client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/client-runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/auth-screens.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/incentive/page.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(session, /export const ME_REFRESH_INTERVAL_MS = 60_000;/);
  assert.match(session, /status: "loading"/);
  for (const status of ['bootstrap', 'login', 'password', 'ready']) assert.match(session, new RegExp(`status: "${status}"`));
  assert.match(session, /addEventListener\("focus"/);
  assert.match(session, /addEventListener\("visibilitychange"/);
  // 401 은 code 가 UNAUTHENTICATED 일 때만 로그인으로 보낸다. 로그아웃·401 은 급여성 데이터 키를 지운다.
  assert.match(session, /body\?\.code === "UNAUTHENTICATED"/);
  assert.match(session, /clearScopedDataKeys\(\)/);
  assert.match(runtime, /return `\$\{key\}::\$\{storageScope \?\? "anonymous"\}`;/);
  assert.match(runtime, /"xdnode-incentive-deals-v1",\s*"xdnode-incentive-adjustments-v1",\s*"xdnode-incentive-payroll-v1",\s*"xdnode-incentive-excluded-people-v1",/);
  assert.doesNotMatch(runtime.slice(runtime.indexOf('SCOPED_DATA_KEYS')), /"xdnode-(?:active-tab|compensation-preferences-v2|incentive-config-v1|incentive-cable-exclusion-v2)"/);
  assert.match(runtime, /document\.execCommand\("copy"\)/);
  assert.match(runtime, /getRandomValues/);
  assert.match(screens, /data-auth-gate=\{gate\}/);
  assert.match(screens, /이 화면을 볼 권한이 없습니다\./);
  assert.match(incentivePage, /<RequireTab tab="compensation">/);
});

test('client-runtime: randomId is a v4 UUID and scoped storage migrates legacy keys once', async () => {
  const store = new Map();
  globalThis.window = { localStorage: { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  try {
    const runtime = await import('../app/client-runtime.ts');
    assert.match(runtime.randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    runtime.setStorageScope('acct_one');
    store.set('xdnode-incentive-deals-v1', '[1]');
    assert.equal(runtime.readScoped('xdnode-incentive-deals-v1'), '[1]');
    assert.equal(store.has('xdnode-incentive-deals-v1'), false, 'legacy key removed after the one-time read');
    assert.equal(store.get('xdnode-incentive-deals-v1::acct_one'), '[1]');
    runtime.writeScoped('xdnode-incentive-config-v1', '{}');
    runtime.setStorageScope('acct_two');
    assert.equal(runtime.readScoped('xdnode-incentive-deals-v1'), null, 'another account does not see the first account data');
    runtime.setStorageScope('acct_one');
    store.set('xdnode-incentive-payroll-v1', 'legacy');
    runtime.clearScopedDataKeys();
    assert.equal(store.has('xdnode-incentive-deals-v1::acct_one'), false);
    assert.equal(store.has('xdnode-incentive-payroll-v1'), false);
    assert.equal(store.get('xdnode-incentive-config-v1::acct_one'), '{}', 'screen settings survive logout');
  } finally {
    delete globalThis.window;
  }
});
