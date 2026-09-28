// HR 상태 전이의 즉시 반영(xdnode-management R1, Design §12.2).
//
// 예전에는 인사발령·퇴직·휴가 신청·급여월 승인·성과 최종 확정·인력계획 승인·채용요청 모집 시작 7개
// 흐름이 전자결재 엔진(app/approval-engine.ts)을 거쳤고, 승인 순간의 부수효과를 엔진이 대신 썼다.
// 결재가 없어진 뒤로는 편집 권한자가 누르면 곧바로 반영한다. 그 부수효과를 여기 한 곳에 모은다.
//
// 규칙
// - 모든 함수는 D1PreparedStatement[] 를 돌려주는 순수 함수다. db.batch 와 meta.changes 검사는 라우트가 한다.
// - 전이는 WHERE status IN (<원래 from>, <레거시 대기 상태>) 로 건다. 결재 시절에 대기 상태로 남은 행도
//   같은 버튼으로 빠져나올 수 있어야 하기 때문이다. changes 가 0 이면 라우트가 409 CONFLICT 로 막는다.
// - actor 컬럼에는 principal.employeeId 를 넣는다.

/** 결재 시절의 대기 상태. 이 상태로 남은 행은 즉시 반영 전이의 from-state 로도 받는다. */
export const LEGACY_PENDING = {
  personnelAction: "SUBMITTED", retirement: "SUBMITTED", leaveRequest: "PENDING",
  workforcePlan: "SUBMITTED", requisition: "SUBMITTED", performanceCycle: "FINALIZATION_SUBMITTED",
} as const;

export const HR_CONFLICT_MESSAGE = "다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요.";

/** 조건부 UPDATE 가 한 행도 바꾸지 못했을 때의 응답(Design §6.1 CONFLICT). */
export function hrConflictResponse() {
  return Response.json({ error: HR_CONFLICT_MESSAGE, code: "CONFLICT" }, { status: 409 });
}

/** batch 결과의 index 번째 문장이 바꾼 행 수. */
export function changedRows(results: D1Result[], index: number) {
  return Number(results[index]?.meta.changes ?? 0);
}

export type LegacyDecision = "APPROVED" | "REJECTED";

// ── 1. 인사발령 ────────────────────────────────────────────────────────────────

/**
 * 발령을 승인된 상태로 등록한다. 시행일이 된 발령을 인사기록에 적용하는 길은
 * applyDuePersonnelActions(app/hr-personnel-actions.ts) 하나뿐이므로, 라우트는 batch 뒤에 그 함수를 부른다.
 */
