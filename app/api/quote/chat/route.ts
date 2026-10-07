import { env } from "cloudflare:workers";
import { authorizeErpRequest, erpError, writeErpAudit } from "../../../erp-platform";
import { ensureQuoteSchema } from "../../../quote-schema";
import { CHAT_BODY_CAP, MAX_TURNS, buildChatPrompt, chatSystemPrompt, readChatMessages } from "../../../quote-chat";
import { QUOTE_LIMITS, coerceQuote, withoutMargin } from "../../../quote-model";
import { DEFAULT_QUOTE_BRIDGE_URL, loadBomLibrary, loadQuoteCatalog, quoteValidation, readJsonCapped } from "../../../quote-server";

// quote-tool Design §3.2·§7.3 POST /api/quote/chat (quote:write, QD-16). 옛 /api/chat 대응. QT-D3: 웹 검색 없이 지금 견적과 내부 자료로만 답한다.
// 화면의 견적과 최근 대화를 받아, 서버가 권한 확인 뒤 문맥(견적 요약·카탈로그 최근 단가·같은 GPU 의 과거 검증 구성)을 만들고
// 서버 PC 의 견적 AI 브리지(127.0.0.1:3140 /quote-chat, 도구 모두 끔·기록 없음·한 번에 하나)에 넘긴다. 대화는 저장하지 않는다(화면 메모리만).
// 문맥에는 견적의 margin·고객 전화·메일·담당자 블록·과거 견적 기관명을 넣지 않는다(app/quote-chat.ts).
// 감사에는 턴 수·질문 글자 수·답 글자 수만 남긴다(질문·답 본문 없음, QT-FR-16·17).
const bindings = env as unknown as { DB: D1Database; CLAUDE_QUOTE_BRIDGE_URL?: string };
const db = bindings.DB;
const BRIDGE_TIMEOUT_MS = 310_000;
const MAX_REPLY = 12_000;

const bridgeUrl = () => (bindings.CLAUDE_QUOTE_BRIDGE_URL?.trim() || DEFAULT_QUOTE_BRIDGE_URL).replace(/\/+$/, "");

export async function POST(request: Request) {
  await ensureQuoteSchema(db);
  const authorization = await authorizeErpRequest(db, "quote", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  const read = await readJsonCapped(request, CHAT_BODY_CAP);
  if (read.response) return read.response;
  const body = read.body;

  // 편집 중인 견적은 엄격 검증을 아직 통과하지 못할 수 있다. 모양만 맞추고(문맥용) 줄 수 상한만 본다. margin 은 처음부터 버린다.
  const coerced = body.quote === undefined || body.quote === null ? coerceQuote({ lines: [] }) : coerceQuote(body.quote);
  if (!coerced) return quoteValidation("견적 내용을 읽을 수 없습니다.", "quote");
  const quote = withoutMargin(coerced);
  if (quote.lines.length > QUOTE_LIMITS.lines) return quoteValidation(`품목 줄은 ${QUOTE_LIMITS.lines}줄(A~Z)까지입니다.`, "lines");
  const checked = readChatMessages(body.messages);
  if ("error" in checked) return quoteValidation(checked.error, checked.field);
  const messages = checked.messages;

  const [catalog, library] = await Promise.all([loadQuoteCatalog(db), loadBomLibrary(db)]);
  const system = chatSystemPrompt(quote, catalog, library);
  const prompt = buildChatPrompt(messages);
  let reply: string;
  try {
    const response = await fetch(`${bridgeUrl()}/quote-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, prompt }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (response.status === 429) return erpError(429, "BUSY", "AI가 다른 요청을 처리하고 있습니다. 잠시 후 다시 눌러 주세요.");
    const answer = await response.json().catch(() => ({})) as { reply?: unknown };
    if (!response.ok || !answer || typeof answer.reply !== "string" || !answer.reply.trim()) {
      return erpError(502, "AI_UNAVAILABLE", "AI가 답하지 못했습니다. 질문을 나눠 다시 물어 주세요.");
    }
    reply = answer.reply.trim().slice(0, MAX_REPLY);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return erpError(502, "AI_UNAVAILABLE", name === "TimeoutError" || name === "AbortError"
      ? "AI 응답 시간이 초과되었습니다. 질문을 더 구체적으로 나눠 물어 주세요."
      : "AI 다리(서버 PC의 Claude)에 연결하지 못했습니다.");
  }

  const question = messages[messages.length - 1].content;
  await writeErpAudit(db, {
    principal, module: "quote", action: "QUOTE_CHAT", entityType: "QUOTE_AI", entityId: "chat",
    after: { turns: Math.min(messages.length, MAX_TURNS), questionChars: question.length, replyChars: reply.length, lines: quote.lines.length },
  });
  return Response.json({ reply });
}
