"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import SalesPlanningView from "./sales-planning-view";
import SalesAccount360View from "./sales-account-360-view";
import SalesPricingGovernance from "./sales-pricing-governance";
import SalesContractManagement from "./sales-contract-management";
import SalesServiceManagement from "./sales-service-management";
import SalesSheetDataHub from "./sales-sheet-data-hub";
import SalesSheetAnalyticsView from "./sales-sheet-analytics-view";

type Account = { id: string; name: string; businessNumber: string; industry: string; ownerEmployeeId: string; status: string; memo: string };
type Opportunity = { id: string; accountId: string; accountName: string; title: string; ownerEmployeeId: string; stage: string; leadType: string; expectedRevenue: number; expectedCost: number; probability: number; expectedCloseDate: string; nextAction: string; nextActionDate: string; status: string };
type CatalogItem = { id: string; code: string; name: string; itemType: string; unit: string; defaultUnitPrice: number; status: string };
type DocumentLine = { id: string; documentId: string; lineNumber: number; catalogItemId: string; catalogCode: string; catalogName: string; description: string; quantity: number; unit: string; unitPrice: number; amount: number; sourceLineId: string; orderedQuantity: number; deliveredQuantity: number; invoicedQuantity: number };
type SalesDocument = { id: string; opportunityId: string; opportunityTitle: string; accountName: string; documentType: string; documentNumber: string; version: number; amount: number; status: string; issuedDate: string; dueDate: string; sourceDocumentId: string; sourceDocumentNumber: string; reservedAmount: number; collectedAmount: number; outstandingAmount: number; linkedInvoiceId: string; linkedInvoiceNumber: string; lines: DocumentLine[] };
type SalesData = { dataStatus: { crm: string; incentive: string }; accounts: Account[]; opportunities: Opportunity[]; documents: SalesDocument[]; catalog: CatalogItem[]; incentiveRules: Array<{ id: string; name: string; version: number; status: string }> };
type Contact = { id: string; accountId: string; name: string; title: string; email: string; phone: string; isPrimary: boolean; status: string; createdBy: string; createdAt: number };
type Activity = { id: string; opportunityId: string; contactId: string; contactName: string; activityType: string; occurredAt: string; summary: string; nextAction: string; nextActionDate: string; createdBy: string; createdAt: number };
type StageHistory = { id: string; opportunityId: string; fromStage: string; toStage: string; reason: string; changedBy: string; changedAt: number };
type CrmData = { opportunity: Opportunity; contacts: Contact[]; activities: Activity[]; stageHistory: StageHistory[] };
type SalesSection = "accounts" | "planning" | "catalog" | "contracts" | "service" | "documents" | "sheet_data" | "analytics";

const salesNavigation: Array<{ title: string; items: Array<[SalesSection, string, string]> }> = [
  { title: "영업 활동", items: [
    ["accounts", "거래처·영업기회", "거"],
    ["planning", "영업 목표·전망", "목"],
    ["catalog", "상품·가격", "상"],
    ["contracts", "계약 관리", "계"],
    ["service", "사후지원", "사"],
    ["documents", "견적·수주·납품·청구", "견"],
  ] },
  { title: "데이터 연동", items: [["sheet_data", "구글시트 데이터", "구"], ["analytics", "매출 분석", "분"]] },
];

const stageLabels: Record<string, string> = { LEAD: "리드", DISCOVERY: "요구 확인", PROPOSAL: "제안", CONTRACT: "계약 협의", WON: "수주", LOST: "실주" };
const dataLabels: Record<string, string> = { MANUAL: "수기 관리", NOT_CONNECTED: "미연결", APPROVED: "승인 규칙", UNVERIFIED: "규칙 미확정" };
const salesDocumentLabels: Record<string, string> = { QUOTE: "견적", ORDER: "수주", DELIVERY: "납품", INVOICE: "청구", PAYMENT: "수금" };
const salesDocumentStatusLabels: Record<string, string> = { DRAFT: "작성 중", ISSUED: "발행", ACCEPTED: "확정", COMPLETED: "완료", CANCELLED: "취소" };
const activityLabels: Record<string, string> = { CALL: "전화", EMAIL: "이메일", MEETING: "회의", NOTE: "메모" };
const nextStage: Record<string, string> = { LEAD: "DISCOVERY", DISCOVERY: "PROPOSAL", PROPOSAL: "CONTRACT", CONTRACT: "WON" };
const sourceTypes: Record<string, string[]> = { QUOTE: [], ORDER: ["QUOTE"], DELIVERY: ["ORDER"], INVOICE: ["ORDER", "DELIVERY"], PAYMENT: [] };
const currency = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const localDateTime = () => { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };
const availableDocumentStatuses = (document: SalesDocument) => document.documentType === "PAYMENT" && document.status === "ACCEPTED"
  ? [["ACCEPTED", "확정"], ["COMPLETED", "완료"]]
  : document.documentType === "PAYMENT" && document.status === "COMPLETED"
    ? [["COMPLETED", "완료"]]
    : Object.entries(salesDocumentStatusLabels);

