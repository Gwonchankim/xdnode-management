// 로컬 D1·R2 상태 폴더(.wrangler/state/v3)를 다루는 공용 함수.
// Design Ref: §11.2 scripts/lib/d1-state.mjs — 실제 앱 DB 파일을 이름이 아니라 내용(erp_audit_logs 유무)으로 고른다.
// miniflare 는 파일 이름을 바인딩 id 의 해시로 짓고, 쓰지 않는 빈 잔재 파일(4KB)도 같은 폴더에 남긴다.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** state 폴더 인자를 받아 v3 폴더를 돌려준다. `.wrangler/state` 와 `.wrangler/state/v3` 둘 다 받는다. */
export function resolveV3(stateDir) {
  const base = resolve(stateDir);
  const v3 = existsSync(join(base, "d1")) ? base : join(base, "v3");
  if (!existsSync(join(v3, "d1"))) throw new Error(`D1 상태 폴더를 찾지 못했습니다: ${v3}`);
  return v3;
}

function sqliteFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite").map((name) => join(dir, name));
}

function hasTable(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } finally {
    db.close();
  }
}

/** 앱 DB 파일 경로. erp_audit_logs 가 있는 파일이 정확히 하나여야 한다. */
export function findAppDatabase(stateDir) {
  const v3 = resolveV3(stateDir);
  const candidates = sqliteFiles(join(v3, "d1", "miniflare-D1DatabaseObject")).filter((file) => hasTable(file, "erp_audit_logs"));
  if (candidates.length !== 1) throw new Error(`앱 DB 파일을 하나로 정하지 못했습니다(${candidates.length}개).`);
  return candidates[0];
}

/** 상태 폴더 안의 모든 sqlite 파일(무결성 검사 대상). */
export function stateSqliteFiles(stateDir) {
  const v3 = resolveV3(stateDir);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".sqlite")) out.push(path);
    }
  };
  walk(v3);
  return out.sort();
}

/** R2 객체 본문 파일 수와 바이트 합. sqlite 메타 파일은 빼고 센다. */
export function r2BlobStats(stateDir) {
  const root = join(resolveV3(stateDir), "r2");
  let count = 0;
  let bytes = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (!/\.sqlite(-wal|-shm)?$/.test(name)) { count += 1; bytes += info.size; }
    }
  };
  walk(root);
  return { count, bytes };
}

/** 객체 수를 나눠 세는 키 첫 경로 조각(quote-tool Design §8). 그 밖은 other 로 묶는다. */
export const R2_PREFIX_BUCKETS = ["ga", "quote"];

/**
 * R2 메타데이터(`r2/miniflare-R2BucketObject/*.sqlite`)의 객체 수와 본문 blob id(R4 백업 검증).
 * 키·메타데이터 같은 행 내용은 돌려주지 않는다. 멀티파트 객체는 완료된 조각의 blob 을 센다.
 * byPrefix 는 키의 첫 경로 조각별 수(ga·quote·other)뿐이다(QT-SC-12 복원 대조).
 */
export function r2ObjectStats(stateDir) {
  const dir = join(resolveV3(stateDir), "r2", "miniflare-R2BucketObject");
  let count = 0;
  const blobIds = new Set();
  const byPrefix = Object.fromEntries([...R2_PREFIX_BUCKETS, "other"].map((name) => [name, 0]));
  for (const file of sqliteFiles(dir)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      if (has("_mf_objects")) {
        count += Number(db.prepare("SELECT COUNT(*) AS n FROM _mf_objects").get().n);
        for (const row of db.prepare(`SELECT CASE WHEN instr(key, '/') > 0 THEN substr(key, 1, instr(key, '/') - 1) ELSE '' END AS prefix, COUNT(*) AS n
          FROM _mf_objects GROUP BY prefix`).all()) {
          const bucket = R2_PREFIX_BUCKETS.includes(String(row.prefix)) ? String(row.prefix) : "other";
          byPrefix[bucket] += Number(row.n);
        }
        for (const row of db.prepare("SELECT blob_id FROM _mf_objects WHERE blob_id IS NOT NULL").all()) blobIds.add(String(row.blob_id));
      }
      if (has("_mf_multipart_parts")) {
        for (const row of db.prepare("SELECT blob_id FROM _mf_multipart_parts WHERE object_key IS NOT NULL").all()) blobIds.add(String(row.blob_id));
      }
    } finally {
      db.close();
    }
  }
  return { count, byPrefix, blobIds: [...blobIds].sort() };
}

/**
 * blob 저장소(`<ns>/blobs/<id>` 모양. 상태 폴더의 `v3/r2` 나 백업의 `r2-blobs`)의 본문 파일 이름·수·바이트.
 * sqlite 메타 파일은 빼고 센다.
 */
export function blobStoreFiles(root) {
  const names = new Set();
  let count = 0;
  let bytes = 0;
  const walk = (dir, parentName) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path, name);
      else if (!/\.sqlite(-wal|-shm)?$/.test(name)) {
        count += 1;
        bytes += info.size;
        if (parentName === "blobs") names.add(name);
      }
    }
  };
  walk(resolve(root), "");
  return { names, count, bytes };
}
