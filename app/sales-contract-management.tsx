"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Obligation = { id: string; contractId: string; obligationType: string; title: string; ownerEmployeeId: string; dueDate: string; evidenceRequired: boolean; status: string; completionNote: string; completedBy: string; completedAt: number | null };
type Change = { id: string; contractId: string; changeType: string; reason: string; before: Record<string, unknown>; after: Record<string, unknown>; effectiveDate: string; status: string; approvalRequestId: string; createdAt: number };
type Contract = { id: string; orderDocumentId: string; orderNumber: string; accountName: string; opportunityTitle: string; contractNumber: string; title: string; version: number; amountSnapshot: number; currency: string; startDate: string; endDate: string; autoRenewal: boolean; renewalNoticeDays: number; paymentTerms: string; acceptanceCriteria: string; deliveryTerms: string; ownerEmployeeId: string; signedDocumentId: string; status: string; obligations: Obligation[]; changes: Change[] };
type ContractData = { enforcementStartedAt: number; contracts: Contract[]; eligibleOrders: Array<{ id: string; documentNumber: string; amount: number; accountName: string; opportunityTitle: string }>; employees: Array<{ employeeId: string; name: string; position: string }>; documents: Array<{ id: string; entityType: string; entityId: string; category: string; version: number; fileName: string; downloadUrl: string }> };

const money = (value: number) => `₩${value.toLocaleString("ko-KR")}`;
const today = () => new Date().toISOString().slice(0, 10);
const statusLabels: Record<string, string> = { DRAFT: "작성 중", SUBMITTED: "계약 결재 중", ACTIVE: "활성", TERMINATED: "종료", EXPIRED: "만료", OPEN: "대기", IN_PROGRESS: "진행", COMPLETED: "완료", SCHEDULED: "적용 대기", APPROVED: "승인", REJECTED: "반려" };
const obligationLabels: Record<string, string> = { DELIVERY: "납품", ACCEPTANCE: "검수", INVOICE: "청구", PAYMENT: "대금", CUSTOM: "기타" };
const changeLabels: Record<string, string> = { PERIOD: "기간 변경", TERMS: "조건 변경", OWNER: "담당자 변경", RENEWAL: "갱신 설정", TERMINATION: "계약 종료" };

