import { env } from "cloudflare:workers";
import { ensureHrCompensationRunSchema } from "../../../hr-compensation-schema";
import { companyEmployees } from "../../../hr-company-data";
import { payrollSeedRecords } from "../../../payroll-seed-data";
import { authorizeErpRequest, safeJson, writeErpAudit } from "../../../erp-platform";
import { changedRows, hrConflictResponse, payrollRunTransition } from "../../../hr-transitions";

/**
 * 재무에서 지급·전기가 시작된 과거 급여월. 재무 모듈이 없어져(D2-b) 재오픈 때 재무 행을 읽지 않고 이 목록으로 막는다.
 * r1-preflight(2026-09-28) 조회에서 payroll 재무 행 20건이 모두 미지급·미전기라 비어 있다(Design §12.1).
 */
export const LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS: readonly string[] = [];

type HrBindings = { DB: D1Database };
const db = (env as unknown as HrBindings).DB;

type PayrollRow = {
  id: string;
  year_month: string;
  employee_id: string | null;
  employee_name: string;
  department: string | null;
  annual_salary: number;
  base_pay: number;
  meal_allowance: number;
  childcare_allowance: number;
  vehicle_allowance: number;
  incentive: number;
  bonus: number;
  annual_leave_pay: number;
  retirement_pay: number;
  deductions: number;
  gross_pay: number;
  net_pay: number;
  card_allowance: number;
  card_usage: number;
  personal_purchase: number;
  non_taxable: number;
  welfare_fund: number;
  notes: string;
  personal_expense: number;
  deduction_detail_json: string | null;
  source_sheet: string;
  source_row: number;
};

type PayrollSummaryRow = {
  year_month: string;
  /** 그 달 임금안의 상태. 빈 문자열이면 임금계산에 아직 없는 달이다. */
  compensation_status: string;
  employee_count: number;
  gross_pay: number;
  deductions: number;
  net_pay: number;
  status: string;
  prepared_by: string;
  reviewed_by: string;
  approved_by: string;
  locked_at: number | null;
};

const employeeAliases: Record<string, string> = {
  조수종: "sjcho",
  민경윤: "ky.min",
};

const employeeByName = new Map(companyEmployees.map((employee) => [employee.name, employee]));
const employeeById = new Map(companyEmployees.map((employee) => [employee.id, employee]));

