"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { financeCurrentData } from "./finance-current-data";
import { companyEmployees } from "./hr-company-data";

const currentPeriod = financeCurrentData.asOf.slice(0, 7);

type CollectionStatus = "OPEN" | "IN_PROGRESS" | "PROMISED" | "PARTIAL" | "DISPUTED" | "HOLD" | "CLOSED";
type AgingBucket = "CURRENT" | "1_30" | "31_60" | "61_90" | "OVER_90" | "MISSING_DUE";
type Invoice = {
  id: string; opportunityTitle: string; accountName: string; documentNumber: string; amount: number;
  invoiceStatus: string; issuedDate: string; dueDate: string; collectedAmount: number; reservedAmount: number;
  outstandingAmount: number; overdueDays: number; agingBucket: AgingBucket; collectionStatus: CollectionStatus;
  ownerEmployeeId: string; promisedDate: string; promisedAmount: number; disputeReason: string;
  nextAction: string; nextActionDate: string; memo: string; caseUpdatedAt: number | null;
};
type Note = { id: string; invoiceId: string; noteType: string; content: string; createdBy: string; createdAt: number };
type LegacyRecord = { partnerName: string; outstandingAmount: number; dueDate: string; status: string };
type Summary = {
  outstandingAmount: number; overdueAmount: number; overdueCount: number; promisedAmount: number;
  missingDueCount: number; unassignedCount: number;
  aging: Record<AgingBucket, { count: number; amount: number }>;
};
type ResponseData = { asOf: string; invoices: Invoice[]; notes: Note[]; legacyRecords: LegacyRecord[]; summary: Summary };
type FilterKey = "ALL" | "OPEN" | "OVERDUE" | "PROMISED" | "DISPUTED" | "MISSING_DUE";
type TieOutCheck = { check_type: string; period: string; as_of: string; gl_account_code: string; gl_account_name: string;
  subsidiary_amount: number; gl_amount: number; difference_amount: number; difference_reason: string; note: string;
  reviewed_by: string; reviewed_at: number | null };

const statusLabels: Record<CollectionStatus, string> = {
  OPEN: "미착수", IN_PROGRESS: "회수 진행", PROMISED: "입금 약속", PARTIAL: "일부 수금",
  DISPUTED: "분쟁", HOLD: "보류", CLOSED: "수금 완료",
};
const agingLabels: Record<AgingBucket, string> = {
  CURRENT: "정상", "1_30": "1~30일", "31_60": "31~60일", "61_90": "61~90일", OVER_90: "90일 초과", MISSING_DUE: "만기일 없음",
};
const noteLabels: Record<string, string> = { CALL: "통화", EMAIL: "이메일", PROMISE: "입금 약속", DISPUTE: "분쟁", GENERAL: "일반 메모" };
const emptySummary: Summary = {
  outstandingAmount: 0, overdueAmount: 0, overdueCount: 0, promisedAmount: 0, missingDueCount: 0, unassignedCount: 0,
  aging: Object.fromEntries(["CURRENT", "1_30", "31_60", "61_90", "OVER_90", "MISSING_DUE"].map((key) => [key, { count: 0, amount: 0 }])) as Summary["aging"],
};

const formatWon = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const formatCompact = (value: number) => value >= 100_000_000 ? `${(value / 100_000_000).toFixed(2)}억원` : value >= 10_000 ? `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원` : `${value.toLocaleString("ko-KR")}원`;
const employeeName = (id: string) => companyEmployees.find((employee) => employee.id === id)?.name ?? id;

