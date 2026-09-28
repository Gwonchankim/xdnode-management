/** An unused HR module may not have created its tables yet. Other errors still propagate. */
export async function hrTablesExist(db: D1Database, ...names: string[]) {
  const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(',')})`)
    .bind(...names).all<{ name: string }>();
  return result.results.length === names.length;
}

export async function readOptionalHrRows<T>(db: D1Database, names: string[], sql: string, ...values: (string | number)[]): Promise<{ results: T[] }> {
  if (!await hrTablesExist(db, ...names)) return { results: [] };
  return db.prepare(sql).bind(...values).all<T>();
}
