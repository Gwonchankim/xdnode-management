// quote-tool(Design §11.2, QT1): 견적 라우트를 실제 코드·SQL 로 실행한다(하니스의 메모리 SQLite + 가짜 R2).
// QA-01 권한, QA-02 스키마 멱등, QA-03 이전 멱등·대조, QA-04 템플릿, QA-05 검색, QA-06 불러오기, QA-18 배지. 데이터는 모두 합성이다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { callApi, createAccount, db, login, objects, resetDatabase, setAccess } from './helpers/hr-api-harness.mjs';

const { ensureQuoteSchema, resetQuoteSchemaGate, QUOTE_TABLES } = await import('../app/quote-schema.ts');
const { normalizeQuote, parseStoredQuote, subtotal } = await import('../app/quote-model.ts');

const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** JSON 본문에 Content-Length 를 붙여 보낸다(라우트는 길이가 없으면 411). */
function send(path, method, body, query = '', options = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return callApi(path, method, undefined, query, {
    rawBody: raw, contentType: 'application/json', ...options,
    headers: { 'content-length': String(Buffer.byteLength(raw)), ...(options.headers ?? {}) },
  });
}
const importApi = (body, options) => send('quote/import', 'POST', body, '', options);
function putTemplate(bytes, { contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', length, cookie } = {}) {
  return callApi('quote/import', 'PUT', undefined, '?part=template', {
    rawBody: bytes, contentType, ...(cookie !== undefined ? { cookie } : {}),
    headers: length === null ? {} : { 'content-length': String(length ?? bytes.byteLength) },
  });
}
async function as(tabs, extra = {}) {
  const account = await createAccount({ tabs, ...extra });
  const session = await login(account.email, account.password);
  return { ...account, cookie: session.cookie };
}

// ── 합성 템플릿(실제 템플릿과 같은 시트 이름·셀 위치, 그림·링크 없음) ─────────────────────
function syntheticTemplate({ sheetNames = ['견적', '견적 (마진계산용)'], tweak = '' } = {}) {
  const cells = ['B7', 'B8', 'B9', 'B10', 'B13', 'A14', 'A15', 'A16', 'A17', 'A18', 'H14', 'H15', 'H16', 'H17'];
  const protoRows = [21, 22, 23, 24, 25, 30, 31, 32];
  const sheet = () => {
    const byRow = new Map();
    for (const ref of cells) {
      const row = Number(ref.slice(1));
      byRow.set(row, [...(byRow.get(row) ?? []), `<c r="${ref}" s="3"/>`]);
    }
    for (const row of protoRows) byRow.set(row, 'ABCDEFGHI'.split('').map((col) => `<c r="${col}${row}" s="${row}"/>`));
    const body = [...byRow].sort((a, b) => a[0] - b[0]).map(([row, list]) => `<row r="${row}">${list.join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData>${tweak}</worksheet>`;
  };
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheetNames.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'),
  };
  sheetNames.forEach((_, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheet()); });
  return zipSync(files, { mtime: new Date('2026-10-02T00:00:00Z') });
}

