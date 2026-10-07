import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { QUOTE_LIMITS, coerceQuote, codePoints, type Quote } from "../../../quote-model";
import { recommend, toLine, variants } from "../../../quote-recommend";
import { loadBomLibrary, quoteSuggestions, quoteValidation, readJsonCapped } from "../../../quote-server";

// quote-tool Design §3.2·§3.5 POST /api/quote/compute (quote:read). 읽기만 하는 계산이라 감사하지 않는다(QT-Q11 예외).
//   SUGGEST    현재 화면의 견적 → {suggestions(줄 'li'·상세 'li.ii' → 23키 제안), customer_matches(상위 8)}
//              선택 칸(QT3b, 화면의 부분 갱신): lineIndexes = 보낸 줄들이 화면 견적에서 몇 번째 줄인지(0~25, 중복 없음, 줄 수와 같은 길이).
//              주면 응답 키를 그 번호로 바꿔 준다('0' → '<lineIndexes[0]>', '0.2' → '<lineIndexes[0]>.2'). 줄마다 제안은 그 줄 내용만으로
//              정해지므로 바뀐 줄만 보내도 결과가 같다. customers: false 면 고객 후보를 계산하지 않고 customer_matches 는 null 이다.
//   RECOMMEND  {gpu, qty?, capacity?, limit?≤10} → {recommendations:[…, line]} (옛 /api/recommend: 줄마다 toLine(rec, qty))
//   VARIANTS   {gpu, counts:int[](1~6개, 각 1~16), capacity?} → {variants:[{gpu_qty, line, source}]} (옛 /api/variants)
//              두 액션의 응답(customer·file·evidence)에는 과거 견적의 기관명·파일명이 들어간다(Design §13.3). 그래서 이 둘은
//              읽기 권한 확인 뒤 편집 권한(quote:write)을 한 번 더 확인한다. 보기 권한 화면에는 추천 패널도 없다(§10.3).
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

// ── 구성 추천(QT4, Design §4.6) ──────────────────────────────────────────
const MAX_GPU_TEXT = 200;
const optionalCount = (value: unknown, max: number) => (value === undefined || value === null ? null : Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? (value as number) : undefined);

function readGpu(value: unknown): string | Response {
  if (typeof value !== "string" || !value.trim()) return quoteValidation("GPU 모델을 입력하세요.", "gpu");
  if (codePoints(value) > MAX_GPU_TEXT) return quoteValidation(`GPU 모델은 ${MAX_GPU_TEXT}자까지입니다.`, "gpu");
  return value;
}

async function recommendAction(body: Record<string, unknown>) {
  const gpu = readGpu(body.gpu);
  if (gpu instanceof Response) return gpu;
  const qty = optionalCount(body.qty, 64);
  if (qty === undefined) return quoteValidation("장수는 1~64 사이 정수입니다.", "qty");
  const capacity = optionalCount(body.capacity, 64);
  if (capacity === undefined) return quoteValidation("증설 목표는 1~64 사이 정수입니다.", "capacity");
  const limit = optionalCount(body.limit, 10);
  if (limit === undefined) return quoteValidation("추천 개수는 1~10 사이 정수입니다.", "limit");
  const library = await loadBomLibrary(db);
  const recommendations = recommend(library, gpu, qty, capacity, limit ?? 4).map((rec) => ({ ...rec, line: toLine(rec, qty) }));
  return Response.json({ recommendations, libraryReady: library.entries.length > 0 });
}

async function variantsAction(body: Record<string, unknown>) {
  const gpu = readGpu(body.gpu);
  if (gpu instanceof Response) return gpu;
  const counts = body.counts;
  if (!Array.isArray(counts) || counts.length < 1 || counts.length > 6 || !counts.every((count) => Number.isInteger(count) && count >= 1 && count <= 16)) {
    return quoteValidation("비교할 장수는 1~16 사이 정수 1~6개입니다.", "counts");
  }
  const capacity = optionalCount(body.capacity, 64);
  if (capacity === undefined) return quoteValidation("증설 목표는 1~64 사이 정수입니다.", "capacity");
  const library = await loadBomLibrary(db);
  return Response.json({ variants: variants(library, gpu, counts as number[], capacity), libraryReady: library.entries.length > 0 });
}

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "read");
  if (authorization.response) return authorization.response;
  const read = await readJsonCapped(request, BODY_CAP);
  if (read.response) return read.response;
  switch (read.body.action) {
    case "SUGGEST": return suggest(read.body);
    case "RECOMMEND":
    case "VARIANTS": {
      // 과거 견적 기관명이 든 근거 문구를 보기 권한에 주지 않는다(Design §13.3 → 편집 권한, QD-16 과 같은 편집 보조).
      const editor = await authorizeErpRequest(db, "quote", "write");
      if (editor.response) return editor.response;
      return read.body.action === "RECOMMEND" ? recommendAction(read.body) : variantsAction(read.body);
    }
    default: return quoteValidation("알 수 없는 요청입니다.", "action");
  }
}
