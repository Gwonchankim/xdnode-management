// quote-tool(Design §11.6, QT3·QT4): 텍스트 키·신뢰도·단가 제안·고객 매칭·구성 추천(QP-10)의 TS 이식이 파이썬 옛 툴과 같은지 본다(순수 모듈).
// 픽스처는 옛 툴 저장소 tools/export_xdm_pricing_fixtures.py 가 보관 사본으로 만든 파이썬 출력이다(tests/fixtures/quote/{textkey,confidence,customers}.json, suggest/).
// QP-01·02(텍스트 키·SequenceMatcher 동등)는 허용 오차 없이 === 로 본다. 이 둘이 통과하기 전에는 견적 화면 작업에 들어가지 않는다(R-QT6).
import './helpers/tsx-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { norm, tokens, scoreOne, SequenceMatcher, SequenceB, SLOT, SLOT_ORDER, slotOf, slotsOf, isModelContainment } = await import('../app/quote-textkey.ts');
const confidence = await import('../app/quote-confidence.ts');
const { decide, SUGGESTION_KEYS } = confidence;
const P = await import('../app/quote-pricing.ts');
const { coerceQuote } = await import('../app/quote-model.ts');
const { pyRound, pyRoundInt, pyFloatRepr, pyFormatFixed, PY_LOG_TABLE } = await import('../app/quote-pyfmt.ts');
const { contentHash, dedupKey, priceLogRows } = await import('../app/quote-dedup.ts');

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(root, 'tests', 'fixtures', 'quote');
const readJson = (...parts) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
const EXAMPLES = ['01', '02', '03', '04', '05'];
const TODAY = '2026-10-01';

/** 파이썬 sorted() 와 같은 코드 포인트 순 정렬. */
const pySorted = (values) => [...values].sort(P.pyCompare);
/** 실패 메시지용: 문자열은 앞 60자만, 개수는 최대 5건(픽스처는 익명화되어 있지만 출력은 짧게 둔다). */
const short = (value) => JSON.stringify(typeof value === 'string' ? value.slice(0, 60) : value);
function report(label, mismatches, total) {
  assert.equal(mismatches.length, 0, `${label}: ${mismatches.length}/${total} mismatch(es)\n${mismatches.slice(0, 5).join('\n')}`);
}

const textkey = readJson('textkey.json');
const customersFixture = readJson('customers.json');
const flatCustomers = (byOrg) => Object.entries(byOrg).flatMap(([org, list]) => list.map((entry) => ({
  org, contact: entry.contact ?? null, tel: entry.tel ?? null, email: entry.email ?? null, last_date: entry.last_date ?? null, n: entry.n ?? null,
})));

// ── QP-01 텍스트 키 문자열 동등(QT-SC-04) ─────────────────────────────────────
test('QP-01: norm, tokens, slots_of and slot_of equal Python for every fixture string (0 mismatches)', () => {
  const strings = textkey.strings;
  assert.ok(strings.length >= 1500, `fixture has ${strings.length} strings (Design P-6: ≥1,500)`);
  const bad = [];
  for (const [index, entry] of strings.entries()) {
    if (norm(entry.s) !== entry.norm) bad.push(`#${index} norm ${short(norm(entry.s))} ≠ ${short(entry.norm)}`);
    const got = pySorted(tokens(entry.s));
    if (JSON.stringify(got) !== JSON.stringify(entry.tokens)) bad.push(`#${index} tokens ${short(got)} ≠ ${short(entry.tokens)}`);
    const slots = pySorted(slotsOf(entry.s));
    if (JSON.stringify(slots) !== JSON.stringify(entry.slots_of)) bad.push(`#${index} slots_of ${short(slots)} ≠ ${short(entry.slots_of)}`);
    if (slotOf(entry.s) !== entry.slot_of) bad.push(`#${index} slot_of ${short(slotOf(entry.s))} ≠ ${short(entry.slot_of)}`);
  }
  report('QP-01', bad, strings.length * 4);
  // 옛 dict 의 삽입 순서(접두·부분 일치가 순서에 의존)와 SLOT_ORDER 도 같다.
  assert.deepEqual(SLOT.map(([key, slot]) => [key, slot]), textkey.slot);
  assert.deepEqual([...SLOT_ORDER], textkey.slot_order);
  // 경계: Kelvin 기호·İ 는 소문자화로 ASCII 가 되고, 전각·®™·서로게이트 쌍은 한 공백 묶음이 된다.
  assert.equal(norm('\u212a8s'), 'k8s');
  assert.equal(norm('RTX\u00ae4090\u2122'), 'rtx4090');
  assert.equal(norm('가나\u{1F600}다'), '가나 다');
});

