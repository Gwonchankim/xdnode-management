import { env } from "cloudflare:workers";
import { authorizeErpRequest, writeErpAudit } from "../../../erp-platform";
import { ensureHrEmployeeRecordsSchema } from "../../../hr-employee-schema";
import { applyDuePersonnelActions } from "../../../hr-personnel-actions";
import { applyDueRetirements } from "../../../hr-retirements";
import { applyDueOnboarding } from "../../../hr-onboarding";
import { ensureEmployeeRosterSeeded } from "../../../hr-employee-roster";

type EmployeeRecordRow = {
  employee_id: string;
  name: string;
  birth: string;
  email: string;
  phone: string;
  address: string;
  department: string;
  manager: string;
  employment_type: string;
  join_date: string;
  position: string;
  job_title: string;
  status: string;
  history_json: string;
  retirement_json: string | null;
  annual_salary: number;
  base_pay: number;
  meal_allowance: number;
  childcare_allowance: number;
  vehicle_allowance: number;
  /** 첫 계약(3개월 기간제) 동안 기준 연봉의 몇 %를 주는지. 처우 제안 때 정해 입사 전환으로 넘어오고, 여기서 고칠 수 있다. */
  first_term_pay_percent: number | null;
  /** 3개월 첫 계약이 끝나 기간의 정함이 없는 계약을 맺은 날. 비어 있으면 아직 전환 전이다. */
  regular_contract_date: string | null;
  /** 첫 계약 근무평가와 결정(JSON). 대시보드의 전환 패널에서 기록한다. */
  first_term_review_json: string | null;
  updated_at: number;
};

type HrBindings = { DB: D1Database };
const db = (env as unknown as HrBindings).DB;

async function ensureSchema() {
  await ensureHrEmployeeRecordsSchema(db);
  await ensureEmployeeRosterSeeded(db);
}

function parseJson<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function toRecord(row: EmployeeRecordRow) {
  return {
    employeeId: row.employee_id,
    name: row.name,
    birth: row.birth,
    email: row.email,
    phone: row.phone,
    address: row.address,
    department: row.department,
    type: row.employment_type,
    joinDate: row.join_date,
    position: row.position,
    jobTitle: row.job_title,
    status: row.status,
    history: parseJson(row.history_json, []),
    retirement: parseJson(row.retirement_json, null),
    annualSalary: row.annual_salary,
    basePay: row.base_pay,
    mealAllowance: row.meal_allowance,
    childcareAllowance: row.childcare_allowance,
    vehicleAllowance: row.vehicle_allowance,
    firstTermPayPercent: row.first_term_pay_percent ?? 100,
    regularContractDate: row.regular_contract_date ?? "",
    firstTermReview: parseJson(row.first_term_review_json, null),
    updatedAt: row.updated_at,
  };
}

export async function GET() {
  const auth = await authorizeErpRequest(db, "hr", "read");
  if (auth.response) return auth.response;
  await ensureSchema();
  await applyDuePersonnelActions(db);
  await applyDueRetirements(db);
  await applyDueOnboarding(db);
  const result = await db.prepare(`SELECT employee_id, name, birth, email, phone, address,
    department, manager, employment_type, join_date, position, job_title, status, history_json, retirement_json,
    annual_salary, base_pay, meal_allowance, childcare_allowance, vehicle_allowance, first_term_pay_percent, regular_contract_date, first_term_review_json, updated_at
    FROM hr_employee_records ORDER BY employee_id`).all<EmployeeRecordRow>();

  // 퇴직일과 사유는 retirement_json 이 아니라 hr_retirement_requests 에 있다. 화면은 employee.retirement
  // 하나만 보므로 여기서 합쳐 준다. 이게 없으면 퇴직 절차 팝업의 퇴직일이 기본값으로 보이고,
  // 대시보드도 "누가 언제 나가는지"를 알 수 없다.
  type RetirementRequestRow = { employee_id: string; id: string; retirement_date: string; reason: string; status: string };
  let requestRows: RetirementRequestRow[] = [];
  try {
    // 퇴직 요청 테이블은 입·퇴사 관리 라우트가 처음 돌 때 만들어진다. 아직 없을 수도 있다.
    const requests = await db.prepare(`SELECT employee_id, id, retirement_date, reason, status
      FROM hr_retirement_requests ORDER BY created_at`).all<RetirementRequestRow>();
    requestRows = requests.results;
  } catch { requestRows = []; }
  const byEmployee = new Map(requestRows.map((row) => [row.employee_id, row]));
  const records = result.results.map(toRecord).map((record) => {
    const request = byEmployee.get(record.employeeId);
    if (!request) return record;
    const retirement = (record.retirement ?? {}) as Record<string, unknown>;
    return { ...record, retirement: {
      ...retirement,
      requestId: retirement.requestId ?? request.id,
      date: retirement.date ?? request.retirement_date,
      reason: retirement.reason ?? request.reason,
      status: retirement.status ?? request.status,
    } };
  });
  return Response.json({ records });
}

