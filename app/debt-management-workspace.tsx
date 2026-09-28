"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { financeCurrentData } from "./finance-current-data";

const currentPeriod = financeCurrentData.asOf.slice(0, 7);
type TieOutCheck = { check_type: string; period: string; as_of: string; gl_account_code: string; gl_account_name: string;
  subsidiary_amount: number; gl_amount: number; difference_amount: number; difference_reason: string; note: string;
  reviewed_by: string; reviewed_at: number | null };

type LoanAccount = { id: number; bankCode: string; last4: string; name: string; currency: string; balance: number; krwBalance: number };
type DocumentItem = { id: string; category: string; version: number; fileName: string; uploadedBy: string; createdAt: number; downloadUrl: string };
type Schedule = { id: string; due_date: string; item_type: string; amount: number; status: string; derived_status: string; payment_request_id: string; expense_status: string | null; note: string };
type Review = { id: string; review_date: string; covenant_name: string; comparator: string; threshold_value_scaled: number; actual_value_scaled: number; unit: string; result: string; evidence_document_id: string; note: string; reviewed_by: string };
type Facility = { id: string; facility_code: string; source_account_id: string; lender_name: string; facility_name: string; currency: string;
  original_principal: number; agreement_date: string; maturity_date: string; interest_type: string; fixed_rate_bps: number;
  benchmark_name: string; spread_bps: number; repayment_type: string; payment_day: number; covenant_note: string;
  next_covenant_review_date: string; status: string; evidence_document_id: string; approved_by: string; approved_at: number | null;
  current_balance: number | null; source_account: LoanAccount | null; schedules: Schedule[]; reviews: Review[]; documents: DocumentItem[] };
type Data = { asOf: string; loanAccounts: LoanAccount[]; facilities: Facility[]; unmapped: LoanAccount[];
  summary: { sourceLoanBalance: number; activeFacilities: number; unmappedAccounts: number; overdueSchedules: number; due13WeekAmount: number; covenantBreaches: number; covenantDue: number }; sourceNote: string };

const won = (value: number | null | undefined) => value === null || value === undefined ? "미확인" : `${Math.round(value).toLocaleString("ko-KR")}원`;
const statusLabel: Record<string, string> = { DRAFT: "초안", ACTIVE: "활성", CLOSED: "종료", VOID: "무효",
  PLANNED: "예정", REQUESTED: "지급 진행", PAID: "지급 완료", OVERDUE: "기한 경과", CANCELLED: "취소",
  PASS: "충족", BREACH: "위반" };
const itemLabel: Record<string, string> = { PRINCIPAL: "원금", INTEREST: "이자", FEE: "수수료" };
const interestLabel: Record<string, string> = { FIXED: "고정", FLOATING: "변동", MANUAL: "고지액 관리" };
const repaymentLabel: Record<string, string> = { BULLET: "만기 일시", AMORTIZING: "분할 상환", MANUAL: "직접 일정" };

const emptyFacility = { facilityId: "", facilityCode: "", sourceAccountId: "", lenderName: "", facilityName: "", originalPrincipal: "",
  agreementDate: "", maturityDate: "", interestType: "MANUAL", fixedRatePercent: "", benchmarkName: "", spreadPercent: "",
  repaymentType: "MANUAL", paymentDay: "0", covenantNote: "", nextCovenantReviewDate: "" };

