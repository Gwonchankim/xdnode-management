// 단가 제안·카탈로그 매칭·고객 매칭(quote-tool Design §4.5, 옛 quote_gen/pricing.py·catalog_v2.py). 순수 모듈.
// 데이터(카탈로그·고객·단가 이력)는 인자로 받는다. DB 조회는 quote-server.ts(loadQuoteCatalog·priceHistoryMap)가 한다.
// 출력은 옛 툴의 dict 와 같은 snake_case 키다(QD-2). tests/fixtures/quote/suggest·customers.json(파이썬 출력)과 같아야 한다.
import { CANDIDATE_MIN_LEGACY, CANDIDATE_MIN_V2, CAT_PENALTY, SUGGESTION_KEYS, decide, type CatRel } from "./quote-confidence";
import { isGroup, type Quote } from "./quote-model";
import { PY_LOG_TABLE, pyRound, pySlice, pyStrip } from "./quote-pyfmt";
import { norm, prepareText, SequenceB, SequenceMatcher, slotsOf, tokens, type PreparedText } from "./quote-textkey";

// ── 입력 모양(카탈로그 원천 JSON 의 칸 이름 그대로) ─────────────────────────
export type HistoryEntry = { date?: string | null; price?: number | null; customer?: string | null; qty?: number | null; [key: string]: unknown };
export type CatalogProductInput = {
  canonical: string; category?: string | null; kind?: string | null; spellings?: string[] | null; n?: number | null;
  min?: number | null; max?: number | null; last_price?: number | null; last_date?: string | null; note?: string | null; caution?: string | null;
  history?: HistoryEntry[] | null;
};
export type LegacyProductInput = {
  name: string; category?: string | null; n?: number | null; group_ratio?: number | null; last_price?: number | null; last_price_date?: string | null;
  price_history?: HistoryEntry[] | null;
};
export type SpecInput = { name: string; spec: string };
export type CustomerInput = { org: string; contact: string | null; tel: string | null; email: string | null; last_date: string | null; n: number | null };
export type Vocab = Record<string, string[]>;

type PreparedProduct = CatalogProductInput & { kindOrPart: string; texts: PreparedText[] };
type PreparedLegacy = LegacyProductInput & { text: PreparedText };
type PreparedSpec = SpecInput & { seq: SequenceB };
type PreparedCustomer = CustomerInput & { orgSeq: SequenceB; orgNorm: string; contactKey: SequenceB | null };

/** 미리 계산한 카탈로그(서버가 버전별로 캐시한다, Design §4.5). products 는 junk 를 뺀 v2 제품(원천 순서). */
export type QuoteCatalog = {
  products: PreparedProduct[]; legacy: PreparedLegacy[]; specs: PreparedSpec[]; customers: PreparedCustomer[]; vocab: Vocab;
};

/** 옛 catalog_v2.PART_KINDS */
const PART_KINDS = new Set(["part", "service", "license"]);

export function buildQuoteCatalog(input: {
  products?: CatalogProductInput[]; legacy?: LegacyProductInput[]; specs?: SpecInput[]; customers?: CustomerInput[]; vocab?: Vocab;
}): QuoteCatalog {
  const products = (input.products ?? []).filter((product) => product.kind !== "junk").map((product) => ({
    ...product,
    kindOrPart: product.kind ?? "part",
    texts: [product.canonical, ...(product.spellings ?? []).slice(0, 6)].map(prepareText),
  }));
  const legacy = (input.legacy ?? []).map((product) => ({ ...product, text: prepareText(product.name) }));
  const specs = (input.specs ?? []).map((spec) => ({ ...spec, seq: new SequenceB(norm(spec.name)) }));
  const orgCache = new Map<string, { seq: SequenceB; norm: string }>();
  const customers = (input.customers ?? []).map((customer) => {
    let org = orgCache.get(customer.org);
    if (!org) {
      const orgNorm = norm(customer.org);
      org = { seq: new SequenceB(orgNorm), norm: orgNorm };
      orgCache.set(customer.org, org);
    }
    return { ...customer, orgSeq: org.seq, orgNorm: org.norm, contactKey: customer.contact ? new SequenceB(pySlice(norm(customer.contact), 3)) : null };
  });
  return { products, legacy, specs, customers, vocab: input.vocab ?? {} };
}

