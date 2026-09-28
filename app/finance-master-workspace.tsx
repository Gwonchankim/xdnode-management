"use client";

import { FormEvent, useEffect, useState } from "react";
import MasterImpactDialog from "./master-impact-dialog";

type Row = Record<string, string | number | null>;
type MasterData = {
  asOf: string;
  accounts: Row[]; partners: Row[]; aliases: Row[]; banks: Row[]; taxCodes: Row[]; changes: Array<Row & { after?: Record<string, unknown> }>;
  quality: { activeAccounts: number; activePartners: number; unmappedExternalPartners: number; unmappedBankAccounts: number; activeTaxCodes: number; pendingChanges: number };
  unmappedExternalPartners: Array<{ key: string; name: string; customer: boolean; vendor: boolean }>;
};

const categoryLabels: Record<string, string> = { ASSET: "자산", LIABILITY: "부채", EQUITY: "자본", REVENUE: "수익", EXPENSE: "비용", OTHER: "기타" };
const partnerTypeLabels: Record<string, string> = { CUSTOMER: "매출처", VENDOR: "매입처", BOTH: "매출·매입", OTHER: "기타" };
const changeLabels: Record<string, string> = { CREATE: "신규", UPDATE: "수정", DEACTIVATE: "비활성", ACTIVATE: "재활성", SUBMITTED: "결재 중", APPROVED: "승인 완료", REJECTED: "반려" };

