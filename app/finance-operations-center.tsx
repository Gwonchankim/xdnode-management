"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { financeCurrentData } from "./finance-current-data";

type ForecastItem = {
  id: string; expectedDate: string; direction: "INFLOW" | "OUTFLOW"; category: string;
  counterparty: string; amount: number; probability: number; scenario: string; status: string; memo: string;
};
type CloseTask = { id: string; period: string; category: string; title: string; ownerEmployeeId: string; status: string };
type BudgetItem = { id: string; fiscalYear: number; month: number; department: string; accountCode: string; accountName: string; amount: number; status: string };
type ExpenseItem = {
  id: string; requestKind: "EXPENSE" | "PAYMENT"; title: string; vendor: string; amount: number;
  requestedDate: string; dueDate: string; accountCode: string; accountName: string; paymentMethod: string;
  memo: string; status: string; requesterEmployeeId: string; approvedBy: string; paidBy: string;
  sourceType: string; sourceId: string; journalStatus: string; evidenceRequired: boolean; evidenceCount: number;
};
type PaymentItem = { id: string; requestId: string; paymentDate: string; amount: number; paymentMethod: string; bankReference: string; paidBy: string; status: string };
type JournalItem = {
  id: string; paymentRequestId: string; voucherDate: string; description: string;
  debitAccountCode: string; debitAccountName: string; creditAccountCode: string;
  creditAccountName: string; amount: number; status: string; preparedBy: string; postedBy: string;
};
type MasterAccount = { id: string; code: string; name: string; status: string };
type MasterPartner = { id: string; canonical_name: string; status: string };
type OperationsData = {
  asOf: string;
  sourceStatus: Record<string, "LIVE" | "IMPORTED" | "MANUAL" | "AUTOMATED" | "NOT_CONNECTED">;
  forecast: ForecastItem[];
  closeTasks: CloseTask[];
  budgets: BudgetItem[];
  reconciliations: unknown[];
  reconciliationSummary: { bankTransactions: number; confirmedMatches: number };
  expenses: ExpenseItem[];
  payments: PaymentItem[];
  journals: JournalItem[];
};

const statusLabel: Record<string, string> = {
  LIVE: "실시간 연동", IMPORTED: "가져온 자료", MANUAL: "수기 관리", AUTOMATED: "자동 계산", NOT_CONNECTED: "미연결",
  OPEN: "미착수", IN_PROGRESS: "진행 중", COMPLETED: "완료", APPROVED: "승인 완료",
  EXPECTED: "예정", CONFIRMED: "확정", CANCELLED: "취소",
  DRAFT: "작성 중", SUBMITTED: "검토 요청",
  REJECTED: "반려", PAID: "지급 완료", READY: "분개 준비", POSTED: "전기 완료",
};

function won(value: number) {
  return `₩${Math.round(value).toLocaleString("ko-KR")}`;
}

