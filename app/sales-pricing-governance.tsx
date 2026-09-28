"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type PriceItem = { id: string; catalogItemId: string; catalogCode: string; catalogName: string; listUnitPrice: number; standardUnitCost: number; minUnitPrice: number };
type PriceList = { id: string; name: string; version: number; currency: string; effectiveFrom: string; effectiveTo: string; status: string; items: PriceItem[] };
type Policy = { id: string; name: string; version: number; maxDiscountBps: number; minGrossMarginBps: number; status: string };
type Review = { documentId: string; documentType: string; documentNumber: string; documentStatus: string; accountName: string; opportunityTitle: string;
  priceListVersion: number; policyVersion: number; listAmount: number; quotedAmount: number; standardCostAmount: number; minimumAmount: number;
  discountBps: number; grossMarginBps: number; outcome: string; reasons: string[]; approvalRequestId: string };
type PricingDocument = { id: string; documentType: string; documentNumber: string; status: string; amount: number; accountName: string };
type PricingData = { configurationReady: boolean; activePriceListId: string; activePolicyId: string; priceLists: PriceList[]; policies: Policy[];
  reviews: Review[]; catalog: Array<{ id: string; code: string; name: string; unit: string; status: string }>; documents: PricingDocument[] };

const money = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const today = () => new Date().toISOString().slice(0, 10);
const outcomeLabels: Record<string, string> = {
  PASS: "기준 통과", DATA_MISSING: "기준정보 누락", EXCEPTION_REQUIRED: "예외 승인 필요",
  APPROVAL_PENDING: "예외 결재 중", APPROVED: "예외 승인", REJECTED: "예외 반려",
};

