import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import writeXlsxFile from "write-excel-file/node";
import { strFromU8, unzipSync } from "fflate";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("payroll Excel export accepts the styled title and header rows", async () => {
  const calculator = await read("app/compensation-calculator.tsx");
  assert.match(calculator, /\[\{ value: targetKey, fontWeight: "bold" \}\]/);
  assert.match(calculator, /backgroundColor: "#F4F4F5"/);
  const workbook = await writeXlsxFile([
    [{ value: "2026-08", fontWeight: "bold" }],
    ["성명", "지급총액"].map((value) => ({ value, fontWeight: "bold", backgroundColor: "#F4F4F5" })),
    [{ value: "김권찬" }, { value: 3_465_751, format: "₩#,##0" }],
  ], { sheet: "2026-08", freezeRows: 2, showGridLines: true }).toBuffer();
  assert.equal(workbook[0], 0x50);
  assert.equal(workbook[1], 0x4b);
});

test("sensitive ERP APIs enforce role-based authorization and audit writes", async () => {
  const files = await Promise.all([
    read("app/api/finance/operations/route.ts"),
    read("app/api/hr/employee-records/route.ts"),
    read("app/api/hr/recruitment/route.ts"),
    read("app/api/sales/route.ts"),
    read("app/api/sales/sheet-sync/route.ts"),
    read("app/api/sales/sheet-sync/insights/route.ts"),
  ]);
  for (const source of files) assert.match(source, /authorizeErpRequest/);
  for (const source of files) assert.match(source, /writeErpAudit/);
});

test("every mutating finance API route enforces authorization and writes an audit trail", async () => {
  // general-ledger is intentionally excluded: it is GET-only (a read-only verification view over
  // the imported ledger) and has no mutation to audit.
  const routes = [
    "alert-actions", "assistant", "budget", "close", "daily-treasury", "debt", "expense-control",
    "fixed-assets", "forecast", "import-mappings", "inventory", "management-report", "master-data",
    "opening-balance", "operations", "posting-control", "project-costing", "purchasing",
    "receivables", "reconciliation", "risk-policy", "tax", "tie-out",
  ];
  const files = await Promise.all(routes.map((route) => read(`app/api/finance/${route}/route.ts`)));
  files.forEach((source, index) => {
    assert.match(source, /authorizeErpRequest/, `${routes[index]}: missing authorizeErpRequest`);
    assert.match(source, /writeErpAudit/, `${routes[index]}: missing writeErpAudit`);
  });
});