// ── 합성 이전 입력 ────────────────────────────────────────────────────────
const V2 = sha('catalog_v2 synthetic');
const V1 = sha('catalog synthetic');
const VB = sha('bom synthetic');
const quoteJson = (org, extra = {}) => JSON.stringify({
  customer: { org, contact: '홍길동 님', email: 'customer@example.com' },
  staff: { name: '담당자 팀장', tel: '010-1234-5678', email: 'staff@example.com' },
  issue_date: '2026-09-17',
  lines: [{ label: 'GPU', name: 'RTX PRO 6000', qty: 2, unit_price: 1000000 }],
  margin: { rate: 0.1, buy_units: { '0': 900000 } },
  ...extra,
});
const SNAP_A = 'A'.repeat(10) + '가나다';
const SNAP_B1 = '{"part":"one",';
const SNAP_B2 = '"two":true}';
function importInput() {
  return {
    corpus_files: [
      { id: 1, file: '견적서(엑스디노드)_260101_고객기관A(G494)_홍길동 님 귀하.xlsx', quote_date: '2026-01-01', customer_from_name: '고객기관A', model_hint: 'G494', contact_from_name: '홍길동 님', suffix: null, mtime: '2026-01-01T09:00:00', quote_json: quoteJson('고객기관A'), reverse_error: null },
      { id: 2, file: 'broken.xlsx', quote_date: null, customer_from_name: null, model_hint: null, contact_from_name: null, suffix: null, mtime: '2026-01-02T09:00:00', quote_json: null, reverse_error: 'KeyError' },
    ],
    corpus_sheets: [
      { id: 10, quote_id: 1, sheet_name: '견적', is_margin: 0, customer: '고객기관A', contact: '홍길동 님', tel: '010-0000-0000', email: 'customer@example.com', valid_weeks: '1', delivery: '협의', payment: '현금', place: '지정', project: null, staff: '담당자 팀장', staff_tel: '010-1234-5678', staff_email: 'staff@example.com', has_set_col: 1, header_row: 21, subtotal: 100, vat: 10, total: 110, remark: '- 3년 무상 보증', n_items: 2 },
      { id: 11, quote_id: 1, sheet_name: '견적 (마진계산용)', is_margin: 1, customer: '고객기관A', contact: null, tel: null, email: null, valid_weeks: null, delivery: null, payment: null, place: null, project: null, staff: null, staff_tel: null, staff_email: null, has_set_col: 0, header_row: null, subtotal: null, vat: null, total: null, remark: null, n_items: 0 },
      { id: 12, quote_id: 2, sheet_name: '견적', is_margin: 0, customer: '고객기관B', contact: '김철수 연구원님', tel: null, email: null, valid_weeks: '2', delivery: null, payment: null, place: null, project: null, staff: null, staff_tel: null, staff_email: null, has_set_col: 0, header_row: 21, subtotal: 50, vat: 5, total: 55, remark: null, n_items: 1 },
    ],
    corpus_items: [
      { id: 100, sheet_id: 10, row: 22, no: 'A', is_group: 1, category: 'Server', spec: 'G494', spec_first_line: 'G494', qty: null, sets: 1, unit_price: 100, amount: 100 },
      { id: 101, sheet_id: 10, row: 23, no: '1', is_group: 0, category: 'GPU', spec: 'RTX PRO 6000\n96GB', spec_first_line: 'RTX PRO 6000', qty: 2, sets: null, unit_price: null, amount: null },
      { id: 102, sheet_id: 12, row: 22, no: 'A', is_group: 0, category: 'NAS', spec: 'DS1621+', spec_first_line: 'DS1621+', qty: 1, sets: null, unit_price: 50, amount: 50 },
    ],
    corpus_margin_items: [{ id: 1, sheet_id: 11, row: 23, category: 'GPU', spec_first_line: 'RTX PRO 6000', qty: 2, buy_unit: 40, margin_rate: 0.1, sell_unit: 44 }],
    catalog_products: [
      { ord: 0, canonical: 'RTX PRO 6000', category: 'GPU', kind: 'part', keys: ['rtx pro 6000'], spellings: ['RTX PRO 6000'], n: 3, min: 1, max: 2, last_price: 2, last_date: '2026-09-01', first_date: '2026-01-01', note: '', outliers_excluded: 0, caution: null, history: [{ date: '2026-09-01', price: 2, customer: '고객N', qty: 1 }] },
      { ord: 1, canonical: '잡음', category: null, kind: 'junk', keys: [], spellings: [], n: 1, min: null, max: null, last_price: null, last_date: null, first_date: null, note: null, outliers_excluded: 0, caution: null, history: [] },
    ],
    catalog_legacy: [
      { ord: 0, name: 'RTX PRO 6000', key: 'rtx pro 6000', category: 'GPU', n: 3, last_date: '2026-09-01', group_ratio: 0, last_price: 2, last_price_date: '2026-09-01', price_history: [] },
      { ord: 1, name: 'G494', key: 'g494', category: 'Server', n: 2, last_date: null, group_ratio: 1, last_price: null, last_price_date: null, price_history: [] },
    ],
    spec_library: [{ ord: 0, name: 'G494', spec: 'Gigabyte G494\nDual Socket', date: '2026-01-01', category: 'Chassis' }],
    customers: [
      { ord: 0, org: '고객기관A', contact: '홍길동 님', tel: '010-0000-0000', email: 'customer@example.com', last_date: '2026-01-01', n: 2 },
      { ord: 1, org: '고객기관A', contact: '이영희 님', tel: null, email: null, last_date: '2025-12-01', n: 1 },
      { ord: 2, org: '고객기관B', contact: '김철수 연구원님', tel: null, email: null, last_date: null, n: null },
    ],
    bom_library: [{ ord: 0, sheet_id: 10, file: 'x.xlsx', date: '2026-01-01', customer: '고객기관A', sheet_name: '견적', total: 110, subtotal: 100, system_label: 'Server', system_name: 'G494', gpu_name: 'RTX PRO 6000', gpu_key: 'rtx pro 6000', gpu_qty: 2, base_key: 'g494', remark: '', parts: { gpu: [{ slot: 'gpu', category: 'GPU', name: 'RTX PRO 6000', qty: 2, unit_price: null }] }, n_slots: 6, base_max_gpu: 8 }],
    vocab: [{ group_labels: ['Server'], categories: ['GPU'], remarks: ['- 3년 무상 보증'], payment: ['현금결제'], delivery: ['협의 후 결정'] }],
    issued: [{ id: 1, created_at: '2026-09-17T10:20:30', issue_date: '2026-09-17', filename: '견적서(엑스디노드)_260917_고객기관A_홍길동 님 귀하.xlsx', xlsx_path: 'C:\\old\\a.xlsx', pdf_path: null, customer: '고객기관A', contact: '홍길동 님', model_hint: null, subtotal: 2000000, total: 2200000, n_lines: 1, quote_json: quoteJson('고객기관A'), author: '담당자 팀장', author_host: null, status: 'confirmed', dedup_key: 'legacy-key-1#0123456789abcdef', suffix: null, updated_at: '2026-09-17T10:20:30' }],
    price_log: [
      { id: 1, issued_id: 1, issue_date: '2026-09-17', customer: '고객기관A', kind: 'single', category: 'GPU', name: 'RTX PRO 6000', name_key: 'rtx pro 6000', qty: 2, unit_price: 1000000, status: 'confirmed' },
      { id: 2, issued_id: 1, issue_date: '2026-09-17', customer: '고객기관A', kind: 'item', category: 'GPU', name: 'RTX PRO 6000', name_key: 'rtx pro 6000', qty: 2, unit_price: 1000000, status: 'confirmed' },
    ],
    staff: [{ name: '담당자 팀장', tel: '010-1234-5678', email: 'staff@example.com', sort: 0 }, { name: '보조 사원', tel: '', email: '', sort: 1 }],
    source_snapshots: [
      { name: 'price_points.json', version: sha(SNAP_A), part: 0, part_count: 1, body: SNAP_A },
      { name: 'pdf_quotes.json', version: sha(SNAP_B1 + SNAP_B2), part: 0, part_count: 2, body: SNAP_B1 },
      { name: 'pdf_quotes.json', version: sha(SNAP_B1 + SNAP_B2), part: 1, part_count: 2, body: SNAP_B2 },
    ],
  };
}
const SOURCE = {
  files: { 'catalog_v2.json': V2, 'catalog.json': V1, 'bom_library.json': VB },
  counts: { corpus_files: 2, corpus_sheets: 3, corpus_items: 3, corpus_margin_items: 1, issued: 1, price_log: 2, catalog_products: 2, catalog_legacy: 2,
    spec_library: 1, customers: 3, customer_orgs: 2, bom_library: 1, staff: 2 },
  snapshots: { 'price_points.json': sha(SNAP_A), 'pdf_quotes.json': sha(SNAP_B1 + SNAP_B2) },
  lastLegacyIssuedId: 1,
};
const VERSION_OF = { catalog_products: V2, catalog_legacy: V1, spec_library: V1, customers: V1, vocab: V1, bom_library: VB };
const ORDER = ['corpus_files', 'corpus_sheets', 'corpus_items', 'corpus_margin_items', 'catalog_products', 'catalog_legacy', 'spec_library', 'customers', 'bom_library', 'vocab', 'ACTIVATE', 'issued', 'price_log', 'staff', 'source_snapshots'];

