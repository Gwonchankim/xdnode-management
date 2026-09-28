import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { anonymousActor, erpError, platformSchemaReady, writeErpAudit } from "../../../erp-platform";
import { getDummyHash, verifyPassword } from "../../../auth-password";
import {
  createSession, hashToken, lockedRetryAfterSeconds, newSessionToken, normalizeEmail, peerOf, reservationLocked,
  reserveLoginAttempt, sessionCookie, sessionUserDto, toPrincipal, type AuthAccountRow,
} from "../../../auth-session";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../../request-guard";

// Design §4.2.2, §7.4(D15 + D21). 검증 전에 시도를 원자적으로 예약한다. 루프백 peer 만 잠금 검사를 건너뛴다(실패는 센다).
const db = (env as unknown as { DB: D1Database }).DB;
const INVALID_CREDENTIALS = "이메일 또는 비밀번호가 올바르지 않습니다.";
const LOCKED_MESSAGE = "로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.";

export async function POST(request: Request) {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403 });
  let payload: { email?: unknown; password?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return erpError(400, "VALIDATION", "요청 내용을 읽을 수 없습니다.");
  }
  const email = normalizeEmail(payload?.email);
  const password = payload?.password;
  if (!email || email.length > 200) return erpError(400, "VALIDATION", "이메일을 입력해 주세요.", { field: "email" });
  if (typeof password !== "string" || password.length < 1 || password.length > 200) {
    return erpError(400, "VALIDATION", "비밀번호를 입력해 주세요.", { field: "password" });
  }

  const peer = peerOf(requestHeaders);
  const now = Date.now();
  const account = await db.prepare(`SELECT * FROM auth_accounts WHERE email = ?`).bind(email).first<AuthAccountRow>();
  if (!account || account.active !== 1) {
    // 없는 계정·비활성 계정도 같은 비용을 들이고 같은 401을 준다. 카운터는 건드리지 않는다.
    await verifyPassword(password, await getDummyHash());
    await writeErpAudit(db, { principal: anonymousActor(email), module: "auth", action: "LOGIN_FAILED",
      entityType: "AUTH_ACCOUNT", entityId: account?.id ?? "unknown", after: { email, reason: "UNKNOWN_OR_INACTIVE", peer: peer.address } });
    return erpError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS);
  }

  const reservation = await reserveLoginAttempt(db, account.id, now, { enforceLock: !peer.loopback });
  if (!reservation) {
    const retryAfterSeconds = await lockedRetryAfterSeconds(db, account.id, now);
    await writeErpAudit(db, { principal: anonymousActor(email), module: "auth", action: "LOGIN_BLOCKED",
      entityType: "AUTH_ACCOUNT", entityId: account.id, after: { peer: peer.address } });
    return erpError(429, "LOCKED", LOCKED_MESSAGE, { retryAfterSeconds }, { headers: { "Retry-After": String(retryAfterSeconds) } });
  }

  if (!await verifyPassword(password, account.password_hash)) {
    await writeErpAudit(db, { principal: anonymousActor(email), module: "auth", action: "LOGIN_FAILED",
      entityType: "AUTH_ACCOUNT", entityId: account.id,
      after: { email, reason: "WRONG_PASSWORD", failedAttempts: reservation.failedAttempts, peer: peer.address, ...(peer.loopback ? { lockExempt: true } : {}) } });
    if (reservationLocked(reservation, now)) {
      await writeErpAudit(db, { principal: anonymousActor(email), module: "auth", action: "ACCOUNT_LOCKED",
        entityType: "AUTH_ACCOUNT", entityId: account.id, after: { peer: peer.address, lockedUntil: reservation.lockedUntil } });
    }
    return erpError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS);
  }

  const token = newSessionToken();
  await db.batch([
    // 서버 PC(루프백)에서 로그인에 성공하면 LAN 에서 걸린 잠금도 여기서 풀린다(D21).
    db.prepare(`UPDATE auth_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = ?1, updated_at = ?1 WHERE id = ?2`)
      .bind(now, account.id),
    createSession(db, { sessionId: await hashToken(token), accountId: account.id, now, peer: peer.address,
      userAgent: requestHeaders.get("user-agent") ?? "" }),
  ]);
  const principal = toPrincipal(account);
  await writeErpAudit(db, { principal, module: "auth", action: "LOGIN_SUCCEEDED", entityType: "AUTH_ACCOUNT", entityId: account.id,
    after: { peer: peer.address } });
  return Response.json({ mustChangePassword: account.must_change_password === 1, user: sessionUserDto(principal) },
    { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } });
}
