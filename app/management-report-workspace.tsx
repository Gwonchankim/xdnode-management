"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type SourceStatus = "CONFIRMED" | "PARTIAL" | "MISSING" | "REVIEW";
type ReportStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "SUPERSEDED";
type ReportActionStatus = "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE";
type AlertActionItem = { id: string; title: string; priority: string; status: string; ownerEmployeeId: string; dueDate: string; evidenceCount: number };
type Snapshot = {
  period: string; asOf: string; generatedAt: string;
  sections: {
    statement?: { status: SourceStatus; from: string; to: string; lineCount: number; difference: number;
      current: { revenue: number; expenses: number; netIncome: number };
      previous: ({ from: string; to: string; revenue: number; expenses: number; netIncome: number;
        delta: { revenue: number | null; expenses: number | null; netIncome: number | null } }) | null;
      priorYear: ({ from: string; to: string; monthCount: number; revenue: number; expenses: number; netIncome: number;
        delta: { revenue: number | null; expenses: number | null; netIncome: number | null } }) | null; comparisonRule: string };
    commerce: { status: SourceStatus; sales: { amount: number; documentCount: number; partnerCount: number }; purchases: { amount: number; documentCount: number; partnerCount: number }; netSupplyDifference: number };
    cash: { status: SourceStatus; balanceDate: string | null; bankBalanceKrw: number | null; checkingBalanceKrw: number | null; fxBalanceKrw: number | null; loanBalanceKrw: number | null; trend: Array<{ date: string; balance: number }> };
    receivables: { status: SourceStatus; scope: string; recordCount: number; outstandingAmount: number | null; overdueAmount: number | null; missingPlanCount: number | null; updatedAt: number | null };
    payroll: { status: SourceStatus; runStatus: string | null; employeeCount: number | null; grossPay: number | null; deductions: number | null; netPay: number | null; updatedAt: number | null };
    budget: { status: SourceStatus; plan: { id: string; name: string; version: number } | null; lines: number; budget: number; actual: number; variance: number; alertCount: number; unmappedCount: number; mappedCount?: number };
    close: { status: SourceStatus; runStatus: string | null; periodEnd?: string; controlPassCount?: number; controlFailCount?: number; manualCompletedCount?: number; manualTotalCount?: number; evidenceCount?: number; version?: number;
      ledgerDrift?: { checked:boolean;drifted:boolean;checkedAsOf:string;frozenHash:string;currentHash:string;frozenLineCount:number;currentLineCount:number;lineCountDelta:number;totalsChanged:boolean;openingChanged:boolean } };
    alertActions?: { cutoffDate: string; capturedAt: string; totalCount: number; unresolvedCount: number; highCriticalUnresolvedCount: number; reviewCount: number; closedCount: number; overdueCount: number; items: AlertActionItem[] };
    quality: { status: SourceStatus; warningCount: number; journal: { scope: string; lineCount: number; debitAmountKrw: number; creditAmountKrw: number; differenceKrw: number }; warnings: QualityWarning[] };
  };
  sources: Array<{ key: string; label: string; status: SourceStatus; statusLabel: string; asOf: string; destination: string; note: string }>;
  quality: { warningCount: number; blockingCount?: number; canSubmit?: boolean; requiresAcknowledgement: boolean; warnings: QualityWarning[] };
  autoAnalysis: { highlights: string; risks: string; decisions: string };
};
type QualityWarning = { code: string; section: string; message: string; destination: string; blocking?: boolean };
type Report = {
  id: string; period: string; version: number; status: ReportStatus; asOf: string; snapshot: Snapshot;
  highlights: string; risks: string; decisions: string; qualityAcknowledged: boolean; revisionReason: string;
  createdBy: string; submittedAt: number | null; approvedBy: string; approvedAt: number | null; createdAt: number; updatedAt: number;
};
type ReportAction = {
  id: string; reportId: string; sourceSection: string; title: string; ownerEmployeeId: string;
  dueDate: string; status: ReportActionStatus; memo: string; decisionId: string; createdBy: string; completedAt: number | null;
};
type DecisionStatus = "DRAFT" | "PENDING" | "APPROVED" | "DEFERRED" | "REJECTED";
type ReportDecision = {
  id: string; reportId: string; sourceSection: string; decisionType: string; title: string; proposal: string;
  financialImpact: number; ownerEmployeeId: string; decisionDueDate: string; requiresAction: boolean;
  status: DecisionStatus; resolutionNote: string; resolvedBy: string; resolvedAt: number | null; actionId: string;
  sourceAssistantAnswerId: string; sourceAnswerHash: string; sourceEvidenceHash: string;
  sourceBasisAsOf: string; sourceEvidenceStatus: string;
};
type AssistantDecisionSource = {
  id: string; question: string; answer: string; evidenceStatus: "VERIFIED" | "REVIEW_REQUIRED";
  evidenceLabel: string; basisAsOf: string; evidenceHash: string; answerHash: string; createdByName: string; createdAt: number;
};
type ApiState = { period: string; currentPeriod: string; periods: string[]; preview: Snapshot; reports: Report[]; selected: Report | null; actions: ReportAction[]; decisions: ReportDecision[]; error?: string };

