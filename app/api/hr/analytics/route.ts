import { env } from "cloudflare:workers";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { readOptionalHrRows } from "../../../hr-optional-tables";
import { companyEmployees, companyOrganizations } from "../../../hr-company-data";
import { authorizeErpRequest, safeJson, writeErpAudit } from "../../../erp-platform";
import { isHrManager } from "../../../access-tabs";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type EmployeeRow = { employee_id: string; name: string; department: string; employment_type: string; join_date: string; status: string; history_json: string; retirement_json: string | null };
type ApplicantRow = { id: string; applied: string; stage: string; source: string; interview_json: string | null };
type OfferRow = { applicant_id: string; status: string; start_date: string };
type PayrollRow = { year_month: string; department: string | null; employee_count: number; gross_pay: number; deductions: number; net_pay: number };
type PerformanceRow = { final_score: number | null; final_rating: string; finalized_at: number | null };
type TrainingRow = { course_id: string; title: string; course_type: string; due_date: string; assignment_status: string; department: string };
type ReportRow = { id: string; report_type: string; title: string; period_start: string; period_end: string; version: number; snapshot_json: string; generated_by: string; created_at: number };
type EmployeeSnapshot = { id: string; name: string; department: string; status: string; joinDate: string; retirementDate: string };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const normalizeDate = (value: string) => value.trim().replaceAll(".", "-").slice(0, 10);
const utcTime = (value: string) => new Date(`${value}T00:00:00Z`).getTime();
const daysBetween = (from: string, to: string) => Math.round((utcTime(to) - utcTime(from)) / 86400000);

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_analytics_reports (
      id TEXT PRIMARY KEY NOT NULL, report_type TEXT NOT NULL DEFAULT 'HR_OVERVIEW', title TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      snapshot_json TEXT NOT NULL, generated_by TEXT NOT NULL, created_at INTEGER NOT NULL)`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_analytics_report_period_version ON hr_analytics_reports(report_type, period_start, period_end, version)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_analytics_report_created ON hr_analytics_reports(created_at)"),
  ]);
}

function validatePeriod(from: string, to: string) {
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) return "조회 시작일과 종료일을 확인해 주세요.";
  if (daysBetween(from, to) > 366 * 5) return "한 번에 조회할 수 있는 기간은 최대 5년입니다.";
  return "";
}

function retirementDate(row: EmployeeRow) {
  const retirement = safeJson<{ date?: string } | null>(row.retirement_json, null);
  if (retirement?.date) return normalizeDate(retirement.date);
  const history = safeJson<{ date?: string; type?: string }[]>(row.history_json, []);
  const retired = history.filter((item) => item.type === "퇴직" && item.date).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return retired?.date ? normalizeDate(retired.date) : "";
}

async function employeesSnapshot() {
  const result = await db.prepare(`SELECT employee_id, name, department, employment_type, join_date, status,
    history_json, retirement_json FROM hr_employee_records ORDER BY employee_id`).all<EmployeeRow>();
  const saved = new Map(result.results.map((row) => [row.employee_id, row])); const baseIds = new Set(companyEmployees.map((item) => item.id));
  return [
    ...companyEmployees.map((item) => {
      const row = saved.get(item.id); return { id: item.id, name: row?.name ?? item.name, department: row?.department ?? item.department,
        status: row?.status ?? item.status, joinDate: normalizeDate(row?.join_date ?? item.joinDate), retirementDate: row ? retirementDate(row) : "" };
    }),
    ...result.results.filter((row) => !baseIds.has(row.employee_id)).map((row) => ({ id: row.employee_id, name: row.name,
      department: row.department, status: row.status, joinDate: normalizeDate(row.join_date), retirementDate: retirementDate(row) })),
  ] satisfies EmployeeSnapshot[];
}

function monthEnds(from: string, to: string) {
  const points: { label: string; date: string }[] = []; const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.getTime() <= utcTime(to)) {
    const year = cursor.getUTCFullYear(); const month = cursor.getUTCMonth();
    const end = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    points.push({ label: `${year}-${String(month + 1).padStart(2, "0")}`, date: end > to ? to : end });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return points;
}

const activeOn = (employee: EmployeeSnapshot, date: string) => Boolean(employee.joinDate && employee.joinDate <= date && (!employee.retirementDate || employee.retirementDate > date));
const countBy = <T>(items: T[], key: (item: T) => string) => [...items.reduce<Map<string, number>>((map, item) => { const value = key(item) || "미지정"; map.set(value, (map.get(value) ?? 0) + 1); return map; }, new Map()).entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

async function buildSnapshot(from: string, to: string, canSensitive: boolean) {
  const employees = await employeesSnapshot(); const fromMonth = from.slice(0, 7); const toMonth = to.slice(0, 7);
  const [applicantsResult, offersResult, payrollResult, performanceResult, trainingResult] = await Promise.all([
    readOptionalHrRows<ApplicantRow>(db, ["hr_applicants"], "SELECT id, applied, stage, source, interview_json FROM hr_applicants WHERE REPLACE(applied, '.', '-') BETWEEN ? AND ? ORDER BY applied", from, to),
    readOptionalHrRows<OfferRow>(db, ["hr_offer_requests", "hr_applicants"], `SELECT o.applicant_id, o.status, o.start_date FROM hr_offer_requests o
      JOIN hr_applicants a ON a.id = o.applicant_id WHERE REPLACE(a.applied, '.', '-') BETWEEN ? AND ? ORDER BY o.created_at`, from, to),
    canSensitive ? readOptionalHrRows<PayrollRow>(db, ["hr_payroll_records"], `SELECT year_month, department, COUNT(*) AS employee_count,
      COALESCE(SUM(gross_pay), 0) AS gross_pay, COALESCE(SUM(deductions), 0) AS deductions, COALESCE(SUM(net_pay), 0) AS net_pay
      FROM hr_payroll_records WHERE year_month BETWEEN ? AND ? GROUP BY year_month, department ORDER BY year_month`, fromMonth, toMonth) : Promise.resolve({ results: [] as PayrollRow[] }),
    canSensitive ? readOptionalHrRows<PerformanceRow>(db, ["hr_performance_participants", "hr_performance_cycles"], `SELECT p.final_score, p.final_rating, p.finalized_at FROM hr_performance_participants p
      JOIN hr_performance_cycles c ON c.id = p.cycle_id WHERE c.status = 'FINALIZED' AND p.status = 'FINALIZED'
      AND p.finalized_at BETWEEN ? AND ?`, utcTime(from), utcTime(to) + 86399999) : Promise.resolve({ results: [] as PerformanceRow[] }),
    readOptionalHrRows<TrainingRow>(db, ["hr_training_courses", "hr_training_assignments"], `SELECT c.id AS course_id, c.title, c.course_type, c.due_date, a.status AS assignment_status, a.department
      FROM hr_training_courses c JOIN hr_training_assignments a ON a.course_id = c.id
      WHERE c.due_date BETWEEN ? AND ? AND c.status IN ('OPEN', 'CLOSED') ORDER BY c.due_date, c.title`, from, to),
  ]);

  const current = employees.filter((item) => activeOn(item, to)); const start = employees.filter((item) => activeOn(item, from));
  const hires = employees.filter((item) => item.joinDate >= from && item.joinDate <= to);
  const exits = employees.filter((item) => item.retirementDate >= from && item.retirementDate <= to);
  const averageHeadcount = (start.length + current.length) / 2;
  const headcountTrend = monthEnds(from, to).map((point) => ({ period: point.label, value: employees.filter((item) => activeOn(item, point.date)).length }));
  // 조직관리에서 이름을 바꾼 조직은 hr_organization_records 의 이름으로 센다(정적 이름만 보면 개명한 조직이 통계에서 사라진다).
  let renamed = new Map<string, string>();
  try {
    const rows = await db.prepare("SELECT organization_id, name FROM hr_organization_records").all<{ organization_id: string; name: string }>();
    renamed = new Map(rows.results.map((row) => [row.organization_id, row.name]));
  } catch { /* 조직관리를 한 번도 열지 않은 환경에는 표가 없다 — 기준자료 이름을 쓴다. */ }
  const organization = companyOrganizations.map((item) => renamed.get(item.id) ?? item.name).map((label) => ({ label, value: current.filter((employee) => employee.department === label).length }))
    .filter((item) => item.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  const applicants = applicantsResult.results; const applicantIds = new Set(applicants.map((item) => item.id));
  const offers = offersResult.results.filter((item) => applicantIds.has(item.applicant_id));
  const accepted = offers.filter((item) => item.status === "ACCEPTED"); const appliedById = new Map(applicants.map((item) => [item.id, normalizeDate(item.applied)]));
  const hiringDays = accepted.map((item) => ({ from: appliedById.get(item.applicant_id) ?? "", to: normalizeDate(item.start_date) }))
    .filter((item) => datePattern.test(item.from) && datePattern.test(item.to) && item.to >= item.from).map((item) => daysBetween(item.from, item.to));
  const interviewCount = applicants.filter((item) => Boolean(item.interview_json)).length;
  const passedCount = applicants.filter((item) => !["서류 검토", "서류 탈락"].includes(item.stage)).length;
  const recruitment = { total: applicants.length, accepted: accepted.length, conversionRate: applicants.length ? Math.round((accepted.length / applicants.length) * 1000) / 10 : 0,
    averageHiringDays: hiringDays.length ? Math.round(hiringDays.reduce((sum, value) => sum + value, 0) / hiringDays.length) : null,
    sources: countBy(applicants, (item) => item.source), funnel: [
      { label: "지원", value: applicants.length }, { label: "서류 합격 이후", value: passedCount }, { label: "면접 일정", value: interviewCount },
      { label: "채용 제안", value: new Set(offers.map((item) => item.applicant_id)).size }, { label: "입사 확정", value: accepted.length },
    ] };

  const payrollMonths = [...payrollResult.results.reduce<Map<string, { period: string; employees: number; grossPay: number; deductions: number; netPay: number }>>((map, row) => {
    const item = map.get(row.year_month) ?? { period: row.year_month, employees: 0, grossPay: 0, deductions: 0, netPay: 0 };
    item.employees += row.employee_count; item.grossPay += row.gross_pay; item.deductions += row.deductions; item.netPay += row.net_pay; map.set(row.year_month, item); return map;
  }, new Map()).values()];
  const payroll = canSensitive ? { available: payrollMonths.length > 0, months: payrollMonths,
    grossPay: payrollMonths.reduce((sum, item) => sum + item.grossPay, 0), deductions: payrollMonths.reduce((sum, item) => sum + item.deductions, 0), netPay: payrollMonths.reduce((sum, item) => sum + item.netPay, 0),
    departments: [...payrollResult.results.reduce<Map<string, number>>((map, row) => { const key = row.department || "미지정"; map.set(key, (map.get(key) ?? 0) + row.gross_pay); return map; }, new Map()).entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) } : null;

  const ratings = countBy(performanceResult.results, (item) => item.final_rating || "미지정");
  const scored = performanceResult.results.filter((item) => item.final_score !== null);
  const performance = canSensitive ? { finalized: performanceResult.results.length, averageScore: scored.length ? Math.round((scored.reduce((sum, item) => sum + Number(item.final_score), 0) / scored.length) * 10) / 10 : null, ratings } : null;

  const trainingRows = trainingResult.results; const trainingCompleted = trainingRows.filter((item) => ["COMPLETED", "WAIVED"].includes(item.assignment_status)).length;
  const trainingSubmitted = trainingRows.filter((item) => item.assignment_status === "SUBMITTED").length;
  const trainingCourses = [...trainingRows.reduce<Map<string, { id: string; title: string; type: string; dueDate: string; total: number; completed: number; submitted: number }>>((map, row) => {
    const item = map.get(row.course_id) ?? { id: row.course_id, title: row.title, type: row.course_type, dueDate: row.due_date, total: 0, completed: 0, submitted: 0 };
    item.total += 1; if (["COMPLETED", "WAIVED"].includes(row.assignment_status)) item.completed += 1; if (row.assignment_status === "SUBMITTED") item.submitted += 1; map.set(row.course_id, item); return map;
  }, new Map()).values()].map((item) => ({ ...item, completionRate: item.total ? Math.round((item.completed / item.total) * 100) : 0 }));
  const training = { total: trainingRows.length, completed: trainingCompleted, submitted: trainingSubmitted,
    incomplete: trainingRows.length - trainingCompleted - trainingSubmitted, completionRate: trainingRows.length ? Math.round((trainingCompleted / trainingRows.length) * 100) : 0, courses: trainingCourses };

  const quality = [
    { label: "입사일 누락", value: employees.filter((item) => !datePattern.test(item.joinDate)).length },
    { label: "퇴직일 누락", value: employees.filter((item) => item.status === "퇴직" && !datePattern.test(item.retirementDate)).length },
    { label: "소속 미지정", value: current.filter((item) => !item.department || item.department === "소속 미지정").length },
    { label: "급여 원장 없는 조회월", value: canSensitive ? Math.max(0, monthEnds(from, to).length - payrollMonths.length) : 0 },
  ];
  return { generatedAt: Date.now(), period: { from, to }, formulas: { turnoverRate: "기간 중 퇴직자 ÷ 기간 시작·종료 평균 재직자 × 100", averageHiringDays: "입사 확정자의 지원일~입사예정일 평균" },
    headcount: { atStart: start.length, atEnd: current.length, hires: hires.length, exits: exits.length, turnoverRate: averageHeadcount ? Math.round((exits.length / averageHeadcount) * 1000) / 10 : 0, trend: headcountTrend, organization },
    recruitment, payroll, performance, training, quality, sensitiveIncluded: canSensitive };
}

function csv(snapshot: Awaited<ReturnType<typeof buildSnapshot>>) {
  const rows: (string | number | null)[][] = [["XDnode management HR 집계 리포트"], ["기간", snapshot.period.from, snapshot.period.to], [], ["인원 지표", "값"],
    ["기간 시작 재직자", snapshot.headcount.atStart], ["기간 말 재직자", snapshot.headcount.atEnd], ["입사자", snapshot.headcount.hires], ["퇴직자", snapshot.headcount.exits], ["이직률(%)", snapshot.headcount.turnoverRate],
    [], ["월", "월말 재직자"], ...snapshot.headcount.trend.map((item) => [item.period, item.value]),
    [], ["조직", "기간 말 재직자"], ...snapshot.headcount.organization.map((item) => [item.label, item.value]),
    [], ["채용 지표", "값"], ["지원자", snapshot.recruitment.total], ["입사 확정", snapshot.recruitment.accepted], ["전환율(%)", snapshot.recruitment.conversionRate], ["평균 채용기간(일)", snapshot.recruitment.averageHiringDays],
    [], ["지원경로", "지원자"], ...snapshot.recruitment.sources.map((item) => [item.label, item.value]),
    [], ["교육 지표", "값"], ["대상", snapshot.training.total], ["수료·면제", snapshot.training.completed], ["증빙 검토 대기", snapshot.training.submitted], ["미이수", snapshot.training.incomplete], ["이수율(%)", snapshot.training.completionRate]];
  if (snapshot.payroll) rows.push([], ["급여월", "대상 인원", "지급총액", "공제총액", "실 지급액"], ...snapshot.payroll.months.map((item) => [item.period, item.employees, item.grossPay, item.deductions, item.netPay]));
  if (snapshot.performance) rows.push([], ["성과평가 지표", "값"], ["최종 확정 대상", snapshot.performance.finalized], ["평균 점수", snapshot.performance.averageScore], ...snapshot.performance.ratings.map((item) => [`등급 ${item.label}`, item.value]));
  rows.push([], ["데이터 품질", "건수"], ...snapshot.quality.map((item) => [item.label, item.value]));
  const escape = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\r\n")}`;
}

