// R3(r3-tabs): 탭 → API 권한 대응(Design §4.3.2, §8.2 #20~#30, FR-10·11·16·20, SC-2의 API 절반).
// 실제 라우트를 메모리 SQLite 에서 돌린다. 호출자는 하니스의 시드 계정이고 setAccess 로 탭 부여를 바꾼다(기본: 비관리자, gc.kim 연결).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetDatabase, callApi, callRoute, setAccess, createAccount, login, db, TEST_ADMIN_ACCOUNT_ID,
} from './helpers/hr-api-harness.mjs';

const { TAB_REGISTRY, ASSISTANT_MODULES, MODULE_TAB } = await import('../app/access-tabs.ts');
const { authorizeErpRequest } = await import('../app/erp-platform.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const expectStatus = (result, status, code) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body?.code, code, JSON.stringify(result.body));
  return result.body;
};
const accessDenied = (sql) => sql.prepare("SELECT * FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' ORDER BY created_at, rowid").all();
const form = (fields = {}) => { const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); return data; };
const GRANTABLE = ['hr', 'compensation'];

// ── 유지 라우트·메서드 전부(§4.3.2). [경로, 메서드, 탭, 필요 수준, 쿼리, 본문] ─────────────
// 본문은 인가를 통과한 뒤 도메인 검증에서 멈추도록 비워 둔다(401·403이 아니면 된다).
const ROUTES = [
  ['hr/analytics', 'GET', 'hr', 'view', '?year=2026'], ['hr/analytics', 'POST', 'hr', 'edit', '', {}],
  ['hr/applicant-interview-recordings', 'GET', 'hr', 'view', '?applicantId=tab-missing'], ['hr/applicant-interview-recordings', 'POST', 'hr', 'edit', '', 'form'],
  ['hr/catalogs', 'GET', 'hr', 'view', '?kind=RANK'], ['hr/catalogs', 'POST', 'hr', 'edit', '', {}], ['hr/catalogs', 'DELETE', 'hr', 'edit', '', {}],
  ['hr/employee-records', 'GET', 'hr', 'view'], ['hr/employee-records', 'PUT', 'hr', 'edit', '', {}],
  ['hr/interviews', 'GET', 'hr', 'view', '?employeeId=tab-missing'], ['hr/interviews', 'POST', 'hr', 'edit', '', 'form'],
  ['hr/leave', 'GET', 'hr', 'view'], ['hr/leave', 'POST', 'hr', 'edit', '', {}], ['hr/leave', 'DELETE', 'hr', 'edit', '?id=tab-missing', {}],
  ['hr/message-templates', 'GET', 'hr', 'view'], ['hr/message-templates', 'PUT', 'hr', 'edit', '', {}], ['hr/message-templates', 'DELETE', 'hr', 'edit', '', {}],
  ['hr/operations', 'GET', 'hr', 'view'], ['hr/operations', 'POST', 'hr', 'edit', '', {}], ['hr/operations', 'PUT', 'hr', 'edit', '', {}],
  ['hr/organization-leaders', 'GET', 'hr', 'view'], ['hr/organization-leaders', 'PUT', 'hr', 'edit', '', {}],
  ['hr/organizations', 'GET', 'hr', 'view'], ['hr/organizations', 'POST', 'hr', 'edit', '', {}], ['hr/organizations', 'PUT', 'hr', 'edit', '', {}],
  ['hr/payroll', 'GET', 'hr', 'view', '?period=2026-09'], ['hr/payroll', 'POST', 'hr', 'edit', '', {}], ['hr/payroll', 'PUT', 'hr', 'edit', '', {}],
  ['hr/performance', 'GET', 'hr', 'view', '?year=2026'], ['hr/performance', 'POST', 'hr', 'edit', '', {}],
  ['hr/recruitment', 'GET', 'hr', 'view'], ['hr/recruitment', 'PUT', 'hr', 'edit', '', {}], ['hr/recruitment', 'POST', 'hr', 'edit', '', {}], ['hr/recruitment', 'DELETE', 'hr', 'edit', '', {}],
  ['hr/recruitment-requisitions', 'GET', 'hr', 'view'], ['hr/recruitment-requisitions', 'POST', 'hr', 'edit', '', {}],
  ['hr/resume-analysis', 'POST', 'hr', 'edit', '', {}],
  ['hr/training', 'GET', 'hr', 'view', '?year=2026'], ['hr/training', 'POST', 'hr', 'edit', '', {}],
  ['hr/transcriptions', 'GET', 'hr', 'view', '?entityType=EMPLOYEE_INTERVIEW&entityId=tab-missing'], ['hr/transcriptions', 'POST', 'hr', 'edit', '', {}],
  ['hr/workforce-plans', 'GET', 'hr', 'view', '?year=2026'], ['hr/workforce-plans', 'POST', 'hr', 'edit', '', {}],
  ['documents', 'GET', 'hr', 'view', '?module=hr&entityType=employee&entityId=tab-missing'], ['documents', 'POST', 'hr', 'edit', '', 'form'],
  ['documents', 'PATCH', 'hr', 'edit', '', {}], ['documents', 'DELETE', 'hr', 'edit', '', {}],
  ['compensation', 'GET', 'compensation', 'view', '?period=2026-09'], ['compensation', 'POST', 'compensation', 'edit', '', {}],
  ['compensation/roster', 'GET', 'compensation', 'view'],
  // 어시스턴트는 보기로 통과한다. 통과하면 하니스의 닫힌 브리지 포트 때문에 502 다.
  ['assistant', 'POST', 'hr', 'view', '?module=hr', { question: 'audit' }],
  ['assistant', 'POST', 'compensation', 'view', '?module=compensation', { question: 'audit' }],
  ['assistant', 'POST', 'compensation', 'view', '?module=incentive', { question: 'audit' }],
];

