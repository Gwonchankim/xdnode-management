// quote-tool(Design §7·§11.6, QT3): 견적 AI 브리지(scripts/claude-quote-bridge.mjs)를 임의 포트와 가짜 claude(tests/helpers/fake-claude.mjs)로 띄워
// QB-01 Origin·Host 403, QB-02 바쁨 하나(동시 요청 429), QB-03 실행 인자(도구 끔·차단 12개·기록 없음·파일 경로 없음)·빈 작업 폴더·이미지는 표준입력에만,
// QB-04 스키마 위반 502, QB-05 413, QB-06 3120·3130 이 공용 실행부(scripts/lib/claude-cli.mjs)를 쓴다(소스)를 본다.
// QT4: QB-07 /quote-chat(도구 끔·기록 없음·시스템 프롬프트 그대로·표준입력에 대화·답 12,000자 자름·로그 web=0), QB-08 상담 입력 검사·413·빈 답 502.
// 실제 claude 는 띄우지 않는다. 브리지의 임시 폴더(TEMP/TMP)는 테스트 전용 폴더로 돌린다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function call(port, { method = 'GET', pathName = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined && finalHeaders['content-length'] === undefined && !finalHeaders['transfer-encoding']) finalHeaders['content-length'] = String(payload.length);
    if (payload !== undefined && finalHeaders['content-type'] === undefined) finalHeaders['content-type'] = 'application/json';
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathName, headers: finalHeaders, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* 글 그대로 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'images'],
  properties: { answer: { type: 'string' }, images: { type: 'integer' } },
};
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const extract = (port, body, headers = {}) => call(port, { method: 'POST', pathName: '/quote-extract', body, headers });
const request = (prompt, extra = {}) => ({ system: '견적 추출 시험입니다.', prompt, schema: SCHEMA, images: [], ...extra });
const chat = (port, body, headers = {}) => call(port, { method: 'POST', pathName: '/quote-chat', body, headers });

