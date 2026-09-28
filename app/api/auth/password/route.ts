import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { anonymousActor, erpError, platformSchemaReady, writeErpAudit } from "../../../erp-platform";
import { hashPassword, validatePassword, verifyPassword } from "../../../auth-password";
import {
  lockedRetryAfterSeconds, peerOf, reservationLocked, reserveLoginAttempt, resolveSession, revokeAccountSessions, toPrincipal,
} from "../../../auth-session";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../../request-guard";

// Design §4.2.4. must_change_password 상태에서도 허용한다. 현재 비밀번호 검증은 peer 와 관계없이 잠금 WHERE 가 붙은
// 예약을 쓴다. D21 루프백 면제는 로그인에만 있다(부록 C #23). 세션을 훔쳐도 서버 PC에서조차 무차별 대입이 되지 않는다.
const db = (env as unknown as { DB: D1Database }).DB;

export async function PUT(request: Request) {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403 });
  const session = await resolveSession(db, requestHeaders.get("cookie"));
  if (!session) return erpError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  let payload: { currentPassword?: unknown; newPassword?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return erpError(400, "VALIDATION", "요청 내용을 읽을 수 없습니다.");
  }
  const currentPassword = payload?.currentPassword;
  const newPassword = payload?.newPassword;
  if (typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 200) {
    return erpError(400, "VALIDATION", "현재 비밀번호를 입력해 주세요.", { field: "currentPassword" });
  }
  const policy = validatePassword(newPassword);
  if (policy) return erpError(400, "VALIDATION", policy, { field: "newPassword" });
  if (newPassword === currentPassword) return erpError(400, "VALIDATION", "새 비밀번호는 현재 비밀번호와 달라야 합니다.", { field: "newPassword" });

  const account = session.account;
  const peer = peerOf(requestHeaders);
  const now = Date.now();
  const reservation = await reserveLoginAttempt(db, account.id, now, { enforceLock: true });
  if (!reservation) {
    const retryAfterSeconds = await lockedRetryAfterSeconds(db, account.id, now);
    return erpError(429, "LOCKED", "로그인에 5번 실패해 5분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.",
      { retryAfterSeconds }, { headers: { "Retry-After": String(retryAfterSeconds) } });
  }
  if (!await verifyPassword(currentPassword, account.password_hash)) {
    if (reservationLocked(reservation, now)) {
      await writeErpAudit(db, { principal: anonymousActor(account.email), module: "auth", action: "ACCOUNT_LOCKED",
        entityType: "AUTH_ACCOUNT", entityId: account.id, after: { peer: peer.address, lockedUntil: reservation.lockedUntil } });
    }
    // 세션은 유지한다. 클라이언트는 code 가 UNAUTHENTICATED 일 때만 로그인 화면으로 보낸다(§6.3).
    return erpError(401, "INVALID_CREDENTIALS", "현재 비밀번호가 올바르지 않습니다.");
  }

  const results = await db.batch([
    db.prepare(`UPDATE auth_accounts SET password_hash = ?1, must_change_password = 0, password_changed_at = ?2,
      failed_attempts = 0, locked_until = NULL, updated_at = ?2 WHERE id = ?3`)
      .bind(await hashPassword(newPassword as string), now, account.id),
    revokeAccountSessions(db, account.id, "PASSWORD_CHANGED", now, session.sessionId),
  ]);
  const revokedSessions = results[1]?.meta?.changes ?? 0;
  await writeErpAudit(db, { principal: toPrincipal(account), module: "auth", action: "PASSWORD_CHANGED",
    entityType: "AUTH_ACCOUNT", entityId: account.id, after: { peer: peer.address, revokedSessions } });
  return Response.json({ ok: true, mustChangePassword: false }, { headers: { "Cache-Control": "no-store" } });
}