async function call([route, method, , , query = '', body]) {
  return callApi(route, method, body === 'form' ? form() : body, query);
}

// §8.2 #21: 유지 라우트·메서드 전부 × 그 탭 none·view·edit(다른 탭은 edit).
for (const entry of ROUTES) {
  const [route, method, tab, required, query = ''] = entry;
  test(`#21 ${method} /api/${route}${query} needs ${tab}:${required}`, async () => {
    const rank = { none: 0, view: 1, edit: 2 };
    for (const level of ['none', 'view', 'edit']) {
      const sql = await resetDatabase();
      const grants = Object.fromEntries(GRANTABLE.map((key) => [key, key === tab ? level : 'edit']));
      setAccess(grants);
      const before = accessDenied(sql).length;
      const result = await call(entry);
      if (rank[level] < rank[required]) {
        expectStatus(result, 403, 'FORBIDDEN');
        const rows = accessDenied(sql);
        assert.equal(rows.length, before + 1, `${method} ${route} at ${tab}=${level} must be audited`);
        const denied = JSON.parse(rows.at(-1).after_json);
        assert.equal(denied.tab, tab);
        assert.equal(denied.required, required);
        assert.equal(denied.granted, level);
        assert.equal(rows.at(-1).actor_user_id, TEST_ADMIN_ACCOUNT_ID);
      } else {
        assert.ok(![401, 403].includes(result.status), `${method} ${route} at ${tab}=${level}: ${result.status} ${JSON.stringify(result.body)}`);
        // 통과하면 도메인 검증(200·400·404·422)까지 간다. 어시스턴트만 닫힌 브리지 때문에 502 다.
        if (route === 'assistant') assert.equal(result.status, 502);
        else assert.ok(result.status < 500, `${method} ${route}: ${result.status}`);
        assert.equal(accessDenied(sql).length, before);
      }
    }
  });
}

// §8.2 #22: 교차 매트릭스(SC-2).
test('#22 cross matrix: compensation and HR grants never leak into each other; audit/admin stay admin-only', async () => {
  const passes = (result) => ![401, 403].includes(result.status);
  const probe = async () => ({
    compensation: await callApi('compensation', 'GET', undefined, '?period=2026-09'),
    roster: await callApi('compensation/roster'),
    employees: await callRoute('employee-records'),
    assistantCompensation: await callApi('assistant', 'POST', { question: 'audit' }, '?module=compensation'),
    assistantIncentive: await callApi('assistant', 'POST', { question: 'audit' }, '?module=incentive'),
    assistantHr: await callApi('assistant', 'POST', { question: 'audit' }, '?module=hr'),
    audit: await callApi('audit-log'),
    admin: await callApi('admin/accounts'),
  });
  await resetDatabase();
  setAccess({ compensation: 'edit' });
  let r = await probe();
  assert.equal(r.compensation.status, 200); assert.equal(r.roster.status, 200);
  expectStatus(r.employees, 403, 'FORBIDDEN');
  assert.ok(passes(r.assistantCompensation) && passes(r.assistantIncentive));
  expectStatus(r.assistantHr, 403, 'FORBIDDEN');
  expectStatus(r.audit, 403, 'FORBIDDEN'); expectStatus(r.admin, 403, 'FORBIDDEN');

  setAccess({ hr: 'edit' });
  r = await probe();
  expectStatus(r.compensation, 403, 'FORBIDDEN'); expectStatus(r.roster, 403, 'FORBIDDEN');
  assert.equal(r.employees.status, 200);
  expectStatus(r.assistantCompensation, 403, 'FORBIDDEN'); expectStatus(r.assistantIncentive, 403, 'FORBIDDEN');
  assert.ok(passes(r.assistantHr));
  expectStatus(r.audit, 403, 'FORBIDDEN'); expectStatus(r.admin, 403, 'FORBIDDEN');

  // 비관리자의 tabs_json 에 audit·admin=edit 가 있어도 resolveTabs 가 버린다(#23과 같은 경계).
  setAccess({ hr: 'view', compensation: 'view', audit: 'edit', admin: 'edit' });
  r = await probe();
  assert.equal(r.compensation.status, 200); assert.equal(r.roster.status, 200); assert.equal(r.employees.status, 200);
  assert.ok(passes(r.assistantCompensation) && passes(r.assistantHr));
  expectStatus(r.audit, 403, 'FORBIDDEN'); expectStatus(r.admin, 403, 'FORBIDDEN');

  setAccess({}, { isAdmin: true });
  r = await probe();
  for (const key of ['compensation', 'roster', 'employees', 'audit', 'admin']) assert.equal(r[key].status, 200, key);
  assert.ok(passes(r.assistantCompensation) && passes(r.assistantIncentive) && passes(r.assistantHr));
});