export default function ReceivablesWorkspace() {
  const [data, setData] = useState<ResponseData>({ asOf: "", invoices: [], notes: [], legacyRecords: [], summary: emptySummary });
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<Invoice | null>(null);
  const [noteType, setNoteType] = useState("CALL");
  const [noteContent, setNoteContent] = useState("");
  const [tieOut, setTieOut] = useState<TieOutCheck | null>(null);
  const [tieOutBusy, setTieOutBusy] = useState(false);
  const [tieOutMessage, setTieOutMessage] = useState("");
  const [tieOutReason, setTieOutReason] = useState<"STRUCTURAL" | "UNCONFIRMED">("STRUCTURAL");
  const [tieOutNote, setTieOutNote] = useState("");

  async function recomputeTieOut() {
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECOMPUTE", checkType: "RECEIVABLES", period: tieOut?.period ?? currentPeriod }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "대사를 재계산하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutNote(""); setTieOutMessage("매출채권 대사를 다시 계산했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "대사를 재계산하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function reviewTieOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tieOut) return;
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REVIEW", checkType: "RECEIVABLES", period: tieOut.period, reason: tieOutReason, note: tieOutNote }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "차이 사유를 저장하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutMessage("차이 사유를 저장했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "차이 사유를 저장하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function load(preferredId = selectedId) {
    setLoading(true);
    try {
      const response = await fetch("/api/finance/receivables", { cache: "no-store" });
      const payload = await response.json() as ResponseData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "채권 자료를 불러오지 못했습니다.");
      setData(payload);
      const nextId = preferredId && payload.invoices.some((item) => item.id === preferredId) ? preferredId : payload.invoices[0]?.id ?? "";
      setSelectedId(nextId);
      setDraft(payload.invoices.find((item) => item.id === nextId) ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "채권 자료를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/receivables", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as ResponseData & { error?: string };
        if (!response.ok) throw new Error(payload.error || "채권 자료를 불러오지 못했습니다.");
        if (cancelled) return;
        setData(payload);
        const nextId = payload.invoices[0]?.id ?? "";
        setSelectedId(nextId);
        setDraft(payload.invoices[0] ?? null);
      })
      .catch((error: unknown) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "채권 자료를 불러오지 못했습니다."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    fetch("/api/finance/tie-out", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { checks?: TieOutCheck[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "대사 결과를 불러오지 못했습니다.");
        if (!cancelled) setTieOut(payload.checks?.find((item) => item.check_type === "RECEIVABLES") ?? null);
      })
      .catch((error: unknown) => { if (!cancelled) setTieOutMessage(error instanceof Error ? error.message : "대사 결과를 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => data.invoices.filter((invoice) => {
    const query = search.trim().toLowerCase();
    if (query && !`${invoice.accountName} ${invoice.documentNumber} ${invoice.opportunityTitle}`.toLowerCase().includes(query)) return false;
    if (filter === "OPEN") return invoice.outstandingAmount > 0;
    if (filter === "OVERDUE") return invoice.outstandingAmount > 0 && invoice.overdueDays > 0;
    if (filter === "PROMISED") return invoice.collectionStatus === "PROMISED";
    if (filter === "DISPUTED") return ["DISPUTED", "HOLD"].includes(invoice.collectionStatus);
    if (filter === "MISSING_DUE") return invoice.outstandingAmount > 0 && !invoice.dueDate;
    return true;
  }), [data.invoices, filter, search]);
  const invoiceNotes = data.notes.filter((note) => note.invoiceId === selectedId);
  const maxAgingAmount = Math.max(1, ...Object.values(data.summary.aging).map((bucket) => bucket.amount));

  function chooseInvoice(invoice: Invoice) {
    setSelectedId(invoice.id);
    setDraft({ ...invoice });
    setMessage("");
  }

  async function saveCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/finance/receivables", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "SAVE_CASE", invoiceId: draft.id, collectionStatus: draft.collectionStatus,
        ownerEmployeeId: draft.ownerEmployeeId, promisedDate: draft.promisedDate, promisedAmount: draft.promisedAmount,
        disputeReason: draft.disputeReason, nextAction: draft.nextAction, nextActionDate: draft.nextActionDate, memo: draft.memo,
      }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "회수계획을 저장하지 못했습니다.");
      setMessage("청구서별 회수계획을 저장했습니다.");
      await load(draft.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "회수계획을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !noteContent.trim()) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/finance/receivables", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ADD_NOTE", invoiceId: draft.id, noteType, content: noteContent }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "접촉기록을 저장하지 못했습니다.");
      setNoteContent(""); setMessage("접촉기록을 추가했습니다."); await load(draft.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "접촉기록을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  return <div className="receivables-workspace">
    <div className="finance-subpage-heading receivable-heading">
      <div data-korean-heading><h2>청구서별 채권·회수 관리</h2><span>승인된 청구서와 확정 수금을 연결해 미수잔액, 약속, 분쟁, 후속 조치를 관리합니다.</span></div>
      <span className="finance-data-badge">{data.asOf || "최신"} 기준</span>
    </div>
    <section className="kpi-grid receivable-kpis">
      <article><span>총 미수잔액</span><strong>{formatCompact(data.summary.outstandingAmount)}</strong><small>{data.invoices.filter((item) => item.outstandingAmount > 0).length}개 청구서</small></article>
      <article><span>연체 채권</span><strong>{formatCompact(data.summary.overdueAmount)}</strong><small>{data.summary.overdueCount}건 · 만기 기준</small></article>
      <article><span>입금 약속액</span><strong>{formatCompact(data.summary.promisedAmount)}</strong><small>약속 상태의 청구서</small></article>
      <article><span>관리정보 보완</span><strong>{data.summary.missingDueCount + data.summary.unassignedCount}건</strong><small>만기일 {data.summary.missingDueCount} · 담당자 {data.summary.unassignedCount}</small></article>
    </section>
    <section className="panel receivable-aging-panel">
      <div className="receivable-section-head"><div data-korean-heading><h3>연체 구간별 미수잔액</h3></div><small>청구서 만기일 기준 · 미수잔액만 집계</small></div>
      <div className="receivable-aging-grid">{(Object.keys(agingLabels) as AgingBucket[]).map((bucket) => <button type="button" key={bucket} onClick={() => setFilter(bucket === "MISSING_DUE" ? "MISSING_DUE" : bucket === "CURRENT" ? "OPEN" : "OVERDUE")}>
        <span>{agingLabels[bucket]}</span><strong>{formatCompact(data.summary.aging[bucket]?.amount ?? 0)}</strong><small>{data.summary.aging[bucket]?.count ?? 0}건</small><i style={{ width: `${((data.summary.aging[bucket]?.amount ?? 0) / maxAgingAmount) * 100}%` }} />
      </button>)}</div>
    </section>
    <section className="panel receivable-aging-panel receivable-tie-out-panel">
      <div className="receivable-section-head"><div data-korean-heading><h3>매출채권 보조부 ↔ 원장 대사</h3></div><small>{tieOut ? `${tieOut.period} · 원장 기준일 ${tieOut.as_of}` : "아직 계산되지 않음"}</small></div>
      {tieOutMessage && <div className="finance-inline-message">{tieOutMessage}</div>}
      <div className="receivable-source-card">
        <span>이카운트 import 원장과의 대사 · 자동 계산</span>
        <h3>{tieOut ? (tieOut.difference_amount === 0 ? "잔액 일치" : `차이 ${formatWon(tieOut.difference_amount)}`) : "대사 미실행"}</h3>
        <p>{tieOut?.gl_account_code ? `${tieOut.gl_account_code} ${tieOut.gl_account_name}` : "계정 매핑 대기"}</p>
        <dl>
          <div><dt>보조부(청구서 − 확정수금)</dt><dd>{formatWon(tieOut?.subsidiary_amount ?? 0)}</dd></div>
          <div><dt>원장 잔액</dt><dd>{formatWon(tieOut?.gl_amount ?? 0)}</dd></div>
        </dl>
      </div>
      <button type="button" onClick={() => void recomputeTieOut()} disabled={tieOutBusy}>{tieOutBusy ? "계산 중…" : "지금 다시 계산"}</button>
      {tieOut && tieOut.difference_amount !== 0 && (
        tieOut.reviewed_at
          ? <p className="receivable-closed-message">{tieOut.difference_reason === "STRUCTURAL" ? "구조적 차이로 확인됨" : "미확인 차이로 기록됨"} · {tieOut.note}</p>
          : <form className="receivable-case-form" onSubmit={reviewTieOut}>
              <div className="receivable-form-grid">
                <label>차이 사유<select value={tieOutReason} onChange={(event) => setTieOutReason(event.target.value as "STRUCTURAL" | "UNCONFIRMED")}><option value="STRUCTURAL">구조적 차이(설명 가능, 월마감 차단 안 함)</option><option value="UNCONFIRMED">미확인(월마감 차단)</option></select></label>
              </div>
              <label>설명<textarea rows={2} minLength={5} value={tieOutNote} onChange={(event) => setTieOutNote(event.target.value)} placeholder="예: 12월 말 발행분 이연 반영으로 인한 시차" /></label>
              <button type="submit" className="receivable-save-button" disabled={tieOutBusy || tieOutNote.trim().length < 5}>{tieOutBusy ? "저장 중…" : "사유 저장"}</button>
            </form>
      )}
    </section>
    <section className="receivable-toolbar">
      <div className="segment-control">{(["ALL", "OPEN", "OVERDUE", "PROMISED", "DISPUTED", "MISSING_DUE"] as FilterKey[]).map((key) => <button type="button" className={filter === key ? "active" : ""} key={key} onClick={() => setFilter(key)}>{{ ALL: "전체", OPEN: "미수", OVERDUE: "연체", PROMISED: "입금약속", DISPUTED: "분쟁·보류", MISSING_DUE: "만기일 없음" }[key]}</button>)}</div>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="거래처·청구번호·영업 건 검색" />
    </section>
    {message && <div className="finance-inline-message">{message}</div>}
    <section className="content-grid receivable-control-grid">
      <article className="panel receivable-list-panel">
        <div className="receivable-section-head"><div data-korean-heading><h3>청구서 목록</h3></div><small>{loading ? "불러오는 중" : `${filtered.length}건`}</small></div>
        <div className="receivable-invoice-list">
          {filtered.map((invoice) => <button type="button" key={invoice.id} className={selectedId === invoice.id ? "active" : ""} onClick={() => chooseInvoice(invoice)}>
            <span className={`receivable-status ${invoice.collectionStatus.toLowerCase()}`}>{statusLabels[invoice.collectionStatus]}</span>
            <p><strong>{invoice.accountName}</strong><small>{invoice.documentNumber} · {invoice.dueDate || "만기일 없음"}{invoice.overdueDays ? ` · ${invoice.overdueDays}일 연체` : ""}</small></p>
            <b>{formatCompact(invoice.outstandingAmount)}</b>
          </button>)}
          {!loading && filtered.length === 0 && <div className="finance-empty">조건에 맞는 청구서가 없습니다.</div>}
        </div>
      </article>
      <article className="panel receivable-editor-panel">
        {draft ? <>
          <div className="receivable-source-card"><span>회계·영업 원천값 · 읽기 전용</span><h3>{draft.accountName}</h3><p>{draft.documentNumber} · {draft.opportunityTitle}</p><dl><div><dt>청구액</dt><dd>{formatWon(draft.amount)}</dd></div><div><dt>확정 수금</dt><dd>{formatWon(draft.collectedAmount)}</dd></div><div><dt>등록 대기</dt><dd>{formatWon(draft.reservedAmount)}</dd></div><div><dt>현재 미수</dt><dd>{formatWon(draft.outstandingAmount)}</dd></div></dl></div>
          {draft.collectionStatus !== "CLOSED" ? <form className="receivable-case-form" onSubmit={saveCase}>
            <div className="receivable-section-head"><div data-korean-heading><h3>회수 실행계획</h3></div></div>
            <div className="receivable-form-grid"><label>회수 상태<select value={draft.collectionStatus} onChange={(event) => setDraft({ ...draft, collectionStatus: event.target.value as CollectionStatus })}>{(["OPEN", "IN_PROGRESS", "PROMISED", "PARTIAL", "DISPUTED", "HOLD"] as CollectionStatus[]).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><label>담당자<select value={draft.ownerEmployeeId} onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}><option value="">미지정</option>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label></div>
            <div className="receivable-form-grid"><label>입금 약속일<input type="date" value={draft.promisedDate} onChange={(event) => setDraft({ ...draft, promisedDate: event.target.value })} /></label><label>입금 약속금액<input type="number" min="0" max={draft.outstandingAmount} value={draft.promisedAmount} onChange={(event) => setDraft({ ...draft, promisedAmount: Number(event.target.value) })} /></label></div>
            <div className="receivable-form-grid"><label>다음 조치<input value={draft.nextAction} maxLength={500} placeholder="예: 입금증 재확인 요청" onChange={(event) => setDraft({ ...draft, nextAction: event.target.value })} /></label><label>다음 조치일<input type="date" value={draft.nextActionDate} onChange={(event) => setDraft({ ...draft, nextActionDate: event.target.value })} /></label></div>
            {["DISPUTED", "HOLD"].includes(draft.collectionStatus) && <label>분쟁·보류 사유<textarea rows={3} value={draft.disputeReason} onChange={(event) => setDraft({ ...draft, disputeReason: event.target.value })} /></label>}
            <label>관리 메모<textarea rows={3} value={draft.memo} onChange={(event) => setDraft({ ...draft, memo: event.target.value })} /></label>
            <button type="submit" className="receivable-save-button" disabled={saving}>{saving ? "저장 중…" : "회수계획 저장"}</button>
          </form> : <div className="receivable-closed-message">확정 수금으로 전액 회수된 청구서입니다. 상태는 자동으로 종료됩니다.</div>}
          <form className="receivable-note-form" onSubmit={addNote}><div className="receivable-section-head"><div data-korean-heading><h3>접촉·특이사항 기록</h3></div></div><div><select value={noteType} onChange={(event) => setNoteType(event.target.value)}>{Object.entries(noteLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><input value={noteContent} maxLength={2000} onChange={(event) => setNoteContent(event.target.value)} placeholder="통화·메일·약속·분쟁 내용을 남기세요." /><button type="submit" disabled={saving || !noteContent.trim()}>추가</button></div></form>
          <div className="receivable-note-list">{invoiceNotes.map((note) => <article key={note.id}><span>{noteLabels[note.noteType] ?? note.noteType}</span><p>{note.content}</p><small>{employeeName(note.createdBy)} · {new Date(note.createdAt).toLocaleString("ko-KR")}</small></article>)}{invoiceNotes.length === 0 && <p className="finance-empty">아직 접촉기록이 없습니다.</p>}</div>
        </> : <div className="receivable-empty-editor"><span>₩</span><strong>관리할 청구서를 선택하세요.</strong><p>원천 청구액은 고정하고 회수 실행정보와 접촉이력을 기록합니다.</p></div>}
      </article>
    </section>
    {data.legacyRecords.length > 0 && <details className="panel receivable-legacy-panel"><summary>2025년 거래처 단위 기존 관리기록 {data.legacyRecords.length}건 보기</summary><p>과거 결산 기준 참고자료이며 2026년 청구서 미수합계에는 섞지 않습니다.</p><div>{data.legacyRecords.map((record) => <span key={record.partnerName}><strong>{record.partnerName}</strong>{formatCompact(record.outstandingAmount)}</span>)}</div></details>}
    <p className="receivable-risk-note">위험 표시는 만기일·회수약속·담당자 누락을 기반으로 한 운영 경보입니다. 신용한도와 내부 신용정책이 등록되기 전까지 공식 신용등급으로 사용하지 않습니다.</p>
  </div>;
}
