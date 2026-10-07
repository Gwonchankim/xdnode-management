// quote-tool(Design §10·§11.6·§11.7, QT3b): 견적 편집 화면의 권한별 렌더링(서버 렌더로 실제 컴포넌트를 그린다), 단가 제안 부분 갱신 기억(순수),
// 생성 요청 본문, 화면 소스 가드(HTML 주입 없음, 로컬 도우미 직접 호출 없음, 서버 모듈 import 없음, 단축키, 409 STALE 처리, 디바운스 ≥ 600ms).
// QT4: 상담 답 렌더링(HTML 주입 없음·http(s) 링크만·rel=noopener noreferrer), 구성 추천·상담 서랍의 권한별 렌더링과 소스 가드.
import './helpers/tsx-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const { SuggestCache, lineSuggestKey } = await import('../app/quote-suggest-plan.ts');
const { default: QuoteEditorView, emptyPriceCount, priceAt, withPriceAt } = await import('../app/quote-editor-view.tsx');
const { default: QuoteWorkspace, quoteForSend, SUGGEST_DEBOUNCE_MS } = await import('../app/quote-workspace.tsx');
const { coerceQuote } = await import('../app/quote-model.ts');

const sampleQuote = () => coerceQuote({
  customer: { org: '알파연구소', contact: '홍길동 님', tel: '010-0000-0000', email: 'customer@example.com' },
  staff: { name: '담당자 팀장', tel: '010-1234-5678', email: 'staff@example.com' },
  lines: [
    { label: 'Server', name: 'Gigabyte G494', sets: 1, items: [
      { category: 'Chassis', spec: 'G494\nDual Socket\nline3\nline4', qty: 1, unit_price: 3000000 },
      { category: 'GPU', spec: 'RTX PRO 6000', qty: 4, unit_price: null },
    ], notes: ['* 확약', ''] },
    { label: 'NAS', name: 'DS1621+', qty: 1, unit_price: 2500000, notes: [] },
  ],
  remarks: ['- 3년 무상 보증', ''],
  margin: { rate: 0.12, buy_units: { '0.0': 2500000, '0.1': 900000, '5.0': 1 } },
});
const suggestion = (price, extra = {}) => ({
  name: 'RTX PRO 6000', matches: [], suggested: price, suggested_date: '2026-09-01', suggested_source: 'issued', kind: 'part', caution: null, note: null,
  min: price, max: price + 1000, history: [{ date: '2026-09-01', price, customer: '고객N', qty: 1, source: 'issued', status: 'confirmed' }, { date: '2026-08-01', price: price + 1000, customer: '고객M', qty: 2, source: 'file' }],
  confidence: 'medium', confidence_reason: '발행 기록이 1건뿐', match_score: 0.8, suggested_grade: 'confirmed', cat_rel: 'match', gated: false, anchor_name: null, contained: false,
  current_price: null, delta: null, delta_pct: null, age_days: 36, ...extra,
});