// §8.2 #23
test('#23 audit-log and admin/accounts are admin-only even when a non-admin has audit/admin=edit stored', async () => {
  const sql = await resetDatabase();
  setAccess({ hr: 'edit', compensation: 'edit', audit: 'edit', admin: 'edit' });
  expectStatus(await callApi('audit-log'), 403, 'FORBIDDEN');
  expectStatus(await callApi('admin/accounts'), 403, 'FORBIDDEN');
  expectStatus(await callApi('admin/accounts', 'POST', { action: 'UNLOCK', id: TEST_ADMIN_ACCOUNT_ID }), 403, 'FORBIDDEN');
  const denied = accessDenied(sql).map((row) => [row.module, JSON.parse(row.after_json)]);
  assert.deepEqual(denied.map(([module, after]) => [module, after.tab, after.required, after.granted]),
    [['audit', 'audit', 'view', 'none'], ['admin', 'admin', 'view', 'none'], ['admin', 'admin', 'edit', 'none']]);
  setAccess({}, { isAdmin: true });
  expectStatus(await callApi('audit-log'), 200);
});

// §8.2 #20(r3-auth 의 auth-session 테스트에서 옮김)
test('#20 UPDATE_TABS merges grantable keys, rejects audit/admin/unknown keys, keeps unknown stored keys, applies on the next request', async () => {
  const sql = await resetDatabase();
  const admin = (body) => callApi('admin/accounts', 'POST', body);
  const user = await createAccount({ email: 'tabs@example.test', tabs: { hr: 'view', chat: 'edit', audit: 'edit', admin: 'edit' } });
  const cookie = (await login(user.email, user.password)).cookie;
  const me = () => callApi('me', 'GET', undefined, '', { cookie });
  assert.deepEqual(expectStatus(await me(), 200).tabs, { hr: 'view', compensation: 'none', chat: 'edit', audit: 'none', admin: 'none' });
  for (const tabs of [{ audit: 'edit' }, { admin: 'view' }, { chat: 'owner' }, { quote: 'edit' }, { __proto__: null, constructor: 'edit' }, { hr: 'admin' }, { hr: true }, ['hr']]) {
    expectStatus(await admin({ action: 'UPDATE_TABS', id: user.id, tabs }), 400, 'VALIDATION');
  }
  const updated = expectStatus(await admin({ action: 'UPDATE_TABS', id: user.id, tabs: { hr: 'none', compensation: 'edit' } }), 200);
  assert.deepEqual(updated.account.tabs, { hr: 'none', compensation: 'edit', chat: 'edit' });
  assert.deepEqual(JSON.parse(sql.prepare('SELECT tabs_json FROM auth_accounts WHERE id = ?').get(user.id).tabs_json),
    { chat: 'edit', audit: 'edit', admin: 'edit', compensation: 'edit' });
  assert.deepEqual(expectStatus(await me(), 200).tabs, { hr: 'none', compensation: 'edit', chat: 'edit', audit: 'none', admin: 'none' });
  expectStatus(await callApi('compensation/roster', 'GET', undefined, '', { cookie }), 200);
  expectStatus(await callApi('hr/employee-records', 'GET', undefined, '', { cookie }), 403, 'FORBIDDEN');
  const [audit] = sql.prepare("SELECT * FROM erp_audit_logs WHERE action = 'ACCOUNT_TABS_UPDATED'").all();
  assert.equal(audit.module, 'admin');
  assert.deepEqual(JSON.parse(audit.before_json).tabs, { hr: 'view', compensation: 'none', chat: 'edit' });
  const grantable = expectStatus(await callApi('admin/accounts'), 200).grantableTabs;
  assert.deepEqual(grantable, [{ key: 'hr', label: '인사관리' }, { key: 'compensation', label: '임금 계산' }, { key: 'chat', label: '메신저' }]);
});

