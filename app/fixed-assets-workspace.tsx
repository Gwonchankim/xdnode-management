"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";

type Asset = { id: string; asset_code: string; name: string; category: string; acquisition_date: string; in_service_date: string;
  acquisition_cost: number; residual_value: number; useful_life_months: number; depreciation_method: string;
  opening_accumulated: number; opening_as_of: string;
  asset_account_code: string; accumulated_account_code: string; expense_account_code: string; location: string;
  custodian_employee_id: string; source_type: string; source_id: string; source_reference: string; status: string;
  disposal_date: string; note: string; posted_accumulated: number; evidence_count: number };
type Schedule = { id: string; asset_id: string; asset_code: string; asset_name: string; period: string; opening_accumulated: number;
  depreciation_amount: number; closing_accumulated: number; closing_book_value: number; status: string; journal_entry_id: string };
type Candidate = { id: string; item_name: string; description: string; order_number: string; vendor_name: string;
  receipt_date: string; accepted_quantity_milli: number; accepted_amount: number };
type AssetData = { asOf: string; currentPeriod: string; period: string; locked: boolean; assets: Asset[]; schedules: Schedule[];
  candidates: Candidate[]; events: Array<Record<string, string | number>>; summary: { activeAssets: number; acquisitionCost: number;
    accumulatedDepreciation: number; bookValue: number; pendingSchedules: number } };

const won = (value: number) => `₩${Number(value || 0).toLocaleString("ko-KR")}`;
const categoryLabel: Record<string, string> = { EQUIPMENT: "기계·장비", VEHICLE: "차량", FURNITURE: "비품",
  SOFTWARE: "소프트웨어", LEASEHOLD: "시설장치", OTHER: "기타" };
const statusLabel: Record<string, string> = { DRAFT: "작성 중", ACTIVE: "사용 중", DISPOSED: "처분", PLANNED: "상각 계획",
  DRAFTED: "전표 초안", POSTED: "전기 완료" };
const emptyDraft = { assetCode: "", name: "", category: "EQUIPMENT", acquisitionDate: "", inServiceDate: "",
  acquisitionCost: "", residualValue: "0", usefulLifeMonths: "60", assetAccountCode: "", accumulatedAccountCode: "",
  openingAccumulated: "0", openingAsOf: "", expenseAccountCode: "", location: "", custodianEmployeeId: "",
  sourceType: "MANUAL", sourceId: "", sourceReference: "", note: "" };

