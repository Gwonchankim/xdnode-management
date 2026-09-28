"use client";

import { FormEvent, useEffect, useState } from "react";
import MasterImpactDialog from "./master-impact-dialog";

type Account = { id: string; name: string; businessNumber: string; industry: string; ownerEmployeeId: string; ownerName: string; status: string; memo: string };
type Contact = { id: string; name: string; title: string; email: string; phone: string; isPrimary: boolean; status: string };
type Account360 = {
  account: Account;
  metrics: { opportunityCount: number; openOpportunityCount: number; activityCount: number; outstandingAmount: number; latestActivity: string; lastContactDays: number | null };
  contacts: Contact[];
  opportunities: Array<{ id: string; title: string; ownerName: string; stage: string; expectedRevenue: number; expectedCost: number; probability: number; expectedCloseDate: string; nextAction: string; nextActionDate: string; status: string }>;
  activities: Array<{ id: string; opportunityTitle: string; contactName: string; activityType: string; occurredAt: string; summary: string; nextAction: string; nextActionDate: string }>;
  documents: Array<{ id: string; opportunityTitle: string; documentType: string; documentNumber: string; amount: number; status: string; issuedDate: string; dueDate: string; collectedAmount: number; outstandingAmount: number }>;
  ownerHistory: Array<{ id: string; fromOwnerName: string; toOwnerName: string; reason: string; changedBy: string; changedAt: number }>;
  employees: Array<{ id: string; name: string; department: string; status: string }>;
  duplicateCandidates: Account[];
  mergeTargets: Account[];
  alerts: Array<{ code: string; level: string; title: string }>;
};

const won = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const stageLabel: Record<string, string> = { LEAD: "리드", DISCOVERY: "요구 확인", PROPOSAL: "제안", CONTRACT: "계약 협의", WON: "수주", LOST: "실주" };
const activityLabel: Record<string, string> = { CALL: "전화", EMAIL: "이메일", MEETING: "회의", NOTE: "메모" };
const documentLabel: Record<string, string> = { QUOTE: "견적", ORDER: "수주", DELIVERY: "납품", INVOICE: "청구", PAYMENT: "수금" };

