// 견적 PDF 도우미(quote-tool Design §6.1, 127.0.0.1:3150). Worker 는 프로세스를 띄울 수 없어 ERP 서버(/api/quote/issued)가 이 도우미를 부른다.
//
//   GET  /health  → {ok, busy, queued, lastMs, lastError, sessionId, interactive}  (Excel 을 띄우지 않는다. sessionId·interactive 는 QT-Q8 진단용)
//   POST /pdf     본문 = xlsx, X-Quote-Sheet: <encodeURIComponent(시트명)>
//                 → 200 application/pdf (+X-Pdf-Pages) / 400 BAD_INPUT / 411 / 413(5MB) / 429 BUSY / 502 EXCEL_FAILED / 504 TIMEOUT
//
// - 브라우저가 직접 부르면 /api/* 의 권한 검사를 건너뛴다. Origin 이 붙은 요청과 이 PC 가 아닌 Host 는 403 이다(기존 브리지와 같다). CORS 없음.
// - 한 번에 하나: 실행 1 + 대기 3. 5번째는 즉시 429.
// - 작업마다 tmpdir 의 xdnode-quote-pdf-* 폴더에 in.xlsx 를 쓰고 out.pdf 를 받는다. 끝나면 폴더를 지운다.
// - 실행: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/quote-xlsx-to-pdf.ps1 (shell 없음).
//   테스트는 XD_NODE_QUOTE_PDF_RUNNER(시작 때 한 번 읽는 node 스크립트 경로)로만 실행기를 바꾼다.
// - 시간 초과 60초(Excel 기동 포함): 실행기 트리를 taskkill /T /F 로 끄고, pid 파일의 Excel 은 이름이 EXCEL 이고 작업 시작 뒤에 뜬 것만 끈다
//   (COM 서버로 뜬 Excel 은 PowerShell 의 자식이 아니라 트리 종료로 꺼지지 않는다). 시작할 때 남은 작업 폴더의 Excel 도 같은 조건으로 정리한다.
// - 로그: 시각·소요 ms·결과 코드·바이트 수만. 시트명·파일 내용은 남기지 않는다.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.XD_NODE_QUOTE_PDF_PORT || 3150);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const SCRIPT = fileURLToPath(new URL("./quote-xlsx-to-pdf.ps1", import.meta.url));
// 테스트 전용 실행기(node 스크립트). 시작할 때 한 번만 읽는다.
const RUNNER = process.env.XD_NODE_QUOTE_PDF_RUNNER || "";
// 시간 초과는 60초다. 테스트만 더 짧게 줄일 수 있다(늘릴 수는 없다).
const TIMEOUT_MS = Math.min(60_000, Math.max(100, Number(process.env.XD_NODE_QUOTE_PDF_TIMEOUT_MS) || 60_000));
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_WAITING = 3;
const WORK_PREFIX = "xdnode-quote-pdf-";
const PDF_MIME = "application/pdf";

const state = { busy: false, waiting: [], lastMs: null, lastError: null, sessionId: null, interactive: null };