// ── QP-02 쌍 8,000개 ratio·블록·score_one·contained ─────────────────────────────
test('QP-02: SequenceMatcher ratio/blocks (normalized and raw), score_one and is_model_containment equal Python for 8,000 pairs (exact)', () => {
  const { strings, pairs } = textkey;
  assert.ok(pairs.length >= 8000, `fixture has ${pairs.length} pairs`);
  const bad = [];
  for (const [index, pair] of pairs.entries()) {
    const a = strings[pair.a].s;
    const b = strings[pair.b].s;
    const na = norm(a);
    const nb = norm(b);
    const matcher = new SequenceMatcher(na, nb);
    // 허용 오차는 계획대로 1e-12 이지만 같은 IEEE 연산이라 실제로는 === 를 기대한다. 차이가 나면 크기를 함께 보인다.
    const ratio = matcher.ratio();
    if (ratio !== pair.ratio) bad.push(`#${index} ratio ${ratio} ≠ ${pair.ratio} (Δ ${Math.abs(ratio - pair.ratio)})`);
    if (JSON.stringify(matcher.getMatchingBlocks()) !== JSON.stringify(pair.blocks)) bad.push(`#${index} blocks ${short(matcher.getMatchingBlocks())} ≠ ${short(pair.blocks)}`);
    const raw = new SequenceMatcher(a, b);
    if (raw.ratio() !== pair.raw_ratio) bad.push(`#${index} raw ratio ${raw.ratio()} ≠ ${pair.raw_ratio}`);
    if (JSON.stringify(raw.getMatchingBlocks()) !== JSON.stringify(pair.raw_blocks)) bad.push(`#${index} raw blocks differ`);
    const s = scoreOne(na, tokens(a), b);
    if (s !== pair.score_one) bad.push(`#${index} score_one ${s} ≠ ${pair.score_one} (Δ ${Math.abs(s - pair.score_one)})`);
    if (isModelContainment(a, b) !== pair.contained) bad.push(`#${index} contained ${isModelContainment(a, b)} ≠ ${pair.contained}`);
  }
  report('QP-02', bad, pairs.length * 6);
  // b 측 구조를 미리 만들어 재사용해도(카탈로그 캐시) 결과가 같다.
  const sb = new SequenceB(norm(strings[pairs[0].b].s));
  assert.equal(new SequenceMatcher(norm(strings[pairs[0].a].s), sb).ratio(), pairs[0].ratio);
  assert.equal(new SequenceMatcher('', '').ratio(), 1.0);
});