// ── 카탈로그 매칭 ───────────────────────────────────────────────────────
export type PriceHistoryOut = { date: string | null; price: number | null; customer: string | null; qty: number | null };
export type ProductMatch = {
  score: number; match_score: number; cat_rel: CatRel; contained: boolean; name: string; category: string | null; kind: string | null; n: number | null;
  last_price: number | null; last_price_date: string | null; min: number | null; max: number | null; note: string | null; caution: string | null;
  price_history: HistoryEntry[];
};

/** 두 카테고리 표기의 관계. 한쪽이라도 모르면 null — 모른다는 것이 다르다는 뜻은 아니다(옛 _cat_rel). */
export function catRel(a: string | null | undefined, b: string | null | undefined): CatRel {
  const sa = slotsOf(a);
  const sb = slotsOf(b);
  if (!sa.size || !sb.size) return null;
  for (const slot of sa) if (sb.has(slot)) return "match";
  return "mismatch";
}

/** 질의 토큰이 후보 토큰에 모두 들어 있고 모델명다운 토큰(5자 이상 + ASCII 숫자)이 있는가(옛 is_model_containment, 질의 토큰을 재사용). */
function contains(qt: Set<string>, candidate: PreparedText) {
  if (!qt.size) return false;
  for (const token of qt) if (!candidate.tokens.has(token)) return false;
  for (const token of qt) if (Array.from(token).length >= 5 && /[0-9]/.test(token)) return true;
  return false;
}

/** 옛 score_one 과 같은 식(카탈로그 후보는 미리 계산한 PreparedText). */
function score(q: string, qt: Set<string>, text: PreparedText) {
  const pt = text.tokens;
  if (!pt.size) return 0.0;
  let exact = 0;
  for (const token of qt) if (pt.has(token)) exact += 1;
  let partial = 0;
  for (const a of qt) {
    if (pt.has(a)) continue;
    const la = Array.from(a).length;
    for (const b of pt) {
      if ((b.includes(a) || a.includes(b)) && Math.min(la, Array.from(b).length) >= 3) {
        partial += 1;
        break;
      }
    }
  }
  const jac = (exact + 0.6 * partial) / (qt.size + pt.size - exact);
  const seq = new SequenceMatcher(q, text.seq).ratio();
  return 0.6 * jac + 0.4 * seq;
}

/** min(0.08, 0.02 * math.log(max(n, 1))) — n ≥ 55 는 상한(PY_LOG_TABLE, Design §4.1). */
function frequencyBonus(n: number | null | undefined) {
  const count = Math.max(typeof n === "number" ? n : 1, 1);
  if (count > PY_LOG_TABLE.length) return 0.08;
  // 원천의 n 은 정수다. 정수가 아니면(있을 수 없는 값) Math.log 로 계산한다.
  return Math.min(0.08, 0.02 * (Number.isInteger(count) ? PY_LOG_TABLE[count - 1] : Math.log(count)));
}

const sameCategory = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && pyStrip(b).toUpperCase() === pyStrip(a).toUpperCase());
const stableDesc = <T extends { s: number }>(list: T[]) => list.sort((x, y) => (x.s > y.s ? -1 : x.s < y.s ? 1 : 0));

