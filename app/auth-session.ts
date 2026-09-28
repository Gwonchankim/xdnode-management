// 계정·세션 저장소, 로그인 시도 예약, peer 판정, principal 조립(Design §3, §7.2, §7.4).
// erp-platform 을 import하지 않는다(erp-platform → auth-session 한 방향, §9.2). 쿠키는 headers().get("cookie") 로만 읽고,
// Set-Cookie 는 라우트가 Response 에 직접 싣는다(cookies() 금지, §10.2).

// ── 상수(§7.2·§7.4) ──────────────────────────────────────────────────
export const SESSION_COOKIE = "xdm_session";
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 2_592_000_000;
export const SESSION_TOUCH_INTERVAL_MS = 3_600_000;
export const ACCOUNT_ID_PREFIX = "acct_";
export const PEER_HEADER = "x-xdm-peer";
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 300_000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ── 타입(§3.1) ───────────────────────────────────────────────────────
export interface AuthAccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  employee_id: string | null;
  is_admin: 0 | 1;
  active: 0 | 1;
  must_change_password: 0 | 1;
  failed_attempts: number;
  locked_until: number | null;
  tabs_json: string;
  password_changed_at: number | null;
  last_login_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}
export type SessionRevokeReason = "LOGOUT" | "PASSWORD_CHANGED" | "PASSWORD_RESET" | "DEACTIVATED" | "ADMIN_REVOKE";
export type PeerInfo = { address: string; loopback: boolean };
export type ResolvedSession = { sessionId: string; account: AuthAccountRow };
export type LoginReservation = { failedAttempts: number; lockedUntil: number | null };

// ── 탭 해석(임시) ────────────────────────────────────────────────────
// r3-tabs 에서 app/access-tabs.ts 의 TAB_REGISTRY·resolveTabs 로 옮긴다(Design §4.3.1). 그때까지 R3 탭 4개를 여기 둔다.
// 키 목록과 규칙은 레지스트리와 같다: 없는 키 = none, 모르는 키·adminOnly 키는 버린다, 관리자는 모두 edit.
export type TabLevel = "none" | "view" | "edit";
export const INTERIM_TABS = [
  { key: "hr", label: "인사관리", adminOnly: false },
  { key: "compensation", label: "임금 계산", adminOnly: false },
  { key: "audit", label: "감사 로그", adminOnly: true },
  { key: "admin", label: "계정 관리", adminOnly: true },
] as const;
export type TabKey = (typeof INTERIM_TABS)[number]["key"];
export type GrantableTabKey = Extract<(typeof INTERIM_TABS)[number], { adminOnly: false }>["key"];
export type ResolvedTabs = Record<TabKey, TabLevel>;
export const GRANTABLE_TABS = INTERIM_TABS.filter((tab) => !tab.adminOnly).map((tab) => ({ key: tab.key as GrantableTabKey, label: tab.label }));
const GRANTABLE_KEYS: ReadonlySet<string> = new Set(GRANTABLE_TABS.map((tab) => tab.key));

export function isGrantableTabKey(key: string): key is GrantableTabKey {
  return GRANTABLE_KEYS.has(key);
}

export function parseStoredTabs(tabsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tabsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function resolveTabs(tabsJson: string, isAdmin: boolean): ResolvedTabs {
  const stored = parseStoredTabs(tabsJson);
  const resolved = {} as ResolvedTabs;
  for (const tab of INTERIM_TABS) {
    if (isAdmin) { resolved[tab.key] = "edit"; continue; }
    const value = !tab.adminOnly && Object.hasOwn(stored, tab.key) ? stored[tab.key] : undefined;
    resolved[tab.key] = value === "view" || value === "edit" ? value : "none";
  }
  return resolved;
}

// ── principal ────────────────────────────────────────────────────────
/** 옛 역할 이름. r3-tabs 에서 principal.roles 사용처(analytics·performance·training·operations)를 isHrManager 로 바꾸며 없앤다. */
export type ErpRole = "SUPER_ADMIN" | "HR_ADMIN" | "RECRUITER" | "VIEWER";
export type AccountPrincipal = {
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  employeeId: string;
  employeeName: string;
  linkedEmployee: boolean;
  isAdmin: boolean;
  tabs: ResolvedTabs;
  /** @deprecated 임시 호환 필드(r3-auth ~ r3-tabs). 탭 권한에서 파생한다. 새 코드는 isAdmin·tabs 를 쓴다. */
  roles: ErpRole[];
};

export function toPrincipal(account: AuthAccountRow): AccountPrincipal {
  const isAdmin = account.is_admin === 1;
  const tabs = resolveTabs(account.tabs_json, isAdmin);
  const roles: ErpRole[] = isAdmin ? ["SUPER_ADMIN"] : tabs.hr === "edit" ? ["HR_ADMIN"] : tabs.hr === "view" ? ["VIEWER"] : [];
  return {
    userId: account.id,
    accountId: account.id,
    email: account.email,
    displayName: account.display_name,
    employeeId: account.employee_id ?? account.id,
    employeeName: account.display_name,
    linkedEmployee: account.employee_id !== null,
    isAdmin,
    tabs,
    roles,
  };
}

export function sessionUserDto(principal: AccountPrincipal) {
  return {
    accountId: principal.accountId,
    email: principal.email,
    name: principal.displayName,
    employeeId: principal.employeeId,
    linkedEmployee: principal.linkedEmployee,
  };
}

// ── 스키마(§3.3) ─────────────────────────────────────────────────────
export function authSchemaStatements(db: D1Database) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      employee_id TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      tabs_json TEXT NOT NULL DEFAULT '{}',
      password_changed_at INTEGER,
      last_login_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_accounts_employee ON auth_accounts(employee_id) WHERE employee_id IS NOT NULL`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_reason TEXT NOT NULL DEFAULT '',
      peer TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id, revoked_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`),
  ];
}