export default function FinanceMasterWorkspace() {
  const [data, setData] = useState<MasterData | null>(null);
  const [tab, setTab] = useState<"account" | "partner" | "bank" | "tax" | "change">("account");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [accountDraft, setAccountDraft] = useState({ code: "", name: "", category: "EXPENSE", normalBalance: "DEBIT", reason: "" });
  const [partnerDraft, setPartnerDraft] = useState({ canonicalName: "", businessNumber: "", partnerType: "BOTH", paymentTermsDays: "30", reason: "" });
  const [taxDraft, setTaxDraft] = useState({ code: "", name: "", direction: "BOTH", ratePct: "10", reason: "" });
  const [impactRequest, setImpactRequest] = useState<null | { entityType: string; entityId: string; action: string; proceed: (assessmentId: string) => Promise<boolean> }>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/finance/master-data");
      const result = await response.json() as MasterData & { error?: string };
      if (!response.ok) throw new Error(result.error || "재무 마스터를 불러오지 못했습니다.");
      setData(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "재무 마스터를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  async function submitChange(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/finance/master-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "변경 결재를 제출하지 못했습니다.");
      setMessage(success);
      await load();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "변경 결재를 제출하지 못했습니다.");
      return false;
    } finally { setWorking(false); }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await submitChange({ targetType: "ACCOUNT", changeType: "CREATE", reason: accountDraft.reason, data: accountDraft }, "계정과목 신규 등록을 결재로 제출했습니다.")) setAccountDraft({ code: "", name: "", category: "EXPENSE", normalBalance: "DEBIT", reason: "" });
  }
  async function createPartner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await submitChange({ targetType: "PARTNER", changeType: "CREATE", reason: partnerDraft.reason, data: { ...partnerDraft, paymentTermsDays: Number(partnerDraft.paymentTermsDays) } }, "거래처 신규 등록을 결재로 제출했습니다.")) setPartnerDraft({ canonicalName: "", businessNumber: "", partnerType: "BOTH", paymentTermsDays: "30", reason: "" });
  }
  async function createTax(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await submitChange({ targetType: "TAX", changeType: "CREATE", reason: taxDraft.reason, data: { ...taxDraft, rateBasisPoints: Math.round(Number(taxDraft.ratePct) * 100) } }, "세금코드 신규 등록을 결재로 제출했습니다.")) setTaxDraft({ code: "", name: "", direction: "BOTH", ratePct: "10", reason: "" });
  }
  async function toggleStatus(targetType: "ACCOUNT" | "PARTNER" | "BANK" | "TAX", row: Row) {
    const active = row.status === "ACTIVE";
    const changeType = active ? "DEACTIVATE" : "ACTIVATE";
    setImpactRequest({ entityType: `FINANCE_${targetType}`, entityId: String(row.id), action: changeType, proceed: async (impactAssessmentId) => {
      const reason = window.prompt(`${active ? "비활성" : "재활성"} 사유를 5자 이상 입력해 주세요.`, active ? "더 이상 신규 거래에 사용하지 않음" : "업무 재사용 승인 요청");
      if (!reason) return false;
      return submitChange({ targetType, targetId: row.id, changeType, reason, data: {}, impactAssessmentId }, `${active ? "비활성" : "재활성"} 변경을 결재로 제출했습니다.`);
    } });
  }
  async function mapBank(row: Row) {
    setImpactRequest({ entityType: "FINANCE_BANK", entityId: String(row.id), action: "UPDATE", proceed: async (impactAssessmentId) => {
      const glAccountCode = window.prompt("연결할 활성 계정코드를 입력해 주세요.", String(row.gl_account_code ?? "1039"));
      if (glAccountCode === null) return false;
      const reason = window.prompt("연결 변경 사유를 5자 이상 입력해 주세요.", "은행계좌와 총계정원장 연결");
      if (!reason) return false;
      return submitChange({ targetType: "BANK", targetId: row.id, changeType: "UPDATE", reason, data: { glAccountCode }, impactAssessmentId }, "은행계좌-계정 연결을 결재로 제출했습니다.");
    } });
  }

  const normalized = query.trim().toLowerCase();
  const filterRows = (rows: Row[]) => normalized ? rows.filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(normalized))) : rows;
  const accounts = filterRows(data?.accounts ?? []);
  const partners = filterRows(data?.partners ?? []);
  const banks = filterRows(data?.banks ?? []);
  const taxCodes = filterRows(data?.taxCodes ?? []);

  return <div className="finance-master-workspace">
    <section className="finance-master-hero">
      <div data-korean-heading><h1>통합 재무 마스터</h1><span>계정과목·거래처·은행계좌·세금코드를 한 기준으로 통제하고 변경은 결재 후 반영합니다.</span></div>
      <div><small>기준일</small><strong>{data?.asOf ?? "—"}</strong><em>과거 전표 스냅샷 보존</em></div>
    </section>

    {message && <p className="finance-master-message" role="status">{message}</p>}
    {loading && <section className="panel finance-master-loading">기존 계정·거래처·계좌와 외부 코드 연결상태를 점검하고 있습니다.</section>}

    {!loading && data && <>
      <section className="finance-master-quality">
        <article><small>활성 계정과목</small><strong>{data.quality.activeAccounts}개</strong><span>2025 시산표 기준 시드</span></article>
        <article><small>활성 거래처</small><strong>{data.quality.activePartners}곳</strong><span>영업·구매 기존 원장 연결</span></article>
        <article className={data.quality.unmappedExternalPartners ? "warning" : ""}><small>외부 거래처 미연결</small><strong>{data.quality.unmappedExternalPartners}곳</strong><span>정확 일치만 자동 판정</span></article>
        <article className={data.quality.unmappedBankAccounts ? "warning" : ""}><small>계좌 GL 미연결</small><strong>{data.quality.unmappedBankAccounts}개</strong><span>은행계좌별 원장 연결 필요</span></article>
        <article className={!data.quality.activeTaxCodes ? "warning" : ""}><small>활성 세금코드</small><strong>{data.quality.activeTaxCodes}개</strong><span>실제 코드 수신 전 임의 생성 안 함</span></article>
        <article><small>변경 결재 중</small><strong>{data.quality.pendingChanges}건</strong><span>승인 후에만 운영 반영</span></article>
      </section>

      <section className="panel finance-master-panel">
        <header>
          <nav aria-label="재무 마스터 구분">
            {([['account','계정과목'],['partner','거래처'],['bank','은행계좌'],['tax','세금코드'],['change','변경이력']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}
          </nav>
          <label>마스터 검색<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="코드·명칭·출처" /></label>
        </header>

        {tab === "account" && <>
          <form className="finance-master-create" onSubmit={createAccount}>
            <label>계정코드<input required value={accountDraft.code} onChange={(event) => setAccountDraft({ ...accountDraft, code: event.target.value })} /></label>
            <label>계정명<input required value={accountDraft.name} onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })} /></label>
            <label>분류<select value={accountDraft.category} onChange={(event) => setAccountDraft({ ...accountDraft, category: event.target.value, normalBalance: ["LIABILITY","EQUITY","REVENUE"].includes(event.target.value) ? "CREDIT" : "DEBIT" })}>{Object.entries(categoryLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>정상잔액<select value={accountDraft.normalBalance} onChange={(event) => setAccountDraft({ ...accountDraft, normalBalance: event.target.value })}><option value="DEBIT">차변</option><option value="CREDIT">대변</option></select></label>
            <label className="reason">변경 사유<input required minLength={5} value={accountDraft.reason} onChange={(event) => setAccountDraft({ ...accountDraft, reason: event.target.value })} /></label>
            <button disabled={working}>신규 결재 제출</button>
          </form>
          <div className="finance-master-row head"><span>코드·계정명</span><span>분류</span><span>정상잔액</span><span>출처</span><span>상태</span><span>관리</span></div>
          {accounts.map((row) => <div className={`finance-master-row ${String(row.status).toLowerCase()}`} key={String(row.id)}><p><strong>{row.code}</strong><span>{row.name}</span></p><span>{categoryLabels[String(row.category)] ?? row.category}</span><span>{row.normal_balance === "CREDIT" ? "대변" : "차변"}</span><span>{row.source}</span><em>{row.status === "ACTIVE" ? "사용" : "비활성"}</em><button type="button" onClick={() => void toggleStatus("ACCOUNT", row)}>{row.status === "ACTIVE" ? "비활성 요청" : "재활성 요청"}</button></div>)}
        </>}

        {tab === "partner" && <>
          <form className="finance-master-create" onSubmit={createPartner}>
            <label>거래처명<input required value={partnerDraft.canonicalName} onChange={(event) => setPartnerDraft({ ...partnerDraft, canonicalName: event.target.value })} /></label>
            <label>사업자번호<input value={partnerDraft.businessNumber} onChange={(event) => setPartnerDraft({ ...partnerDraft, businessNumber: event.target.value })} /></label>
            <label>유형<select value={partnerDraft.partnerType} onChange={(event) => setPartnerDraft({ ...partnerDraft, partnerType: event.target.value })}>{Object.entries(partnerTypeLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>지급조건<input type="number" min="0" max="365" value={partnerDraft.paymentTermsDays} onChange={(event) => setPartnerDraft({ ...partnerDraft, paymentTermsDays: event.target.value })} /><small>일</small></label>
            <label className="reason">변경 사유<input required minLength={5} value={partnerDraft.reason} onChange={(event) => setPartnerDraft({ ...partnerDraft, reason: event.target.value })} /></label>
            <button disabled={working}>신규 결재 제출</button>
          </form>
          <div className="finance-master-row partner head"><span>거래처</span><span>사업자번호</span><span>유형</span><span>지급조건</span><span>상태</span><span>관리</span></div>
          {partners.map((row) => <div className={`finance-master-row partner ${String(row.status).toLowerCase()}`} key={String(row.id)}><p><strong>{row.canonical_name}</strong><span>{row.source}</span></p><span>{row.business_number || "—"}</span><span>{partnerTypeLabels[String(row.partner_type)] ?? row.partner_type}</span><span>{row.payment_terms_days}일</span><em>{row.status === "ACTIVE" ? "사용" : "비활성"}</em><button type="button" onClick={() => void toggleStatus("PARTNER", row)}>{row.status === "ACTIVE" ? "비활성 요청" : "재활성 요청"}</button></div>)}
          {data.unmappedExternalPartners.length > 0 && <aside className="finance-master-unmapped"><strong>Clobe 거래처 미연결 후보</strong><span>자동 병합하지 않고 명칭·사업자번호를 확인해 연결합니다.</span><div>{data.unmappedExternalPartners.slice(0, 12).map((row) => <i key={row.key}>{row.name} · {row.customer && row.vendor ? "매출·매입" : row.customer ? "매출" : "매입"}</i>)}</div></aside>}
        </>}

        {tab === "bank" && <>
          <div className="finance-master-guidance">계좌번호 전체값은 저장하지 않으며, Clobe 계좌 ID·은행·끝 4자리만 보관합니다. 연결 변경은 결재 후 반영됩니다.</div>
          <div className="finance-master-row bank head"><span>계좌명</span><span>은행·끝자리</span><span>유형·통화</span><span>연결 GL</span><span>상태</span><span>관리</span></div>
          {banks.map((row) => <div className={`finance-master-row bank ${String(row.status).toLowerCase()}`} key={String(row.id)}><p><strong>{row.account_name}</strong><span>Clobe #{row.source_account_id}</span></p><span>{row.bank_code} · {row.last4}</span><span>{row.account_type} · {row.currency}</span><span>{row.gl_account_code || "미연결"}</span><em>{row.status === "ACTIVE" ? "사용" : "비활성"}</em><button type="button" onClick={() => void mapBank(row)}>GL 연결</button></div>)}
        </>}

        {tab === "tax" && <>
          <form className="finance-master-create" onSubmit={createTax}>
            <label>세금코드<input required value={taxDraft.code} onChange={(event) => setTaxDraft({ ...taxDraft, code: event.target.value })} /></label>
            <label>명칭<input required value={taxDraft.name} onChange={(event) => setTaxDraft({ ...taxDraft, name: event.target.value })} /></label>
            <label>적용방향<select value={taxDraft.direction} onChange={(event) => setTaxDraft({ ...taxDraft, direction: event.target.value })}><option value="BOTH">매출·매입</option><option value="SALES">매출</option><option value="PURCHASE">매입</option></select></label>
            <label>세율<input type="number" min="0" max="100" step="0.01" value={taxDraft.ratePct} onChange={(event) => setTaxDraft({ ...taxDraft, ratePct: event.target.value })} /><small>%</small></label>
            <label className="reason">변경 사유<input required minLength={5} value={taxDraft.reason} onChange={(event) => setTaxDraft({ ...taxDraft, reason: event.target.value })} /></label>
            <button disabled={working}>신규 결재 제출</button>
          </form>
          {!taxCodes.length && <div className="finance-master-empty"><strong>등록된 세금코드가 없습니다.</strong><span>실제 이카운트 세금코드 목록을 확인한 뒤 위에서 등록해 주세요. 시스템이 임의 코드를 만들지 않습니다.</span></div>}
          {taxCodes.map((row) => <div className={`finance-master-row ${String(row.status).toLowerCase()}`} key={String(row.id)}><p><strong>{row.code}</strong><span>{row.name}</span></p><span>{row.direction}</span><span>{Number(row.rate_basis_points) / 100}%</span><span>MANUAL</span><em>{row.status === "ACTIVE" ? "사용" : "비활성"}</em><button type="button" onClick={() => void toggleStatus("TAX", row)}>{row.status === "ACTIVE" ? "비활성 요청" : "재활성 요청"}</button></div>)}
        </>}

        {tab === "change" && <>
          <div className="finance-master-row change head"><span>대상·변경</span><span>사유</span><span>요청자</span><span>요청일시</span><span>상태</span><span>결재</span></div>
          {data.changes.map((row) => <div className="finance-master-row change" key={String(row.id)}><p><strong>{row.target_type} · {changeLabels[String(row.change_type)]}</strong><span>{String(row.target_id).slice(0, 12)}</span></p><span>{row.reason}</span><span>{row.created_by}</span><span>{new Date(Number(row.created_at)).toLocaleString("ko-KR")}</span><em>{changeLabels[String(row.status)] ?? row.status}</em><span>{String(row.approval_id || "—").slice(0, 10)}</span></div>)}
          {!data.changes.length && <div className="finance-master-empty"><strong>변경 이력이 없습니다.</strong><span>신규·수정·비활성 요청은 모두 이곳과 전자결재에 함께 남습니다.</span></div>}
        </>}
      </section>
    </>}
    {impactRequest && <MasterImpactDialog entityType={impactRequest.entityType} entityId={impactRequest.entityId} action={impactRequest.action} onClose={() => setImpactRequest(null)} onProceed={impactRequest.proceed} />}
  </div>;
}
