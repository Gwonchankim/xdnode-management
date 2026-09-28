// SC-4 HR 회귀 시나리오 (xdnode-management: Plan §4.1 SC-4, Design §8.4 SC-4 행·§12.7 r1-verify).
//
// 운영 DB 에서는 절대 돌리지 않는다. 급여 LOCKED·재오픈, 퇴직 COMPLETED, 성과 확정, 인력계획 SUPERSEDED 처럼
// 되돌릴 수 없는 전이를 만든다. 별도 점검 인스턴스(R1: 3100 staging, R3: 3001 점검 인스턴스)에만 쓴다.
//
// 스스로 만든 합성 기록만 다룬다: 직원 id `sc4-<run>-a|b`, 이름 "SC4 테스트 …", 조직 "SC4 테스트 조직 …",
// 급여월은 2090~2099 의 빈 달, 인력계획은 계획이 없는 반기. 실제 직원 자료는 출력하지 않는다
// (응답 본문을 통째로 찍지 않고, 합성 기록의 상태값과 HTTP 상태만 찍는다).
//
// 한 번에 전부(날짜 도래·레거시 행이 필요한 단계는 SKIP):
//   node scripts/sc4-hr-regression.mjs --base http://127.0.0.1:3100
//
// 전 항목(권장). 서버로는 만들 수 없는 두 가지가 있어 서버를 멈춘 사이에 사본 DB 를 한 번 손본다:
//   (가) 시행일·퇴직일의 "도래": 미래 날짜로 등록한 발령·퇴직의 날짜를 오늘로 당겨 도래일 반영을 확인한다.
//   (나) 결재 시절의 레거시 행: PENDING 휴가 신청과 CALIBRATION 단계 성과주기(대상자 = 합성 직원 + 현재 사용자,
//        현재 사용자는 이의제기를 본인만 낼 수 있어서 필요하다). 새 코드에는 이 상태를 만드는 API 가 없다.
//   1) node scripts/sc4-hr-regression.mjs --base <url> --phase main --state <file.json>
//   2) 서버 정지 → node scripts/sc4-hr-regression.mjs --offline-prep <정지한 사본의 .wrangler/state> --state <file.json>
//   3) 서버 시작 → node scripts/sc4-hr-regression.mjs --base <url> --phase due --state <file.json>
//
// 재무·영업·결재 표의 행 수가 바뀌지 않았는지는 이 스크립트가 아니라, 서버를 멈춘 사본에 대해
// `node scripts/verify-state-snapshot.mjs <사본> --compare <실행 전 사본>` 으로 확인한다(DB 를 직접 읽지 않는다).
//
// 옵션: --cookie <값> 또는 환경변수 SC4_COOKIE — R3 세션 로그인 뒤 점검 인스턴스에 쓸 쿠키.
// 종료 코드: FAIL 이 있으면 1, FAIL 없이 SKIP 만 있으면 3, 전부 PASS 면 0. 사용법 오류는 2.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const BASE = (option("--base") ?? "").replace(/\/+$/, "");
const PHASE = option("--phase") ?? "all";
const STATE_FILE = option("--state");
const OFFLINE_DIR = option("--offline-prep");
const COOKIE = option("--cookie") ?? process.env.SC4_COOKIE ?? "";

function usage(message) {
  console.error(`${message}\n사용법: node scripts/sc4-hr-regression.mjs --base <url> [--phase all|main|due] [--state <file>]\n       node scripts/sc4-hr-regression.mjs --offline-prep <stoppedStateDir> --state <file>`);
  process.exit(2);
}
if (OFFLINE_DIR) { if (!STATE_FILE) usage("--offline-prep 에는 --state 가 필요합니다."); }
else {
  if (!/^https?:\/\/[^/]+$/.test(BASE)) usage("--base 가 필요합니다(예: http://127.0.0.1:3100).");
  if (!["all", "main", "due"].includes(PHASE)) usage("--phase 는 all, main, due 중 하나입니다.");
  if (PHASE !== "all" && !STATE_FILE) usage("--phase main|due 에는 --state 가 필요합니다.");
}

