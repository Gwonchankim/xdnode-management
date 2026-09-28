import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";
import { authorizeErpRequest, writeErpAudit, type ErpPrincipal, linkedEmployeeId } from "../../../erp-platform";
import { isHrManager } from "../../../access-tabs";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type CourseRow = {
  id: string; title: string; course_type: string; year: number; description: string; provider: string;
  delivery_mode: string; start_date: string; due_date: string; duration_minutes: number;
  audience_type: string; organization_id: string; status: string; created_by: string;
  opened_at: number | null; closed_at: number | null; created_at: number; updated_at: number;
};
type AssignmentRow = {
  id: string; course_id: string; employee_id: string; employee_name: string; department: string;
  status: string; progress: number; score: number | null; completed_minutes: number;
  evidence_name: string; evidence_ref: string; employee_note: string; waiver_reason: string;
  verified_by: string; verified_at: number | null; completed_at: number | null; created_at: number; updated_at: number;
};
type EmployeeSnapshot = { id: string; name: string; department: string; status: string; organizationId: string };


async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_training_courses (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, course_type TEXT NOT NULL DEFAULT 'MANDATORY',
      year INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
      delivery_mode TEXT NOT NULL DEFAULT 'ONLINE', start_date TEXT NOT NULL, due_date TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 0, audience_type TEXT NOT NULL DEFAULT 'ALL',
      organization_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'DRAFT', created_by TEXT NOT NULL,
      opened_at INTEGER, closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_training_course_year_title ON hr_training_courses(year, title)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_training_course_status_due ON hr_training_courses(status, due_date)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_training_assignments (
      id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL, employee_id TEXT NOT NULL, employee_name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ASSIGNED', progress INTEGER NOT NULL DEFAULT 0,
      score REAL, completed_minutes INTEGER NOT NULL DEFAULT 0, evidence_name TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '', employee_note TEXT NOT NULL DEFAULT '', waiver_reason TEXT NOT NULL DEFAULT '',
      verified_by TEXT NOT NULL DEFAULT '', verified_at INTEGER, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_training_assignment_course_employee ON hr_training_assignments(course_id, employee_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_training_assignment_employee_status ON hr_training_assignments(employee_id, status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_training_assignment_course_status ON hr_training_assignments(course_id, status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS hr_organization_records (organization_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
}

async function employeeSnapshot() {
  const [employeeResult, organizationResult] = await Promise.all([
    db.prepare("SELECT employee_id, name, department, status FROM hr_employee_records ORDER BY employee_id").all<{ employee_id: string; name: string; department: string; status: string }>(),
    db.prepare("SELECT organization_id, name FROM hr_organization_records").all<{ organization_id: string; name: string }>(),
  ]);
  const savedEmployees = new Map(employeeResult.results.map((row) => [row.employee_id, row]));
  const savedOrganizations = new Map(organizationResult.results.map((row) => [row.organization_id, row.name]));
  const organizations = companyOrganizations.map((organization) => ({ id: organization.id, name: savedOrganizations.get(organization.id) ?? organization.name, originalName: organization.name }));
  const organizationByName = new Map(organizations.flatMap((organization) => [[organization.name, organization], [organization.originalName, organization]]));
  const baseIds = new Set(companyEmployees.map((employee) => employee.id));
  return [
    ...companyEmployees.map((employee) => {
      const saved = savedEmployees.get(employee.id); const department = saved?.department ?? employee.department;
      return { id: employee.id, name: saved?.name ?? employee.name, department, status: saved?.status ?? employee.status, organizationId: organizationByName.get(department)?.id ?? "" };
    }),
    ...employeeResult.results.filter((row) => !baseIds.has(row.employee_id)).map((row) => ({ id: row.employee_id, name: row.name, department: row.department, status: row.status, organizationId: organizationByName.get(row.department)?.id ?? "" })),
  ] satisfies EmployeeSnapshot[];
}

const courseView = (row: CourseRow) => ({ id: row.id, title: row.title, courseType: row.course_type, year: row.year,
  description: row.description, provider: row.provider, deliveryMode: row.delivery_mode, startDate: row.start_date,
  dueDate: row.due_date, durationMinutes: row.duration_minutes, audienceType: row.audience_type,
  organizationId: row.organization_id, status: row.status, createdBy: row.created_by,
  openedAt: row.opened_at, closedAt: row.closed_at, createdAt: row.created_at, updatedAt: row.updated_at });
const assignmentView = (row: AssignmentRow) => ({ id: row.id, courseId: row.course_id, employeeId: row.employee_id,
  employeeName: row.employee_name, department: row.department, status: row.status, progress: row.progress,
  score: row.score, completedMinutes: row.completed_minutes, evidenceName: row.evidence_name,
  evidenceRef: row.evidence_ref, employeeNote: row.employee_note, waiverReason: row.waiver_reason,
  verifiedBy: row.verified_by, verifiedAt: row.verified_at, completedAt: row.completed_at,
  createdAt: row.created_at, updatedAt: row.updated_at });

async function responseState(principal: ErpPrincipal, selectedId = "") {
  const allCourses = await db.prepare("SELECT * FROM hr_training_courses ORDER BY year DESC, due_date DESC, created_at DESC").all<CourseRow>();
  const allAssignments = await db.prepare("SELECT * FROM hr_training_assignments ORDER BY course_id, employee_name").all<AssignmentRow>();
  const isAdmin = isHrManager(principal);
  const visibleAssignments = isAdmin ? allAssignments.results : allAssignments.results.filter((item) => item.employee_id === linkedEmployeeId(principal));
  const visibleCourseIds = new Set(visibleAssignments.map((item) => item.course_id));
  const courses = isAdmin ? allCourses.results : allCourses.results.filter((item) => visibleCourseIds.has(item.id));
  const selected = courses.find((item) => item.id === selectedId) ?? courses[0] ?? null;
  const selectedAssignments = selected ? visibleAssignments.filter((item) => item.course_id === selected.id) : [];
  const today = new Date().toISOString().slice(0, 10);
  const completed = selectedAssignments.filter((item) => ["COMPLETED", "WAIVED"].includes(item.status)).length;
  return { principal, canAdmin: isAdmin, courses: courses.map(courseView), selected: selected ? courseView(selected) : null,
    assignments: selectedAssignments.map(assignmentView), organizations: companyOrganizations.map((item) => ({ id: item.id, name: item.name })),
    summary: { total: selectedAssignments.length, completed, incomplete: selectedAssignments.length - completed,
      completionRate: selectedAssignments.length ? Math.round((completed / selectedAssignments.length) * 100) : 0,
      overdue: selectedAssignments.filter((item) => !["COMPLETED", "WAIVED"].includes(item.status) && Boolean(selected && selected.due_date < today)).length } };
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  return Response.json(await responseState(authorization.principal, new URL(request.url).searchParams.get("courseId") ?? ""));
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  const principal = authorization.principal; const isAdmin = isHrManager(principal);
  const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? "").toUpperCase(); const now = Date.now();

  if (action === "CREATE_COURSE") {
    if (!isAdmin) return Response.json({ error: "HR 관리자만 교육 과정을 만들 수 있습니다." }, { status: 403 });
    const title = String(body.title ?? "").trim().slice(0, 160); const courseType = String(body.courseType ?? "MANDATORY").toUpperCase();
    const year = Math.round(Number(body.year)); const description = String(body.description ?? "").trim().slice(0, 1500);
    const provider = String(body.provider ?? "").trim().slice(0, 160); const deliveryMode = String(body.deliveryMode ?? "ONLINE").toUpperCase();
    const startDate = String(body.startDate ?? "").trim(); const dueDate = String(body.dueDate ?? "").trim();
    const durationMinutes = Math.round(Number(body.durationMinutes)); const audienceType = String(body.audienceType ?? "ALL").toUpperCase();
    const organizationId = audienceType === "ORGANIZATION" ? String(body.organizationId ?? "").trim() : "";
    if (!title || description.length < 5 || !provider || year < 2024 || year > 2100 || !["MANDATORY", "ROLE", "SKILL"].includes(courseType)
      || !["ONLINE", "OFFLINE", "BLENDED"].includes(deliveryMode) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
      || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < startDate || durationMinutes < 1
      || !["ALL", "ORGANIZATION"].includes(audienceType) || (audienceType === "ORGANIZATION" && !companyOrganizations.some((item) => item.id === organizationId))) {
      return Response.json({ error: "과정명·설명·기관·기간·시간·대상을 확인해 주세요." }, { status: 400 });
    }
    const id = crypto.randomUUID();
    try {
      await db.prepare(`INSERT INTO hr_training_courses
        (id, title, course_type, year, description, provider, delivery_mode, start_date, due_date, duration_minutes,
          audience_type, organization_id, status, created_by, opened_at, closed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, NULL, NULL, ?, ?)`)
        .bind(id, title, courseType, year, description, provider, deliveryMode, startDate, dueDate, durationMinutes, audienceType, organizationId, principal.employeeId, now, now).run();
    } catch { return Response.json({ error: "같은 연도에 동일한 교육 과정명이 이미 있습니다." }, { status: 409 }); }
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_COURSE_CREATED", entityType: "hrTrainingCourse", entityId: id, after: { title, courseType, year, provider, startDate, dueDate, durationMinutes, audienceType, organizationId } });
    return Response.json({ created: true, id }, { status: 201 });
  }

  const courseId = String(body.courseId ?? "").trim();
  const course = courseId ? await db.prepare("SELECT * FROM hr_training_courses WHERE id = ?").bind(courseId).first<CourseRow>() : null;
  if (!course) return Response.json({ error: "교육 과정을 찾을 수 없습니다." }, { status: 404 });

  if (action === "DELETE_COURSE") {
    if (!isAdmin || course.status !== "DRAFT") return Response.json({ error: "HR 관리자만 개설 전 초안 과정을 삭제할 수 있습니다." }, { status: 403 });
    await db.prepare("DELETE FROM hr_training_courses WHERE id = ? AND status = 'DRAFT'").bind(courseId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_COURSE_DELETED", entityType: "hrTrainingCourse", entityId: courseId, before: course, after: null });
    return Response.json({ deleted: true });
  }

  if (action === "OPEN_COURSE") {
    if (!isAdmin || course.status !== "DRAFT") return Response.json({ error: "HR 관리자만 초안 과정을 개설할 수 있습니다." }, { status: 403 });
    const employees = (await employeeSnapshot()).filter((employee) => employee.status !== "퇴직" && employee.status !== "입사 예정"
      && (course.audience_type === "ALL" || employee.organizationId === course.organization_id));
    if (!employees.length) return Response.json({ error: "조건에 맞는 재직 교육 대상자가 없습니다." }, { status: 409 });
    await db.batch([
      ...employees.map((employee) => db.prepare(`INSERT INTO hr_training_assignments
        (id, course_id, employee_id, employee_name, department, status, progress, score, completed_minutes,
          evidence_name, evidence_ref, employee_note, waiver_reason, verified_by, verified_at, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'ASSIGNED', 0, NULL, 0, '', '', '', '', '', NULL, NULL, ?, ?)
        ON CONFLICT(course_id, employee_id) DO NOTHING`).bind(crypto.randomUUID(), courseId, employee.id, employee.name, employee.department, now, now)),
      db.prepare("UPDATE hr_training_courses SET status = 'OPEN', opened_at = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'").bind(now, now, courseId),
    ]);
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_COURSE_OPENED", entityType: "hrTrainingCourse", entityId: courseId, before: { status: course.status }, after: { status: "OPEN", assignmentCount: employees.length } });
    return Response.json({ opened: true, assignmentCount: employees.length });
  }

  if (action === "CLOSE_COURSE") {
    if (!isAdmin || course.status !== "OPEN") return Response.json({ error: "HR 관리자만 진행 중 과정을 종료할 수 있습니다." }, { status: 403 });
    const incomplete = await db.prepare("SELECT COUNT(*) AS count FROM hr_training_assignments WHERE course_id = ? AND status NOT IN ('COMPLETED', 'WAIVED')").bind(courseId).first<{ count: number }>();
    if ((incomplete?.count ?? 0) > 0) return Response.json({ error: "미이수 대상자가 남아 있어 과정을 종료할 수 없습니다." }, { status: 409 });
    await db.prepare("UPDATE hr_training_courses SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'").bind(now, now, courseId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_COURSE_CLOSED", entityType: "hrTrainingCourse", entityId: courseId, before: { status: course.status }, after: { status: "CLOSED" } });
    return Response.json({ closed: true });
  }

  const assignmentId = String(body.assignmentId ?? "").trim();
  const assignment = assignmentId ? await db.prepare("SELECT * FROM hr_training_assignments WHERE id = ? AND course_id = ?").bind(assignmentId, courseId).first<AssignmentRow>() : null;
  if (!assignment) return Response.json({ error: "교육 대상자를 찾을 수 없습니다." }, { status: 404 });
  // 본인 판정은 인사기록과 연결된 계정만 한다(acct_… 는 인사기록 id 가 아니다).
  const isSelf = assignment.employee_id === linkedEmployeeId(principal);

  if (action === "UPDATE_ASSIGNMENT") {
    if (course.status !== "OPEN" || (!isSelf && !isAdmin) || ["SUBMITTED", "COMPLETED", "WAIVED"].includes(assignment.status)) return Response.json({ error: "진행 중인 본인 교육만 수정할 수 있습니다." }, { status: 403 });
    const progress = Math.round(Number(body.progress)); const completedMinutes = Math.round(Number(body.completedMinutes));
    const scoreInput = body.score; const score = scoreInput === "" || scoreInput === null || scoreInput === undefined ? null : Number(scoreInput);
    const evidenceName = String(body.evidenceName ?? "").trim().slice(0, 255); const evidenceRef = String(body.evidenceRef ?? "").trim().slice(0, 500);
    const employeeNote = String(body.employeeNote ?? "").trim().slice(0, 1200);
    if (!Number.isInteger(progress) || progress < 0 || progress > 100 || !Number.isInteger(completedMinutes) || completedMinutes < 0
      || (score !== null && (!Number.isFinite(score) || score < 0 || score > 100))) return Response.json({ error: "진행률·이수시간·점수를 확인해 주세요." }, { status: 400 });
    if (progress === 100 && course.course_type === "MANDATORY" && (!evidenceName || !evidenceRef)) return Response.json({ error: "법정교육 완료에는 증빙명과 증빙 참조가 모두 필요합니다." }, { status: 409 });
    const status = progress === 100 ? "SUBMITTED" : progress > 0 ? "IN_PROGRESS" : "ASSIGNED";
    await db.prepare(`UPDATE hr_training_assignments SET status = ?, progress = ?, score = ?, completed_minutes = ?,
      evidence_name = ?, evidence_ref = ?, employee_note = ?, verified_by = ?, verified_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(status, progress, score, completedMinutes, evidenceName, evidenceRef, employeeNote, "", null, null, now, assignmentId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_ASSIGNMENT_UPDATED", entityType: "hrTrainingAssignment", entityId: assignmentId, before: assignment, after: { status, progress, score, completedMinutes, evidenceName, evidenceRef, employeeNote }, reason: !isSelf ? "HR 관리자 대리 입력" : undefined });
    return Response.json({ saved: true, status });
  }

  if (action === "VERIFY_ASSIGNMENT") {
    if (!isAdmin || course.status !== "OPEN" || assignment.status !== "SUBMITTED") return Response.json({ error: "HR 관리자만 제출된 교육 증빙을 수료 확정할 수 있습니다." }, { status: 403 });
    if (course.course_type === "MANDATORY" && (!assignment.evidence_name || !assignment.evidence_ref)) return Response.json({ error: "법정교육 증빙명과 증빙 참조를 먼저 확인해 주세요." }, { status: 409 });
    await db.prepare("UPDATE hr_training_assignments SET status = 'COMPLETED', verified_by = ?, verified_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTED'")
      .bind(principal.employeeId, now, now, now, assignmentId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_ASSIGNMENT_VERIFIED", entityType: "hrTrainingAssignment", entityId: assignmentId, before: assignment, after: { status: "COMPLETED", verifiedBy: principal.employeeId, verifiedAt: now } });
    return Response.json({ verified: true });
  }

  if (action === "WAIVE_ASSIGNMENT") {
    if (!isAdmin || course.status !== "OPEN" || ["COMPLETED", "WAIVED"].includes(assignment.status)) return Response.json({ error: "HR 관리자만 진행 중인 미이수 대상을 면제할 수 있습니다." }, { status: 403 });
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    if (reason.length < 10) return Response.json({ error: "면제 사유를 10자 이상 입력해 주세요." }, { status: 400 });
    await db.prepare("UPDATE hr_training_assignments SET status = 'WAIVED', waiver_reason = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?").bind(reason, principal.employeeId, now, now, assignmentId).run();
    await writeErpAudit(db, { principal, module: "hr", action: "TRAINING_ASSIGNMENT_WAIVED", entityType: "hrTrainingAssignment", entityId: assignmentId, before: assignment, after: { status: "WAIVED", reason } });
    return Response.json({ waived: true });
  }

  return Response.json({ error: "지원하지 않는 교육 작업입니다." }, { status: 400 });
}
