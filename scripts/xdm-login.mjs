// 운영 스크립트용 로그인 도우미(Design §11.1 `scripts/xdm-login.mjs`, §7.3, §10.3, Plan M5a).
//
// 모듈로 쓴다(import-leave-ledger.mjs, restore-known-data.mjs, sc4-hr-regression.mjs):
//   const client = await connectXdm(base);                 // XDM_EMAIL·XDM_PASSWORD 로 로그인
//   const client = await connectXdm(base, { cookie });     // 이미 받은 쿠키를 쓴다(로그인하지 않음)
//   const response = await client.fetch("/api/hr/leave", { method: "POST", ... });
//
// client.fetch 는 모든 요청에 Cookie 를, GET·HEAD 가 아닌 요청에는 `Origin: <base>` 를 붙인다.
// Worker 가 Origin·Sec-Fetch-Site 가 없는 비GET 을 403 CROSS_ORIGIN 으로 막기 때문이다(app/request-guard.ts).
//
// 명령줄로 쓰면 쿠키 한 줄(xdm_session=…)을 표준 출력에 찍는다. SC-4 의 --cookie 나 SC4_COOKIE 에 넘길 때만 쓴다:
//   XDM_EMAIL=… XDM_PASSWORD=… node scripts/xdm-login.mjs --base http://127.0.0.1:3001
//
// 비밀번호는 환경변수로만 받고 파일에 저장하지 않는다. 쿠키는 30일 세션이므로 끝나면 화면에서 로그아웃하거나
// 계정 관리의 '세션 강제 종료'로 폐기한다. 스크립트 계정은 첫 로그인 때 화면에서 비밀번호를 한 번 바꿔 둔다.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SESSION_COOKIE = "xdm_session";

export class XdmLoginError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "XdmLoginError";
    this.status = status;
  }
}

/** `http://host:port` 형태로 정리한다. 경로·쿼리가 있으면 거부한다. */
export function normalizeBase(base) {
  const trimmed = String(base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#]+$/.test(trimmed)) throw new XdmLoginError(`주소 형식이 올바르지 않습니다: ${trimmed || "(없음)"} (예: http://127.0.0.1:3000)`);
  return trimmed;
}

/** Set-Cookie 목록에서 세션 쿠키의 `name=value` 만 꺼낸다. */
export function sessionCookieFrom(setCookies) {
  for (const line of setCookies ?? []) {
    const pair = String(line).split(";")[0].trim();
    if (pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1) return pair;
  }
  return "";
}

/** 요청 헤더를 만든다. 비GET 이면 Origin 을 붙인다. */
export function xdmHeaders(base, method, cookie, extra = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set("Cookie", cookie);
  const verb = String(method ?? "GET").toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") headers.set("Origin", base);
  return headers;
}

export function createXdmClient(base, { cookie = "" } = {}) {
  const origin = normalizeBase(base);
  return {
    base: origin,
    cookie,
    fetch(path, init = {}) {
      const method = init.method ?? "GET";
      return fetch(`${origin}${path}`, { redirect: "manual", ...init, method, headers: xdmHeaders(origin, method, cookie, init.headers) });
    },
  };
}

/** 로그인해서 세션 쿠키(`xdm_session=…`)를 돌려준다. 비밀번호 변경이 필요한 계정이면 거부한다. */
export async function loginXdm(base, { email = process.env.XDM_EMAIL, password = process.env.XDM_PASSWORD } = {}) {
  const origin = normalizeBase(base);
  if (!email || !password) throw new XdmLoginError("XDM_EMAIL 과 XDM_PASSWORD 환경변수를 설정하세요(파일에 저장하지 않습니다).");
  let response;
  try {
    response = await fetch(`${origin}/api/auth/login`, {
      method: "POST", redirect: "manual",
      headers: xdmHeaders(origin, "POST", "", { "Content-Type": "application/json" }),
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new XdmLoginError(`${origin} 에 연결하지 못했습니다. 앱이 떠 있는지 확인하세요 (${error instanceof Error ? error.message : String(error)}).`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "";
    const retry = code === "LOCKED" && payload?.retryAfterSeconds ? ` ${payload.retryAfterSeconds}초 뒤 다시 시도하세요.` : "";
    throw new XdmLoginError(`로그인 실패 (${response.status}${code ? ` ${code}` : ""}).${retry}`, response.status);
  }
  const cookie = sessionCookieFrom(response.headers.getSetCookie?.() ?? []);
  if (!cookie) throw new XdmLoginError("로그인 응답에 세션 쿠키가 없습니다.", response.status);
  if (payload?.mustChangePassword) {
    throw new XdmLoginError("이 계정은 비밀번호를 바꿔야 합니다. 브라우저로 한 번 로그인해 비밀번호를 바꾼 뒤 다시 실행하세요.", 403);
  }
  return cookie;
}

/** 쿠키가 있으면 그대로, 없으면 XDM_EMAIL·XDM_PASSWORD 로 로그인한 클라이언트를 돌려준다. */
export async function connectXdm(base, { cookie = "", email, password } = {}) {
  const session = cookie || await loginXdm(base, { email, password });
  return createXdmClient(base, { cookie: session });
}

async function main(argv) {
  const index = argv.indexOf("--base");
  const base = index >= 0 ? argv[index + 1] : "http://127.0.0.1:3000";
  try {
    const cookie = await loginXdm(base);
    console.error("주의: 아래 줄은 30일짜리 세션 쿠키입니다. 파일·채팅에 남기지 말고, 끝나면 로그아웃해 폐기하세요.");
    console.log(cookie);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