// ── QP-03 autojunk(popular) 경로 ───────────────────────────────────────────
test('QP-03: the autojunk "popular" rule (b length ≥ 200) is exercised and matches Python', () => {
  const { strings, pairs } = textkey;
  const long = pairs.filter((pair) => Array.from(norm(strings[pair.b].s)).length >= 200 || Array.from(strings[pair.b].s).length >= 200);
  assert.ok(long.length >= 500, `${long.length} pairs with a long b`);
  let popularHits = 0;
  for (const pair of long) {
    const nb = norm(strings[pair.b].s);
    if (Array.from(nb).length >= 200 && new SequenceB(nb).popular.size > 0) popularHits += 1;
  }
  assert.ok(popularHits >= 200, `${popularHits} long pairs actually drop popular elements`);
  // 파이썬: SequenceMatcher(None, 'a'*10, 'a'*250).ratio() == 20/260 — 'a' 는 popular 라 b2j 에서 빠져 본 루프는 일치를 못 찾지만,
  // 크기 0 인 (0, 0) 에서 시작한 앞쪽 확장 루프가 popular 문자를 이어 붙여 10 글자가 된다(값은 파이썬 3.14 로 확인).
  assert.deepEqual([...new SequenceB('a'.repeat(250)).popular], ['a']);
  assert.equal(new SequenceMatcher('a'.repeat(10), 'a'.repeat(250)).ratio(), 20 / 260);
  assert.equal(new SequenceMatcher('a'.repeat(10), 'a'.repeat(199)).ratio(), 20 / 209);
  // popular 문자도 확장 루프는 건너 이어 붙인다(bjunk 가 아니다): 'b' 로 시작한 일치가 양옆의 'a' 를 끌어온다.
  const b = `${'a'.repeat(120)}xbx${'a'.repeat(120)}`;
  assert.equal(new SequenceMatcher('aaxbxaa', b).ratio(), (2 * 7) / (7 + b.length));
});

// ── QP-04 decide 판정 표·앵커 규칙 ─────────────────────────────────────────
test('QP-04: decide() equals Python for the test_confidence.py table, the anchor rule and the score/category/history grid', () => {
  const fixture = readJson('confidence.json');
  assert.deepEqual({ PROMOTE_MIN: confidence.PROMOTE_MIN, CONF_HIGH: confidence.CONF_HIGH, CONF_MED: confidence.CONF_MED, THIN_HISTORY: confidence.THIN_HISTORY, CAT_PENALTY: confidence.CAT_PENALTY }, fixture.constants);
  assert.deepEqual(pySorted(SUGGESTION_KEYS), fixture.suggestion_keys);
  assert.equal(SUGGESTION_KEYS.size, 23);
  const bad = [];
  let table = 0;
  for (const [index, entry] of fixture.cases.entries()) {
    const hist = Array.from({ length: entry.hist_len }, () => ({ date: '2026-01-01', price: 1000 }));
    const anchor = entry.anchor_index === null ? null : entry.matches[entry.anchor_index];
    const verdict = decide(entry.matches, entry.live, hist, anchor);
    try {
      assert.deepStrictEqual(verdict, entry.expected);
    } catch {
      bad.push(`#${index} ${entry.desc}: ${short(verdict)} ≠ ${short(entry.expected)}`);
    }
    if (entry.table) {
      table += 1;
      if (verdict.promote !== entry.table.promote || verdict.confidence !== entry.table.confidence) bad.push(`#${index} table ${entry.desc}`);
    }
  }
  report('QP-04', bad, fixture.cases.length);
  assert.ok(table >= 17, `${table} table rows`);
  // 앵커 이름은 객체 동일성으로 top1 과 다를 때만(같은 내용의 다른 객체여도 채운다).
  const top = { score: 0.9, cat_rel: null, name: '1위' };
  assert.equal(decide([top], [], [{}, {}, {}], top).anchor_name, null);
  assert.equal(decide([top], [], [{}, {}, {}], { ...top }).anchor_name, '1위');
});

// ── 카탈로그(부분 사본)·단가 이력 기록으로 제안을 다시 계산한다 ───────────────────────
const v2 = readJson('suggest', 'catalog_v2.json');
const v1 = readJson('suggest', 'catalog.json');
const catalogInput = { legacy: v1.products, customers: flatCustomers(v1.customers), vocab: v1.vocab };
const catalogs = { normal: P.buildQuoteCatalog({ ...catalogInput, products: v2.products }), fallback: P.buildQuoteCatalog({ ...catalogInput, products: [] }) };

