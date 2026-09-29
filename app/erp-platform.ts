import { headers } from "next/headers";
import { crossSiteViolation, CROSS_ORIGIN_ERROR } from "./request-guard";
import { authSchemaStatements, resolveSession, toPrincipal, type AccountPrincipal } from "./auth-session";
import { accessDecision, type ErpAction, type ErpModule } from "./access-tabs";

// R3(Design §3·§4.3.1): 신원은 세션 쿠키로 정한다. 인사기록 연결은 선택이다(D14).
// 권한은 계정별 탭 수준(none·view·edit)이고, 모듈→탭 대응과 판정(canAccess)은 app/access-tabs.ts 의 레지스트리가 정한다(D20).

export type { ErpAction, ErpModule } from "./access-tabs";
export type ErpPrincipal = AccountPrincipal;
/** writeErpAudit 의 행위자. 인증 전 이벤트는 anonymousActor(email). */
export type AuditActor = Pick<ErpPrincipal, "userId" | "email" | "employeeId">;

/**
 * self·manager 판정에 쓰는 인사기록 id(Design §10.4-8, 부록 C #27). 연결 없는 계정의 employeeId 는 'acct_…' 이고
 * 인사기록 id 가 아니므로 null 을 돌려준다. 이 값과 같은지 비교하면 미연결 계정은 누구의 본인·팀장도 되지 않는다.
 */
export function linkedEmployeeId(principal: Pick<ErpPrincipal, "linkedEmployee" | "employeeId">): string | null {
  return principal.linkedEmployee === true ? principal.employeeId : null;
}

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

// ── 운영 (R4, Design §3.3·§11.5.8, 부록 C #6) ──────────────────────────────────────
// 백업 스크립트(scripts/verify-state-snapshot.mjs --record-run)가 서버 정지 중에 같은 DDL 로 표를 만들고 한 행을 쓴다.
// 두 파일의 문자열이 같은지는 tests/lan-exposure-guards.test.mjs 가 대조한다. 여기서 바꾸면 스크립트도 같이 바꾼다.
const OPS_BACKUP_RUNS_DDL = `CREATE TABLE IF NOT EXISTS ops_backup_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OK','FAILED')),
  backup_dir TEXT NOT NULL,
  integrity TEXT NOT NULL DEFAULT '',
  r2_object_count INTEGER NOT NULL DEFAULT 0,
  row_counts_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
)`;
const OPS_BACKUP_RUNS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_ops_backup_runs_finished ON ops_backup_runs(finished_at)`;

function opsSchemaStatements(db: D1Database) {
  return [db.prepare(OPS_BACKUP_RUNS_DDL), db.prepare(OPS_BACKUP_RUNS_INDEX_DDL)];
}

/**
 * 공용 스키마. 조건 없이, 멱등으로 한 batch 에서 만든다. 추가만 하고 DROP 은 하지 않는다(D4).
 * 결재(erp_approval_*)·업무(erp_tasks)·동기화(erp_sync_runs)는 R1, hr_authorized_users·erp_user_access 와 gc.kim 시드는
 * R3 에서 더 만들지 않는다(Design §3.4). 기존 DB 의 테이블과 행은 그대로 남는다. 순서는 audit → auth → ops(R4) → chat(R5)이다.
 */
export async function ensureErpPlatformSchema(db: D1Database) {
  await db.batch([...auditStatements(db), ...authSchemaStatements(db), ...opsSchemaStatements(db)]);
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

/**
 * 순서(Design §4.3.1): 게이트 → headers() → 교차 출처 403 → 세션 401 → 비밀번호 변경 필요 403 → principal → 권한 403(+ACCESS_DENIED 감사).
 * 시그니처는 R1과 같다. 메서드를 모르므로 비GET 교차 출처 차단은 worker/index.ts 가 먼저 한다.
 * module 은 호출부의 문자열 리터럴이다(§10.4). 레지스트리에 없는 값이 들어와도(런타임 값) 관리자까지 거부한다.
 */
export async function authorizeErpRequest(db: D1Database, module: ErpModule, action: ErpAction): Promise<
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
  module: ErpModule | "auth";
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
