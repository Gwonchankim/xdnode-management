import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { erpError, platformSchemaReady, writeErpAudit } from "../../../erp-platform";
import { hashPassword, validatePassword } from "../../../auth-password";
import {
  accountsExist, ACCOUNT_ID_PREFIX, findEmployeeRecord, hashToken, isValidEmail, newSessionToken, normalizeEmail, peerOf,
  sessionCookie, sessionUserDto, SESSION_TTL_MS, toPrincipal, type AuthAccountRow,
} from "../../../auth-session";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "../../../request-guard";

// Design §4.2.5, §7.5. 계정이 0개이고 Node 가 확인한 peer 가 루프백일 때만 첫 관리자를 만든다.
// Node 층(local-peer 플러그인, r3-runtime)이 비루프백 요청을 먼저 끊고, 이 라우트가 peerOf(h).loopback 을 다시 본다.
// 계정 INSERT 는 WHERE NOT EXISTS 로 원자적이고, 세션은 그 행이 실제로 들어갔을 때만 생긴다(동시 요청에도 201은 하나).
const db = (env as unknown as { DB: D1Database }).DB;
const CLOSED = "이미 계정이 있어 첫 관리자 만들기가 닫혔습니다.";

export async function POST(request: Request) {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  const peer = peerOf(requestHeaders);
  if (!peer.loopback) {
    return erpError(403, "BOOTSTRAP_LOCAL_ONLY", "첫 관리자 계정은 서버 PC의 http://localhost:3000 에서만 만들 수 있습니다.");
  }
  if (requestHeaders.get("upgrade") !== null) return erpError(400, "VALIDATION", "요청 형식을 확인해 주세요.");
  if (!/^application\/json\b/i.test(requestHeaders.get("content-type") ?? "")) {
    return erpError(415, "UNSUPPORTED_MEDIA_TYPE", "올릴 수 없는 파일 형식입니다.");
  }
  if (crossSiteViolation(requestHeaders)) return Response.json(CROSS_ORIGIN_ERROR, { status: 403 });
  if (await accountsExist(db)) return erpError(409, "BOOTSTRAP_CLOSED", CLOSED);

  let payload: { email?: unknown; displayName?: unknown; password?: unknown; employeeId?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return erpError(400, "VALIDATION", "요청 내용을 읽을 수 없습니다.");
  }
  const email = normalizeEmail(payload?.email);
  if (!isValidEmail(email)) return erpError(400, "VALIDATION", "이메일 형식을 확인해 주세요.", { field: "email" });
  const policy = validatePassword(payload?.password);
  if (policy) return erpError(400, "VALIDATION", policy, { field: "password" });
  const employeeIdInput = typeof payload?.employeeId === "string" ? payload.employeeId.trim() : "";
  if (payload?.employeeId !== undefined && payload.employeeId !== null && typeof payload.employeeId !== "string") {
    return erpError(400, "VALIDATION", "인사기록을 찾을 수 없습니다.", { field: "employeeId" });
  }
  let employee: { employee_id: string; name: string } | null = null;
  if (employeeIdInput) {
    if (employeeIdInput.startsWith(ACCOUNT_ID_PREFIX)) return erpError(400, "VALIDATION", "인사기록을 찾을 수 없습니다.", { field: "employeeId" });
    employee = await findEmployeeRecord(db, employeeIdInput);
    if (!employee) return erpError(400, "VALIDATION", "인사기록을 찾을 수 없습니다.", { field: "employeeId" });
  }
  const displayName = (typeof payload?.displayName === "string" ? payload.displayName.trim() : "") || employee?.name || "";
  if (displayName.length < 1 || displayName.length > 60) {
    return erpError(400, "VALIDATION", "이름은 1자 이상 60자 이하로 입력해 주세요.", { field: "displayName" });
  }

  const now = Date.now();
  const accountId = `${ACCOUNT_ID_PREFIX}${crypto.randomUUID()}`;
  const token = newSessionToken();
  const passwordHash = await hashPassword(payload.password as string);
  const userAgent = (requestHeaders.get("user-agent") ?? "").slice(0, 200);
  const results = await db.batch([
    db.prepare(`INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password,
        failed_attempts, locked_until, tabs_json, password_changed_at, last_login_at, created_by, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, 1, 1, 0, 0, NULL, '{}', ?6, ?6, 'bootstrap', ?6, ?6
      WHERE NOT EXISTS (SELECT 1 FROM auth_accounts)`)
      .bind(accountId, email, displayName, passwordHash, employee?.employee_id ?? null, now),
    db.prepare(`INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at, revoked_at, revoked_reason, peer, user_agent)
      SELECT ?1, id, ?2, ?2 + ${SESSION_TTL_MS}, ?2, NULL, '', ?3, ?4 FROM auth_accounts WHERE id = ?5`)
      .bind(await hashToken(token), now, peer.address, userAgent, accountId),
  ]);
  if (results[0]?.meta?.changes !== 1) return erpError(409, "BOOTSTRAP_CLOSED", CLOSED);

  const account = await db.prepare(`SELECT * FROM auth_accounts WHERE id = ?`).bind(accountId).first<AuthAccountRow>();
  const principal = toPrincipal(account as AuthAccountRow);
  await writeErpAudit(db, { principal, module: "auth", action: "BOOTSTRAP_ADMIN_CREATED", entityType: "AUTH_ACCOUNT", entityId: accountId,
    after: { peer: peer.address, employeeId: employee?.employee_id ?? null } });
  return Response.json({ user: sessionUserDto(principal), mustChangePassword: false },
    { status: 201, headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } });
}