async function ensureSchema() {
  await ensureHrCompensationRunSchema(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_records (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      employee_id TEXT,
      employee_name TEXT NOT NULL,
      department TEXT,
      annual_salary INTEGER NOT NULL,
      base_pay INTEGER NOT NULL,
      meal_allowance INTEGER NOT NULL,
      childcare_allowance INTEGER NOT NULL,
      vehicle_allowance INTEGER NOT NULL,
      incentive INTEGER NOT NULL,
      bonus INTEGER NOT NULL,
      annual_leave_pay INTEGER NOT NULL,
      retirement_pay INTEGER NOT NULL,
      deductions INTEGER NOT NULL,
      gross_pay INTEGER NOT NULL,
      net_pay INTEGER NOT NULL,
      card_allowance INTEGER NOT NULL,
      card_usage INTEGER NOT NULL,
      personal_purchase INTEGER NOT NULL,
      non_taxable INTEGER NOT NULL,
      welfare_fund INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      imported_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_hr_payroll_records_month_name
      ON hr_payroll_records(year_month, employee_name)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hr_payroll_runs (
      period TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', employee_count INTEGER NOT NULL DEFAULT 0,
      gross_pay INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0, net_pay INTEGER NOT NULL DEFAULT 0,
      prepared_by TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '',
      locked_at INTEGER, reopened_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
  ]);
  // 급여대장의 항목별 공제(국민연금·건강보험·소득세 등)를 그대로 담아 두는 칸. 뒤늦게 붙여서
  // CREATE TABLE 로는 기존 테이블에 생기지 않으므로 여기서 확인하고 추가한다.
  const payrollColumns = await db.prepare("PRAGMA table_info(hr_payroll_records)").all<{ name: string }>();
  if (!payrollColumns.results.some((column) => column.name === "deduction_detail_json")) {
    await db.prepare("ALTER TABLE hr_payroll_records ADD COLUMN deduction_detail_json TEXT NOT NULL DEFAULT '{}'").run();
  }
  // 업무에 쓴 개인 비용을 되돌려 주는 실비. 지급 항목이라 지급총액에 들어간다.
  if (!payrollColumns.results.some((column) => column.name === "personal_expense")) {
    await db.prepare("ALTER TABLE hr_payroll_records ADD COLUMN personal_expense INTEGER NOT NULL DEFAULT 0").run();
  }
}

/**
 * 급여관리 월 목록(hr_payroll_runs)을 급여기록에서 다시 집계한다.
 *
 * 새 달을 여기서 마음대로 만들지 않는다. 급여관리에 달이 올라오는 길은 하나뿐이다 —
 * 임금계산 탭에서 그 달을 "확정"하는 것. 예전에는 급여기록에 행만 있으면 (원본 시트 임포트 포함)
 * 달이 저절로 생겨서, 아직 작성 중인 달까지 급여관리에 금액이 떠 있었다.
 *
 * 이미 등록된 달은 그대로 두고 합계만 갱신한다. 확정한 뒤 임금계산에서 "수정하기"로 다시 열어도
 * 목록에서 사라지지 않고 자리를 지킨다(화면이 "수정 중"으로 표시한다).
 */
async function syncPayrollRuns() {
  const now = Date.now();
  await db.prepare(`INSERT INTO hr_payroll_runs
    (period, status, employee_count, gross_pay, deductions, net_pay, prepared_by, reviewed_by, approved_by,
      locked_at, reopened_reason, created_at, updated_at)
    SELECT r.year_month, 'DRAFT', COUNT(*), COALESCE(SUM(r.gross_pay), 0), COALESCE(SUM(r.deductions), 0),
      COALESCE(SUM(r.net_pay), 0), '', '', '', NULL, '', ?, ?
    FROM hr_payroll_records r
    WHERE EXISTS (SELECT 1 FROM hr_compensation_runs c WHERE c.period = r.year_month AND c.status = 'CONFIRMED')
       OR EXISTS (SELECT 1 FROM hr_payroll_runs p WHERE p.period = r.year_month)
    GROUP BY r.year_month
    ON CONFLICT(period) DO UPDATE SET employee_count = excluded.employee_count, gross_pay = excluded.gross_pay,
      deductions = excluded.deductions, net_pay = excluded.net_pay, updated_at = excluded.updated_at`)
    .bind(now, now).run();
}

async function seedPayrollRecords() {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM hr_payroll_records").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;

  const importedAt = Date.now();
  const statements = payrollSeedRecords.map((record) => {
    const aliasId = employeeAliases[record.employeeName];
    const employee = aliasId ? employeeById.get(aliasId) : employeeByName.get(record.employeeName);
    return db.prepare(`INSERT INTO hr_payroll_records (
      id, year_month, employee_id, employee_name, department, annual_salary, base_pay,
      meal_allowance, childcare_allowance, vehicle_allowance, incentive, bonus,
      annual_leave_pay, retirement_pay, deductions, gross_pay, net_pay,
      card_allowance, card_usage, personal_purchase, non_taxable, welfare_fund,
      notes, source_sheet, source_row, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`).bind(
      record.id,
      record.yearMonth,
      employee?.id ?? null,
      record.employeeName,
      employee?.department ?? null,
      record.annualSalary,
      record.basePay,
      record.mealAllowance,
      record.childcareAllowance,
      record.vehicleAllowance,
      record.incentive,
      record.bonus,
      record.annualLeavePay,
      record.retirementPay,
      record.deductions,
      record.grossPay,
      record.netPay,
      record.cardAllowance,
      record.cardUsage,
      record.personalPurchase,
      record.nonTaxable,
      record.welfareFund,
      record.notes,
      record.sourceSheet,
      record.sourceRow,
      importedAt,
    );
  });

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

function toRecord(row: PayrollRow) {
  return {
    id: row.id,
    yearMonth: row.year_month,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    department: row.department,
    annualSalary: row.annual_salary,
    basePay: row.base_pay,
    mealAllowance: row.meal_allowance,
    childcareAllowance: row.childcare_allowance,
    vehicleAllowance: row.vehicle_allowance,
    incentive: row.incentive,
    bonus: row.bonus,
    annualLeavePay: row.annual_leave_pay,
    personalExpense: row.personal_expense,
    retirementPay: row.retirement_pay,
    deductions: row.deductions,
    grossPay: row.gross_pay,
    netPay: row.net_pay,
    cardAllowance: row.card_allowance,
    cardUsage: row.card_usage,
    personalPurchase: row.personal_purchase,
    nonTaxable: row.non_taxable,
    welfareFund: row.welfare_fund,
    notes: row.notes,
    // 급여대장의 항목별 공제. 열 제목을 눌렀을 때 화면이 그대로 펼쳐 보여 준다.
    deductionDetail: safeJson<Record<string, number>>(String(row.deduction_detail_json ?? ""), {}),
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
  };
}

export async function GET(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "read");
  if (authorization.response) return authorization.response;
  await seedPayrollRecords();
  await syncPayrollRuns();

  const month = new URL(request.url).searchParams.get("month")?.trim();
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return Response.json({ error: "급여월 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const [recordsResult, summary] = await Promise.all([
      db.prepare(`SELECT * FROM hr_payroll_records
        WHERE year_month = ? ORDER BY employee_name`).bind(month).all<PayrollRow>(),
      db.prepare(`SELECT r.year_month, COUNT(*) AS employee_count,
        COALESCE(SUM(r.gross_pay), 0) AS gross_pay, COALESCE(SUM(r.deductions), 0) AS deductions,
        COALESCE(SUM(r.net_pay), 0) AS net_pay, p.status, p.prepared_by, p.reviewed_by, p.approved_by, p.locked_at
        FROM hr_payroll_records r JOIN hr_payroll_runs p ON p.period = r.year_month
        WHERE r.year_month = ? GROUP BY r.year_month, p.status, p.prepared_by, p.reviewed_by, p.approved_by, p.locked_at`).bind(month).first<PayrollSummaryRow>(),
    ]);
    return Response.json({
      summary: summary ? {
        yearMonth: summary.year_month,
        employeeCount: summary.employee_count,
        grossPay: summary.gross_pay,
        deductions: summary.deductions,
        netPay: summary.net_pay,
        status: summary.status,
        preparedBy: summary.prepared_by,
        reviewedBy: summary.reviewed_by,
        approvedBy: summary.approved_by,
        lockedAt: summary.locked_at,
      } : null,
      records: recordsResult.results.map(toRecord),
    });
  }

  // 임금계산 상태를 같이 내려보낸다. 목록에 있는데 임금안이 DRAFT 면 확정 뒤 다시 연 "수정 중"이다.
  const result = await db.prepare(`SELECT r.year_month, COUNT(*) AS employee_count,
    COALESCE(SUM(r.gross_pay), 0) AS gross_pay, COALESCE(SUM(r.deductions), 0) AS deductions,
    COALESCE(SUM(r.net_pay), 0) AS net_pay, p.status, p.prepared_by, p.reviewed_by, p.approved_by, p.locked_at,
    COALESCE(c.status, '') AS compensation_status
    FROM hr_payroll_records r JOIN hr_payroll_runs p ON p.period = r.year_month
    LEFT JOIN hr_compensation_runs c ON c.period = r.year_month
    GROUP BY r.year_month, p.status, p.prepared_by, p.reviewed_by, p.approved_by, p.locked_at, c.status
    ORDER BY r.year_month DESC`).all<PayrollSummaryRow>();

  return Response.json({ summaries: result.results.map((summary) => ({
    yearMonth: summary.year_month,
    employeeCount: summary.employee_count,
    grossPay: summary.gross_pay,
    deductions: summary.deductions,
    netPay: summary.net_pay,
    status: summary.status,
    preparedBy: summary.prepared_by,
    reviewedBy: summary.reviewed_by,
    approvedBy: summary.approved_by,
    lockedAt: summary.locked_at,
    compensationStatus: summary.compensation_status,
  })) });
}

