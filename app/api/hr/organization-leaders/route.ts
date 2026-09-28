import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";

type LeaderRow = {
  organization_id: string;
  leader_employee_id: string | null;
  updated_at: number;
};

type HrBindings = {
  DB: D1Database;
};

const db = (env as unknown as HrBindings).DB;

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS hr_organization_leaders (
    organization_id TEXT PRIMARY KEY,
    leader_employee_id TEXT,
    updated_at INTEGER NOT NULL
  )`).run();
}

function toLeader(row: LeaderRow) {
  return {
    organizationId: row.organization_id,
    leaderEmployeeId: row.leader_employee_id,
    updatedAt: row.updated_at,
  };
}

export async function GET() {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  const result = await db.prepare(`SELECT leader.organization_id,
    CASE WHEN employee.status = '퇴직'
      OR json_extract(CASE WHEN json_valid(employee.retirement_json) THEN employee.retirement_json ELSE '{}' END, '$.status') IN ('EFFECTIVE', 'COMPLETED')
      THEN NULL ELSE leader.leader_employee_id END AS leader_employee_id,
    leader.updated_at
    FROM hr_organization_leaders leader
    LEFT JOIN hr_employee_records employee ON employee.employee_id = leader.leader_employee_id
    ORDER BY leader.organization_id`).all<LeaderRow>();
  return Response.json({ leaders: result.results.map(toLeader) });
}

export async function PUT(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as { organizationId?: unknown; leaderEmployeeId?: unknown };
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  const leaderEmployeeId = typeof body.leaderEmployeeId === "string" && body.leaderEmployeeId.trim()
    ? body.leaderEmployeeId.trim()
    : null;

  if (!organizationId) {
    return Response.json({ error: "organizationId is required." }, { status: 400 });
  }
  if (leaderEmployeeId) {
    const employee = await db.prepare("SELECT status, retirement_json FROM hr_employee_records WHERE employee_id = ?")
      .bind(leaderEmployeeId).first<{ status: string; retirement_json: string | null }>();
    let retirementStatus = "";
    try { retirementStatus = employee?.retirement_json ? String((JSON.parse(employee.retirement_json) as { status?: unknown }).status ?? "") : ""; } catch { retirementStatus = ""; }
    if (!employee || employee.status === "퇴직" || ["EFFECTIVE", "COMPLETED"].includes(retirementStatus)) {
      return Response.json({ error: "퇴직자는 조직장으로 지정할 수 없습니다." }, { status: 409 });
    }
  }

  const updatedAt = Date.now();
  const before = await db.prepare(`SELECT organization_id, leader_employee_id, updated_at
    FROM hr_organization_leaders WHERE organization_id = ?`).bind(organizationId).first<LeaderRow>();
  await db.prepare(`INSERT INTO hr_organization_leaders (organization_id, leader_employee_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      leader_employee_id = excluded.leader_employee_id,
      updated_at = excluded.updated_at`)
    .bind(organizationId, leaderEmployeeId, updatedAt)
    .run();

  const after = toLeader({
    organization_id: organizationId,
    leader_employee_id: leaderEmployeeId,
    updated_at: updatedAt,
  });
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "hr",
    action: "ORGANIZATION_LEADER_UPDATED",
    entityType: "organizationLeader",
    entityId: organizationId,
    before: before ? toLeader(before) : null,
    after,
  });

  return Response.json({ leader: after });
}
