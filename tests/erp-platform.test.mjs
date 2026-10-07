import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

const UNAUDITED_PERSONAL_ROUTES = ["chat/read-state/route.ts", "chat/me/route.ts"];
const READ_ONLY_COMPUTE_ROUTES = ["quote/compute/route.ts"];

test("every mutating API route calls the authorization helper and writes an audit trail", async () => {
  // R1(Design §8.7): 삭제된 재무·영업 라우트 목록 대신, 남은 app/api 라우트 전부를 훑는다.
  const entries = await readdir(new URL("../app/api/", import.meta.url), { recursive: true });
  const routes = entries.map((entry) => entry.replaceAll("\\", "/")).filter((entry) => entry.endsWith("/route.ts")).sort();
  assert.ok(routes.length >= 20, `route scan found only ${routes.length} files`);
  let mutating = 0;
  for (const route of routes) {
    const source = await read(`app/api/${route}`);
    if (!/export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE)\b/.test(source)) continue;
    mutating += 1;
    if (route.startsWith("auth/")) {
      // R3(Design §4.3.2): 인증 라우트는 authorizeErpRequest 대신 게이트와 교차 출처 검사를 직접 부른다.
      assert.match(source, /platformSchemaReady\(db\)/, `${route}: missing platformSchemaReady`);
      assert.match(source, /crossSiteViolation\(requestHeaders\)/, `${route}: missing crossSiteViolation`);
    } else {
      assert.match(source, /authorizeErpRequest\(/, `${route}: missing authorizeErpRequest`);
    }
    // R5(Design §4.2.8): 읽음 위치 PUT 은 감사하지 않는다(읽을 때마다 감사 행이 쌓이지 않게).
    // messenger-enhancement(ME-MD9, DD14): 나만 보는 개인 상태(알림 수준·스레드 읽음·북마크)의 chat/me 도 같다. 예외는 이 두 파일뿐이다.
    if (UNAUDITED_PERSONAL_ROUTES.includes(route)) { assert.doesNotMatch(source, /writeErpAudit\(/, route); continue; }
    // quote-tool QT-Q11(Design §3.5): 읽기만 하는 계산(단가 제안 등)의 POST 는 감사하지 않는다. 아래 소스 가드가 읽기 전용을 강제한다.
    if (READ_ONLY_COMPUTE_ROUTES.includes(route)) { assert.doesNotMatch(source, /writeErpAudit\(/, route); continue; }
    assert.match(source, /writeErpAudit\(/, `${route}: missing writeErpAudit`);
  }
  assert.ok(mutating >= 20, `only ${mutating} mutating routes found`);
});

test("read-only compute routes (quote-tool QT-Q11) cannot write: no audit, no batch/run, no R2, no mutating SQL, allow-listed imports only", async () => {
  const allowed = new Set(["cloudflare:workers", "../../../erp-platform", "../../../quote-schema", "../../../quote-server", "../../../quote-model",
    "../../../quote-pricing", "../../../quote-recommend"]);
  for (const route of READ_ONLY_COMPUTE_ROUTES) {
    const source = await read(`app/api/${route}`);
    assert.match(source, /authorizeErpRequest\(db, "quote", "read"\)/, route);
    assert.match(source, /ensureQuoteSchema\(db\)/, route);
    for (const forbidden of [/writeErpAudit\(/, /\.run\(/, /\.batch\(/, /HR_AUDIO/, /quote-store/, /\bexecute\(/]) assert.doesNotMatch(source, forbidden, `${route}: ${forbidden}`);
    // 주석·문자열을 가리지 않고 파일 전체에서 SQL 변경 키워드를 찾는다(대소문자 무시). ensureQuoteSchema 는 이름으로만 부른다.
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE)\b/i, `${route}: mutating SQL keyword`);
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    assert.ok(imports.length >= 3, `${route}: import scan found ${imports.length}`);
    for (const specifier of imports) assert.ok(allowed.has(specifier), `${route}: import ${specifier} is not allowed in a read-only compute route`);
    assert.doesNotMatch(source, /\bimport\(/, `${route}: dynamic import`);
  }
});

test("retirement effectiveness and compensation confirmation are server-controlled", async () => {
  const [retirement, operations, employees, compensation, calculator, calculatorCss, workspace, wonInput, migration, settingsMigration, defaultsMigration] = await Promise.all([
    read("app/hr-retirements.ts"), read("app/api/hr/operations/route.ts"), read("app/api/hr/employee-records/route.ts"),
    read("app/api/compensation/route.ts"), read("app/compensation-calculator.tsx"), read("app/compensation-calculator.css"), read("app/hr-workspace.tsx"),
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
  // 첫 계약 종료일은 시작일 + 3개월 − 1일이고, 끝나는 달에 같은 날이 없으면 그 달 말일이다(2026-09-28 확정). 화면에서 고르지 않고 계산한다.
  assert.match(contract, /if \(start\.getDate\(\) > lastDayOfEndMonth\.getDate\(\)\) return isoDate\(lastDayOfEndMonth\);/);
  assert.match(contract, /startDate: resolvedKind === "FIXED_TERM" \? joined : firstTermNextStart\(joined\),/);
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
  const compensationRoute = await read("app/api/compensation/route.ts");
  // R3: 라우트가 app/api/compensation 으로 옮겨 상대 경로가 한 단계 줄었다.
  assert.match(compensationRoute, /import \{ FIXED_TERM_MONTHS, fixedTermEndDate \} from "\.\.\/\.\.\/hr-employment-contract";/);
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
  assert.match(workspace, /import \{ buildEmploymentContract, contractFileName, contractKindLabels, contractPay, contractTokens, defaultContractOptions, downloadBlob, FIXED_TERM_MONTHS, firstTermNextStart, fixedTermEndDate, type ContractKind, type ContractOptions \} from "\.\/hr-employment-contract";/);
  // 대시보드의 정규직 전환일은 첫 계약 종료 다음 날이다 — 월말 입사자도 종료일과 겹치지 않는다.
  assert.match(workspace, /firstTerm: \(joinDate\) => \(\{ endDate: fixedTermEndDate\(joinDate\), nextStart: firstTermNextStart\(joinDate\) \}\),/);
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
  const launcher = await read("scripts/Start-XDNodeManagement.ps1");
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
  // R3(D23): 업무 영역은 쿼리로 보내고, 서버는 본문보다 먼저 그 값으로 인가한다.
  assert.match(assistantUi, /fetch\(`\$\{assistantEndpoint\}\?module=\$\{encodeURIComponent\(module\)\}`, \{/);
  assert.doesNotMatch(assistantUi, /const bridgeUrl = /);
  // 서버 라우트가 다리를 대신 부른다 — 권한 검사와 감사 기록을 다른 라우트와 같은 규약으로 거친다.
  const assistantRoute = await read("app/api/assistant/route.ts");
  // R3(D23, §4.2.7): 쿼리 module → ASSISTANT_MODULES(레지스트리) → 임금 계산·인센티브는 compensation 탭으로 인가한다.
  assert.match(assistantRoute, /authorizeErpRequest\(bindings\.DB, permissionModule, "read"\)/);
  assert.match(await read("app/access-tabs.ts"), /ASSISTANT_MODULES = \{ hr: "hr", compensation: "compensation", incentive: "compensation" \}/);
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
  // general-affairs GD-11: 정산 패널은 직원 id 도 받아 미반납 지급 자산을 보여 준다.
  assert.match(workspace, /<RetirementSettlementPanel requestId=\{request\.id\} employeeId=\{request\.employee_id\} retirementDate=\{request\.retirement_date\} \/>/);
  // 퇴직 절차 팝업에서도 확정된 마지막 근무일을 바꿀 수 있다(2026-10-01).
  assert.match(workspace, /onChangeDate=\{\(date\) => changeRetirementDate\(openRetirement, date\)\}/);
  assert.match(workspace, /<span>퇴직일<\/span><strong>\{retirementDayAfter\(request\.retirement_date\)\}/);
  assert.doesNotMatch(workspace, /expandedCards|toggleCard\(/);
  assert.match(styles, /\.retirement-process-modal \{[^}]*max-height: 92vh/);
  assert.match(styles, /\.lifecycle-board \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 900px\) \{ \.lifecycle-board \{ grid-template-columns: 1fr;/);
});

test("runtime API column names stay aligned with the Drizzle production schema", async () => {
  const hrOperations = await read("app/api/hr/operations/route.ts");
  for (const column of ["before_json", "after_json", "task_group", "owner_employee_id", "due_date"]) {
    assert.match(hrOperations, new RegExp(column));
  }
  assert.doesNotMatch(hrOperations, /from_department|event_date|owner_type|evidence_document_id/);
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
  // R3(D13): 상태 변경도 hr 편집이다. 리소스별 write/approve 분기 없이 본문보다 먼저 hr:write 로 한 번 인가한다.
  assert.match(api, /export async function PUT\(request: Request\) \{\s*\/\/[^\n]*\n\s*const authorization = await authorizeErpRequest\(db, "hr", "write"\);/);
  assert.doesNotMatch(api, /"approve"/);
  assert.match(api, /'RECORDED', 'MANUAL'/);
  assert.match(view, /자동연동 전까지 자료 출처는 수기 입력/);
  assert.match(view, /Math\.round\(Number\(leaveDraft\.units\) \* 100\)/);
});

test("post-approval HR workflows require explicit controls before completion", async () => {
  const [recruitment, hr, onboarding, workspace, migration] = await Promise.all([
    read("app/api/hr/recruitment/route.ts"),
    read("app/api/hr/operations/route.ts"), read("app/hr-onboarding.ts"),
    read("app/hr-workspace.tsx"), read("drizzle/0015_redundant_aqueduct.sql"),
  ]);
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
  assert.match(migration, /hr_retirement_settlements/);
});

test("payroll close stays inside HR and legacy finance-locked months cannot be reopened", async () => {
  const [payroll, workspace] = await Promise.all([read("app/api/hr/payroll/route.ts"), read("app/hr-workspace.tsx")]);
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

test("future personnel actions wait until their effective date and then apply once", async () => {
  const [activator, records] = await Promise.all([
    read("app/hr-personnel-actions.ts"), read("app/api/hr/employee-records/route.ts"),
  ]);
  assert.match(activator, /WHERE status = 'APPROVED' AND effective_date <= \?/);
  assert.match(activator, /status = 'EFFECTIVE'/);
  assert.match(activator, /PERSONNEL_ACTION_EFFECTIVE/);
  assert.match(records, /applyDuePersonnelActions\(db\)/);
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
  assert.match(api, /resource === "retirementDate"/);
  assert.match(api, /action: "RETIREMENT_DATE_CHANGED"/);
  assert.doesNotMatch(activator, /retirement_date <= \?/);
  // retirement_date 는 마지막 근무일이라 퇴직 처리는 그 다음 날부터다(<=  였다면 마지막 근무일 아침에 퇴직자가 된다).
  assert.match(activator, /WHERE retirement_date < \? AND \(status IN \('IN_PROGRESS', 'READY'\) OR \(status = 'EFFECTIVE'/);
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

test("workforce planning versions approved headcount and derives actual staffing from HR sources", async () => {
  const [api, view, workspace, schema, migration, transitions, plan] = await Promise.all([
    read("app/api/hr/workforce-plans/route.ts"), read("app/workforce-planning-view.tsx"),
    read("app/hr-workspace.tsx"), read("db/schema.ts"), read("drizzle/0039_workforce_planning.sql"),
    read("app/hr-transitions.ts"), read("docs/hr-workforce-planning-plan.md"),
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
  assert.match(transitions, /status = 'SUPERSEDED'/);
  assert.match(plan, /지원자 수는 채용 경쟁도이지 확보 인원이 아니므로/);
  // D2-a: 계획 문서도 결재 대신 즉시 반영 기준이다.
  assert.match(plan, /`DRAFT → APPROVED`로 확정한다/);
  assert.doesNotMatch(plan, /DRAFT → SUBMITTED → APPROVED/);
});

test("recruitment requisitions reserve approved gaps and link applicants through accepted offers", async () => {
  const [api, recruitment, view, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/hr/recruitment-requisitions/route.ts"), read("app/api/hr/recruitment/route.ts"),
    read("app/recruitment-requisition-view.tsx"), read("app/hr-workspace.tsx"), read("db/schema.ts"),
    read("drizzle/0040_recruitment_requisitions.sql"),
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
  // D2-a: 결재가 없어져 '기안'이 아니라 '요청'이다.
  assert.match(plan, /추가 요청 가능 = 계획 부족 - 예약 TO/);
  assert.doesNotMatch(plan, /결재 제출|진행 중 결재/);
});

test("performance management separates goals, reviews, calibration, approval and appeals", async () => {
  const [api, view, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/hr/performance/route.ts"), read("app/performance-management-view.tsx"),
    read("app/hr-workspace.tsx"), read("db/schema.ts"), read("drizzle/0041_performance_management.sql"),
    read("docs/hr-performance-management-plan.md"),
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
  assert.match(plan, /급여·승진·강등에 자동 반영하지 않는다/);
});

test("training management snapshots employees and requires evidence for mandatory completion", async () => {
  const [api, view, workspace, schema, migration, plan] = await Promise.all([
    read("app/api/hr/training/route.ts"), read("app/training-management-view.tsx"), read("app/hr-workspace.tsx"),
    read("db/schema.ts"), read("drizzle/0042_hr_training_management.sql"),
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
  // R3(§4.3.2): 인가 모듈은 리터럴 hr 이고, entityModules 는 감사 module 에만 쓴다.
  assert.match(api, /authorizeErpRequest\(bindings\.DB, "hr", "write"\)/);
  assert.doesNotMatch(api, /authorizeErpRequest\([^,]+, entityModules/);
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

test("enterprise audit trail is admin-only, paginated, redacted and immutable", async () => {
  const [api, workspace, shell, platform, schema, migration, plan] = await Promise.all([
    read("app/api/audit-log/route.ts"), read("app/audit-log-workspace.tsx"), read("app/page.tsx"),
    read("app/erp-platform.ts"), read("db/schema.ts"), read("drizzle/0060_erp_audit_trail.sql"),
    read("docs/erp-audit-trail-plan.md"),
  ]);
  assert.match(api, /authorizeErpRequest\(db, "audit", "read"\)/);
  assert.match(api, /ORDER BY a\.created_at DESC, a\.id DESC LIMIT 31/);
  assert.match(api, /a\.created_at < \? OR \(a\.created_at = \? AND a\.id < \?\)/);
  assert.match(api, /secretKey\.test\(key\)/);
  assert.match(api, /automaticMutation: false/);
  assert.doesNotMatch(api, /UPDATE erp_audit_logs|DELETE FROM erp_audit_logs/);
  assert.match(workspace, /통합 감사·변경이력/);
  assert.match(workspace, /다음 30건 보기/);
  assert.match(workspace, /보안 키 값은 서버에서 가려 표시/);
  // R1: data-governance-center 가 삭제되어 감사 로그는 셸의 '감사 로그' 탭으로 마운트된다(D2-c).
  assert.match(shell, /import AuditLogWorkspace from "\.\/audit-log-workspace"/);
  // R3: 탭 이름은 레지스트리(app/access-tabs.ts)에 있고, 셸은 레지스트리에서 탭을 그린다. 감사 로그는 관리자 전용 탭이다(D23).
  assert.match(await read("app/access-tabs.ts"), /\{ key: "audit", label: "감사 로그", glyph: "[^"]+", adminOnly: true, modules: \["audit"\]/);
  for (const source of [platform, schema, migration]) assert.match(source, /idx_erp_audit_created_id/);
  assert.match(plan, /조회는 관리자 전용 `audit:read` 권한/);
  assert.match(plan, /수정·삭제 경로가 없다/);
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
  assert.match(workspace, /fetch\("\/api\/assistant\?module=hr", \{/);
});

test("wage calculator can append new hires from HR records without rebuilding the roster", async () => {
  const route = await read("app/api/compensation/route.ts");
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
  assert.match(calculator, /className="allowance-value" title=\{`[^`]*`\} onClick=\{\(\) => \{ setEditingCell\(`\$\{employee\.id}:\$\{field}`\); updateMonthly\(employee\.id, field, row\[field\]\)/);
  assert.match(calculator, /focusOnEdit=\{editingCell === `\$\{employee\.id}:\$\{field}`\}/);
  const wonInput = await read("app/won-input.tsx");
  assert.match(wonInput, /if \(focusOnEdit\) inputRef\.current\?\.focus\(\)/);
  const calculatorCss = await read("app/compensation-calculator.css");
  assert.match(calculatorCss, /\.allowance-cell input\.money-input \{ width: 92px/);
  // 되돌리기는 0을 넣는 게 아니라 월별 값을 지운다.
  assert.match(calculator, /function clearMonthly/);
  assert.match(calculator, /className="allowance-auto"[^>]*onClick=\{\(\) => clearMonthly\(employee\.id, field\)/);
  // 기본급도 같은 방식으로 그 달 금액을 그대로 적는다(급여대장과 맞출 때). 수기 기본급(월 기준액)과는 다른 칸이다.
  assert.match(calculator, /updateMonthly\(employee\.id, "basicOverride", row\.basic\)/);
  assert.match(calculator, /clearMonthly\(employee\.id, "basicOverride"\)/);
  // 그 달 지급액 값은 다음 달로 이어받지 않는다.
  assert.match(calculator, /const MONTH_ONLY_FIELDS = new Set\(\["basicOverride", "car", "child"\]\)/);
  const engine = await read("app/compensation-calculation.ts");
  assert.match(engine, /monthly\.meal !== undefined \? monthly\.meal : allowance\(employee\.meal\)/);
  assert.match(engine, /if \(monthly\.basicOverride !== undefined\) basic = monthly\.basicOverride;/);
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
  // R3(Design §5.6): http LAN 은 보안 컨텍스트가 아니라 clipboard 가 없다. copyText() 가 execCommand 로 대신한다.
  assert.ok(view.includes("void copyText(item.text).then("));
  assert.ok(!view.includes("navigator.clipboard"));
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
  // R3: 대시보드의 역할 입력(roles)은 없어졌다(Design §8.7).
  assert.ok(workspace.includes("leaveLedgers={leaveLedgers} onNavigate"));
});

test("임금계산 1단계 수정: 버전 가드, 퇴직일 두 출처, 음수 실지급 허용, 연봉 산식 고정, 올림 기본급", async () => {
  const route = await readFile("app/api/compensation/route.ts", "utf8");
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
  // R3: 임금 계산 라우트는 app/api/compensation 으로 옮겼다.
  const routes = ["hr/employee-records", "hr/operations", "compensation", "hr/recruitment", "hr/recruitment-requisitions", "hr/performance", "hr/training", "hr/workforce-plans"];
  for (const name of routes) {
    const source = await readFile(`app/api/${name}/route.ts`, "utf8");
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

test("임금 계산은 수습(첫 계약) 표시를 인사기록과 맞춰 보고, 바로 고칠 버튼을 준다", async () => {
  const calculator = await readFile("app/compensation-calculator.tsx", "utf8");
  const engine = await readFile("app/compensation-calculation.ts", "utf8");
  const styles = await readFile("app/compensation-calculator.css", "utf8");
  // 임금안과 그 달 인사기록 스냅숏을 한 번에 받고, 월이 맞을 때만 점검에 쓴다.
  // R3(D20): 임금 계산 API 는 /api/compensation 으로 옮겼다.
  assert.match(calculator, /fetch\(`\/api\/compensation\?period=\$\{key\}&include=hr`\)/);
  assert.match(calculator, /const hrSnapshot = hrSnapshotState\?\.period === key \? hrSnapshotState\.employees : null;/);
  assert.match(calculator, /const probation = useMemo\(\(\) => reviewProbation\(rows, hrSnapshot, year, month\)/);
  for (const label of ["수습 누락", "수습 지급률 불일치", "수습 종료", "이 달 수습 종료", "첫 3개월 · 100% 지급"]) assert.ok(calculator.includes(`<b>${label} {`), label);
  assert.match(calculator, /onClick=\{\(\) => applyHrFixes\(probation\.missing\)\}>인사기록대로 맞추기<\/button>/);
  assert.match(calculator, /onClick=\{\(\) => applyHrFixes\(probation\.mismatch\)\}>인사기록대로 맞추기<\/button>/);
  assert.match(calculator, /onClick=\{\(\) => applyHrFixes\(probation\.ended\)\}>수습 해제<\/button>/);
  // 방법 1(2026-09-28 확정), 말일 규칙, 수습 칸이 곧 적용 여부.
  assert.match(engine, /\(fullMonthly - reducedMonthly\) \* segments\[0\]\.days \/ totalDays/);
  assert.match(engine, /if \(join\.getUTCDate\(\) > lastDay\) return new Date\(Date\.UTC\(year, targetMonth, lastDay\)\);/);
  assert.match(engine, /const endOfProbation = employee\.probationMonths > 0/);
  assert.match(styles, /\.wage-alerts>div\.info\{/);
  // 입·퇴사일도 인사기록카드와 대조한다(2026-09-28: 인사기록이 기준).
  assert.match(calculator, /const hrDates = useMemo\(\(\) => reviewHrDates\(rows, hrSnapshot\), \[rows, hrSnapshot\]\);/);
  assert.ok(calculator.includes("<b>입·퇴사일 불일치 {"));
  assert.match(calculator, /onClick=\{\(\) => applyHrFixes\(hrDates\)\}>인사기록대로 맞추기<\/button>/);
});

test("근로계약서 양식 제5조(휴일)는 2026-09-30 검토안대로 법 문구에 맞춘다", async () => {
  for (const kind of ["fixed-term", "regular"]) {
    const files = unzipSync(new Uint8Array(await readFile(`public/hr/employment-contract-${kind}.docx`)));
    const text = strFromU8(files["word/document.xml"]).replace(/<[^>]+>/g, "");
    const article5 = text.slice(text.indexOf("제 5 조"), text.indexOf("제 6 조"));
    // 주휴 요건은 시행령 제30조의 「개근」, 토요일 근로는 시간외근로 조항(제8조)으로 보낸다.
    assert.ok(article5.includes("1주 동안의 소정근로일을 개근한 경우 1일 소정근로시간(7시간)분의 유급휴일로 한다."), kind);
    assert.ok(article5.includes("휴일근로가 아닌 소정근로시간 외 근로로 보아 제8조에 따라 처리한다."), kind);
    assert.ok(!article5.includes("제7조에 따라 처리한다"), kind);
    assert.ok(article5.includes("관공서의 공휴일(일요일은 제외한다) 및 대체공휴일은 유급휴일로 한다."), kind);
    // 휴일 대체: 공휴일은 근로자대표 서면합의, 근로자의 날은 대체 불가.
    assert.ok(article5.includes("근로자대표와 서면으로 합의한 경우에만 특정한 근로일로 대체할 수 있으며, 근로자의 날은 대체하지 아니한다."), kind);
    assert.ok(article5.includes("⑤ 휴일에 근로한 경우 제8조에 따라 휴일근로 가산수당을 지급한다."), kind);
    // 같은 검토에서 고친 항 번호(제4조 ③·④, 번호 뒤 마침표)와 임금 지급일.
    assert.ok(text.includes("③ 시업·종업 및 휴게시간을") && text.includes("④ 1개월 평균 실제 소정근로시간은"), kind);
    assert.doesNotMatch(text, /[①②③④⑤]\. /, kind);
    assert.ok(text.includes("지급일이 휴일인 경우에는 직전 근로일에 지급"), kind);
  }
});
