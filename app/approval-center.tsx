"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type ApprovalModule = "finance" | "hr" | "recruitment" | "sales" | "settings";
type ApprovalRequest = {
  id: string; module: ApprovalModule; requestType: string; typeLabel: string; title: string; description: string;
  requesterEmployeeId: string; targetEntityType: string; targetEntityId: string; amount: number; currency: string;
  priority: string; status: string; currentStep: number; dueDate: string; metadata: Record<string, unknown>;
  version: number; submittedAt: number; decidedAt: number | null; createdAt: number; updatedAt: number;
};
type ApprovalStep = { id: string; requestId: string; stepOrder: number; stepName: string; approverRole: string; approverEmployeeId: string; delegatedFromEmployeeId: string; status: string; comment: string; actedBy: string; actedAt: number | null };
type ApprovalEvent = { id: string; requestId: string; stepOrder: number; action: string; actorEmployeeId: string; comment: string; createdAt: number };
type ApprovalData = {
  principal: { employeeId: string; employeeName: string; roles: string[] };
  summary: { pendingMine: number; requestedByMe: number; active: number; overdueMine: number };
  requests: ApprovalRequest[]; steps: ApprovalStep[]; events: ApprovalEvent[];
  types: Record<ApprovalModule, Record<string, string>>;
};

const fallbackTypes: ApprovalData["types"] = {
  finance: { EXPENSE: "지출 승인", BUDGET: "예산 승인", CLOSE: "월마감 승인", REPORT: "경영보고 승인", PAYMENT: "지급 승인", PURCHASE_ORDER: "발주 승인", MASTER_DATA: "재무 마스터 승인" },
  hr: { LEAVE_REQUEST: "휴가 승인", PERSONNEL_ACTION: "인사발령 승인", PAYROLL_RUN: "급여 승인", RETIREMENT: "퇴직 승인", WORKFORCE_PLAN: "인력계획 승인", PERFORMANCE_CYCLE: "성과평가 최종확정" },
  recruitment: { REQUISITION: "채용요청 승인", OFFER: "채용 제안 승인", DIRECT_INTERVIEW: "면접 직접등록 승인" },
  sales: { QUOTE: "견적 승인", ORDER: "수주 승인", DELIVERY: "납품 승인", INVOICE: "청구 승인", PAYMENT: "수금 승인", INCENTIVE_RULE: "인센티브 규정 승인", TARGET_PLAN: "영업 목표 승인", SPECIAL_INCENTIVE: "특별 인센티브 승인", DISCOUNT: "가격·할인 예외 승인", CONTRACT: "계약 활성화 승인", CONTRACT_CHANGE: "계약 변경 승인", SERVICE_POLICY: "고객지원 SLA 승인", SERVICE_RESOLUTION: "고객 이슈 처리 승인" },
  settings: { MASTER_IMPACT_REPORT: "기준정보 위험 주간보고 승인" },
};
const moduleLabels: Record<ApprovalModule, string> = { finance: "재무회계", hr: "HR", recruitment: "채용", sales: "영업", settings: "데이터 통제" };
const statusLabels: Record<string, string> = { SUBMITTED: "결재 대기", IN_REVIEW: "결재 진행", CHANGES_REQUESTED: "보완 요청", APPROVED: "승인 완료", REJECTED: "반려", CANCELLED: "취소" };
const stepLabels: Record<string, string> = { WAITING: "대기", PENDING: "처리 대기", APPROVED: "승인", REJECTED: "반려", CHANGES_REQUESTED: "보완 요청", SKIPPED: "종료" };

const won = (value: number) => new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);
const dateTime = (value: number | null) => value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(value) : "-";
const employeeLabel = (employeeId: string) => companyEmployees.find((item) => item.id === employeeId)?.name ?? employeeId;
const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

