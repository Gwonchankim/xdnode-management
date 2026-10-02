// 견적 Quote 모델(quote-tool Design §4.7, QD-2, 옛 툴 quote_gen/schema.py). 순수 모듈이고 import 가 없다. 클라이언트·서버가 함께 쓴다.
// 형식은 옛 툴 그대로 snake_case 다(customer.org, terms.valid_weeks, lines[].unit_price, items[].extra_categories, margin.buy_units).
// 이전한 quote_json 과 앱이 만든 행을 같은 로더(parseStoredQuote)로 읽는다. 생성 입력은 normalizeQuote(엄격)로 검사한다.
// 담당자 기본값의 실명·휴대폰(schema.py:43-46)은 옮기지 않는다(데이터는 서버 D1 에만 있다).

export type QuoteCustomer = { org: string; contact: string; tel: string | null; email: string | null };
export type QuoteTerms = { valid_weeks: number; delivery: string; payment: string; place: string; project: string | null; stamp_omitted: boolean };
export type QuoteStaff = { name: string; tel: string; email: string };
export type QuoteItem = { category: string; spec: string; qty: number | null; unit_price: number | null; extra_categories: string[] };
export type QuoteLine = {
  label: string; name: string; items: QuoteItem[]; sets: number | null; qty: number | null; unit_price: number | null; notes: string[];
};
export type QuoteMargin = { rate: number; buy_units: Record<string, number>; gpu_buy_unit: number | null; gpu_sell_unit: number | null };
export type Quote = {
  customer: QuoteCustomer; terms: QuoteTerms; staff: QuoteStaff; issue_date: string | null; lines: QuoteLine[];
  remarks: string[]; sheet_name: string; model_hint: string | null; margin: QuoteMargin | null;
};

export const QUOTE_LIMITS = {
  lines: 26, itemsPerLine: 60, items: 200, extraCategories: 6, notes: 10, remarks: 10,
  label: 40, category: 40, name: 200, spec: 4000, note: 300, remark: 300, org: 120, contact: 60, tel: 40, email: 120,
  term: 60, project: 200, modelHint: 60, staffName: 40, staffTel: 40, staffEmail: 120, sheetName: 23, buyUnits: 200,
} as const;
export const DEFAULT_REMARKS = ["- 3년 무상 보증"];
export const DEFAULT_TERMS: QuoteTerms = { valid_weeks: 1, delivery: "협의 후 결정", payment: "현금결제", place: "귀사 지정 장소", project: null, stamp_omitted: true };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const has = (object: Obj, key: string) => Object.hasOwn(object, key);

// ── 문자 정리 ────────────────────────────────────────────────────────────
/** XML 금지 문자·짝 없는 서로게이트를 지우고 줄바꿈을 \n 으로 맞춘다(§4.7 '문자'). */
export function cleanText(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}
/** 코드 포인트 길이(파이썬 len). */
export const codePoints = (value: string) => Array.from(value).length;

// ── 금액(옛 정의 그대로: `unit_price or 0` 은 || 0, `sets if not None else 1` 은 ?? 1) ──
export const isGroup = (line: QuoteLine) => line.items.length > 0;
export const itemsPriced = (line: QuoteLine) => isGroup(line) && line.items.every((item) => !item.qty || item.unit_price !== null);

export function lineAmount(line: QuoteLine) {
  if (isGroup(line)) {
    const price = line.unit_price === null && itemsPriced(line)
      ? line.items.reduce((sum, item) => sum + (item.unit_price || 0) * (item.qty || 0), 0)
      : line.unit_price || 0;
    return price * (line.sets ?? 1);
  }
  return (line.unit_price || 0) * (line.qty ?? 1);
}

export function subtotal(quote: Pick<Quote, "lines">) {
  return quote.lines.reduce((sum, line) => sum + lineAmount(line), 0);
}

