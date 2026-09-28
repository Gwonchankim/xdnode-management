import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";
import { createApprovalRequest } from "../../../approval-engine";
import { authorizeErpRequest, writeErpAudit, type ErpPrincipal } from "../../../erp-platform";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type CycleRow = {
  id: string; name: string; period: string; description: string; status: string;
  goal_due_date: string; self_due_date: string; manager_due_date: string; calibration_due_date: string;
  created_by: string; opened_at: number | null; finalized_by: string; finalized_at: number | null;
  created_at: number; updated_at: number;
};
type ParticipantRow = {
  id: string; cycle_id: string; employee_id: string; organization_id: string; manager_employee_id: string;
  status: string; final_score: number | null; final_rating: string; calibration_note: string;
  finalized_by: string; finalized_at: number | null; created_at: number; updated_at: number;
};
type GoalRow = {
  id: string; participant_id: string; title: string; description: string; weight: number; metric_type: string;
  target_value: number; actual_value: number | null; unit: string; evidence: string; employee_comment: string;
  manager_comment: string; status: string; created_by: string; created_at: number; updated_at: number;
};
type ReviewRow = {
  id: string; participant_id: string; reviewer_type: string; reviewer_employee_id: string; score: number;
  rating: string; strengths: string; improvements: string; comment: string; status: string;
  submitted_at: number | null; created_at: number; updated_at: number;
};
type AppealRow = {
  id: string; participant_id: string; reason: string; status: string; response: string;
  submitted_by: string; submitted_at: number; resolved_by: string; resolved_at: number | null;
  created_at: number; updated_at: number;
};
type EmployeeSnapshot = { id: string; name: string; department: string; status: string; organizationId: string; managerEmployeeId: string };