export function insertApprovedPersonnelAction(db: D1Database, input: {
  id: string; employeeId: string; actionType: string; effectiveDate: string; orderNumber: string;
  beforeState: Record<string, unknown>; afterState: Record<string, unknown>; reason: string;
  actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  return [db.prepare(`INSERT INTO hr_personnel_actions
    (id, employee_id, action_type, effective_date, order_number, before_json, after_json,
      reason, status, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`)
    .bind(input.id, input.employeeId, input.actionType, input.effectiveDate, input.orderNumber,
      JSON.stringify(input.beforeState), JSON.stringify(input.afterState), input.reason,
      input.actorEmployeeId, input.now, input.now, input.now)];
}

/** 결재 시절에 SUBMITTED 로 남은 발령의 승인·반려. 승인이면 라우트가 이어서 applyDuePersonnelActions 를 부른다. */
export function decidePersonnelActionStatements(db: D1Database, input: {
  id: string; decision: LegacyDecision; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  if (input.decision === "APPROVED") {
    return [db.prepare(`UPDATE hr_personnel_actions SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = ?`)
      .bind(input.actorEmployeeId, input.now, input.now, input.id, LEGACY_PENDING.personnelAction)];
  }
  return [db.prepare(`UPDATE hr_personnel_actions SET status = 'REJECTED', approved_by = '', approved_at = NULL, updated_at = ?
    WHERE id = ? AND status = ?`)
    .bind(input.now, input.id, LEGACY_PENDING.personnelAction)];
}

// ── 2. 퇴직 ────────────────────────────────────────────────────────────────────

/**
 * 퇴직 절차가 IN_PROGRESS 가 되는 순간의 부수효과: 정산 초안과 인사기록의 '퇴직 예정' 표시.
 * 요청이 이 호출의 now 로 방금 IN_PROGRESS 가 된 경우에만 쓴다(같은 batch 의 앞 문장이 실패하면 아무것도 안 한다).
 * 인사이력의 '퇴직 예정' 항목은 등록 때 라우트가 한 번만 넣는다. 여기서 또 넣으면 두 번 남는다.
 */
function retirementStartEffects(db: D1Database, requestId: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO hr_retirement_settlements
      (request_id, final_salary, retirement_pay, unused_leave_pay, deductions, net_settlement,
        payroll_confirmed, insurance_confirmed, access_revoked, assets_returned, handover_confirmed,
        status, prepared_by, completed_by, completed_at, created_at, updated_at)
      SELECT ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'DRAFT', '', '', NULL, ?, ?
      WHERE EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = 'IN_PROGRESS' AND approved_at = ?)`)
      .bind(requestId, now, now, requestId, now),
    db.prepare(`UPDATE hr_employee_records SET status = '퇴직 예정',
      retirement_json = json((SELECT json_object('requestId', id, 'date', retirement_date, 'reason', reason,
        'completedTaskIds', json(checklist_json), 'status', 'IN_PROGRESS') FROM hr_retirement_requests WHERE id = ?)),
      updated_at = ?
      WHERE employee_id = (SELECT employee_id FROM hr_retirement_requests WHERE id = ?)
        AND EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = 'IN_PROGRESS' AND approved_at = ?)`)
      .bind(requestId, now, requestId, requestId, now),
  ];
}

/**
 * 퇴직 요청을 곧바로 IN_PROGRESS 로 등록하고 같은 batch 에서 정산 초안·인사기록 상태를 반영한다.
 * 라우트는 hr_employee_records 의 INSERT OR IGNORE 를 이 문장들보다 앞에 둔다.
 */
export function startRetirementStatements(db: D1Database, input: {
  id: string; employeeId: string; retirementDate: string; reason: string;
  completedTaskIds: string[]; totalTasks: number; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO hr_retirement_requests
      (id, employee_id, retirement_date, reason, status, checklist_json, total_tasks, completed_tasks,
        requested_by, approved_by, approved_at, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .bind(input.id, input.employeeId, input.retirementDate, input.reason, JSON.stringify(input.completedTaskIds),
        input.totalTasks, input.completedTaskIds.length, input.actorEmployeeId, input.actorEmployeeId,
        input.now, input.now, input.now),
    ...retirementStartEffects(db, input.id, input.now),
  ];
}

/**
 * 결재 시절에 SUBMITTED 로 남은 퇴직 요청의 승인·반려. 이 길이 없으면 SUBMITTED 요청이 같은 직원의 새 퇴직
 * 등록을 영원히 막는다(operations POST 의 진행 중 요청 검사).
 */
export function decideRetirementStatements(db: D1Database, input: {
  id: string; decision: LegacyDecision; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  if (input.decision === "APPROVED") {
    return [
      db.prepare(`UPDATE hr_retirement_requests SET status = 'IN_PROGRESS', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = ?`)
        .bind(input.actorEmployeeId, input.now, input.now, input.id, LEGACY_PENDING.retirement),
      ...retirementStartEffects(db, input.id, input.now),
    ];
  }
  return [
    db.prepare(`UPDATE hr_retirement_requests SET status = 'REJECTED', updated_at = ? WHERE id = ? AND status = ?`)
      .bind(input.now, input.id, LEGACY_PENDING.retirement),
    db.prepare(`UPDATE hr_lifecycle_tasks SET status = 'CANCELLED', updated_at = ?
      WHERE lifecycle_type = 'RETIREMENT' AND id LIKE ?
        AND EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = 'REJECTED' AND updated_at = ?)`)
      .bind(input.now, `${input.id}:%`, input.id, input.now),
  ];
}

// ── 3. 휴가 신청(구 양식) ───────────────────────────────────────────────────────

/** 휴가 신청을 승인된 상태로 등록한다. 결정자는 등록한 사람이다. */
export function insertApprovedLeaveRequest(db: D1Database, input: {
  id: string; employeeId: string; leaveType: string; startDate: string; endDate: string; units: number;
  reason: string; deducts: number; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  return [db.prepare(`INSERT INTO hr_leave_requests
    (id, employee_id, leave_type, start_date, end_date, units, reason, status,
      approver_employee_id, decided_at, created_at, updated_at, deducts, source, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, 'ERP', ?)`)
    .bind(input.id, input.employeeId, input.leaveType, input.startDate, input.endDate, input.units, input.reason,
      input.actorEmployeeId, input.now, input.now, input.now, input.deducts, input.actorEmployeeId)];
}

// ── 4. 급여월 ──────────────────────────────────────────────────────────────────

/**
 * 급여월 상태 전이. 급여월에는 결재 대기 상태가 따로 없었다(결재 중에도 REVIEW 였다).
 * - LOCKED: 작성·검토·승인 담당이 비어 있으면 행위자로 채우고 잠근다.
 * - APPROVED·LOCKED → DRAFT(재오픈): 승인·잠금을 풀고 사유를 남긴다.
 * - 그 밖: 일반 전이. REVIEW 이상이면 작성자, APPROVED 이상이면 검토·승인자를 행위자로 적는다.
 */
export function payrollRunTransition(db: D1Database, input: {
  period: string; from: string; to: string; actorEmployeeId: string; now: number; reason: string;
}): D1PreparedStatement[] {
  const { period, from, to, actorEmployeeId: actor, now, reason } = input;
  if (to === "LOCKED") {
    return [db.prepare(`UPDATE hr_payroll_runs SET status = 'LOCKED', prepared_by = CASE WHEN prepared_by = '' THEN ? ELSE prepared_by END,
      reviewed_by = CASE WHEN reviewed_by = '' THEN ? ELSE reviewed_by END, approved_by = ?, locked_at = ?, updated_at = ?
      WHERE period = ? AND status = ?`)
      .bind(actor, actor, actor, now, now, period, from)];
  }
  if (to === "DRAFT" && (from === "APPROVED" || from === "LOCKED")) {
    return [db.prepare(`UPDATE hr_payroll_runs SET status = 'DRAFT', approved_by = '', locked_at = NULL,
      reopened_reason = ?, updated_at = ? WHERE period = ? AND status IN ('APPROVED','LOCKED')`)
      .bind(reason, now, period)];
  }
  return [db.prepare(`UPDATE hr_payroll_runs SET status = ?, prepared_by = CASE WHEN ? IN ('REVIEW','APPROVED','LOCKED') THEN ? ELSE prepared_by END,
    reviewed_by = CASE WHEN ? IN ('APPROVED','LOCKED') THEN ? ELSE reviewed_by END,
    approved_by = CASE WHEN ? IN ('APPROVED','LOCKED') THEN ? ELSE '' END,
    locked_at = CASE WHEN ? = 'LOCKED' THEN ? ELSE NULL END,
    reopened_reason = CASE WHEN ? = 'DRAFT' THEN ? ELSE reopened_reason END, updated_at = ? WHERE period = ? AND status = ?`)
    .bind(to, to, actor, to, actor, to, actor, to, now, to, reason, now, period, from)];
}

// ── 5. 성과 최종 확정 ───────────────────────────────────────────────────────────

/** 보정을 마친 평가주기와 CALIBRATED 참여자를 한 batch 에서 FINALIZED 로 만든다. 라우트는 changes[0] === 1 을 요구한다. */
export function finalizePerformanceCycleStatements(db: D1Database, input: {
  cycleId: string; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  const { cycleId, actorEmployeeId: actor, now } = input;
  return [
    db.prepare(`UPDATE hr_performance_cycles SET status = 'FINALIZED', finalized_by = ?, finalized_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('CALIBRATION', ?)`)
      .bind(actor, now, now, cycleId, LEGACY_PENDING.performanceCycle),
    db.prepare(`UPDATE hr_performance_participants SET status = 'FINALIZED', finalized_by = ?, finalized_at = ?, updated_at = ?
      WHERE cycle_id = ? AND status = 'CALIBRATED'
        AND EXISTS (SELECT 1 FROM hr_performance_cycles WHERE id = ? AND status = 'FINALIZED' AND finalized_at = ?)`)
      .bind(actor, now, now, cycleId, cycleId, now),
  ];
}

// ── 6. 인력계획 승인 ────────────────────────────────────────────────────────────

/**
 * 같은 반기의 이전 승인본을 SUPERSEDED 로 돌리고 대상 계획을 승인한다. 이전 승인본은 대상이 아직
 * DRAFT·SUBMITTED 일 때만 바꾼다. 라우트는 changes[1] === 1 을 요구한다.
 */
export function approveWorkforcePlanStatements(db: D1Database, input: {
  planId: string; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  const { planId, actorEmployeeId: actor, now } = input;
  return [
    db.prepare(`UPDATE hr_workforce_plans SET status = 'SUPERSEDED', updated_at = ?
      WHERE period = (SELECT period FROM hr_workforce_plans WHERE id = ?)
        AND id <> ? AND status = 'APPROVED'
        AND EXISTS (SELECT 1 FROM hr_workforce_plans WHERE id = ? AND status IN ('DRAFT', ?))`)
      .bind(now, planId, planId, planId, LEGACY_PENDING.workforcePlan),
    db.prepare(`UPDATE hr_workforce_plans SET status = 'APPROVED', submitted_at = ?, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('DRAFT', ?)`)
      .bind(now, actor, now, now, planId, LEGACY_PENDING.workforcePlan),
  ];
}

// ── 7. 채용요청 모집 시작 ───────────────────────────────────────────────────────

/** 작성 중(또는 결재 시절 제출된) 채용요청을 모집 중(OPEN)으로 연다. 인원 검사는 라우트가 먼저 한다. */
export function openRequisitionStatement(db: D1Database, input: {
  id: string; actorEmployeeId: string; now: number;
}): D1PreparedStatement[] {
  return [db.prepare(`UPDATE hr_recruitment_requisitions SET status = 'OPEN', approved_by = ?, approved_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('DRAFT', ?)`)
    .bind(input.actorEmployeeId, input.now, input.now, input.id, LEGACY_PENDING.requisition)];
}