test("retirement effectiveness and compensation confirmation are server-controlled", async () => {
  const [retirement, operations, employees, compensation, calculator, calculatorCss, workspace, wonInput, migration, settingsMigration, defaultsMigration] = await Promise.all([
    read("app/hr-retirements.ts"), read("app/api/hr/operations/route.ts"), read("app/api/hr/employee-records/route.ts"),
    read("app/api/hr/compensation/route.ts"), read("app/compensation-calculator.tsx"), read("app/compensation-calculator.css"), read("app/hr-workspace.tsx"),
    read("app/won-input.tsx"), read("drizzle/0065_hr_retirement_compensation.sql"), read("drizzle/0068_compensation_draft_settings.sql"),
    read("drizzle/0069_hr_employee_compensation_defaults.sql"),
  ]);
  assert.match(retirement, /status IN \('IN_PROGRESS', 'READY'\) OR \(status = 'EFFECTIVE'/);
  assert.match(retirement, /const nextStatus = completion\?\.ready \? "COMPLETED" : "EFFECTIVE"/);
  assert.match(operations, /due \? "퇴직" : "퇴직 예정"/);
  for (const field of ["base_pay", "meal_allowance", "childcare_allowance", "vehicle_allowance"]) {
    assert.match(employees, new RegExp(field)); assert.match(migration, new RegExp(field));
  }
  for (const table of ["hr_compensation_runs", "hr_compensation_lines"]) assert.match(compensation, new RegExp(table));
  assert.match(compensation, /DELETE FROM hr_payroll_records WHERE year_month = \?/);
  assert.match(compensation, /hr_payroll_runs\.status='DRAFT'/);
  assert.match(compensation, /검토·승인·마감이 진행된 급여월은 임금안으로 덮어쓸 수 없습니다/);
  assert.match(calculator, /임금안을 확정해 HR 급여관리에 덮어썼습니다/);
  assert.match(calculator, /"급여 확정"/);
  assert.match(calculator, /수정하기/);
  assert.match(calculator, /action: "SAVE", period: key/);
  assert.match(calculator, /변경된 임금안이 서버에 자동 저장되었습니다/);
  assert.match(calculator, /서버 저장 완료 · 새로고침하거나 다시 접속해도 이 초안이 유지됩니다/);
  assert.match(calculator, /className="payroll-footer-action confirm"/);
  assert.match(calculator, /\.toFile\(`XD_NODE_급여_/);
  assert.match(calculator, /writeXlsxFile\(sheets\)\.toFile/);
  assert.doesNotMatch(calculator, /<fieldset className="compensation-editable" disabled=/);
  assert.match(calculator, /<fieldset className="compensation-editing-fields" disabled=\{locked \|\| saving\}>/);
  assert.match(calculator, /<fieldset className="wage-table-editable" disabled=\{locked \|\| saving\}>/);
  assert.match(calculator, /<\/fieldset><footer><button disabled=\{Boolean\(exporting\)\}/);
  assert.match(calculator, /beginColumnResize/);
  assert.match(calculator, /column-resizer/);
  assert.match(calculator, /COLUMN_VISIBILITY_OPTIONS/);
  assert.match(calculator, /hiddenColumns/);
  assert.match(calculator, /label: "부서"/);
  assert.match(calculator, /label: "직책"/);
  assert.match(calculator, /action === "CONFIRM" && !run/);
  assert.match(compensation, /hasClientDraft/);
  assert.match(compensation, /grossPayByEmployee/);
  assert.match(calculatorCss, /tbody tr:nth-child\(even\) td/);
  assert.match(calculatorCss, /border-right:1px solid/);
  assert.match(calculatorCss, /font-size:12px;font-weight:800;text-align:center/);
  assert.match(calculatorCss, /column-visibility/);
  assert.match(calculator, /type WageSortKey/);
  assert.match(calculator, /toggleSort/);
  assert.match(calculator, /sortedRows\.map/);
  assert.match(calculator, /aria-sort/);
  assert.match(calculatorCss, /column-sort/);
  assert.match(calculatorCss, /footer button\{font-size:11px\}/);
  for (const label of ["연봉", "기본급 직접 입력", "추가수당", "연구수당", "퇴직금", "복지기금"]) {
    assert.match(calculator, new RegExp(`WonInput className="money-input" ariaLabel="${label}"`));
  }
  assert.match(calculator, /field === "incentive" \? "인센티브" : "상여금"/);
  assert.doesNotMatch(calculator, /className="money-input" type="number"/);
  assert.match(compensation, /settings_json/);
  assert.match(settingsMigration, /settings_json TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(defaultsMigration, /annual_salary INTEGER NOT NULL DEFAULT 0/);
  assert.equal((defaultsMigration.match(/UPDATE hr_employee_records SET/g) ?? []).length, 27);
  assert.match(compensation, /annualSalary: employee\.annual_salary/);
  assert.match(compensation, /\["CREATE", "LOAD_HR"\]\.includes\(action\)/);
  assert.match(compensation, /NULLIF\(replace\(join_date, '\.', '-'\), ''\) IS NOT NULL/);
  // 퇴직일은 인사기록 JSON 과 퇴직 요청 표 두 곳을 합쳐 판단한다(예전에는 JSON 만 봐서 퇴직자가 퇴사월 임금안에서 빠졌다).
  assert.ok(compensation.includes('exitByEmployee.get(employee.employee_id) || ""'));
  assert.ok(compensation.includes("if (exit) return exit >= start;"));
  assert.match(compensation, /COMPENSATION_HR_DRAFT_LOADED/);
  assert.match(calculator, /: "급여 작성"\}<\/button>/);
  assert.match(calculator, /compensationAction\("LOAD_HR"\)/);
  assert.match(calculator, /현재 입력한 월별 수당과 메모는 초기화됩니다/);
  assert.match(workspace, /연봉 · 1원 단위/);
  assert.match(workspace, /기본급 · 1원 단위/);
  assert.doesNotMatch(workspace, /step="10000"/);
  assert.match(wonInput, /toLocaleString\("ko-KR"\)/);
  assert.match(wonInput, /inputMode="numeric"/);
});

test("retired employees are excluded from directory and organization membership", async () => {
  const [workspace, retirement, leaders, migration] = await Promise.all([
    read("app/hr-workspace.tsx"), read("app/hr-retirements.ts"),
    read("app/api/hr/organization-leaders/route.ts"), read("drizzle/0066_retired_employee_visibility.sql"),
  ]);
  assert.match(workspace, /function isCurrentEmployee/);
  assert.match(workspace, /const visibleEmployees = query \? currentEmployees\.filter/);
  assert.match(workspace, /isCurrentEmployee\(employee\) && employee\.department === organization\.name/);
  assert.match(retirement, /UPDATE hr_organization_leaders SET leader_employee_id = NULL/);
  assert.match(leaders, /퇴직자는 조직장으로 지정할 수 없습니다/);
  assert.match(leaders, /THEN NULL ELSE leader\.leader_employee_id END/);
  assert.match(migration, /WHERE status = '퇴직'/);
});

test("master data changes freeze, validate and consume a server-side impact assessment", async () => {
  const [server, api, dialog, finance, sales, hr, approvals, schema, migration, plan] = await Promise.all([
    read("app/master-impact.ts"), read("app/api/master-impact/route.ts"), read("app/master-impact-dialog.tsx"),
    read("app/api/finance/master-data/route.ts"), read("app/api/sales/accounts/route.ts"), read("app/api/hr/organizations/route.ts"),
    read("app/api/approvals/route.ts"), read("db/schema.ts"), read("drizzle/0061_master_data_impact.sql"), read("docs/master-data-impact-plan.md"),
  ]);
  for (const source of [server, schema, migration]) assert.match(source, /erp_master_impact_assessments/);
  assert.match(api, /authorizeErpRequest/); assert.match(server, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(server, /expiresAt = createdAt \+ 15 \* 60_000/); assert.match(server, /row\.used_at/);
  assert.match(server, /current\.checksum !== row\.checksum/); assert.match(server, /current\.blockingCount > 0/);
  for (const source of [finance, sales]) assert.match(source, /validateMasterImpactAssessment/);
  for (const source of [finance, sales]) assert.match(source, /impactAssessmentId/);
  // R1(r1-decouple, Design §12.3): HR 조직 수정은 마스터 영향 평가 없이 저장한다.
  assert.doesNotMatch(hr, /master-impact|impactAssessmentId|MasterImpact/);
  assert.match(approvals, /reassessMasterImpact/); assert.match(approvals, /최종 승인 직전 재검증/);
  assert.match(dialog, /차단 항목 해결 필요/); assert.match(dialog, /변경 직전 서버에서 다시 검증/);
  assert.match(plan, /자동 병합·자동 계정 치환하지 않는다/); assert.match(plan, /localStorage.*사용하지 않는다/);
});

test("master impact blockers become controlled resolution cases with recheck and evidence gates", async () => {
  const [server, api, operations, workbench, workspace, center, page, schema, migration, plan] = await Promise.all([
    read("app/master-impact.ts"), read("app/api/master-impact-cases/route.ts"), read("app/api/operations/route.ts"),
    read("app/api/workbench/route.ts"), read("app/master-impact-case-workspace.tsx"), read("app/data-governance-center.tsx"), read("app/page.tsx"), read("db/schema.ts"),
    read("drizzle/0062_master_impact_resolution_queue.sql"), read("docs/master-impact-resolution-queue-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const source of [server, api, schema, migration]) for (const table of ["erp_master_impact_cases", "erp_master_impact_case_events"]) assert.match(source, new RegExp(table));
  assert.match(server, /entry\.severity === "BLOCKER" && entry\.count > 0/);
  assert.match(server, /MASTER_IMPACT_CASE/); assert.match(server, /source_type, source_id/);
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /reassessMasterImpact/); assert.match(api, /currentCount === 0 \? "VERIFIED"/);
  assert.match(api, /resolutionNote\.length < 10 \|\| evidenceRef\.length < 3/);
  assert.match(api, /expectedVersion !== before\.version/); assert.match(api, /status = 'CLOSED'/);
  assert.match(workspace, /자동 해결 없음/); assert.match(workspace, /회사 직원만 배정/); assert.match(workspace, /원장 재검증/); assert.match(workspace, /증빙 남기고 종결/);
  assert.match(operations, /before\.source_type === "MASTER_IMPACT_CASE" && status !== before\.status/);
  assert.match(workbench, /row\.source_type !== "MASTER_IMPACT_CASE"/);
  assert.match(center, /기준정보 영향/);
  assert.match(plan, /`BLOCKER`이면서 연결 건수가 1건 이상/); assert.match(plan, /OPEN → IN_PROGRESS → VERIFIED → CLOSED/);
  assert.match(plan, /자동 해결, 자동 계정 치환, 자동 병합, 자동 종결은 하지 않는다/);
});

test("master impact SLA escalations preserve ownership and freeze versioned weekly risk reports", async () => {
  const [server, api, workspace, schema, migration, plan] = await Promise.all([
    read("app/master-impact.ts"), read("app/api/master-impact-cases/route.ts"), read("app/master-impact-case-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0063_master_impact_sla_reporting.sql"), read("docs/master-impact-sla-reporting-plan.md"),
  ]);
  for (const source of [server, api, schema, migration]) for (const table of ["erp_master_impact_sla_policies", "erp_master_impact_weekly_reports"]) assert.match(source, new RegExp(table));
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /target <= row\.escalation_level/); assert.match(api, /WHERE id = \? AND escalation_level < \?/);
  assert.match(api, /SLA_ESCALATED/); assert.match(api, /SYSTEM:SLA/); assert.match(api, /MASTER_IMPACT_SLA_ESCALATION/);
  assert.match(api, /expectedVersion !== before\.version/); assert.match(api, /expectedPolicyVersion/);
  assert.match(api, /executiveEscalationDays <= managerEscalationDays/); assert.match(api, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(api, /SELECT COALESCE\(MAX\(version\), 0\) \+ 1 FROM erp_master_impact_weekly_reports/);
  assert.doesNotMatch(api, /UPDATE erp_master_impact_weekly_reports SET (?:snapshot_json|checksum)/);
  assert.match(workspace, /자동 재배정 없음/); assert.match(workspace, /기존 기한은 변경하지 않았습니다/); assert.match(workspace, /관리자별 현재 위험/); assert.match(workspace, /현재 상태 주간 보고 저장/);
  assert.match(server, /policy\.defaultDueDays/); assert.match(plan, /기존 업무의 담당자·기한을 소급 변경하지 않는다/); assert.match(plan, /새 버전을 추가한다/);
});

test("master impact weekly reports require recorded manager responses before executive approval", async () => {
  const [api, workspace, approval, approvalApi, schema, migration, plan] = await Promise.all([
    read("app/api/master-impact-cases/route.ts"), read("app/master-impact-case-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/api/approvals/route.ts"), read("db/schema.ts"),
    read("drizzle/0064_master_impact_report_approval.sql"), read("docs/master-impact-report-approval-plan.md"),
  ]);
  for (const source of [api, schema, migration]) for (const table of ["erp_master_impact_weekly_report_reviews", "erp_master_impact_weekly_report_events"]) assert.match(source, new RegExp(table));
  assert.match(api, /ACK_MANAGER_REVIEW/); assert.match(api, /REQUEST_MANAGER_ACTION/); assert.match(api, /VERIFY_MANAGER_ACTION/);
  assert.match(api, /follow_up_task_status !== "DONE"/); assert.match(api, /outcome <> 'ACKNOWLEDGED'/);
  assert.match(api, /SUBMIT_WEEKLY_REPORT/); assert.match(api, /MASTER_IMPACT_WEEKLY_REPORT/); assert.match(api, /createApprovalRequest/);
  assert.match(api, /expectedReviewVersion/); assert.match(api, /expectedWorkflowVersion/); assert.match(api, /status = 'DRAFT'/);
  assert.match(api, /MASTER_IMPACT_REPORT_REVIEW/); assert.match(api, /data-control:master-impact/);
  assert.match(approval, /settings: \{ MASTER_IMPACT_REPORT/); assert.match(approval, /targetEntityType === "MASTER_IMPACT_WEEKLY_REPORT"/);
  assert.match(approvalApi, /moduleName === "settings"/); assert.match(migration, /idx_erp_approval_master_impact_report/);
  assert.match(approvalApi, /MASTER_IMPACT_WEEKLY_REPORT/); assert.match(approvalApi, /\["REQUEST_CHANGES", "RESUBMIT", "CANCEL"\]/);
  assert.match(migration, /trg_erp_master_impact_weekly_report_immutable/); assert.match(migration, /BEFORE UPDATE OF `snapshot_json`, `checksum`/);
  assert.match(workspace, /실제 기록자 표시/); assert.match(workspace, /자동 승인 없음/); assert.match(workspace, /경영 책임자 전자결재 제출/);
  assert.match(plan, /조직장과 실제 기록자를 구분/); assert.match(plan, /자동 승인·자동 종결은 하지 않는다/);
  assert.match(plan, /snapshot_json.*checksum.*수정하지 않는다/);
});

test("finance assistant answers become traceable decision drafts without bypassing review and approval", async () => {
  const [api, page, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/finance/management-report/route.ts"), read("app/page.tsx"),
    read("app/management-report-workspace.tsx"), read("db/schema.ts"),
    read("drizzle/0059_finance_assistant_decision_lineage.sql"), read("docs/finance-assistant-to-decision-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const source of [api, schema, migration]) {
    assert.match(source, /source_assistant_answer_id/);
    assert.match(source, /source_answer_hash/);
    assert.match(source, /source_evidence_hash/);
  }
  assert.match(api, /PROMOTE_ASSISTANT_ANSWER/);
  assert.match(api, /report\.status !== "DRAFT"/);
  assert.match(api, /assistant\.evidence_status !== "VERIFIED" && body\.reviewAcknowledged !== true/);
  assert.match(api, /ASSISTANT_ANSWER_PROMOTED/);
  assert.match(migration, /UNIQUE INDEX `idx_finance_management_decision_assistant_source`/);
  assert.match(workspace, /AI 근거 안건 제안/);
  assert.match(workspace, /원문 근거/);
  assert.match(workspace, /근거 제한을 확인했습니다/);
  assert.match(plan, /답변 → 안건 초안 → 보고서 제출 → 전자결재 → 안건 확정 → 후속조치/);
});

test("daily treasury reports freeze source data, survive AI outages and require human review before finalization", async () => {
  const [api, view, schema, migration, page, operations, close, plan] = await Promise.all([
    read("app/api/finance/daily-treasury/route.ts"), read("app/daily-treasury-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0034_daily_treasury_reporting.sql"), read("app/page.tsx"),
    read("app/api/operations/route.ts"), read("app/api/finance/close/route.ts"),
    read("docs/finance-daily-treasury-report-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(schema, /financeDailyTreasuryReports/);
  assert.match(migration, /idx_finance_daily_treasury_report_date_version/);
  assert.match(api, /finance_bank_transactions/);
  assert.match(api, /finance_cash_forecast_items/);
  assert.match(api, /sales_payment_allocations/);
  assert.match(api, /finance_purchase_invoices/);
  assert.match(api, /finance_debt_schedule_items/);
  assert.match(api, /action === "FINALIZE" \? "approve" : "write"/);
  assert.match(api, /analysis_source = \?/);
  assert.match(api, /RULE_BASED_FALLBACK/);
  assert.match(api, /status: "QUOTA"/);
  assert.match(api, /managementNote\.length < 10 \|\| actionItems\.length < 1/);
  assert.match(api, /WHERE id = \? AND status = 'REVIEWED'/);
  assert.match(view, /동결 스냅샷 분석/);
  assert.match(view, /AI 결과는 참고자료/);
  assert.doesNotMatch(page, /임시 저장/);
  assert.match(operations, /daily-treasury-report-due/);
  assert.match(operations, /destination: "finance:daily-report"/);
  assert.match(close, /DAILY_TREASURY_REPORT/);
  assert.match(close, /category: "TREASURY"/);
  assert.match(plan, /`FINAL` 보고서는 수정하지 않고 다음 버전으로만 개정/);
  assert.match(plan, /AI 설정 누락·무료한도 초과·통신 실패/);
});

test("finance overview uses live operation tasks and saved treasury reports instead of frozen UI copy", async () => {
  const [page, assistant, insights, plan] = await Promise.all([
    read("app/page.tsx"), read("app/api/finance/assistant/route.ts"),
    read("app/finance-current-insights.ts"), read("docs/finance-live-overview-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.doesNotMatch(page, /const financeAlerts\s*=/);
  assert.doesNotMatch(page, /const financeDailyBrief\s*=/);
  assert.match(assistant, /financeCurrentInsights\.bankActivity31Days/);
  assert.match(insights, /계좌간 대체 포함 가능/);
  assert.match(plan, /완료 업무는 카드에서 제거/);
  assert.match(plan, /API가 실패한 경우 이를 명시/);
});

test("finance charts derive balance endpoints and invoice flows from shared source data", async () => {
  const [page, series, plan] = await Promise.all([
    read("app/page.tsx"), read("app/finance-time-series.ts"), read("docs/finance-time-series-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.doesNotMatch(page, /const cashTrend\s*=/);
  assert.doesNotMatch(page, /const financeChartSeries\s*=/);
  assert.match(series, /주간 마지막 관측값/);
  assert.match(series, /무발행 구간은 0원/);
  assert.match(plan, /잔액은 특정 시점 값이고 매출은 기간 합계/);
  assert.match(plan, /은행의 매출성 입금이나 판매채널 정산액과 합치지 않는다/);
});

test("finance forecast and account risk share explainable decision models with the AI assistant", async () => {
  const [page, assistant, model, plan] = await Promise.all([
    read("app/page.tsx"), read("app/api/finance/assistant/route.ts"),
    read("app/finance-decision-model.ts"), read("docs/finance-forecast-risk-model-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.doesNotMatch(page, /const elapsedDays2026/);
  assert.doesNotMatch(page, /const accountRiskScore/);
  assert.match(assistant, /buildSalesForecast/);
  assert.match(assistant, /buildAccountRiskModel/);
  assert.match(model, /2026\.08-v2/);
  assert.match(model, /회사 최소 운영자금·외화 한도 정책 미등록/);
  assert.match(plan, /보수 ≤ 기준 ≤ 낙관/);
});

test("company finance policy is durable, admin-controlled, audited and connected to risk tasks", async () => {
  const [api, server, view, page, schema, migration, operations, assistant, forecast, plan] = await Promise.all([
    read("app/api/finance/risk-policy/route.ts"), read("app/finance-risk-policy-server.ts"),
    read("app/finance-risk-policy-workspace.tsx"), read("app/page.tsx"), read("db/schema.ts"),
    read("drizzle/0035_finance_risk_policy.sql"), read("app/api/operations/route.ts"),
    read("app/api/finance/assistant/route.ts"), read("app/api/finance/forecast/route.ts"),
    read("docs/finance-risk-policy-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /authorizeErpRequest\(db, "finance", "read"\)/);
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /FINANCE_RISK_POLICY_UPDATED/);
  assert.match(api, /changeReason\.length < 2/);
  assert.match(server, /finance_cash_forecast_settings/);
  assert.match(schema, /riskPolicyConfigured/);
  assert.match(migration, /minimum_debt_coverage_bps/);
  assert.match(view, /정책 저장·재평가/);
  assert.match(view, /감사기록에 남습니다/);
  assert.match(operations, /finance-risk-policy-missing/);
  assert.match(operations, /account-liquidity-policy-risk/);
  assert.match(operations, /destination: "finance:policy"/);
  assert.match(assistant, /loadFinanceRiskPolicy/);
  assert.doesNotMatch(forecast, /Number\(body\.minimumCashBalance/);
  assert.match(plan, /일반 재무 쓰기 권한으로 정책을 변경할 수 없어야 한다/);
});

test("finance master changes are approval-gated and new finance inputs validate active master records", async () => {
  const [api, workspace, engine, operations, budget, sales, purchasing, page, plan, taskRoute] = await Promise.all([
    read("app/api/finance/master-data/route.ts"), read("app/finance-master-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/api/finance/operations/route.ts"),
    read("app/api/finance/budget/route.ts"), read("app/api/sales/route.ts"),
    read("app/api/finance/purchasing/route.ts"), read("app/page.tsx"), read("docs/finance-master-data-plan.md"), read("app/api/operations/route.ts"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /requestType: "MASTER_DATA"/);
  assert.match(api, /targetEntityType: "FINANCE_MASTER_CHANGE"/);
  assert.match(api, /INSERT OR IGNORE INTO finance_master_accounts/);
  assert.match(workspace, /계좌번호 전체값은 저장하지 않으며/);
  assert.match(engine, /targetEntityType === "FINANCE_MASTER_CHANGE"/);
  assert.match(engine, /transition_token/);
  assert.match(workspace, /통합 재무 마스터/);
  assert.match(workspace, /실제 이카운트 세금코드 목록/);
  assert.match(operations, /finance_master_partners WHERE canonical_name/);
  assert.match(operations, /finance_master_accounts WHERE code/);
  assert.match(budget, /전기 분개를 연결하려면 활성 계정과목/);
  assert.match(sales, /finance_master_partner_aliases/);
  assert.match(purchasing, /finance_master_partner_aliases/);
  assert.match(taskRoute, /finance-master-quality/);
  assert.match(taskRoute, /destination: "finance:master"/);
  assert.match(plan, /과거 문자열 스냅샷은 보존/);
  assert.match(plan, /임의 코드를 생성하지 않는다/);
});

test("invoice receivables derive balances from accepted payments and preserve operational collection history", async () => {
  const [api, workspace, schema, migration, page, operations, plan] = await Promise.all([
    read("app/api/finance/receivables/route.ts"), read("app/receivables-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0025_receivable_collections.sql"), read("app/page.tsx"),
    read("app/api/operations/route.ts"), read("docs/finance-receivables-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_receivable_cases", "finance_receivable_notes"]) {
    assert.match(api, new RegExp(table));
    assert.match(migration, new RegExp(table));
  }
  assert.match(schema, /financeReceivableCases/);
  assert.match(schema, /financeReceivableNotes/);
  assert.match(api, /payment\.status IN \('ACCEPTED','COMPLETED'\)/);
  assert.match(api, /source\.outstandingAmount <= 0/);
  assert.match(api, /입금 약속 상태에는 약속일과 약속금액/);
  assert.match(api, /분쟁·보류 상태에는 사유/);
  assert.match(workspace, /회계·영업 원천값 · 읽기 전용/);
  assert.match(workspace, /연체 구간별 미수잔액/);
  assert.match(workspace, /접촉·특이사항 기록/);
  assert.match(operations, /receivable-collections-risk/);
  assert.match(plan, /사용자가 임의 종결하지 못한다/);
  assert.match(plan, /공식 신용등급/);
});

test("payables use vendor-scoped invoice uniqueness, accountable schedules and forecast dates", async () => {
  const [api, workspace, forecast, forecastView, schema, migration, operations, plan] = await Promise.all([
    read("app/api/finance/purchasing/route.ts"), read("app/purchasing-workspace.tsx"),
    read("app/api/finance/forecast/route.ts"), read("app/cash-forecast-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0026_payable_scheduling.sql"),
    read("app/api/operations/route.ts"), read("docs/finance-payables-plan.md"),
  ]);
  assert.match(schema, /financePayablePlans/);
  assert.match(schema, /idx_finance_purchase_invoice_vendor_number/);
  assert.match(migration, /finance_payable_plans/);
  assert.match(migration, /DROP INDEX IF EXISTS `idx_finance_purchase_invoice_number`/);
  assert.match(api, /vendor_id = \? AND invoice_number = \?/);
  assert.match(api, /planStatus === "SCHEDULED" && !plannedPaymentDate/);
  assert.match(api, /planStatus === "HOLD" && !holdReason/);
  assert.match(workspace, /매입채무 에이징·지급 일정/);
  assert.match(workspace, /원천 지급기한과 내부 지급일을 분리/);
  assert.match(forecast, /dateQuality: planned \? "PAYMENT_PLAN"/);
  assert.match(forecastView, /내부 지급계획/);
  assert.match(operations, /payable-schedule-risk/);
  assert.match(plan, /부분지급·분할지급/);
});

test("inventory control connects accepted receipts and deliveries without inventing SKU mappings", async () => {
  const [api, view, page, schema, migration, close, operations, plan] = await Promise.all([
    read("app/api/finance/inventory/route.ts"), read("app/inventory-workspace.tsx"), read("app/page.tsx"),
    read("db/schema.ts"), read("drizzle/0027_inventory_control.sql"), read("app/api/finance/close/route.ts"),
    read("app/api/operations/route.ts"), read("docs/finance-inventory-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(schema, /inventoryProducts/);
  assert.match(schema, /idx_inventory_movement_source_line/);
  assert.match(migration, /CREATE TABLE `inventory_movements`/);
  assert.match(api, /receipt_line\.accepted_quantity_milli > 0/);
  assert.match(api, /가용재고 .*초과해 출고할 수 없습니다/);
  assert.match(api, /INVENTORY_MOVEMENT_POSTED/);
  assert.match(api, /INVENTORY_PRODUCT_UPDATED/);
  assert.match(api, /잠긴 마감월에는 재고 이동을 추가할 수 없습니다/);
  assert.match(api, /source\.receipt_date, productId, warehouseId/);
  assert.match(view, /자유입력 품목명.*자동 SKU로 간주하지 않습니다/);
  assert.match(view, /이동평균 원가 · 음수재고 차단/);
  assert.match(view, /변경 저장/);
  assert.match(close, /INVENTORY_LEDGER/);
  assert.match(operations, /inventory-control-risk/);
  assert.match(plan, /과거 Clobe·이카운트 자료를 임의로 재고수량으로 환산하지 않는다/);
});

test("VAT review reconciles explicit source and reported figures without inferring tax rates", async () => {
  const [api, view, page, schema, migration, close, operations, plan] = await Promise.all([
    read("app/api/finance/tax/route.ts"), read("app/tax-reconciliation-workspace.tsx"), read("app/page.tsx"),
    read("db/schema.ts"), read("drizzle/0028_tax_reconciliation.sql"), read("app/api/finance/close/route.ts"),
    read("app/api/operations/route.ts"), read("docs/finance-tax-reconciliation-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(schema, /financeTaxPeriods/);
  assert.match(migration, /CREATE TABLE `finance_tax_periods`/);
  assert.match(api, /financeCurrentData\.salesDaily2026\.filter/);
  assert.match(api, /TAX_RECONCILIATION_SAVED/);
  assert.match(api, /잠긴 마감월은 부가세 검토값을 변경할 수 없습니다/);
  assert.match(api, /finance_master_tax_codes WHERE status = 'ACTIVE'/);
  assert.doesNotMatch(api, /\*\s*0\.1|\/\s*10/);
  assert.match(view, /공식 신고서가 아니며 과세유형·세율·공제 여부를 자동 추정하지 않습니다/);
  assert.match(view, /홈택스 또는 이카운트 원본에서 확인했습니다/);
  assert.match(close, /TAX_RECONCILIATION/);
  assert.match(operations, /tax-reconciliation-due/);
  assert.match(plan, /공식 세무신고를 대신하지 않는 내부 검토 원장/);
});

test("fixed assets require explicit classification, evidence and posted straight-line depreciation", async () => {
  const [api, view, page, schema, migration, close, operations, plan] = await Promise.all([
    read("app/api/finance/fixed-assets/route.ts"), read("app/fixed-assets-workspace.tsx"), read("app/page.tsx"),
    read("db/schema.ts"), read("drizzle/0029_fixed_asset_control.sql"), read("app/api/finance/close/route.ts"),
    read("app/api/operations/route.ts"), read("docs/finance-fixed-assets-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(schema, /financeFixedAssets/);
  assert.match(schema, /financeAssetDepreciationSchedules/);
  assert.match(migration, /CREATE TABLE `finance_fixed_assets`/);
  assert.match(migration, /idx_finance_asset_depreciation_period/);
  assert.match(migration, /opening_accumulated/);
  assert.match(api, /PURCHASE_ORDER_LINE/);
  assert.match(api, /취득 증빙을 1건 이상 첨부한 후 활성화해 주세요/);
  assert.match(api, /depreciation_method.*STRAIGHT_LINE|STRAIGHT_LINE.*depreciation_method/s);
  assert.match(api, /잠긴 마감월에는 감가상각 계획을 생성할 수 없습니다/);
  assert.match(api, /ASSET_DEPRECIATION_JOURNAL_CREATED/);
  assert.match(api, /ASSET_DEPRECIATION_POSTED/);
  assert.match(api, /기초 누계상각/);
  assert.match(api, /priorPosted/);
  assert.match(api, /처분일까지의 미전기 감가상각을 먼저 처리해 주세요/);
  assert.match(view, /구매 품목은 후보일 뿐이며 담당자가 직접 자산 여부와 내용연수·계정과목을 확정합니다/);
  assert.match(view, /정액법 · 원 단위 균등배분 · 사용개시월부터 월할/);
  assert.match(close, /FIXED_ASSET_DEPRECIATION/);
  assert.match(operations, /fixed-asset-control-risk/);
  assert.match(plan, /과거 자료와 자유입력 품목을 자동으로 자산화하지 않는다/);
});

test("project profitability uses exact sales links, bounded manual allocations and close controls", async () => {
  const [api, view, page, schema, migration, close, operations, plan, purchasing, payroll, sales] = await Promise.all([
    read("app/api/finance/project-costing/route.ts"), read("app/project-costing-workspace.tsx"), read("app/page.tsx"),
    read("db/schema.ts"), read("drizzle/0030_project_costing.sql"), read("app/api/finance/close/route.ts"),
    read("app/api/operations/route.ts"), read("docs/finance-project-costing-plan.md"),
    read("app/api/finance/purchasing/route.ts"), read("app/api/hr/payroll/route.ts"), read("app/api/sales/route.ts"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_cost_centers", "finance_project_monthly_budgets", "finance_project_allocations"]) {
    assert.match(api, new RegExp(table)); assert.match(migration, new RegExp(table));
  }
  assert.match(schema, /financeCostCenters/); assert.match(schema, /financeProjectMonthlyBudgets/); assert.match(schema, /financeProjectAllocations/);
  assert.match(api, /center\.opportunity_id = opportunity\.id/);
  assert.match(api, /Number\(allocated\?\.amount \?\? 0\) \+ allocationAmount > source\.amount/);
  assert.match(api, /영업기회로 자동 귀속된 매출은 수동으로 다시 배부할 수 없습니다/);
  assert.match(api, /잠긴 마감월에는 프로젝트 배부를 추가할 수 없습니다/);
  assert.match(view, /추정 자동배부 금지/); assert.match(view, /타임시트·관리자 확인 근거/);
  assert.match(close, /PROJECT_COST_ALLOCATION/); assert.match(operations, /project-costing-risk/);
  assert.match(purchasing, /프로젝트 원가에 배부된 매입 인보이스/);
  // R1(D2-b): 급여 재오픈은 재무 배부를 조회하지 않는다.
  assert.doesNotMatch(payroll, /finance_project_allocations|프로젝트 원가에 배부된 급여월/);
  assert.match(sales, /프로젝트 손익에 반영된 청구서/);
  assert.match(plan, /Clobe 세금계산서 스냅샷은 문서 ID가 없는 일·거래처 집계이므로 프로젝트 손익 원천으로 자동 배부할 수 없다/);
});

test("expense controls reconcile corporate cards, reviewed evidence and existing bank-payment ledgers", async () => {
  const [api, view, page, schema, migration, operations, documents, close, tasks, plan] = await Promise.all([
    read("app/api/finance/expense-control/route.ts"), read("app/expense-control-workspace.tsx"), read("app/page.tsx"),
    read("db/schema.ts"), read("drizzle/0031_expense_evidence_control.sql"), read("app/api/finance/operations/route.ts"),
    read("app/api/documents/route.ts"), read("app/api/finance/close/route.ts"), read("app/api/operations/route.ts"),
    read("docs/finance-expense-control-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_corporate_cards", "finance_card_transactions", "finance_expense_controls"]) {
    assert.match(api, new RegExp(table)); assert.match(migration, new RegExp(table));
  }
  assert.match(schema, /financeCorporateCards/); assert.match(schema, /financeCardTransactions/); assert.match(schema, /financeExpenseControls/);
  assert.match(api, /전체 카드번호와 외화 원화환산값은 추정·저장하지 않습니다/);
  assert.match(api, /금액이 정확히 같은 승인 완료 법인카드 지출만 연결할 수 있습니다/);
  assert.match(api, /해당 지출에 첨부된 유효한 증빙 문서를 선택해 주세요/);
  assert.match(api, /완료된 증빙 검토는 재개방한 뒤 다시 확정해 주세요/);
  assert.match(api, /미대사 카드 거래를 모두 연결하거나 제외한 뒤 카드를 종료해 주세요/);
  assert.match(api, /DEDUCTIBLE.*NONDEDUCTIBLE.*OUT_OF_SCOPE/s);
  assert.match(view, /증빙 파일 존재만으로 적격성을 자동 확정하지 않습니다/);
  assert.match(view, /카드사 거래 참조값/);
  assert.match(operations, /지급 전 법인카드·지출증빙 화면에서 증빙과 세무 처리를 검토해 주세요/);
  assert.match(operations, /실제 카드 승인 거래와 정확한 금액으로 대사한 후/);
  assert.match(operations, /card_transaction_status !== "MATCHED"/);
  assert.doesNotMatch(documents, /financeExpense|검토 완료된 지출증빙입니다/);
  assert.match(close, /EXPENSE_SPEND_CONTROL/); assert.match(tasks, /expense-control-risk/);
  assert.match(plan, /기존 `finance_expense_requests`, 지급원장, 전표, 은행 대사를 회계 원천으로 유지한다/);
  assert.match(plan, /카드번호 전체값, CVC, 유효기간 저장/);
});

test("employee persistence retains lifecycle state across refreshes", async () => {
  const [schema, route, workspace] = await Promise.all([
    read("db/schema.ts"),
    read("app/api/hr/employee-records/route.ts"),
    read("app/hr-workspace.tsx"),
  ]);
  for (const field of ["join_date", "status", "history_json", "retirement_json"]) assert.match(route, new RegExp(field));
  for (const field of ["joinDate", "historyJson", "retirementJson"]) assert.match(schema, new RegExp(field));
  assert.match(workspace, /신규 직원을 인사기록카드에 영구 등록했습니다/);
  assert.match(workspace, /RETIREMENT_CHECKLIST|resource: "retirement"/);
});

test("applicant popup owns screening and interview, and the list only reports stages", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/hr-workspace.tsx"),
    read("public/hr-workspace.css"),
  ]);
  // 서류 합불은 목록 행이 아니라 지원자 팝업에서만 누른다.
  // 서류 합불과 특이사항 메모는 한 칸으로 합쳤다. 합불 버튼은 메모 아래에 붙는다.
  assert.match(workspace, /<h3>서류 심사 및 특이사항 기록<\/h3>/);
  assert.match(workspace, /screening === "PASSED" && <section className="applicant-interview-block">/);
  assert.doesNotMatch(workspace, /applicant-special-notes|applicant-edit-side|applicant-edit-layout/);
  assert.doesNotMatch(styles, /applicant-special-notes|applicant-edit-side|applicant-edit-layout/);
  assert.match(workspace, /onDecideScreening\(applicant\.id, "PASS"\)/);
  assert.match(workspace, /onDecideScreening\(applicant\.id, "REJECT"\)/);
  // 잘못 눌렀을 때 되돌릴 수 있어야 한다.
  assert.match(workspace, /onDecideScreening\(applicant\.id, "RESET"\)\}>평가중으로 되돌리기/);
  // RESET 은 별도 분기 없이 "평가중" 단계로 되돌아간다.
  assert.match(workspace, /decision === "REJECT" \? SCREENING_REJECTED_STAGE : SCREENING_PENDING_STAGE/);

  // 목록은 채용단계(서류 결과)와 현재 단계(면접 일정)만 보여준다.
  // 열 너비는 자리 번호가 아니라 클래스로 잡는다 — 열을 끼워 넣어도 너비가 밀리지 않게.
  assert.match(workspace, /<th className="applicant-stage-column">현재 단계<\/th><th>채용단계<\/th>/);
  assert.match(styles, /\.applicant-table \.applicant-stage-column \{/);
  assert.doesNotMatch(workspace, /<th>채용 처리<\/th>/);
  // 채용단계는 서류 합격 뒤를 면접일 유무로 가른다.
  assert.match(workspace, /PENDING: "서류 평가중", INTERVIEW_PENDING: "면접일 미정", INTERVIEW_SCHEDULED: "면접 예정",/);
  assert.match(workspace, /applicant\.interview\?\.date\?\.trim\(\) \? "INTERVIEW_SCHEDULED" : "INTERVIEW_PENDING"/);
  assert.match(styles, /\.screening-stage\.interview_pending \{/);
  assert.match(styles, /\.screening-stage\.interview_scheduled \{/);
  // 사유가 무엇이든 탈락자는 채용단계에 "탈락" 하나로 묶고, 처우 단계까지 간 사람만 "면접"이다.
  assert.match(workspace, /if \(REJECTED_STAGES\.includes\(applicant\.stage\)\) return "REJECTED";/);
  assert.match(workspace, /if \(OFFER_STAGES\.includes\(applicant\.stage\)\) return "INTERVIEW";/);
  // 면접 단계에서 내린 탈락은 불참이든 아니든 현재 단계에 "면접 탈락"으로 적는다.
  assert.match(workspace, /INTERVIEW_NO_SHOW_STAGE\) return INTERVIEW_REJECTED_STAGE;/);
  assert.match(workspace, /function currentStageOf\(applicant: Applicant\)/);

  // 면접관리 탭과 서류 합격 처리 페이지는 팝업으로 흡수되어 사라졌다.
  assert.doesNotMatch(workspace, /function ScreeningWorkflow\(|function InterviewManagement\(|function InterviewCandidateView\(/);
  assert.doesNotMatch(workspace, /label: "면접관리"/);
  // 흡수된 기능(면접 녹음, 제안 수락 전환)은 팝업 안에 남아 있어야 한다.
  // 면접 녹음은 걷어냈다. 면접 박스는 질문지(왼쪽)와 결과(오른쪽) 두 칸으로 나뉜다.
  assert.doesNotMatch(workspace, /<ApplicantInterviewRecorder applicantId=/);
  assert.match(workspace, /className="applicant-interview-split"/);
  assert.match(workspace, /<span>면접 질문지<\/span>/);
  // 질문지는 세 단계다: 면접일 입력 시 기본 질문지 자동 작성, 심화 질문 생성, 역제안 질문 생성.
  assert.match(workspace, /심화 질문 생성/);
  assert.match(workspace, /역제안 질문 생성/);
  assert.doesNotMatch(workspace, /AI 면접질문 생성/);
  assert.match(styles, /\.applicant-interview-split \{/);
  // 지원자가 다른 자리를 역으로 제안하면 질문 구성이 바뀐다(13개 안팎, 분류 2개 신설).
  assert.match(workspace, /counterProposal\?: string;/);
  assert.match(workspace, /<span>역제안 포지션\{counterBadge &&/);
  assert.match(workspace, /counterProposalPosition: schedule\.counterProposal\.trim\(\)/);
  assert.match(workspace, /COUNTER_ROLE_SKILL: "역제안 직무 역량"/);
  // 역제안 칸은 잠그지 않는다. 기록된 역제안 2건이 모두 면접 전날에 들어왔기 때문이다.
  // 대신 당일이면 눈에 띄게, 시각 30분 전부터 더 진하게 표시한다(면접이 10~20분 일찍 시작된다).
  assert.match(workspace, /function counterProposalTone\(schedule: InterviewSchedule, now: Date\)/);
  assert.match(workspace, /now\.getTime\(\) >= start\.getTime\(\) - 30 \* 60 \* 1000/);
  assert.match(workspace, /counterTone === "soon" \? "면접 임박" : counterTone === "today" \? "오늘 면접"/);
  assert.doesNotMatch(workspace, /applicant-counter-proposal[^>]*disabled/);
  assert.match(styles, /\.applicant-counter-proposal\.today \.applicant-counter-badge \{/);
  assert.match(styles, /\.applicant-counter-proposal\.soon input \{/);
  // 역제안 칸은 질문 생성 버튼 옆에 둔다 — 질문을 만들기 직전에 적는 값이다.
  assert.match(styles, /\.applicant-interview-pane-actions \.applicant-counter-proposal \{/);
  // 면접 질문지·면접 결과 상자는 같은 높이에서 시작한다 — 라벨 grid 의 남는 높이가 글자 행으로 가면 오른쪽만 내려간다.
  assert.match(styles, /\.applicant-interview-pane \.form-note \{ align-content: start; \}/);
  // 역제안 질문 앞에는 구분선을 넣어 지원 포지션 질문과 섞이지 않게 한다.
  assert.match(workspace, /const COUNTER_QUESTION_SEPARATOR = "-+ 역제안 포지션용 질문 -+";/);
  assert.match(workspace, /if \(!counterStarted && COUNTER_QUESTION_CATEGORIES\.includes\(key\)\)/);
  // 역제안 직무가 우리 조직에 있는지 판단하려면 roleFocus 가 있어야 한다.
  assert.match(workspace, /roleFocus: \{/);
  // 면접 중 다시 생성해도 앞서 물어본 질문이 사라지면 안 된다.
  assert.match(workspace, /current\.questions\?\.trim\(\) \?/);
  // 일정 저장 버튼을 없애고 상·하단 「변경사항 저장」으로 합쳤다.
  assert.doesNotMatch(workspace, />면접 일정 저장<\/button>/);
  // 질문지만 채운 경우에도 저장되어야 한다.
  assert.match(workspace, /schedule\.questions, schedule\.counterProposal\]\.some\(Boolean\)/);
  // 채용 종료 표에도 삭제 버튼이 있다.
  assert.match(workspace, /<td colSpan=\{9\} className="empty-cell">종료된 지원자가 없습니다\./);
  // 처우 제안 단계는 별도 박스다. 제안 → 수락/거절 순서이고, 수락은 최종 처우 팝업에서 확정한다.
  assert.match(workspace, /처우 제안 단계/);
  assert.match(workspace, /최종 처우 확정/);
  assert.match(workspace, /제안 거절 기록/);
  // 합격은 처우 입력 모달로 이어지고 판단 근거가 메모로 남는다.
  assert.match(workspace, /className="employee-modal interview-pass-modal"/);
  assert.match(workspace, /면접 결과\(합격\): \$\{interviewResult\.trim\(\)\}/);
  // 탈락은 면접 불참과 면접 후 탈락 두 갈래로 나뉘고, 적어 둔 면접 결과가 메모로 남는다.
  assert.match(workspace, /const prefix = attended \? "면접 결과\(탈락\)" : "면접 불참\(탈락\)";/);
  assert.match(workspace, /\$\{prefix\}: \$\{interviewResult\.trim\(\)\}/);
  assert.match(workspace, />면접 불참 탈락<\/button>/);
  assert.match(workspace, />면접 후 탈락<\/button>/);
  assert.match(styles, /\.screening-stage\.rejected \{/);
  assert.match(styles, /\.screening-stage\.interview \{/);
  // 지원 현황 아래에 면접 일시 순으로 정렬된 면접 전형 표가 따로 있다.
  assert.match(workspace, /className="panel table-panel interview-schedule-panel"/);
  assert.match(workspace, /<th>면접 일시<\/th>/);
  // 면접 예정 정렬은 대시보드 모델로 옮겨 갔다 — 날짜 뒤에 시간을 붙여 비교한다.
  const dashboardModel = await readFile("app/hr-dashboard-model.ts", "utf8");
  assert.ok(dashboardModel.includes('`${dashDate(a.interview!.date)} ${a.interview!.time || "99:99"}`.localeCompare('));
  // 절차가 끝난 사람(탈락·제안 거절·타사 합격·오퍼 수락)은 지원 현황에서 빼고
  // 페이지 맨 아래 "채용 종료" 표 한 곳에 모은다.
  assert.match(workspace, /className="panel table-panel closed-applicant-panel"/);
  assert.match(workspace, /const REJECTED_STAGES = \[SCREENING_REJECTED_STAGE, INTERVIEW_REJECTED_STAGE, INTERVIEW_NO_SHOW_STAGE\]/);
  assert.match(workspace, /const CLOSED_STAGES = \[/);
  // 면접에 합격한 뒤의 단계는 지원 현황에서 빠진다 — 합격자는 면접 전형 진행 표에서 본다.
  assert.match(workspace, /const active = visible\.filter\(\(applicant\) => !CLOSED_STAGES\.includes\(applicant\.stage\)\s*&& !OFFER_STAGES\.includes\(applicant\.stage\)\);/);
  // 면접 전형 진행 표는 세 갈래를 한 표에 담되 손댈 일이 남은 순서로 세운다.
  assert.match(workspace, /AWAITING: "결과 입력 대기", SCHEDULED: "면접 예정", PASSED: "면접 합격"/);
  assert.match(workspace, /const interviewTrackOrder: Record<InterviewTrack, number> = \{ AWAITING: 0, SCHEDULED: 1, PASSED: 2 \};/);
  assert.match(workspace, /if \(applicant\.stage === INTERVIEW_PASSED_STAGE \|\| applicant\.stage === OFFER_PREPARED_STAGE\) return "PASSED";/);
  assert.match(workspace, /\|\| applicant\.stage === INTERVIEW_PASSED_STAGE \|\| applicant\.stage === OFFER_PREPARED_STAGE\)/);
  assert.match(styles, /\.interview-track\.awaiting \{/);
  assert.match(styles, /\.interview-track\.passed \{/);
  // 처우를 제안하면 합격 안내문이 그 값으로 자동 작성된다. 수습 안내는 선택이라 끄면 그 줄이 빠진다.
  assert.match(workspace, /const COMPANY_NAME = "\(주\) 엑스디노드";/);
  assert.match(workspace, /function offerMessageTokens\(applicant: Applicant, offer: RecruitmentOffer, options: \{/);
  assert.match(workspace, /firstTerm: \{ percent: string \} \| null;/);
  // 회사는 첫 3개월을 기간제로 맺는다. 안내문은 "수습"이 아니라 첫 계약과 지급률을 적고, 예전 저장 문구의 {{수습안내}} 자리도 같은 문장을 받는다.
  assert.match(workspace, /첫계약안내: options\.firstTerm \? firstTermNotice\(options\.firstTerm\.percent\) : ""/);
  assert.match(workspace, /수습안내: options\.firstTerm \? firstTermNotice\(options\.firstTerm\.percent\) : ""/);
  assert.match(workspace, /기간제 근로계약이며, 해당 기간에는 기준 연봉의 \$\{percent \|\| "\[XX\]"\}%가 지급됩니다/);
  assert.match(workspace, /firstTerm: offerFirstTermOn \? \{ percent: String\(activeOffer\.firstTermPayPercent \?\? 100\) \} : null \}\),/);
  assert.match(workspace, /제목: \{\{회사명\}\} 최종 합격 및 입사 오퍼 안내/);
  assert.match(workspace, /\* 연봉: 세전 \{\{연봉\}\}원/);
  assert.match(styles, /\.offer-message-block \{/);
  // 승낙 뒤에는 입사 안내문으로 갈아 끼운다. 선택 서류는 체크한 것만 들어간다.
  assert.match(workspace, /const ONBOARDING_OPTIONAL_DOCS = \[/);
  assert.match(workspace, /최종학력 졸업증명서\(선택\)/);
  assert.match(workspace, /function onboardingMessageTokens\(applicant: Applicant, offer: RecruitmentOffer, optionalDocIds: string\[\]\)/);
  assert.match(workspace, /\.filter\(\(doc\) => optionalDocIds\.includes\(doc\.id\)\)/);
  assert.match(workspace, /const accepted = \["ACCEPTED", "ONBOARDED"\]\.includes\(activeOffer\.status\);/);
  assert.match(workspace, /제목: 입사 일정 및 준비사항 안내/);
  assert.match(styles, /\.offer-message-docs \{/);

  // 안내문 기본 문구는 서버에 저장해 모든 지원자에게 쓴다. 사람마다 달라지는 값은 토큰 자리로 남는다.
  const templates = await read("app/api/hr/message-templates/route.ts");
  assert.match(templates, /authorizeErpRequest/);
  assert.match(templates, /writeErpAudit/);
  assert.match(templates, /CREATE TABLE IF NOT EXISTS hr_message_templates/);
  assert.match(templates, /MESSAGE_TEMPLATE_UPDATED/);
  assert.match(templates, /MESSAGE_TEMPLATE_RESET/);
  assert.match(templates, /const TEMPLATE_IDS = \["OFFER", "ONBOARDING", "REJECTION", "INTERVIEW"\]/);
  // 서류 합격 뒤 면접일·시작 시간을 넣으면 면접 안내문이 그 자리에서 만들어진다. 요일·시각은 입력값에서 계산한다.
  assert.match(workspace, /const DEFAULT_INTERVIEW_TEMPLATE = `안녕하세요\. \{\{지원자명\}\}님/);
  assert.match(workspace, /- 면접 일시: \{\{면접일시\}\}/);
  assert.match(workspace, /function interviewMessageTokens\(applicant: Applicant, schedule: InterviewSchedule\)/);
  assert.match(workspace, /"일월화수목금토"\[new Date\(year, month - 1, day\)\.getDay\(\)\]/);
  // 서류 합격이면 면접 안내문이 바로 보인다. 일시가 비어 있으면 자리표시로 보이다가 입력하는 대로 채워진다.
  assert.match(workspace, /\{!OFFER_STAGES\.includes\(applicant\.stage\) && !REJECTED_STAGES\.includes\(applicant\.stage\) && messageComposer\(\{/);
  assert.match(workspace, /"면접일과 시작 시간을 입력하면 일시가 채워집니다 — 지금은 자리표시로 보입니다"/);
  // 채용요청·TO 칸은 눌러서 그 자리에서 바꾼다. 모집 중인 공고만 고를 수 있고, 입사 예정자·채용 종료 표에서는 읽기 전용이다.
  assert.match(workspace, /<select className="applicant-to-select" autoFocus value=\{current\}/);
  assert.match(workspace, /OPEN_REQUISITION_STATUSES\.includes\(item\.status\) \|\| item\.id === current/);
  assert.match(workspace, /onRequisitionChange=\{\(applicant, requisitionId\) => updateApplicantDetail\(\{ \.\.\.applicant, requisitionId \}\)\}/);
  assert.equal(workspace.match(/<RequisitionCell requisition=\{requisition\} applicant=\{applicant\} requisitions=\{requisitions\} onChange=\{onRequisitionChange\} \/>/g).length, 3);
  assert.equal(workspace.match(/<RequisitionCell requisition=\{requisition\} \/>/g).length, 2);
  assert.match(workspace, /const MESSAGE_TEMPLATE_IDS: MessageTemplateId\[\] = \["OFFER", "ONBOARDING", "REJECTION", "INTERVIEW"\];/);

  // 입사 전환은 확정한 연봉을 인사기록카드에 함께 넣어야 한다. 처우 컬럼이 빠져 0 으로 들어가면
  // 임금계산이 이 표를 그대로 읽는 탓에 갓 입사한 사람이 0원짜리 대상자가 된다.
  // 처우 컬럼은 뒤에 붙은 것이라, 이 라우트도 없으면 만들어 둬야 위 INSERT 가 성립한다.
  // 인사기록카드의 직무·직위는 고정 목록이다. 입사 전환에서 자유 문구를 넣으면 카드가 엉뚱한 값을 보인다.
  assert.match(workspace, /<label><span>직무 \*<\/span><select required value=\{responseDraft\.jobTitle\}/);
  assert.match(workspace, /useState\(\{ employeeId: "", position: "", jobTitle: "", responseNote: "" \}\)/);
  assert.match(workspace, /<span>직위 \*<\/span><select required value=\{draft\.position\}/);
  assert.match(workspace, /<span>직무 \*<\/span><select required value=\{draft\.jobTitle\}/);
  assert.match(workspace, /const DEFAULT_OFFER_TEMPLATE = /);
  assert.match(workspace, /const DEFAULT_ONBOARDING_TEMPLATE = /);
  assert.match(workspace, /function renderTemplate\(body: string, tokens: Record<string, string>\)/);
  assert.match(workspace, /const DEFAULT_REJECTION_TEMPLATE = /);
  // 탈락 사유는 적지 않는다. 직무 적합도로 갈린 결정이라는 문장만 남는다.
  assert.doesNotMatch(workspace, /DEFAULT_REJECTION_TEMPLATE[\s\S]*?탈락 사유/);
  assert.match(workspace, /제목: \{\{회사명\}\} \{\{포지션\}\} 채용 전형 결과 안내/);
  assert.match(workspace, /function rejectionMessageTokens\(applicant: Applicant, options: \{/);
  // 면접에 오지 않은 사람에게 "면접을 진행했다"는 문장이 나가면 안 된다.
  assert.match(workspace, /면접안내: options\.mentionInterview \? /);
  assert.match(workspace, /const mentionInterview = rejectionInterviewOn \?\? applicant\.stage === INTERVIEW_REJECTED_STAGE;/);
  assert.match(workspace, /const interviewDate = rejectionInterviewDate \?\? schedule\.date;/);
  assert.match(workspace, /\[INTERVIEW_REJECTED_STAGE, INTERVIEW_NO_SHOW_STAGE\]\.includes\(applicant\.stage\) && \(\(\) => \{/);
  assert.match(workspace, /templateId: "REJECTION",/);
  // 합격·입사·불합격 안내문은 한 얼개를 함께 쓴다. 편집·복사 방식이 세 군데로 갈라지면 안 된다.
  assert.match(workspace, /function messageComposer\(config: \{/);
  assert.equal(workspace.match(/className="offer-message-text"/g).length, 2);
  // 토큰만 있던 줄이 빈 값이 되면 줄째로 지운다 — 수습 안내를 끄면 빈 줄이 남으면 안 된다.
  assert.match(workspace, /\.filter\(\(row\) => !row\.drop\)/);
  assert.match(workspace, /fetch\("\/api\/hr\/message-templates"\)/);
  assert.match(workspace, /templateId: id, body/);
  assert.match(styles, /\.offer-message-tokens \{/);
  assert.match(workspace, /<th className="applicant-status-column">종료 구분<\/th>/);
  assert.match(styles, /\.closed-applicant-panel \{/);
  // 면접 전형 진행 아래에 「면접 결과 입력」 표가 있고, 면접 시각이 지났는데 결과가 없는 사람만 담는다.
  assert.match(workspace, /className="panel table-panel interview-result-panel"/);
  assert.match(workspace, /<h2>면접 결과 입력<\/h2>/);
  assert.match(workspace, /const awaiting = interviewRows\.filter\(\(row\) => row\.track === "AWAITING"\)\.map\(\(row\) => row\.applicant\);/);
  // 그 사람들은 면접 전형 진행 표에서 빠진다 — 한 사람이 한 표에만 보인다.
  assert.match(workspace, /const interviewing = interviewRows\.filter\(\(row\) => row\.track !== "AWAITING"\);/);
  // 처우 제안 준비 단계도 면접이 끝난 사람이라 합격 트랙에 남아 어디에도 안 보이는 일이 없다.
  assert.match(workspace, /applicant\.stage === INTERVIEW_PASSED_STAGE \|\| applicant\.stage === OFFER_PREPARED_STAGE\) return "PASSED";/);
  assert.match(workspace, /className="interview-result-button" onClick=\{\(\) => onSelect\(applicant\.id\)\}>결과 입력 →<\/button>/);
  assert.match(workspace, /<td colSpan=\{9\} className="empty-cell">결과를 입력할 면접이 없습니다\./);
  // 입사 예정자는 처우 수락자만 입사예정일 순. 예전 「면접 결과」 표와 그 상태 배지는 없다.
  assert.match(workspace, /OFFER_STAGES\.includes\(applicant\.stage\) && \["ACCEPTED", "ONBOARDED"\]\.includes\(applicant\.offer\?\.status \?\? ""\)/);
  assert.match(workspace, /<th>입사예정일<\/th>/);
  assert.doesNotMatch(workspace, /passed-applicant-panel|passedStatusTone/);
  assert.doesNotMatch(styles, /\.passed-status/);
  assert.match(styles, /\.interview-result-panel \{/);
  // 면접 합격은 이제 실제 단계다. 처우를 제안하기 전에도 "면접 합격"으로 읽혀야 한다.
  assert.match(workspace, /const INTERVIEW_PASSED_STAGE = "면접 합격";/);
  // 처우까지 제안했으면 면접 절차가 끝난 것이라 "면접 종료"로 적는다.
  assert.match(workspace, /if \(applicant\.stage === OFFER_PREPARED_STAGE\) return "면접 종료";/);
  // 면접 이후 단계는 지난 면접 일정이 아니라 단계 이름을 보여준다.
  assert.match(workspace, /if \(OFFER_STAGES\.includes\(applicant\.stage\)\) return applicant\.stage;/);
  // 타사 합격은 우리가 떨어뜨린 "탈락"과 구분해 채용단계에 따로 적는다.
  assert.match(workspace, /const OTHER_OFFER_STAGE = "타사 합격";/);
  assert.match(workspace, /OTHER_OFFER: OTHER_OFFER_STAGE/);
  // 입사 예정자 표에도 연락처가 있고, 채용 페이지의 모든 표가 같은 열 너비 규칙을 쓴다.
  assert.match(workspace, /<th className="applicant-phone-cell">연락처<\/th><th className="applicant-to-column">채용요청·TO<\/th><th>제안 직무<\/th>/);
  assert.match(styles, /\.recruitment-page \.table-panel \.data-table \.applicant-phone-cell \{ min-width: 132px; \}/);
  assert.match(styles, /\.recruitment-page \.table-panel \.data-table \.applicant-to-column \{ min-width: 200px; \}/);
  assert.match(styles, /\.recruitment-page \.table-panel \.data-table \.applicant-owner-column \{ min-width: 132px; \}/);
  assert.match(styles, /\.recruitment-page \.table-panel \.data-table \.applicant-status-column \{ min-width: 148px; \}/);

  // 공고를 종료해도 지원자의 연결은 남으므로, 목록에서 걸러 내면 화면에서만 "예외·미연결"로 보인다.
  // 그래서 종료된 공고까지 내려주고, 새로 고를 수 있는 공고는 선택 상자에서 status 로 거른다.
  const recruitmentRoute = await read("app/api/hr/recruitment/route.ts");
  assert.match(recruitmentRoute, /function onboardingPayBreakdown\(annualSalary: number\)/);
  assert.match(recruitmentRoute, /const STANDARD_MEAL_ALLOWANCE = 200_000;/);
  assert.match(recruitmentRoute, /const monthly = Math\.ceil\(annual \/ 12\);/);
  assert.match(recruitmentRoute, /const pay = onboardingPayBreakdown\(offer\.annual_salary\);/);
  assert.match(recruitmentRoute, /annual_salary, base_pay, meal_allowance, childcare_allowance, vehicle_allowance, first_term_pay_percent, updated_at\)/);
  assert.match(recruitmentRoute, /await ensureHrEmployeeRecordsSchema\(db\)/);

  // 근로계약서: 회사 양식의 빈칸만 {{토큰}}으로 바꿔 두고, 인사기록카드 값으로 채워 브라우저에서 내려준다.
  const contract = await read("app/hr-employment-contract.ts");
  assert.match(contract, /FIXED_TERM: "\/hr\/employment-contract-fixed-term\.docx",/);
  assert.match(contract, /REGULAR: "\/hr\/employment-contract-regular\.docx",/);
  assert.match(contract, /export const FIXED_TERM_MONTHS = 3;/);
  // 첫 계약 종료일은 시작일 + 3개월 − 1일. 화면에서 고르지 않고 계산한다.
  assert.match(contract, /nextStart\.setDate\(nextStart\.getDate\(\) - 1\);/);
  assert.match(contract, /export const MONTHLY_WAGE_HOURS = 182\.5;/);
  assert.match(contract, /Math\.round\(basePay \/ MONTHLY_WAGE_HOURS\)/);
  assert.match(contract, /await import\("fflate"\)/);
  // 남은 토큰이 있으면 만들지 않는다 — 빈칸이 남은 계약서가 조용히 나가면 안 된다.
  assert.match(contract, /throw new Error\(`근로계약서 양식에 채우지 못한 자리가 있습니다/);
  // 양식의 토큰과 코드가 채우는 토큰이 정확히 같아야 한다. 양식을 고치면 이 검사가 먼저 걸린다.
  const tokenBlock = contract.slice(contract.indexOf("export function contractTokens("), contract.indexOf("function escapeXml("));
  const codeTokens = new Set([...tokenBlock.matchAll(/^\s{4}([가-힣]+): /gm)].map((match) => match[1]));
  const templateTokens = new Set();
  const templateTexts = {};
  for (const file of ["fixed-term", "regular"]) {
    const buffer = await readFile(new URL(`../public/hr/employment-contract-${file}.docx`, import.meta.url));
    assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
    const xml = strFromU8(unzipSync(new Uint8Array(buffer))["word/document.xml"]);
    templateTexts[file] = xml.replace(/<[^>]+>/g, "");
    for (const token of xml.match(/\{\{[^}]+\}\}/g)) {
      const key = token.slice(2, -2);
      assert.ok(codeTokens.has(key), `${file} 양식에 코드가 모르는 토큰 ${key}`);
      templateTokens.add(key);
    }
  }
  assert.deepEqual([...templateTokens].sort(), [...codeTokens].sort());
  // 회사는 첫 입사자와 3개월 기간제를 맺고 근무평가 뒤 기간의 정함이 없는 계약을 다시 맺는다.
  // 두 양식 모두 수습 조항이 없어야 한다 — 3개월 기간제에는 최저임금 수습 감액을 쓸 수 없다.
  assert.doesNotMatch(templateTexts["fixed-term"], /수습/);
  assert.doesNotMatch(templateTexts["regular"], /수습/);
  assert.match(templateTexts["fixed-term"], /일까지\(3개월\)로 한다\./);
  assert.match(templateTexts["fixed-term"], /계약기간의 만료로 종료한다/);
  assert.match(templateTexts["fixed-term"], /기간의 정함이 없는 근로계약의 체결 여부를 결정하여/);
  assert.match(templateTexts["regular"], /기간의 정함이 없는 근로계약으로 한다\./);
  assert.match(templateTexts["regular"], /최초 입사일인/);
  // 첫 계약은 사람마다 기준 연봉의 몇 %를 줄지 다르다. 계약서에 비율이 적히고, 표의 금액은 비율을 적용한 값이다.
  assert.match(templateTexts["fixed-term"], /기준 연봉의\s+\{\{지급비율\}\}\s*%에 해당하는 임금/);
  assert.doesNotMatch(templateTexts["regular"], /지급비율/);
  assert.match(contract, /export function contractPay\(employee: ContractEmployee, options: ContractOptions\)/);
  assert.match(contract, /Math\.ceil\(annual \* percent \/ 100 \/ 12\) - meal - vehicle - childcare/);
  // 3개월 기간제에는 수습 감액이 없다. 최저시급에 못 미치면 파일을 만들지 않는다.
  assert.match(contract, /export const MINIMUM_HOURLY_WAGE = 10_320;/);
  assert.match(contract, /const problem = contractPay\(employee, options\)\.problem;\s+if \(problem\) throw new Error\(problem\);/);
  assert.match(workspace, /disabled=\{contractBusy \|\| Boolean\(pay\.problem\)\}/);
  // 지급률은 처우 제안 때 정해 최종 확정·입사 정보 수정을 거쳐 입사 완료 시 인사기록카드로 넘어가고, 카드에서 고칠 수 있다.
  assert.match(recruitmentRoute, /function payPercentOf\(value: unknown, fallback: number\)/);
  assert.match(recruitmentRoute, /probation_months, first_term_pay_percent, notes, status, requested_by/);
  assert.match(recruitmentRoute, /probation_months = \?, first_term_pay_percent = \?, department = \?/);
  assert.match(recruitmentRoute, /annual_salary = \?, probation_months = \?, first_term_pay_percent = \?, response_note = \?/);
  assert.match(recruitmentRoute, /vehicle_allowance, first_term_pay_percent, updated_at\)/);
  assert.match(recruitmentRoute, /offer\.first_term_pay_percent \?\? 100, now, id, now\),/);
  // 임금계산은 인사기록카드의 첫 계약 지급률을 엔진의 수습 구간(일할)에 태운다. 종료일은 계약서와 같은 함수로 계산한다.
  const compensationRoute = await read("app/api/hr/compensation/route.ts");
  assert.match(compensationRoute, /import \{ FIXED_TERM_MONTHS, fixedTermEndDate \} from "\.\.\/\.\.\/\.\.\/hr-employment-contract";/);
  assert.match(compensationRoute, /probationRate: firstTermOf\(employee\)!\.rate, probationEndDate: firstTermOf\(employee\)!\.end, manualBasic: false/);
  assert.match(compensationRoute, /if \(employee\.regular_contract_date && employee\.regular_contract_date <= end\) end = dayBefore\(employee\.regular_contract_date\);/);
  const engine = await read("app/compensation-calculation.ts");
  assert.match(engine, /rate: employee\.probationRate \?\? 0\.9/);
  assert.match(engine, /employee\.probationEndDate \? parseDate\(employee\.probationEndDate\) : probationEnd\(join, employee\.probationMonths\)/);
  const employeeRecords = await read("app/api/hr/employee-records/route.ts");
  assert.match(employeeRecords, /first_term_pay_percent = excluded\.first_term_pay_percent,/);
  assert.match(employeeRecords, /firstTermPayPercent: row\.first_term_pay_percent \?\? 100,/);
  assert.match(workspace, /firstTermPayPercent: Number\(offerDraft\.firstTermPayPercent\) \|\| 100,/);
  assert.match(workspace, /firstTermPayPercent: Number\(finalOffer\.firstTermPayPercent\) \|\| 100,/);
  assert.match(workspace, /<input name="firstTermPayPercent" type="number" min="1" max="100"/);
  assert.match(workspace, /firstTermPayPercent: next\.firstTermPayPercent \?\? 100,/);
  // 계약서 팝업은 카드 값을 읽기만 한다 — 두 곳에서 따로 고치면 계약서와 급여가 어긋난다.
  assert.match(workspace, /<span>첫 계약 지급률\(%\) · 인사기록카드 기준<\/span><input readOnly/);
  assert.match(contract, /firstTermPayPercent: String\(employee\.firstTermPayPercent \?\? 100\),/);

  // 3개월 첫 계약 만료 → 정규직 전환. 대시보드가 만료 30일 전부터 보여 주고, 전환을 기록하면 목록에서 빠진다.
  assert.match(employeeRecords, /regular_contract_date = excluded\.regular_contract_date,/);
  assert.match(await read("app/hr-employee-schema.ts"), /\["regular_contract_date", "TEXT NOT NULL DEFAULT \x27\x27"\]/);
  assert.match(workspace, /async function markRegularContract\(employee: Employee, date: string, review: FirstTermReview\)/);
  // 전환이든 종료든 계약서 제2조의 기준(직무수행·근무태도·협업)으로 평가를 먼저 남긴다. 종료는 퇴직 절차로 바로 이어진다.
  assert.match(workspace, /async function endFirstTermContract\(employee: Employee, endDate: string, review: FirstTermReview\)/);
  assert.match(workspace, /setRetirementPrefill\(\{ date: endDate, reason: "3개월 기간제 근로계약 만료\(정규직 미전환\)" \}\);/);
  assert.match(workspace, /label: "직무수행 능력" \}, \{ key: "attitude", label: "근무태도" \}, \{ key: "teamwork", label: "협업" \}/);
  const renewalModel = await readFile("app/hr-dashboard-model.ts", "utf8");
  assert.ok(renewalModel.includes('employee.firstTermReview?.decision !== "END"'));
  assert.match(employeeRecords, /first_term_review_json = excluded\.first_term_review_json,/);
  assert.match(workspace, /type: "정규직 전환", detail: `3개월 기간제 계약 종료 후 기간의 정함이 없는 근로계약 체결 · \$\{reviewSummary\(review\)\}`/);
  // 모든 입사자가 3개월 수습을 거치므로 전환 대상은 재직자 전원이다(ERP 입사 처리 여부와 무관).
  assert.ok(renewalModel.includes('!employee.regularContractDate && employee.firstTermReview?.decision !== "END" && dayGap(employee.joinDate) !== null'));
  assert.ok(!renewalModel.includes("onboardedIds"));
  assert.ok(renewalModel.includes('(task.lifecycle_type ?? "ONBOARDING") !== "RETIREMENT"'));
  assert.ok(renewalModel.includes('return gap <= 30 && gap >= -RENEWAL_GRACE_DAYS;'));
  assert.ok(workspace.includes("panel dash-panel renewal-panel span-12"));
  assert.match(styles, /\.renewal-state\.overdue \{/);
  assert.match(contract, /if \(employee\.regularContractDate\) return "REGULAR";/);

  // 직무 목록은 서버에 저장한다. 예전에는 조직관리에서 추가해도 새로고침하면 사라졌다.
  const catalogs = await read("app/api/hr/catalogs/route.ts");
  assert.match(catalogs, /authorizeErpRequest\(db, "hr", "write"\)/);
  assert.match(catalogs, /CATALOG_ITEM_ADDED/);
  assert.match(catalogs, /CATALOG_ITEM_REMOVED/);
  assert.match(catalogs, /CREATE TABLE IF NOT EXISTS hr_catalog_items/);
  // 종류별로 비어 있을 때만 기준자료로 채운다 — 지운 항목이 되살아나면 안 된다. 직무는 예전 hr_job_titles 내용을 옮긴다.
  assert.match(catalogs, /if \(count\?\.count\) continue;/);
  assert.match(catalogs, /SELECT title FROM hr_job_titles ORDER BY sort_order, created_at/);
  assert.match(catalogs, /JOB_TITLE: \{ label: "직무", seed: companyJobTitles, protectedValues: \["미지정", "조직장"\], column: "job_title" \}/);
  assert.match(catalogs, /RANK: \{ label: "직위", seed: companyRanks, protectedValues: \[\], column: "position" \}/);
  assert.match(catalogs, /SELECT COUNT\(\*\) AS count FROM hr_employee_records WHERE \$\{catalog\.column\} = \?/);

  // 지원자 생년월일·주소는 지원 단계에서 받아 입사 전환 때 인사기록카드·계약서 서명란으로 넘어간다. 이력서 분석도 함께 뽑는다.
  assert.match(recruitmentRoute, /for \(const column of \["birth", "address"\]\)/);
  assert.match(recruitmentRoute, /career_summary=excluded\.career_summary, birth=excluded\.birth, address=excluded\.address,/);
  assert.match(recruitmentRoute, /\(applicant\.birth \?\? ""\)\.replaceAll\("-", "\."\), applicant\.email, applicant\.phone, applicant\.address \?\? ""/);
  const resumeAnalysis = await read("app/api/hr/resume-analysis/route.ts");
  assert.match(resumeAnalysis, /birth: stringValue\(parsed\.birth, 20\),/);
  assert.match(resumeAnalysis, /required: \["name", "email", "phone", "birth", "address", "role",/);
  assert.match(workspace, /<span>생년월일<\/span><input type="date" value=\{applicantDraft\.birth\}/);
  assert.match(workspace, /birth: analysis\.birth \|\| current\.birth,/);
  assert.match(workspace, /fetch\("\/api\/hr\/catalogs"\)/);
  // 직위도 직무처럼 서버에 저장하고, 처우 확정·입사 정보 수정이 정적 기준자료 대신 같은 목록을 쓴다.
  assert.match(workspace, /void changeCatalog\("RANK", "POST", trimmed\);/);
  assert.doesNotMatch(workspace, /companyRanks\.map/);
  assert.match(workspace, /<CatalogManager title="직무 관리"/);
  // 인사기록카드·처우 확정·입사 정보 수정이 같은 목록을 쓴다. 정적 기준자료를 직접 읽는 select 는 남지 않는다.
  assert.doesNotMatch(workspace, /companyJobTitles\.filter/);
  assert.match(workspace, /<LifecycleManagementView jobTitles=\{jobTitles\} ranks=\{ranks\} onSelectApplicant=\{setSelectedApplicantId\}/);
  // 인사문서는 재직자와 퇴사자를 나눠 본다.
  assert.match(workspace, /const scopedEmployees = employees\.filter\(\(employee\) => \(scope === "active"\) === isCurrentEmployee\(employee\)\);/);
  assert.match(workspace, /className="document-scope"/);
  assert.match(styles, /\.document-scope button\.active \{/);
  // 데이터가 없는 모듈 4개는 사이드바에서 접어 둔다. 링크로 들어오면 그 동안만 펼친다.
  assert.match(workspace, /title: "준비 중",\s+collapsed: true,/);
  assert.match(workspace, /const open = !collapsible \|\| deferredOpen \|\| group\.items\.some\(\(item\) => item\.id === active\);/);
  assert.match(styles, /\.nav-collapsed-toggle \{/);
  // 입·퇴사 관리: 입사 예정과 입사 완료는 다른 표에 두고, 둘 다 연락처 열이 있다.
  assert.match(workspace, /<h3 className="lifecycle-table-title">입사 예정 <em>\{pending\.length\}명<\/em><\/h3>/);
  assert.match(workspace, /<h3 className="lifecycle-table-title">입사 완료 <em>\{completed\.length\}명<\/em><\/h3>/);
  assert.match(workspace, /<td className="lifecycle-phone-cell">\{candidate\.phone \|\| "미입력"\}<\/td>/);
  // 인사기록카드 전체 현황 표에도 연락처 열이 있다.
  assert.match(workspace, /<th className="employee-phone-column">연락처<\/th>/);
  assert.match(workspace, /<td className="employee-phone-column">\{employee\.phone \|\| "미입력"\}<\/td>/);
  // 지원 정보 상세: 「경력 상세」 라벨과 분석 버튼 사이 간격, 위 여백 축소, 텍스트박스 확대.
  assert.match(workspace, /<span className="applicant-career-label">경력 상세/);
  assert.match(styles, /\.applicant-edit-fields \.form-note span\.applicant-career-label \{ display: flex;/);
  assert.match(styles, /textarea\.applicant-career-text \{ min-height: 220px; \}/);
  // 지원 정보 상세의 「변경사항 저장」은 팝업의 저장과 같은 함수를 타고, 저장이 되면 창을 닫는다.
  assert.match(workspace, /onClick=\{\(\) => \{ if \(saveChanges\(\)\) setFieldsModalOpen\(false\); \}\}>변경사항 저장<\/button>/);
  assert.match(workspace, /function saveChanges\(\) \{/);
  assert.match(workspace, /import \{ addMonths, buildEmploymentContract, contractFileName, contractKindLabels, contractPay, contractTokens, defaultContractOptions, downloadBlob, FIXED_TERM_MONTHS, fixedTermEndDate, type ContractKind, type ContractOptions \} from "\.\/hr-employment-contract";/);
  assert.match(workspace, /<label><span>계약 종료일 \(자동, 3개월\)<\/span><input readOnly value=\{fixedTermEndDate\(contractOptions\.startDate\)/);
  assert.match(workspace, /근로계약서 다운로드<\/button>/);
  assert.match(workspace, /downloadBlob\(await buildEmploymentContract\(employee, contractOptions\), contractFileName\(employee, contractOptions\)\)/);
  assert.match(styles, /\.contract-preview \{/);
  assert.match(recruitmentRoute, /FROM hr_recruitment_requisitions ORDER BY created_at DESC/);
  assert.doesNotMatch(recruitmentRoute, /FROM hr_recruitment_requisitions WHERE status IN \('OPEN','DRAFT','SUBMITTED'\)/);
  // 공고가 종료·충원되어도 이미 붙어 있던 지원자는 계속 고칠 수 있어야 한다.
  assert.match(recruitmentRoute, /linked\?\.requisition_id !== requisitionId/);
  assert.match(workspace, /const OPEN_REQUISITION_STATUSES = \["OPEN", "DRAFT", "SUBMITTED"\];/);
  assert.match(workspace, /function RequisitionCell\(\{ requisition, applicant, requisitions, onChange \}/);
  assert.match(workspace, /requisitions\.filter\(\(item\) => item\.status === "OPEN"\)/);
  assert.match(workspace, /requisitions\.filter\(\(item\) => item\.status === "OPEN" \|\| item\.id === applicant\.requisitionId\)/);
  assert.match(styles, /\.applicant-to-closed \{/);

  // 이력서 분석은 Claude CLI 하나만 쓴다. Worker 는 프로세스를 못 띄우므로 로컬 다리를 거친다.
  const resumeRoute = await read("app/api/hr/resume-analysis/route.ts");
  assert.match(resumeRoute, /CLAUDE_BRIDGE_URL\?: string;/);
  assert.match(resumeRoute, /function runClaude\(/);
  assert.match(resumeRoute, /provider: "claude"/);
  assert.doesNotMatch(resumeRoute, /CLOUDFLARE_ACCOUNT_ID|LOCAL_LLM_BASE_URL|runCloudflare|runLocal/);
  // 다리는 sonnet + effort high 로 돌고, 셸 없이 띄워야 시스템 프롬프트가 잘리지 않는다.
  const bridge = await read("scripts/claude-resume-bridge.mjs");
  assert.match(bridge, /XD_NODE_CLAUDE_MODEL \|\| "sonnet"/);
  assert.match(bridge, /XD_NODE_CLAUDE_EFFORT \|\| "medium"/);
  assert.match(bridge, /"--model", MODEL,/);
  assert.match(bridge, /"--effort", EFFORT,/);
  // 경력란은 "· 회사명(소속 및 직급): 재직기간 / 업무내용" 꼴로 조립한다.
  // 통 문장으로 받으면 형식이 매번 달라져 항목을 나눠 받는다.
  assert.match(resumeRoute, /type CareerEntry = \{/);
  assert.match(resumeRoute, /careerHistory: careerEntries\(parsed\.careerHistory\)/);
  assert.match(resumeRoute, /required: \["company", "affiliation", "period", "summary"\]/);
  assert.match(workspace, /item\.affiliation\.trim\(\) \? `\(\$\{item\.affiliation\.trim\(\)\}\)` : ""/);
  assert.match(workspace, /function formatCareerHistory\(entries: ResumeAnalysis\["careerHistory"\]\)/);
  assert.match(workspace, /`    ·  \$\{item\.summary\.trim\(\)\}`/);
  // 최초 등록에서도 이력서를 올리면 경력란까지 함께 채워진다. 로컬 AI 재분석은 Claude 재분석으로 바뀌었다.
  assert.match(workspace, /careerSummary: formatCareerHistory\(analysis\.careerHistory \?\? \[\]\) \|\| current\.careerSummary,/);
  assert.match(workspace, /async function reanalyzeResume\(\)/);
  // 등록 폼의 제출 버튼. 3열 2행으로 바꾸면서 한 번 지워졌던 자리라 테스트로 못 박는다.
  assert.match(workspace, /<button type="submit" className="primary-button">지원자 등록<\/button>/);
  assert.doesNotMatch(workspace, /localAiAvailable|reanalyzeWithLocal|Workers AI/);
  assert.doesNotMatch(bridge, /shell: process\.platform/);
  // ERP 서버를 켜면 다리도 같이 뜬다.
  const launcher = await read("scripts/Start-XDNodeERP.ps1");
  assert.match(launcher, /\$ResumeBridgePort = 3120/);
  assert.match(launcher, /npm\.cmd run resume:bridge/);

  // HR·임금계산 어시스턴트는 Claude CLI 로 돈다. Codex 의 --output-schema 가 없으므로
  // 다리가 응답을 직접 검증해야 한다 — 변경안이 실제 ERP 를 바꾸기 때문이다.
  const assistantBridge = await read("scripts/claude-assistant-bridge.mjs");
  assert.match(assistantBridge, /function validate\(value, schema, path = ""\)/);
  assert.match(assistantBridge, /Codex 의 --output-schema 를 대신하는 검증/);
  assert.match(assistantBridge, /const errors = validate\(parsed, schema\);/);
  // 프롬프트 규칙은 Codex 다리 원본을 그대로 가져다 쓴다(지시가 두 벌로 갈라지지 않게).
  assert.match(assistantBridge, /async function loadBuildPrompt\(\)/);
  assert.match(assistantBridge, /줄바꿈이 LF 든 CRLF 든 같게 다룬다/);
  assert.doesNotMatch(assistantBridge, /shell: true/);
  // 면접 질문은 nextSteps 가 아니라 전용 배열에 담는다.
  const responseSchema = await read("scripts/codex-assistant-response-schema.json");
  assert.match(responseSchema, /"interviewQuestions"/);
  assert.match(responseSchema, /"RESUME_CHECK"/);
  assert.match(responseSchema, /"BUSINESS_SCENARIO"/);
  const codexBridge = await read("scripts/codex-assistant-bridge.mjs");
  assert.match(codexBridge, /맞춤 면접 질문은 answer 나 nextSteps 가 아니라 interviewQuestions 배열에만 담으세요/);
  const assistantUi = await read("app/local-codex-assistant.tsx");
  assert.match(assistantUi, /fetch\(assistantEndpoint, \{/);
  assert.doesNotMatch(assistantUi, /const bridgeUrl = /);
  // 서버 라우트가 다리를 대신 부른다 — 권한 검사와 감사 기록을 다른 라우트와 같은 규약으로 거친다.
  const assistantRoute = await read("app/api/assistant/route.ts");
  assert.match(assistantRoute, /authorizeErpRequest\(bindings\.DB, MODULE_PERMISSION\[module\], "read"\)/);
  assert.match(assistantRoute, /compensation: "hr",/);
  assert.match(assistantRoute, /action: "ASSISTANT_ASKED"/);
  // 질문 본문·첨부 자료는 감사 로그에 남기지 않는다.
  assert.match(assistantRoute, /questionLength: question\.length/);
  assert.doesNotMatch(assistantRoute, /after: \{[^}]*\bquestion,/);
  // 다리는 계속 로컬 전용이다. 다른 기기에 여는 대신 서버가 대신 부른다.
  assert.match(assistantBridge, /const HOST = "127\.0\.0\.1"/);
  assert.match(assistantUi, /interviewCategoryOrder/);
  assert.doesNotMatch(assistantUi, /"Codex가 검토 중…"/);
  assert.match(launcher, /npm\.cmd run assistant:claude/);
  assert.match(responseSchema, /"COUNTER_FIT"/);
  assert.match(codexBridge, /COUNTER_FIT 2개를 더해 전체 13개 안팎/);
  assert.match(codexBridge, /roleFocus 에 없는 직무이면 질문을 지어내지 말고/);
});

test("employee lifecycle opens each retirement in its own modal beside the onboarding table", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/hr-workspace.tsx"),
    read("public/hr-workspace.css"),
  ]);
  assert.match(workspace, /className="lifecycle-board"/);
  assert.match(workspace, /id="onboarding-heading">입사 관리/);
  assert.match(workspace, /id="offboarding-heading">퇴직자 관리/);
  // 퇴직 절차는 목록 안에서 펼치지 않고 한 명씩 모달로 연다.
  assert.match(workspace, /const \[openRetirementId, setOpenRetirementId\] = useState\(""\)/);
  assert.match(workspace, /onClick=\{\(\) => setOpenRetirementId\(request\.id\)\}/);
  assert.match(workspace, /function RetirementProcessModal\(/);
  assert.match(workspace, /className=\{`employee-modal retirement-process-modal\$\{condensed \? " condensed" : ""\}`\}/);
  assert.match(workspace, /role="dialog"\s+aria-modal="true"/);
  // 팝업 규칙 세 가지(곡률 9px, 안쪽 왼편 스크롤 막대, 접히는 제목줄)를 이 팝업도 따른다.
  assert.match(styles, /\.retirement-process-modal \{[^}]*border-radius: 9px;[^}]*direction: rtl;/);
  assert.match(styles, /\.retirement-process-modal\.condensed \.modal-header \{ min-height: 46px;/);
  // 접히면 위쪽 내용이 46px 줄어 스크롤 앵커링이 기준선을 되넘나들며 깜빡였다.
  // 앵커링을 끄고 접힘/펼침 기준을 벌려 둔 것을 함께 지킨다.
  assert.match(styles, /\.payroll-record-modal \{ overflow-anchor: none; \}/);
  assert.match(workspace, /function nextCondensed\(current: boolean, scrollTop: number\) \{\s*return current \? scrollTop > 8 : scrollTop > 56;/);
  // 급여자료에 손으로 적어 둔 퇴직금은 추정치와 나란히 보이고, 덮어쓰기 전에 확인을 받아야 한다.
  assert.match(workspace, /기입력된 퇴직금 금액/);
  assert.match(workspace, /estimate\.recordedSeverance > 0 && <tr className="recorded">/);
  assert.match(workspace, /기 입력된 값이 있습니다\. 덮어 쓰겠습니까\?/);
  assert.match(workspace, /function applyEstimate\(estimate: SeveranceEstimate\)/);
  // 임금안 반영은 사람이 눌렀을 때만, 초안 상태에서만, 감사기록과 함께 이루어져야 한다.
  assert.match(workspace, /resource: "severanceToPayroll"/);
  const operations = await read("app/api/hr/operations/route.ts");
  assert.match(operations, /resource === "severanceToPayroll"/);
  assert.match(operations, /run\.status !== "DRAFT"/);
  assert.match(operations, /급여 월이 비어 있습니다\. 해당 급여월은 만들어 주세요/);
  assert.match(operations, /action: "SEVERANCE_APPLIED_TO_PAYROLL"/);
  // 급여기록은 임금계산 확정 때만 다시 만들어지므로 여기서 직접 쓰면 안 된다.
  assert.doesNotMatch(operations, /UPDATE hr_payroll_records|INSERT INTO hr_payroll_records/);
  // 체크와 정산 입력이 모두 모달 안에서 이루어져야 한다.
  assert.match(workspace, /className="retirement-modal-checklist"/);
  assert.match(workspace, /<RetirementSettlementPanel requestId=\{request\.id\} \/>/);
  assert.doesNotMatch(workspace, /expandedCards|toggleCard\(/);
  assert.match(styles, /\.retirement-process-modal \{[^}]*max-height: 92vh/);
  assert.match(styles, /\.lifecycle-board \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 900px\) \{ \.lifecycle-board \{ grid-template-columns: 1fr;/);
});

test("finance controls distinguish imported bank rows from automated forecasts", async () => {
  const [api, view] = await Promise.all([
    read("app/api/finance/operations/route.ts"),
    read("app/finance-operations-center.tsx"),
  ]);
  assert.match(api, /bankTransactionLines: \(bankTransactionCount\?\.count \?\? 0\) > 0 \? "IMPORTED" : "NOT_CONNECTED"/);
  assert.match(api, /forecast: "AUTOMATED"/);
  assert.match(view, /자동 원장은 좌측 ‘13주 자금예측’에서 계산됩니다/);
  assert.match(view, /좌측 ‘자금 대사’에서 자동 후보를 검토/);
});

test("13-week cash forecast de-duplicates ledgers, exposes data quality and persists daily scenarios", async () => {
  const [api, workspace, operations, schema, migration, page] = await Promise.all([
    read("app/api/finance/forecast/route.ts"), read("app/cash-forecast-workspace.tsx"),
    read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0020_careless_goliath.sql"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /expense\.source_type = 'PURCHASE_INVOICE' AND expense\.source_id = invoice\.id/);
  // 미수잔액은 receivables/route.ts와 같은 정의(확정 수금만 차감)를 써야 한다 — DRAFT/SUBMITTED
  // 수금까지 차감하면 미수잔액이 과소계상되어 자금예측이 낙관적으로 왜곡된다.
  assert.match(api, /payment\.status IN \('ACCEPTED','COMPLETED'\)\), 0\) AS outstanding_amount/);
  assert.doesNotMatch(api, /payment\.status <> 'CANCELLED'/);
  assert.match(api, /FALLBACK_REQUEST_DATE/);
  assert.match(api, /fallbackDateCount: fallbackDateItems\.length/);
  assert.match(api, /scenario === "CONSERVATIVE"/);
  assert.match(api, /scenario === "OPTIMISTIC"/);
  assert.match(api, /ON CONFLICT\(as_of, scenario\) DO UPDATE/);
  assert.match(workspace, /주차 근거 원장/);
  assert.match(workspace, /요청일 대체/);
  assert.match(workspace, /최소운영자금/);
  assert.match(operations, /id: "cash-forecast-risk"/);
  assert.match(operations, /destination: "finance:forecast"/);
  assert.match(schema, /financeCashForecastSettings/);
  assert.match(schema, /financeCashForecastSnapshots/);
  assert.match(migration, /idx_finance_cash_forecast_snapshot_asof_scenario/);
});

test("sales incentives require triple validation, collected cash, staged review and one payroll application", async () => {
  const [api, governance, engine, documents, operations, migration, schema] = await Promise.all([
    read("app/api/sales/route.ts"),
    read("app/incentive-governance.tsx"), read("app/approval-engine.ts"), read("app/api/documents/route.ts"),
    read("app/api/operations/route.ts"), read("drizzle/0033_incentive_governance.sql"), read("db/schema.ts"),
  ]);
  assert.match(api, /status === "ACTIVE"/);
  assert.match(api, /"UNVERIFIED"/);
  const control = await read("app/api/sales/incentives/route.ts");
  assert.match(control, /requiredValidations = \["POLICY", "EXAMPLE", "HISTORICAL"\]/);
  assert.match(control, /recognitionBasis: "CUMULATIVE_COLLECTED_PAYMENT_TRUE_UP"/);
  assert.match(control, /PROJECT_ALLOCATED_ACTUAL_COST_WITH_DRAFT_FALLBACK/);
  assert.match(control, /costQuality: hasActualCost \? "ACTUAL_PROJECT_COST" : "EXPECTED_COST_FALLBACK"/);
  assert.match(control, /prior\.status IN \('APPROVED','PAYROLL_APPLIED'\)/);
  assert.match(control, /unresolved_prior_count/);
  assert.match(control, /clawbackCandidate: Math\.min\(0, settlementDifference\)/);
  assert.match(control, /cost_allocation_updated_at/);
  assert.match(control, /action === "VOID_RESULT"/);
  assert.match(control, /payment\.status IN \('ACCEPTED','COMPLETED'\)/);
  assert.match(control, /status = 'SALES_CONFIRMED'/);
  assert.match(control, /status = 'FINANCE_REVIEWED'/);
  assert.match(control, /targetEntityType: "INCENTIVE_RULE"/);
  assert.match(control, /targetEntityType: "INCENTIVE_RESULT"/);
  assert.match(control, /status !== "DRAFT"/);
  assert.match(control, /idx_sales_incentive_payroll_result/);
  assert.match(engine, /INCENTIVE_RULE/); assert.match(engine, /INCENTIVE_RESULT/);
  assert.doesNotMatch(documents, /salesIncentiveRule|인센티브 근거문서/);
  assert.match(operations, /incentive-governance-risk/);
  assert.match(operations, /fallback_cost_count/);
  assert.match(operations, /clawback_count/);
  assert.match(governance, /자동 확정 없음 · 3회 교차검증/);
  assert.match(governance, /누적 확정 수금액/);
  assert.match(governance, /예상원가 대체 · 승인 불가/);
  const close = await read("app/api/finance/close/route.ts");
  assert.match(close, /INCENTIVE_SETTLEMENT_CONTROL/);
  assert.match(close, /missing_result_count/);
  for (const table of ["sales_incentive_validations", "sales_incentive_notes", "sales_incentive_payroll_links"]) {
    assert.match(migration, new RegExp(table)); assert.match(schema, new RegExp(table));
  }
});

test("runtime API column names stay aligned with the Drizzle production schema", async () => {
  const [schema, hrOperations, salesApi] = await Promise.all([
    read("db/schema.ts"),
    read("app/api/hr/operations/route.ts"),
    read("app/api/sales/route.ts"),
  ]);
  for (const column of ["before_json", "after_json", "task_group", "owner_employee_id", "due_date"]) {
    assert.match(hrOperations, new RegExp(column));
  }
  assert.doesNotMatch(hrOperations, /from_department|event_date|owner_type|evidence_document_id/);
  assert.match(schema, /rulesJson: text\("rules_json"\)/);
  assert.match(salesApi, /rules_json/);
  assert.doesNotMatch(salesApi, /\brule_json\b/);
});

test("leave and attendance workflows persist real manual records and decide legacy requests directly", async () => {
  const [api, view, transitions] = await Promise.all([
    read("app/api/hr/operations/route.ts"),
    read("app/hr-workspace.tsx"),
    read("app/hr-transitions.ts"),
  ]);
  assert.match(api, /resource === "leaveRequest"/);
  // R1(D2-a): 휴가 신청은 결재 없이 APPROVED 로 등록되고, 결재 테이블을 직접 읽거나 쓰지 않는다.
  assert.doesNotMatch(api, /createApprovalRequest|approval-engine|erp_approval_|erp_tasks/);
  assert.match(api, /insertApprovedLeaveRequest\(db/);
  assert.match(transitions, /export function insertApprovedLeaveRequest/);
  assert.match(api, /LEAVE_REQUEST_APPROVED/);
  // 결재 시절에 PENDING 으로 남은 신청은 화면의 승인/반려 버튼(decide)으로 처리한다.
  assert.match(view, /decide\("leaveRequest", item\.id, "APPROVED"\)/);
  assert.doesNotMatch(view, /상단 전자결재에서 처리/);
  // 체크리스트·입사 과제만 write. 정산 금액 확정과 임금안 반영(severanceToPayroll)은 돈이 움직이므로 approve 권한이다(2026-09-21 점검 후 상향).
  assert.match(api, /\["retirementChecklist", "lifecycleTask"\]\.includes\(resource\) \? "write" : "approve"/);
  assert.match(api, /'RECORDED', 'MANUAL'/);
  assert.match(view, /자동연동 전까지 자료 출처는 수기 입력/);
  assert.match(view, /Math\.round\(Number\(leaveDraft\.units\) \* 100\)/);
});

test("post-approval finance and HR workflows require explicit controls before completion", async () => {
  const [finance, recruitment, hr, onboarding, workspace, migration] = await Promise.all([
    read("app/api/finance/operations/route.ts"), read("app/api/hr/recruitment/route.ts"),
    read("app/api/hr/operations/route.ts"), read("app/hr-onboarding.ts"),
    read("app/hr-workspace.tsx"), read("drizzle/0015_redundant_aqueduct.sql"),
  ]);
  assert.match(finance, /action === "CREATE_JOURNAL"/);
  assert.match(finance, /resource === "journal"/);
  assert.match(finance, /debit_account_name === before\.credit_account_name/);
  assert.match(recruitment, /resource === "offerResponse"/);
  assert.match(recruitment, /'ONBOARDING'/);
  assert.match(recruitment, /status = 'ACCEPTED'/);
  assert.match(onboarding, /status = '입사 예정'/);
  assert.match(onboarding, /ONBOARDING_EFFECTIVE/);
  assert.match(hr, /resource === "retirementSettlement"/);
  assert.match(hr, /settlement\?\.status !== "READY"/);
  // 처우 제안 단계는 별도 박스다. 제안 → 수락/거절 순서이고, 수락은 최종 처우 팝업에서 확정한다.
  assert.match(workspace, /처우 제안 단계/);
  assert.match(workspace, /최종 처우 확정/);
  assert.match(workspace, /제안 거절 기록/);
  assert.match(workspace, /퇴직 정산·회수 통제/);
  for (const table of ["finance_journal_entries", "hr_retirement_settlements"]) assert.match(migration, new RegExp(table));
});

test("payroll close stays inside HR and legacy finance-locked months cannot be reopened", async () => {
  const [payroll, finance, view, schema, migration, workspace] = await Promise.all([
    read("app/api/hr/payroll/route.ts"), read("app/api/finance/operations/route.ts"),
    read("app/finance-operations-center.tsx"), read("db/schema.ts"),
    read("drizzle/0016_wild_black_tarantula.sql"), read("app/hr-workspace.tsx"),
  ]);
  // R1(D2-b, Design §12.3): 급여↔재무 연결 3곳을 끊는다. ensureSchema·LOCKED·재오픈 어디에도 재무 표가 없다.
  assert.doesNotMatch(payroll, /finance_expense_requests|finance_project_allocations|module: "finance"|payroll:\$\{period\}/);
  assert.doesNotMatch(payroll, /createApprovalRequest|approval-engine|erp_approval_/);
  assert.match(payroll, /export const LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS: readonly string\[\] = \[\]/);
  assert.match(payroll, /code: "LEGACY_PERIOD_LOCKED"/);
  assert.match(payroll, /payrollRunTransition\(db/);
  assert.match(payroll, /PAYROLL_RUN_LOCKED/);
  assert.match(payroll, /PAYROLL_RUN_REOPENED/);
  assert.match(payroll, /allowedTransitions/);
  assert.doesNotMatch(workspace, /financeExpenseId|재무회계 지급대기 원장/);
  assert.match(finance, /source_type/);
  assert.match(view, /급여 마감 자동연결/);
  for (const field of ["sourceType", "sourceId"]) assert.match(schema, new RegExp(field));
  for (const column of ["source_type", "source_id"]) assert.match(migration, new RegExp(column));
});

test("employee documents are versioned, audited, downloadable and recoverably deleted", async () => {
  const api = await read("app/api/documents/route.ts");
  assert.match(api, /SELECT MAX\(version\) AS version/);
  assert.match(api, /DOCUMENT_UPLOADED/);
  assert.match(api, /downloadId/);
  assert.match(api, /DOCUMENT_DOWNLOADED/);
  assert.match(api, /UPDATE erp_documents SET deleted_at/);
  assert.match(api, /원본 파일은 복구를 위해 보존/);
  assert.doesNotMatch(api, /HR_AUDIO\.delete\(row\.storage_key\)/);
});

test("sales quote-to-cash documents support versioning and approval gates", async () => {
  const [api, view] = await Promise.all([
    read("app/api/sales/route.ts"),
    read("app/sales-workspace.tsx"),
  ]);
  for (const type of ["QUOTE", "ORDER", "DELIVERY", "INVOICE", "PAYMENT"]) assert.match(api, new RegExp(`"${type}"`));
  assert.match(api, /SELECT MAX\(version\) AS version FROM sales_documents/);
  assert.match(api, /status === "ACCEPTED"/);
  assert.match(api, /createApprovalRequest/);
  assert.match(api, /targetEntityType: "SALES_DOCUMENT"/);
  assert.match(view, /견적·수주·납품·청구·수금/);
});

test("sales collections explicitly allocate to an approved invoice and reserve its remaining balance", async () => {
  const [api, view, schema, migration] = await Promise.all([
    read("app/api/sales/route.ts"), read("app/sales-workspace.tsx"), read("db/schema.ts"),
    read("drizzle/0017_workable_lady_deathstrike.sql"),
  ]);
  assert.match(api, /sales_payment_allocations/);
  assert.match(api, /invoiceDocumentId/);
  assert.match(api, /payment\.status <> 'CANCELLED'/);
  assert.match(api, /CASE WHEN payment\.id IS NOT NULL/);
  assert.match(api, /역수금·환불 절차가 필요합니다/);
  assert.match(view, /대상 청구서/);
  assert.match(view, /현재 미수금/);
  assert.match(view, /수금 예약/);
  assert.match(schema, /salesPaymentAllocations/);
  assert.match(migration, /idx_sales_payment_allocation_payment/);
});

test("purchase-to-pay requires an approved order, accepted receipt and matched invoice before payment", async () => {
  const [api, view, approval, approvalCenter, finance, operations, schema, migration, page] = await Promise.all([
    read("app/api/finance/purchasing/route.ts"), read("app/purchasing-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/approval-center.tsx"), read("app/api/finance/operations/route.ts"), read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0018_confused_thanos.sql"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_purchase_vendors", "finance_purchase_orders", "finance_purchase_order_lines", "finance_purchase_receipts", "finance_purchase_receipt_lines", "finance_purchase_invoices"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp(table));
  }
  assert.match(api, /requestType: "PURCHASE_ORDER"/);
  assert.match(api, /status IN \('APPROVED','PARTIALLY_RECEIVED'\)/);
  assert.match(api, /검수 잔액/);
  assert.match(api, /status = 'PAYMENT_READY'/);
  assert.match(api, /'PURCHASE_INVOICE'/);
  assert.match(approval, /targetEntityType === "PURCHASE_ORDER"/);
  assert.match(approvalCenter, /PURCHASE_ORDER: "발주 승인"/);
  assert.match(finance, /finance_purchase_invoices SET status = 'PAID'/);
  assert.match(operations, /purchase-match-exceptions/);
  assert.match(view, /발주·입고 현황/);
  assert.match(view, /매입채무·지급 연결/);
});

test("cash reconciliation imports real Clobe transaction IDs and keeps confirmation human-controlled", async () => {
  const [api, workspace, page, closeApi, schema, seed] = await Promise.all([
    read("app/api/finance/reconciliation/route.ts"), read("app/cash-reconciliation-workspace.tsx"),
    read("app/page.tsx"), read("app/api/finance/close/route.ts"), read("db/schema.ts"),
    read("app/finance-bank-transactions.ts"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /finance_bank_transactions/);
  assert.match(api, /finance_cash_matches/);
  assert.match(api, /SUGGESTED_CONFIRMED/);
  assert.match(api, /requestedAmount > remaining \|\| requestedAmount > sourceRemaining/);
  assert.match(api, /action === "REVERSE"/);
  assert.match(workspace, /후보는 자동 제시하되 확정은 사용자가 수행합니다/);
  assert.match(workspace, /부분 배분/);
  assert.match(closeApi, /match_row\.status = 'CONFIRMED'/);
  assert.match(closeApi, /미대사.*건/);
  assert.match(schema, /idx_finance_cash_match_unique_source/);
  assert.equal((seed.match(/"transactionId"/g) ?? []).length, 155);
  assert.doesNotMatch(seed, /accountNumber/);
});

test("system tasks are generated from live workflow state instead of static counts", async () => {
  const api = await read("app/api/operations/route.ts");
  assert.match(api, /TRIM\(owner_id\) = ''/);
  assert.match(api, /updated_at < \?/);
  assert.match(api, /status !== "LOCKED"/);
  assert.match(api, /differenceKrw !== 0/);
  assert.match(api, /closeRuleTask/);
});

test("same-day Clobe corrections refresh sync metrics and reopen changed journal alerts", async () => {
  const api = await read("app/api/operations/route.ts");
  assert.match(api, /ON CONFLICT\(id\) DO UPDATE SET snapshot_date = excluded\.snapshot_date/);
  assert.match(api, /record_count = excluded\.record_count/);
  assert.match(api, /metrics_json = excluded\.metrics_json/);
  assert.match(api, /`\$\{syncId\}:\$\{financeCurrentData\.journalSummary\.differenceKrw\}`/);
  assert.match(api, /erp_tasks\.source_id <> excluded\.source_id[\s\S]*THEN 'OPEN'/);
});

test("month-end close freezes automatic controls, evidence and a controlled reopen trail", async () => {
  const [api, workspace, engine, documents, operations, schema, migration, page] = await Promise.all([
    read("app/api/finance/close/route.ts"), read("app/finance-close-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/api/documents/route.ts"),
    read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0021_amusing_sway.sql"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /match_row\.status = 'CONFIRMED'/);
  assert.match(api, /journalSummary\.differenceKrw/);
  assert.match(api, /status <> 'POSTED'/);
  assert.match(api, /expense\.evidence_required = 1/);
  assert.match(api, /payroll\?\.status === "LOCKED"/);
  assert.match(api, /action === "SUBMIT_CLOSE"/);
  assert.match(api, /snapshot_json = \?/);
  assert.match(api, /targetEntityType: "FINANCE_CLOSE_RUN"/);
  assert.match(api, /action === "REQUEST_REOPEN"/);
  assert.match(api, /targetEntityType: "FINANCE_CLOSE_REOPEN"/);
  assert.match(engine, /targetEntityType === "FINANCE_CLOSE_RUN"/);
  assert.match(engine, /targetEntityType === "FINANCE_CLOSE_REOPEN"/);
  assert.doesNotMatch(documents, /financeCloseRun|finance_close_runs/);
  assert.match(operations, /month-close-controls/);
  assert.match(operations, /destination: "finance:close"/);
  assert.match(workspace, /월마감 통제센터/);
  assert.match(workspace, /마감 증빙/);
  assert.match(workspace, /재개방 결재 요청/);
  assert.match(schema, /financeCloseRuns/);
  assert.match(schema, /idx_finance_close_run_status_period/);
  assert.match(migration, /finance_close_runs/);
  assert.match(migration, /idx_finance_close_run_status_period/);
});

test("budget-versus-actual uses versioned plans, explicit sources and accountable variance actions", async () => {
  const [api, workspace, engine, operations, schema, migration, page] = await Promise.all([
    read("app/api/finance/budget/route.ts"), read("app/budget-actual-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0022_yellow_shadowcat.sql"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const source of ["SALES_INVOICE", "PURCHASE_INVOICE", "POSTED_JOURNAL_DEBIT", "POSTED_JOURNAL_CREDIT"]) assert.match(api, new RegExp(source));
  assert.match(api, /line\.department !== "전사"/);
  assert.match(api, /currentDay \/ daysInMonth/);
  assert.match(api, /line\.direction === "REVENUE"/);
  assert.match(api, /COUNT\(DISTINCT month\) AS month_count/);
  assert.match(api, /totals\.month_count !== 12/);
  assert.match(api, /actualSource === "SALES_INVOICE" && direction !== "REVENUE"/);
  assert.match(api, /action === "CREATE_REVISION"/);
  assert.match(api, /action === "SAVE_VARIANCE_ACTION"/);
  assert.match(api, /targetEntityType: "FINANCE_BUDGET_PLAN"/);
  assert.match(engine, /targetEntityType === "FINANCE_BUDGET_PLAN"/);
  assert.match(engine, /status = 'SUPERSEDED'/);
  assert.match(operations, /budget-variance-alert/);
  assert.match(operations, /destination: "finance:budget"/);
  assert.match(workspace, /예산·실적 관리/);
  assert.match(workspace, /매핑 필요/);
  assert.match(workspace, /차이 원인/);
  for (const table of ["financeBudgetPlans", "financeBudgetPlanLines", "financeBudgetVarianceActions"]) assert.match(schema, new RegExp(table));
  for (const table of ["finance_budget_plans", "finance_budget_plan_lines", "finance_budget_variance_actions"]) assert.match(migration, new RegExp(table));
  assert.match(migration, /idx_finance_budget_plan_year_version/);
  assert.match(migration, /idx_finance_budget_variance_line_unique/);
});

test("approval transitions require module approval rights and optimistic concurrency", async () => {
  const api = await read("app/api/approvals/route.ts");
  assert.match(api, /authorizeErpRequest\(db, before\.module as ErpModule, "approve"\)/);
  assert.match(api, /version = version \+ 1/);
  assert.match(api, /transition_token = \?/);
  assert.match(api, /WHERE id = \? AND version = \?/);
  assert.match(api, /다른 사용자가 먼저 처리했습니다/);
  assert.match(api, /REQUEST_CHANGES/);
  assert.match(api, /RESUBMIT/);
  assert.match(api, /comment\) return Response\.json/);
  assert.match(api, /targetEntityType: "", targetEntityId: ""/);
});

test("final approvals update linked HR, finance and sales records in the guarded batch", async () => {
  const [engine, approvalApi, hr, payroll, finance, closeApi, sales] = await Promise.all([
    read("app/approval-engine.ts"), read("app/api/approvals/route.ts"),
    read("app/api/hr/operations/route.ts"), read("app/api/hr/payroll/route.ts"),
    read("app/api/finance/operations/route.ts"), read("app/api/finance/close/route.ts"), read("app/api/sales/route.ts"),
  ]);
  for (const entity of ["HR_LEAVE", "HR_PERSONNEL_ACTION", "PAYROLL_RUN", "FINANCE_BUDGET", "FINANCE_BUDGET_PLAN", "FINANCE_CLOSE", "FINANCE_CLOSE_RUN", "FINANCE_CLOSE_REOPEN", "FINANCE_MANAGEMENT_REPORT", "SALES_DOCUMENT"]) assert.match(engine, new RegExp(entity));
  assert.match(approvalApi, /buildApprovalOutcomeStatements/);
  assert.match(engine, /transition_token = \?/);
  // R1(D2-a): HR 라우트는 엔진에 결재를 올리지 않는다. HR 부수효과는 app/hr-transitions.ts 로 옮겼다.
  for (const source of [hr, payroll]) assert.doesNotMatch(source, /requestType: "|createApprovalRequest|approval-engine/);
  assert.match(engine, /UPDATE hr_employee_records SET/);
  assert.match(engine, /history_json = json_insert/);
  assert.match(finance, /requestType: "BUDGET"/);
  assert.match(closeApi, /requestType: "CLOSE"/);
  assert.match(sales, /targetEntityType: "SALES_DOCUMENT"/);
});

test("approval center replaces fixed mock approvals with server-backed workflow history", async () => {
  const [page, center] = await Promise.all([read("app/page.tsx"), read("app/approval-center.tsx")]);
  // R1(r1-decouple): 상단 전자결재 센터는 마운트하지 않는다. 파일은 r1-delete 에서 지운다.
  assert.doesNotMatch(page, /<ApprovalCenter|from "\.\/approval-center"/);
  assert.doesNotMatch(page, /박서연 · 연차|이도윤 · 마이너스 연차|최유진 · 법인카드/);
  assert.match(center, /fetch\("\/api\/approvals"/);
  assert.match(center, /기안·검토·승인·반려/);
  assert.match(center, /보완 후 재제출/);
});

test("delegated approvals remain scoped to the assigned step and are visible in the route", async () => {
  const [api, engine, center] = await Promise.all([
    read("app/api/approvals/route.ts"), read("app/approval-engine.ts"), read("app/approval-center.tsx"),
  ]);
  assert.match(api, /actingAsDelegate/);
  assert.match(api, /step\.approver_employee_id === principal\.employeeId/);
  assert.match(api, /Boolean\(step\.delegated_from_employee_id\)/);
  assert.match(engine, /starts_on <= \?/);
  assert.match(engine, /ends_on >= \?/);
  assert.match(center, /delegatedFromEmployeeId/);
  assert.match(center, /대결/);
});

test("future personnel actions wait until their effective date and then apply once", async () => {
  const [engine, activator, records] = await Promise.all([
    read("app/approval-engine.ts"), read("app/hr-personnel-actions.ts"), read("app/api/hr/employee-records/route.ts"),
  ]);
  assert.match(engine, /effective_date FROM hr_personnel_actions/);
  assert.match(engine, /effective_date <= \?/);
  assert.match(activator, /WHERE status = 'APPROVED' AND effective_date <= \?/);
  assert.match(activator, /status = 'EFFECTIVE'/);
  assert.match(activator, /PERSONNEL_ACTION_EFFECTIVE/);
  assert.match(records, /applyDuePersonnelActions\(db\)/);
});

test("approval center reports overdue work without manufacturing a second task", async () => {
  const [api, center] = await Promise.all([read("app/api/approvals/route.ts"), read("app/approval-center.tsx")]);
  assert.match(api, /overdueMine/);
  assert.match(api, /item\.due_date < today/);
  assert.match(center, /기한 경과/);
  assert.match(center, /summary\.overdueMine/);
});

test("monthly management reporting freezes source lineage, quality gates, revisions and follow-up actions", async () => {
  const [api, workspace, schema, migration, page, engine, operations, plan] = await Promise.all([
    read("app/api/finance/management-report/route.ts"), read("app/management-report-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0023_management_reporting.sql"), read("app/page.tsx"),
    read("app/approval-engine.ts"), read("app/api/operations/route.ts"), read("docs/finance-management-report-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_management_reports", "finance_management_report_actions"]) {
    assert.match(migration, new RegExp(table));
    assert.match(api, new RegExp(table));
  }
  for (const model of ["financeManagementReports", "financeManagementReportActions"]) assert.match(schema, new RegExp(model));
  assert.match(api, /monthInvoiceSummary/);
  assert.match(api, /qualityWarnings/);
  assert.match(api, /requiresAcknowledgement/);
  assert.match(api, /report\.highlights === oldAuto\.highlights/);
  assert.match(api, /status IN \('DRAFT','SUBMITTED'\)/);
  assert.match(api, /CREATE_REVISION/);
  assert.match(api, /status <> 'DONE'/);
  assert.match(api, /requestType: "REPORT"/);
  assert.match(engine, /FINANCE_MANAGEMENT_REPORT/);
  assert.match(engine, /status = 'SUPERSEDED'/);
  assert.match(workspace, /공급가액 순차이/);
  assert.match(workspace, /보고 수치 원천 등록부/);
  assert.match(workspace, /품질경고/);
  assert.match(workspace, /window\.print/);
  assert.match(operations, /management-report-due/);
  assert.match(operations, /management-report-actions/);
  assert.match(plan, /제출 이후에는 수정하지 않는다/);
  assert.match(plan, /미연결/);
});

test("management reports govern structured decisions and convert approved outcomes into one action", async () => {
  const [api, workspace, schema, migration, engine, operations, plan] = await Promise.all([
    read("app/api/finance/management-report/route.ts"), read("app/management-report-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0037_management_decision_register.sql"), read("app/approval-engine.ts"),
    read("app/api/operations/route.ts"), read("docs/finance-management-decision-register-plan.md"),
  ]);
  for (const source of [api, schema, migration]) assert.match(source, /finance_management_decisions/);
  assert.match(migration, /idx_finance_management_action_decision/);
  assert.match(api, /ADD_DECISION/);
  assert.match(api, /RESOLVE_DECISION/);
  assert.match(api, /authorizeErpRequest\(db, "finance", "approve"\)/);
  assert.match(api, /status = 'PENDING'/);
  assert.match(api, /decision_id/);
  assert.match(api, /decisionOutcomes/);
  assert.match(api, /미결정 안건을 모두 승인·보류·반려한 뒤 보고서를 개정/);
  assert.match(engine, /finance_management_decisions SET status = 'DRAFT'/);
  assert.match(workspace, /<h2>경영 의사결정 안건<\/h2>/);
  assert.match(workspace, /후속조치 자동 생성/);
  assert.match(operations, /management-report-decisions/);
  assert.match(plan, /DRAFT → PENDING → APPROVED \| DEFERRED \| REJECTED/);
  assert.match(plan, /최대 한 건/);
});

test("management reports freeze posted profit comparisons and block submission on close ledger drift", async () => {
  const [api, workspace, ledger, integrity, plan] = await Promise.all([
    read("app/api/finance/management-report/route.ts"), read("app/management-report-workspace.tsx"),
    read("app/finance-ledger-snapshot.ts"), read("app/finance-ledger-integrity.ts"), read("docs/finance-management-statement-integration-plan.md"),
  ]);
  assert.match(ledger, /buildFinancePeriodStatementSnapshot/);assert.match(integrity, /evaluateLedgerSnapshotDrift/);
  assert.match(ledger, /status='POSTED'/);assert.match(ledger, /periodDebit === periodCredit/);
  assert.match(api, /currentStatement/);assert.match(api, /previousEqualLengthPeriod/);assert.match(api, /historicalCloseComparison/);
  assert.match(api, /CLOSE_LEDGER_DRIFT/);assert.match(api, /CLOSE_LEDGER_CHECK_FAILED/);assert.match(api, /blockingCount/);assert.match(api, /canSubmit: blockingCount === 0/);
  assert.match(api, /마감 원장 무결성 차단 항목을 해결/);
  assert.match(workspace, /전기 완료 손익과 비교/);assert.match(workspace, /2025 동일 완료월/);
  assert.match(workspace, /snapshot\.quality\.canSubmit === false/);assert.match(workspace, /이 저장본에는 전기 손익 비교가 포함되지 않았습니다/);
  assert.match(plan, /공급가액과 회계상 손익을 혼동하지 않고/);assert.match(plan, /부분월은 전년 수치를 일할 계산하지 않는다/);
  assert.match(plan, /서버와 화면 양쪽에서 결재 제출을 막는다/);
});

test("expense requests require evidence, approval and a unique payment ledger entry", async () => {
  const [schema, migration, api, view, engine] = await Promise.all([
    read("db/schema.ts"), read("drizzle/0014_talented_matthew_murdock.sql"),
    read("app/api/finance/operations/route.ts"), read("app/finance-operations-center.tsx"), read("app/approval-engine.ts"),
  ]);
  for (const table of ["finance_expense_requests", "finance_payment_ledger"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp(table));
  }
  assert.match(migration, /UNIQUE INDEX `idx_finance_payment_request_unique`/);
  assert.match(api, /evidence_count < 1/);
  assert.match(api, /before\.status !== "APPROVED"/);
  assert.match(api, /journal_status = 'READY'/);
  assert.match(api, /targetEntityType: "FINANCE_EXPENSE"/);
  assert.match(engine, /targetEntityType === "FINANCE_EXPENSE"/);
  assert.match(view, /증빙을 첨부한 뒤 결재를 제출/);
});

test("direct retirement approval activates a durable checklist and applies the due retirement once", async () => {
  const [migration, api, activator, records, workspace] = await Promise.all([
    read("drizzle/0014_talented_matthew_murdock.sql"), read("app/api/hr/operations/route.ts"),
    read("app/hr-retirements.ts"),
    read("app/api/hr/employee-records/route.ts"), read("app/hr-workspace.tsx"),
  ]);
  assert.match(migration, /hr_retirement_requests/);
  // R1(D2-a): 퇴직 요청은 결재 없이 곧바로 IN_PROGRESS 로 등록되고, 정산 초안·인사기록 상태를 같은 batch 에서 반영한다.
  const transitions = await read("app/hr-transitions.ts");
  assert.match(api, /startRetirementStatements\(db/);
  assert.match(api, /action: "RETIREMENT_APPROVED"/);
  assert.doesNotMatch(api, /requestType: "RETIREMENT"|targetEntityType: "HR_RETIREMENT"|RETIREMENT_SUBMITTED/);
  assert.match(transitions, /VALUES \(\?, \?, \?, \?, 'IN_PROGRESS'/);
  assert.match(transitions, /INSERT OR IGNORE INTO hr_retirement_settlements/);
  assert.doesNotMatch(transitions, /결재 승인/);
  // 결재 시절에 SUBMITTED 로 남은 퇴직 요청은 승인·반려 버튼으로 빠져나온다.
  assert.match(api, /resource === "retirementDecision"/);
  assert.match(workspace, /onLegacyDecision\("APPROVED"\)/);
  assert.match(api, /resource === "retirementChecklist"/);
  assert.match(activator, /WHERE retirement_date <= \? AND \(status IN \('IN_PROGRESS', 'READY'\) OR \(status = 'EFFECTIVE'/);
  assert.match(activator, /"COMPLETED" : "EFFECTIVE"/);
  assert.match(activator, /RETIREMENT_EFFECTIVE/);
  assert.match(records, /applyDueRetirements\(db\)/);
  assert.match(workspace, /작성한 내용을 확인 후 퇴직 버튼을 클릭해 주세요/);
  assert.match(workspace, />퇴직<\/button>/);
  assert.doesNotMatch(workspace, /const nextEmployee: Employee = \{[\s\S]*?status: "퇴직 예정"/);
});

test("recruitment offers move directly into the onboarding lifecycle", async () => {
  const [migration, api, workspace] = await Promise.all([
    read("drizzle/0014_talented_matthew_murdock.sql"), read("app/api/hr/recruitment/route.ts"),
    read("app/hr-workspace.tsx"),
  ]);
  assert.match(migration, /hr_offer_requests/);
  assert.match(api, /resource === "offer"/);
  assert.match(api, /'APPROVED'/);
  assert.match(api, /\["onboardingUpdate", "onboardingComplete", "onboardingCancel"\]\.includes\(resource\)/);
  assert.match(api, /resource === "onboardingCancel"/);
  assert.doesNotMatch(api, /requestType: "OFFER"/);
  // 처우 제안 단계는 별도 박스다. 제안 → 수락/거절 순서이고, 수락은 최종 처우 팝업에서 확정한다.
  assert.match(workspace, /처우 제안 단계/);
  assert.match(workspace, /최종 처우 확정/);
  assert.match(workspace, /제안 거절 기록/);
  assert.match(workspace, /입사 완료/);
  assert.match(workspace, /입사 정보 수정/);
});

test("debt management keeps Clobe balances immutable and routes schedules through controlled payments", async () => {
  const [migration, schema, api, workspace, forecast, close, operations, documents, page] = await Promise.all([
    read("drizzle/0032_debt_management.sql"), read("db/schema.ts"), read("app/api/finance/debt/route.ts"),
    read("app/debt-management-workspace.tsx"), read("app/api/finance/forecast/route.ts"),
    read("app/api/finance/close/route.ts"), read("app/api/operations/route.ts"),
    read("app/api/documents/route.ts"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_debt_facilities", "finance_debt_schedule_items", "finance_debt_covenant_reviews"]) {
    assert.match(migration, new RegExp(table));
    assert.match(schema, new RegExp(table));
  }
  assert.match(api, /financeCurrentData\.accounts\.filter\(\(account\) => account\.type === "LOAN"/);
  assert.match(api, /original_principal < account\.krwBalance/);
  assert.match(api, /category = '차입계약'/);
  assert.match(api, /source_type, source_id[\s\S]*'DEBT_SCHEDULE'/);
  assert.match(workspace, /자동 이자 계산 없음/);
  assert.match(workspace, /document\.category === "차입계약"/);
  assert.match(forecast, /DEBT_SCHEDULE/);
  assert.match(close, /DEBT_SCHEDULE_CONTROL/);
  assert.match(operations, /destination: "finance:debt"/);
  assert.doesNotMatch(documents, /financeDebtFacility|finance_debt_/);
});

test("financial system alerts require evidence, finance review and controlled closure", async () => {
  const [api, view, server, operations, documents, schema, migration, page, plan] = await Promise.all([
    read("app/api/finance/alert-actions/route.ts"), read("app/finance-alert-action-center.tsx"),
    read("app/finance-alert-actions-server.ts"), read("app/api/operations/route.ts"),
    read("app/api/documents/route.ts"), read("db/schema.ts"),
    read("drizzle/0036_finance_alert_actions.sql"), read("app/page.tsx"),
    read("docs/finance-alert-action-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const table of ["finance_alert_cases", "finance_alert_case_events"]) {
    assert.match(api, new RegExp(table));
    assert.match(migration, new RegExp(table));
  }
  for (const model of ["financeAlertCases", "financeAlertCaseEvents"]) assert.match(schema, new RegExp(model));
  assert.match(api, /authorizeErpRequest\(db, "finance", permission\)/);
  assert.match(api, /\["APPROVE", "REJECT", "REOPEN"\].*"approve"/);
  assert.match(api, /rootCause\.length < 5/);
  assert.match(api, /evidenceCount\(caseId\) < 1/);
  assert.match(api, /CLOSURE_APPROVED/);
  assert.match(api, /db\.batch\(\[/);
  assert.match(server, /status = 'CLOSED'/);
  assert.match(operations, /hasClosedFinanceAlertCase/);
  assert.match(operations, /중요 재무 경보는 조치계획·근거자료·재무 승인/);
  assert.doesNotMatch(documents, /financeAlertCase|finance-alert-actions-server/);
  assert.match(view, /재무 경보 조치센터/);
  assert.match(view, /증빙 확인·종료 검토 요청/);
  assert.match(plan, /OPEN → IN_PROGRESS → REVIEW → CLOSED/);
});

test("financial alert outcomes are frozen into treasury, management reporting and month close", async () => {
  const [reporting, model, treasuryApi, treasuryView, managementApi, managementView, closeApi, plan, page] = await Promise.all([
    read("app/finance-alert-reporting.ts"), read("app/finance-alert-reporting-model.ts"),
    read("app/api/finance/daily-treasury/route.ts"), read("app/daily-treasury-workspace.tsx"),
    read("app/api/finance/management-report/route.ts"), read("app/management-report-workspace.tsx"),
    read("app/api/finance/close/route.ts"), read("docs/finance-alert-reporting-integration-plan.md"), read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(reporting, /alert\.created_at <= \?/);
  assert.match(reporting, /document\.created_at <= \?/);
  assert.match(model, /CLOSURE_APPROVED: "CLOSED"/);
  assert.match(model, /CASE_REOPENED: "IN_PROGRESS"/);
  assert.match(model, /item\.dueDate < cutoffDate/);
  assert.match(treasuryApi, /buildFinanceAlertReportSnapshot\(db, reportDate\)/);
  assert.match(treasuryApi, /FINANCE_ALERT_ACTION/);
  assert.match(treasuryApi, /alertActions,/);
  assert.match(treasuryView, /재무 경보 조치현황/);
  assert.match(treasuryView, /snapshot\.alertActions \?\?/);
  assert.match(managementApi, /ALERT_ACTIONS_OPEN/);
  assert.match(managementApi, /ERP 재무 경보 조치원장/);
  assert.match(managementView, /<h2>재무 경보 조치현황<\/h2>/);
  assert.match(managementView, /snapshot\.sections\.alertActions \?\?/);
  assert.match(closeApi, /FINANCE_ALERT_ACTIONS/);
  assert.match(closeApi, /highCriticalUnresolvedCount > 0 \? "FAIL"/);
  assert.match(closeApi, /alertActions\.unresolvedCount > 0 \? "REVIEW"/);
  assert.match(plan, /현재 진행 중인 월은 미래 월말이 아니라 최신 재무 원천 기준일/);
});

test("personal workbench merges assigned sources without copying source status", async () => {
  const [api, view, schema, migration, page, plan] = await Promise.all([
    read("app/api/workbench/route.ts"), read("app/operations-workbench.tsx"), read("db/schema.ts"),
    read("drizzle/0038_personal_workbench.sql"), read("app/page.tsx"),
    read("docs/personal-operations-workbench-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /owner_employee_id = \?/);
  assert.match(api, /id NOT IN \('management-report-actions','management-report-decisions'\)/);
  assert.match(api, /finance_management_report_actions/);
  assert.match(api, /finance_management_decisions/);
  assert.match(api, /Date\.now\(\) \+ 9 \* 60 \* 60 \* 1000/);
  assert.match(api, /ON CONFLICT\(employee_id, item_type, item_id\)/);
  assert.match(api, /본인에게 배정된 업무만/);
  assert.match(api, /canWriteOperations/);
  assert.match(api, /canWriteFinance/);
  assert.doesNotMatch(migration, /\bstatus\b/i);
  assert.match(schema, /erpWorkbenchPreferences/);
  assert.match(view, /fetch\("\/api\/workbench"\)/);
  assert.match(view, /fetch\(isTask \? "\/api\/operations" : "\/api\/finance\/management-report"/);
  assert.match(view, /오늘의 업무/);
  assert.match(view, /경영 의사결정/);
  assert.match(plan, /상태의 진실은 각 원천 원장이 소유한다/);
  assert.match(plan, /다른 사용자가 읽거나 수정할 수 없게 한다/);
});

test("workforce planning versions approved headcount and derives actual staffing from HR sources", async () => {
  const [api, view, workspace, schema, migration, approval, plan, operations] = await Promise.all([
    read("app/api/hr/workforce-plans/route.ts"), read("app/workforce-planning-view.tsx"),
    read("app/hr-workspace.tsx"), read("db/schema.ts"), read("drizzle/0039_workforce_planning.sql"),
    read("app/approval-engine.ts"), read("docs/hr-workforce-planning-plan.md"), read("app/api/operations/route.ts"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "hr", "read"\)/);
  assert.match(api, /authorizeErpRequest\(db, "hr", "write"\)/);
  assert.match(api, /companyEmployees\.map/);
  assert.match(api, /employee\.status !== "퇴직" && employee\.status !== "입사 예정"/);
  assert.match(api, /employee\.status === "입사 예정"/);
  assert.match(api, /Math\.max\(0, approvedHeadcount - projected\)/);
  assert.match(api, /예상 가동 인원보다 정원이 적으면/);
  // R1(D2-a): 인력계획 승인은 결재 없이 곧바로 반영한다(SUPERSEDED 전환과 한 batch).
  assert.doesNotMatch(api, /requestType: "WORKFORCE_PLAN"|createApprovalRequest|approval-engine/);
  assert.match(api, /approveWorkforcePlanStatements\(db/);
  assert.match(api, /WORKFORCE_PLAN_APPROVED/);
  assert.match(api, /changedRows\(result, 1\) !== 1/);
  assert.match(view, /승인·확정/);
  assert.match(view, /지원자 수는 포함하지 않으며/);
  assert.match(view, /승인 정원/);
  assert.match(workspace, /<WorkforcePlanningView/);
  assert.match(schema, /hrWorkforcePlans/);
  assert.match(schema, /hrWorkforcePlanLines/);
  assert.match(migration, /idx_hr_workforce_plan_period_version/);
  assert.match(migration, /idx_hr_workforce_plan_line_org/);
  assert.match(approval, /WORKFORCE_PLAN: "인력계획 승인"/);
  assert.match(approval, /targetEntityType === "HR_WORKFORCE_PLAN"/);
  assert.match(approval, /status = 'SUPERSEDED'/);
  assert.match(operations, /workforce-gap-\$\{plan\.period\}/);
  assert.match(operations, /destination: "hr:workforce"/);
  assert.match(plan, /지원자 수는 채용 경쟁도이지 확보 인원이 아니므로/);
  assert.match(plan, /DRAFT → SUBMITTED → APPROVED/);
});

test("recruitment requisitions reserve approved gaps and link applicants through accepted offers", async () => {
  const [api, recruitment, view, workspace, schema, migration, approval, plan] = await Promise.all([
    read("app/api/hr/recruitment-requisitions/route.ts"), read("app/api/hr/recruitment/route.ts"),
    read("app/recruitment-requisition-view.tsx"), read("app/hr-workspace.tsx"), read("db/schema.ts"),
    read("drizzle/0040_recruitment_requisitions.sql"), read("app/approval-engine.ts"),
    read("docs/hr-recruitment-requisition-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "recruitment", "read"\)/);
  assert.match(api, /line\.approved_headcount - projected/);
  assert.match(api, /\["DRAFT", "SUBMITTED", "OPEN"\]/);
  assert.match(api, /availableHeadcount: Math\.max\(0, hiringGap - reserved\)/);
  // R1(D2-a): 모집 시작은 결재 없이 OPEN 으로 전이한다.
  assert.doesNotMatch(api, /requestType: "REQUISITION"|createApprovalRequest|willAutoApproveForSelf|approval-engine|erp_approval_|erp_tasks/);
  assert.match(api, /openRequisitionStatement\(db/);
  assert.match(api, /REQUISITION_OPENED/);
  assert.match(recruitment, /requisition_id/);
  assert.match(recruitment, /요청 인원이 이미 모두 충원되었습니다/);
  assert.match(recruitment, /status = 'FILLED'/);
  assert.match(view, /채용요청·TO 관리/);
  assert.match(view, /지원자 수는 충원 인원으로 계산하지 않습니다/);
  assert.match(workspace, /<RecruitmentRequisitionView/);
  assert.match(workspace, /채용요청·TO/);
  assert.match(schema, /hrRecruitmentRequisitions/);
  assert.match(migration, /ALTER TABLE `hr_applicants` ADD `requisition_id`/);
  assert.match(approval, /REQUISITION: "채용요청 승인"/);
  assert.match(approval, /targetEntityType === "HR_RECRUITMENT_REQUISITION"/);
  // Registering a requisition opens it straight away when the headcount check passes (the behavior
  // the single-admin office already saw), otherwise it stays a draft that 모집 시작 can open later.
  assert.match(api, /openRequisition\(authorization\.principal, created, fresh, now\)/);
  assert.match(view, /모집을 시작했습니다/);
  // 진행 중 요청 counts every live requisition, including teams with no workforce plan.
  assert.match(api, /reserved: requisitions\.filter/);
  // Removing a requisition must not orphan applicants or lose the record itself.
  assert.match(api, /action === "DELETE"/);
  assert.match(api, /COUNT\(\*\) AS count FROM hr_applicants WHERE requisition_id = \?/);
  assert.match(api, /연결된 지원자가/);
  assert.match(api, /db\.prepare\("DELETE FROM hr_recruitment_requisitions WHERE id = \?"\)/);
  assert.match(api, /action: "REQUISITION_DELETED"[\s\S]*?before: row/);
  assert.match(view, /className="delete-action"/);
  assert.match(plan, /지원자가 연결된 요청은 삭제하지 않고/);
  assert.match(plan, /추가 기안 가능 = 계획 부족 - 예약 TO/);
});

test("performance management separates goals, reviews, calibration, approval and appeals", async () => {
  const [api, view, workspace, schema, migration, approval, operations, plan] = await Promise.all([
    read("app/api/hr/performance/route.ts"), read("app/performance-management-view.tsx"),
    read("app/hr-workspace.tsx"), read("db/schema.ts"), read("drizzle/0041_performance_management.sql"),
    read("app/approval-engine.ts"), read("app/api/operations/route.ts"), read("docs/hr-performance-management-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "hr", "read"\)/);
  assert.match(api, /employee\.status !== "퇴직" && employee\.status !== "입사 예정"/);
  assert.match(api, /totals\?\.weight !== 100/);
  assert.match(api, /action === "DELETE_GOAL"/);
  assert.match(api, /!item\.manager_employee_id/);
  assert.match(api, /actual_value IS NULL OR length\(trim\(evidence\)\) < 5/);
  assert.match(api, /reviewerType === "SELF"/);
  assert.match(api, /reviewerType === "MANAGER"/);
  assert.match(api, /reviewerType === "CALIBRATION"/);
  assert.match(api, /14 \* 24 \* 60 \* 60 \* 1000/);
  // R1(D2-a): 최종 확정은 결재 없이 주기와 CALIBRATED 참여자를 한 batch 에서 FINALIZED 로 만든다.
  assert.doesNotMatch(api, /requestType: "PERFORMANCE_CYCLE"|createApprovalRequest|approval-engine/);
  assert.match(api, /finalizePerformanceCycleStatements\(db/);
  assert.match(api, /PERFORMANCE_CYCLE_FINALIZED/);
  // 이의제기 '수용'은 서버가 받는 RESOLVED 를 보낸다(기존 버그: ACCEPTED 를 보내 400).
  assert.match(view, /resolveAppeal\(appeal\.id, "RESOLVED"\)/);
  assert.doesNotMatch(view, /"ACCEPTED"/);
  assert.match(view, /평가 제출·잠금/);
  assert.match(view, /resolveAppeal/);
  assert.match(view, /급여·승진·강등에 자동 반영되지 않습니다/);
  assert.match(workspace, /<PerformanceManagementView/);
  assert.match(schema, /hrPerformanceCycles/);
  assert.match(schema, /hrPerformanceParticipants/);
  assert.match(schema, /hrPerformanceGoals/);
  assert.match(schema, /hrPerformanceReviews/);
  assert.match(schema, /hrPerformanceAppeals/);
  assert.match(migration, /idx_hr_performance_participant_cycle_employee/);
  assert.match(migration, /idx_hr_performance_review_participant_type/);
  assert.match(approval, /PERFORMANCE_CYCLE: "성과평가 최종확정"/);
  assert.match(approval, /targetEntityType === "HR_PERFORMANCE_CYCLE"/);
  assert.match(operations, /performance-cycle-\$\{cycle\.id\}/);
  assert.match(operations, /destination: "hr:performance"/);
  assert.match(plan, /급여·승진·강등에 자동 반영하지 않는다/);
});

test("training management snapshots employees and requires evidence for mandatory completion", async () => {
  const [api, view, workspace, schema, migration, operations, plan] = await Promise.all([
    read("app/api/hr/training/route.ts"), read("app/training-management-view.tsx"), read("app/hr-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0042_hr_training_management.sql"), read("app/api/operations/route.ts"),
    read("docs/hr-training-management-plan.md"),
  ]);
  assert.match(api, /employee\.status !== "퇴직" && employee\.status !== "입사 예정"/);
  assert.match(api, /ON CONFLICT\(course_id, employee_id\) DO NOTHING/);
  assert.match(api, /course\.course_type === "MANDATORY" && \(!evidenceName \|\| !evidenceRef\)/);
  assert.match(api, /action === "VERIFY_ASSIGNMENT"/);
  assert.match(api, /assignment\.status !== "SUBMITTED"/);
  assert.match(api, /status NOT IN \('COMPLETED', 'WAIVED'\)/);
  assert.match(api, /reason\.length < 10/);
  assert.match(view, /수료 증빙, 면제와 미이수 알림/);
  assert.match(view, /급여·평가·승진에 자동 반영되지 않습니다/);
  assert.match(workspace, /<TrainingManagementView/);
  assert.match(schema, /hrTrainingCourses/);
  assert.match(schema, /hrTrainingAssignments/);
  assert.match(migration, /idx_hr_training_assignment_course_employee/);
  assert.match(operations, /training-course-\$\{course\.id\}/);
  assert.match(operations, /destination: "hr:training"/);
  assert.match(plan, /법정교육은 증빙 없는 완료를 허용하지 않음/);
});

test("HR analytics aggregates ledgers without exposing employee identifiers", async () => {
  const [api, view, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/hr/analytics/route.ts"), read("app/hr-analytics-view.tsx"), read("app/hr-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0043_hr_analytics_reports.sql"), read("docs/hr-analytics-reporting-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "hr", "read"\)/);
  assert.match(api, /기간 중 퇴직자 ÷ 기간 시작·종료 평균 재직자/);
  assert.match(api, /c\.status = 'FINALIZED' AND p\.status = 'FINALIZED'/);
  assert.match(api, /item\.assignment_status === "SUBMITTED"/);
  assert.match(api, /if \(!canSensitive\) return Response\.json\(\{ error: "저장 리포트는 HR 관리자만 열 수 있습니다/);
  assert.match(api, /HR_ANALYTICS_REPORT_GENERATED/);
  assert.match(api, /COALESCE\(MAX\(version\), 0\) \+ 1/);
  assert.doesNotMatch(api, /employeeName.*csv|email.*csv|phone.*csv/i);
  assert.match(view, /개인 이름·사번·이메일·연락처·생년월일/);
  assert.match(view, /CSV 내보내기/);
  assert.match(workspace, /<HrAnalyticsView/);
  assert.match(schema, /hrAnalyticsReports/);
  assert.match(migration, /idx_hr_analytics_report_period_version/);
  assert.match(plan, /급여와 성과평가 집계는 HR 관리자 또는 최고관리자에게만 제공/);
});

test("sales CRM preserves customer activities and governs stage transitions", async () => {
  const [sales, crm, view, operations, schema, migration, plan] = await Promise.all([
    read("app/api/sales/route.ts"), read("app/api/sales/crm/route.ts"), read("app/sales-workspace.tsx"),
    read("app/api/operations/route.ts"), read("db/schema.ts"), read("drizzle/0044_sales_crm_governance.sql"),
    read("docs/sales-crm-governance-plan.md"),
  ]);
  assert.match(sales, /nextStage\[before\.stage\] !== stage/);
  assert.match(sales, /실주 사유를 10자 이상 입력해 주세요/);
  assert.match(sales, /document_type = 'ORDER' AND status IN \('ACCEPTED', 'COMPLETED'\)/);
  assert.match(sales, /OPPORTUNITY_STAGE_CHANGED/);
  assert.match(sales, /transition\[0\]\.meta\.changes/);
  assert.match(crm, /authorizeErpRequest\(db, "sales", "read"\)/);
  assert.match(crm, /authorizeErpRequest\(db, "sales", "write"\)/);
  assert.match(crm, /ACCOUNT_CONTACT_CREATED/);
  assert.match(crm, /OPPORTUNITY_ACTIVITY_RECORDED/);
  assert.match(crm, /WHERE id = \? AND account_id = \? AND status = 'ACTIVE'/);
  assert.match(view, /고객 담당자/);
  assert.match(view, /영업 활동 기록/);
  assert.match(view, /단계 변경 이력/);
  assert.match(operations, /sales-follow-up:\$\{opportunity\.id\}/);
  assert.match(operations, /destination: "sales:opportunity"/);
  assert.match(schema, /salesAccountContacts/);
  assert.match(schema, /salesOpportunityActivities/);
  assert.match(schema, /salesOpportunityStageHistory/);
  assert.match(migration, /idx_sales_contact_account_key/);
  assert.match(plan, /리드 → 요구 확인 → 제안 → 계약 협의 → 수주/);
});

test("sales document lines derive totals and prevent downstream quantity over-allocation", async () => {
  const [api, view, operations, schema, migration, plan] = await Promise.all([
    read("app/api/sales/route.ts"), read("app/sales-workspace.tsx"), read("app/api/operations/route.ts"),
    read("db/schema.ts"), read("drizzle/0045_sales_document_lines.sql"), read("docs/sales-document-line-governance-plan.md"),
  ]);
  assert.match(api, /resource === "catalog"/);
  assert.match(api, /SALES_CATALOG_ITEM_CREATED/);
  assert.match(api, /SALES_CATALOG_ITEM_UPDATED/);
  assert.match(api, /견적·수주·납품·청구 문서에는 품목 라인이 한 개 이상 필요합니다/);
  assert.match(api, /const amount = lines\.reduce\(\(sum, line\) => sum \+ line\.amount, 0\)/);
  assert.match(api, /json_each\(\?\) request/);
  assert.match(api, /source_line\.quantity - COALESCE/);
  assert.match(api, /child\.status <> 'CANCELLED'/);
  assert.match(api, /미취소 하위 문서가 있어 취소할 수 없습니다/);
  assert.match(view, /상품·서비스 기준정보/);
  assert.match(view, /과거 문서에는 영향이 없습니다/);
  assert.match(view, /품목 합계/);
  assert.match(view, /기존 총액 문서/);
  assert.match(view, /처리 가능한 잔여 수량/);
  assert.match(operations, /sales-document-control-risk/);
  assert.match(operations, /라인합계 불일치/);
  assert.match(schema, /salesCatalogItems/);
  assert.match(schema, /salesDocumentLines/);
  assert.match(migration, /ALTER TABLE `sales_documents` ADD `source_document_id`/);
  assert.match(migration, /idx_sales_document_line_number/);
  assert.match(migration, /PRAGMA optimize/);
  assert.match(plan, /문서 금액은 `수량 × 단가`의 라인별 반올림 합계/);
});

test("sales targets are versioned, approval-gated and forecast without double-counting invoices", async () => {
  const [api, view, workspace, approval, approvalCenter, operations, schema, migration, plan] = await Promise.all([
    read("app/api/sales/planning/route.ts"), read("app/sales-planning-view.tsx"), read("app/sales-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/approval-center.tsx"), read("app/api/operations/route.ts"),
    read("db/schema.ts"), read("drizzle/0046_sales_target_forecast.sql"), read("docs/sales-target-forecast-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "sales", "read"\)/);
  assert.match(api, /COALESCE\(MAX\(version\), 0\) \+ 1/);
  assert.match(api, /status NOT IN \('퇴직','입사 예정'\)/);
  assert.match(api, /Math\.max\(0, opportunity\.expected_revenue - \(invoicesByOpportunity\.get\(opportunity\.id\) \?\? 0\)\)/);
  assert.match(api, /document\.status IN \('ACCEPTED','COMPLETED'\)/);
  assert.match(api, /companyTargets\?\.months \?\? 0\) !== 12/);
  assert.match(api, /requestType: "TARGET_PLAN"/);
  assert.match(api, /SALES_FORECAST_SNAPSHOT_CREATED/);
  assert.match(view, /확정 청구와 미청구 가중 파이프라인을 분리/);
  assert.match(view, /비교 범위/);
  assert.match(view, /전망 저장/);
  assert.match(workspace, /<SalesPlanningView/);
  assert.match(approval, /TARGET_PLAN: "영업 목표 승인"/);
  assert.match(approval, /targetEntityType === "SALES_TARGET_PLAN"/);
  assert.match(approval, /status = 'SUPERSEDED'/);
  assert.match(approvalCenter, /TARGET_PLAN: "영업 목표 승인"/);
  assert.match(operations, /sales-forecast-governance-risk/);
  assert.match(operations, /attainment < 0\.9 \|\| drop >= 0\.1/);
  assert.match(schema, /salesTargetPlans/);
  assert.match(schema, /salesTargetLines/);
  assert.match(schema, /salesForecastSnapshots/);
  assert.match(migration, /idx_sales_target_plan_year_approved/);
  assert.match(migration, /WHERE `status` = 'APPROVED'/);
  assert.match(plan, /월 전망: 월 확정 청구 \+ 해당 월 마감 예정 미청구 가중 파이프라인/);
});

test("sales pricing uses versioned masters, immutable reviews and approval-gated quote to order", async () => {
  const [pricing, api, helper, view, workspace, approval, approvalCenter, operations, schema, migration, plan] = await Promise.all([
    read("app/api/sales/pricing/route.ts"), read("app/api/sales/route.ts"), read("app/sales-pricing.ts"),
    read("app/sales-pricing-governance.tsx"), read("app/sales-workspace.tsx"), read("app/approval-engine.ts"),
    read("app/approval-center.tsx"), read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0048_sales_pricing_governance.sql"), read("docs/sales-pricing-governance-plan.md"),
  ]);
  assert.match(pricing, /action === "CREATE_PRICE_LIST"/);
  assert.match(pricing, /action === "UPSERT_PRICE_ITEM"/);
  assert.match(pricing, /action === "ACTIVATE_PRICE_LIST"/);
  assert.match(pricing, /authorizeErpRequest\(db, "sales", "approve"\)/);
  assert.match(pricing, /action === "CREATE_POLICY"/);
  assert.match(pricing, /action === "ACTIVATE_POLICY"/);
  assert.match(pricing, /action === "REQUEST_EXCEPTION"/);
  assert.match(pricing, /requestType: "DISCOUNT"/);
  assert.match(pricing, /targetEntityType: "SALES_PRICING_REVIEW"/);
  assert.match(helper, /Math\.round\(\(listAmount - document\.amount\) \/ listAmount \* 10_000\)/);
  assert.match(helper, /Math\.round\(\(document\.amount - standardCostAmount\) \/ document\.amount \* 10_000\)/);
  assert.match(helper, /"DATA_MISSING"/);
  assert.match(helper, /"EXCEPTION_REQUIRED"/);
  assert.match(helper, /\["PASS", "APPROVED"\]/);
  assert.match(api, /가격 검토를 통과하거나 예외 승인을 받은 견적만 수주로 전환/);
  assert.match(api, /가격 검토를 통과하거나 가격 예외 승인을 완료한 뒤 문서를 발행·확정/);
  assert.match(view, /가격표·할인·마진 통제/);
  assert.match(view, /시스템은 기본 할인율이나 마진율을 임의로 제안하지 않습니다/);
  assert.match(workspace, /<SalesPricingGovernance/);
  assert.match(approval, /DISCOUNT: "가격·할인 예외 승인"/);
  assert.match(approval, /targetEntityType === "SALES_PRICING_REVIEW"/);
  assert.match(approvalCenter, /가격·할인 예외 승인/);
  assert.match(operations, /sales-pricing-governance-risk/);
  assert.match(operations, /destination: "sales:pricing"/);
  assert.match(schema, /salesPriceLists/);
  assert.match(schema, /salesPriceListItems/);
  assert.match(schema, /salesPricingPolicies/);
  assert.match(schema, /salesDocumentPricingReviews/);
  assert.match(migration, /idx_sales_price_list_single_active/);
  assert.match(migration, /idx_sales_pricing_policy_single_active/);
  assert.match(migration, /sales_document_pricing_reviews/);
  assert.match(plan, /데이터 누락은 예외 승인으로 우회할 수 없다/);
});

test("sales contracts require signed evidence, obligations and governed changes before fulfillment", async () => {
  const [api, helper, sales, documents, view, workspace, approval, approvalCenter, operations, schema, migration, plan] = await Promise.all([
    read("app/api/sales/contracts/route.ts"), read("app/sales-contracts.ts"), read("app/api/sales/route.ts"),
    read("app/api/documents/route.ts"), read("app/sales-contract-management.tsx"), read("app/sales-workspace.tsx"),
    read("app/approval-engine.ts"), read("app/approval-center.tsx"), read("app/api/operations/route.ts"),
    read("db/schema.ts"), read("drizzle/0049_sales_contract_lifecycle.sql"), read("docs/sales-contract-lifecycle-plan.md"),
  ]);
  assert.match(api, /action === "CREATE_CONTRACT"/);
  assert.match(api, /document_type = 'ORDER' AND status IN \('ACCEPTED','COMPLETED'\)/);
  assert.match(api, /action === "ADD_OBLIGATION"/);
  assert.match(api, /서명 계약서와 최소 1개의 이행 의무/);
  assert.match(api, /requestType: "CONTRACT"/);
  assert.match(api, /targetEntityType: "SALES_CONTRACT"/);
  assert.match(api, /action === "REQUEST_CHANGE"/);
  assert.match(api, /이미 결재 또는 적용 대기 중인 계약 변경/);
  assert.match(api, /requestType: "CONTRACT_CHANGE"/);
  assert.match(api, /action === "APPLY_SCHEDULED_CHANGE"/);
  assert.match(api, /OBLIGATION_EVIDENCE/);
  assert.match(helper, /enforcement_started_at/);
  assert.match(helper, /order\.created_at >=/);
  assert.match(helper, /도입 이후 수주는 승인된 계약 원장/);
  assert.match(sales, /getSalesContractGate/);
  assert.doesNotMatch(documents, /salesContract|sales-contracts/);
  assert.match(view, /계약·이행 관리/);
  assert.match(view, /서명 계약서/);
  assert.match(view, /계약 변경요청/);
  assert.match(workspace, /<SalesContractManagement/);
  assert.match(approval, /CONTRACT: "계약 활성화 승인"/);
  assert.match(approval, /CONTRACT_CHANGE: "계약 변경 승인"/);
  assert.match(approval, /targetEntityType === "SALES_CONTRACT"/);
  assert.match(approval, /targetEntityType === "SALES_CONTRACT_CHANGE"/);
  assert.match(approval, /'SCHEDULED'/);
  assert.match(approvalCenter, /계약 활성화 승인/);
  assert.match(operations, /sales-contract-lifecycle-risk/);
  assert.match(operations, /갱신 통지 도래/);
  assert.match(schema, /salesContracts/);
  assert.match(schema, /salesContractObligations/);
  assert.match(schema, /salesContractChangeRequests/);
  assert.match(migration, /idx_sales_contract_order/);
  assert.match(migration, /idx_sales_contract_number/);
  assert.match(plan, /도입 이전 수주는 기존 운영을 보존/);
});

test("after-sales service governs SLA, return quantities, evidence, approval and downstream completion", async () => {
  const [api, service, documents, approval, approvalCenter, operations, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/sales/service/route.ts"),
    read("app/sales-service-management.tsx"),
    read("app/api/documents/route.ts"),
    read("app/approval-engine.ts"),
    read("app/approval-center.tsx"),
    read("app/api/operations/route.ts"),
    read("app/sales-workspace.tsx"),
    read("db/schema.ts"),
    read("drizzle/0050_sales_service_control.sql"),
    read("docs/sales-service-control-plan.md"),
  ]);
  assert.match(api, /status = 'ACTIVE'/);
  assert.match(api, /활성 SLA가 없어 최초응답과 해결기한을 직접 입력/);
  assert.match(api, /reserved_milli/);
  assert.match(api, /quantityMilli > Math\.round\(source\.quantity \* 1000\) - Number\(source\.reserved_milli\)/);
  assert.match(api, /REMOVE_RETURN_LINE/);
  assert.match(api, /reservedRefund/);
  assert.match(api, /SERVICE_EVIDENCE/);
  assert.match(api, /requestType: "SERVICE_RESOLUTION"/);
  assert.match(api, /authorizeErpRequest\(db, "finance", "write"\)/);
  assert.match(api, /'SALES_RETURN_IN'/);
  assert.match(api, /finance_status !== "PAID"/);
  assert.doesNotMatch(documents, /salesServiceCase|sales-service/);
  assert.match(approval, /SERVICE_POLICY: "고객지원 SLA 승인"/);
  assert.match(approval, /SERVICE_RESOLUTION: "고객 이슈 처리 승인"/);
  assert.match(approval, /targetEntityType === "SALES_SERVICE_POLICY"/);
  assert.match(approval, /targetEntityType === "SALES_SERVICE_CASE"/);
  assert.match(approval, /'SALES_SERVICE_REFUND'/);
  assert.match(approval, /'SALES_SERVICE_EXCHANGE'/);
  assert.match(approval, /'SALES_SERVICE_DISPOSITION'/);
  assert.match(approvalCenter, /고객지원 SLA 승인/);
  assert.match(operations, /sales-service-control-risk/);
  assert.match(service, /고객지원·반품 관리/);
  assert.match(service, /최초 고객 응답/);
  assert.match(service, /후속조치 확인 후 종결/);
  assert.match(workspace, /<SalesServiceManagement/);
  assert.match(schema, /salesServiceCases/);
  assert.match(schema, /salesServiceReturnLines/);
  assert.match(migration, /idx_sales_service_policy_active_priority/);
  assert.match(api, /INSERT INTO sales_service_return_lines[\s\S]*SELECT \?, service\.id, source_line\.id/);
  assert.match(api, /transition\.meta\.changes/);
  assert.match(plan, /상품 매핑이나 원가는 추정하지 않는다/);
  assert.match(plan, /동시 요청/);
});

test("HR audio transcription separates consent, AI attempts and one-time human review", async () => {
  const [api, control, employeeApi, applicantApi, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/hr/transcriptions/route.ts"),
    read("app/audio-transcription-control.tsx"),
    read("app/api/hr/interviews/route.ts"),
    read("app/api/hr/applicant-interview-recordings/route.ts"),
    read("app/hr-workspace.tsx"),
    read("db/schema.ts"),
    read("drizzle/0051_hr_audio_transcriptions.sql"),
    read("docs/hr-audio-transcription-plan.md"),
  ]);
  assert.match(api, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(api, /consentConfirmed !== true/);
  assert.match(api, /authorizeErpRequest\(bindings\.DB, entityModules\[entityType\], "write"\)/);
  assert.match(api, /audio\.size > 10 \* 1024 \* 1024/);
  assert.match(api, /QUOTA_EXCEEDED/);
  assert.match(api, /reviewed_at IS NULL/);
  assert.match(api, /HR_AUDIO_TRANSCRIBED/);
  assert.match(api, /HR_AUDIO_TRANSCRIPTION_REVIEWED/);
  assert.match(control, /Cloudflare Workers AI로 전송/);
  assert.match(control, /사용자 검토 확정/);
  assert.match(employeeApi, /녹음 당사자의 동의 확인/);
  assert.match(applicantApi, /지원자의 동의 확인/);
  assert.match(workspace, /실시간 전사 초안/);
  assert.match(workspace, /<AudioTranscriptionControl entityType="EMPLOYEE_INTERVIEW"/);
  // 지원자 면접 녹음 화면(ApplicantInterviewRecorder)은 c3738bc 이후 어디에도 붙지 않은 죽은 코드라 2026-09-21 정리했다.
  // 지원자 동의 확인은 API(app/api/hr/applicant-interview-recordings)에서 계속 강제한다 — 위 applicantApi 단정이 그 가드다.
  assert.doesNotMatch(workspace, /function ApplicantInterviewRecorder\(/);
  assert.match(schema, /hrAudioTranscriptions/);
  assert.match(migration, /idx_hr_audio_transcription_entity_attempt/);
  assert.match(plan, /AI 원문은 수정하지 않고 사용자 검토본을 별도 필드/);
});

test("data governance control center verifies recoverability without automatic restore or deletion", async () => {
  const [api, server, view, page, operations, schema, migration, plan] = await Promise.all([
    read("app/api/data-governance/route.ts"), read("app/data-governance.ts"),
    read("app/data-governance-center.tsx"), read("app/page.tsx"), read("app/api/operations/route.ts"), read("db/schema.ts"),
    read("drizzle/0052_data_governance.sql"), read("docs/data-governance-control-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const source of [api, server, schema, migration]) {
    for (const table of ["erp_data_control_runs", "erp_data_control_checks", "erp_logical_snapshots",
      "erp_recovery_rehearsals", "erp_audit_exports", "erp_retention_policies"]) assert.match(source, new RegExp(table));
  }
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(api, /productionWrites: 0/);
  assert.match(api, /totalRows > 50_000/);
  assert.match(api, /20 \* 1024 \* 1024/);
  assert.match(api, /COUNT\(\*\).*10_000/s);
  assert.match(api, /bindings\.HR_AUDIO\.head/);
  assert.match(api, /auditBefore/);
  assert.match(api, /스냅샷 생성 중 감사 대상 업무 변경/);
  assert.match(api, /data-governance-attention/);
  assert.match(api, /settings:data-governance/);
  assert.match(api, /automaticRestore: false/);
  assert.match(api, /automaticDeletion: false/);
  assert.doesNotMatch(api, /DROP TABLE|DELETE FROM erp_audit_logs|DELETE FROM hr_employee_records/);
  assert.match(view, /데이터 신뢰성 통제 센터/);
  assert.match(view, /복구 모의훈련/);
  assert.match(view, /자동 복구 없음/);
  assert.match(view, /자동 삭제 없음/);
  assert.match(operations, /데이터 통제 점검이 정상 상태가 된 뒤 업무가 자동 종료/);
  assert.match(plan, /실제 복구는 자동 제공하지 않는다/);
  assert.match(plan, /settings:admin/);
});

test("data integration center reconciles approved snapshots with idempotent reviewed exceptions", async () => {
  const [api, server, workspace, center, page, operations, schema, migration, plan] = await Promise.all([
    read("app/api/data-integration/route.ts"), read("app/data-integration.ts"), read("app/data-integration-workspace.tsx"),
    read("app/data-governance-center.tsx"), read("app/page.tsx"), read("app/api/operations/route.ts"),
    read("db/schema.ts"), read("drizzle/0053_data_integration_center.sql"), read("docs/data-integration-reconciliation-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for (const source of [api, server, schema, migration]) for (const table of ["erp_integration_sources", "erp_integration_exceptions", "erp_sync_run_events"]) assert.match(source, new RegExp(table));
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(api, /CLOBE_FINANCE_2026/); assert.match(api, /ECOUNT_FINANCE_2024/); assert.match(api, /HIWORKS_EMPLOYEES/); assert.match(api, /PAYROLL_EXCEL_2025_2026/);
  assert.match(api, /idempotency_key/); assert.match(api, /retry_of_run_id/); assert.match(api, /ACCEPT_RISK/); assert.match(api, /note\.length < 5/);
  assert.match(api, /automaticWrites: 0, externalFetch: false/);
  assert.doesNotMatch(api, /DELETE FROM finance_bank_transactions|DELETE FROM hr_employee_records|DELETE FROM hr_payroll_records/);
  assert.match(workspace, /현재 ERP 스냅샷 검증/); assert.match(workspace, /외부 조회 없음/); assert.match(workspace, /자동 덮어쓰기 없음/);
  assert.match(center, /연동·대사/);
  assert.match(operations, /고위험 연동 예외를 해결하거나 근거와 함께 위험 수용/);
  assert.match(migration, /WHERE `idempotency_key` <> ''/); assert.match(plan, /자동 덮어쓰기/); assert.match(plan, /외부 API를 호출하지 않았는데 수집했다고 표시/);
});

test("enterprise audit trail is admin-only, paginated, redacted and immutable", async () => {
  const [api, workspace, center, platform, schema, migration, plan] = await Promise.all([
    read("app/api/audit-log/route.ts"), read("app/audit-log-workspace.tsx"), read("app/data-governance-center.tsx"),
    read("app/erp-platform.ts"), read("db/schema.ts"), read("drizzle/0060_erp_audit_trail.sql"),
    read("docs/erp-audit-trail-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /ORDER BY a\.created_at DESC, a\.id DESC LIMIT 31/);
  assert.match(api, /a\.created_at < \? OR \(a\.created_at = \? AND a\.id < \?\)/);
  assert.match(api, /secretKey\.test\(key\)/);
  assert.match(api, /automaticMutation: false/);
  assert.doesNotMatch(api, /UPDATE erp_audit_logs|DELETE FROM erp_audit_logs/);
  assert.match(workspace, /통합 감사·변경이력/);
  assert.match(workspace, /다음 30건 보기/);
  assert.match(workspace, /보안 키 값은 서버에서 가려 표시/);
  assert.match(center, /감사·변경이력/);
  for (const source of [platform, schema, migration]) assert.match(source, /idx_erp_audit_created_id/);
  assert.match(plan, /조회는 `settings:admin` 권한/);
  assert.match(plan, /수정·삭제 경로가 없다/);
});

test("controlled data intake stages immutable originals before approval and explicit application", async () => {
  const [api, server, workspace, integration, approval, schema, migration, plan] = await Promise.all([
    read("app/api/data-intake/route.ts"), read("app/data-intake.ts"), read("app/data-intake-workspace.tsx"),
    read("app/data-integration-workspace.tsx"), read("app/approval-engine.ts"), read("db/schema.ts"),
    read("drizzle/0054_controlled_data_intake.sql"), read("docs/controlled-data-intake-plan.md"),
  ]);
  for (const source of [api, server, schema, migration]) for (const table of ["erp_data_import_batches", "erp_data_import_rows", "erp_data_import_events"]) assert.match(source, new RegExp(table));
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/);
  assert.match(api, /10 \* 1024 \* 1024/); assert.match(api, /slice\(0, 500\)/); assert.match(api, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(api, /readSheet/); assert.match(api, /csvRows/); assert.match(api, /JSON은 객체 배열 또는 rows 배열/);
  assert.match(api, /동일 원본이 이미 등록/); assert.match(api, /validation_status<>'VALID'/); assert.match(api, /String\(batch\.status\) !== "APPROVED"/);
  assert.match(api, /supportedApplySources/); assert.match(api, /업무 원장 반영 매핑 확정 전/); assert.match(api, /ON CONFLICT\(employee_id\) DO UPDATE/); assert.match(api, /ON CONFLICT\(id\) DO UPDATE SET annual_salary/);
  assert.match(api, /bindings\.HR_AUDIO\.put/); assert.match(api, /automaticApply: false/); assert.match(plan, /원본 자동 삭제 없음/);
  assert.match(approval, /DATA_IMPORT: "재무 데이터 반영 승인"/); assert.match(approval, /targetEntityType === "DATA_IMPORT_BATCH"/);
  assert.match(workspace, /원본 보관·검증/); assert.match(workspace, /결재 제출/); assert.match(workspace, /승인본 반영/); assert.match(integration, /DataIntakeWorkspace/);
  assert.match(plan, /자동 반영하지 않는다/); assert.match(plan, /실제 업무 원장 반영은 API 계약과 계정 매핑이 확정될 때까지 차단/);
});

test("finance import mappings are versioned, approval-gated and balance-blocking", async () => {
  const [api, server, workspace, integration, approval, schema, migration, plan] = await Promise.all([
    read("app/api/finance/import-mappings/route.ts"), read("app/finance-import-mapping.ts"), read("app/finance-import-mapping-workspace.tsx"),
    read("app/data-integration-workspace.tsx"), read("app/approval-engine.ts"), read("db/schema.ts"),
    read("drizzle/0055_finance_import_mapping.sql"), read("docs/finance-import-mapping-plan.md"),
  ]);
  for (const source of [api, server, schema, migration]) for (const table of ["finance_import_mapping_sets", "finance_import_mapping_rules", "finance_import_validations", "finance_import_canonical_rows", "finance_import_mapping_events"]) assert.match(source, new RegExp(table));
  assert.match(api, /authorizeErpRequest\(db, "settings", "admin"\)/); assert.match(api, /requestType: "IMPORT_MAPPING"/); assert.match(api, /status='ACTIVE'/);
  assert.match(api, /분개장 차변·대변/); assert.match(api, /기간 차변·대변/); assert.match(api, /파일 내부 거래 ID 중복/); assert.match(api, /은행계좌 또는 GL 미연결/);
  assert.match(api, /mapping_method.*MANUAL/); assert.match(api, /exactMatchOnly: true/); assert.match(api, /directPosting: false/);
  assert.match(approval, /IMPORT_MAPPING: "재무 파일 매핑 승인"/); assert.match(approval, /targetEntityType === "FINANCE_IMPORT_MAPPING_SET"/); assert.match(approval, /status='SUPERSEDED'/);
  assert.match(workspace, /자동 유사매칭 없음/); assert.match(workspace, /차대변 1원 차이도/); assert.match(workspace, /운영 총계정원장이 아닌 검증용 스테이징/); assert.match(integration, /FinanceImportMappingWorkspace/);
  assert.match(migration, /WHERE `status` = 'ACTIVE'/); assert.match(plan, /명칭 유사도 자동 병합은 하지 않는다/); assert.match(plan, /운영 총계정원장 전기를 의미하지 않는다/);
});

test("finance posting control preserves multi-line lineage and requires tax, period and approval gates", async () => {
  const [api, server, workspace, integration, approval, close, schema, migration, plan, platform] = await Promise.all([
    read("app/api/finance/posting-control/route.ts"), read("app/finance-posting.ts"), read("app/finance-posting-workspace.tsx"),
    read("app/data-integration-workspace.tsx"), read("app/approval-engine.ts"), read("app/api/finance/close/route.ts"), read("db/schema.ts"),
    read("drizzle/0056_finance_posting_control.sql"), read("docs/finance-posting-control-plan.md"), read("app/erp-platform.ts"),
  ]);
  for (const source of [api, server, schema, migration]) for (const table of ["finance_posting_batches", "finance_posting_vouchers", "finance_posting_lines", "finance_posting_events"]) assert.match(source, new RegExp(table));
  assert.match(api, /authorizeErpRequest\(db, "finance", "admin"\)/); assert.match(api, /validation\.status='PASSED'/); assert.match(api, /validation\.data_type='JOURNAL'/);
  assert.match(api, /total_debit.*total_credit/); assert.match(api, /tax_review_status !== "REVIEWED"/);
  // The period-lock query itself lives in erp-platform.ts's shared blockedFinancePeriods() now
  // (docs/finance-remediation-plan.md Stage 2 — "blockedPeriods() 공용화"), not duplicated here.
  assert.match(api, /blockedFinancePeriods\(db,/); assert.match(platform, /finance_close_runs WHERE period IN/); assert.match(api, /미개방 회계기간/);
  assert.match(api, /requestType:"JOURNAL_POSTING"/); assert.match(api, /status='APPROVED'/); assert.match(api, /source_canonical_row_id/); assert.match(api, /reversal_of_line_id/);
  assert.match(api, /Number\(line\.credit_amount\), Number\(line\.debit_amount\)/); assert.doesNotMatch(api, /DELETE FROM finance_posting_batches WHERE id=\? AND status='POSTED'/);
  assert.match(approval, /JOURNAL_POSTING: "분개 전기 승인"/); assert.match(approval, /targetEntityType === "FINANCE_POSTING_BATCH"/);
  assert.match(close, /ensureFinancePostingSchema/); assert.match(close, /status IN \('DRAFT','SUBMITTED','APPROVED'\)/);
  assert.match(close, /통제 분개 미전기 배치/); assert.match(close, /period_from <= \? AND period_to >= \?/);
  assert.match(workspace, /금액 수정 금지/); assert.match(workspace, /수정분개만 허용/); assert.match(workspace, /승인본 전기/); assert.match(integration, /FinancePostingWorkspace/);
  assert.match(migration, /WHERE `source_canonical_row_id` <> ''/); assert.match(migration, /WHERE `reversal_of_batch_id` <> ''/); assert.match(plan, /전기된 전표는 수정·삭제하지 않는다/); assert.match(plan, /현재 월이 아닌데 마감 원장 자체가 없는 기간도 미개방/);
});

test("general ledger is import-only and excludes ERP-generated payment journal entries", async () => {
  const [api, server, snapshot, workspace, page, plan] = await Promise.all([
    read("app/api/finance/general-ledger/route.ts"), read("app/finance-general-ledger.ts"),
    read("app/finance-ledger-snapshot.ts"),
    read("app/general-ledger-workspace.tsx"), read("app/page.tsx"), read("docs/finance-general-ledger-plan.md"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api, /authorizeErpRequest\(db, "finance", "read"\)/);
  assert.match(api, /financeHistoricalData\.trialBalance2025/);
  assert.match(api, /finance_posting_batches batch ON batch\.id=voucher\.batch_id AND batch\.status='POSTED'/);
  assert.doesNotMatch(api, /FROM finance_journal_entries/);
  assert.doesNotMatch(snapshot, /FROM finance_journal_entries/);
  assert.match(api, /openingDifference/); assert.match(api, /periodDifference/); assert.match(api, /endingDifference/);
  assert.match(server, /row\.voucherDate < from/); assert.match(api, /ledgerRows\("2026-01-01", to\)/);
  assert.match(api, /stagedOrClobeRowsIncluded: false/); assert.match(api, /Content-Disposition/); assert.match(api, /\^\[=\+\\-@\]/);
  assert.match(workspace, /총계정원장·2026 시산표/); assert.match(workspace, /CSV 내려받기/); assert.match(workspace, /이카운트 분개장 import분만/);
  assert.match(plan, /검증·분석 레이어/); assert.match(plan, /제외/);
});

test("equation check uses YTD ending balances regardless of the query start date", async () => {
  const server = await read("app/finance-general-ledger.ts");
  assert.match(server, /ytdRevenue = amount\("REVENUE", "CREDIT"\)/);
  assert.match(server, /ytdExpenses = amount\("EXPENSE", "DEBIT"\)/);
  assert.match(server, /equationDifference = assets - liabilities - equity - ytdNetIncome/);
  assert.match(server, /normalBalanceMismatch/);
});

test("opening balances require a balanced immutable draft and final electronic approval", async()=>{
  const[api,server,control,ledger,approval,schema,migration,plan]=await Promise.all([read("app/api/finance/opening-balance/route.ts"),read("app/finance-opening-balance.ts"),read("app/opening-balance-control.tsx"),read("app/api/finance/general-ledger/route.ts"),read("app/approval-engine.ts"),read("db/schema.ts"),read("drizzle/0057_finance_opening_balance.sql"),read("docs/finance-opening-balance-plan.md")]);
  for(const source of[api,server,schema,migration])for(const table of["finance_opening_balance_sets","finance_opening_balance_lines","finance_opening_balance_events"])assert.match(source,new RegExp(table));
  assert.match(api,/authorizeErpRequest\(db,"finance","admin"\)/);assert.match(api,/difference_amount/);assert.match(api,/requestType:"OPENING_BALANCE"/);assert.match(server,/crypto\.subtle\.digest\("SHA-256"/);assert.doesNotMatch(api,/UPDATE finance_opening_balance_lines|DELETE FROM finance_opening_balance/);
  assert.match(approval,/OPENING_BALANCE: "개시잔액 기준선 승인"/);assert.match(approval,/FINANCE_OPENING_BALANCE_SET/);assert.match(ledger,/approvedOpeningRows/);assert.match(ledger,/openingApprovedReference: Boolean\(opening\)/);
  assert.match(control,/금액 편집 없이 생성/);assert.match(control,/개시잔액 결재 제출/);assert.match(migration,/WHERE `status`='APPROVED'/);assert.match(plan,/승인 전 참고값/);assert.match(plan,/수정과 삭제 API를 제공하지 않는다/);
});

test("operational statements and month close freeze only approved posted ledger evidence",async()=>{
  const[api,server,snapshot,workspace,close,plan]=await Promise.all([read("app/api/finance/general-ledger/route.ts"),read("app/finance-general-ledger.ts"),read("app/finance-ledger-snapshot.ts"),read("app/general-ledger-workspace.tsx"),read("app/api/finance/close/route.ts"),read("docs/finance-operational-statements-plan.md")]);
  assert.match(api,/buildOperationalFinancialStatements/);assert.match(api,/statements/);assert.match(api,/statementOfficial/);
  assert.match(server,/periodDebit.*periodCredit/);assert.match(server,/equationDifference/);assert.match(server,/unclassifiedAccounts/);
  assert.match(snapshot,/finance_posting_batches batch ON batch\.id=voucher\.batch_id AND batch\.status='POSTED'/);
  assert.doesNotMatch(snapshot,/FROM finance_journal_entries/);assert.match(snapshot,/crypto\.subtle\.digest\("SHA-256"/);
  assert.match(workspace,/2026 손익계산서·재무상태표/);assert.match(workspace,/검토용 초안/);assert.match(workspace,/공식화 전 확인/);
  assert.match(close,/buildFinanceLedgerSnapshot/);assert.match(close,/APPROVED_OPENING_BALANCE/);assert.match(close,/GENERAL_LEDGER_BALANCE/);
  assert.match(close,/openingChecksum/);assert.match(close,/ledgerHash/);assert.match(close,/ledgerSnapshot/);
  assert.match(plan,/세금계산서 통계.*직접 합산하지 않는다/);assert.match(plan,/월마감 제출 직전에 원장을 다시 계산/);
});

test("income statement subdivides into gross/operating/pre-tax lines and balance sheet splits current/non-current",async()=>{
  const[opening,server,masterData,engine,api,snapshot,workspace]=await Promise.all([
    read("app/finance-opening-balance.ts"),read("app/finance-general-ledger.ts"),read("app/api/finance/master-data/route.ts"),
    read("app/approval-engine.ts"),read("app/api/finance/general-ledger/route.ts"),read("app/finance-ledger-snapshot.ts"),
    read("app/general-ledger-workspace.tsx"),
  ]);
  assert.match(opening,/export function statementLineFor/);assert.match(opening,/export function liquidityFor/);
  assert.match(server,/grossProfit = salesRevenue - cogs/);assert.match(server,/operatingIncome = grossProfit - sga/);
  assert.match(server,/preTaxIncome = operatingIncome \+ nonOperatingIncome - nonOperatingExpense/);
  assert.match(server,/currentAssets = liquidityAmount\("ASSET", "CURRENT", "DEBIT"\)/);
  assert.match(server,/unclassifiedStatementLineAccounts/);assert.match(server,/unclassifiedLiquidityAccounts/);
  assert.match(masterData,/statement_line/);assert.match(masterData,/statementLineFor\(/);assert.match(masterData,/liquidityFor\(/);
  assert.match(engine,/statement_line = COALESCE/);assert.match(engine,/liquidity = COALESCE/);
  assert.match(api,/masterStatementLines/);assert.match(api,/statementLineMap\(accounts, categories\)/);
  assert.match(snapshot,/statementLines\[item\.key\]/);assert.match(snapshot,/liquidity\[item\.key\]/);
  assert.match(workspace,/매출총이익/);assert.match(workspace,/영업이익/);assert.match(workspace,/법인세차감전순이익/);
  assert.match(workspace,/유동자산/);assert.match(workspace,/비유동부채/);assert.match(workspace,/전기 이월, 2026년 미변동/);
});

test("statement comparisons disclose source scope and submitted closes detect ledger drift",async()=>{
  const[api,server,workspace,close,closeWorkspace,integrity,plan]=await Promise.all([read("app/api/finance/general-ledger/route.ts"),read("app/finance-general-ledger.ts"),read("app/general-ledger-workspace.tsx"),read("app/api/finance/close/route.ts"),read("app/finance-close-workspace.tsx"),read("app/finance-ledger-integrity.ts"),read("docs/finance-comparison-drift-plan.md")]);
  assert.match(server,/previousEqualLengthPeriod/);assert.match(server,/completedMonthsInRange/);assert.match(server,/historicalCloseComparison/);
  assert.match(api,/previousPeriod/);assert.match(api,/priorYearRule/);assert.match(api,/부분월은 일할 계산하지 않습니다/);
  assert.match(workspace,/직전 동일 일수/);assert.match(workspace,/2025 동일 완료월/);assert.match(workspace,/2025 비교값은 매출-순이익 역산/);
  assert.match(close,/evaluateLedgerSnapshotDrift/);assert.match(integrity,/frozen\.ledgerHash !== current\.ledgerHash/);assert.match(integrity,/openingChanged/);assert.match(integrity,/lineCountDelta/);
  assert.match(closeWorkspace,/마감 이후 원장 변동 감지/);assert.match(closeWorkspace,/재개방 결재 요청/);assert.match(close,/재개방 승인이 필요합니다/);
  assert.match(plan,/자동 수정하거나 마감을 자동 재개방하지 않는다/);assert.match(plan,/회계 정확성 자체의 보증이 아니라 원장 계보 무결성/);
});

test("finance assistant answers from posted evidence and discloses source lineage and limitations",async()=>{
  const[api,evidence,page,style,plan]=await Promise.all([read("app/api/finance/assistant/route.ts"),read("app/finance-assistant-evidence.ts"),read("app/page.tsx"),read("app/globals.css"),read("docs/finance-assistant-evidence-plan.md")]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  assert.match(api,/buildFinancePeriodStatementSnapshot/);assert.match(api,/buildFinanceLedgerSnapshot/);assert.match(api,/evaluateLedgerSnapshotDrift/);
  assert.match(api,/finance_close_runs/);assert.match(api,/RULE_BASED_FALLBACK/);assert.match(api,/quotaExceeded/);
  assert.match(evidence,/JSON 근거에 들어 있는 사실과 숫자만 사용/);assert.match(evidence,/taxInvoices2026.*회계상 매출/s);
  assert.match(style,/assistant-trust-line/);assert.match(style,/assistant-limitations/);
  assert.match(plan,/AI는 구조화된 근거 JSON을 설명만/);assert.match(plan,/규칙 기반 답변/);
});

test("finance assistant audit history freezes evidence and restores prior answers without mutation routes",async()=>{
  const[api,history,page,style,schema,migration,plan]=await Promise.all([read("app/api/finance/assistant/route.ts"),read("app/finance-assistant-history.ts"),read("app/page.tsx"),read("app/globals.css"),read("db/schema.ts"),read("drizzle/0058_finance_assistant_history.sql"),read("docs/finance-assistant-history-plan.md")]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for(const source of[history,schema,migration])assert.match(source,/finance_assistant_answers/);
  assert.match(api,/export async function GET/);assert.match(api,/saveFinanceAssistantAnswer/);assert.match(api,/responseWithHistory/);
  assert.match(history,/evidenceHash/);assert.match(history,/answerHash/);assert.match(history,/FINANCE_ASSISTANT_PROMPT_VERSION/);
  assert.match(history,/ORDER BY created_at DESC LIMIT/);assert.match(history,/Math\.min\(Math\.max\(limit, 1\), 50\)/);assert.match(history,/getFinanceAssistantAnswer/);
  assert.match(api,/searchParams\.get\("id"\)/);
  assert.doesNotMatch(api,/DELETE FROM finance_assistant_answers|UPDATE finance_assistant_answers/);
  assert.match(style,/assistant-history-list/);assert.match(plan,/수정·삭제 API는 만들지 않는다/);assert.match(plan,/저장에 실패한 답변은 화면에 성공한 답변으로 반환하지 않는다/);
});

test("receivables tie-out compares subsidiary and ledger balances, blocks close only on unconfirmed differences",async()=>{
  const[lib,api,snapshot,close,workspace,plan]=await Promise.all([
    read("app/finance-tie-out.ts"),read("app/api/finance/tie-out/route.ts"),read("app/finance-ledger-snapshot.ts"),
    read("app/api/finance/close/route.ts"),read("app/receivables-workspace.tsx"),read("docs/finance-remediation-plan.md"),
  ]);
  assert.match(lib,/finance_tie_out_checks/);assert.match(lib,/idx_finance_tie_out_type_period/);
  assert.match(lib,/difference_amount === 0 \|\| row\.difference_reason === "STRUCTURAL"/);
  assert.match(lib,/existing\?\.difference_amount === differenceAmount/);
  assert.match(snapshot,/export async function glAccountBalance/);
  assert.match(api,/authorizeErpRequest\(db, "finance", "read"\)/);assert.match(api,/authorizeErpRequest\(db, "finance", "write"\)/);
  assert.match(api,/authorizeErpRequest\(db, "finance", "approve"\)/);assert.match(api,/writeErpAudit/);
  assert.match(api,/RECEIVABLES_GL_ACCOUNT_CODE = "1089"/);assert.match(api,/note\.length < 5/);
  assert.match(close,/tieOutPasses/);assert.match(close,/RECEIVABLES_TIE_OUT/);
  assert.match(workspace,/매출채권 보조부 ↔ 원장 대사/);assert.match(workspace,/구조적 차이\(설명 가능, 월마감 차단 안 함\)/);
  assert.match(plan,/finance_reconciliation_statements 신설|finance-tie-out/);
});

test("payables tie-out compares unpaid invoices against the ledger and closes the AP subsidiary loop",async()=>{
  const[api,close,workspace]=await Promise.all([
    read("app/api/finance/tie-out/route.ts"),read("app/api/finance/close/route.ts"),read("app/purchasing-workspace.tsx"),
  ]);
  assert.match(api,/PAYABLES_GL_ACCOUNT_CODE = "2519"/);
  assert.match(api,/payment\.status = 'PAID' AND payment\.id IS NULL|payment\.id IS NULL/);
  assert.match(api,/invoice\.status <> 'CANCELLED'/);
  assert.match(api,/glAmount: -gl\.netDebit/);
  assert.match(api,/"RECEIVABLES", "PAYABLES", "INVENTORY", "DEBT", "BANK"\]\.includes\(checkType\)/);
  assert.match(close,/PAYABLES_TIE_OUT/);assert.match(close,/payablesTieOut/);
  assert.match(workspace,/매입채무 보조부 ↔ 원장 대사/);assert.match(workspace,/보조부\(미지급 인보이스\)/);
});

test("inventory tie-out aggregates the moving-average ledger against the stock GL account",async()=>{
  const[api,close,workspace]=await Promise.all([
    read("app/api/finance/tie-out/route.ts"),read("app/api/finance/close/route.ts"),read("app/inventory-workspace.tsx"),
  ]);
  assert.match(api,/INVENTORY_GL_ACCOUNT_CODE = "1469"/);
  assert.match(api,/async function inventorySubsidiaryAmount/);
  assert.match(api,/FROM inventory_movements`\)\.first/);
  assert.match(close,/INVENTORY_TIE_OUT/);assert.match(close,/inventoryTieOut/);
  assert.match(workspace,/재고자산 보조부 ↔ 원장 대사/);assert.match(workspace,/보조부\(이동원장 누적\)/);
});

test("debt tie-out compares the Clobe loan-balance snapshot against the loan GL account",async()=>{
  const[api,close,workspace]=await Promise.all([
    read("app/api/finance/tie-out/route.ts"),read("app/api/finance/close/route.ts"),read("app/debt-management-workspace.tsx"),
  ]);
  assert.match(api,/DEBT_GL_ACCOUNT_CODE = "2954"/);
  assert.match(api,/async function debtSubsidiaryAmount/);
  assert.match(api,/financeCurrentData\.accounts\.filter\(\(account\) => account\.type === "LOAN"\)/);
  assert.match(api,/"RECEIVABLES", "PAYABLES", "INVENTORY", "DEBT"/);
  assert.match(close,/DEBT_TIE_OUT/);assert.match(close,/debtTieOut/);
  assert.match(workspace,/차입금 보조부 ↔ 원장 대사/);assert.match(workspace,/보조부\(Clobe 스냅샷 대출잔액\)/);
});

test("bank tie-out (은행계정조정표) compares the Clobe bank-asset snapshot against the deposit GL account and itemizes unmatched bank transactions",async()=>{
  const[tieOutModule,api,close,workspace]=await Promise.all([
    read("app/finance-tie-out.ts"),read("app/api/finance/tie-out/route.ts"),
    read("app/api/finance/close/route.ts"),read("app/cash-reconciliation-workspace.tsx"),
  ]);
  assert.match(api,/BANK_GL_ACCOUNT_CODE = "1039"/);
  assert.match(api,/async function bankSubsidiaryAmount/);
  assert.match(api,/financeCurrentData\.accountSummary\.checkingBalanceSum \+ financeCurrentData\.accountSummary\.fxBalanceSumKrw/);
  assert.match(api,/async function bankBreakdown/);
  assert.match(api,/FROM finance_bank_transactions transaction_row/);
  assert.match(api,/"RECEIVABLES", "PAYABLES", "INVENTORY", "DEBT", "BANK"\]\.includes\(checkType\)/);
  assert.match(tieOutModule,/breakdown_json/);
  assert.match(close,/BANK_BALANCE_TIE_OUT/);assert.match(close,/bankTieOut/);
  assert.match(workspace,/은행계정조정표\(보통예금 잔액 대사\)/);assert.match(workspace,/보조부\(Clobe 스냅샷 은행성 자산\)/);
  assert.match(workspace,/미기입예금·미결제출금 후보/);
});

test("tie-out board unifies all 5 subsidiary-to-GL reconciliations with drill-down navigation and is wired into the finance sidebar",async()=>{
  const[board,page]=await Promise.all([
    read("app/tie-out-board-workspace.tsx"),read("app/page.tsx"),
  ]);
  // R1(M1-3): 셸(page.tsx)에서 재무·영업·워크벤치·데이터 통제 화면을 뺐다. 이 테스트와 대상 파일은 r1-delete에서 삭제한다.
  assert.doesNotMatch(page, /finance-current-data|FinanceDashboard|OperationsWorkbench|DataGovernanceCenter/);
  for(const type of["RECEIVABLES","PAYABLES","INVENTORY","DEBT","BANK"]) assert.match(board,new RegExp(`type: "${type}"`));
  assert.match(board,/fetch\(`\/api\/finance\/tie-out\?period=/);
  assert.match(board,/action: "RECOMPUTE"/);
  assert.match(board,/onNavigate\(item\.destination\)/);
});

test("inventory moving average respects transaction date and fully liquidated stock leaves no rounding residue", async () => {
  const api = await read("app/api/finance/inventory/route.ts");
  assert.match(api, /async function currentStock\(productId: string, warehouseId: string, asOfDate\?: string\)/);
  assert.match(api, /AND movement_date <= \?/);
  assert.match(api, /currentStock\(productId, warehouseId, movementDate\)/);
  assert.match(api, /quantityMilli === onHandMilli \? stockAmount : Math\.round\(quantityMilli \* unitCost \/ 1000\)/);
});

test("평균임금 산정 쿼리는 퇴직금과 퇴직월 연차수당을 뺀다", async () => {
  const source = await read("app/api/hr/operations/route.ts");
  // 지급총액을 그대로 쓰면 퇴직금이 평균임금에 섞여 들어간다.
  assert.match(source, /gross_pay - retirement_pay/);
  assert.ok(source.includes("CASE WHEN year_month = ? THEN annual_leave_pay ELSE 0 END"));
});

test("HR 감사 후속(B4·B2·D1·D2): 시연용 모듈 표 제거, 조직장 스냅샷 컬럼 미사용, 작은 팝업 디자인 규칙, 전환 예정 카드", async () => {
  const source = await readFile("app/hr-workspace.tsx", "utf8");
  const api = await readFile("app/api/hr/employee-records/route.ts", "utf8");
  const css = await readFile("public/hr-workspace.css", "utf8");
  // B4 — 정적 회사자료로 채우던 시연용 모듈 설정과, 어떤 메뉴로도 갈 수 없던 표 화면을 지웠다.
  for (const dead of ["demoModuleConfigs", "moduleConfigs", "type ModuleConfig", "function ModuleView", "<ModuleView"]) assert.ok(!source.includes(dead), dead);
  // B2 — 조직장은 hr_organization_leaders 가 기준. 화면은 manager 를 쓰지 않고, 서버는 돌려주지도 덮어쓰지도 않는다.
  assert.ok(!/\bmanager: /.test(source));
  assert.ok(source.includes("<input value={organizationLeaderName} disabled"));
  assert.ok(!api.includes("manager: row.manager") && !api.includes("manager = excluded.manager") && !api.includes('stringValue("manager")'));
  assert.ok(api.includes("record.department, \"\", record.type,"));
  assert.match(api, /await ensureHrEmployeeRecordsSchema\(db\)/);
  assert.ok((await read("app/hr-employee-schema.ts")).includes("manager TEXT NOT NULL"));
  // D1 — 처우 확정·거절, 입사 정보 수정 팝업도 접히는 제목줄·안쪽 왼편 스크롤바·공통 곡률을 따른다.
  assert.ok(source.includes('className={`employee-modal offer-response-modal${responseCondensed ? " condensed" : ""}`}'));
  assert.ok(source.includes('className={`employee-modal onboarding-edit-modal${condensed ? " condensed" : ""}`}'));
  assert.match(source, /setResponseCondensed\(false\); setAcceptModalOpen\(true\)/);
  assert.match(source, /setResponseCondensed\(false\); setDeclineModalOpen\(true\)/);
  assert.match(css, /\.offer-response-modal,\s*\.onboarding-edit-modal \{ direction: rtl;/);
  assert.match(css, /\.onboarding-edit-modal\.condensed \.modal-header \{ min-height: 46px;/);
  assert.ok(!/\.offer-response-modal \{[^}]*border-radius: 9px/.test(css));
  // D2 — 대시보드 지표 카드 5장. 정규직 전환 예정 카드는 화면을 옮기지 않고 아래 전환 예정 표로 내려간다.
  const model = await readFile("app/hr-dashboard-model.ts", "utf8");
  assert.ok(model.includes('{ key: "renewal", icon: "전", tone: "purple", label: "정규직 전환 예정", value: renewals.length,'));
  assert.ok(source.includes('if (metric.key === "renewal") scrollToAnchor(event, "renewal");'));
  assert.ok(css.includes(".metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }"));
});

test("급여월 현황의 상태 칸은 눌러서 바로 검토 요청·마감 잠금을 고를 수 있고, 상세 화면과 같은 변경 규칙을 쓴다", async () => {
  const source = await readFile("app/hr-workspace.tsx", "utf8");
  const css = await readFile("public/hr-workspace.css", "utf8");
  assert.ok(source.includes("function PayrollStatusCell({ summary, busy, onChange }"));
  // 선택지는 서버의 allowedTransitions 와 같은 표에서 나온다 — 작성 중에서 곧바로 마감 잠금까지 갈 수 있다.
  assert.ok(source.includes("payrollStatusTransitions[summary.status].map((status) => <option key={status} value={status}>"));
  assert.ok(source.includes('DRAFT: ["DRAFT", "REVIEW", "LOCKED"],'));
  // 재개방 사유·전자결재 안내는 한 함수에 있고, 목록과 상세가 둘 다 그 함수를 부른다.
  assert.equal(source.split("await requestPayrollStatusChange(").length - 1, 2);
  assert.ok(source.includes('<td className="payroll-status-cell"><PayrollStatusCell summary={summary} busy={busyMonth === summary.yearMonth}'));
  // 상태 칸의 클릭·키 입력은 행(상세 열기)으로 번지지 않는다.
  assert.ok(source.includes('onClick={(event) => { event.stopPropagation(); setEditing(true); }} onKeyDown={stop}'));
  assert.ok(css.includes(".payroll-status-button:hover .status-pill"));
});

test("offer creation follows the linked requisition organization and counts onboarded hires toward headcount", async () => {
  const recruitment = await read("app/api/hr/recruitment/route.ts");
  const requisitions = await read("app/api/hr/recruitment-requisitions/route.ts");
  // 잔여 인원 계산은 입사 예정(ACCEPTED)뿐 아니라 입사 완료(ONBOARDED)도 자리를 차지한 것으로 센다.
  assert.doesNotMatch(recruitment, /requisition_id = \? AND o\.status = 'ACCEPTED'/);
  assert.match(recruitment, /requisition_id = \? AND o\.status IN \('ACCEPTED', 'ONBOARDED'\)/);
  assert.match(recruitment, /accepted_offer\.status IN \('ACCEPTED', 'ONBOARDED'\)/);
  assert.match(requisitions, /CASE WHEN o\.status IN \('ACCEPTED', 'ONBOARDED'\) THEN a\.id END\) AS filled_count/);
  const workspace = await read("app/hr-workspace.tsx");
  // 처우 제안 소속 기본값은 연결된 채용요청의 조직이다. 조직 목록 첫 항목을 쓰면 서버가 조직 불일치로 거부한다.
  assert.match(workspace, /const linkedDepartment = organizations\.find\(\(item\) => item\.id === linkedRequisition\?\.organizationId\)\?\.name \?\? ""/);
  assert.doesNotMatch(workspace, /department: organizations\[0\]\?\.name \?\? "", employmentType/);
  assert.match(workspace, /<select value=\{linkedDepartment\} disabled/);
  // 저장이 거부되면 팝업을 닫지 않고 사유를 보여 준다. 콜백은 실패 사유(성공은 null)를 돌려준다.
  assert.match(workspace, /onSubmitOffer: \(applicantId: string, draft: RecruitmentOfferDraft\) => Promise<string \| null>/);
  assert.match(workspace, /if \(failure\) \{ setOfferError\(failure\); return; \}/);
  assert.match(workspace, /className="applicant-screening-hint offer-error" role="alert"/);
});

test("demo USB packager ships the app without secrets and with the files the dev server needs", async () => {
  const packager = await read("scripts/Package-XDNodeDemo.ps1");
  // 비밀 값(.env*)은 옮기지 않고 로컬 신원 두 줄만 새로 쓴다.
  assert.match(packager, /"\.env\*"/);
  assert.match(packager, /LOCAL_ERP_USER_EMAIL\|LOCAL_ERP_USER_NAME/);
  // vite.config.ts 가 ./build/sites-vite-plugin 과 ./.openai/hosting.json 을 불러오므로 build 는 제외 목록에 없어야 한다.
  assert.doesNotMatch(packager, /"dist", "build"/);
  assert.match(packager, /sites-vite-plugin/);
  // 260자를 넘는 경로에서는 workerd 가 DB 파일을 열지 못한다. 패키저가 미리 막는다.
  assert.match(packager, /\$AppPath\.Length \+ 130\) -gt 250/);
  // 동봉 Node 를 PATH 앞에 두고 기존 실행 스크립트를 그대로 부른다.
  assert.match(packager, /runtime\\node;%PATH%/);
  assert.match(packager, /Start-XDNodeERP\.ps1/);
});

test("no browser-side code calls the desktop-only Claude bridges directly", async () => {
  // 브라우저가 127.0.0.1 다리를 직접 부르면 태블릿 등 다른 기기에서는 그 기기 자신을 가리켜 실패한다.
  // AI 호출은 모두 서버 라우트(/api/assistant, /api/hr/resume-analysis)를 거친다.
  const uiFiles = ["app/hr-workspace.tsx", "app/local-codex-assistant.tsx", "app/page.tsx", "app/compensation-calculator.tsx", "app/recruitment-requisition-view.tsx"];
  for (const file of uiFiles) {
    const source = await read(file);
    assert.doesNotMatch(source, /127\.0\.0\.1|localhost:31[0-9]{2}/, `${file}: 로컬 다리를 직접 부른다`);
    assert.doesNotMatch(source, /npm run assistant/, `${file}: 사용자에게 터미널 명령을 안내한다`);
  }
  const workspace = await read("app/hr-workspace.tsx");
  assert.match(workspace, /fetch\("\/api\/assistant", \{/);
});

test("wage calculator can append new hires from HR records without rebuilding the roster", async () => {
  const route = await read("app/api/hr/compensation/route.ts");
  // GET ?include=hr 은 그 달의 HR 급여 대상만 돌려주고 임금안은 건드리지 않는다.
  assert.match(route, /searchParams\.get\("include"\) === "hr"/);
  assert.match(route, /hrEmployees: await hrPayrollSnapshots\(period\)/);
  const calculator = await read("app/compensation-calculator.tsx");
  assert.match(calculator, /HR에서 인원 추가/);
  assert.match(calculator, /include=hr/);
  // 이미 표에 있는 사람(사번 같거나 이름·입사일 같음)은 후보에서 빼고, 고른 사람은 기존 행 뒤에 붙인다.
  assert.match(calculator, /function alreadyListed/);
  assert.match(calculator, /\[\.\.\.current, \.\.\.picked/);
  // 확정된 임금안에는 붙이지 않는다 — LOAD_HR 과 같은 규칙.
  assert.match(calculator, /run\?\.status === "CONFIRMED"/);
});

test("wage table lets the meal allowance be typed for a month and reverted to automatic", async () => {
  const calculator = await read("app/compensation-calculator.tsx");
  // 자동 금액은 버튼이라 누르면 그 달 식대가 수기 입력으로 바뀐다. 시작값은 자동 계산값이다.
  assert.match(calculator, /className="allowance-value" title="[^"]*" onClick=\{\(\) => \{ setMealEditingId\(employee\.id\); updateMonthly\(employee\.id, "meal", row\.meal\)/);
  assert.match(calculator, /focusOnEdit=\{mealEditingId === employee\.id\}/);
  const wonInput = await read("app/won-input.tsx");
  assert.match(wonInput, /if \(focusOnEdit\) inputRef\.current\?\.focus\(\)/);
  const calculatorCss = await read("app/compensation-calculator.css");
  assert.match(calculatorCss, /\.allowance-cell input\.money-input \{ width: 92px/);
  // 되돌리기는 0을 넣는 게 아니라 월별 값을 지운다.
  assert.match(calculator, /function clearMonthly/);
  assert.match(calculator, /className="allowance-auto"[^>]*onClick=\{\(\) => clearMonthly\(employee\.id, "meal"\)/);
  const engine = await read("app/compensation-calculation.ts");
  assert.match(engine, /monthly\.meal !== undefined \? monthly\.meal : allowance\(employee\.meal\)/);
});

test("연차관리 라우트는 권한·감사 가드를 거치고, 발생은 저장하지 않고 엔진이 계산하며 차감 제외 종류를 구분한다", async () => {
  const route = await readFile("app/api/hr/leave/route.ts", "utf8");
  const engine = await readFile("app/hr-leave-accrual.ts", "utf8");
  assert.match(route, /authorizeErpRequest\(db, "hr", "read"\)/);
  assert.match(route, /authorizeErpRequest\(db, "hr", "write"\)/);
  for (const action of ["LEAVE_RECORDED", "LEAVE_GRANT_ADJUSTED", "LEAVE_SHEET_IMPORTED", "LEAVE_RECORD_DELETED"]) assert.ok(route.includes(action), action);
  // 회사 결정: 법정 가산, 1년 소멸, 생일 반차·공가 미차감, 자동 부여(조정 표만 저장), HR 대리 입력(바로 APPROVED).
  assert.ok(engine.includes("annualDays: 15, seniorityIncrement: true, maxAnnualDays: 25, expiryMonths: 12"));
  assert.ok(engine.includes('BIRTHDAY_HALF: { label: "생일 반차", units: 0.5, deducts: false'));
  assert.ok(route.includes("CREATE TABLE IF NOT EXISTS hr_leave_grant_adjustments"));
  assert.ok(!route.includes("hr_leave_grants ("));
  assert.ok(route.includes("VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?)"));
  assert.ok(route.includes("ADD COLUMN deducts INTEGER NOT NULL DEFAULT 1"));
  // R1(Design §12.3): 삭제는 결재 테이블을 읽지 않는다. 새 DB 에서 'no such table' 500 이 나던 곳이다.
  assert.ok(!route.includes("erp_approval_requests"));
  assert.ok(!route.includes("전자결재를 거친 휴가 신청은 결재에서 취소해 주세요."));
});

test("연차관리 화면은 사이드바·인사기록카드에 연결되고, 직원 카드 팝업은 공통 팝업 규칙을 따른다", async () => {
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  const view = await readFile("app/hr-leave-view.tsx", "utf8");
  const css = await readFile("public/hr-workspace.css", "utf8");
  assert.ok(workspace.includes('{ id: "leave", label: "연차관리", icon: "연" }'));
  assert.ok(workspace.includes('{active === "leave" && <LeaveManagementView onNotify={showToast} />}'));
  assert.ok(workspace.includes("<LeaveLedgerPanel employeeId={employee.id} onNotify={onNotify} />"));
  // 기록 추가는 HR 대리 입력이라 결재 없이 바로 저장되고, 촉진 안내문은 복사해서 하이웍스 메일로 보낸다.
  assert.ok(view.includes('resource: "record", employeeId: ledger.employeeId'));
  assert.ok(view.includes("navigator.clipboard.writeText(item.text)"));
  assert.ok(view.includes('resource: "adjustment", employeeId: ledger.employeeId, grantKey: grant.key, status: "EXCLUDED"'));
  assert.match(css, /\.leave-card-modal \{[^}]*direction: rtl;/);
  assert.match(css, /\.leave-card-modal\.condensed \.modal-header \{ min-height: 46px;/);
});

test("퇴직 정산의 미사용 연차는 연차관리 엔진이 퇴직일 기준으로 계산해 미리 채운다", async () => {
  const operations = await readFile("app/api/hr/operations/route.ts", "utf8");
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  assert.ok(operations.includes("exitDate: retirementDate, today: retirementDate,"));
  assert.ok(operations.includes("usedLeaveUnits: ledger.used, unusedLeaveDays: ledger.balance,"));
  assert.ok(!operations.includes("leave_type IN ('ANNUAL', 'HALF_AM', 'HALF_PM')"));
  assert.ok(workspace.includes("const suggestedDays = computed ? computed.unusedLeaveDays : 0;"));
  assert.ok(workspace.includes("연차관리 잔여 {estimate.unusedLeaveDays}일 적용"));
});

test("대표이사는 연차 관리 대상에서 빠지고, 연차 촉진·초과 사용은 대시보드 대기함으로 간다", async () => {
  const route = await readFile("app/api/hr/leave/route.ts", "utf8");
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  assert.ok(route.includes('const LEAVE_EXEMPT_POSITIONS = ["대표", "대표이사"];'));
  assert.ok(route.includes("result.results.filter((row) => !LEAVE_EXEMPT_POSITIONS.includes(row.position.trim()))"));
  assert.ok(workspace.includes("leaveLedgers={leaveLedgers} roles={principalRoles}"));
});

test("임금계산 1단계 수정: 버전 가드, 퇴직일 두 출처, 음수 실지급 허용, 연봉 산식 고정, 올림 기본급", async () => {
  const route = await readFile("app/api/hr/compensation/route.ts", "utf8");
  const operations = await readFile("app/api/hr/operations/route.ts", "utf8");
  const engine = await readFile("app/compensation-calculation.ts", "utf8");
  // H1 — 라인 저장·삭제와 확정 시 급여기록 교체가 모두 임금안 버전 가드 아래 있다.
  assert.ok(route.includes("SELECT ?, ?, ?, ?, ? WHERE ${draftGuard}"));
  assert.ok(route.includes("FROM hr_payroll_records WHERE year_month = ? AND ${confirmedGuard}"));
  assert.ok(route.includes("WHERE ${confirmedGuard}`)"));
  // H3 — 퇴직 정산 반영은 DRAFT 일 때만, 버전을 올려 열려 있는 화면의 자동 저장을 막는다.
  assert.ok(operations.includes("UPDATE hr_compensation_runs SET version = version + 1, gross_pay = ?, settings_json = ?, updated_at = ? WHERE period = ? AND status = 'DRAFT' AND version = ?"));
  // H4 — 확정 INSERT 가 쓰는 열을 이 라우트도 보강한다.
  assert.ok(route.includes("ADD COLUMN personal_expense INTEGER NOT NULL DEFAULT 0"));
  // H6·H8 — 실지급만 음수 허용, 연봉이 있으면 항상 연봉 산식.
  assert.ok(route.includes('money(row[field], field === "total")'));
  assert.ok(route.includes("manualBasic: employee.annual_salary <= 0"));
  // H7 — 만근 기본급은 계약서와 같은 올림.
  assert.ok(engine.includes("Math.ceil(employee.annualSalary * segments[0].rate / 12) - allowanceMonthly"));
});

test("브라우저 기본 대화상자는 앱 내부 대화상자(app/erp-dialog.tsx)로 바뀌고, HR·임금계산 트리에 공급자가 있다", async () => {
  const dialog = await readFile("app/erp-dialog.tsx", "utf8");
  assert.ok(dialog.includes("export function ErpDialogProvider") && dialog.includes("export function useErpDialog"));
  assert.ok(dialog.includes("minLength") && dialog.includes('event.key === "Escape"'));
  for (const file of ["app/hr-workspace.tsx", "app/compensation-calculator.tsx", "app/recruitment-requisition-view.tsx", "app/hr-leave-view.tsx"]) {
    const source = await readFile(file, "utf8");
    assert.ok(!/window\.(confirm|alert|prompt)\(/.test(source), `${file} still uses a browser dialog`);
  }
  const hr = await readFile("app/hr-workspace.tsx", "utf8");
  assert.ok(hr.includes("<ErpDialogProvider>") && hr.includes("requestPayrollStatusChange(dialog, "));
  const wage = await readFile("app/compensation-calculator.tsx", "utf8");
  assert.ok(wage.includes("<ErpDialogProvider><CompensationCalculatorBody"));
  // 사유 입력은 5자 이상을 대화상자 단계에서 막는다 (채용요청 마감·취소·삭제).
  const requisition = await readFile("app/recruitment-requisition-view.tsx", "utf8");
  assert.ok(requisition.includes("minLength: 5, multiline: true"));
  for (const css of ["public/hr-workspace.css", "app/globals.css"]) assert.ok((await readFile(css, "utf8")).includes(".erp-dialog-actions .erp-dialog-primary"));
});

test("hr_employee_records 정의는 app/hr-employee-schema.ts 한 곳뿐이고 HR 라우트 8곳이 그 헬퍼를 부른다", async () => {
  const routes = ["employee-records", "operations", "compensation", "recruitment", "recruitment-requisitions", "performance", "training", "workforce-plans"];
  for (const name of routes) {
    const source = await readFile(`app/api/hr/${name}/route.ts`, "utf8");
    assert.ok(source.includes("await ensureHrEmployeeRecordsSchema(db);"), `${name} does not use the shared schema`);
    assert.ok(!source.includes("CREATE TABLE IF NOT EXISTS hr_employee_records"), `${name} still defines hr_employee_records`);
    assert.ok(!source.includes("PRAGMA table_info(hr_employee_records)"), `${name} still alters hr_employee_records itself`);
  }
  const schema = await readFile("app/hr-employee-schema.ts", "utf8");
  for (const column of ["annual_salary", "first_term_pay_percent", "regular_contract_date", "first_term_review_json"]) {
    assert.ok(schema.includes(`${column} `) && schema.includes(`["${column}",`), `${column} missing from CREATE or ADDITIONS`);
  }
});

test("합격 안내 메시지의 회신 기한은 입사예정일을 넘지 않도록 자동 조정된다", async () => {
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  assert.ok(workspace.includes("function clampOfferReplyDue(replyDue: string, startDate: string"));
  // 문구에 들어가는 값과 날짜 입력칸의 max 가 모두 같은 규칙(입사 전날)을 따른다.
  assert.ok(workspace.includes("replyDue: clampOfferReplyDue(offerReplyDue, activeOffer.startDate)"));
  assert.ok(workspace.includes("max={/^\\d{4}-\\d{2}-\\d{2}$/.test(activeOffer.startDate) ? shiftIsoDate(activeOffer.startDate, -1) : undefined}"));
  assert.ok(workspace.includes("입사예정일에 맞춰"));
  // 규칙 자체를 실행해 본다: 기본값이 입사일을 넘기면 입사 전날, 그 날이 지났으면 오늘.
  const source = workspace.slice(workspace.indexOf("function shiftIsoDate"), workspace.indexOf("/** 합격 안내 메시지의 값들"));
  const { clampOfferReplyDue } = new Function(`${source.replace(/: string|: number|, today = todayIsoDate\(\)/g, "").replace(/\(replyDue, startDate\)/, "(replyDue, startDate, today)")}; return { clampOfferReplyDue };`)();
  assert.equal(clampOfferReplyDue("2026-10-05", "2026-10-01", "2026-09-22"), "2026-09-30");
  assert.equal(clampOfferReplyDue("2026-09-25", "2026-10-01", "2026-09-22"), "2026-09-25");
  assert.equal(clampOfferReplyDue("2026-10-05", "2026-09-22", "2026-09-22"), "2026-09-22");
  assert.equal(clampOfferReplyDue("2026-10-05", "", "2026-09-22"), "2026-10-05");
});

test("입·퇴사 관리의 입사 예정자 이름을 누르면 지원자 관리와 같은 지원·면접 기록 팝업이 뜬다", async () => {
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  const styles = await readFile("public/hr-workspace.css", "utf8");
  // 팝업은 앱 최상위가 한 벌만 띄우고, 입·퇴사 화면은 지원자 ID 만 넘긴다.
  assert.match(workspace, /<LifecycleManagementView jobTitles=\{jobTitles\} ranks=\{ranks\} onSelectApplicant=\{setSelectedApplicantId\} applicantPopupOpen=\{Boolean\(selectedApplicantId\)\} \/>/);
  assert.match(workspace, /className="name-link lifecycle-applicant-link" title="지원·면접 기록 보기" onClick=\{\(\) => onSelectApplicant\(candidate\.applicantId\)\}/);
  // 팝업을 닫으면 입·퇴사 표를, 입사 완료·취소·수정 뒤에는 앱의 지원자 목록을 다시 읽는다.
  assert.match(workspace, /if \(applicantPopupWasOpen\.current && !applicantPopupOpen\) void load\(\);/);
  assert.match(workspace, /window\.dispatchEvent\(new Event\("hr-recruitment-updated"\)\);\r?\n    await load\(\);\r?\n    return true;/);
  assert.match(styles, /\.lifecycle-onboarding-table \.lifecycle-applicant-link \{/);
});

test("면접일이 확정되면 기본 질문지가 채워지고, 심화·역제안 질문은 각각의 버튼으로 덧붙인다", async () => {
  const workspace = await readFile("app/hr-workspace.tsx", "utf8");
  const bridge = await readFile("scripts/codex-assistant-bridge.mjs", "utf8");
  const styles = await readFile("public/hr-workspace.css", "utf8");
  // 1) 면접일을 입력하면 질문지가 비어 있을 때만 지원 포지션 기본 질문지를 채운다. 일정이 이미 잡힌 지원자는 팝업을 열 때 채운다.
  assert.match(workspace, /import \{ buildDefaultInterviewQuestions \} from "\.\/hr-interview-question-templates";/);
  assert.match(workspace, /onChange=\{\(event\) => changeInterviewDate\(event\.target\.value\)\}/);
  assert.match(workspace, /const sheet = date && !schedule\.questions\?\.trim\(\) \? defaultQuestionsFor\(draft\.role \|\| applicant\.role, draft\.requisitionId\) : null;/);
  assert.match(workspace, /&& \[SCREENING_PASSED_STAGE, "면접"\]\.includes\(applicant\.stage\)\);/);
  // 2) 심화 질문은 지금까지의 질문지와 면접 메모를 넘기고, 구분선 아래에 덧붙인다.
  assert.match(workspace, /onClick=\{\(\) => void generateInterviewQuestions\("DEEP_DIVE"\)\}/);
  assert.match(workspace, /existingQuestions: \(schedule\.questions \?\? ""\)\.slice\(0, 6000\), interviewNotes/);
  assert.match(workspace, /const DEEP_QUESTION_SEPARATOR = "--------------- 심화 면접 질문 ---------------";/);
  // 3) 역제안 질문은 역제안 포지션을 적어야 켜지고, 그 포지션만 넘긴다.
  assert.match(workspace, /disabled=\{questionStatus !== "idle" \|\| !applicant\.resumeText \|\| !schedule\.counterProposal\?\.trim\(\)\}/);
  assert.match(workspace, /onClick=\{\(\) => void generateInterviewQuestions\("COUNTER"\)\}/);
  assert.match(workspace, /\.\.\.\(mode === "COUNTER" && schedule\.counterProposal\?\.trim\(\) \? \{ counterProposalPosition:/);
  // 어시스턴트는 questionMode 에 맞춰 질문 구성을 바꾼다.
  assert.match(bridge, /interviewBrief\.questionMode 가 DEEP_DIVE 이면 기본 질문지 다음 단계의 심화 질문 요청입니다\./);
  assert.match(bridge, /questionMode 가 COUNTER 이면 counterProposalPosition 에 대한 질문만/);
  assert.match(styles, /\.applicant-question-buttons \{/);
});

// R1(M1-3, Design §7.9·§12.5): 직원 명부·보상 시드는 서버 전용 모듈에만 두고, 클라이언트는 카탈로그만 import한다.
// 빌드 산출물 전수 검사(bundle-exposure)는 r1-delete에서 추가한다.
test("employee roster seed is server-only and client screens load employees from the API", async () => {
  const [data, catalogs, workspace, incentive, harness] = await Promise.all([
    read("app/hr-company-data.ts"), read("app/hr-company-catalogs.ts"), read("app/hr-workspace.tsx"),
    read("app/incentive/incentive-calculator.tsx"), read("tests/helpers/hr-api-harness.mjs"),
  ]);
  assert.match(data, /^import "server-only";/);
  assert.match(data, /export \{ companyOrganizations, companyRanks, companyJobTitles, type CompanyOrganizationSeed \} from "\.\/hr-company-catalogs";/);
  assert.match(data, /export const companyEmployees: CompanyEmployeeSeed\[\]/);
  assert.doesNotMatch(data, /export const (companyOrganizations|companyRanks|companyJobTitles)\b/);
  for (const name of ["companyOrganizations", "companyRanks", "companyJobTitles"]) assert.match(catalogs, new RegExp(`export const ${name}\\b`));
  assert.match(catalogs, /export type CompanyOrganizationSeed = \{/);
  assert.doesNotMatch(catalogs, /server-only|companyEmployees|annualSalary|phone/);
  assert.match(workspace, /from "\.\/hr-company-catalogs";/);
  assert.doesNotMatch(workspace, /hr-company-data|companyEmployees/);
  assert.match(workspace, /const initialEmployees: Employee\[\] = \[\];/);
  assert.match(workspace, /fetch\("\/api\/hr\/employee-records"\)/);
  assert.match(workspace, /직원 정보를 불러오는 중입니다/);
  assert.doesNotMatch(incentive, /hr-company-data|companyEmployees|COMPANY_EMPLOYEE_OPTIONS/);
  assert.match(incentive, /if \(!response\.ok\) throw new Error\(data\.error \|\| "직원 목록을 불러오지 못했습니다\."\)/);
  assert.match(incentive, /role="alert">\{employeesError\}/);
  assert.match(harness, /'server-only'\]\.includes\(specifier\)/);
});