function recompute(example, mode) {
  const lookup = new Map(example[`${mode}_price_history_calls`].map((call) => [`${call.kind}|${call.name}`, call.rows]));
  const asked = [];
  const historyOf = (name, kind) => {
    asked.push(`${kind}|${name}`);
    const rows = lookup.get(`${kind}|${name}`);
    assert.ok(rows, `price history call not in fixture: ${short(name)} (${kind})`);
    return rows;
  };
  const quote = coerceQuote(example.quote);
  const result = {
    suggestions: P.suggestPrices(catalogs[mode], quote, historyOf, TODAY),
    customer_matches: P.matchCustomer(catalogs[mode], quote.customer.org, quote.customer.contact),
  };
  return { result, asked, quote };
}

// ── QP-05 키 계약(정상·폴백) ────────────────────────────────────────────────
test('QP-05: every suggestion on both paths has exactly the 23 keys and the four invariants hold (QT-SC-03)', () => {
  let normal = 0;
  let fallback = 0;
  for (const name of EXAMPLES) {
    const example = readJson('suggest', `${name}.json`);
    for (const mode of ['normal', 'fallback']) {
      for (const suggestion of Object.values(recompute(example, mode).result.suggestions)) {
        if (mode === 'normal') normal += 1; else fallback += 1;
        assert.deepEqual(pySorted(Object.keys(suggestion)), pySorted(SUGGESTION_KEYS), `${name}/${mode}: key set`);
        for (const key of ['match_score', 'confidence', 'suggested_grade', 'cat_rel', 'anchor_name']) assert.ok(Object.hasOwn(suggestion, key), key);
        if (suggestion.gated) assert.equal(suggestion.suggested, null, 'gated ⇒ no suggested');
        if (suggestion.gated) assert.ok(suggestion.delta === null && suggestion.age_days === null, 'gated ⇒ no delta/age_days');
        if (suggestion.suggested === null) assert.equal(suggestion.delta, null, 'no suggested ⇒ no delta');
        if (suggestion.confidence === 'high') assert.notEqual(suggestion.suggested, null, 'high ⇒ suggested');
      }
    }
  }
  assert.ok(normal >= 20 && fallback >= 20, `normal ${normal}, fallback ${fallback}`);
  // 키가 어긋나면 throw 한다(옛 assert).
  assert.equal(P.mergeSuggestion([], [], null, TODAY), null);
});

// ── QP-06 예제 제안 동등(QT-SC-05) ──────────────────────────────────────────
test('QP-06: suggestions and customer matches for the anonymized examples equal Python on the v2 and fallback paths (clock fixed to 2026-10-01)', () => {
  const coverage = new Set();
  for (const name of EXAMPLES) {
    const example = readJson('suggest', `${name}.json`);
    for (const mode of ['normal', 'fallback']) {
      const { result, asked } = recompute(example, mode);
      // 파이썬과 같은 순서로 같은 이력 조회를 부른다.
      assert.deepEqual(asked, example[`${mode}_price_history_calls`].map((call) => `${call.kind}|${call.name}`), `${name}/${mode}: price history calls`);
      const expected = example[mode];
      assert.deepEqual(Object.keys(result.suggestions).sort(), Object.keys(expected.suggestions).sort(), `${name}/${mode}: suggestion keys`);
      for (const [key, suggestion] of Object.entries(expected.suggestions)) {
        const got = result.suggestions[key];
        // QT-SC-05 의 핵심 칸을 먼저 비교해 실패 메시지를 짧게 한다. 이어서 전체(이력·후보 포함)를 비교한다.
        for (const field of ['suggested', 'confidence', 'suggested_grade', 'gated', 'match_score', 'anchor_name']) {
          assert.deepStrictEqual(got[field], suggestion[field], `${name}/${mode}/${key}: ${field}`);
        }
        assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), suggestion, `${name}/${mode}/${key}: full suggestion`);
        coverage.add(`${suggestion.confidence}/${suggestion.suggested_grade}/${suggestion.gated}`);
        if (suggestion.anchor_name) coverage.add('anchor');
        if (suggestion.delta !== null) coverage.add('delta');
      }
      assert.deepStrictEqual(JSON.parse(JSON.stringify(result.customer_matches)), expected.customer_matches, `${name}/${mode}: customer matches`);
    }
  }
  for (const path of ['high/confirmed/false', 'low/draft/false', 'high/file/false', 'medium/file/false', 'low/file/true', 'anchor', 'delta']) {
    assert.ok(coverage.has(path), `fixture covers ${path}`);
  }
});

