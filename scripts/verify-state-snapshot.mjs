// 상태 스냅샷(.wrangler/state 사본) 검증 보고서를 만들고, R4 백업 결과를 ops_backup_runs 에 기록한다.
// Design Ref: §11.2 scripts/verify-state-snapshot.mjs, §11.5.8(백업 4·5단계), 부록 C #6 — 읽기 전용이고, 기록 모드 말고는 운영(live) 파일을 열지 않는다(SC-8).
//
//   검증: node scripts/verify-state-snapshot.mjs <snapshotStateDir> [--out report.json] [--compare <otherStateDir>] [--blob-store <dir>]
//   기록: node scripts/verify-state-snapshot.mjs --record-run <liveStateDir> --run-id <yyyy-MM-dd[THHmm]> --started-at <epoch ms>
//           --backup-dir <dir> [--report backup-report.json] [--error <사유>] [--pid-file <file>] [--port <n>]
//
// 보고서에는 sqlite 파일별 PRAGMA integrity_check, 앱 DB 테이블별 행 수, R2 객체 수와 본문 blob 확인 결과가 들어간다.
// 행 내용은 읽지 않는다. --blob-store 는 백업의 단일 blob 저장소(r2-blobs)에서 R2 객체 본문이 모두 있는지 본다.
// 기록 모드는 서버가 멈춘 동안에만 운영 D1 파일에 한 행을 쓴다(성공·실패 모두). pid 파일의 프로세스가 살아 있거나 포트가 열려 있으면 거부한다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { blobStoreFiles, findAppDatabase, r2BlobStats, r2ObjectStats, resolveV3, stateSqliteFiles } from "./lib/d1-state.mjs";

const LIVE_STATE = resolve(import.meta.dirname, "..", ".wrangler", "state");
const DEFAULT_PID_FILE = "C:\\xdm\\run\\xdm-management.pid";
const DEFAULT_PORT = 3000;
const RUN_ID = /^\d{4}-\d{2}-\d{2}(?:T\d{4}(?:\d{2})?)?$/;

// ── R4 운영 스키마. app/erp-platform.ts 의 opsSchemaStatements 와 같은 문자열이다(tests/lan-exposure-guards 가 대조한다). ──
export const OPS_BACKUP_RUNS_DDL = `CREATE TABLE IF NOT EXISTS ops_backup_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OK','FAILED')),
  backup_dir TEXT NOT NULL,
  integrity TEXT NOT NULL DEFAULT '',
  r2_object_count INTEGER NOT NULL DEFAULT 0,
  row_counts_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
)`;
export const OPS_BACKUP_RUNS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_ops_backup_runs_finished ON ops_backup_runs(finished_at)`;

const isInside = (child, parent) => {
  const a = resolve(child).toLowerCase();
  const b = resolve(parent).toLowerCase();
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`);
};

function refuseLive(stateDir, extraLive = []) {
  for (const live of [LIVE_STATE, ...extraLive]) {
    if (isInside(stateDir, live)) {
      throw new Error("운영 중인 .wrangler/state 는 검사하지 않습니다. 서버를 멈추고 복사한 사본을 지정하세요.");
    }
  }
}

export function report(stateDir, { blobStore, liveStates = [] } = {}) {
  refuseLive(stateDir, liveStates);
  const v3 = resolveV3(stateDir);
  const integrity = {};
  for (const file of stateSqliteFiles(stateDir)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      integrity[relative(v3, file).replace(/\\/g, "/")] = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join("; ");
    } finally {
      db.close();
    }
  }
  const appDb = findAppDatabase(stateDir);
  const db = new DatabaseSync(appDb, { readOnly: true });
  const rowCounts = {};
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
    for (const { name } of tables) rowCounts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
  } finally {
    db.close();
  }
  // R2 본문은 사본 자신의 r2 폴더(전체 복사) 또는 --blob-store(R4 백업의 단일 저장소)에서 찾는다.
  const objects = r2ObjectStats(stateDir);
  const store = blobStoreFiles(blobStore ?? join(v3, "r2"));
  const missingBlobs = objects.blobIds.filter((id) => !store.names.has(id)).length;
  const integrityOk = Object.values(integrity).every((value) => value === "ok");
  return {
    stateDir: v3,
    appDatabase: relative(v3, appDb).replace(/\\/g, "/"),
    ok: integrityOk && missingBlobs === 0,
    integrityOk,
    integrity,
    tableCount: Object.keys(rowCounts).length,
    rowCounts,
    r2Blobs: r2BlobStats(stateDir),
    r2Objects: { count: objects.count, missingBlobs },
    ...(blobStore ? { blobStore: { dir: resolve(blobStore), files: store.count, bytes: store.bytes } } : {}),
  };
}

