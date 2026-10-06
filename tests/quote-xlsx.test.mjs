// quote-tool(Design §11.3, QT2): 견적 xlsx 조립(순수 모듈). 템플릿은 tests/fixtures/quote/template-redacted.xlsx(그림 1×1·링크·작성자 제거, 시트·스타일 XML 동일).
// 회귀 5건은 옛 툴 tools/export_xdm_fixtures.py 가 만든 픽스처다: 익명화 Quote → 파이썬 save_quote → Excel COM 계산값(A1:I45, 마진 시트 K~P)
// + openpyxl 로 읽은 수식·병합·행 높이·인쇄영역. TS 출력의 계산값(<v>)과 테스트 쪽 평가기 재계산이 픽스처와 같아야 한다(QT-SC-01 ①).
import './helpers/tsx-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const { buildQuoteXlsx, loadTemplate, stripMarginSheet, PATCH_CELLS, DOC_AUTHOR } = await import('../app/quote-xlsx.ts');
const { normalizeQuote, coerceQuote, subtotal, isGroup } = await import('../app/quote-model.ts');
const { quoteFilename, autoModelHint } = await import('../app/quote-filename.ts');
const { evaluateFormula } = await import('../app/quote-formula.ts');
const { readCell, splitSheet, rowNumber, findCell, attr, openTag, unescapeXml, parseRef, cellRef } = await import('../app/quote-xml.ts');
const { contentHash, contentHashMaterial, dedupKey, priceLogRows } = await import('../app/quote-dedup.ts');
const { pyRoundInt } = await import('../app/quote-pyfmt.ts');

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(root, 'tests', 'fixtures', 'quote');
const CASES = ['server_group_span', 'parts_priced_items', 'mixed_gpu_nas', 'no_set_col_dgx', 'server_with_notes'];
const NOW = Date.UTC(2026, 9, 6, 1, 2, 3);
const readJson = (...parts) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
const templateBytes = new Uint8Array(readFileSync(path.join(FIXTURES, 'template-redacted.xlsx')));
const template = await loadTemplate(templateBytes);
const templateFiles = unzipSync(templateBytes);

function caseQuote(name) {
  const result = normalizeQuote(readJson('regression', `${name}.quote.json`));
  assert.equal(result.ok, true, `${name}: ${result.error}`);
  return result.quote;
}
function build(quote, { now = NOW, withMargin = true } = {}) {
  return buildQuoteXlsx({ template, quote, issueDate: quote.issue_date ?? '2026-10-06', withMargin, now });
}

/** 테스트 쪽 통합 문서 읽기: 시트 이름·경로, 셀(값·수식·스타일), 행 높이, 병합, 정의된 이름. */
function readWorkbook(bytes) {
  const files = unzipSync(bytes);
  const text = (name) => strFromU8(files[name]);
  const workbook = text('xl/workbook.xml');
  const rels = new Map([...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [attr(tag, 'Id'), attr(tag, 'Target').replace(/^\/+/, '')]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => {
    const target = rels.get(attr(tag, 'r:id'));
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const xml = text(sheetPath);
    const parts = splitSheet(xml);
    const cells = new Map();
    const heights = new Map();
    for (const row of parts.rows) {
      const r = rowNumber(row);
      const ht = attr(openTag(row), 'ht');
      if (ht !== null) heights.set(r, Number(ht));
      for (const [cell] of row.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) cells.set(attr(openTag(cell), 'r'), readCell(cell));
    }
    const merges = [...parts.tail.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => match[1]);
    return { name: attr(tag, 'name'), path: sheetPath, xml, parts, cells, heights, merges };
  });
  const definedNames = [...workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)].map((match) => ({ attrs: match[1], localSheetId: attr(`<x${match[1]}>`, 'localSheetId'), text: unescapeXml(match[2]) }));
  return { files, text, workbook, sheets, definedNames };
}

const valueOf = (cell) => (cell ? cell.value : null);
const norm = (value) => (value === null || value === undefined || value === '' ? null : typeof value === 'string' ? value.replace(/\r/g, '') : value);
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.5 : a === b);
const COLS = 'ABCDEFGHI';