export default function SalesAccount360View({ accountId, onClose, onChanged }: { accountId: string; onClose: () => void; onChanged: () => Promise<void> | void }) {
  const [data, setData] = useState<Account360 | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [edit, setEdit] = useState({ name: "", businessNumber: "", industry: "", memo: "", status: "ACTIVE" });
  const [transfer, setTransfer] = useState({ toOwnerEmployeeId: "", reason: "" });
  const [merge, setMerge] = useState({ targetAccountId: "", reason: "" });
  const [impactRequest, setImpactRequest] = useState<null | { action: string; proceed: (assessmentId: string) => Promise<boolean> }>(null);

  async function load() {
    const response = await fetch(`/api/sales/accounts?accountId=${encodeURIComponent(accountId)}`);
    const result = await response.json() as Account360 & { error?: string };
    if (!response.ok) { setMessage(result.error || "고객 360도 정보를 불러오지 못했습니다."); return; }
    setData(result);
    setEdit({ name: result.account.name, businessNumber: result.account.businessNumber, industry: result.account.industry, memo: result.account.memo, status: result.account.status });
    setTransfer((current) => ({ ...current, toOwnerEmployeeId: current.toOwnerEmployeeId || result.account.ownerEmployeeId }));
    setMerge((current) => ({ ...current, targetAccountId: current.targetAccountId || result.duplicateCandidates[0]?.id || "" }));
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [accountId]);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/sales/accounts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, ...payload }) });
      const result = await response.json() as { error?: string; merged?: boolean };
      if (!response.ok) { setMessage(result.error || "거래처 작업을 완료하지 못했습니다."); return false; }
      setMessage(success); await onChanged();
      if (result.merged) { onClose(); return true; }
      await load(); return true;
    } finally { setWorking(false); }
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const impactAction = edit.status === "INACTIVE" && data?.account.status !== "INACTIVE" ? "DEACTIVATE" : "UPDATE";
    setImpactRequest({ action: impactAction, proceed: async (impactAssessmentId) => {
      return mutate({ action: "UPDATE_ACCOUNT", ...edit, reason: "고객 360도에서 거래처 기준정보 수정", impactAssessmentId }, "거래처 기준정보를 저장했습니다.");
    } });
  }
  async function reassign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate({ action: "REASSIGN_OWNER", ...transfer }, "거래처와 진행 중 영업기회의 담당자를 함께 이관했습니다.");
    setTransfer((current) => ({ ...current, reason: "" }));
  }
  async function mergeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = data?.mergeTargets.find((item) => item.id === merge.targetAccountId);
    if (!target || !window.confirm(`${data?.account.name}의 영업기회·담당자를 ${target.name}(으)로 병합합니다. 계속할까요?`)) return;
    setImpactRequest({ action: "MERGE", proceed: async (impactAssessmentId) => {
      return mutate({ action: "MERGE_ACCOUNT", ...merge, impactAssessmentId }, "거래처를 병합했습니다.");
    } });
  }
  async function updateContact(contact: Contact, patch: { status?: string; isPrimary?: boolean }) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/sales/crm", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: contact.id, status: patch.status ?? contact.status, isPrimary: patch.isPrimary ?? contact.isPrimary,
          reason: patch.status === "INACTIVE" ? "거래처 담당자 변경으로 비활성화" : "대표 고객 담당자 지정" }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setMessage(result.error || "고객 담당자 상태를 변경하지 못했습니다."); return; }
      setMessage("고객 담당자 상태를 변경했습니다."); await load();
    } finally { setWorking(false); }
  }

  if (!data) return <section className="panel sales-account-360 loading">{message || "고객 360도 원장을 불러오고 있습니다…"}</section>;

  return <section className="panel sales-account-360">
    <header className="sales-account-360-heading"><div data-korean-heading><h2>{data.account.name}</h2><span>{data.account.businessNumber || "사업자번호 미입력"} · 담당 {data.account.ownerName || "미지정"}</span></div><button type="button" onClick={onClose}>닫기</button></header>
    {message && <div className="sales-account-360-message" role="status">{message}</div>}
    {data.alerts.length > 0 && <div className="sales-account-alerts">{data.alerts.map((alert) => <span className={alert.level.toLowerCase()} key={alert.code}>{alert.title}</span>)}</div>}
    <div className="sales-account-360-metrics">
      <article><small>영업기회</small><strong>{data.metrics.openOpportunityCount} / {data.metrics.opportunityCount}건</strong><span>진행 / 전체</span></article>
      <article><small>고객 접점</small><strong>{data.metrics.activityCount}건</strong><span>{data.metrics.lastContactDays === null ? "접점 없음" : `최근 ${data.metrics.lastContactDays}일 전`}</span></article>
      <article><small>미수금</small><strong>{won(data.metrics.outstandingAmount)}</strong><span>확정 청구 - 확정 수금</span></article>
      <article><small>고객 담당자</small><strong>{data.contacts.filter((item) => item.status === "ACTIVE").length}명</strong><span>대표 {data.contacts.find((item) => item.isPrimary && item.status === "ACTIVE")?.name || "미지정"}</span></article>
    </div>

    <div className="sales-account-governance-grid">
      <form onSubmit={saveAccount}><h3>거래처 기준정보</h3><label>거래처명<input required minLength={2} value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></label><label>사업자번호<input value={edit.businessNumber} onChange={(event) => setEdit({ ...edit, businessNumber: event.target.value })} /></label><label>업종<input value={edit.industry} onChange={(event) => setEdit({ ...edit, industry: event.target.value })} /></label><label>상태<select value={edit.status} onChange={(event) => setEdit({ ...edit, status: event.target.value })}><option value="ACTIVE">활성</option><option value="INACTIVE">비활성</option></select></label><label className="wide">메모<textarea value={edit.memo} onChange={(event) => setEdit({ ...edit, memo: event.target.value })} /></label><button disabled={working} type="submit">변경내용 저장</button></form>
      <form onSubmit={reassign}><h3>영업 담당자 이관</h3><label>현재 담당자<input readOnly value={data.account.ownerName || "미지정"} /></label><label>새 담당자<select required value={transfer.toOwnerEmployeeId} onChange={(event) => setTransfer({ ...transfer, toOwnerEmployeeId: event.target.value })}><option value="">선택</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department || "소속 미지정"}</option>)}</select></label><label className="wide">이관 사유<textarea required minLength={10} value={transfer.reason} onChange={(event) => setTransfer({ ...transfer, reason: event.target.value })} placeholder="고객 인수인계 근거를 10자 이상 기록" /></label><button disabled={working || transfer.toOwnerEmployeeId === data.account.ownerEmployeeId} type="submit">진행 영업 건까지 이관</button></form>
      <form className="danger" onSubmit={mergeAccount}><h3>중복 거래처 병합</h3>{data.duplicateCandidates.length > 0 && <p>정확히 일치하는 중복 후보 {data.duplicateCandidates.length}곳이 있습니다.</p>}<label>병합 대상<select required value={merge.targetAccountId} onChange={(event) => setMerge({ ...merge, targetAccountId: event.target.value })}><option value="">선택</option>{data.mergeTargets.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.businessNumber || "번호 없음"}</option>)}</select></label><label className="wide">병합 사유<textarea required minLength={10} value={merge.reason} onChange={(event) => setMerge({ ...merge, reason: event.target.value })} placeholder="중복 확인 근거를 10자 이상 기록" /></label><button disabled={working} type="submit">영업 원장 병합</button><small>재무 거래처 마스터는 자동 병합하지 않습니다.</small></form>
    </div>

    <div className="sales-account-360-ledgers">
      <article><header><h3>고객 담당자</h3><span>대표 1명 원칙</span></header>{data.contacts.map((contact) => <div className={contact.status === "INACTIVE" ? "inactive" : ""} key={contact.id}><p><strong>{contact.name}{contact.isPrimary ? " · 대표" : ""}</strong><small>{contact.title || "직책 미입력"} · {contact.email || contact.phone}</small></p><span>{contact.status === "ACTIVE" ? "활성" : "비활성"}</span><div>{contact.status === "ACTIVE" && !contact.isPrimary && <button disabled={working} type="button" onClick={() => void updateContact(contact, { isPrimary: true })}>대표 지정</button>}<button disabled={working} type="button" onClick={() => void updateContact(contact, { status: contact.status === "ACTIVE" ? "INACTIVE" : "ACTIVE", isPrimary: false })}>{contact.status === "ACTIVE" ? "비활성" : "활성화"}</button></div></div>)}</article>
      <article><header><h3>영업기회</h3><span>{data.opportunities.length}건</span></header>{data.opportunities.map((item) => <div key={item.id}><p><strong>{item.title}</strong><small>{item.ownerName || "담당 미지정"} · 다음 행동 {item.nextAction || "미지정"}{item.nextActionDate ? ` (${item.nextActionDate})` : ""}</small></p><span>{stageLabel[item.stage] || item.stage}</span><strong>{won(item.expectedRevenue)}</strong></div>)}</article>
      <article><header><h3>영업 문서·미수</h3><span>{data.documents.length}건</span></header>{data.documents.map((item) => <div key={item.id}><p><strong>{documentLabel[item.documentType] || item.documentType} · {item.documentNumber}</strong><small>{item.opportunityTitle} · {item.issuedDate || "미발행"}{item.dueDate ? ` → ${item.dueDate}` : ""}</small></p><span>{item.status}</span><strong>{won(item.amount)}{item.outstandingAmount > 0 && <small>미수 {won(item.outstandingAmount)}</small>}</strong></div>)}</article>
      <article><header><h3>고객 접점 타임라인</h3><span>{data.activities.length}건</span></header>{data.activities.slice(0, 30).map((item) => <div key={item.id}><time>{item.occurredAt.replace("T", " ")}</time><p><strong>{activityLabel[item.activityType] || item.activityType} · {item.opportunityTitle}{item.contactName ? ` · ${item.contactName}` : ""}</strong><small>{item.summary}</small></p></div>)}{!data.activities.length && <p className="empty">기록된 고객 접점이 없습니다.</p>}</article>
      <article><header><h3>담당자 이관 이력</h3><span>감사 원장</span></header>{data.ownerHistory.map((item) => <div key={item.id}><time>{new Date(item.changedAt).toLocaleString("ko-KR")}</time><p><strong>{item.fromOwnerName || "미지정"} → {item.toOwnerName}</strong><small>{item.reason}</small></p></div>)}{!data.ownerHistory.length && <p className="empty">담당자 이관 이력이 없습니다.</p>}</article>
    </div>
    {impactRequest && <MasterImpactDialog entityType="SALES_ACCOUNT" entityId={accountId} action={impactRequest.action} onClose={() => setImpactRequest(null)} onProceed={impactRequest.proceed} />}
  </section>;
}