/** 정식 제품 후보(옛 catalog_v2.match). wantGroup true 면 세트가(system)만, false 면 부품가만. */
export function matchProductV2(catalog: QuoteCatalog, name: string, category: string | null, limit: number, wantGroup: boolean | null): ProductMatch[] {
  const q = norm(name);
  if (!q) return [];
  const qt = tokens(name);
  const out: Array<{ s: number; p: PreparedProduct; rel: CatRel; held: boolean }> = [];
  for (const p of catalog.products) {
    if (wantGroup === true && p.kindOrPart !== "system") continue;
    if (wantGroup === false && !PART_KINDS.has(p.kindOrPart)) continue;
    let best = Math.max(...p.texts.map((text) => score(q, qt, text)));
    const rel = catRel(category, p.category);
    const held = p.texts.some((text) => contains(qt, text));
    if (sameCategory(category, p.category)) best += 0.05;
    else if (rel === "mismatch") best -= CAT_PENALTY;
    best += frequencyBonus(p.n);
    if (p.last_price) best += 0.04;
    if (best >= CANDIDATE_MIN_V2) out.push({ s: best, p, rel, held });
  }
  return stableDesc(out).slice(0, limit).map(({ s, p, rel, held }) => ({
    score: pyRound(s, 3), match_score: pyRound(s, 3), cat_rel: rel, contained: held,
    name: p.canonical, category: p.category ?? null, kind: p.kind ?? null, n: p.n ?? null,
    last_price: p.last_price ?? null, last_price_date: p.last_date ?? null, min: p.min ?? null, max: p.max ?? null,
    note: p.note ?? null, caution: p.caution ?? null,
    price_history: (p.history ?? []).slice(-8).map((h) => ({ date: h.date ?? null, price: h.price ?? null, customer: h.customer ?? null, qty: h.qty ?? null })),
  }));
}

/** 옛 카탈로그(표기 단위) 후보(옛 pricing.match_product 폴백). 출력 키 집합은 v2 와 같다. */
export function matchProductLegacy(catalog: QuoteCatalog, name: string, category: string | null, limit: number, wantGroup: boolean | null): ProductMatch[] {
  const q = norm(name);
  if (!q) return [];
  const qt = tokens(name);
  const out: Array<{ s: number; p: PreparedLegacy; rel: CatRel; held: boolean }> = [];
  for (const p of catalog.legacy) {
    if (!p.text.tokens.size) continue;
    const ratio = p.group_ratio ?? 0;
    if (wantGroup === true && ratio < 0.5) continue;
    if (wantGroup === false && ratio >= 0.5) continue;
    let s = score(q, qt, p.text);
    const rel = catRel(category, p.category);
    const held = contains(qt, p.text);
    if (sameCategory(category, p.category)) s += 0.05;
    else if (rel === "mismatch") s -= CAT_PENALTY;
    s += frequencyBonus(p.n);
    if (p.last_price) s += 0.04;
    if (s >= CANDIDATE_MIN_LEGACY) out.push({ s, p, rel, held });
  }
  return stableDesc(out).slice(0, limit).map(({ s, p, rel, held }) => ({
    score: pyRound(s, 3), match_score: pyRound(s, 3), cat_rel: rel, contained: held,
    name: p.name, category: p.category ?? null, kind: null, n: p.n ?? null,
    last_price: p.last_price ?? null, last_price_date: p.last_price_date ?? null, min: null, max: null, note: null, caution: null,
    price_history: (p.price_history ?? []).slice(-5),
  }));
}

/** 제품명 → 후보(점수순). 정식 카탈로그(v2, junk 제외)가 1개 이상이면 그것을, 아니면 옛 카탈로그를 쓴다(옛 catalog_v2.available()). */
export function matchProduct(catalog: QuoteCatalog, name: string, category: string | null = null, limit = 5, wantGroup: boolean | null = null): ProductMatch[] {
  return catalog.products.length ? matchProductV2(catalog, name, category, limit, wantGroup) : matchProductLegacy(catalog, name, category, limit, wantGroup);
}

// ── 날짜 ───────────────────────────────────────────────────────────────
// 옛 _age_days 의 strptime 세 형식(%Y-%m-%d, %Y.%m.%d, %y%m%d). 파이썬 _strptime 의 정규식(끝 고정 없이 match → 남은 글자가 있으면 실패)과
// 같은 대안 순서를 쓴다. (파이썬 \d 는 유니코드 숫자도 받지만 날짜 칸은 ASCII 라 [0-9] 로 둔다.)
const M = "(1[0-2]|0[1-9]|[1-9])";
const D = "(3[01]|[12][0-9]|0[1-9]|[1-9]| [1-9])";
const DATE_FORMATS: Array<{ re: RegExp; short: boolean }> = [
  { re: new RegExp(`^([0-9]{4})-${M}-${D}`), short: false },
  { re: new RegExp(`^([0-9]{4})\\.${M}\\.${D}`), short: false },
  { re: new RegExp(`^([0-9]{2})${M}${D}`), short: true },
];

