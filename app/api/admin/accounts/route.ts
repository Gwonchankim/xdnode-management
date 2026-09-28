import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { authorizeErpRequest, erpError, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";
import { generateTemporaryPassword, hashPassword } from "../../../auth-password";
import {
  ACCOUNT_ID_PREFIX, findEmployeeRecord, GRANTABLE_TABS, isGrantableTabKey, isValidEmail, normalizeEmail, parseStoredTabs, peerOf,
  resolveTabs, revokeAccountSessions, type AuthAccountRow, type GrantableTabKey, type TabLevel,
} from "../../../auth-session";
import { readOptionalHrRows } from "../../../hr-optional-tables";

// Design §4.2.6. 관리자 전용(admin:read / admin:write). 인가를 먼저 하고 본문은 그다음에 읽는다.
// temporaryPassword 는 CREATE·RESET_PASSWORD 응답에만 한 번 싣고, 감사에는 temporaryPasswordIssued:true 만 남긴다.
const db = (env as unknown as { DB: D1Database }).DB;
const NOT_FOUND = "계정을 찾을 수 없습니다.";
const DUPLICATE_EMAIL = "이미 등록된 이메일입니다.";
const DUPLICATE_EMPLOYEE = "이미 다른 계정에 연결된 직원입니다.";
const LAST_ADMIN = "마지막 관리자는 비활성화하거나 권한을 낮출 수 없습니다.";
const TAB_LEVELS: ReadonlySet<string> = new Set(["none", "view", "edit"]);

type Payload = Record<string, unknown>;

function validation(error: string, field?: string) {
  return erpError(400, "VALIDATION", error, field ? { field } : {});
}

function storedGrants(account: AuthAccountRow) {
  const resolved = resolveTabs(account.tabs_json, false);
  return Object.fromEntries(GRANTABLE_TABS.map((tab) => [tab.key, resolved[tab.key]])) as Record<GrantableTabKey, TabLevel>;
}

async function activeSessionCounts(now: number) {
  const result = await db.prepare(`SELECT account_id, COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY account_id`)
    .bind(now).all<{ account_id: string; n: number }>();
  return new Map(result.results.map((row) => [row.account_id, Number(row.n)]));
}

function toDto(account: AuthAccountRow, sessions: number, now: number) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.display_name,
    employeeId: account.employee_id,
    isAdmin: account.is_admin === 1,
    active: account.active === 1,
    mustChangePassword: account.must_change_password === 1,
    lockedUntil: account.locked_until !== null && account.locked_until > now ? account.locked_until : null,
    failedAttempts: account.failed_attempts,
    tabs: storedGrants(account),
    lastLoginAt: account.last_login_at,
    createdAt: account.created_at,
    activeSessions: sessions,
  };
}

async function loadAccount(id: unknown) {
  if (typeof id !== "string" || !id.startsWith(ACCOUNT_ID_PREFIX) || id.length > 80) return null;
  return db.prepare(`SELECT * FROM auth_accounts WHERE id = ?`).bind(id).first<AuthAccountRow>();
}

async function accountDto(id: string) {
  const now = Date.now();
  const account = await loadAccount(id) as AuthAccountRow;
  return toDto(account, (await activeSessionCounts(now)).get(id) ?? 0, now);
}

/** {hr?, compensation?} → 검증한 부여값. 부여할 수 없는 키(audit·admin·모르는 키)나 값이면 null. */
function parseTabGrants(value: unknown): Partial<Record<GrantableTabKey, TabLevel>> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grants: Partial<Record<GrantableTabKey, TabLevel>> = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!isGrantableTabKey(key) || typeof level !== "string" || !TAB_LEVELS.has(level)) return null;
    grants[key] = level as TabLevel;
  }
  return grants;
}

/** 저장된 JSON 의 모르는 키는 보존하고 부여 가능 키만 바꾼다. none 은 키 삭제다. */
function mergeGrants(tabsJson: string, grants: Partial<Record<GrantableTabKey, TabLevel>>) {
  const stored = parseStoredTabs(tabsJson);
  for (const [key, level] of Object.entries(grants)) {
    if (level === "none") delete stored[key];
    else stored[key] = level;
  }
  return JSON.stringify(stored);
}

function isUniqueViolation(error: unknown) {
  return /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? error));
}

async function emailTaken(email: string) {
  return Boolean(await db.prepare(`SELECT id FROM auth_accounts WHERE email = ?`).bind(email).first<string>("id"));
}

