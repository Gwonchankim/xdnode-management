import { env } from "cloudflare:workers";
import { normalizeCompensationSettings as normalizeSettings } from "../../../compensation-settings";
import { ensureHrCompensationRunSchema } from "../../../hr-compensation-schema";
import { readOptionalHrRows } from "../../../hr-optional-tables";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { FIXED_TERM_MONTHS, fixedTermEndDate } from "../../../hr-employment-contract";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { applyDueRetirements } from "../../../hr-retirements";
import { ensureEmployeeRosterSeeded } from "../../../hr-employee-roster";
import { retirementPayDraft } from "../../../assistant-retirement-pay";
import type { CompensationEmployee } from "../../../compensation-calculation";

type Bindings = { DB: D1Database };
const db = (env as unknown as Bindings).DB;

type RunRow = {
  period: string; status: string; version: number; employee_count: number; gross_pay: number;
  settings_json: string;
  created_by: string; confirmed_by: string; confirmed_at: number | null; created_at: number; updated_at: number;
};

type LineRow = { employee_id: string; snapshot_json: string; gross_pay: number };
type EmployeeRow = {
  employee_id: string; name: string; birth: string; department: string; position: string; job_title: string;
  join_date: string; status: string; retirement_json: string | null; base_pay: number; meal_allowance: number;
  childcare_allowance: number; vehicle_allowance: number; annual_salary: number;
  first_term_pay_percent: number | null; regular_contract_date: string | null;
};

const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 영업 인센티브(sales_incentive_payroll_links)가 급여기록에 합산됐던 과거 급여월. 영업 모듈이 없어져(D2)
 * 확정 때 그 표를 읽지 않으므로, 이 월은 다시 확정(CONFIRM)하지 못하게 막는다.
 * r1-preflight(2026-09-28) 조회에서 0건이라 비어 있다(Design §12.1).
 */
export const LEGACY_SALES_INCENTIVE_PERIODS: readonly string[] = [];
const safeJson = <T,>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
// 개별 지급 항목은 0원 이상. 지급총액(공제 후 실지급)만 음수를 허용한다 — 선사용 연차 공제 등으로 공제가 지급을 넘는 달이 있다.
const money = (value: unknown, allowNegative = false) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && (allowNegative || parsed >= 0) ? Math.round(parsed) : null;
};


