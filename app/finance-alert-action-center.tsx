"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type AlertCaseStatus = "OPEN" | "IN_PROGRESS" | "REVIEW" | "CLOSED";
type AlertEvent = { id: string; action: string; actorEmployeeId: string; comment: string; createdAt: number };
type AlertDocument = { id: string; category: string; version: number; fileName: string; uploadedBy: string; createdAt: number; downloadUrl: string };
type AlertCase = {
  id: string; taskId: string; taskSourceId: string; sourceDestination: string; title: string; description: string;
  priority: string; ownerEmployeeId: string; dueDate: string; status: AlertCaseStatus; rootCause: string;
  impactAssessment: string; actionPlan: string; resolutionSummary: string; submittedBy: string;
  submittedAt: number | null; reviewedBy: string; reviewedAt: number | null; reviewComment: string;
  version: number; createdAt: number; updatedAt: number; closedAt: number | null;
  events: AlertEvent[]; documents: AlertDocument[];
};
type AlertResponse = { cases: AlertCase[]; error?: string };

const statusLabel: Record<AlertCaseStatus, string> = { OPEN: "조치 대기", IN_PROGRESS: "조치 중", REVIEW: "종료 검토", CLOSED: "종료" };
const eventLabel: Record<string, string> = {
  ACTION_SAVED: "조치 저장", REVIEW_REQUESTED: "종료 검토 요청", REVIEW_REJECTED: "보완 요청",
  CLOSURE_APPROVED: "종료 승인", CASE_REOPENED: "재개방",
};
const employeeName = (id: string) => (companyEmployees.find((employee) => employee.id === id)?.name ?? id) || "미지정";

function AlertCaseEditor({ alertCase, onReload, onNavigate }: {
  alertCase: AlertCase; onReload: () => Promise<void>; onNavigate: (destination: string) => void;
}) {
  const [draft, setDraft] = useState({
    ownerEmployeeId: alertCase.ownerEmployeeId, dueDate: alertCase.dueDate,
    rootCause: alertCase.rootCause, impactAssessment: alertCase.impactAssessment,
    actionPlan: alertCase.actionPlan, resolutionSummary: alertCase.resolutionSummary,
  });
  const [reviewComment, setReviewComment] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function mutate(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/finance/alert-actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, caseId: alertCase.id, version: alertCase.version, ...draft, ...extra }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) setMessage(result.error || "경보 조치를 처리하지 못했습니다.");
      else { setMessage(action === "APPROVE" ? "경보 조치를 종료 승인했습니다." : action === "SUBMIT" ? "관리자 종료 검토를 요청했습니다." : "경보 조치 내용을 반영했습니다."); await onReload(); }
    } catch { setMessage("경보 조치 요청을 완료하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const formElement = event.currentTarget;
    const fileInput = formElement.elements.namedItem("evidence") as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) { setMessage("첨부할 근거자료를 선택해 주세요."); setBusy(false); return; }
    const form = new FormData();
    form.set("module", "finance"); form.set("entityType", "financeAlertCase"); form.set("entityId", alertCase.id);
    form.set("category", "경보 조치 근거"); form.set("file", file);
    try {
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const result = await response.json() as { error?: string };
      if (!response.ok) setMessage(result.error || "근거자료를 저장하지 못했습니다.");
      else { formElement.reset(); setMessage("근거자료를 안전하게 보관했습니다."); await onReload(); }
    } catch { setMessage("근거자료 업로드를 완료하지 못했습니다."); }
    finally { setBusy(false); }
  }

  const editable = alertCase.status === "OPEN" || alertCase.status === "IN_PROGRESS";
  return <article className="panel finance-alert-case-detail">
    <header>
      <div><p>{alertCase.priority} · {statusLabel[alertCase.status]}</p><h2>{alertCase.title}</h2><span>{alertCase.description}</span></div>
      <button type="button" onClick={() => onNavigate(alertCase.sourceDestination)}>원인 화면 열기 →</button>
    </header>
    {message && <div className="finance-alert-case-message" role="status">{message}</div>}
    <div className="finance-alert-case-meta"><span>발생원천 <b>{alertCase.taskSourceId || "시스템 규칙"}</b></span><span>정책 기한 <b>{alertCase.dueDate || "미설정"}</b></span><span>버전 <b>v{alertCase.version}</b></span></div>
    <form className="finance-alert-action-form" onSubmit={(event) => { event.preventDefault(); void mutate("SAVE"); }}>
      <div className="finance-alert-owner-row">
        <label>조치 담당자<select disabled={!editable || busy} value={draft.ownerEmployeeId} onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}><option value="">선택</option>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label>
        <label>조치 기한<input disabled={!editable || busy} type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} /></label>
      </div>
      <label>원인 분석<textarea disabled={!editable || busy} rows={4} value={draft.rootCause} onChange={(event) => setDraft({ ...draft, rootCause: event.target.value })} placeholder="경보가 발생한 직접 원인과 구조적 원인을 구분해 기록하세요." /></label>
      <label>재무 영향<textarea disabled={!editable || busy} rows={3} value={draft.impactAssessment} onChange={(event) => setDraft({ ...draft, impactAssessment: event.target.value })} placeholder="현금흐름·지급·환율·손익에 미치는 영향을 기록하세요." /></label>
      <label>조치 계획<textarea disabled={!editable || busy} rows={4} value={draft.actionPlan} onChange={(event) => setDraft({ ...draft, actionPlan: event.target.value })} placeholder="실행 항목, 책임자, 완료 기준을 구체적으로 기록하세요." /></label>
      {editable && <div className="finance-alert-form-actions"><button type="submit" disabled={busy}>임시 저장</button><button type="button" className="primary" disabled={busy} onClick={() => void mutate("SUBMIT")}>증빙 확인·종료 검토 요청</button></div>}
    </form>

    <section className="finance-alert-evidence">
      <div data-korean-heading><h3>조치 근거자료</h3><span>종료 검토 전 최소 1개가 필요합니다.</span></div>
      {editable && <form onSubmit={uploadEvidence}><input name="evidence" type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv" /><button type="submit" disabled={busy}>근거 첨부</button></form>}
      <div className="finance-alert-document-list">{alertCase.documents.map((document) => <a href={document.downloadUrl} key={document.id}><span>문</span><p><strong>{document.fileName}</strong><small>{document.category} · v{document.version} · {employeeName(document.uploadedBy)}</small></p><em>다운로드</em></a>)}{!alertCase.documents.length && <p className="finance-alert-empty">첨부된 근거자료가 없습니다.</p>}</div>
    </section>

    {alertCase.status === "REVIEW" && <section data-korean-heading className="finance-alert-review-box"><h3>종료 검토</h3><textarea rows={3} value={draft.resolutionSummary} onChange={(event) => setDraft({ ...draft, resolutionSummary: event.target.value })} placeholder="조치 결과와 잔여 위험을 확인해 기록하세요." /><input value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="보완 요청 시 사유" /><div><button type="button" disabled={busy} onClick={() => void mutate("REJECT", { comment: reviewComment })}>보완 요청</button><button type="button" className="primary" disabled={busy} onClick={() => void mutate("APPROVE")}>종료 승인</button></div></section>}
    {alertCase.status === "CLOSED" && <section className="finance-alert-closed"><div><p>종료 확인</p><strong>{alertCase.resolutionSummary}</strong><small>{employeeName(alertCase.reviewedBy)} · {alertCase.reviewedAt ? new Date(alertCase.reviewedAt).toLocaleString("ko-KR") : ""}</small></div><label><span>재개방 사유</span><input value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="새 사실 또는 후속 위험을 5자 이상 입력" /></label><button type="button" disabled={busy || reviewComment.trim().length < 5} onClick={() => void mutate("REOPEN", { comment: reviewComment })}>재개방</button></section>}

    <section data-korean-heading className="finance-alert-timeline"><h3>처리 이력</h3>{alertCase.events.map((event) => <div key={event.id}><span>{eventLabel[event.action] ?? event.action}</span><p><strong>{employeeName(event.actorEmployeeId)}</strong><small>{event.comment || "상태 변경"}</small></p><time>{new Date(event.createdAt).toLocaleString("ko-KR")}</time></div>)}{!alertCase.events.length && <p className="finance-alert-empty">아직 처리 이력이 없습니다.</p>}</section>
  </article>;
}