async function employeeLinkedElsewhere(employeeId: string, accountId = "") {
  return Boolean(await db.prepare(`SELECT id FROM auth_accounts WHERE employee_id = ? AND id <> ?`).bind(employeeId, accountId).first<string>("id"));
}

/** undefined = 바꾸지 않음, null = 연결 해제, 문자열 = 연결. 인사기록이 없거나 acct_ 접두면 오류 Response. */
async function resolveEmployeeInput(value: unknown): Promise<{ employee: { employee_id: string; name: string } | null | undefined } | { response: Response }> {
  if (value === undefined) return { employee: undefined };
  if (value === null || value === "") return { employee: null };
  if (typeof value !== "string") return { response: validation("인사기록을 찾을 수 없습니다.", "employeeId") };
  const employee = await findEmployeeRecord(db, value.trim());
  if (!employee) return { response: validation("인사기록을 찾을 수 없습니다.", "employeeId") };
  return { employee };
}

function displayNameInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

async function audit(principal: ErpPrincipal, action: string, entityId: string, after: Record<string, unknown>, before?: unknown) {
  const peer = peerOf(await headers()).address;
  await writeErpAudit(db, { principal, module: "admin", action, entityType: "AUTH_ACCOUNT", entityId, before, after: { ...after, peer } });
}

