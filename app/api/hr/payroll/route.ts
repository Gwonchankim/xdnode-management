import { env } from "cloudflare:workers";
import { ensureHrCompensationRunSchema } from "../../../hr-compensation-schema";
import { companyEmployees } from "../../../hr-company-data";
import { payrollSeedRecords } from "../../../payroll-seed-data";
import { createApprovalRequest } from "../../../approval-engine";
import { authorizeErpRequest, safeJson, writeErpAudit } from "../../../erp-platform";

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
    db.prepare(`CREATE TABLE IF NOT EXISTS finance_expense_requests (
      id TEXT PRIMARY KEY NOT NULL, request_kind TEXT NOT NULL DEFAULT 'EXPENSE', title TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, requested_date TEXT NOT NULL,
      due_date TEXT NOT NULL DEFAULT '', account_code TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER', memo TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'MANUAL', source_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'DRAFT',
      requester_employee_id TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '', approved_at INTEGER,
      paid_by TEXT NOT NULL DEFAULT '', paid_at INTEGER, journal_status TEXT NOT NULL DEFAULT 'UNPOSTED',
      evidence_required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
  const expenseColumns = await db.prepare("PRAGMA table_info(finance_expense_requests)").all<{ name: string }>();
  const existing = new Set(expenseColumns.results.map((column) => column.name));
  for (const [name, definition] of [
    ["source_type", "TEXT NOT NULL DEFAULT 'MANUAL'"], ["source_id", "TEXT NOT NULL DEFAULT ''"],
  ].filter(([name]) => !existing.has(name))) await db.prepare(`ALTER TABLE finance_expense_requests ADD COLUMN ${name} ${definition}`).run();
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
  await ensureSchema();
  const body = await request.json() as { period?: unknown; status?: unknown; reopenedReason?: unknown };
  const period = typeof body.period === "string" ? body.period.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!/^\d{4}-\d{2}$/.test(period) || !["DRAFT", "REVIEW", "APPROVED", "LOCKED"].includes(status)) {
    return Response.json({ error: "급여월과 처리 상태를 확인해 주세요." }, { status: 400 });
  }
  const action = status === "LOCKED" ? "approve" : "write";
  const authorization = await authorizeErpRequest(db, "hr", action);
  if (authorization.response) return authorization.response;
  await syncPayrollRuns();
  const before = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
  if (!before) return Response.json({ error: "급여월을 찾을 수 없습니다." }, { status: 404 });
  const currentStatus = String(before.status ?? "DRAFT");
  const allowedTransitions: Record<string, string[]> = {
    // 결재선을 태울 사람이 한 명뿐이라 작성 중에서 바로 마감 잠금까지 갈 수 있게 열어 둔다.
    // 검토 요청·승인 결재는 남겨 두되 거쳐 갈 의무는 없다.
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
  if (status === "APPROVED" && before.status !== "APPROVED") {
    if (before.status !== "REVIEW") return Response.json({ error: "검토 요청 상태의 급여월만 승인 결재를 요청할 수 있습니다." }, { status: 409 });
    const existing = await db.prepare(`SELECT id, status FROM erp_approval_requests
      WHERE target_entity_type = 'PAYROLL_RUN' AND target_entity_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(period).first<{ id: string; status: string }>();
    if (existing && ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED"].includes(existing.status)) return Response.json({ item: before, approvalSubmitted: true, approvalId: existing.id }, { status: 202 });
    const netPay = Number(before.net_pay ?? 0);
    const approval = await createApprovalRequest(db, authorization.principal, {
      module: "hr", requestType: "PAYROLL_RUN", title: `${period} 급여 승인`,
      description: `${Number(before.employee_count ?? 0)}명 · 실 지급액 ${netPay.toLocaleString("ko-KR")}원`,
      targetEntityType: "PAYROLL_RUN", targetEntityId: period, amount: netPay,
      metadata: { period, employeeCount: Number(before.employee_count ?? 0), grossPay: Number(before.gross_pay ?? 0), deductions: Number(before.deductions ?? 0), netPay },
    }) as { id: string; status: string; autoApproved?: boolean };
    if (approval.autoApproved) {
      const after = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
      await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PAYROLL_APPROVAL_AUTO_APPROVED", entityType: "payrollRun", entityId: period, before, after: { ...after, approvalId: approval.id } });
      return Response.json({ item: after, approvalSubmitted: false, autoApproved: true, approvalId: approval.id });
    }
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PAYROLL_APPROVAL_SUBMITTED", entityType: "payrollRun", entityId: period, before, after: approval });
    return Response.json({ item: before, approvalSubmitted: true, approvalId: approval.id }, { status: 202 });
  }
  const payrollExpenseId = `payroll:${period}`;
  if (status === "LOCKED") {
    const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const financeBefore = await db.prepare("SELECT * FROM finance_expense_requests WHERE id = ?").bind(payrollExpenseId).first<Record<string, unknown>>();
    const result = await db.batch([
      db.prepare(`UPDATE hr_payroll_runs SET status = 'LOCKED', prepared_by = CASE WHEN prepared_by = '' THEN ? ELSE prepared_by END,
        reviewed_by = CASE WHEN reviewed_by = '' THEN ? ELSE reviewed_by END, approved_by = ?, locked_at = ?, updated_at = ?
        WHERE period = ? AND status = ?`)
        .bind(authorization.principal.employeeId, authorization.principal.employeeId, authorization.principal.employeeId, now, now, period, currentStatus),
      db.prepare(`INSERT INTO finance_expense_requests
        (id, request_kind, title, vendor, amount, requested_date, due_date, account_code, account_name,
          payment_method, memo, source_type, source_id, status, requester_employee_id, approved_by, approved_at,
          paid_by, paid_at, journal_status, evidence_required, created_at, updated_at)
        SELECT ?, 'PAYMENT', ?, '임직원 급여', net_pay, ?, '', '', '급여(계정 확인 필요)', 'BANK_TRANSFER', ?,
          'PAYROLL_RUN', period, 'APPROVED', ?, ?, ?, '', NULL, 'UNPOSTED', 0, ?, ?
        FROM hr_payroll_runs WHERE period = ? AND status = 'LOCKED' AND updated_at = ?
        ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, requested_date=excluded.requested_date,
          memo=excluded.memo, status='APPROVED', requester_employee_id=excluded.requester_employee_id,
          approved_by=excluded.approved_by, approved_at=excluded.approved_at, paid_by='', paid_at=NULL,
          journal_status='UNPOSTED', updated_at=excluded.updated_at
        WHERE finance_expense_requests.status = 'CANCELLED'`)
        .bind(payrollExpenseId, `${period} 급여 지급`, koreaDate,
          `${Number(before.employee_count ?? 0)}명 · 총지급 ${Number(before.gross_pay ?? 0).toLocaleString("ko-KR")}원 · 공제 ${Number(before.deductions ?? 0).toLocaleString("ko-KR")}원`,
          authorization.principal.employeeId, authorization.principal.employeeId, now, now, now, period, now),
    ]);
    if ((result[0].meta.changes ?? 0) < 1 || (result[1].meta.changes ?? 0) < 1) return Response.json({ error: "급여월 또는 연결 지급 건의 상태가 변경되었습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
    const [after, financeAfter] = await Promise.all([
      db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>(),
      db.prepare("SELECT * FROM finance_expense_requests WHERE id = ?").bind(payrollExpenseId).first<Record<string, unknown>>(),
    ]);
    await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PAYROLL_RUN_LOCKED", entityType: "payrollRun", entityId: period, before, after });
    await writeErpAudit(db, { principal: authorization.principal, module: "finance", action: financeBefore ? "PAYROLL_PAYMENT_REACTIVATED" : "PAYROLL_PAYMENT_CREATED", entityType: "financeExpense", entityId: payrollExpenseId, before: financeBefore, after: financeAfter });
    return Response.json({ item: after, financeExpenseId: payrollExpenseId });
  }
  if (status === "DRAFT" && ["APPROVED", "LOCKED"].includes(String(before.status ?? ""))) {
    const approvalAuthorization = await authorizeErpRequest(db, "hr", "approve");
    if (approvalAuthorization.response) return approvalAuthorization.response;
    const reopenedReason = typeof body.reopenedReason === "string" ? body.reopenedReason.trim() : "";
    if (!reopenedReason) return Response.json({ error: "승인·마감된 급여월을 다시 열려면 사유가 필요합니다." }, { status: 400 });
    // finance_project_allocations 는 재무 "프로젝트·원가센터" 화면이 처음 열릴 때 만들어진다.
    // 그 화면을 한 번도 열지 않은 환경에서는 테이블이 없어 이 조회가 통째로 500 을 냈고,
    // 그 탓에 승인·마감된 급여월을 다시 여는 것 자체가 막혀 있었다.
    // 테이블이 없다는 것은 배부 자체가 없다는 뜻이므로 0 건으로 본다. 테이블이 있으면 종전과 같다.
    const allocationTable = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finance_project_allocations'",
    ).first<{ name: string }>();
    const projectAllocation = allocationTable
      ? await db.prepare(`SELECT COUNT(*) AS count FROM finance_project_allocations
          WHERE source_type = 'PAYROLL_RUN' AND source_id = ?`).bind(period).first<{ count: number }>()
      : { count: 0 };
    if (Number(projectAllocation?.count ?? 0) > 0) return Response.json({ error: "프로젝트 원가에 배부된 급여월입니다. 재무 담당자가 배부를 먼저 정정해야 다시 열 수 있습니다." }, { status: 409 });
    const financeBefore = await db.prepare("SELECT * FROM finance_expense_requests WHERE id = ?").bind(payrollExpenseId).first<Record<string, unknown>>();
    if (financeBefore && (financeBefore.status === "PAID" || !["UNPOSTED", ""].includes(String(financeBefore.journal_status ?? "")))) {
      return Response.json({ error: "이미 지급 또는 회계전표 처리가 시작되어 급여월을 다시 열 수 없습니다. 재무 취소·역분개 절차가 필요합니다." }, { status: 409 });
    }
    const result = await db.batch([
      db.prepare(`UPDATE hr_payroll_runs SET status = 'DRAFT', approved_by = '', locked_at = NULL,
        reopened_reason = ?, updated_at = ? WHERE period = ? AND status IN ('APPROVED','LOCKED')
          AND (NOT EXISTS (SELECT 1 FROM finance_expense_requests WHERE id = ?)
            OR EXISTS (SELECT 1 FROM finance_expense_requests WHERE id = ? AND status IN ('APPROVED','CANCELLED') AND journal_status = 'UNPOSTED'))`)
        .bind(reopenedReason, now, period, payrollExpenseId, payrollExpenseId),
      db.prepare(`UPDATE finance_expense_requests SET status = 'CANCELLED', updated_at = ?
        WHERE id = ? AND status = 'APPROVED' AND journal_status = 'UNPOSTED'
          AND EXISTS (SELECT 1 FROM hr_payroll_runs WHERE period = ? AND status = 'DRAFT' AND updated_at = ?)`)
        .bind(now, payrollExpenseId, period, now),
    ]);
    if ((result[0].meta.changes ?? 0) < 1) return Response.json({ error: "지급 상태가 변경되어 급여월을 다시 열지 못했습니다." }, { status: 409 });
    const after = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
    await writeErpAudit(db, { principal: approvalAuthorization.principal, module: "hr", action: "PAYROLL_RUN_REOPENED", entityType: "payrollRun", entityId: period, before, after, reason: reopenedReason });
    if (financeBefore) await writeErpAudit(db, { principal: approvalAuthorization.principal, module: "finance", action: "PAYROLL_PAYMENT_CANCELLED", entityType: "financeExpense", entityId: payrollExpenseId, before: financeBefore, after: { ...financeBefore, status: "CANCELLED" }, reason: reopenedReason });
    return Response.json({ item: after });
  }
  // 검토 요청 상태에서 작성 중으로 되돌릴 때도 사유를 남긴다. 결재 근거가 바뀌는 일이라 승인·마감 되돌리기와 같은 기록이 필요하다.
  const revertReason = typeof body.reopenedReason === "string" ? body.reopenedReason.trim() : "";
  if (status === "DRAFT" && currentStatus === "REVIEW" && !revertReason) return Response.json({ error: "검토 요청을 되돌리려면 사유가 필요합니다." }, { status: 400 });
  const transition = await db.prepare(`UPDATE hr_payroll_runs SET status = ?, prepared_by = CASE WHEN ? IN ('REVIEW','APPROVED','LOCKED') THEN ? ELSE prepared_by END,
    reviewed_by = CASE WHEN ? IN ('APPROVED','LOCKED') THEN ? ELSE reviewed_by END,
    approved_by = CASE WHEN ? IN ('APPROVED','LOCKED') THEN ? ELSE '' END,
    locked_at = CASE WHEN ? = 'LOCKED' THEN ? ELSE NULL END,
    reopened_reason = CASE WHEN ? = 'DRAFT' THEN ? ELSE reopened_reason END, updated_at = ? WHERE period = ? AND status = ?`)
    .bind(status, status, authorization.principal.employeeId, status, authorization.principal.employeeId,
      status, authorization.principal.employeeId, status, now, status,
      revertReason, now, period, currentStatus).run();
  // 전이 검사와 UPDATE 사이에 다른 사람이 상태를 바꿨으면 한 행도 안 바뀐다.
  if ((transition.meta.changes ?? 0) < 1) return Response.json({ error: "급여월 상태가 그 사이 바뀌었습니다. 새로고침 후 다시 시도해 주세요." }, { status: 409 });
  const after = await db.prepare("SELECT * FROM hr_payroll_runs WHERE period = ?").bind(period).first<Record<string, unknown>>();
  await writeErpAudit(db, { principal: authorization.principal, module: "hr", action: "PAYROLL_RUN_STATUS_UPDATED", entityType: "payrollRun", entityId: period, before, after, reason: typeof body.reopenedReason === "string" ? body.reopenedReason : "" });
  return Response.json({ item: after });
}
