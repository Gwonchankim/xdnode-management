import { headers } from "next/headers";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "./request-guard";
import {
  authSchemaStatements, resolveSession, toPrincipal,
  type AccountPrincipal, type ErpRole as SessionErpRole, type TabKey, type TabLevel,
} from "./auth-session";

// R3(r3-auth, Design §3·§4.3.1): 신원은 세션 쿠키로 정한다. 인사기록 연결은 선택이다(D14).
// 권한 판정은 탭 수준(none·view·edit)이다. 모듈→탭 대응과 canAccess 는 r3-tabs 에서 app/access-tabs.ts 로 옮긴다.

/** @deprecated 임시 호환(r3-tabs 에서 삭제). */
export type ErpRole = SessionErpRole;
export type ErpModule = "hr" | "recruitment" | "settings";
/** 가드가 받는 모듈. r3-tabs 에서 레지스트리 파생 ErpModule 하나로 합친다. */
export type GuardModule = ErpModule | "compensation" | "audit" | "admin";
export type ErpAction = "read" | "write" | "approve" | "delete" | "admin";
export type ErpPrincipal = AccountPrincipal;
/** writeErpAudit 의 행위자. 인증 전 이벤트는 anonymousActor(email). */
export type AuditActor = Pick<ErpPrincipal, "userId" | "email" | "employeeId">;

export function anonymousActor(email = ""): AuditActor {
  return { userId: "anonymous", email: email.slice(0, 200), employeeId: "anonymous" };
}

function auditStatements(db: D1Database) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS erp_audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      actor_employee_id TEXT NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_erp_audit_module_created
      ON erp_audit_logs (module, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_erp_audit_entity
      ON erp_audit_logs (entity_type, entity_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_erp_audit_created_id
      ON erp_audit_logs (created_at, id)`),
  ];
}

/**
 * 공용 스키마. 조건 없이, 멱등으로 한 batch 에서 만든다. 추가만 하고 DROP 은 하지 않는다(D4).
 * 결재(erp_approval_*)·업무(erp_tasks)·동기화(erp_sync_runs)는 R1, hr_authorized_users·erp_user_access 와 gc.kim 시드는
 * R3 에서 더 만들지 않는다(Design §3.4). 기존 DB 의 테이블과 행은 그대로 남는다.
 */
export async function ensureErpPlatformSchema(db: D1Database) {
  await db.batch([...auditStatements(db), ...authSchemaStatements(db)]);
}

let schemaGate: Promise<void> | null = null;
/** 프로세스당 한 번만 스키마를 만든다. 실패하면 게이트를 비워 다음 요청에서 다시 시도한다. */
export function platformSchemaReady(db: D1Database) {
  if (!schemaGate) {
    schemaGate = ensureErpPlatformSchema(db).catch((error) => {
      schemaGate = null;
      throw error;
    });
  }
  return schemaGate;
}

/** 하니스 전용: 새 메모리 DB 를 만들 때 게이트를 비운다(Design §8.5). */
export function resetPlatformSchemaGate() {
  schemaGate = null;
}

export function erpError(status: number, code: string, error: string, extra: Record<string, unknown> = {}, init: ResponseInit = {}) {
  return Response.json({ error, code, ...extra }, { ...init, status });
}

// ── 권한 판정(임시, r3-tabs 에서 access-tabs.canAccess 로 교체) ──────
const MODULE_TAB: ReadonlyMap<string, TabKey> = new Map<string, TabKey>([
  ["hr", "hr"],
  ["recruitment", "hr"],
  ["compensation", "compensation"],
  // settings 는 R1까지의 관리자 전용 모듈 이름이다(audit-log, authorized-users). r3-tabs 에서 audit·admin 으로 바뀐다.
  ["settings", "audit"],
  ["audit", "audit"],
  ["admin", "admin"],
]);
const ADMIN_ONLY_TABS: ReadonlySet<TabKey> = new Set<TabKey>(["audit", "admin"]);
const LEVEL_RANK: Record<TabLevel, number> = { none: 0, view: 1, edit: 2 };
const REQUIRED_LEVEL: Record<string, "view" | "edit" | "admin"> = { read: "view", write: "edit", approve: "edit", delete: "edit", admin: "admin" };

function accessDecision(principal: ErpPrincipal, module: string, action: string) {
  const tab = MODULE_TAB.get(module) ?? null;
  const required = Object.hasOwn(REQUIRED_LEVEL, action) ? REQUIRED_LEVEL[action] : null;
  const granted: TabLevel = tab ? principal.tabs[tab] : "none";
  let allowed: boolean;
  if (!tab || !required) allowed = false;                         // 모르는 모듈·action 은 관리자에게도 거부(fail closed)
  else if (required === "admin" || ADMIN_ONLY_TABS.has(tab)) allowed = principal.isAdmin;
  else if (principal.isAdmin) allowed = true;
  else allowed = LEVEL_RANK[granted] >= LEVEL_RANK[required];
  return { allowed, tab, required, granted };
}

/**
 * 순서(Design §4.3.1): 게이트 → headers() → 교차 출처 403 → 세션 401 → 비밀번호 변경 필요 403 → principal → 권한 403(+ACCESS_DENIED 감사).
 * 시그니처는 R1과 같다. 메서드를 모르므로 비GET 교차 출처 차단은 worker/index.ts 가 먼저 한다.
 */
export async function authorizeErpRequest(db: D1Database, module: GuardModule, action: ErpAction): Promise<
  { principal: ErpPrincipal; response?: never } | { principal?: never; response: Response }
> {
  await platformSchemaReady(db);
  const requestHeaders = await headers();
  if (crossSiteViolation(requestHeaders)) return { response: Response.json(CROSS_ORIGIN_ERROR, { status: 403 }) };
  const session = await resolveSession(db, requestHeaders.get("cookie"));
  if (!session) return { response: erpError(401, "UNAUTHENTICATED", "로그인이 필요합니다.") };
  if (session.account.must_change_password === 1) {
    return { response: erpError(403, "PASSWORD_CHANGE_REQUIRED", "비밀번호를 먼저 변경해 주세요.") };
  }
  const principal = toPrincipal(session.account);
  const decision = accessDecision(principal, module, action);
  if (!decision.allowed) {
    await writeErpAudit(db, {
      principal,
      module: decision.tab ? module : "auth",
      action: "ACCESS_DENIED",
      entityType: "ACCESS",
      entityId: `${module}:${action}`.slice(0, 120),
      after: { module, action, tab: decision.tab, required: decision.required, granted: decision.granted },
    });
    return { response: erpError(403, "FORBIDDEN", "이 작업을 수행할 권한이 없습니다.") };
  }
  return { principal };
}

function auditJson(value: unknown) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized.length > 30_000 ? JSON.stringify({ truncated: true }) : serialized;
}

export async function writeErpAudit(db: D1Database, input: {
  principal: AuditActor;
  module: GuardModule | "auth";
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  await platformSchemaReady(db);
  await db.prepare(`INSERT INTO erp_audit_logs
    (id, actor_user_id, actor_email, actor_employee_id, module, action, entity_type,
      entity_id, before_json, after_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      input.principal.userId,
      input.principal.email,
      input.principal.employeeId,
      input.module,
      input.action,
      input.entityType,
      input.entityId,
      auditJson(input.before),
      auditJson(input.after),
      input.reason?.slice(0, 500) ?? "",
      Date.now(),
    ).run();
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