function parseLegacyDate(text: string): number | null {
  for (const { re, short } of DATE_FORMATS) {
    const match = re.exec(text);
    if (!match || match[0].length !== text.length) continue;
    let year = Number(match[1]);
    if (short) year += year <= 68 ? 2000 : 1900;
    const month = Number(match[2]);
    const day = Number(match[3].trim());
    if (year < 1) continue;
    const date = new Date(Date.UTC(2000, month - 1, day));
    date.setUTCFullYear(year);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    return date.getTime();
  }
  return null;
}

/** 이력 날짜가 today(YYYY-MM-DD, KST) 기준 며칠 전인지. 형식이 어긋나면 null — 추측하지 않는다(옛 _age_days). */
export function ageDays(date: string | null | undefined, today: string): number | null {
  if (!date) return null;
  const at = parseLegacyDate(pySlice(date, 10));
  const now = parseLegacyDate(today);
  if (at === null || now === null) return null;
  return Math.round((now - at) / 86_400_000);
}

/** 파이썬 문자열 비교(코드 포인트 순). */
export function pyCompare(a: string, b: string) {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (d) return d < 0 ? -1 : 1;
  }
}

// ── 제안 병합 ───────────────────────────────────────────────────────────
/** 발행 로그 행(quote-server priceHistory 의 SELECT 모양). */
export type LiveRow = { date: string | null; price: number | null; customer: string | null; qty: number | null; kind?: string; name: string | null; status: string | null };
export type HistRow = { date: string | null; price: number | null; customer: string | null; qty: number | null; source: "issued" | "file"; status?: string | null };
export type Suggestion = {
  name: string | null; matches: ProductMatch[]; suggested: number | null; suggested_date: string | null; suggested_source: "issued" | "file" | null;
  kind: string | null; caution: string | null; note: string | null; min: number | null; max: number | null; history: HistRow[];
  confidence: "high" | "medium" | "low"; confidence_reason: string; match_score: number | null; suggested_grade: "confirmed" | "draft" | "file" | null;
  cat_rel: CatRel; gated: boolean; anchor_name: string | null; contained: boolean;
  current_price: number | null; delta: number | null; delta_pct: number | null; age_days: number | null;
};

/**
 * 카탈로그 매칭(과거 파일) + 발행 로그(신규)를 합쳐 제안 1건 + 이력(옛 _merge_suggestion).
 * 이름은 1위에서, 단가는 이력이 있는 첫 후보(앵커, FR-06)에서 가져온다. 게이트에 막힌 단가로는 delta 를 내지 않는다.
 * 결과의 키 집합이 SUGGESTION_KEYS 와 다르면 throw(옛 assert).
 */
