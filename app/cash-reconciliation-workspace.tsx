"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { financeCurrentData } from "./finance-current-data";

const currentPeriod = financeCurrentData.asOf.slice(0, 7);
type TieOutBreakdownItem = { label: string; direction: "IN" | "OUT"; count: number; amount: number };
type TieOutCheck = { check_type: string; period: string; as_of: string; gl_account_code: string; gl_account_name: string;
  subsidiary_amount: number; gl_amount: number; difference_amount: number; difference_reason: string; note: string;
  reviewed_by: string; reviewed_at: number | null; breakdown_json: string };

type MatchItem = {
  id: string; matchGroupId: string; bankTransactionId: string; sourceType: string; sourceId: string;
  matchedAmount: number; matchScore: number; matchMethod: string; status: string; memo: string;
  confirmedBy: string; confirmedAt: number; reversalReason: string;
};
type Candidate = {
  sourceType: "PAYMENT_LEDGER" | "SALES_PAYMENT" | "BANK_TRANSACTION";
  sourceId: string; direction: "IN" | "OUT"; date: string; amount: number; remainingAmount: number;
  label: string; counterparty: string; reference: string; score: number;
};
type BankTransaction = {
  id: string; source: string; sourceSnapshotDate: string; accountId: string; bankCode: string; bankName: string;
  accountName: string; accountLast4: string; currency: string; transactionAt: string; transactionDate: string;
  transactionType: string; description: string; direction: "IN" | "OUT"; amount: number; afterBalance: number;
  category: string; businessEntityName: string; isUnclassified: boolean; memo: string;
  allocatedAmount: number; remainingAmount: number; status: string; matches: MatchItem[]; candidates: Candidate[];
};
type SourceItem = {
  sourceType: "PAYMENT_LEDGER" | "SALES_PAYMENT"; sourceId: string; direction: "IN" | "OUT";
  date: string; amount: number; remainingAmount: number; label: string; counterparty: string; reference: string;
};
type ReconciliationData = {
  asOf: string;
  coverage: { startDate: string; endDate: string; importedCount: number; deduplicated: boolean };
  stats: { importedCount: number; resolvedCount: number; pendingCount: number; unclassifiedPendingCount: number; importedAmount: number; resolvedAmount: number; reconciliationRate: number };
  transactions: BankTransaction[];
  availableSources: SourceItem[];
};

const statusLabel: Record<string, string> = {
  UNMATCHED: "미대사", PARTIAL: "부분 대사", MATCHED: "대사 완료", TRANSFER: "내부 이체", EXCLUDED: "대상 제외",
};
const sourceLabel: Record<string, string> = {
  PAYMENT_LEDGER: "지급원장", SALES_PAYMENT: "수금원장", BANK_TRANSACTION: "내부 이체", EXCLUDED: "대상 제외",
};
const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const money = (value: number, currency: string) => currency === "KRW" ? won(value) : `${value.toLocaleString("ko-KR")} ${currency}`;

