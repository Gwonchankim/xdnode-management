// R3(r3-runtime): local-peer 플러그인(Design §7.6, §7.4 '루프백 판정을 위조할 수 없는 이유', §8.6 local-peer-plugin 행, FR-07, D21).
// build/** 는 lint 대상이 아니므로 순수 함수 export 와 실제 http.Server 로 동작을 지킨다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
// 하니스가 .ts 로더 훅을 등록한다(DB 는 쓰지 않는다).
import './helpers/hr-api-harness.mjs';

const plugin = await import('../build/local-peer-vite-plugin.ts');
const session = await import('../app/auth-session.ts');
const {
  localPeerPlugin, normalizePeerAddress, isLoopbackAddress, stampPeer, gatePeerRequest, allowUpgrade, guardUpgrades,
  normalizeRequestPaths, BOOTSTRAP_LOCAL_ONLY_BODY, PEER_HEADER, LOOPBACK_ADDRESSES,
} = plugin;

/** @cloudflare/vite-plugin createHeaders 와 같은 방식: rawHeaders 를 차례로 append 한다(같은 이름은 ", " 로 합쳐진다). */
const workerHeaders = (req) => {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  return headers;
};
/** 파서가 만든 것처럼 rawHeaders 와 헤더 수(kHeadersCount, headers 게터가 읽는 값)를 채운 IncomingMessage. */
const incoming = (socket, rawHeaders) => {
  const req = new IncomingMessage(socket);
  req.rawHeaders.push(...rawHeaders);
  const count = Object.getOwnPropertySymbols(req).find((symbol) => symbol.description === 'kHeadersCount');
  assert.ok(count, 'IncomingMessage kHeadersCount');
  req[count] = rawHeaders.length;
  return req;
};
const fakeRequest = (remoteAddress, rawHeaders) => incoming({ remoteAddress }, rawHeaders);

test('peer header name and loopback list are the ones app/auth-session.ts peerOf() reads', () => {
  assert.equal(PEER_HEADER, session.PEER_HEADER);
  assert.equal(PEER_HEADER, 'x-xdm-peer');
  assert.deepEqual([...LOOPBACK_ADDRESSES], [...session.LOOPBACK_ADDRESSES]);
  assert.deepEqual([...LOOPBACK_ADDRESSES], ['127.0.0.1', '::1']);
  assert.equal(BOOTSTRAP_LOCAL_ONLY_BODY.code, 'BOOTSTRAP_LOCAL_ONLY');
});

test('normalizePeerAddress maps IPv4-mapped IPv6 and never turns a missing address into loopback', () => {
  const table = [
    ['::ffff:127.0.0.1', '127.0.0.1', true], ['::FFFF:127.0.0.1', '127.0.0.1', true], ['127.0.0.1', '127.0.0.1', true],
    ['::1', '::1', true], ['[::1]', '::1', true], [' 127.0.0.1 ', '127.0.0.1', true],
    ['::ffff:192.168.0.50', '192.168.0.50', false], ['192.0.2.10', '192.0.2.10', false], ['127.0.0.2', '127.0.0.2', false],
    ['', '', false], [undefined, '', false], [null, '', false], ['fe80::1', 'fe80::1', false],
  ];
  for (const [input, normalized, loopback] of table) {
    assert.equal(normalizePeerAddress(input), normalized, String(input));
    assert.equal(isLoopbackAddress(input), loopback, String(input));
  }
});