export async function GET(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "read"); if (authorization.response) return authorization.response;
  await ensureSchema(); const url = new URL(request.url); const from = url.searchParams.get("from") ?? "2026-01-01"; const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const error = validatePeriod(from, to); if (error) return Response.json({ error }, { status: 400 });
  const canSensitive = isHrManager(authorization.principal); const reportId = url.searchParams.get("reportId") ?? "";
  let snapshot: Awaited<ReturnType<typeof buildSnapshot>>;
  if (reportId) {
    if (!canSensitive) return Response.json({ error: "저장 리포트는 HR 관리자만 열 수 있습니다." }, { status: 403 });
    const report = await db.prepare("SELECT * FROM hr_analytics_reports WHERE id = ?").bind(reportId).first<ReportRow>();
    if (!report) return Response.json({ error: "저장 리포트를 찾을 수 없습니다." }, { status: 404 });
    snapshot = safeJson<Awaited<ReturnType<typeof buildSnapshot>> | null>(report.snapshot_json, null) ?? await buildSnapshot(from, to, true);
  } else snapshot = await buildSnapshot(from, to, canSensitive);
  if (url.searchParams.get("format") === "csv") return new Response(csv(snapshot), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="hr-analytics-${snapshot.period.from}-${snapshot.period.to}.csv"` } });
  const reports = canSensitive ? await db.prepare("SELECT * FROM hr_analytics_reports ORDER BY created_at DESC LIMIT 30").all<ReportRow>() : { results: [] as ReportRow[] };
  return Response.json({ principal: authorization.principal, canSensitive, snapshot, reports: reports.results.map((row) => ({ id: row.id, title: row.title, periodStart: row.period_start, periodEnd: row.period_end, version: row.version, generatedBy: row.generated_by, createdAt: row.created_at })) });
}

export async function POST(request: Request) {
  const authorization = await authorizeErpRequest(db, "hr", "write"); if (authorization.response) return authorization.response;
  await ensureSchema(); if (!isHrManager(authorization.principal)) return Response.json({ error: "HR 관리자만 리포트 스냅샷을 생성할 수 있습니다." }, { status: 403 });
  const body = await request.json() as Record<string, unknown>; const action = String(body.action ?? "").toUpperCase();
  if (action !== "GENERATE_REPORT") return Response.json({ error: "지원하지 않는 리포트 작업입니다." }, { status: 400 });
  const from = String(body.from ?? "").trim(); const to = String(body.to ?? "").trim(); const error = validatePeriod(from, to);
  if (error) return Response.json({ error }, { status: 400 });
  const snapshot = await buildSnapshot(from, to, true); const id = crypto.randomUUID(); const now = Date.now(); const title = `${from}~${to} HR 통합 리포트`;
  const inserted = await db.prepare(`INSERT INTO hr_analytics_reports
    (id, report_type, title, period_start, period_end, version, snapshot_json, generated_by, created_at)
    SELECT ?, 'HR_OVERVIEW', ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM hr_analytics_reports
    WHERE report_type = 'HR_OVERVIEW' AND period_start = ? AND period_end = ? RETURNING version`)
    .bind(id, title, from, to, JSON.stringify(snapshot), authorization.principal.employeeId, now, from, to).all<{ version: number }>();
  const version = inserted.results[0]?.version ?? 1;
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "HR_ANALYTICS_REPORT_GENERATED", entityType: "hrAnalyticsReport", entityId: id, after: { title, from, to, version, generatedAt: snapshot.generatedAt } });
  return Response.json({ created: true, id, version }, { status: 201 });
}
