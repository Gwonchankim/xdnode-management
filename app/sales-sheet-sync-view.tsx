"use client";

import { useEffect, useRef, useState } from "react";
import writeXlsxFile, { type SheetData } from "write-excel-file/browser";

type SyncRun = { id: string; sync_key: string; status: string; total_rows: number; imported_rows: number; error_message: string; requested_by: string; started_at: number; finished_at: number | null };
type SummaryRow = { deal_status: string; count: number; sale_total: number };
type RevenueRecord = { id: string; source_sheet: string; deal_status: string; rep: string; order_date: string; customer_name: string; end_customer_name: string; item: string; quantity: number; sale_total: number; margin: number; collected_date: string };
type TabRecord = Record<string, unknown> & { id: string };
type TabData = { key: string; sheetName: string; tableName: string; latestRun: SyncRun | null; count: number; records: TabRecord[] };
type SyncData = { configured: boolean; latestRun: SyncRun | null; summary: SummaryRow[]; records: RevenueRecord[]; tabs: TabData[]; recentRuns: SyncRun[] };

const won = (value: number) => `₩${Number(value ?? 0).toLocaleString("ko-KR")}`;
const dealStatusLabels: Record<string, string> = { CONFIRMED: "확정(26년 매출)", IN_PROGRESS: "진행 딜" };
const runStatusLabels: Record<string, string> = { RUNNING: "동기화 중", SUCCESS: "성공", FAILED: "실패" };
const syncKeyLabels: Record<string, string> = { revenue: "매출 원장", lead_protection: "영업보호", inbound_lead: "인바운드 영업", delivery: "서버납품", service_log: "AS", price_catalog: "매입단가고지" };
const str = (record: TabRecord, key: string) => (record[key] ? String(record[key]) : "");