function diffGrid(sheet, expected, skip) {
  const diffs = [];
  for (let i = 0; i < 45; i += 1) {
    for (let j = 0; j < 9; j += 1) {
      const ref = `${COLS[j]}${i + 1}`;
      if (skip.has(ref)) continue;
      const got = norm(valueOf(sheet.cells.get(ref)));
      const want = norm(expected[i][j]);
      if (!same(got, want)) diffs.push(`${ref}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  return diffs;
}

/** 테스트 쪽 재계산: 수식 셀은 app/quote-formula.ts 로 다시 계산(참조하는 수식 셀도 재귀로). */
function recompute(sheet) {
  const memo = new Map();
  const lookup = (ref) => {
    const cell = sheet.cells.get(ref);
    if (!cell) return null;
    if (cell.formula === null) return cell.value;
    if (!memo.has(ref)) memo.set(ref, evaluateFormula(cell.formula, lookup));
    return memo.get(ref);
  };
  return lookup;
}

// ── QX-01·02 ─────────────────────────────────────────────────────────────
test('QX-01/02: the five regression quotes match the Python fixture computed values with zero differences', () => {
  const report = {};
  for (const name of CASES) {
    const expected = readJson('regression', `${name}.expected.json`);
    const book = readWorkbook(build(caseQuote(name)).bytes);
    const sheet = book.sheets[0];
    assert.equal(sheet.name, expected.sheet, `${name}: sheet name`);
    const skip = new Set(['H14', ...expected.quote.shadow]);
    const diffs = diffGrid(sheet, expected.values, skip);
    report[name] = diffs.length;
    assert.deepEqual(diffs, [], `${name}: ${diffs.length} differences vs the Python fixture`);
    // QX-02: 수식 셀마다 테스트 쪽 재계산 = <v> 계산값 = 픽스처 값.
    const lookup = recompute(sheet);
    let formulas = 0;
    for (const [ref, cell] of sheet.cells) {
      if (cell.formula === null) continue;
      formulas += 1;
      const again = lookup(ref);
      assert.equal(again, cell.value, `${name} ${ref}: re-evaluated ${again} vs <v> ${cell.value}`);
      const { col, row } = parseRef(ref);
      if (row <= 45 && col <= 9 && !skip.has(ref)) assert.ok(same(again, norm(expected.values[row - 1][col - 1])), `${name} ${ref}: fixture`);
    }
    assert.ok(formulas >= 5, `${name}: formula cells`);
  }
  assert.deepEqual(Object.values(report), [0, 0, 0, 0, 0]);
});

// ── QX-03 ────────────────────────────────────────────────────────────────
test('QX-03: merges, sheet names, print areas, B13, formula text and row heights match the fixture', () => {
  for (const name of CASES) {
    const expected = readJson('regression', `${name}.expected.json`);
    const book = readWorkbook(build(caseQuote(name)).bytes);
    const [quoteSheet, marginSheet] = book.sheets;
    assert.deepEqual(book.sheets.map((sheet) => sheet.name), expected.sheetNames, `${name}: sheet names`);
    assert.deepEqual([...quoteSheet.merges].sort(), [...expected.quote.merges].sort(), `${name}: quote merges`);
    assert.deepEqual([...marginSheet.merges].sort(), [...expected.margin.merges].sort(), `${name}: margin merges`);
    const areas = book.definedNames.filter((entry) => entry.attrs.includes('_xlnm.Print_Area'));
    assert.equal(areas.find((entry) => entry.localSheetId === '0').text, expected.quote.printArea, `${name}: print area`);
    assert.equal(areas.find((entry) => entry.localSheetId === '1').text, expected.margin.printArea, `${name}: margin print area`);
    assert.equal(`=${quoteSheet.cells.get('B13').formula}`, expected.quote.b13, `${name}: B13`);
    const formulas = Object.fromEntries([...quoteSheet.cells].filter(([ref, cell]) => cell.formula !== null && parseRef(ref).row <= 45 && parseRef(ref).col <= 9).map(([ref, cell]) => [ref, `=${cell.formula}`]));
    assert.deepEqual(formulas, expected.quote.formulas, `${name}: formula text`);
    for (const [row, height] of Object.entries(expected.quote.rowHeights)) {
      const got = quoteSheet.heights.get(Number(row));
      assert.ok(got !== undefined && Math.abs(got - height) <= 0.5, `${name}: row ${row} height ${got} vs ${height}`);
    }
    assert.equal(Math.max(...[...quoteSheet.cells.keys()].map((ref) => parseRef(ref).row)), expected.quote.maxRow, `${name}: last row`);
    assert.match(quoteSheet.xml, new RegExp(`<dimension ref="A1:I${expected.quote.maxRow}"/>`));
    assert.match(quoteSheet.xml, /<pageSetUpPr fitToPage="1"\/>/);
    assert.match(quoteSheet.xml, /<pageSetup\b[^>]*fitToWidth="1"[^>]*fitToHeight="1"/);
  }
});

// ── QX-04 ────────────────────────────────────────────────────────────────
test('QX-04: the margin sheet K~P values (detail rows, totals, 총매입, 총마진) and formulas match the fixture', () => {
  for (const name of CASES) {
    const expected = readJson('regression', `${name}.expected.json`);
    const quote = caseQuote(name);
    const book = readWorkbook(build(quote).bytes);
    const margin = book.sheets[1];
    const got = {};
    for (const [ref, cell] of margin.cells) {
      if (/^[K-P]\d+$/.test(ref) && norm(cell.value) !== null) got[ref] = norm(cell.value);
    }
    assert.deepEqual(Object.keys(got).sort(), Object.keys(expected.marginValues).sort(), `${name}: margin cells`);
    for (const [ref, want] of Object.entries(expected.marginValues)) assert.ok(same(got[ref], want), `${name} ${ref}: ${got[ref]} vs ${want}`);
    const formulas = Object.fromEntries([...margin.cells].filter(([, cell]) => cell.formula !== null).map(([ref, cell]) => [ref, `=${cell.formula}`]));
    assert.deepEqual(formulas, expected.margin.formulas, `${name}: margin formulas`);
    if (quote.lines.some(isGroup)) assert.ok(Object.keys(got).some((ref) => ref.startsWith('L') && typeof got[ref] === 'number' && got[ref] > 0), `${name}: buy units present`);
  }
});

// ── QX-05 ────────────────────────────────────────────────────────────────
function maskPatchCells(rowXml) {
  let out = rowXml;
  for (const ref of PATCH_CELLS) {
    const found = findCell(out, ref);
    if (found) out = `${out.slice(0, found.start)}<PATCH ${ref}/>${out.slice(found.end)}`;
  }
  return out;
}
test('QX-05: rows 1~20 are byte-identical apart from the patched cells; media, drawings and theme bytes are untouched', () => {
  const book = readWorkbook(build(caseQuote('server_group_span')).bytes);
  for (const [index, sheet] of book.sheets.entries()) {
    const source = splitSheet(strFromU8(templateFiles[`xl/worksheets/sheet${index + 1}.xml`]));
    const before = source.rows.filter((row) => rowNumber(row) < 21).map(maskPatchCells);
    const after = sheet.parts.rows.filter((row) => rowNumber(row) < 21).map(maskPatchCells);
    assert.deepEqual(after, before, `${sheet.name}: rows 1~20`);
    for (const ref of PATCH_CELLS) {
      const sourceStyle = attr(openTag(findCell(source.rows.join(''), ref).text), 's');
      assert.equal(sheet.cells.get(ref).style, Number(sourceStyle), `${ref} keeps its style`);
    }
  }
  for (const name of Object.keys(templateFiles).filter((entry) => /^xl\/(media|drawings|theme)\//.test(entry) || entry === 'docProps/app.xml' || entry === '_rels/.rels')) {
    assert.deepEqual(book.files[name], templateFiles[name], `${name} unchanged`);
  }
  for (const drawing of ['xl/drawings/drawing1.xml', 'xl/drawings/drawing2.xml']) {
    assert.equal((book.text(drawing).match(/<(?:xdr:)?(?:one|two)CellAnchor\b/g) ?? []).length, 2, `${drawing}: logo and stamp anchors`);
  }
  // 헤더 값: 작성일 일련번호, 담당자 블록, 조건 문구.
  const sheet = book.sheets[0];
  assert.equal(sheet.cells.get('H14').value, 46282, '2026-09-17 → Excel serial');
  assert.equal(sheet.cells.get('A14').value, '견적유효기간 : 견적 후 1주 이내 (직인생략)');
  assert.equal(sheet.cells.get('H15').value, '담당자 팀장');
});

// ── QX-06 ────────────────────────────────────────────────────────────────
test('QX-06: B10/H17 hyperlinks follow the quote e-mails or disappear; H11 stays; the document author is XDnode management', () => {
  const quote = caseQuote('mixed_gpu_nas');
  const withMail = readWorkbook(build({ ...quote, customer: { ...quote.customer, email: 'buyer+1@example.org' }, staff: { ...quote.staff, email: 'sales@example.net' } }).bytes);
  for (const index of [1, 2]) {
    const rels = withMail.text(`xl/worksheets/_rels/sheet${index}.xml.rels`);
    assert.match(rels, /Id="rId1"/);
    assert.ok(rels.includes('Target="mailto:buyer+1@example.org"'), 'B10 → customer mail');
    assert.ok(rels.includes('Target="mailto:sales@example.net"'), 'H17 → staff mail');
    assert.ok(rels.includes('http://www.xdnode.co.kr/'), 'H11 homepage link kept');
    assert.doesNotMatch(rels, /customer@example\.com|staff@example\.com/);
  }
  const noMail = readWorkbook(build({ ...quote, customer: { ...quote.customer, email: null }, staff: { ...quote.staff, email: '' } }).bytes);
  for (const [index, sheet] of noMail.sheets.entries()) {
    const rels = noMail.text(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`);
    assert.doesNotMatch(rels, /mailto:/);
    assert.doesNotMatch(rels, /Id="rId1"|Id="rId3"/);
    assert.match(rels, /Id="rId2"/);
    assert.match(sheet.parts.tail, /<hyperlink\b[^>]*ref="H11"/);
    assert.doesNotMatch(sheet.parts.tail, /ref="B10"|ref="H17"/);
    assert.equal(sheet.cells.get('B10').value, null);
  }
  const core = withMail.text('docProps/core.xml');
  assert.match(core, new RegExp(`<dc:creator[^>]*>${DOC_AUTHOR}</dc:creator>`));
  assert.match(core, new RegExp(`<cp:lastModifiedBy>${DOC_AUTHOR}</cp:lastModifiedBy>`));
  assert.match(core, /<dcterms:modified[^>]*>2026-10-06T01:02:03Z<\/dcterms:modified>/);
});

