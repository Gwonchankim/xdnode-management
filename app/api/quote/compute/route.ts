import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { QUOTE_LIMITS, coerceQuote, codePoints, type Quote } from "../../../quote-model";
import { quoteSuggestions, quoteValidation, readJsonCapped } from "../../../quote-server";

// quote-tool Design §3.2·§3.5 POST /api/quote/compute (quote:read). 읽기만 하는 계산이라 감사하지 않는다(QT-Q11 예외).
//   SUGGEST    현재 화면의 견적 → {suggestions(줄 'li'·상세 'li.ii' → 23키 제안), customer_matches(상위 8)}
//              선택 칸(QT3b, 화면의 부분 갱신): lineIndexes = 보낸 줄들이 화면 견적에서 몇 번째 줄인지(0~25, 중복 없음, 줄 수와 같은 길이).
//              주면 응답 키를 그 번호로 바꿔 준다('0' → '<lineIndexes[0]>', '0.2' → '<lineIndexes[0]>.2'). 줄마다 제안은 그 줄 내용만으로
//              정해지므로 바뀐 줄만 보내도 결과가 같다. customers: false 면 고객 후보를 계산하지 않고 customer_matches 는 null 이다.
//   RECOMMEND·VARIANTS 는 QT4 에서 더한다.
// 이 파일은 tests/erp-platform.test.mjs 의 READ_ONLY_COMPUTE_ROUTES 소스 가드를 받는다: 감사·변경 문·R2·쓰기 문 빌더를 쓰지 않고,
// 허용된 모듈만 가져온다. 스키마 준비는 ensureQuoteSchema 를 이름으로만 부른다.
const db = (env as unknown as { DB: D1Database }).DB;
const BODY_CAP = 1_048_576;

/** 편집 중인 견적은 엄격 검증(normalizeQuote)을 아직 통과하지 못할 수 있다(빈 줄·전화 형식 등). 모양만 맞추고 계산량 상한만 본다. */
function readQuote(raw: unknown): { quote: Quote } | { error: Response } {
  const quote = coerceQuote(raw);
  if (!quote) return { error: quoteValidation("견적 내용을 읽을 수 없습니다.", "quote") };
  if (quote.lines.length > QUOTE_LIMITS.lines) return { error: quoteValidation(`품목 줄은 ${QUOTE_LIMITS.lines}줄(A~Z)까지입니다.`, "lines") };
  let items = 0;
  for (const [li, line] of quote.lines.entries()) {
    if (line.items.length > QUOTE_LIMITS.itemsPerLine) return { error: quoteValidation(`한 줄의 상세 품목은 ${QUOTE_LIMITS.itemsPerLine}개까지입니다.`, `lines[${li}].items`) };
    items += line.items.length;
    if (codePoints(line.name) > QUOTE_LIMITS.name || codePoints(line.label) > QUOTE_LIMITS.label) return { error: quoteValidation("품목 이름이 너무 깁니다.", `lines[${li}]`) };
    for (const [ii, item] of line.items.entries()) {
      if (codePoints(item.spec) > QUOTE_LIMITS.spec || codePoints(item.category) > QUOTE_LIMITS.category) return { error: quoteValidation("상세 품목이 너무 깁니다.", `lines[${li}].items[${ii}]`) };
    }
  }
  if (items > QUOTE_LIMITS.items) return { error: quoteValidation(`상세 품목은 모두 ${QUOTE_LIMITS.items}개까지입니다.`, "lines") };
  if (codePoints(quote.customer.org) > QUOTE_LIMITS.org || codePoints(quote.customer.contact) > QUOTE_LIMITS.contact) return { error: quoteValidation("수신자 칸이 너무 깁니다.", "customer") };
  return { quote };
}

/** lineIndexes: 없으면 null(보낸 순서 그대로). 있으면 줄 수와 같은 길이의 0~25 정수, 중복 없음. */
function readLineIndexes(raw: unknown, lineCount: number): { indexes: number[] | null } | { error: Response } {
  if (raw === undefined || raw === null) return { indexes: null };
  const valid = Array.isArray(raw) && raw.length === lineCount
    && raw.every((value) => Number.isInteger(value) && value >= 0 && value < QUOTE_LIMITS.lines)
    && new Set(raw).size === raw.length;
  if (!valid) return { error: quoteValidation("줄 번호 목록을 확인해 주세요.", "lineIndexes") };
  return { indexes: raw as number[] };
}

async function suggest(body: Record<string, unknown>) {
  const read = readQuote(body.quote);
  if ("error" in read) return read.error;
  const mapping = readLineIndexes(body.lineIndexes, read.quote.lines.length);
  if ("error" in mapping) return mapping.error;
  if (body.customers !== undefined && typeof body.customers !== "boolean") return quoteValidation("customers 는 true·false 입니다.", "customers");
  const result = await quoteSuggestions(db, read.quote, Date.now(), { customers: body.customers !== false });
  const indexes = mapping.indexes;
  if (!indexes) return Response.json(result);
  const suggestions: typeof result.suggestions = {};
  for (const [key, value] of Object.entries(result.suggestions)) {
    const [li, ii] = key.split(".");
    suggestions[ii === undefined ? String(indexes[Number(li)]) : `${indexes[Number(li)]}.${ii}`] = value;
  }
  return Response.json({ ...result, suggestions });
}

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const read = await readJsonCapped(request, BODY_CAP);
  if (read.response) return read.response;
  switch (read.body.action) {
    case "SUGGEST": return suggest(read.body);
    default: return quoteValidation("알 수 없는 요청입니다.", "action");
  }
}