// §8.2 #24
test('#24 a legacy finance document is 404 for administrators and HR viewers, and hidden behind 403 without the HR tab', async () => {
  const sql = await resetDatabase();
  expectStatus(await callApi('documents', 'GET', undefined, '?module=hr&entityType=employee&entityId=x'), 200);
  sql.prepare(`INSERT INTO erp_documents (id, module, entity_type, entity_id, category, version, file_name, content_type, storage_key, uploaded_by, created_at, deleted_at)
    VALUES ('legacy-finance', 'finance', 'financeExpense', 'payroll:2026-08', '증빙', 1, 'legacy.pdf', 'application/pdf', 'erp-documents/finance/legacy.pdf', 'gc.kim', 1, NULL)`).run();
  for (const access of [[{}, { isAdmin: true }], [{ hr: 'view' }], [{ hr: 'edit' }]]) {
    setAccess(...access);
    const download = await callApi('documents', 'GET', undefined, '?downloadId=legacy-finance');
    assert.equal(download.status, 404, JSON.stringify(access));
    assert.equal(download.body, '문서를 찾을 수 없습니다.');
  }
  setAccess({ hr: 'edit' });
  expectStatus(await callApi('documents', 'PATCH', { id: 'legacy-finance', category: 'moved' }), 404);
  expectStatus(await callApi('documents', 'DELETE', { id: 'legacy-finance' }), 404);
  setAccess({ compensation: 'edit' });
  expectStatus(await callApi('documents', 'GET', undefined, '?downloadId=legacy-finance'), 403, 'FORBIDDEN');
  expectStatus(await callApi('documents', 'GET', undefined, '?downloadId=no-such-document'), 403, 'FORBIDDEN');
  assert.equal(sql.prepare("SELECT deleted_at FROM erp_documents WHERE id = 'legacy-finance'").get().deleted_at, null);
});

// §8.2 #25
test('#25 /api/me returns exactly user, isAdmin, tabs and mustChangePassword; non-admins resolve audit/admin to none', async () => {
  await resetDatabase();
  setAccess({ hr: 'view', audit: 'edit', admin: 'edit' });
  const body = expectStatus(await callApi('me'), 200);
  assert.deepEqual(Object.keys(body).sort(), ['isAdmin', 'mustChangePassword', 'tabs', 'user']);
  assert.deepEqual(body.tabs, { hr: 'view', compensation: 'none', chat: 'none', audit: 'none', admin: 'none' });
  assert.equal(body.isAdmin, false);
  assert.equal(body.mustChangePassword, false);
  assert.deepEqual(Object.keys(body.user).sort(), ['accountId', 'email', 'employeeId', 'linkedEmployee', 'name']);
  setAccess({}, { isAdmin: true });
  assert.deepEqual(expectStatus(await callApi('me'), 200).tabs, { hr: 'edit', compensation: 'edit', chat: 'edit', audit: 'edit', admin: 'edit' });
});

// §8.2 #26, 부록 C #27
test('#26 acct_ ids are rejected by employee-records PUT and by recruitment hire conversion and onboarding edits', async () => {
  const sql = await resetDatabase();
  setAccess({ hr: 'edit' });
  expectStatus(await callRoute('employee-records', 'PUT', { employeeId: 'acct_x', name: 'Synthetic Account' }), 400);
  expectStatus(await callRoute('employee-records', 'PUT', { employeeId: `${TEST_ADMIN_ACCOUNT_ID}`, name: 'Synthetic Account' }), 400);
  const applicant = { id: 'AP-acct-guard', name: '가상 지원자', role: '기술지원', applied: '2026.09.21', ownerId: 'gc.kim', stage: '서류 검토',
    email: 'acct-guard@example.test', phone: '', resumeText: '가상 이력서: 서버 운영 경력', resumeFileName: '가상이력서.txt', createOnly: true,
    recruitmentHelper: true, interview: { questions: '경력 확인 질문' } };
  expectStatus(await callRoute('recruitment', 'PUT', applicant), 200);
  const offer = { resource: 'offer', applicantId: applicant.id, proposedTitle: '기술지원', department: 'Audit Team', employmentType: '정규직',
    startDate: '2026-10-01', annualSalary: 36000000, probationMonths: 3 };
  const offerId = expectStatus(await callRoute('recruitment', 'POST', offer), 201).offer.id;
  const accept = (employeeId) => callRoute('recruitment', 'PUT', { resource: 'offerResponse', id: offerId, action: 'ACCEPT', employeeId, position: '사원', jobTitle: '팀원' });
  expectStatus(await accept('acct_hire'), 400);
  expectStatus(await accept('SYN-ACCT-GUARD-1'), 201);
  const onboarding = { resource: 'onboardingUpdate', id: offerId, startDate: '2026-10-01', department: 'Audit Team', proposedTitle: '기술지원',
    position: '사원', jobTitle: '팀원', employmentType: '정규직', annualSalary: 36000000, probationMonths: 3 };
  expectStatus(await callRoute('recruitment', 'PUT', { ...onboarding, employeeId: 'acct_onboarding' }), 400);
  assert.equal(sql.prepare("SELECT employee_id FROM hr_offer_requests WHERE id = ?").get(offerId).employee_id, 'SYN-ACCT-GUARD-1');
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM hr_employee_records WHERE employee_id LIKE 'acct\\_%' ESCAPE '\\'").get().n, 0);
});

