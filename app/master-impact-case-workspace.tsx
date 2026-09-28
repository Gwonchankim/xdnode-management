"use client";

import { useEffect, useMemo, useState } from "react";

type CaseEvent = { id: string; action: string; actorEmployeeId: string; fromStatus: string; toStatus: string; note: string; createdAt: number };
type ImpactCase = {
  id: string; entityType: string; entityId: string; entityLabel: string; action: string; impactCode: string;
  impactLabel: string; impactDetail: string; initialCount: number; currentCount: number; initialAmount: number;
  currentAmount: number; status: string; ownerEmployeeId: string; ownerName: string; dueDate: string;
  ownerDepartment: string; managerName: string; escalationLevel: number; escalatedAt: number | null; overdueDays: number;
  resolutionNote: string; evidenceRef: string; lastRecheckedBy: string; lastRecheckedAt: number | null;
  version: number; createdAt: number; updatedAt: number; isOverdue: boolean; events: CaseEvent[];
};
type WeeklyReview = { id: string; reportId: string; managerName: string; managerEmployeeId: string; outcome: string; note: string;
  reviewedBy: string; reviewedAt: number | null; followUpOwnerEmployeeId: string; followUpDueDate: string;
  followUpTaskId: string; followUpTaskStatus: string; version: number; createdAt: number; updatedAt: number };
type WeeklyReport = { id: string; weekStart: string; weekEnd: string; version: number; activeCount: number; overdueCount: number;
  managerEscalatedCount: number; executiveEscalatedCount: number; checksum: string; status: string; approvalRequestId: string;
  approvalStatus: string; workflowVersion: number; submittedBy: string; submittedAt: number | null; approvedBy: string;
  approvedAt: number | null; createdBy: string; createdAt: number; reviews: WeeklyReview[] };
type QueueData = {
  summary: { active: number; open: number; inProgress: number; verified: number; overdue: number; managerEscalated: number; executiveEscalated: number };
  cases: ImpactCase[]; employees: Array<{ id: string; name: string; department: string }>;
  managerSummary: Array<{ managerName: string; active: number; overdue: number; managerEscalated: number; executiveEscalated: number }>;
  policy: { defaultDueDays: number; managerEscalationDays: number; executiveEscalationDays: number; version: number; updatedBy: string; updatedAt: number };
  weeklyReports: WeeklyReport[];
  controls: { automaticResolution: boolean; automaticReassignment: boolean; automaticApproval: boolean; retrospectiveDueDateChange: boolean; companyEmployeesOnly: boolean; recheckRequired: boolean; evidenceRequired: boolean; managerResponseRecorderVisible: boolean };
};

const statusLabels: Record<string, string> = { ALL: "전체", OPEN: "대기", IN_PROGRESS: "진행 중", VERIFIED: "재검증 통과", CLOSED: "종결" };
const actionLabels: Record<string, string> = { UPDATE: "수정", DEACTIVATE: "비활성화", ACTIVATE: "재활성화", MERGE: "병합" };
const entityLabels: Record<string, string> = { FINANCE_ACCOUNT: "계정과목", FINANCE_PARTNER: "재무 거래처", FINANCE_BANK: "은행계좌", FINANCE_TAX: "세금코드", SALES_ACCOUNT: "영업 거래처", HR_ORGANIZATION: "HR 조직" };
const eventLabels: Record<string, string> = { CASE_CREATED: "업무 생성", SOURCE_REFRESHED: "원천 갱신", SLA_ESCALATED: "SLA 단계 상향", ASSIGN: "담당·기한 변경", START: "진행 시작", RECHECK: "원장 재검증", CLOSE: "종결" };
const reportStatusLabels: Record<string, string> = { DRAFT: "조직장 확인 중", SUBMITTED: "전자결재 중", APPROVED: "승인 완료", REJECTED: "반려" };
const reviewStatusLabels: Record<string, string> = { PENDING: "확인 대기", ACTION_REQUIRED: "보완조치 필요", ACKNOWLEDGED: "확인 완료" };
const won = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const formatTime = (value: number | null) => value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "미실행";
const dateAfter = (days: number) => new Date(Date.now() + (days * 24 + 9) * 60 * 60 * 1000).toISOString().slice(0, 10);

async function requestQueue(status: string, query: string) {
  const params = new URLSearchParams({ status }); if (query) params.set("q", query);
  const response = await fetch(`/api/master-impact-cases?${params}`, { cache: "no-store" });
  const payload = await response.json() as QueueData & { error?: string };
  if (!response.ok) throw new Error(payload.error || "영향 해결 큐를 불러오지 못했습니다.");
  return payload;
}