// ── 토큰·쿠키 ────────────────────────────────────────────────────────
function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32바이트 → base64url 43자. 원문은 쿠키에만 있다. */
export function newSessionToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

/** DB 의 auth_sessions.id = hex(SHA-256(token)). */
export async function hashToken(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cookie 헤더에서 xdm_session 값을 꺼낸다. 형식(43자 base64url)이 아니거나 값이 둘 이상이면 세션 없음이다. */
export function readSessionToken(cookieHeader: string | null) {
  if (!cookieHeader) return null;
  const values = cookieHeader.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  if (values.length !== 1 || !SESSION_TOKEN_PATTERN.test(values[0])) return null;
  return values[0];
}

/** http LAN 이라 Secure·__Host- 는 붙이지 않는다(§7.2). */
export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── 세션 ─────────────────────────────────────────────────────────────
/** 새 세션 INSERT 문장. 로그인 batch 에 넣는다. */
export function createSession(db: D1Database, input: { sessionId: string; accountId: string; now: number; peer: string; userAgent: string }) {
  return db.prepare(`INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at, revoked_at, revoked_reason, peer, user_agent)
    VALUES (?1, ?2, ?3, ?3 + ${SESSION_TTL_MS}, ?3, NULL, '', ?4, ?5)`)
    .bind(input.sessionId, input.accountId, input.now, input.peer, input.userAgent.slice(0, 200));
}

type SessionJoinRow = AuthAccountRow & { session_id: string; session_last_seen_at: number };

/** 요청마다 1회. 폐기·만료·비활성 계정이면 null. HR 테이블은 읽지 않고 캐시도 두지 않는다(Plan M4). */
export async function resolveSession(db: D1Database, cookieHeader: string | null, now = Date.now()): Promise<ResolvedSession | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  const sessionId = await hashToken(token);
  const row = await db.prepare(`SELECT s.id AS session_id, s.last_seen_at AS session_last_seen_at, a.*
    FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id
    WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1`)
    .bind(sessionId, now).first<SessionJoinRow>();
  if (!row) return null;
  if (row.session_last_seen_at < now - SESSION_TOUCH_INTERVAL_MS) {
    await db.prepare(`UPDATE auth_sessions SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?1 - ${SESSION_TOUCH_INTERVAL_MS}`)
      .bind(now, sessionId).run();
  }
  const { session_id: resolvedId, session_last_seen_at: ignored, ...account } = row;
  void ignored;
  return { sessionId: resolvedId, account: account as AuthAccountRow };
}

/** 그 계정의 살아 있는 세션을 폐기하는 문장. exceptSessionId 를 주면 그 세션은 남긴다. */
export function revokeAccountSessions(db: D1Database, accountId: string, reason: SessionRevokeReason, now: number, exceptSessionId?: string) {
  return exceptSessionId
    ? db.prepare(`UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE account_id = ? AND id <> ? AND revoked_at IS NULL`)
      .bind(now, reason, accountId, exceptSessionId)
    : db.prepare(`UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE account_id = ? AND revoked_at IS NULL`)
      .bind(now, reason, accountId);
}

// ── 로그인 시도 예약(§7.4) ───────────────────────────────────────────
const RESERVATION_SET = `
  failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= ?1 THEN 1 ELSE failed_attempts + 1 END,
  locked_until = CASE
    WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ?1 THEN 1 ELSE failed_attempts + 1 END) >= ${LOGIN_MAX_FAILURES} THEN ?1 + ${LOGIN_LOCK_MS}
    WHEN locked_until IS NOT NULL AND locked_until <= ?1 THEN NULL
    ELSE locked_until END,
  updated_at = ?1`;

