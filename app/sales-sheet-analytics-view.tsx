"use client";

import { useEffect, useState } from "react";

type MonthlyTrend = { month: string; confirmed: number; inProgress: number; confirmedCount: number; inProgressCount: number };
type RepPerf = { rep: string; count: number; sale_total: number; margin: number };
type CustomerRow = { customer_name: string; count: number; sale_total: number; share: number };
type CustomerConcentration = { customers: CustomerRow[]; grandTotal: number; otherSum: number; otherShare: number };
type MarginBucket = { key: string; label: string; count: number; sale_total: number; margin: number };
type MarginDistribution = { buckets: MarginBucket[]; averageMarginRate: number; totals: { count: number; sale_total: number; margin: number } };
type ItemPerf = { item: string; count: number; sale_total: number; margin: number };
type CollectionMonth = { month: string; due_amount: number; collected_amount: number; count: number };
type CollectionSummary = { totalDue: number; outstandingTotal: number; outstandingCount: number; overdueTotal: number; overdueCount: number; collectionRate: number };
type Funnel = { total: number; won: number; lost: number; inProgress: number; unset: number; overallRate: number; resolvedRate: number };
type LeadProtectionFunnel = Funnel & {
  registeredCustomers: number; matchedCustomers: number; revenueMatchRate: number;
  looseMatchedCustomers: number; looseRevenueMatchRate: number;
};
type UnmatchedWin = { id: string; customer_company: string; product: string; sales_rep: string; registered_date: string };
type ConfidenceBucket = { key: string; label: string; count: number; sale_total: number };
type PipelineConfidence = { buckets: ConfidenceBucket[]; rawTotal: number; weightedForecast: number; averageProbability: number };
type PipelineCoverage = { period: string; targetRevenue: number; pipelineTotal: number; coverageRatio: number | null };
type WhitespaceRow = { customer_name: string; sale_total: number; purchasedCategories: string[]; missingCategories: string[] };
type AnomalySignal = { label: string; refMonth: string; refCount: number; baselineAvg: number; dropRate: number; isAnomaly: boolean };
type EngagementAnomaly = { inboundLead: AnomalySignal; leadProtection: AnomalySignal };
type AnalyticsData = {
  monthlyTrend: MonthlyTrend[]; repPerformance: RepPerf[]; customerConcentration: CustomerConcentration; marginDistribution: MarginDistribution;
  itemPerformance: ItemPerf[]; collectionTrend: CollectionMonth[]; collectionSummary: CollectionSummary;
  inboundLeadFunnel: Funnel; leadProtectionFunnel: LeadProtectionFunnel; unmatchedWinLeadProtections: UnmatchedWin[];
  pipelineConfidence: PipelineConfidence; pipelineCoverage: PipelineCoverage; whitespace: WhitespaceRow[]; engagementAnomaly: EngagementAnomaly;
};

const won = (value: number) => `₩${Math.round(value ?? 0).toLocaleString("ko-KR")}`;
const pct = (value: number) => `${((value ?? 0) * 100).toFixed(1)}%`;

