"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Scenario = "BASE" | "CONSERVATIVE" | "OPTIMISTIC";
type ForecastItem = {
  sourceType: string; sourceId: string; expectedDate: string; direction: "INFLOW" | "OUTFLOW";
  category: string; counterparty: string; amount: number; probability: number; status: string;
  dateQuality: "EXACT" | "PAYMENT_PLAN" | "FALLBACK_REQUEST_DATE" | "MISSING"; memo: string;
};
type ForecastBucket = {
  week: number; weekStart: string; weekEnd: string; inflow: number; outflow: number; net: number;
  endingCash: number; belowMinimum: boolean; minimumGap: number; itemCount: number; overdueItemCount: number;
};
type ForecastData = {
  asOf: string; scenario: Scenario;
  settings: { minimumCashBalance: number; includeFx: boolean; defaultScenario: Scenario; collectionProbability: number };
  summary: { openingCash: number; projectedEndingCash: number; lowestCash: number; lowWeekCount: number; firstLowWeek: number | null; minimumGap: number; totalExpectedInflow: number; totalExpectedOutflow: number };
  coverage: { startDate: string; endDate: string; weeks: number; sourceCounts: Record<string, number>; includedCount: number; missingDateCount: number; fallbackDateCount: number; outsideHorizonCount: number };
  buckets: ForecastBucket[]; items: ForecastItem[]; missingDateItems: ForecastItem[]; outsideHorizonItems: ForecastItem[]; insights: string[];
};

const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const compactWon = (value: number) => {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 100000000) return `${sign}₩${(abs / 100000000).toFixed(abs >= 1000000000 ? 1 : 2)}억`;
  if (abs >= 10000) return `${sign}₩${(abs / 10000).toFixed(0)}만`;
  return `${sign}₩${abs.toLocaleString("ko-KR")}`;
};
const scenarioLabel: Record<Scenario, string> = { BASE: "기준", CONSERVATIVE: "보수", OPTIMISTIC: "낙관" };
const sourceLabel: Record<string, string> = {
  MANUAL: "수기 계획", FINANCE_EXPENSE: "지급·지출", PURCHASE_INVOICE: "매입 인보이스", SALES_INVOICE: "미수 청구서",
};
const appliedProbability = (item: ForecastItem, scenario: Scenario) => {
  if (scenario === "CONSERVATIVE") return item.direction === "INFLOW" ? Math.max(0, item.probability - 25) : 100;
  if (scenario === "OPTIMISTIC") return item.direction === "INFLOW" ? Math.min(100, item.probability + 15) : item.probability;
  return item.probability;
};