// ── 단가 제안 부분 갱신(순수) ───────────────────────────────────────────────
test('SuggestCache asks only for lines whose suggestion inputs changed, follows moved lines, and drops answers from before an invalidation', () => {
  const quote = sampleQuote();
  const cache = new SuggestCache();
  assert.deepEqual(cache.plan(quote.lines), [0, 1], 'nothing remembered yet');
  const keys = quote.lines.map(lineSuggestKey);
  cache.markPending(keys);
  assert.deepEqual(cache.plan(quote.lines), [], 'lines being asked are not asked twice');
  const answer = { '0': suggestion(1), '0.1': suggestion(2), '1': suggestion(3) };
  assert.equal(cache.store(cache.generation, [0, 1], keys, answer), true);
  assert.deepEqual(cache.assemble(quote.lines), answer);
  assert.deepEqual(cache.plan(quote.lines), []);

  // 수량·확약 문구·사양 둘째 줄 이하·매입단가는 제안 재료가 아니다 → 다시 묻지 않는다.
  const qtyOnly = { ...quote, lines: [{ ...quote.lines[0], sets: 3, notes: ['x'], items: [{ ...quote.lines[0].items[0], qty: 9, spec: 'G494\n바뀐 둘째 줄' }, quote.lines[0].items[1]] }, quote.lines[1]] };
  assert.deepEqual(cache.plan(qtyOnly.lines), []);
  // 이름·단가·품목명·사양 첫 줄을 바꾸면 그 줄만 다시 묻는다.
  const renamed = { ...quote, lines: [quote.lines[0], { ...quote.lines[1], name: 'DS1821+' }] };
  assert.deepEqual(cache.plan(renamed.lines), [1]);
  assert.deepEqual(cache.plan([{ ...quote.lines[0], unit_price: 1 }]), [0], 'the current price feeds delta, so it is part of the key');
  // 줄 순서를 바꾸면 제안도 줄을 따라간다(키는 내용이다).
  const swapped = [quote.lines[1], quote.lines[0]];
  assert.deepEqual(cache.assemble(swapped), { '0': answer['1'], '1': answer['0'], '1.1': answer['0.1'] });
  // 같은 내용의 줄이 둘이면 한 번만 묻는다.
  assert.deepEqual(cache.plan([renamed.lines[1], renamed.lines[1]]), [0]);
  // 비운 뒤 도착한 옛 응답은 버린다.
  const old = cache.generation;
  cache.invalidate();
  assert.equal(cache.store(old, [0], [keys[0]], { '0': suggestion(9) }), false);
  assert.deepEqual(cache.assemble(quote.lines), {});
  // 상한을 넘으면 오래된 것부터 지운다.
  const small = new SuggestCache(2);
  const lines = ['a', 'b', 'c'].map((name) => ({ ...quote.lines[1], name }));
  small.store(small.generation, [0, 1, 2], lines.map(lineSuggestKey), {});
  assert.deepEqual(small.plan(lines), [0]);
});

test('price helpers and the send body: blank remarks and notes go, singles lose items, groups lose qty, the view role sends no margin', () => {
  const quote = sampleQuote();
  assert.equal(emptyPriceCount(quote), 1, 'the group has no set price, so the GPU row counts');
  assert.equal(priceAt(quote, '0.0'), 3000000);
  assert.equal(priceAt(quote, '1'), 2500000);
  const changed = withPriceAt(quote, '0.1', 777);
  assert.equal(changed.lines[0].items[1].unit_price, 777);
  assert.equal(quote.lines[0].items[1].unit_price, null, 'immutable');
  const sent = quoteForSend(quote, true);
  assert.equal(sent.issue_date, null);
  assert.deepEqual(sent.remarks, ['- 3년 무상 보증']);
  assert.deepEqual(sent.lines[0].notes, ['* 확약']);
  assert.equal(sent.lines[0].qty, null);
  assert.deepEqual([sent.lines[1].items, sent.lines[1].sets], [[], null]);
  assert.deepEqual(sent.margin.buy_units, { '0.0': 2500000, '0.1': 900000 }, 'buy prices of rows that no longer exist are dropped');
  assert.equal(quoteForSend(quote, false).margin, null);
});

// ── 권한별 렌더링(§10.3) ───────────────────────────────────────────────────
const noop = () => {};
const footer = { busy: null, result: null, failure: null, confirmMessage: '', stale: false, withPdf: true, suffix: '' };
function editor(canEdit, extra = {}) {
  return renderToStaticMarkup(createElement(QuoteEditorView, {
    draft: sampleQuote(), update: noop, canEdit, showMargin: canEdit, suggestions: { '0.1': suggestion(12000000), '1': suggestion(2400000, { caution: '단가 변동이 큽니다' }) },
    suggestBusy: false, suggestError: '', onRetrySuggest: noop, customerMatches: null, staffProfiles: [], onManageStaff: noop, sourceDate: '2026-01-01', vocab: { categories: ['GPU'] },
    onApply: noop, onApplyAll: noop, onRefreshPast: noop, undo: null, onUndo: noop, onOpenSearch: noop, footer, setFooter: noop,
    onGenerate: noop, onConfirm: noop, onRegeneratePdf: noop, onDownloadFailure: noop, emptyHint: null, today: '2026-10-07', ...extra,
  }));
}

