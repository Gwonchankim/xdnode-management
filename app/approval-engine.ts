import type { ErpPrincipal, ErpRole } from "./erp-platform";

export type ApprovalModule = "finance" | "hr" | "recruitment" | "sales" | "settings";
export type ApprovalPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export type ApprovalCreateInput = {
  module: ApprovalModule;
  requestType: string;
  title: string;
  description?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  amount?: number;
  currency?: string;
  priority?: ApprovalPriority;
  dueDate?: string;
  metadata?: Record<string, unknown>;
};

type ApprovalRouteStep = { name: string; role: ErpRole; employeeId?: string };
type AccessRow = { employee_id: string; roles_json: string };
type PolicyRow = { id: string };
type PolicyStepRow = { step_name: string; approver_role: ErpRole; approver_employee_id: string };
type DelegationRow = { delegator_employee_id: string; delegate_employee_id: string; module: string };

export const approvalTypeLabels: Record<ApprovalModule, Record<string, string>> = {
  finance: { EXPENSE: "지출 승인", BUDGET: "예산 승인", CLOSE: "월마감 승인", REPORT: "경영보고 승인", PAYMENT: "지급 승인", PURCHASE_ORDER: "발주 승인", MASTER_DATA: "재무 마스터 승인", DATA_IMPORT: "재무 데이터 반영 승인", IMPORT_MAPPING: "재무 파일 매핑 승인", JOURNAL_POSTING: "분개 전기 승인", OPENING_BALANCE: "개시잔액 기준선 승인" },
  hr: { LEAVE_REQUEST: "휴가 승인", PERSONNEL_ACTION: "인사발령 승인", PAYROLL_RUN: "급여 승인", RETIREMENT: "퇴직 승인", WORKFORCE_PLAN: "인력계획 승인", PERFORMANCE_CYCLE: "성과평가 최종확정", DATA_IMPORT: "HR 데이터 반영 승인" },
  recruitment: { REQUISITION: "채용요청 승인", OFFER: "채용 제안 승인", DIRECT_INTERVIEW: "면접 직접등록 승인" },
  sales: { QUOTE: "견적 승인", ORDER: "수주 승인", DELIVERY: "납품 승인", INVOICE: "청구 승인", PAYMENT: "수금 승인", INCENTIVE_RULE: "인센티브 규정 승인", TARGET_PLAN: "영업 목표 승인", SPECIAL_INCENTIVE: "특별 인센티브 승인", DISCOUNT: "가격·할인 예외 승인", CONTRACT: "계약 활성화 승인", CONTRACT_CHANGE: "계약 변경 승인", SERVICE_POLICY: "고객지원 SLA 승인", SERVICE_RESOLUTION: "고객 이슈 처리 승인" },
  settings: { MASTER_IMPACT_REPORT: "기준정보 위험 주간보고 승인" },
};

export function isApprovalType(module: ApprovalModule, requestType: string) {
  return Object.prototype.hasOwnProperty.call(approvalTypeLabels[module], requestType);
}

function defaultRouteFor(input: ApprovalCreateInput): ApprovalRouteStep[] {
  if (input.module === "finance") {
    if (input.requestType === "CLOSE") return [{ name: "재무 검토", role: "FINANCE_ADMIN" }, { name: "대표 승인", role: "SUPER_ADMIN" }];
    return [{ name: "재무 검토", role: "FINANCE_ADMIN" }, { name: "대표 승인", role: "SUPER_ADMIN" }];
  }
  if (input.module === "hr") {
    if (input.requestType === "LEAVE_REQUEST") return [{ name: "인사 승인", role: "HR_ADMIN" }];
    return [{ name: "인사 검토", role: "HR_ADMIN" }, { name: "대표 승인", role: "SUPER_ADMIN" }];
  }
  if (input.module === "recruitment") {
    return [{ name: "인사 검토", role: "HR_ADMIN" }, { name: "대표 승인", role: "SUPER_ADMIN" }];
  }
  if (input.module === "settings") return [{ name: "경영 책임자 승인", role: "SUPER_ADMIN" }];
  if (input.requestType === "QUOTE" && (input.amount ?? 0) < 10_000_000) {
    return [{ name: "영업 승인", role: "SALES_ADMIN" }];
  }
  return [{ name: "영업 검토", role: "SALES_ADMIN" }, { name: "대표 승인", role: "SUPER_ADMIN" }];
}

export function defaultApprovalRoute(module: ApprovalModule, requestType: string, amount = 0) {
  return defaultRouteFor({ module, requestType, title: "", amount });
}

function parseRoles(value: string): ErpRole[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((role): role is ErpRole => typeof role === "string") : [];
  } catch {
    return [];
  }
}

async function configuredRouteFor(db: D1Database, input: ApprovalCreateInput) {
  const amount = Math.max(0, Math.round(input.amount ?? 0));
  const policy = await db.prepare(`SELECT id FROM erp_approval_policies
    WHERE module = ? AND request_type = ? AND active = 1 AND min_amount <= ?
      AND (max_amount IS NULL OR max_amount >= ?)
    ORDER BY priority DESC, min_amount DESC, updated_at DESC LIMIT 1`)
    .bind(input.module, input.requestType, amount, amount).first<PolicyRow>();
  if (!policy) return { policyId: "", steps: defaultRouteFor(input) };
  const result = await db.prepare(`SELECT step_name, approver_role, approver_employee_id
    FROM erp_approval_policy_steps WHERE policy_id = ? ORDER BY step_order`).bind(policy.id).all<PolicyStepRow>();
  if (!result.results.length) throw new Error("선택된 결재 규칙에 결재 단계가 없습니다.");
  return {
    policyId: policy.id,
    steps: result.results.map((step) => ({ name: step.step_name, role: step.approver_role, employeeId: step.approver_employee_id || undefined })),
  };
}

