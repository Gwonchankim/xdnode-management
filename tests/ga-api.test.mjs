// general-affairs(Design §9, GA-FR-01~11): 총무 라우트를 실제 코드·SQL 로 실행한다(하니스의 메모리 SQLite + 가짜 R2).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  TEST_SESSION_TOKEN, callApi, createAccount, db, login, objects, resetDatabase, setAccess, setClock, setPeer,
} from './helpers/hr-api-harness.mjs';

const { ensureHrEmployeeRecordsSchema } = await import('../app/hr-employee-schema.ts');
const alerts = await import('../app/ga-alerts.ts');
const importRules = await import('../app/ga-import.ts');

const ga = (path, method = 'GET', body, query = '', options = {}) => callApi(`general/${path}`, method, body, query, { cookie: TEST_SESSION_TOKEN, ...options });
const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const NOW = Date.parse('2026-09-30T01:00:00Z'); // KST 2026-09-30 10:00

async function world() {
  const sqlite = await resetDatabase();
  setAccess({}, { isAdmin: true });
  await ensureHrEmployeeRecordsSchema(db);
  const insert = sqlite.prepare(`INSERT INTO hr_employee_records (employee_id, name, birth, email, phone, address, department, manager, employment_type,
    position, job_title, status, updated_at) VALUES (?, ?, '', '', '', '', ?, '', '정규직', '사원', '', ?, 0)`);
  insert.run('emp-a', '김하나', '경영지원실', '재직');
  insert.run('emp-b', '이두리', '영업팀', '재직');
  insert.run('emp-c', '박세나', '영업팀', '재직');
  insert.run('emp-d', '박세나', '기술팀', '재직');
  return sqlite;
}
async function as(tabs, extra = {}) {
  const account = await createAccount({ tabs, ...extra });
  const session = await login(account.email, account.password);
  return { ...account, call: (path, method = 'GET', body, query = '', options = {}) => callApi(`general/${path}`, method, body, query, { ...options, cookie: session.cookie }) };
}
const create = async (body) => {
  const result = await ga('assets', 'POST', { action: 'CREATE', ...body });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.asset;
};

test('GA #1: general=none is refused everywhere; general=view can read but not write', async () => {
  await world();
  const none = await as({ hr: 'edit' });
  for (const path of ['overview', 'people', 'assets', 'documents', 'custody']) assert.equal((await none.call(path)).status, 403, path);
  assert.equal((await none.call('assets', 'POST', { action: 'CREATE', kind: 'SUPPLY', name: 'x', quantity: 1 })).status, 403);
  const viewer = await as({ general: 'view' });
  assert.equal((await viewer.call('overview')).status, 200);
  const people = (await viewer.call('people')).body.people;
  assert.ok(people.every((person) => Object.keys(person).sort().join() === 'department,employeeId,name,status'), 'no pay or contact fields');
  assert.equal((await viewer.call('assets', 'POST', { action: 'CREATE', kind: 'SUPPLY', name: 'x', quantity: 1 })).status, 403);
  assert.equal((await viewer.call('custody', 'POST', { action: 'CREATE_ITEM', kind: 'CORP_SEAL', name: '법인인감' })).status, 403);
  assert.ok((await rows(`SELECT id FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' AND module = 'general'`)).length >= 3);
});

test('GA #2 #4: equipment create → assign → double assign 409 → return; asset numbers are sequential and unique', async () => {
  await world();
  const laptop = await create({ kind: 'EQUIPMENT', name: '노트북 A', serialNo: 'SN-1', acquiredOn: '2026-03-02', acquisitionCost: 1890000 });
  assert.equal(laptop.assetNo, 'GA-EQ-2026-0001');
  assert.equal(laptop.status, 'IN_STOCK');
  const second = await create({ kind: 'EQUIPMENT', name: '노트북 B', acquiredOn: '2026-05-01' });
  assert.equal(second.assetNo, 'GA-EQ-2026-0002');
  const dup = await ga('assets', 'POST', { action: 'CREATE', kind: 'EQUIPMENT', name: 'C', assetNo: 'GA-EQ-2026-0001' });
  assert.deepEqual([dup.status, dup.body.code], [409, 'DUPLICATE']);
  const assigned = await ga('assets', 'POST', { action: 'ASSIGN', id: laptop.id, employeeId: 'emp-a' });
  assert.deepEqual([assigned.status, assigned.body.asset.status, assigned.body.asset.holderName], [200, 'ASSIGNED', '김하나']);
  const again = await ga('assets', 'POST', { action: 'ASSIGN', id: laptop.id, employeeId: 'emp-b' });
  assert.equal(again.status, 409);
  assert.equal((await ga('assets', 'POST', { action: 'ASSIGN', id: second.id, employeeId: 'no-such' })).status, 400);
  const returned = await ga('assets', 'POST', { action: 'RETURN', id: laptop.id, location: '창고' });
  assert.deepEqual([returned.body.asset.status, returned.body.asset.holderEmployeeId, returned.body.asset.location], ['IN_STOCK', null, '창고']);
  const detail = await ga('assets', 'GET', undefined, `?id=${laptop.id}`);
  assert.deepEqual(detail.body.events.map((event) => event.kind).sort(), ['ACQUIRED', 'ASSIGNED', 'RETURNED']);
  assert.equal((await ga('assets', 'POST', { action: 'STOCK_IN', id: laptop.id, quantity: 1 })).status, 400, 'stock moves are for supplies only');
});