test('QP-06b: the catalog views (products, priceHistory catalog half, fallback products) equal Python', () => {
  const views = readJson('suggest', 'catalog_views.json');
  for (const entry of views.products) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P.matchProduct(catalogs.normal, entry.q, entry.category, 8))), entry.expected, `products ${short(entry.q)} ${entry.category}`);
  }
  for (const entry of views.products_fallback) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P.matchProduct(catalogs.fallback, entry.q, entry.category, 8))), entry.expected, `fallback ${short(entry.q)}`);
  }
  for (const entry of views.price_history) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P.matchProduct(catalogs.normal, entry.name, null, 3))), entry.expected.catalog, `priceHistory catalog ${short(entry.name)}`);
  }
  assert.ok(views.products.length >= 30 && views.price_history.length >= 30);
  // v2 의 junk 제품은 후보가 되지 않는다(부분 카탈로그에 junk 가 들어 있다).
  assert.ok(v2.products.some((product) => product.kind === 'junk'));
  assert.equal(catalogs.normal.products.some((product) => product.kind === 'junk'), false);
});

// ── QP-07 이전 name_key 재계산 ─────────────────────────────────────────────
test('QP-07: name_key recomputed in TS equals the Python norm_key for the price-log fixtures', () => {
  const rows = [...readJson('suggest', 'price_log.json'), ...readJson('dedup.json').flatMap((entry) => entry.price_rows)];
  assert.ok(rows.length >= 40);
  for (const row of rows) assert.equal(norm(row.name), row.name_key, short(row.name));
  for (const example of EXAMPLES.map((name) => readJson('suggest', `${name}.json`))) {
    for (const call of example.normal_price_history_calls) for (const row of call.rows) assert.equal(norm(row.name), norm(call.name));
  }
});

// ── QP-08 파이썬 숫자 표기 경계 ────────────────────────────────────────────
test('QP-08: pyRound, pyFloatRepr and pyFormatFixed match Python at the boundaries', () => {
  assert.equal(pyRound(0.0625, 3), 0.062);
  assert.equal(pyRound(2.675, 2), 2.67);
  assert.equal(pyRound(0.5945, 3), 0.595);
  assert.equal(pyRound(-0.0625, 3), -0.062);
  assert.equal(pyRoundInt(0.5), 0);
  assert.equal(pyRoundInt(1.5), 2);
  assert.equal(pyRoundInt(2.5), 2);
  assert.equal(pyFloatRepr(1e16), '1e+16');
  assert.equal(pyFloatRepr(1e-5), '1e-05');
  assert.equal(pyFloatRepr(-0), '-0.0');
  assert.equal(pyFloatRepr(2), '2.0');
  assert.equal(pyFloatRepr(0.1 + 0.2), '0.30000000000000004');
  assert.equal(pyFormatFixed(0.0625, 3), '0.062');
  assert.equal(pyFormatFixed(2.675, 2), '2.67');
  assert.equal(pyFormatFixed(0.715, 2), '0.71');
  assert.equal(pyFormatFixed(-0, 2), '-0.00');
  assert.equal(pyFormatFixed(1.234, 3), '1.234');
  // math.log(1..54) 표는 파이썬 출력과 비트 단위로 같다.
  assert.deepEqual([...PY_LOG_TABLE], textkey.log);
});

