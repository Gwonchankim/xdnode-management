"use client";

import { useEffect, useMemo, useState } from "react";

type AuditItem = {
  id: string; actorEmail: string; actorEmployeeId: string; actorName: string; module: string; action: string;
  entityType: string; entityId: string; before: unknown; after: unknown; changedFields: string[]; reason: string; createdAt: number;
};
type AuditData = {
  principal: { employeeId: string; name: string };
  summary: { total: number; actors: number; latestAt: number | null };
  actionOptions: { action: string; count: number }[];
  items: AuditItem[];
  nextCursor: { createdAt: number; id: string } | null;
  controls: { readOnly: boolean; secretValuesRedacted: boolean; automaticMutation: boolean };
};

const moduleLabel: Record<string, string> = { ALL: "전체", operations: "운영", finance: "재무회계", hr: "HR", recruitment: "채용", sales: "영업", settings: "설정" };
function seoulDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}
const defaultTo = seoulDate(new Date());
const defaultFrom = seoulDate(new Date(Date.now() - 90 * 86_400_000));

function readable(value: string) {
  return value.toLowerCase().split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function snapshot(value: unknown) {
  return value === null || value === undefined ? "기록 없음" : JSON.stringify(value, null, 2);
}

async function requestAudit(filters: { moduleName: string; action: string; query: string; dateFrom: string; dateTo: string }, cursor?: { createdAt: number; id: string } | null) {
  const params = new URLSearchParams({ module: filters.moduleName, dateFrom: filters.dateFrom, dateTo: filters.dateTo });
  if (filters.action) params.set("action", filters.action);
  if (filters.query) params.set("q", filters.query);
  if (cursor) { params.set("cursorAt", String(cursor.createdAt)); params.set("cursorId", cursor.id); }
  const response = await fetch(`/api/audit-log?${params.toString()}`, { cache: "no-store" });
  const payload = await response.json() as AuditData & { error?: string };
  if (!response.ok) throw new Error(payload.error || "감사기록을 불러오지 못했습니다.");
  return payload;
}

export default function AuditLogWorkspace() {
  const [data, setData] = useState<AuditData | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [moduleName, setModuleName] = useState("ALL");
  const [action, setAction] = useState("");
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  const [expanded, setExpanded] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const filters = useMemo(() => ({ moduleName, action, query, dateFrom, dateTo }), [moduleName, action, query, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    requestAudit(filters).then((payload) => {
      if (cancelled) return;
      setData(payload); setItems(payload.items); setExpanded(""); setError("");
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "감사기록을 불러오지 못했습니다.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true); setError("");
    try {
      const payload = await requestAudit(filters, data.nextCursor);
      setData(payload); setItems((current) => [...current, ...payload.items]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "감사기록을 불러오지 못했습니다."); }
    finally { setLoadingMore(false); }
  }

  const changedCount = useMemo(() => items.filter((item) => item.changedFields.length > 0).length, [items]);

  return <div className="audit-log-body">
    <section className="audit-log-boundary">
      <div data-korean-heading><h3>통합 감사·변경이력</h3><span>HR·재무회계·영업·설정의 변경 주체, 시각, 대상과 변경 전후 값을 하나의 읽기 전용 원장에서 확인합니다.</span></div>
      <ul><li>수정·삭제 불가</li><li>관리자 전용</li><li>보안 값 자동 가림</li></ul>
    </section>

    <section className="audit-log-summary" aria-label="감사기록 요약">
      <article><span>조건 내 기록</span><strong>{(data?.summary.total ?? 0).toLocaleString("ko-KR")}<small>건</small></strong></article>
      <article><span>변경 주체</span><strong>{data?.summary.actors ?? 0}<small>명</small></strong></article>
      <article><span>현재 표시된 변경</span><strong>{changedCount}<small>건</small></strong></article>
      <article><span>최근 기록</span><strong className="date">{data?.summary.latestAt ? new Date(data.summary.latestAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "없음"}</strong></article>
    </section>

    <form className="audit-log-filters" onSubmit={(event) => { event.preventDefault(); setQuery(searchDraft.trim()); }}>
      <label>시작일<input type="date" value={dateFrom} max={dateTo} onChange={(event) => setDateFrom(event.target.value)} /></label>
      <label>종료일<input type="date" value={dateTo} min={dateFrom} onChange={(event) => setDateTo(event.target.value)} /></label>
      <label>업무 영역<select value={moduleName} onChange={(event) => { setModuleName(event.target.value); setAction(""); }}>{Object.entries(moduleLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>작업<select value={action} onChange={(event) => setAction(event.target.value)}><option value="">전체 작업</option>{data?.actionOptions.map((item) => <option value={item.action} key={item.action}>{readable(item.action)} ({item.count})</option>)}</select></label>
      <label className="audit-log-search">검색<input value={searchDraft} maxLength={80} onChange={(event) => setSearchDraft(event.target.value)} placeholder="직원·작업·원장 ID·사유" /></label>
      <button type="submit">조회</button>
    </form>

    {error && <div className="audit-log-message" role="alert">{error}</div>}
    <section className="audit-log-ledger">
      <header><span>시각·업무</span><span>작업·대상</span><span>처리자·사유</span><span>상세</span></header>
      {loading && !items.length && <div className="audit-log-empty">감사기록을 조회하고 있습니다.</div>}
      {!loading && !items.length && !error && <div className="audit-log-empty">이 조건에 해당하는 감사기록이 없습니다.</div>}
      {items.map((item) => <article key={item.id} className={expanded === item.id ? "expanded" : ""}>
        <div><time>{new Date(item.createdAt).toLocaleString("ko-KR")}</time><em>{moduleLabel[item.module] ?? item.module}</em></div>
        <div><strong>{readable(item.action)}</strong><span>{item.entityType} · {item.entityId}</span>{item.changedFields.length > 0 && <small>{item.changedFields.slice(0, 3).join(" · ")}{item.changedFields.length > 3 ? ` 외 ${item.changedFields.length - 3}개` : ""}</small>}</div>
        <div><strong>{item.actorName}</strong><span>{item.actorEmail}</span><small>{item.reason || "사유 기록 없음"}</small></div>
        <button type="button" aria-expanded={expanded === item.id} onClick={() => setExpanded((current) => current === item.id ? "" : item.id)}>{expanded === item.id ? "접기" : "변경값"}</button>
        {expanded === item.id && <div className="audit-log-detail">
          <section><h4>변경 전</h4><pre>{snapshot(item.before)}</pre></section>
          <section><h4>변경 후</h4><pre>{snapshot(item.after)}</pre></section>
          <footer><span>감사 ID {item.id}</span><span>대상 ID {item.entityId}</span><span>보안 키 값은 서버에서 가려 표시합니다.</span></footer>
        </div>}
      </article>)}
      {data?.nextCursor && <button className="audit-log-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "불러오는 중…" : "다음 30건 보기"}</button>}
    </section>
  </div>;
}