/** 스크립트와 같은 순서로 한 번 이전한다. 표별 응답과 FINISH 응답을 돌려준다. */
async function runImport(input = importInput(), source = SOURCE) {
  const begin = await importApi({ action: 'BEGIN', source });
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const runId = begin.body.runId;
  const tables = {};
  for (const table of ORDER) {
    if (table === 'ACTIVATE') {
      const activated = await importApi({ action: 'ACTIVATE', runId, versions: { catalog_v2: V2, catalog: V1, bom_library: VB },
        expected: { catalog_products: 2, catalog_legacy: 2, spec_library: 1, customers: 3, customer_orgs: 2, bom_library: 1 } });
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      continue;
    }
    const result = await importApi({ action: 'ROWS', runId, table, version: VERSION_OF[table], rows: input[table] });
    assert.equal(result.status, 200, `${table}: ${JSON.stringify(result.body)}`);
    tables[table] = result.body;
  }
  const finish = await importApi({ action: 'FINISH', runId });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  return { runId, tables, finish: finish.body };
}

// ── QA-01 ────────────────────────────────────────────────────────────────
test('QA-01: none is refused on every quote route; view reads; edit cannot import; only admins import', async () => {
  const sql = await resetDatabase();
  const none = await as({ hr: 'edit' });
  for (const query of ['?view=recent', '?view=search&q=a', '?view=pending', '?issuedId=1']) {
    assert.equal((await callApi('quote/history', 'GET', undefined, query, { cookie: none.cookie })).status, 403, query);
  }
  assert.equal((await callApi('quote/overview', 'GET', undefined, '?summary=1', { cookie: none.cookie })).status, 403);
  assert.equal((await importApi({ action: 'BEGIN', source: SOURCE }, { cookie: none.cookie })).status, 403);
  assert.equal((await putTemplate(syntheticTemplate(), { cookie: none.cookie })).status, 403);

  const viewer = await as({ quote: 'view' });
  for (const query of ['?view=recent', '?view=search&q=', '?view=pending']) {
    assert.equal((await callApi('quote/history', 'GET', undefined, query, { cookie: viewer.cookie })).status, 200, query);
  }
  assert.equal((await callApi('quote/overview', 'GET', undefined, '', { cookie: viewer.cookie })).status, 200);
  const deniedBefore = sql.prepare(`SELECT COUNT(*) AS n FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' AND module = 'quote'`).get().n;
  // 본문은 인가 뒤에 읽는다: 깨진 본문이어도 403 이 먼저다.
  assert.equal((await send('quote/import', 'POST', '{not json', '', { cookie: viewer.cookie })).status, 403);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' AND module = 'quote'`).get().n, deniedBefore + 1);

  const editor = await as({ quote: 'edit' });
  assert.equal((await importApi({ action: 'BEGIN', source: SOURCE }, { cookie: editor.cookie })).status, 403);
  assert.equal((await putTemplate(syntheticTemplate(), { cookie: editor.cookie })).status, 403);
  assert.equal((await callApi('quote/history', 'GET', undefined, '?view=recent', { cookie: editor.cookie })).status, 200);

  setAccess({}, { isAdmin: true });
  const begin = await importApi({ action: 'BEGIN', source: SOURCE });
  assert.equal(begin.status, 200);
  assert.match(begin.body.runId, /^qir_[0-9a-f-]{36}$/);
  setAccess(null);
  assert.equal((await callApi('quote/history', 'GET', undefined, '?view=recent')).status, 401);
});

