"use client";

import { FormEvent, useEffect, useState } from "react";
import { financeCurrentData } from "./finance-current-data";

type Plan = { id: string; fiscalYear: number; name: string; status: string; version: number; revisionReason: string; ownerEmployeeId: string; approvedBy: string; approvedAt: number | null };
type VarianceAction = { id: string; status: string; cause: string; actionPlan: string; ownerEmployeeId: string; dueDate: string; updatedAt: number };
type BudgetLine = {
  id: string; month: number; department: string; accountCode: string; accountName: string; direction: string;
  actualSource: string; sourceLabel: string; amount: number; comparisonBudget: number; actualAmount: number | null;
  varianceAmount: number | null; variancePct: number | null; thresholdPct: number; notes: string;
  mapping: string; mappingNote: string; partial: boolean; flag: string; requiresAction: boolean; action: VarianceAction | null;
};
type DirectionSummary = { direction: string; annualBudget: number; budgetToDate: number; actualToDate: number; variance: number; yearEndProjection: number };
type BudgetData = {
  asOf: string; year: number; currentYear: number; scopeNotice: string; plans: Plan[];
  selected: null | {
    plan: Plan; lines: BudgetLine[];
    summary: { annualBudget: number; budgetToDate: number; actualToDate: number; yearEndProjection: number; alertCount: number; watchCount: number; unmappedCount: number; openActionCount: number; mappedCount: number; comparableCount: number; coveragePct: number; registeredMonthCount: number };
    directionSummary: DirectionSummary[];
  };
};
type MasterAccount = { id: string; code: string; name: string; category: string; status: string };

const statusLabel: Record<string, string> = {
  DRAFT: "작성 중", SUBMITTED: "결재 진행", APPROVED: "승인 예산", SUPERSEDED: "이전 버전",
  GOOD: "범위 내", WATCH: "주의", ALERT: "조치 필요", UNMAPPED: "매핑 필요", FUTURE: "예정월",
  OPEN: "원인 확인", EXPLAINED: "원인 기록", ACTIONED: "조치 등록",
};
const sourceOptions = [
  ["SALES_INVOICE", "Clobe 매출 세금계산서"], ["PURCHASE_INVOICE", "Clobe 매입 세금계산서"],
  ["POSTED_JOURNAL_DEBIT", "ERP 전기 분개 차변"], ["POSTED_JOURNAL_CREDIT", "ERP 전기 분개 대변"],
] as const;
const won = (value: number | null) => value === null ? "—" : `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${won(value)}`;

