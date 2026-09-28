import { companyEmployees } from "./hr-company-data";
import { getChatGPTUser } from "./chatgpt-auth";

export type ErpRole = "SUPER_ADMIN" | "HR_ADMIN" | "RECRUITER" | "VIEWER";
export type ErpModule = "operations" | "finance" | "hr" | "recruitment" | "sales" | "settings";
export type ErpAction = "read" | "write" | "approve" | "delete" | "admin";

export type ErpPrincipal = {
  userId: string;
  email: string;
  displayName: string;
  employeeId: string;
  employeeName: string;
  roles: ErpRole[];
};

type AccessRow = {
  employee_id: string;
  email: string;
  roles_json: string;
  active: number;
};

const rolePermissions: Record<ErpRole, Set<string>> = {
  SUPER_ADMIN: new Set(["*"]),
  HR_ADMIN: new Set(["operations:read", "operations:write", "hr:read", "hr:write", "hr:approve", "hr:delete", "recruitment:read", "recruitment:write", "recruitment:approve", "recruitment:delete"]),
  RECRUITER: new Set(["operations:read", "recruitment:read", "recruitment:write"]),
  VIEWER: new Set(["operations:read", "hr:read", "recruitment:read"]),
};

const administratorEmployeeId = "gc.kim";
const administrator = companyEmployees.find((employee) => employee.id === administratorEmployeeId);

export async function ensureErpPlatformSchema(db: D1Database) {
  const now = Date.now();
  const statements = [
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_authorized_users (
      employee_id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS erp_user_access (
      employee_id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      roles_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
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
    // 결재(erp_approval_*)·업무(erp_tasks)·동기화(erp_sync_runs) 테이블은 더 만들지 않는다(D2-개정, Design §12.4).
    // 기존 DB 의 테이블은 지우지 않는다(D4).
  ];
  if (administrator?.email && administrator.email !== "미입력") {
    statements.push(db.prepare(`INSERT OR IGNORE INTO erp_user_access
      (employee_id, email, roles_json, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`)
      .bind(administrator.id, administrator.email.toLowerCase(), JSON.stringify(["SUPER_ADMIN"]), now, now));
  }
  await db.batch(statements);
}

function parseRoles(value: string): ErpRole[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((role): role is ErpRole => typeof role === "string" && role in rolePermissions);
  } catch {
    return [];
  }
}

function hasPermission(roles: ErpRole[], module: ErpModule, action: ErpAction) {
  return roles.some((role) => rolePermissions[role].has("*") || rolePermissions[role].has(`${module}:${action}`));
}

export async function authorizeErpRequest(db: D1Database, module: ErpModule, action: ErpAction): Promise<
  { principal: ErpPrincipal; response?: never } | { principal?: never; response: Response }
> {
  await ensureErpPlatformSchema(db);
  const user = await getChatGPTUser();
  if (!user) {
    return { response: Response.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  }

  const normalizedEmail = user.email.trim().toLowerCase();
  const companyEmployee = companyEmployees.find((item) => item.email.toLowerCase() === normalizedEmail);
  let employee: { id: string; name: string } | undefined = companyEmployee;
  if (!employee) {
    try {
      const storedEmployee = await db.prepare(`SELECT employee_id, name FROM hr_employee_records
        WHERE lower(email) = ? LIMIT 1`).bind(normalizedEmail).first<{ employee_id: string; name: string }>();
      if (storedEmployee) employee = { id: storedEmployee.employee_id, name: storedEmployee.name };
    } catch {
      // The static company directory remains the fallback before the HR migration is applied.
    }
  }
  if (!employee) {
    return { response: Response.json({ error: "회사 인사기록과 연결되지 않은 계정입니다." }, { status: 403 }) };
  }

  let access = await db.prepare(`SELECT employee_id, email, roles_json, active
    FROM erp_user_access WHERE lower(email) = ? LIMIT 1`)
    .bind(normalizedEmail).first<AccessRow>();

  if (!access) {
    const legacy = await db.prepare(`SELECT employee_id FROM hr_authorized_users
      WHERE employee_id = ? LIMIT 1`).bind(employee.id).first<{ employee_id: string }>();
    if (legacy) {
      const now = Date.now();
      await db.prepare(`INSERT OR IGNORE INTO erp_user_access
        (employee_id, email, roles_json, active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)`)
        .bind(employee.id, normalizedEmail, JSON.stringify(["VIEWER"]), now, now).run();
      access = { employee_id: employee.id, email: normalizedEmail, roles_json: JSON.stringify(["VIEWER"]), active: 1 };
    }
  }

  if (!access || !access.active) {
    return { response: Response.json({ error: "ERP 사용 권한이 없습니다." }, { status: 403 }) };
  }

  const roles = parseRoles(access.roles_json);
  if (!hasPermission(roles, module, action)) {
    return { response: Response.json({ error: "이 작업을 수행할 권한이 없습니다." }, { status: 403 }) };
  }

  return {
    principal: {
      userId: user.userId,
      email: normalizedEmail,
      displayName: user.displayName,
      employeeId: employee.id,
      employeeName: employee.name,
      roles,
    },
  };
}

function auditJson(value: unknown) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized.length > 30_000 ? JSON.stringify({ truncated: true }) : serialized;
}

export async function writeErpAudit(db: D1Database, input: {
  principal: ErpPrincipal;
  module: ErpModule;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  await ensureErpPlatformSchema(db);
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

// Shared period-lock check for finance modules — see docs/finance-remediation-plan.md Stage 2
// ("blockedPeriods() 공용화"). Before this, posting-control had the only rigorous version (blocks
// CLOSED, SUBMITTED, and never-opened past periods); debt/expense-control/fixed-assets/
// project-costing/tax each carried their own copy that only checked CLOSED — meaning those
// subsidiary ledgers could post into a month the GL had already refused, or into a month currently
// awaiting close approval against a frozen snapshot. All finance period-lock checks should route
// through this one function so the rule can't drift apart again.
export async function blockedFinancePeriods(db: D1Database, periods: string[]) {
  if (!periods.length) return [] as string[];
  const unique = [...new Set(periods)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT period,status FROM finance_close_runs WHERE period IN (${placeholders})`)
    .bind(...unique).all<{ period: string; status: string }>().catch(() => ({ results: [] }));
  const states = new Map(rows.results.map((row) => [row.period, row.status]));
  const currentPeriod = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  return unique.filter((period) => ["CLOSED", "SUBMITTED"].includes(states.get(period) ?? "")
    || (!states.has(period) && period !== currentPeriod));
}

export async function isFinancePeriodLocked(db: D1Database, period: string) {
  return (await blockedFinancePeriods(db, [period])).length > 0;
}
