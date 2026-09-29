// R4(r4-backup, Design §4.2.6 GET /api/admin/backups, §5.4 백업 경고, §11.5.8 백업 4·5단계, 부록 C #6).
// 1) 실제 라우트를 메모리 SQLite 에서 돌려 stale·lastRun·권한을 본다.
// 2) scripts/verify-state-snapshot.mjs 의 검사·기록 모드를 임시 폴더의 가짜 state 로 실제 프로세스로 돌린다(운영 파일을 열지 않는다).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resetDatabase, callApi, setAccess, setClock } from './helpers/hr-api-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifyScript = path.join(root, 'scripts', 'verify-state-snapshot.mjs');
const { backupRunRow, OPS_BACKUP_RUNS_DDL } = await import('../scripts/verify-state-snapshot.mjs');

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 29, 3, 30);
const insertRun = (sql, row) => sql.prepare(`INSERT INTO ops_backup_runs (id, started_at, finished_at, status, backup_dir, integrity, r2_object_count, row_counts_json, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.started_at, row.finished_at, row.status, row.backup_dir, row.integrity, row.r2_object_count, row.row_counts_json, row.error);
const okRun = (id, finishedAt) => ({ id, started_at: finishedAt - 60_000, finished_at: finishedAt, status: 'OK', backup_dir: `C:\\xdm\\backup\\${id}\\`, integrity: 'ok', r2_object_count: 3, row_counts_json: '{}', error: '' });
const failedRun = (id, finishedAt, error) => ({ ...okRun(id, finishedAt), status: 'FAILED', integrity: '', error });

test('the platform gate creates ops_backup_runs with the shared DDL', async () => {
  const sql = await resetDatabase();
  const table = sql.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ops_backup_runs'").get();
  assert.ok(table, 'ops_backup_runs is missing');
  assert.equal(table.sql, OPS_BACKUP_RUNS_DDL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'));
  assert.ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ops_backup_runs_finished'").get());
  assert.throws(() => insertRun(sql, { ...okRun('2026-09-29', NOW), status: 'DONE' }), /CHECK constraint/);
});

test('GET /api/admin/backups: no run yet is stale with no last run', async () => {
  await resetDatabase();
  setAccess({}, { isAdmin: true });
  const result = await callApi('admin/backups');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { lastSuccessAt: null, lastRun: null, stale: true });
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('GET /api/admin/backups: a success within 36 hours is fresh; older than 36 hours is stale', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  insertRun(sql, okRun('2026-09-28', NOW - 24 * HOUR));
  insertRun(sql, okRun('2026-09-29', NOW - 1 * HOUR));
  setClock(NOW);
  let body = (await callApi('admin/backups')).body;
  assert.deepEqual(body, { lastSuccessAt: NOW - HOUR, lastRun: { id: '2026-09-29', status: 'OK', finishedAt: NOW - HOUR, error: '' }, stale: false });
  setClock(NOW - HOUR + 36 * HOUR);
  assert.equal((await callApi('admin/backups')).body.stale, false, 'exactly 36h is not yet stale');
  setClock(NOW - HOUR + 36 * HOUR + 1);
  body = (await callApi('admin/backups')).body;
  assert.equal(body.stale, true);
  assert.equal(body.lastSuccessAt, NOW - HOUR);
});

test('GET /api/admin/backups: a failed last run is reported with its error while the last success stays', async () => {
  const sql = await resetDatabase();
  setAccess({}, { isAdmin: true });
  insertRun(sql, okRun('2026-09-28', NOW - 25 * HOUR));
  insertRun(sql, failedRun('2026-09-29', NOW - HOUR, '사본의 integrity_check 가 ok 가 아닙니다.'));
  setClock(NOW);
  let body = (await callApi('admin/backups')).body;
  assert.equal(body.stale, false);
  assert.equal(body.lastSuccessAt, NOW - 25 * HOUR);
  assert.deepEqual(body.lastRun, { id: '2026-09-29', status: 'FAILED', finishedAt: NOW - HOUR, error: '사본의 integrity_check 가 ok 가 아닙니다.' });
  // 실패만 있으면 stale 이다.
  sql.prepare("DELETE FROM ops_backup_runs WHERE status = 'OK'").run();
  body = (await callApi('admin/backups')).body;
  assert.equal(body.stale, true);
  assert.equal(body.lastSuccessAt, null);
  assert.equal(body.lastRun.status, 'FAILED');
});

test('GET /api/admin/backups is admin-only: 403 for a non-admin even with admin=edit stored, 401 signed out', async () => {
  const sql = await resetDatabase();
  insertRun(sql, okRun('2026-09-29', Date.now()));
  setAccess({ hr: 'edit', compensation: 'edit', admin: 'edit', audit: 'edit' });
  const denied = await callApi('admin/backups');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'FORBIDDEN');
  assert.equal(denied.body.lastRun, undefined);
  const audit = sql.prepare("SELECT after_json FROM erp_audit_logs WHERE action = 'ACCESS_DENIED' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.after_json).tab, 'admin');
  setAccess(null);
  const anonymous = await callApi('admin/backups');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'UNAUTHENTICATED');
  setAccess({}, { isAdmin: true, mustChangePassword: true });
  assert.equal((await callApi('admin/backups')).body.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('backupRunRow: OK needs a report, integrity ok and no missing R2 bodies; errors are one line', () => {
  const base = { runId: '2026-09-29', startedAt: 1, finishedAt: 2, backupDir: 'C:\\xdm\\backup\\2026-09-29\\' };
  const snapshot = { integrityOk: true, integrity: { 'd1/a.sqlite': 'ok' }, rowCounts: { auth_accounts: 2 }, r2Objects: { count: 5, missingBlobs: 0 } };
  const ok = backupRunRow({ ...base, reportJson: { snapshot } });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.integrity, 'ok');
  assert.equal(ok.r2_object_count, 5);
  assert.equal(ok.row_counts_json, '{"auth_accounts":2}');
  assert.equal(ok.error, '');
  assert.equal(backupRunRow({ ...base, reportJson: null }).status, 'FAILED');
  const corrupt = backupRunRow({ ...base, reportJson: { snapshot: { ...snapshot, integrityOk: false, integrity: { 'd1/a.sqlite': 'row 3 missing from index' } } } });
  assert.equal(corrupt.status, 'FAILED');
  assert.equal(corrupt.integrity, 'd1/a.sqlite: row 3 missing from index');
  assert.equal(backupRunRow({ ...base, reportJson: { snapshot: { ...snapshot, r2Objects: { count: 5, missingBlobs: 2 } } } }).error, 'R2 객체 본문 2개가 blob 저장소에 없습니다.');
  const scripted = backupRunRow({ ...base, reportJson: { snapshot }, error: 'copy\r\nfailed' });
  assert.equal(scripted.status, 'FAILED');
  assert.equal(scripted.error, 'copy failed');
});

// ── 스크립트 실제 실행: 가짜 state(임시 폴더) ─────────────────────────────────────
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [verifyScript, ...args], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** v3/d1(앱 DB)·v3/r2(메타데이터 + 본문 blob) 모양의 가짜 운영 state. */
function makeLiveState(dir) {
  const d1 = path.join(dir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const meta = path.join(dir, 'v3', 'r2', 'miniflare-R2BucketObject');
  const blobs = path.join(dir, 'v3', 'r2', 'site-creator-r2', 'blobs');
  for (const folder of [d1, meta, blobs]) mkdirSync(folder, { recursive: true });
  const app = new DatabaseSync(path.join(d1, 'app.sqlite'));
  app.exec('CREATE TABLE erp_audit_logs (id TEXT PRIMARY KEY); CREATE TABLE auth_accounts (id TEXT); INSERT INTO auth_accounts VALUES (\'a\'), (\'b\');');
  app.close();
  const r2 = new DatabaseSync(path.join(meta, 'bucket.sqlite'));
  r2.exec(`CREATE TABLE _mf_objects (key TEXT PRIMARY KEY, blob_id TEXT, version TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL,
    uploaded INTEGER NOT NULL, checksums TEXT NOT NULL, http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL);
    INSERT INTO _mf_objects VALUES ('hr/a.webm', 'blob-a', 'v', 3, 'e', 1, '{}', '{}', '{}'), ('hr/b.pdf', 'blob-b', 'v', 3, 'e', 1, '{}', '{}', '{}');`);
  r2.close();
  writeFileSync(path.join(blobs, 'blob-a'), 'aaa');
  writeFileSync(path.join(blobs, 'blob-b'), 'bbb');
  return path.join(dir, 'v3');
}

/** Backup 2·3단계를 흉내 낸다: sqlite 는 날짜 폴더로, blob 은 단일 저장소로. */
function copyLikeBackup(liveV3, backupDir, blobStore, { skipBlob } = {}) {
  for (const relative of ['d1/miniflare-D1DatabaseObject/app.sqlite', 'r2/miniflare-R2BucketObject/bucket.sqlite']) {
    const target = path.join(backupDir, 'v3', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(liveV3, relative), target);
  }
  const blobs = path.join(blobStore, 'site-creator-r2', 'blobs');
  mkdirSync(blobs, { recursive: true });
  for (const id of ['blob-a', 'blob-b'].filter((id) => id !== skipBlob)) copyFileSync(path.join(liveV3, 'r2', 'site-creator-r2', 'blobs', id), path.join(blobs, id));
}

const rows = (liveV3) => {
  const db = new DatabaseSync(path.join(liveV3, 'd1', 'miniflare-D1DatabaseObject', 'app.sqlite'), { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ops_backup_runs'").get();
    return exists ? db.prepare('SELECT * FROM ops_backup_runs ORDER BY id').all() : [];
  } finally { db.close(); }
};

test('verify + record-run: a good copy is recorded OK in the stopped live DB; a missing blob is FAILED; a running server is refused', async (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'xdm-backup-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const liveV3 = makeLiveState(path.join(work, 'prod', '.wrangler', 'state'));
  const backupRoot = path.join(work, 'backup');
  const blobStore = path.join(backupRoot, 'r2-blobs');
  const port = await freePort();
  const pidFile = path.join(work, 'run', 'xdm-management.pid');
  const common = ['--pid-file', pidFile, '--port', String(port)];

  // 성공
  const day = path.join(backupRoot, '2026-09-29');
  copyLikeBackup(liveV3, day, blobStore);
  const report = path.join(day, 'backup-report.json');
  const verified = await run([path.join(day, 'v3'), '--out', report, '--blob-store', blobStore]);
  assert.equal(verified.code, 0, verified.stderr);
  const summary = JSON.parse(readFileSync(report, 'utf8')).snapshot;
  assert.equal(summary.integrityOk, true);
  assert.deepEqual(summary.r2Objects, { count: 2, missingBlobs: 0 });
  assert.equal(summary.rowCounts.auth_accounts, 2);
  assert.equal(summary.blobStore.files, 2);
  // 보고서에는 개수와 무결성만 있다(행 내용·키 없음).
  assert.doesNotMatch(readFileSync(report, 'utf8'), /hr\/a\.webm|blob-a/);
  const recorded = await run(['--record-run', liveV3, '--run-id', '2026-09-29', '--started-at', '1759100000000', '--backup-dir', `${day}\\`, '--report', report, ...common]);
  assert.equal(recorded.code, 0, recorded.stderr);
  let saved = rows(liveV3);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'OK');
  assert.equal(saved[0].integrity, 'ok');
  assert.equal(saved[0].r2_object_count, 2);
  assert.equal(JSON.parse(saved[0].row_counts_json).auth_accounts, 2);

  // 검사 모드는 blob 이 빠진 사본을 실패로 본다 → 기록은 FAILED(종료 코드 1)
  const day2 = path.join(backupRoot, '2026-09-29T0400');
  const store2 = path.join(work, 'backup2', 'r2-blobs');
  copyLikeBackup(liveV3, day2, store2, { skipBlob: 'blob-b' });
  const report2 = path.join(day2, 'backup-report.json');
  assert.equal((await run([path.join(day2, 'v3'), '--out', report2, '--blob-store', store2])).code, 1);
  const failed = await run(['--record-run', liveV3, '--run-id', '2026-09-29T0400', '--started-at', '1759100000000', '--backup-dir', `${day2}\\`, '--report', report2, ...common]);
  assert.equal(failed.code, 1, failed.stderr);
  saved = rows(liveV3);
  assert.equal(saved.at(-1).status, 'FAILED');
  assert.equal(saved.at(-1).error, 'R2 객체 본문 1개가 blob 저장소에 없습니다.');

  // 복사 전에 실패하면 보고서 없이 --error 로 기록한다.
  const aborted = await run(['--record-run', liveV3, '--run-id', '2026-09-29T0500', '--started-at', '1759100000000', '--backup-dir', 'C:\\xdm\\backup\\2026-09-29T0500\\', '--error', '백업 복사에 실패했습니다: robocopy 16', ...common]);
  assert.equal(aborted.code, 1);
  assert.equal(rows(liveV3).at(-1).error, '백업 복사에 실패했습니다: robocopy 16');

  // 서버가 떠 있으면(포트 열림) 기록하지 않는다.
  const server = createServer().listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const refused = await run(['--record-run', liveV3, '--run-id', '2026-09-30', '--started-at', '1759100000000', '--backup-dir', 'x', '--report', report, ...common]);
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /거부/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // pid 파일의 프로세스가 살아 있어도 거부한다(이 테스트 프로세스의 pid).
  mkdirSync(path.dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  const refusedPid = await run(['--record-run', liveV3, '--run-id', '2026-09-30', '--started-at', '1759100000000', '--backup-dir', 'x', '--report', report, ...common]);
  assert.equal(refusedPid.code, 3);
  assert.equal(rows(liveV3).length, 3);

  // 검사 모드는 운영 state 를 열지 않는다(이 저장소의 .wrangler/state).
  const liveRefusal = await run([path.join(root, '.wrangler', 'state')]);
  assert.notEqual(liveRefusal.code, 0);
  if (existsSync(path.join(root, '.wrangler', 'state', 'v3'))) assert.match(liveRefusal.stderr, /운영 중인/);
});
