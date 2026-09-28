"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type AlertActionItem = { id: string; title: string; priority: string; status: string; ownerEmployeeId: string; dueDate: string; evidenceCount: number };

type Snapshot = {
  reportDate: string; sourceAsOf: string; horizonEnd: string;
  balances: { openingDate: string; openingBankAssets: number; closingDate: string; closingBankAssets: number; movement: number; checkingBalance: number | null; fxBalanceKrw: number | null; loanBalance: number | null };
  actualCash: { inflow: number; outflow: number; net: number; count: number; unclassifiedAmount: number; unclassifiedCount: number };
  next7Days: {
    explicitForecast: { inflow: number; outflow: number; net: number; count: number };
    receivables: { dueAmount: number; dueCount: number; overdueAmount: number; missingDueCount: number };
    payables: { dueAmount: number; dueCount: number; missingDueCount: number };
    debt: { dueAmount: number; dueCount: number };
  };
  journal: { lineCount: number; debitAmountKrw: number; creditAmountKrw: number; differenceKrw: number; checkingAccount: { netChangeKrw: number } };
  alertActions?: { cutoffDate: string; capturedAt: string; totalCount: number; unresolvedCount: number; highCriticalUnresolvedCount: number; reviewCount: number; closedCount: number; overdueCount: number; items: AlertActionItem[] };
  warnings: Array<{ code: string; message: string; destination: string }>;
};
type Report = {
  id: string; reportDate: string; version: number; status: "DRAFT" | "REVIEWED" | "FINAL";
  sourceAsOf: string; snapshot: Snapshot; analysisText: string; analysisSource: "AI" | "RULE_BASED_FALLBACK";
  aiStatus: string; aiModel: string; managementNote: string; actionItems: string[];
  generatedBy: string; reviewedBy: string; reviewedAt: number | null; finalizedBy: string; finalizedAt: number | null;
};
type Data = { asOf: string; reportDate: string; preview: Snapshot; reports: Report[]; selected: Report | null };

const won = (value: number | null | undefined) => value == null ? "해당일 상세 없음" : `${Math.round(value).toLocaleString("ko-KR")}원`;
const statusLabel = { DRAFT: "작성 중", REVIEWED: "검토 완료", FINAL: "확정" } as const;
const alertStatusLabel: Record<string, string> = { OPEN: "조치 대기", IN_PROGRESS: "조치 중", REVIEW: "종료 검토", CLOSED: "종료" };