/**
 * 검증하기 전에 시도 한 번을 원자적으로 예약한다. 잠금 조건이 UPDATE 의 WHERE 안에 있으므로 동시에 20건이 와도
 * 예약에 성공하는 것은 5건뿐이다. null = 잠겨 있어 예약하지 못함(검증하지 말고 429).
 * enforceLock=false 는 D21(서버 PC 루프백 로그인) 전용이다. 실패 횟수는 세지만 잠금 검사는 하지 않는다.
 * 비밀번호 변경은 peer 와 관계없이 항상 enforceLock=true 로 부른다(부록 C #23).
 */
export async function reserveLoginAttempt(db: D1Database, accountId: string, now: number, options: { enforceLock: boolean }): Promise<LoginReservation | null> {
  const where = options.enforceLock ? "WHERE id = ?2 AND (locked_until IS NULL OR locked_until <= ?1)" : "WHERE id = ?2";
  const row = await db.prepare(`UPDATE auth_accounts SET ${RESERVATION_SET} ${where} RETURNING failed_attempts, locked_until`)
    .bind(now, accountId).first<{ failed_attempts: number; locked_until: number | null }>();
  return row ? { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until } : null;
}

/** 이 예약이 잠금을 건 바로 그 시도인지(ACCOUNT_LOCKED 를 한 번만 남기기 위해). */
export function reservationLocked(reservation: LoginReservation, now: number) {
  return reservation.failedAttempts === LOGIN_MAX_FAILURES && reservation.lockedUntil === now + LOGIN_LOCK_MS;
}

export async function lockedRetryAfterSeconds(db: D1Database, accountId: string, now: number) {
  const lockedUntil = await db.prepare(`SELECT locked_until FROM auth_accounts WHERE id = ?`).bind(accountId).first<number | null>("locked_until");
  return Math.max(1, Math.ceil(((lockedUntil ?? now) - now) / 1000));
}

// ── peer(§7.4 '루프백 판정을 위조할 수 없는 이유') ────────────────────
/**
 * 신뢰하는 것은 Node 의 local-peer 플러그인이 지우고 다시 쓴 x-xdm-peer 하나다. Host·Origin·CF-Connecting-IP 는 보지 않는다.
 * 헤더가 없거나 ',' 가 들어 있으면(값이 여러 개 합쳐진 경우) 비루프백이다.
 * 주의: 플러그인(build/local-peer-vite-plugin.ts)은 r3-runtime 에서 들어온다. 그 전까지 이 헤더는 클라이언트가 보낸 값 그대로이므로
 * 테스트 밖에서는 믿으면 안 된다(r3 는 한 번에 배포한다, Design §11.3).
 */
export function peerOf(headers: { get(name: string): string | null }): PeerInfo {
  const raw = headers.get(PEER_HEADER);
  if (raw === null || raw.includes(",")) return { address: "", loopback: false };
  const address = raw.trim().slice(0, 64);
  return { address, loopback: (LOOPBACK_ADDRESSES as readonly string[]).includes(address) };
}

// ── 기타 ─────────────────────────────────────────────────────────────
export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string) {
  return email.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(email);
}

export async function accountsExist(db: D1Database) {
  return Boolean(await db.prepare(`SELECT EXISTS(SELECT 1 FROM auth_accounts) AS present`).first<number>("present"));
}

/** 미연결 계정의 표시 이름(비활성 포함, email 없음). r3-tabs 에서 GET /api/hr/operations 의 accountNames 가 쓴다. */
export async function unlinkedAccountNames(db: D1Database) {
  const result = await db.prepare(`SELECT id, display_name FROM auth_accounts WHERE employee_id IS NULL`).all<{ id: string; display_name: string }>();
  return Object.fromEntries(result.results.map((row) => [row.id, row.display_name])) as Record<string, string>;
}

/** 계정 연결 대상 인사기록. 테이블이 아직 없으면(빈 DB) 없는 것으로 본다. `acct_` 접두 id 는 인사기록 id 가 될 수 없다. */
export async function findEmployeeRecord(db: D1Database, employeeId: string) {
  if (!employeeId || employeeId.startsWith(ACCOUNT_ID_PREFIX) || employeeId.length > 120) return null;
  const exists = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hr_employee_records'`).first<string>("name");
  if (!exists) return null;
  return db.prepare(`SELECT employee_id, name FROM hr_employee_records WHERE employee_id = ?`)
    .bind(employeeId).first<{ employee_id: string; name: string }>();
}
