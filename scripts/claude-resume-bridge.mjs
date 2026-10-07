// Claude CLI 를 OpenAI 호환 /chat/completions 로 감싸는 로컬 다리.
//
// 이력서 분석 라우트는 Cloudflare Worker 안에서 돌아 프로세스를 띄울 수 없다. 그래서 이 다리를
// 127.0.0.1 에 세우고, 라우트는 평범한 HTTP 호출만 하면 되도록 모양을 맞췄다.
// scripts/codex-assistant-bridge.mjs 와 같은 틀(로컬 바인딩, 크기 상한, 한 번에 하나)이다.
// Claude 실행(도구 끔·shell 없음·표준입력)은 scripts/lib/claude-cli.mjs 가 맡는다(quote-tool Design §7.1). 동작은 그대로다.
import { createServer } from "node:http";
import { extractJson, json, readBody, runClaudeText, runClaudeVision } from "./lib/claude-cli.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.XD_NODE_CLAUDE_BRIDGE_PORT || 3120);
const CLAUDE_BIN = process.env.XD_NODE_CLAUDE_BIN || "claude";
const MODEL = process.env.XD_NODE_CLAUDE_MODEL || "sonnet";
// 실측 비교: sonnet/medium 39초 $0.144, sonnet/high 78초 $0.116, haiku/medium 49초 $0.046.
// 항목을 뽑는 일이라 high 의 추가 추론이 정확도를 올리지 못했고 시간만 배로 들었다.
const EFFORT = process.env.XD_NODE_CLAUDE_EFFORT || "medium";
// 이력서 원문이 커서 넉넉히 잡되, 무한정 받지는 않는다.
const MAX_REQUEST_BYTES = 1024 * 1024;
// 총무 서류·자산 인식(/extract, general-affairs GA-D7): 이미지 몇 장(base64)을 받으므로 따로 넉넉히 잡는다.
const MAX_EXTRACT_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACT_IMAGES = 4;
const EXTRACT_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const RUN_TIMEOUT_MS = 300_000;
// 프로젝트 밖에서 돌려야 CLAUDE.md 와 프로젝트 설정이 딸려 오지 않는다.
const RUN_CWD = process.env.TEMP || process.env.TMPDIR || process.cwd();
// CLI 는 프로젝트 폴더에서 돌면 CLAUDE.md·MCP 설정까지 시스템 프롬프트에 싣는다. 이력서에서
// 항목만 뽑는 일에는 쓸모가 없고 매번 캐시 생성 토큰만 늘어나므로, 도구와 MCP 를 끄고 돌린다(lib 의 DISABLED_TOOLS).
// 정상 호출은 ERP 서버(/api/hr/resume-analysis)가 이 PC 안에서 하는 서버 대 서버 요청이라 Origin 이 없다.
// Origin 이 붙은 요청은 브라우저가 직접 부른 것이므로 권한 검사를 건너뛰지 못하게 거부한다.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let busy = false;

async function runClaude(systemPrompt, userPrompt) {
  // 이력서 원문은 명령줄 길이 제한에 걸리므로 표준입력으로 넘긴다. 디스크에는 남기지 않는다.
  const result = await runClaudeText({
    bin: CLAUDE_BIN, model: MODEL, effort: EFFORT, systemPrompt, prompt: userPrompt, cwd: RUN_CWD, timeoutMs: RUN_TIMEOUT_MS,
    messages: { timeout: "Claude 분석 시간이 초과되었습니다.", failed: "Claude 분석에 실패했습니다." },
  });
  return { content: extractJson(result.text), usage: result.usage, cost: result.cost, ms: result.ms };
}

/** 이미지 + 글을 함께 읽힌다(general-affairs GA-D7). 이미지는 표준입력의 image 블록으로만 넘긴다(lib runClaudeVision). */
async function runVision(systemPrompt, text, images) {
  const result = await runClaudeVision({
    bin: CLAUDE_BIN, model: MODEL, effort: EFFORT, systemPrompt, text, images, cwd: RUN_CWD, timeoutMs: RUN_TIMEOUT_MS,
    messages: { timeout: "Claude 인식 시간이 초과되었습니다.", failed: "Claude 인식에 실패했습니다." },
  });
  return { content: extractJson(result.text), usage: result.usage, cost: result.cost, ms: result.ms };
}

