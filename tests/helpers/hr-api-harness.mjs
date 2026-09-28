// Runs the real route/auth/SQL code against disposable in-memory SQLite.
// Cloudflare storage and request headers are the only substituted services.
// R3(r3-auth, Design §8.5): the caller's identity is a real session cookie for a seeded account, checked by the real
// session lookup. setAccess(tabs, opts) changes that account's grants; setIdentity(roles) is a temporary shim over it.
import { registerHooks } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

let sqlite;
// headers() inside a route returns the per-call headers (request headers + defaults) of the callApi that invoked it,
// so concurrent calls (Promise.all) each see their own cookie and peer. Outside callApi it falls back to runtime.headers.
const requestScope = new AsyncLocalStorage();
const runtime = { env: {}, headers: new Headers(), beforeBatch: null, forbiddenTables: null, requestScope };
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
      // next/headers: only headers() exists. cookies() is deliberately absent (Design §10.2).
      const source = url.endsWith('server-only') ? 'export {};'
        : url.endsWith('cloudflare:workers') ? 'export const env = globalThis.__hrApiTestRuntime.env;'
        : url.endsWith('next/headers') ? 'export async function headers() { const r = globalThis.__hrApiTestRuntime; return r.requestScope.getStore() ?? r.headers; }'
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
const { ensureErpPlatformSchema, resetPlatformSchemaGate } = await import('../../app/erp-platform.ts');
const { hashPassword } = await import('../../app/auth-password.ts');
const administrator = companyEmployees.find(employee => employee.id === 'gc.kim');

export const TEST_ADMIN_ACCOUNT_ID = 'acct_test_admin';
export const TEST_ADMIN_EMAIL = administrator.email.toLowerCase();
export const TEST_ADMIN_PASSWORD = 'Harness-admin-pw-1';
/** 43 characters of base64url, like a real token. The DB only ever holds its SHA-256. */
export const TEST_SESSION_TOKEN = 'harnessSessionToken_0123456789abcdefghijklm';
export const DEFAULT_PEER = '192.0.2.10';
const sha256 = value => createHash('sha256').update(value).digest('hex');
let adminHash;
const originalNow = Date.now;
const defaults = { cookie: null, peer: DEFAULT_PEER };

function baseHeaders() {
  const headers = new Headers({ host: 'audit.invalid', origin: 'http://audit.invalid' });
  if (defaults.cookie) headers.set('cookie', `xdm_session=${defaults.cookie}`);
  if (defaults.peer !== null) headers.set('x-xdm-peer', defaults.peer);
  return headers;
}
function refreshHeaders() { runtime.headers = baseHeaders(); }