// ── QP-09 contentHash·dedupKey ────────────────────────────────────────────
test('QP-09: contentHash and dedupKey equal the Python store (qty default branch included)', async () => {
  const cases = readJson('dedup.json');
  assert.ok(cases.length >= 10);
  for (const entry of cases) {
    const quote = coerceQuote(entry.input);
    assert.equal(await contentHash(quote, entry.input), entry.content_hash, entry.name);
    assert.equal(await dedupKey(quote, entry.input.issue_date, entry.author ?? quote.staff.name, entry.suffix, entry.input), entry.dedup_key, entry.name);
    assert.deepEqual(priceLogRows(quote).map((row) => row.name_key), entry.price_rows.map((row) => row.name_key));
  }
});

// ── QP-11 matchCustomer·specFor ───────────────────────────────────────────
test('QP-11: matchCustomer and specFor equal Python (three stable sorts, strict > for the spec winner)', () => {
  const catalog = P.buildQuoteCatalog({
    customers: flatCustomers(customersFixture.customers),
    specs: Object.entries(customersFixture.spec_library).map(([name, entry]) => ({ name, spec: entry.spec })),
  });
  assert.ok(customersFixture.match_customer.length >= 25);
  const bad = [];
  for (const entry of customersFixture.match_customer) {
    try {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(P.matchCustomer(catalog, entry.org, entry.contact))), entry.expected);
    } catch {
      bad.push(`${short(entry.org)}/${short(entry.contact)}`);
    }
  }
  report('QP-11 matchCustomer', bad, customersFixture.match_customer.length);
  const specBad = customersFixture.spec_for.filter((entry) => P.specFor(catalog, entry.name) !== entry.expected).map((entry) => short(entry.name));
  report('QP-11 specFor', specBad, customersFixture.spec_for.length);
  assert.ok(customersFixture.spec_for.some((entry) => entry.expected !== null) && customersFixture.spec_for.some((entry) => entry.expected === null));
});

test('ageDays follows the old strptime formats (YYYY-M-D, YYYY.M.D, yymmdd) and rejects impossible dates', () => {
  assert.equal(P.ageDays('2026-09-30', TODAY), 1);
  assert.equal(P.ageDays('2026-9-5', TODAY), 26);
  assert.equal(P.ageDays('2026.09.20', TODAY), 11);
  assert.equal(P.ageDays('260915', TODAY), 16);
  assert.equal(P.ageDays('691231', TODAY), Math.round((Date.UTC(2026, 9, 1) - Date.UTC(1969, 11, 31)) / 86_400_000));
  assert.equal(P.ageDays('2026-10-01T09:00:00', TODAY), 0);
  for (const bad of [null, '', '2026-02-30', '2026/09/30', '2026-13-01', '20260930', 'abc']) assert.equal(P.ageDays(bad, TODAY), null, short(bad));
});

// ── 익명화(새 픽스처) ───────────────────────────────────────────────────────
const QT3_FIXTURES = ['textkey.json', 'confidence.json', 'customers.json', ...readdirSync(path.join(FIXTURES, 'suggest')).map((name) => `suggest/${name}`)];
function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, out);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { out.push(key); stringsOf(entry, out); }
  return out;
}

test('anonymization: QT3 fixtures carry only synthetic customers, placeholder contacts and "고객N" history customers', () => {
  const syntheticOrgs = new Set(Object.keys(customersFixture.customers));
  assert.deepEqual(new Set(Object.keys(v1.customers)), syntheticOrgs);
  for (const product of v2.products) for (const entry of product.history ?? []) assert.ok(entry.customer === null || /^고객\d+$/.test(entry.customer), 'v2 history customer');
  for (const product of v1.products) for (const entry of product.price_history ?? []) assert.ok(entry.customer == null || /^고객\d+$/.test(entry.customer), 'legacy history customer');
  for (const row of readJson('suggest', 'price_log.json')) assert.match(row.customer, /^고객\d+$/);
  for (const name of EXAMPLES) {
    const { quote } = readJson('suggest', `${name}.json`);
    assert.ok(syntheticOrgs.has(quote.customer.org), `${name}: synthetic org`);
    assert.deepEqual(quote.staff, { name: '담당자 팀장', tel: '010-1234-5678', email: 'staff@example.com' });
    assert.equal(quote.customer.tel, '010-0000-0000');
    assert.equal(quote.customer.email, 'customer@example.com');
  }
  for (const file of QT3_FIXTURES) {
    for (const text of stringsOf(readJson(...file.split('/')))) {
      for (const [mail] of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) assert.match(mail, /@example\.(com|org|net)$/, `${file}: e-mail address`);
      for (const [phone] of text.matchAll(/01[016789]-?\d{3,4}-?\d{4}/g)) assert.ok(['010-0000-0000', '010-1234-5678'].includes(phone), `${file}: phone-like value`);
    }
  }
});

