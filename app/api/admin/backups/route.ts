import { env } from "cloudflare:workers";
import { authorizeErpRequest } from "../../../erp-platform";

// Design §4.2.6 `GET /api/admin/backups`(R4, admin:read), §5.4 계정 관리 탭의 백업 경고.
// ops_backup_runs 는 백업 스크립트가 서버 정지 중에 직접 쓴다(scripts/verify-state-snapshot.mjs --record-run).
// 이 라우트는 읽기만 한다. 표는 게이트(ensureErpPlatformSchema → opsSchemaStatements)가 만든다.
const db = (env as unknown as { DB: D1Database }).DB;
/** 마지막 성공이 이보다 오래됐거나 성공 행이 없으면 stale 이다. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

type BackupRunRow = { id: string; status: string; finished_at: number; error: string };

export async function GET() {
  const authorization = await authorizeErpRequest(db, "admin", "read");
  if (authorization.response) return authorization.response;
  const [lastSuccess, lastRun] = await Promise.all([
    db.prepare(`SELECT finished_at FROM ops_backup_runs WHERE status = 'OK' ORDER BY finished_at DESC, id DESC LIMIT 1`)
      .first<{ finished_at: number }>(),
    db.prepare(`SELECT id, status, finished_at, error FROM ops_backup_runs ORDER BY finished_at DESC, id DESC LIMIT 1`)
      .first<BackupRunRow>(),
  ]);
  const lastSuccessAt = lastSuccess ? Number(lastSuccess.finished_at) : null;
  const stale = lastSuccessAt === null || Date.now() - lastSuccessAt > STALE_AFTER_MS;
  return Response.json({
    lastSuccessAt,
    lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, finishedAt: Number(lastRun.finished_at), error: lastRun.error } : null,
    stale,
  }, { headers: { "Cache-Control": "no-store" } });
}