test('GA #3: supplies cannot go negative, even with two outs racing', async () => {
  await world();
  const paper = await create({ kind: 'SUPPLY', name: 'A4 용지', quantity: 3, unit: '박스', minQuantity: 2, acquisitionCost: 25000 });
  assert.equal((await ga('assets', 'POST', { action: 'STOCK_OUT', id: paper.id, quantity: 5 })).status, 400);
  const [one, two] = await Promise.all([
    ga('assets', 'POST', { action: 'STOCK_OUT', id: paper.id, quantity: 2 }),
    ga('assets', 'POST', { action: 'STOCK_OUT', id: paper.id, quantity: 2 }),
  ]);
  // 늦게 온 쪽은 사전 검사(400 재고 부족)나 조건부 UPDATE(409)에서 막힌다. 어느 쪽이든 음수는 없다.
  const statuses = [one.status, two.status].sort();
  assert.equal(statuses[0], 200);
  assert.ok([400, 409].includes(statuses[1]), String(statuses[1]));
  const [row] = await rows(`SELECT quantity FROM ga_assets WHERE id = ?`, paper.id);
  assert.equal(row.quantity, 1);
  assert.equal((await rows(`SELECT id FROM ga_asset_events WHERE asset_id = ? AND kind = 'STOCK_OUT'`, paper.id)).length, 1, 'the losing request leaves no history row');
  const overview = await ga('overview');
  assert.equal(overview.body.lowStock.length, 1);
});

test('GA #5: fixed assets depreciate straight-line monthly; disposal stops it', async () => {
  const schedule = alerts.depreciationSchedule({ acquisitionCost: 1_200_000, residualValue: 0, usefulLifeMonths: 36, inServiceMonth: '2026-01' });
  assert.equal(schedule.length, 36);
  assert.equal(schedule[0].depreciation, 33_334);
  assert.equal(schedule[11].depreciation, 33_334);
  assert.equal(schedule[12].depreciation, 33_333);
  assert.equal(schedule.at(-1).accumulated, 1_200_000);
  const asOf = alerts.depreciationAsOf({ acquisitionCost: 1_200_000, residualValue: 0, usefulLifeMonths: 36, inServiceMonth: '2026-01' }, '2026-09');
  assert.deepEqual([asOf.accumulated, asOf.bookValue], [300_006, 899_994]);
  const opening = alerts.depreciationSchedule({ acquisitionCost: 1_200_000, residualValue: 0, usefulLifeMonths: 36, inServiceMonth: '2026-01', openingAccumulated: 200_000, openingAsOfMonth: '2026-06' });
  assert.deepEqual([opening[0].period, opening[0].accumulated], ['2026-06', 200_000]);
  const openingAsOf = alerts.depreciationAsOf({ acquisitionCost: 1_200_000, residualValue: 0, usefulLifeMonths: 36, inServiceMonth: '2026-01', openingAccumulated: 200_000, openingAsOfMonth: '2026-06' }, '2026-09');
  assert.equal(asOf.monthly, 33_334);
  assert.equal(openingAsOf.monthly, 33_334, '월 상각액은 기초 누계 줄이 아니라 그다음 달 상각액');
  const disposed = alerts.depreciationSchedule({ acquisitionCost: 1_200_000, residualValue: 0, usefulLifeMonths: 36, inServiceMonth: '2026-01', disposedMonth: '2026-03' });
  assert.equal(disposed.length, 3);
  assert.equal(alerts.depreciationValid({ acquisitionCost: 100, residualValue: 100, usefulLifeMonths: 12, inServiceMonth: '2026-01' }), false);

  await world();
  setClock(NOW);
  const fixed = await create({ kind: 'FIXED', name: '영상회의 장비', acquiredOn: '2026-01-10', acquisitionCost: 1_200_000, usefulLifeMonths: 36 });
  assert.deepEqual([fixed.bookValue, fixed.monthlyDepreciation], [899_994, 33_334]);
  assert.equal((await ga('assets', 'POST', { action: 'CREATE', kind: 'FIXED', name: 'x', acquiredOn: '2026-01-01', acquisitionCost: 100, usefulLifeMonths: 12, residualValue: 100 })).status, 400);
  assert.equal((await ga('assets', 'POST', { action: 'DISPOSE', id: fixed.id, amount: 300000 })).status, 400, 'disposal needs a reason');
  const gone = await ga('assets', 'POST', { action: 'DISPOSE', id: fixed.id, amount: 300000, reason: '고장', on: '2026-09-30' });
  assert.equal(gone.body.asset.status, 'DISPOSED');
  setClock(null);
});