export default function DebtManagementWorkspace({ onOpenOperations }: { onOpenOperations: () => void }) {
  const [data, setData] = useState<Data | null>(null); const [selectedId, setSelectedId] = useState("");
  const [facilityDraft, setFacilityDraft] = useState(emptyFacility);
  const [scheduleDraft, setScheduleDraft] = useState({ dueDate: "", itemType: "PRINCIPAL", amount: "", note: "" });
  const [reviewDraft, setReviewDraft] = useState({ reviewDate: "", covenantName: "", comparator: "GTE", thresholdValue: "", actualValue: "", unit: "%", evidenceDocumentId: "", note: "", nextReviewDate: "" });
  const [message, setMessage] = useState(""); const [working, setWorking] = useState(false);
  const [tieOut, setTieOut] = useState<TieOutCheck | null>(null);
  const [tieOutBusy, setTieOutBusy] = useState(false);
  const [tieOutMessage, setTieOutMessage] = useState("");
  const [tieOutReason, setTieOutReason] = useState<"STRUCTURAL" | "UNCONFIRMED">("STRUCTURAL");
  const [tieOutNote, setTieOutNote] = useState("");

  const load = async (preferred = "") => {
    const response = await fetch("/api/finance/debt", { cache: "no-store" }); const result = await response.json() as Data & { error?: string };
    if (!response.ok) throw new Error(result.error || "차입금 원장을 불러오지 못했습니다.");
    setData(result); const current = preferred || selectedId;
    if (!result.facilities.some((item) => item.id === current)) setSelectedId(result.facilities[0]?.id ?? "");
  };
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : "조회 오류")); }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/tie-out", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { checks?: TieOutCheck[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "대사 결과를 불러오지 못했습니다.");
        if (!cancelled) setTieOut(payload.checks?.find((item) => item.check_type === "DEBT") ?? null);
      })
      .catch((error: unknown) => { if (!cancelled) setTieOutMessage(error instanceof Error ? error.message : "대사 결과를 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  async function recomputeTieOut() {
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECOMPUTE", checkType: "DEBT", period: tieOut?.period ?? currentPeriod }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "대사를 재계산하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutNote(""); setTieOutMessage("차입금 대사를 다시 계산했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "대사를 재계산하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function reviewTieOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tieOut) return;
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REVIEW", checkType: "DEBT", period: tieOut.period, reason: tieOutReason, note: tieOutNote }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "차이 사유를 저장하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutMessage("차이 사유를 저장했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "차이 사유를 저장하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }
  const selected = useMemo(() => data?.facilities.find((item) => item.id === selectedId) ?? null, [data, selectedId]);

  const mutate = async (payload: Record<string, unknown>, success: string, preferred = selectedId) => {
    setWorking(true); setMessage("");
    try { const response = await fetch("/api/finance/debt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string; item?: { id?: string } }; if (!response.ok) throw new Error(result.error || "처리하지 못했습니다.");
      await load(result.item?.id && payload.action === "CREATE_FACILITY" ? result.item.id : preferred); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "처리 중 오류가 발생했습니다."); }
    finally { setWorking(false); }
  };

  const submitFacility = async (event: FormEvent) => {
    event.preventDefault(); const update = Boolean(facilityDraft.facilityId);
    await mutate({ action: update ? "UPDATE_FACILITY" : "CREATE_FACILITY", ...facilityDraft,
      originalPrincipal: Number(facilityDraft.originalPrincipal), fixedRatePercent: Number(facilityDraft.fixedRatePercent || 0),
      spreadPercent: Number(facilityDraft.spreadPercent || 0), paymentDay: Number(facilityDraft.paymentDay || 0) }, update ? "차입계약 초안을 수정했습니다." : "차입계약 초안을 등록했습니다.", facilityDraft.facilityId);
    setFacilityDraft(emptyFacility);
  };

  const editFacility = (facility: Facility) => setFacilityDraft({ facilityId: facility.id, facilityCode: facility.facility_code,
    sourceAccountId: facility.source_account_id, lenderName: facility.lender_name, facilityName: facility.facility_name,
    originalPrincipal: String(facility.original_principal), agreementDate: facility.agreement_date, maturityDate: facility.maturity_date,
    interestType: facility.interest_type, fixedRatePercent: facility.fixed_rate_bps ? String(facility.fixed_rate_bps / 100) : "",
    benchmarkName: facility.benchmark_name, spreadPercent: facility.spread_bps ? String(facility.spread_bps / 100) : "",
    repaymentType: facility.repayment_type, paymentDay: String(facility.payment_day), covenantNote: facility.covenant_note,
    nextCovenantReviewDate: facility.next_covenant_review_date });

  const uploadDocument = async (facility: Facility, file: File, category: string) => {
    setWorking(true); setMessage("");
    const form = new FormData(); form.set("module", "finance"); form.set("entityType", "financeDebtFacility");
    form.set("entityId", facility.id); form.set("category", category); form.set("file", file);
    try { const response = await fetch("/api/documents", { method: "POST", body: form }); const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "문서를 저장하지 못했습니다."); await load(facility.id); setSelectedId(facility.id); setMessage("근거 문서를 버전 관리 원장에 저장했습니다."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "문서 저장 오류"); } finally { setWorking(false); }
  };

  const activate = async (facility: Facility) => {
    const evidence = facility.documents.find((document) => document.category === "차입계약")?.id;
    if (!evidence) { setMessage("계약서 또는 대출약정서를 먼저 첨부해 주세요."); return; }
    await mutate({ action: "ACTIVATE_FACILITY", facilityId: facility.id, evidenceDocumentId: evidence }, "계약 증빙과 Clobe 잔액을 확인해 활성화했습니다.", facility.id);
  };

  const submitSchedule = async (event: FormEvent) => { event.preventDefault(); if (!selected) return;
    await mutate({ action: "CREATE_SCHEDULE", facilityId: selected.id, ...scheduleDraft, amount: Number(scheduleDraft.amount) }, "은행 고지액 기준 상환 일정을 등록했습니다.");
    setScheduleDraft({ dueDate: "", itemType: "PRINCIPAL", amount: "", note: "" }); };

  const submitReview = async (event: FormEvent) => { event.preventDefault(); if (!selected) return;
    await mutate({ action: "CREATE_COVENANT_REVIEW", facilityId: selected.id, ...reviewDraft,
      thresholdValue: Number(reviewDraft.thresholdValue), actualValue: Number(reviewDraft.actualValue) }, "근거문서 기반 약정 검토를 기록했습니다.");
    setReviewDraft({ reviewDate: "", covenantName: "", comparator: "GTE", thresholdValue: "", actualValue: "", unit: "%", evidenceDocumentId: "", note: "", nextReviewDate: "" }); };

  if (!data) return <div className="debt-loading">{message || "차입금 원장을 불러오는 중입니다."}</div>;
  return <div className="debt-workspace">
    <section className="debt-hero"><div data-korean-heading><h1>차입금·상환·약정 관리</h1><span>Clobe 잔액과 계약 근거를 연결해 만기·지급·약정 위험을 추적합니다.</span></div><strong>{data.asOf} 기준</strong></section>
    <div className="debt-guidance"><strong>원천 분리 원칙</strong><span>{data.sourceNote}</span><em>자동 이자 계산 없음</em></div>
    {message && <div className="debt-message" role="status">{message}</div>}
    <section className="debt-metrics">
      <article><small>Clobe 대출잔액</small><strong>{won(data.summary.sourceLoanBalance)}</strong><span>대출계좌 {data.loanAccounts.length}개</span></article>
      <article className={data.summary.unmappedAccounts ? "warning" : ""}><small>미등록 대출계좌</small><strong>{data.summary.unmappedAccounts}개</strong><span>잔액이 있는 원천계좌</span></article>
      <article><small>13주 지급 예정</small><strong>{won(data.summary.due13WeekAmount)}</strong><span>미지급 일정 기준</span></article>
      <article className={data.summary.overdueSchedules ? "warning" : ""}><small>기한 경과 일정</small><strong>{data.summary.overdueSchedules}건</strong><span>지급 완료 미확인</span></article>
      <article className={data.summary.covenantBreaches || data.summary.covenantDue ? "warning" : ""}><small>약정 점검</small><strong>{data.summary.covenantBreaches + data.summary.covenantDue}건</strong><span>위반 {data.summary.covenantBreaches} · 기한 {data.summary.covenantDue}</span></article>
    </section>

    {data.unmapped.length > 0 && <section className="panel debt-unmapped"><header><div data-korean-heading><h2>계약 연결이 필요한 대출계좌</h2></div><span>잔액이 있는 계좌만 표시</span></header><div>{data.unmapped.map((account) => <button type="button" key={account.id} onClick={() => setFacilityDraft({ ...emptyFacility, sourceAccountId: String(account.id), facilityName: account.name, originalPrincipal: String(account.krwBalance) })}><span>{account.bankCode}</span><p><strong>{account.name}</strong><small>끝 {account.last4} · {account.currency}</small></p><b>{won(account.krwBalance)}</b><em>계약 등록 →</em></button>)}</div></section>}

    <section className="debt-setup">
      <article className="panel debt-facility-form"><header><div data-korean-heading><h2>{facilityDraft.facilityId ? "차입계약 초안 수정" : "차입계약 등록"}</h2></div><span>계약조건은 증빙 승인 전까지 초안</span></header>
        <form onSubmit={submitFacility}>
          <label>계약코드<input required value={facilityDraft.facilityCode} onChange={(event) => setFacilityDraft({ ...facilityDraft, facilityCode: event.target.value })} placeholder="LOAN-2026-01" /></label>
          <label>Clobe 대출계좌<select required value={facilityDraft.sourceAccountId} onChange={(event) => { const account = data.loanAccounts.find((item) => String(item.id) === event.target.value); setFacilityDraft({ ...facilityDraft, sourceAccountId: event.target.value, facilityName: facilityDraft.facilityName || account?.name || "", originalPrincipal: facilityDraft.originalPrincipal || String(account?.krwBalance ?? "") }); }}><option value="">선택</option>{data.loanAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.last4} · {won(account.krwBalance)}</option>)}</select></label>
          <label>금융기관<input required value={facilityDraft.lenderName} onChange={(event) => setFacilityDraft({ ...facilityDraft, lenderName: event.target.value })} /></label>
          <label>계약명<input required value={facilityDraft.facilityName} onChange={(event) => setFacilityDraft({ ...facilityDraft, facilityName: event.target.value })} /></label>
          <label>계약 원금<input required min="1" type="number" value={facilityDraft.originalPrincipal} onChange={(event) => setFacilityDraft({ ...facilityDraft, originalPrincipal: event.target.value })} /></label>
          <label>약정일<input required type="date" value={facilityDraft.agreementDate} onChange={(event) => setFacilityDraft({ ...facilityDraft, agreementDate: event.target.value })} /></label>
          <label>만기일<input required type="date" value={facilityDraft.maturityDate} onChange={(event) => setFacilityDraft({ ...facilityDraft, maturityDate: event.target.value })} /></label>
          <label>금리 유형<select value={facilityDraft.interestType} onChange={(event) => setFacilityDraft({ ...facilityDraft, interestType: event.target.value })}><option value="MANUAL">은행 고지액 관리</option><option value="FIXED">고정금리</option><option value="FLOATING">변동금리</option></select></label>
          <label>고정금리(%)<input min="0" max="100" step="0.01" type="number" value={facilityDraft.fixedRatePercent} onChange={(event) => setFacilityDraft({ ...facilityDraft, fixedRatePercent: event.target.value })} disabled={facilityDraft.interestType !== "FIXED"} /></label>
          <label>기준금리명<input value={facilityDraft.benchmarkName} onChange={(event) => setFacilityDraft({ ...facilityDraft, benchmarkName: event.target.value })} disabled={facilityDraft.interestType !== "FLOATING"} placeholder="예: COFIX" /></label>
          <label>가산금리(%)<input min="0" max="100" step="0.01" type="number" value={facilityDraft.spreadPercent} onChange={(event) => setFacilityDraft({ ...facilityDraft, spreadPercent: event.target.value })} disabled={facilityDraft.interestType !== "FLOATING"} /></label>
          <label>상환 방식<select value={facilityDraft.repaymentType} onChange={(event) => setFacilityDraft({ ...facilityDraft, repaymentType: event.target.value })}><option value="MANUAL">직접 일정</option><option value="BULLET">만기 일시</option><option value="AMORTIZING">분할 상환</option></select></label>
          <label>정기 지급일<input min="0" max="31" type="number" value={facilityDraft.paymentDay} onChange={(event) => setFacilityDraft({ ...facilityDraft, paymentDay: event.target.value })} /><small>0은 비정기</small></label>
          <label>다음 약정 검토일<input type="date" value={facilityDraft.nextCovenantReviewDate} onChange={(event) => setFacilityDraft({ ...facilityDraft, nextCovenantReviewDate: event.target.value })} /></label>
          <label className="wide">약정·특약 메모<input value={facilityDraft.covenantNote} onChange={(event) => setFacilityDraft({ ...facilityDraft, covenantNote: event.target.value })} /></label>
          <button type="submit" disabled={working}>{facilityDraft.facilityId ? "초안 변경 저장" : "+ 차입계약 초안 등록"}</button>{facilityDraft.facilityId && <button type="button" className="secondary" onClick={() => setFacilityDraft(emptyFacility)}>수정 취소</button>}
        </form>
      </article>
      <article className="panel debt-source-list"><header><div data-korean-heading><h2>대출 원천계좌</h2></div><span>직접 수정 불가</span></header><div>{data.loanAccounts.map((account) => <button type="button" className={selected?.source_account_id === String(account.id) ? "selected" : ""} key={account.id} onClick={() => { const found = data.facilities.find((facility) => facility.source_account_id === String(account.id)); if (found) setSelectedId(found.id); }}><span>{account.bankCode}</span><p><strong>{account.name}</strong><small>끝 {account.last4}</small></p><b>{won(account.krwBalance)}</b></button>)}</div></article>
    </section>

    <section className="panel debt-facility-ledger"><header><div data-korean-heading><h2>차입계약 원장</h2></div><span>계약을 선택하면 일정·약정 검토가 열립니다.</span></header><div className="debt-facility-row head"><span>계약</span><span>Clobe 현재잔액</span><span>기간</span><span>금리·상환</span><span>약정 점검</span><span>상태</span><span>작업</span></div>{data.facilities.map((facility) => <div className={`debt-facility-row ${facility.status.toLowerCase()} ${selectedId === facility.id ? "selected" : ""}`} key={facility.id} onClick={() => setSelectedId(facility.id)}><p><strong>{facility.facility_code} · {facility.facility_name}</strong><small>{facility.lender_name} · 계좌 끝 {facility.source_account?.last4 ?? "미연결"}</small></p><strong>{won(facility.current_balance)}</strong><span>{facility.agreement_date}<small>만기 {facility.maturity_date}</small></span><span>{interestLabel[facility.interest_type]}<small>{facility.interest_type === "FIXED" ? `${(facility.fixed_rate_bps / 100).toFixed(2)}%` : facility.interest_type === "FLOATING" ? `${facility.benchmark_name} + ${(facility.spread_bps / 100).toFixed(2)}%` : "고지액 입력"} · {repaymentLabel[facility.repayment_type]}</small></span><span>{facility.next_covenant_review_date || "일정 없음"}<small>{facility.reviews[0] ? `최근 ${statusLabel[facility.reviews[0].result]}` : "검토 기록 없음"}</small></span><em>{statusLabel[facility.status]}</em><div>{facility.status === "DRAFT" && <><button type="button" onClick={(event) => { event.stopPropagation(); editFacility(facility); }}>초안 수정</button><label onClick={(event) => event.stopPropagation()}>계약서<input type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt" disabled={working} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDocument(facility, file, "차입계약"); event.currentTarget.value = ""; }} /></label><button type="button" disabled={working || !facility.documents.length} onClick={(event) => { event.stopPropagation(); void activate(facility); }}>증빙 확인·활성화</button></>}{facility.status === "ACTIVE" && <><label onClick={(event) => event.stopPropagation()}>검토증빙<input type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt" disabled={working} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDocument(facility, file, "약정검토"); event.currentTarget.value = ""; }} /></label><button type="button" onClick={(event) => { event.stopPropagation(); const reason = window.prompt("계약 재개방 사유(5자 이상)", ""); if (reason) void mutate({ action: "REOPEN_FACILITY", facilityId: facility.id, reason }, "계약을 초안으로 재개방했습니다."); }}>재개방</button>{facility.current_balance === 0 && <button type="button" onClick={(event) => { event.stopPropagation(); const reason = window.prompt("계약 종료 사유(5자 이상)", ""); if (reason) void mutate({ action: "CLOSE_FACILITY", facilityId: facility.id, reason }, "잔액과 미완료 일정을 확인해 계약을 종료했습니다."); }}>종료</button>}</>}</div></div>)}{!data.facilities.length && <div className="debt-empty">등록된 차입계약이 없습니다. 위 Clobe 계좌에서 계약 등록을 시작하세요.</div>}</section>

    <section className="panel payable-control-panel">
      <header><div data-korean-heading><h3>차입금 보조부 ↔ 원장 대사</h3></div><span>{tieOut ? `${tieOut.period} · 원장 기준일 ${tieOut.as_of}` : "아직 계산되지 않음"}</span></header>
      {tieOutMessage && <div className="finance-control-message" role="status">{tieOutMessage}</div>}
      <div className="payable-plan-editor">
        <p>이카운트 IMPORT 원장과의 대사 · 자동 계산</p>
        <h3>{tieOut ? (tieOut.difference_amount === 0 ? "잔액 일치" : `차이 ${won(tieOut.difference_amount)}`) : "대사 미실행"}</h3>
        <dl>
          <div><dt>보조부(Clobe 스냅샷 대출잔액)</dt><dd>{won(tieOut?.subsidiary_amount ?? 0)}</dd></div>
          <div><dt>원장 잔액</dt><dd>{won(tieOut?.gl_amount ?? 0)}</dd></div>
          <div><dt>계정</dt><dd>{tieOut?.gl_account_code ? `${tieOut.gl_account_code} ${tieOut.gl_account_name}` : "매핑 대기"}</dd></div>
        </dl>
        <small>보조부 금액은 Clobe 스냅샷(financeCurrentData)의 최신 대출잔액 합계이며, 스냅샷이 갱신되지 않으면 이 대사도 함께 갱신되지 않습니다.</small>
        <button type="button" onClick={() => void recomputeTieOut()} disabled={tieOutBusy}>{tieOutBusy ? "계산 중…" : "지금 다시 계산"}</button>
        {tieOut && tieOut.difference_amount !== 0 && (
          tieOut.reviewed_at
            ? <p>{tieOut.difference_reason === "STRUCTURAL" ? "구조적 차이로 확인됨" : "미확인 차이로 기록됨"} · {tieOut.note}</p>
            : <form onSubmit={reviewTieOut}>
                <div className="payable-plan-fields">
                  <label>차이 사유<select value={tieOutReason} onChange={(event) => setTieOutReason(event.target.value as "STRUCTURAL" | "UNCONFIRMED")}><option value="STRUCTURAL">구조적 차이(설명 가능, 월마감 차단 안 함)</option><option value="UNCONFIRMED">미확인(월마감 차단)</option></select></label>
                </div>
                <label>설명<textarea rows={2} minLength={5} value={tieOutNote} onChange={(event) => setTieOutNote(event.target.value)} placeholder="예: Clobe 스냅샷 갱신 지연으로 인한 시차" /></label>
                <button type="submit" disabled={tieOutBusy || tieOutNote.trim().length < 5}>{tieOutBusy ? "저장 중…" : "사유 저장"}</button>
              </form>
        )}
      </div>
    </section>

    {selected && <>
      <section className="debt-detail-grid">
        <article className="panel debt-schedule-form"><header><div data-korean-heading><h2>상환·이자 일정 등록</h2></div><span>{selected.facility_code}</span></header><form onSubmit={submitSchedule}><label>지급일<input required type="date" value={scheduleDraft.dueDate} onChange={(event) => setScheduleDraft({ ...scheduleDraft, dueDate: event.target.value })} /></label><label>구분<select value={scheduleDraft.itemType} onChange={(event) => setScheduleDraft({ ...scheduleDraft, itemType: event.target.value })}><option value="PRINCIPAL">원금</option><option value="INTEREST">이자</option><option value="FEE">수수료</option></select></label><label>은행 고지액<input required min="1" type="number" value={scheduleDraft.amount} onChange={(event) => setScheduleDraft({ ...scheduleDraft, amount: event.target.value })} /></label><label className="wide">근거·메모<input value={scheduleDraft.note} onChange={(event) => setScheduleDraft({ ...scheduleDraft, note: event.target.value })} placeholder="상환통지서·자동이체 안내 등" /></label><button type="submit" disabled={working || selected.status !== "ACTIVE"}>+ 일정 등록</button></form></article>
        <article className="panel debt-covenant-form"><header><div data-korean-heading><h2>약정 준수 검토</h2></div><span>수치 비교는 입력값 기준</span></header><form onSubmit={submitReview}><label>검토일<input required max={data.asOf} type="date" value={reviewDraft.reviewDate} onChange={(event) => setReviewDraft({ ...reviewDraft, reviewDate: event.target.value })} /></label><label>약정명<input required value={reviewDraft.covenantName} onChange={(event) => setReviewDraft({ ...reviewDraft, covenantName: event.target.value })} /></label><label>기준<select value={reviewDraft.comparator} onChange={(event) => setReviewDraft({ ...reviewDraft, comparator: event.target.value })}><option value="GTE">이상</option><option value="LTE">이하</option></select></label><label>약정 기준값<input required step="0.0001" type="number" value={reviewDraft.thresholdValue} onChange={(event) => setReviewDraft({ ...reviewDraft, thresholdValue: event.target.value })} /></label><label>실제값<input required step="0.0001" type="number" value={reviewDraft.actualValue} onChange={(event) => setReviewDraft({ ...reviewDraft, actualValue: event.target.value })} /></label><label>단위<input required value={reviewDraft.unit} onChange={(event) => setReviewDraft({ ...reviewDraft, unit: event.target.value })} /></label><label>근거문서<select required value={reviewDraft.evidenceDocumentId} onChange={(event) => setReviewDraft({ ...reviewDraft, evidenceDocumentId: event.target.value })}><option value="">선택</option>{selected.documents.map((document) => <option key={document.id} value={document.id}>{document.category} v{document.version} · {document.fileName}</option>)}</select></label><label>다음 검토일<input type="date" value={reviewDraft.nextReviewDate} onChange={(event) => setReviewDraft({ ...reviewDraft, nextReviewDate: event.target.value })} /></label><label className="wide">검토 메모<input value={reviewDraft.note} onChange={(event) => setReviewDraft({ ...reviewDraft, note: event.target.value })} placeholder="위반 시 원인·조치 10자 이상" /></label><button type="submit" disabled={working || selected.status !== "ACTIVE"}>검토 확정</button></form></article>
      </section>

      <section className="panel debt-schedule-ledger"><header><div data-korean-heading><h2>지급 일정 원장</h2></div><button type="button" onClick={onOpenOperations}>재무 운영센터 →</button></header><div className="debt-schedule-row head"><span>지급일</span><span>구분</span><span>금액</span><span>근거</span><span>지급요청</span><span>상태</span><span>작업</span></div>{selected.schedules.map((schedule) => <div className={`debt-schedule-row ${schedule.derived_status.toLowerCase()}`} key={schedule.id}><strong>{schedule.due_date}</strong><span>{itemLabel[schedule.item_type]}</span><b>{won(schedule.amount)}</b><span>{schedule.note || "미입력"}</span><span>{schedule.payment_request_id ? `${schedule.payment_request_id.slice(0, 13)}…` : "미생성"}<small>{schedule.expense_status ? statusLabel[schedule.expense_status] ?? schedule.expense_status : ""}</small></span><em>{statusLabel[schedule.derived_status]}</em><div>{["PLANNED", "OVERDUE"].includes(schedule.derived_status) && !schedule.payment_request_id && <button type="button" disabled={working} onClick={() => void mutate({ action: "CREATE_PAYMENT_REQUEST", scheduleId: schedule.id }, "지출·지급 결재 원장에 초안을 만들었습니다.")}>지급요청 생성</button>}{["PLANNED", "OVERDUE"].includes(schedule.derived_status) && <button type="button" onClick={() => { const reason = window.prompt("일정 취소 사유(5자 이상)", ""); if (reason) void mutate({ action: "CANCEL_SCHEDULE", scheduleId: schedule.id, reason }, "상환 일정을 취소했습니다."); }}>취소</button>}{schedule.payment_request_id && ["CANCELLED", "REJECTED"].includes(String(schedule.expense_status)) && <button type="button" onClick={() => { const reason = window.prompt("지급요청 재작성 사유(5자 이상)", ""); if (reason) void mutate({ action: "RESET_PAYMENT_REQUEST", scheduleId: schedule.id, reason }, "취소·반려된 지급요청 연결을 해제했습니다."); }}>재작성</button>}</div></div>)}{!selected.schedules.length && <div className="debt-empty">등록된 상환·이자 일정이 없습니다.</div>}</section>

      <section className="panel debt-review-ledger"><header><div data-korean-heading><h2>약정 검토 이력</h2></div><span>확정 후 수정하지 않는 감사 기록</span></header><div className="debt-review-row head"><span>검토일</span><span>약정</span><span>기준</span><span>실제</span><span>결과</span><span>근거·검토자</span></div>{selected.reviews.map((review) => <div className={`debt-review-row ${review.result.toLowerCase()}`} key={review.id}><strong>{review.review_date}</strong><span>{review.covenant_name}</span><span>{(review.threshold_value_scaled / 10000).toLocaleString("ko-KR")} {review.unit} {review.comparator === "GTE" ? "이상" : "이하"}</span><b>{(review.actual_value_scaled / 10000).toLocaleString("ko-KR")} {review.unit}</b><em>{statusLabel[review.result]}</em><p><a href={`/api/documents?downloadId=${encodeURIComponent(review.evidence_document_id)}`}>근거문서</a><small>{review.reviewed_by} · {review.note || "메모 없음"}</small></p></div>)}{!selected.reviews.length && <div className="debt-empty">확정된 약정 검토가 없습니다.</div>}</section>
    </>}
  </div>;
}
