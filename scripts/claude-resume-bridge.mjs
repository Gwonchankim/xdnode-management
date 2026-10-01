// Claude CLI 를 OpenAI 호환 /chat/completions 로 감싸는 로컬 다리.
//
// 이력서 분석 라우트는 Cloudflare Worker 안에서 돌아 프로세스를 띄울 수 없다. 그래서 이 다리를
// 127.0.0.1 에 세우고, 라우트는 평범한 HTTP 호출만 하면 되도록 모양을 맞췄다.
// scripts/codex-assistant-bridge.mjs 와 같은 틀(로컬 바인딩, 크기 상한, 한 번에 하나)이다.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

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

// CLI 는 프로젝트 폴더에서 돌면 CLAUDE.md·MCP 설정까지 시스템 프롬프트에 싣는다. 이력서에서
// 항목만 뽑는 일에는 쓸모가 없고 매번 캐시 생성 토큰만 늘어나므로, 도구와 MCP 를 끄고 돌린다.
// --tools "" 로 내장 도구를 모두 끄고, 아래 목록은 CLI 가 --tools 를 무시하는 경우를 위한 이중 장치다.
const DISABLED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "PowerShell",
];
// 정상 호출은 ERP 서버(/api/hr/resume-analysis)가 이 PC 안에서 하는 서버 대 서버 요청이라 Origin 이 없다.
// Origin 이 붙은 요청은 브라우저가 직접 부른 것이므로 권한 검사를 건너뛰지 못하게 거부한다.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let busy = false;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("요청이 너무 큽니다."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** 모델이 앞뒤에 설명이나 코드펜스를 붙여도 JSON 본문만 건져 낸다. */
function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function runClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", MODEL,
      "--effort", EFFORT,
      "--output-format", "json",
      "--strict-mcp-config",
      "--tools", "",
      "--disallowed-tools", ...DISABLED_TOOLS,
      "--system-prompt", systemPrompt,
    ];
    // 프로젝트 밖에서 돌려야 CLAUDE.md 와 프로젝트 설정이 딸려 오지 않는다.
    // shell 을 쓰면 안 된다. Windows 에서 인자가 이스케이프 없이 이어 붙어 여러 줄짜리
    // 시스템 프롬프트가 중간에 잘린다(실제로 그래서 모델이 지시를 못 받았다).
    // claude 는 실제 실행 파일이라 셸 없이 그대로 띄울 수 있다.
    const child = spawn(CLAUDE_BIN, args, {
      cwd: process.env.TEMP || process.env.TMPDIR || process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude 분석 시간이 초과되었습니다.")); }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Claude CLI 종료 코드 ${code}. ${stderr.slice(0, 300)}`)); return; }
      let envelope;
      try { envelope = JSON.parse(stdout); } catch { reject(new Error("Claude CLI 응답을 읽지 못했습니다.")); return; }
      if (envelope.is_error) { reject(new Error(String(envelope.result || "Claude 분석에 실패했습니다."))); return; }
      resolve({ content: extractJson(envelope.result), usage: envelope.usage, cost: envelope.total_cost_usd, ms: envelope.duration_ms });
    });
    // 이력서 원문은 명령줄 길이 제한에 걸리므로 표준입력으로 넘긴다. 디스크에는 남기지 않는다.
    child.stdin.end(userPrompt, "utf8");
  });
}

/**
 * 이미지 + 글을 함께 읽힌다(general-affairs GA-D7). 도구는 똑같이 모두 끈다. 이미지는 stream-json 입력의 image 블록으로
 * 표준입력에 넘기므로 디스크에 파일을 만들지 않고, 모델이 파일 읽기 도구를 쓸 일도 없다.
 */
function runClaudeVision(systemPrompt, text, images) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", MODEL,
      "--effort", EFFORT,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--tools", "",
      "--disallowed-tools", ...DISABLED_TOOLS,
      "--system-prompt", systemPrompt,
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: process.env.TEMP || process.env.TMPDIR || process.cwd(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude 인식 시간이 초과되었습니다.")); }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Claude CLI 종료 코드 ${code}. ${stderr.slice(0, 300)}`)); return; }
      const lines = stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const result = lines.find((line) => line.type === "result");
      if (!result) { reject(new Error("Claude CLI 응답을 읽지 못했습니다.")); return; }
      if (result.is_error) { reject(new Error(String(result.result || "Claude 인식에 실패했습니다."))); return; }
      resolve({ content: extractJson(result.result), usage: result.usage, cost: result.total_cost_usd, ms: result.duration_ms });
    });
    const content = [
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text },
    ];
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, "utf8");
  });
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
    const result = await runClaudeVision(guard, text || "첨부한 이미지를 읽어 주세요.", images);
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
    payload = JSON.parse(await readBody(request));
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