// ── QX-07 ────────────────────────────────────────────────────────────────
test('QX-07: stripMarginSheet leaves one sheet, one print area, no margin drawing/images and no 매입 text', () => {
  const full = build(caseQuote('server_group_span')).bytes;
  const stripped = readWorkbook(stripMarginSheet(full));
  assert.equal(stripped.sheets.length, 1);
  assert.equal(stripped.definedNames.length, 1);
  assert.equal(stripped.definedNames[0].localSheetId, '0');
  for (const gone of ['xl/worksheets/sheet2.xml', 'xl/worksheets/_rels/sheet2.xml.rels', 'xl/drawings/drawing2.xml', 'xl/drawings/_rels/drawing2.xml.rels', 'xl/media/image3.png', 'xl/media/image4.png']) {
    assert.equal(stripped.files[gone], undefined, `${gone} removed`);
  }
  for (const kept of ['xl/drawings/drawing1.xml', 'xl/media/image1.png', 'xl/media/image2.png']) assert.ok(stripped.files[kept], `${kept} kept`);
  const types = stripped.text('[Content_Types].xml');
  for (const [, part] of types.matchAll(/PartName="\/([^"]+)"/g)) assert.ok(stripped.files[part], `Content_Types override ${part} exists`);
  for (const name of Object.keys(stripped.files).filter((entry) => /^xl\/(worksheets|drawings)\/[^/]+\.xml$/.test(entry))) assert.ok(types.includes(`/${name}"`), `${name} has an override`);
  assert.doesNotMatch(stripped.text('xl/_rels/workbook.xml.rels'), /sheet2\.xml/);
  for (const name of Object.keys(stripped.files).filter((entry) => entry.endsWith('.xml'))) assert.equal(stripped.text(name).includes('매입'), false, `${name}: 매입`);
  assert.equal(stripMarginSheet(stripMarginSheet(full)).byteLength > 0, true);
  // 같은 입력이면 같은 출력(시각은 원본 zip 머리에서 읽는다).
  assert.deepEqual(stripMarginSheet(full), stripMarginSheet(full));
  // withMargin:false 는 같은 변형이다.
  assert.equal(readWorkbook(build(caseQuote('server_group_span'), { withMargin: false }).bytes).sheets.length, 1);
});