test('GA #6 #7: one open checkout per target; documents under checkout cannot be deleted', async () => {
  await world();
  const seal = (await ga('custody', 'POST', { action: 'CREATE_ITEM', kind: 'CORP_SEAL', name: '법인인감', storageLocation: '금고' })).body.id;
  const other = (await ga('custody', 'POST', { action: 'CREATE_ITEM', kind: 'USAGE_SEAL', name: '사용인감' })).body.id;
  const out = { action: 'CHECKOUT', targetType: 'ITEM', targetId: seal, borrowerEmployeeId: 'emp-a', purpose: '은행 서류', outOn: '2026-09-28', dueOn: '2026-09-29' };
  const first = await ga('custody', 'POST', out);
  assert.equal(first.status, 201);
  const [again, parallel] = await Promise.all([ga('custody', 'POST', out), ga('custody', 'POST', { ...out, targetId: other })]);
  assert.deepEqual([again.status, again.body.code, parallel.status], [409, 'CONFLICT', 201]);
  const list = await ga('custody');
  const sealItem = list.body.items.find((item) => item.id === seal);
  assert.equal(sealItem.openCheckout.borrowerName, '김하나');
  assert.equal((await ga('custody', 'POST', { action: 'RETURN', id: first.body.id, returnedOn: '2026-09-27' })).status, 400, 'return before checkout date');
  assert.equal((await ga('custody', 'POST', { action: 'RETURN', id: first.body.id, returnedOn: '2026-09-30', receivedBy: '이두리' })).status, 200);
  assert.equal((await ga('custody', 'POST', out)).status, 201, 'returned targets can go out again');
  assert.equal((await ga('custody', 'POST', { action: 'DELETE_ITEM', id: seal })).status, 409);

  const doc = (await ga('documents', 'POST', { action: 'CREATE', kind: 'SEAL_CERT', title: '인감증명서', storageLocation: '서랍', issuedOn: '2026-09-01', validityMonths: 3 })).body.document;
  assert.equal(doc.expiry, '2026-12-01');
  await ga('custody', 'POST', { action: 'CHECKOUT', targetType: 'DOCUMENT', targetId: doc.id, borrowerEmployeeId: 'emp-b', purpose: '입찰' });
  assert.equal((await ga('documents', 'POST', { action: 'DELETE', id: doc.id })).status, 409);
  assert.equal((await ga('custody', 'POST', { action: 'CHECKOUT', targetType: 'DOCUMENT', targetId: 'gad_missing', borrowerEmployeeId: 'emp-b', purpose: 'x' })).status, 404);
});

