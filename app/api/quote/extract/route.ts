import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { ATTACHMENT_TYPES } from "../../../attachment-rules";
import {
  EXTRACT_BODY_CAP, EXTRACT_MAX_IMAGES, EXTRACT_MAX_INSTRUCTION, EXTRACT_MAX_TEXT, extractPrompts, filledCount, imageLooksValid, normalizeExtraction, toQuote,
  type ExtractImage,
} from "../../../quote-extract";
import { enrichExtracted } from "../../../quote-pricing";
import { DEFAULT_QUOTE_BRIDGE_URL, loadQuoteCatalog, quoteSuggestions, quoteValidation, readJsonCapped } from "../../../quote-server";

// quote-tool Design §3.2·§7.3 POST /api/quote/extract (quote:write, QD-16). 옛 /api/extract 대응.
// 고객 메일 본문·담당자 지시문·스크린샷(최대 4장)을 받아 서버 PC 의 견적 AI 브리지(127.0.0.1:3140 /quote-extract, 도구 모두 끔)에 넘기고,
// 정해진 칸만 거른 Quote 초안 + 필드별 신뢰도·확인 질문·요약 + 단가 제안·고객 후보를 돌려준다. 저장하지 않는다(사람이 '생성'을 눌러야 기록된다).
// 옛 _enrich 와 같이 고객 매칭으로 기관명·연락처를 보완하고 서버 바디 사양을 채운다(enrichExtracted).
// 감사에는 이미지 수·글자 수·채운 칸 수·질문 수만 남긴다(메일 내용·고객명 없음, QT-FR-17).
const bindings = env as unknown as { DB: D1Database; CLAUDE_QUOTE_BRIDGE_URL?: string };
const db = bindings.DB;
const BRIDGE_TIMEOUT_MS = 310_000;
/** 첨부 공용 규칙(app/attachment-rules.ts)의 미리보기 이미지 4종(png·jpeg·gif·webp)만 받는다. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([...ATTACHMENT_TYPES.values()].filter((type) => type.inline && type.contentType.startsWith("image/")).map((type) => type.contentType));

const bridgeUrl = () => (bindings.CLAUDE_QUOTE_BRIDGE_URL?.trim() || DEFAULT_QUOTE_BRIDGE_URL).replace(/\/+$/, "");

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const read = await readJsonCapped(request, EXTRACT_BODY_CAP);
  if (read.response) return read.response;
  const body = read.body;

  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") return quoteValidation("메일 본문을 확인해 주세요.", "text");
  if (body.instruction !== undefined && body.instruction !== null && typeof body.instruction !== "string") return quoteValidation("지시문을 확인해 주세요.", "instruction");
  const text = typeof body.text === "string" ? body.text : "";
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  if (text.length > EXTRACT_MAX_TEXT) return quoteValidation(`메일 본문은 ${EXTRACT_MAX_TEXT.toLocaleString("ko-KR")}자까지 읽습니다.`, "text");
  if (instruction.length > EXTRACT_MAX_INSTRUCTION) return quoteValidation(`지시문은 ${EXTRACT_MAX_INSTRUCTION.toLocaleString("ko-KR")}자까지입니다.`, "instruction");
  if (body.images !== undefined && body.images !== null && !Array.isArray(body.images)) return quoteValidation("이미지 목록을 확인해 주세요.", "images");
  const images = (Array.isArray(body.images) ? body.images : []) as ExtractImage[];
  if (images.length > EXTRACT_MAX_IMAGES) return quoteValidation(`스크린샷은 ${EXTRACT_MAX_IMAGES}장까지 읽습니다.`, "images");
  for (const [index, image] of images.entries()) {
    if (!imageLooksValid(image, IMAGE_TYPES)) return quoteValidation("이미지를 읽을 수 없습니다. PNG·JPEG·GIF·WEBP 스크린샷인지 확인해 주세요.", `images[${index}]`);
  }
  if (!text.trim() && !instruction.trim() && !images.length) return quoteValidation("메일 본문이나 스크린샷을 넣어 주세요.", "text");
  if (!text.trim() && !images.length) return quoteValidation("지시문만으로는 추출할 수 없습니다. 메일 본문이나 스크린샷을 넣어 주세요.", "text");

  const catalog = await loadQuoteCatalog(db);
  const { system, prompt, schema } = extractPrompts(catalog, text, instruction, images.length > 0);
  let content: unknown;
  try {
    const response = await fetch(`${bridgeUrl()}/quote-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, prompt, schema, images: images.map((image) => ({ mediaType: image.mediaType, data: image.data })) }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (response.status === 429) return erpError(429, "BUSY", "AI가 다른 요청을 처리하고 있습니다. 잠시 후 다시 눌러 주세요.");
    const reply = await response.json().catch(() => ({})) as { content?: unknown };
    if (!response.ok || !reply || typeof reply.content !== "object" || reply.content === null) {
      return erpError(502, "AI_UNAVAILABLE", "AI가 견적 내용을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    content = reply.content;
  } catch {
    return erpError(502, "AI_UNAVAILABLE", "AI 다리(서버 PC의 Claude)에 연결하지 못했습니다.");
  }

  // 모델 출력은 외부 입력이다(R-QT5). 정해진 칸만 → Quote → 고객·사양 보완(PII 는 서버 안에서만) → 단가 제안·고객 후보.
  const extraction = normalizeExtraction(content);
  const quote = enrichExtracted(catalog, toQuote(extraction));
  const enrich = await quoteSuggestions(db, quote, Date.now());
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_AI_EXTRACTED", entityType: "QUOTE_AI", entityId: "extract",
    after: {
      images: images.length, textChars: text.length, instructionChars: instruction.length,
      lines: quote.lines.length, filled: filledCount(extraction), questions: extraction.questions.length,
    },
  });
  return Response.json({
    quote,
    extraction: { field_notes: extraction.field_notes, questions: extraction.questions, summary: extraction.summary },
    suggestions: enrich.suggestions,
    customer_matches: enrich.customer_matches,
  });
}
