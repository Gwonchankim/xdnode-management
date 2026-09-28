"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Plan = { id: string; year: number; version: number; name: string; status: string; createdBy: string; approvedBy: string; approvedAt: number | null };
type Scope = { type: "COMPANY" | "DEPARTMENT" | "EMPLOYEE"; key: string; name: string };
type MonthPerformance = { period: string; targetRevenue: number; targetGrossProfit: number; targetOrders: number; actualRevenue: number; actualGrossProfit: number; actualOrderRevenue: number; actualOrders: number; weightedPipeline: number; forecastRevenue: number; forecastGrossProfit: number };
type ScopePerformance = { scope: Scope; monthly: MonthPerformance[]; annual: Omit<MonthPerformance, "period">; forecastAttainment: number | null };
type Snapshot = { id: string; planId: string; asOfDate: string; version: number; formulaVersion: string; createdBy: string; createdAt: number; companyAnnual: ScopePerformance["annual"] | null };
type PlanningData = { plans: Plan[]; activePlan: Plan | null; year: number; formulaVersion: string; asOfDate: string; scopes: Scope[]; performance: ScopePerformance[]; snapshots: Snapshot[]; sourceCounts: { opportunities: number; documents: number; employees: number } };

const won = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const statusLabels: Record<string, string> = { DRAFT: "작성 중", SUBMITTED: "결재 중", APPROVED: "승인", SUPERSEDED: "대체됨" };

