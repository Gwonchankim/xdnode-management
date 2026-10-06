// 발행 기록 재료(quote-tool Design §4.4, 옛 quote_gen/store.py:109-149·198-220). 순수 모듈(Web Crypto 만 쓴다).
// contentHash·dedupKey 는 옛 content_hash·make_dedup_key 와 같은 재료 문자열을 만든다(tests/fixtures/quote/dedup.json 으로 확인).
// priceLogRows 는 옛 _write_issued 의 단가 로그 팬아웃이다.
import { isGroup, itemsPriced, type Quote } from "./quote-model";
import { pyFloatRepr, pyStrip } from "./quote-pyfmt";
import { norm } from "./quote-textkey";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 파이썬 f"{Optional[float]}": None → "None", 숫자 → repr(float)(pydantic 이 정수 입력도 float 로 바꾼다, 실측). */
const P = (value: number | null) => (value === null ? "None" : pyFloatRepr(value));

/** 입력 JSON 의 lines[li].items[ii] 에 qty 키가 아예 없는가(pydantic 기본값 정수 1 이 그대로 남아 "1" 이 된다, 실측). */
function itemQtyMissing(raw: unknown, li: number, ii: number) {
  if (!isObj(raw) || !Array.isArray(raw.lines)) return false;
  const line = raw.lines[li];
  if (!isObj(line) || !Array.isArray(line.items)) return false;
  const item = line.items[ii];
  return isObj(item) && !Object.hasOwn(item, "qty");
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 옛 content_hash 의 재료 문자열(테스트에서 직접 비교한다). raw 는 정규화 전 입력(qty 키 존재 확인용).
 * 구분자는 옛 store.py 소스의 제어문자 그대로다: 비고는 \x01, 조각은 \x02 로 잇는다(Design §4.4 표기에서는 보이지 않는 문자라 빠져 있다).
 */
export function contentHashMaterial(quote: Quote, raw?: unknown): string {
  const parts: string[] = [];
  quote.lines.forEach((line, li) => {
    parts.push(`L|${line.label}|${line.name}|${P(line.unit_price)}|${P(line.qty)}|${P(line.sets)}`);
    line.items.forEach((item, ii) => {
      const qty = itemQtyMissing(raw, li, ii) ? "1" : P(item.qty);
      parts.push(`I|${item.category}|${item.spec}|${qty}|${P(item.unit_price)}`);
    });
  });
  parts.push(`R|${quote.remarks.join("\x01")}`);
  parts.push(`T|${quote.terms.valid_weeks}|${quote.terms.delivery}|${quote.terms.payment}`);
  return parts.join("\x02");
}

/** 옛 content_hash: 재료 문자열 sha256 앞 16자(소문자 hex). */
export async function contentHash(quote: Quote, raw?: unknown): Promise<string> {
  return (await sha256Hex(contentHashMaterial(quote, raw))).slice(0, 16);
}

/** 옛 make_dedup_key: norm("issue|org|model_hint|staff|suffix") + "#" + contentHash. staffName = 찍힌 담당자 이름(QT-Q4). */
export async function dedupKey(quote: Quote, issueDate: string, staffName: string | null, suffix: string | null, raw?: unknown): Promise<string> {
  const head = norm([issueDate, quote.customer.org || "", quote.model_hint || "", staffName || "", suffix || ""].join("|"));
  return `${head}#${await contentHash(quote, raw)}`;
}

export type PriceLogRow = { kind: "set" | "item" | "single"; category: string; name: string; name_key: string; qty: number | null; unit_price: number };

/** 옛 _write_issued 팬아웃(Design §4.4 표). 0·null 단가는 남기지 않는다(파이썬 truthiness). */
export function priceLogRows(quote: Quote): PriceLogRow[] {
  const rows: PriceLogRow[] = [];
  for (const line of quote.lines) {
    if (isGroup(line)) {
      let setPrice = line.unit_price;
      if (setPrice === null && itemsPriced(line)) setPrice = line.items.reduce((sum, item) => sum + (item.unit_price || 0) * (item.qty || 0), 0);
      if (setPrice) rows.push({ kind: "set", category: line.label, name: pyStrip(line.name), name_key: norm(line.name), qty: line.sets || 1, unit_price: setPrice });
      for (const item of line.items) {
        if (!item.unit_price) continue;
        const first = pyStrip(item.spec.split("\n")[0]);
        rows.push({ kind: "item", category: item.category, name: first, name_key: norm(first), qty: item.qty, unit_price: item.unit_price });
      }
    } else if (line.unit_price) {
      rows.push({ kind: "single", category: line.label, name: pyStrip(line.name), name_key: norm(line.name), qty: line.qty || 1, unit_price: line.unit_price });
    }
  }
  return rows;
}