function log(fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
const fail = (response, status, code, message) => json(response, status, { error: { code, message } });

/** 실행 1 + 대기 3. 자리가 없으면 null(즉시 429). */
function acquire() {
  if (!state.busy) {
    state.busy = true;
    return Promise.resolve(true);
  }
  if (state.waiting.length >= MAX_WAITING) return null;
  return new Promise((resolve) => state.waiting.push(resolve));
}
function release() {
  const next = state.waiting.shift();
  if (next) next(true);
  else state.busy = false;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** 자식 프로세스를 끝까지 기다린다(출력은 버린다: 경로·시트명이 섞일 수 있다). */
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", (chunk) => { if (output.length < 4096) output += chunk; });
    child.stderr.on("data", () => {});
    child.on("error", () => resolve({ code: -1, output }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

function killTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* 이미 끝남 */ }
    return Promise.resolve();
  }
  return run("taskkill.exe", ["/T", "/F", "/PID", String(pid)]);
}

/** pid 의 프로세스 이름·시작 시각(UTC ms). 없으면 null. */
async function processInfo(pid) {
  if (process.platform !== "win32") return null;
  const script = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`;
  const { output } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const [name, started] = output.trim().split("|");
  if (!name || !started) return null;
  return { name, startedAt: Date.parse(started) };
}

/** pid 파일의 Excel: 이름이 EXCEL 이고 notBefore(작업 시작) 뒤에 뜬 프로세스만 끈다(pid 재사용 방지). */
async function killExcelFromPidFile(pidPath, notBefore) {
  let pid = 0;
  try { pid = Number((await readFile(pidPath, "ascii")).trim()); } catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const info = await processInfo(pid);
  if (!info || info.name.toUpperCase() !== "EXCEL" || !(info.startedAt >= notBefore - 2_000)) return false;
  await run("taskkill.exe", ["/F", "/PID", String(pid)]);
  return true;
}

/** 시작할 때: 지난 실행이 남긴 작업 폴더(정지 스크립트가 변환 중에 끈 경우)의 고아 Excel 을 정리하고 폴더를 지운다. */
async function cleanupStaleWork() {
  let entries = [];
  try { entries = await readdir(tmpdir(), { withFileTypes: true }); } catch { return { folders: 0, killed: 0 }; }
  let folders = 0;
  let killed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_PREFIX)) continue;
    const dir = join(tmpdir(), entry.name);
    try {
      const info = await stat(dir);
      if (await killExcelFromPidFile(join(dir, "excel.pid"), info.birthtimeMs || info.mtimeMs)) killed += 1;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      folders += 1;
    } catch { /* 다음 기동 때 다시 */ }
  }
  return { folders, killed };
}

function countPages(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

// eslint-disable-next-line no-control-regex -- 시트명에 제어문자가 있으면 거부한다
const sheetError = (sheet) => !sheet || Array.from(sheet).length > 31 || /[\u0000-\u001f[\]:*?/\\]/.test(sheet);

/** 변환 한 건. 결과: { status, code?, pdf?, pages? } */
async function convert(xlsx, sheet) {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), WORK_PREFIX));
  const inPath = join(dir, "in.xlsx");
  const outPath = join(dir, "out.pdf");
  const pidPath = join(dir, "excel.pid");
  try {
    await writeFile(inPath, xlsx);
    const args = ["-In", inPath, "-Out", outPath, "-Sheet", sheet, "-PidFile", pidPath];
    const child = RUNNER
      ? spawn(process.execPath, [RUNNER, ...args], { windowsHide: true, cwd: dir, stdio: "ignore" })
      : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], { windowsHide: true, cwd: dir, stdio: "ignore" });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); resolve({ exitCode: -1 }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1 }); });
    });
    if (outcome.timeout) {
      await killTree(child.pid);
      await killExcelFromPidFile(pidPath, started);
      return { status: 504, code: "TIMEOUT" };
    }
    if (outcome.exitCode !== 0) return { status: 502, code: "EXCEL_FAILED", exitCode: outcome.exitCode };
    let pdf;
    try { pdf = await readFile(outPath); } catch { return { status: 502, code: "EXCEL_FAILED", exitCode: 0 }; }
    if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return { status: 502, code: "EXCEL_FAILED", exitCode: 0 };
    return { status: 200, pdf, pages: countPages(pdf) };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

const MESSAGES = {
  BAD_INPUT: "xlsx 본문과 시트명(31자 이하)을 확인해 주세요.",
  TIMEOUT: "PDF 변환 시간이 초과되었습니다.",
  EXCEL_FAILED: "Excel 이 PDF 를 만들지 못했습니다.",
  BUSY: "PDF 도우미가 다른 변환을 처리하고 있습니다.",
};

const server = createServer(async (request, response) => {
  if (request.headers.origin !== undefined || !ALLOWED_HOSTS.has(String(request.headers.host ?? ""))) {
    fail(response, 403, "FORBIDDEN", "ERP 서버만 호출할 수 있는 로컬 도우미입니다.");
    return;
  }
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && path === "/health") {
    json(response, 200, {
      ok: true, busy: state.busy, queued: state.waiting.length, lastMs: state.lastMs, lastError: state.lastError,
      sessionId: state.sessionId, interactive: state.interactive,
    });
    return;
  }
  if (path !== "/pdf") { fail(response, 404, "NOT_FOUND", "없는 경로입니다."); return; }
  if (request.method !== "POST") { fail(response, 405, "METHOD_NOT_ALLOWED", "POST 만 받습니다."); return; }

  const started = Date.now();
  const length = request.headers["content-length"];
  if (length === undefined || !/^\d{1,12}$/.test(String(length))) { fail(response, 411, "LENGTH_REQUIRED", "Content-Length 가 필요합니다."); request.resume(); return; }
  if (Number(length) > MAX_BYTES) {
    // 본문을 읽지 않는다. 응답을 보낸 뒤 연결을 닫는다.
    response.setHeader("Connection", "close");
    response.on("finish", () => request.destroy());
    fail(response, 413, "PAYLOAD_TOO_LARGE", "xlsx 는 5MB 까지 받습니다.");
    return;
  }
  let sheet = "";
  try { sheet = decodeURIComponent(String(request.headers["x-quote-sheet"] ?? "")); } catch { sheet = ""; }
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error?.code === "TOO_LARGE") fail(response, 413, "PAYLOAD_TOO_LARGE", "xlsx 는 5MB 까지 받습니다.");
    return;
  }
  if (sheetError(sheet) || body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
    fail(response, 400, "BAD_INPUT", MESSAGES.BAD_INPUT);
    log({ ms: Date.now() - started, code: "BAD_INPUT", bytes: body.length });
    return;
  }
  const slot = acquire();
  if (slot === null) {
    fail(response, 429, "BUSY", MESSAGES.BUSY);
    log({ ms: Date.now() - started, code: "BUSY", bytes: body.length });
    return;
  }
  await slot;
  try {
    const result = await convert(body, sheet);
    state.lastMs = Date.now() - started;
    state.lastError = result.status === 200 ? null : result.code;
    log({ ms: state.lastMs, code: result.code ?? "OK", bytes: body.length, pdfBytes: result.pdf?.length ?? 0, pages: result.pages ?? 0, exitCode: result.exitCode });
    if (result.status === 200) {
      response.writeHead(200, { "Content-Type": PDF_MIME, "Content-Length": result.pdf.length, "X-Pdf-Pages": String(result.pages), "Cache-Control": "no-store" });
      response.end(result.pdf);
    } else {
      fail(response, result.status, result.code, MESSAGES[result.code] ?? MESSAGES.EXCEL_FAILED);
    }
  } catch {
    state.lastError = "EXCEL_FAILED";
    log({ ms: Date.now() - started, code: "ERROR", bytes: body.length });
    if (!response.headersSent) fail(response, 502, "EXCEL_FAILED", MESSAGES.EXCEL_FAILED);
  } finally {
    release();
  }
});

/** QT-Q8 진단: 이 프로세스의 세션 id 와 대화형 여부(Excel 을 띄우지 않는다). 테스트 실행기에서는 건너뛴다. */
async function readSessionInfo() {
  if (RUNNER || process.platform !== "win32") return;
  const script = `(Get-Process -Id ${process.pid}).SessionId; [Environment]::UserInteractive`;
  const { output } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const [session, interactive] = output.trim().split(/\r?\n/);
  state.sessionId = Number.isFinite(Number(session)) ? Number(session) : null;
  state.interactive = interactive === undefined ? null : /true/i.test(interactive);
}

const cleanup = await cleanupStaleWork();
log({ code: "STALE_CLEANUP", folders: cleanup.folders, killed: cleanup.killed });
server.listen(PORT, HOST, () => {
  console.log(`[quote-pdf-helper] http://${HOST}:${PORT} (timeout=${TIMEOUT_MS}ms, runner=${RUNNER ? "test" : "excel"})`);
  readSessionInfo().catch(() => {});
});