test('the edit role gets the full editor: buy price column, apply buttons, generate and confirm, filename preview', () => {
  const html = editor(true);
  assert.match(html, /매입단가/);
  assert.match(html, />적용</);
  assert.match(html, /xlsx \+ PDF 생성/);
  assert.match(html, /발송 확정/);
  assert.match(html, /빈 단가 일괄 적용/);
  assert.match(html, /견적서\(엑스디노드\)_261007_알파연구소/);
  assert.match(html, /신뢰도 보통/);
  assert.match(html, /⚠ 확인 필요/, 'caution suggestions say so instead of offering a one-click apply');
  assert.match(html, /원본 작성일 2026-01-01/);
  assert.match(html, /\+ 1줄 더/, 'long specs fold after three lines');
  assert.match(html, /⚠ 단가 미입력 1/);
  assert.doesNotMatch(html, /readOnly=""/);
});

test('the view role gets a read-only editor without margin, apply, generate, confirm or staff management (QT-Q12)', () => {
  const html = editor(false);
  for (const hidden of ['매입단가', '마진', '>적용<', 'xlsx + PDF 생성', 'xlsx 생성', '발송 확정', '견적서(엑스디노드)_', '빈 단가 일괄 적용', '담당자 관리', '+ 세트 행', '줄 삭제']) {
    assert.ok(!html.includes(hidden), `view role must not see ${hidden}`);
  }
  assert.match(html, /신뢰도 보통/, 'suggestion chips are information and stay visible (compute is read)');
  assert.match(html, /readOnly=""/);
  assert.doesNotMatch(html, /<input(?![^>]*readOnly)(?![^>]*type="checkbox")[^>]*class="quote-money/, 'every money input is read-only');
});

test('the workspace mounts the AI extraction panel, pending and staff tools for editors only', () => {
  const view = renderToStaticMarkup(createElement(QuoteWorkspace, { canEdit: false, isAdmin: false, accountId: 'acct_view', userName: '보기 사용자' }));
  assert.match(view, /보기 권한만 있습니다/);
  assert.doesNotMatch(view, /AI 추출|메일 본문|스크린샷/);
  assert.doesNotMatch(view, /role="tab"[^>]*>메일</);
  const edit = renderToStaticMarkup(createElement(QuoteWorkspace, { canEdit: true, isAdmin: false, accountId: 'acct_edit', userName: '편집 사용자' }));
  assert.match(edit, /AI 추출/);
  assert.match(edit, /메일 본문/);
  assert.match(edit, /이 칸을 누르고 Ctrl\+V/);
  assert.doesNotMatch(edit, /보기 권한만 있습니다/);
});

// ── 소스 가드 ─────────────────────────────────────────────────────────────
const uiFiles = readdirSync(path.join(root, 'app')).filter((name) => /^quote-.*\.tsx$/.test(name)).map((name) => `app/${name}`);
const clientFiles = [...uiFiles, 'app/quote-client.ts', 'app/quote-suggest-plan.ts', 'app/quote-chat-format.ts'];

test('quote screens render text nodes only, never call the local helpers, never import server modules and keep storage scoped', () => {
  assert.ok(uiFiles.length >= 6, uiFiles.join(','));
  for (const file of clientFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/, `${file}: HTML string injection`);
    assert.doesNotMatch(source, /127\.0\.0\.1|localhost:31\d\d|:3140|:3150/, `${file}: calls a local helper directly`);
    assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b/, `${file}: storage must go through readScoped/writeScoped`);
    for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
      const [, typeOnly, specifier] = match;
      assert.ok(!/quote-(server|schema|store|import|extract|xlsx|dedup|formula|xml)$/.test(specifier), `${file}: imports server module ${specifier}`);
      if (/quote-pricing$|quote-confidence$|quote-textkey$/.test(specifier)) assert.ok(typeOnly, `${file}: value import of ${specifier} (types only on the client)`);
    }
  }
});

