// quote-tool(Design §6.1·§11.6, QT2): 견적 PDF 도우미(scripts/quote-pdf-helper.mjs)를 임의 포트와 가짜 실행기(tests/helpers/fake-pdf-runner.mjs)로 띄워
// QH-01 Origin 403, QH-02 Host 403, QH-03 411·413, QH-04 PK 아님 400, QH-05 실행 1 + 대기 3 · 5번째 429, QH-06 시간 초과 504·실행기 종료·임시 폴더 삭제,
// QH-07 성공 응답 application/pdf·X-Pdf-Pages, QH-08 소스 가드(shell 없음, PowerShell 인자, ps1 의 경고 끔·매크로 끔·Quit·pid 이름 확인)를 본다.
// Excel 은 띄우지 않는다. 도우미의 임시 폴더(TEMP/TMP)는 테스트 전용 폴더로 돌린다(실제 도우미의 작업 폴더를 건드리지 않는다).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function call(port, { method = 'GET', pathName = '/health', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined && !chunked && finalHeaders['content-length'] === undefined) finalHeaders['content-length'] = String(body.length);
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathName, headers: finalHeaders, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const isJson = (res.headers['content-type'] ?? '').includes('json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson ? JSON.parse(buffer.toString('utf8')) : buffer });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const pdf = (port, sheet, body = PK, headers = {}) => call(port, { method: 'POST', pathName: '/pdf', body, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-quote-sheet': encodeURIComponent(sheet), ...headers } });

const work = mkdtempSync(path.join(tmpdir(), 'xdnode-quote-pdf-test-'));
const helperTemp = path.join(work, 'temp');
const runLog = path.join(work, 'runs');
mkdirSync(helperTemp);
mkdirSync(runLog);
// 지난 실행이 남긴 작업 폴더(고아 정리 대상). pid 파일은 이 테스트 프로세스(node)라 이름 확인에서 걸러져 끄지 않아야 한다.
const stale = path.join(helperTemp, 'xdnode-quote-pdf-stale1');
mkdirSync(stale);
writeFileSync(path.join(stale, 'excel.pid'), String(process.pid));
writeFileSync(path.join(stale, 'in.xlsx'), PK);

