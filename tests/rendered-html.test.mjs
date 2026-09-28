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

// R1(M1-3): 셸은 인사관리·임금 계산·감사 로그 세 탭만 둔다. 재무·영업 모듈, 오늘 업무(워크벤치),
// 데이터 통제, 알림 센터는 셸에서 뺐다(Design §12.5). 첫 화면은 HR이다.
test("renders the HR-first shell with only the hr, compensation and audit tabs", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>XDnode management · 경영지원실<\/title>/);
  assert.match(html, /aria-label="ERP 모듈"/);
  assert.match(html, /class="hr-module-shell"/);
  assert.match(html, /<strong>XDnode management<\/strong>/);
  assert.match(html, /class="erp-module-tab active"[^>]*aria-current="page"[\s\S]*?<strong>인사관리<\/strong>/);
  assert.match(html, /<strong>임금 계산<\/strong>/);
  assert.match(html, /<strong>감사 로그<\/strong>/);
  assert.equal((html.match(/class="erp-module-tab( active)?"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<strong>재무회계<\/strong>|<strong>영업<\/strong>/);
  assert.doesNotMatch(html, /erp-alarm-button|erp-workbench-button|erp-data-governance-button|erp-sync-state/);
  assert.doesNotMatch(html, /2024년부터 오늘까지, 하나의 재무 흐름으로|aria-label="재무회계 메뉴"|Clobe · 2026 데이터/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/);
});

test("shell source keeps only the hr, compensation and audit modules", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /type ModuleKey = "hr" \| "compensation" \| "audit";/);
  assert.match(source, /const validModuleKeys: ModuleKey\[\] = \["hr", "compensation", "audit"\];/);
  // 저장된 모듈이 더 이상 없으면(예: finance) 'hr'로 돌아간다.
  assert.match(source, /validModuleKeys\.includes\(saved as ModuleKey\) \? saved as ModuleKey : "hr"/);
  assert.match(source, /useState<ModuleKey>\("hr"\)/);
  // 감사 로그는 data-governance-center 대신 셸의 탭으로 마운트한다. 서버 게이트(settings:admin)는 그대로다.
  assert.match(source, /import AuditLogWorkspace from "\.\/audit-log-workspace";/);
  assert.match(source, /<main className="admin-page">\s*<AuditLogWorkspace \/>/);
  const auditRoute = await readFile(new URL("../app/api/audit-log/route.ts", import.meta.url), "utf8");
  assert.match(auditRoute, /authorizeErpRequest\(db, "settings", "admin"\)/);
  // HR 화면 이동 핸드셰이크는 남긴다.
  assert.match(source, /<HRWorkspace requestedView=\{hrNavigation\.view\} navigationRequestKey=\{hrNavigation\.requestKey\} \/>/);
  assert.doesNotMatch(source, /financeView|FinanceDashboard|SalesDashboard|HrDashboard|SalesWorkspace|OperationsWorkbench|DataGovernanceCenter|ApprovalCenter|finance-current-data|finance-decision-model|결재 대기/);
  assert.doesNotMatch(source, /fetch\("\/api\/(operations|finance|sales)/);
});

test("renders the incentive calculator analysis workspace", async () => {
  const response = await render("/incentive");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /인센티브 계산기/);
  assert.match(html, /엑셀 또는 CSV 선택/);
  assert.match(html, /개인별 예상 인센티브/);
  assert.match(html, /각 거래의 인센티브를 먼저 계산하고 단수 처리한 뒤 개인별로 합산/);
  assert.match(html, /케이블은 제품명만으로 제외하지 않으며 거래별 ‘인센 반영’ 설정/);
  assert.match(html, /거래별 확정액 합계/);
  assert.match(html, /인센티브 완전 제외 인원/);
  assert.match(html, /엑셀 결과에서 모두 제외/);
  assert.match(html, /월 인바운드 매출/);
  assert.match(html, /개인 인센티브 대시보드/);
  assert.match(html, /전체 인센티브 대시보드/);
  assert.match(html, /인원별 전체 매출 비중/);
  assert.match(html, /제품 · 거래 구분별 매출/);
  assert.match(html, /인원별 전체 인센티브 비중/);
  assert.match(html, /완전 제외 인원 설정과 무관하게 모든 원본 거래/);
  assert.match(html, /제품별/);
  assert.match(html, /거래 구분별/);
  assert.match(html, /거래별 계산 내역/);
  assert.match(html, /케이블 미반영 일괄 적용/);
  assert.match(html, /마진 계산식/);
  assert.match(html, /매출계산서일/);
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