// ── QA-02 ────────────────────────────────────────────────────────────────
test('QA-02: ensureQuoteSchema is idempotent, creates the 15 quote_ tables and touches no other table', async () => {
  const sql = await resetDatabase();
  const others = () => sql.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'quote_%' AND name NOT LIKE 'idx_quote_%' AND name NOT LIKE 'ux_quote_%' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const before = others();
  await ensureQuoteSchema(db);
  const first = sql.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all();
  resetQuoteSchemaGate();
  await ensureQuoteSchema(db);
  await ensureQuoteSchema(db);
  assert.deepEqual(sql.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all(), first);
  const tables = sql.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'quote\\_%' ESCAPE '\\' ORDER BY name`).all().map((row) => row.name);
  assert.equal(tables.length, 15);
  assert.deepEqual(tables, [...QUOTE_TABLES].sort());
  assert.deepEqual(others(), before);
  // 불린은 CHECK 로 0/1 만 받는다.
  assert.throws(() => sql.prepare(`INSERT INTO quote_corpus_sheets (id, quote_id, is_margin, imported_at, import_run_id) VALUES (1, 1, 2, 0, 'r')`).run(), /CHECK/);
});

// ── QA-03 ────────────────────────────────────────────────────────────────
test('QA-03: BEGIN → ROWS → ACTIVATE → FINISH matches the counts; a rerun inserts nothing', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  const first = await runImport();
  assert.equal(first.finish.status, 'OK', JSON.stringify(first.finish.mismatches));
  assert.deepEqual(first.finish.snapshots, { 'price_points.json': true, 'pdf_quotes.json': true });
  for (const [table, result] of Object.entries(first.tables)) assert.equal(result.inserted, result.received, table);
  assert.equal(first.finish.counts.customer_orgs, 2);
  assert.equal(first.finish.lastLegacyIssuedId, 1);
  // 행 변환: KST 지역 시각 → epoch ms, author → staff_name·author_name, 옛 경로는 참고 열, price_log 는 legacy_id 로 다시 잇는다.
  const issued = sql.prepare(`SELECT * FROM quote_issued WHERE legacy_id = 1`).get();
  assert.equal(issued.created_at, Date.parse('2026-09-17T01:20:30Z'));
  assert.equal(issued.staff_name, '담당자 팀장');
  assert.equal(issued.author_name, '담당자 팀장');
  assert.equal(issued.author_account_id, null);
  assert.equal(issued.legacy_xlsx_path, 'C:\\old\\a.xlsx');
  assert.equal(issued.file_rev, 0);
  assert.equal(issued.dedup_key, 'legacy-key-1#0123456789abcdef');
  assert.deepEqual(sql.prepare(`SELECT DISTINCT issued_id FROM quote_price_log`).all().map((row) => row.issued_id), [issued.id]);
  assert.equal(sql.prepare(`SELECT is_margin FROM quote_corpus_sheets WHERE id = 11`).get().is_margin, 1);
  assert.equal(sql.prepare(`SELECT reverse_error FROM quote_corpus_files WHERE id = 2`).get().reverse_error, 'KeyError');
  assert.equal(sql.prepare(`SELECT value FROM quote_meta WHERE key = 'version:catalog_v2'`).get().value, V2);
  assert.deepEqual(JSON.parse(sql.prepare(`SELECT value FROM quote_meta WHERE key = ?`).get(`vocab:${V1}`).value).categories, ['GPU']);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM quote_staff_profiles WHERE legacy = 1 AND created_by = 'import' AND active = 1`).get().n, 2);
  assert.equal(sql.prepare(`SELECT n FROM quote_customers WHERE ord = 2`).get().n, null, 'nullable n stays null');

  const tableCounts = () => Object.fromEntries(QUOTE_TABLES.filter((name) => name !== 'quote_import_runs').map((name) => [name, sql.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n]));
  const countsAfterFirst = tableCounts();
  const rerun = await runImport();
  assert.equal(rerun.finish.status, 'OK');
  for (const [table, result] of Object.entries(rerun.tables)) {
    assert.equal(result.inserted, 0, `${table} rerun inserted`);
    assert.equal(result.updated, 0, `${table} rerun updated`);
  }
  assert.deepEqual(tableCounts(), countsAfterFirst, 'a rerun adds no rows anywhere');
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM quote_import_runs WHERE status = 'OK'`).get().n, 2);

  // 감사 행: 건수·id 만. 고객명·파일명·연락처가 없다(QT-FR-17).
  const audits = sql.prepare(`SELECT action, after_json FROM erp_audit_logs WHERE module = 'quote'`).all();
  assert.ok(audits.some((row) => row.action === 'QUOTE_IMPORTED') && audits.some((row) => row.action === 'QUOTE_IMPORT_FINISHED') && audits.some((row) => row.action === 'QUOTE_CATALOG_ACTIVATED'));
  for (const row of audits) for (const secret of ['고객기관', '홍길동', '010-', 'example.com', '.xlsx', '담당자 팀장']) assert.ok(!String(row.after_json).includes(secret), `${row.action} carries ${secret}`);
});

test('QA-03: old-tool status changes follow, app-modified rows are kept, dedup clashes are skipped, tampered snapshots mismatch', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  await runImport();
  // 옛 툴에서 폐기 → 다시 이전하면 발행 행과 단가 로그가 따라간다.
  const changed = importInput();
  changed.issued[0] = { ...changed.issued[0], status: 'discarded', updated_at: '2026-09-20T09:00:00' };
  changed.price_log = changed.price_log.map((row) => ({ ...row, status: 'discarded' }));
  const second = await runImport(changed);
  assert.deepEqual(second.tables.issued, { received: 1, inserted: 0, updated: 1, skipped: 0 });
  assert.deepEqual(second.tables.price_log, { received: 2, inserted: 0, updated: 2, skipped: 0 });
  assert.equal(sql.prepare(`SELECT status FROM quote_issued WHERE legacy_id = 1`).get().status, 'discarded');
  assert.deepEqual(sql.prepare(`SELECT DISTINCT status FROM quote_price_log`).all().map((row) => row.status), ['discarded']);

  // 앱에서 바꾼 행(app_modified_at)은 다시 이전해도 상태가 바뀌지 않는다(발행·단가 로그 모두).
  sql.prepare(`UPDATE quote_issued SET status = 'confirmed', app_modified_at = 1 WHERE legacy_id = 1`).run();
  sql.prepare(`UPDATE quote_price_log SET status = 'confirmed'`).run();
  const third = await runImport(changed);
  assert.deepEqual(third.tables.issued, { received: 1, inserted: 0, updated: 0, skipped: 1 });
  assert.deepEqual(third.tables.price_log, { received: 2, inserted: 0, updated: 0, skipped: 2 });
  assert.equal(sql.prepare(`SELECT status FROM quote_issued WHERE legacy_id = 1`).get().status, 'confirmed');

  // 앱 행과 dedup_key 가 겹치는 새 옛 행은 넣지 않고 legacy id 를 보고한다.
  sql.prepare(`INSERT INTO quote_issued (created_at, updated_at, issue_date, filename, quote_json, status, dedup_key) VALUES (1, 1, '2026-10-01', 'f', '{}', 'draft', 'app-key#1')`).run();
  const begin = await importApi({ action: 'BEGIN', source: { ...SOURCE, counts: {} } });
  const clash = await importApi({ action: 'ROWS', runId: begin.body.runId, table: 'issued', rows: [{ ...importInput().issued[0], id: 2, dedup_key: 'app-key#1' }] });
  assert.equal(clash.status, 200);
  assert.deepEqual(clash.body, { received: 1, inserted: 0, updated: 0, skipped: 1, skippedLegacyIds: [2] });
  // price_log 의 부모가 없으면 넣지 않는다.
  const orphan = await importApi({ action: 'ROWS', runId: begin.body.runId, table: 'price_log', rows: [{ ...importInput().price_log[0], id: 9, issued_id: 99 }] });
  assert.deepEqual(orphan.body, { received: 1, inserted: 0, updated: 0, skipped: 1 });

  // 스냅샷 조각 하나를 바꾸면 FINISH 가 MISMATCH 다.
  sql.prepare(`UPDATE quote_source_snapshots SET body = 'tampered' WHERE name = 'pdf_quotes.json' AND part = 1`).run();
  const fourth = await runImport();
  assert.equal(fourth.finish.status, 'MISMATCH');
  assert.deepEqual(fourth.finish.snapshots, { 'price_points.json': true, 'pdf_quotes.json': false });
  assert.equal(sql.prepare(`SELECT status FROM quote_import_runs WHERE id = ?`).get(fourth.runId).status, 'MISMATCH');
});

test('QA-03: import validation — sizes, unknown tables, bad rows, ACTIVATE count mismatch, finished runs', async () => {
  await resetDatabase();
  setAccess({}, { isAdmin: true });
  const begin = await importApi({ action: 'BEGIN', source: SOURCE });
  const runId = begin.body.runId;
  assert.equal((await importApi({ action: 'BEGIN', source: { counts: { nope: 1 } } })).body.code, 'VALIDATION');
  assert.equal((await importApi({ action: 'ROWS', runId, table: 'auth_accounts', rows: [] })).status, 400);
  assert.equal((await importApi({ action: 'ROWS', runId, table: 'corpus_items', rows: Array.from({ length: 501 }, (_, id) => ({ id, sheet_id: 1 })) })).status, 400);
  assert.equal((await importApi({ action: 'ROWS', runId, table: 'catalog_products', rows: [] })).status, 400, 'versioned table without version');
  const bad = await importApi({ action: 'ROWS', runId, table: 'corpus_files', rows: [{ id: 'x', file: 'a' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^1번째 행/);
  assert.equal((await importApi({ action: 'ROWS', runId, table: 'catalog_products', version: V2, rows: [{ ord: 0, canonical: 'x', kind: 'weird' }] })).status, 400);
  // 길이 없음 411, 2MB 초과 선언 413(본문을 읽기 전).
  const raw = JSON.stringify({ action: 'FINISH', runId });
  assert.equal((await callApi('quote/import', 'POST', undefined, '', { rawBody: raw, contentType: 'application/json' })).status, 411);
  assert.equal((await send('quote/import', 'POST', raw, '', { headers: { 'content-length': String(3 * 1024 * 1024) } })).status, 413);
  // ACTIVATE: 그 버전 행 수가 기대와 다르면 409, 현재 버전은 바뀌지 않는다.
  const conflict = await importApi({ action: 'ACTIVATE', runId, versions: { catalog_v2: V2 }, expected: { catalog_products: 268 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFLICT');
  assert.equal((await rows(`SELECT value FROM quote_meta WHERE key = 'version:catalog_v2'`)).length, 0);
  // FINISH 뒤에는 같은 실행으로 ROWS 를 받지 않는다.
  assert.equal((await importApi({ action: 'FINISH', runId })).body.status, 'MISMATCH');
  assert.equal((await importApi({ action: 'ROWS', runId, table: 'staff', rows: [] })).status, 409);
  assert.equal((await importApi({ action: 'FINISH', runId })).status, 409);
});

// ── QA-04 ────────────────────────────────────────────────────────────────
test('QA-04: template PUT — not a zip 415, wrong sheets 400, valid v1, same sha unchanged, R2 tamper detected, new sha v2', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  assert.equal((await putTemplate(new TextEncoder().encode('not a zip at all'))).status, 415);
  assert.equal((await putTemplate(syntheticTemplate(), { contentType: 'text/html' })).status, 415);
  assert.equal((await putTemplate(syntheticTemplate(), { length: null })).status, 411);
  assert.equal((await putTemplate(syntheticTemplate(), { length: 6 * 1024 * 1024 })).status, 413);
  const wrong = await putTemplate(syntheticTemplate({ sheetNames: ['견적', 'Sheet2'] }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'TEMPLATE_INVALID');
  assert.equal(objects.size, 0);

  const template = syntheticTemplate();
  const first = await putTemplate(template);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { key: 'quote/template/v1.xlsx', sha256: createHash('sha256').update(template).digest('hex'), bytes: template.byteLength, unchanged: false });
  assert.equal(sql.prepare(`SELECT value FROM quote_meta WHERE key = 'template:sha256'`).get().value, first.body.sha256);
  assert.equal(sql.prepare(`SELECT value FROM quote_meta WHERE key = 'template:bytes'`).get().value, String(template.byteLength));
  assert.ok(objects.has('quote/template/v1.xlsx'));
  assert.equal((await callApi('quote/overview')).body.template.ready, true);

  const again = await putTemplate(template);
  assert.equal(again.body.unchanged, true);
  assert.equal(again.body.key, 'quote/template/v1.xlsx');
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM erp_audit_logs WHERE action = 'QUOTE_TEMPLATE_UPLOADED'`).get().n, 1);

  // R2 본문이 바뀌면(해시 불일치) 템플릿을 쓰지 않는다(QT2 GENERATE 의 503 TEMPLATE_INVALID 와 같은 판정 loadTemplateFromR2).
  const stored = objects.get('quote/template/v1.xlsx');
  objects.set('quote/template/v1.xlsx', { ...stored, value: syntheticTemplate({ tweak: '<!-- changed -->' }).buffer });
  assert.deepEqual((await callApi('quote/overview')).body.template, { ready: false, code: 'TEMPLATE_INVALID' });
  objects.delete('quote/template/v1.xlsx');
  assert.deepEqual((await callApi('quote/overview')).body.template, { ready: false, code: 'TEMPLATE_MISSING' });

  const changed = syntheticTemplate({ tweak: '<!-- v2 -->' });
  const second = await putTemplate(changed);
  assert.equal(second.body.key, 'quote/template/v2.xlsx');
  assert.equal(second.body.unchanged, false);
  assert.equal((await callApi('quote/overview')).body.template.ready, true);
  const audit = sql.prepare(`SELECT after_json FROM erp_audit_logs WHERE action = 'QUOTE_TEMPLATE_UPLOADED' ORDER BY created_at DESC LIMIT 1`).get();
  assert.deepEqual(Object.keys(JSON.parse(audit.after_json)).sort(), ['bytes', 'key', 'sha256']);
});