export async function PUT(request: Request) {
  const auth = await authorizeErpRequest(db, "hr", "write");
  if (auth.response) return auth.response;
  await ensureSchema();
  const body = await request.json() as Record<string, unknown>;
  const stringValue = (key: string) => typeof body[key] === "string" ? String(body[key]) : "";
  const employeeId = stringValue("employeeId").trim();
  const name = stringValue("name").trim();

  if (!employeeId || !name) {
    return Response.json({ error: "직원 ID와 이름이 필요합니다." }, { status: 400 });
  }

  // 부분 수정 호출이 급여 기준값을 0 으로 지우지 않도록, 보내지 않은 항목은 저장된 값을 그대로 쓴다.
  const existing = await db.prepare("SELECT * FROM hr_employee_records WHERE employee_id = ?").bind(employeeId).first<EmployeeRecordRow>();
  const retainedString = (key: string, stored: string | null | undefined) => body[key] === undefined ? stored ?? "" : stringValue(key);
  const retainedJson = (stored: string | null | undefined, fallback: unknown) => {
    try { return stored ? JSON.parse(stored) : fallback; } catch { return fallback; }
  };
  const record = {
    employeeId,
    name,
    birth: retainedString("birth", existing?.birth),
    email: retainedString("email", existing?.email),
    phone: retainedString("phone", existing?.phone),
    address: retainedString("address", existing?.address),
    department: retainedString("department", existing?.department),
    type: retainedString("type", existing?.employment_type),
    joinDate: retainedString("joinDate", existing?.join_date),
    position: retainedString("position", existing?.position),
    jobTitle: retainedString("jobTitle", existing?.job_title),
    status: retainedString("status", existing?.status) || "재직",
    history: body.history === undefined ? retainedJson(existing?.history_json, []) : Array.isArray(body.history) ? body.history : [],
    retirement: body.retirement === undefined ? retainedJson(existing?.retirement_json, null) : body.retirement && typeof body.retirement === "object" ? body.retirement : null,
    annualSalary: existing?.annual_salary ?? 0,
    basePay: existing?.base_pay ?? 0,
    mealAllowance: existing?.meal_allowance ?? 0,
    childcareAllowance: existing?.childcare_allowance ?? 0,
    vehicleAllowance: existing?.vehicle_allowance ?? 0,
    firstTermPayPercent: existing?.first_term_pay_percent ?? 100,
    regularContractDate: body.regularContractDate === undefined ? (existing?.regular_contract_date ?? "")
      : /^\d{4}-\d{2}-\d{2}$/.test(stringValue("regularContractDate")) ? stringValue("regularContractDate") : "",
    firstTermReview: body.firstTermReview === undefined ? retainedJson(existing?.first_term_review_json, null) : body.firstTermReview && typeof body.firstTermReview === "object" ? body.firstTermReview as Record<string, unknown> : null,
    updatedAt: Date.now(),
  };
  for (const [source, target] of [["annualSalary", "annualSalary"], ["basePay", "basePay"], ["mealAllowance", "mealAllowance"], ["childcareAllowance", "childcareAllowance"], ["vehicleAllowance", "vehicleAllowance"]] as const) {
    if (body[source] === undefined) continue;
    const value = Number(body[source] ?? 0);
    if (!Number.isFinite(value) || value < 0) return Response.json({ error: "연봉·기본급과 수당은 0원 이상으로 입력해 주세요." }, { status: 400 });
    record[target] = Math.round(value);
  }
  // 첫 계약 지급률. 비워 보내면 100 으로 두고, 값이 있으면 1~100 정수여야 한다.
  if (body.firstTermPayPercent !== undefined && body.firstTermPayPercent !== null && body.firstTermPayPercent !== "") {
    const percent = Number(body.firstTermPayPercent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return Response.json({ error: "첫 계약 지급률은 1~100 사이의 정수로 입력해 주세요." }, { status: 400 });
    record.firstTermPayPercent = percent;
  }

  const before = await db.prepare(`SELECT employee_id, name, birth, email, phone, address,
    department, manager, employment_type, join_date, position, job_title, status, history_json, retirement_json,
    annual_salary, base_pay, meal_allowance, childcare_allowance, vehicle_allowance, first_term_pay_percent, regular_contract_date, first_term_review_json, updated_at
    FROM hr_employee_records WHERE employee_id = ?`).bind(employeeId).first<EmployeeRecordRow>();

  // manager 컬럼은 예전에 조직장 이름을 스냅샷으로 담던 자리다. 조직장은 hr_organization_leaders 가 기준이라 화면에 주지도,
  // 덮어쓰지도 않는다. 새 행에는 빈값을 넣고 기존 값은 그대로 둔다(NOT NULL 제약 때문에 컬럼 자체는 남긴다).
  await db.prepare(`INSERT INTO hr_employee_records
    (employee_id, name, birth, email, phone, address, department, manager, employment_type, join_date,
      position, job_title, status, history_json, retirement_json, annual_salary, base_pay, meal_allowance,
      childcare_allowance, vehicle_allowance, first_term_pay_percent, regular_contract_date, first_term_review_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET
      name = excluded.name,
      birth = excluded.birth,
      email = excluded.email,
      phone = excluded.phone,
      address = excluded.address,
      department = excluded.department,
      employment_type = excluded.employment_type,
      join_date = excluded.join_date,
      position = excluded.position,
      job_title = excluded.job_title,
      status = excluded.status,
      history_json = excluded.history_json,
      retirement_json = excluded.retirement_json,
      annual_salary = excluded.annual_salary,
      base_pay = excluded.base_pay,
      meal_allowance = excluded.meal_allowance,
      childcare_allowance = excluded.childcare_allowance,
      vehicle_allowance = excluded.vehicle_allowance,
      first_term_pay_percent = excluded.first_term_pay_percent,
      regular_contract_date = excluded.regular_contract_date,
      first_term_review_json = excluded.first_term_review_json,
      updated_at = excluded.updated_at`)
    .bind(record.employeeId, record.name, record.birth, record.email, record.phone, record.address,
      record.department, "", record.type, record.joinDate, record.position, record.jobTitle,
      record.status, JSON.stringify(record.history), record.retirement ? JSON.stringify(record.retirement) : null,
      record.annualSalary, record.basePay, record.mealAllowance, record.childcareAllowance, record.vehicleAllowance, record.firstTermPayPercent, record.regularContractDate, record.firstTermReview ? JSON.stringify(record.firstTermReview) : null, record.updatedAt)
    .run();

  await writeErpAudit(db, {
    principal: auth.principal,
    module: "hr",
    action: before ? "UPDATE" : "CREATE",
    entityType: "EMPLOYEE_RECORD",
    entityId: employeeId,
    before: before ? toRecord(before) : undefined,
    after: record,
  });
  return Response.json({ record });
}
