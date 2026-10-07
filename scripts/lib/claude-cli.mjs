// Claude CLI 실행부 공용 모듈(quote-tool Design §7.1, QT-Q7). 3120(이력서·총무 추출)·3130(HR 어시스턴트)·3140(견적 추출)이 함께 쓴다.
//
// 규칙(D17, QT0 S5·S7):
//  - 도구를 모두 끈다: --tools "" 로 내장 도구를 끄고, CLI 가 --tools 를 무시하는 경우를 위해 아래 목록을 --disallowed-tools 로 한 번 더 막는다.
//  - MCP 설정을 읽지 않는다(--strict-mcp-config).
//  - 사용자 설정(~/.claude/settings.json)을 읽지 않는다(--setting-sources project). 서버 사용자 프로필에 깔린 플러그인·훅
//    (예: bkit)이 브리지 세션 안에서 돌아 작업 폴더에 상태 파일을 쓰고 모델 입력에 맥락을 더하던 것을 막는다(2026-10-07 실측).
//    작업 폴더는 빈 임시 폴더라 project 설정도 없다. 구독 로그인 자격 증명은 설정이 아니라서 그대로 쓴다.
//  - shell 을 쓰지 않는다. Windows 에서 인자가 이스케이프 없이 이어 붙어 여러 줄짜리 시스템 프롬프트가 잘리고 --tools 뒤의 빈 문자열 인자도 사라진다.
//  - 글은 표준입력으로 넘긴다(명령줄 길이 제한). 이미지는 stream-json 입력의 image 블록으로 표준입력에 넘기므로 디스크에 파일을 만들지 않는다.
//  - persist === false 면 --no-session-persistence 로 대화 기록(~/.claude/projects)을 디스크에 남기지 않는다(QD-15, 견적 브리지).
//    3120·3130 은 지금 동작 그대로(기본값 true = 플래그 없음)다.
//  - 환경에서 CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 를 뺀다(Claude Code 세션 안에서 띄운 브리지도 중첩 실행 차단에 걸리지 않게).
// 작업 폴더(cwd)는 호출하는 브리지가 정한다. 저장소 안에서 돌면 CLAUDE.md·프로젝트 설정까지 딸려 오므로 빈 임시 폴더를 쓴다.
// 테스트는 XD_NODE_CLAUDE_BIN 에 .mjs 가짜 실행기(tests/helpers/fake-claude.mjs)를 넣는다. .mjs/.js 실행기는 지금 Node 로 띄운다.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DISABLED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite", "Read", "Grep", "Glob", "PowerShell"];

export function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/** 본문 상한을 넘으면 이 오류로 끝난다(error.code === "TOO_LARGE"). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("요청이 너무 큽니다.");
    this.code = "TOO_LARGE";
  }
}

/**
 * 요청 본문(UTF-8 문자열). limit 을 넘으면 BodyTooLargeError.
 * 기본은 넘는 순간 연결을 끊는다(3120 의 기존 동작). drain: true 면 나머지를 읽어 버린 뒤 끝내므로 413 응답을 돌려줄 수 있다.
 */