export function mergeSuggestion(matches: ProductMatch[], live: LiveRow[], currentPrice: number | null, today: string): Suggestion | null {
  let hist: HistRow[] = live.map((h) => ({ date: h.date, price: h.price, customer: h.customer ?? null, qty: h.qty ?? null, source: "issued" as const, status: h.status ?? null }));
  const name = matches.length ? matches[0].name : null;
  const anchor = matches.find((m) => (m.price_history && m.price_history.length > 0) || m.last_price) ?? null;
  if (anchor) {
    hist = hist.concat((anchor.price_history ?? []).map((h) => ({
      date: (h.date ?? null) as string | null, price: (h.price ?? null) as number | null, customer: (h.customer ?? null) as string | null,
      qty: (h.qty ?? null) as number | null, source: "file" as const,
    })));
  }
  hist = hist.filter((h) => h.price);
  hist.sort((x, y) => pyCompare(y.date || "", x.date || ""));
  if (!hist.length && !matches.length) return null;
  const best = hist.length ? hist[0] : null;
  const prices = hist.map((h) => h.price as number);
  const top: Partial<ProductMatch> = anchor || (matches.length ? matches[0] : {});
  const verdict = decide(matches, live, hist, anchor);
  let delta: number | null = null;
  let deltaPct: number | null = null;
  let age: number | null = null;
  if (verdict.promote && best && best.price) {
    if (currentPrice) {
      delta = best.price - currentPrice;
      deltaPct = pyRound((100.0 * delta) / currentPrice, 1);
    }
    age = ageDays(best.date, today);
  }
  const promote = verdict.promote && best !== null;
  const out: Suggestion = {
    name: name || (live.length ? live[0].name : null),
    matches: matches.slice(0, 3),
    suggested: promote && best ? best.price : null,
    suggested_date: promote && best ? best.date : null,
    suggested_source: promote && best ? best.source : null,
    kind: top.kind ?? null,
    caution: top.caution ?? null,
    note: top.note ?? null,
    min: prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : null,
    max: prices.length ? prices.reduce((a, b) => (b > a ? b : a)) : null,
    history: hist.slice(0, 8),
    confidence: verdict.confidence, confidence_reason: verdict.reason,
    match_score: verdict.match_score, suggested_grade: verdict.grade,
    cat_rel: verdict.cat_rel, gated: !verdict.promote, anchor_name: verdict.anchor_name,
    contained: Boolean(top.contained),
    current_price: currentPrice, delta, delta_pct: deltaPct, age_days: age,
  };
  const keys = Object.keys(out);
  if (keys.length !== SUGGESTION_KEYS.size || !keys.every((key) => SUGGESTION_KEYS.has(key))) throw new Error("suggestion keys drifted from SUGGESTION_KEYS");
  return out;
}

export type PriceKind = "set" | "item";
/** 제안이 부를 단가 이력 조회 목록(서버가 한 번에 모아 읽는다). 이름은 원문, 키는 norm(이름). */
export function suggestionLookups(quote: Pick<Quote, "lines">): Array<{ name: string; kind: PriceKind }> {
  const out: Array<{ name: string; kind: PriceKind }> = [];
  for (const line of quote.lines) {
    out.push({ name: line.name, kind: isGroup(line) ? "set" : "item" });
    for (const item of line.items) out.push({ name: item.spec.split("\n")[0], kind: "item" });
  }
  return out;
}

/**
 * Quote 의 각 행에 대해 제안 단가·이력(옛 suggest_prices). 키는 줄 'li', 상세 'li.ii'.
 * 조건절을 두지 않는다 — 단가가 이미 채워진 행도 '지금 값이 최신 이력과 얼마나 다른지' 를 보여 준다(FR-09).
 */
export function suggestPrices(catalog: QuoteCatalog, quote: Pick<Quote, "lines">, priceHistoryOf: (name: string, kind: PriceKind) => LiveRow[], today: string): Record<string, Suggestion> {
  const out: Record<string, Suggestion> = {};
  quote.lines.forEach((line, li) => {
    const group = isGroup(line);
    const lineSuggestion = mergeSuggestion(matchProduct(catalog, line.name, line.label, 3, group), priceHistoryOf(line.name, group ? "set" : "item"), line.unit_price, today);
    if (lineSuggestion) out[String(li)] = lineSuggestion;
    line.items.forEach((item, ii) => {
      const first = item.spec.split("\n")[0];
      const itemSuggestion = mergeSuggestion(matchProduct(catalog, first, item.category, 3, false), priceHistoryOf(first, "item"), item.unit_price, today);
      if (itemSuggestion) out[`${li}.${ii}`] = itemSuggestion;
    });
  });
  return out;
}

// ── 고객·사양 ───────────────────────────────────────────────────────────
export type CustomerMatch = { org: string; score: number; contact: string | null; tel: string | null; email: string | null; last_date: string | null; n: number | null };

/**
 * 기관·담당자 → 고객 후보 상위 8(옛 match_customer). 기관 유사도(포함 또는 0.6 이상)에 담당자 앞 3글자 유사도 0.5 가중을 더한다.
 * 옛 세 번의 안정 정렬을 그대로 둔다: ① (-score, -n, last_date) ② last_date 내림차순 ③ (-score, -n).
 */
