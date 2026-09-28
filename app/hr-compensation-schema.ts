export async function ensureHrCompensationRunSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS hr_compensation_runs (
      period TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', version INTEGER NOT NULL DEFAULT 1,
      employee_count INTEGER NOT NULL DEFAULT 0, gross_pay INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL,
      confirmed_by TEXT NOT NULL DEFAULT '', confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
}