export default function SalesWorkspace({ search, createRequestKey = 0 }: { search: string; createRequestKey?: number }) {
  const [data, setData] = useState<SalesData | null>(null);
  const [message, setMessage] = useState("");
  const [accountDraft, setAccountDraft] = useState({ name: "", businessNumber: "", industry: "", memo: "" });
  const [opportunityDraft, setOpportunityDraft] = useState({ accountId: "", title: "", leadType: "OUTBOUND", stage: "LEAD", expectedRevenue: "", expectedCost: "", probability: "10", expectedCloseDate: "", nextAction: "", nextActionDate: "" });
  const [catalogDraft, setCatalogDraft] = useState({ code: "", name: "", itemType: "PRODUCT", unit: "EA", defaultUnitPrice: "" });
  const [documentDraft, setDocumentDraft] = useState({ opportunityId: "", documentType: "QUOTE", sourceDocumentId: "", invoiceDocumentId: "", documentNumber: "", amount: "", issuedDate: "", dueDate: "" });
  const [documentLines, setDocumentLines] = useState<Array<{ catalogItemId: string; quantity: string; unitPrice: string; sourceLineId: string; maxQuantity: number | null }>>([{ catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }]);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [crm, setCrm] = useState<CrmData | null>(null);
  const [contactDraft, setContactDraft] = useState({ name: "", title: "", email: "", phone: "", isPrimary: false });
  const [activityDraft, setActivityDraft] = useState({ activityType: "CALL", contactId: "", occurredAt: localDateTime(), summary: "", nextAction: "", nextActionDate: "" });
  const opportunityPanelRef = useRef<HTMLElement>(null);
  const opportunityTitleRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<SalesSection>("accounts");

  async function load() {
    try {
      const response = await fetch("/api/sales");
      const result = await response.json() as SalesData & { error?: string };
      if (!response.ok) throw new Error(result.error || "영업 데이터를 불러오지 못했습니다.");
      setData(result);
      const firstActiveAccount = result.accounts.find((account) => account.status === "ACTIVE");
      if (!opportunityDraft.accountId && firstActiveAccount) setOpportunityDraft((current) => ({ ...current, accountId: firstActiveAccount.id }));
      if (!documentDraft.opportunityId && result.opportunities[0]) setDocumentDraft((current) => ({ ...current, opportunityId: result.opportunities[0].id }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "영업 데이터를 불러오지 못했습니다.");
    }
  }
  async function loadCrm(opportunityId: string) {
    try {
      const response = await fetch(`/api/sales/crm?opportunityId=${encodeURIComponent(opportunityId)}`);
      const result = await response.json() as CrmData & { error?: string };
      if (!response.ok) throw new Error(result.error || "영업 상세를 불러오지 못했습니다.");
      setCrm(result);
      setSelectedOpportunityId(opportunityId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "영업 상세를 불러오지 못했습니다.");
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!createRequestKey) return;
    setSection("accounts");
    window.setTimeout(() => {
      opportunityPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      opportunityTitleRef.current?.focus();
    }, 50);
  }, [createRequestKey]);

  const opportunities = useMemo(() => (data?.opportunities ?? []).filter((item) => `${item.accountName} ${item.title}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const open = opportunities.filter((item) => item.status === "OPEN");
  const pipeline = open.reduce((sum, item) => sum + item.expectedRevenue, 0);
  const weightedPipeline = open.reduce((sum, item) => sum + item.expectedRevenue * item.probability / 100, 0);
  const expectedMargin = open.reduce((sum, item) => sum + item.expectedRevenue - item.expectedCost, 0);
  const invoices = (data?.documents ?? []).filter((item) => item.documentType === "INVOICE" && ["ACCEPTED", "COMPLETED"].includes(item.status));
  const selectableInvoices = invoices.filter((item) => item.opportunityId === documentDraft.opportunityId && item.amount - item.reservedAmount > 0);
  const sourceDocuments = (data?.documents ?? []).filter((item) => item.opportunityId === documentDraft.opportunityId
    && sourceTypes[documentDraft.documentType]?.includes(item.documentType) && ["ACCEPTED", "COMPLETED"].includes(item.status));
  const documentLineTotal = documentLines.reduce((sum, line) => sum + Math.round(Number(line.quantity || 0) * Number(line.unitPrice || 0)), 0);
  const acceptedInvoiceTotal = invoices.reduce((sum, item) => sum + item.amount, 0);
  const collectedTotal = invoices.reduce((sum, item) => sum + item.collectedAmount, 0);

  async function create(event: FormEvent<HTMLFormElement>, resource: "account" | "opportunity") {
    event.preventDefault(); setMessage("");
    const payload = resource === "account" ? accountDraft : { ...opportunityDraft, expectedRevenue: Number(opportunityDraft.expectedRevenue), expectedCost: Number(opportunityDraft.expectedCost), probability: Number(opportunityDraft.probability) };
    const response = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, ...payload }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "저장하지 못했습니다."); return; }
    setMessage(resource === "account" ? "거래처를 등록했습니다." : "영업 건을 등록했습니다.");
    if (resource === "account") setAccountDraft({ name: "", businessNumber: "", industry: "", memo: "" });
    else setOpportunityDraft((current) => ({ ...current, title: "", expectedRevenue: "", expectedCost: "", expectedCloseDate: "", nextAction: "", nextActionDate: "" }));
    await load();
  }

  async function updateStage(id: string, stage: string) {
    const reasonLabel = stage === "LOST" ? "실주 사유를 10자 이상 입력해 주세요." : "단계 변경 근거를 5자 이상 입력해 주세요.";
    const reason = window.prompt(reasonLabel, "");
    if (reason === null) return;
    const response = await fetch("/api/sales", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, stage, reason }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "단계를 변경하지 못했습니다."); return; }
    await load();
    if (selectedOpportunityId === id) await loadCrm(id);
  }

  async function createContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!crm) return;
    const response = await fetch("/api/sales/crm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "contact", accountId: crm.opportunity.accountId, ...contactDraft }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "고객 담당자를 저장하지 못했습니다."); return; }
    setContactDraft({ name: "", title: "", email: "", phone: "", isPrimary: false });
    setMessage("고객 담당자를 등록했습니다.");
    await loadCrm(selectedOpportunityId);
  }

  async function createActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!crm) return;
    const response = await fetch("/api/sales/crm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "activity", opportunityId: selectedOpportunityId, ...activityDraft }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "영업 활동을 저장하지 못했습니다."); return; }
    setActivityDraft({ activityType: "CALL", contactId: "", occurredAt: localDateTime(), summary: "", nextAction: "", nextActionDate: "" });
    setMessage("영업 활동과 다음 행동을 기록했습니다.");
    await Promise.all([load(), loadCrm(selectedOpportunityId)]);
  }

  async function createCatalogItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage("");
    const response = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "catalog", ...catalogDraft, defaultUnitPrice: Number(catalogDraft.defaultUnitPrice) }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "상품·서비스를 저장하지 못했습니다."); return; }
    setCatalogDraft({ code: "", name: "", itemType: "PRODUCT", unit: "EA", defaultUnitPrice: "" });
    setMessage("상품·서비스 기준정보를 등록했습니다."); await load();
  }

  async function toggleCatalogItem(item: CatalogItem) {
    const nextStatus = item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const response = await fetch("/api/sales", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "catalog", id: item.id, ...item, status: nextStatus, reason: nextStatus === "INACTIVE" ? "신규 영업 문서 사용 중지" : "신규 영업 문서 사용 재개" }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "기준정보 상태를 변경하지 못했습니다."); return; }
    setMessage(nextStatus === "ACTIVE" ? "상품·서비스를 다시 활성화했습니다." : "상품·서비스를 비활성화했습니다. 과거 문서에는 영향이 없습니다.");
    await load();
  }

  function changeDocumentType(documentType: string) {
    setDocumentDraft((current) => ({ ...current, documentType, sourceDocumentId: "", invoiceDocumentId: "", amount: "" }));
    setDocumentLines([{ catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }]);
  }

  function selectSourceDocument(sourceDocumentId: string) {
    setDocumentDraft((current) => ({ ...current, sourceDocumentId }));
    const source = (data?.documents ?? []).find((item) => item.id === sourceDocumentId);
    if (!source) { setDocumentLines([{ catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }]); return; }
    const usageKey = documentDraft.documentType === "ORDER" ? "orderedQuantity" : documentDraft.documentType === "DELIVERY" ? "deliveredQuantity" : "invoicedQuantity";
    setDocumentLines(source.lines.map((line) => {
      const remaining = Math.max(0, line.quantity - line[usageKey]);
      return { catalogItemId: line.catalogItemId, quantity: String(remaining), unitPrice: String(line.unitPrice), sourceLineId: line.id, maxQuantity: remaining };
    }).filter((line) => line.maxQuantity > 0));
  }

  function updateDocumentLine(index: number, patch: Partial<(typeof documentLines)[number]>) {
    setDocumentLines((current) => current.map((line, lineIndex) => {
      if (lineIndex !== index) return line;
      const next = { ...line, ...patch };
      if (patch.catalogItemId !== undefined) {
        const item = data?.catalog.find((catalog) => catalog.id === patch.catalogItemId);
        if (item) next.unitPrice = String(item.defaultUnitPrice);
      }
      return next;
    }));
  }

  async function createDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage("");
    const lines = documentDraft.documentType === "PAYMENT" ? [] : documentLines.map((line) => ({ catalogItemId: line.catalogItemId, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice), sourceLineId: line.sourceLineId }));
    const response = await fetch("/api/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "document", ...documentDraft, amount: Number(documentDraft.amount), lines }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "영업 문서를 저장하지 못했습니다."); return; }
    setMessage(`${salesDocumentLabels[documentDraft.documentType]} 문서를 저장했습니다.`);
    setDocumentDraft((current) => ({ ...current, sourceDocumentId: "", invoiceDocumentId: "", documentNumber: "", amount: "", issuedDate: "", dueDate: "" }));
    setDocumentLines([{ catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }]);
    await load();
  }

  async function updateDocumentStatus(id: string, status: string) {
    const response = await fetch("/api/sales", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: "document", id, status }) });
    const result = await response.json() as { error?: string; approvalSubmitted?: boolean };
    if (!response.ok) { setMessage(result.error || "문서 상태를 변경하지 못했습니다."); return; }
    setMessage(result.approvalSubmitted ? "전자결재를 제출했습니다. 승인 후 문서가 확정됩니다." : "문서 상태를 변경했습니다.");
    await load();
  }

  return <div className="sales-workspace-layout">
    <aside className="sales-side-navigation" aria-label="영업 메뉴">
      <div className="sales-side-brand"><span>영</span><div><strong>영업</strong></div></div>
      <nav>
        {salesNavigation.map((group) => (
          <div className="sales-side-group" key={group.title}>
            <p>{group.title}</p>
            {group.items.map(([key, label, icon]) => (
              <button type="button" aria-current={section === key ? "page" : undefined} className={section === key ? "active" : ""} key={key} onClick={() => setSection(key)}>
                <span>{icon}</span><strong>{label}</strong>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sales-side-footer">
        <span>연동 상태</span>
        <div><span className={`source-state ${(data?.dataStatus.crm ?? "NOT_CONNECTED").toLowerCase()}`}>{dataLabels[data?.dataStatus.crm ?? "NOT_CONNECTED"]}</span></div>
      </div>
    </aside>

    <div className="sales-workspace-live">
    {message && <div className="sales-live-message" role="status">{message}</div>}

    {section === "sheet_data" && <SalesSheetDataHub />}

    {section === "analytics" && <SalesSheetAnalyticsView />}

    {section === "planning" && <SalesPlanningView />}

    {section === "accounts" && <>
    <section className="sales-live-metrics">
      <article><small>진행 영업 건</small><strong>{open.length}건</strong><span>실제 등록 기준</span></article>
      <article><small>파이프라인</small><strong>{currency(pipeline)}</strong><span>예상 매출 합계</span></article>
      <article><small>가중 파이프라인</small><strong>{currency(weightedPipeline)}</strong><span>성공확률 반영</span></article>
      <article><small>예상 이익</small><strong>{currency(expectedMargin)}</strong><span>예상 매출 - 예상 원가</span></article>
    </section>

    <section className="sales-live-grid">
      <article className="panel sales-entry-panel">
        <header><div data-korean-heading><h2>거래처 등록</h2></div><span>{data?.accounts.length ?? 0}곳</span></header>
        <form onSubmit={(event) => void create(event, "account")}><label>거래처명<input required value={accountDraft.name} onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })} /></label><label>사업자번호<input value={accountDraft.businessNumber} onChange={(event) => setAccountDraft({ ...accountDraft, businessNumber: event.target.value })} /></label><label>업종<input value={accountDraft.industry} onChange={(event) => setAccountDraft({ ...accountDraft, industry: event.target.value })} /></label><button type="submit">+ 거래처 등록</button></form>
        <div className="sales-account-list">{(data?.accounts ?? []).map((item) => <div key={item.id}><p><strong>{item.name}</strong><small>{item.businessNumber || "사업자번호 미입력"}</small></p><span>{item.industry || "업종 미입력"}</span><em>{item.status === "ACTIVE" ? "활성" : "비활성"}</em><button type="button" onClick={() => setSelectedAccountId(item.id)} aria-label={`${item.name} 고객 360도 열기`}>360°</button></div>)}{!data?.accounts.length && <p>등록된 거래처가 없습니다.</p>}</div>
      </article>

      <article className="panel sales-entry-panel opportunity-entry" ref={opportunityPanelRef}>
        <header><div data-korean-heading><h2>영업 건 등록</h2></div><span>원가 포함</span></header>
        <form onSubmit={(event) => void create(event, "opportunity")}>
          <label>거래처<select required value={opportunityDraft.accountId} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, accountId: event.target.value })}><option value="">선택</option>{(data?.accounts ?? []).filter((item) => item.status === "ACTIVE").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>영업 건명<input ref={opportunityTitleRef} required value={opportunityDraft.title} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, title: event.target.value })} /></label>
          <label>유형<select value={opportunityDraft.leadType} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, leadType: event.target.value })}><option value="OUTBOUND">아웃바운드</option><option value="INBOUND">인바운드</option><option value="RAM">RAM 단독</option></select></label>
          <label>예상 매출<input required type="number" min="0" value={opportunityDraft.expectedRevenue} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, expectedRevenue: event.target.value })} /></label>
          <label>예상 원가<input required type="number" min="0" value={opportunityDraft.expectedCost} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, expectedCost: event.target.value })} /></label>
          <label>확률 %<input required type="number" min="0" max="100" value={opportunityDraft.probability} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, probability: event.target.value })} /></label>
          <label>예상 마감일<input type="date" value={opportunityDraft.expectedCloseDate} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, expectedCloseDate: event.target.value })} /></label>
          <label>다음 행동<input value={opportunityDraft.nextAction} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, nextAction: event.target.value })} /></label>
          <button type="submit">+ 영업 건 등록</button>
        </form>
      </article>
    </section>

    {selectedAccountId && <SalesAccount360View accountId={selectedAccountId} onClose={() => setSelectedAccountId("")} onChanged={load} />}

    <section className="panel sales-live-pipeline">
      <header><div data-korean-heading><h2>실제 영업 파이프라인</h2></div><span>{opportunities.length}건</span></header>
      <div className="sales-pipeline-row head"><span>거래처 / 영업 건</span><span>단계</span><span>예상 매출</span><span>예상 이익</span><span>확률</span><span>예정일</span><span>접점</span></div>
      {opportunities.map((item) => {
        const stageOptions = item.status === "OPEN" ? [item.stage, nextStage[item.stage], "LOST"].filter(Boolean) : [item.stage];
        return <div className={`sales-pipeline-row ${selectedOpportunityId === item.id ? "selected" : ""}`} key={item.id}><p><strong>{item.accountName}</strong><small>{item.title}</small></p><select value={item.stage} onChange={(event) => void updateStage(item.id, event.target.value)}>{stageOptions.map((value) => <option value={value} key={value}>{stageLabels[value]}</option>)}</select><b>{currency(item.expectedRevenue)}</b><span>{currency(item.expectedRevenue - item.expectedCost)}</span><span>{item.probability}%</span><time>{item.expectedCloseDate || "미정"}</time><button type="button" onClick={() => void loadCrm(item.id)}>상세</button></div>;
      })}
      {!opportunities.length && <div className="finance-empty">등록된 영업 기회가 없습니다. 위에서 거래처와 영업 건을 먼저 등록해 주세요.</div>}
    </section>

    {crm && <section className="panel sales-crm-detail">
      <header><div data-korean-heading><h2>{crm.opportunity.accountName} · {crm.opportunity.title}</h2><span>{stageLabels[crm.opportunity.stage]} · 다음 행동 {crm.opportunity.nextAction || "미지정"}{crm.opportunity.nextActionDate ? ` (${crm.opportunity.nextActionDate})` : ""}</span></div><button type="button" onClick={() => { setCrm(null); setSelectedOpportunityId(""); }}>닫기</button></header>
      <div className="sales-crm-grid">
        <article>
          <h3>고객 담당자</h3>
          <form onSubmit={createContact}><label>이름<input required value={contactDraft.name} onChange={(event) => setContactDraft({ ...contactDraft, name: event.target.value })} /></label><label>직책<input value={contactDraft.title} onChange={(event) => setContactDraft({ ...contactDraft, title: event.target.value })} /></label><label>이메일<input type="email" value={contactDraft.email} onChange={(event) => setContactDraft({ ...contactDraft, email: event.target.value })} /></label><label>연락처<input value={contactDraft.phone} onChange={(event) => setContactDraft({ ...contactDraft, phone: event.target.value })} /></label><label className="sales-crm-check"><input type="checkbox" checked={contactDraft.isPrimary} onChange={(event) => setContactDraft({ ...contactDraft, isPrimary: event.target.checked })} />대표 담당자</label><button type="submit">+ 담당자 등록</button></form>
          <div className="sales-contact-list">{crm.contacts.map((contact) => <div key={contact.id}><strong>{contact.name}{contact.isPrimary ? " · 대표" : ""}</strong><span>{contact.title || "직책 미입력"}</span><small>{contact.email || contact.phone}</small></div>)}{!crm.contacts.length && <p>등록된 고객 담당자가 없습니다.</p>}</div>
        </article>
        <article>
          <h3>영업 활동 기록</h3>
          <form onSubmit={createActivity}><label>종류<select value={activityDraft.activityType} onChange={(event) => setActivityDraft({ ...activityDraft, activityType: event.target.value })}>{Object.entries(activityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>고객 담당자<select value={activityDraft.contactId} onChange={(event) => setActivityDraft({ ...activityDraft, contactId: event.target.value })}><option value="">선택 안 함</option>{crm.contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} · {contact.title}</option>)}</select></label><label>발생 일시<input required type="datetime-local" value={activityDraft.occurredAt} onChange={(event) => setActivityDraft({ ...activityDraft, occurredAt: event.target.value })} /></label><label className="wide">상담 내용<textarea required minLength={5} value={activityDraft.summary} onChange={(event) => setActivityDraft({ ...activityDraft, summary: event.target.value })} /></label><label>다음 행동<input value={activityDraft.nextAction} onChange={(event) => setActivityDraft({ ...activityDraft, nextAction: event.target.value })} /></label><label>다음 행동 기한<input type="date" value={activityDraft.nextActionDate} onChange={(event) => setActivityDraft({ ...activityDraft, nextActionDate: event.target.value })} /></label><button type="submit">+ 활동 기록</button></form>
        </article>
      </div>
      <div className="sales-crm-ledgers">
        <article><h3>활동 타임라인</h3>{crm.activities.map((activity) => <div key={activity.id}><time>{activity.occurredAt.replace("T", " ")}</time><strong>{activityLabels[activity.activityType]}{activity.contactName ? ` · ${activity.contactName}` : ""}</strong><p>{activity.summary}</p>{activity.nextAction && <small>다음 행동: {activity.nextAction} · {activity.nextActionDate}</small>}</div>)}{!crm.activities.length && <p>아직 기록된 영업 활동이 없습니다.</p>}</article>
        <article><h3>단계 변경 이력</h3>{crm.stageHistory.map((history) => <div key={history.id}><time>{new Date(history.changedAt).toLocaleString("ko-KR")}</time><strong>{history.fromStage ? `${stageLabels[history.fromStage]} → ` : ""}{stageLabels[history.toStage]}</strong><p>{history.reason}</p></div>)}{!crm.stageHistory.length && <p>단계 변경 이력이 없습니다.</p>}</article>
      </div>
    </section>}
    </>}

    {section === "catalog" && <>
    <section className="panel sales-catalog-panel">
      <header><div data-korean-heading><h2>상품·서비스 기준정보</h2><span>영업 문서의 품목명·단위·기본단가를 통일합니다.</span></div><strong>{data?.catalog.length ?? 0}개</strong></header>
      <form onSubmit={createCatalogItem}><label>품목 코드<input required value={catalogDraft.code} onChange={(event) => setCatalogDraft({ ...catalogDraft, code: event.target.value })} placeholder="예: SVC-AI-001" /></label><label>명칭<input required value={catalogDraft.name} onChange={(event) => setCatalogDraft({ ...catalogDraft, name: event.target.value })} /></label><label>유형<select value={catalogDraft.itemType} onChange={(event) => setCatalogDraft({ ...catalogDraft, itemType: event.target.value })}><option value="PRODUCT">상품</option><option value="SERVICE">서비스</option></select></label><label>단위<input required value={catalogDraft.unit} onChange={(event) => setCatalogDraft({ ...catalogDraft, unit: event.target.value })} /></label><label>기본단가<input required type="number" min="0" value={catalogDraft.defaultUnitPrice} onChange={(event) => setCatalogDraft({ ...catalogDraft, defaultUnitPrice: event.target.value })} /></label><button type="submit">+ 기준정보 등록</button></form>
      <div className="sales-catalog-list">{(data?.catalog ?? []).map((item) => <div className={item.status === "INACTIVE" ? "inactive" : ""} key={item.id}><b>{item.code}</b><strong>{item.name}</strong><span>{item.itemType === "PRODUCT" ? "상품" : "서비스"}</span><span>{item.unit}</span><em>{currency(item.defaultUnitPrice)}</em><button type="button" onClick={() => void toggleCatalogItem(item)}>{item.status === "ACTIVE" ? "비활성" : "활성"}</button></div>)}{!data?.catalog.length && <p>먼저 상품 또는 서비스를 등록한 뒤 영업 문서를 작성해 주세요.</p>}</div>
    </section>

    <SalesPricingGovernance refreshKey={data?.documents.length ?? 0} />
    </>}

    {section === "contracts" && <SalesContractManagement refreshKey={data?.documents.filter((item) => item.documentType === "ORDER").length ?? 0} />}

    {section === "service" && <SalesServiceManagement refreshKey={data?.documents.filter((item) => item.documentType === "DELIVERY").length ?? 0} />}

    {section === "documents" && <>
    <section className="panel sales-document-flow">
      <header><div data-korean-heading><h2>견적·수주·납품·청구·수금</h2></div><span>{data?.documents.length ?? 0}개 문서</span></header>
      <div className="sales-live-metrics"><article><small>확정 청구</small><strong>{currency(acceptedInvoiceTotal)}</strong><span>{invoices.length}건</span></article><article><small>확정 수금</small><strong>{currency(collectedTotal)}</strong><span>승인·완료 수금</span></article><article><small>현재 미수금</small><strong>{currency(Math.max(0, acceptedInvoiceTotal - collectedTotal))}</strong><span>청구 - 확정 수금</span></article><article><small>수금 예약</small><strong>{currency(invoices.reduce((sum, item) => sum + Math.max(0, item.reservedAmount - item.collectedAmount), 0))}</strong><span>작성·결재 중 수금</span></article></div>
      <form className="sales-document-form sales-document-line-form" onSubmit={createDocument}>
        <div className="sales-document-fields">
          <label>영업 건<select required value={documentDraft.opportunityId} onChange={(event) => { setDocumentDraft({ ...documentDraft, opportunityId: event.target.value, sourceDocumentId: "", invoiceDocumentId: "" }); setDocumentLines([{ catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }]); }}><option value="">선택</option>{(data?.opportunities ?? []).map((item) => <option key={item.id} value={item.id}>{item.accountName} · {item.title}</option>)}</select></label>
          <label>문서 종류<select value={documentDraft.documentType} onChange={(event) => changeDocumentType(event.target.value)}>{Object.entries(salesDocumentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {documentDraft.documentType === "PAYMENT" && <label>대상 청구서<select required value={documentDraft.invoiceDocumentId} onChange={(event) => setDocumentDraft({ ...documentDraft, invoiceDocumentId: event.target.value })}><option value="">확정 청구서 선택</option>{selectableInvoices.map((item) => <option key={item.id} value={item.id}>{item.documentNumber} · 잔액 {currency(item.amount - item.reservedAmount)}</option>)}</select></label>}
          {["ORDER", "DELIVERY", "INVOICE"].includes(documentDraft.documentType) && <label>상위 문서<select required={["DELIVERY", "INVOICE"].includes(documentDraft.documentType)} value={documentDraft.sourceDocumentId} onChange={(event) => selectSourceDocument(event.target.value)}><option value="">{documentDraft.documentType === "ORDER" ? "신규 수주(견적 연결 없음)" : "승인 문서 선택"}</option>{sourceDocuments.map((item) => <option disabled={!item.lines.length} key={item.id} value={item.id}>{salesDocumentLabels[item.documentType]} {item.documentNumber}{item.lines.length ? ` · ${item.lines.length}개 품목` : " · 기존 총액 문서"}</option>)}</select></label>}
          <label>문서번호<input required value={documentDraft.documentNumber} onChange={(event) => setDocumentDraft({ ...documentDraft, documentNumber: event.target.value })} placeholder="견적·발주·세금계산서 번호" /></label>
          {documentDraft.documentType === "PAYMENT" ? <label>수금액<input required type="number" min="1" value={documentDraft.amount} onChange={(event) => setDocumentDraft({ ...documentDraft, amount: event.target.value })} /></label> : <label>품목 합계<input readOnly value={currency(documentLineTotal)} /></label>}
          <label>발행일<input type="date" value={documentDraft.issuedDate} onChange={(event) => setDocumentDraft({ ...documentDraft, issuedDate: event.target.value })} /></label>
          <label>예정일<input type="date" value={documentDraft.dueDate} onChange={(event) => setDocumentDraft({ ...documentDraft, dueDate: event.target.value })} /></label>
        </div>
        {documentDraft.documentType !== "PAYMENT" && <div className="sales-document-lines-editor">
          <div className="head"><span>품목</span><span>수량</span><span>단위</span><span>단가</span><span>금액</span><span>관리</span></div>
          {documentLines.map((line, index) => {
            const item = data?.catalog.find((catalog) => catalog.id === line.catalogItemId);
            return <div key={`${line.sourceLineId || "new"}-${index}`}><select required disabled={Boolean(documentDraft.sourceDocumentId)} value={line.catalogItemId} onChange={(event) => updateDocumentLine(index, { catalogItemId: event.target.value })}><option value="">품목 선택</option>{(data?.catalog ?? []).filter((catalog) => catalog.status === "ACTIVE").map((catalog) => <option key={catalog.id} value={catalog.id}>{catalog.code} · {catalog.name}</option>)}</select><input aria-label={`${index + 1}번 라인 수량`} required type="number" min="0.0001" step="any" max={line.maxQuantity ?? undefined} value={line.quantity} onChange={(event) => updateDocumentLine(index, { quantity: event.target.value })} /><span>{item?.unit || "-"}</span><input aria-label={`${index + 1}번 라인 단가`} required readOnly={Boolean(documentDraft.sourceDocumentId)} type="number" min="0" value={line.unitPrice} onChange={(event) => updateDocumentLine(index, { unitPrice: event.target.value })} /><strong>{currency(Math.round(Number(line.quantity || 0) * Number(line.unitPrice || 0)))}</strong><button type="button" onClick={() => setDocumentLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>삭제</button></div>;
          })}
          {!documentDraft.sourceDocumentId && <button type="button" className="add-line" onClick={() => setDocumentLines((current) => [...current, { catalogItemId: "", quantity: "1", unitPrice: "", sourceLineId: "", maxQuantity: null }])}>+ 품목 라인 추가</button>}
          {documentDraft.sourceDocumentId && !documentLines.length && <p>선택한 상위 문서에 처리 가능한 잔여 수량이 없습니다.</p>}
        </div>}
        <button type="submit" className="sales-document-submit" disabled={documentDraft.documentType !== "PAYMENT" && !documentLines.length}>+ 문서 저장</button>
      </form>
      <div className="sales-document-row head"><span>거래처 / 영업 건</span><span>종류</span><span>문서번호</span><span>버전</span><span>금액</span><span>발행·예정일</span><span>상태</span></div>
      {(data?.documents ?? []).map((document) => <div className="sales-document-row" key={document.id}><p><strong>{document.accountName}</strong><small>{document.opportunityTitle}{document.linkedInvoiceNumber ? ` · 청구 ${document.linkedInvoiceNumber}` : ""}</small><small>{document.lines.length ? `${document.lines[0].description}${document.lines.length > 1 ? ` 외 ${document.lines.length - 1}건` : ""}` : document.documentType === "PAYMENT" ? "수금 문서" : "기존 총액 문서"}{document.sourceDocumentNumber ? ` · 근거 ${document.sourceDocumentNumber}` : ""}</small></p><span>{salesDocumentLabels[document.documentType] ?? document.documentType}</span><b>{document.documentNumber}</b><span>v{document.version}</span><strong>{currency(document.amount)}{document.documentType === "INVOICE" && <small>{document.outstandingAmount === 0 ? "완납" : `미수 ${currency(document.outstandingAmount)}`}</small>}</strong><time>{document.issuedDate || "미발행"}<small>{document.dueDate ? ` → ${document.dueDate}` : ""}</small></time><select aria-label={`${document.documentNumber} 상태`} value={document.status} onChange={(event) => void updateDocumentStatus(document.id, event.target.value)}>{availableDocumentStatuses(document).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>)}
      {!data?.documents.length && <div className="finance-empty">영업 문서를 등록하면 견적부터 수금까지 한 흐름으로 확인할 수 있습니다.</div>}
    </section>
    </>}
    </div>
  </div>;
}
