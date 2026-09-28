"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { companyEmployees } from "./hr-company-data";

type Card = { id: string; issuer: string; nickname: string; last4: string; holder_employee_id: string; monthly_limit: number; status: string };
type CardTransaction = { id: string; card_id: string; external_reference: string; transaction_date: string; merchant: string; amount: number;
  currency: string; direction: string; status: string; expense_request_id: string; exclusion_reason: string; issuer: string; nickname: string;
  last4: string; holder_employee_id: string; expense_title: string; expense_status: string };
type EvidenceDocument = { id: string; category: string; version: number; fileName: string; uploadedBy: string; createdAt: number; downloadUrl: string };
type Expense = { id: string; title: string; vendor: string; amount: number; requested_date: string; account_name: string; payment_method: string;
  status: string; requester_employee_id: string; evidence_required: number; business_purpose: string; evidence_status: string;
  evidence_document_id: string; card_transaction_id: string; tax_treatment: string; review_note: string; reviewed_by: string;
  reviewed_at: number | null; payment_id: string; payment_date: string; evidence_count: number; bank_matched_amount: number;
  bank_remaining_amount: number; duplicate_count: number; documents: EvidenceDocument[] };
type Data = { asOf: string; currentPeriod: string; period: string; locked: boolean; cards: Card[]; transactions: CardTransaction[];
  expenses: Expense[]; summary: { activeCards: number; cardTransactions: number; unmatchedCards: number; pendingEvidence: number;
    bankUnmatched: number; duplicateCandidates: number }; sourceNote: string };
type ReviewDraft = { businessPurpose: string; evidenceStatus: string; evidenceDocumentId: string; taxTreatment: string; reviewNote: string };

const won = (value: number) => `₩${Number(value || 0).toLocaleString("ko-KR")}`;
const paymentLabel: Record<string, string> = { BANK_TRANSFER: "계좌이체", CORPORATE_CARD: "법인카드", AUTO_DEBIT: "자동이체", CASH: "현금" };
const evidenceLabel: Record<string, string> = { PENDING: "검토 대기", VERIFIED: "증빙 확인", EXEMPT: "예외 승인" };
const taxLabel: Record<string, string> = { UNREVIEWED: "미검토", DEDUCTIBLE: "공제", NONDEDUCTIBLE: "불공제", OUT_OF_SCOPE: "대상 외" };
const initialCard = { issuer: "", nickname: "", last4: "", holderEmployeeId: "", monthlyLimit: "0" };
const initialTransaction = { cardId: "", externalReference: "", transactionDate: "", merchant: "", amount: "", direction: "CHARGE" };