export async function resetDatabase({ migrate = false } = {}) {
  sqlite?.close();
  resetPlatformSchemaGate();
  sqlite = new DatabaseSync(':memory:');
  runtime.beforeBatch = null;
  runtime.forbiddenTables = null;
  Date.now = originalNow;
  objects.clear();
  for (const key of Object.keys(runtime.env)) if (!['DB', 'HR_AUDIO'].includes(key)) delete runtime.env[key];
  // Never let a test reach the desktop's live AI bridges (127.0.0.1:3120/3130). Port 9 is closed, so an authorized
  // call fails fast with the route's own 502. A test that needs a bridge stubs fetch or sets its own URL.
  runtime.env.CLAUDE_BRIDGE_URL = 'http://127.0.0.1:9';
  runtime.env.CLAUDE_ASSISTANT_BRIDGE_URL = 'http://127.0.0.1:9';
  if (migrate) {
    const directory = new URL('../../drizzle/', import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
      for (const sql of readFileSync(new URL(file, directory), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) sqlite.exec(sql);
    }
  }
  await ensureErpPlatformSchema(db);
  adminHash ??= await hashPassword(TEST_ADMIN_PASSWORD);
  const now = Date.now();
  // The seeded administrator keeps gc.kim's email, name and employee link so fixed owner values in older tests still hold.
  sqlite.prepare(`INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password,
    failed_attempts, locked_until, tabs_json, password_changed_at, last_login_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'gc.kim', 1, 1, 0, 0, NULL, '{}', ?, NULL, 'bootstrap', ?, ?)`)
    .run(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_EMAIL, administrator.name, adminHash, now, now, now);
  sqlite.prepare(`INSERT INTO auth_sessions (id, account_id, created_at, expires_at, last_seen_at, revoked_at, revoked_reason, peer, user_agent)
    VALUES (?, ?, ?, ?, ?, NULL, '', ?, 'harness')`).run(sha256(TEST_SESSION_TOKEN), TEST_ADMIN_ACCOUNT_ID, now, now + 2_592_000_000, now, DEFAULT_PEER);
  defaults.cookie = TEST_SESSION_TOKEN;
  defaults.peer = DEFAULT_PEER;
  refreshHeaders();
  return sqlite;
}

/**
 * Makes the seeded test account the caller with the given grants. `tabs` is { hr?, compensation? } with 'view' | 'edit'.
 * null signs out (no cookie). The account stays linked to gc.kim unless `employeeId` says otherwise (null = unlinked).
 */
export function setAccess(tabs, { isAdmin = false, employeeId = 'gc.kim', mustChangePassword = false } = {}) {
  if (tabs === null) { defaults.cookie = null; refreshHeaders(); return; }
  const stored = Object.fromEntries(Object.entries(tabs ?? {}).filter(([, level]) => level === 'view' || level === 'edit'));
  sqlite.prepare(`UPDATE auth_accounts SET is_admin = ?, tabs_json = ?, employee_id = ?, must_change_password = ?, active = 1,
    failed_attempts = 0, locked_until = NULL WHERE id = ?`)
    .run(isAdmin ? 1 : 0, JSON.stringify(stored), employeeId, mustChangePassword ? 1 : 0, TEST_ADMIN_ACCOUNT_ID);
  sqlite.prepare(`UPDATE auth_sessions SET revoked_at = NULL, revoked_reason = '', expires_at = ? WHERE id = ?`)
    .run(Date.now() + 2_592_000_000, sha256(TEST_SESSION_TOKEN));
  defaults.cookie = TEST_SESSION_TOKEN;
  refreshHeaders();
}

/**
 * Temporary shim (r3-auth ~ r3-tabs, Design §8.5 / Appendix B #20): maps the old role names onto tab grants.
 * r3-tabs moves the remaining callers to setAccess and deletes this function.
 */
export function setIdentity(roles = ['SUPER_ADMIN']) {
  if (roles === null) return setAccess(null);
  if (roles.includes('SUPER_ADMIN')) return setAccess({}, { isAdmin: true });
  const rank = { none: 0, view: 1, edit: 2 };
  const grants = { HR_ADMIN: { hr: 'edit', compensation: 'edit' }, RECRUITER: { hr: 'edit' }, VIEWER: { hr: 'view', compensation: 'view' } };
  const tabs = {};
  for (const role of roles) for (const [tab, level] of Object.entries(grants[role] ?? {})) if (rank[level] > rank[tabs[tab] ?? 'none']) tabs[tab] = level;
  return setAccess(tabs);
}

/** Inserts an account directly (the admin API is tested separately). Returns { id, email, password }. */
export async function createAccount({ email, displayName = 'Synthetic Account', password = 'Synthetic-pw-1', isAdmin = false, tabs = {},
  employeeId = null, mustChangePassword = false, active = true, id } = {}) {
  const accountId = id ?? `acct_test_${Math.random().toString(36).slice(2, 10)}`;
  const address = (email ?? `${accountId}@example.test`).toLowerCase();
  const now = Date.now();
  sqlite.prepare(`INSERT INTO auth_accounts (id, email, display_name, password_hash, employee_id, is_admin, active, must_change_password,
    failed_attempts, locked_until, tabs_json, password_changed_at, last_login_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, 'harness', ?, ?)`)
    .run(accountId, address, displayName, await hashPassword(password), employeeId, isAdmin ? 1 : 0, active ? 1 : 0, mustChangePassword ? 1 : 0,
      JSON.stringify(tabs), now, now);
  return { id: accountId, email: address, password };
}

/** Calls the real login route without a session cookie. `cookie` is the issued session token (or null). */
export async function login(email, password, { peer, headers = {} } = {}) {
  const extra = { ...headers };
  if (peer !== undefined) extra['x-xdm-peer'] = peer;
  const result = await callApi('auth/login', 'POST', { email, password }, '', { headers: extra, cookie: null });
  const cookie = result.setCookies.map(value => /^xdm_session=([^;]*)/.exec(value)?.[1]).find(Boolean) ?? null;
  return { ...result, cookie };
}
/** Sends later calls with this session token (null = no cookie). */
export function setSessionCookie(token) { defaults.cookie = token; refreshHeaders(); }
/** Default x-xdm-peer for later calls. null = no header, which peerOf() treats as non-loopback. */
export function setPeer(address) { defaults.peer = address; refreshHeaders(); }
/** Fixes Date.now (lock expiry, session lifetime). null restores the real clock. resetDatabase also restores it. */
export function setClock(ms) { Date.now = ms === null ? originalNow : () => ms; }
export function beforeBatch(callback) { runtime.beforeBatch = callback; }
export function forbidTableAccess(pattern) { runtime.forbiddenTables = pattern ?? null; }
/**
 * Calls a real route handler. `options.rawBody` sends an unparsed body (with `options.contentType`) so a
 * test can prove authorization happens before the body is read. `options.headers` go on both the Request and
 * what headers() returns (a null value removes a default); `options.cookie` overrides the session token for this
 * call (null = none). JSON responses are parsed; anything else (e.g. the plain-text document 404) comes back as text.
 */
export async function callApi(path, method = 'GET', body, query = '', options = {}) {
  const route = await import(`../../app/api/${path}/route.ts`);
  const init = options.rawBody !== undefined
    ? { headers: { 'Content-Type': options.contentType ?? 'application/json' }, body: options.rawBody }
    : body instanceof FormData ? { body } : body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const request = new Request(`http://audit.invalid/api/${path}${query}`, { method, ...init });
  const scoped = baseHeaders();
  if (options.cookie !== undefined) {
    if (options.cookie === null) scoped.delete('cookie'); else scoped.set('cookie', `xdm_session=${options.cookie}`);
  }
  for (const [name, value] of request.headers) scoped.set(name, value);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) { scoped.delete(name); request.headers.delete(name); continue; }
    scoped.set(name, value);
    try { request.headers.set(name, value); } catch { /* forbidden on a Request (e.g. host); headers() still carries it */ }
  }
  const response = await requestScope.run(scoped, () => route[method](request));
  const setCookies = response.headers.getSetCookie();
  if (response.status === 204) return { status: response.status, body: null, headers: response.headers, setCookies, response };
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  return { status: response.status, body: isJson ? await response.json() : await response.text(), headers: response.headers, setCookies, response };
}
export const callRoute = (name, ...args) => callApi(`hr/${name}`, ...args);
export { db, objects };
export const testBindings = runtime.env;