// §8.2 #27, 부록 B #27: 인가를 본문 읽기보다 먼저 한다(8곳 + 임금 계산).
test('#27 the eight body-reading handlers refuse a view account with 403 before parsing a broken body', async () => {
  await resetDatabase();
  const json = { rawBody: '{ this is not json', contentType: 'application/json' };
  const multipart = { rawBody: 'this is not multipart', contentType: 'multipart/form-data; boundary=tab-guard' };
  const cases = [
    ['documents', 'POST', multipart], ['documents', 'PATCH', json], ['documents', 'DELETE', json],
    ['hr/payroll', 'PUT', json], ['hr/operations', 'PUT', json], ['hr/transcriptions', 'POST', json], ['hr/recruitment', 'POST', json],
  ];
  for (const [route, method, options] of cases) {
    setAccess({ hr: 'view', compensation: 'edit' });
    expectStatus(await callApi(route, method, undefined, '', options), 403, 'FORBIDDEN');
    setAccess({ hr: 'edit' });
    expectStatus(await callApi(route, method, undefined, '', options), 400);
  }
  // 어시스턴트는 보기로 통과하는 경로라, 대상 탭이 none 인 계정으로 본다.
  for (const [module, tab] of [['hr', 'hr'], ['compensation', 'compensation'], ['incentive', 'compensation']]) {
    const other = tab === 'hr' ? 'compensation' : 'hr';
    setAccess({ [other]: 'edit' });
    expectStatus(await callApi('assistant', 'POST', undefined, `?module=${module}`, json), 403, 'FORBIDDEN');
    setAccess({ [tab]: 'view' });
    expectStatus(await callApi('assistant', 'POST', undefined, `?module=${module}`, json), 400);
  }
  setAccess({ compensation: 'view', hr: 'edit' });
  expectStatus(await callApi('compensation', 'POST', undefined, '', json), 403, 'FORBIDDEN');
  setAccess({ compensation: 'edit' });
  expectStatus(await callApi('compensation', 'POST', undefined, '', json), 400);
});

// §8.2 #28
test('#28 the compensation roster has exactly four fields, puts retirees last, and has no side effects', async () => {
  const sql = await resetDatabase();
  setAccess({ compensation: 'view' });
  assert.deepEqual(expectStatus(await callApi('compensation/roster'), 200).employees, []);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'hr_employee_records'").get().n, 0, 'no DDL or seeding');
  setAccess({}, { isAdmin: true });
  expectStatus(await callRoute('employee-records'), 200);
  const ids = sql.prepare('SELECT employee_id FROM hr_employee_records ORDER BY employee_id').all().map((row) => row.employee_id);
  assert.ok(ids.length >= 3);
  sql.prepare("UPDATE hr_employee_records SET status = '퇴직' WHERE employee_id = ?").run(ids[0]);
  sql.prepare("UPDATE hr_employee_records SET phone = '010-0000-0000', address = 'Synthetic Street', birth = '1990.01.01', email = 'leak@example.test' WHERE employee_id = ?").run(ids[1]);
  const auditBefore = sql.prepare('SELECT COUNT(*) AS n FROM erp_audit_logs').get().n;
  setAccess({ compensation: 'view' });
  const { employees } = expectStatus(await callApi('compensation/roster'), 200);
  assert.equal(employees.length, ids.length);
  for (const entry of employees) assert.deepEqual(Object.keys(entry).sort(), ['department', 'employeeId', 'name', 'status']);
  assert.doesNotMatch(JSON.stringify(employees), /010-0000-0000|Synthetic Street|1990|leak@example/);
  const firstRetired = employees.findIndex((entry) => entry.status === '퇴직');
  assert.equal(employees[firstRetired].employeeId, ids[0]);
  assert.ok(employees.slice(firstRetired).every((entry) => entry.status === '퇴직'), 'retirees last');
  const active = employees.slice(0, firstRetired).map((entry) => entry.name);
  assert.deepEqual(active, [...active].sort((left, right) => left.localeCompare(right, 'ko')));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM erp_audit_logs').get().n, auditBefore, 'a read writes nothing');
  setAccess({ hr: 'edit' });
  expectStatus(await callApi('compensation/roster'), 403, 'FORBIDDEN');
});