export default function BudgetActualWorkspace() {
  const currentYear = Number(financeCurrentData.asOf.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [planId, setPlanId] = useState("");
  const [data, setData] = useState<BudgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [masterAccounts, setMasterAccounts] = useState<MasterAccount[]>([]);
  const [planName, setPlanName] = useState(`${currentYear}년 경영예산`);
  const [lineDraft, setLineDraft] = useState({ month: String(Number(financeCurrentData.asOf.slice(5, 7))), department: "전사", accountCode: "", accountName: "매출", direction: "REVENUE", actualSource: "SALES_INVOICE", amount: "", thresholdPct: "10", notes: "" });
  const [selectedLineId, setSelectedLineId] = useState("");
  const [actionDraft, setActionDraft] = useState({ status: "OPEN", cause: "", actionPlan: "", ownerEmployeeId: "", dueDate: "" });

  async function load(targetYear = year, targetPlanId = planId) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ year: String(targetYear) });
      if (targetPlanId) params.set("planId", targetPlanId);
      const response = await fetch(`/api/finance/budget?${params}`);
      const result = await response.json() as BudgetData & { error?: string };
      if (!response.ok) throw new Error(result.error || "예산실적 데이터를 불러오지 못했습니다.");
      setData(result);
      if (result.selected && result.selected.plan.id !== targetPlanId) setPlanId(result.selected.plan.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "예산실적 데이터를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }

  // The first load intentionally uses the initial year and empty plan selection.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    fetch("/api/finance/master-data").then(async (response) => {
      const result = await response.json() as { accounts?: MasterAccount[] };
      if (response.ok) setMasterAccounts((result.accounts ?? []).filter((item) => item.status === "ACTIVE"));
    }).catch(() => undefined);
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string, method = "POST") {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/budget", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string; plan?: Plan; planId?: string };
      if (!response.ok) throw new Error(result.error || "예산 작업을 완료하지 못했습니다.");
      const nextPlanId = result.plan?.id || result.planId || planId;
      if (nextPlanId) setPlanId(nextPlanId);
      setMessage(success);
      await load(year, nextPlanId);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "예산 작업을 완료하지 못했습니다.");
      return false;
    } finally { setWorking(false); }
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate({ action: "CREATE_PLAN", fiscalYear: year, name: planName }, "예산 계획을 생성했습니다.")) setPlanName(`${year}년 경영예산`);
  }
  async function addLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate({ action: "ADD_LINE", planId, ...lineDraft, month: Number(lineDraft.month), amount: Number(lineDraft.amount), thresholdPct: Number(lineDraft.thresholdPct) }, "월별 예산선을 추가했습니다.")) {
      setLineDraft((current) => ({ ...current, accountCode: "", amount: "", notes: "" }));
    }
  }
  async function submitPlan() {
    await mutate({ action: "SUBMIT_PLAN", planId }, "예산 계획을 전자결재로 제출했습니다.");
  }
  async function createRevision() {
    const reason = window.prompt("승인 예산을 개정하는 사유를 입력해 주세요. (5자 이상)", "사업계획 변경 반영");
    if (reason) await mutate({ action: "CREATE_REVISION", planId, reason }, "승인 예산을 보존하고 새 개정본을 만들었습니다.");
  }
  async function deleteLine(lineId: string) {
    if (!window.confirm("이 작성 중 예산선을 삭제할까요?")) return;
    await mutate({ lineId }, "예산선을 삭제했습니다.", "DELETE");
  }
  function openAction(line: BudgetLine) {
    setSelectedLineId(line.id);
    setActionDraft({ status: line.action?.status ?? "OPEN", cause: line.action?.cause ?? "", actionPlan: line.action?.actionPlan ?? "", ownerEmployeeId: line.action?.ownerEmployeeId ?? "", dueDate: line.action?.dueDate ?? "" });
  }
  async function saveAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate({ action: "SAVE_VARIANCE_ACTION", lineId: selectedLineId, ...actionDraft }, "예산 차이 원인과 조치를 저장했습니다.")) setSelectedLineId("");
  }

  const selected = data?.selected;
  const selectedLine = selected?.lines.find((line) => line.id === selectedLineId);
  const isDraft = selected?.plan.status === "DRAFT";

  return <div className="budget-actual-workspace">
    <section className="budget-actual-hero">
      <div data-korean-heading><h1>예산·실적 관리</h1><span>승인 예산을 실제 원천과 연결하고 차이의 원인·조치·담당·기한까지 관리합니다.</span></div>
      <div className="budget-actual-controls">
        <label>예산연도<select value={year} onChange={(event) => { const next = Number(event.target.value); setYear(next); setPlanId(""); void load(next, ""); }}>{Array.from({ length: 5 }, (_, index) => currentYear + index).map((item) => <option key={item} value={item}>{item}년</option>)}</select></label>
        {selected && ["APPROVED","SUPERSEDED"].includes(selected.plan.status) && <button type="button" onClick={() => void createRevision()} disabled={working}>+ 개정본 만들기</button>}
        {selected?.plan.status === "DRAFT" && <button type="button" className="primary" onClick={() => void submitPlan()} disabled={working || selected.summary.registeredMonthCount !== 12}>전자결재 제출</button>}
      </div>
    </section>

    {message && <p className="budget-actual-message" role="status">{message}</p>}
    {loading && <div className="budget-actual-loading">예산과 실적 원천을 대사하고 있습니다.</div>}

    {!loading && !selected && <section className="panel budget-empty-plan">
      <div data-korean-heading><h2>{year}년 예산 계획 만들기</h2><span>실제 회사 예산값은 임의로 만들지 않습니다. 계획을 만든 뒤 월별 예산선을 등록해 주세요.</span></div>
      <form onSubmit={(event) => void createPlan(event)}><label>계획명<input required value={planName} onChange={(event) => setPlanName(event.target.value)} /></label><button type="submit" disabled={working}>계획 생성</button></form>
    </section>}

    {!loading && selected && <>
      <section className="budget-plan-strip">
        <div className="budget-version-list">{data?.plans.map((plan) => <button type="button" className={plan.id === selected.plan.id ? "active" : ""} key={plan.id} onClick={() => { setPlanId(plan.id); void load(year, plan.id); }}><strong>v{plan.version}</strong><span>{statusLabel[plan.status]}</span></button>)}</div>
        <div><p><strong>{selected.plan.name}</strong><span>v{selected.plan.version} · {statusLabel[selected.plan.status]}</span></p>{selected.plan.revisionReason && <small>개정 사유: {selected.plan.revisionReason}</small>}</div>
      </section>

      <section className="budget-summary-grid">
        <article><small>연간 승인·작성 예산</small><strong>{won(selected.summary.annualBudget)}</strong><span>{selected.summary.registeredMonthCount}/12개월 · {selected.lines.length}개 예산선</span></article>
        <article><small>기준일까지 비교 예산</small><strong>{won(selected.summary.budgetToDate)}</strong><span>현재월은 {financeCurrentData.asOf.slice(8, 10)}일까지 일할 계산</span></article>
        <article><small>실제 발생액</small><strong>{won(selected.summary.actualToDate)}</strong><span>실적 매핑률 {selected.summary.coveragePct}%</span></article>
        <article className={selected.summary.openActionCount ? "alert" : ""}><small>차이 조치 필요</small><strong>{selected.summary.openActionCount}건</strong><span>경보 {selected.summary.alertCount} · 주의 {selected.summary.watchCount} · 매핑 {selected.summary.unmappedCount}</span></article>
      </section>

      <section className="budget-direction-grid">
        {selected.directionSummary.map((item) => <article className="panel" key={item.direction}><header><div><p>{item.direction === "REVENUE" ? "REVENUE PLAN" : "EXPENSE PLAN"}</p><h2>{item.direction === "REVENUE" ? "수익 예산" : "비용 예산"}</h2></div><span>{item.direction === "REVENUE" ? "높을수록 양호" : "낮을수록 양호"}</span></header><dl><div><dt>연간 예산</dt><dd>{won(item.annualBudget)}</dd></div><div><dt>비교 예산</dt><dd>{won(item.budgetToDate)}</dd></div><div><dt>실제</dt><dd>{won(item.actualToDate)}</dd></div><div><dt>차이</dt><dd className={item.variance > 0 ? "positive" : item.variance < 0 ? "negative" : ""}>{signedWon(item.variance)}</dd></div><div><dt>연말 예상</dt><dd>{won(item.yearEndProjection)}</dd></div></dl></article>)}
      </section>

      <div className="budget-scope-notice"><span>i</span><p><strong>실적 연결 범위</strong>{data?.scopeNotice} 연결되지 않은 예산은 0원이 아니라 ‘매핑 필요’로 표시합니다.</p></div>

      {isDraft && <section className="panel budget-line-editor">
        <header><div data-korean-heading><h2>월별 예산선 등록</h2><span>실적 원천과 한 번 연결하면 이후 스냅샷 갱신 시 자동 재계산됩니다.</span></div></header>
        <form onSubmit={(event) => void addLine(event)}>
          <label>월<select value={lineDraft.month} onChange={(event) => setLineDraft({ ...lineDraft, month: event.target.value })}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month}월</option>)}</select></label>
          <label>부서<input required value={lineDraft.department} onChange={(event) => setLineDraft({ ...lineDraft, department: event.target.value })} /></label>
          <label>구분<select value={lineDraft.direction} onChange={(event) => setLineDraft({ ...lineDraft, direction: event.target.value })}><option value="REVENUE">수익</option><option value="EXPENSE">비용</option></select></label>
          <label>계정과목<select value={lineDraft.accountCode} onChange={(event) => { const account = masterAccounts.find((item) => item.code === event.target.value); setLineDraft({ ...lineDraft, accountCode: account?.code ?? "", accountName: account?.name ?? "" }); }}><option value="">원천 합계만 사용</option>{masterAccounts.map((item) => <option key={item.id} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
          <label>실적 원천<select value={lineDraft.actualSource} onChange={(event) => { const actualSource = event.target.value; setLineDraft({ ...lineDraft, actualSource, direction: actualSource === "SALES_INVOICE" ? "REVENUE" : actualSource === "PURCHASE_INVOICE" ? "EXPENSE" : lineDraft.direction }); }}>{sourceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>예산액<input required min="0" type="number" value={lineDraft.amount} onChange={(event) => setLineDraft({ ...lineDraft, amount: event.target.value })} /></label>
          <label>경보 기준<input required min="0" max="100" type="number" value={lineDraft.thresholdPct} onChange={(event) => setLineDraft({ ...lineDraft, thresholdPct: event.target.value })} /><small>차이 ±%</small></label>
          <label className="wide">메모<input value={lineDraft.notes} onChange={(event) => setLineDraft({ ...lineDraft, notes: event.target.value })} /></label>
          <button type="submit" disabled={working}>+ 예산선 추가</button>
        </form>
      </section>}

      <section className="panel budget-variance-table">
        <header><div data-korean-heading><h2>월별 예산·실적 차이</h2><span>경보는 수익 미달과 비용 초과를 서로 다르게 판정합니다.</span></div><span>{selected.lines.length}개 예산선</span></header>
        <div className="budget-variance-row head"><span>기간·부서</span><span>계정·원천</span><span>예산</span><span>비교 예산</span><span>실제</span><span>차이</span><span>상태</span><span>관리</span></div>
        {selected.lines.map((line) => <div className={`budget-variance-row ${line.flag.toLowerCase()}`} key={line.id}>
          <p><strong>{year}.{String(line.month).padStart(2, "0")}</strong><small>{line.department}{line.partial ? " · 부분월" : ""}</small></p>
          <p><strong>{line.accountName}</strong><small>{line.sourceLabel}</small></p>
          <b>{won(line.amount)}</b><b>{won(line.comparisonBudget)}</b><b>{won(line.actualAmount)}</b>
          <b className={(line.varianceAmount ?? 0) > 0 ? "positive" : (line.varianceAmount ?? 0) < 0 ? "negative" : ""}>{signedWon(line.varianceAmount)}</b>
          <em className={line.flag.toLowerCase()} title={line.mappingNote}>{statusLabel[line.flag]}</em>
          <div>{isDraft ? <button type="button" className="delete" onClick={() => void deleteLine(line.id)}>삭제</button> : <button type="button" onClick={() => openAction(line)}>{line.action ? statusLabel[line.action.status] : "원인·조치"}</button>}</div>
        </div>)}
        {!selected.lines.length && <div className="budget-table-empty">등록된 월별 예산선이 없습니다.</div>}
      </section>

      {selectedLine && <section className="panel budget-action-editor">
        <header><div data-korean-heading><h2>{year}.{String(selectedLine.month).padStart(2, "0")} {selectedLine.accountName}</h2><span>{selectedLine.mappingNote} · 차이 {signedWon(selectedLine.varianceAmount)}</span></div><button type="button" onClick={() => setSelectedLineId("")}>닫기</button></header>
        <form onSubmit={(event) => void saveAction(event)}>
          <label>관리 상태<select value={actionDraft.status} onChange={(event) => setActionDraft({ ...actionDraft, status: event.target.value })}><option value="OPEN">원인 확인 중</option><option value="EXPLAINED">원인 기록 완료</option><option value="ACTIONED">조치 계획 등록</option></select></label>
          <label className="wide">차이 원인<textarea value={actionDraft.cause} onChange={(event) => setActionDraft({ ...actionDraft, cause: event.target.value })} placeholder="매출 이연, 일회성 구매, 단가 변동 등" /></label>
          <label className="wide">조치 계획<textarea value={actionDraft.actionPlan} onChange={(event) => setActionDraft({ ...actionDraft, actionPlan: event.target.value })} placeholder="회수 일정, 구매 조정, 예산 개정 등" /></label>
          <label>담당자<input value={actionDraft.ownerEmployeeId} onChange={(event) => setActionDraft({ ...actionDraft, ownerEmployeeId: event.target.value })} /></label>
          <label>조치 기한<input type="date" value={actionDraft.dueDate} onChange={(event) => setActionDraft({ ...actionDraft, dueDate: event.target.value })} /></label>
          <button type="submit" disabled={working}>차이 조치 저장</button>
        </form>
      </section>}
    </>}
  </div>;
}
