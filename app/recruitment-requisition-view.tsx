"use client";

import { FormEvent, useEffect, useState } from "react";
import { useErpDialog } from "./erp-dialog";

type Plan = { id: string; period: string; version: number; title: string };
type GapLine = {
  id: string; planId: string; organizationId: string; organizationName: string;
  approvedHeadcount: number; currentHeadcount: number; incomingHeadcount: number; plannedExits: number;
  hiringGap: number; reservedHeadcount: number; availableHeadcount: number; note: string;
};
type Requisition = {
  id: string; organizationName: string; title: string; role: string; requestedHeadcount: number;
  applicantCount: number; filledHeadcount: number; remainingHeadcount: number; ownerName: string;
  targetStartDate: string; reason: string; status: string; closeReason: string;
};
type Recruiter = { id: string; name: string; department: string };
type Organization = { id: string; name: string };
type Payload = {
  plan: Plan | null; lines: GapLine[]; requisitions: Requisition[];
  summary: { planGap: number; reserved: number; available: number; filled: number };
  recruiters: Recruiter[]; organizations: Organization[]; error?: string;
};

const labels: Record<string, string> = {
  DRAFT: "작성 중", SUBMITTED: "결재 중", OPEN: "모집 중", REJECTED: "반려",
  FILLED: "충원 완료", CLOSED: "조기 마감", CANCELLED: "취소",
};

const emptyDraft = { organizationId: "", role: "", requestedHeadcount: 1, targetStartDate: "", ownerEmployeeId: "", reason: "" };