export async function POST(request: Request) {
  await ensureSchema();
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  const body = await request.json() as {
    id?: unknown; deductions?: unknown; pay?: unknown; deductionDetail?: unknown; notes?: unknown;
  };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return Response.json({ error: "급여 기록을 찾을 수 없습니다." }, { status: 400 });

  // 공제는 항목별 내역(국민연금·건강보험·산재보험 …)으로 받는 것이 기본이고, 합계는 그 합이다.
  // 항목 없이 총액만 보내던 예전 호출도 그대로 받는다.
  const detailInput = body.deductionDetail && typeof body.deductionDetail === "object" && !Array.isArray(body.deductionDetail)
    ? body.deductionDetail as Record<string, unknown> : null;
  const detail: Record<string, number> = {};
  if (detailInput) {
    for (const [label, value] of Object.entries(detailInput)) {
      const name = label.trim();
      const amount = Math.round(Number(value));
      if (!name || !Number.isFinite(amount) || amount === 0) continue;
      detail[name] = (detail[name] ?? 0) + amount;
    }
  }
  // 빈 문자열은 Number("") === 0 이라 조용히 0 원이 됐다. 항목이 없으면 총액은 반드시 숫자로 와야 한다.
  if (!detailInput && (body.deductions === undefined || body.deductions === null || String(body.deductions).trim() === "")) {
    return Response.json({ error: "공제액을 숫자로 입력해 주세요." }, { status: 400 });
  }
  const deductions = detailInput ? Object.values(detail).reduce((sum, value) => sum + value, 0) : Math.round(Number(body.deductions));
  if (!Number.isFinite(deductions)) {
    return Response.json({ error: "공제액을 숫자로 입력해 주세요." }, { status: 400 });
  }

  await seedPayrollRecords();
  await syncPayrollRuns();
  const before = await db.prepare("SELECT * FROM hr_payroll_records WHERE id = ?").bind(id).first<PayrollRow>();
  if (!before) return Response.json({ error: "급여 기록을 찾을 수 없습니다." }, { status: 404 });
  const run = await db.prepare("SELECT status FROM hr_payroll_runs WHERE period = ?").bind(before.year_month).first<{ status: string }>();
  if (run && !["DRAFT", "REVIEW"].includes(run.status)) {
    return Response.json({ error: "승인 또는 마감된 급여월은 공제값을 수정할 수 없습니다. 먼저 작성 중으로 되돌려 주세요." }, { status: 409 });
  }

  // 지급 항목이 오면 그 값으로 갈아 끼우고, 오지 않은 항목은 기존 값을 그대로 둔다.
  // 지급총액은 따로 받지 않고 항목의 합으로만 만든다 — 합과 총액이 어긋나는 행이 생기지 않게.
  const PAY_FIELDS = [
    ["basePay", "base_pay"], ["mealAllowance", "meal_allowance"], ["childcareAllowance", "childcare_allowance"],
    ["vehicleAllowance", "vehicle_allowance"], ["incentive", "incentive"], ["bonus", "bonus"],
    ["annualLeavePay", "annual_leave_pay"], ["personalExpense", "personal_expense"], ["retirementPay", "retirement_pay"],
    ["nonTaxable", "non_taxable"], ["welfareFund", "welfare_fund"], ["cardUsage", "card_usage"],
    ["personalPurchase", "personal_purchase"], ["annualSalary", "annual_salary"],
  ] as const;
  const GROSS_FIELDS = new Set(["base_pay", "meal_allowance", "childcare_allowance", "vehicle_allowance",
    "incentive", "bonus", "annual_leave_pay", "personal_expense", "retirement_pay"]);
  const payInput = body.pay && typeof body.pay === "object" && !Array.isArray(body.pay)
    ? body.pay as Record<string, unknown> : null;
  const next: Record<string, number> = {};
  for (const [key, column] of PAY_FIELDS) {
    const raw = payInput?.[key];
    const value = raw === undefined ? Number((before as unknown as Record<string, number>)[column]) : Math.round(Number(raw));
    if (!Number.isFinite(value)) return Response.json({ error: `${key} 값을 숫자로 입력해 주세요.` }, { status: 400 });
    next[column] = value;
  }
  const grossPay = [...GROSS_FIELDS].reduce((sum, column) => sum + next[column], 0);
  const netPay = grossPay - deductions;
  const notes = typeof body.notes === "string" ? body.notes : before.notes;

  await db.prepare(`UPDATE hr_payroll_records SET base_pay = ?, meal_allowance = ?, childcare_allowance = ?,
      vehicle_allowance = ?, incentive = ?, bonus = ?, annual_leave_pay = ?, personal_expense = ?, retirement_pay = ?,
      non_taxable = ?, welfare_fund = ?, card_usage = ?, personal_purchase = ?, annual_salary = ?,
      deductions = ?, deduction_detail_json = ?, gross_pay = ?, net_pay = ?, notes = ? WHERE id = ?`)
    .bind(next.base_pay, next.meal_allowance, next.childcare_allowance, next.vehicle_allowance,
      next.incentive, next.bonus, next.annual_leave_pay, next.personal_expense, next.retirement_pay,
      next.non_taxable, next.welfare_fund, next.card_usage, next.personal_purchase, next.annual_salary,
      deductions, detailInput ? JSON.stringify(detail) : String(before.deduction_detail_json ?? "{}"),
      grossPay, netPay, notes, id).run();
  await syncPayrollRuns();
  const after = await db.prepare("SELECT * FROM hr_payroll_records WHERE id = ?").bind(id).first<PayrollRow>();
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PAYROLL_RECORD_UPDATED", entityType: "payrollRecord", entityId: id, before: toRecord(before), after: after ? toRecord(after) : null });
  return Response.json({ record: after ? toRecord(after) : null });
}