async function handleExtract(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request, MAX_EXTRACT_BYTES));
  } catch (error) {
    json(response, 400, { error: { message: error instanceof Error ? error.message : "요청을 읽지 못했습니다." } });
    return;
  }
  const systemPrompt = String(payload?.system ?? "").trim();
  const text = String(payload?.prompt ?? "").slice(0, 60_000);
  const images = Array.isArray(payload?.images) ? payload.images : [];
  if (!systemPrompt || (!text.trim() && !images.length)) { json(response, 400, { error: { message: "인식할 내용이 없습니다." } }); return; }
  if (images.length > MAX_EXTRACT_IMAGES || images.some((image) => !EXTRACT_MEDIA_TYPES.has(image?.mediaType) || typeof image?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(image.data))) {
    json(response, 400, { error: { message: "이미지 형식을 확인해 주세요." } });
    return;
  }
  const schema = payload?.schema;
  const guard = [
    systemPrompt,
    "",
    "출력은 오직 JSON 하나만 반환하세요. 설명, 머리말, 코드펜스를 붙이지 마세요.",
    ...(schema ? ["다음 JSON 스키마를 정확히 따르세요:", JSON.stringify(schema)] : []),
  ].join("\n");
  busy = true;
  try {
    const result = await runVision(guard, text || "첨부한 이미지를 읽어 주세요.", images);
    console.log(`[claude-resume-bridge] extract ok ${result.ms}ms images=${images.length} cost=$${result.cost ?? "?"}`);
    json(response, 200, { content: result.content });
  } catch (error) {
    console.error(`[claude-resume-bridge] extract 실패: ${error instanceof Error ? error.message : error}`);
    json(response, 502, { error: { message: error instanceof Error ? error.message : "Claude 인식에 실패했습니다." } });
  } finally {
    busy = false;
  }
}

const server = createServer(async (request, response) => {
  if (request.headers.origin !== undefined || !ALLOWED_HOSTS.has(String(request.headers.host ?? ""))) {
    json(response, 403, { error: { message: "ERP 서버만 호출할 수 있는 로컬 다리입니다." } });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, model: MODEL, effort: EFFORT });
    return;
  }
  const extract = request.method === "POST" && request.url === "/extract";
  if (!extract && (request.method !== "POST" || !request.url?.startsWith("/chat/completions"))) {
    json(response, 404, { error: { message: "지원하지 않는 경로입니다." } });
    return;
  }
  if (busy) {
    json(response, 429, { error: { message: "이미 분석이 진행 중입니다. 끝난 뒤 다시 시도해 주세요." } });
    return;
  }
  if (extract) { await handleExtract(request, response); return; }

  let payload;
  try {
    payload = JSON.parse(await readBody(request, MAX_REQUEST_BYTES));
  } catch (error) {
    json(response, 400, { error: { message: error instanceof Error ? error.message : "요청을 읽지 못했습니다." } });
    return;
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const systemPrompt = String(messages.find((item) => item?.role === "system")?.content ?? "").trim();
  const userPrompt = String(messages.find((item) => item?.role === "user")?.content ?? "").trim();
  if (!userPrompt) {
    json(response, 400, { error: { message: "분석할 내용이 없습니다." } });
    return;
  }

  // 호출부가 넘긴 스키마를 시스템 프롬프트 끝에 붙여 형식을 못 박는다.
  const schema = payload?.response_format?.json_schema?.schema;
  const guard = [
    systemPrompt,
    "",
    "출력은 오직 JSON 하나만 반환하세요. 설명, 머리말, 코드펜스를 붙이지 마세요.",
    ...(schema ? ["다음 JSON 스키마를 정확히 따르세요:", JSON.stringify(schema)] : []),
  ].join("\n");

  busy = true;
  try {
    const result = await runClaude(guard, userPrompt);
    console.log(`[claude-resume-bridge] ok ${result.ms}ms cost=$${result.cost ?? "?"}`);
    json(response, 200, {
      id: `claude-${Date.now()}`,
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: result.content } }],
      usage: result.usage,
    });
  } catch (error) {
    console.error(`[claude-resume-bridge] 실패: ${error instanceof Error ? error.message : error}`);
    json(response, 502, { error: { message: error instanceof Error ? error.message : "Claude 분석에 실패했습니다." } });
  } finally {
    busy = false;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-resume-bridge] http://${HOST}:${PORT} (model=${MODEL}, effort=${EFFORT})`);
});