export default function CashReconciliationWorkspace() {
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("PENDING");
  const [query, setQuery] = useState("");
  const [manualSources, setManualSources] = useState<Record<string, string>>({});
  const [tieOut, setTieOut] = useState<TieOutCheck | null>(null);
  const [tieOutBusy, setTieOutBusy] = useState(false);
  const [tieOutMessage, setTieOutMessage] = useState("");
  const [tieOutReason, setTieOutReason] = useState<"STRUCTURAL" | "UNCONFIRMED">("STRUCTURAL");
  const [tieOutNote, setTieOutNote] = useState("");
  const tieOutBreakdown = useMemo<TieOutBreakdownItem[]>(() => {
    if (!tieOut?.breakdown_json) return [];
    try { return JSON.parse(tieOut.breakdown_json) as TieOutBreakdownItem[]; } catch { return []; }
  }, [tieOut]);

  async function load() {
    setLoading(true);
    const response = await fetch("/api/finance/reconciliation", { cache: "no-store" });
    const result = await response.json() as ReconciliationData & { error?: string };
    if (!response.ok) setMessage(result.error || "자금 대사 원장을 불러오지 못했습니다.");
    else setData(result);
    setLoading(false);
  }
  useEffect(() => {
    let active = true;
    fetch("/api/finance/reconciliation", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as ReconciliationData & { error?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setMessage(result.error || "자금 대사 원장을 불러오지 못했습니다.");
        else setData(result);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setMessage("자금 대사 원장을 불러오지 못했습니다.");
        setLoading(false);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/finance/tie-out", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { checks?: TieOutCheck[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "은행계정조정표를 불러오지 못했습니다.");
        if (!cancelled) setTieOut(payload.checks?.find((item) => item.check_type === "BANK") ?? null);
      })
      .catch((error: unknown) => { if (!cancelled) setTieOutMessage(error instanceof Error ? error.message : "은행계정조정표를 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  async function recomputeTieOut() {
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECOMPUTE", checkType: "BANK", period: tieOut?.period ?? currentPeriod }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "은행계정조정표를 다시 계산하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutNote(""); setTieOutMessage("은행계정조정표를 다시 계산했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "은행계정조정표를 다시 계산하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  async function reviewTieOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tieOut) return;
    setTieOutBusy(true); setTieOutMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REVIEW", checkType: "BANK", period: tieOut.period, reason: tieOutReason, note: tieOutNote }) });
      const result = await response.json() as { check?: TieOutCheck; error?: string };
      if (!response.ok) throw new Error(result.error || "차이 사유를 저장하지 못했습니다.");
      setTieOut(result.check ?? null); setTieOutMessage("차이 사유를 저장했습니다.");
    } catch (error) { setTieOutMessage(error instanceof Error ? error.message : "차이 사유를 저장하지 못했습니다."); }
    finally { setTieOutBusy(false); }
  }

  const visibleTransactions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (data?.transactions ?? []).filter((item) => {
      if (filter === "PENDING" && !["UNMATCHED", "PARTIAL"].includes(item.status)) return false;
      if (filter === "UNCLASSIFIED" && !(item.isUnclassified && item.remainingAmount > 0)) return false;
      if (filter === "RESOLVED" && ["UNMATCHED", "PARTIAL"].includes(item.status)) return false;
      if (filter === "TRANSFER" && item.status !== "TRANSFER") return false;
      return !normalized || `${item.description} ${item.businessEntityName} ${item.category} ${item.bankName} ${item.accountLast4}`.toLowerCase().includes(normalized);
    });
  }, [data, filter, query]);

  async function mutate(payload: Record<string, unknown>, successMessage: string) {
    setMessage("");
    const response = await fetch("/api/finance/reconciliation", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "대사 상태를 변경하지 못했습니다.");
    setMessage(successMessage);
    await load();
  }

  async function confirmCandidate(transaction: BankTransaction, candidate: Candidate | SourceItem) {
    const maxAmount = Math.min(transaction.remainingAmount, candidate.remainingAmount);
    const raw = window.prompt("대사 금액을 입력하세요.", String(maxAmount));
    if (!raw) return;
    const amount = Number(raw.replaceAll(",", ""));
    if (!Number.isInteger(amount) || amount <= 0) return setMessage("대사 금액은 0원 초과 정수로 입력해 주세요.");
    if (!window.confirm(`${transaction.transactionDate} ${transaction.description || transaction.transactionType}\n${money(amount, transaction.currency)}을 ${sourceLabel[candidate.sourceType]}과 연결할까요?`)) return;
    await mutate({ action: "CONFIRM", bankTransactionId: transaction.id, sourceType: candidate.sourceType,
      sourceId: candidate.sourceId, amount }, "은행 거래와 ERP 원장을 확정 연결했습니다.");
  }

  async function exclude(transaction: BankTransaction) {
    const reason = window.prompt("대사 대상에서 제외하는 사유를 입력하세요. (예: 비사업 거래, 중복 원문)", "");
    if (!reason) return;
    await mutate({ action: "EXCLUDE", bankTransactionId: transaction.id, reason }, "제외 사유와 담당자를 감사기록에 남겼습니다.");
  }

  async function reverse(match: MatchItem) {
    const reason = window.prompt("확정 대사를 해제하는 사유를 입력하세요.", "");
    if (!reason) return;
    await mutate({ action: "REVERSE", id: match.id, reason }, "연결된 대사 그룹을 해제하고 이력을 보존했습니다.");
  }

  if (loading && !data) return <section className="panel cash-reconciliation-loading">Clobe 거래 원문과 ERP 원장을 대조하고 있습니다…</section>;

  return <div className="cash-reconciliation-workspace">
    <section className="cash-reconciliation-hero">
      <div data-korean-heading><h1>자금 대사</h1><span>Clobe 은행 거래를 지급·수금 원장과 연결하고 미처리 사유를 추적합니다.</span></div>
      <div><small>원천 범위</small><strong>{data?.coverage.startDate}–{data?.coverage.endDate}</strong><em>{data?.coverage.deduplicated ? "거래 ID 중복 제거" : "원문 기준"}</em></div>
    </section>

    {message && <div className="cash-reconciliation-message" role="status">{message}</div>}

    <section className="cash-reconciliation-metrics">
      <article><small>가져온 거래</small><strong>{data?.stats.importedCount ?? 0}건</strong><span>Clobe 실제 원문</span></article>
      <article><small>대사율</small><strong>{data?.stats.reconciliationRate ?? 0}%</strong><span>{data?.stats.resolvedCount ?? 0}건 해결</span></article>
      <article><small>미대사 거래</small><strong>{data?.stats.pendingCount ?? 0}건</strong><span>부분 대사 포함</span></article>
      <article><small>미분류 우선검토</small><strong>{data?.stats.unclassifiedPendingCount ?? 0}건</strong><span>계정 없는 입출금</span></article>
    </section>

    <section className="panel payable-control-panel">
      <header><div data-korean-heading><h3>은행계정조정표(보통예금 잔액 대사)</h3></div><span>{tieOut ? `${tieOut.period} · 원장 기준일 ${tieOut.as_of}` : "아직 계산되지 않음"}</span></header>
      {tieOutMessage && <div className="finance-control-message" role="status">{tieOutMessage}</div>}
      <div className="payable-plan-editor">
        <p>이카운트 IMPORT 원장과의 대사 · 자동 계산</p>
        <h3>{tieOut ? (tieOut.difference_amount === 0 ? "잔액 일치" : `차이 ${won(tieOut.difference_amount)}`) : "대사 미실행"}</h3>
        <dl>
          <div><dt>보조부(Clobe 스냅샷 은행성 자산)</dt><dd>{won(tieOut?.subsidiary_amount ?? 0)}</dd></div>
          <div><dt>원장 잔액</dt><dd>{won(tieOut?.gl_amount ?? 0)}</dd></div>
          <div><dt>계정</dt><dd>{tieOut?.gl_account_code ? `${tieOut.gl_account_code} ${tieOut.gl_account_name}` : "매핑 대기"}</dd></div>
        </dl>
        <small>보조부 금액은 Clobe 스냅샷의 체크·자유예금 + 외화예금(원화환산) 합계이며, 스냅샷이 갱신되지 않으면 이 대사도 함께 갱신되지 않습니다.</small>
        {tieOutBreakdown.length > 0 && <div className="cash-tie-out-breakdown">
          <p>미기입예금·미결제출금 후보(위 자금 대사 원장의 미매칭 은행 거래 기준, {tieOut?.period} 수집분)</p>
          {tieOutBreakdown.map((item) => <div key={item.direction}><span>{item.label}</span><b className={item.direction === "IN" ? "in" : "out"}>{item.count}건 · {won(item.amount)}</b></div>)}
        </div>}
        {tieOut && !tieOutBreakdown.length && <small>해당 기간은 Clobe 은행 거래 원문이 수집되지 않아 항목별 세부 내역을 제공하지 않습니다 — 위 대사 원장의 수집 범위({data?.coverage.startDate}–{data?.coverage.endDate})를 벗어난 기간입니다.</small>}
        <button type="button" onClick={() => void recomputeTieOut()} disabled={tieOutBusy}>{tieOutBusy ? "계산 중…" : "지금 다시 계산"}</button>
        {tieOut && tieOut.difference_amount !== 0 && (
          tieOut.reviewed_at
            ? <p>{tieOut.difference_reason === "STRUCTURAL" ? "구조적 차이로 확인됨" : "미확인 차이로 기록됨"} · {tieOut.note}</p>
            : <form onSubmit={reviewTieOut}>
                <div className="payable-plan-fields">
                  <label>차이 사유<select value={tieOutReason} onChange={(event) => setTieOutReason(event.target.value as "STRUCTURAL" | "UNCONFIRMED")}><option value="STRUCTURAL">구조적 차이(설명 가능, 월마감 차단 안 함)</option><option value="UNCONFIRMED">미확인(월마감 차단)</option></select></label>
                </div>
                <label>설명<textarea rows={2} minLength={5} value={tieOutNote} onChange={(event) => setTieOutNote(event.target.value)} placeholder="예: 은행 마감 이후 입금분으로 익영업일 반영 예정" /></label>
                <button type="submit" disabled={tieOutBusy || tieOutNote.trim().length < 5}>{tieOutBusy ? "저장 중…" : "사유 저장"}</button>
              </form>
        )}
      </div>
    </section>

    <section className="panel cash-reconciliation-ledger">
      <header>
        <div data-korean-heading><h2>은행 거래 대사 원장</h2><span>후보는 자동 제시하되 확정은 사용자가 수행합니다.</span></div>
        <label><span>검색</span><input value={query} placeholder="적요·거래처·계정·계좌" onChange={(event) => setQuery(event.target.value)} /></label>
      </header>
      <div className="cash-reconciliation-filters" aria-label="대사 상태 필터">
        {[ ["PENDING", "미처리"], ["UNCLASSIFIED", "미분류"], ["RESOLVED", "처리 완료"], ["TRANSFER", "내부 이체"], ["ALL", "전체"] ].map(([key, label]) =>
          <button type="button" key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}
        <span>{visibleTransactions.length}건</span>
      </div>

      <div className="cash-reconciliation-table">
        <div className="cash-reconciliation-row head"><span>거래일·계좌</span><span>적요·분류</span><span>입출금액</span><span>대사 상태</span><span>원장 후보·처리</span></div>
        {visibleTransactions.slice(0, 120).map((item) => {
          const manualOptions = (data?.availableSources ?? []).filter((source) => source.direction === item.direction && source.remainingAmount > 0);
          const manualKey = manualSources[item.id] ?? "";
          const manualSource = manualOptions.find((source) => `${source.sourceType}:${source.sourceId}` === manualKey);
          return <div className={`cash-reconciliation-row ${item.status.toLowerCase()}`} key={item.id}>
            <p><strong>{item.transactionDate} {item.transactionAt.slice(11, 16)}</strong><small>{item.bankName} ····{item.accountLast4} · {item.accountName}</small></p>
            <p><strong>{item.description || item.transactionType || "적요 없음"}</strong><small>{item.businessEntityName ? `${item.businessEntityName} · ` : ""}{item.category || "미분류"}{item.isUnclassified ? " · 확인 필요" : ""}</small></p>
            <b className={item.direction === "IN" ? "in" : "out"}>{item.direction === "IN" ? "+" : "−"}{money(item.amount, item.currency)}<small>{item.allocatedAmount ? `대사 ${money(item.allocatedAmount, item.currency)}` : ""}</small></b>
            <em className={`cash-match-status ${item.status.toLowerCase()}`}>{statusLabel[item.status] ?? item.status}{item.remainingAmount > 0 && item.allocatedAmount > 0 ? <small>잔액 {money(item.remainingAmount, item.currency)}</small> : null}</em>
            <div className="cash-match-actions">
              {item.candidates[0] && item.remainingAmount > 0 && <button type="button" className="candidate" onClick={() => void confirmCandidate(item, item.candidates[0])}>
                <strong>{sourceLabel[item.candidates[0].sourceType]} {item.candidates[0].score}점</strong><small>{item.candidates[0].counterparty || item.candidates[0].label} · {money(item.candidates[0].remainingAmount, item.currency)}</small>
              </button>}
              {item.remainingAmount > 0 && item.currency === "KRW" && <div className="cash-manual-match"><select aria-label={`${item.description || item.id} 수동 원장 선택`} value={manualKey} onChange={(event) => setManualSources((current) => ({ ...current, [item.id]: event.target.value }))}>
                <option value="">다른 원장 선택</option>{manualOptions.map((source) => <option key={`${source.sourceType}:${source.sourceId}`} value={`${source.sourceType}:${source.sourceId}`}>{sourceLabel[source.sourceType]} · {source.date} · {source.counterparty || source.label} · {won(source.remainingAmount)}</option>)}
              </select><button type="button" disabled={!manualSource} onClick={() => manualSource && void confirmCandidate(item, manualSource)}>연결</button></div>}
              {item.remainingAmount > 0 && <button type="button" className="exclude" onClick={() => void exclude(item)}>비대상 처리</button>}
              {item.remainingAmount === 0 && item.matches[0] && <button type="button" className="reverse" onClick={() => void reverse(item.matches[0])}>대사 해제</button>}
              {!item.candidates.length && item.remainingAmount > 0 && !manualOptions.length && <small className="no-candidate">현재 ERP 원장 후보 없음</small>}
            </div>
          </div>;
        })}
        {!visibleTransactions.length && <div className="cash-reconciliation-empty">해당 조건의 은행 거래가 없습니다.</div>}
      </div>
      {visibleTransactions.length > 120 && <p className="cash-reconciliation-limit">화면 성능을 위해 최근 120건을 표시했습니다. 검색 또는 상태 필터로 범위를 좁혀 주세요.</p>}
    </section>

    <section className="cash-reconciliation-principles">
      <article><span>01</span><p><strong>원문 불변</strong><small>Clobe 거래 ID·거래일·금액은 수정하지 않고 대사 기록만 별도로 저장합니다.</small></p></article>
      <article><span>02</span><p><strong>부분 배분</strong><small>한 거래를 여러 지급·수금 원장에 나눠 연결하되 잔액 초과를 차단합니다.</small></p></article>
      <article><span>03</span><p><strong>사람이 확정</strong><small>자동 점수는 후보 제안에만 사용하고 담당자 확정·해제 이력을 남깁니다.</small></p></article>
      <article><span>04</span><p><strong>마감 통제</strong><small>해당 월의 원화 거래가 남아 있으면 은행 대사 마감 완료를 차단합니다.</small></p></article>
    </section>
  </div>;
}