export default function FinanceAlertActionCenter({ onNavigate }: { onNavigate: (destination: string) => void }) {
  const [cases, setCases] = useState<AlertCase[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/finance/alert-actions", { cache: "no-store" });
      const result = await response.json() as AlertResponse;
      if (!response.ok) throw new Error(result.error || "재무 경보 조치현황을 불러오지 못했습니다.");
      setCases(result.cases); setSelectedId((current) => result.cases.some((item) => item.id === current) ? current : result.cases[0]?.id ?? ""); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "재무 경보 조치현황을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  // The first request intentionally initializes server-backed workflow state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  const selected = cases.find((item) => item.id === selectedId) ?? cases[0];
  const summary = useMemo(() => ({
    open: cases.filter((item) => item.status === "OPEN").length,
    progress: cases.filter((item) => item.status === "IN_PROGRESS").length,
    review: cases.filter((item) => item.status === "REVIEW").length,
    closed: cases.filter((item) => item.status === "CLOSED").length,
  }), [cases]);

  if (loading) return <section className="panel finance-alert-center-loading">재무 경보와 조치 원장을 연결하는 중입니다…</section>;
  return <div className="finance-alert-action-center">
    <section className="finance-alert-center-hero"><div data-korean-heading><h1>재무 경보 조치센터</h1><span>시스템 경보의 원인부터 실행·근거·종료 판단까지 하나의 감사 가능한 흐름으로 관리합니다.</span></div><div><article><span>조치 대기</span><strong>{summary.open}</strong></article><article><span>조치 중</span><strong>{summary.progress}</strong></article><article><span>검토 요청</span><strong>{summary.review}</strong></article><article><span>종료</span><strong>{summary.closed}</strong></article></div></section>
    {error && <div className="finance-alert-center-error">{error}</div>}
    <section className="finance-alert-center-grid">
      <aside className="panel finance-alert-case-list"><header data-korean-heading><h2>경보 사례</h2><span>{cases.length}건</span></header>{cases.map((item) => <button type="button" className={selected?.id === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)} key={item.id}><em className={item.priority.toLowerCase()}>{item.priority}</em><p><strong>{item.title}</strong><small>{employeeName(item.ownerEmployeeId)} · {item.dueDate || "기한 미정"}</small></p><span>{statusLabel[item.status]}</span></button>)}{!cases.length && <p className="finance-alert-empty">현재 생성된 재무 시스템 경보가 없습니다.</p>}</aside>
      {selected ? <AlertCaseEditor key={`${selected.id}-${selected.version}`} alertCase={selected} onReload={load} onNavigate={onNavigate} /> : <article className="panel finance-alert-case-placeholder"><span>✓</span><strong>조치할 경보가 없습니다.</strong><p>새 재무 시스템 경보가 발생하면 원인과 조치계획을 이곳에서 관리합니다.</p></article>}
    </section>
  </div>;
}
