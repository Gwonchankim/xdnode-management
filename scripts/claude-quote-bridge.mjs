// 견적 AI 브리지(quote-tool Design §7, QT-Q7, 127.0.0.1:3140). 견적 탭의 AI 추출을 서버 PC 의 Claude CLI 로 돌린다.
//
// 견적 라우트(/api/quote/extract)는 Cloudflare Worker 안에서 돌아 프로세스를 띄울 수 없다. 라우트가 권한 확인·이미지 검사를 마친 뒤
// 이 브리지를 서버 대 서버로 부른다. 브라우저는 이 브리지를 직접 부르지 않는다.
//
// 규칙:
//  - 127.0.0.1 에만 바인딩한다. Origin 이 붙은 요청(브라우저가 직접 부른 것)과 허용 목록 밖 Host 는 403 이다. CORS 헤더는 없다.
//  - 도구를 모두 끄고(--tools "" + 차단 목록), shell 없이, 시작할 때 만든 빈 임시 폴더에서 돈다(scripts/lib/claude-cli.mjs).
//  - 이미지는 stream-json 입력의 image 블록으로 표준입력에만 넘긴다. 디스크에 쓰지 않는다.
//  - --no-session-persistence(QD-15): 고객 메일·견적이 ~/.claude/projects 기록 파일로 남지 않게 한다.
//  - 한 번에 하나(바쁨 플래그 하나, 429). 본문 16 MB, 이미지 4장. 시간 초과 300초.
//  - 모델 출력은 JSON 하나로 읽어 요청의 스키마로 검사한다. 위반이면 502 다. 라우트가 다시 정해진 칸만 거른다(app/quote-extract.ts).
//  - 로그에는 경로·소요 ms·비용·이미지 수만 남긴다. 메일 본문·이미지·결과는 남기지 않는다.
// /quote-chat(상담)은 QT4 에서 더한다. 그때도 같은 바쁨 플래그를 쓴다.
import { createServer } from "node:http";
import { BodyTooLargeError, createRunDirectory, extractJson, json, readBody, runClaudeText, runClaudeVision, validate } from "./lib/claude-cli.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.XD_NODE_CLAUDE_QUOTE_PORT || 3140);
const CLAUDE_BIN = process.env.XD_NODE_CLAUDE_BIN || "claude";
const MODEL = process.env.XD_NODE_CLAUDE_QUOTE_MODEL || "sonnet";
const EFFORT = process.env.XD_NODE_CLAUDE_QUOTE_EFFORT || "medium";
const MAX_EXTRACT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_PROMPT_CHARS = 200_000;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const RUN_TIMEOUT_MS = 300_000;
// 정상 호출은 ERP 서버(/api/quote/extract)가 이 PC 안에서 하는 서버 대 서버 요청이라 Origin 이 없다.
// Origin 이 붙은 요청은 브라우저가 직접 부른 것이므로 권한 검사를 건너뛰지 못하게 거부한다.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// Claude CLI 는 이 빈 폴더에서 돈다. 저장소 안에서 돌면 CLAUDE.md·프로젝트 설정까지 딸려 온다. 요청을 처리하는 동안 파일을 만들지 않는다.
const RUN_DIRECTORY = await createRunDirectory("xdnode-quote-");

let busy = false;

const fail = (response, status, message) => json(response, status, { error: { message } });

async function handleExtract(request, response) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_EXTRACT_BYTES) {
    // 밝힌 길이가 상한을 넘으면 읽지 않고 답한 뒤 연결을 닫는다.
    response.setHeader("Connection", "close");
    fail(response, 413, "요청이 너무 큽니다.");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(request, MAX_EXTRACT_BYTES, { drain: true }));
  } catch (error) {
    if (error instanceof BodyTooLargeError) fail(response, 413, "요청이 너무 큽니다.");
    else fail(response, 400, "요청을 읽지 못했습니다.");
    return;
  }
  const system = typeof payload?.system === "string" ? payload.system.trim() : "";
  const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  const schema = payload?.schema;
  const images = Array.isArray(payload?.images) ? payload.images : null;
  if (!system || !schema || typeof schema !== "object" || Array.isArray(schema) || images === null) { fail(response, 400, "요청 형식을 확인해 주세요."); return; }
  if (prompt.length > MAX_PROMPT_CHARS) { fail(response, 413, "요청이 너무 큽니다."); return; }
  if (!prompt.trim() && !images.length) { fail(response, 400, "읽을 내용이 없습니다."); return; }
  if (images.length > MAX_IMAGES || images.some((image) => !MEDIA_TYPES.has(image?.mediaType) || typeof image?.data !== "string" || !image.data || !/^[A-Za-z0-9+/=]+$/.test(image.data))) {
    fail(response, 400, "이미지 형식을 확인해 주세요.");
    return;
  }
  const systemPrompt = [
    system,
    "",
    "출력은 오직 JSON 하나만 반환하세요. 설명, 머리말, 코드펜스를 붙이지 마세요.",
    "다음 JSON 스키마를 정확히 따르세요:",
    JSON.stringify(schema),
  ].join("\n");
  const started = Date.now();
  try {
    const options = { bin: CLAUDE_BIN, model: MODEL, effort: EFFORT, systemPrompt, cwd: RUN_DIRECTORY, timeoutMs: RUN_TIMEOUT_MS, persist: false };
    const result = images.length
      ? await runClaudeVision({ ...options, text: prompt || "첨부한 이미지를 읽어 주세요.", images })
      : await runClaudeText({ ...options, prompt });
    let parsed;
    try { parsed = JSON.parse(extractJson(result.text)); } catch {
      console.error(`[claude-quote-bridge] /quote-extract ${Date.now() - started}ms images=${images.length} 결과가 JSON 이 아님`);
      fail(response, 502, "AI 응답을 JSON 으로 읽지 못했습니다.");
      return;
    }
    const errors = validate(parsed, schema);
    if (errors.length) {
      // 위반 내용(필드 경로)만 남긴다. 값은 남기지 않는다.
      console.error(`[claude-quote-bridge] /quote-extract 스키마 위반 ${errors.length}건`);
      fail(response, 502, "AI 응답 형식이 올바르지 않습니다.");
      return;
    }
    console.log(`[claude-quote-bridge] /quote-extract ok ${result.ms ?? Date.now() - started}ms images=${images.length} cost=$${result.cost ?? "?"}`);
    json(response, 200, { content: parsed });
  } catch (error) {
    console.error(`[claude-quote-bridge] /quote-extract 실패 ${Date.now() - started}ms images=${images.length}`);
    fail(response, 502, error instanceof Error && /시간이 초과/.test(error.message) ? "AI 응답 시간이 초과되었습니다." : "AI가 내용을 읽지 못했습니다.");
  }
}

const server = createServer(async (request, response) => {
  if (request.headers.origin !== undefined || !ALLOWED_HOSTS.has(String(request.headers.host ?? ""))) {
    json(response, 403, { error: { message: "ERP 서버만 호출할 수 있는 로컬 다리입니다." } });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, model: MODEL, effort: EFFORT, busy });
    return;
  }
  if (request.method !== "POST" || request.url !== "/quote-extract") {
    json(response, 404, { error: { message: "지원하지 않는 경로입니다." } });
    return;
  }
  if (busy) {
    request.resume();
    json(response, 429, { error: { message: "AI가 다른 요청을 처리하고 있습니다. 잠시 후 다시 눌러 주세요." } });
    return;
  }
  busy = true;
  try {
    await handleExtract(request, response);
  } finally {
    busy = false;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-quote-bridge] http://${HOST}:${PORT} (model=${MODEL}, effort=${EFFORT})`);
});
