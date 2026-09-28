"use client";

import { useCallback, useEffect, useState } from "react";

type Plan = {
  id: string; period: string; version: number; title: string; assumptions: string; status: string;
  revisionReason: string; createdBy: string; submittedAt: number | null; approvedBy: string; approvedAt: number | null; updatedAt: number;
};
type Line = {
  id: string; planId: string; organizationId: string; organizationName: string; currentHeadcount: number;
  incomingHeadcount: number; plannedExits: number; projectedHeadcount: number; approvedHeadcount: number;
  hiringGap: number; surplus: number; note: string; updatedAt: number;
};
type WorkforceData = {
  plans: Plan[]; selected: Plan | null; lines: Line[];
  summary: { current: number; incoming: number; approved: number; gap: number; surplus: number };
};
type ApiResult = WorkforceData & { error?: string };

const statusLabels: Record<string, string> = { DRAFT: "작성 중", SUBMITTED: "결재 중", APPROVED: "승인", SUPERSEDED: "대체됨" };
const periodOptions = Array.from({ length: 10 }, (_, index) => {
  const year = 2026 + Math.floor((index + 1) / 2);
  return `${year}-${index % 2 === 0 ? "H2" : "H1"}`;
});

async function requestWorkforce(planId = "") {
  const response = await fetch(`/api/hr/workforce-plans${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`);
  const result = await response.json() as ApiResult;
  if (!response.ok) throw new Error(result.error || "인력계획을 불러오지 못했습니다.");
  return result;
}

function WorkforceLineEditor({ line, editable, busy, onSave }: { line: Line; editable: boolean; busy: boolean; onSave: (line: Line, draft: { approvedHeadcount: number; plannedExits: number; note: string }) => void }) {
  const [approvedHeadcount, setApprovedHeadcount] = useState(String(line.approvedHeadcount));
  const [plannedExits, setPlannedExits] = useState(String(line.plannedExits));
  const [note, setNote] = useState(line.note);
  const projected = Math.max(0, line.currentHeadcount + line.incomingHeadcount - Number(plannedExits || 0));
  const gap = Math.max(0, Number(approvedHeadcount || 0) - projected);
  const surplus = Math.max(0, projected - Number(approvedHeadcount || 0));
  return <div className={`workforce-line ${gap ? "gap" : surplus ? "surplus" : "balanced"}`}>
    <div><strong>{line.organizationName}</strong><small>{line.organizationId}</small></div>
    <span><small>현재</small><b>{line.currentHeadcount}</b></span>
    <span><small>입사 예정</small><b>{line.incomingHeadcount}</b></span>
    {editable ? <label><small>계획 퇴사</small><input type="number" min="0" max={line.currentHeadcount} value={plannedExits} onChange={(event) => setPlannedExits(event.target.value)} /></label> : <span><small>계획 퇴사</small><b>{line.plannedExits}</b></span>}
    <span><small>예상 가동</small><b>{projected}</b></span>
    {editable ? <label><small>승인 정원</small><input type="number" min="0" value={approvedHeadcount} onChange={(event) => setApprovedHeadcount(event.target.value)} /></label> : <span><small>승인 정원</small><b>{line.approvedHeadcount}</b></span>}
    <em>{gap ? `충원 ${gap}명` : surplus ? `초과 ${surplus}명` : "균형"}</em>
    {editable ? <label className="workforce-line-note"><small>조정 근거</small><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="축소 계획이면 근거 필수" /></label> : <p>{line.note || "등록된 조정 근거 없음"}</p>}
    {editable && <button type="button" disabled={busy} onClick={() => onSave(line, { approvedHeadcount: Number(approvedHeadcount), plannedExits: Number(plannedExits), note })}>행 저장</button>}
  </div>;
}

function PlanEditor({ plan, busy, onSave, onSubmit, onRevision }: { plan: Plan; busy: boolean; onSave: (title: string, assumptions: string) => void; onSubmit: () => void; onRevision: () => void }) {
  const [title, setTitle] = useState(plan.title);
  const [assumptions, setAssumptions] = useState(plan.assumptions);
  const editable = plan.status === "DRAFT";
  return <section className="workforce-plan-control">
    <div className="workforce-plan-copy">
      <label>계획명<input disabled={!editable} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="wide">계획 가정·기준<textarea disabled={!editable} rows={3} value={assumptions} onChange={(event) => setAssumptions(event.target.value)} placeholder="사업계획, 생산성, 인건비 또는 조직변경 가정을 10자 이상 기록하세요." /></label>
    </div>
    <div className="workforce-plan-actions">
      {editable && <button type="button" disabled={busy} onClick={() => onSave(title, assumptions)}>기본정보 저장</button>}
      {editable && <button type="button" className="primary" disabled={busy} onClick={onSubmit}>결재 제출</button>}
      {["APPROVED", "SUPERSEDED"].includes(plan.status) && <button type="button" className="primary" disabled={busy} onClick={onRevision}>개정본 만들기</button>}
      {plan.status === "SUBMITTED" && <span>결재센터에서 승인 결과를 확정합니다.</span>}
    </div>
  </section>;
}