// ── QX-08 ────────────────────────────────────────────────────────────────
/** 파이썬 Quote 기본값을 채운 객체(정규화 없이 파일명 함수만 본다: 탭·VT 같은 문자도 그대로). */
function pyQuote(raw) {
  return {
    customer: { org: raw.customer?.org ?? '', contact: raw.customer?.contact ?? '', tel: null, email: null },
    issue_date: raw.issue_date ?? null, model_hint: raw.model_hint === undefined ? null : raw.model_hint,
    lines: raw.lines.map((line) => ({ label: line.label, name: line.name ?? '', items: (line.items ?? []).map((item) => ({ category: item.category, spec: item.spec ?? '' })) })),
  };
}
test('QX-08: file names equal the Python quote_filename for the five cases and the Unicode boundary examples', () => {
  for (const name of CASES) {
    const expected = readJson('regression', `${name}.expected.json`);
    assert.equal(quoteFilename(caseQuote(name)), expected.filename, name);
  }
  const examples = readJson('filename.json');
  assert.ok(examples.length >= 16);
  for (const example of examples) {
    const quote = pyQuote(example.quote);
    assert.equal(autoModelHint(quote), example.hint, `${example.name}: hint`);
    assert.equal(quoteFilename(quote, example.suffix), example.filename, `${example.name}/${example.suffix}`);
  }
});