test('anonymization: no value from the marker file appears in any QT3 fixture string', (t) => {
  const markerPath = process.env.QUOTE_PII_MARKERS || 'C:\\xdm\\secure\\quote-markers.json';
  if (!existsSync(markerPath)) {
    t.skip('marker file not present on this machine (values are never printed)');
    return;
  }
  const markers = JSON.parse(readFileSync(markerPath, 'utf8'));
  const values = [...(markers.orgs ?? []), ...(markers.phones ?? [])].filter((value) => typeof value === 'string' && value.length >= 2);
  assert.ok(values.length > 0, 'marker file has values');
  let hits = 0;
  for (const file of QT3_FIXTURES) {
    const text = stringsOf(readJson(...file.split('/'))).join('\n');
    for (const value of values) if (text.includes(value)) hits += 1;
  }
  // 값은 출력하지 않는다(건수만).
  assert.equal(hits, 0, `${hits} marker hit(s) in QT3 fixtures`);
});

// ── QP-10 구성 추천·비교 변형 동등(QT4, Design §4.6) ─────────────────────────────
// 픽스처: 옛 툴 저장소 tools/export_xdm_recommend_fixtures.py 가 보관 사본의 구성 라이브러리에서 고른 부분 사본(기관·파일명 익명화)과
// 그 사본으로 돌린 파이썬 recommend·variants·to_line 출력(tests/fixtures/quote/recommend). 허용 오차 없이 deepStrictEqual 로 본다.
const R = await import('../app/quote-recommend.ts');
const recommendLibrary = readJson('recommend', 'library.json');
const recommendCases = readJson('recommend', 'cases.json');

test('QP-10: recommend (+ to_line per result), variants and to_line equal Python for every fixture case (0 mismatches)', () => {
  const library = R.prepareBomLibrary(recommendLibrary);
  assert.ok(recommendLibrary.length >= 100, `library subset has ${recommendLibrary.length} entries`);
  const bad = [];
  let compared = 0;
  for (const [index, c] of recommendCases.recommend.entries()) {
    compared += 1;
    const got = R.recommend(library, c.gpu, c.qty, c.capacity, c.limit).map((rec) => ({ ...rec, line: R.toLine(rec, c.qty) }));
    try { assert.deepStrictEqual(got, c.out); } catch { bad.push(`recommend #${index} gpu=${short(c.gpu)} qty=${c.qty} cap=${c.capacity} limit=${c.limit}`); }
  }
  for (const [index, c] of recommendCases.variants.entries()) {
    compared += 1;
    try { assert.deepStrictEqual(R.variants(library, c.gpu, c.counts, c.capacity), c.out); } catch { bad.push(`variants #${index} gpu=${short(c.gpu)} counts=${c.counts}`); }
  }
  for (const [index, c] of recommendCases.to_line.entries()) {
    compared += 1;
    try { assert.deepStrictEqual(R.toLine(c.rec, c.gpu_qty, c.label), c.out); } catch { bad.push(`to_line #${index} gpu_qty=${c.gpu_qty} label=${short(c.label)}`); }
  }
  report('QP-10', bad, compared);
  // 표본이 실제로 경로를 고루 지난다: 결과 있는 추천·없는 추천, 증설 실적 문구, 2026 이전·이후 날짜, 여러 건 결과의 점수 내림차순.
  const nonEmpty = recommendCases.recommend.filter((c) => c.out.length);
  assert.ok(nonEmpty.length >= 100 && recommendCases.recommend.length - nonEmpty.length >= 10, 'both empty and non-empty recommendations');
  assert.ok(nonEmpty.some((c) => c.out.some((rec) => /같은 베이스로 최대/.test(rec.evidence))), 'base_max_gpu evidence');
  assert.ok(recommendLibrary.some((b) => b.date < '2026-01-01') && recommendLibrary.some((b) => b.date >= '2026-01-01'), 'date bonus on both sides');
  assert.ok(nonEmpty.some((c) => c.out.length >= 3), 'multi-result cases');
  assert.ok(recommendCases.variants.filter((c) => c.out.length).length >= 50, 'variants with a base');
});