/** KST 달력 날짜 'YYYY-MM-DD'(서버 시계는 UTC). */
export function kstToday(now: number) {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 엑셀 일련번호(1899-12-30 기준 일수). */
export function toExcelSerial(isoDate: string) {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// ── 엄격 검증(생성 입력, QT-FR-04) ───────────────────────────────────────
export type NormalizeResult = { ok: true; quote: Quote } | { ok: false; field: string; error: string };

class QuoteFieldError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

function str(input: Obj, key: string, field: string, label: string, max: number, fallback: string): string {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new QuoteFieldError(field, `${label} 값을 확인해 주세요.`);
  const cleaned = cleanText(value);
  if (codePoints(cleaned) > max) throw new QuoteFieldError(field, `${label}은(는) ${max}자까지입니다.`);
  return cleaned;
}
function optStr(input: Obj, key: string, field: string, label: string, max: number): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  return str(input, key, field, label, max, "");
}
function num(input: Obj, key: string, field: string, label: string, min: number, max: number, fallback: number | null): number | null {
  if (!has(input, key)) return fallback;
  const value = input[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new QuoteFieldError(field, `${label}은(는) 숫자여야 합니다.`);
  if (value < min || value > max) throw new QuoteFieldError(field, `${label}은(는) ${min}~${max} 범위여야 합니다.`);
  return value;
}
function strList(input: Obj, key: string, field: string, label: string, maxItems: number, maxLen: number, fallback: string[]): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new QuoteFieldError(field, `${label} 목록을 확인해 주세요.`);
  if (value.length > maxItems) throw new QuoteFieldError(field, `${label}은(는) ${maxItems}줄까지입니다.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new QuoteFieldError(`${field}[${index}]`, `${label} 값을 확인해 주세요.`);
    const cleaned = cleanText(entry);
    if (codePoints(cleaned) > maxLen) throw new QuoteFieldError(`${field}[${index}]`, `${label}은(는) 한 줄 ${maxLen}자까지입니다.`);
    return cleaned;
  });
}
function obj(input: Obj, key: string, field: string, label: string): Obj {
  const value = input[key];
  if (value === undefined || value === null) return {};
  if (!isObj(value)) throw new QuoteFieldError(field, `${label} 값을 확인해 주세요.`);
  return value;
}

export function sheetNameError(name: string): string | null {
  const length = codePoints(name);
  if (length < 1 || length > QUOTE_LIMITS.sheetName) return `시트명은 1~${QUOTE_LIMITS.sheetName}자입니다.`;
  if (/[[\]:*?/\\]/.test(name)) return "시트명에는 [ ] : * ? / \\ 를 쓸 수 없습니다.";
  if (name.startsWith("'") || name.endsWith("'")) return "시트명의 앞뒤에 ' 를 쓸 수 없습니다.";
  return null;
}

function normalizeStrict(raw: unknown): Quote {
  if (!isObj(raw)) throw new QuoteFieldError("quote", "견적 내용을 읽을 수 없습니다.");
  const customerIn = obj(raw, "customer", "customer", "수신자");
  const tel = optStr(customerIn, "tel", "customer.tel", "전화", QUOTE_LIMITS.tel);
  if (tel && !/^[0-9+\-() ]*$/.test(tel)) throw new QuoteFieldError("customer.tel", "전화에는 숫자와 + - ( ) 공백만 쓸 수 있습니다.");
  const customer: QuoteCustomer = {
    org: str(customerIn, "org", "customer.org", "기관명", QUOTE_LIMITS.org, ""),
    contact: str(customerIn, "contact", "customer.contact", "담당자", QUOTE_LIMITS.contact, ""),
    tel,
    email: optStr(customerIn, "email", "customer.email", "메일", QUOTE_LIMITS.email),
  };
  const termsIn = obj(raw, "terms", "terms", "거래 조건");
  const weeks = num(termsIn, "valid_weeks", "terms.valid_weeks", "견적유효기간", 1, 52, DEFAULT_TERMS.valid_weeks);
  if (weeks === null || !Number.isInteger(weeks)) throw new QuoteFieldError("terms.valid_weeks", "견적유효기간은 1~52 사이의 정수입니다.");
  const stamp = termsIn.stamp_omitted;
  if (stamp !== undefined && stamp !== null && typeof stamp !== "boolean") throw new QuoteFieldError("terms.stamp_omitted", "직인생략 값을 확인해 주세요.");
  const terms: QuoteTerms = {
    valid_weeks: weeks,
    delivery: str(termsIn, "delivery", "terms.delivery", "납품기일", QUOTE_LIMITS.term, DEFAULT_TERMS.delivery),
    payment: str(termsIn, "payment", "terms.payment", "결제조건", QUOTE_LIMITS.term, DEFAULT_TERMS.payment),
    place: str(termsIn, "place", "terms.place", "납품장소", QUOTE_LIMITS.term, DEFAULT_TERMS.place),
    project: optStr(termsIn, "project", "terms.project", "프로젝트명", QUOTE_LIMITS.project),
    stamp_omitted: typeof stamp === "boolean" ? stamp : true,
  };
  const staffIn = obj(raw, "staff", "staff", "담당자 블록");
  const staff: QuoteStaff = {
    name: str(staffIn, "name", "staff.name", "담당자 이름", QUOTE_LIMITS.staffName, ""),
    tel: str(staffIn, "tel", "staff.tel", "담당자 전화", QUOTE_LIMITS.staffTel, ""),
    email: str(staffIn, "email", "staff.email", "담당자 메일", QUOTE_LIMITS.staffEmail, ""),
  };
  const issue = raw.issue_date;
  if (issue !== undefined && issue !== null && !isRealDate(issue)) throw new QuoteFieldError("issue_date", "작성일은 2026-10-01 형식의 날짜입니다.");
  if (!Array.isArray(raw.lines) || raw.lines.length < 1) throw new QuoteFieldError("lines", "품목을 한 줄 이상 넣어 주세요.");
  if (raw.lines.length > QUOTE_LIMITS.lines) throw new QuoteFieldError("lines", `품목 줄은 ${QUOTE_LIMITS.lines}줄(A~Z)까지입니다.`);
  let itemCount = 0;
  const lines = raw.lines.map((lineIn, li): QuoteLine => {
    if (!isObj(lineIn)) throw new QuoteFieldError(`lines[${li}]`, "품목 줄을 읽을 수 없습니다.");
    const itemsIn = lineIn.items ?? [];
    if (!Array.isArray(itemsIn)) throw new QuoteFieldError(`lines[${li}].items`, "상세 품목 목록을 확인해 주세요.");
    if (itemsIn.length > QUOTE_LIMITS.itemsPerLine) throw new QuoteFieldError(`lines[${li}].items`, `한 줄의 상세 품목은 ${QUOTE_LIMITS.itemsPerLine}개까지입니다.`);
    itemCount += itemsIn.length;
    if (itemCount > QUOTE_LIMITS.items) throw new QuoteFieldError("lines", `상세 품목은 모두 ${QUOTE_LIMITS.items}개까지입니다.`);
    const items = itemsIn.map((itemIn, ii): QuoteItem => {
      const field = `lines[${li}].items[${ii}]`;
      if (!isObj(itemIn)) throw new QuoteFieldError(field, "상세 품목을 읽을 수 없습니다.");
      return {
        category: str(itemIn, "category", `${field}.category`, "품목명", QUOTE_LIMITS.category, ""),
        spec: str(itemIn, "spec", `${field}.spec`, "제품사양", QUOTE_LIMITS.spec, ""),
        qty: num(itemIn, "qty", `${field}.qty`, "수량", 0, 100_000, 1),
        unit_price: num(itemIn, "unit_price", `${field}.unit_price`, "단가", -1e12, 1e12, null),
        extra_categories: strList(itemIn, "extra_categories", `${field}.extra_categories`, "병합 품목", QUOTE_LIMITS.extraCategories, QUOTE_LIMITS.category, []),
      };
    });
    const field = `lines[${li}]`;
    return {
      label: str(lineIn, "label", `${field}.label`, "품목명", QUOTE_LIMITS.label, ""),
      name: str(lineIn, "name", `${field}.name`, "대표 모델", QUOTE_LIMITS.name, ""),
      items,
      sets: num(lineIn, "sets", `${field}.sets`, "세트 수", 0, 100_000, null),
      qty: num(lineIn, "qty", `${field}.qty`, "수량", 0, 100_000, null),
      unit_price: num(lineIn, "unit_price", `${field}.unit_price`, "단가", -1e12, 1e12, null),
      notes: strList(lineIn, "notes", `${field}.notes`, "확약 문구", QUOTE_LIMITS.notes, QUOTE_LIMITS.note, []),
    };
  });
  const sheetName = str(raw, "sheet_name", "sheet_name", "시트명", 100, "견적");
  const sheetError = sheetNameError(sheetName);
  if (sheetError) throw new QuoteFieldError("sheet_name", sheetError);
  let margin: QuoteMargin | null = null;
  if (raw.margin !== undefined && raw.margin !== null) {
    const marginIn = obj(raw, "margin", "margin", "마진");
    const rate = num(marginIn, "rate", "margin.rate", "마진율", 0, 1, 0.1);
    const buyIn = obj(marginIn, "buy_units", "margin.buy_units", "매입단가");
    const keys = Object.keys(buyIn);
    if (keys.length > QUOTE_LIMITS.buyUnits) throw new QuoteFieldError("margin.buy_units", `매입단가는 ${QUOTE_LIMITS.buyUnits}개까지입니다.`);
    const buyUnits: Record<string, number> = {};
    for (const key of keys) {
      if (!/^\d+(\.\d+)?$/.test(key)) throw new QuoteFieldError("margin.buy_units", "매입단가 위치 값을 확인해 주세요.");
      const value = num(buyIn, key, `margin.buy_units.${key}`, "매입단가", 0, 1e12, null);
      if (value !== null) buyUnits[key] = value;
    }
    margin = {
      rate: rate ?? 0.1, buy_units: buyUnits,
      gpu_buy_unit: num(marginIn, "gpu_buy_unit", "margin.gpu_buy_unit", "GPU 매입가", 0, 1e12, null),
      gpu_sell_unit: num(marginIn, "gpu_sell_unit", "margin.gpu_sell_unit", "GPU 매출가", 0, 1e12, null),
    };
  }
  return {
    customer, terms, staff, issue_date: typeof issue === "string" ? issue : null, lines,
    remarks: strList(raw, "remarks", "remarks", "비고", QUOTE_LIMITS.remarks, QUOTE_LIMITS.remark, DEFAULT_REMARKS),
    sheet_name: sheetName,
    model_hint: optStr(raw, "model_hint", "model_hint", "모델 표기", QUOTE_LIMITS.modelHint),
    margin,
  };
}

/** 생성 입력 검증·정규화(§4.7). 상한을 넘거나 형식이 다르면 { ok:false, field, error }. */
export function normalizeQuote(raw: unknown): NormalizeResult {
  try {
    return { ok: true, quote: normalizeStrict(raw) };
  } catch (error) {
    if (error instanceof QuoteFieldError) return { ok: false, field: error.field, error: error.message };
    throw error;
  }
}

// ── 관대한 로더(저장된 quote_json, 이전 데이터) ──────────────────────────────
// 옛 reverse.py 결과는 상한(줄 26·시트명 등)을 넘을 수 있다. 미리보기·불러오기는 막지 않고, 모양만 맞추고 pydantic 기본값을 채운다
// (exclude_none 으로 빠진 키는 기본값: items[].qty 가 없으면 1 — 옛 툴의 Quote.model_validate_json 과 같은 결과).
const s = (value: unknown, fallback = "") => (typeof value === "string" ? cleanText(value) : fallback);
const sn = (value: unknown) => (typeof value === "string" ? cleanText(value) : null);
const n = (value: unknown, fallback: number | null = null) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const strs = (value: unknown) => list(value).filter((entry): entry is string => typeof entry === "string").map(cleanText);

export function coerceQuote(raw: unknown): Quote | null {
  if (!isObj(raw)) return null;
  const customer = isObj(raw.customer) ? raw.customer : {};
  const terms = isObj(raw.terms) ? raw.terms : {};
  const staff = isObj(raw.staff) ? raw.staff : {};
  const marginIn = isObj(raw.margin) ? raw.margin : null;
  const weeks = n(terms.valid_weeks, DEFAULT_TERMS.valid_weeks) as number;
  return {
    customer: { org: s(customer.org), contact: s(customer.contact), tel: sn(customer.tel), email: sn(customer.email) },
    terms: {
      valid_weeks: Number.isInteger(weeks) ? weeks : DEFAULT_TERMS.valid_weeks,
      delivery: s(terms.delivery, DEFAULT_TERMS.delivery), payment: s(terms.payment, DEFAULT_TERMS.payment), place: s(terms.place, DEFAULT_TERMS.place),
      project: sn(terms.project), stamp_omitted: typeof terms.stamp_omitted === "boolean" ? terms.stamp_omitted : true,
    },
    staff: { name: s(staff.name), tel: s(staff.tel), email: s(staff.email) },
    issue_date: isRealDate(raw.issue_date) ? raw.issue_date : null,
    lines: list(raw.lines).filter(isObj).map((line) => ({
      label: s(line.label), name: s(line.name),
      items: list(line.items).filter(isObj).map((item) => ({
        category: s(item.category), spec: s(item.spec),
        qty: has(item, "qty") ? n(item.qty) : 1,
        unit_price: n(item.unit_price), extra_categories: strs(item.extra_categories),
      })),
      sets: n(line.sets), qty: n(line.qty), unit_price: n(line.unit_price), notes: strs(line.notes),
    })),
    remarks: Array.isArray(raw.remarks) ? strs(raw.remarks) : [...DEFAULT_REMARKS],
    sheet_name: s(raw.sheet_name, "견적") || "견적",
    model_hint: sn(raw.model_hint),
    margin: marginIn ? {
      rate: n(marginIn.rate, 0.1) as number,
      buy_units: Object.fromEntries(Object.entries(isObj(marginIn.buy_units) ? marginIn.buy_units : {})
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
      gpu_buy_unit: n(marginIn.gpu_buy_unit), gpu_sell_unit: n(marginIn.gpu_sell_unit),
    } : null,
  };
}

/** 저장된 quote_json 문자열 → Quote. 읽을 수 없으면 null. */
export function parseStoredQuote(json: string | null | undefined): Quote | null {
  if (!json) return null;
  try {
    return coerceQuote(JSON.parse(json));
  } catch {
    return null;
  }
}

/** 보기 권한 응답용: margin 을 지운다(QT-Q12). */
export function withoutMargin(quote: Quote): Quote {
  return { ...quote, margin: null };
}