const statusLabels: Record<string, string> = {
  DRAFT: "작성 중", SUBMITTED: "결재 중", APPROVED: "승인", SUPERSEDED: "대체됨",
  CONFIRMED: "확정", PARTIAL: "부분 연결", MISSING: "미연결", REVIEW: "검토 필요",
  OPEN: "대기", IN_PROGRESS: "진행", WAITING: "외부대기", DONE: "완료",
  PENDING: "결정 대기", DEFERRED: "보류", REJECTED: "반려",
};
const sectionLabels: Record<string, string> = { STATEMENT: "전기 손익", COMMERCE: "매출·매입", CASH: "자금", RECEIVABLES: "미수", PAYROLL: "급여", BUDGET: "예산", CLOSE: "월마감", QUALITY: "데이터 품질", GENERAL: "공통" };
const decisionTypeLabels: Record<string, string> = { BUDGET: "예산", CASH: "자금", SALES: "영업", HR: "인사", RISK: "위험", POLICY: "정책", OTHER: "기타" };

function won(value: number | null | undefined) {
  return value === null || value === undefined ? "미연결" : `${value.toLocaleString("ko-KR")}원`;
}
const pct = (value: number | null | undefined) => value === null || value === undefined ? "비교율 없음" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function periodLabel(period: string) {
  return `${Number(period.slice(5, 7))}월`;
}

async function fetchReportState(period: string, reportId: string) {
  const response = await fetch(`/api/finance/management-report?period=${encodeURIComponent(period)}${reportId ? `&reportId=${encodeURIComponent(reportId)}` : ""}`);
  const data = await response.json() as ApiState;
  if (!response.ok) throw new Error(data.error || "경영보고 원장을 불러오지 못했습니다.");
  return data;
}

