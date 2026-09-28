"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type Control = { key: string; category: string; title: string; status: "PASS" | "FAIL" | "REVIEW"; message: string; count: number };
type CloseTask = { id: string; period: string; category: string; title: string; ownerEmployeeId: string; status: string; completedAt: number | null };
type CloseDocument = { id: string; category: string; version: number; fileName: string; uploadedBy: string; createdAt: number; downloadUrl: string };
type CloseData = {
  asOf: string; currentPeriod: string;
  run: { period: string; periodEnd: string; status: string; controlPassCount: number; controlFailCount: number;
    manualCompletedCount: number; manualTotalCount: number; evidenceCount: number; submittedBy: string; submittedAt: number | null;
    closedBy: string; closedAt: number | null; reopenedBy: string; reopenedAt: number | null; reopenedReason: string; version: number };
  controls: Control[]; tasks: CloseTask[]; documents: CloseDocument[];
  summary: { passCount: number; failCount: number; reviewCount: number; manualCompleted: number; manualTotal: number;
    evidenceCount: number; canSubmit: boolean; reasons: string[] };
  ledgerDrift: { checked:boolean;drifted:boolean;reason:string;checkedAsOf:string;frozenHash:string;currentHash:string;
    frozenLineCount:number;currentLineCount:number;lineCountDelta:number;totalsChanged:boolean;openingChanged:boolean };
};

const runStatusLabel: Record<string, string> = { OPEN: "작성 중", READY: "제출 준비", SUBMITTED: "결재 진행", CLOSED: "마감 잠금" };
const controlStatusLabel: Record<string, string> = { PASS: "통과", FAIL: "차단", REVIEW: "수동 확인" };