// ── 결과 출력 ─────────────────────────────────────────────────────────────────────────────────
const tally = { pass: 0, fail: 0, skip: 0 };
const short = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 140 ? `${text.slice(0, 140)}…` : text;
};
function report(kind, name, status, expected, actual, note = "") {
  tally[kind.toLowerCase()] += 1;
  const http = status === null || status === undefined ? "-" : String(status);
  console.log(`${kind.padEnd(4)} ${name} | HTTP ${http} | expected ${short(expected)} | actual ${short(actual)}${note ? ` | ${note}` : ""}`);
}
/** 한 단계. check 는 { status, expected, actual, ok } 를 돌려준다. 예외는 FAIL 로 적고 다음 단계로 간다. */
async function step(name, check) {
  try {
    const result = await check();
    report(result.ok ? "PASS" : "FAIL", name, result.status, result.expected, result.actual, result.ok ? "" : result.note ?? "");
    return result.ok;
  } catch (error) {
    report("FAIL", name, error.status ?? null, "no exception", error instanceof Error ? error.message : String(error));
    return false;
  }
}
const skip = (name, why) => report("SKIP", name, null, "-", "-", why);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** HTTP 상태와 합성 기록 상태를 함께 비교한다. 실패하면 서버의 error 문구(합성 기록 이름만 담긴다)를 덧붙인다. */
function expect(response, expectedStatus, expectedState, actualState) {
  const ok = response.status === expectedStatus && same(expectedState, actualState);
  const note = response.body && typeof response.body === "object" && typeof response.body.error === "string" ? `server error: ${short(response.body.error)}` : "";
  return { ok, status: response.status, expected: { http: expectedStatus, ...(expectedState === undefined ? {} : { state: expectedState }) }, actual: { http: response.status, ...(actualState === undefined ? {} : { state: actualState }) }, note };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────
async function api(method, path, body, { form = false, raw = false } = {}) {
  const headers = {};
  if (COOKIE) headers.Cookie = COOKIE;
  const init = { method, headers, redirect: "manual" };
  if (body !== undefined) {
    if (form) init.body = body;
    else { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  }
  const response = await fetch(`${BASE}${path}`, init);
  const type = response.headers.get("content-type") ?? "";
  const payload = raw || !type.includes("json") ? await response.text() : await response.json().catch(() => null);
  return { status: response.status, body: payload, headers: response.headers };
}
const koreaToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const FUTURE = "2099-12-31";

// ── 상태 파일(단계 사이에 합성 기록 id 를 넘긴다) ──────────────────────────────────────────────
const loadState = () => (STATE_FILE && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveState = (state) => { if (STATE_FILE) writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8"); };

// ── 인센티브 계산: 화면(app/incentive/incentive-calculator.tsx)의 계산 함수를 그대로 실행한다 ─────────
async function loadIncentiveCalculate() {
  const { default: ts } = await import("typescript");
  const source = readFileSync(new URL("../app/incentive/incentive-calculator.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("incentive.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["calculate", "roundIncentive"].includes(node.name?.text));
  if (functions.length !== 2) throw new Error("incentive-calculator.tsx 에서 calculate·roundIncentive 를 찾지 못했습니다.");
  const context = vm.createContext({});
  vm.runInContext(ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { calculate: context.calculate, roundIncentive: context.roundIncentive };
}

// ── 공용 조회(합성 기록만 골라낸다) ─────────────────────────────────────────────────────────────
async function employeeRecord(employeeId) {
  const response = await api("GET", "/api/hr/employee-records");
  const record = Array.isArray(response.body?.records) ? response.body.records.find((item) => item.employeeId === employeeId) : undefined;
  return { response, record };
}
async function operationsFor(employeeId) {
  const response = await api("GET", `/api/hr/operations?employeeId=${encodeURIComponent(employeeId)}`);
  return { response, body: response.body ?? {} };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// main 단계: API 만으로 끝나는 시나리오
// ════════════════════════════════════════════════════════════════════════════════════════════
async function phaseMain(state) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const employeeA = `sc4-${run}-a`;
  const employeeB = `sc4-${run}-b`;
  Object.assign(state, { run, employeeA, employeeB });

  // 0. 준비: 인증과 스키마(새 DB 에서도 표가 생긴다)
  await step("0.1 인증·HR 운영 조회(스키마 생성)", async () => {
    const response = await api("GET", "/api/hr/operations");
    state.principalEmployeeId = response.body?.principal?.employeeId ?? "";
    const roles = response.body?.principal?.roles ?? [];
    return expect(response, 200, { canWrite: true }, { canWrite: roles.includes("SUPER_ADMIN") || roles.includes("HR_ADMIN") });
  });
  for (const path of ["/api/hr/leave", "/api/hr/performance?year=2026", "/api/hr/workforce-plans", "/api/hr/recruitment-requisitions", "/api/hr/recruitment", "/api/hr/organizations"]) {
    await step(`0.2 조회 ${path.split("?")[0]}`, async () => expect(await api("GET", path), 200));
  }

  // 1. 조직 수정 (직원 부서명이 따라 바뀌는지까지)
  const orgName = `SC4 테스트 조직 ${run}`;
  const orgRenamed = `SC4 테스트 조직 ${run} 수정`;
  await step("1.1 조직 신설", async () => {
    const response = await api("POST", "/api/hr/organizations", { name: orgName, description: "SC4 회귀 점검용 조직" });
    state.organizationId = response.body?.organization?.organizationId ?? response.body?.organization?.id ?? "";
    return expect(response, 201, { name: orgName, hasId: true }, { name: response.body?.organization?.name, hasId: Boolean(state.organizationId) });
  });

  // 2. 합성 직원
  for (const [id, label] of [[employeeA, "A"], [employeeB, "B"]]) {
    await step(`2.1 합성 직원 ${label} 등록`, async () => {
      const response = await api("PUT", "/api/hr/employee-records", { employeeId: id, name: `SC4 테스트 직원${label}`, email: `${id}@example.invalid`,
        department: orgName, joinDate: "2025-01-02", position: "사원", jobTitle: "SC4 테스트", status: "재직", annualSalary: 36000000, mealAllowance: 200000 });
      return expect(response, 200, { employeeId: id, department: orgName }, { employeeId: response.body?.record?.employeeId, department: response.body?.record?.department });
    });
  }

  await step("1.2 조직명 수정 → 소속 직원 부서명 반영", async () => {
    const response = await api("PUT", "/api/hr/organizations", { organizationId: state.organizationId, name: orgRenamed, description: "SC4 회귀 점검용 조직(수정)" });
    const { record } = await employeeRecord(employeeA);
    return expect(response, 200, { name: orgRenamed, employeeDepartment: orgRenamed }, { name: response.body?.organization?.name, employeeDepartment: record?.department });
  });

  // 3. 인사발령: 오늘 → 즉시 반영, 미래 → 승인만(도래일 반영은 due 단계)
  const todayTeam = `SC4 테스트 발령팀 ${run}`;
  const futureTeam = `SC4 테스트 미래팀 ${run}`;
  const action = (effectiveDate, toDepartment, fromDepartment) => api("POST", "/api/hr/operations", { resource: "personnelAction", employeeId: employeeA,
    actionType: "인사이동(전보)", effectiveDate, fromDepartment, fromPosition: "사원", toDepartment, toPosition: "사원", reason: "SC4 회귀 점검 발령" });
  await step("3.1 인사발령 오늘 날짜 → 즉시 EFFECTIVE·부서 반영", async () => {
    const response = await action(koreaToday(), todayTeam, orgRenamed);
    const { record } = await employeeRecord(employeeA);
    return expect(response, 201, { status: "EFFECTIVE", department: todayTeam }, { status: response.body?.item?.status, department: record?.department });
  });
  await step("3.2 인사발령 미래 날짜 → APPROVED, 부서 그대로", async () => {
    const response = await action(FUTURE, futureTeam, todayTeam);
    state.futureActionId = response.body?.item?.id ?? "";
    const { record } = await employeeRecord(employeeA);
    return expect(response, 201, { status: "APPROVED", department: todayTeam }, { status: response.body?.item?.status, department: record?.department });
  });
  Object.assign(state, { todayTeam, futureTeam });

  // 4. 퇴직 등록 → IN_PROGRESS(정산 초안·'퇴직 예정')
  const retirement = { resource: "retirement", employeeId: employeeB, eventDate: FUTURE, reason: "SC4 회귀 점검 퇴직",
    tasks: [{ id: "handover", title: "SC4 인수인계", ownerType: "HR" }] };
  await step("4.1 퇴직 등록 → IN_PROGRESS", async () => {
    const response = await api("POST", "/api/hr/operations", retirement);
    state.retirementId = response.body?.item?.id ?? "";
    return expect(response, 201, { status: "IN_PROGRESS" }, { status: response.body?.item?.status });
  });
  await step("4.2 퇴직 정산 초안 DRAFT·인사기록 '퇴직 예정'·이력 1건", async () => {
    const { response, body } = await operationsFor(employeeB);
    const request = (body.retirementRequests ?? []).find((item) => item.id === state.retirementId);
    const settlement = (body.retirementSettlements ?? []).find((item) => item.request_id === state.retirementId);
    const { record } = await employeeRecord(employeeB);
    return expect(response, 200, { request: "IN_PROGRESS", settlement: "DRAFT", employeeStatus: "퇴직 예정", historyEntries: 1 },
      { request: request?.status, settlement: settlement?.status, employeeStatus: record?.status, historyEntries: (record?.history ?? []).filter((entry) => entry.type === "퇴직 예정").length });
  });
  await step("4.3 같은 직원 두 번째 퇴직 등록 → 409", async () => expect(await api("POST", "/api/hr/operations", retirement), 409));

  // 5. 휴가: 구 양식(즉시 APPROVED), 연차 대장 신청·삭제
  await step("5.1 휴가 구 양식 신청 → 즉시 APPROVED", async () => {
    const response = await api("POST", "/api/hr/operations", { resource: "leaveRequest", employeeId: employeeA, leaveType: "ANNUAL",
      startDate: "2026-08-20", endDate: "2026-08-20", units: 100, reason: "SC4 휴가(구 양식)" });
    const id = response.body?.item?.id;
    const { body } = await operationsFor(employeeA);
    const row = (body.leaveRequests ?? []).find((item) => item.id === id);
    return expect(response, 201, { response: "APPROVED", stored: "APPROVED", decided: true }, { response: response.body?.item?.status, stored: row?.status, decided: Boolean(row?.decided_at) });
  });
  let ledgerId = "";
  await step("5.2 연차 대장 신청", async () => {
    const response = await api("POST", "/api/hr/leave", { employeeId: employeeA, leaveType: "ANNUAL", date: "2026-08-21", units: 1 });
    ledgerId = response.body?.id ?? "";
    const ledger = await api("GET", `/api/hr/leave?employeeId=${encodeURIComponent(employeeA)}`);
    return expect(response, 201, { inLedger: true }, { inLedger: (ledger.body?.ledger?.usages ?? []).some((usage) => usage.id === ledgerId) });
  });
  await step("5.3 연차 대장 삭제", async () => {
    const response = await api("DELETE", `/api/hr/leave?id=${encodeURIComponent(ledgerId)}`);
    const ledger = await api("GET", `/api/hr/leave?employeeId=${encodeURIComponent(employeeA)}`);
    return expect(response, 200, { inLedger: false }, { inLedger: (ledger.body?.ledger?.usages ?? []).some((usage) => usage.id === ledgerId) });
  });
  await step("5.4 같은 기록 재삭제 → 404", async () => expect(await api("DELETE", `/api/hr/leave?id=${encodeURIComponent(ledgerId)}`), 404));

  // 6. 채용요청 생성 → OPEN → 삭제 (인력계획보다 먼저: 새 승인 계획이 이 조직 정원을 묶지 않게)
  let requisitionId = "";
  const requisitionStatus = async () => {
    const response = await api("GET", "/api/hr/recruitment-requisitions");
    return (response.body?.requisitions ?? []).find((item) => item.id === requisitionId)?.status ?? "(없음)";
  };
  await step("6.1 채용요청 생성 → 즉시 OPEN", async () => {
    const response = await api("POST", "/api/hr/recruitment-requisitions", { action: "CREATE_DRAFT", organizationId: state.organizationId,
      role: "SC4 테스트 포지션", requestedHeadcount: 1, targetStartDate: "2099-12-01", reason: "SC4 회귀 점검" });
    requisitionId = response.body?.id ?? "";
    return expect(response, 201, { opened: true, status: "OPEN" }, { opened: response.body?.opened, status: await requisitionStatus() });
  });
  await step("6.2 OPEN 채용요청 재모집 → 409", async () => expect(await api("POST", "/api/hr/recruitment-requisitions", { action: "SUBMIT", id: requisitionId }), 409));
  await step("6.3 채용요청 삭제", async () => {
    const response = await api("POST", "/api/hr/recruitment-requisitions", { action: "DELETE", id: requisitionId, reason: "SC4 회귀 점검 삭제" });
    return expect(response, 200, { status: "(없음)" }, { status: await requisitionStatus() });
  });

  // 7. 인력계획 승인, 개정본 승인 시 이전 승인본 SUPERSEDED
  const plans = await api("GET", "/api/hr/workforce-plans");
  const allPlans = plans.body?.plans ?? [];
  const periods = [];
  for (let year = 2035; year >= 2024; year -= 1) periods.push(`${year}-H2`, `${year}-H1`);
  const planPeriod = periods.find((period) => !allPlans.some((plan) => plan.period === period))
    ?? periods.find((period) => allPlans.filter((plan) => plan.period === period).every((plan) => String(plan.title).startsWith("SC4 테스트") && !["DRAFT", "SUBMITTED"].includes(plan.status)));
  const planStatus = async (id) => {
    const response = await api("GET", `/api/hr/workforce-plans?planId=${encodeURIComponent(id)}`);
    return (response.body?.plans ?? []).find((plan) => plan.id === id)?.status ?? "(없음)";
  };
  let firstPlan = ""; let secondPlan = "";
  if (!planPeriod) skip("7.x 인력계획", "합성 계획을 둘 빈 반기(2024-H1~2035-H2)가 없습니다");
  else {
    const title = `SC4 테스트 인력계획 ${run}`;
    await step(`7.1 인력계획 작성(${planPeriod})`, async () => {
      const response = await api("POST", "/api/hr/workforce-plans", { action: "CREATE_PLAN", period: planPeriod, title });
      firstPlan = response.body?.id ?? "";
      return expect(response, 201, { status: "DRAFT" }, { status: await planStatus(firstPlan) });
    });
    await step("7.2 인력계획 가정 저장", async () => expect(await api("POST", "/api/hr/workforce-plans", { action: "SAVE_PLAN", planId: firstPlan, title, assumptions: "SC4 회귀 점검용 가정과 기준입니다" }), 200));
    await step("7.3 인력계획 승인 → APPROVED", async () => {
      const response = await api("POST", "/api/hr/workforce-plans", { action: "SUBMIT_PLAN", planId: firstPlan });
      return expect(response, 200, { status: "APPROVED" }, { status: await planStatus(firstPlan) });
    });
    await step("7.4 개정본 작성", async () => {
      const response = await api("POST", "/api/hr/workforce-plans", { action: "CREATE_REVISION", planId: firstPlan, reason: "SC4 개정 점검" });
      secondPlan = response.body?.id ?? "";
      return expect(response, 201, { status: "DRAFT" }, { status: await planStatus(secondPlan) });
    });
    await step("7.5 개정본 승인 → 새 계획 APPROVED, 이전 계획 SUPERSEDED", async () => {
      const response = await api("POST", "/api/hr/workforce-plans", { action: "SUBMIT_PLAN", planId: secondPlan });
      return expect(response, 200, { previous: "SUPERSEDED", current: "APPROVED" }, { previous: await planStatus(firstPlan), current: await planStatus(secondPlan) });
    });
  }

  // 8. 직원·지원자 문서 업로드와 다운로드
  const applicantId = `sc4-${run}-applicant`;
  await step("8.1 합성 지원자 등록", async () => expect(await api("PUT", "/api/hr/recruitment", { id: applicantId, name: "SC4 테스트 지원자",
    email: `${applicantId}@example.invalid`, stage: "서류 검토", applied: "2026.09.28" }), 200));
  for (const [label, entityType, entityId] of [["직원", "employee", employeeA], ["지원자", "applicant", applicantId]]) {
    const content = `SC4 ${label} 문서 ${run}`;
    let documentId = "";
    await step(`8.2 ${label} 문서 업로드`, async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries({ module: "hr", entityType, entityId, category: "SC4 테스트" })) form.set(key, value);
      form.set("file", new File([content], `sc4-${entityType}.txt`, { type: "text/plain" }));
      const response = await api("POST", "/api/documents", form, { form: true });
      documentId = response.body?.document?.id ?? "";
      const list = await api("GET", `/api/documents?module=hr&entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`);
      return expect(response, 201, { listed: true }, { listed: (list.body?.documents ?? []).some((item) => item.id === documentId) });
    });
    await step(`8.3 ${label} 문서 다운로드(내용 일치)`, async () => {
      const response = await api("GET", `/api/documents?downloadId=${encodeURIComponent(documentId)}`, undefined, { raw: true });
      return expect(response, 200, { sameContent: true, attachment: true }, { sameContent: response.body === content, attachment: (response.headers.get("content-disposition") ?? "").startsWith("attachment") });
    });
  }

  // 9. 인센티브 계산 → 임금 계산 CREATE·SAVE·CONFIRM·REOPEN → 급여 REVIEW→APPROVED→LOCKED→사유 재오픈
  await step("9.1 인센티브 계산 화면(/incentive) 렌더", async () => {
    const response = await api("GET", "/incentive", undefined, { raw: true });
    return expect(response, 200, { hasTitle: true }, { hasTitle: typeof response.body === "string" && response.body.includes("인센티브") });
  });
  let incentive = 0;
  await step("9.2 인센티브 계산(화면 계산 함수)", async () => {
    const { calculate, roundIncentive } = await loadIncentiveCalculate();
    const deal = { id: `sc4-${run}-deal`, person: "SC4 테스트 직원A", personId: employeeA, date: "2026-09-01", salesInvoiceDate: "", client: "SC4 테스트 거래처",
      item: "SC4 품목", quantity: 2, unitCost: 600000, unitSale: 1000000, expense: 50000, kind: "일반", excluded: false };
    const config = { hurdleRate: 5, payoutRate: 5, cableMode: "deduct", rounding: "none", fixCancelSign: true };
    const result = calculate(deal, config);
    incentive = Math.round(roundIncentive(result.incentive, config.rounding));
    // 매출 2,000,000 · 마진 750,000 · 문턱 100,000 → (750,000 − 100,000) × 5% = 32,500
    return { ok: incentive === 32500, status: null, expected: { sales: 2000000, margin: 750000, incentive: 32500 }, actual: { sales: result.sales, margin: result.margin, incentive } };
  });

  let period = "";
  for (let year = 2099; year >= 2090 && !period; year -= 1) {
    for (let month = 12; month >= 1 && !period; month -= 1) {
      const candidate = `${year}-${String(month).padStart(2, "0")}`;
      const [wage, payroll] = await Promise.all([api("GET", `/api/hr/compensation?period=${candidate}`), api("GET", `/api/hr/payroll?month=${candidate}`)]);
      if (wage.status === 200 && wage.body?.run === null && payroll.status === 200 && payroll.body?.summary === null && (payroll.body?.records ?? []).length === 0) period = candidate;
    }
  }
  state.period = period;
  if (!period) { skip("9.x 임금 계산·급여", "합성 급여월로 쓸 빈 달(2090~2099)이 없습니다"); return; }

  const monthly = { incentive };
  const snapshot = { id: employeeA, name: "SC4 테스트 직원A", department: todayTeam, title: "SC4 테스트", birthDate: "", joinDate: "2025-01-02", leaveDate: "",
    probationMonths: 0, annualSalary: 36000000, basePay: 0, manualBasic: false, meal: 200000, car: 0, child: 0, monthly: { [period]: monthly } };
  const row = { employeeId: employeeA, basic: 3000000, meal: 200000, car: 0, child: 0, incentive, bonus: 0, extra: 0, research: 0, severance: 0,
    annualLeave: 0, personalExpense: 0, deduction: 100000, welfare: 0 };
  row.total = row.basic + row.meal + row.car + row.child + row.incentive + row.bonus + row.extra + row.research + row.severance + row.annualLeave + row.personalExpense - row.deduction;
  const draft = { period, settings: { rounding: "round", columns: { research: true, extra: true, welfare: true, severance: true, deduction: true, annualLeave: true, personalExpense: true } },
    employees: [snapshot], rows: [row] };
  const wage = (body) => api("POST", "/api/hr/compensation", { ...draft, ...body });
  const payrollPut = (body) => api("PUT", "/api/hr/payroll", { period, ...body });
  let version = 0;
  const wageStep = async (name, body, expectedStatus, expectedRun) => step(name, async () => {
    const response = await wage(body);
    if (response.body?.run?.version) version = response.body.run.version;
    return expect(response, expectedStatus, expectedRun, expectedRun === undefined ? undefined : { status: response.body?.run?.status, grossPay: response.body?.run?.grossPay });
  });
  console.log(`INFO 합성 급여월 ${period}`);
  await wageStep("9.3 임금안 작성(CREATE, 인센티브 포함)", { action: "CREATE" }, 201, { status: "DRAFT", grossPay: row.total });
  await wageStep("9.4 임금안 저장(SAVE)", { action: "SAVE", version: 1 }, 200, { status: "DRAFT", grossPay: row.total });
  await wageStep("9.5 임금안 확정(CONFIRM)", { action: "CONFIRM", version }, 200, { status: "CONFIRMED", grossPay: row.total });
  await step("9.6 확정 → 급여기록 반영(인센티브·지급총액·실지급)", async () => {
    const response = await api("GET", `/api/hr/payroll?month=${period}`);
    const record = (response.body?.records ?? []).find((item) => item.employeeId === employeeA);
    return expect(response, 200, { run: "DRAFT", records: 1, incentive, grossPay: row.total + row.deduction, netPay: row.total },
      { run: response.body?.summary?.status, records: (response.body?.records ?? []).length, incentive: record?.incentive, grossPay: record?.grossPay, netPay: record?.netPay });
  });
  await wageStep("9.7 임금안 재오픈(REOPEN)", { action: "REOPEN", version }, 200, { status: "DRAFT", grossPay: row.total });
  await wageStep("9.8 임금안 재확정(CONFIRM)", { action: "CONFIRM", version }, 200, { status: "CONFIRMED", grossPay: row.total });
  await step("9.9 급여 REVIEW", async () => { const r = await payrollPut({ status: "REVIEW" }); return expect(r, 200, { status: "REVIEW" }, { status: r.body?.item?.status }); });
  await step("9.10 급여 APPROVED(검토·승인자 기록)", async () => {
    const r = await payrollPut({ status: "APPROVED" });
    return expect(r, 200, { status: "APPROVED", reviewedBy: true, approvedBy: true }, { status: r.body?.item?.status, reviewedBy: Boolean(r.body?.item?.reviewed_by), approvedBy: Boolean(r.body?.item?.approved_by) });
  });
  await step("9.11 급여 LOCKED", async () => {
    const r = await payrollPut({ status: "LOCKED" });
    return expect(r, 200, { status: "LOCKED", lockedAt: true }, { status: r.body?.item?.status, lockedAt: Boolean(r.body?.item?.locked_at) });
  });
  await wageStep("9.12 마감된 달 임금안 재오픈 → 409", { action: "REOPEN", version }, 409);
  await step("9.13 사유 없는 급여 재오픈 → 400", async () => expect(await payrollPut({ status: "DRAFT" }), 400));
  const reason = "SC4 회귀 점검: 급여 상세 정정";
  await step("9.14 사유를 적은 급여 재오픈 → DRAFT", async () => {
    const r = await payrollPut({ status: "DRAFT", reopenedReason: reason });
    return expect(r, 200, { status: "DRAFT", reason, approvedBy: "", lockedAt: null },
      { status: r.body?.item?.status, reason: r.body?.item?.reopened_reason, approvedBy: r.body?.item?.approved_by, lockedAt: r.body?.item?.locked_at });
  });
  await wageStep("9.15 급여 재오픈 뒤 임금안 REOPEN", { action: "REOPEN", version }, 200, { status: "DRAFT", grossPay: row.total });
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// due 단계: 날짜 도래와 레거시 행(--offline-prep 이 사본에 만들어 둔 것)
// ════════════════════════════════════════════════════════════════════════════════════════════
async function phaseDue(state) {
  const { run, employeeA, employeeB } = state;
  if (!state.offlinePrepared) {
    for (const name of ["10.x 미래 발령 도래일 반영", "11.x 퇴직 EFFECTIVE→COMPLETED", "12.x 레거시 PENDING 휴가 승인", "13.x 성과 확정·이의제기"]) {
      skip(name, "--offline-prep 을 거치지 않았습니다(서버로 날짜를 당기거나 레거시 행을 만들 수 없음)");
    }
    return;
  }

  // 10. 미래 발령: 시행일이 오면(오늘로 당김) 인사기록 조회 때 반영된다
  await step("10.1 미래 발령 도래일 → EFFECTIVE·부서 반영", async () => {
    const { response, record } = await employeeRecord(employeeA);
    const { body } = await operationsFor(employeeA);
    const action = (body.personnelActions ?? []).find((item) => item.id === state.futureActionId);
    return expect(response, 200, { status: "EFFECTIVE", department: state.futureTeam }, { status: action?.status, department: record?.department });
  });

  // 11. 퇴직: 퇴직일 도래 → EFFECTIVE, 체크리스트·정산 완료 → COMPLETED
  const retirementState = async () => {
    const { body } = await operationsFor(employeeB);
    return {
      request: (body.retirementRequests ?? []).find((item) => item.id === state.retirementId)?.status,
      settlement: (body.retirementSettlements ?? []).find((item) => item.request_id === state.retirementId),
    };
  };
  await step("11.1 퇴직일 도래 → EFFECTIVE·인사기록 '퇴직'", async () => {
    const { response, record } = await employeeRecord(employeeB);
    const current = await retirementState();
    return expect(response, 200, { request: "EFFECTIVE", employeeStatus: "퇴직" }, { request: current.request, employeeStatus: record?.status });
  });
  await step("11.2 체크리스트 완료(정산 전이라 EFFECTIVE 유지)", async () => {
    const response = await api("PUT", "/api/hr/operations", { resource: "retirementChecklist", id: state.retirementId, completedTaskIds: ["handover"] });
    return expect(response, 200, { request: "EFFECTIVE", settlementPending: true }, { request: response.body?.item?.status, settlementPending: response.body?.settlementPending });
  });
  const settlement = { resource: "retirementSettlement", id: state.retirementId, finalSalary: 1000000, retirementPay: 2000000, leaveDays: 0, unusedLeavePay: 0,
    deductions: 50000, payrollConfirmed: true, insuranceConfirmed: true, accessRevoked: true, assetsReturned: true, handoverConfirmed: true };
  await step("11.3 정산 완료 → COMPLETED", async () => {
    const response = await api("PUT", "/api/hr/operations", settlement);
    const current = await retirementState();
    return expect(response, 200, { request: "COMPLETED", settlement: "COMPLETED", net: 2950000 },
      { request: current.request, settlement: current.settlement?.status, net: current.settlement?.net_settlement });
  });
  await step("11.4 완료된 퇴직 재정산 → 409", async () => expect(await api("PUT", "/api/hr/operations", settlement), 409));

  // 12. 레거시 PENDING 휴가 신청의 직접 승인
  const legacyLeaveId = `sc4-${run}-legacy-leave`;
  await step("12.1 레거시 PENDING 휴가 → 승인", async () => {
    const before = (await operationsFor(employeeA)).body.leaveRequests?.find((item) => item.id === legacyLeaveId)?.status;
    const response = await api("PUT", "/api/hr/operations", { resource: "leaveRequest", id: legacyLeaveId, status: "APPROVED" });
    return expect(response, 200, { before: "PENDING", after: "APPROVED", decided: true }, { before, after: response.body?.item?.status, decided: Boolean(response.body?.item?.decided_at) });
  });

  // 13. 성과: 보정 단계 주기 최종 확정, 이의제기 수용(RESOLVED)·기각(REJECTED)
  const cycleId = `sc4-${run}-cycle`;
  const selfParticipant = `sc4-${run}-p-self`;
  const performance = async () => {
    const response = await api("GET", `/api/hr/performance?cycleId=${encodeURIComponent(cycleId)}`);
    const body = response.body ?? {};
    return { response, cycle: body.selected?.id === cycleId ? body.selected.status : "(없음)",
      participants: (body.participants ?? []).map((item) => item.status), appeals: body.appeals ?? [] };
  };
  await step("13.1 성과 최종 확정 → 주기·대상자 FINALIZED", async () => {
    const response = await api("POST", "/api/hr/performance", { action: "SUBMIT_FINALIZATION", cycleId });
    const current = await performance();
    return expect(response, 200, { cycle: "FINALIZED", participants: ["FINALIZED", "FINALIZED"] }, { cycle: current.cycle, participants: current.participants });
  });
  await step("13.2 확정된 주기 재확정 → 409", async () => expect(await api("POST", "/api/hr/performance", { action: "SUBMIT_FINALIZATION", cycleId }), 409));
  for (const [label, outcome] of [["수용", "RESOLVED"], ["기각", "REJECTED"]]) {
    let appealId = "";
    await step(`13.3 이의제기 제출(${label}용)`, async () => {
      const response = await api("POST", "/api/hr/performance", { action: "SUBMIT_APPEAL", participantId: selfParticipant, reason: `SC4 회귀 점검 이의제기(${label}) 사유와 근거를 적습니다` });
      appealId = response.body?.id ?? "";
      return expect(response, 201, { status: "SUBMITTED" }, { status: (await performance()).appeals.find((item) => item.id === appealId)?.status });
    });
    if (outcome === "RESOLVED") {
      await step("13.4 이의제기 처리결과 ACCEPTED → 400(서버 값은 RESOLVED)", async () => expect(await api("POST", "/api/hr/performance", {
        action: "RESOLVE_APPEAL", participantId: selfParticipant, appealId, outcome: "ACCEPTED", response: "SC4 회귀 점검 답변입니다" }), 400));
    }
    await step(`13.5 이의제기 ${label} → ${outcome}`, async () => {
      const response = await api("POST", "/api/hr/performance", { action: "RESOLVE_APPEAL", participantId: selfParticipant, appealId, outcome, response: `SC4 회귀 점검 ${label} 답변입니다` });
      return expect(response, 200, { status: outcome }, { status: (await performance()).appeals.find((item) => item.id === appealId)?.status });
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// offline-prep: 서버를 멈춘 점검 사본에만. 합성(sc4-) 행만 만들거나 날짜를 당긴다.
// ════════════════════════════════════════════════════════════════════════════════════════════
async function offlinePrep() {
  const state = loadState();
  if (!state.run || !state.employeeA) usage("상태 파일에 main 단계 결과가 없습니다. 먼저 --phase main 을 실행하세요.");
  const target = resolve(OFFLINE_DIR).toLowerCase();
  const live = resolve(import.meta.dirname, "..", ".wrangler", "state").toLowerCase();
  if (target.startsWith(live)) {
    console.error("운영 중인 .wrangler/state 는 손대지 않습니다. 정지한 점검 사본을 지정하세요.");
    process.exit(2);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const { findAppDatabase } = await import("./lib/d1-state.mjs");
  const db = new DatabaseSync(findAppDatabase(OFFLINE_DIR));
  const today = koreaToday();
  const now = Date.now();
  const { run, employeeA, principalEmployeeId } = state;
  const offlineStep = (name, fn) => {
    try {
      const { changes, expected } = fn();
      report(changes === expected ? "PASS" : "FAIL", name, null, { rows: expected }, { rows: changes });
    } catch (error) { report("FAIL", name, null, "no exception", error instanceof Error ? error.message : String(error)); }
  };
  try {
    db.exec("BEGIN IMMEDIATE");
    offlineStep("P.1 미래 발령 시행일을 오늘로 당김(도래 모사)", () => ({ expected: 1, changes: Number(db.prepare(`UPDATE hr_personnel_actions SET effective_date = ?
      WHERE id = ? AND employee_id LIKE 'sc4-%' AND status = 'APPROVED'`).run(today, state.futureActionId).changes) }));
    offlineStep("P.2 미래 퇴직일을 오늘로 당김(도래 모사)", () => ({ expected: 1, changes: Number(db.prepare(`UPDATE hr_retirement_requests SET retirement_date = ?
      WHERE id = ? AND employee_id LIKE 'sc4-%' AND status = 'IN_PROGRESS'`).run(today, state.retirementId).changes) }));
    offlineStep("P.3 레거시 PENDING 휴가 신청(결재 시절 행) 생성", () => ({ expected: 1, changes: Number(db.prepare(`INSERT INTO hr_leave_requests
      (id, employee_id, leave_type, start_date, end_date, units, reason, status, approver_employee_id, decided_at, created_at, updated_at)
      VALUES (?, ?, 'ANNUAL', '2026-08-24', '2026-08-24', 100, 'SC4 레거시 대기 휴가', 'PENDING', '', NULL, ?, ?)`).run(`sc4-${run}-legacy-leave`, employeeA, now, now).changes) }));
    offlineStep("P.4 보정(CALIBRATION) 단계 성과주기와 CALIBRATED 대상자 2명 생성", () => {
      let changes = Number(db.prepare(`INSERT INTO hr_performance_cycles (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
        calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
        VALUES (?, ?, '2099-H2', 'SC4 회귀 점검용', 'CALIBRATION', '2099-07-01', '2099-08-01', '2099-09-01', '2099-10-01', ?, ?, '', NULL, ?, ?)`)
        .run(`sc4-${run}-cycle`, `SC4 테스트 성과주기 ${run}`, principalEmployeeId, now, now, now).changes);
      for (const [suffix, employeeId] of [["p-a", employeeA], ["p-self", principalEmployeeId]]) {
        changes += Number(db.prepare(`INSERT INTO hr_performance_participants (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
          final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
          VALUES (?, ?, ?, '', '', 'CALIBRATED', 80, 'B', 'SC4 보정', '', NULL, ?, ?)`).run(`sc4-${run}-${suffix}`, `sc4-${run}-cycle`, employeeId, now, now).changes);
      }
      return { expected: 3, changes };
    });
    if (tally.fail) { db.exec("ROLLBACK"); console.log("INFO 실패가 있어 모두 되돌렸습니다."); }
    else { db.exec("COMMIT"); state.offlinePrepared = true; saveState(state); }
  } finally {
    db.close();
  }
}

// ── 실행 ─────────────────────────────────────────────────────────────────────────────────────
if (OFFLINE_DIR) await offlinePrep();
else {
  console.log(`INFO SC-4 HR 회귀 · base ${BASE} · phase ${PHASE} · today(KST) ${koreaToday()}`);
  const state = PHASE === "due" ? loadState() : {};
  if (PHASE === "due" && !state.run) usage("상태 파일에 main 단계 결과가 없습니다.");
  if (PHASE !== "due") { await phaseMain(state); saveState(state); }
  if (PHASE !== "main") await phaseDue(state);
}
console.log(`SUMMARY pass=${tally.pass} fail=${tally.fail} skip=${tally.skip}`);
process.exit(tally.fail ? 1 : tally.skip ? 3 : 0);