export default function MasterImpactCaseWorkspace() {
  const [data, setData] = useState<QueueData | null>(null);
  const [status, setStatus] = useState("ALL"); const [query, setQuery] = useState(""); const [searchDraft, setSearchDraft] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { ownerEmployeeId: string; dueDate: string }>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { ownerEmployeeId: string; dueDate: string }>>({});
  const [policyDraft, setPolicyDraft] = useState({ defaultDueDays: 3, managerEscalationDays: 1, executiveEscalationDays: 3 });

  function applyData(payload: QueueData) {
    setData(payload); setDrafts(Object.fromEntries(payload.cases.map((item) => [item.id, { ownerEmployeeId: item.ownerEmployeeId, dueDate: item.dueDate }])));
    setReviewDrafts(Object.fromEntries(payload.weeklyReports.flatMap((report) => report.reviews.map((review) => [review.id, {
      ownerEmployeeId: review.followUpOwnerEmployeeId || review.managerEmployeeId || payload.employees[0]?.id || "",
      dueDate: review.followUpDueDate || dateAfter(3),
    }]))));
    setPolicyDraft({ defaultDueDays: payload.policy.defaultDueDays, managerEscalationDays: payload.policy.managerEscalationDays, executiveEscalationDays: payload.policy.executiveEscalationDays });
  }

  useEffect(() => {
    let cancelled = false;
    requestQueue(status, query).then((payload) => { if (!cancelled) { applyData(payload); setMessage(""); } })
      .catch((error: Error) => { if (!cancelled) setMessage(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, status]);

  async function mutate(action: string, item: ImpactCase, extra: Record<string, unknown> = {}) {
    setBusy(`${action}:${item.id}`); setMessage("");
    try {
      const response = await fetch("/api/master-impact-cases", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: item.id, expectedVersion: item.version, statusFilter: status, query, ...extra }) });
      const payload = await response.json() as QueueData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "영향 해결 업무를 처리하지 못했습니다.");
      applyData(payload);
      setMessage(action === "RECHECK" ? "최신 원장으로 재검증했습니다." : action === "CLOSE" ? "증빙과 해결 메모를 남기고 업무를 종결했습니다." : "업무 상태를 저장했습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "영향 해결 업무를 처리하지 못했습니다."); }
    finally { setBusy(""); }
  }

  async function mutateGlobal(action: "UPDATE_SLA_POLICY" | "CREATE_WEEKLY_REPORT" | "ACK_MANAGER_REVIEW" | "REQUEST_MANAGER_ACTION" | "VERIFY_MANAGER_ACTION" | "SUBMIT_WEEKLY_REPORT", extra: Record<string, unknown> = {}) {
    setBusy(action); setMessage("");
    try {
      const response = await fetch("/api/master-impact-cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, statusFilter: status, query, ...extra }) });
      const payload = await response.json() as QueueData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "SLA 운영 정보를 저장하지 못했습니다.");
      applyData(payload); setMessage(action === "UPDATE_SLA_POLICY" ? "새 차단 업무에 적용할 SLA 정책을 저장했습니다. 기존 기한은 변경하지 않았습니다."
        : action === "CREATE_WEEKLY_REPORT" ? "현재 해결 큐를 불변 주간 보고로 저장했습니다."
        : action === "SUBMIT_WEEKLY_REPORT" ? "모든 조직장 확인을 마치고 경영 책임자 전자결재를 제출했습니다."
        : action === "REQUEST_MANAGER_ACTION" ? "보완조치 업무와 기한을 알림센터에 등록했습니다." : "조직장 확인 결과를 감사기록과 함께 저장했습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "SLA 운영 정보를 저장하지 못했습니다."); }
    finally { setBusy(""); }
  }

  function recordReview(action: "ACK_MANAGER_REVIEW" | "REQUEST_MANAGER_ACTION" | "VERIFY_MANAGER_ACTION", review: WeeklyReview) {
    const minimum = action === "REQUEST_MANAGER_ACTION" ? 10 : 5;
    const note = window.prompt(action === "REQUEST_MANAGER_ACTION" ? "필요한 보완조치와 판단 근거를 10자 이상 입력해 주세요." : "수신한 확인 내용과 근거를 5자 이상 입력해 주세요.", review.note || "");
    if (!note || note.trim().length < minimum) { setMessage(`${minimum}자 이상의 확인 근거가 필요합니다.`); return; }
    const draft = reviewDrafts[review.id];
    void mutateGlobal(action, { reviewId: review.id, expectedReviewVersion: review.version, note: note.trim(),
      ...(action === "REQUEST_MANAGER_ACTION" ? { ownerEmployeeId: draft?.ownerEmployeeId, dueDate: draft?.dueDate } : {}) });
  }

  function closeCase(item: ImpactCase) {
    const resolutionNote = window.prompt("해결 방법과 확인 결과를 10자 이상 입력해 주세요.", item.resolutionNote || "연결 원장 정리 후 재검증 완료");
    if (!resolutionNote) return;
    const evidenceRef = window.prompt("증빙 문서 번호·업무 링크·전표 번호 중 하나를 입력해 주세요.", item.evidenceRef || "");
    if (!evidenceRef) return;
    void mutate("CLOSE", item, { resolutionNote, evidenceRef });
  }

  const overdueIds = useMemo(() => new Set((data?.cases ?? []).filter((item) => item.isOverdue).map((item) => item.id)), [data]);

  return <div className="master-impact-case-body">
    <section className="master-impact-case-boundary"><div data-korean-heading><h3>기준정보 영향 해결 큐</h3><span>차단 항목을 담당자·기한·SLA·원장 재검증·증빙까지 연결해 종결합니다.</span></div><ul><li>자동 해결 없음</li><li>자동 재배정 없음</li><li>회사 직원만 배정</li><li>재검증 필수</li><li>증빙 필수</li></ul></section>
    {message && <div className="master-impact-case-message" role="status">{message}</div>}
    {loading && <div className="master-impact-case-loading">차단 영향과 담당 업무를 불러오는 중입니다.</div>}
    {data && <>
      <section className="master-impact-case-summary">
        <article><span>활성 업무</span><strong>{data.summary.active}<small>건</small></strong></article>
        <article><span>대기 / 진행</span><strong>{data.summary.open} / {data.summary.inProgress}<small>건</small></strong></article>
        <article className="verified"><span>재검증 통과</span><strong>{data.summary.verified}<small>건</small></strong></article>
        <article className={data.summary.overdue ? "overdue" : ""}><span>기한 경과</span><strong>{data.summary.overdue}<small>건</small></strong></article>
        <article className={data.summary.managerEscalated ? "overdue" : ""}><span>조직장 확인</span><strong>{data.summary.managerEscalated}<small>건</small></strong></article>
        <article className={data.summary.executiveEscalated ? "executive" : ""}><span>경영 책임자 확인</span><strong>{data.summary.executiveEscalated}<small>건</small></strong></article>
      </section>
      <section className="master-impact-sla-panel">
        <form onSubmit={(event) => { event.preventDefault(); void mutateGlobal("UPDATE_SLA_POLICY", { ...policyDraft, expectedPolicyVersion: data.policy.version }); }}>
          <div><em>SLA POLICY v{data.policy.version}</em><strong>차단 업무 처리 기준</strong><small>정책 변경은 새 업무에만 적용되며 기존 기한과 담당자를 덮어쓰지 않습니다.</small></div>
          <label>기본 처리기한<input type="number" min="1" max="30" value={policyDraft.defaultDueDays} onChange={(event) => setPolicyDraft((current) => ({ ...current, defaultDueDays: Number(event.target.value) }))} /><span>일</span></label>
          <label>조직장 확인<input type="number" min="1" max="14" value={policyDraft.managerEscalationDays} onChange={(event) => setPolicyDraft((current) => ({ ...current, managerEscalationDays: Number(event.target.value) }))} /><span>일 경과</span></label>
          <label>경영 책임자 확인<input type="number" min="2" max="30" value={policyDraft.executiveEscalationDays} onChange={(event) => setPolicyDraft((current) => ({ ...current, executiveEscalationDays: Number(event.target.value) }))} /><span>일 경과</span></label>
          <button type="submit" disabled={Boolean(busy)}>정책 저장</button>
        </form>
        <div className="master-impact-manager-summary"><header><div><strong>관리자별 현재 위험</strong><small>담당자의 인사기록에 등록된 조직장을 기준으로 집계합니다.</small></div><button type="button" disabled={Boolean(busy)} onClick={() => void mutateGlobal("CREATE_WEEKLY_REPORT")}>현재 상태 주간 보고 저장</button></header><div>{data.managerSummary.map((item) => <article key={item.managerName}><strong>{item.managerName}</strong><span>활성 {item.active} · 기한 경과 {item.overdue}</span><small>조직장 확인 {item.managerEscalated} · 경영 책임자 확인 {item.executiveEscalated}</small></article>)}{!data.managerSummary.length && <p>현재 활성 차단 업무가 없습니다.</p>}</div></div>
        <div className="master-impact-weekly-reports"><header><strong>주간 위험 보고·승인</strong><small>스냅샷은 불변으로 보존하고 조직장 응답·보완조치·경영 책임자 결재를 별도 이력으로 남깁니다.</small></header><div>{data.weeklyReports.map((report) => {
          const allAcknowledged = report.reviews.every((review) => review.outcome === "ACKNOWLEDGED");
          return <article className={`weekly-report-${report.status.toLowerCase()}`} key={report.id}>
            <div className="master-impact-report-head"><div><strong>{report.weekStart}~{report.weekEnd} · v{report.version}</strong><small>{formatTime(report.createdAt)} · 생성 {report.createdBy}</small></div><span>활성 {report.activeCount} · 경과 {report.overdueCount}</span><em>L1 {report.managerEscalatedCount} / L2 {report.executiveEscalatedCount}</em><code>{report.checksum.slice(0, 12)}</code><b>{reportStatusLabels[report.status] ?? report.status}{report.approvalStatus === "CHANGES_REQUESTED" ? " · 보완 요청" : ""}</b></div>
            <div className="master-impact-report-reviews">{report.reviews.map((review) => {
              const draft = reviewDrafts[review.id] ?? { ownerEmployeeId: review.managerEmployeeId || data.employees[0]?.id || "", dueDate: dateAfter(3) };
              return <div className={`review-${review.outcome.toLowerCase()}`} key={review.id}><div><strong>{review.managerName}</strong><small>조직장 {data.employees.find((employee) => employee.id === review.managerEmployeeId)?.name || "계정 미연결"} · 기록자 {data.employees.find((employee) => employee.id === review.reviewedBy)?.name || review.reviewedBy || "미기록"}</small>{review.note && <span>{review.note}</span>}</div><em>{reviewStatusLabels[review.outcome] ?? review.outcome}</em>
                {report.status === "DRAFT" && review.outcome === "PENDING" && <div className="master-impact-review-actions"><select value={draft.ownerEmployeeId} onChange={(event) => setReviewDrafts((current) => ({ ...current, [review.id]: { ...draft, ownerEmployeeId: event.target.value } }))}>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select><input type="date" value={draft.dueDate} onChange={(event) => setReviewDrafts((current) => ({ ...current, [review.id]: { ...draft, dueDate: event.target.value } }))} /><button type="button" disabled={Boolean(busy)} onClick={() => recordReview("ACK_MANAGER_REVIEW", review)}>확인 기록</button><button type="button" className="request" disabled={Boolean(busy) || !draft.ownerEmployeeId || !draft.dueDate} onClick={() => recordReview("REQUEST_MANAGER_ACTION", review)}>보완업무 생성</button></div>}
                {report.status === "DRAFT" && review.outcome === "ACTION_REQUIRED" && <div className="master-impact-review-actions follow-up"><span>후속업무 {review.followUpTaskStatus || "OPEN"} · {data.employees.find((employee) => employee.id === review.followUpOwnerEmployeeId)?.name || review.followUpOwnerEmployeeId} · {review.followUpDueDate}</span><button type="button" disabled={Boolean(busy) || review.followUpTaskStatus !== "DONE"} onClick={() => recordReview("VERIFY_MANAGER_ACTION", review)}>완료 결과 확인</button></div>}
              </div>;
            })}{!report.reviews.length && <p>확인할 조직장 위험 항목이 없습니다.</p>}</div>
            <footer><span>조직장 확인 {report.reviews.filter((review) => review.outcome === "ACKNOWLEDGED").length}/{report.reviews.length} · 자동 승인 없음 · 실제 기록자 표시</span>{report.status === "DRAFT" && <button type="button" disabled={Boolean(busy) || !allAcknowledged} onClick={() => void mutateGlobal("SUBMIT_WEEKLY_REPORT", { reportId: report.id, expectedWorkflowVersion: report.workflowVersion })}>경영 책임자 전자결재 제출</button>}{report.status !== "DRAFT" && <strong>{report.approvalStatus ? `전자결재 ${report.approvalStatus}` : reportStatusLabels[report.status]}</strong>}</footer>
          </article>;
        })}{!data.weeklyReports.length && <p>저장된 주간 보고가 없습니다.</p>}</div></div>
      </section>
      <form className="master-impact-case-filters" onSubmit={(event) => { event.preventDefault(); setQuery(searchDraft.trim()); }}>
        <nav aria-label="영향 업무 상태">{["ALL","OPEN","IN_PROGRESS","VERIFIED","CLOSED"].map((value) => <button type="button" key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{statusLabels[value]}</button>)}</nav>
        <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="대상·영향·담당자 검색" aria-label="영향 업무 검색" />
        <button type="submit">검색</button>
      </form>
      <section className="master-impact-case-ledger">
        <header><span>대상·영향</span><span>연결 원장</span><span>담당자·기한</span><span>상태·관리</span></header>
        {data.cases.map((item) => {
          const draft = drafts[item.id] ?? { ownerEmployeeId: item.ownerEmployeeId, dueDate: item.dueDate };
          const isBusy = busy.endsWith(`:${item.id}`); const isExpanded = expanded === item.id;
          return <article className={`${item.status.toLowerCase()} ${overdueIds.has(item.id) ? "overdue" : ""}`} key={item.id}>
            <div className="master-impact-case-title"><em>{entityLabels[item.entityType] ?? item.entityType} · {actionLabels[item.action] ?? item.action}</em><strong>{item.entityLabel}</strong><span>{item.impactLabel}</span><small>{item.impactDetail}</small>{item.escalationLevel > 0 && <b className={`sla-level-${item.escalationLevel}`}>{item.escalationLevel === 2 ? "L2 경영 책임자 확인" : "L1 조직장 확인"} · {item.overdueDays}일 경과</b>}</div>
            <div className="master-impact-case-count"><span>최초 <strong>{item.initialCount}건</strong>{item.initialAmount > 0 && <small>{won(item.initialAmount)}</small>}</span><b>→</b><span>현재 <strong>{item.currentCount}건</strong>{item.currentAmount > 0 && <small>{won(item.currentAmount)}</small>}</span><small>최근 재검증 {formatTime(item.lastRecheckedAt)}</small></div>
            <div className="master-impact-case-assignment"><small>{item.ownerDepartment || "소속 미지정"} · 조직장 {item.managerName || "미지정"}</small><select disabled={item.status === "CLOSED" || isBusy} value={draft.ownerEmployeeId} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, ownerEmployeeId: event.target.value } }))}>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department || "소속 미지정"}</option>)}</select><input disabled={item.status === "CLOSED" || isBusy} type="date" value={draft.dueDate} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, dueDate: event.target.value } }))} /><button type="button" disabled={item.status === "CLOSED" || isBusy || (draft.ownerEmployeeId === item.ownerEmployeeId && draft.dueDate === item.dueDate)} onClick={() => void mutate("ASSIGN", item, draft)}>배정 저장</button></div>
            <div className="master-impact-case-actions"><em>{overdueIds.has(item.id) ? "기한 경과" : statusLabels[item.status] ?? item.status}</em>{item.status === "OPEN" && <button disabled={isBusy} type="button" onClick={() => void mutate("START", item)}>진행 시작</button>}{item.status !== "CLOSED" && <button disabled={isBusy} type="button" onClick={() => void mutate("RECHECK", item)}>원장 재검증</button>}{item.status === "VERIFIED" && <button className="close" disabled={isBusy} type="button" onClick={() => closeCase(item)}>증빙 남기고 종결</button>}<button type="button" onClick={() => setExpanded(isExpanded ? "" : item.id)}>{isExpanded ? "이력 닫기" : "처리 이력"}</button></div>
            {isExpanded && <div className="master-impact-case-events">{item.events.map((event) => <div key={event.id}><time>{formatTime(event.createdAt)}</time><p><strong>{eventLabels[event.action] ?? event.action}</strong><span>{event.note}</span><small>{event.actorEmployeeId} · {statusLabels[event.fromStatus] ?? (event.fromStatus || "생성")} → {statusLabels[event.toStatus] ?? event.toStatus}</small></p></div>)}{!item.events.length && <p>처리 이력이 없습니다.</p>}{item.status === "CLOSED" && <aside><strong>해결 메모</strong><span>{item.resolutionNote}</span><small>증빙 {item.evidenceRef}</small></aside>}</div>}
          </article>;
        })}
        {!data.cases.length && <div className="master-impact-case-empty">현재 조건에 해당하는 영향 해결 업무가 없습니다.</div>}
      </section>
    </>}
  </div>;
}