test('GA #8: alert buckets, month-end expiry, B2B notice deadlines, auto-renew defaults', async () => {
  const today = '2026-09-30';
  assert.equal(alerts.bucketOf('2026-09-29', today), 'OVERDUE');
  assert.equal(alerts.bucketOf('2026-09-30', today), 'TODAY');
  assert.equal(alerts.bucketOf('2026-10-07', today), 'D7');
  assert.equal(alerts.bucketOf('2026-10-08', today), 'D30');
  assert.equal(alerts.bucketOf('2026-10-30', today), 'D30');
  assert.equal(alerts.bucketOf('2026-10-31', today), null);
  assert.equal(alerts.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(alerts.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(alerts.kstToday(Date.parse('2026-09-30T15:30:00Z')), '2026-10-01', 'KST calendar day');

  await world();
  setClock(NOW);
  const renew = await create({ kind: 'CONTRACT', name: '오피스 라이선스', counterparty: 'MS', endsOn: '2026-10-03', autoRenew: true });
  assert.equal(renew.alertOff, true, 'auto-renew contracts start with alerts off');
  await create({ kind: 'CONTRACT', name: '도메인', counterparty: '가비아', endsOn: '2026-10-05' });
  const b2b = await ga('documents', 'POST', { action: 'CREATE', kind: 'B2B_CONTRACT', title: '물품공급 기본계약', contractType: 'SUPPLY', counterparty: '○○상사',
    endsOn: '2026-11-30', autoRenew: true, noticeDays: 40 });
  assert.equal(b2b.status, 201);
  assert.equal((await ga('documents', 'POST', { action: 'CREATE', kind: 'B2B_CONTRACT', title: 'x', contractType: 'SUPPLY', counterparty: 'y', noticeDays: 10 })).status, 400,
    'a notice deadline needs an end date');
  const overview = await ga('overview');
  const keys = overview.body.alerts.map((item) => [item.kind, item.bucket, item.dueOn]);
  assert.deepEqual(keys, [['CONTRACT_END', 'D7', '2026-10-05'], ['DOC_NOTICE', 'D30', '2026-10-21']], 'auto-renew B2B alerts only the notice deadline');
  assert.equal(overview.body.badge, 1);
  assert.deepEqual((await ga('overview', 'GET', undefined, '?summary=1')).body, { badge: 1 });
  setClock(null);
});

test('GA #9 #10 #11: the daily alert run posts once to a members-only channel written by a non-account author', async () => {
  await world();
  setClock(NOW);
  await create({ kind: 'CONTRACT', name: '도메인', counterparty: '가비아', endsOn: '2026-10-05' });
  const viewer = await as({ general: 'view', chat: 'edit' });
  const outsider = await as({ chat: 'edit' });
  // 세션 없는 시스템 호출: 루프백 + 헤더만 받는다.
  setPeer('192.0.2.50');
  const remote = await callApi('general/alerts', 'POST', { trigger: 'task' }, '', { cookie: null, headers: { 'x-xdm-task': 'ga-alerts' } });
  assert.equal(remote.status, 401);
  setPeer('127.0.0.1');
  const run = await callApi('general/alerts', 'POST', { trigger: 'task' }, '', { cookie: null, headers: { 'x-xdm-task': 'ga-alerts' } });
  assert.equal(run.status, 200);
  assert.deepEqual([run.body.posted, run.body.itemCount, run.body.alreadyRan], [true, 1, false]);
  const twice = await callApi('general/alerts', 'POST', { trigger: 'task' }, '', { cookie: null, headers: { 'x-xdm-task': 'ga-alerts' } });
  assert.deepEqual([twice.body.posted, twice.body.alreadyRan], [false, true]);
  const messages = await rows(`SELECT author_account_id, body FROM chat_messages WHERE channel_id = 'ch_ga_alerts'`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].author_account_id, 'system:ga');
  assert.match(messages[0].body, /\[총무 알림\] 2026-09-30/);
  assert.match(messages[0].body, /⚠️ D-7 {2}계약 · 도메인 — 가비아 · 만료 10-05 \(5일 남음\)/);
  const members = (await rows(`SELECT account_id FROM chat_members WHERE channel_id = 'ch_ga_alerts' AND left_at IS NULL`)).map((row) => row.account_id).sort();
  assert.ok(members.includes(viewer.id) && !members.includes(outsider.id), 'only accounts with the general tab');
  assert.equal((await rows(`SELECT id FROM auth_accounts WHERE id LIKE 'system:%'`)).length, 0, 'the author is not an account');
  // 채팅 쪽에서 본 모습: 멤버에게는 'XDnode 알림' 글, 비멤버에게는 채널 자체가 없다.
  const viewerChat = await callApi('chat/messages', 'GET', undefined, '?channelId=ch_ga_alerts', { cookie: (await login(viewer.email, viewer.password)).cookie });
  assert.equal(viewerChat.body.messages[0].author.name, 'XDnode 알림');
  const outsiderChat = await callApi('chat/messages', 'GET', undefined, '?channelId=ch_ga_alerts', { cookie: (await login(outsider.email, outsider.password)).cookie });
  assert.equal(outsiderChat.status, 404);
  // 다음 날: 권한을 뺀 계정은 나가고, 새로 급해진 항목만 싣는다.
  await db.prepare(`UPDATE auth_accounts SET tabs_json = '{"chat":"edit"}' WHERE id = ?`).bind(viewer.id).run();
  setClock(NOW + 86_400_000 * 2);
  const next = await callApi('general/alerts', 'POST', {}, '', { cookie: null, headers: { 'x-xdm-task': 'ga-alerts' } });
  assert.deepEqual([next.body.posted, next.body.itemCount], [false, 0], 'still D-7: nothing new to say');
  assert.equal((await rows(`SELECT 1 FROM chat_members WHERE channel_id = 'ch_ga_alerts' AND account_id = ? AND left_at IS NULL`, viewer.id)).length, 0);
  setClock(NOW + 86_400_000 * 5);
  const today = await callApi('general/alerts', 'POST', {}, '', { cookie: null, headers: { 'x-xdm-task': 'ga-alerts' } });
  assert.deepEqual([today.body.posted, today.body.itemCount], [true, 1], 'TODAY is more urgent than D-7');
  setPeer('192.0.2.10');
  setClock(null);
  const audit = await rows(`SELECT actor_user_id FROM erp_audit_logs WHERE action = 'GA_ALERTS_RUN'`);
  assert.ok(audit.length >= 3 && audit.every((row) => row.actor_user_id === 'SYSTEM'));
});

const pdf = new TextEncoder().encode('%PDF-1.4 ga');
test('GA #12: attachments follow the messenger rules; viewers download only', async () => {
  await world();
  const doc = (await ga('documents', 'POST', { action: 'CREATE', kind: 'BUSINESS_REG', title: '사업자등록증', storageLocation: '금고' })).body.document;
  const put = (name, bytes, headers = { 'content-length': String(bytes.byteLength) }, call = ga) =>
    call('attachments', 'PUT', undefined, `?ownerType=DOCUMENT&ownerId=${doc.id}&name=${encodeURIComponent(name)}`, { rawBody: bytes, contentType: 'text/html', headers });
  const up = await put('사업자등록증.pdf', pdf);
  assert.equal(up.status, 201);
  for (const [name, status] of [['cert.pfx', 415], ['key.p12', 415], ['page.svg', 415]]) assert.equal((await put(name, pdf)).status, status, name);
  assert.equal((await put('a.pdf', pdf, { 'content-length': '26214401' })).status, 413);
  assert.equal((await put('a.pdf', pdf, {})).status, 411);
  assert.ok([...objects.keys()].every((key) => key.startsWith(`ga/DOCUMENT/${doc.id}/gaf_`)));
  const viewer = await as({ general: 'view' });
  const got = await viewer.call('attachments', 'GET', undefined, `?id=${up.body.attachment.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.match(got.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
  assert.equal((await put('b.pdf', pdf, undefined, viewer.call)).status, 403);
  assert.equal((await viewer.call('attachments', 'DELETE', undefined, `?id=${up.body.attachment.id}`)).status, 403);
  assert.equal((await ga('attachments', 'DELETE', undefined, `?id=${up.body.attachment.id}`)).status, 200);
  assert.equal(objects.size, 0);
});

test('GA #13: import previews row errors, commits all-or-nothing, skips or overwrites duplicates, and reverts', async () => {
  await world();
  const table = [
    ['이름*', '분류', '상태', '사용자', '취득일', '취득가', '자산번호'],
    ['노트북 (LG gram 16)', '노트북', '지급', '홍길동', '2026-03-02', '1,890,000', ''], // 양식 예시 행과 다르므로 데이터로 본다
    ['노트북 A', '노트북', '지급', '김하나', '2026.03.02', '1,890,000원', ''],
    ['노트북 B', '노트북', '지급', '박세나', 46296, '1000000', ''],
    ['', '', '', '', '', '', ''],
  ];
  const { rows: parsed, missing } = importRules.rowsFromTable('EQUIPMENT', table);
  assert.deepEqual(missing, []);
  assert.equal(parsed.length, 3);
  const previewed = await ga('import', 'POST', { action: 'PREVIEW', sheet: 'EQUIPMENT', rows: parsed });
  const statuses = previewed.body.rows.map((row) => [row.row, row.status, row.errors.join('|')]);
  assert.equal(statuses[0][1], 'error', '홍길동 is not an employee');
  assert.equal(statuses[1][1], 'ok');
  assert.match(statuses[2][2], /동명이인/);
  assert.equal((await ga('import', 'POST', { action: 'COMMIT', sheet: 'EQUIPMENT', rows: parsed })).status, 400, 'errors block the commit');
  const fixed = parsed.slice(1).map((row) => row.row === 4 ? { ...row, raw: { ...row.raw, 사용자: 'emp-c' } } : row);
  const committed = await ga('import', 'POST', { action: 'COMMIT', sheet: 'EQUIPMENT', rows: fixed });
  assert.deepEqual([committed.status, committed.body.created, committed.body.skipped], [200, 2, 0]);
  const assets = await rows(`SELECT asset_no, holder_employee_id, acquired_on, acquisition_cost, status FROM ga_assets ORDER BY asset_no`);
  assert.deepEqual(assets.map((row) => [row.asset_no, row.holder_employee_id, row.acquired_on, row.acquisition_cost, row.status]), [
    ['GA-EQ-2026-0001', 'emp-a', '2026-03-02', 1890000, 'ASSIGNED'],
    ['GA-EQ-2026-0002', 'emp-c', '2026-10-01', 1000000, 'ASSIGNED'],
  ]);
  const again = [{ row: 3, raw: { '이름': '노트북 A (수정)', '자산번호': 'GA-EQ-2026-0001', '취득가': '2000000' } }];
  const dupPreview = await ga('import', 'POST', { action: 'PREVIEW', sheet: 'EQUIPMENT', rows: again });
  assert.equal(dupPreview.body.rows[0].status, 'duplicate');
  assert.equal((await ga('import', 'POST', { action: 'COMMIT', sheet: 'EQUIPMENT', rows: again })).body.skipped, 1);
  const overwrite = await ga('import', 'POST', { action: 'COMMIT', sheet: 'EQUIPMENT', rows: again, mode: 'overwrite', overwriteRows: [3] });
  assert.equal(overwrite.body.updated, 1);
  assert.equal((await rows(`SELECT name FROM ga_assets WHERE asset_no = 'GA-EQ-2026-0001'`))[0].name, '노트북 A (수정)');
  assert.equal((await ga('import', 'POST', { action: 'REVERT', batchId: committed.body.batchId })).status, 200);
  assert.equal((await rows(`SELECT id FROM ga_assets WHERE deleted_at IS NULL`)).length, 0);
  assert.equal((await ga('import', 'POST', { action: 'REVERT', batchId: committed.body.batchId })).status, 400, 'a batch reverts once');
  // 반출대장: 대상 이름으로 찾고, 반납일 없는 행은 열린 반출이다.
  await ga('custody', 'POST', { action: 'CREATE_ITEM', kind: 'CORP_SEAL', name: '법인인감' });
  const checkouts = [
    { row: 3, raw: { '대상': '법인인감', '반출자': '김하나', '반출일': '2026-09-01', '용도': '은행', '반납일': '2026-09-02' } },
    { row: 4, raw: { '대상': '법인인감', '반출자': '이두리', '반출일': '2026-09-20', '용도': '계약' } },
    { row: 5, raw: { '대상': '법인인감', '반출자': '이두리', '반출일': '2026-09-21', '용도': '계약' } },
  ];
  const checkoutPreview = await ga('import', 'POST', { action: 'PREVIEW', sheet: 'CHECKOUT', rows: checkouts });
  assert.deepEqual(checkoutPreview.body.rows.map((row) => row.status), ['ok', 'ok', 'error']);
  const imported = await ga('import', 'POST', { action: 'COMMIT', sheet: 'CHECKOUT', rows: checkouts.slice(0, 2) });
  assert.equal(imported.body.created, 2);
  assert.equal((await ga('custody', 'GET', undefined, '?open=1')).body.checkouts.length, 1);
});

test('GA #14: HR retirement settlement lists assets still held, for HR editors only', async () => {
  const sqlite = await resetDatabase();
  setAccess({ hr: 'edit' });
  assert.deepEqual((await callApi('hr/operations', 'GET', undefined, '?retirementAssets=emp-a')).body, { assets: [] }, 'fresh DB: no GA tables, none created');
  assert.equal(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'ga_assets'`).get(), undefined);
  await world();
  const laptop = await create({ kind: 'EQUIPMENT', name: '노트북', holderEmployeeId: 'emp-a' });
  await create({ kind: 'EQUIPMENT', name: '반납된 모니터' });
  setAccess({ hr: 'edit' });
  const held = await callApi('hr/operations', 'GET', undefined, '?retirementAssets=emp-a');
  assert.deepEqual(held.body.assets.map((asset) => asset.id), [laptop.id]);
  setAccess({ hr: 'view' });
  assert.equal((await callApi('hr/operations', 'GET', undefined, '?retirementAssets=emp-a')).status, 403);
});

