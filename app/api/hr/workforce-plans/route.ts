import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { LEGACY_PENDING, approveWorkforcePlanStatements, changedRows, hrConflictResponse } from "../../../hr-transitions";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type PlanRow = {
  id: string; period: string; version: number; title: string; assumptions: string; status: string;
  revision_reason: string; created_by: string; submitted_at: number | null; approved_by: string;
  approved_at: number | null; created_at: number; updated_at: number;
};
type LineRow = { id: string; plan_id: string; organization_id: string; approved_headcount: number; planned_exits: number; note: string; created_at: number; updated_at: number };
type EmployeeRow = { employee_id: string; department: string; status: string; join_date: string };
type OrganizationRow = { organization_id: string; name: string; description: string };
type OrganizationSnapshot = { id: string; name: string; description: string; originalName: string };
type EmployeeSnapshot = { id: string; department: string; status: string; joinDate: string };

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_workforce_plans (
      id TEXT PRIMARY KEY NOT NULL, period TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL, assumptions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'DRAFT',
      revision_reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, submitted_at INTEGER,
      approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_workforce_plan_period_version
      ON hr_workforce_plans(period, version)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_hr_workforce_plan_period_status
      ON hr_workforce_plans(period, status)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_workforce_plan_lines (
      id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      approved_headcount INTEGER NOT NULL DEFAULT 0, planned_exits INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_workforce_plan_line_org
      ON hr_workforce_plan_lines(plan_id, organization_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_organization_records (
      organization_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL)`),
  ]);
}

function planView(row: PlanRow) {
  return {
    id: row.id, period: row.period, version: row.version, title: row.title, assumptions: row.assumptions,
    status: row.status, revisionReason: row.revision_reason, createdBy: row.created_by,
    submittedAt: row.submitted_at, approvedBy: row.approved_by, approvedAt: row.approved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function validPeriod(period: string) {
  return /^(20\d{2})-(H1|H2)$/.test(period) && period >= "2024-H1" && period <= "2035-H2";
}

async function organizationSnapshot() {
  const result = await db.prepare("SELECT organization_id, name, description FROM hr_organization_records ORDER BY organization_id").all<OrganizationRow>();
  const saved = new Map(result.results.map((row) => [row.organization_id, row]));
  const baseIds = new Set(companyOrganizations.map((organization) => organization.id));
  return [
    ...companyOrganizations.map((organization) => ({
      id: organization.id,
      name: saved.get(organization.id)?.name ?? organization.name,
      description: saved.get(organization.id)?.description ?? organization.description,
      originalName: organization.name,
    })),
    ...result.results.filter((row) => !baseIds.has(row.organization_id)).map((row) => ({
      id: row.organization_id, name: row.name, description: row.description, originalName: row.name,
    })),
  ] satisfies OrganizationSnapshot[];
}

async function employeeSnapshot(organizations: OrganizationSnapshot[]) {
  const result = await db.prepare("SELECT employee_id, department, status, join_date FROM hr_employee_records ORDER BY employee_id").all<EmployeeRow>();
  const saved = new Map(result.results.map((row) => [row.employee_id, row]));
  const renamed = new Map(organizations.map((organization) => [organization.originalName, organization.name]));
  const baseIds = new Set(companyEmployees.map((employee) => employee.id));
  return [
    ...companyEmployees.map((employee) => {
      const override = saved.get(employee.id);
      const department = override?.department ?? renamed.get(employee.department) ?? employee.department;
      return { id: employee.id, department, status: override?.status ?? employee.status, joinDate: override?.join_date ?? employee.joinDate };
    }),
    ...result.results.filter((row) => !baseIds.has(row.employee_id)).map((row) => ({
      id: row.employee_id, department: row.department, status: row.status, joinDate: row.join_date,
    })),
  ] satisfies EmployeeSnapshot[];
}

function actualFor(organization: OrganizationSnapshot, employees: EmployeeSnapshot[]) {
  const members = employees.filter((employee) => employee.department === organization.name);
  return {
    current: members.filter((employee) => employee.status !== "퇴직" && employee.status !== "입사 예정").length,
    incoming: members.filter((employee) => employee.status === "입사 예정").length,
  };
}

async function responseState(selectedId = "") {
  const [planResult, organizations] = await Promise.all([
    db.prepare("SELECT * FROM hr_workforce_plans ORDER BY period DESC, version DESC").all<PlanRow>(),
    organizationSnapshot(),
  ]);
  const employees = await employeeSnapshot(organizations);
  const selected = planResult.results.find((plan) => plan.id === selectedId)
    ?? planResult.results.find((plan) => plan.status !== "SUPERSEDED") ?? planResult.results[0] ?? null;
  const lineResult = selected
    ? await db.prepare("SELECT * FROM hr_workforce_plan_lines WHERE plan_id = ? ORDER BY organization_id").bind(selected.id).all<LineRow>()
    : { results: [] as LineRow[] };
  const lineMap = new Map(lineResult.results.map((line) => [line.organization_id, line]));
  const lines = organizations.map((organization) => {
    const actual = actualFor(organization, employees);
    const line = lineMap.get(organization.id);
    const approvedHeadcount = line?.approved_headcount ?? 0;
    const plannedExits = line?.planned_exits ?? 0;
    const projected = Math.max(0, actual.current + actual.incoming - plannedExits);
    return {
      id: line?.id ?? "", planId: selected?.id ?? "", organizationId: organization.id,
      organizationName: organization.name, currentHeadcount: actual.current, incomingHeadcount: actual.incoming,
      plannedExits, projectedHeadcount: projected, approvedHeadcount,
      hiringGap: Math.max(0, approvedHeadcount - projected), surplus: Math.max(0, projected - approvedHeadcount),
      note: line?.note ?? "", updatedAt: line?.updated_at ?? 0,
    };
  });
  const summary = lines.reduce((total, line) => ({
    current: total.current + line.currentHeadcount,
    incoming: total.incoming + line.incomingHeadcount,
    approved: total.approved + line.approvedHeadcount,
    gap: total.gap + line.hiringGap,
    surplus: total.surplus + line.surplus,
  }), { current: 0, incoming: 0, approved: 0, gap: 0, surplus: 0 });
  return { plans: planResult.results.map(planView), selected: selected ? planView(selected) : null, lines, summary };
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const planId = new URL(request.url).searchParams.get("planId") ?? "";
  return Response.json({ principal: authorization.principal, ...await responseState(planId) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const body = await request.json() as Record<string, unknown>;
  const action = String(body.action ?? "").toUpperCase();
  const now = Date.now();

  if (action === "CREATE_PLAN") {
    const period = String(body.period ?? "").toUpperCase();
    const title = String(body.title ?? "").trim().slice(0, 120);
    const assumptions = String(body.assumptions ?? "").trim().slice(0, 3000);
    if (!validPeriod(period) || !title) return Response.json({ error: "계획 반기와 제목을 확인해 주세요." }, { status: 400 });
    const active = await db.prepare("SELECT id FROM hr_workforce_plans WHERE period = ? AND status IN ('DRAFT','SUBMITTED') LIMIT 1").bind(period).first();
    if (active) return Response.json({ error: "같은 반기에 작성 중인 계획이 있습니다." }, { status: 409 });
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM hr_workforce_plans WHERE period = ?").bind(period).first<{ version: number }>();
    const id = crypto.randomUUID();
    const version = (latest?.version ?? 0) + 1;
    const organizations = await organizationSnapshot();
    const employees = await employeeSnapshot(organizations);
    await db.batch([
      db.prepare(`INSERT INTO hr_workforce_plans
        (id, period, version, title, assumptions, status, revision_reason, created_by, submitted_at,
          approved_by, approved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'DRAFT', '', ?, NULL, '', NULL, ?, ?)`)
        .bind(id, period, version, title, assumptions, authorization.principal.employeeId, now, now),
      ...organizations.map((organization) => {
        const actual = actualFor(organization, employees);
        return db.prepare(`INSERT INTO hr_workforce_plan_lines
          (id, plan_id, organization_id, approved_headcount, planned_exits, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, '', ?, ?)`)
          .bind(crypto.randomUUID(), id, organization.id, actual.current + actual.incoming, now, now);
      }),
    ]);
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "WORKFORCE_PLAN_CREATED", entityType: "hrWorkforcePlan", entityId: id, after: { period, version, title, organizationCount: organizations.length } });
    return Response.json({ created: true, id }, { status: 201 });
  }

  const planId = String(body.planId ?? "").trim();
  const plan = planId ? await db.prepare("SELECT * FROM hr_workforce_plans WHERE id = ?").bind(planId).first<PlanRow>() : null;
  if (!plan) return Response.json({ error: "인력계획을 찾을 수 없습니다." }, { status: 404 });

  if (action === "SAVE_PLAN") {
    if (plan.status !== "DRAFT") return Response.json({ error: "작성 중인 계획만 수정할 수 있습니다." }, { status: 409 });
    const title = String(body.title ?? "").trim().slice(0, 120);
    const assumptions = String(body.assumptions ?? "").trim().slice(0, 3000);
    if (!title) return Response.json({ error: "계획 제목을 입력해 주세요." }, { status: 400 });
    await db.prepare("UPDATE hr_workforce_plans SET title = ?, assumptions = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'")
      .bind(title, assumptions, now, planId).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "WORKFORCE_PLAN_SAVED", entityType: "hrWorkforcePlan", entityId: planId, before: planView(plan), after: { title, assumptions } });
    return Response.json({ saved: true });
  }

  if (action === "UPSERT_LINE") {
    if (plan.status !== "DRAFT") return Response.json({ error: "작성 중인 계획의 조직 정원만 수정할 수 있습니다." }, { status: 409 });
    const organizationId = String(body.organizationId ?? "").trim();
    const approvedHeadcount = Math.round(Number(body.approvedHeadcount));
    const plannedExits = Math.round(Number(body.plannedExits));
    const note = String(body.note ?? "").trim().slice(0, 1000);
    if (!organizationId || !Number.isInteger(approvedHeadcount) || approvedHeadcount < 0 || approvedHeadcount > 10_000
      || !Number.isInteger(plannedExits) || plannedExits < 0 || plannedExits > 10_000) {
      return Response.json({ error: "승인 정원과 계획 퇴사 인원을 확인해 주세요." }, { status: 400 });
    }
    const organizations = await organizationSnapshot();
    const organization = organizations.find((item) => item.id === organizationId);
    if (!organization) return Response.json({ error: "현재 회사 조직에 등록된 조직만 계획할 수 있습니다." }, { status: 400 });
    const employees = await employeeSnapshot(organizations);
    const actual = actualFor(organization, employees);
    if (plannedExits > actual.current) return Response.json({ error: "계획 퇴사 인원은 현재 재직 인원을 넘을 수 없습니다." }, { status: 400 });
    const projected = actual.current + actual.incoming - plannedExits;
    if (approvedHeadcount < projected && note.length < 5) return Response.json({ error: "예상 가동 인원보다 정원이 적으면 5자 이상의 조정 근거를 입력해 주세요." }, { status: 400 });
    const existing = await db.prepare("SELECT * FROM hr_workforce_plan_lines WHERE plan_id = ? AND organization_id = ?").bind(planId, organizationId).first<LineRow>();
    await db.prepare(`INSERT INTO hr_workforce_plan_lines
      (id, plan_id, organization_id, approved_headcount, planned_exits, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, organization_id) DO UPDATE SET approved_headcount = excluded.approved_headcount,
        planned_exits = excluded.planned_exits, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(existing?.id ?? crypto.randomUUID(), planId, organizationId, approvedHeadcount, plannedExits, note, existing?.created_at ?? now, now).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "WORKFORCE_PLAN_LINE_SAVED", entityType: "hrWorkforcePlanLine", entityId: existing?.id ?? `${planId}:${organizationId}`, before: existing ?? null, after: { planId, organizationId, approvedHeadcount, plannedExits, note } });
    return Response.json({ saved: true });
  }

  // UI 가 보내는 이름은 그대로 SUBMIT_PLAN 이지만, 결재 없이 곧바로 승인·확정한다(Design §12.2 흐름 6).
  // 결재 시절에 SUBMITTED 로 남은 계획도 같은 버튼으로 확정할 수 있다.
  if (action === "SUBMIT_PLAN") {
    if (plan.status !== "DRAFT" && plan.status !== LEGACY_PENDING.workforcePlan) return Response.json({ error: "작성 중인 계획만 승인·확정할 수 있습니다." }, { status: 409 });
    if (plan.assumptions.trim().length < 10) return Response.json({ error: "계획 가정과 기준을 10자 이상 저장한 뒤 승인·확정해 주세요." }, { status: 409 });
    const organizations = await organizationSnapshot();
    const lineCount = await db.prepare("SELECT COUNT(*) AS count FROM hr_workforce_plan_lines WHERE plan_id = ?").bind(planId).first<{ count: number }>();
    if ((lineCount?.count ?? 0) !== organizations.length) return Response.json({ error: "현재 모든 조직의 정원을 저장한 뒤 승인·확정해 주세요." }, { status: 409 });
    const summary = (await responseState(planId)).summary;
    const result = await db.batch(approveWorkforcePlanStatements(db, { planId, actorEmployeeId: authorization.principal.employeeId, now }));
    if (changedRows(result, 1) !== 1) return hrConflictResponse();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "WORKFORCE_PLAN_APPROVED", entityType: "hrWorkforcePlan", entityId: planId, before: planView(plan), after: { status: "APPROVED", supersededPlans: changedRows(result, 0), summary } });
    return Response.json({ approved: true, status: "APPROVED" });
  }

  if (action === "CREATE_REVISION") {
    if (!["APPROVED", "SUPERSEDED"].includes(plan.status)) return Response.json({ error: "승인된 계획만 개정할 수 있습니다." }, { status: 409 });
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    if (reason.length < 5) return Response.json({ error: "개정 사유를 5자 이상 입력해 주세요." }, { status: 400 });
    const active = await db.prepare("SELECT id FROM hr_workforce_plans WHERE period = ? AND status IN ('DRAFT','SUBMITTED') LIMIT 1").bind(plan.period).first();
    if (active) return Response.json({ error: "같은 반기에 작성 중인 개정본이 있습니다." }, { status: 409 });
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM hr_workforce_plans WHERE period = ?").bind(plan.period).first<{ version: number }>();
    const id = crypto.randomUUID(); const version = (latest?.version ?? plan.version) + 1;
    await db.batch([
      db.prepare(`INSERT INTO hr_workforce_plans
        (id, period, version, title, assumptions, status, revision_reason, created_by, submitted_at,
          approved_by, approved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, NULL, '', NULL, ?, ?)`)
        .bind(id, plan.period, version, plan.title, plan.assumptions, reason, authorization.principal.employeeId, now, now),
      db.prepare(`INSERT INTO hr_workforce_plan_lines
        (id, plan_id, organization_id, approved_headcount, planned_exits, note, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), ?, organization_id, approved_headcount, planned_exits, note, ?, ?
        FROM hr_workforce_plan_lines WHERE plan_id = ?`).bind(id, now, now, planId),
    ]);
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "WORKFORCE_PLAN_REVISION_CREATED", entityType: "hrWorkforcePlan", entityId: id, before: planView(plan), after: { period: plan.period, version, reason } });
    return Response.json({ created: true, id }, { status: 201 });
  }

  return Response.json({ error: "지원하지 않는 인력계획 작업입니다." }, { status: 400 });
}