function elapsed(started: number | undefined) {
  if (!started) return "-";
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

// Compact preview per tab: title fields (bold, shown together) and a few detail chips underneath.
const TAB_META: Record<string, { title: string; description: string; titleFields: string[]; detailFields: Array<{ key: string; format?: "won" }> }> = {
  lead_protection: { title: "영업보호 (재고 선점권)", description: "요청업체·고객사가 제품 선점을 등록한 순서를 기록합니다.",
    titleFields: ["customer_company", "product"], detailFields: [{ key: "registered_date" }, { key: "sales_rep" }, { key: "progress" }] },
  inbound_lead: { title: "인바운드 영업 (웹 문의 리드)", description: "웹 유입 문의부터 계약 완료까지의 진행 상태를 기록합니다.",
    titleFields: ["company", "product"], detailFields: [{ key: "inflow_date" }, { key: "stage" }, { key: "quote_amount", format: "won" }] },
  delivery: { title: "서버납품", description: "확정 매출의 실제 납품 이력입니다.",
    titleFields: ["customer_name", "model"], detailFields: [{ key: "delivery_date" }, { key: "quantity" }, { key: "serial" }] },
  service_log: { title: "AS (사후지원 로그)", description: "현장에서 바로 기록하는 AS·RMA 처리 로그입니다. 정식 SLA 케이스는 서비스 관리 화면을 이용하세요.",
    titleFields: ["product_name", "customer_name"], detailFields: [{ key: "shipped_date" }, { key: "issue_description" }, { key: "result" }] },
  price_catalog: { title: "매입단가고지", description: "품목별 원가·소비자가 고지 내역입니다. 상품 카탈로그 기본단가는 자동으로 바뀌지 않습니다.",
    titleFields: ["item"], detailFields: [{ key: "cost", format: "won" }, { key: "retail_price", format: "won" }, { key: "notice" }] },
};

// Full column sets for Excel export (broader than the compact on-screen preview).
const EXPORT_COLUMNS: Record<string, Array<{ label: string; key: string }>> = {
  revenue: [
    { label: "담당자", key: "rep" }, { label: "발주일", key: "order_date" }, { label: "계산서일", key: "invoice_date" },
    { label: "매출처", key: "customer_name" }, { label: "최종고객", key: "end_customer_name" }, { label: "품목", key: "item" },
    { label: "수량", key: "quantity" }, { label: "원가", key: "cost" }, { label: "매출단가", key: "sale_price" },
    { label: "매출합", key: "sale_total" }, { label: "마진", key: "margin" }, { label: "수금예정일", key: "collection_due_date" },
    { label: "수금일", key: "collected_date" }, { label: "비고", key: "note" },
  ],
  lead_protection: [
    { label: "등록일", key: "registered_date" }, { label: "요청업체", key: "requester_company" }, { label: "담당자", key: "contact_person" },
    { label: "고객사", key: "customer_company" }, { label: "실수요자", key: "end_user" }, { label: "연락처", key: "phone" },
    { label: "이메일", key: "email" }, { label: "제품", key: "product" }, { label: "진행시기", key: "timing" },
    { label: "영업담당자", key: "sales_rep" }, { label: "진행율", key: "progress" }, { label: "프로젝트명", key: "project_name" }, { label: "기타", key: "note" },
  ],
  inbound_lead: [
    { label: "유입일", key: "inflow_date" }, { label: "채널", key: "channel" }, { label: "문의유형", key: "inquiry_type" },
    { label: "회사", key: "company" }, { label: "담당자", key: "contact_person" }, { label: "연락처", key: "phone" },
    { label: "제품", key: "product" }, { label: "수량", key: "quantity" }, { label: "견적금액", key: "quote_amount" },
    { label: "진행단계", key: "stage" }, { label: "최종결과", key: "final_result" }, { label: "계약금액", key: "contract_amount" },
    { label: "마진", key: "margin" }, { label: "계약완료일", key: "contract_completed_date" }, { label: "메모", key: "memo" },
  ],
  delivery: [
    { label: "납품일", key: "delivery_date" }, { label: "계산서일", key: "invoice_date" }, { label: "담당자", key: "rep" },
    { label: "매출처", key: "customer_name" }, { label: "모델명", key: "model" }, { label: "수량", key: "quantity" },
    { label: "시리얼", key: "serial" }, { label: "비고", key: "note" },
  ],
  service_log: [
    { label: "제품명", key: "product_name" }, { label: "시리얼", key: "serial_number" }, { label: "매입처", key: "purchase_vendor" },
    { label: "매출처", key: "customer_name" }, { label: "영업담당자", key: "sales_rep" }, { label: "출고일", key: "shipped_date" },
    { label: "오류내용", key: "issue_description" }, { label: "제품입고일", key: "product_received_date" },
    { label: "반송/환불/대체", key: "return_refund_replace" }, { label: "RMA유형", key: "rma_result_type" }, { label: "결과", key: "result" },
  ],
  price_catalog: [
    { label: "품목", key: "item" }, { label: "원가", key: "cost" }, { label: "소비자가", key: "retail_price" },
    { label: "부가세포함", key: "retail_price_vat_included" }, { label: "고지", key: "notice" },
  ],
};

function toSheet(title: string, columns: Array<{ label: string; key: string }>, rows: TabRecord[]): SheetData {
  return [
    columns.map((column) => ({ value: column.label, fontWeight: "bold" as const, backgroundColor: "#F4F4F5" })),
    ...rows.map((row) => columns.map((column) => ({ value: row[column.key] ?? "" } as { value: string | number }))),
  ];
}

export default function SalesSheetSyncView() {
  const [data, setData] = useState<SyncData | null>(null);
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(query = "") {
    try {
      const response = await fetch(`/api/sales/sheet-sync${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      const result = await response.json() as SyncData & { error?: string };
      if (!response.ok) throw new Error(result.error || "구글 시트 동기화 현황을 불러오지 못했습니다.");
      setData(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구글 시트 동기화 현황을 불러오지 못했습니다.");
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(value), 300);
  }

  async function sync(only?: string) {
    setSyncing(only ?? "all"); setMessage("");
    try {
      const response = await fetch(`/api/sales/sheet-sync${only ? `?only=${only}` : ""}`, { method: "POST" });
      const result = await response.json() as SyncData & { error?: string };
      if (!response.ok) throw new Error(result.error || "구글 시트 동기화에 실패했습니다.");
      setData(result);
      if (only) {
        const run = only === "revenue" ? result.latestRun : result.tabs.find((tab) => tab.key === only)?.latestRun;
        setMessage(`${syncKeyLabels[only] ?? only} 재동기화 완료: ${run?.imported_rows ?? 0}행 반영`);
      } else {
        const tabTotal = result.tabs.reduce((sum, tab) => sum + (tab.latestRun?.imported_rows ?? 0), 0);
        setMessage(`동기화 완료: 매출 ${result.latestRun?.imported_rows ?? 0}행 · 나머지 탭 ${tabTotal}행 반영`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구글 시트 동기화에 실패했습니다.");
    } finally {
      setSyncing(null);
    }
  }

  async function exportCurrent() {
    if (!data) return;
    setExporting(true); setMessage("");
    try {
      const sheets = [
        { sheet: "매출원장", data: toSheet("매출원장", EXPORT_COLUMNS.revenue, data.records as unknown as TabRecord[]), freezeRows: 1, showGridLines: true },
        ...data.tabs.filter((tab) => EXPORT_COLUMNS[tab.key] && tab.records.length).map((tab) => ({
          sheet: syncKeyLabels[tab.key] ?? tab.key, data: toSheet(tab.key, EXPORT_COLUMNS[tab.key], tab.records), freezeRows: 1, showGridLines: true,
        })),
      ];
      await writeXlsxFile(sheets).toFile(`XD_NODE_영업시트_${search ? `검색_${search}` : "현재목록"}.xlsx`);
      setMessage("현재 화면에 보이는 목록을 엑셀로 저장했습니다.");
    } catch {
      setMessage("엑셀 파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setExporting(false);
    }
  }

  async function convertLead(leadId: string) {
    setConverting(leadId); setMessage("");
    try {
      const response = await fetch("/api/sales/sheet-sync/insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "CONVERT_LEAD", leadId }) });
      const result = await response.json() as { opportunityId?: string; alreadyConverted?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || "영업기회로 전환하지 못했습니다.");
      setMessage(result.alreadyConverted ? "이미 영업기회로 전환된 리드입니다." : "영업기회로 전환했습니다. \"영업 운영\" 탭 파이프라인에서 확인하세요.");
      await load(search);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "영업기회로 전환하지 못했습니다.");
    } finally {
      setConverting(null);
    }
  }

  const confirmed = data?.summary.find((row) => row.deal_status === "CONFIRMED");
  const inProgress = data?.summary.find((row) => row.deal_status === "IN_PROGRESS");

  return <section className="panel sales-sheet-sync-view">
    <header><div data-korean-heading><h2>구글 시트 영업 데이터 동기화</h2><span>'26년 매출'·'진행 딜'을 포함해 시트 7개 탭을 읽어와 반영합니다. 버튼을 누를 때만 동기화합니다.</span></div>
      <div className="sales-sheet-sync-actions">
        <button type="button" disabled={exporting || !data?.records.length && !data?.tabs.some((tab) => tab.records.length)} onClick={() => void exportCurrent()}>{exporting ? "내보내는 중…" : "엑셀로 내보내기"}</button>
        <button type="button" disabled={Boolean(syncing) || data?.configured === false} onClick={() => void sync()}>{syncing === "all" ? "동기화 중…" : "지금 동기화"}</button>
      </div>
    </header>
    {message && <div className="sales-live-message" role="status">{message}</div>}
    {data?.configured === false && <div className="sales-live-message">구글 시트 연동 자격증명이 설정되지 않았습니다.</div>}
    <div className="sales-live-metrics">
      <article><small>확정 매출 (26년 매출)</small><strong>{won(confirmed?.sale_total ?? 0)}</strong><span>{confirmed?.count ?? 0}건</span></article>
      <article><small>진행 딜</small><strong>{won(inProgress?.sale_total ?? 0)}</strong><span>{inProgress?.count ?? 0}건</span></article>
      <article><small>최근 동기화</small><strong>{data?.latestRun ? runStatusLabels[data.latestRun.status] ?? data.latestRun.status : "이력 없음"}</strong><span>{elapsed(data?.latestRun?.started_at)}</span></article>
      <article><small>최근 반영 건수</small><strong>{data?.latestRun?.imported_rows ?? 0}행</strong><span>{data?.latestRun?.error_message || "오류 없음"}</span></article>
    </div>
    <div className="sales-sheet-sync-search">
      <input type="search" placeholder="고객사·담당자·품목으로 전체 표 검색" value={search} onChange={(event) => onSearchChange(event.target.value)} />
      {search && <span>"{search}" 검색 결과 (표마다 최대 200건)</span>}
    </div>
    <div className="sales-sheet-sync-table">
      <div className="head"><span>구분</span><span>담당자</span><span>발주일</span><span>매출처</span><span>품목</span><span>수량</span><span>매출합</span><span>마진</span><span>수금일</span></div>
      {(data?.records ?? []).map((record) => <div key={record.id}><em>{dealStatusLabels[record.deal_status] ?? record.deal_status}</em><span>{record.rep || "-"}</span><time>{record.order_date || "-"}</time><span>{record.customer_name}{record.end_customer_name ? ` · ${record.end_customer_name}` : ""}</span><span>{record.item}</span><span>{record.quantity}</span><strong>{won(record.sale_total)}</strong><span>{won(record.margin)}</span><span>{record.collected_date || "미수금"}</span></div>)}
      {!data?.records.length && <div className="finance-empty">{search ? "검색 결과가 없습니다." : "동기화된 매출 기록이 없습니다. \"지금 동기화\"를 눌러 시트 데이터를 반영해 주세요."}</div>}
    </div>

    {(data?.tabs ?? []).map((tab) => {
      const meta = TAB_META[tab.key];
      if (!meta) return null;
      return <div className="sales-sheet-sync-tab" key={tab.key}>
        <header><div><h3>{meta.title}</h3><span>{meta.description}</span></div><div className="sales-sheet-sync-tab-status"><em>{tab.count}건 · {tab.latestRun ? (runStatusLabels[tab.latestRun.status] ?? tab.latestRun.status) : "이력 없음"} · {elapsed(tab.latestRun?.started_at)}</em><button type="button" disabled={Boolean(syncing) || data?.configured === false} onClick={() => void sync(tab.key)}>{syncing === tab.key ? "재동기화 중…" : "이 표만 재동기화"}</button></div></header>
        <div className="sales-sheet-sync-tab-list">
          {tab.records.map((record) => <div key={record.id} className={tab.key === "inbound_lead" ? "with-action" : ""}>
            <p>{meta.titleFields.map((field) => str(record, field)).filter(Boolean).join(" · ") || "(내용 없음)"}</p>
            <span>{meta.detailFields.map((field) => field.format === "won" ? won(Number(record[field.key] ?? 0)) : str(record, field.key)).filter(Boolean).join(" · ") || "-"}</span>
            {tab.key === "inbound_lead" && (record.converted
              ? <em>영업기회 전환됨</em>
              : <button type="button" disabled={converting === record.id} onClick={() => void convertLead(record.id)}>{converting === record.id ? "전환 중…" : "영업기회로 전환"}</button>)}
          </div>)}
          {!tab.records.length && <div className="finance-empty">{search ? "검색 결과가 없습니다." : "동기화된 기록이 없습니다."}</div>}
        </div>
      </div>;
    })}

    <div className="sales-sheet-sync-history">
      <h3>최근 동기화 이력</h3>
      {(data?.recentRuns ?? []).slice(0, 10).map((run) => <div key={run.id}><em className={run.status.toLowerCase()}>{runStatusLabels[run.status] ?? run.status}</em><span>{(syncKeyLabels[run.sync_key] ?? run.sync_key) || "-"}</span><time>{new Date(run.started_at).toLocaleString("ko-KR")}</time><span>{run.status === "FAILED" ? run.error_message : `${run.imported_rows}행`}</span></div>)}
      {!data?.recentRuns.length && <div className="finance-empty">동기화 이력이 없습니다.</div>}
    </div>
  </section>;
}