export async function PUT(request: Request) {
  // R3(D13, 부록 B #27): 상태 변경(승인·마감·재오픈)도 hr 편집이다. 본문을 읽기 전에 한 번만 인가한다.
  const authorization = await authorizeErpRequest(db, "hr", "write");
  if (authorization.response) return authorization.response;
  await ensureSchema();
  let body: { period?: unknown; status?: unknown; reopenedReason?: unknown };
  try {
    body = await request.json() as { period?: unknown; status?: unknown; reopenedReason?: unknown };
  } catch {
    return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "요청 내용을 읽을 수 없습니다." }, { status: 400 });
  const period = typeof body.period === "string" ? body.period.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!/^\d{4}-\d{2}$/.test(period) || !["DRAFT", "REVIEW", "APPROVED", "LOCKED"].includes(status)) {
    return Response.json({ error: "급여월과 처리 상태를 확인해 주세요." }, { status: 400 });
  }
  await syncPayrollRuns();
  const before = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
  if (!before) return Response.json({ error: "급여월을 찾을 수 없습니다." }, { status: 404 });
  const currentStatus = String(before.status ?? "DRAFT");
  const allowedTransitions: Record<string, string[]> = {
    // 작성 중에서 바로 마감 잠금까지 갈 수 있게 열어 둔다. 검토 요청·승인 단계는 남겨 두되 거쳐 갈 의무는 없다.
    DRAFT: ["DRAFT", "REVIEW", "LOCKED"],
    REVIEW: ["DRAFT", "REVIEW", "APPROVED", "LOCKED"],
    APPROVED: ["DRAFT", "APPROVED", "LOCKED"],
    LOCKED: ["DRAFT", "LOCKED"],
  };
  if (!(allowedTransitions[currentStatus] ?? []).includes(status)) {
    return Response.json({ error: `${currentStatus} 상태에서 ${status} 상태로 바로 변경할 수 없습니다.` }, { status: 409 });
  }
  if (status === currentStatus) return Response.json({ item: before });
  const now = Date.now();
  // 결재 없이 곧바로 반영한다(Design §12.2 흐름 4). 승인(APPROVED)도 일반 전이를 탄다.
  // 재무 지급 건은 더 만들거나 취소하지 않는다(D2-b, 재무 모듈 제거).
  const reopening = status === "DRAFT" && ["APPROVED", "LOCKED"].includes(currentStatus);
  const principal = authorization.principal;
  const reason = typeof body.reopenedReason === "string" ? body.reopenedReason.trim() : "";
  if (reopening) {
    if (!reason) return Response.json({ error: "승인·마감된 급여월을 다시 열려면 사유가 필요합니다." }, { status: 400 });
    // 재무에서 지급·전기가 시작된 과거 급여월은 이제 재무 쪽을 확인할 수 없으므로 정적 목록으로 막는다(§12.3).
    if (LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS.includes(period)) {
      return Response.json({ error: "재무에서 지급·전기된 과거 급여월은 다시 열 수 없습니다.", code: "LEGACY_PERIOD_LOCKED", period }, { status: 409 });
    }
  }
  // 검토 요청 상태에서 작성 중으로 되돌릴 때도 사유를 남긴다. 승인 근거가 바뀌는 일이라 승인·마감 되돌리기와 같은 기록이 필요하다.
  if (status === "DRAFT" && currentStatus === "REVIEW" && !reason) return Response.json({ error: "검토 요청을 되돌리려면 사유가 필요합니다." }, { status: 400 });
  const result = await db.batch(payrollRunTransition(db, {
    period, from: currentStatus, to: status, actorEmployeeId: principal.employeeId, now, reason,
  }));
  // 전이 검사와 UPDATE 사이에 다른 사람이 상태를 바꿨으면 한 행도 안 바뀐다.
  if (changedRows(result, 0) !== 1) return hrConflictResponse();
  const after = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
  const auditAction = status === "LOCKED" ? "PAYROLL_RUN_LOCKED" : reopening ? "PAYROLL_RUN_REOPENED" : "PAYROLL_RUN_STATUS_UPDATED";
  await writeErpAudit(db, { principal, module: "hr", action: auditAction, entityType: "payrollRun", entityId: period, before, after, reason });
  return Response.json({ item: after });
}
