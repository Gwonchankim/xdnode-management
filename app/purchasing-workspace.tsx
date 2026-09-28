"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { financeCurrentData } from "./finance-current-data";
import { companyEmployees } from "./hr-company-data";

const currentPeriod = financeCurrentData.asOf.slice(0, 7);

type Vendor = { id: string; name: string; businessNumber: string; contactName: string; email: string; paymentTermsDays: number; status: string };
type OrderLine = { id: string; orderId: string; lineNumber: number; itemName: string; description: string; quantity: number; unitPrice: number; lineAmount: number; acceptedQuantity: number };
type PurchaseOrder = { id: string; orderNumber: string; vendorId: string; vendorName: string; title: string; subtotal: number; taxAmount: number; totalAmount: number; expectedDate: string; status: string; lines: OrderLine[] };
type Receipt = { id: string; orderId: string; orderNumber: string; vendorName: string; receiptNumber: string; receiptDate: string; status: string; acceptedAmount: number };
type PurchaseInvoice = { id: string; orderId: string; vendorId: string; orderNumber: string; vendorName: string; invoiceNumber: string; invoiceDate: string; dueDate: string; supplyAmount: number; taxAmount: number; totalAmount: number; matchedReceiptAmount: number; status: string; exceptionReason: string; paymentRequestId: string; paymentRequestStatus: string; paymentDate: string; planStatus: "UNSCHEDULED" | "SCHEDULED" | "HOLD"; plannedPaymentDate: string; priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; ownerEmployeeId: string; holdReason: string; planMemo: string };
type PurchasingData = { vendors: Vendor[]; orders: PurchaseOrder[]; receipts: Receipt[]; invoices: PurchaseInvoice[] };
type TieOutCheck = { check_type: string; period: string; as_of: string; gl_account_code: string; gl_account_name: string;
  subsidiary_amount: number; gl_amount: number; difference_amount: number; difference_reason: string; note: string;
  reviewed_by: string; reviewed_at: number | null };

const statusLabels: Record<string, string> = {
  DRAFT: "작성 중", SUBMITTED: "결재 중", APPROVED: "발주 승인", PARTIALLY_RECEIVED: "부분 입고",
  RECEIVED: "입고 완료", MATCHED: "3자 대사 일치", EXCEPTION: "대사 예외", PAYMENT_READY: "지급 요청 생성",
  PAID: "지급 완료", CANCELLED: "취소", ACCEPTED: "검수 반영",
};
const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const blankLine = () => ({ itemName: "", description: "", quantity: "1", unitPrice: "" });
const editablePayable = (invoice: PurchaseInvoice): PurchaseInvoice => ({ ...invoice,
  planStatus: invoice.planStatus === "UNSCHEDULED" ? "SCHEDULED" : invoice.planStatus,
  plannedPaymentDate: invoice.plannedPaymentDate || invoice.dueDate,
});

