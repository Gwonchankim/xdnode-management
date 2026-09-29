// local-peer 플러그인(Design §7.6, §7.4 '루프백 판정을 위조할 수 없는 이유', Plan M5a·D21).
//
// Node 가 확인한 TCP 상대 주소(req.socket.remoteAddress) 하나만 믿는다. 클라이언트가 보낸 x-xdm-peer 는 대소문자와
// 관계없이 req.headers 와 req.rawHeaders 양쪽에서 지우고, 정규화한 실제 주소로 다시 찍는다. Worker 의 Request 는
// rawHeaders 로 만들어지므로(@cloudflare/vite-plugin createHeaders) 두 곳을 모두 바꿔야 한다.
// 이 헤더는 app/auth-session.ts 의 peerOf() 가 읽는다. 이름과 루프백 목록은 그 파일에서 그대로 가져온다.
//
// 비루프백 요청만 막는다: /cdn-cgi/*(explorer·트리거·mf)와 /__debug* 는 본문 없는 404, /api/auth/bootstrap 은 403 JSON.
// upgrade 는 middleware 를 거치지 않으므로 리스너 전체를 감싸고, dev 의 루프백 Vite HMR 말고는 소켓을 끊는다.
//
// 이 파일은 lint 대상이 아니다(eslint.config.mjs 의 build/**). 순수 함수 export 와 tests/local-peer-plugin.test.mjs 로 지킨다.
// 지원 런타임은 vinext dev(127.0.0.1)와 vite preview 뿐이다. wrangler dev·vinext start 에는 이 플러그인이 실리지 않는다.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { LOOPBACK_ADDRESSES, PEER_HEADER } from "../app/auth-session";

export { LOOPBACK_ADDRESSES, PEER_HEADER };
export type PeerServerMode = "dev" | "preview";
export type PeerGate = { status: 404 } | { status: 403; body: { error: string; code: string } };

export const BOOTSTRAP_LOCAL_ONLY_BODY = Object.freeze({
  error: "첫 관리자 계정은 서버 PC의 http://localhost:3000 에서만 만들 수 있습니다.",
  code: "BOOTSTRAP_LOCAL_ONLY",
});

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** `::ffff:127.0.0.1` → `127.0.0.1`, 대괄호·공백 제거, 소문자. 없으면 "" (비루프백). */
export function normalizePeerAddress(address: string | undefined | null): string {
  let value = String(address ?? "").trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  return value.slice(0, 64);
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  return (LOOPBACK_ADDRESSES as readonly string[]).includes(normalizePeerAddress(address));
}

/** 클라이언트가 보낸 x-xdm-peer 를 모두 지우고 Node 가 확인한 주소 하나를 찍는다. 찍은 주소를 돌려준다. */
export function stampPeer(req: IncomingMessage): string {
  const address = normalizePeerAddress(req.socket?.remoteAddress);
  // req.headers 는 rawHeaders 에서 늦게 계산되어 캐시된다. 먼저 읽어 캐시를 만든 뒤 고친다.
  const headers = req.headers;
  for (const name of Object.keys(headers)) if (name.toLowerCase() === PEER_HEADER) delete headers[name];
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() !== PEER_HEADER) kept.push(raw[i], raw[i + 1]);
  kept.push(PEER_HEADER, address);
  // 같은 배열 객체를 바꾼다. createHeaders 가 나중에 req.rawHeaders 를 다시 읽는다.
  raw.splice(0, raw.length, ...kept);
  headers[PEER_HEADER] = address;
  return address;
}

/** 점 세그먼트(`.`, `..`)를 푼다. 빈 세그먼트는 앞에서 이미 합쳤다. */
function removeDotSegments(path: string): string {
  const output: string[] = [];
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === ".") { if (index === segments.length - 1) output.push(""); continue; }
    if (segment === "..") { if (output.length > 1) output.pop(); if (index === segments.length - 1) output.push(""); continue; }
    output.push(segment);
  }
  const joined = output.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * 비교에 쓸 pathname 후보들. 디스패처와 같은 방식(new URL(req.url, base).pathname)으로 구한 값과,
 * 그 값을 퍼센트 디코딩 1회·역슬래시→슬래시·연속 `/` 축약·점 세그먼트 해석·소문자화한 값 두 가지다.
 * absolute-form(`GET http://h/cdn-cgi/…`)과 `%63dn-cgi`, `//cdn-cgi`, `/CDN-CGI` 같은 변형을 한 모양으로 모은다.
 * URL 로 읽을 수 없으면 null(비루프백이면 404로 막는다).
 */