export default function DailyTreasuryWorkspace({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [reportDate, setReportDate] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [managementNote, setManagementNote] = useState("");
  const [actionItems, setActionItems] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (date = reportDate, reportId = selectedId) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (reportId) params.set("reportId", reportId);
    const response = await fetch(`/api/finance/daily-treasury?${params}`);
    const next = await response.json() as Data & { error?: string };
    if (!response.ok) throw new Error(next.error || "자금일보를 불러오지 못했습니다.");
    setData(next); setReportDate(next.reportDate); setSelectedId(next.selected?.id ?? "");
    setManagementNote(next.selected?.managementNote ?? "");
    setActionItems(next.selected?.actionItems.join("\n") ?? "");
  }, [reportDate, selectedId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/daily-treasury")
      .then(async (response) => {
        const next = await response.json() as Data & { error?: string };
        if (!response.ok) throw new Error(next.error || "자금일보를 불러오지 못했습니다.");
        return next;
      })
      .then((next) => {
        if (cancelled) return;
        setData(next); setReportDate(next.reportDate); setSelectedId(next.selected?.id ?? "");
        setManagementNote(next.selected?.managementNote ?? ""); setActionItems(next.selected?.actionItems.join("\n") ?? "");
      })
      .catch((error: unknown) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "자금일보를 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  async function post(body: Record<string, unknown>) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/daily-treasury", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string; id?: string; aiStatus?: string };
      if (!response.ok) throw new Error(result.error || "자금일보 작업을 완료하지 못했습니다.");
      await load(reportDate, result.id ?? selectedId);
      setMessage(body.action === "GENERATE" ? (result.aiStatus === "SUCCESS" ? "최신 원천으로 AI 자금일보를 생성했습니다." : "AI를 사용할 수 없어 규칙 기반 분석으로 자금일보를 생성했습니다.") : body.action === "SAVE_REVIEW" ? "검토 완료 상태로 저장했습니다." : "자금일보를 확정했습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "자금일보 작업을 완료하지 못했습니다."); }
    finally { setWorking(false); }
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!data?.selected) return;
    void post({ action: "SAVE_REVIEW", reportId: data.selected.id, managementNote, actionItems: actionItems.split("\n").map((item) => item.trim()).filter(Boolean) });
  }

  if (!data) return <div className="treasury-loading">{message || "자금일보 원천을 불러오는 중입니다."}</div>;
  const report = data.selected;
  const snapshot = report?.snapshot ?? data.preview;
  const alertActionsConnected = Boolean(snapshot.alertActions);
  const alertActions = snapshot.alertActions ?? { cutoffDate: snapshot.reportDate, capturedAt: "", totalCount: 0, unresolvedCount: 0, highCriticalUnresolvedCount: 0, reviewCount: 0, closedCount: 0, overdueCount: 0, items: [] };
  const projectedNet = snapshot.next7Days.explicitForecast.net + snapshot.next7Days.receivables.dueAmount - snapshot.next7Days.payables.dueAmount - snapshot.next7Days.debt.dueAmount;

  return (
    <section className="treasury-workspace">
      <header className="treasury-hero">
        <div data-korean-heading><h1>일일 자금일보</h1><span>은행 실적과 7일 채권·채무·차입 일정을 동결하고 담당자 검토 후 확정합니다.</span></div>
        <div className="treasury-date-actions">
          <label>보고일<input type="date" min="2026-01-01" max={data.asOf} value={reportDate} onChange={(event) => setReportDate(event.target.value)} /></label>
          <button type="button" disabled={working} onClick={() => { setSelectedId(""); void load(reportDate, "").catch((error: unknown) => setMessage(error instanceof Error ? error.message : "조회하지 못했습니다.")); }}>조회</button>
          <button type="button" className="primary" disabled={working} onClick={() => void post({ action: "GENERATE", reportDate })}>{working ? "처리 중" : report?.status === "DRAFT" ? "원천 새로 반영" : "+ 자금일보 생성"}</button>
        </div>
      </header>

      {message && <div className="treasury-message" role="status">{message}</div>}

      <div className="treasury-source-line">
        <strong>Clobe·ERP 원천 {snapshot.sourceAsOf}</strong><span>보고일 {snapshot.reportDate} · 7일 전망 {snapshot.horizonEnd}까지</span>
        <em className={report ? report.status.toLowerCase() : "preview"}>{report ? `${statusLabel[report.status]} · v${report.version}` : "실시간 미리보기"}</em>
      </div>

      <div className="treasury-metrics">
        <article><small>당일 은행성 자산</small><strong>{won(snapshot.balances.closingBankAssets)}</strong><span>직전 관측일 대비 {won(snapshot.balances.movement)}</span></article>
        <article><small>당일 순현금흐름</small><strong>{won(snapshot.actualCash.net)}</strong><span>입금 {won(snapshot.actualCash.inflow)} · 출금 {won(snapshot.actualCash.outflow)}</span></article>
        <article><small>향후 7일 순예정액</small><strong>{won(projectedNet)}</strong><span>명시 예측 + 채권 − 채무 − 차입 일정</span></article>
        <article className={snapshot.warnings.length ? "warning" : ""}><small>통제 경고</small><strong>{snapshot.warnings.length}건</strong><span>{alertActionsConnected ? `재무 경보 미해결 ${alertActions.unresolvedCount}건` : "경보 원장 연계 전 저장본"}</span></article>
      </div>

      <div className="treasury-grid">
        <article className="panel treasury-detail">
          <header><div data-korean-heading><h2>잔액과 당일 실적</h2></div><span>{snapshot.balances.closingDate || "관측일 없음"}</span></header>
          <div className="treasury-detail-list">
            <div><span>직전 은행성 자산</span><strong>{won(snapshot.balances.openingBankAssets)}</strong><small>{snapshot.balances.openingDate || "관측일 없음"}</small></div>
            <div><span>원화 입출금계좌</span><strong>{won(snapshot.balances.checkingBalance)}</strong><small>최신 기준일에만 표시</small></div>
            <div><span>외화예금 원화환산</span><strong>{won(snapshot.balances.fxBalanceKrw)}</strong><small>최신 기준일에만 표시</small></div>
            <div><span>대출 잔액</span><strong>{won(snapshot.balances.loanBalance)}</strong><small>최신 기준일에만 표시</small></div>
            <div><span>은행거래</span><strong>{snapshot.actualCash.count}건</strong><small>미분류 {snapshot.actualCash.unclassifiedCount}건 · {won(snapshot.actualCash.unclassifiedAmount)}</small></div>
            <div><span>분개장 차대변</span><strong>{won(snapshot.journal.differenceKrw)}</strong><small>{snapshot.journal.lineCount.toLocaleString("ko-KR")}라인</small></div>
          </div>
        </article>

        <article className="panel treasury-detail">
          <header><div data-korean-heading><h2>입출금 예정</h2></div><span>{snapshot.horizonEnd}</span></header>
          <div className="treasury-detail-list compact">
            <div><span>명시 입금예측</span><strong>{won(snapshot.next7Days.explicitForecast.inflow)}</strong><small>{snapshot.next7Days.explicitForecast.count}건의 수동·연결 계획</small></div>
            <div><span>명시 출금예측</span><strong>{won(snapshot.next7Days.explicitForecast.outflow)}</strong><small>중복 합산 방지를 위해 별도 표시</small></div>
            <div><span>회수 예정 채권</span><strong>{won(snapshot.next7Days.receivables.dueAmount)}</strong><small>{snapshot.next7Days.receivables.dueCount}건 · 연체 {won(snapshot.next7Days.receivables.overdueAmount)}</small></div>
            <div><span>지급 예정 채무</span><strong>{won(snapshot.next7Days.payables.dueAmount)}</strong><small>{snapshot.next7Days.payables.dueCount}건</small></div>
            <div><span>차입금 일정</span><strong>{won(snapshot.next7Days.debt.dueAmount)}</strong><small>{snapshot.next7Days.debt.dueCount}건</small></div>
          </div>
        </article>
      </div>

      <article className="panel treasury-analysis">
        <header><div data-korean-heading><h2>동결 스냅샷 분석</h2></div>{report ? <span className={report.analysisSource === "AI" ? "ai" : "fallback"}>{report.analysisSource === "AI" ? "AI 분석" : `규칙 기반 · ${report.aiStatus}`}</span> : <span>생성 전</span>}</header>
        <div className="treasury-analysis-text">{report?.analysisText || "자금일보를 생성하면 AI 또는 규칙 기반 분석이 동결 스냅샷과 함께 저장됩니다."}</div>
        {snapshot.warnings.length > 0 && <div className="treasury-warning-list">{snapshot.warnings.map((warning) => <div key={warning.code}><strong>{warning.code}</strong><span>{warning.message}</span></div>)}</div>}
      </article>

      <article className="panel treasury-alert-actions">
        <header><div data-korean-heading><h2>재무 경보 조치현황</h2></div><button type="button" onClick={() => onNavigate("risk-actions")}>조치센터 열기 →</button></header>
        {!alertActionsConnected && <p className="alert-lineage-legacy">이 저장본은 재무 경보 연계 전에 생성되어 당시 경보 상태를 확정할 수 없습니다. 새 버전을 생성하면 기준일 상태가 동결됩니다.</p>}
        <div className="treasury-alert-summary"><span>미해결 <strong>{alertActionsConnected ? alertActions.unresolvedCount : "-"}</strong></span><span>중요 <strong>{alertActionsConnected ? alertActions.highCriticalUnresolvedCount : "-"}</strong></span><span>종료 검토 <strong>{alertActionsConnected ? alertActions.reviewCount : "-"}</strong></span><span>기한 경과 <strong>{alertActionsConnected ? alertActions.overdueCount : "-"}</strong></span></div>
        <div className="treasury-alert-list">{alertActions.items.filter((item) => item.status !== "CLOSED").slice(0, 6).map((item) => <button type="button" key={item.id} onClick={() => onNavigate("risk-actions")}><em className={item.priority.toLowerCase()}>{item.priority}</em><p><strong>{item.title}</strong><small>{(companyEmployees.find((employee) => employee.id === item.ownerEmployeeId)?.name ?? item.ownerEmployeeId) || "담당자 미지정"} · {item.dueDate || "기한 미정"} · 증빙 {item.evidenceCount}건</small></p><span>{alertStatusLabel[item.status] ?? item.status}</span></button>)}{alertActionsConnected && alertActions.unresolvedCount === 0 && <p className="treasury-empty">보고일 기준 미해결 재무 경보가 없습니다.</p>}</div>
      </article>

      <div className="treasury-grid review">
        <form className="panel treasury-review" onSubmit={review}>
          <header><div data-korean-heading><h2>담당자 검토</h2></div><span>AI 결과는 참고자료</span></header>
          <label>경영 메모<textarea value={managementNote} disabled={!report || report.status !== "DRAFT"} onChange={(event) => setManagementNote(event.target.value)} placeholder="오늘의 자금 판단과 확인사항을 10자 이상 기록하세요." /></label>
          <label>후속조치<textarea value={actionItems} disabled={!report || report.status !== "DRAFT"} onChange={(event) => setActionItems(event.target.value)} placeholder={"한 줄에 하나씩 기록하세요.\n예: 미분류 출금 계정 지정"} /></label>
          <button type="submit" disabled={working || !report || report.status !== "DRAFT"}>검토 완료 저장</button>
          {report?.status === "REVIEWED" && <button type="button" className="finalize" disabled={working} onClick={() => void post({ action: "FINALIZE", reportId: report.id })}>승인 권한으로 최종 확정</button>}
          {report?.status === "FINAL" && <div className="treasury-final-stamp">확정본 · 수정 불가 · 새 버전으로 개정</div>}
        </form>

        <article className="panel treasury-history">
          <header><div data-korean-heading><h2>보고서 이력</h2></div><span>{data.reports.length}개 버전</span></header>
          <div>{data.reports.length ? data.reports.map((item) => <button type="button" className={item.id === report?.id ? "selected" : ""} key={item.id} onClick={() => void load(reportDate, item.id)}><span>v{item.version}</span><p><strong>{statusLabel[item.status]}</strong><small>원천 {item.sourceAsOf} · {item.analysisSource === "AI" ? "AI" : "규칙 기반"}</small></p><em>보기 →</em></button>) : <p className="treasury-empty">이 보고일에 저장된 자금일보가 없습니다.</p>}</div>
        </article>
      </div>
    </section>
  );
}
