"use client";

import { useEffect, useState } from "react";
import { financeCurrentData } from "./finance-current-data";

const currentPeriod = financeCurrentData.asOf.slice(0, 7);

type TieOutRow = {
  check_type: string; period: string; as_of: string; gl_account_code: string; gl_account_name: string;
  subsidiary_amount: number; gl_amount: number; difference_amount: number; difference_reason: string; note: string;
  reviewed_by: string; reviewed_at: number | null;
};

// 2단계 대사 축이 완성한 5종 tie-out. destination은 각 유형의 "홈" 화면(세부 검토·사유 등록은 거기서
// 수행) — 이 보드는 통합 현황과 재계산만 담당하고 사유 입력 폼은 중복 구현하지 않는다.
const TIE_OUT_TYPES: Array<{ type: string; label: string; account: string; destination: string; destinationLabel: string }> = [
  { type: "RECEIVABLES", label: "매출채권", account: "1089 외상매출금", destination: "receivables", destinationLabel: "외상·미수 관리" },
  { type: "PAYABLES", label: "매입채무", account: "2519 외상매입금", destination: "purchasing", destinationLabel: "구매·매입채무" },
  { type: "INVENTORY", label: "재고자산", account: "1469 상품", destination: "inventory", destinationLabel: "재고·상품원가" },
  { type: "DEBT", label: "차입금", account: "2954 장기차입금", destination: "debt", destinationLabel: "차입금·상환·약정" },
  { type: "BANK", label: "은행계정조정표", account: "1039 보통예금", destination: "reconciliation", destinationLabel: "자금 대사" },
];

const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;

function statusOf(row: TieOutRow | undefined) {
  if (!row) return { label: "미계산", tone: "pending" as const };
  if (row.difference_amount === 0) return { label: "잔액 일치", tone: "pass" as const };
  if (row.difference_reason === "STRUCTURAL") return { label: "구조적 차이", tone: "review" as const };
  if (row.difference_reason === "UNCONFIRMED") return { label: "미확인 차이 · 마감 차단", tone: "fail" as const };
  return { label: "사유 미등록", tone: "fail" as const };
}

export default function TieOutBoardWorkspace({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [period, setPeriod] = useState(currentPeriod);
  const [checks, setChecks] = useState<TieOutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busyType, setBusyType] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/finance/tie-out?period=${encodeURIComponent(currentPeriod)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { checks?: TieOutRow[]; error?: string };
        if (!response.ok) throw new Error(result.error || "대사 현황을 불러오지 못했습니다.");
        if (!cancelled) { setChecks(result.checks ?? []); setLoading(false); }
      })
      .catch((error: unknown) => {
        if (!cancelled) { setMessage(error instanceof Error ? error.message : "대사 현황을 불러오지 못했습니다."); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, []);

  async function load(selectedPeriod: string) {
    try {
      const response = await fetch(`/api/finance/tie-out?period=${encodeURIComponent(selectedPeriod)}`, { cache: "no-store" });
      const result = await response.json() as { checks?: TieOutRow[]; error?: string };
      if (!response.ok) throw new Error(result.error || "대사 현황을 불러오지 못했습니다.");
      setChecks(result.checks ?? []);
    } catch (error) { setMessage(error instanceof Error ? error.message : "대사 현황을 불러오지 못했습니다."); }
  }

  function changePeriod(nextPeriod: string) {
    setPeriod(nextPeriod); setMessage(""); setLoading(true);
    void load(nextPeriod).finally(() => setLoading(false));
  }

  async function recomputeOne(type: string) {
    setBusyType(type); setMessage("");
    try {
      const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RECOMPUTE", checkType: type, period }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "재계산하지 못했습니다.");
      await load(period);
    } catch (error) { setMessage(error instanceof Error ? error.message : "재계산하지 못했습니다."); }
    finally { setBusyType(""); }
  }

  async function recomputeAll() {
    setBusyType("ALL"); setMessage("");
    try {
      for (const item of TIE_OUT_TYPES) {
        const response = await fetch("/api/finance/tie-out", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "RECOMPUTE", checkType: item.type, period }) });
        if (!response.ok) {
          const result = await response.json() as { error?: string };
          throw new Error(`${item.label}: ${result.error || "재계산 실패"}`);
        }
      }
      await load(period);
      setMessage("5종 대사를 모두 다시 계산했습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "일부 대사를 재계산하지 못했습니다."); }
    finally { setBusyType(""); }
  }

  const rows = TIE_OUT_TYPES.map((item) => ({ item, row: checks.find((check) => check.check_type === item.type) }));
  const computedCount = rows.filter(({ row }) => Boolean(row)).length;
  const passCount = rows.filter(({ row }) => statusOf(row).tone === "pass" || statusOf(row).tone === "review").length;
  const blockingCount = rows.filter(({ row }) => statusOf(row).tone === "fail").length;

  if (loading && !checks.length) return <div className="tie-out-board-loading">보조부 ↔ 원장 대사 현황을 불러오는 중입니다.</div>;

  return <div className="tie-out-board-workspace">
    <section className="tie-out-board-hero">
      <div data-korean-heading><h1>대사 현황판</h1><span>보조부 ↔ 총계정원장 tie-out 5종을 한 화면에서 확인하고, 차이가 있으면 담당 화면으로 이동해 사유를 등록합니다.</span></div>
      <label>기준월<input type="month" min="2026-01" max={currentPeriod} value={period} onChange={(event) => changePeriod(event.target.value)} /></label>
    </section>

    {message && <div className="tie-out-board-message" role="status">{message}</div>}

    <section className="tie-out-board-metrics">
      <article><small>대사 대상</small><strong>{TIE_OUT_TYPES.length}종</strong><span>재고·매출채권·매입채무·차입금·은행</span></article>
      <article><small>계산 완료</small><strong>{computedCount}종</strong><span>{period} 기준</span></article>
      <article><small>마감 통과</small><strong>{passCount}종</strong><span>일치 또는 구조적 차이로 확인됨</span></article>
      <article className={blockingCount ? "warning" : ""}><small>마감 차단</small><strong>{blockingCount}종</strong><span>미확인 차이 · 사유 등록 필요</span></article>
    </section>

    <section className="panel tie-out-board-panel">
      <header>
        <div data-korean-heading><h2>대사 현황</h2></div>
        <button type="button" onClick={() => void recomputeAll()} disabled={Boolean(busyType)}>{busyType === "ALL" ? "전체 계산 중…" : "전체 다시 계산"}</button>
      </header>
      <div className="tie-out-board-row head"><span>유형·계정</span><span>보조부 잔액</span><span>원장 잔액</span><span>차이</span><span>상태</span><span>작업</span></div>
      {rows.map(({ item, row }) => {
        const status = statusOf(row);
        return <div className="tie-out-board-row" key={item.type}>
          <p><strong>{item.label}</strong><small>{row?.gl_account_code ? `${row.gl_account_code} ${row.gl_account_name}` : item.account}</small></p>
          <b>{won(row?.subsidiary_amount ?? 0)}</b>
          <b>{won(row?.gl_amount ?? 0)}</b>
          <b>{won(row?.difference_amount ?? 0)}</b>
          <em className={`tie-out-board-status ${status.tone}`}>{status.label}</em>
          <div>
            <button type="button" disabled={busyType === item.type || busyType === "ALL"} onClick={() => void recomputeOne(item.type)}>{busyType === item.type ? "계산 중…" : "다시 계산"}</button>
            <button type="button" onClick={() => onNavigate(item.destination)}>{item.destinationLabel} →</button>
          </div>
        </div>;
      })}
    </section>
  </div>;
}