export default function FixedAssetsWorkspace() {
  const [data, setData] = useState<AssetData | null>(null); const [period, setPeriod] = useState("");
  const [draft, setDraft] = useState(emptyDraft); const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false); const [message, setMessage] = useState("");

  async function load(selected = period) {
    setLoading(true); setMessage("");
    try {
      const response = await fetch(`/api/finance/fixed-assets${selected ? `?period=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      const result = await response.json() as AssetData & { error?: string };
      if (!response.ok) throw new Error(result.error || "고정자산 원장을 불러오지 못했습니다.");
      setData(result); setPeriod(result.period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "고정자산 원장을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/finance/fixed-assets", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as AssetData & { error?: string } }))
      .then(({ response, result }) => { if (!active) return; if (!response.ok) setMessage(result.error || "고정자산 원장을 불러오지 못했습니다.");
        else { setData(result); setPeriod(result.period); } setLoading(false); })
      .catch(() => { if (active) { setMessage("고정자산 원장을 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/fixed-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "고정자산 작업을 처리하지 못했습니다.");
      setMessage(success); await load(period); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "고정자산 작업을 처리하지 못했습니다."); return false; }
    finally { setWorking(false); }
  }

  async function createAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate({ resource: "asset", action: "CREATE", ...draft, acquisitionCost: Number(draft.acquisitionCost),
      residualValue: Number(draft.residualValue), usefulLifeMonths: Number(draft.usefulLifeMonths) }, "고정자산 초안을 등록했습니다. 증빙 첨부 후 활성화해 주세요.")) setDraft(emptyDraft);
  }

  function selectCandidate(candidate: Candidate) {
    setDraft({ ...draft, sourceType: "PURCHASE_ORDER_LINE", sourceId: candidate.id,
      sourceReference: `${candidate.order_number} · ${candidate.vendor_name}`, name: candidate.item_name,
      acquisitionDate: candidate.receipt_date, inServiceDate: candidate.receipt_date, acquisitionCost: String(candidate.accepted_amount),
      note: candidate.description });
  }

  async function uploadEvidence(asset: Asset, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    setWorking(true); setMessage(""); const form = new FormData(); form.append("module", "finance");
    form.append("entityType", "financeFixedAsset"); form.append("entityId", asset.id); form.append("category", "ASSET_EVIDENCE"); form.append("file", file);
    try { const response = await fetch("/api/documents", { method: "POST", body: form }); const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "자산 증빙을 저장하지 못했습니다."); setMessage(`${asset.asset_code} 증빙을 저장했습니다.`); await load(period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "자산 증빙을 저장하지 못했습니다."); } finally { setWorking(false); }
  }

  async function transfer(asset: Asset) {
    const eventDate = window.prompt("이동일(YYYY-MM-DD)", new Date().toISOString().slice(0, 10)); if (!eventDate) return;
    const location = window.prompt("새 위치", asset.location) ?? asset.location;
    const custodianEmployeeId = window.prompt("새 관리책임자 사번", asset.custodian_employee_id) ?? asset.custodian_employee_id;
    const reason = window.prompt("이동 사유(5자 이상)", "업무 사용 위치 변경"); if (!reason) return;
    await mutate({ resource: "asset", action: "TRANSFER", assetId: asset.id, eventDate, location, custodianEmployeeId, reason }, "자산 이동 이력을 저장했습니다.");
  }

  async function dispose(asset: Asset) {
    const eventDate = window.prompt("처분일(YYYY-MM-DD)", new Date().toISOString().slice(0, 10)); if (!eventDate) return;
    const amount = window.prompt("처분가액", "0"); if (amount === null) return;
    const journalReference = window.prompt("처분 회계전표 참조", ""); if (!journalReference) return;
    const reason = window.prompt("처분 사유(5자 이상)", "사용 종료에 따른 처분"); if (!reason) return;
    await mutate({ resource: "asset", action: "DISPOSE", assetId: asset.id, eventDate, amount: Number(amount), journalReference, reason }, "자산 처분 이력을 저장했습니다.");
  }

  if (loading && !data) return <section className="panel fixed-assets-loading">자산대장과 감가상각 전표를 확인하고 있습니다…</section>;
  return <div className="fixed-assets-workspace">
    <section className="fixed-assets-hero"><div data-korean-heading><h1>고정자산·감가상각</h1><span>취득 근거부터 위치·책임자, 정액법 상각, 전표와 처분 이력까지 연결합니다.</span></div><label>상각월<input type="month" min="2026-01" max={data?.currentPeriod} value={period} onChange={(event) => void load(event.target.value)} /></label></section>
    <div className="fixed-assets-guidance"><strong>자동 자산화 금지</strong><span>구매 품목은 후보일 뿐이며 담당자가 직접 자산 여부와 내용연수·계정과목을 확정합니다.</span><em>정액법 · 월할(사용개시월 포함)</em></div>
    {message && <div className="fixed-assets-message" role="status">{message}</div>}
    <section className="fixed-assets-metrics">
      <article><small>사용 중 자산</small><strong>{data?.summary.activeAssets ?? 0}개</strong><span>증빙 활성화 기준</span></article>
      <article><small>취득원가</small><strong>{won(data?.summary.acquisitionCost ?? 0)}</strong><span>활성 자산 합계</span></article>
      <article><small>감가상각누계액</small><strong>{won(data?.summary.accumulatedDepreciation ?? 0)}</strong><span>전기 완료 기준</span></article>
      <article><small>장부가액</small><strong>{won(data?.summary.bookValue ?? 0)}</strong><span>취득원가 − 누계액</span></article>
    </section>

    <section className="fixed-assets-grid">
      <article className="panel fixed-assets-form"><header><div data-korean-heading><h2>자산 등록</h2></div><span>DRAFT → 증빙 → ACTIVE</span></header>
        <form onSubmit={createAsset}>
          <label>자산코드<input required value={draft.assetCode} onChange={(event) => setDraft({ ...draft, assetCode: event.target.value })} placeholder="FA-2026-001" /></label>
          <label>자산명<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>분류<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{Object.entries(categoryLabel).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>취득일<input required type="date" value={draft.acquisitionDate} onChange={(event) => setDraft({ ...draft, acquisitionDate: event.target.value })} /></label>
          <label>사용개시일<input required type="date" value={draft.inServiceDate} onChange={(event) => setDraft({ ...draft, inServiceDate: event.target.value })} /></label>
          <label>취득원가<input required type="number" min="1" value={draft.acquisitionCost} onChange={(event) => setDraft({ ...draft, acquisitionCost: event.target.value })} /></label>
          <label>잔존가치<input required type="number" min="0" value={draft.residualValue} onChange={(event) => setDraft({ ...draft, residualValue: event.target.value })} /></label>
          <label>내용연수<input required type="number" min="1" max="600" value={draft.usefulLifeMonths} onChange={(event) => setDraft({ ...draft, usefulLifeMonths: event.target.value })} /><small>개월</small></label>
          <label>기초 누계상각<input required type="number" min="0" value={draft.openingAccumulated} onChange={(event) => setDraft({ ...draft, openingAccumulated: event.target.value })} /></label>
          <label>기초 기준일<input type="date" value={draft.openingAsOf} onChange={(event) => setDraft({ ...draft, openingAsOf: event.target.value })} /><small>기존 자산</small></label>
          <label>자산 계정코드<input required value={draft.assetAccountCode} onChange={(event) => setDraft({ ...draft, assetAccountCode: event.target.value })} /></label>
          <label>누계액 계정코드<input required value={draft.accumulatedAccountCode} onChange={(event) => setDraft({ ...draft, accumulatedAccountCode: event.target.value })} /></label>
          <label>상각비 계정코드<input required value={draft.expenseAccountCode} onChange={(event) => setDraft({ ...draft, expenseAccountCode: event.target.value })} /></label>
          <label>위치<input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
          <label>관리책임자 사번<input value={draft.custodianEmployeeId} onChange={(event) => setDraft({ ...draft, custodianEmployeeId: event.target.value })} /></label>
          <label>원천<select value={draft.sourceType} onChange={(event) => setDraft({ ...draft, sourceType: event.target.value, sourceId: "", sourceReference: "" })}><option value="MANUAL">수기 근거</option><option value="PURCHASE_ORDER_LINE">구매 입고 품목</option></select></label>
          <label className="wide">원천 참조<input required={draft.sourceType === "MANUAL"} value={draft.sourceReference} onChange={(event) => setDraft({ ...draft, sourceReference: event.target.value })} placeholder="인보이스·계약서 번호" /></label>
          <label className="wide">메모<input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
          <button disabled={working}>자산 초안 등록</button>
        </form>
      </article>

      <article className="panel fixed-assets-candidates"><header><div data-korean-heading><h2>구매 입고 후보</h2></div><span>{data?.candidates.length ?? 0}건</span></header>
        <div>{data?.candidates.map((candidate) => <button type="button" key={candidate.id} onClick={() => selectCandidate(candidate)}><span>입고</span><p><strong>{candidate.item_name}</strong><small>{candidate.order_number} · {candidate.vendor_name} · {(candidate.accepted_quantity_milli / 1000).toLocaleString("ko-KR")}개</small></p><em>{won(candidate.accepted_amount)}</em></button>)}{!data?.candidates.length && <p className="fixed-assets-empty">미등록 입고 후보가 없습니다. 품목명만으로 자산을 추정하지 않습니다.</p>}</div>
      </article>
    </section>

    <section className="panel fixed-assets-ledger"><header><div data-korean-heading><h2>자산대장</h2></div><span>{data?.assets.length ?? 0}개</span></header>
      <div className="fixed-assets-row head"><span>자산</span><span>취득·사용개시</span><span>원가·장부가</span><span>상각 조건</span><span>위치·책임자</span><span>상태·증빙</span><span>관리</span></div>
      {data?.assets.map((asset) => <div className={`fixed-assets-row ${asset.status.toLowerCase()}`} key={asset.id}>
        <p><strong>{asset.asset_code} · {asset.name}</strong><small>{categoryLabel[asset.category] ?? asset.category} · {asset.source_reference || asset.source_type}</small></p>
        <span>{asset.acquisition_date}<small>{asset.in_service_date} 사용</small></span><span>{won(asset.acquisition_cost)}<small>장부 {won(asset.acquisition_cost - Number(asset.posted_accumulated || 0))}</small></span>
        <span>정액 {asset.useful_life_months}개월<small>기초누계 {won(asset.opening_accumulated)}{asset.opening_as_of ? ` · ${asset.opening_as_of}` : ""}</small></span><span>{asset.location || "미지정"}<small>{asset.custodian_employee_id || "책임자 미지정"}</small></span>
        <span><em>{statusLabel[asset.status] ?? asset.status}</em><small>증빙 {asset.evidence_count}건</small></span>
        <div>{asset.status === "DRAFT" && <><label>증빙<input type="file" accept=".pdf,.xlsx,.png,.jpg,.jpeg" onChange={(event) => void uploadEvidence(asset, event)} /></label><button type="button" disabled={working || !asset.evidence_count} onClick={() => void mutate({ resource: "asset", action: "ACTIVATE", assetId: asset.id }, "자산을 활성화했습니다.")}>활성화</button></>}{asset.status === "ACTIVE" && <><button type="button" onClick={() => void transfer(asset)}>이동</button><button type="button" onClick={() => void dispose(asset)}>처분</button></>}</div>
      </div>)}{!data?.assets.length && <p className="fixed-assets-empty">등록된 자산이 없습니다. 과거 자료를 임의로 자산대장에 만들지 않았습니다.</p>}
    </section>

    <section className="panel fixed-assets-depreciation"><header><div data-korean-heading><h2>{period} 감가상각</h2><span>정액법 · 원 단위 균등배분 · 사용개시월부터 월할</span></div><button type="button" disabled={working || data?.locked} onClick={() => void mutate({ resource: "depreciation", action: "GENERATE", period }, "월 감가상각 계획을 생성했습니다.")}>상각계획 생성</button></header>
      <div className="fixed-assets-dep-row head"><span>자산</span><span>기초 누계</span><span>당월 상각</span><span>기말 누계</span><span>기말 장부가</span><span>상태</span><span>처리</span></div>
      {data?.schedules.map((schedule) => <div className="fixed-assets-dep-row" key={schedule.id}><p><strong>{schedule.asset_code}</strong><small>{schedule.asset_name}</small></p><span>{won(schedule.opening_accumulated)}</span><span>{won(schedule.depreciation_amount)}</span><span>{won(schedule.closing_accumulated)}</span><span>{won(schedule.closing_book_value)}</span><em>{statusLabel[schedule.status] ?? schedule.status}</em><div>{schedule.status === "PLANNED" && <button type="button" disabled={working || data.locked} onClick={() => void mutate({ resource: "depreciation", action: "CREATE_JOURNAL", scheduleId: schedule.id }, "감가상각 전표 초안을 만들었습니다.")}>전표 초안</button>}{schedule.status === "DRAFTED" && <button type="button" disabled={working || data.locked} onClick={() => void mutate({ resource: "depreciation", action: "POST_JOURNAL", scheduleId: schedule.id }, "감가상각 전표를 승인 전기했습니다.")}>승인 전기</button>}{schedule.status === "POSTED" && <span>전표 {schedule.journal_entry_id.slice(0, 8)}</span>}</div></div>)}
      {!data?.schedules.length && <p className="fixed-assets-empty">이 월의 상각계획이 없습니다. 활성 자산을 확인한 뒤 계획을 생성해 주세요.</p>}
    </section>
  </div>;
}
