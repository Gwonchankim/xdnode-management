import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function workerFetch(pathname, init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}-${init.method ?? "GET"}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, init),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function assertSecurityHeaders(response, label) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
  assert.equal(response.headers.get("x-frame-options"), "DENY", label);
  assert.equal(response.headers.get("referrer-policy"), "same-origin", label);
  assert.equal(response.headers.get("permissions-policy"), "microphone=(self)", label);
}

// R3(r3-auth, Design §7.3·§7.7·§8.3 #8·#9): worker 가 /api/* 비GET 교차 출처 요청을 DB 없이 먼저 막고,
// 모든 응답에 보안 헤더 3종을, /api/* 에는 기본 no-store 를 붙인다.
test("worker refuses cross-origin and header-less API writes before any handler runs", async () => {
  const json = { "content-type": "application/json" };
  const cases = [
    ["/api/auth/login", { method: "POST", headers: { ...json, origin: "http://evil.invalid" }, body: "{}" }],
    ["/api/auth/login", { method: "POST", headers: json, body: "{}" }],
    ["/api/hr/payroll", { method: "PUT", headers: json, body: "{}" }],
    ["/api/auth/bootstrap", { method: "POST", headers: { ...json, origin: "null" }, body: "{}" }],
  ];
  for (const [pathname, init] of cases) {
    const response = await workerFetch(pathname, init);
    assert.equal(response.status, 403, `${init.method} ${pathname}`);
    assert.deepEqual(await response.json(), { error: "다른 사이트에서 보낸 요청은 처리하지 않습니다.", code: "CROSS_ORIGIN" });
    assertSecurityHeaders(response, pathname);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("worker adds the global security headers to pages and not-found responses", async () => {
  const page = await render("/");
  assertSecurityHeaders(page, "/");
  const missing = await workerFetch("/api/finance/budget");
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing, "/api/finance/budget");
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

// R3(r3-shell, Design §5.2·§8.3 #5·#6): SSR 과 첫 렌더는 AuthLoadingShell(data-auth-gate="loading")뿐이다.
// 탭 라벨·HR 데이터·재무/영업 문자열이 HTML 에 없고, 페이지는 D1 을 읽지 않는다(이 테스트는 DB 없이 worker 를 부른다).
const TAB_LABELS = ["인사관리", "임금 계산", "감사 로그", "계정 관리", "메신저"];

test("renders only the auth loading shell at / with no tab DOM and no business data", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>XDnode management · 경영지원실<\/title>/);
  assert.match(html, /data-auth-gate="loading"/);
  assert.match(html, /<strong>XDnode management<\/strong>/);
  assert.match(html, /src="\/brand\/xdnode-logo\.png"/);
  // 설명 메타("인사 · 임금 계산 · 감사 기록")는 vinext 가 <body> 의 숨은 div 와 RSC 스크립트에도 싣는다.
  // 탭 DOM 여부는 메타·title·스크립트를 뺀 화면 마크업으로 본다.
  const body = html.slice(html.indexOf("<body"))
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<meta\b[^>]*>/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "");
  for (const label of TAB_LABELS) assert.equal(body.includes(label), false, `tab label in SSR body: ${label}`);
  assert.doesNotMatch(html, /class="erp-module-tab|aria-label="업무 탭"|erp-top-nav|hr-module-shell|peopleflow-host/);
  assert.doesNotMatch(html, /<strong>재무회계<\/strong>|<strong>영업<\/strong>|재무|영업 인센티브 대시보드/);
  assert.doesNotMatch(html, /erp-alarm-button|erp-workbench-button|erp-data-governance-button|erp-sync-state/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/);
  assert.doesNotMatch(html, /\b01\d-\d{3,4}-\d{4}\b/, "no phone numbers in the SSR shell");
});

test("renders only the auth loading shell at /incentive, without the calculator DOM", async () => {
  const response = await render("/incentive");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>개인 인센티브 계산기 · XDnode management<\/title>/);
  assert.match(html, /data-auth-gate="loading"/);
  assert.doesNotMatch(html, /인센티브 계산기<\/h1>|엑셀 또는 CSV 선택|개인별 예상 인센티브|거래별 계산 내역/);
});

test("removed finance, sales and approval APIs are framework 404s", async () => {
  for (const pathname of ["/api/finance/budget", "/api/sales", "/api/approvals"]) {
    const response = await workerFetch(pathname);
    assert.equal(response.status, 404, pathname);
    assertSecurityHeaders(response, pathname);
  }
});

test("shell source renders tabs from the registry through the session state machine", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const session = useSession\(\);/);
  assert.match(source, /if \(session\.state\.status !== "ready"\)/);
  assert.match(source, /<SessionGate session=\{session\} \/>/);
  assert.match(source, /const TAB_PANELS: Record<TabKey, \(ctx: PanelContext\) => ReactNode> = \{/);
  // 감사 로그와 계정 관리는 관리자 전용 탭이다(D23). 서버 게이트는 audit:read·admin:read.
  assert.match(source, /import AuditLogWorkspace from "\.\/audit-log-workspace";/);
  assert.match(source, /<main className="admin-page">\s*<AuditLogWorkspace \/>/);
  assert.match(source, /<AdminAccountsWorkspace currentAccountId=\{ctx\.me\.user\.accountId\} \/>/);
  const auditRoute = await readFile(new URL("../app/api/audit-log/route.ts", import.meta.url), "utf8");
  assert.match(auditRoute, /authorizeErpRequest\(db, "audit", "read"\)/);
  // HR 화면 이동 핸드셰이크와 보기 권한 배너(access.canEdit)를 넘긴다.
  assert.match(source, /<HRWorkspace requestedView=\{ctx\.hrNavigation\.view\} navigationRequestKey=\{ctx\.hrNavigation\.requestKey\} access=\{\{ canEdit: ctx\.tabs\.hr === "edit" \}\} \/>/);
  // 저장된 탭은 계정 범위 키로 읽고, 옛 키(xdnode-active-module)는 1회 읽은 뒤 지운다.
  assert.match(source, /const ACTIVE_TAB_KEY = "xdnode-active-tab";/);
  assert.match(source, /"xdnode-active-module"/);
  assert.match(source, /readScoped\(ACTIVE_TAB_KEY, LEGACY_ACTIVE_TAB_KEYS\)/);
  assert.doesNotMatch(source, /financeView|FinanceDashboard|SalesDashboard|HrDashboard|SalesWorkspace|OperationsWorkbench|DataGovernanceCenter|ApprovalCenter|finance-current-data|finance-decision-model|결재 대기/);
  assert.doesNotMatch(source, /fetch\("\/api\/(operations|finance|sales)/);
  assert.doesNotMatch(source, /localStorage/);
});

test("incentive calculator keeps its analysis workspace copy (rendered after the session gate)", async () => {
  const source = await readFile(new URL("../app/incentive/incentive-calculator.tsx", import.meta.url), "utf8");
  for (const text of [
    "인센티브 계산기", "엑셀 또는 CSV 선택", "개인별 예상 인센티브", "각 거래의 인센티브를 먼저 계산하고 단수 처리한 뒤 개인별로 합산",
    "케이블은 제품명만으로 제외하지 않으며 거래별 ‘인센 반영’ 설정", "거래별 확정액 합계", "인센티브 완전 제외 인원", "엑셀 결과에서 모두 제외",
    "월 인바운드 매출", "개인 인센티브 대시보드", "전체 인센티브 대시보드", "인원별 전체 매출 비중", "제품 · 거래 구분별 매출",
    "인원별 전체 인센티브 비중", "완전 제외 인원 설정과 무관하게 모든 원본 거래", "거래별 계산 내역", "케이블 미반영 일괄 적용", "마진 계산식", "매출계산서일",
  ]) assert.ok(source.includes(text), text);
  // R3(Design §4.2.7): 담당자 목록은 4필드 명부에서만 받는다. 인사기록(전화·주소·급여)은 부르지 않는다.
  assert.match(source, /fetch\("\/api\/compensation\/roster", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(source, /\/api\/hr\/employee-records"\)/);
  assert.match(source, /if \(!response\.ok\) throw new Error/);
  assert.doesNotMatch(source, /localStorage\./);
});

test("company sales dashboard includes every original deal before person exclusions", async () => {
  const source = await readFile(new URL("../app/incentive/incentive-calculator.tsx", import.meta.url), "utf8");
  assert.match(source, /overallSalesByPerson = useMemo\(\(\) => salesBreakdown\(deals,/);
  assert.match(source, /overallSalesByProduct = useMemo\(\(\) => salesBreakdown\(deals,/);
  assert.match(source, /overallSalesByKind = useMemo\(\(\) => kindSalesBreakdown\(deals\)/);
  assert.match(source, /RankedBars breakdown=\{overallSalesByProduct\} label="제품별"/);
  assert.match(source, /RankedBars breakdown=\{overallSalesByKind\} label="거래 구분별"/);
});

test("does not blanket-exclude cable transactions from incentives", async () => {
  const source = await readFile(new URL("../app/incentive/incentive-calculator.tsx", import.meta.url), "utf8");
  assert.match(source, /new Set<DealKind>\(\["인바운드", "단독 RAM", "온라인"\]\)/);
  assert.doesNotMatch(source, /new Set<DealKind>\(\["인바운드", "단독 RAM", "케이블", "온라인"\]\)/);
  assert.match(source, /migrateCableExclusions/);
  assert.match(source, /styles\.cableRow/);
  assert.match(source, /excludeCableDealsForPerson/);
});

test("incentive result export uses the current workbook download API", async () => {
  const source = await readFile(new URL("../app/incentive/incentive-calculator.tsx", import.meta.url), "utf8");
  assert.match(source, /writeXlsxFile\(data,[\s\S]*?\)\.toFile\(`/);
  assert.match(source, /backgroundColor: rowIndex === 0 \? "#E8EEF0"/);
  assert.match(source, /엑셀 파일을 만들지 못했습니다/);
});
