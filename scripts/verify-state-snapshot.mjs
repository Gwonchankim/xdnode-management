// 상태 스냅샷(.wrangler/state 사본) 검증 보고서를 만든다.
// Design Ref: §11.2 scripts/verify-state-snapshot.mjs — 읽기 전용, 운영(live) 파일은 열지 않는다(SC-8).
//
//   node scripts/verify-state-snapshot.mjs <snapshotStateDir> [--out report.json] [--compare <otherStateDir>]
//
// 보고서에는 sqlite 파일별 PRAGMA integrity_check, 앱 DB 테이블별 행 수, R2 본문 파일 수가 들어간다.
// 행 내용은 읽지 않는다. 백업 결과 기록(--record-run)은 R4 에서 더한다.
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findAppDatabase, r2BlobStats, resolveV3, stateSqliteFiles } from "./lib/d1-state.mjs";

const LIVE_STATE = resolve(import.meta.dirname, "..", ".wrangler", "state");

function refuseLive(stateDir) {
  const target = resolve(stateDir);
  if (target.toLowerCase().startsWith(LIVE_STATE.toLowerCase())) {
    throw new Error("운영 중인 .wrangler/state 는 검사하지 않습니다. 서버를 멈추고 복사한 사본을 지정하세요.");
  }
}

function report(stateDir) {
  refuseLive(stateDir);
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
  return {
    stateDir: v3,
    appDatabase: relative(v3, appDb).replace(/\\/g, "/"),
    integrityOk: Object.values(integrity).every((value) => value === "ok"),
    integrity,
    tableCount: Object.keys(rowCounts).length,
    rowCounts,
    r2Blobs: r2BlobStats(stateDir),
  };
}

function compare(a, b) {
  const tables = [...new Set([...Object.keys(a.rowCounts), ...Object.keys(b.rowCounts)])].sort();
  const differences = tables
    .filter((name) => a.rowCounts[name] !== b.rowCounts[name])
    .map((name) => ({ table: name, left: a.rowCounts[name] ?? null, right: b.rowCounts[name] ?? null }));
  return { same: differences.length === 0 && a.r2Blobs.count === b.r2Blobs.count, differences, r2: { left: a.r2Blobs, right: b.r2Blobs } };
}

const args = process.argv.slice(2);
const stateDir = args[0];
if (!stateDir || stateDir.startsWith("--")) {
  console.error("사용법: node scripts/verify-state-snapshot.mjs <snapshotStateDir> [--out report.json] [--compare <otherStateDir>]");
  process.exit(2);
}
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

const result = { createdAt: new Date().toISOString(), snapshot: report(stateDir) };
const other = option("--compare");
if (other) result.comparison = compare(result.snapshot, report(other));
const out = option("--out");
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  integrityOk: result.snapshot.integrityOk,
  appDatabase: result.snapshot.appDatabase,
  tableCount: result.snapshot.tableCount,
  r2Blobs: result.snapshot.r2Blobs,
  ...(result.comparison ? { comparisonSame: result.comparison.same, differences: result.comparison.differences.length } : {}),
  ...(out ? { report: out } : {}),
}));
process.exit(result.snapshot.integrityOk ? 0 : 1);