const ratingValues = new Set(["S", "A", "B", "C", "D"]);
const privileged = (principal: ErpPrincipal) => principal.roles.includes("SUPER_ADMIN") || principal.roles.includes("HR_ADMIN");

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_performance_cycles (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, period TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT', goal_due_date TEXT NOT NULL, self_due_date TEXT NOT NULL,
      manager_due_date TEXT NOT NULL, calibration_due_date TEXT NOT NULL, created_by TEXT NOT NULL,
      opened_at INTEGER, finalized_by TEXT NOT NULL DEFAULT '', finalized_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_performance_cycle_period_name ON hr_performance_cycles(period, name)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_performance_cycle_status_period ON hr_performance_cycles(status, period)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_performance_participants (
      id TEXT PRIMARY KEY NOT NULL, cycle_id TEXT NOT NULL, employee_id TEXT NOT NULL,
      organization_id TEXT NOT NULL DEFAULT '', manager_employee_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'NOT_STARTED', final_score INTEGER, final_rating TEXT NOT NULL DEFAULT '',
      calibration_note TEXT NOT NULL DEFAULT '', finalized_by TEXT NOT NULL DEFAULT '', finalized_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_performance_participant_cycle_employee ON hr_performance_participants(cycle_id, employee_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_performance_participant_manager_status ON hr_performance_participants(manager_employee_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_performance_goals (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      weight INTEGER NOT NULL, metric_type TEXT NOT NULL DEFAULT 'PERCENT', target_value REAL NOT NULL,
      actual_value REAL, unit TEXT NOT NULL DEFAULT '%', evidence TEXT NOT NULL DEFAULT '',
      employee_comment TEXT NOT NULL DEFAULT '', manager_comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_performance_goal_participant_status ON hr_performance_goals(participant_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_performance_reviews (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL, reviewer_type TEXT NOT NULL,
      reviewer_employee_id TEXT NOT NULL, score INTEGER NOT NULL, rating TEXT NOT NULL,
      strengths TEXT NOT NULL DEFAULT '', improvements TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT', submitted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_performance_review_participant_type ON hr_performance_reviews(participant_id, reviewer_type)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_performance_review_reviewer_status ON hr_performance_reviews(reviewer_employee_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_performance_appeals (
      id TEXT PRIMARY KEY NOT NULL, participant_id TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'SUBMITTED', response TEXT NOT NULL DEFAULT '', submitted_by TEXT NOT NULL,
      submitted_at INTEGER NOT NULL, resolved_by TEXT NOT NULL DEFAULT '', resolved_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_performance_appeal_participant_status ON hr_performance_appeals(participant_id, status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS hr_organization_records (organization_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS hr_organization_leaders (organization_id TEXT PRIMARY KEY, leader_employee_id TEXT, updated_at INTEGER NOT NULL)"),
  ]);
}

async function employeeSnapshot() {
  const [employeeResult, organizationResult, leaderResult] = await Promise.all([
    db.prepare("SELECT employee_id, name, department, status FROM hr_employee_records ORDER BY employee_id")
      .all<{ employee_id: string; name: string; department: string; status: string }>(),
    db.prepare("SELECT organization_id, name FROM hr_organization_records").all<{ organization_id: string; name: string }>(),
    db.prepare("SELECT organization_id, leader_employee_id FROM hr_organization_leaders").all<{ organization_id: string; leader_employee_id: string | null }>(),
  ]);
  const savedEmployees = new Map(employeeResult.results.map((row) => [row.employee_id, row]));
  const savedOrganizations = new Map(organizationResult.results.map((row) => [row.organization_id, row.name]));
  const leaderByOrganization = new Map(leaderResult.results.map((row) => [row.organization_id, row.leader_employee_id ?? ""]));
  const organizations = companyOrganizations.map((organization) => ({ id: organization.id, name: savedOrganizations.get(organization.id) ?? organization.name, originalName: organization.name }));
  const organizationByName = new Map(organizations.flatMap((organization) => [[organization.name, organization], [organization.originalName, organization]]));
  const baseIds = new Set(companyEmployees.map((employee) => employee.id));
  return [
    ...companyEmployees.map((employee) => {
      const saved = savedEmployees.get(employee.id);
      const department = saved?.department ?? organizationByName.get(employee.department)?.name ?? employee.department;
      const organization = organizationByName.get(department);
      return { id: employee.id, name: saved?.name ?? employee.name, department, status: saved?.status ?? employee.status, organizationId: organization?.id ?? "", managerEmployeeId: organization ? leaderByOrganization.get(organization.id) ?? "" : "" };
    }),
    ...employeeResult.results.filter((row) => !baseIds.has(row.employee_id)).map((row) => {
      const organization = organizationByName.get(row.department);
      return { id: row.employee_id, name: row.name, department: row.department, status: row.status, organizationId: organization?.id ?? "", managerEmployeeId: organization ? leaderByOrganization.get(organization.id) ?? "" : "" };
    }),
  ] satisfies EmployeeSnapshot[];
}

const cycleView = (row: CycleRow) => ({
  id: row.id, name: row.name, period: row.period, description: row.description, status: row.status,
  goalDueDate: row.goal_due_date, selfDueDate: row.self_due_date, managerDueDate: row.manager_due_date,
  calibrationDueDate: row.calibration_due_date, createdBy: row.created_by, openedAt: row.opened_at,
  finalizedBy: row.finalized_by, finalizedAt: row.finalized_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

async function responseState(principal: ErpPrincipal, cycleId = "") {
  const cycles = await db.prepare("SELECT * FROM hr_performance_cycles ORDER BY period DESC, created_at DESC").all<CycleRow>();
  const selected = cycles.results.find((cycle) => cycle.id === cycleId) ?? cycles.results[0] ?? null;
  if (!selected) return { cycles: [], selected: null, participants: [], goals: [], reviews: [], appeals: [], summary: { total: 0, goals: 0, self: 0, manager: 0, calibrated: 0, managerMissing: 0 } };
  const employees = await employeeSnapshot();
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
  const allParticipants = await db.prepare("SELECT * FROM hr_performance_participants WHERE cycle_id = ? ORDER BY employee_id").bind(selected.id).all<ParticipantRow>();
  const isAdmin = privileged(principal);
  const visible = allParticipants.results.filter((participant) => isAdmin || participant.employee_id === principal.employeeId || participant.manager_employee_id === principal.employeeId);
  const ids = new Set(visible.map((participant) => participant.id));
  const [goalResult, reviewResult, appealResult] = await Promise.all([
    db.prepare(`SELECT g.* FROM hr_performance_goals g JOIN hr_performance_participants p ON p.id = g.participant_id
      WHERE p.cycle_id = ? ORDER BY g.participant_id, g.created_at`).bind(selected.id).all<GoalRow>(),
    db.prepare(`SELECT r.* FROM hr_performance_reviews r JOIN hr_performance_participants p ON p.id = r.participant_id
      WHERE p.cycle_id = ? ORDER BY r.participant_id, r.reviewer_type`).bind(selected.id).all<ReviewRow>(),
    db.prepare(`SELECT a.* FROM hr_performance_appeals a JOIN hr_performance_participants p ON p.id = a.participant_id
      WHERE p.cycle_id = ? ORDER BY a.created_at DESC`).bind(selected.id).all<AppealRow>(),
  ]);
  const participants = visible.map((row) => {
    const employee = employeeMap.get(row.employee_id);
    const manager = employeeMap.get(row.manager_employee_id);
    return { id: row.id, cycleId: row.cycle_id, employeeId: row.employee_id, employeeName: employee?.name ?? row.employee_id,
      department: employee?.department ?? "미지정", organizationId: row.organization_id,
      managerEmployeeId: row.manager_employee_id, managerName: manager?.name ?? (row.manager_employee_id || "미지정"),
      status: row.status, finalScore: row.final_score, finalRating: row.final_rating, calibrationNote: row.calibration_note,
      finalizedBy: row.finalized_by, finalizedAt: row.finalized_at, createdAt: row.created_at, updatedAt: row.updated_at };
  });
  const reviews = reviewResult.results.filter((row) => {
    if (!ids.has(row.participant_id)) return false;
    if (isAdmin || selected.status === "FINALIZED") return true;
    const participant = visible.find((item) => item.id === row.participant_id);
    if (participant?.manager_employee_id === principal.employeeId) return row.reviewer_type !== "CALIBRATION";
    return row.reviewer_type === "SELF";
  }).map((row) => ({ id: row.id, participantId: row.participant_id, reviewerType: row.reviewer_type,
    reviewerEmployeeId: row.reviewer_employee_id, score: row.score, rating: row.rating, strengths: row.strengths,
    improvements: row.improvements, comment: row.comment, status: row.status, submittedAt: row.submitted_at,
    createdAt: row.created_at, updatedAt: row.updated_at }));
  const summary = {
    total: allParticipants.results.length,
    goals: allParticipants.results.filter((item) => ["GOALS_SUBMITTED", "SELF_SUBMITTED", "MANAGER_SUBMITTED", "CALIBRATED", "FINALIZED"].includes(item.status)).length,
    self: allParticipants.results.filter((item) => ["SELF_SUBMITTED", "MANAGER_SUBMITTED", "CALIBRATED", "FINALIZED"].includes(item.status)).length,
    manager: allParticipants.results.filter((item) => ["MANAGER_SUBMITTED", "CALIBRATED", "FINALIZED"].includes(item.status)).length,
    calibrated: allParticipants.results.filter((item) => ["CALIBRATED", "FINALIZED"].includes(item.status)).length,
    managerMissing: allParticipants.results.filter((item) => !item.manager_employee_id).length,
  };
  return {
    cycles: cycles.results.map(cycleView), selected: cycleView(selected), participants,
    goals: goalResult.results.filter((row) => ids.has(row.participant_id)).map((row) => ({ id: row.id, participantId: row.participant_id,
      title: row.title, description: row.description, weight: row.weight, metricType: row.metric_type,
      targetValue: row.target_value, actualValue: row.actual_value, unit: row.unit, evidence: row.evidence,
      employeeComment: row.employee_comment, managerComment: row.manager_comment, status: row.status,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at })),
    reviews,
    appeals: appealResult.results.filter((row) => ids.has(row.participant_id)).map((row) => ({ id: row.id,
      participantId: row.participant_id, reason: row.reason, status: row.status, response: row.response,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at, resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at })),
    summary,
  };
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const cycleId = new URL(request.url).searchParams.get("cycleId") ?? "";
  return Response.json({ principal: authorization.principal, canAdmin: privileged(authorization.principal), ...await responseState(authorization.principal, cycleId) });
}

async function selectedParticipant(id: string) {
  return db.prepare(`SELECT p.*, c.status AS cycle_status, c.finalized_at AS cycle_finalized_at
    FROM hr_performance_participants p JOIN hr_performance_cycles c ON c.id = p.cycle_id WHERE p.id = ?`)
    .bind(id).first<ParticipantRow & { cycle_status: string; cycle_finalized_at: number | null }>();
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const principal = authorization.principal;
  const body = await request.json() as Record<string, unknown>;
  const action = String(body.action ?? "").toUpperCase();
  const now = Date.now();

  if (action === "CREATE_CYCLE") {
    if (!privileged(principal)) return Response.json({ error: "HR 관리자만 평가주기를 만들 수 있습니다." }, { status: 403 });
    const name = String(body.name ?? "").trim().slice(0, 120);
    const period = String(body.period ?? "").trim().slice(0, 30);
    const description = String(body.description ?? "").trim().slice(0, 1500);
    const dates = ["goalDueDate", "selfDueDate", "managerDueDate", "calibrationDueDate"].map((key) => String(body[key] ?? "").trim());
    if (!name || !/^20\d{2}-(H1|H2)$/.test(period) || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))
      || dates.some((date, index) => index > 0 && date <= dates[index - 1])) return Response.json({ error: "평가명·반기와 순서대로 증가하는 단계별 마감일을 확인해 주세요." }, { status: 400 });
    const employees = (await employeeSnapshot()).filter((employee) => employee.status !== "퇴직" && employee.status !== "입사 예정");
    if (!employees.length) return Response.json({ error: "평가 대상 재직자가 없습니다." }, { status: 409 });
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO hr_performance_cycles
        (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
          calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, NULL, '', NULL, ?, ?)`)
        .bind(id, name, period, description, ...dates, principal.employeeId, now, now),
      ...employees.map((employee) => db.prepare(`INSERT INTO hr_performance_participants
        (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
          final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'NOT_STARTED', NULL, '', '', '', NULL, ?, ?)`)
        .bind(crypto.randomUUID(), id, employee.id, employee.organizationId, employee.managerEmployeeId === employee.id ? "" : employee.managerEmployeeId, now, now)),
    ]);
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_CYCLE_CREATED", entityType: "hrPerformanceCycle", entityId: id, after: { name, period, description, dates, participantCount: employees.length } });
    return Response.json({ created: true, id }, { status: 201 });
  }

  if (action === "TRANSITION") {
    if (!privileged(principal)) return Response.json({ error: "HR 관리자만 평가 단계를 변경할 수 있습니다." }, { status: 403 });
    const cycleId = String(body.cycleId ?? "").trim();
    const target = String(body.target ?? "").toUpperCase();
    const cycle = await db.prepare("SELECT * FROM hr_performance_cycles WHERE id = ?").bind(cycleId).first<CycleRow>();
    if (!cycle) return Response.json({ error: "평가주기를 찾을 수 없습니다." }, { status: 404 });
    const allowed: Record<string, string> = { DRAFT: "GOAL_SETTING", GOAL_SETTING: "SELF_REVIEW", SELF_REVIEW: "MANAGER_REVIEW", MANAGER_REVIEW: "CALIBRATION" };
    if (allowed[cycle.status] !== target) return Response.json({ error: "현재 단계에서 요청한 단계로 이동할 수 없습니다." }, { status: 409 });
    const participants = await db.prepare("SELECT id, status, manager_employee_id FROM hr_performance_participants WHERE cycle_id = ?").bind(cycleId).all<{ id: string; status: string; manager_employee_id: string }>();
    if (!participants.results.length) return Response.json({ error: "평가 대상자가 없습니다." }, { status: 409 });
    if (target === "MANAGER_REVIEW" && participants.results.some((item) => !item.manager_employee_id)) return Response.json({ error: "조직장이 지정되지 않은 평가 대상자가 있습니다. 조직관리에서 조직장을 먼저 지정해 주세요." }, { status: 409 });
    const required = target === "SELF_REVIEW" ? "GOALS_SUBMITTED" : target === "MANAGER_REVIEW" ? "SELF_SUBMITTED" : target === "CALIBRATION" ? "MANAGER_SUBMITTED" : "";
    if (required && participants.results.some((item) => item.status !== required)) return Response.json({ error: "모든 평가 대상자가 현재 단계 제출을 완료해야 다음 단계로 이동할 수 있습니다." }, { status: 409 });
    await db.prepare("UPDATE hr_performance_cycles SET status = ?, opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ? AND status = ?")
      .bind(target, now, now, cycleId, cycle.status).run();
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_STAGE_CHANGED", entityType: "hrPerformanceCycle", entityId: cycleId, before: { status: cycle.status }, after: { status: target } });
    return Response.json({ transitioned: true, status: target });
  }

  if (action === "SUBMIT_FINALIZATION") {
    if (!privileged(principal)) return Response.json({ error: "HR 관리자만 최종 확정 결재를 제출할 수 있습니다." }, { status: 403 });
    const cycleId = String(body.cycleId ?? "").trim();
    const cycle = await db.prepare("SELECT * FROM hr_performance_cycles WHERE id = ?").bind(cycleId).first<CycleRow>();
    if (!cycle || cycle.status !== "CALIBRATION") return Response.json({ error: "보정 단계의 평가주기만 최종 확정 결재를 제출할 수 있습니다." }, { status: 409 });
    const incomplete = await db.prepare("SELECT COUNT(*) AS count FROM hr_performance_participants WHERE cycle_id = ? AND status <> 'CALIBRATED'").bind(cycleId).first<{ count: number }>();
    if ((incomplete?.count ?? 0) > 0) return Response.json({ error: "모든 평가 대상자의 보정평가를 완료해 주세요." }, { status: 409 });
    await db.prepare("UPDATE hr_performance_cycles SET status = 'FINALIZATION_SUBMITTED', updated_at = ? WHERE id = ? AND status = 'CALIBRATION'").bind(now, cycleId).run();
    try {
      const approval = await createApprovalRequest(db, principal, { module: "hr", requestType: "PERFORMANCE_CYCLE",
        title: `${cycle.period} ${cycle.name} 최종 확정`, description: "목표·자기평가·관리자평가·보정평가 완료 결과의 최종 확정",
        targetEntityType: "HR_PERFORMANCE_CYCLE", targetEntityId: cycleId, priority: "HIGH",
        metadata: { period: cycle.period, name: cycle.name } });
      await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_FINALIZATION_SUBMITTED", entityType: "hrPerformanceCycle", entityId: cycleId, before: { status: cycle.status }, after: { status: "FINALIZATION_SUBMITTED", approvalId: approval.id } });
      return Response.json({ submitted: true, approvalId: approval.id }, { status: 202 });
    } catch (error) {
      await db.prepare("UPDATE hr_performance_cycles SET status = 'CALIBRATION', updated_at = ? WHERE id = ? AND status = 'FINALIZATION_SUBMITTED'").bind(Date.now(), cycleId).run();
      return Response.json({ error: error instanceof Error ? error.message : "최종 확정 결재선을 만들지 못했습니다." }, { status: 409 });
    }
  }

  const participantId = String(body.participantId ?? "").trim();
  const participant = participantId ? await selectedParticipant(participantId) : null;
  if (!participant) return Response.json({ error: "평가 대상자를 찾을 수 없습니다." }, { status: 404 });
  const isAdmin = privileged(principal);
  const isSelf = participant.employee_id === principal.employeeId;
  const isManager = participant.manager_employee_id === principal.employeeId;

  if (action === "SAVE_GOAL") {
    if (participant.cycle_status !== "GOAL_SETTING" || (!isSelf && !isAdmin)) return Response.json({ error: "목표설정 단계에서 본인 또는 HR 관리자만 목표를 저장할 수 있습니다." }, { status: 403 });
    const goalId = String(body.id ?? "").trim();
    const title = String(body.title ?? "").trim().slice(0, 160);
    const description = String(body.description ?? "").trim().slice(0, 1200);
    const weight = Math.round(Number(body.weight)); const targetValue = Number(body.targetValue);
    const metricType = String(body.metricType ?? "PERCENT").toUpperCase();
    const unit = String(body.unit ?? "%").trim().slice(0, 20);
    if (!title || description.length < 5 || !Number.isInteger(weight) || weight < 1 || weight > 100
      || !Number.isFinite(targetValue) || !["PERCENT", "NUMBER", "MILESTONE"].includes(metricType)) return Response.json({ error: "목표명·5자 이상 설명·가중치·측정방식·목표값을 확인해 주세요." }, { status: 400 });
    const existing = goalId ? await db.prepare("SELECT * FROM hr_performance_goals WHERE id = ? AND participant_id = ?").bind(goalId, participantId).first<GoalRow>() : null;
    if (existing?.status === "LOCKED") return Response.json({ error: "제출해 잠긴 목표는 수정할 수 없습니다." }, { status: 409 });
    const total = await db.prepare("SELECT COALESCE(SUM(weight), 0) AS total FROM hr_performance_goals WHERE participant_id = ? AND id <> ?").bind(participantId, goalId).first<{ total: number }>();
    if ((total?.total ?? 0) + weight > 100) return Response.json({ error: "개인 목표 가중치 합계는 100%를 넘을 수 없습니다." }, { status: 409 });
    const id = existing?.id ?? crypto.randomUUID();
    await db.prepare(`INSERT INTO hr_performance_goals
      (id, participant_id, title, description, weight, metric_type, target_value, actual_value, unit,
        evidence, employee_comment, manager_comment, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '', '', '', 'DRAFT', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, weight=excluded.weight,
        metric_type=excluded.metric_type, target_value=excluded.target_value, unit=excluded.unit, updated_at=excluded.updated_at`)
      .bind(id, participantId, title, description, weight, metricType, targetValue, unit, principal.employeeId, existing?.created_at ?? now, now).run();
    await writeErpAudit(db, { principal, module: "hr", action: existing ? "PERFORMANCE_GOAL_UPDATED" : "PERFORMANCE_GOAL_CREATED", entityType: "hrPerformanceGoal", entityId: id, before: existing ?? null, after: { participantId, title, description, weight, metricType, targetValue, unit }, reason: !isSelf ? "HR 관리자 대리 입력" : undefined });
    return Response.json({ saved: true, id });
  }

  if (action === "SUBMIT_GOALS") {
    if (participant.cycle_status !== "GOAL_SETTING" || (!isSelf && !isAdmin)) return Response.json({ error: "목표설정 단계에서 본인 또는 HR 관리자만 제출할 수 있습니다." }, { status: 403 });
    const totals = await db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(weight), 0) AS weight FROM hr_performance_goals WHERE participant_id = ?").bind(participantId).first<{ count: number; weight: number }>();
    if ((totals?.count ?? 0) < 1 || totals?.weight !== 100) return Response.json({ error: "목표를 1개 이상 등록하고 가중치 합계를 정확히 100%로 맞춰 주세요." }, { status: 409 });
    await db.batch([
      db.prepare("UPDATE hr_performance_goals SET status = 'LOCKED', updated_at = ? WHERE participant_id = ?").bind(now, participantId),
      db.prepare("UPDATE hr_performance_participants SET status = 'GOALS_SUBMITTED', updated_at = ? WHERE id = ?").bind(now, participantId),
    ]);
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_GOALS_SUBMITTED", entityType: "hrPerformanceParticipant", entityId: participantId, after: totals, reason: !isSelf ? "HR 관리자 대리 제출" : undefined });
    return Response.json({ submitted: true });
  }

  if (action === "DELETE_GOAL") {
    if (participant.cycle_status !== "GOAL_SETTING" || (!isSelf && !isAdmin)) return Response.json({ error: "목표설정 단계에서 본인 또는 HR 관리자만 목표를 삭제할 수 있습니다." }, { status: 403 });
    const goalId = String(body.goalId ?? "").trim();
    const goal = await db.prepare("SELECT * FROM hr_performance_goals WHERE id = ? AND participant_id = ?").bind(goalId, participantId).first<GoalRow>();
    if (!goal) return Response.json({ error: "삭제할 성과 목표를 찾을 수 없습니다." }, { status: 404 });
    if (goal.status !== "DRAFT" || participant.status !== "NOT_STARTED") return Response.json({ error: "제출해 잠긴 목표는 삭제할 수 없습니다." }, { status: 409 });
    await db.prepare("DELETE FROM hr_performance_goals WHERE id = ? AND participant_id = ? AND status = 'DRAFT'").bind(goalId, participantId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_GOAL_DELETED", entityType: "hrPerformanceGoal", entityId: goalId, before: goal, after: null, reason: !isSelf ? "HR 관리자 대리 삭제" : undefined });
    return Response.json({ deleted: true });
  }

  if (action === "UPDATE_GOAL_RESULT") {
    const goalId = String(body.goalId ?? "").trim();
    const goal = await db.prepare("SELECT * FROM hr_performance_goals WHERE id = ? AND participant_id = ?").bind(goalId, participantId).first<GoalRow>();
    if (!goal) return Response.json({ error: "성과 목표를 찾을 수 없습니다." }, { status: 404 });
    if (participant.cycle_status === "SELF_REVIEW" && (isSelf || isAdmin)) {
      const actualValue = Number(body.actualValue); const evidence = String(body.evidence ?? "").trim().slice(0, 2000);
      const employeeComment = String(body.employeeComment ?? "").trim().slice(0, 2000);
      if (!Number.isFinite(actualValue) || evidence.length < 5 || employeeComment.length < 5) return Response.json({ error: "실제값과 5자 이상의 성과 근거·설명을 입력해 주세요." }, { status: 400 });
      await db.prepare("UPDATE hr_performance_goals SET actual_value = ?, evidence = ?, employee_comment = ?, updated_at = ? WHERE id = ?")
        .bind(actualValue, evidence, employeeComment, now, goalId).run();
      await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_GOAL_RESULT_SAVED", entityType: "hrPerformanceGoal", entityId: goalId, before: goal, after: { actualValue, evidence, employeeComment }, reason: !isSelf ? "HR 관리자 대리 입력" : undefined });
      return Response.json({ saved: true });
    }
    if (participant.cycle_status === "MANAGER_REVIEW" && (isManager || isAdmin)) {
      const managerComment = String(body.managerComment ?? "").trim().slice(0, 2000);
      if (managerComment.length < 5) return Response.json({ error: "목표별 관리자 의견을 5자 이상 입력해 주세요." }, { status: 400 });
      await db.prepare("UPDATE hr_performance_goals SET manager_comment = ?, updated_at = ? WHERE id = ?")
        .bind(managerComment, now, goalId).run();
      await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_GOAL_MANAGER_COMMENT_SAVED", entityType: "hrPerformanceGoal", entityId: goalId, before: goal, after: { managerComment }, reason: !isManager ? "HR 관리자 대리 입력" : undefined });
      return Response.json({ saved: true });
    }
    return Response.json({ error: "현재 단계에서 목표 실적을 수정할 수 없습니다." }, { status: 409 });
  }

  if (action === "SUBMIT_REVIEW") {
    const reviewerType = String(body.reviewerType ?? "").toUpperCase();
    const requiredStage = { SELF: "SELF_REVIEW", MANAGER: "MANAGER_REVIEW", CALIBRATION: "CALIBRATION" }[reviewerType];
    const allowed = reviewerType === "SELF" ? isSelf || isAdmin : reviewerType === "MANAGER" ? isManager || isAdmin : reviewerType === "CALIBRATION" ? isAdmin : false;
    if (!requiredStage || participant.cycle_status !== requiredStage || !allowed) return Response.json({ error: "현재 평가 단계와 평가자 권한을 확인해 주세요." }, { status: 403 });
    const score = Math.round(Number(body.score)); const rating = String(body.rating ?? "").toUpperCase();
    const strengths = String(body.strengths ?? "").trim().slice(0, 1500);
    const improvements = String(body.improvements ?? "").trim().slice(0, 1500);
    const comment = String(body.comment ?? "").trim().slice(0, 2000);
    if (!Number.isInteger(score) || score < 0 || score > 100 || !ratingValues.has(rating)
      || strengths.length < 5 || improvements.length < 5 || comment.length < 5) return Response.json({ error: "0~100점, S~D 등급과 5자 이상의 강점·개선점·종합의견을 입력해 주세요." }, { status: 400 });
    if (reviewerType === "SELF") {
      const incompleteGoals = await db.prepare(`SELECT COUNT(*) AS count FROM hr_performance_goals
        WHERE participant_id = ? AND (actual_value IS NULL OR length(trim(evidence)) < 5 OR length(trim(employee_comment)) < 5)`)
        .bind(participantId).first<{ count: number }>();
      if ((incompleteGoals?.count ?? 0) > 0) return Response.json({ error: "모든 목표의 실제값·성과 근거·본인 설명을 저장한 뒤 자기평가를 제출해 주세요." }, { status: 409 });
    }
    if (reviewerType === "MANAGER") {
      const incompleteGoals = await db.prepare(`SELECT COUNT(*) AS count FROM hr_performance_goals
        WHERE participant_id = ? AND length(trim(manager_comment)) < 5`).bind(participantId).first<{ count: number }>();
      if ((incompleteGoals?.count ?? 0) > 0) return Response.json({ error: "모든 목표에 관리자 의견을 저장한 뒤 관리자평가를 제출해 주세요." }, { status: 409 });
    }
    const existing = await db.prepare("SELECT * FROM hr_performance_reviews WHERE participant_id = ? AND reviewer_type = ?").bind(participantId, reviewerType).first<ReviewRow>();
    if (existing?.status === "SUBMITTED") return Response.json({ error: "이미 제출된 평가는 수정할 수 없습니다." }, { status: 409 });
    const id = existing?.id ?? crypto.randomUUID();
    const nextParticipantStatus = reviewerType === "SELF" ? "SELF_SUBMITTED" : reviewerType === "MANAGER" ? "MANAGER_SUBMITTED" : "CALIBRATED";
    await db.batch([
      db.prepare(`INSERT INTO hr_performance_reviews
        (id, participant_id, reviewer_type, reviewer_employee_id, score, rating, strengths, improvements,
          comment, status, submitted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)
        ON CONFLICT(participant_id, reviewer_type) DO UPDATE SET reviewer_employee_id=excluded.reviewer_employee_id,
          score=excluded.score, rating=excluded.rating, strengths=excluded.strengths, improvements=excluded.improvements,
          comment=excluded.comment, status='SUBMITTED', submitted_at=excluded.submitted_at, updated_at=excluded.updated_at`)
        .bind(id, participantId, reviewerType, principal.employeeId, score, rating, strengths, improvements, comment, now, existing?.created_at ?? now, now),
      db.prepare(`UPDATE hr_performance_participants SET status = ?, final_score = CASE WHEN ? = 'CALIBRATION' THEN ? ELSE final_score END,
        final_rating = CASE WHEN ? = 'CALIBRATION' THEN ? ELSE final_rating END,
        calibration_note = CASE WHEN ? = 'CALIBRATION' THEN ? ELSE calibration_note END, updated_at = ? WHERE id = ?`)
        .bind(nextParticipantStatus, reviewerType, score, reviewerType, rating, reviewerType, comment, now, participantId),
    ]);
    await writeErpAudit(db, { principal, module: "hr", action: `PERFORMANCE_${reviewerType}_SUBMITTED`, entityType: "hrPerformanceReview", entityId: id, before: existing ?? null, after: { participantId, reviewerType, score, rating, strengths, improvements, comment }, reason: reviewerType !== "CALIBRATION" && !isSelf && !isManager ? "HR 관리자 대리 제출" : undefined });
    return Response.json({ submitted: true, id });
  }

  if (action === "SUBMIT_APPEAL") {
    if (!isSelf || participant.cycle_status !== "FINALIZED" || !participant.cycle_finalized_at || now - participant.cycle_finalized_at > 14 * 24 * 60 * 60 * 1000) return Response.json({ error: "평가 확정 후 14일 안에 본인만 이의제기를 제출할 수 있습니다." }, { status: 403 });
    const reason = String(body.reason ?? "").trim().slice(0, 2000);
    if (reason.length < 20) return Response.json({ error: "이의제기 사유와 근거를 20자 이상 입력해 주세요." }, { status: 400 });
    const open = await db.prepare("SELECT id FROM hr_performance_appeals WHERE participant_id = ? AND status = 'SUBMITTED' LIMIT 1").bind(participantId).first();
    if (open) return Response.json({ error: "처리 중인 이의제기가 이미 있습니다." }, { status: 409 });
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO hr_performance_appeals
      (id, participant_id, reason, status, response, submitted_by, submitted_at, resolved_by, resolved_at, created_at, updated_at)
      VALUES (?, ?, ?, 'SUBMITTED', '', ?, ?, '', NULL, ?, ?)`)
      .bind(id, participantId, reason, principal.employeeId, now, now, now).run();
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_APPEAL_SUBMITTED", entityType: "hrPerformanceAppeal", entityId: id, after: { participantId, reason } });
    return Response.json({ submitted: true, id }, { status: 201 });
  }

  if (action === "RESOLVE_APPEAL") {
    if (!isAdmin) return Response.json({ error: "HR 관리자만 이의제기를 처리할 수 있습니다." }, { status: 403 });
    const appealId = String(body.appealId ?? "").trim(); const outcome = String(body.outcome ?? "").toUpperCase();
    const response = String(body.response ?? "").trim().slice(0, 2000);
    if (!["RESOLVED", "REJECTED"].includes(outcome) || response.length < 10) return Response.json({ error: "처리결과와 10자 이상의 답변을 입력해 주세요." }, { status: 400 });
    const appeal = await db.prepare("SELECT * FROM hr_performance_appeals WHERE id = ? AND participant_id = ?").bind(appealId, participantId).first<AppealRow>();
    if (!appeal || appeal.status !== "SUBMITTED") return Response.json({ error: "처리할 이의제기를 찾을 수 없습니다." }, { status: 409 });
    await db.prepare("UPDATE hr_performance_appeals SET status = ?, response = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTED'")
      .bind(outcome, response, principal.employeeId, now, now, appealId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "PERFORMANCE_APPEAL_RESOLVED", entityType: "hrPerformanceAppeal", entityId: appealId, before: appeal, after: { outcome, response } });
    return Response.json({ resolved: true });
  }

  return Response.json({ error: "지원하지 않는 성과관리 작업입니다." }, { status: 400 });
}