export default function SalesPlanningView() {
  const [data, setData] = useState<PlanningData | null>(null);
  const [message, setMessage] = useState("");
  const [scopeValue, setScopeValue] = useState("COMPANY:company");
  const [planDraft, setPlanDraft] = useState({ year: String(new Date().getFullYear()), name: "" });
  const [lineDraft, setLineDraft] = useState({ period: `${new Date().getFullYear()}-01`, targetRevenue: "", targetGrossProfit: "", targetOrders: "" });

  async function load(planId = "") {
    try {
      const response = await fetch(`/api/sales/planning${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`);
      const result = await response.json() as PlanningData & { error?: string };
      if (!response.ok) throw new Error(result.error || "영업 목표·전망을 불러오지 못했습니다.");
      setData(result);
      if (result.activePlan && !lineDraft.period.startsWith(String(result.activePlan.year))) setLineDraft((current) => ({ ...current, period: `${result.activePlan?.year}-01` }));
      if (!result.scopes.some((scope) => `${scope.type}:${scope.key}` === scopeValue)) setScopeValue("COMPANY:company");
    } catch (error) { setMessage(error instanceof Error ? error.message : "영업 목표·전망을 불러오지 못했습니다."); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const [scopeType, scopeKey] = scopeValue.split(":", 2) as [Scope["type"], string];
  const selectedScope = data?.scopes.find((scope) => scope.type === scopeType && scope.key === scopeKey) ?? data?.scopes[0];
  const performance = data?.performance.find((item) => item.scope.type === selectedScope?.type && item.scope.key === selectedScope?.key);
  const latestSnapshot = data?.snapshots[0]; const previousSnapshot = data?.snapshots[1];
  const forecastDelta = useMemo(() => latestSnapshot?.companyAnnual && previousSnapshot?.companyAnnual && previousSnapshot.companyAnnual.forecastRevenue
    ? Math.round((latestSnapshot.companyAnnual.forecastRevenue - previousSnapshot.companyAnnual.forecastRevenue) / previousSnapshot.companyAnnual.forecastRevenue * 1000) / 10 : null,
  [latestSnapshot, previousSnapshot]);

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage("");
    const response = await fetch("/api/sales/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "CREATE_PLAN", year: Number(planDraft.year), name: planDraft.name }) });
    const result = await response.json() as { item?: Plan; error?: string };
    if (!response.ok) { setMessage(result.error || "목표 계획을 생성하지 못했습니다."); return; }
    setPlanDraft((current) => ({ ...current, name: "" })); setMessage("새 목표 계획 버전을 생성했습니다.");
    await load(result.item?.id);
  }

  async function saveLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data?.activePlan || !selectedScope) return;
    const response = await fetch("/api/sales/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "UPSERT_LINE", planId: data.activePlan.id,
      scopeType: selectedScope.type, scopeKey: selectedScope.key, period: lineDraft.period, targetRevenue: Number(lineDraft.targetRevenue),
      targetGrossProfit: Number(lineDraft.targetGrossProfit), targetOrders: Number(lineDraft.targetOrders) }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "월별 목표를 저장하지 못했습니다."); return; }
    setMessage(`${selectedScope.name} ${lineDraft.period} 목표를 저장했습니다.`); await load(data.activePlan.id);
  }

  function editMonth(month: MonthPerformance) {
    setLineDraft({ period: month.period, targetRevenue: String(month.targetRevenue), targetGrossProfit: String(month.targetGrossProfit), targetOrders: String(month.targetOrders) });
  }

  async function act(action: "SUBMIT_PLAN" | "SNAPSHOT") {
    if (!data?.activePlan) return;
    const response = await fetch("/api/sales/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, planId: data.activePlan.id }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setMessage(result.error || "처리하지 못했습니다."); return; }
    setMessage(action === "SUBMIT_PLAN" ? "영업 목표 계획을 전자결재에 제출했습니다." : "현재 전망을 변경 불가능한 스냅샷으로 저장했습니다.");
    await load(data.activePlan.id);
  }

  return <section className="panel sales-planning-view">
    <header><div data-korean-heading><h2>영업 목표·전망</h2><span>확정 청구와 미청구 가중 파이프라인을 분리해 목표 대비 전망을 확인합니다.</span></div><div><select aria-label="목표 계획 선택" value={data?.activePlan?.id ?? ""} onChange={(event) => void load(event.target.value)}><option value="">계획 없음</option>{(data?.plans ?? []).map((plan) => <option key={plan.id} value={plan.id}>{plan.year} · v{plan.version} · {statusLabels[plan.status] ?? plan.status}</option>)}</select>{data?.activePlan?.status === "DRAFT" && <button type="button" onClick={() => void act("SUBMIT_PLAN")}>결재 제출</button>}{data?.activePlan?.status === "APPROVED" && <button type="button" onClick={() => void act("SNAPSHOT")}>전망 저장</button>}</div></header>
    {message && <div className="sales-live-message" role="status">{message}</div>}
    <div className="sales-plan-toolbar">
      <form onSubmit={createPlan}><label>연도<input required type="number" min="2024" max="2100" value={planDraft.year} onChange={(event) => setPlanDraft({ ...planDraft, year: event.target.value })} /></label><label>새 계획명<input required minLength={3} value={planDraft.name} onChange={(event) => setPlanDraft({ ...planDraft, name: event.target.value })} placeholder="예: 2027 사업계획" /></label><button type="submit">+ 새 버전</button></form>
      <label>비교 범위<select value={scopeValue} onChange={(event) => setScopeValue(event.target.value)}>{(data?.scopes ?? []).map((scope) => <option key={`${scope.type}:${scope.key}`} value={`${scope.type}:${scope.key}`}>{scope.type === "COMPANY" ? "회사" : scope.type === "DEPARTMENT" ? "조직" : "담당자"} · {scope.name}</option>)}</select></label>
    </div>
    <div className="sales-plan-metrics">
      <article><small>연간 매출 목표</small><strong>{won(performance?.annual.targetRevenue ?? 0)}</strong><span>{selectedScope?.name ?? "회사 전체"}</span></article>
      <article><small>확정 청구 실적</small><strong>{won(performance?.annual.actualRevenue ?? 0)}</strong><span>확정·완료 청구 발행월</span></article>
      <article><small>미청구 가중 파이프라인</small><strong>{won(performance?.annual.weightedPipeline ?? 0)}</strong><span>미청구 예상매출 × 확률</span></article>
      <article><small>연간 전망 / 달성률</small><strong>{won(performance?.annual.forecastRevenue ?? 0)}</strong><span>{performance?.forecastAttainment === null || performance?.forecastAttainment === undefined ? "목표 미입력" : `${performance.forecastAttainment}%`}</span></article>
    </div>
    {data?.activePlan?.status === "DRAFT" && selectedScope && <form className="sales-plan-line-form" onSubmit={saveLine}><label>목표월<input required type="month" min={`${data.activePlan.year}-01`} max={`${data.activePlan.year}-12`} value={lineDraft.period} onChange={(event) => setLineDraft({ ...lineDraft, period: event.target.value })} /></label><label>매출 목표<input required type="number" min="0" value={lineDraft.targetRevenue} onChange={(event) => setLineDraft({ ...lineDraft, targetRevenue: event.target.value })} /></label><label>매출총이익 목표<input required type="number" min="0" value={lineDraft.targetGrossProfit} onChange={(event) => setLineDraft({ ...lineDraft, targetGrossProfit: event.target.value })} /></label><label>수주 건수 목표<input required type="number" min="0" value={lineDraft.targetOrders} onChange={(event) => setLineDraft({ ...lineDraft, targetOrders: event.target.value })} /></label><button type="submit">월 목표 저장</button></form>}
    <div className="sales-plan-table">
      <div className="head"><span>월</span><span>매출 목표</span><span>확정 청구</span><span>확정 수주</span><span>가중 파이프라인</span><span>전망</span><span>달성 전망</span><span>관리</span></div>
      {(performance?.monthly ?? []).map((month) => <div key={month.period}><b>{month.period.slice(5)}월</b><span>{won(month.targetRevenue)}</span><span>{won(month.actualRevenue)}</span><span>{won(month.actualOrderRevenue)} · {month.actualOrders}건</span><span>{won(month.weightedPipeline)}</span><strong>{won(month.forecastRevenue)}</strong><em>{month.targetRevenue > 0 ? `${Math.round(month.forecastRevenue / month.targetRevenue * 1000) / 10}%` : "-"}</em><button type="button" disabled={data?.activePlan?.status !== "DRAFT"} onClick={() => editMonth(month)}>수정</button></div>)}
    </div>
    <footer><span>산식 {data?.formulaVersion ?? "-"} · 기준일 {data?.asOfDate ?? "-"} · 영업기회 {data?.sourceCounts.opportunities ?? 0}건 · 확정 문서 {data?.sourceCounts.documents ?? 0}건</span><span>{latestSnapshot ? `최근 스냅샷 ${latestSnapshot.asOfDate} v${latestSnapshot.version}` : "저장된 전망 없음"}{forecastDelta !== null ? ` · 직전 대비 ${forecastDelta > 0 ? "+" : ""}${forecastDelta}%` : ""}</span></footer>
  </section>;
}