export default function SalesPricingGovernance({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<PricingData | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [listDraft, setListDraft] = useState({ name: "", currency: "KRW", effectiveFrom: today(), effectiveTo: "" });
  const [itemDraft, setItemDraft] = useState({ priceListId: "", catalogItemId: "", listUnitPrice: "", standardUnitCost: "", minUnitPrice: "" });
  const [policyDraft, setPolicyDraft] = useState({ name: "", maxDiscountPercent: "", minGrossMarginPercent: "" });

  async function load() {
    try {
      const response = await fetch("/api/sales/pricing");
      const result = await response.json() as PricingData & { error?: string };
      if (!response.ok) throw new Error(result.error || "가격 통제 데이터를 불러오지 못했습니다.");
      setData(result);
      const firstDraft = result.priceLists.find((item) => item.status === "DRAFT");
      const firstCatalog = result.catalog.find((item) => item.status === "ACTIVE");
      setItemDraft((current) => ({ ...current, priceListId: current.priceListId || firstDraft?.id || "", catalogItemId: current.catalogItemId || firstCatalog?.id || "" }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "가격 통제 데이터를 불러오지 못했습니다."); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [refreshKey]);

  async function act(action: string, payload: Record<string, unknown> = {}) {
    setBusy(action); setMessage("");
    try {
      const response = await fetch("/api/sales/pricing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "요청을 처리하지 못했습니다.");
      await load(); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "요청을 처리하지 못했습니다."); return false; }
    finally { setBusy(""); }
  }

  async function createList(event: FormEvent) {
    event.preventDefault();
    if (await act("CREATE_PRICE_LIST", listDraft)) { setListDraft({ name: "", currency: "KRW", effectiveFrom: today(), effectiveTo: "" }); setMessage("새 가격표 버전을 만들었습니다. 품목 가격을 입력한 뒤 활성화해 주세요."); }
  }
  async function saveItem(event: FormEvent) {
    event.preventDefault();
    if (await act("UPSERT_PRICE_ITEM", { ...itemDraft, listUnitPrice: Number(itemDraft.listUnitPrice), standardUnitCost: Number(itemDraft.standardUnitCost), minUnitPrice: Number(itemDraft.minUnitPrice) })) {
      setItemDraft((current) => ({ ...current, listUnitPrice: "", standardUnitCost: "", minUnitPrice: "" })); setMessage("가격표 품목을 저장했습니다.");
    }
  }
  async function createPolicy(event: FormEvent) {
    event.preventDefault();
    if (await act("CREATE_POLICY", { ...policyDraft, maxDiscountPercent: Number(policyDraft.maxDiscountPercent), minGrossMarginPercent: Number(policyDraft.minGrossMarginPercent) })) {
      setPolicyDraft({ name: "", maxDiscountPercent: "", minGrossMarginPercent: "" }); setMessage("새 가격정책 버전을 만들었습니다. 영업 승인 권한자가 활성화해 주세요.");
    }
  }
  async function requestException(documentId: string) {
    const reason = window.prompt("가격 예외 사유를 10자 이상 입력해 주세요. 결재 원장에 그대로 남습니다.", "");
    if (reason === null) return;
    if (await act("REQUEST_EXCEPTION", { documentId, reason })) setMessage("가격 예외 전자결재를 제출했습니다.");
  }

  const draftLists = data?.priceLists.filter((item) => item.status === "DRAFT") ?? [];
  const activeList = data?.priceLists.find((item) => item.id === data.activePriceListId);
  const activePolicy = data?.policies.find((item) => item.id === data.activePolicyId);
  const reviewsByDocument = useMemo(() => new Map((data?.reviews ?? []).map((review) => [review.documentId, review])), [data]);

  return <section className="panel sales-pricing-governance">
    <header><div data-korean-heading><h2>가격표·할인·마진 통제</h2><span>수치를 추정하지 않고 승인된 버전과 문서 스냅샷으로 견적부터 수주까지 통제합니다.</span></div>
      <strong className={data?.configurationReady ? "ready" : "missing"}>{data?.configurationReady ? "통제 기준 활성" : "가격표·정책 설정 필요"}</strong></header>
    {message && <div className="sales-pricing-message" role="status">{message}</div>}
    <div className="sales-pricing-active">
      <article><small>활성 가격표</small><strong>{activeList ? `${activeList.name} v${activeList.version}` : "미설정"}</strong><span>{activeList ? `${activeList.effectiveFrom} ~ ${activeList.effectiveTo || "종료일 없음"} · ${activeList.items.length}개 품목` : "가격표 품목의 정가·원가·최저단가가 필요합니다."}</span></article>
      <article><small>활성 가격정책</small><strong>{activePolicy ? `${activePolicy.name} v${activePolicy.version}` : "미설정"}</strong><span>{activePolicy ? `최대 할인 ${percent(activePolicy.maxDiscountBps)} · 최저 마진 ${percent(activePolicy.minGrossMarginBps)}` : "할인 한도와 최저 마진을 직접 정해 주세요."}</span></article>
    </div>
    <div className="sales-pricing-setup">
      <article>
        <h3>가격표 버전</h3>
        <form onSubmit={createList}><label>가격표명<input required minLength={2} value={listDraft.name} onChange={(event) => setListDraft({ ...listDraft, name: event.target.value })} placeholder="예: 국내 표준 가격표" /></label><label>통화<input required maxLength={3} value={listDraft.currency} onChange={(event) => setListDraft({ ...listDraft, currency: event.target.value.toUpperCase() })} /></label><label>적용 시작<input required type="date" value={listDraft.effectiveFrom} onChange={(event) => setListDraft({ ...listDraft, effectiveFrom: event.target.value })} /></label><label>적용 종료<input type="date" value={listDraft.effectiveTo} onChange={(event) => setListDraft({ ...listDraft, effectiveTo: event.target.value })} /></label><button disabled={Boolean(busy)} type="submit">+ 가격표 작성</button></form>
        <form className="sales-price-item-form" onSubmit={saveItem}><label>작성 가격표<select required value={itemDraft.priceListId} onChange={(event) => setItemDraft({ ...itemDraft, priceListId: event.target.value })}><option value="">선택</option>{draftLists.map((item) => <option value={item.id} key={item.id}>{item.name} v{item.version}</option>)}</select></label><label>품목<select required value={itemDraft.catalogItemId} onChange={(event) => setItemDraft({ ...itemDraft, catalogItemId: event.target.value })}><option value="">선택</option>{data?.catalog.filter((item) => item.status === "ACTIVE").map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}</select></label><label>정가<input required min="0" type="number" value={itemDraft.listUnitPrice} onChange={(event) => setItemDraft({ ...itemDraft, listUnitPrice: event.target.value })} /></label><label>표준원가<input required min="0" type="number" value={itemDraft.standardUnitCost} onChange={(event) => setItemDraft({ ...itemDraft, standardUnitCost: event.target.value })} /></label><label>최저단가<input required min="0" type="number" value={itemDraft.minUnitPrice} onChange={(event) => setItemDraft({ ...itemDraft, minUnitPrice: event.target.value })} /></label><button disabled={Boolean(busy) || !draftLists.length} type="submit">품목 저장</button></form>
        <div className="sales-pricing-version-list">{data?.priceLists.map((item) => <div key={item.id}><p><strong>{item.name} v{item.version}</strong><small>{item.currency} · {item.effectiveFrom} ~ {item.effectiveTo || "계속"}</small></p><span>{item.items.length}개 품목</span><em className={item.status.toLowerCase()}>{item.status === "ACTIVE" ? "활성" : item.status === "DRAFT" ? "작성 중" : "종료"}</em>{item.status === "DRAFT" && <button type="button" disabled={Boolean(busy) || !item.items.length} onClick={() => void act("ACTIVATE_PRICE_LIST", { id: item.id })}>활성화</button>}</div>)}</div>
      </article>
      <article>
        <h3>할인·마진 정책</h3>
        <form onSubmit={createPolicy}><label>정책명<input required minLength={2} value={policyDraft.name} onChange={(event) => setPolicyDraft({ ...policyDraft, name: event.target.value })} placeholder="예: 국내 영업 가격정책" /></label><label>최대 할인율 %<input required min="0" max="100" step="0.01" type="number" value={policyDraft.maxDiscountPercent} onChange={(event) => setPolicyDraft({ ...policyDraft, maxDiscountPercent: event.target.value })} /></label><label>최저 매출총이익률 %<input required min="0" max="100" step="0.01" type="number" value={policyDraft.minGrossMarginPercent} onChange={(event) => setPolicyDraft({ ...policyDraft, minGrossMarginPercent: event.target.value })} /></label><button disabled={Boolean(busy)} type="submit">+ 정책 작성</button></form>
        <p className="sales-pricing-rule-note">시스템은 기본 할인율이나 마진율을 임의로 제안하지 않습니다. 회사가 승인한 수치만 사용합니다.</p>
        <div className="sales-pricing-version-list">{data?.policies.map((item) => <div key={item.id}><p><strong>{item.name} v{item.version}</strong><small>할인 ≤ {percent(item.maxDiscountBps)} · 마진 ≥ {percent(item.minGrossMarginBps)}</small></p><em className={item.status.toLowerCase()}>{item.status === "ACTIVE" ? "활성" : item.status === "DRAFT" ? "작성 중" : "종료"}</em>{item.status === "DRAFT" && <button type="button" disabled={Boolean(busy)} onClick={() => void act("ACTIVATE_POLICY", { id: item.id })}>활성화</button>}</div>)}</div>
      </article>
    </div>
    <div className="sales-pricing-review-ledger">
      <header><div><h3>견적·수주 가격 검토 원장</h3><span>발행·확정 전 가격 근거와 예외 결재 상태를 확인합니다.</span></div><b>{data?.documents.length ?? 0}건</b></header>
      <div className="sales-pricing-review-row head"><span>문서 / 거래처</span><span>견적액</span><span>정가·원가</span><span>할인·마진</span><span>판정 근거</span><span>조치</span></div>
      {data?.documents.map((document) => {
        const review = reviewsByDocument.get(document.id);
        return <div className="sales-pricing-review-row" key={document.id}><p><strong>{document.documentNumber}</strong><small>{document.accountName || "거래처 미지정"} · {document.documentType === "QUOTE" ? "견적" : "수주"}</small></p><b>{money(document.amount)}</b><span>{review ? `${money(review.listAmount)} · ${money(review.standardCostAmount)}` : "미검토"}</span><span>{review ? `${percent(review.discountBps)} · ${percent(review.grossMarginBps)}` : "-"}</span><p><em className={(review?.outcome ?? "none").toLowerCase()}>{review ? outcomeLabels[review.outcome] || review.outcome : "검토 필요"}</em><small>{review?.reasons.join(" · ") || (review ? `가격표 v${review.priceListVersion} · 정책 v${review.policyVersion}` : "가격 검토를 실행해 주세요.")}</small></p><div><button type="button" disabled={Boolean(busy) || ["PASS", "APPROVAL_PENDING", "APPROVED"].includes(review?.outcome ?? "")} onClick={() => void act("EVALUATE_DOCUMENT", { documentId: document.id })}>가격 검토</button>{review?.outcome === "EXCEPTION_REQUIRED" && <button className="exception" type="button" disabled={Boolean(busy)} onClick={() => void requestException(document.id)}>예외 승인 요청</button>}</div></div>;
      })}
      {!data?.documents.length && <p className="finance-empty">작성 중인 견적·수주 문서가 없습니다.</p>}
    </div>
  </section>;
}
