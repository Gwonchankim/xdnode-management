// Runs the real route/auth/SQL code against disposable in-memory SQLite.
// Cloudflare storage and request headers are the only substituted services.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

let sqlite;
const runtime = { env: {}, headers: new Headers(), beforeBatch: null, forbiddenTables: null };
globalThis.__hrApiTestRuntime = runtime;
// forbidTableAccess(/pattern/) makes every read or write that names a matching table fail the way a
// fresh D1 database without those tables would ('no such table'). Schema bootstrap statements
// (CREATE / PRAGMA / the erp_approval_steps ALTER in ensureErpPlatformSchema) are still allowed, so
// a test can prove a route path no longer touches approval or finance tables at all.
const guard = sql => {
  if (!runtime.forbiddenTables || !runtime.forbiddenTables.test(sql)) return;
  if (/^\s*(CREATE|PRAGMA)\b/i.test(sql) || /^\s*ALTER TABLE erp_approval_steps\b/i.test(sql)) return;
  throw new Error(`no such table (forbidden in this test): ${sql.trim().slice(0, 120)}`);
};
const db = {
  prepare(sql) {
    let args = [];
    const statement = {
      sql,
      bind(...values) { args = values; return statement; },
      async all() { guard(sql); return { results: sqlite.prepare(sql).all(...args), success: true }; },
      async first(column) { guard(sql); const row = sqlite.prepare(sql).get(...args); return column ? row?.[column] ?? null : row ?? null; },
      async run() { return statement.execute(); },
      execute() { guard(sql); const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
    return statement;
  },
  async batch(statements) {
    if (runtime.beforeBatch) runtime.beforeBatch(statements, sqlite);
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
runtime.env.DB = db;
const objects = new Map();
runtime.env.HR_AUDIO = {
  async put(key, value, options) { objects.set(key, { value, options }); },
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  async get(key) {
    const object = objects.get(key);
    return object ? { body: object.value, httpMetadata: object.options?.httpMetadata,
      size: object.value.byteLength ?? object.value.size ?? 0,
      arrayBuffer: async () => object.value, writeHttpMetadata: headers => headers.set('Content-Type', object.options?.httpMetadata?.contentType ?? 'application/octet-stream') } : null;
  },
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 'server-only' is a virtual module in vinext (@vitejs/plugin-rsc rsc:validate-imports); no package is installed.
    if (['cloudflare:workers', 'next/headers', 'next/navigation', 'server-only'].includes(specifier)) return { url: `hr-test:${specifier}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(`${url.href}.ts`))) return nextResolve(`${url.href}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('hr-test:')) {
      const source = url.endsWith('server-only') ? 'export {};'
        : url.endsWith('cloudflare:workers') ? 'export const env = globalThis.__hrApiTestRuntime.env;'
        : url.endsWith('next/headers') ? 'export async function headers() { return globalThis.__hrApiTestRuntime.headers; }'
          : 'export function redirect(url) { throw new Error(`Unexpected redirect: ${url}`); }';
      return { format: 'module', source, shortCircuit: true };
    }
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

const { companyEmployees } = await import('../../app/hr-company-data.ts');
const { ensureErpPlatformSchema } = await import('../../app/erp-platform.ts');
const administrator = companyEmployees.find(employee => employee.id === 'gc.kim');

export async function resetDatabase({ migrate = false } = {}) {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  runtime.beforeBatch = null;
  runtime.forbiddenTables = null;
  objects.clear();
  for (const key of Object.keys(runtime.env)) if (!['DB', 'HR_AUDIO'].includes(key)) delete runtime.env[key];
  if (migrate) {
    const directory = new URL('../../drizzle/', import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
      for (const sql of readFileSync(new URL(file, directory), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) sqlite.exec(sql);
    }
  }
  await ensureErpPlatformSchema(db);
  setIdentity();
  return sqlite;
}
export function setIdentity(roles = ['SUPER_ADMIN']) {
  runtime.headers = new Headers(roles === null ? {} : {
    'oai-authenticated-user-id': 'hr-audit-test',
    'oai-authenticated-user-email': administrator.email,
  });
  if (sqlite && roles) sqlite.prepare('UPDATE erp_user_access SET roles_json=? WHERE employee_id=?').run(JSON.stringify(roles), administrator.id);
}
export function beforeBatch(callback) { runtime.beforeBatch = callback; }
export function forbidTableAccess(pattern) { runtime.forbiddenTables = pattern ?? null; }
/**
 * Calls a real route handler. `options.rawBody` sends an unparsed body (with `options.contentType`) so a
 * test can prove authorization happens before the body is read. JSON responses are parsed; anything else
 * (e.g. the plain-text document 404) comes back as text.
 */
export async function callApi(path, method = 'GET', body, query = '', options = {}) {
  const route = await import(`../../app/api/${path}/route.ts`);
  const init = options.rawBody !== undefined
    ? { headers: { 'Content-Type': options.contentType ?? 'application/json' }, body: options.rawBody }
    : body instanceof FormData ? { body } : body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const request = new Request(`http://audit.invalid/api/${path}${query}`, { method, ...init });
  const response = await route[method](request);
  if (response.status === 204) return { status: response.status, body: null };
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  return { status: response.status, body: isJson ? await response.json() : await response.text() };
}
export const callRoute = (name, ...args) => callApi(`hr/${name}`, ...args);
export { db, objects };
export const testBindings = runtime.env;