const work = mkdtempSync(path.join(tmpdir(), 'xdnode-quote-bridge-test-'));
const bridgeTemp = path.join(work, 'temp');
const runLog = path.join(work, 'runs');
mkdirSync(bridgeTemp);
mkdirSync(runLog);
const port = await freePort();
const bridge = spawn(process.execPath, [path.join(root, 'scripts', 'claude-quote-bridge.mjs')], {
  cwd: root,
  env: {
    ...process.env, XD_NODE_CLAUDE_QUOTE_PORT: String(port), XD_NODE_CLAUDE_BIN: path.join(root, 'tests', 'helpers', 'fake-claude.mjs'),
    FAKE_CLAUDE_LOG_DIR: runLog, TEMP: bridgeTemp, TMP: bridgeTemp, TMPDIR: bridgeTemp, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (chunk) => { bridgeLog += chunk; });
bridge.stderr.on('data', (chunk) => { bridgeLog += chunk; });
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await call(port)).status === 200) break;
  } catch { /* 아직 안 떴다 */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const runs = () => readdirSync(runLog).map((name) => JSON.parse(readFileSync(path.join(runLog, name), 'utf8')));

test.after(() => {
  bridge.kill();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('QB-01: Origin and foreign Host are refused with 403; /health answers; unknown paths are 404', async () => {
  const health = await call(port);
  assert.equal(health.status, 200, bridgeLog);
  assert.deepEqual(health.body, { ok: true, model: 'sonnet', effort: 'medium', busy: false });
  assert.equal((await call(port, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 403);
  assert.equal((await extract(port, request('mode:ok'), { origin: 'http://192.0.2.10:3000' })).status, 403);
  assert.equal((await call(port, { headers: { host: `xdnode-pc:${port}` } })).status, 403);
  assert.equal((await call(port, { headers: { host: `192.0.2.10:${port}` } })).status, 403);
  assert.equal((await call(port, { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await call(port, { method: 'POST', pathName: '/quote-chat', body: { system: 'x', prompt: 'mode:ok' }, headers: { origin: 'http://192.0.2.10:3000' } })).status, 403, 'chat refuses Origin too');
  assert.equal((await call(port, { method: 'GET', pathName: '/quote-chat' })).status, 404, 'POST only');
  assert.equal((await call(port, { method: 'POST', pathName: '/extract', body: {} })).status, 404);
  assert.equal(health.headers['access-control-allow-origin'], undefined);
});

test('QB-02: one request at a time — a second request while the first runs gets 429, then the bridge is free again', async () => {
  const first = extract(port, request('mode:sleep-900'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await call(port)).body.busy, true);
  const second = await extract(port, request('mode:ok'));
  assert.equal(second.status, 429);
  assert.match(second.body.error.message, /다른 요청/);
  assert.equal((await first).status, 200);
  assert.equal((await extract(port, request('mode:ok'))).status, 200, 'free again');
  // 추출과 상담이 바쁨 하나를 나눠 쓴다(QT4).
  const slowChat = chat(port, { system: '상담 시험', prompt: 'mode:sleep-900' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await extract(port, request('mode:ok'))).status, 429, 'extract waits for chat');
  assert.equal((await chat(port, { system: '상담 시험', prompt: 'mode:ok' })).status, 429, 'chat waits for chat');
  assert.equal((await slowChat).status, 200);
  const slowExtract = extract(port, request('mode:sleep-900'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await chat(port, { system: '상담 시험', prompt: 'mode:ok' })).status, 429, 'chat waits for extract');
  assert.equal((await slowExtract).status, 200);
});

test('QB-03: Claude runs with every tool off, no session persistence, no file paths, in an empty temp folder; images only on stdin', async () => {
  const before = new Set(readdirSync(runLog));
  const text = await extract(port, request('mode:ok 고객 메일 본문'));
  assert.equal(text.status, 200, JSON.stringify(text.body));
  assert.deepEqual(text.body, { content: { answer: 'ok', images: 0 } });
  const vision = await extract(port, request('mode:ok', { images: [{ mediaType: 'image/png', data: PNG_1PX }, { mediaType: 'image/jpeg', data: PNG_1PX }] }));
  assert.equal(vision.status, 200, JSON.stringify(vision.body));
  assert.deepEqual(vision.body, { content: { answer: 'ok', images: 2 } });
  const fenced = await extract(port, request('mode:fence'));
  assert.deepEqual(fenced.body, { content: { answer: 'fenced', images: 0 } }, 'code fences are stripped before parsing');

  const fresh = runs().filter((run) => !before.has(`run-${run.pid}.json`));
  assert.equal(fresh.length, 3);
  for (const run of fresh) {
    const { args } = run;
    assert.equal(args[0], '-p');
    const tools = args.indexOf('--tools');
    assert.ok(tools > 0 && args[tools + 1] === '', '--tools ""');
    const disallowed = args.indexOf('--disallowed-tools');
    const names = args.slice(disallowed + 1, disallowed + 13);
    assert.deepEqual([...names].sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write']);
    assert.ok(args.includes('--no-session-persistence'), 'QD-15');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), ['--model', 'sonnet', '--effort', 'medium']);
    for (const arg of args) assert.doesNotMatch(arg, /[A-Za-z]:\\|\.png|\.jpe?g|xdnode-quote-/, `no file paths in args: ${arg.slice(0, 60)}`);
    assert.ok(!args.join(' ').includes(PNG_1PX), 'images never travel in argv');
    assert.match(path.basename(run.cwd), /^xdnode-quote-/);
    assert.equal(path.dirname(run.cwd), bridgeTemp);
    assert.deepEqual(run.cwdFiles, [], 'the working folder is empty');
    assert.deepEqual(run.env, { CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null }, 'nested-session markers are removed');
    // 시스템 프롬프트 끝에 JSON 하나·스키마 지시가 붙는다.
    const system = args[args.indexOf('--system-prompt') + 1];
    assert.match(system, /^견적 추출 시험입니다\./);
    assert.ok(system.includes(JSON.stringify(SCHEMA)));
  }
  const [textRun, visionRun] = fresh.sort((a, b) => (a.stdin.length > b.stdin.length ? 1 : -1)).filter((run) => !run.stdin.includes('mode:fence'));
  assert.ok(textRun.args.includes('json') && !textRun.args.includes('stream-json'), 'text-only runs use --output-format json');
  assert.equal(textRun.stdin, 'mode:ok 고객 메일 본문');
  assert.ok(visionRun.args.includes('stream-json') && visionRun.args.includes('--verbose'));
  const message = JSON.parse(visionRun.stdin.trim());
  assert.deepEqual(message.message.content.map((block) => block.type), ['image', 'image', 'text']);
  assert.equal(message.message.content[0].source.data, PNG_1PX);
  // 실행이 끝난 뒤에도 브리지 임시 폴더에는 작업 폴더 하나만 있고, 그 안은 비어 있다.
  const folders = readdirSync(bridgeTemp);
  assert.equal(folders.length, 1);
  assert.deepEqual(readdirSync(path.join(bridgeTemp, folders[0])), []);
});

test('QB-04: output outside the schema (extra keys, wrong types) or not JSON is 502; CLI failures are 502 without echoing stderr', async () => {
  const bad = await extract(port, request('mode:bad-schema'));
  assert.equal(bad.status, 502);
  assert.doesNotMatch(JSON.stringify(bad.body), /secret|\.env/);
  assert.equal((await extract(port, request('mode:not-json'))).status, 502);
  const crashed = await extract(port, request('mode:exit-3'));
  assert.equal(crashed.status, 502);
  assert.doesNotMatch(JSON.stringify(crashed.body), /fake failure/);
  assert.equal((await call(port)).body.busy, false);
});

test('QB-05: oversized bodies are 413; malformed requests and images are 400', async () => {
  // 길이를 밝히지 않은(chunked) 큰 본문은 끝까지 읽어 버린 뒤 413, 길이를 밝힌 큰 본문은 읽기 전에 413 이다.
  const huge = await call(port, { method: 'POST', pathName: '/quote-extract', body: Buffer.alloc(16 * 1024 * 1024 + 16, 0x20), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(huge.status, 413);
  const declared = await call(port, { method: 'POST', pathName: '/quote-extract', body: '{}', headers: { 'content-length': String(16 * 1024 * 1024 + 1) } });
  assert.equal(declared.status, 413);
  assert.equal((await extract(port, request('x'.repeat(200_001)))).status, 413, 'prompt over 200,000 chars');
  assert.equal((await extract(port, '{not json')).status, 400);
  assert.equal((await extract(port, request('mode:ok', { schema: undefined }))).status, 400, 'schema is required');
  assert.equal((await extract(port, request('', { images: [] }))).status, 400, 'nothing to read');
  const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PNG_1PX }));
  assert.equal((await extract(port, request('mode:ok', { images: five }))).status, 400);
  assert.equal((await extract(port, request('mode:ok', { images: [{ mediaType: 'image/svg+xml', data: PNG_1PX }] }))).status, 400);
  assert.equal((await extract(port, request('mode:ok', { images: [{ mediaType: 'image/png', data: 'not base64!' }] }))).status, 400);
  assert.equal((await call(port)).body.busy, false);
});

test('QB-06: the resume (3120) and assistant (3130) bridges run Claude through scripts/lib/claude-cli.mjs and keep their own guards', () => {
  for (const file of ['scripts/claude-resume-bridge.mjs', 'scripts/claude-assistant-bridge.mjs', 'scripts/claude-quote-bridge.mjs']) {
    const source = read(file);
    assert.match(source, /from "\.\/lib\/claude-cli\.mjs";/, file);
    assert.doesNotMatch(source, /node:child_process|spawn\(/, file);
    assert.match(source, /const HOST = "127\.0\.0\.1"/, file);
    assert.match(source, /request\.headers\.origin !== undefined \|\| !ALLOWED_HOSTS\.has\(String\(request\.headers\.host \?\? ""\)\)/, file);
  }
  // 3120·3130 은 기록을 남기는 기본 동작 그대로(persist 를 넘기지 않는다), 3140 만 끈다(QD-15).
  assert.doesNotMatch(read('scripts/claude-resume-bridge.mjs'), /persist/);
  assert.doesNotMatch(read('scripts/claude-assistant-bridge.mjs'), /persist/);
  assert.match(read('scripts/claude-quote-bridge.mjs'), /persist: false/);
});

test('QB-07: /quote-chat runs Claude as text with every tool off and no persistence; the system prompt goes as is, the conversation on stdin; long answers are cut at 12,000', async () => {
  const before = new Set(readdirSync(runLog));
  const system = '견적 상담 시험입니다.\n<quote_data>\n[A] Server\n</quote_data>';
  const prompt = '<이전 대화>\n담당자: 첫 질문\n</이전 대화>\n\n담당자의 새 질문: mode:ok 웹에서 찾아 줘';
  const answer = await chat(port, { system, prompt });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reply: JSON.stringify({ answer: 'ok', images: 0 }) }, 'the reply is the plain result text');
  const long = await chat(port, { system, prompt: 'mode:long' });
  assert.equal(long.status, 200);
  assert.equal(long.body.reply.length, 12_000);

  const fresh = runs().filter((run) => !before.has(`run-${run.pid}.json`));
  assert.equal(fresh.length, 2);
  for (const run of fresh) {
    const { args } = run;
    assert.equal(args[0], '-p');
    assert.ok(args[args.indexOf('--tools') + 1] === '', '--tools ""');
    const disallowed = args.indexOf('--disallowed-tools');
    assert.deepEqual(args.slice(disallowed + 1, disallowed + 13).sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write']);
    assert.ok(args.includes('--no-session-persistence'), 'QD-15');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', 'project']);
    assert.ok(!args.includes('stream-json'), 'chat is text only (no image input)');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.equal(args[args.indexOf('--system-prompt') + 1], system, 'no JSON/schema instruction is appended for chat');
    assert.match(path.basename(run.cwd), /^xdnode-quote-/);
    assert.deepEqual(run.cwdFiles, []);
  }
  assert.equal(fresh.find((run) => run.stdin.includes('웹에서'))?.stdin, prompt, 'the conversation travels on stdin unchanged');
  // 로그에는 경로·ms·웹 조회 수만(질문·답 없음). 도구가 꺼져 있어 web=0 이다.
  assert.match(bridgeLog, /\/quote-chat ok \d+ms web=0 cost=\$/);
  assert.ok(!bridgeLog.includes('웹에서 찾아') && !bridgeLog.includes('첫 질문'), 'no conversation text in the log');
});

test('QB-08: /quote-chat input checks — missing system or prompt 400, bad JSON 400, over 256 KB 413, prompt over 200,000 chars 413, empty or failed answers 502', async () => {
  assert.equal((await chat(port, { prompt: 'mode:ok' })).status, 400, 'system is required');
  assert.equal((await chat(port, { system: '상담', prompt: '   ' })).status, 400, 'prompt is required');
  assert.equal((await chat(port, { system: 3, prompt: 'mode:ok' })).status, 400);
  assert.equal((await chat(port, '{not json')).status, 400);
  const declared = await call(port, { method: 'POST', pathName: '/quote-chat', body: '{}', headers: { 'content-length': String(256 * 1024 + 1) } });
  assert.equal(declared.status, 413);
  const chunked = await call(port, { method: 'POST', pathName: '/quote-chat', body: Buffer.alloc(256 * 1024 + 16, 0x20), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(chunked.status, 413);
  assert.equal((await chat(port, { system: '상담', prompt: 'x'.repeat(200_001) })).status, 413);
  const empty = await chat(port, { system: '상담', prompt: 'mode:empty' });
  assert.equal(empty.status, 502);
  const crashed = await chat(port, { system: '상담', prompt: 'mode:exit-3' });
  assert.equal(crashed.status, 502);
  assert.doesNotMatch(JSON.stringify(crashed.body), /fake failure/);
  assert.equal((await call(port)).body.busy, false);
});