test('GA #15 #16: audit rows carry no names, numbers or file names; source guards', async () => {
  await world();
  await create({ kind: 'CONTRACT', name: '비밀 라이선스명', counterparty: '비밀상사', contractNo: 'CN-SECRET-9', endsOn: '2027-01-01' });
  await ga('documents', 'POST', { action: 'CREATE', kind: 'B2B_CONTRACT', title: '비밀 파트너 계약', contractType: 'PARTNER', counterparty: '비밀파트너', contractAmount: 5000000 });
  const audit = (await rows(`SELECT before_json, after_json FROM erp_audit_logs WHERE module = 'general'`)).map((row) => `${row.before_json}${row.after_json}`).join('\n');
  assert.doesNotMatch(audit, /비밀|CN-SECRET/);
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const registry = read('app/access-tabs.ts');
  assert.match(registry, /\{ key: "general", label: "총무", glyph: "▣", adminOnly: false, modules: \["general"\], apiPrefixes: \["\/api\/general\/"\], shellClass: "general-module-shell" \}/);
  for (const route of ['assets', 'documents', 'custody', 'attachments', 'import', 'overview', 'people']) {
    assert.match(read(`app/api/general/${route}/route.ts`), /authorizeErpRequest\(db, "general", "(read|write)"\)/, route);
  }
  assert.match(read('app/chat-server.ts'), /row\.author_account_id\.startsWith\("system:"\) \? "XDnode 알림"/);
  assert.doesNotMatch(read('app/ga-alert-run.ts'), /INSERT INTO auth_accounts/);
});