function compare(a, b) {
  const tables = [...new Set([...Object.keys(a.rowCounts), ...Object.keys(b.rowCounts)])].sort();
  const differences = tables
    .filter((name) => a.rowCounts[name] !== b.rowCounts[name])
    .map((name) => ({ table: name, left: a.rowCounts[name] ?? null, right: b.rowCounts[name] ?? null }));
  const same = differences.length === 0 && a.r2Blobs.count === b.r2Blobs.count && a.r2Objects.count === b.r2Objects.count;
  return { same, differences, r2: { left: a.r2Blobs, right: b.r2Blobs }, r2Objects: { left: a.r2Objects.count, right: b.r2Objects.count } };
}

// ── 기록 모드(R4) ────────────────────────────────────────────────────────────────

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); done(open); };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function pidAlive(pidFile) {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 서버가 떠 있다는 근거가 있으면 그 이유 문구, 없으면 null. */
export async function runningServerReason({ pidFile = DEFAULT_PID_FILE, port = DEFAULT_PORT } = {}) {
  if (pidAlive(pidFile)) return `pid 파일(${pidFile})의 프로세스가 살아 있습니다.`;
  if (await portOpen(port)) return `127.0.0.1:${port} 에서 서버가 응답합니다.`;
  return null;
}

const oneLine = (value, max) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** 보고서(없을 수 있음)와 실패 사유로 기록할 행을 정한다. 성공 = 보고서 있음 + integrity ok + R2 본문 누락 0(Design §11.5.8). */
export function backupRunRow({ runId, startedAt, finishedAt, backupDir, reportJson, error }) {
  const snapshot = reportJson?.snapshot;
  let status = "OK";
  let reason = oneLine(error, 500);
  if (reason) status = "FAILED";
  else if (!snapshot) { status = "FAILED"; reason = "백업 보고서(backup-report.json)가 없습니다."; }
  else if (!snapshot.integrityOk) { status = "FAILED"; reason = "사본의 integrity_check 가 ok 가 아닙니다."; }
  else if ((snapshot.r2Objects?.missingBlobs ?? 0) > 0) { status = "FAILED"; reason = `R2 객체 본문 ${snapshot.r2Objects.missingBlobs}개가 blob 저장소에 없습니다.`; }
  const bad = snapshot ? Object.entries(snapshot.integrity ?? {}).filter(([, value]) => value !== "ok") : [];
  const integrity = !snapshot ? "" : bad.length === 0 ? "ok" : oneLine(bad.map(([file, value]) => `${file}: ${value}`).join("; "), 500);
  return {
    id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    backup_dir: oneLine(backupDir, 200),
    integrity,
    r2_object_count: Number(snapshot?.r2Objects?.count ?? 0),
    row_counts_json: JSON.stringify(snapshot?.rowCounts ?? {}),
    error: status === "OK" ? "" : reason,
  };
}

/** 멈춘 운영 state 의 앱 DB 에 ops_backup_runs 한 행을 쓴다. 표가 없으면 같은 DDL 로 만든다. */
export function writeBackupRun(liveStateDir, row) {
  const db = new DatabaseSync(findAppDatabase(liveStateDir));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(OPS_BACKUP_RUNS_DDL);
    db.exec(OPS_BACKUP_RUNS_INDEX_DDL);
    db.prepare(`INSERT INTO ops_backup_runs (id, started_at, finished_at, status, backup_dir, integrity, r2_object_count, row_counts_json, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.started_at, row.finished_at, row.status, row.backup_dir, row.integrity, row.r2_object_count, row.row_counts_json, row.error);
  } finally {
    db.close();
  }
  return row;
}

async function recordMode(option) {
  const live = option("--record-run");
  const runId = option("--run-id") ?? "";
  const startedAt = Number(option("--started-at"));
  const backupDir = option("--backup-dir") ?? "";
  if (!RUN_ID.test(runId) || !Number.isInteger(startedAt) || startedAt <= 0 || !backupDir) {
    console.error("사용법: --record-run <liveStateDir> --run-id <yyyy-MM-dd[THHmm]> --started-at <epoch ms> --backup-dir <dir> [--report <file>] [--error <사유>]");
    return 2;
  }
  const port = Number(option("--port") ?? DEFAULT_PORT);
  const running = await runningServerReason({ pidFile: option("--pid-file") ?? DEFAULT_PID_FILE, port });
  if (running) {
    console.error(`거부: ${running} 서버를 멈춘 뒤에만 기록합니다.`);
    return 3;
  }
  const reportFile = option("--report");
  let reportJson = null;
  let error = option("--error") ?? "";
  if (reportFile) {
    try {
      reportJson = JSON.parse(readFileSync(reportFile, "utf8"));
      if (isInside(reportJson?.snapshot?.stateDir ?? "", resolveV3(live))) error ||= "보고서가 운영 state 를 가리킵니다.";
    } catch {
      error ||= "백업 보고서를 읽지 못했습니다.";
    }
  }
  const row = backupRunRow({ runId, startedAt, finishedAt: Date.now(), backupDir, reportJson, error });
  try {
    writeBackupRun(live, row);
  } catch (writeError) {
    console.error(`기록 실패: ${oneLine(writeError?.message, 300)}`);
    return 3;
  }
  console.log(JSON.stringify({ recorded: row.id, status: row.status, integrity: row.integrity, r2ObjectCount: row.r2_object_count, error: row.error }));
  return row.status === "OK" ? 0 : 1;
}

async function main(args) {
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes("--record-run")) {
    // 기록 모드의 예외(앱 DB 없음 등)는 '기록하지 못함'(3)이다. 1 은 FAILED 행을 쓴 경우에만 쓴다.
    return recordMode(option).catch((error) => { console.error(`기록 실패: ${oneLine(error?.message, 300)}`); return 3; });
  }
  const stateDir = args[0];
  if (!stateDir || stateDir.startsWith("--")) {
    console.error("사용법: node scripts/verify-state-snapshot.mjs <snapshotStateDir> [--out report.json] [--compare <otherStateDir>] [--blob-store <dir>]");
    return 2;
  }
  const blobStore = option("--blob-store");
  if (blobStore && !existsSync(blobStore)) {
    console.error(`blob 저장소가 없습니다: ${blobStore}`);
    return 2;
  }
  const result = { createdAt: new Date().toISOString(), snapshot: report(stateDir, { blobStore }) };
  const other = option("--compare");
  if (other) result.comparison = compare(result.snapshot, report(other));
  const out = option("--out");
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: result.snapshot.ok,
    integrityOk: result.snapshot.integrityOk,
    appDatabase: result.snapshot.appDatabase,
    tableCount: result.snapshot.tableCount,
    r2Blobs: result.snapshot.r2Blobs,
    r2Objects: result.snapshot.r2Objects,
    ...(result.comparison ? { comparisonSame: result.comparison.same, differences: result.comparison.differences.length } : {}),
    ...(out ? { report: out } : {}),
  }));
  return result.snapshot.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`실패: ${oneLine(error?.message, 300)}`);
    process.exitCode = 1;
  });
}