// ── QX-09 ────────────────────────────────────────────────────────────────
test('QX-09: the same input and the same now give the same bytes', () => {
  const quote = caseQuote('server_with_notes');
  assert.deepEqual(build(quote).bytes, build(quote).bytes);
  assert.notDeepEqual(build(quote).bytes, build(quote, { now: NOW + 86_400_000 }).bytes);
});

// ── QX-10 ────────────────────────────────────────────────────────────────
test('QX-10: validation rejects 0 and 27 lines, a 24-character or bracketed sheet name, and strips control characters', () => {
  const line = { label: 'GPU', name: 'x', qty: 1, unit_price: 1 };
  assert.equal(normalizeQuote({ lines: [] }).field, 'lines');
  assert.equal(normalizeQuote({ lines: Array.from({ length: 27 }, () => line) }).field, 'lines');
  assert.equal(normalizeQuote({ lines: Array.from({ length: 26 }, () => line) }).ok, true);
  assert.equal(normalizeQuote({ lines: [line], sheet_name: '가'.repeat(24) }).field, 'sheet_name');
  assert.equal(normalizeQuote({ lines: [line], sheet_name: '가'.repeat(23) }).ok, true);
  assert.equal(normalizeQuote({ lines: [line], sheet_name: '견적[1]' }).field, 'sheet_name');
  const cleaned = normalizeQuote({ lines: [{ ...line, name: 'a\u0001b\u000bc', items: [{ category: 'X', spec: 'p\r\nq\u0000' }] }], remarks: ['r\u0008'] });
  assert.equal(cleaned.quote.lines[0].name, 'abc');
  assert.equal(cleaned.quote.lines[0].items[0].spec, 'p\nq');
  assert.equal(cleaned.quote.remarks[0], 'r');
  // 26줄은 A~Z 로 조립된다.
  const book = readWorkbook(build(normalizeQuote({ lines: Array.from({ length: 26 }, () => line), issue_date: '2026-10-06' }).quote).bytes);
  assert.equal(book.sheets[0].cells.get('A47').value, 'Z');
});