async function resolveApprovers(db: D1Database, steps: ApprovalRouteStep[], requesterEmployeeId: string, module: ApprovalModule) {
  const today = new Date().toISOString().slice(0, 10);
  const [access, delegationResult] = await Promise.all([
    db.prepare(`SELECT employee_id, roles_json FROM erp_user_access
    WHERE active = 1 ORDER BY CASE WHEN employee_id = ? THEN 1 ELSE 0 END, created_at ASC`)
      .bind(requesterEmployeeId).all<AccessRow>(),
    db.prepare(`SELECT delegator_employee_id, delegate_employee_id, module FROM erp_approval_delegations
      WHERE active = 1 AND starts_on <= ? AND ends_on >= ? AND (module = ? OR module = 'all')
      ORDER BY CASE WHEN module = ? THEN 0 ELSE 1 END, updated_at DESC`)
      .bind(today, today, module, module).all<DelegationRow>(),
  ]);
  const activeIds = new Set(access.results.map((row) => row.employee_id));
  return steps.map((step) => {
    const explicit = step.employeeId ? access.results.find((row) => row.employee_id === step.employeeId) : undefined;
    const exact = step.employeeId ? explicit : access.results.find((row) => parseRoles(row.roles_json).includes(step.role));
    const superAdmin = access.results.find((row) => parseRoles(row.roles_json).includes("SUPER_ADMIN"));
    const originalEmployeeId = exact?.employee_id ?? (step.employeeId ? "" : superAdmin?.employee_id ?? "");
    const delegation = delegationResult.results.find((item) => item.delegator_employee_id === originalEmployeeId && activeIds.has(item.delegate_employee_id));
    return {
      ...step,
      employeeId: delegation?.delegate_employee_id ?? originalEmployeeId,
      delegatedFromEmployeeId: delegation ? originalEmployeeId : "",
    };
  });
}

// Single-operator deployments hold every approver role themselves, so a route that resolves entirely
// to the requester is a self-approval — waiting on it is pure friction with no real second reviewer.
// Scoped to an explicit allowlist (currently PAYROLL_RUN only) rather than every request type, since
// each target entity's outcome side effects (buildApprovalOutcomeStatements) need to be safe to fire
// immediately, unattended, at submit time.
// 퇴직 요청도 결재선을 탄다. 결재선이 요청자 본인뿐인 소규모 운영에서는 즉시 승인되어 예전과 같은 흐름이 된다.
const AUTO_APPROVE_WHEN_SELF = new Set<string>(["hr:PAYROLL_RUN", "hr:RETIREMENT", "recruitment:REQUISITION"]);

// Lets a feature route find out, before it commits to a draft-then-submit flow, whether the request
// would be auto-approved anyway because the requester is the only person on the resolved route. A
// route that knows this can finish the job at registration instead of parking the record in a draft
// state whose only exit is a decision the same person would rubber-stamp.
export async function willAutoApproveForSelf(db: D1Database, principal: ErpPrincipal, input: ApprovalCreateInput) {
  if (!AUTO_APPROVE_WHEN_SELF.has(`${input.module}:${input.requestType}`)) return false;
  if (!isApprovalType(input.module, input.requestType)) return false;
  try {
    const configured = await configuredRouteFor(db, input);
    const route = await resolveApprovers(db, configured.steps, principal.employeeId, input.module);
    return route.length > 0 && route.every((step) => step.employeeId === principal.employeeId);
  } catch {
    // An unresolvable route is not an auto-approval; let the normal submit path raise the real error.
    return false;
  }
}