test('the workspace re-asks only changed lines after ≥ 600 ms, handles 409 STALE on confirm, and wires the old shortcuts', () => {
  assert.ok(SUGGEST_DEBOUNCE_MS >= 600);
  const workspace = read('app/quote-workspace.tsx');
  assert.match(workspace, /action: "SUGGEST", quote: \{ customer: draftRef\.current\.customer, lines: chunk\.map\(\(index\) => lines\[index\]\) \}, lineIndexes: chunk, customers: false,/);
  assert.match(workspace, /window\.setTimeout\(\(\) => void fetchMissing\(\), SUGGEST_DEBOUNCE_MS\)/);
  assert.match(workspace, /if \(!suggestCache\.store\(generation, chunk, keys, result\.body\.suggestions\)\) break;/);
  assert.match(workspace, /result\.status === 409 && result\.body\.code === "STALE"/);
  assert.match(workspace, /action: "CONFIRM", issuedId: state\.result\.issuedId/);
  for (const code of ['"Digit1"', '"KeyG"', '"KeyP"']) assert.ok(workspace.includes(`event.code === ${code}`), code);
  assert.match(workspace, /event\.key === "\/"/);
  assert.match(workspace, /event\.key === "\?"/);
  // 권한: 편집 권한만 추출 패널·담당자·미확정 일괄을 연다(서버 403 이 최종 방어).
  assert.match(workspace, /const mailPanel = canEdit \? <QuoteAssistView/);
  assert.match(workspace, /modal === "staff" && canEdit/);
  assert.match(workspace, /modal === "pending" && canEdit/);
  assert.match(workspace, /const showMargin = canEdit \|\| isAdmin;/);
  const editorSource = read('app/quote-editor-view.tsx');
  assert.match(editorSource, /\{showMargin && <th className="num">매입단가<\/th>\}/);
  assert.match(editorSource, /}, sameLineProps\);/, 'line rows are memoized per line');
  // 추출은 서버 라우트로만, 이미지는 브라우저에서 줄여 보낸다.
  const assist = read('app/quote-assist-view.tsx');
  assert.match(assist, /quoteRequest<ExtractResult>\("\/api\/quote\/extract", "POST"/);
  assert.match(assist, /imagesToExtractInput/);
  assert.match(assist, /const MAX_IMAGES = 4;/);
});

// ── QT4: 구성 추천 패널·상담 서랍(Design §10.2·§10.3, §7.3 응답 렌더링) ─────────────────────────
const { parseChatMarkdown, parseInline, safeHref } = await import('../app/quote-chat-format.ts');
const { ChatMarkdown, QuoteRecommendPanel, QuoteChatDrawer, firstGpuSpec } = await import('../app/quote-assist-view.tsx');

test('QT4: the chat answer renderer makes React nodes only — raw HTML stays text, links are http(s) only with rel="noopener noreferrer" (old S8)', () => {
  const hostile = [
    '**결론**: 된다. `PSU 2000W` 권장',
    '<script>alert(1)</script> <img src=x onerror=alert(2)>',
    '- [제조사 자료](https://www.nvidia.com/ko-kr/data-center/) 참고',
    '- [나쁜 링크](javascript:alert(3)) · [데이터](data:text/html,<b>x</b>) · [상대](/api/quote/history)',
    '맨 주소 https://example.com/spec.pdf. 끝',
    '| 부품 | TDP |',
    '|---|---|',
    '| GPU <b>x</b> | 600W |',
    '| 구분선 없는 | 표 줄 |',
    '```',
    '<iframe src="https://evil.example"></iframe>',
    '```',
  ].join('\n');
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: hostile }));
  assert.doesNotMatch(html, /<script|<img|<iframe|<b>|<[^>]*\sonerror=/i, 'no HTML from the answer becomes markup');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>결론<\/strong>/);
  assert.match(html, /<code>PSU 2000W<\/code>/);
  const anchors = [...html.matchAll(/<a [^>]*>/g)].map(([tag]) => tag);
  assert.equal(anchors.length, 2, anchors.join('\n'));
  for (const tag of anchors) {
    assert.match(tag, /href="https:\/\//);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /target="_blank"/);
  }
  assert.ok(anchors.some((tag) => tag.includes('href="https://example.com/spec.pdf"')), 'the trailing period is not part of a bare link');
  assert.doesNotMatch(html, /href="(javascript|data|\/api)/);
  assert.match(html, /\[나쁜 링크\]\(javascript:alert\(3\)\)/, 'unsafe links stay visible as text');
  assert.match(html, /<table>.*<th>부품<\/th>.*<td>GPU &lt;b&gt;x&lt;\/b&gt;<\/td>/s);
  assert.match(html, /<pre><code>&lt;iframe/);
  // 순수 해석기: 끝나지 않는 표 줄·빈 글도 멈추지 않는다.
  assert.deepEqual(parseChatMarkdown(''), []);
  assert.equal(parseChatMarkdown('| a | b |').length, 1);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://exa mple.com'), null);
  assert.equal(safeHref('HTTPS://Example.com/a'), 'https://example.com/a');
  assert.deepEqual(parseInline('a **b** c'), [{ kind: 'text', text: 'a ' }, { kind: 'strong', text: 'b' }, { kind: 'text', text: ' c' }]);
});