export default function FinanceOperationsCenter({ onOpenBudget }: { onOpenBudget: () => void }) {
  const [data, setData] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [masterAccounts, setMasterAccounts] = useState<MasterAccount[]>([]);
  const [masterPartners, setMasterPartners] = useState<MasterPartner[]>([]);
  const [forecastDraft, setForecastDraft] = useState({ expectedDate: financeCurrentData.asOf, direction: "INFLOW", category: "매출대금", counterparty: "", amount: "", probability: "100", memo: "" });
  const [expenseDraft, setExpenseDraft] = useState({ requestKind: "EXPENSE", title: "", vendor: "", amount: "", requestedDate: financeCurrentData.asOf, dueDate: "", accountCode: "", accountName: "", paymentMethod: "BANK_TRANSFER", memo: "" });

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/finance/operations");
      const result = await response.json() as OperationsData & { error?: string };
      if (!response.ok) throw new Error(result.error || "재무 운영 데이터를 불러오지 못했습니다.");
      setData(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "재무 운영 데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    fetch("/api/finance/master-data").then(async (response) => {
      const result = await response.json() as { accounts?: MasterAccount[]; partners?: MasterPartner[] };
      if (response.ok) {
        setMasterAccounts((result.accounts ?? []).filter((item) => item.status === "ACTIVE"));
        setMasterPartners((result.partners ?? []).filter((item) => item.status === "ACTIVE"));
      }
    }).catch(() => undefined);
  }, []);

  const weightedForecast = useMemo(() => (data?.forecast ?? []).reduce((sum, item) => {
    if (["CANCELLED", "COMPLETED"].includes(item.status)) return sum;
    const signed = item.direction === "INFLOW" ? item.amount : -item.amount;
    return sum + signed * (item.probability / 100);
  }, 0), [data]);
  const openingCash = financeCurrentData.accountSummary.checkingBalanceSum + financeCurrentData.accountSummary.fxBalanceSumKrw;
  const closeCompleted = data?.closeTasks.filter((item) => ["COMPLETED", "APPROVED"].includes(item.status)).length ?? 0;

  async function createItem(event: FormEvent<HTMLFormElement>, resource: "forecast") {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/finance/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource, ...forecastDraft, amount: Number(forecastDraft.amount), probability: Number(forecastDraft.probability) }),
    });
    const result = await response.json() as { error?: string; approvalSubmitted?: boolean };
    if (!response.ok) {
      setMessage(result.error || "저장하지 못했습니다.");
      return;
    }
    setMessage("자금예측 항목을 저장했습니다.");
    setForecastDraft((current) => ({ ...current, counterparty: "", amount: "", memo: "" }));
    await load();
  }

  async function updateStatus(resource: "close" | "forecast", id: string, status: string) {
    setMessage("");
    const response = await fetch("/api/finance/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, id, status }),
    });
    const result = await response.json() as { error?: string; approvalSubmitted?: boolean };
    if (!response.ok) {
      setMessage(result.error || "상태를 변경하지 못했습니다.");
      return;
    }
    setMessage(result.approvalSubmitted ? "전자결재를 제출했습니다. 승인 후 상태가 반영됩니다." : "상태를 변경했습니다.");
    await load();
  }

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/finance/operations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "expense", ...expenseDraft, amount: Number(expenseDraft.amount) }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "지출·지급 요청을 저장하지 못했습니다.");
    setExpenseDraft((current) => ({ ...current, title: "", vendor: "", amount: "", dueDate: "", accountCode: "", accountName: "", memo: "" }));
    setMessage("요청 초안을 저장했습니다. 증빙을 첨부한 뒤 결재를 제출해 주세요.");
    await load();
  }

  async function uploadEvidence(expenseId: string, file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.append("module", "finance");
    form.append("entityType", "financeExpense");
    form.append("entityId", expenseId);
    form.append("category", "EVIDENCE");
    form.append("file", file);
    const response = await fetch("/api/documents", { method: "POST", body: form });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "증빙을 저장하지 못했습니다.");
    setMessage("증빙을 안전하게 저장했습니다.");
    await load();
  }

  async function expenseAction(item: ExpenseItem, action: "SUBMIT" | "PAY" | "CREATE_JOURNAL") {
    const paymentDate = action === "PAY" ? window.prompt("지급일을 YYYY-MM-DD 형식으로 입력하세요.", financeCurrentData.asOf) : "";
    if (action === "PAY" && !paymentDate) return;
    const bankReference = action === "PAY" ? window.prompt("은행 이체번호 또는 지급 참조값을 입력하세요. (선택)", "") ?? "" : "";
    const voucherDate = action === "CREATE_JOURNAL" ? window.prompt("전표일을 YYYY-MM-DD 형식으로 입력하세요.", financeCurrentData.asOf) : "";
    if (action === "CREATE_JOURNAL" && !voucherDate) return;
    const debitAccountName = action === "CREATE_JOURNAL" ? window.prompt("차변 계정명을 입력하세요.", item.accountName || "지급수수료") : "";
    if (action === "CREATE_JOURNAL" && !debitAccountName) return;
    const creditAccountName = action === "CREATE_JOURNAL" ? window.prompt("대변 계정명을 입력하세요.", "보통예금") : "";
    if (action === "CREATE_JOURNAL" && !creditAccountName) return;
    const description = action === "CREATE_JOURNAL" ? window.prompt("전표 적요를 입력하세요.", `${item.vendor ? `${item.vendor} · ` : ""}${item.title}`) : "";
    if (action === "CREATE_JOURNAL" && !description) return;
    const response = await fetch("/api/finance/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "expense", id: item.id, action, paymentDate, paymentMethod: item.paymentMethod, bankReference,
        voucherDate, debitAccountCode: item.accountCode, debitAccountName, creditAccountName, description }),
    });
    const result = await response.json() as { error?: string; approvalSubmitted?: boolean };
    if (!response.ok) return setMessage(result.error || "요청을 처리하지 못했습니다.");
    setMessage(action === "PAY" ? "지급원장에 반영했으며 분개 준비 상태로 전환했습니다."
      : action === "CREATE_JOURNAL" ? "차변·대변을 확인한 전표 초안을 만들었습니다. 전기 전 최종 검토해 주세요."
        : "전자결재를 제출했습니다. 최종 승인 후 지급할 수 있습니다.");
    await load();
  }

  async function postJournal(item: JournalItem) {
    if (!window.confirm(`${item.voucherDate} ${item.description}\n차변 ${item.debitAccountName} / 대변 ${item.creditAccountName}\n${won(item.amount)}을 전기할까요?`)) return;
    const response = await fetch("/api/finance/operations", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "journal", id: item.id, action: "POST" }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "전표를 전기하지 못했습니다.");
    setMessage("전표를 전기하고 지출·지급 요청과 연결했습니다.");
    await load();
  }

  if (loading && !data) return <section className="panel finance-control-loading">재무 운영 데이터를 확인하고 있습니다…</section>;

  return <div className="finance-control-room">
    <section className="finance-control-hero">
      <div data-korean-heading><h1>재무 운영센터</h1><span>예측·마감·예산·대사 상태를 한 화면에서 관리합니다.</span></div>
      <div className="finance-control-source"><small>기준일</small><strong>{data?.asOf ?? financeCurrentData.asOf}</strong><em>Clobe 스냅샷</em></div>
    </section>

    {message && <div className="finance-control-message" role="status">{message}</div>}

    <section className="finance-control-metrics">
      <article><small>은행성 자산</small><strong>{won(openingCash)}</strong><span>실제 스냅샷 기준</span></article>
      <article><small>가중 예상 순변동</small><strong>{won(weightedForecast)}</strong><span>등록된 향후 입출금</span></article>
      <article><small>월마감 진척</small><strong>{closeCompleted}/{data?.closeTasks.length ?? 0}</strong><span>완료·승인 항목</span></article>
      <article><small>예산·실적</small><strong>전용</strong><span>버전·실적·차이조치 통합</span></article>
    </section>

    <section className="panel finance-control-panel expense-panel">
      <header><div data-korean-heading><h2>지출·지급 요청과 지급원장</h2></div><span>{data?.expenses.length ?? 0}건</span></header>
      <form className="finance-control-form expense-form" onSubmit={createExpense}>
        <label>구분<select value={expenseDraft.requestKind} onChange={(event) => setExpenseDraft({ ...expenseDraft, requestKind: event.target.value })}><option value="EXPENSE">지출 결의</option><option value="PAYMENT">지급 요청</option></select></label>
        <label>제목<input required value={expenseDraft.title} onChange={(event) => setExpenseDraft({ ...expenseDraft, title: event.target.value })} /></label>
        <label>거래처<select value={expenseDraft.vendor} onChange={(event) => setExpenseDraft({ ...expenseDraft, vendor: event.target.value })}><option value="">선택 안 함</option>{masterPartners.map((item) => <option key={item.id} value={item.canonical_name}>{item.canonical_name}</option>)}</select></label>
        <label>금액<input required type="number" min="1" value={expenseDraft.amount} onChange={(event) => setExpenseDraft({ ...expenseDraft, amount: event.target.value })} /></label>
        <label>요청일<input required type="date" value={expenseDraft.requestedDate} onChange={(event) => setExpenseDraft({ ...expenseDraft, requestedDate: event.target.value })} /></label>
        <label>지급예정일<input type="date" value={expenseDraft.dueDate} onChange={(event) => setExpenseDraft({ ...expenseDraft, dueDate: event.target.value })} /></label>
        <label>계정과목<select value={expenseDraft.accountCode} onChange={(event) => { const account = masterAccounts.find((item) => item.code === event.target.value); setExpenseDraft({ ...expenseDraft, accountCode: account?.code ?? "", accountName: account?.name ?? "" }); }}><option value="">선택 안 함</option>{masterAccounts.map((item) => <option key={item.id} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
        <label>지급수단<select value={expenseDraft.paymentMethod} onChange={(event) => setExpenseDraft({ ...expenseDraft, paymentMethod: event.target.value })}><option value="BANK_TRANSFER">계좌이체</option><option value="CORPORATE_CARD">법인카드</option><option value="AUTO_DEBIT">자동이체</option><option value="CASH">현금</option></select></label>
        <button type="submit">+ 요청 초안</button>
      </form>
      <div className="expense-ledger">
        <div className="expense-row head"><span>요청</span><span>거래처·계정</span><span>금액</span><span>증빙</span><span>상태</span><span>처리</span></div>
        {(data?.expenses ?? []).map((item) => <div className="expense-row" key={item.id}>
          <p><strong>{item.title}</strong><small>{item.sourceType === "PAYROLL_RUN" ? "급여 마감 자동연결" : item.sourceType === "PURCHASE_INVOICE" ? "구매 인보이스 자동연결" : item.requestKind === "PAYMENT" ? "지급 요청" : "지출 결의"} · {item.requestedDate}</small></p>
          <p><strong>{item.vendor || "거래처 미입력"}</strong><small>{item.accountName || "계정 미지정"}</small></p>
          <b>{won(item.amount)}</b>
          <label className="expense-evidence"><input type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv" disabled={item.status !== "DRAFT"} onChange={(event) => void uploadEvidence(item.id, event.target.files?.[0])} /><span>{item.evidenceCount ? `${item.evidenceCount}개 첨부` : "증빙 첨부"}</span></label>
          <em className={`expense-status ${item.status.toLowerCase()}`}>{statusLabel[item.status] ?? item.status}{item.status === "PAID" ? ` · ${statusLabel[item.journalStatus] ?? item.journalStatus}` : ""}</em>
          <div>{item.status === "DRAFT" && <button type="button" onClick={() => void expenseAction(item, "SUBMIT")}>결재 제출</button>}{item.status === "APPROVED" && <button type="button" onClick={() => void expenseAction(item, "PAY")}>지급 반영</button>}{item.status === "PAID" && item.journalStatus === "READY" && <button type="button" onClick={() => void expenseAction(item, "CREATE_JOURNAL")}>전표 작성</button>}</div>
        </div>)}
        {!data?.expenses.length && <div className="finance-empty">지출 또는 지급 초안을 등록하고 증빙을 첨부하면 결재와 지급원장까지 연결됩니다.</div>}
      </div>
      <div className="journal-ledger">
        <h3>회계전표</h3>
        <div className="journal-row head"><span>전표일·적요</span><span>차변</span><span>대변</span><span>금액</span><span>상태</span><span>처리</span></div>
        {(data?.journals ?? []).map((item) => <div className="journal-row" key={item.id}>
          <p><strong>{item.voucherDate}</strong><small>{item.description}</small></p>
          <p><strong>{item.debitAccountName}</strong><small>{item.debitAccountCode || "코드 미입력"}</small></p>
          <p><strong>{item.creditAccountName}</strong><small>{item.creditAccountCode || "코드 미입력"}</small></p>
          <b>{won(item.amount)}</b><em className={`expense-status ${item.status.toLowerCase()}`}>{statusLabel[item.status] ?? item.status}</em>
          <div>{item.status === "DRAFT" && <button type="button" onClick={() => void postJournal(item)}>전기</button>}</div>
        </div>)}
        {!data?.journals.length && <div className="finance-empty">지급 완료 건에서 차변·대변 계정을 확인하면 전표 초안이 이곳에 생성됩니다.</div>}
      </div>
    </section>

    <section className="finance-control-grid">
      <article className="panel finance-control-panel forecast-panel">
        <header><div data-korean-heading><h2>13주 자금예측</h2></div><span className={`source-state ${(data?.sourceStatus.forecast ?? "NOT_CONNECTED").toLowerCase()}`}>{statusLabel[data?.sourceStatus.forecast ?? "NOT_CONNECTED"]}</span></header>
        <form className="finance-control-form forecast-form" onSubmit={(event) => void createItem(event, "forecast")}>
          <label>예정일<input required type="date" value={forecastDraft.expectedDate} onChange={(event) => setForecastDraft({ ...forecastDraft, expectedDate: event.target.value })} /></label>
          <label>구분<select value={forecastDraft.direction} onChange={(event) => setForecastDraft({ ...forecastDraft, direction: event.target.value })}><option value="INFLOW">입금</option><option value="OUTFLOW">출금</option></select></label>
          <label>분류<input required value={forecastDraft.category} onChange={(event) => setForecastDraft({ ...forecastDraft, category: event.target.value })} /></label>
          <label>거래처<input value={forecastDraft.counterparty} onChange={(event) => setForecastDraft({ ...forecastDraft, counterparty: event.target.value })} /></label>
          <label>금액<input required min="1" type="number" value={forecastDraft.amount} onChange={(event) => setForecastDraft({ ...forecastDraft, amount: event.target.value })} /></label>
          <label>확률 %<input required min="0" max="100" type="number" value={forecastDraft.probability} onChange={(event) => setForecastDraft({ ...forecastDraft, probability: event.target.value })} /></label>
          <button type="submit">+ 예측 항목 추가</button>
        </form>
        <div className="finance-control-list">
          {(data?.forecast ?? []).map((item) => <div key={item.id}>
            <time>{item.expectedDate}</time><p><strong>{item.counterparty || item.category}</strong><small>{item.category} · 확률 {item.probability}%</small></p>
            <b className={item.direction === "INFLOW" ? "positive" : "negative"}>{item.direction === "INFLOW" ? "+" : "-"}{won(item.amount)}</b>
            <select aria-label={`${item.counterparty || item.category} 상태`} value={item.status} onChange={(event) => void updateStatus("forecast", item.id, event.target.value)}><option value="EXPECTED">예정</option><option value="CONFIRMED">확정</option><option value="COMPLETED">완료</option><option value="CANCELLED">취소</option></select>
          </div>)}
          {!data?.forecast.length && <div className="finance-empty">자동 원장은 좌측 ‘13주 자금예측’에서 계산됩니다. 이 영역에는 아직 발생 원장이 없는 수기 계획만 등록합니다.</div>}
        </div>
      </article>

      <article className="panel finance-control-panel close-panel">
        <header><div data-korean-heading><h2>월마감 체크리스트</h2></div><span>{data?.closeTasks[0]?.period ?? financeCurrentData.asOf.slice(0, 7)}</span></header>
        <div className="finance-close-progress"><i><b style={{ width: `${data?.closeTasks.length ? closeCompleted / data.closeTasks.length * 100 : 0}%` }} /></i><strong>{data?.closeTasks.length ? Math.round(closeCompleted / data.closeTasks.length * 100) : 0}%</strong></div>
        <div className="finance-close-list">
          {(data?.closeTasks ?? []).map((item) => { const automated = ["BANK", "JOURNAL", "EVIDENCE", "PAYROLL"].includes(item.category); return <div key={item.id}><span>{["COMPLETED", "APPROVED"].includes(item.status) ? "✓" : "·"}</span><p><strong>{item.title}</strong><small>{item.category}{automated ? " · 자동 통제" : ""}</small></p><select disabled={automated} aria-label={`${item.title} 상태`} value={item.status === "APPROVED" ? "COMPLETED" : item.status} onChange={(event) => void updateStatus("close", item.id, event.target.value)}><option value="OPEN">미착수</option><option value="IN_PROGRESS">진행 중</option><option value="COMPLETED">완료</option></select></div>; })}
        </div>
      </article>

      <article className="panel finance-control-panel budget-panel">
        <header><div data-korean-heading><h2>예산·실적 관리</h2></div><span className="source-state automated">통합 관리</span></header>
        <div className="reconciliation-readiness"><div><span>01</span><p><strong>계획 버전 승인</strong><small>연간 계획 전체를 하나의 버전으로 결재</small></p><em>전자결재</em></div><div><span>02</span><p><strong>실적 원천 자동 연결</strong><small>Clobe 매출·매입과 ERP 전기 분개</small></p><em>자동 계산</em></div><div><span>03</span><p><strong>차이 원인·조치</strong><small>담당자·기한·개정 사유까지 감사 추적</small></p><em>통제 원장</em></div></div>
        <p className="finance-control-note">기존 행 단위 예산 입력은 종료했습니다. 승인 예산과 실제값은 전용 화면에서 버전 단위로 관리합니다.</p>
        <button type="button" className="finance-control-primary" onClick={onOpenBudget}>예산·실적 관리 열기 →</button>
      </article>

      <article className="panel finance-control-panel reconciliation-panel">
        <header><div data-korean-heading><h2>은행·분개 대사</h2></div><span className={`source-state ${(data?.sourceStatus.journalMatching ?? "NOT_CONNECTED").toLowerCase()}`}>{statusLabel[data?.sourceStatus.journalMatching ?? "NOT_CONNECTED"]}</span></header>
        <div className="reconciliation-readiness">
          <div><span>01</span><p><strong>은행 거래 원문</strong><small>거래일·입출금액·적요·계좌 식별값 필요</small></p><em>{statusLabel[data?.sourceStatus.bankTransactionLines ?? "NOT_CONNECTED"]}</em></div>
          <div><span>02</span><p><strong>분개 라인 식별값</strong><small>전표번호·라인번호·계정코드 필요</small></p><em>{statusLabel[data?.sourceStatus.journalMatching ?? "NOT_CONNECTED"]}</em></div>
          <div><span>03</span><p><strong>자동 후보·사용자 확정</strong><small>금액·일자·적요 점수로 후보를 제시하고 사람이 확정</small></p><em>{data?.reconciliationSummary.confirmedMatches ? `${data.reconciliationSummary.confirmedMatches}건 확정` : "확정 대기"}</em></div>
        </div>
        <p className="finance-control-note">Clobe 거래 원문 {data?.reconciliationSummary.bankTransactions ?? 0}건을 가져왔습니다. 좌측 ‘자금 대사’에서 자동 후보를 검토하고 확정·부분 배분·해제할 수 있습니다.</p>
      </article>
    </section>
  </div>;
}