export default function ExpenseControlWorkspace() {
  const [data, setData] = useState<Data | null>(null); const [period, setPeriod] = useState("");
  const [loading, setLoading] = useState(true); const [working, setWorking] = useState(false); const [message, setMessage] = useState("");
  const [cardDraft, setCardDraft] = useState(initialCard); const [transactionDraft, setTransactionDraft] = useState(initialTransaction);
  const [matches, setMatches] = useState<Record<string, string>>({}); const [reviews, setReviews] = useState<Record<string, ReviewDraft>>({});

  async function load(selected = period) {
    setLoading(true); setMessage("");
    try { const response = await fetch(`/api/finance/expense-control${selected ? `?period=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      const result = await response.json() as Data & { error?: string }; if (!response.ok) throw new Error(result.error || "지출통제 원장을 불러오지 못했습니다.");
      setData(result); setPeriod(result.period); setTransactionDraft((current) => ({ ...current, transactionDate: current.transactionDate || result.asOf,
        cardId: current.cardId || result.cards.find((card) => card.status === "ACTIVE")?.id || "" }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "지출통제 원장을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true; fetch("/api/finance/expense-control", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as Data & { error?: string } }))
      .then(({ response, result }) => { if (!active) return; if (!response.ok) setMessage(result.error || "지출통제 원장을 불러오지 못했습니다.");
        else { setData(result); setPeriod(result.period); setTransactionDraft((current) => ({ ...current, transactionDate: result.asOf,
          cardId: result.cards.find((card) => card.status === "ACTIVE")?.id || "" })); } setLoading(false); })
      .catch(() => { if (active) { setMessage("지출통제 원장을 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  async function mutate(payload: Record<string, unknown>, success: string) {
    setWorking(true); setMessage("");
    try { const response = await fetch("/api/finance/expense-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "지출통제 작업을 처리하지 못했습니다.");
      setMessage(success); await load(period); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "지출통제 작업을 처리하지 못했습니다."); return false; }
    finally { setWorking(false); }
  }

  async function createCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (await mutate({ action: "CREATE_CARD", ...cardDraft, monthlyLimit: Number(cardDraft.monthlyLimit) }, "법인카드를 등록했습니다.")) setCardDraft(initialCard);
  }
  async function registerTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (await mutate({ action: "REGISTER_TRANSACTION", ...transactionDraft, amount: Number(transactionDraft.amount), currency: "KRW" }, "카드 거래를 등록했습니다."))
      setTransactionDraft((current) => ({ ...initialTransaction, cardId: current.cardId, transactionDate: data?.asOf ?? "" }));
  }
  async function uploadEvidence(expense: Expense, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setWorking(true); setMessage("");
    const form = new FormData(); form.append("module", "finance"); form.append("entityType", "financeExpense"); form.append("entityId", expense.id);
    form.append("category", "EVIDENCE"); form.append("file", file);
    try { const response = await fetch("/api/documents", { method: "POST", body: form }); const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "증빙을 저장하지 못했습니다."); setMessage(`${expense.title} 증빙을 저장했습니다.`); await load(period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "증빙을 저장하지 못했습니다."); } finally { setWorking(false); }
  }
  function reviewFor(expense: Expense): ReviewDraft { return reviews[expense.id] ?? { businessPurpose: expense.business_purpose,
    evidenceStatus: expense.evidence_status === "EXEMPT" ? "EXEMPT" : "VERIFIED", evidenceDocumentId: expense.evidence_document_id || expense.documents[0]?.id || "",
    taxTreatment: expense.tax_treatment === "UNREVIEWED" ? "DEDUCTIBLE" : expense.tax_treatment, reviewNote: expense.review_note }; }
  async function reviewExpense(expense: Expense) {
    const review = reviewFor(expense); await mutate({ action: "REVIEW_EVIDENCE", expenseRequestId: expense.id, ...review }, "증빙 검토와 세무 판단을 저장했습니다.");
  }

  if (loading && !data) return <section className="panel expense-control-loading">법인카드·증빙·은행 대사 상태를 확인하고 있습니다…</section>;
  const activeCards = data?.cards.filter((card) => card.status === "ACTIVE") ?? [];
  const eligibleExpenses = (transaction: CardTransaction) => data?.expenses.filter((expense) => expense.status === "APPROVED"
    && expense.payment_method === "CORPORATE_CARD" && expense.amount === transaction.amount && !expense.card_transaction_id) ?? [];
  return <div className="expense-control-workspace">
    <section className="expense-control-hero"><div data-korean-heading><h1>법인카드·지출증빙</h1><span>지출결의, 법인카드 거래, 증빙 검토, 지급원장과 은행 대사를 하나의 통제 흐름으로 연결합니다.</span></div><label>관리월<input type="month" min="2026-01" max={data?.currentPeriod} value={period} onChange={(event) => void load(event.target.value)} /></label></section>
    <div className="expense-control-guidance"><strong>자동 확정 금지</strong><span>{data?.sourceNote}</span><em>{data?.locked ? "마감 잠금" : "명시적 검토"}</em></div>
    {message && <div className="expense-control-message" role="status">{message}</div>}
    <section className="expense-control-metrics">
      <article><small>활성 법인카드</small><strong>{data?.summary.activeCards ?? 0}개</strong><span>끝 4자리만 저장</span></article>
      <article><small>카드 미대사</small><strong>{data?.summary.unmatchedCards ?? 0}건</strong><span>원화·정확한 금액 연결</span></article>
      <article><small>증빙 검토 대기</small><strong>{data?.summary.pendingEvidence ?? 0}건</strong><span>목적·문서·세무판단</span></article>
      <article><small>은행 미대사 지급</small><strong>{data?.summary.bankUnmatched ?? 0}건</strong><span>기존 자금 대사 원장</span></article>
      <article className="warning"><small>중복 후보</small><strong>{data?.summary.duplicateCandidates ?? 0}건</strong><span>자동 삭제·병합 안 함</span></article>
    </section>

    <section className="expense-control-setup">
      <article className="panel corporate-card-form"><header><div data-korean-heading><h2>법인카드 등록</h2></div><span>민감정보 최소화</span></header><form onSubmit={createCard}>
        <label>카드사<input required value={cardDraft.issuer} onChange={(event) => setCardDraft({ ...cardDraft, issuer: event.target.value })} /></label>
        <label>별칭<input required value={cardDraft.nickname} onChange={(event) => setCardDraft({ ...cardDraft, nickname: event.target.value })} placeholder="대표이사 카드" /></label>
        <label>끝 4자리<input required inputMode="numeric" maxLength={4} value={cardDraft.last4} onChange={(event) => setCardDraft({ ...cardDraft, last4: event.target.value.replace(/\D/g, "") })} /></label>
        <label>사용자<select value={cardDraft.holderEmployeeId} onChange={(event) => setCardDraft({ ...cardDraft, holderEmployeeId: event.target.value })}><option value="">공용·미지정</option>{companyEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department}</option>)}</select></label>
        <label>월 한도<input type="number" min="0" value={cardDraft.monthlyLimit} onChange={(event) => setCardDraft({ ...cardDraft, monthlyLimit: event.target.value })} /></label><button disabled={working}>카드 등록</button>
      </form><div className="corporate-card-list">{data?.cards.map((card) => <div key={card.id}><span>{card.issuer}</span><p><strong>{card.nickname} · •••• {card.last4}</strong><small>{companyEmployees.find((employee) => employee.id === card.holder_employee_id)?.name ?? "공용"} · 한도 {won(card.monthly_limit)}</small></p><em>{card.status}</em>{card.status === "ACTIVE" && <button type="button" onClick={() => void mutate({ action: "SET_CARD_STATUS", cardId: card.id, status: "SUSPENDED" }, "카드를 사용중지했습니다.")}>중지</button>}{card.status !== "ACTIVE" && <button type="button" onClick={() => void mutate({ action: "SET_CARD_STATUS", cardId: card.id, status: "ACTIVE" }, "카드를 다시 활성화했습니다.")}>활성화</button>}</div>)}</div></article>
      <article className="panel card-transaction-form"><header><div data-korean-heading><h2>카드 거래 등록</h2></div><span>명세서 연동 전 직접 등록</span></header><form onSubmit={registerTransaction}>
        <label>카드<select required value={transactionDraft.cardId} onChange={(event) => setTransactionDraft({ ...transactionDraft, cardId: event.target.value })}><option value="">선택</option>{activeCards.map((card) => <option key={card.id} value={card.id}>{card.nickname} · {card.last4}</option>)}</select></label>
        <label>카드사 거래 참조값<input required minLength={4} value={transactionDraft.externalReference} onChange={(event) => setTransactionDraft({ ...transactionDraft, externalReference: event.target.value })} /></label>
        <label>거래일<input required type="date" max={data?.asOf} value={transactionDraft.transactionDate} onChange={(event) => setTransactionDraft({ ...transactionDraft, transactionDate: event.target.value })} /></label>
        <label>가맹점<input required value={transactionDraft.merchant} onChange={(event) => setTransactionDraft({ ...transactionDraft, merchant: event.target.value })} /></label>
        <label>구분<select value={transactionDraft.direction} onChange={(event) => setTransactionDraft({ ...transactionDraft, direction: event.target.value })}><option value="CHARGE">승인</option><option value="REFUND">취소·환불</option></select></label>
        <label>원화 금액<input required type="number" min="1" value={transactionDraft.amount} onChange={(event) => setTransactionDraft({ ...transactionDraft, amount: event.target.value })} /></label><button disabled={working}>거래 등록</button>
      </form></article>
    </section>

    <section className="panel card-transaction-ledger"><header><div data-korean-heading><h2>{period} 카드 거래 대사</h2></div><span>{data?.transactions.length ?? 0}건</span></header>
      <div className="card-transaction-row head"><span>카드·거래일</span><span>가맹점·참조값</span><span>금액</span><span>상태</span><span>지출결의 연결</span><span>처리</span></div>
      {data?.transactions.map((transaction) => <div className={`card-transaction-row ${transaction.status.toLowerCase()}`} key={transaction.id}>
        <p><strong>{transaction.nickname} · {transaction.last4}</strong><small>{transaction.transaction_date} · {transaction.direction === "CHARGE" ? "승인" : "취소·환불"}</small></p>
        <p><strong>{transaction.merchant}</strong><small>{transaction.external_reference}</small></p><strong>{won(transaction.amount)}</strong>
        <em>{transaction.status === "UNMATCHED" ? "미대사" : transaction.status === "MATCHED" ? "대사 완료" : "제외"}</em>
        {transaction.status === "UNMATCHED" ? <select disabled={transaction.direction !== "CHARGE" || data.locked} value={matches[transaction.id] ?? ""} onChange={(event) => setMatches({ ...matches, [transaction.id]: event.target.value })}><option value="">같은 금액의 승인 지출 선택</option>{eligibleExpenses(transaction).map((expense) => <option key={expense.id} value={expense.id}>{expense.requested_date} · {expense.vendor || "거래처 없음"} · {expense.title}</option>)}</select> : <span>{transaction.expense_title || transaction.exclusion_reason}</span>}
        <div>{transaction.status === "UNMATCHED" && <><button type="button" disabled={working || !matches[transaction.id] || data.locked} onClick={() => void mutate({ action: "MATCH_CARD", transactionId: transaction.id, expenseRequestId: matches[transaction.id] }, "법인카드 거래를 승인 지출에 연결했습니다.")}>대사</button><button type="button" disabled={working || data.locked} onClick={() => { const reason = window.prompt("대상 외 거래 사유(5자 이상)", transaction.direction === "REFUND" ? "원 승인 취소·환불 거래" : "업무 지출 대상 외"); if (reason) void mutate({ action: "EXCLUDE_TRANSACTION", transactionId: transaction.id, reason }, "카드 거래를 대사 대상에서 제외했습니다."); }}>제외</button></>}{transaction.status === "MATCHED" && transaction.expense_status !== "PAID" && <button type="button" disabled={working || data.locked} onClick={() => { const reason = window.prompt("대사 해제 사유(5자 이상)", "지출 귀속 정정"); if (reason) void mutate({ action: "UNMATCH_CARD", transactionId: transaction.id, reason }, "카드 대사를 해제했습니다."); }}>해제</button>}</div>
      </div>)}{!data?.transactions.length && <p className="expense-control-empty">등록된 카드 거래가 없습니다. 실제 카드사 참조값이 있는 거래만 등록해 주세요.</p>}
    </section>

    <section className="panel expense-evidence-ledger"><header><div data-korean-heading><h2>{period} 지출증빙·지급 대사</h2><span>증빙 파일 존재만으로 적격성을 자동 확정하지 않습니다.</span></div><em>{data?.expenses.length ?? 0}건</em></header>
      {data?.expenses.map((expense) => { const review = reviewFor(expense); const completed = ["VERIFIED", "EXEMPT"].includes(expense.evidence_status); return <article className={Number(expense.duplicate_count) > 0 ? "duplicate" : ""} key={expense.id}>
        <div className="expense-evidence-head"><p><strong>{expense.vendor || "거래처 미입력"} · {expense.title}</strong><small>{expense.requested_date} · {paymentLabel[expense.payment_method] ?? expense.payment_method} · {expense.account_name || "계정 미지정"}</small></p><strong>{won(expense.amount)}</strong><em>{expense.status}</em>{Number(expense.duplicate_count) > 0 && <span>중복 후보 {expense.duplicate_count}건</span>}</div>
        <div className="expense-evidence-documents"><label><input type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.csv" disabled={working || data.locked} onChange={(event) => void uploadEvidence(expense, event)} /><span>+ 증빙 추가</span></label>{expense.documents.map((document) => <a key={document.id} href={document.downloadUrl}>{document.fileName} · v{document.version}</a>)}</div>
        <div className="expense-review-fields"><label>업무 목적<input disabled={completed || data.locked} value={review.businessPurpose} onChange={(event) => setReviews({ ...reviews, [expense.id]: { ...review, businessPurpose: event.target.value } })} placeholder="누가·어떤 업무에 사용했는지" /></label><label>증빙 상태<select disabled={completed || data.locked} value={review.evidenceStatus} onChange={(event) => setReviews({ ...reviews, [expense.id]: { ...review, evidenceStatus: event.target.value } })}><option value="VERIFIED">증빙 확인</option><option value="EXEMPT">증빙 예외 승인</option></select></label><label>증빙 문서<select disabled={completed || review.evidenceStatus === "EXEMPT" || data.locked} value={review.evidenceDocumentId} onChange={(event) => setReviews({ ...reviews, [expense.id]: { ...review, evidenceDocumentId: event.target.value } })}><option value="">문서 선택</option>{expense.documents.map((document) => <option key={document.id} value={document.id}>{document.fileName} · v{document.version}</option>)}</select></label><label>세무 처리<select disabled={completed || data.locked} value={review.taxTreatment} onChange={(event) => setReviews({ ...reviews, [expense.id]: { ...review, taxTreatment: event.target.value } })}><option value="DEDUCTIBLE">공제</option><option value="NONDEDUCTIBLE">불공제</option><option value="OUT_OF_SCOPE">대상 외</option></select></label><label>검토 메모<input disabled={completed || data.locked} value={review.reviewNote} onChange={(event) => setReviews({ ...reviews, [expense.id]: { ...review, reviewNote: event.target.value } })} placeholder={review.evidenceStatus === "EXEMPT" ? "10자 이상의 예외 사유" : "확인 사항"} /></label></div>
        <div className="expense-settlement-status"><span>증빙 <strong>{evidenceLabel[expense.evidence_status] ?? expense.evidence_status}</strong></span><span>세무 <strong>{taxLabel[expense.tax_treatment] ?? expense.tax_treatment}</strong></span>{expense.payment_method === "CORPORATE_CARD" ? <span>카드 <strong>{expense.card_transaction_id ? "대사 완료" : "미대사"}</strong></span> : ["BANK_TRANSFER", "AUTO_DEBIT"].includes(expense.payment_method) && expense.status === "PAID" ? <span>은행 <strong>{expense.bank_remaining_amount ? `${won(expense.bank_remaining_amount)} 미대사` : "대사 완료"}</strong></span> : <span>지급 <strong>{expense.status}</strong></span>}<div>{!completed && <button type="button" disabled={working || data.locked} onClick={() => void reviewExpense(expense)}>검토 확정</button>}{completed && <button type="button" disabled={working || data.locked} onClick={() => { const reason = window.prompt("검토 재개방 사유(5자 이상)", "증빙 또는 세무 판단 정정"); if (reason) void mutate({ action: "REOPEN_REVIEW", expenseRequestId: expense.id, reason }, "증빙 검토를 재개방했습니다."); }}>재검토</button>}</div></div>
      </article>; })}{!data?.expenses.length && <p className="expense-control-empty">이 관리월에 등록된 지출결의가 없습니다.</p>}
    </section>
  </div>;
}
