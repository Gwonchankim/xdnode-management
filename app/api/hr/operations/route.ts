import { env } from "cloudflare:workers";
import { calculateCompensation, type CompensationEmployee } from "../../../compensation-calculation";
import { normalizeCompensationSettings } from "../../../compensation-settings";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { isHrManager } from "../../../access-tabs";
import { gaTablesExist } from "../../../ga-schema";
import { unlinkedAccountNames } from "../../../auth-session";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { companyEmployees } from "../../../hr-company-data";
import { applyDueOnboarding } from "../../../hr-onboarding";
import { applyDuePersonnelActions } from "../../../hr-personnel-actions";
import { applyDueRetirements } from "../../../hr-retirements";
import {
  changedRows, decidePersonnelActionStatements, decideRetirementStatements, hrConflictResponse,
  insertApprovedLeaveRequest, insertApprovedPersonnelAction, startRetirementStatements, type LegacyDecision,
} from "../../../hr-transitions";
import { averageWageMonths, calculateLeaveAllowance, calculateSeverance, normalizeDate } from "../../../hr-severance-calculation";
import { computeLeaveLedger, type GrantAdjustment, type LeaveKind } from "../../../hr-leave-accrual";
import { monthlyOrdinaryWageOn } from "../../../hr-ordinary-wage";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