export default function WorkforcePlanningView({ onNotify }: { onNotify: (message: string) => void }) {
  const [data, setData] = useState<WorkforceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ period: "2026-H2", title: "2026년 하반기 인력계획", assumptions: "" });

  const load = useCallback(async (planId = "") => {
    setLoading(true); setError("");
    try { setData(await requestWorkforce(planId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "인력계획을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestWorkforce().then((result) => { if (!cancelled) setData(result); })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "인력계획을 불러오지 못했습니다."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function mutate(body: Record<string, unknown>, message: string, selectedId = data?.selected?.id ?? "") {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/hr/workforce-plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "인력계획을 저장하지 못했습니다.");
      onNotify(message); setCreateOpen(false); await load(result.id ?? selectedId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "인력계획을 저장하지 못했습니다."); }
    finally { setBusy(false); }
  }

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void mutate({ action: "CREATE_PLAN", ...draft }, "인력계획 초안과 조직별 기준선을 만들었습니다.");
  }

  const selected = data?.selected;
  const editable = selected?.status === "DRAFT";
  return <div className="page-wrap workforce-page">
    <section className="module-hero workforce-hero">
      <div data-korean-heading><h1>인력계획 및 정원 관리</h1><p>승인 정원과 실제 재직·입사 예정 인원을 분리해 조직별 충원 필요를 계산합니다.</p></div>
      <div className="workforce-hero-actions">
        {data?.plans.length ? <select aria-label="인력계획 버전" value={selected?.id ?? ""} onChange={(event) => void load(event.target.value)}>{data.plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.period} · v{plan.version} · {statusLabels[plan.status] ?? plan.status}</option>)}</select> : null}
        <button type="button" className="primary-button" onClick={() => setCreateOpen((value) => !value)}>+ 새 계획</button>
      </div>
    </section>

    {createOpen && <form className="panel workforce-create" onSubmit={create}>
      <label>계획 반기<select value={draft.period} onChange={(event) => setDraft({ ...draft, period: event.target.value })}>{periodOptions.map((period) => <option key={period}>{period}</option>)}</select></label>
      <label>계획명<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label className="wide">초기 가정<textarea rows={2} value={draft.assumptions} onChange={(event) => setDraft({ ...draft, assumptions: event.target.value })} placeholder="초안 생성 후 보완할 수 있습니다." /></label>
      <button type="submit" disabled={busy}>기준선 생성</button>
    </form>}

    {error && <div className="workforce-message">{error}</div>}
    {loading && !data && <div className="panel workforce-empty">인사기록과 인력계획을 연결하고 있습니다.</div>}
    {!loading && data && !selected && !createOpen && <div className="panel workforce-empty"><strong>등록된 인력계획이 없습니다.</strong><span>새 계획을 만들면 현재 인원을 조직별 기준선으로 자동 채웁니다.</span></div>}

    {data && selected && <>
      <section className="metric-grid module-metrics workforce-metrics">
        {[
          ["현재 재직", data.summary.current, "인사기록 현재 상태"], ["입사 예정", data.summary.incoming, "수락된 채용 제안"],
          ["승인 정원", data.summary.approved, `${selected.period} · v${selected.version}`], ["충원 필요", data.summary.gap, data.summary.surplus ? `초과 ${data.summary.surplus}명 별도` : "예상 가동 기준"],
        ].map(([label, value, note], index) => <div className="compact-metric" key={String(label)}><span className={`metric-accent ${index === 3 ? "red" : index === 1 ? "green" : index === 2 ? "orange" : "navy"}`}></span><p>{label}</p><h2>{value}명</h2><small>{note}</small></div>)}
      </section>

      <section className="panel workforce-version-strip"><div><span>{selected.period}</span><strong>{selected.title}</strong><small>v{selected.version} · {selected.revisionReason || "최초 계획"}</small></div><em className={selected.status.toLowerCase()}>{statusLabels[selected.status] ?? selected.status}</em></section>
      <PlanEditor key={`${selected.id}:${selected.updatedAt}`} plan={selected} busy={busy}
        onSave={(title, assumptions) => void mutate({ action: "SAVE_PLAN", planId: selected.id, title, assumptions }, "인력계획의 기본정보를 저장했습니다.")}
        onSubmit={() => void mutate({ action: "SUBMIT_PLAN", planId: selected.id }, "인력계획 결재를 제출했습니다.")}
        onRevision={() => { const reason = window.prompt("개정 사유를 5자 이상 입력하세요.", "사업계획 변경 반영"); if (reason) void mutate({ action: "CREATE_REVISION", planId: selected.id, reason }, "인력계획 개정본을 만들었습니다."); }} />

      <section className="panel workforce-ledger">
        <header><div data-korean-heading><h2>조직별 정원 원장</h2><span>지원자 수는 포함하지 않으며 입사 예정 인사기록만 미래 인원으로 반영합니다.</span></div><em>{data.lines.length}개 조직</em></header>
        <div className="workforce-line workforce-head"><span>조직</span><span>현재</span><span>입사 예정</span><span>계획 퇴사</span><span>예상 가동</span><span>승인 정원</span><span>차이</span><span>근거</span>{editable && <span>저장</span>}</div>
        <div>{data.lines.map((line) => <WorkforceLineEditor key={`${line.organizationId}:${line.updatedAt}:${line.currentHeadcount}:${line.incomingHeadcount}`} line={line} editable={editable} busy={busy} onSave={(item, next) => void mutate({ action: "UPSERT_LINE", planId: selected.id, organizationId: item.organizationId, ...next }, `${item.organizationName} 정원 계획을 저장했습니다.`)} />)}</div>
      </section>
    </>}
  </div>;
}