export default function FinanceCloseWorkspace() {
  const [period, setPeriod] = useState("");
  const [data, setData] = useState<CloseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  async function load(selectedPeriod = period) {
    setLoading(true);
    setMessage("");
    try {
      const query = selectedPeriod ? `?period=${encodeURIComponent(selectedPeriod)}` : "";
      const response = await fetch(`/api/finance/close${query}`, { cache: "no-store" });
      const result = await response.json() as CloseData & { error?: string };
      if (!response.ok) setMessage(result.error || "월마감 상태를 불러오지 못했습니다.");
      else { setData(result); setPeriod(result.run.period); }
    } catch { setMessage("월마감 상태를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/finance/close", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as CloseData & { error?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setMessage(result.error || "월마감 상태를 불러오지 못했습니다.");
        else { setData(result); setPeriod(result.run.period); }
        setLoading(false);
      })
      .catch(() => { if (active) { setMessage("월마감 상태를 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  const automatedCategories = useMemo(() => new Set((data?.controls ?? [])
    .filter((control) => control.status !== "REVIEW").map((control) => control.category)), [data]);

  async function mutate(body: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/close", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, ...body }) });
      const result = await response.json() as { error?: string; reasons?: string[] };
      if (!response.ok) setMessage([result.error, ...(result.reasons ?? [])].filter(Boolean).join(" · ") || "월마감 작업을 처리하지 못했습니다.");
      else { setMessage(success); await load(period); }
    } catch { setMessage("월마감 작업을 처리하지 못했습니다."); }
    finally { setWorking(false); }
  }

  async function updateTask(task: CloseTask, status: string) {
    await mutate({ action: "UPDATE_TASK", taskId: task.id, status }, "마감 검토 상태를 저장했습니다.");
  }

  async function uploadEvidence(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setWorking(true); setMessage("");
    const form = new FormData();
    form.append("module", "finance"); form.append("entityType", "financeCloseRun");
    form.append("entityId", period); form.append("category", "CLOSE_PACK"); form.append("file", file);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const result = await response.json() as { error?: string };
      if (!response.ok) setMessage(result.error || "마감 증빙을 저장하지 못했습니다.");
      else { setMessage("마감 증빙을 버전 기록과 함께 저장했습니다."); await load(period); }
    } catch { setMessage("마감 증빙을 저장하지 못했습니다."); }
    finally { setWorking(false); }
  }

  async function requestReopen() {
    const reason = window.prompt("잠금된 월을 다시 열어야 하는 사유를 입력해 주세요.", "");
    if (!reason?.trim()) return;
    await mutate({ action: "REQUEST_REOPEN", reason: reason.trim() }, "재개방 결재를 제출했습니다. 승인 전까지 마감 잠금은 유지됩니다.");
  }

  if (loading && !data) return <section className="panel finance-close-loading">원장과 마감 통제를 확인하고 있습니다…</section>;

  return <div className="finance-close-workspace">
    <section className="finance-close-hero">
      <div data-korean-heading><h1>월마감 통제센터</h1><span>자동 원장 검증과 수동 검토, 증빙, 승인 이력을 하나의 월마감 실행으로 잠급니다.</span></div>
      <label>마감월<input type="month" min="2026-01" max={data?.currentPeriod} value={period} onChange={(event) => { setPeriod(event.target.value); void load(event.target.value); }} /></label>
    </section>

    {message && <div className="finance-close-message" role="status">{message}</div>}

    <section className="finance-close-metrics">
      <article><small>마감 상태</small><strong>{runStatusLabel[data?.run.status ?? "OPEN"]}</strong><span>버전 {data?.run.version ?? 1}</span></article>
      <article><small>자동 통제</small><strong>{data?.summary.passCount ?? 0}/{data?.controls.length ?? 0}</strong><span>차단 {data?.summary.failCount ?? 0} · 수동 {data?.summary.reviewCount ?? 0}</span></article>
      <article><small>수동 검토</small><strong>{data?.summary.manualCompleted ?? 0}/{data?.summary.manualTotal ?? 0}</strong><span>완료 항목</span></article>
      <article><small>마감 증빙</small><strong>{data?.summary.evidenceCount ?? 0}건</strong><span>버전 관리·감사기록</span></article>
    </section>

    {data?.run.status !== "OPEN" && <section className={`finance-close-drift ${!data.ledgerDrift.checked?"unavailable":data.ledgerDrift.drifted?"drifted":"matched"}`}>
      <span>{!data.ledgerDrift.checked?"?":data.ledgerDrift.drifted?"!":"✓"}</span>
      <div><strong>{!data.ledgerDrift.checked?"원장 무결성 비교 필요":data.ledgerDrift.drifted?"마감 이후 원장 변동 감지":"동결 원장과 현재 원장 일치"}</strong><small>{data.ledgerDrift.reason}</small></div>
      {data.ledgerDrift.checked&&<p><strong>{data.ledgerDrift.frozenLineCount.toLocaleString("ko-KR")} → {data.ledgerDrift.currentLineCount.toLocaleString("ko-KR")}행</strong><small>{data.ledgerDrift.checkedAsOf} 기준 · 동결 {data.ledgerDrift.frozenHash.slice(0,12)}… / 현재 {data.ledgerDrift.currentHash.slice(0,12)}…{data.ledgerDrift.totalsChanged?" · 합계 변동":""}{data.ledgerDrift.openingChanged?" · 개시잔액 계보 변동":""}</small></p>}
    </section>}

    {(data?.summary.reasons.length ?? 0) > 0 && data?.run.status === "OPEN" && <section className="finance-close-blockers">
      <header><strong>마감 전 해결할 항목</strong><span>{data.summary.reasons.length}건</span></header>
      <div>{data.summary.reasons.map((reason) => <p key={reason}><i>!</i>{reason}</p>)}</div>
    </section>}

    <section className="finance-close-grid">
      <article className="panel finance-close-controls">
        <header><div data-korean-heading><h2>원장 자동 검증</h2></div><span>{data?.asOf} 기준</span></header>
        <div>{(data?.controls ?? []).map((control, index) => <div className={`finance-close-control ${control.status.toLowerCase()}`} key={control.key}><span>{String(index + 1).padStart(2, "0")}</span><p><strong>{control.title}</strong><small>{control.message}</small></p><em>{controlStatusLabel[control.status]}</em></div>)}</div>
      </article>

      <article className="panel finance-close-tasks">
        <header><div data-korean-heading><h2>마감 업무</h2></div><span>{data?.tasks.length ?? 0}개 통제</span></header>
        <div>{(data?.tasks ?? []).map((task) => { const automated = automatedCategories.has(task.category); return <div key={task.id}><span className={["COMPLETED", "APPROVED"].includes(task.status) ? "done" : ""}>{["COMPLETED", "APPROVED"].includes(task.status) ? "✓" : "·"}</span><p><strong>{task.title}</strong><small>{task.category}{automated ? " · 원장 자동판정" : " · 담당자 확인"}</small></p><select disabled={automated || data?.run.status !== "OPEN" || working} value={task.status === "APPROVED" ? "COMPLETED" : task.status} onChange={(event) => void updateTask(task, event.target.value)}><option value="OPEN">미착수</option><option value="IN_PROGRESS">확인 필요</option><option value="COMPLETED">완료</option></select></div>; })}</div>
      </article>
    </section>

    <section className="finance-close-bottom-grid">
      <article className="panel finance-close-evidence">
        <header><div data-korean-heading><h2>마감 증빙</h2><span>시산표·은행 잔액·세금·급여·검토표를 한 묶음으로 보관합니다.</span></div><label className={working || data?.run.status !== "OPEN" ? "disabled" : ""}>+ 파일 첨부<input disabled={working || data?.run.status !== "OPEN"} type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv" onChange={(event) => void uploadEvidence(event)} /></label></header>
        <div>{(data?.documents ?? []).map((document) => <a href={document.downloadUrl} key={document.id}><span>{document.fileName.split(".").pop()?.toUpperCase() || "FILE"}</span><p><strong>{document.fileName}</strong><small>v{document.version} · {document.uploadedBy || "담당자"} · {new Date(document.createdAt).toLocaleString("ko-KR")}</small></p><em>다운로드</em></a>)}{!data?.documents.length && <p className="finance-close-empty">마감 근거 파일을 첨부하면 삭제 대신 이력과 버전을 보존합니다.</p>}</div>
      </article>

      <article data-korean-heading className="panel finance-close-action">
        <h2>{period} 마감</h2>
        <div><span>기간 종료일</span><strong>{data?.run.periodEnd}</strong></div><div><span>현재 상태</span><strong>{runStatusLabel[data?.run.status ?? "OPEN"]}</strong></div>
        {data?.run.status === "OPEN" && <button type="button" disabled={!data.summary.canSubmit || working} onClick={() => void mutate({ action: "SUBMIT_CLOSE" }, "월마감 잠금 결재를 제출했습니다.")}>월마감 잠금 결재 제출</button>}
        {data?.run.status === "SUBMITTED" && <button type="button" disabled>전자결재 진행 중</button>}
        {data?.run.status === "CLOSED" && <button type="button" className="reopen" disabled={working} onClick={() => void requestReopen()}>재개방 결재 요청</button>}
        <small>{data?.run.status === "CLOSED" ? `${data.run.closedBy || "승인자"} · ${data.run.closedAt ? new Date(data.run.closedAt).toLocaleString("ko-KR") : "잠금 완료"}` : "잠금 시 자동 통제와 수동 검토, 증빙 목록을 불변 스냅샷으로 저장합니다."}</small>
      </article>
    </section>
  </div>;
}