export default function SalesContractManagement({ refreshKey = 0 }: { refreshKey?: number }) {
  const [currentDate] = useState(today); const [currentTime] = useState(Date.now);
  const [data, setData] = useState<ContractData | null>(null); const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState({ orderDocumentId: "", contractNumber: "", title: "", startDate: today(), endDate: "", autoRenewal: false, renewalNoticeDays: "30", paymentTerms: "", acceptanceCriteria: "", deliveryTerms: "", ownerEmployeeId: "" });
  const [obligation, setObligation] = useState({ obligationType: "DELIVERY", title: "", ownerEmployeeId: "", dueDate: "", evidenceRequired: true });
  const [change, setChange] = useState({ changeType: "PERIOD", reason: "", effectiveDate: today(), endDate: "", paymentTerms: "", acceptanceCriteria: "", deliveryTerms: "", ownerEmployeeId: "", autoRenewal: false, renewalNoticeDays: "30" });

  async function load() {
    try {
      const response = await fetch("/api/sales/contracts"); const result = await response.json() as ContractData & { error?: string };
      if (!response.ok) throw new Error(result.error || "계약 데이터를 불러오지 못했습니다."); setData(result);
      const nextSelected = result.contracts.find((item) => item.id === selectedId) ?? result.contracts[0] ?? null;
      setSelectedId(nextSelected?.id || "");
      if (nextSelected) setChange({ changeType: "PERIOD", reason: "", effectiveDate: currentDate, endDate: nextSelected.endDate,
        paymentTerms: nextSelected.paymentTerms, acceptanceCriteria: nextSelected.acceptanceCriteria, deliveryTerms: nextSelected.deliveryTerms,
        ownerEmployeeId: nextSelected.ownerEmployeeId, autoRenewal: nextSelected.autoRenewal, renewalNoticeDays: String(nextSelected.renewalNoticeDays) });
      const firstEmployee = result.employees[0]?.employeeId || ""; const firstOrder = result.eligibleOrders[0]?.id || "";
      setDraft((current) => ({ ...current, orderDocumentId: current.orderDocumentId || firstOrder, ownerEmployeeId: current.ownerEmployeeId || firstEmployee }));
      setObligation((current) => ({ ...current, ownerEmployeeId: current.ownerEmployeeId || firstEmployee }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "계약 데이터를 불러오지 못했습니다."); }
  }
  // The server refresh owns the selected contract and related form snapshots.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [refreshKey]);

  async function act(action: string, payload: Record<string, unknown>) {
    setBusy(action); setMessage("");
    try {
      const response = await fetch("/api/sales/contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const result = await response.json() as { error?: string; id?: string };
      if (!response.ok) throw new Error(result.error || "계약 작업을 처리하지 못했습니다."); await load(); return result;
    } catch (error) { setMessage(error instanceof Error ? error.message : "계약 작업을 처리하지 못했습니다."); return null; }
    finally { setBusy(""); }
  }
  async function createContract(event: FormEvent) {
    event.preventDefault(); const result = await act("CREATE_CONTRACT", { ...draft, renewalNoticeDays: Number(draft.renewalNoticeDays) });
    if (result?.id) { setSelectedId(result.id); setDraft((current) => ({ ...current, contractNumber: "", title: "", endDate: "", paymentTerms: "", acceptanceCriteria: "", deliveryTerms: "" })); setMessage("계약 초안을 만들었습니다. 서명본과 이행 의무를 등록해 주세요."); }
  }
  async function addObligation(event: FormEvent) {
    event.preventDefault(); if (!selectedId) return;
    if (await act("ADD_OBLIGATION", { contractId: selectedId, ...obligation })) { setObligation((current) => ({ ...current, title: "", dueDate: "" })); setMessage("계약 이행 의무를 등록했습니다."); }
  }
  async function upload(entityType: "salesContract" | "salesContractObligation", entityId: string, category: string, file?: File) {
    if (!file) return; setBusy(`upload:${entityId}`); setMessage("");
    try {
      const form = new FormData(); form.append("module", "sales"); form.append("entityType", entityType); form.append("entityId", entityId); form.append("category", category); form.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body: form }); const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "파일을 저장하지 못했습니다."); setMessage(entityType === "salesContract" ? "서명 계약서를 저장했습니다." : "의무 완료 증빙을 저장했습니다."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "파일을 저장하지 못했습니다."); } finally { setBusy(""); }
  }
  async function completeObligation(item: Obligation) {
    if (item.status === "OPEN") { await act("UPDATE_OBLIGATION", { id: item.id, status: "IN_PROGRESS", completionNote: "" }); return; }
    const completionNote = window.prompt("완료 근거를 5자 이상 입력해 주세요.", ""); if (completionNote === null) return;
    if (await act("UPDATE_OBLIGATION", { id: item.id, status: "COMPLETED", completionNote })) setMessage("계약 의무를 완료 처리했습니다.");
  }
  async function requestChange(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    const payload: Record<string, unknown> = { contractId: selected.id, changeType: change.changeType, reason: change.reason, effectiveDate: change.effectiveDate };
    if (change.changeType === "PERIOD") payload.endDate = change.endDate;
    else if (change.changeType === "TERMS") Object.assign(payload, { paymentTerms: change.paymentTerms, acceptanceCriteria: change.acceptanceCriteria, deliveryTerms: change.deliveryTerms });
    else if (change.changeType === "OWNER") payload.ownerEmployeeId = change.ownerEmployeeId;
    else if (change.changeType === "RENEWAL") Object.assign(payload, { autoRenewal: change.autoRenewal, renewalNoticeDays: Number(change.renewalNoticeDays) });
    if (await act("REQUEST_CHANGE", payload)) { setChange((current) => ({ ...current, reason: "" })); setMessage("계약 변경 전자결재를 제출했습니다."); }
  }
  function chooseContract(contract: Contract) {
    setSelectedId(contract.id); setChange({ changeType: "PERIOD", reason: "", effectiveDate: currentDate, endDate: contract.endDate,
      paymentTerms: contract.paymentTerms, acceptanceCriteria: contract.acceptanceCriteria, deliveryTerms: contract.deliveryTerms,
      ownerEmployeeId: contract.ownerEmployeeId, autoRenewal: contract.autoRenewal, renewalNoticeDays: String(contract.renewalNoticeDays) });
  }

  const selected = data?.contracts.find((item) => item.id === selectedId) ?? null;
  const documentsByEntity = useMemo(() => {
    const latest = new Map<string, ContractData["documents"][number]>();
    for (const item of data?.documents ?? []) {
      const key = `${item.entityType}:${item.entityId}`;
      if (!latest.has(key)) latest.set(key, item);
    }
    return latest;
  }, [data]);
  const activeCount = data?.contracts.filter((item) => item.status === "ACTIVE").length ?? 0;
  const overdueCount = data?.contracts.flatMap((item) => item.obligations).filter((item) => item.status !== "COMPLETED" && item.dueDate < currentDate).length ?? 0;
  const renewalCount = data?.contracts.filter((item) => item.status === "ACTIVE" && item.autoRenewal && new Date(item.endDate).getTime() - item.renewalNoticeDays * 86_400_000 <= currentTime).length ?? 0;

  return <section className="panel sales-contract-management">
    <header><div data-korean-heading><h2>계약·이행 관리</h2><span>수주 이후 계약서, 조건, 담당 의무, 변경합의와 갱신기한을 한 원장으로 관리합니다.</span></div><strong>도입 기준 {data?.enforcementStartedAt ? new Date(data.enforcementStartedAt).toLocaleDateString("ko-KR") : "확인 중"}</strong></header>
    {message && <div className="sales-contract-message" role="status">{message}</div>}
    <div className="sales-contract-metrics"><article><small>활성 계약</small><strong>{activeCount}건</strong><span>납품·청구 가능</span></article><article><small>계약 초안·결재</small><strong>{data?.contracts.filter((item) => ["DRAFT", "SUBMITTED"].includes(item.status)).length ?? 0}건</strong><span>서명본·의무·승인 확인</span></article><article className={overdueCount ? "warning" : ""}><small>기한 경과 의무</small><strong>{overdueCount}건</strong><span>완료 증빙 필요</span></article><article className={renewalCount ? "warning" : ""}><small>갱신 통지 도래</small><strong>{renewalCount}건</strong><span>자동갱신 계약 기준</span></article></div>
    <form className="sales-contract-create" onSubmit={createContract}><h3>수주에서 계약 초안 생성</h3><label>승인 수주<select required value={draft.orderDocumentId} onChange={(event) => setDraft({ ...draft, orderDocumentId: event.target.value })}><option value="">선택</option>{data?.eligibleOrders.map((item) => <option key={item.id} value={item.id}>{item.documentNumber} · {item.accountName} · {money(item.amount)}</option>)}</select></label><label>계약번호<input required value={draft.contractNumber} onChange={(event) => setDraft({ ...draft, contractNumber: event.target.value })} /></label><label>계약명<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>시작일<input required type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label><label>종료일<input required type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></label><label>담당자<select required value={draft.ownerEmployeeId} onChange={(event) => setDraft({ ...draft, ownerEmployeeId: event.target.value })}><option value="">선택</option>{data?.employees.map((item) => <option key={item.employeeId} value={item.employeeId}>{item.name} · {item.position}</option>)}</select></label><label>대금조건<textarea required minLength={5} value={draft.paymentTerms} onChange={(event) => setDraft({ ...draft, paymentTerms: event.target.value })} /></label><label>검수기준<textarea required minLength={5} value={draft.acceptanceCriteria} onChange={(event) => setDraft({ ...draft, acceptanceCriteria: event.target.value })} /></label><label>납품조건<textarea required minLength={5} value={draft.deliveryTerms} onChange={(event) => setDraft({ ...draft, deliveryTerms: event.target.value })} /></label><label className="check"><input type="checkbox" checked={draft.autoRenewal} onChange={(event) => setDraft({ ...draft, autoRenewal: event.target.checked })} />자동갱신</label><label>갱신 통지일<input type="number" min="0" max="3650" value={draft.renewalNoticeDays} onChange={(event) => setDraft({ ...draft, renewalNoticeDays: event.target.value })} /></label><button disabled={Boolean(busy) || !data?.eligibleOrders.length} type="submit">+ 계약 초안</button></form>
    <div className="sales-contract-layout">
      <aside>{data?.contracts.map((item) => <button type="button" className={item.id === selectedId ? "selected" : ""} key={item.id} onClick={() => chooseContract(item)}><span>{item.contractNumber} · v{item.version}</span><strong>{item.title}</strong><small>{item.accountName} · {item.startDate}~{item.endDate}</small><em className={item.status.toLowerCase()}>{statusLabels[item.status]}</em></button>)}{!data?.contracts.length && <p>등록된 계약이 없습니다.</p>}</aside>
      {selected ? <div className="sales-contract-detail"><header><div><p>{selected.orderNumber} · {selected.accountName}</p><h3>{selected.contractNumber} {selected.title}</h3><span>{money(selected.amountSnapshot)} · 담당 {data?.employees.find((item) => item.employeeId === selected.ownerEmployeeId)?.name || selected.ownerEmployeeId}</span></div><em className={selected.status.toLowerCase()}>{statusLabels[selected.status]}</em></header>
        <div className="sales-contract-terms"><p><small>계약기간</small><strong>{selected.startDate} ~ {selected.endDate}</strong></p><p><small>대금조건</small><span>{selected.paymentTerms}</span></p><p><small>검수기준</small><span>{selected.acceptanceCriteria}</span></p><p><small>납품조건</small><span>{selected.deliveryTerms}</span></p><p><small>갱신</small><span>{selected.autoRenewal ? `자동 · ${selected.renewalNoticeDays}일 전 통지` : "자동갱신 없음"}</span></p></div>
        {selected.status === "DRAFT" && <div className="sales-contract-draft-actions"><label className="file-action">서명 계약서<input type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" onChange={(event) => { void upload("salesContract", selected.id, "SIGNED_CONTRACT", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>{documentsByEntity.get(`salesContract:${selected.id}`) && <a href={documentsByEntity.get(`salesContract:${selected.id}`)?.downloadUrl}>서명본 v{documentsByEntity.get(`salesContract:${selected.id}`)?.version} 보기</a>}<button type="button" disabled={Boolean(busy)} onClick={() => void act("SUBMIT_CONTRACT", { contractId: selected.id })}>계약 결재 제출</button></div>}
        {selected.status === "DRAFT" && <form className="sales-obligation-form" onSubmit={addObligation}><h4>이행 의무 추가</h4><label>유형<select value={obligation.obligationType} onChange={(event) => setObligation({ ...obligation, obligationType: event.target.value })}>{Object.entries(obligationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>의무 내용<input required minLength={3} value={obligation.title} onChange={(event) => setObligation({ ...obligation, title: event.target.value })} /></label><label>담당자<select required value={obligation.ownerEmployeeId} onChange={(event) => setObligation({ ...obligation, ownerEmployeeId: event.target.value })}>{data?.employees.map((item) => <option key={item.employeeId} value={item.employeeId}>{item.name}</option>)}</select></label><label>기한<input required type="date" min={selected.startDate} max={selected.endDate} value={obligation.dueDate} onChange={(event) => setObligation({ ...obligation, dueDate: event.target.value })} /></label><label className="check"><input type="checkbox" checked={obligation.evidenceRequired} onChange={(event) => setObligation({ ...obligation, evidenceRequired: event.target.checked })} />증빙 필요</label><button disabled={Boolean(busy)} type="submit">+ 의무 추가</button></form>}
        <div className="sales-obligation-ledger"><h4>계약 이행 의무</h4>{selected.obligations.map((item) => <div key={item.id}><p><strong>{obligationLabels[item.obligationType]} · {item.title}</strong><small>{data?.employees.find((employee) => employee.employeeId === item.ownerEmployeeId)?.name || item.ownerEmployeeId} · {item.dueDate}{item.evidenceRequired ? " · 증빙 필수" : ""}</small></p><em className={item.status.toLowerCase()}>{statusLabels[item.status]}</em>{selected.status === "ACTIVE" && item.status !== "COMPLETED" && <><label className="evidence-file">증빙<input type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv" onChange={(event) => { void upload("salesContractObligation", item.id, "OBLIGATION_EVIDENCE", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><button type="button" onClick={() => void completeObligation(item)}>{item.status === "OPEN" ? "착수" : "완료"}</button></>}{documentsByEntity.get(`salesContractObligation:${item.id}`) && <a href={documentsByEntity.get(`salesContractObligation:${item.id}`)?.downloadUrl}>근거 보기</a>}</div>)}{!selected.obligations.length && <p>등록된 이행 의무가 없습니다.</p>}</div>
        {selected.status === "ACTIVE" && <form className="sales-contract-change-form" onSubmit={requestChange}><h4>계약 변경요청</h4><label>변경 유형<select value={change.changeType} onChange={(event) => setChange({ ...change, changeType: event.target.value })}>{Object.entries(changeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>적용일<input required type="date" value={change.effectiveDate} onChange={(event) => setChange({ ...change, effectiveDate: event.target.value })} /></label>{change.changeType === "PERIOD" && <label>새 종료일<input required type="date" value={change.endDate} onChange={(event) => setChange({ ...change, endDate: event.target.value })} /></label>}{change.changeType === "OWNER" && <label>새 담당자<select required value={change.ownerEmployeeId} onChange={(event) => setChange({ ...change, ownerEmployeeId: event.target.value })}>{data?.employees.map((item) => <option key={item.employeeId} value={item.employeeId}>{item.name}</option>)}</select></label>}{change.changeType === "RENEWAL" && <><label className="check"><input type="checkbox" checked={change.autoRenewal} onChange={(event) => setChange({ ...change, autoRenewal: event.target.checked })} />자동갱신</label><label>통지일<input type="number" min="0" max="3650" value={change.renewalNoticeDays} onChange={(event) => setChange({ ...change, renewalNoticeDays: event.target.value })} /></label></>}{change.changeType === "TERMS" && <><label>대금조건<textarea value={change.paymentTerms} onChange={(event) => setChange({ ...change, paymentTerms: event.target.value })} /></label><label>검수기준<textarea value={change.acceptanceCriteria} onChange={(event) => setChange({ ...change, acceptanceCriteria: event.target.value })} /></label><label>납품조건<textarea value={change.deliveryTerms} onChange={(event) => setChange({ ...change, deliveryTerms: event.target.value })} /></label></>}<label className="reason">변경 사유<textarea required minLength={10} value={change.reason} onChange={(event) => setChange({ ...change, reason: event.target.value })} /></label><button disabled={Boolean(busy) || selected.changes.some((item) => ["SUBMITTED", "SCHEDULED"].includes(item.status))} type="submit">변경 결재 제출</button></form>}
        <div className="sales-contract-change-ledger"><h4>변경 이력</h4>{selected.changes.map((item) => <div key={item.id}><p><strong>{changeLabels[item.changeType]} · {statusLabels[item.status]}</strong><small>{item.effectiveDate} 적용 · {item.reason}</small></p>{item.status === "SCHEDULED" && item.effectiveDate <= currentDate && <button type="button" onClick={() => void act("APPLY_SCHEDULED_CHANGE", { id: item.id })}>승인 변경 적용</button>}</div>)}{!selected.changes.length && <p>계약 변경 이력이 없습니다.</p>}</div>
      </div> : <div className="finance-empty">왼쪽에서 계약을 선택해 주세요.</div>}
    </div>
  </section>;
}