export default function PurchasingWorkspace() {
  const [data, setData] = useState<PurchasingData | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [vendorDraft, setVendorDraft] = useState({ name: "", businessNumber: "", contactName: "", email: "", paymentTermsDays: "30" });
  const [orderDraft, setOrderDraft] = useState({ vendorId: "", orderNumber: "", title: "", expectedDate: "", taxAmount: "", lines: [blankLine()] });
  const [receiptDraft, setReceiptDraft] = useState({ orderId: "", receiptNumber: "", receiptDate: "", orderLineId: "", receivedQuantity: "", acceptedQuantity: "", notes: "" });
  const [invoiceDraft, setInvoiceDraft] = useState({ orderId: "", invoiceNumber: "", invoiceDate: "", dueDate: "", supplyAmount: "", taxAmount: "" });
  const [payableDraft, setPayableDraft] = useState<PurchaseInvoice | null>(null);
  const [tieOut, setTieOut] = useState<TieOutCheck | null>(null);
  const [tieOutBusy, setTieOutBusy] = useState(false);
  const [tieOutMessage, setTieOutMessage] = useState("");
  const [tieOutReason, setTieOutReason] = useState<"STRUCTURAL" | "UNCONFIRMED">("STRUCTURAL");
  const [tieOutNote, setTieOutNote] = useState("");

  async function loadTieOut() {
    try {
      const response = await fetch("/api/finance/tie-out", { cache: "no-store" });
      const payload = await response.json() as { checks?: TieOutCheck[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "대사 결과를 불러오지 못했습니다.");
      setTieOut(payload.checks?.find((item) => item.check_type === "PAYABLES") ?? null);
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "대사 결과를 불러오지 못했습니다."); }
  }

  async function recomputeTieOut() {
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECOMPUTE", checkType: "PAYABLES", period: tieOut?.period ?? currentPeriod }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "대사를 재계산하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutNote(""); setTieOutMessage("매입채무 대사를 다시 계산했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "대사를 재계산하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function reviewTieOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tieOut) return;
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REVIEW", checkType: "PAYABLES", period: tieOut.period, reason: tieOutReason, note: tieOutNote }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "차이 사유를 저장하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutMessage("차이 사유를 저장했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "차이 사유를 저장하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function load() {
    try {
      const response = await fetch("/api/finance/purchasing");
      const payload = await response.json() as PurchasingData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "구매 원장을 불러오지 못했습니다.");
      setData(payload);
      setOrderDraft((current) => ({ ...current, vendorId: current.vendorId || payload.vendors[0]?.id || "" }));
      setPayableDraft((current) => {
        const next = payload.invoices.find((invoice) => invoice.id === current?.id)
          ?? payload.invoices.find((invoice) => ["MATCHED", "PAYMENT_READY"].includes(invoice.status));
        return next ? editablePayable(next) : null;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구매 원장을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); void loadTieOut(); }, []);

  const receiptOrders = useMemo(() => (data?.orders ?? []).filter((order) => ["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status)), [data]);
  const invoiceOrders = useMemo(() => (data?.orders ?? []).filter((order) => ["APPROVED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(order.status)), [data]);
  const selectedReceiptOrder = receiptOrders.find((order) => order.id === receiptDraft.orderId);
  const receiptLines = selectedReceiptOrder?.lines.filter((line) => line.acceptedQuantity < line.quantity) ?? [];
  const openPayables = (data?.invoices ?? []).filter((invoice) => ["MATCHED", "PAYMENT_READY"].includes(invoice.status)).reduce((sum, invoice) => sum + invoice.totalAmount, 0);
  const exceptionCount = (data?.invoices ?? []).filter((invoice) => invoice.status === "EXCEPTION").length;
  const pendingOrders = (data?.orders ?? []).filter((order) => ["DRAFT", "SUBMITTED"].includes(order.status)).length;
  const receivedValue = (data?.receipts ?? []).reduce((sum, receipt) => sum + receipt.acceptedAmount, 0);
  const payableInvoices = (data?.invoices ?? []).filter((invoice) => ["MATCHED", "PAYMENT_READY"].includes(invoice.status));
  const today = new Date().toISOString().slice(0, 10);
  const overduePayables = payableInvoices.filter((invoice) => invoice.dueDate && invoice.dueDate < today);
  const scheduledPayables = payableInvoices.filter((invoice) => invoice.planStatus === "SCHEDULED" && invoice.plannedPaymentDate);
  const unscheduledPayables = payableInvoices.filter((invoice) => invoice.planStatus === "UNSCHEDULED");
  const payableAging = [
    { label: "기한 내", amount: payableInvoices.filter((invoice) => invoice.dueDate && invoice.dueDate >= today).reduce((sum, invoice) => sum + invoice.totalAmount, 0) },
    { label: "1~30일", amount: payableInvoices.filter((invoice) => invoice.dueDate && invoice.dueDate < today && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86400000 <= 30).reduce((sum, invoice) => sum + invoice.totalAmount, 0) },
    { label: "31~60일", amount: payableInvoices.filter((invoice) => invoice.dueDate && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86400000 > 30 && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86400000 <= 60).reduce((sum, invoice) => sum + invoice.totalAmount, 0) },
    { label: "60일 초과", amount: payableInvoices.filter((invoice) => invoice.dueDate && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86400000 > 60).reduce((sum, invoice) => sum + invoice.totalAmount, 0) },
    { label: "기한 없음", amount: payableInvoices.filter((invoice) => !invoice.dueDate).reduce((sum, invoice) => sum + invoice.totalAmount, 0) },
  ];

  async function post(resource: string, payload: Record<string, unknown>) {
    setMessage("");
    const response = await fetch("/api/finance/purchasing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, ...payload }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "저장하지 못했습니다."); return false; }
    await load();
    return true;
  }

  async function createVendor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post("vendor", { ...vendorDraft, paymentTermsDays: Number(vendorDraft.paymentTermsDays) })) {
      setVendorDraft({ name: "", businessNumber: "", contactName: "", email: "", paymentTermsDays: "30" });
      setMessage("매입 거래처를 등록했습니다.");
    }
  }

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const lines = orderDraft.lines.map((line) => ({ ...line, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) }));
    if (await post("order", { ...orderDraft, taxAmount: Number(orderDraft.taxAmount || 0), lines })) {
      setOrderDraft((current) => ({ vendorId: current.vendorId, orderNumber: "", title: "", expectedDate: "", taxAmount: "", lines: [blankLine()] }));
      setMessage("발주서 초안을 저장했습니다. 결재 제출 후 입고를 기록할 수 있습니다.");
    }
  }

  async function createReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const lines = [{ orderLineId: receiptDraft.orderLineId, receivedQuantity: Number(receiptDraft.receivedQuantity), acceptedQuantity: Number(receiptDraft.acceptedQuantity) }];
    if (await post("receipt", { ...receiptDraft, lines })) {
      setReceiptDraft({ orderId: "", receiptNumber: "", receiptDate: "", orderLineId: "", receivedQuantity: "", acceptedQuantity: "", notes: "" });
      setMessage("입고·검수 수량을 반영하고 발주 잔량을 갱신했습니다.");
    }
  }

  async function createInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post("invoice", { ...invoiceDraft, supplyAmount: Number(invoiceDraft.supplyAmount), taxAmount: Number(invoiceDraft.taxAmount || 0) })) {
      setInvoiceDraft({ orderId: "", invoiceNumber: "", invoiceDate: "", dueDate: "", supplyAmount: "", taxAmount: "" });
      setMessage("매입 인보이스를 저장하고 발주·검수 금액과 대사했습니다.");
    }
  }

  async function action(resource: "order" | "invoice", id: string, actionName: "SUBMIT" | "CREATE_PAYMENT" | "CANCEL") {
    setMessage("");
    const response = await fetch("/api/finance/purchasing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, id, action: actionName }) });
    const result = await response.json() as { error?: string; approvalSubmitted?: boolean };
    if (!response.ok) return setMessage(result.error || "처리하지 못했습니다.");
    setMessage(actionName === "SUBMIT" ? "발주 전자결재를 제출했습니다." : actionName === "CREATE_PAYMENT" ? "재무 운영센터에 지급 요청 초안을 생성했습니다. 증빙 첨부 후 결재를 제출해 주세요." : "인보이스를 취소했습니다.");
    await load();
  }

  async function savePayablePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payableDraft) return;
    setMessage("");
    const response = await fetch("/api/finance/purchasing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      resource: "payablePlan", id: payableDraft.id, action: "SAVE", planStatus: payableDraft.planStatus === "UNSCHEDULED" ? "SCHEDULED" : payableDraft.planStatus,
      plannedPaymentDate: payableDraft.plannedPaymentDate, priority: payableDraft.priority,
      ownerEmployeeId: payableDraft.ownerEmployeeId, holdReason: payableDraft.holdReason, memo: payableDraft.planMemo,
    }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "지급계획을 저장하지 못했습니다.");
    setMessage("공급사 인보이스의 내부 지급계획을 저장했습니다.");
    await load();
  }

  function updateOrderLine(index: number, key: "itemName" | "description" | "quantity" | "unitPrice", value: string) {
    setOrderDraft((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line) }));
  }

  if (loading && !data) return <section className="panel purchasing-loading">구매·매입채무 원장을 확인하고 있습니다…</section>;

  return <div className="purchasing-workspace">
    <section className="finance-subpage-heading purchasing-heading"><div data-korean-heading><h2>구매·매입채무</h2><span>거래처 등록부터 발주, 입고·검수, 매입 인보이스, 지급 요청까지 연결합니다.</span></div><em>실제 입력 원장</em></section>
    {message && <div className="finance-control-message" role="status">{message}</div>}
    <section className="purchasing-metrics">
      <article><small>결재 전 발주</small><strong>{pendingOrders}건</strong><span>작성·결재 중</span></article>
      <article><small>검수 반영액</small><strong>{won(receivedValue)}</strong><span>발주단가 기준</span></article>
      <article><small>지급 전 매입채무</small><strong>{won(openPayables)}</strong><span>대사 일치·지급 준비</span></article>
      <article><small>대사 예외</small><strong>{exceptionCount}건</strong><span>발주·검수 초과 확인</span></article>
    </section>

    <section className="purchasing-entry-grid">
      <article className="panel purchasing-card">
        <header><div data-korean-heading><h3>매입 거래처</h3></div><span>{data?.vendors.length ?? 0}곳</span></header>
        <form onSubmit={createVendor} className="purchasing-form vendor-form">
          <label>거래처명<input required value={vendorDraft.name} onChange={(event) => setVendorDraft({ ...vendorDraft, name: event.target.value })} /></label>
          <label>사업자번호<input value={vendorDraft.businessNumber} onChange={(event) => setVendorDraft({ ...vendorDraft, businessNumber: event.target.value })} /></label>
          <label>담당자<input value={vendorDraft.contactName} onChange={(event) => setVendorDraft({ ...vendorDraft, contactName: event.target.value })} /></label>
          <label>이메일<input type="email" value={vendorDraft.email} onChange={(event) => setVendorDraft({ ...vendorDraft, email: event.target.value })} /></label>
          <label>지급조건(일)<input type="number" min="0" max="365" value={vendorDraft.paymentTermsDays} onChange={(event) => setVendorDraft({ ...vendorDraft, paymentTermsDays: event.target.value })} /></label>
          <button type="submit">+ 거래처 등록</button>
        </form>
        <div className="purchasing-mini-list">{(data?.vendors ?? []).map((vendor) => <div key={vendor.id}><p><strong>{vendor.name}</strong><small>{vendor.businessNumber || "사업자번호 미입력"}</small></p><span>{vendor.contactName || "담당자 미지정"}</span><em>D+{vendor.paymentTermsDays}</em></div>)}{!data?.vendors.length && <div className="finance-empty">실제 매입 거래처를 먼저 등록해 주세요.</div>}</div>
      </article>

      <article className="panel purchasing-card purchase-order-card">
        <header><div data-korean-heading><h3>발주서 작성</h3></div><span>최대 20개 품목</span></header>
        <form onSubmit={createOrder} className="purchasing-form order-form">
          <div className="purchase-order-basics"><label>거래처<select required value={orderDraft.vendorId} onChange={(event) => setOrderDraft({ ...orderDraft, vendorId: event.target.value })}><option value="">선택</option>{(data?.vendors ?? []).map((vendor) => <option value={vendor.id} key={vendor.id}>{vendor.name}</option>)}</select></label><label>발주번호<input required value={orderDraft.orderNumber} onChange={(event) => setOrderDraft({ ...orderDraft, orderNumber: event.target.value })} /></label><label>발주 제목<input required value={orderDraft.title} onChange={(event) => setOrderDraft({ ...orderDraft, title: event.target.value })} /></label><label>납기 예정일<input type="date" value={orderDraft.expectedDate} onChange={(event) => setOrderDraft({ ...orderDraft, expectedDate: event.target.value })} /></label><label>부가세<input type="number" min="0" value={orderDraft.taxAmount} onChange={(event) => setOrderDraft({ ...orderDraft, taxAmount: event.target.value })} /></label></div>
          <div className="purchase-line-editor"><div className="purchase-line-row head"><span>품목명</span><span>설명</span><span>수량</span><span>단가</span><span></span></div>{orderDraft.lines.map((line, index) => <div className="purchase-line-row" key={index}><input aria-label={`${index + 1}번째 품목명`} required value={line.itemName} onChange={(event) => updateOrderLine(index, "itemName", event.target.value)} /><input aria-label={`${index + 1}번째 품목 설명`} value={line.description} onChange={(event) => updateOrderLine(index, "description", event.target.value)} /><input aria-label={`${index + 1}번째 수량`} required type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateOrderLine(index, "quantity", event.target.value)} /><input aria-label={`${index + 1}번째 단가`} required type="number" min="0" value={line.unitPrice} onChange={(event) => updateOrderLine(index, "unitPrice", event.target.value)} /><button type="button" disabled={orderDraft.lines.length === 1} onClick={() => setOrderDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))}>삭제</button></div>)}</div>
          <div className="purchase-order-actions"><button type="button" className="outline" disabled={orderDraft.lines.length >= 20} onClick={() => setOrderDraft((current) => ({ ...current, lines: [...current.lines, blankLine()] }))}>+ 품목 행</button><button type="submit">발주서 초안 저장</button></div>
        </form>
      </article>
    </section>

    <section className="panel purchasing-ledger">
      <header><div data-korean-heading><h3>발주·입고 현황</h3></div><span>{data?.orders.length ?? 0}건</span></header>
      <div className="purchase-order-row head"><span>발주</span><span>거래처</span><span>품목·입고</span><span>금액</span><span>상태</span><span>처리</span></div>
      {(data?.orders ?? []).map((order) => <div className="purchase-order-row" key={order.id}><p><strong>{order.orderNumber}</strong><small>{order.title} · {order.expectedDate || "납기 미정"}</small></p><strong>{order.vendorName}</strong><p><strong>{order.lines.length}개 품목</strong><small>{order.lines.reduce((sum, line) => sum + line.acceptedQuantity, 0).toLocaleString("ko-KR")} / {order.lines.reduce((sum, line) => sum + line.quantity, 0).toLocaleString("ko-KR")} 검수</small></p><b>{won(order.totalAmount)}</b><em className={`purchase-status ${order.status.toLowerCase()}`}>{statusLabels[order.status] ?? order.status}</em><div>{order.status === "DRAFT" && <button type="button" onClick={() => void action("order", order.id, "SUBMIT")}>결재 제출</button>}</div></div>)}
      {!data?.orders.length && <div className="finance-empty">등록된 발주서가 없습니다.</div>}
    </section>

    <section className="purchasing-entry-grid purchasing-processing-grid">
      <article className="panel purchasing-card">
        <header><div data-korean-heading><h3>입고·검수 등록</h3></div><span>승인 발주만</span></header>
        <form className="purchasing-form" onSubmit={createReceipt}>
          <label>발주서<select required value={receiptDraft.orderId} onChange={(event) => setReceiptDraft({ ...receiptDraft, orderId: event.target.value, orderLineId: "" })}><option value="">선택</option>{receiptOrders.map((order) => <option key={order.id} value={order.id}>{order.orderNumber} · {order.vendorName}</option>)}</select></label>
          <label>입고번호<input required value={receiptDraft.receiptNumber} onChange={(event) => setReceiptDraft({ ...receiptDraft, receiptNumber: event.target.value })} /></label>
          <label>입고일<input required type="date" value={receiptDraft.receiptDate} onChange={(event) => setReceiptDraft({ ...receiptDraft, receiptDate: event.target.value })} /></label>
          <label>품목<select required value={receiptDraft.orderLineId} onChange={(event) => setReceiptDraft({ ...receiptDraft, orderLineId: event.target.value })}><option value="">선택</option>{receiptLines.map((line) => <option key={line.id} value={line.id}>{line.itemName} · 잔량 {(line.quantity - line.acceptedQuantity).toLocaleString("ko-KR")}</option>)}</select></label>
          <label>입고수량<input required type="number" min="0.001" step="0.001" value={receiptDraft.receivedQuantity} onChange={(event) => setReceiptDraft({ ...receiptDraft, receivedQuantity: event.target.value })} /></label>
          <label>합격수량<input required type="number" min="0" step="0.001" value={receiptDraft.acceptedQuantity} onChange={(event) => setReceiptDraft({ ...receiptDraft, acceptedQuantity: event.target.value })} /></label>
          <label className="wide">검수 메모<input value={receiptDraft.notes} onChange={(event) => setReceiptDraft({ ...receiptDraft, notes: event.target.value })} /></label>
          <button type="submit">입고·검수 반영</button>
        </form>
        <div className="purchasing-mini-list">{(data?.receipts ?? []).slice(0, 8).map((receipt) => <div key={receipt.id}><p><strong>{receipt.receiptNumber}</strong><small>{receipt.orderNumber} · {receipt.receiptDate}</small></p><span>{receipt.vendorName}</span><em>{won(receipt.acceptedAmount)}</em></div>)}{!data?.receipts.length && <div className="finance-empty">입고·검수 기록이 없습니다.</div>}</div>
      </article>

      <article className="panel purchasing-card">
        <header><div data-korean-heading><h3>매입 인보이스</h3></div><span>발주·검수·청구</span></header>
        <form className="purchasing-form" onSubmit={createInvoice}>
          <label>발주서<select required value={invoiceDraft.orderId} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, orderId: event.target.value })}><option value="">선택</option>{invoiceOrders.map((order) => <option key={order.id} value={order.id}>{order.orderNumber} · {order.vendorName}</option>)}</select></label>
          <label>인보이스번호<input required value={invoiceDraft.invoiceNumber} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, invoiceNumber: event.target.value })} /></label>
          <label>발행일<input required type="date" value={invoiceDraft.invoiceDate} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, invoiceDate: event.target.value })} /></label>
          <label>지급기한<input type="date" value={invoiceDraft.dueDate} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, dueDate: event.target.value })} /></label>
          <label>공급가액<input required type="number" min="1" value={invoiceDraft.supplyAmount} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, supplyAmount: event.target.value })} /></label>
          <label>부가세<input type="number" min="0" value={invoiceDraft.taxAmount} onChange={(event) => setInvoiceDraft({ ...invoiceDraft, taxAmount: event.target.value })} /></label>
          <button type="submit">인보이스 대사</button>
        </form>
        <p className="purchasing-note">발주 공급가액과 합격 검수수량×발주단가 범위 안에서만 대사 일치로 처리합니다. 세액은 별도 표시하며 자동 추정하지 않습니다.</p>
      </article>
    </section>

    <section className="panel payable-control-panel">
      <header><div data-korean-heading><h3>매입채무 에이징·지급 일정</h3></div><span>{payableInvoices.length}건 · {won(openPayables)}</span></header>
      <div className="payable-control-metrics"><article><small>기한 경과</small><strong>{overduePayables.length}건</strong><span>{won(overduePayables.reduce((sum, invoice) => sum + invoice.totalAmount, 0))}</span></article><article><small>지급일 미설정</small><strong>{unscheduledPayables.length}건</strong><span>내부 일정 등록 필요</span></article><article><small>지급 예정</small><strong>{scheduledPayables.length}건</strong><span>{won(scheduledPayables.reduce((sum, invoice) => sum + invoice.totalAmount, 0))}</span></article><article><small>지급 보류</small><strong>{payableInvoices.filter((invoice) => invoice.planStatus === "HOLD").length}건</strong><span>사유 필수</span></article></div>
      <div className="payable-aging-grid">{payableAging.map((bucket) => <div key={bucket.label}><span>{bucket.label}</span><strong>{won(bucket.amount)}</strong><i style={{ width: `${openPayables ? Math.min(100, bucket.amount / openPayables * 100) : 0}%` }} /></div>)}</div>
      <div className="payable-control-grid">
        <div className="payable-schedule-list"><div className="payable-list-head"><strong>지급 대상 큐</strong><span>원천 지급기한과 내부 지급일을 분리</span></div>{payableInvoices.map((invoice) => <button type="button" className={payableDraft?.id === invoice.id ? "active" : ""} key={invoice.id} onClick={() => setPayableDraft(editablePayable(invoice))}><span className={`payable-priority ${invoice.priority.toLowerCase()}`}>{invoice.priority}</span><p><strong>{invoice.vendorName}</strong><small>{invoice.invoiceNumber} · 원천기한 {invoice.dueDate || "미입력"}</small></p><b>{won(invoice.totalAmount)}</b><em>{invoice.planStatus === "HOLD" ? "보류" : invoice.plannedPaymentDate || "일정 미설정"}</em></button>)}</div>
        <div className="payable-plan-editor">{payableDraft ? <form data-korean-heading onSubmit={savePayablePlan}><h3>{payableDraft.vendorName}</h3><dl><div><dt>인보이스</dt><dd>{payableDraft.invoiceNumber}</dd></div><div><dt>총액</dt><dd>{won(payableDraft.totalAmount)}</dd></div><div><dt>원천 지급기한</dt><dd>{payableDraft.dueDate || "미입력"}</dd></div><div><dt>지급요청</dt><dd>{payableDraft.paymentRequestStatus || "미생성"}</dd></div></dl><div className="payable-plan-fields"><label>계획 상태<select value={payableDraft.planStatus} onChange={(event) => setPayableDraft({ ...payableDraft, planStatus: event.target.value as PurchaseInvoice["planStatus"] })}><option value="SCHEDULED">지급 예정</option><option value="HOLD">지급 보류</option></select></label><label>내부 지급예정일<input type="date" value={payableDraft.plannedPaymentDate} onChange={(event) => setPayableDraft({ ...payableDraft, plannedPaymentDate: event.target.value })} /></label><label>우선순위<select value={payableDraft.priority} onChange={(event) => setPayableDraft({ ...payableDraft, priority: event.target.value as PurchaseInvoice["priority"] })}><option value="LOW">낮음</option><option value="NORMAL">보통</option><option value="HIGH">높음</option><option value="CRITICAL">긴급</option></select></label><label>담당자<select value={payableDraft.ownerEmployeeId} onChange={(event) => setPayableDraft({ ...payableDraft, ownerEmployeeId: event.target.value })}><option value="">미지정</option>{companyEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.department}</option>)}</select></label></div>{payableDraft.planStatus === "HOLD" && <label>지급 보류 사유<textarea rows={3} value={payableDraft.holdReason} onChange={(event) => setPayableDraft({ ...payableDraft, holdReason: event.target.value })} /></label>}<label>지급 메모<textarea rows={3} value={payableDraft.planMemo} onChange={(event) => setPayableDraft({ ...payableDraft, planMemo: event.target.value })} /></label><button type="submit">지급계획 저장</button><small>저장한 내부 지급일은 공급사 인보이스의 원천 지급기한을 변경하지 않으며 13주 자금예측 보완 정보로 사용합니다.</small></form> : <div className="finance-empty">대사 완료된 매입 인보이스가 없습니다.</div>}</div>
      </div>
    </section>

    <section className="panel payable-control-panel">
      <header><div data-korean-heading><h3>매입채무 보조부 ↔ 원장 대사</h3></div><span>{tieOut ? `${tieOut.period} · 원장 기준일 ${tieOut.as_of}` : "아직 계산되지 않음"}</span></header>
      {tieOutMessage && <div className="finance-control-message" role="status">{tieOutMessage}</div>}
      <div className="payable-plan-editor">
        <p>이카운트 IMPORT 원장과의 대사 · 자동 계산</p>
        <h3>{tieOut ? (tieOut.difference_amount === 0 ? "잔액 일치" : `차이 ${won(tieOut.difference_amount)}`) : "대사 미실행"}</h3>
        <dl>
          <div><dt>보조부(미지급 인보이스)</dt><dd>{won(tieOut?.subsidiary_amount ?? 0)}</dd></div>
          <div><dt>원장 잔액</dt><dd>{won(tieOut?.gl_amount ?? 0)}</dd></div>
          <div><dt>계정</dt><dd>{tieOut?.gl_account_code ? `${tieOut.gl_account_code} ${tieOut.gl_account_name}` : "매핑 대기"}</dd></div>
        </dl>
        <button type="button" onClick={() => void recomputeTieOut()} disabled={tieOutBusy}>{tieOutBusy ? "계산 중…" : "지금 다시 계산"}</button>
        {tieOut && tieOut.difference_amount !== 0 && (
          tieOut.reviewed_at
            ? <p>{tieOut.difference_reason === "STRUCTURAL" ? "구조적 차이로 확인됨" : "미확인 차이로 기록됨"} · {tieOut.note}</p>
            : <form onSubmit={reviewTieOut}>
                <div className="payable-plan-fields">
                  <label>차이 사유<select value={tieOutReason} onChange={(event) => setTieOutReason(event.target.value as "STRUCTURAL" | "UNCONFIRMED")}><option value="STRUCTURAL">구조적 차이(설명 가능, 월마감 차단 안 함)</option><option value="UNCONFIRMED">미확인(월마감 차단)</option></select></label>
                </div>
                <label>설명<textarea rows={2} minLength={5} value={tieOutNote} onChange={(event) => setTieOutNote(event.target.value)} placeholder="예: 월말 매입 인보이스 등록 지연으로 인한 시차" /></label>
                <button type="submit" disabled={tieOutBusy || tieOutNote.trim().length < 5}>{tieOutBusy ? "저장 중…" : "사유 저장"}</button>
              </form>
        )}
      </div>
    </section>

    <section className="panel purchasing-ledger invoice-ledger">
      <header><div data-korean-heading><h3>매입채무·지급 연결</h3></div><span>{data?.invoices.length ?? 0}건</span></header>
      <div className="purchase-invoice-row head"><span>인보이스</span><span>발주·거래처</span><span>공급가/세액</span><span>총액</span><span>대사 상태</span><span>처리</span></div>
      {(data?.invoices ?? []).map((invoice) => <div className="purchase-invoice-row" key={invoice.id}><p><strong>{invoice.invoiceNumber}</strong><small>{invoice.invoiceDate} · 지급 {invoice.dueDate || "미정"}</small></p><p><strong>{invoice.vendorName}</strong><small>{invoice.orderNumber}</small></p><p><strong>{won(invoice.supplyAmount)}</strong><small>세액 {won(invoice.taxAmount)}</small></p><b>{won(invoice.totalAmount)}</b><p><em className={`purchase-status ${invoice.status.toLowerCase()}`}>{statusLabels[invoice.status] ?? invoice.status}</em><small>{invoice.exceptionReason || `검수대사 ${won(invoice.matchedReceiptAmount)}`}</small></p><div>{invoice.status === "MATCHED" && <button type="button" onClick={() => void action("invoice", invoice.id, "CREATE_PAYMENT")}>지급 요청</button>}{["MATCHED", "EXCEPTION"].includes(invoice.status) && !invoice.paymentRequestId && <button type="button" className="danger" onClick={() => void action("invoice", invoice.id, "CANCEL")}>취소</button>}</div></div>)}
      {!data?.invoices.length && <div className="finance-empty">매입 인보이스가 없습니다. 승인 발주의 검수 후 등록해 주세요.</div>}
    </section>
  </div>;
}
