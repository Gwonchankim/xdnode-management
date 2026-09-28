import { env } from "cloudflare:workers";
import { readOptionalHrRows } from "../../../hr-optional-tables";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";
import { createApprovalRequest, willAutoApproveForSelf } from "../../../approval-engine";
import { authorizeErpRequest, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type PlanRow = { id: string; period: string; version: number; title: string };
type PlanLineRow = { id: string; plan_id: string; organization_id: string; approved_headcount: number; planned_exits: number; note: string };
type RequisitionRow = {
  id: string; workforce_plan_id: string; workforce_plan_line_id: string; organization_id: string;
  title: string; role: string; requested_headcount: number; owner_employee_id: string;
  target_start_date: string; reason: string; status: string; requested_by: string;
  approved_by: string; approved_at: number | null; closed_by: string; closed_at: number | null;
  close_reason: string; created_at: number; updated_at: number;
};
type OrganizationRow = { organization_id: string; name: string; description: string };
type EmployeeRow = { employee_id: string; name: string; department: string; status: string; join_date: string };
type CountRow = { requisition_id: string; applicant_count: number; filled_count: number };

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_recruitment_requisitions (
      id TEXT PRIMARY KEY NOT NULL, workforce_plan_id TEXT NOT NULL, workforce_plan_line_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
      requested_headcount INTEGER NOT NULL DEFAULT 1, owner_employee_id TEXT NOT NULL,
      target_start_date TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
      requested_by TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER,
      closed_by TEXT NOT NULL DEFAULT '', closed_at INTEGER, close_reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_requisition_plan_org ON hr_recruitment_requisitions(workforce_plan_id, organization_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_requisition_status_owner ON hr_recruitment_requisitions(status, owner_employee_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_workforce_plans (
      id TEXT PRIMARY KEY NOT NULL, period TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL, assumptions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'DRAFT',
      revision_reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, submitted_at INTEGER,
      approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_workforce_plan_lines (
      id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      approved_headcount INTEGER NOT NULL DEFAULT 0, planned_exits INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_organization_records (
      organization_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE TABLE IF NOT EXISTS hr_recruiters (employee_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)"),
  ]);
}

async function organizationSnapshot() {
  const result = await db.prepare("SELECT organization_id, name, description FROM hr_organization_records ORDER BY organization_id").all<OrganizationRow>();
  const saved = new Map(result.results.map((row) => [row.organization_id, row]));
  const baseIds = new Set(companyOrganizations.map((organization) => organization.id));
  return [
    ...companyOrganizations.map((organization) => ({
      id: organization.id, name: saved.get(organization.id)?.name ?? organization.name,
      originalName: organization.name, description: saved.get(organization.id)?.description ?? organization.description,
    })),
    ...result.results.filter((row) => !baseIds.has(row.organization_id)).map((row) => ({
      id: row.organization_id, name: row.name, originalName: row.name, description: row.description,
    })),
  ];
}

async function employeeSnapshot(organizations: Awaited<ReturnType<typeof organizationSnapshot>>) {
  const result = await db.prepare("SELECT employee_id, name, department, status, join_date FROM hr_employee_records ORDER BY employee_id").all<EmployeeRow>();
  const saved = new Map(result.results.map((row) => [row.employee_id, row]));
  const renamed = new Map(organizations.map((organization) => [organization.originalName, organization.name]));
  const baseIds = new Set(companyEmployees.map((employee) => employee.id));
  return [
    ...companyEmployees.map((employee) => {
      const override = saved.get(employee.id);
      return {
        id: employee.id, name: override?.name ?? employee.name,
        department: override?.department ?? renamed.get(employee.department) ?? employee.department,
        status: override?.status ?? employee.status, joinDate: override?.join_date ?? employee.joinDate,
      };
    }),
    ...result.results.filter((row) => !baseIds.has(row.employee_id)).map((row) => ({
      id: row.employee_id, name: row.name, department: row.department, status: row.status, joinDate: row.join_date,
    })),
  ];
}

function countsForOrganization(name: string, employees: Awaited<ReturnType<typeof employeeSnapshot>>) {
  const members = employees.filter((employee) => employee.department === name);
  return {
    current: members.filter((employee) => employee.status !== "퇴직" && employee.status !== "입사 예정").length,
    incoming: members.filter((employee) => employee.status === "입사 예정").length,
  };
}

async function state() {
  const [plan, organizations, requisitionResult, countResult, recruiterResult] = await Promise.all([
    db.prepare("SELECT id, period, version, title FROM hr_workforce_plans WHERE status = 'APPROVED' ORDER BY period DESC, version DESC LIMIT 1").first<PlanRow>(),
    organizationSnapshot(),
    db.prepare("SELECT * FROM hr_recruitment_requisitions ORDER BY created_at DESC").all<RequisitionRow>(),
    readOptionalHrRows<CountRow>(db, ["hr_applicants", "hr_offer_requests"], `SELECT a.requisition_id,
      COUNT(DISTINCT a.id) AS applicant_count,
      COUNT(DISTINCT CASE WHEN o.status IN ('ACCEPTED', 'ONBOARDED') THEN a.id END) AS filled_count
      FROM hr_applicants a LEFT JOIN hr_offer_requests o ON o.applicant_id = a.id
      WHERE TRIM(a.requisition_id) <> '' GROUP BY a.requisition_id`),
    db.prepare("SELECT employee_id FROM hr_recruiters ORDER BY created_at, employee_id").all<{ employee_id: string }>(),
  ]);
  const employees = await employeeSnapshot(organizations);
  const lineResult = plan
    ? await db.prepare("SELECT id, plan_id, organization_id, approved_headcount, planned_exits, note FROM hr_workforce_plan_lines WHERE plan_id = ? ORDER BY organization_id").bind(plan.id).all<PlanLineRow>()
    : { results: [] as PlanLineRow[] };
  const organizationMap = new Map(organizations.map((organization) => [organization.id, organization]));
  const countMap = new Map(countResult.results.map((row) => [row.requisition_id, row]));
  const requisitions = requisitionResult.results.map((row) => {
    const count = countMap.get(row.id);
    const filled = Number(count?.filled_count ?? 0);
    return {
      id: row.id, workforcePlanId: row.workforce_plan_id, workforcePlanLineId: row.workforce_plan_line_id,
      organizationId: row.organization_id, organizationName: organizationMap.get(row.organization_id)?.name ?? "삭제된 조직",
      title: row.title, role: row.role, requestedHeadcount: row.requested_headcount,
      applicantCount: Number(count?.applicant_count ?? 0), filledHeadcount: filled,
      remainingHeadcount: Math.max(0, row.requested_headcount - filled), ownerEmployeeId: row.owner_employee_id,
      ownerName: employees.find((employee) => employee.id === row.owner_employee_id)?.name ?? row.owner_employee_id,
      targetStartDate: row.target_start_date, reason: row.reason, status: row.status,
      requestedBy: row.requested_by, approvedBy: row.approved_by, approvedAt: row.approved_at,
      closedBy: row.closed_by, closedAt: row.closed_at, closeReason: row.close_reason,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
  const lines = lineResult.results.map((line) => {
    const organization = organizationMap.get(line.organization_id);
    const actual = countsForOrganization(organization?.name ?? "", employees);
    const projected = Math.max(0, actual.current + actual.incoming - line.planned_exits);
    const hiringGap = Math.max(0, line.approved_headcount - projected);
    // Match on the organization rather than the plan line: requisitions are now raised directly
    // and carry no plan line, but they still consume the same approved headcount.
    const reserved = requisitions
      .filter((item) => item.organizationId === line.organizationId && ["DRAFT", "SUBMITTED", "OPEN"].includes(item.status))
      .reduce((sum, item) => sum + item.remainingHeadcount, 0);
    return {
      id: line.id, planId: line.plan_id, organizationId: line.organization_id,
      organizationName: organization?.name ?? "삭제된 조직", approvedHeadcount: line.approved_headcount,
      currentHeadcount: actual.current, incomingHeadcount: actual.incoming, plannedExits: line.planned_exits,
      hiringGap, reservedHeadcount: reserved, availableHeadcount: Math.max(0, hiringGap - reserved), note: line.note,
    };
  });
  const summary = {
    planGap: lines.reduce((sum, line) => sum + line.hiringGap, 0),
    // Counted from the requisitions themselves rather than from plan lines: a request raised against
    // a team that has no workforce plan is still in flight and has to appear in this figure.
    reserved: requisitions.filter((item) => ["DRAFT", "SUBMITTED", "OPEN"].includes(item.status))
      .reduce((sum, item) => sum + item.remainingHeadcount, 0),
    available: lines.reduce((sum, line) => sum + line.availableHeadcount, 0),
    filled: requisitions.reduce((sum, item) => sum + item.filledHeadcount, 0),
  };
  const recruiterIds = new Set(recruiterResult.results.map((row) => row.employee_id));
  return {
    plan: plan ? { id: plan.id, period: plan.period, version: plan.version, title: plan.title } : null,
    lines, requisitions, summary,
    // The whole roster of teams, so a requisition can be raised for any of them rather than only
    // for the organizations a workforce plan happens to cover.
    organizations: organizations.map((organization) => ({ id: organization.id, name: organization.name })),
    recruiters: employees.filter((employee) => recruiterIds.has(employee.id) && employee.status !== "퇴직")
      .map((employee) => ({ id: employee.id, name: employee.name, department: employee.department })),
  };
}

export async function GET() {
  const authorization = await authorizeErpRequest(db, "recruitment", "read");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  return Response.json({ principal: authorization.principal, ...await state() });
}

type SubmitResult = { approvalId: string; autoApproved: boolean } | { error: string; status: number };

// Shared by direct registration and the explicit 결재 제출 button so both run the same plan check,
// the same approval route and the same audit entry. Returns the failure instead of a Response so the
// registration path can report it in its own wording.
async function submitRequisition(principal: ErpPrincipal, row: RequisitionRow,
  snapshot: Awaited<ReturnType<typeof state>>, now: number): Promise<SubmitResult> {
  const line = snapshot.lines.find((item) => item.id === row.workforce_plan_line_id);
  const selfReserved = Math.max(0, row.requested_headcount);
  // Only requisitions that were tied to a plan line are held to that plan's headcount. One raised
  // directly against a team that has no plan has no ceiling to check it against.
  if (row.workforce_plan_line_id && (!line || line.availableHeadcount + selfReserved < row.requested_headcount)) {
    return { error: "인력계획 또는 다른 TO가 변경되어 요청 인원을 승인 정원 안에 둘 수 없습니다.", status: 409 };
  }
  const updated = await db.prepare("UPDATE hr_recruitment_requisitions SET status = 'SUBMITTED', updated_at = ? WHERE id = ? AND status = 'DRAFT'").bind(now, row.id).run();
  if (updated.meta.changes !== 1) return { error: "다른 사용자가 채용요청 상태를 먼저 변경했습니다.", status: 409 };
  try {
    const approval = await createApprovalRequest(db, principal, requisitionApprovalInput(row, snapshot)) as { id: string; status: string; autoApproved?: boolean };
    const autoApproved = approval.autoApproved === true;
    await writeErpAudit(db, { principal, module: "recruitment", action: "REQUISITION_SUBMITTED", entityType: "hrRecruitmentRequisition", entityId: row.id, before: row, after: { status: autoApproved ? "OPEN" : "SUBMITTED", approvalId: approval.id, autoApproved } });
    return { approvalId: approval.id, autoApproved };
  } catch (error) {
    await db.prepare("UPDATE hr_recruitment_requisitions SET status = 'DRAFT', updated_at = ? WHERE id = ? AND status = 'SUBMITTED'").bind(Date.now(), row.id).run();
    return { error: error instanceof Error ? error.message : "채용요청 결재선을 만들지 못했습니다.", status: 409 };
  }
}

// Built in one place so the pre-flight self-approval probe and the real submit resolve the identical
// route; a probe against a different policy would answer for the wrong request.
function requisitionApprovalInput(row: RequisitionRow, snapshot: Awaited<ReturnType<typeof state>>) {
  const line = snapshot.lines.find((item) => item.id === row.workforce_plan_line_id);
  const organizationName = line?.organizationName ?? snapshot.organizations.find((item) => item.id === row.organization_id)?.name ?? "삭제된 조직";
  return {
    module: "recruitment" as const, requestType: "REQUISITION", title: `${row.title} · ${row.requested_headcount}명 채용 승인`,
    description: `${line ? snapshot.plan?.period ?? "인력계획" : "직접 등록"} · ${organizationName} · ${row.role} · 목표일 ${row.target_start_date}`,
    targetEntityType: "HR_RECRUITMENT_REQUISITION", targetEntityId: row.id, priority: "HIGH" as const, dueDate: row.target_start_date,
    metadata: { workforcePlanId: row.workforce_plan_id, workforcePlanLineId: row.workforce_plan_line_id, organizationId: row.organization_id, requestedHeadcount: row.requested_headcount, role: row.role },
  };
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "recruitment", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const body = await request.json() as Record<string, unknown>;
  const action = String(body.action ?? "").toUpperCase();
  const now = Date.now();

  if (action === "CREATE_DRAFT") {
    // Requisitions are raised directly against a team. They used to require an approved workforce
    // plan with spare headcount, which meant nothing could be requested at all until a plan existed
    // — the plan figures are still reported alongside, but they no longer gate the request.
    const snapshot = await state();
    const organizationId = String(body.organizationId ?? "").trim();
    const organization = snapshot.organizations.find((item) => item.id === organizationId);
    const requestedHeadcount = Math.round(Number(body.requestedHeadcount));
    const role = String(body.role ?? "").trim().slice(0, 120);
    const ownerEmployeeId = String(body.ownerEmployeeId ?? "").trim();
    const targetStartDate = String(body.targetStartDate ?? "").trim();
    const reason = String(body.reason ?? "").trim().slice(0, 1500);
    const title = (String(body.title ?? "").trim() || `${organization?.name ?? ""} ${role} 채용`.trim()).slice(0, 120);
    if (!organization) return Response.json({ error: "채용요청 팀을 선택해 주세요." }, { status: 400 });
    if (!role) return Response.json({ error: "요청 포지션을 입력해 주세요." }, { status: 400 });
    if (!Number.isInteger(requestedHeadcount) || requestedHeadcount < 1 || requestedHeadcount > 99) {
      return Response.json({ error: "요청 인원수는 1~99명 사이로 입력해 주세요." }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetStartDate)) return Response.json({ error: "목표일을 선택해 주세요." }, { status: 400 });
    if (ownerEmployeeId && !snapshot.recruiters.some((item) => item.id === ownerEmployeeId)) {
      return Response.json({ error: "채용담당자 목록에서 다시 선택해 주세요." }, { status: 400 });
    }
    // Record the plan only when one already covers this team, so the TO figures stay meaningful
    // without the request depending on a plan existing.
    const line = snapshot.lines.find((item) => item.organizationId === organizationId);
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO hr_recruitment_requisitions
      (id, workforce_plan_id, workforce_plan_line_id, organization_id, title, role, requested_headcount,
        owner_employee_id, target_start_date, reason, status, requested_by, approved_by, approved_at,
        closed_by, closed_at, close_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, '', NULL, '', NULL, '', ?, ?)`)
      .bind(id, line ? line.planId : "", line ? line.id : "", organizationId, title, role, requestedHeadcount,
        ownerEmployeeId, targetStartDate, reason, authorization.principal.employeeId, now, now).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "REQUISITION_CREATED", entityType: "hrRecruitmentRequisition", entityId: id, after: { planId: line?.planId ?? "", organizationId, title, role, requestedHeadcount, ownerEmployeeId, targetStartDate, reason } });

    // When the requester turns out to be the only approver on the route, 작성 중 → 결재 제출 → 승인 is
    // three clicks with one possible outcome. Carry it through here so registering the request is the
    // whole job. A route that includes anyone else still stops at 작성 중 for a real decision.
    const created = await db.prepare("SELECT * FROM hr_recruitment_requisitions WHERE id = ?").bind(id).first<RequisitionRow>();
    // Re-read the plan figures: the snapshot above predates this row, so its reserved headcount would
    // not yet count the request we are about to submit against the very same plan line.
    const fresh = created ? await state() : snapshot;
    if (created && await willAutoApproveForSelf(db, authorization.principal, requisitionApprovalInput(created, fresh))) {
      const outcome = await submitRequisition(authorization.principal, created, fresh, now);
      if (!("error" in outcome)) {
        return Response.json({ created: true, id, autoApproved: outcome.autoApproved, approvalId: outcome.approvalId }, { status: 201 });
      }
      // The record is registered either way; only the shortcut failed, so it stays in 작성 중 and the
      // caller is told why the 결재 제출 button is still waiting for them.
      return Response.json({ created: true, id, autoApproved: false, submitError: outcome.error }, { status: 201 });
    }
    return Response.json({ created: true, id, autoApproved: false }, { status: 201 });
  }

  const id = String(body.id ?? "").trim();
  const row = id ? await db.prepare("SELECT * FROM hr_recruitment_requisitions WHERE id = ?").bind(id).first<RequisitionRow>() : null;
  if (!row) return Response.json({ error: "채용요청을 찾을 수 없습니다." }, { status: 404 });

  if (action === "SUBMIT") {
    if (row.status !== "DRAFT") return Response.json({ error: "작성 중인 채용요청만 결재할 수 있습니다." }, { status: 409 });
    const snapshot = await state();
    const outcome = await submitRequisition(authorization.principal, row, snapshot, now);
    if ("error" in outcome) return Response.json({ error: outcome.error }, { status: outcome.status });
    return Response.json({ submitted: true, approvalId: outcome.approvalId, autoApproved: outcome.autoApproved }, { status: 202 });
  }

  if (action === "CLOSE") {
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    if (row.status !== "OPEN" || reason.length < 5) return Response.json({ error: "모집 중인 TO의 마감 사유를 5자 이상 입력해 주세요." }, { status: 409 });
    await db.prepare(`UPDATE hr_recruitment_requisitions SET status = 'CLOSED', closed_by = ?, closed_at = ?,
      close_reason = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`)
      .bind(authorization.principal.employeeId, now, reason, now, id).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "REQUISITION_CLOSED", entityType: "hrRecruitmentRequisition", entityId: id, before: row, after: { status: "CLOSED", reason } });
    return Response.json({ closed: true });
  }

  if (action === "CANCEL") {
    if (row.status !== "DRAFT") return Response.json({ error: "작성 중인 채용요청만 취소할 수 있습니다." }, { status: 409 });
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    if (reason.length < 5) return Response.json({ error: "초안 취소 사유를 5자 이상 입력해 주세요." }, { status: 400 });
    await db.prepare(`UPDATE hr_recruitment_requisitions SET status = 'CANCELLED', closed_by = ?, closed_at = ?,
      close_reason = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'`)
      .bind(authorization.principal.employeeId, now, reason, now, id).run();
    await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "REQUISITION_CANCELLED", entityType: "hrRecruitmentRequisition", entityId: id, before: row, after: { status: "CANCELLED", reason } });
    return Response.json({ cancelled: true });
  }

  if (action === "DELETE") {
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    if (reason.length < 5) return Response.json({ error: "삭제 사유를 5자 이상 입력해 주세요." }, { status: 400 });

    // Applicants are records of real people. Dropping the requisition out from under them would leave
    // those rows pointing at an id that no longer resolves, so the link has to be cleared first.
    const linked = await db.prepare("SELECT COUNT(*) AS count FROM hr_applicants WHERE requisition_id = ?")
      .bind(id).first<{ count: number }>();
    if ((linked?.count ?? 0) > 0) {
      return Response.json({ error: `이 채용요청에 연결된 지원자가 ${linked?.count}명 있습니다. 지원자 관리에서 연결을 해제한 뒤 삭제해 주세요.` }, { status: 409 });
    }

    // A still-open approval would otherwise sit in 전자결재 pointing at a requisition that is gone.
    // Close it out the same way an explicit 결재 취소 would, so the inbox and task list stay truthful.
    const approval = await db.prepare(`SELECT id, current_step FROM erp_approval_requests
      WHERE target_entity_type = 'HR_RECRUITMENT_REQUISITION' AND target_entity_id = ?
        AND status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED')`)
      .bind(id).first<{ id: string; current_step: number }>();
    const statements: D1PreparedStatement[] = [];
    if (approval) {
      statements.push(
        db.prepare("UPDATE erp_approval_requests SET status = 'CANCELLED', decided_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .bind(now, now, approval.id),
        db.prepare("UPDATE erp_approval_steps SET status = 'SKIPPED', updated_at = ? WHERE request_id = ? AND status IN ('PENDING', 'WAITING')")
          .bind(now, approval.id),
        db.prepare("UPDATE erp_tasks SET status = 'DONE', completed_at = ?, updated_at = ? WHERE source_type = 'APPROVAL' AND source_id = ?")
          .bind(now, now, approval.id),
        db.prepare(`INSERT INTO erp_approval_events (id, request_id, step_order, action, actor_employee_id, comment, snapshot_json, created_at)
          VALUES (?, ?, ?, 'CANCELLED', ?, ?, '{}', ?)`)
          .bind(crypto.randomUUID(), approval.id, approval.current_step, authorization.principal.employeeId, `채용요청 삭제: ${reason}`, now),
      );
    }
    statements.push(db.prepare("DELETE FROM hr_recruitment_requisitions WHERE id = ?").bind(id));
    await db.batch(statements);
    // The row is gone from the ledger, but the audit entry carries the whole record it held, so what
    // was requested and by whom is still answerable after the fact.
    await writeErpAudit(db, { principal: authorization.principal, module: "recruitment", action: "REQUISITION_DELETED", entityType: "hrRecruitmentRequisition", entityId: id, before: row, after: { deleted: true, reason, cancelledApprovalId: approval?.id ?? "" } });
    return Response.json({ deleted: true, cancelledApproval: Boolean(approval) });
  }

  return Response.json({ error: "지원하지 않는 채용요청 작업입니다." }, { status: 400 });
}