test('stampPeer removes every forged x-xdm-peer from headers and rawHeaders, in any case, and stamps the socket address once', () => {
  const req = fakeRequest('::ffff:192.0.2.10', [
    'Host', 'localhost:3000', 'X-XDM-Peer', '127.0.0.1', 'x-xdm-peer', '::1', 'CF-Connecting-IP', '127.0.0.1', 'X-Xdm-PEER', '127.0.0.1, ::1',
  ]);
  // Node 는 headers 를 rawHeaders 에서 늦게 계산해 캐시한다. 먼저 읽혀 있어도 두 곳이 모두 바뀌어야 한다.
  assert.equal(req.headers['x-xdm-peer'], '127.0.0.1, ::1, 127.0.0.1, ::1');
  const rawBefore = req.rawHeaders;
  assert.equal(stampPeer(req), '192.0.2.10');
  assert.equal(req.rawHeaders, rawBefore, 'rawHeaders 는 같은 배열 객체를 바꾼다');
  const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  assert.equal(names.filter((name) => name === 'x-xdm-peer').length, 1);
  assert.equal(req.headers['x-xdm-peer'], '192.0.2.10');
  assert.deepEqual(Object.keys(req.headers).filter((name) => name.toLowerCase() === 'x-xdm-peer'), ['x-xdm-peer']);
  // Worker 가 받는 Request 헤더로 peerOf() 를 부르면 위조가 통하지 않는다(Host·CF-Connecting-IP 는 보지 않는다).
  assert.deepEqual(session.peerOf(workerHeaders(req)), { address: '192.0.2.10', loopback: false });
  assert.equal(req.headers.host, 'localhost:3000');

  const local = fakeRequest('::ffff:127.0.0.1', ['x-xdm-peer', '192.0.2.99']);
  assert.equal(stampPeer(local), '127.0.0.1');
  assert.deepEqual(session.peerOf(workerHeaders(local)), { address: '127.0.0.1', loopback: true });

  // 주소가 없으면 빈 값을 찍는다 → 비루프백(fail closed).
  const unknown = fakeRequest(undefined, ['x-xdm-peer', '127.0.0.1']);
  assert.equal(stampPeer(unknown), '');
  assert.deepEqual(session.peerOf(workerHeaders(unknown)), { address: '', loopback: false });
});

test('non-loopback /cdn-cgi/* and /__debug* are 404 and bootstrap is 403, including absolute-form and encoded variants', () => {
  const lan = '192.0.2.10';
  const notFound = [
    '/cdn-cgi/explorer/api/d1/database', '/cdn-cgi', '/cdn-cgi/', '/cdn-cgi/handler/scheduled', '/cdn-cgi/mf/reload',
    'http://localhost/cdn-cgi/explorer/api/d1/database', 'http://127.0.0.1:3000/CDN-CGI/explorer', '//cdn-cgi/explorer',
    '/%63dn-cgi/explorer', '/%43DN-CGI/explorer', '/cdn%2Dcgi/explorer', '/cdn-cgi%2Fexplorer', '/a/../cdn-cgi/explorer', '/%2e%2e/cdn-cgi/x',
    '/x/%2e%2e/cdn-cgi/x', '///cdn-cgi//explorer', '/.\\cdn-cgi/explorer', '/cdn-cgi/explorer?x=1#y',
    '/__debug', '/__debug/', '/__DEBUG', '/__debugger', '/%5f_debug', '/%5F%5Fdebug', 'http://evil.invalid/__debug',
  ];
  for (const url of notFound) assert.deepEqual(gatePeerRequest(url, lan), { status: 404 }, url);
  for (const url of ['/api/auth/bootstrap', '/api/auth/bootstrap/', '/api/auth/bootstrap?x=1', '/API/AUTH/BOOTSTRAP', '/api/auth/%62ootstrap',
    '/api//auth/bootstrap', 'http://localhost:3000/api/auth/bootstrap']) {
    assert.deepEqual(gatePeerRequest(url, lan), { status: 403, body: { ...BOOTSTRAP_LOCAL_ONLY_BODY } }, url);
  }
  for (const url of ['/', '/api/me', '/api/auth/login', '/api/auth/bootstrapped', '/cdn-cgix', '/incentive', '/api/hr/leave?x=/cdn-cgi/', undefined]) {
    assert.equal(gatePeerRequest(url, lan), null, String(url));
  }
  // 빈 주소(모름)도 비루프백이다.
  assert.deepEqual(gatePeerRequest('/cdn-cgi/explorer', ''), { status: 404 });
  // 루프백은 그대로 통과한다(explorer 는 꺼져 있고, /__debug 는 인스펙터가 없어 앱의 404 가 된다).
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    for (const url of ['/cdn-cgi/explorer', '/__debug', '/api/auth/bootstrap']) assert.equal(gatePeerRequest(url, address), null, `${address} ${url}`);
  }
  assert.deepEqual(normalizeRequestPaths('/%63dn-cgi/A'), ['/%63dn-cgi/a', '/cdn-cgi/a']);
});

test('upgrade decision table: only dev + vite protocol + loopback is allowed; preview refuses everything', () => {
  const request = (protocol, remoteAddress) => ({ headers: protocol === undefined ? {} : { 'sec-websocket-protocol': protocol }, socket: { remoteAddress } });
  const rows = [];
  for (const mode of ['dev', 'preview']) {
    for (const protocol of ['vite-hmr', 'vite-ping', 'chat', undefined]) {
      for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '192.0.2.10', '']) {
        const expected = mode === 'dev' && String(protocol ?? '').startsWith('vite') && isLoopbackAddress(address);
        assert.equal(allowUpgrade(request(protocol, address), mode), expected, `${mode} ${protocol} ${address}`);
        if (expected) rows.push(`${mode} ${protocol} ${address}`);
      }
    }
  }
  assert.equal(rows.length, 6);
});