test('GA scripts: Run-GaAlerts posts with the task header from the server PC; Start runs it once, Register adds the 09:00 task', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
  for (const name of ['Run-GaAlerts', 'Start-XDNodeManagement', 'Register-XDNodeManagementTasks']) {
    assert.deepEqual([...read(`scripts/${name}.ps1`).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}.ps1 needs a UTF-8 BOM`);
  }
  const run = read('scripts/Run-GaAlerts.ps1').toString('utf8');
  assert.match(run, /\$base = "http:\/\/127\.0\.0\.1:\$Port"/);
  assert.match(run, /"X-XDM-Task" = "ga-alerts"; "Origin" = \$base/);
  const start = read('scripts/Start-XDNodeManagement.ps1').toString('utf8');
  // 09:00 전 재기동(03:00 백업)은 알림을 건너뛴다. 그날 알림은 09:00 작업이 보낸다.
  assert.match(start, /if \(\$Headless -and \$Port -eq 3000 -and \(Get-Date\)\.Hour -ge 9\) \{\s*\$alertScript = Join-Path \$PSScriptRoot "Run-GaAlerts\.ps1"/);
  assert.ok(start.indexOf('Run-GaAlerts.ps1') > start.indexOf('ready: GET http://127.0.0.1:$Port/api/me -> 401'), 'alerts run only after the server is ready');
  const register = read('scripts/Register-XDNodeManagementTasks.ps1').toString('utf8');
  assert.match(register, /\$AlertsTask = "XDnodeManagement-Alerts"/);
  assert.match(register, /\[string\]\$AlertsTime = "09:00"/);
  assert.match(register, /if \(Test-Path -LiteralPath \$alertsScript\) \{\s*\$definitions \+= @\{ Name = \$AlertsTask/);
});

test('GA UI: the document and asset create forms take files and upload them to the new item', () => {
  const workspace = readFileSync(new URL('../app/general-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /\{ name: "files", label: "서류 파일\(스캔본·사진, 선택\)", type: "files"/);
  assert.match(workspace, /\{ name: "files", label: "첨부\(사진·영수증·계약서 등, 선택\)", type: "files"/);
  assert.match(workspace, /const problems = await uploadGaFiles\("DOCUMENT", result\.body\.document\.id, files\);/);
  assert.match(workspace, /const problems = await uploadGaFiles\("ASSET", result\.body\.asset\.id, files\);/);
  // 모든 칸은 같은 틀(ga-field: 제목 줄 → 40px 상자 → 안내)이고, 파일·체크 칸은 label 을 중첩하지 않는다.
  assert.match(workspace, /<div key=\{field\.name\} className=\{\["ga-field", wide \? "wide" : "", aiFilled\.has\(field\.name\) \? "ai-filled" : ""\]\.filter\(Boolean\)\.join\(" "\)\}>/);
  assert.match(workspace, /<label className="ga-toggle" htmlFor=\{id\}>/);
  assert.match(workspace, /<label className="ga-file-button" htmlFor=\{id\}>/);
  const css = readFileSync(new URL('../app/general-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.ga-field \{ min-width: 0; display: grid; grid-template-rows: 18px auto; row-gap: 6px; \}/, 'one label row height for every field');
  assert.match(css, /height: 40px;/);
  assert.match(workspace, /!fileExtensionAllowed\(file\.name\)/, 'the same extension table as the server, checked before upload');
});

test('GA-D6: documents register without a storage location, and editing keeps a value recorded earlier', async () => {
  await world();
  const created = await ga('documents', 'POST', { action: 'CREATE', kind: 'BUSINESS_REG', title: '사업자등록증' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const legacy = (await ga('documents', 'POST', { action: 'CREATE', kind: 'PERMIT', title: '허가증', storageLocation: '금고 1단' })).body.document;
  const edited = await ga('documents', 'POST', { action: 'UPDATE', id: legacy.id, kind: 'PERMIT', title: '허가증(갱신)', updatedAt: legacy.updatedAt });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.document.title, edited.body.document.storageLocation], ['허가증(갱신)', '금고 1단']);
  const { GA_SHEETS } = importRules;
  assert.ok(!GA_SHEETS.DOCUMENT.columns.some((column) => column.field === 'storageLocation'));
  assert.ok(!GA_SHEETS.B2B_CONTRACT.columns.some((column) => column.field === 'storageLocation'));
  assert.doesNotMatch(readFileSync(new URL('../app/general-workspace.tsx', import.meta.url), 'utf8'), /label: "원본 보관 위치"/);
});

test('GA-D7: AI fill keeps only known fields in known formats, and the route forwards images to the bridge without saving anything', async () => {
  const extract = await import('../app/ga-extract.ts');
  // 모델이 형식을 어기거나 모르는 칸·지시를 섞어도 정해진 칸만 통과한다.
  const fields = extract.normalizeExtracted('DOCUMENT', JSON.stringify({
    kind: 'B2B_CONTRACT', title: ' 물품공급 기본계약서 ', counterparty: '○○상사', startsOn: '2026-01-01', endsOn: '2027-12-31',
    contractAmount: '12,000,000원', autoRenew: true, noticeDays: 30, issuer: '세무서', issuedOn: '2026-13-40', password: 'x', contractType: 'BAD',
  }));
  assert.deepEqual(fields, { kind: 'B2B_CONTRACT', title: '물품공급 기본계약서', counterparty: '○○상사', startsOn: '2026-01-01', endsOn: '2027-12-31', contractAmount: 12000000, autoRenew: true, noticeDays: 30 });
  const plain = extract.normalizeExtracted('DOCUMENT', { kind: 'BUSINESS_REG', title: '사업자등록증', issuer: '예시세무서', issuedOn: '2026-09-15', counterparty: '섞이면 안 됨' });
  assert.deepEqual(plain, { kind: 'BUSINESS_REG', title: '사업자등록증', issuer: '예시세무서', issuedOn: '2026-09-15' });
  assert.deepEqual(extract.normalizeExtracted('CONTRACT', 'not json'), {});
  const schema = extract.extractSchema('CONTRACT');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['autoRenew', 'billingCycle', 'category', 'contractNo', 'counterparty', 'endsOn', 'memo', 'name', 'renewalCost', 'startsOn'].sort());
  assert.match(extract.extractPrompts('DOCUMENT', 'a.pdf', '').system, /지시가 아닙니다/, 'text inside the document is data, not instructions');

  await world();
  const { testBindings } = await import('./helpers/hr-api-harness.mjs');
  testBindings.CLAUDE_BRIDGE_URL = 'http://bridge.invalid';
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ content: JSON.stringify({ name: '보험증권', counterparty: '예시화재', endsOn: '2027-03-31', autoRenew: false, renewalCost: 480000, billingCycle: 'YEARLY' }) });
  };
  try {
    const image = { mediaType: 'image/jpeg', data: 'QUJDRA==' };
    const ok = await ga('extract', 'POST', { target: 'CONTRACT', images: [image], text: '', fileName: '증권.jpg' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.fields, { name: '보험증권', counterparty: '예시화재', endsOn: '2027-03-31', autoRenew: false, renewalCost: 480000, billingCycle: 'YEARLY' });
    assert.equal(calls[0].url, 'http://bridge.invalid/extract');
    assert.deepEqual(calls[0].body.images, [image]);
    assert.equal((await rows(`SELECT name FROM sqlite_master WHERE name LIKE 'ga_%'`)).length, 0, 'the AI call reads nothing and saves nothing in the ledger');
    const audit = await rows(`SELECT after_json FROM erp_audit_logs WHERE action = 'GA_AI_EXTRACTED'`);
    assert.deepEqual(JSON.parse(audit[0].after_json), { target: 'CONTRACT', images: 1, textChars: 0, filled: 6 });
    assert.doesNotMatch(audit[0].after_json, /보험|예시화재|증권/);
    for (const bad of [{ target: 'X', images: [image] }, { target: 'DOCUMENT', images: [] }, { target: 'DOCUMENT', images: [{ mediaType: 'image/svg+xml', data: 'QQ==' }] },
      { target: 'DOCUMENT', images: Array.from({ length: 5 }, () => image) }]) {
      assert.equal((await ga('extract', 'POST', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    const viewer = await as({ general: 'view' });
    assert.equal((await viewer.call('extract', 'POST', { target: 'DOCUMENT', images: [image] })).status, 403);
    globalThis.fetch = async () => { throw new Error('down'); };
    const down = await ga('extract', 'POST', { target: 'DOCUMENT', images: [image] });
    assert.deepEqual([down.status, down.body.code], [502, 'AI_UNAVAILABLE']);
  } finally {
    globalThis.fetch = original;
  }
  const bridge = readFileSync(new URL('../scripts/claude-resume-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /"--input-format", "stream-json",/);
  const vision = bridge.slice(bridge.indexOf('function runClaudeVision'), bridge.indexOf('async function handleExtract'));
  assert.match(vision, /"--tools", "",/, 'the vision run keeps every tool off');
  assert.match(vision, /"--disallowed-tools", \.\.\.DISABLED_TOOLS,/);
  assert.doesNotMatch(vision, /writeFile|mkdtemp/, 'images go through stdin, never to disk');
  const workspace = readFileSync(new URL('../app/general-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /extractTarget: "DOCUMENT"/);
  assert.match(workspace, /extractTarget: assetKind as ExtractTarget/);
});

test('GA-D10 snacks: purchases keep item rows and totals, edits replace rows atomically, receipts are images under ga/SNACK', async () => {
  const extract = await import('../app/ga-extract.ts');
  // AI 출력 정리: 배송비·할인 줄은 빼고, 단가·금액 중 하나만 있으면 나머지를 계산한다.
  assert.deepEqual(extract.normalizeSnackItems([
    { name: '농심 새우깡 90g', quantity: 10, unitPrice: 1200, amount: null },
    { name: '오리온 초코파이 12개입', quantity: 2, unitPrice: null, amount: 9600 },
    { name: '배송비', quantity: 1, unitPrice: 3000, amount: 3000 },
    { name: ' ', quantity: 1, unitPrice: 1, amount: 1 },
    { name: '제주 감귤주스', quantity: null, unitPrice: '2,500원', amount: null },
  ]), [
    { name: '농심 새우깡 90g', quantity: 10, unitPrice: 1200, amount: 12000 },
    { name: '오리온 초코파이 12개입', quantity: 2, unitPrice: 4800, amount: 9600 },
    { name: '제주 감귤주스', quantity: 1, unitPrice: 2500, amount: 2500 },
  ]);
  const snack = extract.normalizeExtracted('SNACK', { purchasedOn: '2026-10-01', vendor: '쿠팡', shippingFee: 0, discount: 1000, total: 23100, items: [{ name: '새우깡', quantity: 1, unitPrice: 1200, amount: 1200 }] });
  assert.deepEqual(snack, { items: [{ name: '새우깡', quantity: 1, unitPrice: 1200, amount: 1200 }], purchasedOn: '2026-10-01', vendor: '쿠팡', shippingFee: 0, discount: 1000, total: 23100 });
  assert.ok(extract.extractSchema('SNACK').properties.items.items.required.includes('unitPrice'));

  await world();
  const items = [{ name: '새우깡 90g', quantity: 10, unitPrice: 1200 }, { name: '초코파이', quantity: 2, unitPrice: 4800, amount: 9600 }];
  const created = await ga('snacks', 'POST', { action: 'CREATE', purchasedOn: '2026-10-01', vendor: '쿠팡', shippingFee: 3000, discount: 1000, items });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let list = (await ga('snacks', 'GET', undefined, '?from=2026-01-01')).body.purchases;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].itemsTotal, list[0].totalAmount], [21600, 23600], 'total = items + shipping - discount when not given');
  assert.deepEqual(list[0].items.map((item) => [item.name, item.quantity, item.amount]), [['새우깡 90g', 10, 12000], ['초코파이', 2, 9600]]);
  for (const bad of [{ purchasedOn: '2026-13-01', items }, { purchasedOn: '2026-10-01', items: [] }, { purchasedOn: '2026-10-01', items: [{ name: 'x', quantity: 0, unitPrice: 1 }] },
    { purchasedOn: '2026-10-01', items: [{ name: '', quantity: 1, unitPrice: 1 }] }]) {
    assert.equal((await ga('snacks', 'POST', { action: 'CREATE', ...bad })).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  // 수정: 줄을 통째로 바꾸고, 결제 총액을 직접 주면 그 값을 쓴다. 낡은 updatedAt 이면 409 이고 줄도 그대로다.
  const stale = list[0].updatedAt;
  const updated = await ga('snacks', 'POST', { action: 'UPDATE', id: list[0].id, updatedAt: stale, purchasedOn: '2026-10-01', vendor: '쿠팡', totalAmount: 5000,
    items: [{ name: '감귤주스', quantity: 2, unitPrice: 2500 }] });
  assert.equal(updated.status, 200);
  const conflict = await ga('snacks', 'POST', { action: 'UPDATE', id: list[0].id, updatedAt: stale, purchasedOn: '2026-10-02', items: [{ name: '덮어쓰면 안 됨', quantity: 1, unitPrice: 1 }] });
  assert.equal(conflict.status, 409);
  list = (await ga('snacks')).body.purchases;
  assert.deepEqual([list[0].totalAmount, list[0].items.map((item) => item.name)], [5000, ['감귤주스']]);
  // 캡처(영수증): 이미지만 받고, 보기 권한자도 내려받을 수 있다.
  const png = new TextEncoder().encode('PNG-SNACK');
  const put = (name, headers = { 'content-length': String(png.byteLength) }) => ga('snacks', 'PUT', undefined, `?purchaseId=${list[0].id}&name=${encodeURIComponent(name)}`, { rawBody: png, contentType: 'image/png', headers });
  assert.equal((await put('주문내역.png')).status, 201);
  assert.equal((await put('page.svg')).status, 415);
  assert.ok([...objects.keys()].some((key) => key.startsWith(`ga/SNACK/${list[0].id}/gasr_`)));
  const receipt = (await ga('snacks')).body.purchases[0].receipts[0];
  const viewer = await as({ general: 'view' });
  const got = await viewer.call('snacks', 'GET', undefined, `?receiptId=${receipt.id}`);
  assert.deepEqual([got.status, got.headers.get('content-security-policy')], [200, "sandbox; default-src 'none'"]);
  assert.equal((await viewer.call('snacks', 'POST', { action: 'CREATE', purchasedOn: '2026-10-01', items })).status, 403);
  assert.equal((await ga('snacks', 'POST', { action: 'DELETE', id: list[0].id })).status, 200);
  assert.equal((await ga('snacks')).body.purchases.length, 0);
  assert.equal((await ga('snacks', 'GET', undefined, `?receiptId=${receipt.id}`)).status, 404, 'receipts of a deleted purchase are gone');
  const audit = (await rows(`SELECT after_json FROM erp_audit_logs WHERE action LIKE 'GA_SNACK_%'`)).map((row) => row.after_json).join('\n');
  assert.doesNotMatch(audit, /새우깡|초코파이|쿠팡|감귤/, 'no product or vendor names in the audit trail');
  const view = readFileSync(new URL('../app/general-snacks-view.tsx', import.meta.url), 'utf8');
  assert.match(view, /document\.addEventListener\("paste", onPaste\)/, 'Ctrl+V anywhere in the dialog');
  assert.match(view, /void readWithAi\(next\.map\(\(image\) => image\.file\)\);/, 'pasting starts the AI read right away');
  assert.match(readFileSync(new URL('../app/general-workspace.tsx', import.meta.url), 'utf8'), /\{ key: "snacks", label: "간식 구입" \}/);
});
