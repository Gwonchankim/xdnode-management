import { hrTablesExist } from "./hr-optional-tables";

type DuePersonnelAction = {
  id: string;
  employee_id: string;
  effective_date: string;
  action_type: string;
  before_json: string;
  after_json: string;
  reason: string;
};

export async function applyDuePersonnelActions(db: D1Database, now = Date.now()) {
  if (!await hrTablesExist(db, "hr_personnel_actions")) return 0;
  const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const due = await db.prepare(`SELECT id, employee_id, effective_date, action_type, before_json, after_json, reason
    FROM hr_personnel_actions WHERE status = 'APPROVED' AND effective_date <= ? ORDER BY effective_date, created_at`)
    .bind(koreaDate).all<DuePersonnelAction>();
  let applied = 0;
  for (const action of due.results) {
    const result = await db.batch([
      db.prepare(`UPDATE hr_personnel_actions SET status = 'EFFECTIVE', updated_at = ?
        WHERE id = ? AND status = 'APPROVED' AND effective_date <= ?`).bind(now, action.id, koreaDate),
      db.prepare(`UPDATE hr_employee_records SET
        department = COALESCE(NULLIF(json_extract(?, '$.department'), ''), department),
        position = COALESCE(NULLIF(json_extract(?, '$.position'), ''), position),
        history_json = json_insert(CASE WHEN json_valid(history_json) THEN history_json ELSE '[]' END, '$[#]',
          json(json_object('date', replace(?, '-', '.'), 'type', ?, 'detail', ?))),
        updated_at = ? WHERE employee_id = ?
          AND EXISTS (SELECT 1 FROM hr_personnel_actions WHERE id = ? AND status = 'EFFECTIVE' AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM erp_audit_logs WHERE action = 'PERSONNEL_ACTION_EFFECTIVE' AND entity_id = ?)`)
          .bind(action.after_json, action.after_json, action.effective_date, action.action_type, action.reason, now,
            action.employee_id, action.id, now, action.id),
      db.prepare(`INSERT INTO erp_audit_logs
        (id, actor_user_id, actor_email, actor_employee_id, module, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
        SELECT ?, 'SYSTEM', 'system@xdnode.local', 'SYSTEM', 'hr', 'PERSONNEL_ACTION_EFFECTIVE',
          'personnelAction', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM hr_personnel_actions WHERE id = ? AND status = 'EFFECTIVE' AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM erp_audit_logs WHERE action = 'PERSONNEL_ACTION_EFFECTIVE' AND entity_id = ?)`)
        .bind(crypto.randomUUID(), action.id, action.before_json, action.after_json, action.reason, now, action.id, now, action.id),
    ]);
    if ((result[0].meta.changes ?? 0) > 0) applied += 1;
  }
  return applied;
}