export default function ApprovalCenter({ openRequestKey = 0 }: { openRequestKey?: number }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [data, setData] = useState<ApprovalData | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<"pending" | "mine" | "all">("pending");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [draft, setDraft] = useState({ module: "finance" as ApprovalModule, requestType: "EXPENSE", title: "", description: "", amount: "", dueDate: "", priority: "NORMAL" });

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/approvals", { cache: "no-store" });
      const payload = await response.json() as ApprovalData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "전자결재를 불러오지 못했습니다.");
      setData(payload);
      setSelectedId((current) => current && payload.requests.some((item) => item.id === current) ? current : payload.requests[0]?.id ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "전자결재를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }

  // The first request provides the pending-count badge before the drawer is opened.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (openRequestKey > 0) { setOpen(true); void load(); } }, [openRequestKey]);

  const requests = useMemo(() => {
    if (!data) return [];
    if (filter === "mine") return data.requests.filter((item) => item.requesterEmployeeId === data.principal.employeeId);
    if (filter === "pending") return data.requests.filter((item) => data.steps.some((step) => step.requestId === item.id && step.approverEmployeeId === data.principal.employeeId && step.status === "PENDING"));
    return data.requests;
  }, [data, filter]);
  const selected = data?.requests.find((item) => item.id === selectedId) ?? requests[0];
  const selectedSteps = data?.steps.filter((item) => item.requestId === selected?.id) ?? [];
  const selectedEvents = data?.events.filter((item) => item.requestId === selected?.id) ?? [];
  const currentStep = selectedSteps.find((item) => item.stepOrder === selected?.currentStep);
  const canAct = Boolean(selected && currentStep?.status === "PENDING" && data
    && (currentStep.approverEmployeeId === data.principal.employeeId || data.principal.roles.includes("SUPER_ADMIN")));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const response = await fetch("/api/approvals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, amount: Number(draft.amount || 0) }) });
    const payload = await response.json() as { request?: { id: string }; error?: string };
    if (!response.ok || !payload.request) { setError(payload.error || "결재를 제출하지 못했습니다."); return; }
    setCreating(false); setDraft({ module: "finance", requestType: "EXPENSE", title: "", description: "", amount: "", dueDate: "", priority: "NORMAL" });
    await load(); setSelectedId(payload.request.id);
  }

  async function act(action: "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "RESUBMIT" | "CANCEL") {
    if (!selected) return;
    setError("");
    const response = await fetch("/api/approvals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selected.id, version: selected.version, action, comment }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error || "결재를 처리하지 못했습니다."); return; }
    setComment(""); await load();
  }

  const typeMap = data?.types ?? fallbackTypes;
  return <>
    <button type="button" className="erp-approval-button" onClick={() => { setOpen(true); void load(); }} aria-label={`전자결재, 내가 처리할 문서 ${data?.summary.pendingMine ?? 0}건`}>
      <span aria-hidden="true">✓</span><span>전자결재</span><em>{data?.summary.pendingMine ?? 0}</em>
    </button>
    {open && <>
      <button type="button" className="approval-backdrop" aria-label="전자결재 닫기" onClick={() => setOpen(false)} />
      <section className="approval-center" role="dialog" aria-modal="true" aria-label="전자결재 센터">
        <header className="approval-center-header"><div data-korean-heading><h2>전자결재 센터</h2><span>기안·검토·승인·반려와 모든 의견을 한 이력으로 관리합니다.</span></div><div><button type="button" className="approval-create-button" onClick={() => setCreating((value) => !value)}>＋ 새 기안</button><button type="button" className="approval-close-button" aria-label="닫기" onClick={() => setOpen(false)}>×</button></div></header>
        {error && <div className="approval-error">{error}</div>}
        {creating && <form className="approval-create-form" onSubmit={create}>
          <label><span>업무 영역</span><select value={draft.module} onChange={(event) => { const selectedModule = event.target.value as ApprovalModule; setDraft({ ...draft, module: selectedModule, requestType: Object.keys(typeMap[selectedModule])[0] }); }}>{Object.entries(moduleLabels).filter(([value]) => value !== "settings").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>결재 유형</span><select value={draft.requestType} onChange={(event) => setDraft({ ...draft, requestType: event.target.value })}>{Object.entries(typeMap[draft.module]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide"><span>제목</span><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="결재 목적을 명확히 입력하세요" /></label>
          <label><span>금액</span><input type="number" min="0" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} placeholder="해당 시 입력" /></label>
          <label><span>처리기한</span><input type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} /></label>
          <label><span>우선순위</span><select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}><option value="LOW">낮음</option><option value="NORMAL">보통</option><option value="HIGH">높음</option><option value="CRITICAL">긴급</option></select></label>
          <label className="wide"><span>기안 내용</span><textarea required rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="배경, 요청사항, 판단 근거를 입력하세요" /></label>
          <div className="approval-form-actions"><button type="button" onClick={() => setCreating(false)}>취소</button><button type="submit">결재선 생성 후 제출</button></div>
        </form>}
        <div className="approval-summary"><article><span>내 결재 대기</span><strong>{data?.summary.pendingMine ?? 0}</strong></article><article className={(data?.summary.overdueMine ?? 0) > 0 ? "overdue" : ""}><span>기한 경과</span><strong>{data?.summary.overdueMine ?? 0}</strong></article><article><span>내가 기안한 진행 건</span><strong>{data?.summary.requestedByMe ?? 0}</strong></article><article><span>전체 진행 건</span><strong>{data?.summary.active ?? 0}</strong></article></div>
        <div className="approval-tabs"><button type="button" className={filter === "pending" ? "active" : ""} onClick={() => setFilter("pending")}>내 결재</button><button type="button" className={filter === "mine" ? "active" : ""} onClick={() => setFilter("mine")}>내 기안</button><button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>전체 이력</button></div>
        <div className="approval-layout">
          <aside className="approval-request-list">{loading && <div className="approval-empty">불러오는 중입니다.</div>}{!loading && requests.map((item) => { const overdue = Boolean(item.dueDate && item.dueDate < today() && ["SUBMITTED", "IN_REVIEW"].includes(item.status)); return <button type="button" key={item.id} className={`${selected?.id === item.id ? "active" : ""} ${overdue ? "overdue" : ""}`} onClick={() => setSelectedId(item.id)}><span><em>{moduleLabels[item.module]} · {item.typeLabel}</em><time>{overdue ? `기한 경과 · ${item.dueDate}` : item.dueDate || "기한 없음"}</time></span><strong>{item.title}</strong><small>{employeeLabel(item.requesterEmployeeId)} · {statusLabels[item.status] ?? item.status}</small></button>; })}{!loading && !requests.length && <div className="approval-empty">이 조건의 결재 문서가 없습니다.</div>}</aside>
          <main className="approval-detail">{selected ? <>
            <div className="approval-detail-heading"><div><p>{moduleLabels[selected.module]} · {selected.typeLabel}</p><h3>{selected.title}</h3><span>기안자 {employeeLabel(selected.requesterEmployeeId)} · 제출 {dateTime(selected.submittedAt)}</span></div><em className={`approval-status ${selected.status.toLowerCase()}`}>{statusLabels[selected.status] ?? selected.status}</em></div>
            <div className="approval-facts"><div><span>결재 금액</span><strong>{selected.amount ? won(selected.amount) : "해당 없음"}</strong></div><div><span>우선순위</span><strong>{selected.priority}</strong></div><div><span>처리기한</span><strong>{selected.dueDate || "미지정"}</strong></div><div><span>문서 버전</span><strong>v{selected.version}</strong></div></div>
            <article className="approval-description"><span>기안 내용</span><p>{selected.description || "입력된 상세 내용이 없습니다."}</p></article>
            <section className="approval-route"><h4>결재선</h4>{selectedSteps.map((step) => <div key={step.id} className={step.status.toLowerCase()}><b>{step.stepOrder}</b><p><strong>{step.stepName}</strong><small>{employeeLabel(step.approverEmployeeId)} · {step.approverRole}{step.delegatedFromEmployeeId ? ` · ${employeeLabel(step.delegatedFromEmployeeId)} 대결` : ""}</small>{step.comment && <span>{step.comment}</span>}</p><em>{stepLabels[step.status] ?? step.status}</em></div>)}</section>
            <section className="approval-history"><h4>처리 이력</h4>{selectedEvents.map((event) => <div key={event.id}><time>{dateTime(event.createdAt)}</time><p><strong>{event.action}</strong><small>{employeeLabel(event.actorEmployeeId)}{event.comment ? ` · ${event.comment}` : ""}</small></p></div>)}</section>
            {canAct && <section className="approval-decision"><textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="승인 의견 또는 반려·보완 사유를 입력하세요" /><div><button type="button" onClick={() => void act("REQUEST_CHANGES")}>보완 요청</button><button type="button" className="reject" onClick={() => void act("REJECT")}>반려</button><button type="button" className="approve" onClick={() => void act("APPROVE")}>승인</button></div></section>}
            {!canAct && selected.status === "CHANGES_REQUESTED" && selected.requesterEmployeeId === data?.principal.employeeId && <section className="approval-decision"><textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="보완한 내용을 기록하세요" /><div><button type="button" className="approve" onClick={() => void act("RESUBMIT")}>보완 후 재제출</button></div></section>}
            {!canAct && selected.requesterEmployeeId === data?.principal.employeeId && ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED"].includes(selected.status) && <button type="button" className="approval-cancel" onClick={() => void act("CANCEL")}>기안 취소</button>}
          </> : <div className="approval-empty detail">확인할 결재 문서를 선택하세요.</div>}</main>
        </div>
      </section>
    </>}
  </>;
}