async function ensureSchema() {
  await ensureHrCompensationRunSchema(db);
  await ensureHrEmployeeRecordsSchema(db);
  await db.batch([

    db.prepare(`CREATE TABLE IF NOT EXISTS hr_compensation_lines (
      period TEXT NOT NULL, employee_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, gross_pay INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (period, employee_id))`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_hr_compensation_lines_period ON hr_compensation_lines(period, employee_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_records (
      id TEXT PRIMARY KEY, year_month TEXT NOT NULL, employee_id TEXT, employee_name TEXT NOT NULL, department TEXT,
      annual_salary INTEGER NOT NULL, base_pay INTEGER NOT NULL, meal_allowance INTEGER NOT NULL,
      childcare_allowance INTEGER NOT NULL, vehicle_allowance INTEGER NOT NULL, incentive INTEGER NOT NULL,
      bonus INTEGER NOT NULL, annual_leave_pay INTEGER NOT NULL, retirement_pay INTEGER NOT NULL, deductions INTEGER NOT NULL,
      gross_pay INTEGER NOT NULL, net_pay INTEGER NOT NULL, card_allowance INTEGER NOT NULL, card_usage INTEGER NOT NULL,
      personal_purchase INTEGER NOT NULL, non_taxable INTEGER NOT NULL, welfare_fund INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '', source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL, imported_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_runs (
      period TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', employee_count INTEGER NOT NULL DEFAULT 0,
      gross_pay INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0, net_pay INTEGER NOT NULL DEFAULT 0,
      prepared_by TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '',
      locked_at INTEGER, reopened_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
  ]);
  // 확정 INSERT 가 쓰는 열. 원래 급여관리 라우트만 더했는데, 급여관리를 열기 전에 확정하면 열이 없어 실패했다.
  const payrollColumns = await db.prepare("PRAGMA table_info(hr_payroll_records)").all<{ name: string }>();
  const payrollExisting = new Set(payrollColumns.results.map((column) => column.name));
  if (!payrollExisting.has("deduction_detail_json")) await db.prepare("ALTER TABLE hr_payroll_records ADD COLUMN deduction_detail_json TEXT NOT NULL DEFAULT '{}'").run();
  if (!payrollExisting.has("personal_expense")) await db.prepare("ALTER TABLE hr_payroll_records ADD COLUMN personal_expense INTEGER NOT NULL DEFAULT 0").run();
  const runColumns = await db.prepare("PRAGMA table_info(hr_compensation_runs)").all<{ name: string }>();
  if (!runColumns.results.some((column) => column.name === "settings_json")) {
    await db.prepare("ALTER TABLE hr_compensation_runs ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'").run();
  }
  // hrPayrollSnapshots() drafts payroll straight from hr_employee_records, so an unseeded roster
  // silently produces a payroll run covering only the few edited employees.
  await ensureEmployeeRosterSeeded(db);
}

function runJson(row: RunRow | null, lines: LineRow[]) {
  if (!row) return null;
  return {
    period: row.period, status: row.status, version: row.version, employeeCount: row.employee_count,
    grossPay: row.gross_pay, settings: normalizeSettings(safeJson(row.settings_json, {})),
    createdBy: row.created_by, confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at,
    employees: lines.map((line) => safeJson<Record<string, unknown>>(line.snapshot_json, {})),
  };
}

async function readRun(period: string) {
  const [run, lines] = await Promise.all([
    db.prepare("SELECT * FROM hr_compensation_runs WHERE period = ?").bind(period).first<RunRow>(),
    db.prepare("SELECT employee_id, snapshot_json, gross_pay FROM hr_compensation_lines WHERE period = ? ORDER BY employee_id").bind(period).all<LineRow>(),
  ]);
  return { run: run ?? null, lines: lines.results };
}

async function hrPayrollSnapshots(period: string) {
  const [year, month] = period.split("-").map(Number);
  const start = `${period}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  // 퇴직일은 두 곳에 있다 — 인사기록의 retirement_json.$.date(예전 방식)와 퇴직 요청 표(현재 방식, 퇴직 효력 처리는 $.status 만 쓴다).
  // 그래서 SQL 로 걸러내지 않고 전원을 읽은 뒤 두 출처를 합쳐 판단한다: 퇴직일이 급여월 시작 전이면 제외, 급여월 안이면
  // 퇴사일을 채워 일할 계산되게 한다. 퇴직 상태인데 퇴직일을 어디서도 못 찾으면 제외한다.
  const allEmployees = await db.prepare(`SELECT employee_id, name, birth, department, position, job_title, join_date, status,
    retirement_json, annual_salary, base_pay, meal_allowance, childcare_allowance, vehicle_allowance,
    first_term_pay_percent, regular_contract_date FROM hr_employee_records
    WHERE NULLIF(replace(join_date, '.', '-'), '') IS NOT NULL AND replace(join_date, '.', '-') <= ?
    ORDER BY department, name`).bind(end).all<EmployeeRow>();
  const retirementRows = await readOptionalHrRows<{ employee_id: string; retirement_date: string }>(db, ["hr_retirement_requests"], `SELECT employee_id, retirement_date FROM hr_retirement_requests
    WHERE status IN ('IN_PROGRESS', 'READY', 'EFFECTIVE', 'COMPLETED') ORDER BY created_at`);
  const exitByEmployee = new Map(retirementRows.results.map((row) => [row.employee_id, row.retirement_date.replaceAll(".", "-")]));
  const exitDateOf = (employee: EmployeeRow) => safeJson<{ date?: string }>(employee.retirement_json ?? "", {}).date?.replaceAll(".", "-") || exitByEmployee.get(employee.employee_id) || "";
  const employees = { results: allEmployees.results.filter((employee) => {
    const exit = exitDateOf(employee);
    if (exit) return exit >= start;
    return (employee.status ?? "재직").trim() !== "퇴직";
  }) };
  // 첫 계약(3개월 기간제) 지급률이 100% 미만이면 엔진의 수습 구간 계산에 태운다 — 월 경계 일할까지 엔진이 맞춘다.
  // 종료일은 입사일 + 3개월 − 1일이고, 그 전에 정규직 전환을 기록했으면 전환 전날까지만 줄여 준다.
  const dayBefore = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const firstTermOf = (employee: EmployeeRow) => {
    const percent = employee.first_term_pay_percent ?? 100;
    if (!(percent > 0 && percent < 100) || employee.annual_salary <= 0) return null;
    let end = fixedTermEndDate(employee.join_date.replaceAll(".", "-"));
    if (!end) return null;
    if (employee.regular_contract_date && employee.regular_contract_date <= end) end = dayBefore(employee.regular_contract_date);
    return { rate: percent / 100, end };
  };
  return employees.results.map((employee) => ({
    id: employee.employee_id, name: employee.name, department: employee.department,
    title: employee.job_title || employee.position, birthDate: employee.birth === "미입력" ? "" : employee.birth.replaceAll(".", "-"),
    joinDate: employee.join_date.replaceAll(".", "-"),
    leaveDate: exitDateOf(employee),
    ...(firstTermOf(employee)
      ? { probationMonths: FIXED_TERM_MONTHS, probationRate: firstTermOf(employee)!.rate, probationEndDate: firstTermOf(employee)!.end, manualBasic: false }
      : { probationMonths: 0, manualBasic: employee.annual_salary <= 0 }),
    annualSalary: employee.annual_salary, basePay: employee.base_pay,
    meal: employee.meal_allowance, car: employee.vehicle_allowance, child: employee.childcare_allowance, monthly: {},
  }));
}

function validateDraft(body: Record<string, unknown>) {
  if (!Array.isArray(body.employees) || !Array.isArray(body.rows)) return { error: "임금 대상자와 계산 결과가 필요합니다." } as const;
  const employees = body.employees as Array<Record<string, unknown>>;
  const rows = body.rows as Array<Record<string, unknown>>;
  if (employees.length !== rows.length || employees.length > 500) return { error: "임금 대상자와 계산 결과의 인원 수가 일치하지 않습니다." } as const;
  const employeeIds = new Set<string>();
  const normalizedRows: Array<Record<string, number | string>> = [];
  for (const [index, employee] of employees.entries()) {
    const employeeId = String(employee.id ?? "").trim();
    const name = String(employee.name ?? "").trim();
    if (!employeeId || !name || employeeIds.has(employeeId)) return { error: "직원 ID와 이름을 확인해 주세요." } as const;
    employeeIds.add(employeeId);
    const row = rows[index];
    if (String(row.employeeId ?? "") !== employeeId) return { error: "직원과 계산 결과의 순서가 일치하지 않습니다." } as const;
    // 연차수당과 공제도 지급총액에 들어간다. app/compensation-calculation.ts 의 total 산식과 같아야 하고,
    // 어긋나면 자동 저장이 통째로 400 으로 막혀 화면에서 고친 값이 조용히 사라진다.
    //   total = 기본급+식대+차량+육아+인센티브+상여+수당+연구 + 퇴직금 + 연차수당 − 공제
    const fields = ["basic", "meal", "car", "child", "incentive", "bonus", "extra", "research", "severance", "annualLeave", "personalExpense", "deduction", "welfare", "total"] as const;
    const values = Object.fromEntries(fields.map((field) => [field, money(row[field], field === "total")])) as Record<(typeof fields)[number], number | null>;
    if (Object.values(values).some((value) => value === null)) return { error: `${name}의 임금 항목은 0원 이상이어야 합니다.` } as const;
    const expected = values.basic! + values.meal! + values.car! + values.child! + values.incentive! + values.bonus!
      + values.extra! + values.research! + values.severance! + values.annualLeave! + values.personalExpense! - values.deduction!;
    if (expected !== values.total) {
      return { error: `${name}의 지급총액이 세부 항목 합계와 일치하지 않습니다. (합계 ${expected.toLocaleString("ko-KR")}원 · 지급총액 ${values.total!.toLocaleString("ko-KR")}원)` } as const;
    }
    // 공제 사유는 숫자가 아니라 위 fields 에 없다. 따로 실어 두지 않으면 확정할 때 사유가 사라진다.
    normalizedRows.push({ employeeId, name, deductionNote: String(row.deductionNote ?? "").trim(),
      personalExpenseNote: String(row.personalExpenseNote ?? "").trim(),
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value!])) });
  }
  return { employees, rows: normalizedRows } as const;
}

export async function GET(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await applyDueRetirements(db);
  const period = new URL(request.url).searchParams.get("period")?.trim() ?? "";
  if (!periodPattern.test(period)) return Response.json({ error: "급여월 형식이 올바르지 않습니다." }, { status: 400 });
  const { run, lines } = await readRun(period);
  // include=hr: 그 달의 HR 급여 대상 스냅샷을 함께 준다. 화면이 표에 없는 인원만 골라 붙일 때 쓴다 —
  // LOAD_HR 처럼 명단을 통째로 다시 만들지 않으므로 이미 손본 행은 그대로 남는다.
  const includeHr = new URL(request.url).searchParams.get("include") === "hr";
  return Response.json({ run: runJson(run, lines), ...(includeHr ? { hrEmployees: await hrPayrollSnapshots(period) } : {}) });
}

export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await applyDueRetirements(db);
  let body = await request.json() as Record<string, unknown>;
  const period = String(body.period ?? "").trim();
  const action = String(body.action ?? "").trim();
  if (!periodPattern.test(period)) return Response.json({ error: "급여월 형식이 올바르지 않습니다." }, { status: 400 });
  const now = Date.now();
  const beforeState = await readRun(period);

  if (["CREATE", "LOAD_HR"].includes(action)) {
    if (action === "CREATE" && beforeState.run) return Response.json({ run: runJson(beforeState.run, beforeState.lines), reused: true });
    if (action === "LOAD_HR" && beforeState.run?.status === "CONFIRMED") {
      return Response.json({ error: "확정된 임금안은 수정하기를 먼저 눌러 주세요." }, { status: 409 });
    }
    let snapshots: Array<Record<string, unknown>>;
    let grossPayByEmployee: number[];
    const hasClientDraft = action === "CREATE" && Array.isArray(body.employees) && body.employees.length > 0;
    if (hasClientDraft) {
      const draft = validateDraft(body);
      if ("error" in draft) return Response.json({ error: draft.error }, { status: 400 });
      snapshots = draft.employees;
      grossPayByEmployee = draft.rows.map((row) => Number(row.total));
    } else {
      snapshots = await hrPayrollSnapshots(period);
      grossPayByEmployee = snapshots.map(() => 0);
    }
    const grossPay = grossPayByEmployee.reduce((sum, amount) => sum + amount, 0);
    if (!beforeState.run) {
      await db.batch([
        db.prepare(`INSERT INTO hr_compensation_runs
          (period, status, version, employee_count, gross_pay, settings_json, created_by, confirmed_by, confirmed_at, created_at, updated_at)
          VALUES (?, 'DRAFT', 1, ?, ?, ?, ?, '', NULL, ?, ?)`).bind(period, snapshots.length, grossPay,
          JSON.stringify(normalizeSettings(body.settings)), authorization.principal.employeeId, now, now),
        ...snapshots.map((snapshot, index) => db.prepare(`INSERT INTO hr_compensation_lines
          (period, employee_id, snapshot_json, gross_pay, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(period, String(snapshot.id), JSON.stringify(snapshot), grossPayByEmployee[index], now)),
      ]);
    } else {
      const expectedVersion = Number(body.version ?? 0);
      if (expectedVersion !== beforeState.run.version) return Response.json({ error: "다른 사용자가 임금안을 변경했습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
      const nextVersion = expectedVersion + 1;
      const results = await db.batch([
        db.prepare(`UPDATE hr_compensation_runs SET version=version+1, employee_count=?, gross_pay=?, settings_json=?, updated_at=?
          WHERE period=? AND status='DRAFT' AND version=?`).bind(snapshots.length, grossPay,
          JSON.stringify(normalizeSettings(body.settings)), now, period, expectedVersion),
        db.prepare(`DELETE FROM hr_compensation_lines WHERE period = ? AND EXISTS (
          SELECT 1 FROM hr_compensation_runs WHERE period = ? AND status='DRAFT' AND version=? AND updated_at=?)`)
          .bind(period, period, nextVersion, now),
        ...snapshots.map((snapshot, index) => db.prepare(`INSERT INTO hr_compensation_lines
          (period, employee_id, snapshot_json, gross_pay, updated_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM hr_compensation_runs WHERE period = ? AND status='DRAFT' AND version=? AND updated_at=?)`)
          .bind(period, String(snapshot.id), JSON.stringify(snapshot), grossPayByEmployee[index], now,
            period, nextVersion, now)),
      ]);
      if ((results[0]?.meta.changes ?? 0) < 1) return Response.json({ error: "임금안 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
    }
    const afterState = await readRun(period);
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: action === "LOAD_HR" ? "COMPENSATION_HR_DRAFT_LOADED" : "COMPENSATION_DRAFT_CREATED", entityType: "compensationRun", entityId: period, before: beforeState.run ? runJson(beforeState.run, beforeState.lines) : undefined, after: runJson(afterState.run, afterState.lines) });
    return Response.json({ run: runJson(afterState.run, afterState.lines) }, { status: 201 });
  }

  if (!beforeState.run) return Response.json({ error: "먼저 해당 월 임금안을 작성해 주세요." }, { status: 404 });
  const expectedVersion = Number(body.version ?? 0);
  if (expectedVersion !== beforeState.run.version) return Response.json({ error: "다른 사용자가 임금안을 변경했습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });

  if (action === "REOPEN") {
    if (beforeState.run.status !== "CONFIRMED") return Response.json({ error: "확정된 임금안만 수정 상태로 전환할 수 있습니다." }, { status: 409 });
    const payroll = await db.prepare("SELECT status FROM hr_payroll_runs WHERE period = ?").bind(period).first<{ status: string }>();
    if (payroll && payroll.status !== "DRAFT") return Response.json({ error: "HR 급여관리에서 검토·승인·마감이 진행된 급여월은 먼저 작성 중으로 되돌려야 합니다." }, { status: 409 });
    const reopened = await db.prepare(`UPDATE hr_compensation_runs SET status='DRAFT', version=version+1, confirmed_by='', confirmed_at=NULL, updated_at=?
      WHERE period=? AND status='CONFIRMED' AND version=?
        AND NOT EXISTS (SELECT 1 FROM hr_payroll_runs p WHERE p.period = hr_compensation_runs.period AND p.status <> 'DRAFT')`).bind(now, period, expectedVersion).run();
    if ((reopened.meta.changes ?? 0) < 1) return Response.json({ error: "임금안 또는 급여월 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
  } else if (["SAVE", "CONFIRM", "APPLY_RETIREMENT_PAY"].includes(action)) {
    if (beforeState.run.status !== "DRAFT") return Response.json({ error: "확정된 임금안은 수정하기를 먼저 눌러 주세요." }, { status: 409 });
    // 영업 인센티브가 급여기록에 합산됐던 과거 급여월은 이 화면의 값만으로 다시 확정하면 그 금액이 사라진다.
    if (action === "CONFIRM" && LEGACY_SALES_INCENTIVE_PERIODS.includes(period)) {
      return Response.json({ error: "영업 인센티브가 반영된 과거 급여월은 다시 확정할 수 없습니다.", code: "LEGACY_PERIOD_LOCKED", period }, { status: 409 });
    }
    if (action === "CONFIRM" || action === "APPLY_RETIREMENT_PAY") {
      const payroll = await db.prepare("SELECT status FROM hr_payroll_runs WHERE period = ?").bind(period).first<{ status: string }>();
      if (payroll && payroll.status !== "DRAFT") return Response.json({ error: "HR 급여관리에서 검토·승인·마감이 진행된 급여월은 임금안으로 덮어쓸 수 없습니다." }, { status: 409 });
    }
    if (action === "APPLY_RETIREMENT_PAY") {
      try {
        const current = runJson(beforeState.run, beforeState.lines)!;
        const updated = retirementPayDraft({ ...current, employees: current.employees as CompensationEmployee[] }, {
          period, employeeId: String(body.employeeId ?? ""), employeeName: String(body.employeeName ?? ""),
          amount: body.amount as number, sourceFileName: String(body.sourceFileName ?? ""),
        });
        body = { ...body, ...updated };
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "퇴직금 반영 내용을 확인해 주세요." }, { status: 400 });
      }
    }
    const draft = validateDraft(body);
    if ("error" in draft) return Response.json({ error: draft.error }, { status: 400 });
    // 배치의 모든 문은 임금안이 아직 이 버전의 DRAFT 일 때만 효력이 있다. 버전 검사(위)와 배치 사이에 다른 저장이 끼어들면
    // 라인·급여기록이 옛 초안으로 덮이는데, 예전에는 run UPDATE 만 막히고 나머지 문은 그대로 실행됐다.
    const payrollGuard = action === "CONFIRM" || action === "APPLY_RETIREMENT_PAY"
      ? "NOT EXISTS (SELECT 1 FROM hr_payroll_runs p WHERE p.period = hr_compensation_runs.period AND p.status <> 'DRAFT')"
      : "1 = 1";
    const draftGuard = `EXISTS (SELECT 1 FROM hr_compensation_runs WHERE period = ? AND status = 'DRAFT' AND version = ? AND ${payrollGuard})`;
    const draftGuardBinds = [period, expectedVersion];
    const lineStatements = draft.employees.map((employee, index) => db.prepare(`INSERT INTO hr_compensation_lines
      (period, employee_id, snapshot_json, gross_pay, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${draftGuard}
      ON CONFLICT(period, employee_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, gross_pay=excluded.gross_pay, updated_at=excluded.updated_at`)
      .bind(period, String(employee.id), JSON.stringify(employee), Number(draft.rows[index].total), now, ...draftGuardBinds));
    const employeeIds = draft.employees.map((employee) => String(employee.id));
    const deleteRemoved = employeeIds.length
      ? db.prepare(`DELETE FROM hr_compensation_lines WHERE period = ? AND employee_id NOT IN (${employeeIds.map(() => "?").join(",")}) AND ${draftGuard}`).bind(period, ...employeeIds, ...draftGuardBinds)
      : db.prepare(`DELETE FROM hr_compensation_lines WHERE period = ? AND ${draftGuard}`).bind(period, ...draftGuardBinds);
    const grossPay = draft.rows.reduce((sum, row) => sum + Number(row.total), 0);
    // 임금계산기의 total 은 공제를 이미 뺀 실지급액이다. 급여관리 화면은 지급총액·공제총액·
    // 실 지급액을 따로 보여주므로, 공제를 더해 공제 전 금액을 되살려 넘긴다.
    const totalDeductions = draft.rows.reduce((sum, row) => sum + Number(row.deduction ?? 0), 0);
    const nextStatus = action === "CONFIRM" ? "CONFIRMED" : "DRAFT";
    const statements = [
      ...lineStatements, deleteRemoved,
      db.prepare(`UPDATE hr_compensation_runs SET status=?, version=version+1, employee_count=?, gross_pay=?, settings_json=?,
        confirmed_by=?, confirmed_at=?, updated_at=? WHERE period=? AND status='DRAFT' AND version=? AND ${payrollGuard}`)
        .bind(nextStatus, draft.employees.length, grossPay, JSON.stringify(normalizeSettings(body.settings)),
          action === "CONFIRM" ? authorization.principal.employeeId : "", action === "CONFIRM" ? now : null, now, period, expectedVersion),
    ];
    if (action === "CONFIRM") {
      // run UPDATE(위)가 이번 호출로 CONFIRMED·새 버전이 됐을 때만 급여기록을 교체한다.
      const confirmedGuard = "EXISTS (SELECT 1 FROM hr_compensation_runs WHERE period = ? AND status = 'CONFIRMED' AND version = ? AND updated_at = ?)";
      const confirmedGuardBinds = [period, expectedVersion + 1, now];
      statements.push(db.prepare(`DELETE FROM hr_payroll_records WHERE year_month = ? AND ${confirmedGuard}`).bind(period, ...confirmedGuardBinds));
      draft.rows.forEach((row, index) => {
        const employee = draft.employees[index];
        const combinedBonus = Number(row.bonus) + Number(row.extra) + Number(row.research);
        const recordId = `compensation:${period}:${String(employee.id)}`;
        // 인센티브는 임금 계산 화면의 입력값만 쓴다(영업 인센티브 합산은 R1에서 없앴다, Design §12.3).
        const incentiveTotal = Number(row.incentive);
        const rowDeduction = Number(row.deduction ?? 0);
        // row.total 은 공제 후 금액이다. 공제를 되더해 공제 전 지급총액을 만든다.
        const payNet = Number(row.total);
        const payGross = payNet + rowDeduction;
        // 공제 사유가 있으면 원본 메모 뒤에 덧붙인다. 저장할 때마다 메모에서 새로 만들기 때문에
        // 여러 번 저장해도 사유가 겹쳐 쌓이지 않는다.
        const baseNote = String((employee.monthly as Record<string, Record<string, unknown>> | undefined)?.[period]?.note ?? "");
        const deductionNote = String(row.deductionNote ?? "").trim();
        const personalExpenseNote = String(row.personalExpenseNote ?? "").trim();
        const recordNote = [baseNote, deductionNote ? `공제 사유: ${deductionNote}` : "",
          personalExpenseNote ? `개인비용 사유: ${personalExpenseNote}` : ""].filter(Boolean).join(" / ");
        statements.push(db.prepare(`INSERT INTO hr_payroll_records
          (id, year_month, employee_id, employee_name, department, annual_salary, base_pay, meal_allowance,
            childcare_allowance, vehicle_allowance, incentive, bonus, annual_leave_pay, personal_expense, retirement_pay, deductions,
            gross_pay, net_pay, card_allowance, card_usage, personal_purchase, non_taxable, welfare_fund,
            notes, source_sheet, source_row, imported_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 'ERP 임금계산', ?, ? WHERE ${confirmedGuard}`)
          .bind(recordId, period, String(employee.id), String(employee.name), String(employee.department ?? ""),
            money(employee.annualSalary) ?? 0, Number(row.basic), Number(row.meal), Number(row.child), Number(row.car), incentiveTotal, combinedBonus,
            Number(row.annualLeave ?? 0), Number(row.personalExpense ?? 0), Number(row.severance), rowDeduction, payGross, payNet, Number(row.meal) + Number(row.child) + Number(row.car), Number(row.welfare),
            recordNote, index + 1, now, ...confirmedGuardBinds));
      });
      statements.push(db.prepare(`INSERT INTO hr_payroll_runs
        (period, status, employee_count, gross_pay, deductions, net_pay, prepared_by, reviewed_by, approved_by,
          locked_at, reopened_reason, created_at, updated_at) SELECT ?, 'DRAFT', ?, ?, ?, ?, ?, '', '', NULL, '', ?, ? WHERE ${confirmedGuard}
        ON CONFLICT(period) DO UPDATE SET employee_count=excluded.employee_count, gross_pay=excluded.gross_pay,
          deductions=excluded.deductions, net_pay=excluded.net_pay, prepared_by=excluded.prepared_by, reviewed_by='', approved_by='',
          locked_at=NULL, reopened_reason='', updated_at=excluded.updated_at WHERE hr_payroll_runs.status='DRAFT'`)
        .bind(period, draft.employees.length, grossPay + totalDeductions, totalDeductions,
          grossPay, authorization.principal.employeeId, now, now, ...confirmedGuardBinds));
    }
    const results = await db.batch(statements);
    const runResult = results[lineStatements.length + 1];
    if ((runResult.meta.changes ?? 0) < 1) return Response.json({ error: "임금안 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
  } else {
    return Response.json({ error: "지원하지 않는 임금안 작업입니다." }, { status: 400 });
  }

  const afterState = await readRun(period);
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: `COMPENSATION_${action}`, entityType: "compensationRun", entityId: period, before: runJson(beforeState.run, beforeState.lines), after: runJson(afterState.run, afterState.lines) });
  return Response.json({ run: runJson(afterState.run, afterState.lines) });
}