export async function createApprovalRequest(db: D1Database, principal: ErpPrincipal, input: ApprovalCreateInput) {
  if (!isApprovalType(input.module, input.requestType)) throw new Error("지원하지 않는 결재 유형입니다.");
  const configured = await configuredRouteFor(db, input);
  const route = await resolveApprovers(db, configured.steps, principal.employeeId, input.module);
  if (route.some((step) => !step.employeeId)) throw new Error("결재선에 필요한 승인 권한 사용자가 없습니다.");

  const now = Date.now();
  const id = crypto.randomUUID();
  const amount = Math.max(0, Math.round(input.amount ?? 0));
  const priority = input.priority ?? "NORMAL";
  const dueDate = input.dueDate ?? "";

  const selfApprovable = AUTO_APPROVE_WHEN_SELF.has(`${input.module}:${input.requestType}`)
    && route.length > 0 && route.every((step) => step.employeeId === principal.employeeId);
  if (selfApprovable) {
    const transitionToken = crypto.randomUUID();
    const autoNote = "요청자와 승인자가 동일하여 자동 승인";
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO erp_approval_requests
        (id, module, request_type, title, description, requester_employee_id, target_entity_type,
          target_entity_id, amount, currency, priority, status, current_step, due_date, metadata_json,
          version, transition_token, submitted_at, decided_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .bind(id, input.module, input.requestType, input.title, input.description ?? "", principal.employeeId,
          input.targetEntityType ?? "", input.targetEntityId ?? "", amount, input.currency ?? "KRW", priority,
          route.length, dueDate, JSON.stringify(input.metadata ?? {}), transitionToken, now, now, now, now),
      db.prepare(`INSERT INTO erp_approval_events
        (id, request_id, step_order, action, actor_employee_id, comment, snapshot_json, created_at)
        VALUES (?, ?, 0, 'SUBMITTED', ?, '', ?, ?)`)
        .bind(crypto.randomUUID(), id, principal.employeeId, JSON.stringify({ module: input.module, requestType: input.requestType, title: input.title, policyId: configured.policyId, route, autoApproved: true }), now),
    ];
    route.forEach((step, index) => {
      statements.push(db.prepare(`INSERT INTO erp_approval_steps
        (id, request_id, step_order, step_name, approver_role, approver_employee_id, delegated_from_employee_id, status,
          comment, acted_by, acted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, index + 1, step.name, step.role, step.employeeId, step.delegatedFromEmployeeId,
          autoNote, principal.employeeId, now, now, now));
      statements.push(db.prepare(`INSERT INTO erp_approval_events
        (id, request_id, step_order, action, actor_employee_id, comment, snapshot_json, created_at)
        VALUES (?, ?, ?, 'APPROVE', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, index + 1, principal.employeeId, autoNote, JSON.stringify({ autoApproved: true }), now));
    });
    statements.push(...buildApprovalOutcomeStatements(db, input.targetEntityType ?? "", input.targetEntityId ?? "", true, principal.employeeId, now, id, transitionToken));
    await db.batch(statements);
    return { id, status: "APPROVED", currentStep: route.length, version: 1, route, autoApproved: true };
  }

  const statements = [
    db.prepare(`INSERT INTO erp_approval_requests
      (id, module, request_type, title, description, requester_employee_id, target_entity_type,
        target_entity_id, amount, currency, priority, status, current_step, due_date, metadata_json,
        version, transition_token, submitted_at, decided_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 1, ?, ?, 1, '', ?, NULL, ?, ?)`)
      .bind(id, input.module, input.requestType, input.title, input.description ?? "", principal.employeeId,
        input.targetEntityType ?? "", input.targetEntityId ?? "", amount, input.currency ?? "KRW", priority,
        dueDate, JSON.stringify(input.metadata ?? {}), now, now, now),
    db.prepare(`INSERT INTO erp_approval_events
      (id, request_id, step_order, action, actor_employee_id, comment, snapshot_json, created_at)
      VALUES (?, ?, 0, 'SUBMITTED', ?, '', ?, ?)`)
      .bind(crypto.randomUUID(), id, principal.employeeId, JSON.stringify({ module: input.module, requestType: input.requestType, title: input.title, policyId: configured.policyId, route }), now),
  ];
  route.forEach((step, index) => statements.push(db.prepare(`INSERT INTO erp_approval_steps
    (id, request_id, step_order, step_name, approver_role, approver_employee_id, delegated_from_employee_id, status,
      comment, acted_by, acted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', NULL, ?, ?)`)
    .bind(crypto.randomUUID(), id, index + 1, step.name, step.role, step.employeeId, step.delegatedFromEmployeeId, index === 0 ? "PENDING" : "WAITING", now, now)));
  statements.push(db.prepare(`INSERT INTO erp_tasks
    (id, module, category, title, description, owner_employee_id, due_date, status, priority,
      destination, source_type, source_id, created_at, updated_at)
    VALUES (?, ?, '전자결재', ?, ?, ?, ?, 'OPEN', ?, 'approval:center', 'APPROVAL', ?, ?, ?)`)
    .bind(`approval:${id}:1`, input.module, input.title, `${approvalTypeLabels[input.module][input.requestType]} · ${route[0].name}`,
      route[0].employeeId, dueDate, priority, id, now, now));
  await db.batch(statements);
  return { id, status: "SUBMITTED", currentStep: 1, version: 1, route };
}

export function buildApprovalOutcomeStatements(db: D1Database, targetEntityType: string, targetEntityId: string, approved: boolean, actorEmployeeId: string, now: number, requestId: string, transitionToken: string) {
  if (!targetEntityType || !targetEntityId) return [];
  if (targetEntityType === "MASTER_IMPACT_WEEKLY_REPORT") {
    return [
      db.prepare(`UPDATE erp_master_impact_weekly_reports SET status = ?, approved_by = ?, approved_at = ?, workflow_version = workflow_version + 1
        WHERE id = ? AND status = 'SUBMITTED' AND approval_request_id = ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(approved ? "APPROVED" : "REJECTED", actorEmployeeId, now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`INSERT INTO erp_master_impact_weekly_report_events
        (id, report_id, action, actor_employee_id, note, snapshot_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM erp_master_impact_weekly_reports WHERE id = ? AND approval_request_id = ? AND status = ?)`)
        .bind(crypto.randomUUID(), targetEntityId, approved ? "APPROVED" : "REJECTED", actorEmployeeId,
          approved ? "전자결재 최종 승인" : "전자결재 반려", JSON.stringify({ approvalRequestId: requestId }), now,
          targetEntityId, requestId, approved ? "APPROVED" : "REJECTED"),
    ];
  } else if (targetEntityType === "FINANCE_OPENING_BALANCE_SET") {
    return [
      db.prepare(`UPDATE finance_opening_balance_sets SET status=?,approved_by=?,approved_at=?,updated_at=? WHERE id=? AND status='SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`).bind(approved?"APPROVED":"REJECTED",actorEmployeeId,now,now,targetEntityId,requestId,transitionToken),
      db.prepare(`INSERT INTO finance_opening_balance_events(id,set_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at) SELECT ?,?,?, 'SUBMITTED',?,?,?,'{}',? WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`).bind(crypto.randomUUID(),targetEntityId,approved?"APPROVED":"REJECTED",approved?"APPROVED":"REJECTED",actorEmployeeId,approved?"전자결재 최종 승인·공식 개시 기준선 잠금":"전자결재 반려",now,requestId,transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_POSTING_BATCH") {
    return [
      db.prepare(`UPDATE finance_posting_batches SET status=?,approved_by=?,approved_at=?,version=version+1,updated_at=?
        WHERE id=? AND status='SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(approved ? "APPROVED" : "REJECTED", actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`INSERT INTO finance_posting_events (id,batch_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at)
        SELECT ?,?,?, 'SUBMITTED',?,?,?,'{}',? WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(crypto.randomUUID(), targetEntityId, approved ? "APPROVED" : "REJECTED", approved ? "APPROVED" : "REJECTED", actorEmployeeId, approved ? "전자결재 최종 승인. 사용자 전기 확인 대기" : "전자결재 반려", now, requestId, transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_IMPORT_MAPPING_SET") {
    if (!approved) return [
      db.prepare(`UPDATE finance_import_mapping_sets SET status='REJECTED',approved_by=?,approved_at=?,updated_at=?
        WHERE id=? AND status='SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`INSERT INTO finance_import_mapping_events (id,mapping_set_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at)
        SELECT ?,?,'REJECTED','SUBMITTED','REJECTED',?,'전자결재 반려','{}',? WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(crypto.randomUUID(), targetEntityId, actorEmployeeId, now, requestId, transitionToken),
    ];
    return [
      db.prepare(`UPDATE finance_import_mapping_sets SET status='SUPERSEDED',updated_at=?
        WHERE source_id=(SELECT source_id FROM finance_import_mapping_sets WHERE id=? AND status='SUBMITTED')
          AND data_type=(SELECT data_type FROM finance_import_mapping_sets WHERE id=? AND status='SUBMITTED')
          AND id<>? AND status='ACTIVE'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(now, targetEntityId, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_import_mapping_sets SET status='ACTIVE',approved_by=?,approved_at=?,updated_at=?
        WHERE id=? AND status='SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`INSERT INTO finance_import_mapping_events (id,mapping_set_id,action,from_status,to_status,actor_employee_id,note,snapshot_json,created_at)
        SELECT ?,?,'ACTIVATED','SUBMITTED','ACTIVE',?,'전자결재 최종 승인 후 활성화','{}',? WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id=? AND transition_token=?)`)
        .bind(crypto.randomUUID(), targetEntityId, actorEmployeeId, now, requestId, transitionToken),
    ];
  } else if (targetEntityType === "DATA_IMPORT_BATCH") {
    return [db.prepare(`UPDATE erp_data_import_batches SET status = ?, approved_at = ?, version = version + 1,
      updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REJECTED", approved ? now : null, now, targetEntityId, requestId, transitionToken),
    db.prepare(`INSERT INTO erp_data_import_events
      (id, batch_id, action, from_status, to_status, actor_employee_id, note, snapshot_json, created_at)
      SELECT ?, ?, ?, 'SUBMITTED', ?, ?, ?, '{}', ?
      WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(crypto.randomUUID(), targetEntityId, approved ? "APPROVED" : "REJECTED", approved ? "APPROVED" : "REJECTED",
        actorEmployeeId, approved ? "전자결재 최종 승인" : "전자결재 반려", now, requestId, transitionToken)];
  } else if (targetEntityType === "HR_LEAVE") {
    return [db.prepare(`UPDATE hr_leave_requests SET status = ?, approver_employee_id = ?, decided_at = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REJECTED", actorEmployeeId, now, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "HR_PERSONNEL_ACTION") {
    const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const statements = [db.prepare(`UPDATE hr_personnel_actions SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REJECTED", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
    if (approved) {
      statements.push(db.prepare(`UPDATE hr_employee_records SET
        department = COALESCE(NULLIF((SELECT json_extract(after_json, '$.department') FROM hr_personnel_actions WHERE id = ?), ''), department),
        position = COALESCE(NULLIF((SELECT json_extract(after_json, '$.position') FROM hr_personnel_actions WHERE id = ?), ''), position),
        history_json = json_insert(CASE WHEN json_valid(history_json) THEN history_json ELSE '[]' END, '$[#]',
          json((SELECT json_object('date', replace(effective_date, '-', '.'), 'type', action_type, 'detail', reason)
            FROM hr_personnel_actions WHERE id = ?))),
        updated_at = ?
        WHERE employee_id = (SELECT employee_id FROM hr_personnel_actions WHERE id = ?)
          AND (SELECT effective_date FROM hr_personnel_actions WHERE id = ?) <= ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, targetEntityId, now, targetEntityId, targetEntityId, koreaDate, requestId, transitionToken),
      db.prepare(`UPDATE hr_personnel_actions SET status = 'EFFECTIVE', updated_at = ? WHERE id = ? AND status = 'APPROVED'
        AND effective_date <= ? AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, koreaDate, requestId, transitionToken));
    }
    return statements;
  } else if (targetEntityType === "PAYROLL_RUN") {
    return [db.prepare(`UPDATE hr_payroll_runs SET status = ?, approved_by = ?, updated_at = ? WHERE period = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REVIEW", approved ? actorEmployeeId : "", now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "HR_WORKFORCE_PLAN") {
    if (!approved) return [db.prepare(`UPDATE hr_workforce_plans SET status = 'DRAFT', submitted_at = NULL,
      updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE hr_workforce_plans SET status = 'SUPERSEDED', updated_at = ?
        WHERE period = (SELECT period FROM hr_workforce_plans WHERE id = ?)
          AND id <> ? AND status = 'APPROVED'
          AND (SELECT status FROM hr_workforce_plans WHERE id = ?) = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE hr_workforce_plans SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_BUDGET") {
    return [db.prepare(`UPDATE finance_budgets SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "DRAFT", approved ? actorEmployeeId : "", now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "FINANCE_BUDGET_PLAN") {
    if (!approved) return [db.prepare(`UPDATE finance_budget_plans SET status = 'DRAFT', submitted_at = NULL,
      updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE finance_budget_plans SET status = 'SUPERSEDED', updated_at = ?
        WHERE fiscal_year = (SELECT fiscal_year FROM finance_budget_plans WHERE id = ?)
          AND id <> ? AND status = 'APPROVED'
          AND (SELECT status FROM finance_budget_plans WHERE id = ?) = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_budget_plans SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_CLOSE") {
    return [db.prepare(`UPDATE finance_close_tasks SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "OPEN", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "FINANCE_CLOSE_RUN") {
    return [db.prepare(`UPDATE finance_close_runs SET status = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE period = ?
      AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "CLOSED" : "OPEN", approved ? actorEmployeeId : "", approved ? now : null,
        now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "FINANCE_CLOSE_REOPEN") {
    if (!approved) return [db.prepare(`UPDATE finance_close_runs SET updated_at = updated_at WHERE period = ? AND status = 'CLOSED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(targetEntityId, requestId, transitionToken)];
    return [db.prepare(`UPDATE finance_close_runs SET status = 'OPEN', reopened_by = ?, reopened_at = ?,
      reopened_reason = COALESCE((SELECT json_extract(metadata_json, '$.reopenedReason') FROM erp_approval_requests WHERE id = ?), ''),
      version = version + 1, updated_at = ? WHERE period = ? AND status = 'CLOSED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(actorEmployeeId, now, requestId, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "FINANCE_MANAGEMENT_REPORT") {
    if (!approved) return [
      db.prepare(`UPDATE finance_management_reports SET status = 'DRAFT',
        submitted_at = NULL, quality_acknowledged = 0, updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_management_decisions SET status = 'DRAFT', updated_at = ?
        WHERE report_id = ? AND status = 'PENDING'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, requestId, transitionToken),
    ];
    return [
      db.prepare(`UPDATE finance_management_reports SET status = 'SUPERSEDED', updated_at = ?
        WHERE period = (SELECT period FROM finance_management_reports WHERE id = ?)
          AND id <> ? AND status = 'APPROVED'
          AND (SELECT status FROM finance_management_reports WHERE id = ?) = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_management_reports SET status = 'APPROVED', approved_by = ?, approved_at = ?,
        updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_MASTER_CHANGE") {
    if (!approved) return [db.prepare(`UPDATE finance_master_change_requests SET status = 'REJECTED',
      approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`INSERT OR IGNORE INTO finance_master_accounts
        (id, code, name, category, normal_balance, statement_line, liquidity, status, source, valid_from, valid_to, created_by, created_at, updated_at)
        SELECT target_id, json_extract(after_json, '$.code'), json_extract(after_json, '$.name'),
          json_extract(after_json, '$.category'), json_extract(after_json, '$.normalBalance'),
          COALESCE(json_extract(after_json, '$.statementLine'), ''), COALESCE(json_extract(after_json, '$.liquidity'), ''), 'ACTIVE', 'MANUAL',
          COALESCE(json_extract(after_json, '$.validFrom'), ''), COALESCE(json_extract(after_json, '$.validTo'), ''),
          created_by, ?, ? FROM finance_master_change_requests WHERE id = ? AND target_type = 'ACCOUNT' AND change_type = 'CREATE'
          AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_master_accounts SET
          code = COALESCE((SELECT json_extract(after_json, '$.code') FROM finance_master_change_requests WHERE id = ?), code),
          name = COALESCE((SELECT json_extract(after_json, '$.name') FROM finance_master_change_requests WHERE id = ?), name),
          category = COALESCE((SELECT json_extract(after_json, '$.category') FROM finance_master_change_requests WHERE id = ?), category),
          normal_balance = COALESCE((SELECT json_extract(after_json, '$.normalBalance') FROM finance_master_change_requests WHERE id = ?), normal_balance),
          statement_line = COALESCE((SELECT json_extract(after_json, '$.statementLine') FROM finance_master_change_requests WHERE id = ?), statement_line),
          liquidity = COALESCE((SELECT json_extract(after_json, '$.liquidity') FROM finance_master_change_requests WHERE id = ?), liquidity),
          status = COALESCE((SELECT json_extract(after_json, '$.status') FROM finance_master_change_requests WHERE id = ?), status), updated_at = ?
        WHERE id = (SELECT target_id FROM finance_master_change_requests WHERE id = ? AND target_type = 'ACCOUNT' AND change_type <> 'CREATE')
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, now, targetEntityId, requestId, transitionToken),
      db.prepare(`INSERT OR IGNORE INTO finance_master_partners
        (id, canonical_name, normalized_key, business_number, partner_type, payment_terms_days, status, source, created_by, created_at, updated_at)
        SELECT target_id, json_extract(after_json, '$.canonicalName'), json_extract(after_json, '$.normalizedKey'),
          COALESCE(json_extract(after_json, '$.businessNumber'), ''), json_extract(after_json, '$.partnerType'),
          COALESCE(json_extract(after_json, '$.paymentTermsDays'), 30), 'ACTIVE', 'MANUAL', created_by, ?, ?
        FROM finance_master_change_requests WHERE id = ? AND target_type = 'PARTNER' AND change_type = 'CREATE'
          AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_master_partners SET
          canonical_name = COALESCE((SELECT json_extract(after_json, '$.canonicalName') FROM finance_master_change_requests WHERE id = ?), canonical_name),
          normalized_key = COALESCE((SELECT json_extract(after_json, '$.normalizedKey') FROM finance_master_change_requests WHERE id = ?), normalized_key),
          business_number = COALESCE((SELECT json_extract(after_json, '$.businessNumber') FROM finance_master_change_requests WHERE id = ?), business_number),
          partner_type = COALESCE((SELECT json_extract(after_json, '$.partnerType') FROM finance_master_change_requests WHERE id = ?), partner_type),
          payment_terms_days = COALESCE((SELECT json_extract(after_json, '$.paymentTermsDays') FROM finance_master_change_requests WHERE id = ?), payment_terms_days),
          status = COALESCE((SELECT json_extract(after_json, '$.status') FROM finance_master_change_requests WHERE id = ?), status), updated_at = ?
        WHERE id = (SELECT target_id FROM finance_master_change_requests WHERE id = ? AND target_type = 'PARTNER' AND change_type <> 'CREATE')
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, now, targetEntityId, requestId, transitionToken),
      db.prepare(`INSERT OR IGNORE INTO finance_master_tax_codes
        (id, code, name, direction, rate_basis_points, status, effective_from, effective_to, created_by, created_at, updated_at)
        SELECT target_id, json_extract(after_json, '$.code'), json_extract(after_json, '$.name'),
          json_extract(after_json, '$.direction'), COALESCE(json_extract(after_json, '$.rateBasisPoints'), 0), 'ACTIVE',
          COALESCE(json_extract(after_json, '$.effectiveFrom'), ''), COALESCE(json_extract(after_json, '$.effectiveTo'), ''), created_by, ?, ?
        FROM finance_master_change_requests WHERE id = ? AND target_type = 'TAX' AND change_type = 'CREATE'
          AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_master_tax_codes SET
          code = COALESCE((SELECT json_extract(after_json, '$.code') FROM finance_master_change_requests WHERE id = ?), code),
          name = COALESCE((SELECT json_extract(after_json, '$.name') FROM finance_master_change_requests WHERE id = ?), name),
          direction = COALESCE((SELECT json_extract(after_json, '$.direction') FROM finance_master_change_requests WHERE id = ?), direction),
          rate_basis_points = COALESCE((SELECT json_extract(after_json, '$.rateBasisPoints') FROM finance_master_change_requests WHERE id = ?), rate_basis_points),
          status = COALESCE((SELECT json_extract(after_json, '$.status') FROM finance_master_change_requests WHERE id = ?), status), updated_at = ?
        WHERE id = (SELECT target_id FROM finance_master_change_requests WHERE id = ? AND target_type = 'TAX' AND change_type <> 'CREATE')
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_master_bank_accounts SET
          gl_account_code = COALESCE((SELECT json_extract(after_json, '$.glAccountCode') FROM finance_master_change_requests WHERE id = ?), gl_account_code),
          status = COALESCE((SELECT json_extract(after_json, '$.status') FROM finance_master_change_requests WHERE id = ?), status), updated_at = ?
        WHERE id = (SELECT target_id FROM finance_master_change_requests WHERE id = ? AND target_type = 'BANK')
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE finance_master_change_requests SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "FINANCE_EXPENSE") {
    return [db.prepare(`UPDATE finance_expense_requests SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REJECTED", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "PURCHASE_ORDER") {
    return [db.prepare(`UPDATE finance_purchase_orders SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "DRAFT", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "HR_RETIREMENT") {
    const status = approved ? "IN_PROGRESS" : "REJECTED";
    const statements = [db.prepare(`UPDATE hr_retirement_requests SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(status, approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
    if (approved) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO hr_retirement_settlements
        (request_id, final_salary, retirement_pay, unused_leave_pay, deductions, net_settlement,
          payroll_confirmed, insurance_confirmed, access_revoked, assets_returned, handover_confirmed,
          status, prepared_by, completed_by, completed_at, created_at, updated_at)
        SELECT ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'DRAFT', '', '', NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)
          AND EXISTS (SELECT 1 FROM hr_retirement_requests WHERE id = ? AND status = 'IN_PROGRESS' AND updated_at = ?)`)
        .bind(targetEntityId, now, now, requestId, transitionToken, targetEntityId, now),
      db.prepare(`UPDATE hr_employee_records SET status = '퇴직 예정',
        retirement_json = json((SELECT json_object('requestId', id, 'date', retirement_date, 'reason', reason,
          'completedTaskIds', json(checklist_json), 'status', 'IN_PROGRESS') FROM hr_retirement_requests WHERE id = ?)),
        history_json = json_insert(CASE WHEN json_valid(history_json) THEN history_json ELSE '[]' END, '$[#]',
          json((SELECT json_object('date', strftime('%Y.%m.%d', 'now', '+9 hours'), 'type', '퇴직 절차',
            'detail', retirement_date || ' 퇴직 예정 · ' || reason || ' · 결재 승인') FROM hr_retirement_requests WHERE id = ?))),
        updated_at = ? WHERE employee_id = (SELECT employee_id FROM hr_retirement_requests WHERE id = ?)
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, now, targetEntityId, requestId, transitionToken));
    } else {
      statements.push(db.prepare(`UPDATE hr_lifecycle_tasks SET status = 'CANCELLED', updated_at = ?
        WHERE lifecycle_type = 'RETIREMENT' AND id LIKE ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, `${targetEntityId}:%`, requestId, transitionToken));
    }
    return statements;
  } else if (targetEntityType === "RECRUITMENT_OFFER") {
    return [
      db.prepare(`UPDATE hr_offer_requests SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
        AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(approved ? "APPROVED" : "REJECTED", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE hr_applicants SET stage = ?, updated_at = ?
        WHERE id = (SELECT applicant_id FROM hr_offer_requests WHERE id = ?)
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(approved ? "채용 제안 승인" : "채용 제안 반려", now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "HR_RECRUITMENT_REQUISITION") {
    return [db.prepare(`UPDATE hr_recruitment_requisitions
      SET status = ?, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "OPEN" : "REJECTED", approved ? actorEmployeeId : "", approved ? now : null,
        now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "HR_PERFORMANCE_CYCLE") {
    if (!approved) return [db.prepare(`UPDATE hr_performance_cycles SET status = 'CALIBRATION', updated_at = ?
      WHERE id = ? AND status = 'FINALIZATION_SUBMITTED'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE hr_performance_cycles SET status = 'FINALIZED', finalized_by = ?, finalized_at = ?, updated_at = ?
        WHERE id = ? AND status = 'FINALIZATION_SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE hr_performance_participants SET status = 'FINALIZED', finalized_by = ?, finalized_at = ?, updated_at = ?
        WHERE cycle_id = ? AND status = 'CALIBRATED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)
          AND EXISTS (SELECT 1 FROM hr_performance_cycles WHERE id = ? AND status = 'FINALIZED' AND finalized_at = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken, targetEntityId, now),
    ];
  } else if (targetEntityType === "SALES_DOCUMENT") {
    return [db.prepare(`UPDATE sales_documents SET status = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "ACCEPTED" : "DRAFT", now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "SALES_PRICING_REVIEW") {
    return [db.prepare(`UPDATE sales_document_pricing_reviews SET outcome = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE document_id = ? AND outcome = 'APPROVAL_PENDING' AND approval_request_id = ?
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "REJECTED", actorEmployeeId, now, now, targetEntityId, requestId, requestId, transitionToken)];
  } else if (targetEntityType === "SALES_CONTRACT") {
    return [db.prepare(`UPDATE sales_contracts SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?
      AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "ACTIVE" : "DRAFT", approved ? actorEmployeeId : "", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
  } else if (targetEntityType === "SALES_CONTRACT_CHANGE") {
    const koreaDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!approved) return [db.prepare(`UPDATE sales_contract_change_requests SET status = 'REJECTED', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED' AND approval_request_id = ?
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(actorEmployeeId, now, now, targetEntityId, requestId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE sales_contracts SET
        end_date = COALESCE((SELECT json_extract(after_json, '$.endDate') FROM sales_contract_change_requests WHERE id = ?), end_date),
        payment_terms = COALESCE((SELECT json_extract(after_json, '$.paymentTerms') FROM sales_contract_change_requests WHERE id = ?), payment_terms),
        acceptance_criteria = COALESCE((SELECT json_extract(after_json, '$.acceptanceCriteria') FROM sales_contract_change_requests WHERE id = ?), acceptance_criteria),
        delivery_terms = COALESCE((SELECT json_extract(after_json, '$.deliveryTerms') FROM sales_contract_change_requests WHERE id = ?), delivery_terms),
        owner_employee_id = COALESCE((SELECT json_extract(after_json, '$.ownerEmployeeId') FROM sales_contract_change_requests WHERE id = ?), owner_employee_id),
        auto_renewal = COALESCE((SELECT CAST(json_extract(after_json, '$.autoRenewal') AS INTEGER) FROM sales_contract_change_requests WHERE id = ?), auto_renewal),
        renewal_notice_days = COALESCE((SELECT json_extract(after_json, '$.renewalNoticeDays') FROM sales_contract_change_requests WHERE id = ?), renewal_notice_days),
        status = COALESCE((SELECT json_extract(after_json, '$.status') FROM sales_contract_change_requests WHERE id = ?), status),
        version = version + 1, updated_at = ?
        WHERE id = (SELECT contract_id FROM sales_contract_change_requests WHERE id = ? AND status = 'SUBMITTED' AND effective_date <= ?)
          AND status = 'ACTIVE' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId, targetEntityId,
          now, targetEntityId, koreaDate, requestId, transitionToken),
      db.prepare(`UPDATE sales_contract_change_requests SET status = CASE WHEN effective_date <= ? THEN 'APPROVED' ELSE 'SCHEDULED' END,
        approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTED' AND approval_request_id = ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(koreaDate, actorEmployeeId, now, now, targetEntityId, requestId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "SALES_SERVICE_POLICY") {
    if (!approved) return [db.prepare(`UPDATE sales_service_policies SET status = 'REJECTED', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE sales_service_policies SET status = 'RETIRED', updated_at = ?
        WHERE status = 'ACTIVE' AND priority = (SELECT priority FROM sales_service_policies WHERE id = ? AND status = 'SUBMITTED')
          AND id <> ? AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE sales_service_policies SET status = 'ACTIVE', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "SALES_SERVICE_CASE") {
    if (!approved) return [
      db.prepare(`UPDATE sales_service_cases SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ? AND status = 'RESOLUTION_SUBMITTED'
        AND approval_request_id = ? AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`INSERT INTO sales_service_case_events (id, case_id, event_type, note, actor_employee_id, created_at)
        SELECT ?, id, 'RESOLUTION_REJECTED', '처리안 결재 반려', ?, ? FROM sales_service_cases WHERE id = ? AND status = 'IN_PROGRESS'
          AND approval_request_id = ? AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(`service-resolution-rejected:${requestId}`, actorEmployeeId, now, targetEntityId, requestId, requestId, transitionToken),
    ];
    const requestDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return [
      db.prepare(`INSERT OR IGNORE INTO finance_expense_requests
        (id, request_kind, title, vendor, amount, requested_date, due_date, account_code, account_name,
          payment_method, memo, source_type, source_id, status, requester_employee_id, approved_by, approved_at,
          paid_by, paid_at, journal_status, evidence_required, created_at, updated_at)
        SELECT 'sales-service-refund:' || service.id, 'PAYMENT', service.case_number || ' 고객 환불', account.name,
          service.refund_amount, ?, date(service.resolution_due_at / 1000, 'unixepoch'), '', '', 'BANK_TRANSFER',
          service.resolution_note, 'SALES_SERVICE_REFUND', service.id, 'DRAFT', service.owner_employee_id, '', NULL,
          '', NULL, 'UNPOSTED', 1, ?, ? FROM sales_service_cases service JOIN sales_accounts account ON account.id = service.account_id
        WHERE service.id = ? AND service.status = 'RESOLUTION_SUBMITTED' AND service.approval_request_id = ? AND service.refund_amount > 0
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(requestDate, now, now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`INSERT OR IGNORE INTO erp_tasks
        (id, module, category, title, description, owner_employee_id, due_date, status, priority,
          destination, source_type, source_id, created_at, updated_at)
        SELECT 'sales-service-exchange:' || id, 'sales', '교환 납품', case_number || ' 대체 납품', resolution_note,
          owner_employee_id, date(resolution_due_at / 1000, 'unixepoch'), 'OPEN', priority, 'sales:document',
          'SALES_SERVICE_EXCHANGE', id, ?, ? FROM sales_service_cases WHERE id = ? AND status = 'RESOLUTION_SUBMITTED'
          AND approval_request_id = ? AND resolution_type = 'EXCHANGE'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`INSERT OR IGNORE INTO erp_tasks
        (id, module, category, title, description, owner_employee_id, due_date, status, priority,
          destination, source_type, source_id, created_at, updated_at)
        SELECT 'sales-service-disposition:' || line.id, 'sales', '반품 후속처리', service.case_number || ' ' || line.disposition,
          service.resolution_note, service.owner_employee_id, date(service.resolution_due_at / 1000, 'unixepoch'),
          'OPEN', service.priority, 'sales:service', 'SALES_SERVICE_DISPOSITION', line.id, ?, ?
        FROM sales_service_return_lines line JOIN sales_service_cases service ON service.id = line.case_id
        WHERE service.id = ? AND service.status = 'RESOLUTION_SUBMITTED' AND service.approval_request_id = ?
          AND line.disposition <> 'RESTOCK' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`UPDATE sales_service_cases SET
        status = CASE WHEN refund_amount > 0 OR resolution_type = 'EXCHANGE'
          OR EXISTS (SELECT 1 FROM sales_service_return_lines line WHERE line.case_id = sales_service_cases.id)
          THEN 'RESOLUTION_APPROVED' ELSE 'RESOLVED' END,
        finance_request_id = CASE WHEN refund_amount > 0 THEN 'sales-service-refund:' || id ELSE finance_request_id END,
        resolved_by = CASE WHEN refund_amount = 0 AND resolution_type <> 'EXCHANGE'
          AND NOT EXISTS (SELECT 1 FROM sales_service_return_lines line WHERE line.case_id = sales_service_cases.id)
          THEN ? ELSE resolved_by END,
        resolved_at = CASE WHEN refund_amount = 0 AND resolution_type <> 'EXCHANGE'
          AND NOT EXISTS (SELECT 1 FROM sales_service_return_lines line WHERE line.case_id = sales_service_cases.id)
          THEN ? ELSE resolved_at END, updated_at = ?
        WHERE id = ? AND status = 'RESOLUTION_SUBMITTED' AND approval_request_id = ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, requestId, transitionToken),
      db.prepare(`INSERT INTO sales_service_case_events (id, case_id, event_type, note, actor_employee_id, created_at)
        SELECT ?, id, 'RESOLUTION_APPROVED', resolution_note, ?, ? FROM sales_service_cases WHERE id = ?
          AND status IN ('RESOLUTION_APPROVED','RESOLVED') AND approval_request_id = ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(`service-resolution-approved:${requestId}`, actorEmployeeId, now, targetEntityId, requestId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "SALES_TARGET_PLAN") {
    if (!approved) return [db.prepare(`UPDATE sales_target_plans SET status = 'DRAFT', approved_by = '', approved_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE sales_target_plans SET status = 'SUPERSEDED', updated_at = ?
        WHERE year = (SELECT year FROM sales_target_plans WHERE id = ?) AND status = 'APPROVED' AND id <> ?
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE sales_target_plans SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "INCENTIVE_RULE") {
    if (!approved) return [db.prepare(`UPDATE sales_incentive_rules SET status = 'DRAFT', approved_by = '', approved_at = NULL,
      updated_at = ? WHERE id = ? AND status = 'SUBMITTED'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(now, targetEntityId, requestId, transitionToken)];
    return [
      db.prepare(`UPDATE sales_incentive_rules SET status = 'RETIRED', updated_at = ? WHERE status = 'ACTIVE' AND id <> ?
        AND EXISTS (SELECT 1 FROM sales_incentive_rules WHERE id = ? AND status = 'SUBMITTED')
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(now, targetEntityId, targetEntityId, requestId, transitionToken),
      db.prepare(`UPDATE sales_incentive_rules SET status = 'ACTIVE', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'SUBMITTED'
          AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
        .bind(actorEmployeeId, now, now, targetEntityId, requestId, transitionToken),
    ];
  } else if (targetEntityType === "INCENTIVE_RESULT") {
    return [db.prepare(`UPDATE sales_incentive_results SET status = ?, representative_approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'SUBMITTED'
        AND EXISTS (SELECT 1 FROM erp_approval_requests WHERE id = ? AND transition_token = ?)`)
      .bind(approved ? "APPROVED" : "FINANCE_REVIEWED", approved ? now : null, now, targetEntityId, requestId, transitionToken)];
  }
  return [];
}