test('guardUpgrades wraps every upgrade listener after listening, absorbs later ones and keeps exactly one', async () => {
  for (const mode of ['dev', 'preview']) {
    const server = createServer();
    const calls = [];
    server.on('upgrade', (req) => calls.push(['vite', req.headers['x-xdm-peer']]));
    server.on('upgrade', (req) => calls.push(['cloudflare', req.headers['x-xdm-peer']]));
    guardUpgrades(server, mode, () => {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.listeners('upgrade').length, 1, mode);
    // 나중에 붙은 리스너도 감싸기 안으로 옮겨진다.
    server.on('upgrade', () => calls.push(['late']));
    await Promise.resolve();
    assert.equal(server.listeners('upgrade').length, 1, `${mode}: late listener`);

    const destroyed = [];
    const upgrade = (protocol, remoteAddress) => {
      const socket = { remoteAddress, destroy: () => destroyed.push(protocol) };
      const req = incoming(socket, ['Sec-WebSocket-Protocol', protocol, 'X-Xdm-Peer', '127.0.0.1']);
      server.emit('upgrade', req, socket, Buffer.alloc(0));
    };
    upgrade('vite-hmr', '::ffff:127.0.0.1');
    upgrade('vite-hmr', '192.0.2.10');
    upgrade('chat', '127.0.0.1');
    if (mode === 'dev') {
      assert.deepEqual(calls, [['vite', '127.0.0.1'], ['cloudflare', '127.0.0.1'], ['late']]);
      assert.deepEqual(destroyed, ['vite-hmr', 'chat']);
    } else {
      assert.deepEqual(calls, []);
      assert.deepEqual(destroyed, ['vite-hmr', 'vite-hmr', 'chat']);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.listening, true, `${mode}: the one-listener check passed`);
    server.close();
    await once(server, 'close');
  }
});

test('plugin is enforce:"pre", registers its middleware in both hook bodies, and restamps the peer on a real request', async () => {
  const instance = localPeerPlugin();
  assert.equal(instance.name, 'xdm-local-peer');
  assert.equal(instance.enforce, 'pre');
  for (const [hook, mode] of [['configurePreviewServer', 'preview'], ['configureServer', 'dev']]) {
    const middlewares = [];
    const httpServer = createServer((req, res) => {
      const run = (index) => {
        const handler = middlewares[index];
        if (!handler) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ peer: req.headers['x-xdm-peer'], raw: req.rawHeaders }));
          return;
        }
        handler(req, res, () => run(index + 1));
      };
      run(0);
    });
    // 훅이 반환하는 post 함수가 아니라 본문에서 등록해야 디스패처보다 앞선다.
    const returned = instance[hook]({ middlewares: { use: (handler) => middlewares.push(handler) }, httpServer });
    assert.equal(returned, undefined, `${hook}: post 함수를 돌려주지 않는다`);
    assert.equal(middlewares.length, 1, hook);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const { port } = httpServer.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'X-XDM-Peer': '192.0.2.10', 'x-xdm-peer': '10.0.0.1' } });
    const body = await response.json();
    assert.equal(body.peer, '127.0.0.1', hook);
    const names = body.raw.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    assert.equal(names.filter((name) => name === 'x-xdm-peer').length, 1, hook);
    // 루프백 요청은 차단 경로도 통과한다(여기서는 끝 처리기가 받는다).
    assert.equal((await fetch(`http://127.0.0.1:${port}/cdn-cgi/explorer/api/d1/database`)).status, 200, hook);

    // 실제 TCP 로 보낸 WebSocket upgrade: preview 는 무엇이든, dev 는 vite 가 아닌 것을 끊는다.
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Xdm-Peer: 127.0.0.1\r\n\r\n');
    let received = '';
    socket.on('data', (chunk) => { received += chunk; });
    socket.on('error', () => {});
    await once(socket, 'close');
    assert.equal(received, '', `${mode}: upgrade 는 응답 없이 끊긴다`);
    assert.equal(httpServer.listeners('upgrade').length, 1, hook);
    httpServer.closeAllConnections();
    httpServer.close();
    await once(httpServer, 'close');
  }
});