export default function RecruitmentRequisitionView({ onNotify }: { onNotify: (message: string) => void }) {
  const dialog = useErpDialog();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);

  async function load() {
    const response = await fetch("/api/hr/recruitment-requisitions");
    const payload = await response.json() as Payload;
    if (!response.ok) throw new Error(payload.error || "채용요청을 불러오지 못했습니다.");
    setData(payload);
    return payload;
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hr/recruitment-requisitions")
      .then(async (response) => {
        const payload = await response.json() as Payload;
        if (!response.ok) throw new Error(payload.error || "채용요청을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((error: Error) => { if (!cancelled) onNotify(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onNotify]);

  function openForm() {
    setDraft({ ...emptyDraft, organizationId: data?.organizations[0]?.id ?? "" });
    setFormOpen(true);
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/hr/recruitment-requisitions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CREATE_DRAFT", ...draft }),
      });
      const payload = await response.json() as { error?: string; autoApproved?: boolean; submitError?: string };
      if (!response.ok) throw new Error(payload.error || "채용요청을 저장하지 못했습니다.");
      onNotify(payload.autoApproved ? "채용요청을 등록하고 승인까지 마쳤습니다. 바로 모집 중입니다."
        : payload.submitError ? `채용요청을 등록했지만 자동 승인에 실패했습니다: ${payload.submitError}`
        : "채용요청을 등록했습니다. 내용을 확인한 뒤 결재를 제출해 주세요.");
      setFormOpen(false);
      setDraft(emptyDraft);
      await load();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "채용요청을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  const reasonPrompts: Record<string, string> = {
    CLOSE: "조기 마감 사유를 5자 이상 입력해 주세요.",
    CANCEL: "등록 취소 사유를 5자 이상 입력해 주세요.",
    DELETE: "삭제 사유를 5자 이상 입력해 주세요.",
  };
  const reasonTitles: Record<"CLOSE" | "CANCEL" | "DELETE", string> = { CLOSE: "채용 마감 사유", CANCEL: "등록 취소 사유", DELETE: "삭제 사유" };

  async function action(id: string, name: "SUBMIT" | "CLOSE" | "CANCEL" | "DELETE", title = "") {
    // Deletion removes the row outright rather than moving it to a closed state, so it gets its own
    // confirmation before the reason prompt that the other actions share.
    if (name === "DELETE" && !(await dialog.confirm(`'${title}' 채용요청을 원장에서 삭제합니다.
되돌릴 수 없으며, 진행 중인 결재가 있으면 함께 취소됩니다.`, { title: "채용요청 삭제", confirmLabel: "삭제", danger: true }))) return;
    const reason = name === "SUBMIT" ? "" : (await dialog.prompt(reasonPrompts[name], { title: reasonTitles[name], minLength: 5, multiline: true })) ?? "";
    if (name !== "SUBMIT" && reason.length < 5) return;
    const response = await fetch("/api/hr/recruitment-requisitions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: name, id, reason }),
    });
    const payload = await response.json() as { error?: string; autoApproved?: boolean; cancelledApproval?: boolean };
    if (!response.ok) { onNotify(payload.error || "채용요청 상태를 변경하지 못했습니다."); return; }
    onNotify(name === "SUBMIT" ? (payload.autoApproved ? "요청자와 승인자가 같아 자동 승인되었습니다. 바로 모집 중입니다." : "채용요청 결재를 제출했습니다.")
      : name === "CLOSE" ? "채용요청을 사유와 함께 마감했습니다."
      : name === "DELETE" ? (payload.cancelledApproval ? "채용요청을 삭제하고 진행 중이던 결재도 취소했습니다." : "채용요청을 삭제했습니다.")
      : "채용요청을 취소했습니다.");
    try { await load(); } catch (error) { onNotify(error instanceof Error ? error.message : "목록을 새로고침하지 못했습니다."); }
  }

  const summary = data?.summary ?? { planGap: 0, reserved: 0, available: 0, filled: 0 };
  const organizations = data?.organizations ?? [];
  const selectedTeam = organizations.find((item) => item.id === draft.organizationId);
  const teamLine = data?.lines.find((line) => line.organizationId === draft.organizationId);

  return <div className="page-wrap module-page requisition-page">
    <section className="module-hero"><div data-korean-heading><h1>채용요청·TO 관리</h1><p>필요한 팀과 포지션을 직접 등록하고, 지원자와 입사 확정까지 하나의 흐름으로 관리합니다.</p></div><div className="requisition-hero-actions"><span className="requisition-plan-badge">{data?.plan ? `${data.plan.period} · v${data.plan.version} 승인본` : "승인 인력계획 없음"}</span><button type="button" className="primary-button" onClick={openForm} disabled={loading}>+ 채용요청 등록</button></div></section>
    <section className="metric-grid module-metrics">{[
      ["계획 충원 필요", `${summary.planGap}명`, "승인 인력계획 기준"], ["진행 중 요청", `${summary.reserved}명`, "작성·결재·모집 중"],
      ["계획 대비 여유", `${summary.available}명`, "인력계획이 있는 팀"], ["입사 확정", `${summary.filled}명`, "제안 수락 기준"],
    ].map(([label, value, note], index) => <div className="compact-metric" key={label}><span className={`metric-accent ${["navy", "orange", "blue", "green"][index]}`}></span><p>{label}</p><h2>{value}</h2><small>{note}</small></div>)}</section>

    <section className="panel table-panel requisition-ledger">
      <div className="table-toolbar"><div><h2>채용요청 원장</h2><span>{data?.requisitions.length ?? 0}건 · 지원자 수는 충원 인원으로 계산하지 않습니다.</span></div><div><button type="button" onClick={openForm} disabled={loading}>+ 채용요청 등록</button></div></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>팀·포지션</th><th>요청/확정/잔여</th><th>지원자</th><th>담당자</th><th>목표일</th><th>상태</th><th>처리</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={7} className="empty-cell">채용요청을 불러오는 중입니다.</td></tr> : data?.requisitions.length ? data.requisitions.map((item) => <tr key={item.id}>
          <td><strong>{item.title}</strong><small>{item.organizationName} · {item.role}</small></td><td>{item.requestedHeadcount} / {item.filledHeadcount} / <b>{item.remainingHeadcount}</b></td><td>{item.applicantCount}명</td><td>{item.ownerName || "미지정"}</td><td>{item.targetStartDate}</td><td><span className={`requisition-status ${item.status.toLowerCase()}`}>{labels[item.status] ?? item.status}</span></td>
          <td><div className="row-actions">{item.status === "DRAFT" && <><button type="button" className="interview-action" onClick={() => void action(item.id, "SUBMIT")}>결재 제출</button><button type="button" className="reject-action" onClick={() => void action(item.id, "CANCEL")}>취소</button></>}{item.status === "OPEN" && <button type="button" className="reject-action" onClick={() => void action(item.id, "CLOSE")}>조기 마감</button>}{!["DRAFT", "OPEN"].includes(item.status) && <span>{item.closeReason || "자동 처리"}</span>}<button type="button" className="delete-action" onClick={() => void action(item.id, "DELETE", item.title)}>삭제</button></div></td>
        </tr>) : <tr><td colSpan={7} className="empty-cell">등록된 채용요청이 없습니다. 상단의 채용요청 등록 버튼으로 추가하세요.</td></tr>}
      </tbody></table></div>
    </section>

    {formOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) setFormOpen(false); }}>
      <form className="employee-modal requisition-modal" onSubmit={createDraft}>
        <div className="modal-header"><div data-korean-heading><h2>채용요청 등록</h2></div><button type="button" aria-label="닫기" onClick={() => setFormOpen(false)}>×</button></div>
        <div className="form-grid">
          <label><span>채용요청 팀 *</span><select required value={draft.organizationId} onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })}>
            <option value="">팀 선택</option>
            {organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label><span>요청 포지션 *</span><input required value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="예: 영업, 기술지원, 경영지원" /></label>
          <label><span>요청 인원수 *</span><input required type="number" min="1" max="99" value={draft.requestedHeadcount} onChange={(event) => setDraft({ ...draft, requestedHeadcount: Number(event.target.value) })} /></label>
          <label><span>목표일 *</span><input required type="date" value={draft.targetStartDate} onChange={(event) => setDraft({ ...draft, targetStartDate: event.target.value })} /></label>
          <label><span>채용담당자</span><select value={draft.ownerEmployeeId} onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}>
            <option value="">나중에 지정</option>
            {(data?.recruiters ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.department}</option>)}
          </select></label>
          <label className="wide"><span>충원 사유와 기대 역할</span><textarea value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} placeholder="이 인원이 맡을 역할이나 충원이 필요한 배경을 남겨두면 결재와 이후 채용에 참고됩니다." /></label>
        </div>
        {selectedTeam && <p className="requisition-form-hint">{teamLine
          ? `${selectedTeam.name}은 승인 인력계획상 ${teamLine.hiringGap}명 부족, 진행 중 요청 ${teamLine.reservedHeadcount}명입니다.`
          : `${selectedTeam.name}은 승인된 인력계획이 없어 정원 대비 수치는 표시되지 않습니다. 등록에는 지장이 없습니다.`}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => setFormOpen(false)} disabled={saving}>취소</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? "등록 중…" : "채용요청 등록"}</button>
        </div>
      </form>
    </div>}
  </div>;
}
