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

test("renders the integrated ERP finance workspace", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>XD NODE ERP · 통합 운영 관리<\/title>/);
  assert.match(html, /2024년부터 오늘까지, 하나의 재무 흐름으로/);
  assert.doesNotMatch(html, /class="attention-strip"/);
  assert.doesNotMatch(html, /class="topbar"/);
  assert.doesNotMatch(html, /계좌, 거래처, 전표 검색/);
  assert.doesNotMatch(html, /2026년 8월/);
  assert.match(html, /aria-label="재무회계 메뉴"/);
  assert.match(html, /임금 계산/);
  assert.match(html, /<strong>재무회계<\/strong>/);
  assert.match(html, /class="finance-side-alert"/);
  assert.match(html, /알림 센터/);
  assert.match(html, /내보내기/);
  assert.match(html, /통합 대시보드/);
  assert.match(html, /일일 자금일보/);
  assert.match(html, /손익·재무상태/);
  assert.match(html, /자금·채권채무/);
  assert.match(html, /원장·데이터 점검/);
  assert.match(html, /회사 재무정책/);
  assert.match(html, /재무 경보 조치/);
  assert.match(html, /매입·매출 분석/);
  assert.match(html, /외상·미수 관리/);
  assert.match(html, /차입금·상환·약정/);
  assert.match(html, /재무 데이터 어시스턴트/);
  assert.match(html, /세금계산서 매출/);
  assert.match(html, /잔액형 · 20\d\d-\d\d-\d\d~20\d\d-\d\d-\d\d 관측/);
  assert.doesNotMatch(html, />연동매출</);
  assert.match(html, /실제 재무 업무를 확인하고 있습니다/);
  assert.match(html, /최신 자금일보와 동결 스냅샷을 불러오는 중입니다/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/);
});

test("keeps the finance connection notice in the alarm center configuration", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /title: "2024~2026년 재무 데이터 연결 완료"/);
  assert.match(source, /destination: \{ module: "finance", financeView: "quality" \}/);
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
