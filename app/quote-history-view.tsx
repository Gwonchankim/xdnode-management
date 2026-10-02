"use client";

// 견적 탭 최근·검색 목록(quote-tool Design §10.2 '왼쪽 카드: 최근·검색'). QT1 은 읽기 전용: 행을 누르면 불러오기 미리보기를 연다.
// 미확정 일괄 확정 대화상자·되돌리기 토스트는 QT3 에서 더한다. 값은 React 텍스트 노드로만 그린다.
import { useEffect, useState } from "react";
import { readScoped, writeScoped } from "./client-runtime";
import { STATUS_LABEL, formatWon, quoteRequest, type HistoryHit, type RecentQuote } from "./quote-client";

const SOURCE_TAB_KEY = "xdnode-quote-source-tab";
const PAGE = 30;

export type OpenRequest = { kind: "issued" | "file"; id: number };

function StatusChip({ status }: { status: keyof typeof STATUS_LABEL | null }) {
  if (!status) return <span className="quote-chip file">과거 파일</span>;
  return <span className={`quote-chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

export default function QuoteHistoryView({ selected, onOpen }: { selected: OpenRequest | null; onOpen: (request: OpenRequest) => void }) {
  const [tab, setTab] = useState<"recent" | "search">(() => (readScoped(SOURCE_TAB_KEY) === "search" ? "search" : "recent"));
  const [recent, setRecent] = useState<RecentQuote[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; rows: HistoryHit[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void quoteRequest<{ rows: RecentQuote[] }>("/api/quote/history?view=recent&limit=15").then((result) => {
      if (!alive) return;
      if (result.ok) setRecent(result.body.rows);
      else setError(result.body.error ?? "최근 견적을 불러오지 못했습니다.");
    });
    return () => { alive = false; };
  }, []);

  function chooseTab(next: "recent" | "search") {
    setTab(next);
    writeScoped(SOURCE_TAB_KEY, next);
  }

  async function search(offset = 0) {
    const q = query.trim();
    setBusy(true);
    setError("");
    const result = await quoteRequest<{ rows: HistoryHit[]; total: number }>(`/api/quote/history?view=search&q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`);
    setBusy(false);
    if (!result.ok) { setError(result.body.error ?? "검색하지 못했습니다."); return; }
    setHits((current) => ({ q, total: result.body.total, rows: offset && current ? [...current.rows, ...result.body.rows] : result.body.rows }));
  }

  const isSelected = (kind: "issued" | "file", id: number) => selected?.kind === kind && selected.id === id;

  return (
    <section className="quote-card quote-history" aria-label="최근·검색">
      <div className="quote-segment" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "recent"} className={tab === "recent" ? "active" : ""} onClick={() => chooseTab("recent")}>최근 작성</button>
        <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => chooseTab("search")}>검색</button>
      </div>
      {error && <p className="quote-error" role="alert">{error}</p>}

      {tab === "recent" && (
        recent === null ? <p className="quote-muted">불러오는 중…</p>
          : recent.length === 0 ? <p className="quote-muted">아직 이 탭에서 작성한 견적이 없습니다. 과거 견적은 「검색」에서 찾을 수 있습니다.</p>
            : (
              <ul className="quote-list">
                {recent.map((row) => (
                  <li key={row.id}>
                    <button type="button" className={isSelected("issued", row.id) ? "selected" : ""} onClick={() => onOpen({ kind: "issued", id: row.id })}>
                      <span className="quote-list-main"><strong>{row.customer || "(기관 없음)"}</strong><small>{row.contact}{row.model_hint ? ` · ${row.model_hint}` : ""}</small></span>
                      <span className="quote-list-side"><StatusChip status={row.status} /><small>{row.issue_date} · {formatWon(row.total)}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            )
      )}

      {tab === "search" && (
        <>
          <form className="quote-search" onSubmit={(event) => { event.preventDefault(); void search(0); }}>
            <input type="search" value={query} maxLength={100} placeholder="기관·담당자·모델·사양으로 찾기" aria-label="견적 검색어" onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" disabled={busy}>{busy ? "찾는 중…" : "찾기"}</button>
          </form>
          {hits && <p className="quote-muted">{hits.q ? `「${hits.q}」 ` : "전체 "}{hits.total.toLocaleString("ko-KR")}건</p>}
          {hits && hits.rows.length > 0 && (
            <ul className="quote-list">
              {hits.rows.map((row) => (
                <li key={`${row.source}:${row.id}`}>
                  <button type="button" className={isSelected(row.source, row.id) ? "selected" : ""} onClick={() => onOpen({ kind: row.source, id: row.id })}>
                    <span className="quote-list-main"><strong>{row.customer || "(기관 없음)"}</strong><small>{row.contact ?? ""}{row.model_hint ? ` · ${row.model_hint}` : ""}{row.sheet_name ? ` · ${row.sheet_name}` : ""}</small></span>
                    <span className="quote-list-side"><StatusChip status={row.source === "issued" ? row.status : null} /><small>{row.quote_date ?? "날짜 없음"} · {formatWon(row.total)}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hits && hits.rows.length < hits.total && (
            <button type="button" className="quote-more" disabled={busy} onClick={() => void search(hits.rows.length)}>더 보기</button>
          )}
        </>
      )}
    </section>
  );
}
