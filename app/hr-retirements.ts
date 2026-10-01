type DueRetirement = {
  id: string;
  employee_id: string;
  retirement_date: string;
  reason: string;
};

type PendingRetirement = {
  employee_id: string;
  retirement_date: string;
  reason: string;
  department: string;
  position: string;
  history_json: string;
};

// 퇴직 예정자의 인사이력에 "퇴직 예정 · 예정일" 항목을 채운다. 퇴직 요청을 만들 때도 같은 항목을
// 넣지만(app/api/hr/operations/route.ts), 그 처리를 붙이기 전에 만들어 둔 요청들은 이력이 비어
// 있었다. 인사기록을 읽는 경로마다 이 함수를 거치므로 여기서 한 번 보정하면 옛 기록도 채워진다.
async function backfillPendingRetirementHistory(db: D1Database, now: number, koreaDate: string) {
  const pending = await db.prepare(`SELECT request.employee_id, request.retirement_date, request.reason,
      record.department, record.position, record.history_json
    FROM hr_retirement_requests request
    JOIN hr_employee_records record ON record.employee_id = request.employee_id
    WHERE request.status IN ('SUBMITTED', 'IN_PROGRESS', 'READY') AND request.retirement_date >= ?`)
    .bind(koreaDate).all<PendingRetirement>();
  for (const row of pending.results) {
    const date = row.retirement_date.replaceAll("-", ".");
    let history: Array<{ date?: string; type?: string; detail?: string }>;
    try { history = JSON.parse(row.history_json || "[]") as typeof history; }
    catch { history = []; }
    if (!Array.isArray(history)) history = [];
    if (history.some((item) => item.type === "퇴직 예정" && item.date === date)) continue;
    const detail = `${row.department || "소속 미상"} ${row.position || ""} 퇴직 예정 · ${row.reason}`.replace(/\s+/g, " ").trim();
    await db.prepare("UPDATE hr_employee_records SET history_json = ?, updated_at = ? WHERE employee_id = ?")
      .bind(JSON.stringify([...history, { date, type: "퇴직 예정", detail }]), now, row.employee_id).run();
  }
}

// retirement_date 는 마지막 근무일이다. 퇴직은 그 다음 날(퇴직일)부터라 "retirement_date < 오늘"인 건만 처리한다.
// 예전에는 <= 라서 10/30 까지 근무하는 사람이 10/30 아침에 이미 퇴직자로 바뀌었다(2026-10-01 바로잡음).
export async function applyDueRetirements(db: D1Database, now = Date.now()) {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hr_retirement_requests'")
    .first<{ name: string }>();
  if (!table) return 0;
  const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await backfillPendingRetirementHistory(db, now, koreaDate);
  const due = await db.prepare(`SELECT id, employee_id, retirement_date, reason FROM hr_retirement_requests
    WHERE retirement_date < ? AND (status IN ('IN_PROGRESS', 'READY') OR (status = 'EFFECTIVE'
      AND completed_tasks = total_tasks AND total_tasks > 0
      AND EXISTS (SELECT 1 FROM hr_retirement_settlements settlement
        WHERE settlement.request_id = hr_retirement_requests.id AND settlement.status = 'READY')))
    ORDER BY retirement_date, created_at`)
    .bind(koreaDate).all<DueRetirement>();
  let applied = 0;
  for (const retirement of due.results) {
    const completion = await db.prepare(`SELECT
      CASE WHEN request.completed_tasks = request.total_tasks AND request.total_tasks > 0
        AND settlement.status = 'READY' THEN 1 ELSE 0 END AS ready
      FROM hr_retirement_requests request
      LEFT JOIN hr_retirement_settlements settlement ON settlement.request_id = request.id
      WHERE request.id = ?`).bind(retirement.id).first<{ ready: number }>();
    const nextStatus = completion?.ready ? "COMPLETED" : "EFFECTIVE";
    const organizationLeaderTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hr_organization_leaders'")
      .first<{ name: string }>();
    const statements = [
      db.prepare(`UPDATE hr_retirement_requests SET status = ?, completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END, updated_at = ?
        WHERE id = ? AND status IN ('IN_PROGRESS', 'READY', 'EFFECTIVE') AND retirement_date < ?`)
        .bind(nextStatus, nextStatus, now, now, retirement.id, koreaDate),
      db.prepare(`UPDATE hr_employee_records SET status = '퇴직',
        retirement_json = json_set(CASE WHEN json_valid(retirement_json) THEN retirement_json ELSE '{}' END,
          '$.status', ?),
        history_json = json_insert(CASE WHEN json_valid(history_json) THEN history_json ELSE '[]' END, '$[#]',
          json(json_object('date', replace(?, '-', '.'), 'type', '퇴직', 'detail', ?))), updated_at = ?
        WHERE employee_id = ?
          AND EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = ? AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM erp_audit_logs WHERE action = 'RETIREMENT_EFFECTIVE' AND entity_id = ?)`)
        .bind(nextStatus, retirement.retirement_date, retirement.reason, now, retirement.employee_id, retirement.id, nextStatus, now, retirement.id),
      db.prepare(`UPDATE hr_retirement_settlements SET status = 'COMPLETED', completed_by = 'SYSTEM',
        completed_at = ?, updated_at = ? WHERE request_id = ? AND status = 'READY' AND ? = 'COMPLETED'
          AND EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = ? AND updated_at = ?)`)
        .bind(now, now, retirement.id, nextStatus, retirement.id, nextStatus, now),
      db.prepare(`INSERT INTO erp_audit_logs
        (id, actor_user_id, actor_email, actor_employee_id, module, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
        SELECT ?, 'SYSTEM', 'system@xdnode.local', 'SYSTEM', 'hr', 'RETIREMENT_EFFECTIVE',
          'employeeRetirement', ?, '{}', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = ? AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM erp_audit_logs WHERE action = 'RETIREMENT_EFFECTIVE' AND entity_id = ?)`)
        .bind(crypto.randomUUID(), retirement.id, JSON.stringify({ employeeId: retirement.employee_id, retirementDate: retirement.retirement_date, status: nextStatus }),
          retirement.reason, now, retirement.id, nextStatus, now, retirement.id),
    ];
    if (organizationLeaderTable) statements.splice(2, 0,
      db.prepare("UPDATE hr_organization_leaders SET leader_employee_id = NULL, updated_at = ? WHERE leader_employee_id = ?")
        .bind(now, retirement.employee_id));
    const result = await db.batch(statements);
    if ((result[0].meta.changes ?? 0) > 0) applied += 1;
  }
  return applied;
}