export function normalizeRequestPaths(url: string | undefined): string[] | null {
  let pathname: string;
  try {
    pathname = new URL(url ?? "/", "http://x").pathname;
  } catch {
    return null;
  }
  const decode = (value: string) => removeDotSegments(value
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")).toLowerCase();
  const candidates = [pathname.toLowerCase(), decode(pathname)];
  // `//cdn-cgi/x` 는 URL 로 읽으면 호스트가 되지만, 원문 경로로도 한 번 더 본다(뒤따르는 처리기가 다르게 읽어도 막히게).
  const rawTarget = String(url ?? "");
  if (rawTarget.startsWith("/")) candidates.push(decode(rawTarget.split(/[?#]/, 1)[0]));
  return [...new Set(candidates)];
}

/** 비루프백 요청의 경로 차단. null 이면 통과. 루프백은 항상 통과한다. */
export function gatePeerRequest(url: string | undefined, address: string): PeerGate | null {
  if (isLoopbackAddress(address)) return null;
  const paths = normalizeRequestPaths(url);
  if (paths === null) return { status: 404 };
  if (paths.some((path) => path === "/cdn-cgi" || path.startsWith("/cdn-cgi/"))) return { status: 404 };
  if (paths.some((path) => path.startsWith("/__debug"))) return { status: 404 };
  if (paths.some((path) => /^\/api\/auth\/bootstrap(?:\/|$)/.test(path))) return { status: 403, body: { ...BOOTSTRAP_LOCAL_ONLY_BODY } };
  return null;
}

/** upgrade 허용 판정: dev + `Sec-WebSocket-Protocol` 이 vite 로 시작 + 루프백만. preview 는 전부 거부한다. */
export function allowUpgrade(req: Pick<IncomingMessage, "headers" | "socket">, mode: PeerServerMode): boolean {
  if (mode !== "dev") return false;
  const header = req.headers?.["sec-websocket-protocol"];
  const protocol = Array.isArray(header) ? header.join(",") : String(header ?? "");
  if (!protocol.startsWith("vite")) return false;
  return isLoopbackAddress(req.socket?.remoteAddress);
}

function peerMiddleware(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) {
  const address = stampPeer(req);
  const gate = gatePeerRequest(req.url, address);
  if (!gate) { next(); return; }
  res.statusCode = gate.status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (gate.status === 404) {
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  const body = JSON.stringify(gate.body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(body);
}

/**
 * httpServer 의 upgrade 리스너 전체를 감싼다(listening 뒤 1회). Vite HMR 과 cloudflare handleWebSocket 을 모두 안에 넣고,
 * allowUpgrade 를 통과한 요청만 peer 를 다시 찍어 넘긴다. 나중에 붙는 upgrade 리스너도 안으로 옮긴다.
 * 감싼 뒤 리스너가 정확히 1개인지 확인하고, 아니면 서버를 닫는다(fail closed).
 */
export function guardUpgrades(httpServer: Server, mode: PeerServerMode, log: (message: string) => void = console.error) {
  const wrappedListeners: UpgradeListener[] = [];
  const wrapped: UpgradeListener = (req, socket, head) => {
    if (!allowUpgrade(req, mode)) { socket.destroy(); return; }
    stampPeer(req);
    for (const listener of [...wrappedListeners]) listener.call(httpServer, req, socket, head);
  };
  const install = () => {
    wrappedListeners.push(...(httpServer.listeners("upgrade") as UpgradeListener[]));
    httpServer.removeAllListeners("upgrade");
    httpServer.on("upgrade", wrapped);
    // 이후에 붙는 upgrade 리스너는 동기 등록 직후(마이크로태스크)에 떼어 감싸기 안으로 옮긴다. I/O 이벤트보다 먼저 돈다.
    httpServer.on("newListener", (event: string | symbol, listener: UpgradeListener) => {
      if (event !== "upgrade" || listener === wrapped) return;
      queueMicrotask(() => {
        httpServer.removeListener("upgrade", listener);
        wrappedListeners.push(listener);
      });
    });
    setImmediate(() => {
      const count = httpServer.listeners("upgrade").length;
      if (count !== 1 || httpServer.listeners("upgrade")[0] !== wrapped) {
        log(`[xdm-local-peer] upgrade 리스너가 ${count}개입니다(기대 1개). 서버를 닫습니다.`);
        httpServer.close();
        process.exitCode = 1;
      }
    });
  };
  if (httpServer.listening) install();
  else httpServer.once("listening", install);
  return { listeners: wrappedListeners, wrapped };
}

export function localPeerPlugin(): Plugin {
  return {
    name: "xdm-local-peer",
    enforce: "pre",
    // 훅 본문에서 등록한다. 반환하는 post 함수에서 등록하면 cloudflare 디스패처보다 늦다.
    configureServer(server) {
      server.middlewares.use(peerMiddleware);
      if (server.httpServer) guardUpgrades(server.httpServer as Server, "dev");
    },
    configurePreviewServer(server) {
      server.middlewares.use(peerMiddleware);
      guardUpgrades(server.httpServer as Server, "preview");
    },
  };
}