// §8.2 #29, 부록 B #6
test('#29 GET /api/compensation?include=hr sends an empty birthDate for every HR snapshot', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  expectStatus(await callRoute('employee-records'), 200);
  sql.prepare("UPDATE hr_employee_records SET birth = '1990.01.01'").run();
  setAccess({ compensation: 'view' });
  const body = expectStatus(await callApi('compensation', 'GET', undefined, '?period=2026-09&include=hr'), 200);
  assert.ok(body.hrEmployees.length > 0);
  for (const employee of body.hrEmployees) assert.equal(employee.birthDate, '', employee.id);
  assert.doesNotMatch(JSON.stringify(body.hrEmployees), /1990/);
});

// §8.2 #30
test('#30 assistant modules outside ASSISTANT_MODULES are 400 before authorization, even signed out', async () => {
  await resetDatabase();
  for (const signedIn of [true, false]) {
    if (signedIn) setAccess({}, { isAdmin: true }); else setAccess(null);
    for (const query of ['?module=__proto__', '?module=sales', '?module=constructor', '?module=hasOwnProperty', '?module=HR', '?module=', '']) {
      expectStatus(await callApi('assistant', 'POST', { module: 'hr', question: 'audit' }, query), 400, 'VALIDATION');
    }
  }
  // 본문의 module 은 보지 않는다: 쿼리 compensation + 본문 hr 은 compensation 탭으로 판정한다.
  setAccess({ hr: 'edit' });
  expectStatus(await callApi('assistant', 'POST', { module: 'hr', question: 'audit' }, '?module=compensation'), 403, 'FORBIDDEN');
});

// ── 그 밖의 r3-tabs 동작 ──────────────────────────────────────────────
test('authorizeErpRequest fails closed on modules outside the registry, even for administrators, and audits them under auth', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  for (const moduleName of ['finance', 'sales', 'settings', 'quote', '__proto__', 'constructor']) {
    const { response, principal } = await authorizeErpRequest(db, moduleName, 'read');
    assert.equal(principal, undefined, moduleName);
    assert.equal(response.status, 403, moduleName);
    assert.equal((await response.json()).code, 'FORBIDDEN');
  }
  const rows = accessDenied(sql);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.module === 'auth' && JSON.parse(row.after_json).tab === null));
  const { principal } = await authorizeErpRequest(db, 'hr', 'admin');
  assert.equal(principal.isAdmin, true);
});

test('GET /api/hr/operations reports access {hr, isAdmin} and names of unlinked accounts without email or roles', async () => {
  await resetDatabase();
  const unlinked = await createAccount({ email: 'unlinked@example.test', displayName: '미연결 담당자', tabs: { hr: 'edit' } });
  await createAccount({ email: 'linked@example.test', displayName: '연결 담당자', employeeId: 'gc.kim-linked-test', tabs: { hr: 'view' } });
  setAccess({ hr: 'view' });
  const body = expectStatus(await callRoute('operations'), 200);
  assert.deepEqual(body.access, { hr: 'view', isAdmin: false });
  assert.equal(body.principal.roles, undefined);
  assert.equal(body.accountNames[unlinked.id], '미연결 담당자');
  assert.ok(!Object.values(body.accountNames).includes('연결 담당자'), 'only unlinked accounts');
  assert.doesNotMatch(JSON.stringify(body.accountNames), /@/);
  setAccess({}, { isAdmin: true });
  assert.deepEqual(expectStatus(await callRoute('operations'), 200).access, { hr: 'edit', isAdmin: true });
});

test('audit-log names unlinked actors from auth_accounts and accepts the R3 module filters', async () => {
  const sql = await resetDatabase();
  const user = await createAccount({ email: 'actor@example.test', displayName: '미연결 작성자', tabs: { hr: 'edit' } });
  const cookie = (await login(user.email, user.password)).cookie;
  expectStatus(await callRoute('organizations', 'POST', { name: 'Audit Named Team' }, '', { cookie }), 201);
  setAccess({}, { isAdmin: true });
  const items = expectStatus(await callApi('audit-log', 'GET', undefined, '?module=hr'), 200).items;
  const created = items.find((item) => item.actorEmployeeId === user.id);
  assert.equal(created.actorName, '미연결 작성자');
  assert.equal(sql.prepare('SELECT actor_user_id FROM erp_audit_logs WHERE actor_employee_id = ? LIMIT 1').get(user.id).actor_user_id, user.id);
  for (const moduleName of ['ALL', 'hr', 'recruitment', 'compensation', 'chat', 'audit', 'admin', 'auth', 'operations', 'finance', 'sales', 'settings']) {
    expectStatus(await callApi('audit-log', 'GET', undefined, `?module=${moduleName}`), 200);
  }
  expectStatus(await callApi('audit-log', 'GET', undefined, '?module=bogus'), 400);
  expectStatus(await callApi('audit-log', 'GET', undefined, `?q=${encodeURIComponent('미연결 작성자')}`), 200);
});

