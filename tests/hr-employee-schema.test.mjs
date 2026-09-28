import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureHrEmployeeRecordsSchema } from "../app/hr-employee-schema.ts";

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = {
    prepare(sql) {
      return {
        async run() { return sqlite.prepare(sql).run(); },
        async all() { return { results: sqlite.prepare(sql).all() }; },
      };
    },
  };
  return { sqlite, db };
}

test("employee schema creates a complete table on a fresh database and can run repeatedly", async (t) => {
  const { sqlite, db } = database(t);
  await ensureHrEmployeeRecordsSchema(db);
  const before = sqlite.prepare("PRAGMA table_info(hr_employee_records)").all();
  await ensureHrEmployeeRecordsSchema(db);
  assert.deepEqual(sqlite.prepare("PRAGMA table_info(hr_employee_records)").all(), before);
  assert.equal(before.length, 24);
  for (const name of ["annual_salary", "base_pay", "vehicle_allowance", "first_term_pay_percent", "regular_contract_date", "first_term_review_json"]) {
    assert.ok(before.some((column) => column.name === name), name);
  }
});

test("employee schema upgrades an older table without changing employee records", async (t) => {
  const { sqlite, db } = database(t);
  sqlite.exec("CREATE TABLE hr_employee_records (employee_id TEXT PRIMARY KEY, name TEXT, annual_salary INTEGER)");
  sqlite.prepare("INSERT INTO hr_employee_records VALUES (?, ?, ?)").run("employee-1", "Existing employee", 44000000);
  await ensureHrEmployeeRecordsSchema(db);
  await ensureHrEmployeeRecordsSchema(db);
  const row = sqlite.prepare("SELECT * FROM hr_employee_records").get();
  assert.equal(row.employee_id, "employee-1");
  assert.equal(row.name, "Existing employee");
  assert.equal(row.annual_salary, 44000000);
  assert.equal(row.base_pay, 0);
  assert.equal(row.first_term_pay_percent, 100);
  assert.equal(row.history_json, "[]");
  assert.equal(row.first_term_review_json, null);
});

test("simultaneous HR requests can safely add missing employee columns", async (t) => {
  const { sqlite, db } = database(t);
  sqlite.exec("CREATE TABLE hr_employee_records (employee_id TEXT PRIMARY KEY)");
  await Promise.all([ensureHrEmployeeRecordsSchema(db), ensureHrEmployeeRecordsSchema(db)]);
  const columns = sqlite.prepare("PRAGMA table_info(hr_employee_records)").all();
  assert.ok(columns.some((column) => column.name === "first_term_review_json"));
  assert.equal(new Set(columns.map((column) => column.name)).size, columns.length);
});

test("schema failures are propagated when a missing column was not added", async () => {
  const failure = new Error("database is read-only");
  const db = {
    prepare(sql) {
      return {
        async run() { if (sql.startsWith("ALTER TABLE")) throw failure; },
        async all() { return { results: [] }; },
      };
    },
  };
  await assert.rejects(ensureHrEmployeeRecordsSchema(db), (error) => error === failure);
});