// ── QA-05 ────────────────────────────────────────────────────────────────
async function seedSearch(sql) {
  await ensureQuoteSchema(db);
  const file = sql.prepare(`INSERT INTO quote_corpus_files (id, file, quote_date, model_hint, quote_json, imported_at, import_run_id) VALUES (?, ?, ?, ?, ?, 0, 'r')`);
  const sheet = sql.prepare(`INSERT INTO quote_corpus_sheets (id, quote_id, sheet_name, is_margin, customer, contact, total, n_items, imported_at, import_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'r')`);
  const item = sql.prepare(`INSERT INTO quote_corpus_items (id, sheet_id, spec_first_line, imported_at, import_run_id) VALUES (?, ?, ?, 0, 'r')`);
  const issued = sql.prepare(`INSERT INTO quote_issued (created_at, updated_at, issue_date, filename, customer, contact, model_hint, total, n_lines, quote_json, staff_name, author_name, status, dedup_key)
    VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
  // 순위 1: 고객명·모델힌트 / 2: 담당자·파일명·작성자 / 3: 사양
  file.run(1, 'f1.xlsx', '2025-03-01', null, quoteJson('알파연구소'));
  sheet.run(10, 1, '견적', 0, '알파연구소', '김 님', 110, 2);
  file.run(2, 'f2.xlsx', '2026-02-01', null, null);
  sheet.run(20, 2, '견적', 0, '베타대학', '알파 담당 님', 220, 1);
  file.run(3, 'f3.xlsx', '2026-05-01', null, null);
  sheet.run(30, 3, '견적', 0, '감마기관', '박 님', 330, 1);
  item.run(300, 30, 'GPU 알파 카드');
  file.run(4, 'f4.xlsx', '2026-06-01', null, null);
  sheet.run(40, 4, '견적', 0, '델타', '최 님', 440, 1);
  // 여러 시트: 담당자 일치 시트(id 작음)보다 고객명 일치 시트(순위 1)를 고른다. 마진 시트는 빼고 센다.
  file.run(5, 'f5.xlsx', '2024-01-01', null, null);
  sheet.run(50, 5, '견적 2EA', 0, '엡실론', '알파 연락 님', 550, 1);
  sheet.run(51, 5, '견적 4EA', 0, '알파엡실론', '이 님', 551, 1);
  sheet.run(52, 5, '견적 (마진계산용)', 1, '알파마진', '', 0, 0);
  // 와일드카드 글자
  file.run(6, 'f6.xlsx', '2023-01-01', null, null);
  sheet.run(60, 6, '견적', 0, '퍼센트_기관', '100% 담당', 660, 1);
  issued.run('2026-09-17', 'issued-alpha.xlsx', '알파대학교', '정 님', null, 1100, quoteJson('알파대학교'), '담당자 팀장', '담당자 팀장', 'draft', 'k1');
  issued.run('2026-08-01', 'issued-b.xlsx', '오메가', '한 님', null, 1200, quoteJson('오메가'), '알파 팀장', '알파 팀장', null, 'k2');
}

test('QA-05: search ranks 1 → 2 → 3 with date order inside, pages with total, treats % and _ as text', async () => {
  const sql = await resetDatabase();
  setAccess({ quote: 'view' });
  await seedSearch(sql);
  const search = async (q, extra = '') => callApi('quote/history', 'GET', undefined, `?view=search&q=${encodeURIComponent(q)}${extra}`);
  const result = await search('알파');
  assert.equal(result.status, 200);
  const keys = result.body.rows.map((row) => `${row.source}:${row.id}`);
  // rk1: issued 알파대학교(2026-09-17), file 1(2025-03-01), file 5(2024-01-01) / rk2: issued 오메가(작성자 일치, 2026-08-01), file 2(2026-02-01) / rk3: file 3
  assert.deepEqual(keys, ['issued:1', 'file:1', 'file:5', 'issued:2', 'file:2', 'file:3']);
  assert.equal(result.body.total, 6);
  const multi = result.body.rows.find((row) => row.source === 'file' && row.id === 5);
  assert.equal(multi.customer, '알파엡실론');
  assert.equal(multi.sheet_name, '견적 4EA');
  assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ['contact', 'customer', 'file', 'id', 'model_hint', 'n_items', 'quote_date', 'sheet_name', 'source', 'status', 'total']);
  assert.equal(result.body.rows[0].status, 'draft');
  assert.equal(result.body.rows.find((row) => row.source === 'issued' && row.id === 2).status, 'confirmed', 'NULL status reads as confirmed');

  const page = await search('알파', '&limit=2&offset=2');
  assert.deepEqual(page.body.rows.map((row) => `${row.source}:${row.id}`), ['file:5', 'issued:2']);
  assert.deepEqual([page.body.total, page.body.limit, page.body.offset], [6, 2, 2]);

  const all = await search('');
  assert.equal(all.body.total, 8, '2 issued + 6 corpus files (margin sheets excluded, one row per file)');

  const percent = await search('%');
  assert.deepEqual(percent.body.rows.map((row) => `${row.source}:${row.id}`), ['file:6']);
  const underscore = await search('_');
  assert.deepEqual(underscore.body.rows.map((row) => `${row.source}:${row.id}`), ['file:6']);
  assert.equal((await search('없는 단어')).body.total, 0);

  assert.equal((await search('가'.repeat(101))).status, 400);
  assert.equal((await search('a', '&limit=101')).status, 400);
  assert.equal((await callApi('quote/history', 'GET', undefined, '?view=nope')).status, 400);

  const recent = await callApi('quote/history', 'GET', undefined, '?view=recent');
  assert.deepEqual(recent.body.rows.map((row) => row.id), [2, 1]);
  assert.deepEqual(recent.body.rows[1].files, { xlsx: false, pdf: false });
  const pending = await callApi('quote/history', 'GET', undefined, '?view=pending');
  assert.equal(pending.body.count, 1);
  assert.deepEqual(pending.body.rows.map((row) => row.id), [1]);
});

// ── QA-06 ────────────────────────────────────────────────────────────────
test('QA-06: load by issuedId / corpusId, 404 for an unreadable past file, no file= path input, view loses margin', async () => {
  const sql = await resetDatabase();
  setAccess({ quote: 'edit' });
  await seedSearch(sql);
  const issued = await callApi('quote/history', 'GET', undefined, '?issuedId=1');
  assert.equal(issued.status, 200);
  assert.equal(issued.body.quote.issue_date, null);
  assert.equal(issued.body.source_date, '2026-09-17');
  assert.deepEqual(issued.body.source, { kind: 'issued', id: 1, status: 'draft', rev: 0, files: { xlsx: false, pdf: false } });
  assert.equal(issued.body.quote.customer.org, '알파대학교');
  assert.deepEqual(issued.body.quote.margin.buy_units, { 0: 900000 });
  assert.deepEqual(issued.body.suggestions, {});
  assert.deepEqual(issued.body.customer_matches, []);

  const file = await callApi('quote/history', 'GET', undefined, '?corpusId=1');
  assert.equal(file.status, 200);
  assert.equal(file.body.source.kind, 'file');
  assert.equal(file.body.source_date, '2026-09-17', 'reverse.py issue_date wins over the file-name date');
  assert.equal(file.body.quote.lines[0].qty, 2);
  assert.equal(subtotal(file.body.quote), 2_000_000);

  const unreadable = await callApi('quote/history', 'GET', undefined, '?corpusId=2');
  assert.equal(unreadable.status, 404);
  assert.equal(unreadable.body.error, '이 과거 파일은 불러올 수 없습니다.');
  assert.equal((await callApi('quote/history', 'GET', undefined, '?issuedId=999')).status, 404);
  assert.equal((await callApi('quote/history', 'GET', undefined, '?issuedId=abc')).status, 400);
  // 옛 ?file= 는 받지 않는다: 경로를 쓰지 않고 기본 보기(최근)로 답한다.
  const path = await callApi('quote/history', 'GET', undefined, `?file=${encodeURIComponent('..\\..\\secret.xlsx')}`);
  assert.equal(path.status, 200);
  assert.ok(Array.isArray(path.body.rows) && !('quote' in path.body));

  setAccess({ quote: 'view' });
  const viewed = await callApi('quote/history', 'GET', undefined, '?issuedId=1');
  assert.equal(viewed.body.quote.margin, null);
  assert.equal(JSON.stringify(viewed.body).includes('900000'), false);
  assert.equal((await callApi('quote/history', 'GET', undefined, '?corpusId=1')).body.quote.margin, null);
});

// ── QA-18 ────────────────────────────────────────────────────────────────
test('QA-18: overview summary counts draft quotes only; the full overview reports helpers off and the catalog', async () => {
  const sql = await resetDatabase();
  setAccess({ quote: 'view' });
  await ensureQuoteSchema(db);
  const insert = sql.prepare(`INSERT INTO quote_issued (created_at, updated_at, issue_date, filename, quote_json, status) VALUES (1, 1, '2026-10-01', 'f', '{}', ?)`);
  for (const status of ['draft', 'draft', 'confirmed', null, 'discarded']) insert.run(status);
  const summary = await callApi('quote/overview', 'GET', undefined, '?summary=1');
  assert.deepEqual(summary.body, { pending: 2 });
  const full = await callApi('quote/overview');
  assert.equal(full.body.pending, 2);
  assert.deepEqual(full.body.helpers, { ai: false, pdf: false }, 'the harness points both helpers at a closed port');
  assert.deepEqual(full.body.template, { ready: false, code: 'TEMPLATE_MISSING' });
  assert.equal(full.body.catalog.products, 0);
  assert.equal(full.body.lastImport, null);

  setAccess({}, { isAdmin: true });
  await runImport();
  const after = await callApi('quote/overview');
  assert.deepEqual([after.body.catalog.products, after.body.catalog.legacyProducts, after.body.catalog.bom, after.body.catalog.customers], [1, 2, 1, 2], 'junk products are not counted');
  assert.equal(after.body.lastImport.status, 'OK');
});

// ── 모델(QT1 은 로더·검증만) ───────────────────────────────────────────────
test('quote-model: the stored-JSON loader fills pydantic defaults; the strict validator enforces the §4.7 caps', () => {
  const loaded = parseStoredQuote(JSON.stringify({ customer: { org: '고객기관A' }, lines: [{ label: 'Server', items: [{ category: 'GPU', spec: 'x\r\ny' }] }] }));
  assert.equal(loaded.terms.valid_weeks, 1);
  assert.equal(loaded.terms.delivery, '협의 후 결정');
  assert.equal(loaded.lines[0].items[0].qty, 1, 'a missing qty is pydantic default 1');
  assert.equal(loaded.lines[0].items[0].spec, 'x\ny');
  assert.deepEqual(loaded.remarks, ['- 3년 무상 보증']);
  assert.equal(loaded.sheet_name, '견적');
  assert.equal(parseStoredQuote('not json'), null);
  assert.equal(parseStoredQuote(null), null);

  const line = { label: 'GPU', name: 'x', qty: 1, unit_price: 1 };
  assert.equal(normalizeQuote({ lines: [] }).ok, false);
  assert.equal(normalizeQuote({ lines: Array.from({ length: 27 }, () => line) }).field, 'lines');
  assert.equal(normalizeQuote({ lines: [line], sheet_name: '가'.repeat(24) }).field, 'sheet_name');
  assert.equal(normalizeQuote({ lines: [line], sheet_name: '견적[1]' }).field, 'sheet_name');
  assert.equal(normalizeQuote({ lines: [{ ...line, unit_price: Number.NaN }] }).ok, false);
  assert.equal(normalizeQuote({ lines: [line], terms: { valid_weeks: 1.5 } }).field, 'terms.valid_weeks');
  const ok = normalizeQuote({ lines: [{ ...line, name: 'a\u0001b' }], issue_date: '2026-10-02' });
  assert.equal(ok.ok, true);
  assert.equal(ok.quote.lines[0].name, 'ab');
  assert.equal(normalizeQuote({ lines: [line], issue_date: '2026-02-30' }).field, 'issue_date');
});