test('self and manager checks use the linked HR id only: an unlinked account sees no performance or training rows as its own', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  expectStatus(await callRoute('performance', 'GET', undefined, '?year=2026'), 200);
  expectStatus(await callRoute('training', 'GET', undefined, '?year=2026'), 200);
  const now = Date.now();
  sql.prepare(`INSERT INTO hr_performance_cycles (id, name, period, status, goal_due_date, self_due_date, manager_due_date, calibration_due_date, created_by, created_at, updated_at)
    VALUES ('cycle-link', 'Link Cycle', '2026-H2', 'SELF_REVIEW', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', 'gc.kim', ?, ?)`).run(now, now);
  const participant = sql.prepare(`INSERT INTO hr_performance_participants (id, cycle_id, employee_id, manager_employee_id, status, created_at, updated_at)
    VALUES (?, 'cycle-link', ?, ?, 'NOT_STARTED', ?, ?)`);
  // 가드를 우회해 acct_ 로 된 행이 있다고 가정한다(심층 방어). 연결된 gc.kim 은 자기 행을 본다.
  participant.run('p-account-self', TEST_ADMIN_ACCOUNT_ID, '', now, now);
  participant.run('p-account-manager', 'someone-else', TEST_ADMIN_ACCOUNT_ID, now, now);
  participant.run('p-linked-self', 'gc.kim', '', now, now);
  setAccess({ hr: 'view' }, { employeeId: null });
  assert.deepEqual(expectStatus(await callRoute('performance', 'GET', undefined, '?cycleId=cycle-link'), 200).participants, []);
  setAccess({ hr: 'edit' }, { employeeId: null });
  expectStatus(await callRoute('performance', 'GET', undefined, '?cycleId=cycle-link'), 200);
  setAccess({ hr: 'view' });
  assert.deepEqual(expectStatus(await callRoute('performance', 'GET', undefined, '?cycleId=cycle-link'), 200).participants.map((item) => item.id), ['p-linked-self']);
  setAccess({ hr: 'edit' }, { employeeId: null });
  const all = expectStatus(await callRoute('performance', 'GET', undefined, '?cycleId=cycle-link'), 200);
  assert.equal(all.canAdmin, true, 'hr=edit is an HR manager (isHrManager)');
  assert.equal(all.participants.length, 3);
  setAccess({ hr: 'view' });
  assert.equal(expectStatus(await callRoute('performance', 'GET', undefined, '?cycleId=cycle-link'), 200).canAdmin, false);
});

test('analytics and training use isHrManager: hr=edit manages, hr=view does not, admins always do', async () => {
  await resetDatabase();
  const snapshot = { action: 'GENERATE_REPORT', from: '2026-01-01', to: '2026-06-30' };
  setAccess({ hr: 'view' });
  assert.equal(expectStatus(await callRoute('training', 'GET', undefined, '?year=2026'), 200).canAdmin, false);
  setAccess({ hr: 'edit' });
  assert.equal(expectStatus(await callRoute('training', 'GET', undefined, '?year=2026'), 200).canAdmin, true);
  const created = await callRoute('analytics', 'POST', snapshot);
  assert.ok(![401, 403].includes(created.status), JSON.stringify(created.body));
  setAccess({}, { isAdmin: true });
  assert.equal(expectStatus(await callRoute('training', 'GET', undefined, '?year=2026'), 200).canAdmin, true);
});

// ── 소스 가드(§4.3.2 '소스 가드', §10.4) ────────────────────────────────
function routeFiles(dir = 'app/api') {
  const files = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...routeFiles(relative));
    else if (entry.name === 'route.ts') files.push(relative);
  }
  return files.sort();
}
const SESSION_ONLY = /^app\/api\/(?:me|auth\/[a-z]+)\/route\.ts$/;
const apiPathOf = (file) => `/${file.replace(/^app\//, '').replace(/\/route\.ts$/, '')}`;
const tabsOfPath = (apiPath) => TAB_REGISTRY.filter((tab) => tab.apiPrefixes.some((prefix) => prefix.endsWith('/') ? apiPath.startsWith(prefix) : apiPath === prefix || apiPath.startsWith(`${prefix}/`))).map((tab) => tab.key);
const handlers = (source) => [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match, index, all) => ({
  method: match[1], body: source.slice(match.index, all[index + 1]?.index ?? source.length),
}));
const GUARD_CALL = /authorizeErpRequest\(\s*[\w.]+\s*,\s*([^,]+?)\s*,\s*"(read|write|approve|delete|admin)"\s*\)/g;

