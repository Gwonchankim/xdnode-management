/** hr_employee_records 표의 단일 정의.
 *
 *  예전에는 HR 라우트 8곳이 각자 CREATE TABLE 과 ALTER 보강을 들고 있었고, 열 목록이 서로 달랐다(급여 열이 없는
 *  16열 정의와 24열 정의가 섞여 있었음). 어느 라우트가 먼저 뜨느냐에 따라 표 모양이 달라져 SELECT 가 깨질 수 있어
 *  (docs/hr-compensation-audit-2026-09-21.md 스키마 항목) 여기로 모았다. 열을 더할 때는 CREATE 와 ADDITIONS 둘 다 고친다:
 *  CREATE 는 새 DB 용, ADDITIONS 는 이미 만들어진 표 보강용이다. */

export const HR_EMPLOYEE_RECORDS_CREATE = `CREATE TABLE IF NOT EXISTS hr_employee_records (
  employee_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  birth TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  department TEXT NOT NULL,
  manager TEXT NOT NULL,
  employment_type TEXT NOT NULL,
  join_date TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL,
  job_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '재직',
  history_json TEXT NOT NULL DEFAULT '[]',
  retirement_json TEXT,
  annual_salary INTEGER NOT NULL DEFAULT 0,
  base_pay INTEGER NOT NULL DEFAULT 0,
  meal_allowance INTEGER NOT NULL DEFAULT 0,
  childcare_allowance INTEGER NOT NULL DEFAULT 0,
  vehicle_allowance INTEGER NOT NULL DEFAULT 0,
  first_term_pay_percent INTEGER NOT NULL DEFAULT 100,
  regular_contract_date TEXT NOT NULL DEFAULT '',
  first_term_review_json TEXT,
  updated_at INTEGER NOT NULL
)`;

/** 나중에 붙은 열. 이미 만들어진 표에 없으면 ALTER 로 더한다. 순서는 붙인 순서. */
export const HR_EMPLOYEE_RECORDS_ADDITIONS: ReadonlyArray<readonly [name: string, definition: string]> = [
  ["join_date", "TEXT NOT NULL DEFAULT ''"],
  ["status", "TEXT NOT NULL DEFAULT '재직'"],
  ["history_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["retirement_json", "TEXT"],
  ["annual_salary", "INTEGER NOT NULL DEFAULT 0"],
  ["base_pay", "INTEGER NOT NULL DEFAULT 0"],
  ["meal_allowance", "INTEGER NOT NULL DEFAULT 0"],
  ["childcare_allowance", "INTEGER NOT NULL DEFAULT 0"],
  ["vehicle_allowance", "INTEGER NOT NULL DEFAULT 0"],
  ["first_term_pay_percent", "INTEGER NOT NULL DEFAULT 100"],
  ["regular_contract_date", "TEXT NOT NULL DEFAULT ''"],
  ["first_term_review_json", "TEXT"],
];

/** 표를 만들고(없을 때) 빠진 열을 보강한다. 각 HR 라우트의 ensureSchema() 첫머리에서 부른다. 멱등. */
export async function ensureHrEmployeeRecordsSchema(db: D1Database) {
  await db.prepare(HR_EMPLOYEE_RECORDS_CREATE).run();
  const columns = await db.prepare("PRAGMA table_info(hr_employee_records)").all<{ name: string }>();
  const existing = new Set(columns.results.map((column) => column.name));
  for (const [name, definition] of HR_EMPLOYEE_RECORDS_ADDITIONS) {
    if (existing.has(name)) continue;
    try {
      await db.prepare(`ALTER TABLE hr_employee_records ADD COLUMN ${name} ${definition}`).run();
    } catch (error) {
      // 여러 라우트가 동시에 처음 열리면 다른 요청이 같은 열을 먼저 추가할 수 있다.
      const latest = await db.prepare("PRAGMA table_info(hr_employee_records)").all<{ name: string }>();
      if (!latest.results.some((column) => column.name === name)) throw error;
    }
  }
}
