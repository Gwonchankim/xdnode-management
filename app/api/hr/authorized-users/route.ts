import { env } from "cloudflare:workers";
import { companyEmployees } from "../../../hr-company-data";
import { authorizeErpRequest, ensureErpPlatformSchema, safeJson, writeErpAudit } from "../../../erp-platform";
import type { ErpRole } from "../../../erp-platform";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;
const currentAdministratorId = "gc.kim";
// 재무·영업 관리자 역할은 두 모듈과 함께 없어졌다(D2). 라우트 자체는 R3에 계정 관리로 대체된다.
const allowedRoles = new Set<ErpRole>(["SUPER_ADMIN", "HR_ADMIN", "RECRUITER", "VIEWER"]);

type AccessRow = {
  employee_id: string;
  email: string;
  roles_json: string;
  active: number;
  created_at: number;
  updated_at: number;
};

async function employeeById(employeeId: string) {
  const employee = companyEmployees.find((item) => item.id === employeeId);
  if (employee) return employee;
  const stored = await db.prepare("SELECT employee_id, name, email FROM hr_employee_records WHERE employee_id = ? LIMIT 1")
    .bind(employeeId).first<{ employee_id: string; name: string; email: string }>();
  return stored ? { id: stored.employee_id, name: stored.name, email: stored.email } : undefined;
}

function normalizedRoles(value: unknown): ErpRole[] {
  if (!Array.isArray(value)) return ["VIEWER"];
  const roles = value.filter((role): role is ErpRole => typeof role === "string" && allowedRoles.has(role as ErpRole));
  return roles.length ? [...new Set(roles)] : ["VIEWER"];
}

export async function GET() {
  const auth = await authorizeErpRequest(db, "settings", "admin");
  if (auth.response) return auth.response;
  await ensureErpPlatformSchema(db);
  const result = await db.prepare(`SELECT employee_id, email, roles_json, active, created_at, updated_at
    FROM erp_user_access WHERE active = 1 ORDER BY created_at ASC`).all<AccessRow>();
  const users = result.results.map((row) => ({
    employeeId: row.employee_id,
    email: row.email,
    roles: safeJson<ErpRole[]>(row.roles_json, ["VIEWER"]),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return Response.json({ users, employeeIds: users.map((user) => user.employeeId) });
}

export async function POST(request: Request) {
  const auth = await authorizeErpRequest(db, "settings", "admin");
  if (auth.response) return auth.response;
  const payload = await request.json() as { employeeId?: string; roles?: unknown };
  const employeeId = payload.employeeId?.trim() ?? "";
  const employee = await employeeById(employeeId);
  if (!employee || !employee.email || employee.email === "미입력") {
    return Response.json({ error: "회사에 등록되어 있고 이메일이 있는 인물만 사용자로 추가할 수 있습니다." }, { status: 400 });
  }
  const roles = employeeId === currentAdministratorId ? ["SUPER_ADMIN"] as ErpRole[] : normalizedRoles(payload.roles);
  const before = await db.prepare(`SELECT employee_id, email, roles_json, active, created_at, updated_at
    FROM erp_user_access WHERE employee_id = ?`).bind(employeeId).first<AccessRow>();
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hr_authorized_users (employee_id, created_at) VALUES (?, ?)`)
      .bind(employeeId, now),
    db.prepare(`INSERT INTO erp_user_access
      (employee_id, email, roles_json, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(employee_id) DO UPDATE SET
        email = excluded.email,
        roles_json = excluded.roles_json,
        active = 1,
        updated_at = excluded.updated_at`)
      .bind(employeeId, employee.email.toLowerCase(), JSON.stringify(roles), before?.created_at ?? now, now),
  ]);
  const after = { employeeId, email: employee.email.toLowerCase(), roles, active: true, createdAt: before?.created_at ?? now, updatedAt: now };
  await writeErpAudit(db, {
    principal: auth.principal,
    module: "settings",
    action: before ? "UPDATE_ACCESS" : "CREATE_ACCESS",
    entityType: "ERP_USER_ACCESS",
    entityId: employeeId,
    before: before ? { ...before, roles: safeJson<ErpRole[]>(before.roles_json, []) } : undefined,
    after,
  });
  return Response.json({ user: after }, { status: before ? 200 : 201 });
}

export async function DELETE(request: Request) {
  const auth = await authorizeErpRequest(db, "settings", "admin");
  if (auth.response) return auth.response;
  const payload = await request.json() as { employeeId?: string; reason?: string };
  const employeeId = payload.employeeId?.trim() ?? "";
  if (employeeId === currentAdministratorId) {
    return Response.json({ error: "현재 최고 관리자는 비활성화할 수 없습니다." }, { status: 400 });
  }
  const before = await db.prepare(`SELECT employee_id, email, roles_json, active, created_at, updated_at
    FROM erp_user_access WHERE employee_id = ?`).bind(employeeId).first<AccessRow>();
  if (!before) return Response.json({ error: "등록된 사용자를 찾을 수 없습니다." }, { status: 404 });
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM hr_authorized_users WHERE employee_id = ?").bind(employeeId),
    db.prepare("UPDATE erp_user_access SET active = 0, updated_at = ? WHERE employee_id = ?").bind(now, employeeId),
  ]);
  await writeErpAudit(db, {
    principal: auth.principal,
    module: "settings",
    action: "DISABLE_ACCESS",
    entityType: "ERP_USER_ACCESS",
    entityId: employeeId,
    before: { ...before, roles: safeJson<ErpRole[]>(before.roles_json, []) },
    after: { active: false, updatedAt: now },
    reason: payload.reason ?? "",
  });
  return Response.json({ employeeId, active: false });
}