test('QT4: the recommend panel and chat drawer render for editors; the view role gets neither (Design §10.3)', () => {
  const view = renderToStaticMarkup(createElement(QuoteWorkspace, { canEdit: false, isAdmin: false, accountId: 'acct_view', userName: '보기 사용자' }));
  assert.doesNotMatch(view, /견적 상담|구성 추천|quote-fab|quote-chat/);
  const edit = renderToStaticMarkup(createElement(QuoteWorkspace, { canEdit: true, isAdmin: false, accountId: 'acct_edit', userName: '편집 사용자' }));
  assert.match(edit, /aria-label="견적 상담 열기"/);
  assert.match(edit, /class="quote-chat" hidden=""/, 'the drawer starts closed');
  assert.match(edit, />구성 추천</);
  const panel = renderToStaticMarkup(createElement(QuoteRecommendPanel, { draft: sampleQuote(), room: 24, onAddLines: () => {}, onClose: () => {} }));
  assert.match(panel, /value="RTX PRO 6000"/, 'the first GPU spec fills the GPU field (old toggleRec)');
  assert.match(panel, /과거 구성 찾기/);
  assert.match(panel, /2\/3\/4장 비교/);
  assert.equal(firstGpuSpec({ lines: [] }), '');
  const drawer = renderToStaticMarkup(createElement(QuoteChatDrawer, { open: true, onToggle: () => {}, draft: sampleQuote(), accountId: 'acct_edit' }));
  assert.match(drawer, /알파연구소 · 2개 줄 · 부품 2종/);
  assert.match(drawer, /웹 검색은 하지 않습니다/);
  assert.match(drawer, /maxLength="2000"/);
});

test('QT4 source guards: no HTML injection, every link is rel="noopener noreferrer", chat/recommend go through the server routes, server prompt and recommend logic stay off the client', () => {
  const assist = read('app/quote-assist-view.tsx');
  const format = read('app/quote-chat-format.ts');
  for (const [file, source] of [['app/quote-assist-view.tsx', assist], ['app/quote-chat-format.ts', format]]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|outerHTML/, file);
  }
  const anchors = [...assist.matchAll(/<a\s[^>]*>/g)].map(([tag]) => tag);
  assert.ok(anchors.length >= 1);
  for (const tag of anchors) assert.match(tag, /rel="noopener noreferrer"/, tag);
  assert.match(assist, /href=\{part\.href\}/, 'hrefs come only from the parsed (safeHref) link parts');
  assert.match(format, /url\.protocol === "http:" \|\| url\.protocol === "https:"/);
  assert.match(assist, /quoteRequest<ChatReply>\("\/api\/quote\/chat", "POST"/);
  assert.match(assist, /quoteRequest<RecommendResult>\("\/api\/quote\/compute", "POST", \{\s*action: "RECOMMEND"/);
  assert.match(assist, /quoteRequest<VariantsResult>\("\/api\/quote\/compute", "POST", \{\s*action: "VARIANTS"/);
  assert.match(assist, /const quote = \{ \.\.\.draftRef\.current, margin: null \};/, 'the chat request carries no margin');
  assert.match(assist, /!event\.nativeEvent\.isComposing/, 'Enter while composing Hangul does not send');
  for (const file of [...clientFiles, 'app/quote-chat-format.ts']) {
    const source = read(file);
    for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
      const [, typeOnly, specifier] = match;
      assert.ok(!/quote-chat$/.test(specifier), `${file}: the chat prompt builder is server-only`);
      if (/quote-recommend$/.test(specifier)) assert.ok(typeOnly, `${file}: value import of ${specifier} (types only on the client)`);
    }
  }
  const workspace = read('app/quote-workspace.tsx');
  for (const code of ['"KeyR"', '"KeyC"']) assert.ok(workspace.includes(`event.code === ${code} && canEdit`), code);
  assert.match(workspace, /\{canEdit && <QuoteChatDrawer /);
  assert.match(workspace, /recommend=\{canEdit && recommendOpen \? \(/);
  assert.match(workspace, /onToggleRecommend=\{canEdit \? /);
  assert.match(read('app/quote-editor-view.tsx'), /\{canEdit && props\.recommend\}/);
});