export async function GET() {
  const authorization = await authorizeErpRequest(db, "admin", "read");
  if (authorization.response) return authorization.response;
  const now = Date.now();
  const [accounts, sessions, employees] = await Promise.all([
    db.prepare(`SELECT * FROM auth_accounts ORDER BY created_at ASC, id ASC`).all<AuthAccountRow>(),
    activeSessionCounts(now),
    readOptionalHrRows<{ employee_id: string; name: string; department: string; status: string; linked_account_id: string | null }>(db, ["hr_employee_records"],
      `SELECT r.employee_id, r.name, r.department, r.status, a.id AS linked_account_id
       FROM hr_employee_records r LEFT JOIN auth_accounts a ON a.employee_id = r.employee_id`),
  ]);
  const retired = (status: string) => status.includes("퇴직") ? 1 : 0;
  const employeeList = employees.results
    .map((row) => ({ employeeId: row.employee_id, name: row.name, department: row.department, status: row.status, linkedAccountId: row.linked_account_id ?? null }))
    .sort((left, right) => retired(left.status) - retired(right.status) || left.name.localeCompare(right.name, "ko"));
  return Response.json({
    accounts: accounts.results.map((account) => toDto(account, sessions.get(account.id) ?? 0, now)),
    employees: employeeList,
    grantableTabs: GRANTABLE_TABS,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "admin", "write");
  if (authorization.response) return authorization.response;
  const principal = authorization.principal;
  let payload: Payload;
  try {
    payload = await request.json() as Payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
  } catch {
    return validation("요청 내용을 읽을 수 없습니다.");
  }
  const now = Date.now();
  switch (payload.action) {
    case "CREATE": return createAccount(principal, payload, now);
    case "UPDATE_PROFILE": return updateProfile(principal, payload, now);
    case "UPDATE_TABS": return updateTabs(principal, payload, now);
    case "RESET_PASSWORD": return resetPassword(principal, payload, now);
    case "UNLOCK": return simpleUpdate(principal, payload, now, "UNLOCK");
    case "REACTIVATE": return simpleUpdate(principal, payload, now, "REACTIVATE");
    case "DEACTIVATE": return deactivate(principal, payload, now);
    case "REVOKE_SESSIONS": return revokeSessions(principal, payload, now);
    default: return validation("지원하지 않는 작업입니다.", "action");
  }
}

async function createAccount(principal: ErpPrincipal, payload: Payload, now: number) {
  const email = normalizeEmail(payload.email);
  if (!isValidEmail(email)) return validation("이메일 형식을 확인해 주세요.", "email");
  const employeeInput = await resolveEmployeeInput(payload.employeeId);
  if ("response" in employeeInput) return employeeInput.response;
  const employee = employeeInput.employee ?? null;
  const nameInput = displayNameInput(payload.displayName);
  if (nameInput === null) return validation("이름은 1자 이상 60자 이하로 입력해 주세요.", "displayName");
  const displayName = nameInput ?? employee?.name ?? "";
  if (!displayName || displayName.length > 60) return validation("이름은 1자 이상 60자 이하로 입력해 주세요.", "displayName");
  if (payload.isAdmin !== undefined && typeof payload.isAdmin !== "boolean") return validation("관리자 여부를 확인해 주세요.", "isAdmin");
  const grants = parseTabGrants(payload.tabs);
  if (!grants) return validation("부여할 수 없는 탭 권한입니다.", "tabs");
  if (await emailTaken(email)) return erpError(409, "DUPLICATE", DUPLICATE_EMAIL, { field: "email" });
  if (employee && await employeeLinkedElsewhere(employee.employee_id)) return erpError(409, "DUPLICATE", DUPLICATE_EMPLOYEE, { field: "employeeId" });

  const id = `${ACCOUNT_ID_PREFIX}${crypto.randomUUID()}`;
  const temporaryPassword = generateTemporaryPassword();
  const tabsJson = mergeGrants("{}", grants);
  const isAdmin = payload.isAdmin === true;
  try {
    await db.prepare(`INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password,
        failed_attempts, locked_until, tabs_json, password_changed_at, last_login_at, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 0, NULL, ?7, NULL, NULL, ?8, ?9, ?9)`)
      .bind(id, email, displayName, await hashPassword(temporaryPassword), employee?.employee_id ?? null, isAdmin ? 1 : 0, tabsJson, principal.accountId, now)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) return erpError(409, "DUPLICATE", /employee/i.test(String(error)) ? DUPLICATE_EMPLOYEE : DUPLICATE_EMAIL);
    throw error;
  }
  await audit(principal, "ACCOUNT_CREATED", id, {
    email, employeeId: employee?.employee_id ?? null, isAdmin, tabs: JSON.parse(tabsJson), temporaryPasswordIssued: true,
  });
  return Response.json({ account: await accountDto(id), temporaryPassword }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

async function updateProfile(principal: ErpPrincipal, payload: Payload, now: number) {
  const before = await loadAccount(payload.id);
  if (!before) return erpError(404, "NOT_FOUND", NOT_FOUND);
  const nameInput = displayNameInput(payload.displayName);
  if (nameInput === null) return validation("이름은 1자 이상 60자 이하로 입력해 주세요.", "displayName");
  if (payload.isAdmin !== undefined && typeof payload.isAdmin !== "boolean") return validation("관리자 여부를 확인해 주세요.", "isAdmin");
  const employeeInput = await resolveEmployeeInput(payload.employeeId);
  if ("response" in employeeInput) return employeeInput.response;
  const employeeId = employeeInput.employee === undefined ? before.employee_id : employeeInput.employee?.employee_id ?? null;
  if (employeeId && await employeeLinkedElsewhere(employeeId, before.id)) return erpError(409, "DUPLICATE", DUPLICATE_EMPLOYEE, { field: "employeeId" });
  const displayName = nameInput ?? before.display_name;
  const isAdmin = payload.isAdmin === undefined ? before.is_admin : payload.isAdmin ? 1 : 0;
  const demoting = before.is_admin === 1 && isAdmin === 0;
  // 강등은 원자적 가드: 다른 활성 관리자가 1명 이상 남을 때만 적용된다.
  const guard = demoting ? ` AND (is_admin = 0 OR (SELECT COUNT(*) FROM auth_accounts WHERE is_admin = 1 AND active = 1 AND id <> ?5) >= 1)` : "";
  let changes = 0;
  try {
    const result = await db.prepare(`UPDATE auth_accounts SET display_name = ?1, employee_id = ?2, is_admin = ?3, updated_at = ?4 WHERE id = ?5${guard}`)
      .bind(displayName, employeeId, isAdmin, now, before.id).run();
    changes = result.meta.changes ?? 0;
  } catch (error) {
    if (isUniqueViolation(error)) return erpError(409, "DUPLICATE", DUPLICATE_EMPLOYEE, { field: "employeeId" });
    throw error;
  }
  if (changes === 0) return erpError(409, "LAST_ADMIN", LAST_ADMIN);
  await audit(principal, "ACCOUNT_PROFILE_UPDATED", before.id,
    { displayName, employeeId, isAdmin: isAdmin === 1 },
    { displayName: before.display_name, employeeId: before.employee_id, isAdmin: before.is_admin === 1 });
  return Response.json({ account: await accountDto(before.id) });
}

async function updateTabs(principal: ErpPrincipal, payload: Payload, now: number) {
  const before = await loadAccount(payload.id);
  if (!before) return erpError(404, "NOT_FOUND", NOT_FOUND);
  if (payload.tabs === undefined) return validation("부여할 탭 권한을 입력해 주세요.", "tabs");
  const grants = parseTabGrants(payload.tabs);
  if (!grants) return validation("부여할 수 없는 탭 권한입니다.", "tabs");
  const tabsJson = mergeGrants(before.tabs_json, grants);
  await db.prepare(`UPDATE auth_accounts SET tabs_json = ?, updated_at = ? WHERE id = ?`).bind(tabsJson, now, before.id).run();
  const after = await loadAccount(before.id) as AuthAccountRow;
  await audit(principal, "ACCOUNT_TABS_UPDATED", before.id, { tabs: storedGrants(after) }, { tabs: storedGrants(before) });
  return Response.json({ account: await accountDto(before.id) });
}

async function resetPassword(principal: ErpPrincipal, payload: Payload, now: number) {
  const target = await loadAccount(payload.id);
  if (!target) return erpError(404, "NOT_FOUND", NOT_FOUND);
  if (target.id === principal.accountId) return validation("본인 비밀번호는 비밀번호 변경에서 바꿔 주세요.");
  const temporaryPassword = generateTemporaryPassword();
  const results = await db.batch([
    db.prepare(`UPDATE auth_accounts SET password_hash = ?1, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ?2 WHERE id = ?3`)
      .bind(await hashPassword(temporaryPassword), now, target.id),
    revokeAccountSessions(db, target.id, "PASSWORD_RESET", now),
  ]);
  await audit(principal, "ACCOUNT_PASSWORD_RESET", target.id, { temporaryPasswordIssued: true, revokedSessions: results[1]?.meta?.changes ?? 0 });
  return Response.json({ account: await accountDto(target.id), temporaryPassword }, { headers: { "Cache-Control": "no-store" } });
}

async function simpleUpdate(principal: ErpPrincipal, payload: Payload, now: number, kind: "UNLOCK" | "REACTIVATE") {
  const target = await loadAccount(payload.id);
  if (!target) return erpError(404, "NOT_FOUND", NOT_FOUND);
  // REACTIVATE 는 폐기된 세션을 되살리지 않는다.
  const sql = kind === "UNLOCK"
    ? `UPDATE auth_accounts SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`
    : `UPDATE auth_accounts SET active = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`;
  await db.prepare(sql).bind(now, target.id).run();
  await audit(principal, kind === "UNLOCK" ? "ACCOUNT_UNLOCKED" : "ACCOUNT_REACTIVATED", target.id, {});
  return Response.json({ account: await accountDto(target.id) });
}

async function deactivate(principal: ErpPrincipal, payload: Payload, now: number) {
  const target = await loadAccount(payload.id);
  if (!target) return erpError(404, "NOT_FOUND", NOT_FOUND);
  if (target.id === principal.accountId) return validation("본인 계정은 비활성화할 수 없습니다.");
  const results = await db.batch([
    db.prepare(`UPDATE auth_accounts SET active = 0, updated_at = ?1
      WHERE id = ?2 AND (is_admin = 0 OR (SELECT COUNT(*) FROM auth_accounts WHERE is_admin = 1 AND active = 1 AND id <> ?2) >= 1)`)
      .bind(now, target.id),
    db.prepare(`UPDATE auth_sessions SET revoked_at = ?1, revoked_reason = 'DEACTIVATED'
      WHERE account_id = ?2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = ?2 AND active = 0)`)
      .bind(now, target.id),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return erpError(409, "LAST_ADMIN", LAST_ADMIN);
  await audit(principal, "ACCOUNT_DEACTIVATED", target.id, { revokedSessions: results[1]?.meta?.changes ?? 0 });
  return Response.json({ account: await accountDto(target.id) });
}

async function revokeSessions(principal: ErpPrincipal, payload: Payload, now: number) {
  const target = await loadAccount(payload.id);
  if (!target) return erpError(404, "NOT_FOUND", NOT_FOUND);
  // 본인이면 현재 세션도 폐기된다.
  const result = await revokeAccountSessions(db, target.id, "ADMIN_REVOKE", now).run();
  await audit(principal, "SESSIONS_REVOKED", target.id, { revokedSessions: result.meta.changes ?? 0 });
  return Response.json({ account: await accountDto(target.id) });
}