test('source guard: every kept route calls authorizeErpRequest with a literal module whose tab owns the route path', () => {
  const files = routeFiles();
  assert.ok(files.length >= 25, files.join(', '));
  for (const file of files) {
    const source = read(file);
    if (SESSION_ONLY.test(file)) {
      assert.doesNotMatch(source, /authorizeErpRequest\(/, `${file} is session-only`);
      assert.match(source, /platformSchemaReady\(/, file);
      assert.match(source, /crossSiteViolation\(/, file);
      continue;
    }
    const calls = [...source.matchAll(GUARD_CALL)];
    assert.ok(calls.length > 0, `${file} has no guard`);
    assert.equal(calls.length, (source.match(/authorizeErpRequest\(/g) ?? []).length, `${file}: every guard call must be recognisable`);
    const apiPath = apiPathOf(file);
    if (file === 'app/api/assistant/route.ts') {
      // 동적 모듈은 여기 하나뿐이다. 쿼리 값은 isAssistantModule(Object.hasOwn) 을 통과해야 ASSISTANT_MODULES 에서 조회된다.
      assert.deepEqual(calls.map((match) => match[1]), ['permissionModule']);
      assert.match(source, /if \(!isAssistantModule\(assistantModule\)\) return erpError\(400, "VALIDATION"/);
      assert.match(source, /const permissionModule = ASSISTANT_MODULES\[assistantModule\];/);
      assert.doesNotMatch(source, /payload\.module/);
      assert.match(read('app/access-tabs.ts'), /Object\.hasOwn\(ASSISTANT_MODULES, value\)/);
      continue;
    }
    const owners = tabsOfPath(apiPath);
    assert.equal(owners.length, 1, `${apiPath} must belong to exactly one tab's apiPrefixes (got ${owners})`);
    for (const [, argument] of calls) {
      const literal = /^"([a-z]+)"$/.exec(argument);
      assert.ok(literal, `${file}: module argument ${argument} is not a string literal`);
      assert.equal(MODULE_TAB.get(literal[1]), owners[0], `${file}: module "${literal[1]}" is not on the ${owners[0]} tab`);
    }
  }
});

test('source guard: every exported handler authorizes first and reads the body only afterwards', () => {
  const bodyRead = /\brequest\.(?:json|text|formData|arrayBuffer|blob)\(/;
  for (const file of routeFiles().filter((file) => !SESSION_ONLY.test(file))) {
    for (const { method, body } of handlers(read(file))) {
      const guard = body.search(/authorizeErpRequest\(/);
      assert.ok(guard >= 0, `${file} ${method} has no guard`);
      const readAt = body.search(bodyRead);
      if (readAt >= 0) assert.ok(guard < readAt, `${file} ${method} reads the body before authorizing`);
    }
  }
});

test('source guard: every mutating route writes an audit row', () => {
  for (const file of routeFiles().filter((file) => !SESSION_ONLY.test(file))) {
    const source = read(file);
    // R5: 읽음 위치 PUT 은 감사하지 않는다(Design §4.2.8). messenger-enhancement(ME-MD9, DD14): 개인 상태 chat/me 도 같다.
    if (file === 'app/api/chat/read-state/route.ts' || file === 'app/api/chat/me/route.ts') {
      assert.doesNotMatch(source, /writeErpAudit\(/, file);
      continue;
    }
    if (handlers(source).some(({ method }) => method !== 'GET')) assert.match(source, /writeErpAudit\(/, file);
  }
});

test('source guard: no route keeps the nested or approve-level authorization that D13 folded into edit', () => {
  for (const file of ['app/api/hr/payroll/route.ts', 'app/api/hr/operations/route.ts', 'app/api/hr/recruitment/route.ts', 'app/api/documents/route.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /authorizeErpRequest\([^)]*"approve"\)/, file);
    for (const { method, body } of handlers(source)) {
      assert.equal((body.match(/authorizeErpRequest\(/g) ?? []).length, 1, `${file} ${method} authorizes more than once`);
    }
  }
});

test('source guard: the registry is the only place that lists tabs and modules', () => {
  const platform = read('app/erp-platform.ts');
  const session = read('app/auth-session.ts');
  assert.match(platform, /import \{ accessDecision, type ErpAction, type ErpModule \} from "\.\/access-tabs";/);
  assert.doesNotMatch(platform, /new Map<string, TabKey>|MODULE_TAB|ADMIN_ONLY_TABS|REQUIRED_LEVEL/);
  assert.doesNotMatch(session, /INTERIM_TABS|GRANTABLE_TABS|roles/);
  assert.match(session, /import \{ resolveTabs, type ResolvedTabs \} from "\.\/access-tabs";/);
  for (const key of Object.keys(ASSISTANT_MODULES)) assert.ok(MODULE_TAB.has(ASSISTANT_MODULES[key]));
});
