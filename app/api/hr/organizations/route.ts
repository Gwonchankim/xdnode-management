import { env } from "cloudflare:workers";
import { companyOrganizations } from "../../../hr-company-data";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";

type OrganizationRow = {
  organization_id: string;
  name: string;
  description: string;
  updated_at: number;
};

type HrBindings = { DB: D1Database };
const db = (env as unknown as HrBindings).DB;

async function ensureSchema() {
  await db.prepare(`CREATE TABLE IF NOT EXISTS hr_organization_records (
    organization_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

function toOrganization(row: OrganizationRow) {
  return {
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    updatedAt: row.updated_at,
  };
}

export async function GET() {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  const result = await db.prepare(`SELECT organization_id, name, description, updated_at
    FROM hr_organization_records ORDER BY organization_id`).all<OrganizationRow>();
  return Response.json({ organizations: result.results.map(toOrganization) });
}

/** 조직 신설. 기준자료(companyOrganizations)에 없는 조직은 이 표에만 있고, 화면은 GET 결과를 기준자료와 합쳐 보여 준다.
 *  예전에는 화면 상태에만 추가돼 새로고침하면 사라졌다. */
export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as { name?: unknown; description?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name || name.length > 40) return Response.json({ error: "조직명을 1~40자로 입력해 주세요." }, { status: 400 });
  if (companyOrganizations.some((organization) => organization.name === name)) return Response.json({ error: "이미 있는 조직명입니다." }, { status: 409 });
  const duplicate = await db.prepare("SELECT organization_id FROM hr_organization_records WHERE name = ? LIMIT 1").bind(name).first<{ organization_id: string }>();
  if (duplicate) return Response.json({ error: "이미 있는 조직명입니다." }, { status: 409 });
  const organizationId = `org-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const updatedAt = Date.now();
  await db.prepare("INSERT INTO hr_organization_records (organization_id, name, description, updated_at) VALUES (?, ?, ?, ?)")
    .bind(organizationId, name, description || "조직 설명 미입력", updatedAt).run();
  const after = toOrganization({ organization_id: organizationId, name, description: description || "조직 설명 미입력", updated_at: updatedAt });
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "ORGANIZATION_CREATED", entityType: "organization", entityId: organizationId, before: null, after });
  return Response.json({ organization: after }, { status: 201 });
}

export async function PUT(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as Record<string, unknown>;
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" && body.description.trim()
    ? body.description.trim()
    : "조직 설명 미입력";
  const clientPreviousName = typeof body.previousName === "string" ? body.previousName.trim() : "";

  if (!organizationId || !name) {
    return Response.json({ error: "조직 ID와 조직명이 필요합니다." }, { status: 400 });
  }

  const duplicateInBase = companyOrganizations.some((organization) => organization.id !== organizationId && organization.name === name);
  const duplicateInRecords = await db.prepare(`SELECT organization_id FROM hr_organization_records
    WHERE name = ? AND organization_id <> ? LIMIT 1`).bind(name, organizationId).first<{ organization_id: string }>();
  if (duplicateInBase || duplicateInRecords) {
    return Response.json({ error: "이미 사용 중인 조직명입니다." }, { status: 409 });
  }

  const existing = await db.prepare(`SELECT organization_id, name, description, updated_at
    FROM hr_organization_records WHERE organization_id = ?`).bind(organizationId).first<OrganizationRow>();
  const baseOrganization = companyOrganizations.find((organization) => organization.id === organizationId);
  const previousName = existing?.name ?? baseOrganization?.name ?? clientPreviousName;
  const updatedAt = Date.now();

  const statements = [
    db.prepare(`INSERT INTO hr_organization_records (organization_id, name, description, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        updated_at = excluded.updated_at`).bind(organizationId, name, description, updatedAt),
  ];
  if (previousName && previousName !== name) {
    statements.push(db.prepare(`UPDATE hr_employee_records SET department = ?, updated_at = ?
      WHERE department = ?`).bind(name, updatedAt, previousName));
    // 부서명을 문자열로 들고 있는 파생 표도 같이 바꾼다. 안 바꾸면 급여·통계가 옛 이름과 새 이름으로 갈린다.
    statements.push(db.prepare("UPDATE hr_payroll_records SET department = ? WHERE department = ?").bind(name, previousName));
    statements.push(db.prepare("UPDATE hr_compensation_lines SET snapshot_json = json_set(snapshot_json, '$.department', ?), updated_at = ? WHERE json_valid(snapshot_json) = 1 AND json_extract(snapshot_json, '$.department') = ?").bind(name, updatedAt, previousName));
  }
  await db.batch(statements);

  const after = toOrganization({
    organization_id: organizationId,
    name,
    description,
    updated_at: updatedAt,
  });
  await writeErpAudit(db, {
    principal: authorization.principal,
    module: "hr",
    action: "ORGANIZATION_UPDATED",
    entityType: "organization",
    entityId: organizationId,
    before: existing ? toOrganization(existing) : baseOrganization ? {
      organizationId,
      name: baseOrganization.name,
      description: baseOrganization.description,
    } : null,
    after,
  });

  return Response.json({ organization: after });
}