async function ensureSchema() {
  // hr_employee_records 는 app/hr-employee-schema.ts 한 곳에서 정의한다. 다른 표보다 먼저 보장한다.
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_runs (
      period TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', employee_count INTEGER NOT NULL DEFAULT 0,
      gross_pay INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0, net_pay INTEGER NOT NULL DEFAULT 0,
      prepared_by TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '',
      locked_at INTEGER, reopened_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_leave_requests (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, leave_type TEXT NOT NULL, start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, units INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING',
      approver_employee_id TEXT NOT NULL DEFAULT '', decided_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_attendance_records (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, work_date TEXT NOT NULL,
      work_type TEXT NOT NULL DEFAULT 'OFFICE', check_in TEXT NOT NULL DEFAULT '', check_out TEXT NOT NULL DEFAULT '',
      minutes_worked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'RECORDED',
      source_type TEXT NOT NULL DEFAULT 'MANUAL', memo TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_personnel_actions (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, action_type TEXT NOT NULL, effective_date TEXT NOT NULL,
      order_number TEXT NOT NULL DEFAULT '', before_json TEXT NOT NULL DEFAULT '{}', after_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'DRAFT', approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_lifecycle_tasks (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, lifecycle_type TEXT NOT NULL, task_group TEXT NOT NULL,
      title TEXT NOT NULL, owner_employee_id TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN', completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_retirement_requests (
      id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, retirement_date TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'SUBMITTED', checklist_json TEXT NOT NULL DEFAULT '[]',
      total_tasks INTEGER NOT NULL DEFAULT 0, completed_tasks INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_retirement_settlements (
      request_id TEXT PRIMARY KEY NOT NULL, final_salary INTEGER NOT NULL DEFAULT 0,
      retirement_pay INTEGER NOT NULL DEFAULT 0, unused_leave_pay INTEGER NOT NULL DEFAULT 0,
      deductions INTEGER NOT NULL DEFAULT 0, net_settlement INTEGER NOT NULL DEFAULT 0,
      payroll_confirmed INTEGER NOT NULL DEFAULT 0, insurance_confirmed INTEGER NOT NULL DEFAULT 0,
      access_revoked INTEGER NOT NULL DEFAULT 0, assets_returned INTEGER NOT NULL DEFAULT 0,
      handover_confirmed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT',
      prepared_by TEXT NOT NULL DEFAULT '', completed_by TEXT NOT NULL DEFAULT '', completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_personnel_employee_effective ON hr_personnel_actions(employee_id, effective_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_attendance_employee_date ON hr_attendance_records(employee_id, work_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_attendance_status_date ON hr_attendance_records(status, work_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_lifecycle_employee_type ON hr_lifecycle_tasks(employee_id, lifecycle_type)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_lifecycle_status_due ON hr_lifecycle_tasks(status, due_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_retirement_employee_date ON hr_retirement_requests(employee_id, retirement_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_retirement_status_date ON hr_retirement_requests(status, retirement_date)"),
  ]);
  // 연차수당의 근거가 되는 일수를 값으로 남기려고 뒤늦게 붙인 컬럼. 마이너스 연차를 담아야 해서 REAL.
  const settlementColumns = await db.prepare("PRAGMA table_info(hr_retirement_settlements)").all<{ name: string }>();
  if (!settlementColumns.results.some((column) => column.name === "leave_days")) {
    await db.prepare("ALTER TABLE hr_retirement_settlements ADD COLUMN leave_days REAL NOT NULL DEFAULT 0").run();
  }
  // 연차관리(app/api/hr/leave)가 더한 열과 조정 표. 이 라우트가 먼저 뜰 수도 있어 같은 보강을 둔다.
  const leaveColumns = await db.prepare("PRAGMA table_info(hr_leave_requests)").all<{ name: string }>();
  const leaveNames = new Set(leaveColumns.results.map((column) => column.name));
  if (!leaveNames.has("deducts")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN deducts INTEGER NOT NULL DEFAULT 1").run();
  if (!leaveNames.has("source")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'ERP'").run();
  if (!leaveNames.has("recorded_by")) await db.prepare("ALTER TABLE hr_leave_requests ADD COLUMN recorded_by TEXT NOT NULL DEFAULT ''").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS hr_leave_grant_adjustments (id TEXT PRIMARY KEY NOT NULL, employee_id TEXT NOT NULL, grant_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', units REAL, note TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, UNIQUE (employee_id, grant_key))").run();
}

type SeveranceContext = {
  employeeId: string; employeeName: string; retirementDate: string; period: string; joinDate: string;
  monthlyOrdinaryWage: number; usedLeaveUnits: number;
  /** 퇴직일 기준 연차관리 잔여(음수면 선사용). 미사용 연차수당의 자동 계산 근거다. */
  unusedLeaveDays: number;
};
const LEAVE_TYPE_KIND: Record<string, LeaveKind> = { ANNUAL: "ANNUAL", HALF: "HALF", HALF_AM: "HALF", HALF_PM: "HALF", QUARTER: "QUARTER", BIRTHDAY_HALF: "BIRTHDAY_HALF", OFFICIAL: "OFFICIAL", SICK: "SICK", FAMILY: "FAMILY", OTHER: "OTHER" };

// hr_payroll_records 의 employee_id 는 출처에 따라 값이 다르다. 가져온 인건비 자료는 HR 사번(lhy0220)을
// 쓰지만, ERP 임금계산이 확정하며 만든 행은 임금안 라인의 UUID 를 넣는다. 사번만으로 찾으면 임금계산에서
// 만들어진 행을 통째로 놓치므로 이름도 함께 본다. 같은 달에 두 출처가 겹치면 사번이 맞는 쪽을 쓴다.
const PAYROLL_MATCH = "(employee_id = ? OR employee_name = ?)";

/** 퇴직금 산정에 필요한 사람·급여 정보를 모은다. 정산 저장과 화면 미리보기가 같은 값을 쓰도록 한 곳에 둔다. */
async function severanceContextFor(employeeId: string, retirementDate: string): Promise<SeveranceContext> {
  const employee = await db.prepare(`SELECT name, join_date, annual_salary, base_pay, meal_allowance,
    childcare_allowance, vehicle_allowance, first_term_pay_percent, regular_contract_date FROM hr_employee_records WHERE employee_id = ?`)
    .bind(employeeId).first<{ name: string; join_date: string; annual_salary: number; base_pay: number;
      meal_allowance: number; childcare_allowance: number; vehicle_allowance: number; first_term_pay_percent: number | null; regular_contract_date: string | null }>();
  const monthlyOrdinaryWage = monthlyOrdinaryWageOn(employee ? {
    joinDate: employee.join_date, annualSalary: employee.annual_salary, basePay: employee.base_pay,
    mealAllowance: employee.meal_allowance, childcareAllowance: employee.childcare_allowance,
    vehicleAllowance: employee.vehicle_allowance, firstTermPayPercent: employee.first_term_pay_percent,
    regularContractDate: employee.regular_contract_date,
  } : null, retirementDate);
  // 미사용 연차는 연차관리와 같은 엔진으로 퇴직일 기준 잔여를 낸다(발생·소멸·차감 제외 종류까지 같은 규칙).
  const requests = await db.prepare("SELECT id, leave_type, start_date, units, deducts FROM hr_leave_requests WHERE employee_id = ? AND status = 'APPROVED'")
    .bind(employeeId).all<{ id: string; leave_type: string; start_date: string; units: number; deducts: number }>();
  const adjustmentRows = await db.prepare("SELECT grant_key, status, units, note FROM hr_leave_grant_adjustments WHERE employee_id = ?")
    .bind(employeeId).all<{ grant_key: string; status: string; units: number | null; note: string }>();
  const ledger = computeLeaveLedger({
    employeeId, joinDate: employee?.join_date ?? "", exitDate: retirementDate, today: retirementDate,
    usages: requests.results.map((row) => ({ id: row.id, date: row.start_date, kind: LEAVE_TYPE_KIND[row.leave_type] ?? "OTHER", units: row.units / 100, deducts: Boolean(row.deducts) })),
    adjustments: adjustmentRows.results.map((row): GrantAdjustment => ({ grantKey: row.grant_key, note: row.note, ...(row.status === "EXCLUDED" ? { status: "EXCLUDED" as const } : {}), ...(row.units === null ? {} : { units: row.units }) })),
  });
  return {
    employeeId, employeeName: employee?.name ?? "", retirementDate, period: retirementDate.slice(0, 7),
    joinDate: employee?.join_date ?? "", monthlyOrdinaryWage, usedLeaveUnits: ledger.used, unusedLeaveDays: ledger.balance,
  };
}

/**
 * 산정기간 중 급여가 아직 확정되지 않은 달을 골라낸다. 셋 중 하나면 확정으로 본다.
 *   1) 임금안(hr_compensation_runs)이 CONFIRMED
 *   2) 급여월(hr_payroll_runs)이 LOCKED
 *   3) 그 달이 이미 지났고 급여기록(hr_payroll_records)이 있음 — 실제 지급이 끝난 대장 자료다
 *
 * 3) 이 없으면 마감 버튼을 누르지 않은 지난 달까지 전부 "미확정"이 되어 경고가 무의미해진다.
 * 반대로 아직 끝나지 않은 달(8/31 퇴사자의 8월)은 인센티브가 안 정해졌으므로 미확정으로 남는다.
 */
async function unconfirmedMonthsAmong(months: string[], now = Date.now()) {
  if (!months.length) return [];
  const marks = months.map(() => "?").join(",");
  const [compensation, payroll, records] = await Promise.all([
    db.prepare(`SELECT period, status FROM hr_compensation_runs WHERE period IN (${marks})`)
      .bind(...months).all<{ period: string; status: string }>(),
    db.prepare(`SELECT period, status FROM hr_payroll_runs WHERE period IN (${marks})`)
      .bind(...months).all<{ period: string; status: string }>(),
    db.prepare(`SELECT year_month, COUNT(*) AS count FROM hr_payroll_records
      WHERE year_month IN (${marks}) GROUP BY year_month`)
      .bind(...months).all<{ year_month: string; count: number }>(),
  ]);
  const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hasRecords = new Set(records.results.filter((row) => row.count > 0).map((row) => row.year_month));
  const confirmed = new Set<string>();
  for (const row of compensation.results) if (row.status === "CONFIRMED") confirmed.add(row.period);
  for (const row of payroll.results) if (row.status === "LOCKED") confirmed.add(row.period);
  for (const month of months) {
    const [year, index] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
    if (lastDay < koreaDate && hasRecords.has(month)) confirmed.add(month);
  }
  return months.filter((month) => !confirmed.has(month));
}

async function severanceEstimateFor(context: SeveranceContext) {
  const months = averageWageMonths(context.retirementDate);
  // 평균임금의 분자는 "근로의 대가"만이다. 퇴직금과 퇴직 정산 연차수당은 지급총액에 같이 적혀
  // 있지만 여기서 빼야 한다.
  //   퇴직금: 근로의 대가가 아니다. 넣으면 퇴직금이 평균임금을 올리고 그 평균임금이 다시 퇴직금을
  //           키우는 순환이 생긴다 (실제로 이호영은 이 때문에 1,370,761원 과다 계상됐다).
  //   퇴직 연차수당: 퇴직으로 비로소 발생한 미사용 연차 정산이라 평균임금에 넣지 않는다.
  //           퇴직월에만 빼고, 평월의 연차수당은 3/12 산입 규칙을 세울 자료가 없어 그대로 둔다.
  const retirementMonth = normalizeDate(context.retirementDate).slice(0, 7);
  const matched = months.length
    ? (await db.prepare(`SELECT year_month AS yearMonth, employee_id AS employeeId,
          gross_pay - retirement_pay - (CASE WHEN year_month = ? THEN annual_leave_pay ELSE 0 END) AS grossPay
        FROM hr_payroll_records
        WHERE ${PAYROLL_MATCH} AND year_month IN (${months.map(() => "?").join(",")})`)
        .bind(retirementMonth, context.employeeId, context.employeeName, ...months)
        .all<{ yearMonth: string; grossPay: number; employeeId: string }>()).results
    : [];
  // 한 달에 한 행만 남긴다. 두 출처가 겹칠 때 둘 다 더하면 평균임금이 배로 부풀어 오른다.
  const byMonth = new Map<string, { yearMonth: string; grossPay: number }>();
  for (const row of matched) {
    const kept = byMonth.get(row.yearMonth);
    const isExactId = row.employeeId === context.employeeId;
    if (!kept || isExactId) byMonth.set(row.yearMonth, { yearMonth: row.yearMonth, grossPay: row.grossPay });
  }
  const recentWages = [...byMonth.values()];
  const unconfirmedMonths = await unconfirmedMonthsAmong(months);
  return calculateSeverance({
    joinDate: context.joinDate, retirementDate: context.retirementDate,
    recentWages, monthlyOrdinaryWage: context.monthlyOrdinaryWage, unconfirmedMonths,
  });
}

export async function GET(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  // 퇴직 정산의 미반납 지급 자산(general-affairs GD-11). HR 편집 권한자만 본다. 총무 표가 없으면(새 DB) 빈 목록이고 표를 만들지 않는다.
  const retirementAssetsOf = new URL(request.url).searchParams.get("retirementAssets");
  if (retirementAssetsOf !== null) {
    if (!isHrManager(authorization.principal)) return Response.json({ error: "인사 편집 권한이 필요합니다.", code: "FORBIDDEN" }, { status: 403 });
    if (!(await gaTablesExist(db))) return Response.json({ assets: [] });
    const rows = await db.prepare(`SELECT a.id, a.asset_no, a.name, a.kind, a.status,
        (SELECT MAX(e.event_on) FROM ga_asset_events e WHERE e.asset_id = a.id AND e.kind = 'ASSIGNED') AS assigned_on
      FROM ga_assets a WHERE a.holder_employee_id = ? AND a.deleted_at IS NULL AND a.status IN ('ASSIGNED', 'REPAIR') ORDER BY a.asset_no`)
      .bind(retirementAssetsOf.trim()).all<{ id: string; asset_no: string; name: string; kind: string; status: string; assigned_on: string | null }>();
    return Response.json({ assets: rows.results.map((row) => ({ id: row.id, assetNo: row.asset_no, name: row.name, kind: row.kind, status: row.status, assignedOn: row.assigned_on })) });
  }
  await applyDueRetirements(db);
  const employeeId = new URL(request.url).searchParams.get("employeeId")?.trim() ?? "";
  const where = employeeId ? " WHERE employee_id = ?" : "";
  const bind = <T,>(sql: string) => employeeId ? db.prepare(sql + where).bind(employeeId).all<T>() : db.prepare(sql).all<T>();
  const [actions, lifecycle, leaves, attendance, payrollRuns, retirements, settlements] = await Promise.all([
    bind<Record<string, unknown>>("SELECT * FROM hr_personnel_actions"),
    bind<Record<string, unknown>>("SELECT * FROM hr_lifecycle_tasks"),
    bind<Record<string, unknown>>("SELECT * FROM hr_leave_requests"),
    bind<Record<string, unknown>>("SELECT * FROM hr_attendance_records"),
    db.prepare("SELECT * FROM hr_payroll_runs ORDER BY period DESC").all<Record<string, unknown>>(),
    bind<Record<string, unknown>>("SELECT * FROM hr_retirement_requests"),
    employeeId
      ? db.prepare(`SELECT settlement.* FROM hr_retirement_settlements settlement
          INNER JOIN hr_retirement_requests request ON request.id = settlement.request_id WHERE request.employee_id = ?`)
        .bind(employeeId).all<Record<string, unknown>>()
      : db.prepare("SELECT * FROM hr_retirement_settlements").all<Record<string, unknown>>(),
  ]);
  // 정산 화면이 퇴직금을 손으로 계산하지 않도록 법정 산식 결과를 함께 내려준다. 퇴직 건마다 조회가
  // 네 번씩 붙어서, 이 값이 필요한 정산 화면이 명시적으로 요청할 때만 계산한다 — HR 첫 화면 로딩도
  // 같은 엔드포인트를 쓰기 때문에 무조건 계산하면 진입 속도가 그만큼 느려진다.
  const wantsSeverance = new URL(request.url).searchParams.get("severance") === "1";
  const severanceEstimates = !wantsSeverance ? [] : await Promise.all(retirements.results
    .filter((row) => ["IN_PROGRESS", "READY", "EFFECTIVE"].includes(String(row.status ?? "")))
    .map(async (row) => {
      const context = await severanceContextFor(String(row.employee_id ?? ""), String(row.retirement_date ?? ""));
      const estimate = await severanceEstimateFor(context);
      const payrollMonth = await db.prepare("SELECT period, status FROM hr_compensation_runs WHERE period = ?")
        .bind(context.period).first<{ period: string; status: string }>();
      // 급여자료에 사람이 직접 적어 둔 퇴직금·연차수당. 계산 추정치와 성격이 달라 덮어쓰기 전에
      // 확인을 받아야 하므로, 있는 그대로 함께 내려보내 화면이 나란히 보여줄 수 있게 한다.
      const recorded = await db.prepare(`SELECT COALESCE(MAX(retirement_pay), 0) AS retirement_pay,
          COALESCE(MAX(annual_leave_pay), 0) AS annual_leave_pay FROM hr_payroll_records
        WHERE year_month = ? AND ${PAYROLL_MATCH}`)
        .bind(context.period, context.employeeId, context.employeeName)
        .first<{ retirement_pay: number; annual_leave_pay: number }>();
      return {
        requestId: String(row.id ?? ""), period: context.period, joinDate: context.joinDate,
        monthlyOrdinaryWage: context.monthlyOrdinaryWage, usedLeaveUnits: context.usedLeaveUnits, unusedLeaveDays: context.unusedLeaveDays,
        recordedSeverance: Number(recorded?.retirement_pay ?? 0),
        recordedLeavePay: Number(recorded?.annual_leave_pay ?? 0),
        leaveDailyWage: calculateLeaveAllowance(1, context.monthlyOrdinaryWage, String(row.retirement_date ?? "")).dailyWage,
        payrollMonthReady: Boolean(payrollMonth), payrollMonthStatus: payrollMonth?.status ?? "",
        ...estimate,
      };
    }));
  return Response.json({ personnelActions: actions.results, lifecycleTasks: lifecycle.results, leaveRequests: leaves.results, attendanceRecords: attendance.results, payrollRuns: payrollRuns.results, retirementRequests: retirements.results, retirementSettlements: settlements.results, severanceEstimates ,
    // HR 첫 화면이 이 응답을 같이 쓰므로 호출자의 권한도 여기서 알려 준다(R3: 역할 대신 hr 탭 수준과 관리자 여부).
    principal: { employeeId: authorization.principal.employeeId },
    access: { hr: authorization.principal.tabs.hr, isAdmin: authorization.principal.isAdmin },
    // 인사기록과 연결되지 않은 계정(acct_…)이 처리자로 남은 행의 이름 표시용. 비활성 계정 포함, email 은 없다(부록 B #25).
    accountNames: await unlinkedAccountNames(db) });
}

export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as Record<string, unknown>;
  const resource = String(body.resource ?? "");
  const id = crypto.randomUUID();
  const now = Date.now();

  if (resource === "personnelAction") {
    const employeeId = String(body.employeeId ?? "").trim();
    const actionType = String(body.actionType ?? "").trim();
    const effectiveDate = String(body.effectiveDate ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!employeeId || !["인사이동(전보)", "승진", "강등"].includes(actionType) || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || (actionType === "강등" && !reason)) {
      return Response.json({ error: "발령 대상·구분·시행일을 확인하고 강등 시 정당한 사유를 입력해 주세요." }, { status: 400 });
    }
    const beforeState = { department: String(body.fromDepartment ?? ""), position: String(body.fromPosition ?? "") };
    const afterState = { department: String(body.toDepartment ?? ""), position: String(body.toPosition ?? "") };
    if (!afterState.department || !afterState.position) return Response.json({ error: "발령 후 소속 조직과 직위을 확인해 주세요." }, { status: 400 });
    // 편집 권한자가 등록하면 곧바로 승인된 발령이 된다(결재 없음, Design §12.2 흐름 1).
    // 시행일이 된 발령을 인사기록에 적용하는 것은 applyDuePersonnelActions 한 곳이다.
    await db.batch(insertApprovedPersonnelAction(db, {
      id, employeeId, actionType, effectiveDate, orderNumber: String(body.orderNumber ?? ""), beforeState, afterState, reason,
      actorEmployeeId: authorization.principal.employeeId, now,
    }));
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PERSONNEL_ACTION_APPROVED", entityType: "personnelAction", entityId: id,
      after: { id, employeeId, actionType, effectiveDate, fromDepartment: body.fromDepartment, toDepartment: body.toDepartment, fromPosition: body.fromPosition, toPosition: body.toPosition, reason, status: "APPROVED" } });
    await applyDuePersonnelActions(db, now);
    const created = await db.prepare("SELECT status FROM hr_personnel_actions WHERE id = ?").bind(id).first<{ status: string }>();
    const after = { id, employeeId, actionType, effectiveDate, fromDepartment: body.fromDepartment, toDepartment: body.toDepartment, fromPosition: body.fromPosition, toPosition: body.toPosition, reason, status: created?.status ?? "APPROVED" };
    return Response.json({ item: after }, { status: 201 });
  }

  if (resource === "retirement") {
    const employeeId = String(body.employeeId ?? "").trim();
    const eventDate = String(body.eventDate ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !reason || !tasks.length) return Response.json({ error: "퇴직 대상·퇴직일·사유·체크리스트가 필요합니다." }, { status: 400 });
    const employee = companyEmployees.find((item) => item.id === employeeId);
    const persistedEmployee = await db.prepare(`SELECT name, department, position, history_json
      FROM hr_employee_records WHERE employee_id = ?`).bind(employeeId)
      .first<{ name: string; department: string; position: string; history_json: string }>();
    if (!employee && !persistedEmployee) return Response.json({ error: "회사 인사기록에 등록된 직원만 퇴직 절차를 시작할 수 있습니다." }, { status: 404 });
    const activeRequest = await db.prepare(`SELECT id FROM hr_retirement_requests WHERE employee_id = ?
      AND status IN ('SUBMITTED', 'IN_PROGRESS', 'READY') ORDER BY created_at DESC LIMIT 1`).bind(employeeId).first<{ id: string }>();
    if (activeRequest) return Response.json({ error: "이미 진행 중인 퇴직 요청이 있습니다." }, { status: 409 });
    const completedTaskIds = tasks.filter((task) => Boolean((task as Record<string, unknown>).completed))
      .map((task) => String((task as Record<string, unknown>).id ?? "")).filter(Boolean);
    const statements = tasks.map((task) => {
      const item = task as Record<string, unknown>;
      const taskId = `${id}:${String(item.id ?? crypto.randomUUID())}`;
      const completed = Boolean(item.completed);
      return db.prepare(`INSERT INTO hr_lifecycle_tasks
        (id, employee_id, lifecycle_type, task_group, title, owner_employee_id, due_date, status, completed_at, created_at, updated_at)
        VALUES (?, ?, 'RETIREMENT', ?, ?, '', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at, updated_at = excluded.updated_at`)
        .bind(taskId, employeeId, String(item.ownerType ?? "HR"), String(item.title ?? ""), eventDate,
          completed ? "DONE" : "OPEN", completed ? now : null, now, now);
    });
    // 결재 없이 곧바로 IN_PROGRESS 로 등록하고, 같은 batch 에서 정산 초안과 인사기록의 '퇴직 예정'
    // 상태를 반영한다(Design §12.2 흐름 2). 인사기록 INSERT OR IGNORE 가 이 문장들보다 앞에 온다.
    statements.unshift(...startRetirementStatements(db, {
      id, employeeId, retirementDate: eventDate, reason, completedTaskIds, totalTasks: tasks.length,
      actorEmployeeId: authorization.principal.employeeId, now,
    }));
    if (employee) {
      statements.unshift(db.prepare(`INSERT OR IGNORE INTO hr_employee_records
        (employee_id, name, birth, email, phone, address, department, manager, employment_type, join_date,
          position, job_title, status, history_json, retirement_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .bind(employee.id, employee.name, employee.birth, employee.email, employee.phone, employee.address,
          employee.department, employee.manager, employee.type, employee.joinDate, employee.position,
          employee.jobTitle, employee.status, JSON.stringify(employee.history), now));
    }
    // 인사기록카드의 인사이력에 남긴다. 이 시점은 아직 퇴직 전이라 "퇴직 예정"으로 적고
    // 날짜에 예정일을 넣는다. 퇴직일이 실제로 지나면 hr-retirements.ts 의 applyDueRetirements 가
    // "퇴직" 항목을 따로 넣으므로, 여기서도 "퇴직"으로 적으면 같은 항목이 두 번 남는다.
    // 아래 INSERT OR IGNORE 다음에 실행되어야 해서 push 로 붙인다.
    const retirementHistory = {
      date: eventDate.replaceAll("-", "."),
      type: "퇴직 예정",
      detail: `${persistedEmployee?.department || employee?.department || "소속 미상"} ${persistedEmployee?.position || employee?.position || ""} 퇴직 예정 · ${reason}`.replace(/\s+/g, " ").trim(),
    };
    const currentHistory = persistedEmployee
      ? ((() => { try { const parsed = JSON.parse(persistedEmployee.history_json || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() as Array<{ date?: string; type?: string; detail?: string }>)
      : (employee?.history ?? []);
    const alreadyRecorded = currentHistory.some((item) => item.type === retirementHistory.type && item.date === retirementHistory.date);
    if (!alreadyRecorded) {
      statements.push(db.prepare("UPDATE hr_employee_records SET history_json = ?, updated_at = ? WHERE employee_id = ?")
        .bind(JSON.stringify([...currentHistory, retirementHistory]), now, employeeId));
    }

    await db.batch(statements);
    await applyDueRetirements(db, now);
    const created = await db.prepare("SELECT status FROM hr_retirement_requests WHERE id = ?").bind(id).first<{ status: string }>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "RETIREMENT_APPROVED", entityType: "employeeRetirement", entityId: id, after: { employeeId, employeeName: employee?.name ?? persistedEmployee?.name ?? employeeId, eventDate, reason, completedTaskIds, status: created?.status ?? "IN_PROGRESS" } });
    return Response.json({ item: { id, employeeId, eventDate, taskCount: tasks.length, completedTaskIds, status: created?.status ?? "IN_PROGRESS" } }, { status: 201 });
  }

  // 산정한 퇴직금을 퇴사월 임금안에 넣는다. 자동이 아니라 사람이 화면에서 눌렀을 때만 실행되고,
  // 임금안 초안까지만 쓴다. 급여기록(hr_payroll_records)은 임금계산에서 확정할 때 다시 만들어지므로
  // 여기서는 건드리지 않는다 — 확정 전에 사람이 값을 한 번 더 보게 하려는 것이다.

  if (resource === "leaveRequest") {
    const employeeId = String(body.employeeId ?? "").trim();
    const leaveType = String(body.leaveType ?? "").trim();
    const startDate = String(body.startDate ?? "").trim();
    const endDate = String(body.endDate ?? "").trim();
    const units = Number(body.units);
    const reason = String(body.reason ?? "").trim();
    if (!employeeId || !["ANNUAL", "HALF_AM", "HALF_PM", "SICK", "FAMILY", "OTHER"].includes(leaveType)
      || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      || startDate > endDate || !Number.isInteger(units) || units <= 0) {
      return Response.json({ error: "휴가 대상·종류·기간·사용일수를 확인해 주세요." }, { status: 400 });
    }
    // 연차관리(app/hr-leave-accrual.ts LEAVE_KINDS)와 같은 규칙: 연차·반차만 잔여에서 차감하고 병가·가족돌봄·기타는 기록만 한다.
    const deducts = ["ANNUAL", "HALF_AM", "HALF_PM"].includes(leaveType) ? 1 : 0;
    // 결재 없이 승인된 신청으로 등록한다. 결정자는 등록한 편집 권한자다(Design §12.2 흐름 3).
    await db.batch(insertApprovedLeaveRequest(db, {
      id, employeeId, leaveType, startDate, endDate, units, reason, deducts,
      actorEmployeeId: authorization.principal.employeeId, now,
    }));
    const after = { id, employeeId, leaveType, startDate, endDate, units, reason, status: "APPROVED", approverEmployeeId: authorization.principal.employeeId };
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "LEAVE_REQUEST_APPROVED", entityType: "leaveRequest", entityId: id, after });
    return Response.json({ item: after }, { status: 201 });
  }

  if (resource === "attendance") {
    const employeeId = String(body.employeeId ?? "").trim();
    const workDate = String(body.workDate ?? "").trim();
    const workType = String(body.workType ?? "OFFICE");
    const checkIn = String(body.checkIn ?? "");
    const checkOut = String(body.checkOut ?? "");
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !["OFFICE", "REMOTE", "FIELD", "TRIP", "OFF"].includes(workType)
      || (checkIn && !/^\d{2}:\d{2}$/.test(checkIn)) || (checkOut && !/^\d{2}:\d{2}$/.test(checkOut))) {
      return Response.json({ error: "근무 대상·일자·유형·시간을 확인해 주세요." }, { status: 400 });
    }
    let minutesWorked = 0;
    if (checkIn && checkOut) {
      const [inHour, inMinute] = checkIn.split(":").map(Number);
      const [outHour, outMinute] = checkOut.split(":").map(Number);
      minutesWorked = Math.max(0, outHour * 60 + outMinute - inHour * 60 - inMinute);
    }
    await db.prepare(`INSERT INTO hr_attendance_records
      (id, employee_id, work_date, work_type, check_in, check_out, minutes_worked, status,
        source_type, memo, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'RECORDED', 'MANUAL', ?, '', ?, ?)`)
      .bind(id, employeeId, workDate, workType, checkIn, checkOut, minutesWorked, String(body.memo ?? "").trim(), now, now).run();
    const after = { id, employeeId, workDate, workType, checkIn, checkOut, minutesWorked, status: "RECORDED", sourceType: "MANUAL", memo: String(body.memo ?? "").trim() };
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "ATTENDANCE_RECORDED", entityType: "attendance", entityId: id, after });
    return Response.json({ item: after }, { status: 201 });
  }

  return Response.json({ error: "지원하지 않는 HR 운영 항목입니다." }, { status: 400 });
}

export async function PUT(request: Request) {
  // R3(D13, 부록 B #27): 결정·정산·임금안 반영 같은 상태 변경도 hr 편집이다. 리소스별 write/approve 분기 없이 본문보다 먼저 인가한다.
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  const resource = String(body.resource ?? "");
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "수정할 항목 ID가 필요합니다." }, { status: 400 });
  const now = Date.now();

  if (resource === "severanceToPayroll") {
    const request = await db.prepare("SELECT * FROM hr_retirement_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!request) return Response.json({ error: "퇴직 요청을 찾을 수 없습니다." }, { status: 404 });
    const amount = Math.round(Number(body.amount ?? 0));
    if (!Number.isFinite(amount) || amount < 0) return Response.json({ error: "반영할 퇴직금은 0원 이상이어야 합니다." }, { status: 400 });

    const employeeId = String(request.employee_id ?? "");
    const retirementDate = String(request.retirement_date ?? "");
    const context = await severanceContextFor(employeeId, retirementDate);
    const period = context.period;
    if (!/^\d{4}-\d{2}$/.test(period)) return Response.json({ error: "퇴사일이 없어 반영할 급여월을 알 수 없습니다." }, { status: 409 });

    const run = await db.prepare("SELECT status, version, settings_json FROM hr_compensation_runs WHERE period = ?")
      .bind(period).first<{ status: string; version: number; settings_json: string }>();
    if (!run) return Response.json({ error: "급여 월이 비어 있습니다. 해당 급여월은 만들어 주세요", payrollMonthMissing: true }, { status: 409 });
    if (run.status !== "DRAFT") {
      return Response.json({ error: `${period} 임금안이 확정 상태입니다. 임금계산에서 수정하기를 누른 뒤 다시 시도해 주세요.` }, { status: 409 });
    }

    // 임금안 라인의 employee_id 는 HR 사번이 아니라 임금안 자체의 식별자다. 사번으로 못 찾으면
    // 스냅샷에 담긴 이름으로 찾는다 (급여기록에서 겪은 것과 같은 식별자 불일치).
    const lines = await db.prepare("SELECT employee_id, snapshot_json, gross_pay FROM hr_compensation_lines WHERE period = ?")
      .bind(period).all<{ employee_id: string; snapshot_json: string; gross_pay: number }>();
    const target = lines.results.find((line) => line.employee_id === employeeId)
      ?? lines.results.find((line) => {
        try { return String((JSON.parse(line.snapshot_json) as { name?: string }).name ?? "") === context.employeeName; }
        catch { return false; }
      });
    if (!target) return Response.json({ error: `${period} 임금안에 이 직원의 행이 없습니다. 임금계산에서 대상자를 불러온 뒤 다시 시도해 주세요.` }, { status: 409 });

    let snapshot: Record<string, unknown>;
    try { snapshot = JSON.parse(target.snapshot_json) as Record<string, unknown>; }
    catch { return Response.json({ error: "임금안 자료를 읽지 못해 반영하지 못했습니다." }, { status: 409 }); }
    const monthly = (snapshot.monthly ?? {}) as Record<string, Record<string, unknown>>;
    const previous = Number(monthly[period]?.severance ?? 0);
    // 퇴직금과 함께 공제(예: 마이너스 연월차)도 넘어오면 같은 줄에 적는다. 값이 오지 않으면
    // 기존 공제는 건드리지 않는다.
    const deduction = Number(body.deduction ?? Number.NaN);
    const deductionNote = String(body.deductionNote ?? "").trim();
    // 남은 연차를 돈으로 정산하면 공제가 아니라 지급이라 임금안의 연차수당 칸에 들어간다.
    const annualLeave = Number(body.annualLeave ?? Number.NaN);
    const nextMonthly: Record<string, unknown> = { ...(monthly[period] ?? {}), severance: amount };
    if (Number.isFinite(annualLeave) && annualLeave >= 0) nextMonthly.annualLeave = Math.round(annualLeave);
    if (Number.isFinite(deduction) && deduction >= 0) {
      nextMonthly.deduction = Math.round(deduction);
      nextMonthly.deductionNote = deductionNote;
    }
    monthly[period] = nextMonthly;
    snapshot.monthly = monthly;
    // 퇴사일 열도 같이 채운다. 비어 있으면 임금계산이 그 달을 만근으로 잡아 기본급이 과다 계상된다.
    // 예정일이라도 적혀 있어야 근무일수가 퇴직일까지로 잘려 일할 계산된다.
    const previousLeaveDate = String(snapshot.leaveDate ?? "");
    if (retirementDate) snapshot.leaveDate = retirementDate;
    // 임금안 버전을 함께 올린다. 그래야 열려 있는 임금계산 화면의 자동 저장이 409 를 받고, 여기서 넣은 퇴직금·연차수당·퇴사일을
    // 옛 스냅샷으로 덮어쓰지 못한다. 상태 검사와 저장 사이에 확정됐으면 한 행도 바뀌지 않아 409 로 돌려보낸다.
    let rawSettings: unknown;
    try { rawSettings = JSON.parse(run.settings_json || "{}"); } catch { rawSettings = {}; }
    const settings = normalizeCompensationSettings(rawSettings);
    settings.columns.severance = true;
    if (Number.isFinite(annualLeave)) settings.columns.annualLeave = true;
    if (Number.isFinite(deduction)) settings.columns.deduction = true;
    const [year, month] = period.split("-").map(Number);
    let recalculated: Array<{ employeeId: string; snapshot: CompensationEmployee; total: number }>;
    try {
      recalculated = lines.results.map((line) => {
        const employee = (line.employee_id === target.employee_id ? snapshot : JSON.parse(line.snapshot_json)) as CompensationEmployee;
        const total = calculateCompensation(employee, year, month, settings.rounding as "round" | "up" | "down",
          settings.columns as Parameters<typeof calculateCompensation>[4]).total;
        if (!Number.isFinite(total)) throw new Error("Invalid compensation total");
        return { employeeId: line.employee_id, snapshot: employee, total };
      });
    } catch {
      return Response.json({ error: "임금안 계산 자료를 확인해 주세요. 반영되지 않았습니다." }, { status: 409 });
    }
    const pushed = await db.batch([
      ...recalculated.map((line) => db.prepare("UPDATE hr_compensation_lines SET snapshot_json = ?, gross_pay = ?, updated_at = ? WHERE period = ? AND employee_id = ? AND EXISTS (SELECT 1 FROM hr_compensation_runs WHERE period = ? AND status = 'DRAFT' AND version = ?)")
        .bind(JSON.stringify(line.snapshot), line.total, now, period, line.employeeId, period, run.version)),
      db.prepare("UPDATE hr_compensation_runs SET version = version + 1, gross_pay = ?, settings_json = ?, updated_at = ? WHERE period = ? AND status = 'DRAFT' AND version = ?")
        .bind(recalculated.reduce((sum, line) => sum + line.total, 0), JSON.stringify(settings), now, period, run.version),
    ]);
    if ((pushed[pushed.length - 1].meta.changes ?? 0) < 1) return Response.json({ error: `${period} 임금안이 그 사이 변경되었습니다. 새로고침 후 다시 시도해 주세요.` }, { status: 409 });
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "SEVERANCE_APPLIED_TO_PAYROLL", entityType: "compensationLine", entityId: `${period}:${target.employee_id}`, before: { severance: previous, leaveDate: previousLeaveDate }, after: { severance: amount, leaveDate: retirementDate, retirementRequestId: id, employeeName: context.employeeName } });
    return Response.json({ applied: true, period, previous, amount,
      annualLeave: Number.isFinite(annualLeave) && annualLeave >= 0 ? Math.round(annualLeave) : null,
      deduction: Number.isFinite(deduction) && deduction >= 0 ? Math.round(deduction) : null,
      leaveDate: retirementDate || null, leaveDateChanged: Boolean(retirementDate) && previousLeaveDate !== retirementDate });
  }

  if (resource === "leaveRequest") {
    const before = await db.prepare("SELECT * FROM hr_leave_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "휴가 신청을 찾을 수 없습니다." }, { status: 404 });
    // 결재 시절에 PENDING 으로 남은 신청도 이 결정으로 처리한다(전자결재는 없어졌다).
    const status = String(body.status ?? "");
    if (!["APPROVED", "REJECTED", "CANCELLED"].includes(status)) return Response.json({ error: "올바르지 않은 승인 상태입니다." }, { status: 400 });
    await db.prepare("UPDATE hr_leave_requests SET status = ?, approver_employee_id = ?, decided_at = ?, updated_at = ? WHERE id = ?")
      .bind(status, authorization.principal.employeeId, now, now, id).run();
    const after = await db.prepare("SELECT * FROM hr_leave_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: `LEAVE_REQUEST_${status}`, entityType: "leaveRequest", entityId: id, before, after, reason: String(body.reason ?? "") });
    return Response.json({ item: after });
  }

  // 결재 시절에 SUBMITTED 로 남은 인사발령·퇴직 요청의 승인·반려(Design §12.2 레거시 결정).
  if (resource === "personnelActionDecision" || resource === "retirementDecision") {
    const decision = String(body.decision ?? "").toUpperCase();
    if (decision !== "APPROVED" && decision !== "REJECTED") return Response.json({ error: "승인 또는 반려를 선택해 주세요." }, { status: 400 });
    const reason = String(body.reason ?? "").trim().slice(0, 1000);
    const isPersonnel = resource === "personnelActionDecision";
    const table = isPersonnel ? "hr_personnel_actions" : "hr_retirement_requests";
    const before = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: isPersonnel ? "인사발령을 찾을 수 없습니다." : "퇴직 요청을 찾을 수 없습니다." }, { status: 404 });
    const input = { id, decision: decision as LegacyDecision, actorEmployeeId: authorization.principal.employeeId, now } as const;
    const result = await db.batch(isPersonnel ? decidePersonnelActionStatements(db, input) : decideRetirementStatements(db, input));
    if (changedRows(result, 0) !== 1) return hrConflictResponse();
    if (decision === "APPROVED") {
      if (isPersonnel) await applyDuePersonnelActions(db, now);
      else await applyDueRetirements(db, now);
    }
    const after = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr",
      action: `${isPersonnel ? "PERSONNEL_ACTION" : "RETIREMENT"}_${decision}`,
      entityType: isPersonnel ? "personnelAction" : "employeeRetirement", entityId: id, before, after, reason });
    return Response.json({ item: after });
  }

  if (resource === "attendance") {
    const before = await db.prepare("SELECT * FROM hr_attendance_records WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "근태 기록을 찾을 수 없습니다." }, { status: 404 });
    const status = String(body.status ?? "APPROVED");
    if (!["APPROVED", "REJECTED"].includes(status)) return Response.json({ error: "올바르지 않은 근태 상태입니다." }, { status: 400 });
    await db.prepare("UPDATE hr_attendance_records SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?")
      .bind(status, authorization.principal.employeeId, now, id).run();
    const after = await db.prepare("SELECT * FROM hr_attendance_records WHERE id = ?").bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: `ATTENDANCE_${status}`, entityType: "attendance", entityId: id, before, after });
    return Response.json({ item: after });
  }

  if (resource === "lifecycleTask") {
    const before = await db.prepare(`SELECT task.*, employee.status AS employee_status FROM hr_lifecycle_tasks task
      INNER JOIN hr_employee_records employee ON employee.employee_id = task.employee_id
      WHERE task.id = ? AND task.lifecycle_type = 'ONBOARDING'`)
      .bind(id).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "온보딩 업무를 찾을 수 없습니다." }, { status: 404 });
    if (before.employee_status !== "입사 예정") return Response.json({ error: "재직 전환이 완료된 온보딩 기록은 변경할 수 없습니다." }, { status: 409 });
    const status = String(body.status ?? "DONE").toUpperCase();
    if (!["OPEN", "DONE"].includes(status)) return Response.json({ error: "온보딩 업무 상태를 확인해 주세요." }, { status: 400 });
    await db.prepare("UPDATE hr_lifecycle_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND lifecycle_type = 'ONBOARDING'")
      .bind(status, status === "DONE" ? now : null, now, id).run();
    await applyDueOnboarding(db, now);
    const after = await db.prepare("SELECT * FROM hr_lifecycle_tasks WHERE id = ?").bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: `ONBOARDING_TASK_${status}`, entityType: "lifecycleTask", entityId: id, before, after });
    return Response.json({ item: after });
  }

  if (resource === "retirementSettlement") {
    const request = await db.prepare("SELECT * FROM hr_retirement_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!request) return Response.json({ error: "퇴직 요청을 찾을 수 없습니다." }, { status: 404 });
    if (!["IN_PROGRESS", "READY", "EFFECTIVE"].includes(String(request.status ?? ""))) return Response.json({ error: "승인 완료된 퇴직 요청만 정산할 수 있습니다." }, { status: 409 });
    const before = await db.prepare("SELECT * FROM hr_retirement_settlements WHERE request_id = ?").bind(id).first<Record<string, unknown>>();
    const employeeId = String(request.employee_id ?? "");
    const retirementDate = String(request.retirement_date ?? "");
    const context = await severanceContextFor(employeeId, retirementDate);
    const amounts = ["finalSalary", "retirementPay", "deductions"].map((key) => Number(body[key] ?? 0));
    if (amounts.some((value) => !Number.isFinite(value) || value < 0)) return Response.json({ error: "정산 금액은 0원 이상으로 입력해 주세요." }, { status: 400 });
    const [finalSalary, retirementPay, deductions] = amounts.map(Math.round);
    // 연차는 일수로 받는다. 선사용해 마이너스가 된 연차는 음수 금액이 되어 정산에서 차감된다.
    const leaveDays = Number(body.leaveDays ?? 0);
    if (!Number.isFinite(leaveDays) || Math.abs(leaveDays) > 366) return Response.json({ error: "잔여 연차 일수를 -366~366 사이로 입력해 주세요." }, { status: 400 });
    // 퇴사일 시점의 소정근로시간 규정으로 1일 통상임금을 잡는다 (2026-08-01 주 35시간제 시행).
    // 화면의 연차수당 칸에 적힌 값이 오면 그 값을 그대로 쓴다. 계산 결과를 사람이 고칠 수 있어야
    // 하기 때문이다 (퇴직금 칸과 같은 규칙). 값이 오지 않으면 일수로 계산한다.
    const enteredLeavePay = Number(body.unusedLeavePay ?? Number.NaN);
    const unusedLeavePay = Number.isFinite(enteredLeavePay)
      ? Math.round(enteredLeavePay)
      : calculateLeaveAllowance(leaveDays, context.monthlyOrdinaryWage, retirementDate).amount;
    const netSettlement = finalSalary + retirementPay + unusedLeavePay - deductions;
    const controls = {
      payrollConfirmed: Boolean(body.payrollConfirmed), insuranceConfirmed: Boolean(body.insuranceConfirmed),
      accessRevoked: Boolean(body.accessRevoked), assetsReturned: Boolean(body.assetsReturned),
      handoverConfirmed: Boolean(body.handoverConfirmed),
    };
    const ready = Object.values(controls).every(Boolean);
    await db.prepare(`INSERT INTO hr_retirement_settlements
      (request_id, final_salary, retirement_pay, unused_leave_pay, leave_days, deductions, net_settlement,
        payroll_confirmed, insurance_confirmed, access_revoked, assets_returned, handover_confirmed,
        status, prepared_by, completed_by, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET final_salary=excluded.final_salary, retirement_pay=excluded.retirement_pay,
        unused_leave_pay=excluded.unused_leave_pay, leave_days=excluded.leave_days,
        deductions=excluded.deductions, net_settlement=excluded.net_settlement,
        payroll_confirmed=excluded.payroll_confirmed, insurance_confirmed=excluded.insurance_confirmed,
        access_revoked=excluded.access_revoked, assets_returned=excluded.assets_returned,
        handover_confirmed=excluded.handover_confirmed, status=excluded.status,
        prepared_by=excluded.prepared_by, updated_at=excluded.updated_at`)
      .bind(id, finalSalary, retirementPay, unusedLeavePay, leaveDays, deductions, netSettlement,
        controls.payrollConfirmed ? 1 : 0, controls.insuranceConfirmed ? 1 : 0,
        controls.accessRevoked ? 1 : 0, controls.assetsReturned ? 1 : 0,
        controls.handoverConfirmed ? 1 : 0, ready ? "READY" : "DRAFT",
        authorization.principal.employeeId, now, now).run();
    await applyDueRetirements(db, now);

    // 퇴직금은 정산 기록에만 남기고 퇴사월 임금안에는 자동으로 쓰지 않는다. 평균임금은 퇴직일 이전
    // 3개월과 그 기간의 총일수를 기준으로 하고 근로기준법 시행령 제2조의 제외기간을 빼야 하는데,
    // 이 앱에는 그 기간을 구분할 자료(출산전후휴가·육아휴직·업무상 요양·휴업 등)가 없다.
    // 검증되지 않은 금액이 급여 파일까지 흘러가지 않도록, 반영은 사람이 임금계산에서 직접 넣는다.
    const after = await db.prepare("SELECT * FROM hr_retirement_settlements WHERE request_id = ?").bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "RETIREMENT_SETTLEMENT_UPDATED", entityType: "retirementSettlement", entityId: id, before, after });
    return Response.json({ item: after });
  }

  if (resource === "retirementChecklist") {
    const before = await db.prepare("SELECT * FROM hr_retirement_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!before) return Response.json({ error: "퇴직 요청을 찾을 수 없습니다." }, { status: 404 });
    if (!["IN_PROGRESS", "READY", "EFFECTIVE"].includes(String(before.status ?? ""))) return Response.json({ error: "승인 완료된 퇴직 절차만 체크리스트를 갱신할 수 있습니다." }, { status: 409 });
    const completedTaskIds = Array.isArray(body.completedTaskIds) ? body.completedTaskIds.map(String).filter(Boolean) : [];
    const taskRows = await db.prepare("SELECT id FROM hr_lifecycle_tasks WHERE id LIKE ? AND lifecycle_type = 'RETIREMENT'")
      .bind(`${id}:%`).all<{ id: string }>();
    const allowedIds = new Set(taskRows.results.map((row) => row.id.slice(id.length + 1)));
    const validCompleted = [...new Set(completedTaskIds.filter((taskId) => allowedIds.has(taskId)))];
    const totalTasks = Number(before.total_tasks ?? taskRows.results.length);
    const allComplete = totalTasks > 0 && validCompleted.length === totalTasks;
    // 체크는 "이 업무를 했다"는 기록이라 정산이 덜 끝났어도 그대로 저장한다. 예전에는 마지막 하나를
    // 켜서 10개가 다 차는 순간에만 409 로 막아, 그 항목만 클릭이 안 먹는 것처럼 보였다.
    // 막을 것은 기록이 아니라 완료(READY) 전환이므로, 정산이 준비될 때까지 상태만 붙잡아 둔다.
    const settlement = allComplete
      ? await db.prepare("SELECT status FROM hr_retirement_settlements WHERE request_id = ?")
        .bind(id).first<{ status: string }>()
      : null;
    const settlementPending = allComplete && settlement?.status !== "READY";
    const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const due = String(before.retirement_date ?? "") <= koreaDate;
    const nextStatus = allComplete && !settlementPending ? (due ? "EFFECTIVE" : "READY") : (due ? "EFFECTIVE" : "IN_PROGRESS");
    const taskStatements = taskRows.results.map((row) => {
      const taskId = row.id.slice(id.length + 1);
      const completed = validCompleted.includes(taskId);
      return db.prepare("UPDATE hr_lifecycle_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .bind(completed ? "DONE" : "OPEN", completed ? now : null, now, row.id);
    });
    await db.batch([
      ...taskStatements,
      db.prepare(`UPDATE hr_retirement_requests SET checklist_json = ?, completed_tasks = ?, status = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .bind(JSON.stringify(validCompleted), validCompleted.length, nextStatus, nextStatus === "COMPLETED" ? now : null, now, id),
      db.prepare(`UPDATE hr_employee_records SET status = ?,
        retirement_json = json_set(CASE WHEN json_valid(retirement_json) THEN retirement_json ELSE '{}' END,
          '$.completedTaskIds', json(?), '$.status', ?), updated_at = ?
        WHERE employee_id = ?`)
        .bind(due ? "퇴직" : "퇴직 예정", JSON.stringify(validCompleted), nextStatus, now, String(before.employee_id ?? "")),
      db.prepare(`UPDATE hr_retirement_settlements SET status = CASE WHEN ? = 'COMPLETED' THEN 'COMPLETED' ELSE status END,
        completed_by = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_by END,
        completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END, updated_at = ? WHERE request_id = ?`)
        .bind(nextStatus, nextStatus, authorization.principal.employeeId, nextStatus, now, now, id),
    ]);
    await applyDueRetirements(db, now);
    const after = await db.prepare("SELECT * FROM hr_retirement_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "RETIREMENT_CHECKLIST_UPDATED", entityType: "employeeRetirement", entityId: id, before, after });
    return Response.json({ item: after, settlementPending,
      notice: settlementPending ? "체크리스트는 모두 저장했습니다. 퇴직 정산 금액과 급여·보험·계정·자산·인수인계 확인을 마치면 완료로 전환됩니다." : "" });
  }

  return Response.json({ error: "지원하지 않는 HR 운영 항목입니다." }, { status: 400 });
}
