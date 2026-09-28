"use client";

import { useEffect, useRef, useState } from "react";

type AccountEvent = { source: string; sourceLabel: string; date: string; title: string; detail: string; amount: number | null; id: string };
type RevenueAlertRow = { id: string; deal_status: string; rep: string; customer_name: string; end_customer_name: string; item: string; order_date: string; collection_due_date: string; sale_total: number };
type LeadAlertRow = { id: string; company: string; product: string; inflow_date: string; stage: string; contact_person: string };
type Alerts = { overdueCollections: RevenueAlertRow[]; staleDeals: RevenueAlertRow[]; staleLeads: LeadAlertRow[] };

const won = (value: number) => `₩${Number(value ?? 0).toLocaleString("ko-KR")}`;

export default function SalesSheetInsightsView() {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [timeline, setTimeline] = useState<AccountEvent[] | null>(null);
  const [message, setMessage] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadAlerts() {
    try {
      const response = await fetch("/api/sales/sheet-sync/insights?type=alerts");
      const result = await response.json() as Alerts & { error?: string };
      if (!response.ok) throw new Error(result.error || "데이터 품질 경고를 불러오지 못했습니다.");
      setAlerts(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "데이터 품질 경고를 불러오지 못했습니다.");
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void loadAlerts(); }, []);

  function onAccountQueryChange(value: string) {
    setAccountQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      const response = await fetch(`/api/sales/sheet-sync/insights?type=accounts&q=${encodeURIComponent(value)}`);
      const result = await response.json() as { names: string[] };
      setSuggestions(result.names ?? []);
    }, 250);
  }

  async function openAccount(name: string) {
    setSelectedAccount(name); setAccountQuery(name); setSuggestions([]); setTimeline(null); setMessage("");
    try {
      const response = await fetch(`/api/sales/sheet-sync/insights?type=timeline&name=${encodeURIComponent(name)}`);
      const result = await response.json() as { events?: AccountEvent[]; error?: string };
      if (!response.ok) throw new Error(result.error || "거래처 이력을 불러오지 못했습니다.");
      setTimeline(result.events ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "거래처 이력을 불러오지 못했습니다.");
    }
  }

  return <>
    <section className="panel sales-sheet-account-view">
      <header><div data-korean-heading><h2>거래처 통합 뷰</h2><span>고객사명으로 검색하면 선점권 등록·문의·매출·납품·AS 이력을 한 번에 봅니다. 완전히 같은 이름만 묶입니다.</span></div></header>
      {message && <div className="sales-live-message" role="status">{message}</div>}
      <div className="sales-sheet-account-search">
        <input type="search" placeholder="고객사명 검색 (예: 한국과학기술원)" value={accountQuery} onChange={(event) => onAccountQueryChange(event.target.value)} />
        {suggestions.length > 0 && <div className="sales-sheet-account-suggestions">
          {suggestions.map((name) => <button type="button" key={name} onClick={() => void openAccount(name)}>{name}</button>)}
        </div>}
      </div>
      {selectedAccount && <div className="sales-sheet-account-timeline">
        <h3>{selectedAccount} · {timeline?.length ?? 0}건</h3>
        {(timeline ?? []).map((event) => <div key={`${event.source}-${event.id}`}>
          <em>{event.sourceLabel}</em>
          <div><p>{event.title || "(내용 없음)"}</p><span>{event.detail}</span></div>
          <time>{event.date || "-"}</time>
          <strong>{event.amount ? won(event.amount) : ""}</strong>
        </div>)}
        {timeline && !timeline.length && <div className="finance-empty">이 거래처와 관련된 시트 기록이 없습니다.</div>}
      </div>}
    </section>

    <section className="panel sales-sheet-alerts-view">
      <header><div data-korean-heading><h2>데이터 품질 경고</h2><span>지금 챙겨야 할 수금 지연·정체 건을 모아 보여줍니다.</span></div></header>
      <div className="sales-sheet-alert-group">
        <h3>수금예정일이 지났는데 수금이 안 된 확정 매출 ({alerts?.overdueCollections.length ?? 0}건)</h3>
        {(alerts?.overdueCollections ?? []).map((row) => <div key={row.id}><span>{row.customer_name}{row.end_customer_name ? ` · ${row.end_customer_name}` : ""}</span><span>{row.item}</span><time>{row.collection_due_date} 예정</time><strong>{won(row.sale_total)}</strong></div>)}
        {alerts && !alerts.overdueCollections.length && <div className="finance-empty">지연된 수금 건이 없습니다.</div>}
      </div>
      <div className="sales-sheet-alert-group">
        <h3>30일 넘게 정체된 진행 딜 ({alerts?.staleDeals.length ?? 0}건)</h3>
        {(alerts?.staleDeals ?? []).map((row) => <div key={row.id}><span>{row.rep || "-"}</span><span>{row.customer_name} · {row.item}</span><time>{row.order_date} 발주</time><strong>{won(row.sale_total)}</strong></div>)}
        {alerts && !alerts.staleDeals.length && <div className="finance-empty">정체된 진행 딜이 없습니다.</div>}
      </div>
      <div className="sales-sheet-alert-group">
        <h3>30일 넘게 결과 없는 인바운드 리드 ({alerts?.staleLeads.length ?? 0}건)</h3>
        {(alerts?.staleLeads ?? []).map((row) => <div key={row.id}><span>{row.company}</span><span>{row.product}</span><time>{row.inflow_date} 유입</time><em>{row.stage || "-"}</em></div>)}
        {alerts && !alerts.staleLeads.length && <div className="finance-empty">방치된 인바운드 리드가 없습니다.</div>}
      </div>
    </section>
  </>;
}