export default function SalesSheetAnalyticsView() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/sales/sheet-sync/analytics");
      const result = await response.json() as AnalyticsData & { error?: string };
      if (!response.ok) throw new Error(result.error || "매출 분석을 불러오지 못했습니다.");
      setData(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "매출 분석을 불러오지 못했습니다.");
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const maxMonthly = Math.max(1, ...(data?.monthlyTrend ?? []).flatMap((m) => [m.confirmed, m.inProgress]));
  const maxRep = Math.max(1, ...(data?.repPerformance ?? []).map((r) => r.sale_total));
  const maxCustomerShare = Math.max(0.01, ...(data?.customerConcentration.customers ?? []).map((c) => c.share));
  const maxMarginBucket = Math.max(1, ...(data?.marginDistribution.buckets ?? []).map((b) => b.sale_total));
  const maxItem = Math.max(1, ...(data?.itemPerformance ?? []).map((i) => i.sale_total));
  const maxCollectionMonthly = Math.max(1, ...(data?.collectionTrend ?? []).map((m) => m.due_amount));
  const maxConfidenceBucket = Math.max(1, ...(data?.pipelineConfidence.buckets ?? []).map((b) => b.sale_total));
  const anomalyMessages = data ? [data.engagementAnomaly.inboundLead, data.engagementAnomaly.leadProtection]
    .filter((signal) => signal.isAnomaly)
    .map((signal) => `${signal.label} 신규 등록이 ${signal.refMonth}에 ${signal.refCount}건으로 최근 3개월 평균(${signal.baselineAvg.toFixed(1)}건) 대비 ${pct(signal.dropRate)} 감소했습니다.`)
    : [];
  const funnelRows = (funnel: Funnel) => [
    { key: "won", label: "성공", count: funnel.won },
    { key: "inProgress", label: "진행중", count: funnel.inProgress },
    { key: "lost", label: "실패", count: funnel.lost },
    { key: "unset", label: "미확인", count: funnel.unset },
  ];

  return <>
    <section className="panel sales-analytics-trend">
      <header><div data-korean-heading><h2>월별 매출 추이</h2><span>날짜 형식이 온전한 건만 집계합니다 (자유 텍스트 날짜 제외).</span></div></header>
      {message && <div className="sales-live-message" role="status">{message}</div>}
      {anomalyMessages.map((text) => <div className="sales-live-message" role="status" key={text}>⚠ {text}</div>)}
      <div className="sales-analytics-bars">
        {(data?.monthlyTrend ?? []).map((month) => <div className="sales-analytics-bar-group" key={month.month}>
          <div className="bars">
            <span className="bar confirmed" title={`확정 ${won(month.confirmed)} · ${month.confirmedCount}건`} style={{ height: `${month.confirmed ? Math.max(4, (month.confirmed / maxMonthly) * 100) : 0}%` }} />
            <span className="bar in-progress" title={`진행 딜 ${won(month.inProgress)} · ${month.inProgressCount}건`} style={{ height: `${month.inProgress ? Math.max(4, (month.inProgress / maxMonthly) * 100) : 0}%` }} />
          </div>
          <small>{month.month.slice(2)}</small>
        </div>)}
        {data && !data.monthlyTrend.length && <div className="finance-empty">날짜가 온전한 매출 기록이 없습니다.</div>}
      </div>
      <div className="sales-analytics-legend"><span><i className="confirmed" />확정 매출</span><span><i className="in-progress" />진행 딜</span></div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>담당자별 실적</h2><span>확정 매출 기준, 마진율 포함.</span></div></header>
      <div className="sales-analytics-rank-list">
        {(data?.repPerformance ?? []).map((rep, index) => <div className="sales-analytics-rank-row rank" key={rep.rep}>
          <b>{index + 1}</b><strong>{rep.rep}</strong>
          <div className="bar-track"><span style={{ width: `${(rep.sale_total / maxRep) * 100}%` }} /></div>
          <span>{won(rep.sale_total)}</span><span>{rep.count}건</span><em>{rep.sale_total ? pct(rep.margin / rep.sale_total) : "-"}</em>
        </div>)}
        {data && !data.repPerformance.length && <div className="finance-empty">확정 매출 데이터가 없습니다.</div>}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>거래처 집중도</h2><span>상위 거래처가 확정 매출에서 차지하는 비중.</span></div></header>
      <div className="sales-analytics-rank-list">
        {(data?.customerConcentration.customers ?? []).map((customer) => <div className="sales-analytics-rank-row" key={customer.customer_name}>
          <strong>{customer.customer_name}</strong>
          <div className="bar-track"><span style={{ width: `${(customer.share / maxCustomerShare) * 100}%` }} /></div>
          <span>{won(customer.sale_total)}</span><em>{pct(customer.share)}</em>
        </div>)}
        {data && data.customerConcentration.otherSum > 0 && <div className="sales-analytics-rank-row other">
          <strong className="wide">기타 거래처</strong><div className="bar-track" /><span>{won(data.customerConcentration.otherSum)}</span><em>{pct(data.customerConcentration.otherShare)}</em>
        </div>}
        {data && !data.customerConcentration.customers.length && <div className="finance-empty">확정 매출 데이터가 없습니다.</div>}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>마진율 분포</h2><span>확정 매출 평균 마진율 {data ? pct(data.marginDistribution.averageMarginRate) : "-"}</span></div></header>
      <div className="sales-analytics-rank-list">
        {(data?.marginDistribution.buckets ?? []).map((bucket) => <div className="sales-analytics-rank-row" key={bucket.key}>
          <strong>{bucket.label}</strong>
          <div className="bar-track"><span className={bucket.key === "NEGATIVE" ? "negative" : ""} style={{ width: `${(bucket.sale_total / maxMarginBucket) * 100}%` }} /></div>
          <span>{won(bucket.sale_total)}</span><em>{bucket.count}건</em>
        </div>)}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>품목별 실적</h2><span>확정 매출 상위 20개 품목 (품목명 원문 기준, 표기 차이는 정규화하지 않음).</span></div></header>
      <div className="sales-analytics-rank-list">
        {(data?.itemPerformance ?? []).map((item, index) => <div className="sales-analytics-rank-row rank" key={item.item}>
          <b>{index + 1}</b><strong>{item.item}</strong>
          <div className="bar-track"><span style={{ width: `${(item.sale_total / maxItem) * 100}%` }} /></div>
          <span>{won(item.sale_total)}</span><span>{item.count}건</span><em>{item.sale_total ? pct(item.margin / item.sale_total) : "-"}</em>
        </div>)}
        {data && !data.itemPerformance.length && <div className="finance-empty">확정 매출 데이터가 없습니다.</div>}
      </div>
    </section>

    <section className="panel sales-analytics-trend">
      <header><div data-korean-heading><h2>수금 현황</h2>
        <span>전체 수금율 {data ? pct(data.collectionSummary.collectionRate) : "-"} · 미수금 {data ? won(data.collectionSummary.outstandingTotal) : "-"} ({data?.collectionSummary.outstandingCount ?? 0}건) · 연체 {data ? won(data.collectionSummary.overdueTotal) : "-"} ({data?.collectionSummary.overdueCount ?? 0}건)</span>
      </div></header>
      <div className="sales-analytics-bars">
        {(data?.collectionTrend ?? []).map((month) => <div className="sales-analytics-bar-group" key={month.month}>
          <div className="bars">
            <span className="bar confirmed" title={`수금 완료 ${won(month.collected_amount)}`} style={{ height: `${month.collected_amount ? Math.max(4, (month.collected_amount / maxCollectionMonthly) * 100) : 0}%` }} />
            <span className="bar in-progress" title={`미수금 ${won(month.due_amount - month.collected_amount)}`} style={{ height: `${(month.due_amount - month.collected_amount) > 0 ? Math.max(4, ((month.due_amount - month.collected_amount) / maxCollectionMonthly) * 100) : 0}%` }} />
          </div>
          <small>{month.month.slice(2)}</small>
        </div>)}
        {data && !data.collectionTrend.length && <div className="finance-empty">수금 예정일이 있는 확정 매출이 없습니다.</div>}
      </div>
      <div className="sales-analytics-legend"><span><i className="confirmed" />수금 완료</span><span><i className="in-progress" />미수금</span></div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>인바운드 리드 전환</h2>
        <span>전체 {data?.inboundLeadFunnel.total ?? 0}건 · 계약 성공률 {data ? pct(data.inboundLeadFunnel.overallRate) : "-"} (결론난 건 기준 {data ? pct(data.inboundLeadFunnel.resolvedRate) : "-"})</span>
      </div></header>
      <div className="sales-analytics-rank-list">
        {data && funnelRows(data.inboundLeadFunnel).map((row) => <div className="sales-analytics-rank-row" key={row.key}>
          <strong>{row.label}</strong>
          <div className="bar-track"><span className={row.key === "lost" ? "negative" : ""} style={{ width: `${data.inboundLeadFunnel.total ? (row.count / data.inboundLeadFunnel.total) * 100 : 0}%` }} /></div>
          <span>{row.count}건</span><em>{data.inboundLeadFunnel.total ? pct(row.count / data.inboundLeadFunnel.total) : "-"}</em>
        </div>)}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>영업보호 전환</h2>
        <span>등록 {data?.leadProtectionFunnel.total ?? 0}건 · WIN율 {data ? pct(data.leadProtectionFunnel.overallRate) : "-"} · 확정매출 매칭 완전일치 {data ? pct(data.leadProtectionFunnel.revenueMatchRate) : "-"} → 느슨한 매칭(부분일치) {data ? pct(data.leadProtectionFunnel.looseRevenueMatchRate) : "-"} ({data?.leadProtectionFunnel.looseMatchedCustomers ?? 0}/{data?.leadProtectionFunnel.registeredCustomers ?? 0}개사) — 대학·연구기관은 학과/연구실 명의로 등록되고 매출은 본교 명의로 잡히는 경우가 많아 완전일치만 보면 실제보다 낮게 나옵니다.</span>
      </div></header>
      <div className="sales-analytics-rank-list">
        {data && funnelRows(data.leadProtectionFunnel).map((row) => <div className="sales-analytics-rank-row" key={row.key}>
          <strong>{row.label}</strong>
          <div className="bar-track"><span className={row.key === "lost" ? "negative" : ""} style={{ width: `${data.leadProtectionFunnel.total ? (row.count / data.leadProtectionFunnel.total) * 100 : 0}%` }} /></div>
          <span>{row.count}건</span><em>{data.leadProtectionFunnel.total ? pct(row.count / data.leadProtectionFunnel.total) : "-"}</em>
        </div>)}
      </div>
      <div className="sales-sheet-alert-group">
        <h3>WIN인데 확정매출에서 전혀 찾을 수 없는 거래처 ({data?.unmatchedWinLeadProtections.length ?? 0}건, 부분일치까지 포함해도 매칭 안 됨)</h3>
        {(data?.unmatchedWinLeadProtections ?? []).map((row) => <div key={row.id}>
          <span>{row.customer_company}</span><span>{row.product}</span><time>{row.registered_date} 등록</time><em>{row.sales_rep || "-"}</em>
        </div>)}
        {data && !data.unmatchedWinLeadProtections.length && <div className="finance-empty">WIN 등록 중 매출 미매칭 건이 없습니다.</div>}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>진행 파이프라인 전망</h2>
        <span>진행딜 합계 {data ? won(data.pipelineConfidence.rawTotal) : "-"} · 가중 예측 매출 {data ? won(data.pipelineConfidence.weightedForecast) : "-"} (평균 확률 {data ? pct(data.pipelineConfidence.averageProbability) : "-"}, 영업보호 등록 상태와 거래처명 매칭 기반)
          {data && data.pipelineCoverage.coverageRatio != null
            ? ` · ${data.pipelineCoverage.period} 승인 목표 대비 커버리지 ${data.pipelineCoverage.coverageRatio.toFixed(1)}배`
            : " · 이번 달 승인된 목표가 없어 커버리지는 계산하지 않음"}
        </span>
      </div></header>
      <div className="sales-analytics-rank-list">
        {(data?.pipelineConfidence.buckets ?? []).map((bucket) => <div className="sales-analytics-rank-row" key={bucket.key}>
          <strong>{bucket.label}</strong>
          <div className="bar-track"><span style={{ width: `${(bucket.sale_total / maxConfidenceBucket) * 100}%` }} /></div>
          <span>{won(bucket.sale_total)}</span><em>{bucket.count}건</em>
        </div>)}
      </div>
    </section>

    <section className="panel sales-analytics-rank">
      <header><div data-korean-heading><h2>거래처별 교차판매 후보</h2><span>확정 매출 상위 10개 거래처가 아직 구매하지 않은 제품군 (품목명 키워드 기반 대략적 분류, 정밀한 카테고리 아님).</span></div></header>
      <div>
        {(data?.whitespace ?? []).map((row) => <div className="sales-whitespace-row" key={row.customer_name}>
          <div className="head"><strong>{row.customer_name}</strong><span>{won(row.sale_total)}</span></div>
          {row.missingCategories.length > 0
            ? <span className="missing">미구매: {row.missingCategories.join(", ")}</span>
            : <span className="purchased">분류된 전 제품군 구매 이력 있음</span>}
        </div>)}
        {data && !data.whitespace.length && <div className="finance-empty">확정 매출 데이터가 없습니다.</div>}
      </div>
    </section>
  </>;
}