const port = await freePort();
const helper = spawn(process.execPath, [path.join(root, 'scripts', 'quote-pdf-helper.mjs')], {
  env: {
    ...process.env, TEMP: helperTemp, TMP: helperTemp, TMPDIR: helperTemp, XD_NODE_QUOTE_PDF_PORT: String(port),
    XD_NODE_QUOTE_PDF_RUNNER: path.join(root, 'tests', 'helpers', 'fake-pdf-runner.mjs'), XD_NODE_QUOTE_PDF_TIMEOUT_MS: '1500', FAKE_PDF_LOG_DIR: runLog,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let helperOutput = '';
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`helper did not start: ${helperOutput}`)), 15_000);
  helper.stdout.on('data', (chunk) => {
    helperOutput += chunk;
    if (helperOutput.includes('[quote-pdf-helper]')) { clearTimeout(timer); resolve(); }
  });
  helper.stderr.on('data', (chunk) => { helperOutput += chunk; });
  helper.on('exit', (code) => { clearTimeout(timer); reject(new Error(`helper exited ${code}: ${helperOutput}`)); });
});
test.after(() => {
  helper.kill();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const runs = () => readdirSync(runLog).map((name) => JSON.parse(readFileSync(path.join(runLog, name), 'utf8')));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const workFolders = () => readdirSync(helperTemp).filter((name) => name.startsWith('xdnode-quote-pdf-'));

test('startup cleanup removes stale work folders but only kills an EXCEL process it can attribute', () => {
  assert.equal(existsSync(stale), false, 'stale work folder removed');
  assert.ok(alive(process.pid));
  assert.match(helperOutput, /"code":"STALE_CLEANUP","folders":1,"killed":0/);
});

test('QH-01/02: requests with an Origin header or a foreign Host are refused with 403; health answers on 127.0.0.1 and localhost', async () => {
  const origin = await call(port, { headers: { origin: 'http://127.0.0.1:3000' } });
  assert.equal(origin.status, 403);
  assert.equal(origin.body.error.code, 'FORBIDDEN');
  assert.equal(origin.headers['access-control-allow-origin'], undefined);
  assert.equal((await pdf(port, 'ok', PK, { origin: 'null' })).status, 403);
  assert.equal((await call(port, { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await call(port, { headers: { host: '192.168.0.10:' + port } })).status, 403);
  const health = await call(port);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ['busy', 'interactive', 'lastError', 'lastMs', 'ok', 'queued', 'sessionId']);
  assert.equal(health.body.busy, false);
  assert.equal((await call(port, { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await call(port, { pathName: '/nope' })).status, 404);
  assert.equal((await call(port, { pathName: '/pdf' })).status, 405);
});

test('QH-03: no Content-Length is 411, more than 5 MB is 413', async () => {
  const chunked = await call(port, { method: 'POST', pathName: '/pdf', body: PK, chunked: true, headers: { 'x-quote-sheet': 'ok' } });
  assert.equal(chunked.status, 411);
  const declared = await call(port, { method: 'POST', pathName: '/pdf', headers: { 'content-length': String(5 * 1024 * 1024 + 1), 'x-quote-sheet': 'ok' } });
  assert.equal(declared.status, 413);
  assert.equal(declared.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('QH-04: a body without the PK header or a missing / over-long sheet name is 400 BAD_INPUT', async () => {
  const notZip = await pdf(port, 'ok', Buffer.from('not a zip'));
  assert.equal(notZip.status, 400);
  assert.equal(notZip.body.error.code, 'BAD_INPUT');
  assert.equal((await call(port, { method: 'POST', pathName: '/pdf', body: PK })).status, 400, 'no sheet header');
  assert.equal((await pdf(port, '가'.repeat(32))).status, 400);
  assert.equal((await pdf(port, '견적[1]')).status, 400);
  assert.equal((await pdf(port, '가'.repeat(31))).status, 200, '31 characters is the Excel limit');
  assert.ok(runs().some((run) => run.sheet === '가'.repeat(31)), 'the decoded sheet name reaches the runner as an argument');
});

test('QH-05: one runs and three wait; the fifth concurrent request is refused at once with 429', async () => {
  const before = runs().length;
  const requests = [];
  for (let index = 0; index < 5; index += 1) {
    requests.push(pdf(port, 'sleep-400'));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const health = await call(port);
  assert.equal(health.body.busy, true);
  assert.equal(health.body.queued, 3);
  const results = await Promise.all(requests);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 200, 200, 429]);
  assert.equal(results.find((result) => result.status === 429).body.error.code, 'BUSY');
  assert.equal(runs().length - before, 4, 'the refused request never reached the runner');
  assert.equal((await call(port)).body.busy, false);
});

test('QH-06: a run past the timeout is killed (504), its work folder removed', async () => {
  const before = new Set(runs().map((run) => run.pid));
  const started = Date.now();
  const result = await pdf(port, 'hang');
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, 'TIMEOUT');
  assert.ok(Date.now() - started >= 1400, 'waited for the timeout');
  const run = runs().find((entry) => !before.has(entry.pid));
  assert.ok(run, 'runner started');
  for (let attempt = 0; attempt < 20 && alive(run.pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(run.pid), false, 'runner process killed');
  assert.equal(existsSync(run.cwd), false, 'work folder removed');
  assert.equal(path.dirname(run.cwd), helperTemp);
  assert.match(path.basename(run.cwd), /^xdnode-quote-pdf-/);
  assert.equal((await call(port)).body.lastError, 'TIMEOUT');
  assert.deepEqual(workFolders(), []);
});

test('QH-07: success returns application/pdf with X-Pdf-Pages; a failing runner is 502 EXCEL_FAILED', async () => {
  const ok = await pdf(port, '견적 2EA');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/pdf');
  assert.equal(ok.headers['x-pdf-pages'], '1');
  assert.equal(ok.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(runs().some((run) => run.sheet === '견적 2EA'), 'the Korean sheet name reaches the runner');
  assert.equal((await pdf(port, 'pages-3')).headers['x-pdf-pages'], '3');
  const failed = await pdf(port, 'exit-4');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'EXCEL_FAILED');
  // 실행기는 작업 폴더를 cwd 로, 입력·출력·pid 파일을 그 안에서 받는다(시트명은 인자로만).
  const last = runs().at(-1);
  assert.equal(path.dirname(last.in), last.cwd);
  assert.deepEqual([path.basename(last.in), path.basename(last.out)], ['in.xlsx', 'out.pdf']);
  assert.deepEqual(workFolders(), []);
  // 로그에는 시트명·경로를 남기지 않는다(건수·바이트·코드만).
  assert.equal(helperOutput.includes('pages-3'), false);
  assert.equal(helperOutput.includes(helperTemp), false);
});

test('QH-08: source guards — no shell, the PowerShell flags, and the ps1 safety settings', () => {
  const helperSource = read('scripts/quote-pdf-helper.mjs');
  assert.doesNotMatch(helperSource, /shell\s*:\s*true/);
  assert.doesNotMatch(helperSource, /\bexec(Sync)?\(|execFile\(/);
  assert.match(helperSource, /spawn\("powershell\.exe", \["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, \.\.\.args\]/);
  assert.match(helperSource, /const SCRIPT = fileURLToPath\(new URL\("\.\/quote-xlsx-to-pdf\.ps1", import\.meta\.url\)\);/);
  assert.match(helperSource, /const RUNNER = process\.env\.XD_NODE_QUOTE_PDF_RUNNER \|\| "";/);
  assert.match(helperSource, /const MAX_WAITING = 3;/);
  assert.match(helperSource, /const MAX_BYTES = 5 \* 1024 \* 1024;/);
  assert.match(helperSource, /Math\.min\(60_000,/, 'the timeout can never exceed 60 s');
  assert.match(helperSource, /mkdtemp\(join\(tmpdir\(\), WORK_PREFIX\)\)/);
  assert.match(helperSource, /const WORK_PREFIX = "xdnode-quote-pdf-";/);
  assert.match(helperSource, /rm\(dir, \{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 \}\)/);
  assert.match(helperSource, /run\("taskkill\.exe", \["\/T", "\/F", "\/PID", String\(pid\)\]\)/);
  assert.match(helperSource, /info\.name\.toUpperCase\(\) !== "EXCEL"/);
  assert.doesNotMatch(helperSource, /Access-Control-Allow-Origin/);
  const ps1 = read('scripts/quote-xlsx-to-pdf.ps1');
  assert.ok(ps1.charCodeAt(0) === 0xfeff, 'ps1 is saved with a UTF-8 BOM (Windows PowerShell 5.1 reads Korean comments correctly)');
  for (const marker of ['$excel.DisplayAlerts = $false', '$excel.AutomationSecurity = 3', '$excel.Quit()', '$excel.AskToUpdateLinks = $false',
    '$excel.Workbooks.Open($In, 0, $true)', '$workbook.ExportAsFixedFormat(0, $Out)', 'GetWindowThreadProcessId', 'Set-Content -LiteralPath $PidFile',
    '$left.ProcessName -eq "EXCEL"', '$target.PageSetup.FitToPagesWide = 1', '$target.PageSetup.FitToPagesTall = 1', 'exit $code']) {
    assert.ok(ps1.includes(marker), `ps1: ${marker}`);
  }
  assert.doesNotMatch(ps1, /Write-(Host|Output)\s+.*\$(In|Out|Sheet)\b/, 'ps1 does not print paths or sheet names');
});