export function readBody(request, limit, { drain = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        if (!drain) {
          reject(new BodyTooLargeError());
          request.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => (over ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", reject);
  });
}

/** 모델이 앞뒤에 설명이나 코드펜스를 붙여도 JSON 본문만 건져 낸다. */
export function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** 스키마 검사. 브리지가 쓰는 스키마는 형태가 단순해서 필요한 규칙만 직접 본다
 *  (type, enum, required, additionalProperties, items). 새 의존성을 들이지 않기 위함이다. */
export function validate(value, schema, path = "") {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number"
    ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  if (types.length) {
    const ok = types.some((type) => type === actual
      || (type === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${path || "(root)"}: ${types.join("|")} 가 필요한데 ${actual} 입니다.`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || "(root)"}: 허용되지 않은 값 ${JSON.stringify(value)}`);
  }
  if (actual === "object" && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path ? `${path}.` : ""}${key}: 필수 항목이 없습니다.`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) errors.push(`${path ? `${path}.` : ""}${key}: 허용되지 않은 항목입니다.`);
        continue;
      }
      errors.push(...validate(child, childSchema, `${path ? `${path}.` : ""}${key}`));
    }
  }
  if (actual === "array" && schema.items) {
    value.forEach((item, index) => errors.push(...validate(item, schema.items, `${path}[${index}]`)));
  }
  return errors;
}

/** 빈 임시 폴더. Claude CLI 는 이 폴더에서 돈다. */
export function createRunDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** shell 없이 띄운다. .mjs/.js 실행기(테스트 대역)는 지금 Node 로 띄운다. */
function launch(bin, args, cwd) {
  const viaNode = /\.(mjs|cjs|js)$/i.test(bin);
  return spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args, { cwd, windowsHide: true, env: cleanEnv() });
}

const DEFAULT_MESSAGES = {
  timeout: "Claude 응답 시간이 초과되었습니다.",
  exit: (code, stderr) => `Claude CLI 종료 코드 ${code}. ${stderr}`,
  unreadable: "Claude CLI 응답을 읽지 못했습니다.",
  failed: "Claude 응답에 실패했습니다.",
};

function collect(child, timeoutMs, messages, parse, resolveRun, rejectRun) {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
  const timer = setTimeout(() => { child.kill(); settle(rejectRun, new Error(messages.timeout)); }, timeoutMs);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { clearTimeout(timer); settle(rejectRun, error); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) { settle(rejectRun, new Error(messages.exit(code, stderr.slice(0, 300)))); return; }
    const envelope = parse(stdout);
    if (!envelope) { settle(rejectRun, new Error(messages.unreadable)); return; }
    if (envelope.is_error) { settle(rejectRun, new Error(String(envelope.result || messages.failed))); return; }
    settle(resolveRun, { text: envelope.result, usage: envelope.usage, cost: envelope.total_cost_usd, ms: envelope.duration_ms });
  });
  // 자식이 표준입력을 다 읽기 전에 끝나면 EPIPE 가 날 수 있다. 결과는 close 에서 판정한다.
  child.stdin.on("error", () => {});
}

/**
 * 글만 읽힌다. -p --output-format json, 결과 봉투의 result(문자열)를 text 로 돌려준다. { text, usage, cost, ms }
 * messages 로 오류 문구를 브리지마다 지금과 같게 둔다.
 */
export function runClaudeText({ bin, model, effort, systemPrompt, prompt, cwd, timeoutMs, persist = true, messages = {} }) {
  const words = { ...DEFAULT_MESSAGES, ...messages };
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      "-p",
      "--model", model,
      "--effort", effort,
      "--output-format", "json",
      "--strict-mcp-config",
      "--setting-sources", "project",
      "--tools", "",
      "--disallowed-tools", ...DISABLED_TOOLS,
      "--system-prompt", systemPrompt,
    ];
    if (persist === false) args.push("--no-session-persistence");
    const child = launch(bin, args, cwd);
    collect(child, timeoutMs, words, (stdout) => {
      try { return JSON.parse(stdout); } catch { return null; }
    }, resolveRun, rejectRun);
    child.stdin.end(prompt, "utf8");
  });
}

/**
 * 이미지 + 글을 함께 읽힌다(general-affairs GA-D7, quote-tool §7.2). 도구는 똑같이 모두 끈다. 이미지는 stream-json 입력의 image 블록으로
 * 표준입력에 넘기므로 디스크에 파일을 만들지 않고, 모델이 파일 읽기 도구를 쓸 일도 없다. { text, usage, cost, ms }
 */
export function runClaudeVision({ bin, model, effort, systemPrompt, text, images, cwd, timeoutMs, persist = true, messages = {} }) {
  const words = { ...DEFAULT_MESSAGES, ...messages };
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      "-p",
      "--model", model,
      "--effort", effort,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--setting-sources", "project",
      "--tools", "",
      "--disallowed-tools", ...DISABLED_TOOLS,
      "--system-prompt", systemPrompt,
    ];
    if (persist === false) args.push("--no-session-persistence");
    const child = launch(bin, args, cwd);
    collect(child, timeoutMs, words, (stdout) => {
      const lines = stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return lines.find((line) => line.type === "result") ?? null;
    }, resolveRun, rejectRun);
    const content = [
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text },
    ];
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, "utf8");
  });
}