export default function ManagementReportWorkspace({ onNavigate, assistantSource, onAssistantSourceConsumed, onOpenAssistantSource }: {
  onNavigate: (view: string) => void;
  assistantSource?: AssistantDecisionSource | null;
  onAssistantSourceConsumed?: () => void;
  onOpenAssistantSource?: (id: string) => void;
}) {
  const [period, setPeriod] = useState("2026-08");
  const [reportId, setReportId] = useState("");
  const [state, setState] = useState<ApiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [qualityAcknowledged, setQualityAcknowledged] = useState(false);
  const [draft, setDraft] = useState({ highlights: "", risks: "", decisions: "" });
  const [actionDraft, setActionDraft] = useState({ sourceSection: "GENERAL", title: "", ownerEmployeeId: "gc.kim", dueDate: "2026-08-31", memo: "" });
  const [decisionDraft, setDecisionDraft] = useState({ sourceSection: "GENERAL", decisionType: "OTHER", title: "", proposal: "", financialImpact: 0, ownerEmployeeId: "gc.kim", decisionDueDate: "2026-08-31", requiresAction: true });
  const [assistantPrepared, setAssistantPrepared] = useState(false);
  const [assistantReviewAcknowledged, setAssistantReviewAcknowledged] = useState(false);

  async function load(nextPeriod = period, nextReportId = reportId) {
    setLoading(true); setMessage("");
    try {
      const data = await fetchReportState(nextPeriod, nextReportId);
      setState(data);
      setReportId(data.selected?.id ?? "");
      if (data.selected) {
        setDraft({ highlights: data.selected.highlights, risks: data.selected.risks, decisions: data.selected.decisions });
        setQualityAcknowledged(data.selected.qualityAcknowledged);
      } else {
        setDraft(data.preview.autoAnalysis);
        setQualityAcknowledged(false);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "경영보고 원장을 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchReportState(period, reportId).then((data) => {
      if (cancelled) return;
      setState(data);
      setReportId(data.selected?.id ?? "");
      if (data.selected) {
        setDraft({ highlights: data.selected.highlights, risks: data.selected.risks, decisions: data.selected.decisions });
        setQualityAcknowledged(data.selected.qualityAcknowledged);
      } else {
        setDraft(data.preview.autoAnalysis);
        setQualityAcknowledged(false);
      }
      setMessage("");
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "경영보고 원장을 불러오지 못했습니다.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, reportId]);

  async function run(action: string, payload: Record<string, unknown> = {}) {
    if (busy) return null;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/finance/management-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const data = await response.json() as { error?: string; id?: string };
      if (!response.ok) throw new Error(data.error || "경영보고 작업을 완료하지 못했습니다.");
      setMessage("변경내용을 원장에 저장했습니다.");
      if (data.id && ["CREATE_REPORT", "CREATE_REVISION"].includes(action)) setReportId(data.id); else await load(period, reportId);
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "경영보고 작업을 완료하지 못했습니다.");
      return null;
    } finally { setBusy(false); }
  }

  const selected = state?.selected ?? null;
  const snapshot = selected?.snapshot ?? state?.preview ?? null;
  const editable = selected?.status === "DRAFT";
  const maxCash = useMemo(() => Math.max(1, ...(snapshot?.sections.cash.trend.map((item) => item.balance) ?? [1])), [snapshot]);

  function changePeriod(next: string) {
    setLoading(true); setReportId(""); setPeriod(next);
    const end = new Date(`${next}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    setActionDraft((current) => ({ ...current, dueDate: end.toISOString().slice(0, 10) }));
    setDecisionDraft((current) => ({ ...current, decisionDueDate: end.toISOString().slice(0, 10) }));
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    await run("SAVE_DRAFT", { reportId: selected.id, ...draft });
  }

  async function addAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const done = await run("ADD_ACTION", { reportId: selected.id, ...actionDraft });
    if (done) setActionDraft((current) => ({ ...current, title: "", memo: "" }));
  }

  async function addDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const promote = assistantPrepared && assistantSource;
    const done = await run(promote ? "PROMOTE_ASSISTANT_ANSWER" : "ADD_DECISION", {
      reportId: selected.id, ...decisionDraft,
      ...(promote ? { assistantAnswerId: assistantSource.id, reviewAcknowledged: assistantReviewAcknowledged } : {}),
    });
    if (done) {
      setDecisionDraft((current) => ({ ...current, title: "", proposal: "", financialImpact: 0 }));
      if (promote) { setAssistantPrepared(false); setAssistantReviewAcknowledged(false); onAssistantSourceConsumed?.(); }
    }
  }

  function prepareAssistantDecision() {
    if (!assistantSource) return;
    setDecisionDraft((current) => ({ ...current,
      sourceSection: assistantSource.evidenceStatus === "VERIFIED" ? "GENERAL" : "QUALITY",
      decisionType: assistantSource.evidenceStatus === "VERIFIED" ? "OTHER" : "RISK",
      title: assistantSource.question.slice(0, 200), proposal: assistantSource.answer.slice(0, 2000),
    }));
    setAssistantPrepared(true);
    setAssistantReviewAcknowledged((current) => assistantSource.evidenceStatus === "VERIFIED" ? true : current);
  }

  async function resolveDecision(item: ReportDecision, outcome: "APPROVED" | "DEFERRED" | "REJECTED") {
    if (!selected) return;
    const resolutionNote = window.prompt(`${statusLabels[outcome]} 결정 근거를 5자 이상 입력해 주세요.`, "");
    if (resolutionNote === null) return;
    await run("RESOLVE_DECISION", { reportId: selected.id, decisionId: item.id, outcome, resolutionNote });
  }

  async function createRevision() {
    if (!selected) return;
    const reason = window.prompt("승인본을 개정하는 사유를 입력해 주세요. 기존 승인본은 보존됩니다.", "원천자료 또는 경영진 의견 반영");
    if (reason === null) return;
    await run("CREATE_REVISION", { reportId: selected.id, revisionReason: reason });
  }

  if (loading && !state) return <div className="management-report-loading">월간 경영보고 원장과 원천 데이터를 대사하는 중입니다.</div>;
  if (!snapshot) return <div className="management-report-loading">{message || "경영보고 원천을 불러오지 못했습니다."}</div>;

  const { commerce, cash, receivables, payroll, budget, close, quality } = snapshot.sections;
  const statementConnected = Boolean(snapshot.sections.statement);
  const statement = snapshot.sections.statement ?? { status: "MISSING" as const, from: `${period}-01`, to: `${period}-01`, lineCount: 0, difference: 0,
    current: { revenue: 0, expenses: 0, netIncome: 0 }, previous: null, priorYear: null,
    comparisonRule: "이 저장본은 전기 손익 비교 연계 전에 생성되어 당시 값을 확정할 수 없습니다." };
  const alertActionsConnected = Boolean(snapshot.sections.alertActions);
  const alertActions = snapshot.sections.alertActions ?? { cutoffDate: `${period}-01`, capturedAt: "", totalCount: 0, unresolvedCount: 0, highCriticalUnresolvedCount: 0, reviewCount: 0, closedCount: 0, overdueCount: 0, items: [] };
  return (
    <div className="management-report-workspace">
      <section className="management-report-hero">
        <div data-korean-heading><h1>월간 경영보고</h1><span>숫자·원천·품질·후속조치·승인을 한 버전으로 동결합니다.</span></div>
        <div className="management-report-hero-actions">
          <label>보고월<select value={period} onChange={(event) => changePeriod(event.target.value)}>{(state?.periods ?? [period]).map((item) => <option key={item} value={item}>{item.replace("-", "년 ")}월</option>)}</select></label>
          <button type="button" onClick={() => window.print()}>인쇄</button>
          {!selected && <button type="button" className="primary" disabled={busy} onClick={() => void run("CREATE_REPORT", { period })}>초안 생성</button>}
          {editable && <button type="button" disabled={busy} onClick={() => void run("REFRESH_DRAFT", { reportId: selected.id })}>원천 새로 반영</button>}
          {selected && ["APPROVED", "SUPERSEDED"].includes(selected.status) && <button type="button" className="primary" disabled={busy} onClick={createRevision}>새 버전</button>}
        </div>
      </section>

      {message && <p className="management-report-message" role="status">{message}</p>}

      <section className="management-report-version-strip">
        <div>{(state?.reports ?? []).map((report) => <button type="button" className={selected?.id === report.id ? "active" : ""} key={report.id} onClick={() => { setLoading(true); setReportId(report.id); }}><strong>v{report.version}</strong><span className={report.status.toLowerCase()}>{statusLabels[report.status]}</span></button>)}</div>
        <p><strong>{selected ? `${selected.period} v${selected.version}` : `${period} 실시간 미리보기`}</strong><span>{selected ? `기준일 ${selected.asOf} · ${statusLabels[selected.status]}` : "아직 원장에 동결되지 않은 값입니다."}</span></p>
      </section>

      <section className="management-report-cover panel">
        <div data-korean-heading><h2>2026년 {periodLabel(period)} 경영 현황</h2><span>기준일 {selected?.asOf ?? snapshot.asOf} · 생성 {new Date(snapshot.generatedAt).toLocaleString("ko-KR")}</span></div>
        <div><span className={`source-status ${selected?.status.toLowerCase() ?? "preview"}`}>{selected ? statusLabels[selected.status] : "미리보기"}</span><strong>{snapshot.quality.warningCount}개 품질경고</strong></div>
      </section>

      <section className="management-report-metrics">
        <article><span>연동 매출 공급가액</span><strong>{won(commerce.sales.amount)}</strong><small>세금계산서 {commerce.sales.documentCount}건 · {commerce.sales.partnerCount}개 거래처</small></article>
        <article><span>연동 매입 공급가액</span><strong>{won(commerce.purchases.amount)}</strong><small>세금계산서 {commerce.purchases.documentCount}건 · {commerce.purchases.partnerCount}개 거래처</small></article>
        <article className={commerce.netSupplyDifference < 0 ? "alert" : ""}><span>공급가액 순차이</span><strong>{won(commerce.netSupplyDifference)}</strong><small>회계상 매출총이익이 아닌 공급가액 단순 차이</small></article>
        <article className={cash.status !== "CONFIRMED" ? "warn" : ""}><span>은행 잔액 추이 기준값</span><strong>{won(cash.bankBalanceKrw)}</strong><small>{cash.balanceDate || "기준일 없음"} · {statusLabels[cash.status]}</small></article>
        <article className={receivables.status !== "CONFIRMED" ? "warn" : ""}><span>미수 관리잔액</span><strong>{won(receivables.outstandingAmount)}</strong><small>연체 {won(receivables.overdueAmount)} · {receivables.scope}</small></article>
        <article className={payroll.status !== "CONFIRMED" ? "warn" : ""}><span>급여 지급총액</span><strong>{won(payroll.grossPay)}</strong><small>{payroll.employeeCount ?? "-"}명 · 실지급 {won(payroll.netPay)} · {payroll.runStatus ?? "미연결"}</small></article>
        <article className={budget.status !== "CONFIRMED" ? "warn" : ""}><span>예산 대비 실적</span><strong>{won(budget.variance)}</strong><small>비교예산 {won(budget.budget)} · 실적 {won(budget.actual)}</small></article>
        <article className={close.status !== "CONFIRMED" ? "warn" : ""}><span>월마감 상태</span><strong>{close.ledgerDrift?.drifted ? "원장 변동 감지" : close.runStatus ? statusLabels[close.runStatus] ?? close.runStatus : "미연결"}</strong><small>{close.ledgerDrift?.drifted ? `동결 ${close.ledgerDrift.frozenLineCount}행 → 현재 ${close.ledgerDrift.currentLineCount}행` : `자동통제 ${close.controlPassCount ?? 0} 통과 · ${close.controlFailCount ?? 0} 실패 · 증빙 ${close.evidenceCount ?? 0}건`}</small></article>
      </section>

      <section className={`panel management-statement-panel ${statement.status.toLowerCase()}`}>
        <header><div data-korean-heading><h2>전기 완료 손익과 비교</h2><span>{statement.from}–{statement.to} · 승인 개시잔액 + POSTED {statement.lineCount.toLocaleString("ko-KR")}행</span></div><button type="button" onClick={() => onNavigate("general-ledger")}>총계정원장 →</button></header>
        {!statementConnected&&<p className="management-statement-legacy">이 저장본에는 전기 손익 비교가 포함되지 않았습니다. 승인본은 보존되며 새 버전부터 비교 원천이 동결됩니다.</p>}
        <div className="management-statement-summary"><article><small>매출·수익</small><strong>{statementConnected?won(statement.current.revenue):"미연결"}</strong></article><article><small>비용</small><strong>{statementConnected?won(statement.current.expenses):"미연결"}</strong></article><article className={statement.current.netIncome < 0 ? "loss" : "profit"}><small>순이익</small><strong>{statementConnected?won(statement.current.netIncome):"미연결"}</strong></article></div>
        <div className="management-statement-comparison"><div className="head"><span>지표</span><span>현재</span><span>직전 동일 일수<small>{statement.previous ? `${statement.previous.from}–${statement.previous.to}` : "비교 불가"}</small></span><span>2025 동일 완료월<small>{statement.priorYear ? `${statement.priorYear.from}–${statement.priorYear.to}` : "완료월 없음"}</small></span></div>{([['revenue','매출·수익'],['expenses','비용'],['netIncome','순이익']] as const).map(([key,label])=><div key={key}><strong>{label}</strong><span>{won(statement.current[key])}</span><span>{statement.previous?<>{won(statement.previous[key])}<small>{pct(statement.previous.delta[key])}</small></>:"—"}</span><span>{statement.priorYear?<>{won(statement.priorYear[key])}<small>{pct(statement.priorYear.delta[key])}</small></>:"—"}</span></div>)}</div>
        <footer><span>{statement.comparisonRule}</span><em>{statement.status === "CONFIRMED" ? "전기 손익 확인" : `검토 필요 · 차대변 차이 ${won(statement.difference)}`}</em></footer>
      </section>

      <section className="management-report-grid">
        <article className="panel management-cash-panel">
          <header><div data-korean-heading><h2>월내 자금 잔액 추이</h2></div><span>{cash.trend.length}개 기준점</span></header>
          {cash.trend.length ? <div className="management-cash-bars">{cash.trend.map((item) => <div key={item.date}><i style={{ height: `${Math.max(6, item.balance / maxCash * 100)}%` }} /><span>{item.date.slice(8)}</span><b>{Math.round(item.balance / 100_000_000)}억</b></div>)}</div> : <div className="management-report-empty">해당 월 자금 잔액 추이가 연결되지 않았습니다.</div>}
          <footer><span>원화 입출금 {won(cash.checkingBalanceKrw)}</span><span>외화 환산 {won(cash.fxBalanceKrw)}</span><span>대출 {won(cash.loanBalanceKrw)}</span></footer>
        </article>
        <article className="panel management-quality-panel">
          <header><div data-korean-heading><h2>제출 전 확인사항</h2></div><span>{quality.warningCount}건</span></header>
          {quality.warnings.length ? <div>{quality.warnings.map((warning) => <button type="button" key={warning.code} onClick={() => onNavigate(warning.destination)}><em>{sectionLabels[warning.section] ?? warning.section}</em><p>{warning.message}</p><span>확인 →</span></button>)}</div> : <div className="management-report-empty">현재 연결 원천에서 추가 품질경고가 없습니다.</div>}
          <footer><span>최신 누적 분개 {quality.journal.lineCount.toLocaleString("ko-KR")}행</span><strong>차대변 차이 {won(quality.journal.differenceKrw)}</strong></footer>
        </article>
        <article className="panel management-alert-action-panel">
          <header><div data-korean-heading><h2>재무 경보 조치현황</h2></div><button type="button" onClick={() => onNavigate("risk-actions")}>조치센터 →</button></header>
          {!alertActionsConnected && <p className="alert-lineage-legacy">이 저장본은 재무 경보 연계 전에 생성되어 당시 상태를 확정할 수 없습니다. 새 버전부터 기준일 경보 상태가 함께 동결됩니다.</p>}
          <div className="management-alert-summary"><span>기준일 미해결 <strong>{alertActionsConnected ? alertActions.unresolvedCount : "-"}</strong></span><span>중요 <strong>{alertActionsConnected ? alertActions.highCriticalUnresolvedCount : "-"}</strong></span><span>종료 검토 <strong>{alertActionsConnected ? alertActions.reviewCount : "-"}</strong></span><span>기한 경과 <strong>{alertActionsConnected ? alertActions.overdueCount : "-"}</strong></span><span>종료 <strong>{alertActionsConnected ? alertActions.closedCount : "-"}</strong></span></div>
          <div className="management-alert-list">{alertActions.items.filter((item) => item.status !== "CLOSED").slice(0, 8).map((item) => <button type="button" key={item.id} onClick={() => onNavigate("risk-actions")}><em className={item.priority.toLowerCase()}>{item.priority}</em><p><strong>{item.title}</strong><small>{(companyEmployees.find((employee) => employee.id === item.ownerEmployeeId)?.name ?? item.ownerEmployeeId) || "담당자 미지정"} · {item.dueDate || "기한 미정"} · 증빙 {item.evidenceCount}건</small></p><span>{statusLabels[item.status] ?? item.status}</span></button>)}{alertActionsConnected && alertActions.unresolvedCount === 0 && <p className="management-report-empty">기준일 현재 미해결 재무 경보가 없습니다.</p>}</div>
        </article>
      </section>

      <section className="panel management-source-ledger">
        <header><div data-korean-heading><h2>보고 수치 원천 등록부</h2></div><span>제출 시 함께 동결</span></header>
        <div className="management-source-row head"><span>원천</span><span>상태</span><span>기준일</span><span>보고 범위</span><span>추적</span></div>
        {snapshot.sources.map((source) => <div className="management-source-row" key={source.key}><strong>{source.label}</strong><em className={source.status.toLowerCase()}>{source.statusLabel}</em><span>{source.asOf || "미확인"}</span><span>{source.note}</span><button type="button" disabled={source.destination.startsWith("hr:")} onClick={() => onNavigate(source.destination)}>{source.destination.startsWith("hr:") ? "HR 급여관리" : "원천 보기 →"}</button></div>)}
      </section>

      <form className="panel management-narrative" onSubmit={saveDraft}>
        <header><div data-korean-heading><h2>경영진 보고 문안</h2></div><span>{editable ? "자동 분석 초안을 편집할 수 있습니다." : "제출된 문안은 읽기 전용입니다."}</span></header>
        <div>
          <label><span>핵심 성과</span><textarea value={draft.highlights} readOnly={!editable} onChange={(event) => setDraft((current) => ({ ...current, highlights: event.target.value }))} /></label>
          <label><span>위험 및 확인사항</span><textarea value={draft.risks} readOnly={!editable} onChange={(event) => setDraft((current) => ({ ...current, risks: event.target.value }))} /></label>
          <label><span>의사결정 요청</span><textarea value={draft.decisions} readOnly={!editable} onChange={(event) => setDraft((current) => ({ ...current, decisions: event.target.value }))} /></label>
        </div>
        {editable && <button type="submit" disabled={busy}>보고 문안 저장</button>}
      </form>

      {selected && <section className="panel management-decisions">
        <header><div data-korean-heading><h2>경영 의사결정 안건</h2></div><span>{state?.decisions.filter((item) => item.status === "PENDING").length ?? 0}건 결정 대기</span></header>
        {assistantSource && <div className={`management-assistant-source ${assistantSource.evidenceStatus === "VERIFIED" ? "verified" : "review"}`}>
          <span>분석 근거</span><p><strong>{assistantSource.question}</strong><small>{assistantSource.evidenceLabel} · 기준일 {assistantSource.basisAsOf} · {assistantSource.createdByName}<br />답변 {assistantSource.answerHash.slice(0, 10)}… · 근거 {assistantSource.evidenceHash.slice(0, 10)}…</small></p>
          {editable ? <div>{assistantSource.evidenceStatus === "REVIEW_REQUIRED" && <label><input type="checkbox" checked={assistantReviewAcknowledged} onChange={(event) => setAssistantReviewAcknowledged(event.target.checked)} /> 근거 제한을 확인했습니다.</label>}<button type="button" disabled={busy} onClick={prepareAssistantDecision}>{assistantPrepared ? "안건 양식에 반영됨" : "안건 양식에 반영"}</button></div> : <em>작성 중인 보고서를 선택하거나 새 개정본을 만든 뒤 연결할 수 있습니다.</em>}
        </div>}
        <div className="management-decision-row head"><span>안건·유형</span><span>요청 내용</span><span>재무영향</span><span>책임자·기한</span><span>결과</span><span>처리</span></div>
        {(state?.decisions ?? []).map((item) => <div className={`management-decision-row ${item.status.toLowerCase()}`} key={item.id}>
          <p><strong>{item.title}</strong><small>{decisionTypeLabels[item.decisionType] ?? item.decisionType} · {sectionLabels[item.sourceSection] ?? item.sourceSection}{item.sourceAssistantAnswerId ? ` · AI 근거 ${item.sourceEvidenceHash.slice(0, 8)}…` : ""}</small></p>
          <p><span>{item.proposal}</span>{item.resolutionNote && <small>결정 근거 · {item.resolutionNote}</small>}</p>
          <strong>{won(item.financialImpact)}</strong>
          <p><span>{companyEmployees.find((employee) => employee.id === item.ownerEmployeeId)?.name ?? item.ownerEmployeeId}</span><small>{item.decisionDueDate}{item.requiresAction ? " · 후속조치 필요" : ""}</small></p>
          <em>{statusLabels[item.status] ?? item.status}{item.actionId ? " · 조치 연결" : ""}</em>
          <div>{item.sourceAssistantAnswerId && <button type="button" disabled={busy} onClick={() => onOpenAssistantSource?.(item.sourceAssistantAnswerId)}>원문 근거</button>}{editable && item.status === "DRAFT" && <button type="button" disabled={busy} onClick={() => void run("DELETE_DECISION", { reportId: selected.id, decisionId: item.id })}>삭제</button>}{selected.status === "APPROVED" && item.status === "PENDING" && <><button type="button" disabled={busy} onClick={() => void resolveDecision(item, "APPROVED")}>승인</button><button type="button" disabled={busy} onClick={() => void resolveDecision(item, "DEFERRED")}>보류</button><button type="button" disabled={busy} className="danger" onClick={() => void resolveDecision(item, "REJECTED")}>반려</button></>}</div>
        </div>)}
        {(state?.decisions.length ?? 0) === 0 && <div className="management-report-empty">등록된 구조화 의사결정 안건이 없습니다.</div>}
        {editable && <form className="management-decision-form" onSubmit={addDecision}>
          <label>유형<select value={decisionDraft.decisionType} onChange={(event) => setDecisionDraft((current) => ({ ...current, decisionType: event.target.value }))}>{Object.entries(decisionTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>원천 구간<select value={decisionDraft.sourceSection} onChange={(event) => setDecisionDraft((current) => ({ ...current, sourceSection: event.target.value }))}>{Object.entries(sectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide">안건 제목<input required value={decisionDraft.title} onChange={(event) => setDecisionDraft((current) => ({ ...current, title: event.target.value }))} /></label>
          <label className="full">요청 내용<textarea required minLength={5} value={decisionDraft.proposal} onChange={(event) => setDecisionDraft((current) => ({ ...current, proposal: event.target.value }))} /></label>
          <label>예상 재무영향<input type="number" value={decisionDraft.financialImpact} onChange={(event) => setDecisionDraft((current) => ({ ...current, financialImpact: Number(event.target.value) }))} /></label>
          <label>결정 책임자<select value={decisionDraft.ownerEmployeeId} onChange={(event) => setDecisionDraft((current) => ({ ...current, ownerEmployeeId: event.target.value }))}>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label>
          <label>결정기한<input type="date" required value={decisionDraft.decisionDueDate} onChange={(event) => setDecisionDraft((current) => ({ ...current, decisionDueDate: event.target.value }))} /></label>
          <label className="check"><input type="checkbox" checked={decisionDraft.requiresAction} onChange={(event) => setDecisionDraft((current) => ({ ...current, requiresAction: event.target.checked }))} /> 승인·보류 시 후속조치 자동 생성</label>
          <button type="submit" disabled={busy || Boolean(assistantPrepared && assistantSource?.evidenceStatus === "REVIEW_REQUIRED" && !assistantReviewAcknowledged)}>{assistantPrepared ? "AI 근거 안건 제안" : "안건 추가"}</button>
        </form>}
      </section>}

      {selected && <section className="panel management-actions">
        <header><div data-korean-heading><h2>경영회의 후속조치</h2></div><span>{state?.actions.filter((item) => item.status !== "DONE").length ?? 0}개 진행 중</span></header>
        <div className="management-action-row head"><span>구간</span><span>조치</span><span>담당자</span><span>기한</span><span>상태</span><span>메모</span></div>
        {(state?.actions ?? []).map((item) => <div className="management-action-row" key={item.id}><em>{sectionLabels[item.sourceSection] ?? item.sourceSection}{item.decisionId ? " · 안건" : ""}</em><strong>{item.title}</strong><span>{companyEmployees.find((employee) => employee.id === item.ownerEmployeeId)?.name ?? item.ownerEmployeeId}</span><time>{item.dueDate}</time><select value={item.status} disabled={busy || selected.status === "SUPERSEDED"} onChange={(event) => void run("UPDATE_ACTION", { reportId: selected.id, actionId: item.id, status: event.target.value })}>{(["OPEN", "IN_PROGRESS", "WAITING", "DONE"] as const).map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select><span>{item.memo || "-"}</span></div>)}
        {(state?.actions.length ?? 0) === 0 && <div className="management-report-empty">등록된 후속조치가 없습니다.</div>}
        {editable && <form className="management-action-form" onSubmit={addAction}>
          <label>구간<select value={actionDraft.sourceSection} onChange={(event) => setActionDraft((current) => ({ ...current, sourceSection: event.target.value }))}>{Object.entries(sectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide">조치 제목<input required value={actionDraft.title} onChange={(event) => setActionDraft((current) => ({ ...current, title: event.target.value }))} /></label>
          <label>담당자<select value={actionDraft.ownerEmployeeId} onChange={(event) => setActionDraft((current) => ({ ...current, ownerEmployeeId: event.target.value }))}>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label>
          <label>기한<input type="date" required value={actionDraft.dueDate} onChange={(event) => setActionDraft((current) => ({ ...current, dueDate: event.target.value }))} /></label>
          <label className="wide">실행 메모<input value={actionDraft.memo} onChange={(event) => setActionDraft((current) => ({ ...current, memo: event.target.value }))} /></label>
          <button type="submit" disabled={busy}>조치 추가</button>
        </form>}
      </section>}

      {selected && <section className="management-report-submit">
        <div data-korean-heading><h2>{selected.status === "DRAFT" ? "경영보고 결재 제출" : `현재 상태 · ${statusLabels[selected.status]}`}</h2><span>제출하면 수치·원천·문안은 변경되지 않습니다. 수정이 필요하면 승인본에서 새 버전을 만드세요.</span></div>
        {selected.status === "DRAFT" && <div>
          {snapshot.quality.canSubmit === false && <p className="management-report-submit-blocked">마감 원장 변동을 해결하고 보고서 원천을 새로 반영해야 제출할 수 있습니다.</p>}
          {snapshot.quality.requiresAcknowledgement && <label><input type="checkbox" checked={qualityAcknowledged} onChange={(event) => setQualityAcknowledged(event.target.checked)} /> 품질경고 {snapshot.quality.warningCount}건과 원천 제한을 확인했습니다.</label>}
          <button type="button" disabled={busy || snapshot.quality.canSubmit === false || (snapshot.quality.requiresAcknowledgement && !qualityAcknowledged)} onClick={() => void run("SUBMIT_REPORT", { reportId: selected.id, qualityAcknowledged })}>재무 검토·대표 승인 요청</button>
        </div>}
        {selected.status === "APPROVED" && <div className="approved-stamp"><strong>APPROVED</strong><span>{selected.approvedBy} · {selected.approvedAt ? new Date(selected.approvedAt).toLocaleString("ko-KR") : "승인 완료"}</span></div>}
      </section>}
    </div>
  );
}