export default function CashForecastWorkspace() {
  const [data, setData] = useState<ForecastData | null>(null);
  const [scenario, setScenario] = useState<Scenario>("BASE");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({ minimumCashBalance: "0", includeFx: false, defaultScenario: "BASE" as Scenario, collectionProbability: "85" });
  const [manual, setManual] = useState({ expectedDate: "", direction: "OUTFLOW", category: "", counterparty: "", amount: "", probability: "100", memo: "" });

  async function load(nextScenario: Scenario = scenario) {
    setLoading(true);
    const response = await fetch(`/api/finance/forecast?scenario=${nextScenario}`, { cache: "no-store" });
    const result = await response.json() as ForecastData & { error?: string };
    if (!response.ok) setMessage(result.error || "13주 자금예측을 계산하지 못했습니다.");
    else {
      setData(result);
      setSettings({ minimumCashBalance: String(result.settings.minimumCashBalance), includeFx: result.settings.includeFx,
        defaultScenario: result.settings.defaultScenario, collectionProbability: String(result.settings.collectionProbability) });
    }
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/finance/forecast", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as ForecastData & { error?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok) setMessage(result.error || "13주 자금예측을 계산하지 못했습니다.");
        else {
          setData(result); setScenario(result.scenario);
          setSettings({ minimumCashBalance: String(result.settings.minimumCashBalance), includeFx: result.settings.includeFx,
            defaultScenario: result.settings.defaultScenario, collectionProbability: String(result.settings.collectionProbability) });
        }
        setLoading(false);
      })
      .catch(() => { if (active) { setMessage("13주 자금예측을 계산하지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  const maxFlow = useMemo(() => Math.max(1, ...(data?.buckets ?? []).flatMap((bucket) => [bucket.inflow, bucket.outflow])), [data]);
  const selectedBucket = useMemo(() => data?.buckets.find((bucket) => bucket.week === selectedWeek) ?? data?.buckets[0], [data, selectedWeek]);
  const selectedItems = useMemo(() => {
    if (!data || !selectedBucket) return [];
    return data.items.filter((item) => selectedBucket.week === 1
      ? item.expectedDate <= selectedBucket.weekEnd
      : item.expectedDate >= selectedBucket.weekStart && item.expectedDate <= selectedBucket.weekEnd);
  }, [data, selectedBucket]);

  async function changeScenario(next: Scenario) {
    setScenario(next); setMessage(""); await load(next);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage("");
    const response = await fetch("/api/finance/forecast", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, minimumCashBalance: Number(settings.minimumCashBalance), collectionProbability: Number(settings.collectionProbability) }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "자금예측 설정을 저장하지 못했습니다.");
    setMessage("시나리오·수금확률 설정을 저장하고 예측을 다시 계산했습니다. 최소운영자금은 회사 재무정책에서 관리합니다."); setSettingsOpen(false);
    await load(settings.defaultScenario); setScenario(settings.defaultScenario);
  }

  async function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage("");
    const response = await fetch("/api/finance/operations", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "forecast", ...manual, amount: Number(manual.amount), probability: Number(manual.probability), scenario: "BASE" }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setMessage(result.error || "수기 예정 항목을 저장하지 못했습니다.");
    setManual((current) => ({ ...current, category: "", counterparty: "", amount: "", memo: "" }));
    setMessage("수기 예정 항목을 저장하고 자동 원천과 함께 다시 계산했습니다."); await load();
  }

  if (loading && !data) return <section className="panel cash-forecast-loading">수금·지급·매입채무 원장을 연결해 13주 예측을 계산하고 있습니다…</section>;

  return <div className="cash-forecast-workspace">
    <section className="cash-forecast-hero">
      <div data-korean-heading><h1>13주 자금예측</h1><span>실제 ERP 발생 원장과 수기 계획을 중복 없이 연결해 주차별 가용자금을 계산합니다.</span></div>
      <div className="cash-forecast-hero-actions"><div className="cash-forecast-scenarios" aria-label="예측 시나리오">{(["CONSERVATIVE", "BASE", "OPTIMISTIC"] as Scenario[]).map((item) => <button type="button" key={item} className={scenario === item ? "active" : ""} onClick={() => void changeScenario(item)}>{scenarioLabel[item]}</button>)}</div><button type="button" onClick={() => setSettingsOpen((open) => !open)}>예측 설정</button></div>
    </section>

    {message && <div className="cash-forecast-message" role="status">{message}</div>}

    {settingsOpen && <form className="panel cash-forecast-settings" onSubmit={saveSettings}>
      <label>최소운영자금<input type="number" value={settings.minimumCashBalance} disabled /><span>재무정책</span></label>
      <label>미수금 기준 회수확률<input type="number" min="0" max="100" value={settings.collectionProbability} onChange={(event) => setSettings({ ...settings, collectionProbability: event.target.value })} /><span>%</span></label>
      <label>기본 시나리오<select value={settings.defaultScenario} onChange={(event) => setSettings({ ...settings, defaultScenario: event.target.value as Scenario })}><option value="BASE">기준</option><option value="CONSERVATIVE">보수</option><option value="OPTIMISTIC">낙관</option></select></label>
      <label className="cash-forecast-check"><input type="checkbox" checked={settings.includeFx} onChange={(event) => setSettings({ ...settings, includeFx: event.target.checked })} /><span>외화예금 원화환산액 포함</span></label>
      <button type="submit">설정 저장</button>
    </form>}

    <section className="cash-forecast-metrics">
      <article><small>현재 가용자금</small><strong>{compactWon(data?.summary.openingCash ?? 0)}</strong><span>{data?.settings.includeFx ? "원화·외화 환산 포함" : "원화 입출금계좌"}</span></article>
      <article><small>13주 예상 기말</small><strong className={(data?.summary.projectedEndingCash ?? 0) < 0 ? "negative" : ""}>{compactWon(data?.summary.projectedEndingCash ?? 0)}</strong><span>{scenarioLabel[scenario]} 시나리오</span></article>
      <article><small>기간 중 최저 잔액</small><strong className={(data?.summary.lowWeekCount ?? 0) > 0 ? "negative" : ""}>{compactWon(data?.summary.lowestCash ?? 0)}</strong><span>최소운영자금 {compactWon(data?.settings.minimumCashBalance ?? 0)}</span></article>
      <article><small>위험 주차</small><strong>{data?.summary.lowWeekCount ?? 0}주</strong><span>{data?.summary.firstLowWeek ? `${data.summary.firstLowWeek}주차부터 확인` : "하회 예상 없음"}</span></article>
    </section>

    <section className="panel cash-forecast-chart-panel">
      <header><div data-korean-heading><h2>주차별 유입·유출과 예상 잔액</h2><span>{data?.coverage.startDate}–{data?.coverage.endDate} · {scenarioLabel[scenario]} 확률 반영</span></div><div><b>유입 {compactWon(data?.summary.totalExpectedInflow ?? 0)}</b><b>유출 {compactWon(data?.summary.totalExpectedOutflow ?? 0)}</b></div></header>
      <div className="cash-forecast-chart">
        {(data?.buckets ?? []).map((bucket) => <article key={bucket.week} className={bucket.belowMinimum ? "risk" : ""}>
          <div className="cash-flow-bars"><i className="inflow" style={{ height: `${Math.max(2, bucket.inflow / maxFlow * 100)}%` }} /><i className="outflow" style={{ height: `${Math.max(2, bucket.outflow / maxFlow * 100)}%` }} /></div>
          <strong>{compactWon(bucket.endingCash)}</strong><span>{bucket.week}주</span><small>{bucket.weekStart.slice(5)}–{bucket.weekEnd.slice(5)}</small>
        </article>)}
      </div>
      <div className="cash-forecast-legend"><span><i className="inflow" />예상 유입</span><span><i className="outflow" />예상 유출</span><span><i className="risk" />최소운영자금 하회</span></div>
    </section>

    <section className="cash-forecast-grid">
      <article className="panel cash-forecast-week-table">
        <header><div data-korean-heading><h2>13주 상세</h2></div><span>{data?.coverage.includedCount ?? 0}개 원천 반영</span></header>
        <div className="cash-forecast-week-row head"><span>주차</span><span>유입</span><span>유출</span><span>순변동</span><span>기말잔액</span><span>상태</span></div>
        {(data?.buckets ?? []).map((bucket) => <button type="button" className={`cash-forecast-week-row ${selectedWeek === bucket.week ? "selected" : ""}`} key={bucket.week} onClick={() => setSelectedWeek(bucket.week)}><p><strong>{bucket.week}주차</strong><small>{bucket.weekStart}–{bucket.weekEnd}</small></p><b className="in">+{won(bucket.inflow)}</b><b className="out">−{won(bucket.outflow)}</b><b>{bucket.net >= 0 ? "+" : "−"}{won(Math.abs(bucket.net))}</b><strong>{won(bucket.endingCash)}</strong><em className={bucket.belowMinimum ? "risk" : "stable"}>{bucket.belowMinimum ? `부족 ${won(bucket.minimumGap)}` : bucket.overdueItemCount ? `연체 ${bucket.overdueItemCount}건 포함` : "안정"}</em></button>)}
        <div className="cash-forecast-week-source">
          <div className="cash-forecast-week-source-heading"><p><strong>{selectedBucket?.week ?? 1}주차 근거 원장</strong><small>금액·예정일·적용 확률을 확인해 합계의 근거를 추적합니다.</small></p><span>{selectedItems.length}건</span></div>
          {selectedItems.map((item) => {
            const probability = appliedProbability(item, scenario);
            const adjustedAmount = Math.round(item.amount * probability / 100);
            return <div className="cash-forecast-source-row" key={`${item.sourceType}:${item.sourceId}`}><p><strong>{item.counterparty || item.category}</strong><small>{sourceLabel[item.sourceType] ?? item.sourceType} · {item.category}{item.dateQuality === "PAYMENT_PLAN" ? " · 내부 지급계획" : item.dateQuality === "FALLBACK_REQUEST_DATE" ? " · 요청일 대체" : ""}</small></p><time>{item.expectedDate}</time><span>{probability}%</span><b className={item.direction === "INFLOW" ? "in" : "out"}>{item.direction === "INFLOW" ? "+" : "−"}{won(adjustedAmount)}</b></div>;
          })}
          {!selectedItems.length && <div className="cash-forecast-week-source-empty">이 주차에 반영된 예정 원장이 없습니다.</div>}
        </div>
      </article>

      <article className="panel cash-forecast-insights">
        <header><div data-korean-heading><h2>예측 품질·위험</h2></div><span>{(data?.coverage.missingDateCount ?? 0) + (data?.coverage.fallbackDateCount ?? 0)}건 확인</span></header>
        <div className="cash-forecast-insight-list">{(data?.insights ?? []).map((insight, index) => <div key={insight}><span>0{index + 1}</span><p>{insight}</p></div>)}</div>
        <div className="cash-forecast-source-counts">{Object.entries(data?.coverage.sourceCounts ?? {}).map(([source, count]) => <div key={source}><span>{sourceLabel[source] ?? source}</span><strong>{count}건</strong></div>)}</div>
        {(data?.missingDateItems.length ?? 0) > 0 && <div className="cash-forecast-missing"><h3>예정일 보완 필요</h3>{data?.missingDateItems.slice(0, 8).map((item) => <div key={`${item.sourceType}:${item.sourceId}`}><p><strong>{item.counterparty || item.category}</strong><small>{sourceLabel[item.sourceType] ?? item.sourceType} · {item.memo || "참조 없음"}</small></p><b>{won(item.amount)}</b></div>)}</div>}
      </article>
    </section>

    <section className="panel cash-forecast-manual">
      <header><div data-korean-heading><h2>수기 예정 입출금 추가</h2><span>계약 전 계획·세금·대출상환처럼 아직 발생 원장이 없는 항목만 등록합니다.</span></div></header>
      <form onSubmit={addManual}><label>예정일<input required type="date" min={data?.asOf} value={manual.expectedDate} onChange={(event) => setManual({ ...manual, expectedDate: event.target.value })} /></label><label>구분<select value={manual.direction} onChange={(event) => setManual({ ...manual, direction: event.target.value })}><option value="INFLOW">입금</option><option value="OUTFLOW">출금</option></select></label><label>분류<input required value={manual.category} onChange={(event) => setManual({ ...manual, category: event.target.value })} /></label><label>거래처·대상<input value={manual.counterparty} onChange={(event) => setManual({ ...manual, counterparty: event.target.value })} /></label><label>금액<input required min="1" type="number" value={manual.amount} onChange={(event) => setManual({ ...manual, amount: event.target.value })} /></label><label>발생확률<input required min="0" max="100" type="number" value={manual.probability} onChange={(event) => setManual({ ...manual, probability: event.target.value })} /></label><button type="submit">+ 계획 추가</button></form>
      <p>확정 원장이 생성된 뒤에는 중복 수기 계획을 완료 또는 취소하여 이중 집계를 방지해 주세요.</p>
    </section>
  </div>;
}