test('QP-10b: sim() is the old _sim (token Jaccard without partial credit 0.6 + SequenceMatcher 0.4), and limit/needCap follow the Python truthiness', () => {
  assert.equal(R.sim('', 'RTX 4090'), 0);
  assert.equal(R.sim('RTX 4090', 'RTX 4090'), 1);
  // 부분 일치('409' ⊂ '4090')는 자카드에 들어가지 않는다(score_one 과 다르다).
  const sm = new SequenceMatcher(norm('RTX 409'), norm('RTX 4090')).ratio();
  assert.equal(R.sim('RTX 409', 'RTX 4090'), 0.6 * (1 / 3) + 0.4 * sm);
  const library = R.prepareBomLibrary(recommendLibrary);
  const gpu = recommendLibrary[0].gpu_name;
  // limit ≤ 0 이어도 옛 코드처럼 1건(넣은 뒤 개수를 본다). gpu_qty 0 은 없는 것과 같다.
  assert.equal(R.recommend(library, gpu, null, null, 0).length, 1);
  assert.deepStrictEqual(R.recommend(library, gpu, 0, 0, 3), R.recommend(library, gpu, null, null, 3));
  assert.deepStrictEqual(R.recommend(R.prepareBomLibrary([]), gpu), []);
  assert.deepStrictEqual(R.variants(R.prepareBomLibrary([]), gpu, [2, 3]), []);
});

test('anonymization: QT4 recommend fixtures carry only "고객기관N" customers, placeholder files and no e-mail or phone-like values', (t) => {
  for (const entry of recommendLibrary) {
    assert.match(entry.customer, /^고객기관\d+$/);
    assert.match(entry.file, /^견적\d+\.xlsx$/);
    assert.equal(entry.sheet_name, '견적');
  }
  for (const file of ['recommend/library.json', 'recommend/cases.json']) {
    for (const text of stringsOf(readJson(...file.split('/')))) {
      for (const [mail] of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) assert.match(mail, /@example\.(com|org|net)$/, `${file}: e-mail address`);
      for (const [phone] of text.matchAll(/01[016789]-?\d{3,4}-?\d{4}/g)) assert.equal(phone, '010-0000-0000', `${file}: phone-like value`);
    }
  }
  const markerPath = process.env.QUOTE_PII_MARKERS || 'C:\\xdm\\secure\\quote-markers.json';
  if (!existsSync(markerPath)) { t.diagnostic('marker file not present; marker scan skipped (values are never printed)'); return; }
  const markers = JSON.parse(readFileSync(markerPath, 'utf8'));
  const values = [...(markers.orgs ?? []), ...(markers.phones ?? [])].filter((value) => typeof value === 'string' && value.length >= 2);
  let hits = 0;
  for (const file of ['recommend/library.json', 'recommend/cases.json']) {
    const text = stringsOf(readJson(...file.split('/'))).join('\n');
    for (const value of values) if (text.includes(value)) hits += 1;
  }
  assert.equal(hits, 0, `${hits} marker hit(s) in QT4 fixtures`);
});
