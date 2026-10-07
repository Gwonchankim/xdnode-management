// HR·임금계산 보조 어시스턴트를 Claude CLI 로 구동하는 로컬 다리.
//
// scripts/codex-assistant-bridge.mjs 를 대체한다. 요청·응답 모양과 프롬프트 규칙은 같고
// 실행 엔진만 바뀐다. Codex 다리(3110)는 더 띄우지 않지만, buildPrompt 의 원본이라 파일은 남긴다.
//
// Codex 와 다른 점 두 가지를 여기서 메운다.
//  1) Codex 의 --output-schema 같은 강제 수단이 없다 → 응답을 이 파일에서 직접 검증한다.
//     proposedActions 는 실제 ERP 를 바꾸는 변경안이라, 모양이 틀린 응답을 화면에 넘기면 안 된다.
//  2) Codex 의 --sandbox read-only 대신 도구를 모두 끈다(--tools ""). 저장소 파일은 읽지 않는다.
//     예전에는 저장소 루트에서 Read·Grep·Glob 을 켜고 돌아, 탭 권한과 상관없이 .env.local 의 비밀값과
//     직원 명부까지 읽을 수 있었다. 이제 근거는 /api/assistant 가 권한 검사를 마친 뒤 넘기는 CONTEXT JSON 뿐이다.
// Claude 실행(도구 끔·shell 없음·표준입력)과 스키마 검사 함수는 scripts/lib/claude-cli.mjs 가 맡는다(quote-tool Design §7.1). 동작은 그대로다.
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractJson, json, runClaudeText, validate } from "./lib/claude-cli.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.XD_NODE_CLAUDE_ASSISTANT_PORT || 3130);
// 저장소 경로는 시작할 때 스키마와 buildPrompt 를 읽는 데만 쓴다. Claude CLI 의 작업 폴더로는 쓰지 않는다.
const PROJECT_PATH = resolve(process.env.XD_NODE_PROJECT_PATH || process.cwd());
const SCHEMA_PATH = join(PROJECT_PATH, "scripts", "codex-assistant-response-schema.json");
const CLAUDE_BIN = process.env.XD_NODE_CLAUDE_BIN || "claude";
const MODEL = process.env.XD_NODE_CLAUDE_MODEL || "sonnet";
const EFFORT = process.env.XD_NODE_CLAUDE_EFFORT || "medium";
// 정상 호출은 ERP 서버(/api/assistant)가 이 PC 안에서 하는 서버 대 서버 요청이라 Origin 이 없다.
// Origin 이 붙은 요청은 브라우저가 직접 부른 것이므로 권한 검사를 건너뛰지 못하게 거부한다.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_MODULES = new Set(["hr", "compensation", "incentive"]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_QUESTION_LENGTH = 2000;
const MAX_CONTEXT_BYTES = 192 * 1024;
const RUN_TIMEOUT_MS = 300_000;

let activeRequest = false;

/** Codex 다리의 buildPrompt 를 원본에서 그대로 가져온다.
 *  옮겨 적으면 두 다리의 지시가 조금씩 어긋나므로, 한쪽만 고쳐도 양쪽이 같이 따라오게 한다. */