export function matchCustomer(catalog: QuoteCatalog, org: string | null | undefined, contact: string | null | undefined): CustomerMatch[] {
  const on = norm(org);
  const contactKey = contact ? pySlice(norm(contact), 3) : "";
  const orgScores = new Map<string, number | null>();
  const res: CustomerMatch[] = [];
  for (const c of catalog.customers) {
    let orgScore = orgScores.get(c.org);
    if (orgScore === undefined) {
      const ratio = new SequenceMatcher(on, c.orgSeq).ratio();
      orgScore = on && (c.orgNorm.includes(on) || ratio >= 0.6) ? ratio : null;
      orgScores.set(c.org, orgScore);
    }
    if (orgScore === null) continue;
    let cs = 0;
    if (contact && c.contact && c.contactKey) cs = new SequenceMatcher(contactKey, c.contactKey).ratio();
    res.push({ org: c.org, score: pyRound(orgScore + 0.5 * cs, 3), contact: c.contact, tel: c.tel, email: c.email, last_date: c.last_date, n: c.n });
  }
  const nOf = (x: CustomerMatch) => x.n || 0;
  res.sort((x, y) => (y.score - x.score) || (nOf(y) - nOf(x)) || pyCompare(x.last_date || "", y.last_date || ""));
  res.sort((x, y) => pyCompare(y.last_date || "", x.last_date || ""));
  res.sort((x, y) => (y.score - x.score) || (nOf(y) - nOf(x)));
  return res.slice(0, 8);
}

/** 서버 바디 모델명 → 저장된 멀티라인 사양 문구(옛 spec_for). 엄격한 > 로 최대(먼저 나온 것이 이김), 0.8 이상만. */
export function specFor(catalog: QuoteCatalog, modelName: string | null | undefined): string | null {
  const key = norm(modelName);
  let best: PreparedSpec | null = null;
  let bestScore = 0;
  for (const spec of catalog.specs) {
    const s = new SequenceMatcher(key, spec.seq).ratio();
    if (s > bestScore) {
      best = spec;
      bestScore = s;
    }
  }
  return best && bestScore >= 0.8 ? best.spec : null;
}

const CHASSIS_CATEGORIES = new Set(["chassis", "barebone", "샤시", "서버"]);

/**
 * AI 추출 결과 보완(옛 main.py api_extract 104-119행). 새 Quote 를 돌려준다(입력은 바꾸지 않는다).
 *  ① 고객 매칭 1위의 점수가 1.0 이상이면 기관명을 그 표기로 바꾸고, 전화·메일 빈칸을 채운다. 1위 담당자와 지금 담당자의 앞 두 글자(코드 포인트)가
 *     같으면 담당자도 그 표기로 바꾼다.
 *  ② 상세 중 카테고리가 chassis·barebone·샤시·서버이고 사양이 한 줄이면 저장된 멀티라인 사양 문구(사양 → 없으면 줄 이름)로 바꾼다.
 */
export function enrichExtracted(catalog: QuoteCatalog, quote: Quote): Quote {
  const customer = { ...quote.customer };
  const matches = matchCustomer(catalog, customer.org, customer.contact);
  if (matches.length && matches[0].score >= 1.0) {
    const best = matches[0];
    customer.org = best.org;
    customer.tel = customer.tel || best.tel;
    customer.email = customer.email || best.email;
    if (best.contact && customer.contact && pySlice(best.contact, 2) === pySlice(customer.contact, 2)) customer.contact = best.contact;
  }
  const lines = quote.lines.map((line) => ({
    ...line,
    items: line.items.map((item) => {
      if (!CHASSIS_CATEGORIES.has(pyStrip(item.category).toLowerCase()) || item.spec.includes("\n")) return item;
      const spec = specFor(catalog, item.spec) ?? specFor(catalog, line.name);
      return spec ? { ...item, spec } : item;
    }),
  }));
  return { ...quote, customer, lines };
}
