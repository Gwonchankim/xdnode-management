"use client";

import { FormEvent, useEffect, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type Center = { id: string; code: string; name: string; center_type: string; owner_employee_id: string; opportunity_id: string;
  client_name: string; start_date: string; end_date: string; status: string; note: string; revenue: number; cost: number;
  profit: number; marginPct: number | null; revenueBudget: number; costBudget: number; revenueVariance: number; costVariance: number };
type Source = { sourceType: string; sourceId: string; period: string; date: string; label: string; detail: string;
  direction: "REVENUE" | "COST"; amount: number; linkedCenterId: string; autoAssigned: boolean; allocated: number; remaining: number };
type Allocation = { id: string; cost_center_id: string; source_type: string; source_id: string; period: string; direction: string;
  source_amount: number; amount: number; note: string; center_code: string; center_name: string; created_at: number };
type Opportunity = { id: string; title: string; stage: string; account_name: string };
type Data = { asOf: string; currentPeriod: string; period: string; locked: boolean; centers: Center[]; opportunities: Opportunity[];
  sources: Source[]; allocations: Allocation[]; summary: { activeCenters: number; revenue: number; cost: number; profit: number;
    unmappedSources: number; unmappedAmount: number; externalScopeNote: string } };

const won = (value: number) => `₩${Number(value || 0).toLocaleString("ko-KR")}`;
const compact = (value: number) => Math.abs(value) >= 100_000_000 ? `₩${(value / 100_000_000).toFixed(2)}억` : won(value);
const typeLabel: Record<string, string> = { PROJECT: "프로젝트", DEPARTMENT: "부서", OVERHEAD: "공통비" };
const sourceLabel: Record<string, string> = { SALES_INVOICE: "매출 청구", PURCHASE_INVOICE: "매입 인보이스", EXPENSE_REQUEST: "지출", PAYROLL_RUN: "급여" };
const statusLabel: Record<string, string> = { ACTIVE: "운영", HOLD: "보류", CLOSED: "종료" };
const initialDraft = { code: "", name: "", centerType: "PROJECT", ownerEmployeeId: "", opportunityId: "", startDate: "", endDate: "", note: "" };

export default function ProjectCostingWorkspace() {
  const [data, setData] = useState<Data | null>(null); const [period, setPeriod] = useState("");
  const [draft, setDraft] = useState(initialDraft); const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false); const [message, setMessage] = useState("");
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, { centerId: string; amount: string; note: string }>>({});

  async function load(selected = period) {
    setLoading(true); setMessage("");
    try {
      const response = await fetch(`/api/finance/project-costing${selected ? `?period=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      const result = await response.json() as Data & { error?: string };
      if (!response.ok) throw new Error(result.error || "프로젝트 손익 원장을 불러오지 못했습니다.");
      setData(result); setPeriod(result.period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "프로젝트 손익 원장을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/finance/project-costing", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as Data & { error?: string } }))
      .then(({ response, result }) => { if (!active) return; if (!response.ok) setMessage(result.error || "프로젝트 손익 원장을 불러오지 못했습니다.");
        else { setData(result); setPeriod(result.period); } setLoading(false); })
      .catch(() => { if (active) { setMessage("프로젝트 손익 원장을 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/project-costing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "프로젝트 원가 작업을 처리하지 못했습니다.");
      setMessage(success); await load(period); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "프로젝트 원가 작업을 처리하지 못했습니다."); return false; }
    finally { setWorking(false); }
  }

  async function createCenter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate({ action: "CREATE_CENTER", ...draft }, "프로젝트·원가센터를 등록했습니다.")) setDraft(initialDraft);
  }

  async function setBudget(center: Center) {
    const revenue = window.prompt(`${center.name} ${period} 매출 예산`, String(center.revenueBudget)); if (revenue === null) return;
    const cost = window.prompt(`${center.name} ${period} 원가 예산`, String(center.costBudget)); if (cost === null) return;
    const note = window.prompt("예산 근거", "승인된 월간 계획") ?? "";
    await mutate({ action: "SET_BUDGET", costCenterId: center.id, period, revenueBudget: Number(revenue), costBudget: Number(cost), note }, "월 예산을 저장했습니다.");
  }

  async function setCenterStatus(center: Center, status: string) {
    if (status === "CLOSED" && !window.confirm(`${center.name} 원가센터를 종료할까요?`)) return;
    await mutate({ action: "SET_STATUS", costCenterId: center.id, status }, "원가센터 상태를 변경했습니다.");
  }

  async function allocate(source: Source) {
    const key = `${source.sourceType}:${source.sourceId}`; const item = allocationDrafts[key] ?? { centerId: "", amount: String(source.remaining), note: "" };
    if (await mutate({ action: "ALLOCATE", period, sourceType: source.sourceType, sourceId: source.sourceId,
      costCenterId: item.centerId, amount: Number(item.amount), note: item.note }, "원천 금액을 배부했습니다.")) {
      setAllocationDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    }
  }

  if (loading && !data) return <section className="panel project-costing-loading">프로젝트 손익과 원천 배부 상태를 확인하고 있습니다…</section>;
  const activeCenters = data?.centers.filter((center) => center.status === "ACTIVE") ?? [];
  const unallocated = data?.sources.filter((source) => source.remaining > 0) ?? [];
  return <div className="project-costing-workspace">
    <section className="project-costing-hero"><div data-korean-heading><h1>프로젝트·원가센터</h1><span>매출은 영업기회로 정확히 연결하고, 매입·지출·급여는 근거금액으로 배부해 손익을 확인합니다.</span></div><label>관리월<input type="month" min="2026-01" max={data?.currentPeriod} value={period} onChange={(event) => void load(event.target.value)} /></label></section>
    <div className="project-costing-guidance"><strong>추정 자동배부 금지</strong><span>{data?.summary.externalScopeNote}</span><em>{data?.locked ? "마감 잠금" : "ERP 원천 기준"}</em></div>
    {message && <div className="project-costing-message" role="status">{message}</div>}
    <section className="project-costing-metrics">
      <article><small>운영 원가센터</small><strong>{data?.summary.activeCenters ?? 0}개</strong><span>프로젝트·부서·공통비</span></article>
      <article><small>귀속 매출</small><strong>{compact(data?.summary.revenue ?? 0)}</strong><span>확정 청구 기준</span></article>
      <article><small>배부 원가</small><strong>{compact(data?.summary.cost ?? 0)}</strong><span>확정 원천 기준</span></article>
      <article className={(data?.summary.profit ?? 0) < 0 ? "negative" : "positive"}><small>프로젝트 손익</small><strong>{compact(data?.summary.profit ?? 0)}</strong><span>미분류 {data?.summary.unmappedSources ?? 0}건 · {compact(data?.summary.unmappedAmount ?? 0)}</span></article>
    </section>

    <section className="project-costing-grid">
      <article className="panel project-center-form"><header><div data-korean-heading><h2>원가센터 등록</h2></div><span>영업기회 연결은 프로젝트만</span></header>
        <form onSubmit={createCenter}>
          <label>센터 코드<input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} placeholder="PRJ-2026-001" required /></label>
          <label>센터명<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="고객·과업명" required /></label>
          <label>유형<select value={draft.centerType} onChange={(event) => setDraft({ ...draft, centerType: event.target.value, opportunityId: event.target.value === "PROJECT" ? draft.opportunityId : "" })}><option value="PROJECT">프로젝트</option><option value="DEPARTMENT">부서</option><option value="OVERHEAD">공통비</option></select></label>
          <label>담당자<select value={draft.ownerEmployeeId} onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}><option value="">미지정</option>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label>
          <label className="wide">영업기회<select disabled={draft.centerType !== "PROJECT"} value={draft.opportunityId} onChange={(event) => setDraft({ ...draft, opportunityId: event.target.value })}><option value="">연결 안 함</option>{data?.opportunities.map((item) => <option key={item.id} value={item.id}>{item.account_name || "고객 미지정"} · {item.title} · {item.stage}</option>)}</select></label>
          <label>시작일<input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label>
          <label>종료 예정일<input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></label>
          <label className="wide">관리 메모<input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="계약·과업·배부 기준" /></label>
          <button type="submit" disabled={working}>원가센터 등록</button>
        </form>
      </article>
      <article className="panel project-source-summary"><header><div data-korean-heading><h2>미분류 원천</h2></div><span>{unallocated.length}건</span></header>
        <div><strong>{compact(data?.summary.unmappedAmount ?? 0)}</strong><p>월마감 전에 배부하거나 명확한 공통비 센터로 분류해야 합니다.</p><dl><div><dt>매출</dt><dd>{unallocated.filter((item) => item.direction === "REVENUE").length}건</dd></div><div><dt>원가</dt><dd>{unallocated.filter((item) => item.direction === "COST").length}건</dd></div></dl></div>
      </article>
    </section>

    <section className="panel project-center-ledger"><header><div data-korean-heading><h2>{period} 센터별 손익</h2></div><span>실적 · 예산 · 차이</span></header>
      <div className="project-center-row head"><span>센터</span><span>담당·기간</span><span>매출/예산</span><span>원가/예산</span><span>손익·이익률</span><span>상태</span><span>관리</span></div>
      {data?.centers.map((center) => <div className={`project-center-row ${center.status.toLowerCase()}`} key={center.id}>
        <p><strong>{center.code} · {center.name}</strong><small>{typeLabel[center.center_type]}{center.client_name ? ` · ${center.client_name}` : ""}</small></p>
        <p><span>{companyEmployees.find((employee) => employee.id === center.owner_employee_id)?.name ?? "미지정"}</span><small>{center.start_date || "시작일 미입력"} → {center.end_date || "진행 중"}</small></p>
        <p><strong>{won(center.revenue)}</strong><small>예산 {won(center.revenueBudget)} · 차이 {won(center.revenueVariance)}</small></p>
        <p><strong>{won(center.cost)}</strong><small>예산 {won(center.costBudget)} · 차이 {won(center.costVariance)}</small></p>
        <p className={center.profit < 0 ? "loss" : "profit"}><strong>{won(center.profit)}</strong><small>{center.marginPct === null ? "매출 없음" : `이익률 ${center.marginPct}%`}</small></p>
        <em>{statusLabel[center.status] ?? center.status}</em>
        <div><button type="button" disabled={working || data.locked || center.status === "CLOSED"} onClick={() => void setBudget(center)}>예산</button>{center.status === "ACTIVE" && <button type="button" disabled={working} onClick={() => void setCenterStatus(center, "HOLD")}>보류</button>}{center.status === "HOLD" && <button type="button" disabled={working} onClick={() => void setCenterStatus(center, "ACTIVE")}>재개</button>}{center.status !== "CLOSED" && <button type="button" disabled={working} onClick={() => void setCenterStatus(center, "CLOSED")}>종료</button>}</div>
      </div>)}{!data?.centers.length && <p className="project-costing-empty">등록된 원가센터가 없습니다. 공통비도 명시적인 OVERHEAD 센터로 먼저 등록해 주세요.</p>}
    </section>

    <section className="panel project-allocation-ledger"><header><div data-korean-heading><h2>확정 원천 배부</h2><span>원천 합계를 넘을 수 없으며 급여는 타임시트·관리자 확인 근거가 필요합니다.</span></div><em>{data?.locked ? "마감월 잠금" : `${data?.sources.length ?? 0}건`}</em></header>
      <div className="project-source-row head"><span>원천</span><span>금액</span><span>배부 상태</span><span>원가센터</span><span>배부금액</span><span>배부 근거</span><span>처리</span></div>
      {data?.sources.map((source) => { const key = `${source.sourceType}:${source.sourceId}`; const entry = allocationDrafts[key] ?? { centerId: "", amount: String(source.remaining), note: "" }; return <div className={`project-source-row ${source.remaining ? "pending" : "complete"}`} key={key}>
        <p><em>{sourceLabel[source.sourceType] ?? source.sourceType}</em><strong>{source.label}</strong><small>{source.date} · {source.detail}</small></p>
        <strong>{won(source.amount)}</strong>
        <p><span>{source.autoAssigned ? "영업기회 자동귀속" : `${won(source.allocated)} 배부`}</span><small>잔액 {won(source.remaining)}</small></p>
        {source.autoAssigned ? <span className="project-auto-center">{data.centers.find((center) => center.id === source.linkedCenterId)?.name ?? "연결 센터"}</span> : <select disabled={!source.remaining || data.locked} value={entry.centerId} onChange={(event) => setAllocationDrafts({ ...allocationDrafts, [key]: { ...entry, centerId: event.target.value } })}><option value="">센터 선택</option>{activeCenters.filter((center) => source.direction === "COST" || center.center_type === "PROJECT").map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select>}
        <input disabled={!source.remaining || source.autoAssigned || data.locked} type="number" min="1" max={source.remaining} value={entry.amount} onChange={(event) => setAllocationDrafts({ ...allocationDrafts, [key]: { ...entry, amount: event.target.value } })} />
        <input disabled={!source.remaining || source.autoAssigned || data.locked} value={entry.note} placeholder={source.sourceType === "PAYROLL_RUN" ? "타임시트·관리자 확인 근거" : "계약·발주·사용 근거"} onChange={(event) => setAllocationDrafts({ ...allocationDrafts, [key]: { ...entry, note: event.target.value } })} />
        <button type="button" disabled={working || !source.remaining || source.autoAssigned || data.locked} onClick={() => void allocate(source)}>배부</button>
      </div>; })}{!data?.sources.length && <p className="project-costing-empty">이 관리월에 확정된 ERP 원천이 없습니다.</p>}
    </section>

    <section className="panel project-allocation-history"><header><div data-korean-heading><h2>배부 감사 이력</h2></div><span>{data?.allocations.length ?? 0}건</span></header>
      {data?.allocations.map((item) => <div key={item.id}><p><strong>{item.center_code} · {item.center_name}</strong><small>{sourceLabel[item.source_type] ?? item.source_type} · {item.note}</small></p><span>{item.direction === "REVENUE" ? "매출" : "원가"}</span><strong>{won(item.amount)}</strong><time>{new Date(item.created_at).toLocaleString("ko-KR")}</time><button type="button" disabled={working || data.locked} onClick={() => { const reason = window.prompt("배부 삭제 사유", "원천 귀속 정정"); if (reason) void mutate({ action: "REMOVE_ALLOCATION", id: item.id, reason }, "배부 이력을 삭제하고 감사로그를 남겼습니다."); }}>삭제</button></div>)}{!data?.allocations.length && <p className="project-costing-empty">수동 배부 이력이 없습니다.</p>}
    </section>
  </div>;
}