async function loadBuildPrompt() {
  // 줄바꿈이 LF 든 CRLF 든 같게 다룬다. 편집기·git 설정에 따라 달라지는 값이라 여기서 흡수한다.
  const source = (await readFile(join(PROJECT_PATH, "scripts", "codex-assistant-bridge.mjs"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("function buildPrompt(");
  const close = source.indexOf("\n}\n", start);
  if (start < 0 || close < 0) throw new Error("buildPrompt 를 찾지 못했습니다.");
  const end = close + 3;
  return new Function(`${source.slice(start, end)}; return buildPrompt;`)();
}

// 요청을 처리하는 동안에는 저장소 파일을 열지 않는다. 필요한 것은 시작할 때 한 번 메모리에 올린다.
const [buildPrompt, schema, RUN_DIRECTORY] = await Promise.all([
  loadBuildPrompt(),
  readFile(SCHEMA_PATH, "utf8").then((text) => JSON.parse(text)),
  // Claude CLI 는 이 빈 폴더에서 돈다. 저장소 안에서 돌면 CLAUDE.md·프로젝트 설정까지 딸려 온다.
  mkdtemp(join(tmpdir(), "xdnode-assistant-")),
]);

function runClaude(systemPrompt, prompt) {
  // 긴 한국어 요청이 Windows 명령줄 파서에 걸리지 않도록 표준입력으로 넘긴다(lib runClaudeText).
  return runClaudeText({
    bin: CLAUDE_BIN, model: MODEL, effort: EFFORT, systemPrompt, prompt,
    cwd: RUN_DIRECTORY,
    timeoutMs: RUN_TIMEOUT_MS,
    messages: { exit: (code, stderr) => `Claude CLI가 종료 코드 ${code}로 끝났습니다. ${stderr}` },
  });
}

const server = createServer(async (request, response) => {
  if (request.headers.origin !== undefined || !ALLOWED_HOSTS.has(String(request.headers.host ?? ""))) {
    return json(response, 403, { error: "ERP 서버만 호출할 수 있는 로컬 다리입니다." });
  }
  if (request.method === "GET" && request.url === "/health") {
    return json(response, 200, { status: "ok", engine: "claude", model: MODEL, effort: EFFORT, modules: [...ALLOWED_MODULES] });
  }
  if (request.method !== "POST" || request.url !== "/assistant") {
    return json(response, 404, { error: "지원하지 않는 경로입니다." });
  }
  if (activeRequest) return json(response, 429, { error: "이미 처리 중인 요청이 있습니다. 끝난 뒤 다시 시도해 주세요." });

  let raw = "";
  let tooLarge = false;
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) { tooLarge = true; break; }
  }
  if (tooLarge) return json(response, 413, { error: "요청이 너무 큽니다." });

  let payload;
  try { payload = JSON.parse(raw); } catch { return json(response, 400, { error: "요청 본문을 읽지 못했습니다." }); }
  const area = String(payload?.module ?? "").trim();
  const question = String(payload?.question ?? "").trim();
  const context = payload?.context ?? {};
  if (!ALLOWED_MODULES.has(area)) return json(response, 400, { error: "허용되지 않은 업무 영역입니다." });
  if (!question) return json(response, 400, { error: "질문을 입력해 주세요." });
  if (question.length > MAX_QUESTION_LENGTH) return json(response, 413, { error: "질문이 너무 깁니다." });
  if (JSON.stringify(context).length > MAX_CONTEXT_BYTES) return json(response, 413, { error: "첨부한 자료가 너무 큽니다." });

  activeRequest = true;
  try {
    const prompt = buildPrompt(area, question, context);
    const systemPrompt = [
      "출력은 오직 JSON 하나만 반환하세요. 설명, 머리말, 코드펜스를 붙이지 마세요.",
      "다음 JSON 스키마를 정확히 따르세요:",
      JSON.stringify(schema),
    ].join("\n");

    const result = await runClaude(systemPrompt, prompt);
    let parsed;
    try { parsed = JSON.parse(extractJson(result.text)); } catch {
      return json(response, 502, { error: "Claude 응답을 JSON 으로 읽지 못했습니다." });
    }
    // Codex 의 --output-schema 를 대신하는 검증. 변경안이 화면으로 넘어가기 전 마지막 관문이다.
    const errors = validate(parsed, schema);
    if (errors.length) {
      console.error(`[claude-assistant-bridge] 스키마 위반 ${errors.length}건: ${errors.slice(0, 3).join(" / ")}`);
      return json(response, 502, { error: `응답 형식이 올바르지 않습니다. (${errors[0]})` });
    }
    console.log(`[claude-assistant-bridge] ok ${result.ms}ms cost=$${result.cost ?? "?"} actions=${parsed.proposedActions.length} questions=${parsed.interviewQuestions.length}`);
    return json(response, 200, parsed);
  } catch (error) {
    console.error(`[claude-assistant-bridge] 실패: ${error instanceof Error ? error.message : error}`);
    return json(response, 502, { error: error instanceof Error ? error.message : "어시스턴트 응답에 실패했습니다." });
  } finally {
    activeRequest = false;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-assistant-bridge] http://${HOST}:${PORT} (model=${MODEL}, effort=${EFFORT})`);
});