// ── QX-11 ────────────────────────────────────────────────────────────────
test('QX-11: no calcChain, fullCalcOnLoad kept, every style index exists, derived xfs only appended', () => {
  const book = readWorkbook(build(caseQuote('server_group_span')).bytes);
  assert.equal(book.files['xl/calcChain.xml'], undefined);
  assert.match(book.workbook, /<calcPr\b[^>]*fullCalcOnLoad="1"/);
  const styles = book.text('xl/styles.xml');
  const sourceStyles = strFromU8(templateFiles['xl/styles.xml']);
  const xfsOf = (xml) => /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const count = Number(/<cellXfs count="(\d+)"/.exec(styles)[1]);
  const xfs = xfsOf(styles);
  const sourceXfs = xfsOf(sourceStyles);
  assert.equal(count, xfs.length);
  assert.ok(count > sourceXfs.length, 'derived styles were appended');
  assert.deepEqual(xfs.slice(0, sourceXfs.length), sourceXfs, 'existing xfs unchanged');
  for (const section of ['fonts', 'borders']) {
    const declared = Number(new RegExp(`<${section} count="(\\d+)"`).exec(styles)[1]);
    const items = new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`).exec(styles)[1].match(new RegExp(`<${section.slice(0, -1)}\\b`, 'g')).length;
    assert.equal(declared, items, `${section} count`);
  }
  for (const sheet of book.sheets) {
    for (const [ref, cell] of sheet.cells) assert.ok(cell.style === null || cell.style < count, `${sheet.name} ${ref}: s=${cell.style}`);
  }
  // 마지막 본문 행 A~I 는 이중선 하단, 상세 2줄 이상 사양은 9pt 줄바꿈.
  const last = book.sheets[0].cells.get('A29').style;
  assert.match(xfs[last], /borderId="(\d+)"/);
  const borderId = Number(/borderId="(\d+)"/.exec(xfs[last])[1]);
  const borders = /<borders\b[^>]*>([\s\S]*?)<\/borders>/.exec(styles)[1].match(/<border\b[\s\S]*?<\/border>|<border\b[^>]*\/>/g);
  assert.match(borders[borderId], /<bottom style="double"\/>/);
  assert.match(xfs[book.sheets[0].cells.get('C23').style], /wrapText="1"/);
});

// ── QX-12 ────────────────────────────────────────────────────────────────
test('QX-12: the known-difference baseline is 4 cells across the 5 cases, all inside the compared range', () => {
  const baseline = readJson('regression', 'baseline.json');
  assert.equal(baseline.count, 4);
  assert.equal(baseline.cases, 5);
  assert.equal(baseline.diffs.length, 4);
  for (const diff of baseline.diffs) {
    assert.ok(CASES.includes(diff.case), diff.case);
    const { col, row } = parseRef(diff.cell);
    assert.ok(col <= 9 && row <= 45 && diff.cell !== 'H14', diff.cell);
    assert.deepEqual(Object.keys(diff).sort(), ['case', 'cell'], 'coordinates only, no values');
  }
});

// ── 발행 기록 재료(dedup 픽스처, Design §4.4) ──────────────────────────────
test('QX-13: contentHash, dedupKey and the price-log fan-out equal the Python store for the dedup fixture', async () => {
  const cases = readJson('dedup.json');
  assert.ok(cases.length >= 10);
  for (const entry of cases) {
    const quote = coerceQuote(entry.input);
    assert.ok(quote, entry.name);
    const label = `${entry.name}/${entry.suffix}`;
    assert.equal(await contentHash(quote, entry.input), entry.content_hash, `${label}: content hash (${contentHashMaterial(quote, entry.input).slice(0, 80)}…)`);
    assert.equal(await dedupKey(quote, entry.input.issue_date, entry.author ?? quote.staff.name, entry.suffix, entry.input), entry.dedup_key, `${label}: dedup key`);
    assert.equal(entry.issued.dedup_key, entry.dedup_key);
    assert.equal(subtotal(quote), entry.issued.subtotal, `${label}: subtotal`);
    assert.equal(pyRoundInt(subtotal(quote) * 1.1), entry.issued.total, `${label}: total`);
    const rows = priceLogRows(quote).map((row) => ({ ...row, status: 'draft' }));
    assert.deepEqual(rows, entry.price_rows, `${label}: price rows`);
  }
  // 입력에 qty 키가 없을 때만 "1"(pydantic 기본값 int), 있으면 repr(float).
  const missing = cases.find((entry) => entry.name === 'qty_missing_default');
  assert.match(contentHashMaterial(coerceQuote(missing.input), missing.input), /I\|GPU\|RTX PRO 6000\|1\|None/);
  assert.match(contentHashMaterial(coerceQuote(missing.input), missing.input), /I\|SSD\|PM9A3 3\.84TB\|None\|None/);
});

// ── 익명화 검사(Design §11.5, QT2 픽스처 완료 조건) ─────────────────────────
function fixtureTexts() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push([path.relative(FIXTURES, full), readFileSync(full, 'utf8')]);
    }
  };
  walk(FIXTURES);
  for (const [name, data] of Object.entries(templateFiles)) if (/\.(xml|rels)$/.test(name)) out.push([`template-redacted.xlsx:${name}`, strFromU8(data)]);
  return out;
}
test('anonymization: fixtures carry only placeholder people and contacts', () => {
  const allowedPeople = new Set(['홍길동 님', '김철수 연구원님', '이영희 님', '박민수 과장님', '최지우 조교수님']);
  for (const name of CASES) {
    const quote = readJson('regression', `${name}.quote.json`);
    assert.match(quote.customer.org, /^고객기관[A-E]$/);
    assert.ok(allowedPeople.has(quote.customer.contact), `${name}: contact placeholder`);
    for (const value of [quote.customer.tel, quote.customer.email].filter(Boolean)) assert.ok(['010-0000-0000', 'customer@example.com'].includes(value));
    assert.deepEqual(quote.staff, { name: '담당자 팀장', tel: '010-1234-5678', email: 'staff@example.com' });
    if (quote.terms.project) assert.equal(quote.terms.project, '프로젝트명');
  }
  const texts = fixtureTexts();
  for (const [name, text] of texts) {
    // 휴대폰 번호는 자리표시자만(010-0000-0000, 010-1234-5678).
    for (const [phone] of text.matchAll(/01[016789]-?\d{3,4}-?\d{4}/g)) assert.ok(['010-0000-0000', '010-1234-5678'].includes(phone), `${name}: phone-like value`);
    for (const [mail] of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) assert.match(mail, /@example\.(com|org|net)$/, `${name}: e-mail address`);
  }
});

test('anonymization: no real customer name or phone from the marker file appears in tests/fixtures', (t) => {
  const markerPath = process.env.QUOTE_PII_MARKERS || 'C:\\xdm\\secure\\quote-markers.json';
  if (!existsSync(markerPath)) {
    t.skip('marker file not present on this machine (values are never printed)');
    return;
  }
  const markers = JSON.parse(readFileSync(markerPath, 'utf8'));
  const values = [...(markers.orgs ?? []), ...(markers.phones ?? [])].filter((value) => typeof value === 'string' && value.length >= 2);
  assert.ok(values.length > 0, 'marker file has values');
  let hits = 0;
  for (const [, text] of fixtureTexts()) for (const value of values) if (text.includes(value)) hits += 1;
  // 값은 출력하지 않는다(건수만).
  assert.equal(hits, 0, `${hits} marker hit(s) in tests/fixtures/quote`);
});

test('cellRef/parseRef round-trip and formula evaluator rejects unsupported syntax', () => {
  assert.equal(cellRef(16, 30), 'P30');
  assert.deepEqual(parseRef('$N$23'), { col: 14, row: 23 });
  const cells = { A1: 2, A2: 3, B1: 'text', C1: null };
  const lookup = (ref) => cells[ref] ?? null;
  assert.equal(evaluateFormula('=SUM(A1:A2,B1)*A2-A1+(1+2)', lookup), 16);
  assert.equal(evaluateFormula('$A$1*0.1', lookup), 0.2);
  for (const bad of ['A1/A2', 'IF(A1,1,2)', 'A1:A2', 'SUM(A1', '"x"']) assert.throws(() => evaluateFormula(bad, lookup), bad);
});
