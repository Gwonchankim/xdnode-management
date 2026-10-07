"use client";

// 견적 탭 최근·검색 목록과 미확정 일괄 확정 대화상자(quote-tool Design §10.2 '왼쪽 카드: 최근·검색'·'미확정 일괄', 옛 index.html recent·hist·pendModal).
// 행을 누르면 불러오기(덮어쓰기 확인은 워크스페이스가 한다). 최근 행에는 파일 받기 단추가 있다(보기 권한 xlsx 는 서버가 견적 시트만 준다).
// 미확정 일괄: 오래된 것부터, 체크·전체 선택, '발송 확정'·'폐기' → 결과 토스트의 '되돌리기'(SET_STATUS draft). 편집 권한만.
// 값은 React 텍스트 노드로만 그린다.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readScoped, writeScoped } from "./client-runtime";
import { STATUS_LABEL, formatWon, notifyQuoteChanged, quoteFileUrl, quoteRequest, type HistoryHit, type QuoteStatus, type RecentQuote } from "./quote-client";
import { shortWon } from "./quote-price-chart";

const SOURCE_TAB_KEY = "xdnode-quote-source-tab";
const PAGE = 30;
const SEARCH_DEBOUNCE_MS = 250;

export type OpenRequest = { kind: "issued" | "file"; id: number };
export type SourceTab = "mail" | "recent" | "search";

function StatusChip({ status }: { status: keyof typeof STATUS_LABEL | null }) {
  if (!status) return <span className="quote-chip file">과거 파일</span>;
  return <span className={`quote-chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

export default function QuoteHistoryView({ selected, onOpen, refreshKey, mail, focusSearchKey }: {
  selected: OpenRequest | null; onOpen: (request: OpenRequest) => void; refreshKey: number;
  /** 편집 권한이면 「메일」 탭(AI 추출 패널)을 함께 보인다. */
  mail: ReactNode | null;
  /** 값이 바뀌면 검색 탭으로 옮기고 검색 칸에 초점을 둔다(단축키 /). */
  focusSearchKey: number;
}) {
  const [tab, setTab] = useState<SourceTab>(() => {
    const saved = readScoped(SOURCE_TAB_KEY);
    if (saved === "search" || saved === "recent") return saved;
    return mail ? "mail" : "recent";
  });
  const [recent, setRecent] = useState<RecentQuote[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; rows: HistoryHit[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchInput = useRef<HTMLInputElement | null>(null);
  const searchSeq = useRef(0);
  const timer = useRef<number | null>(null);
  const activeTab: SourceTab = tab === "mail" && !mail ? "recent" : tab;

  useEffect(() => {
    let alive = true;
    void quoteRequest<{ rows: RecentQuote[] }>("/api/quote/history?view=recent&limit=15").then((result) => {
      if (!alive) return;
      if (result.ok) { setRecent(result.body.rows); setError(""); }
      else setError(result.body.error ?? "최근 견적을 불러오지 못했습니다.");
    });
    return () => { alive = false; };
  }, [refreshKey]);

  const [seenFocusKey, setSeenFocusKey] = useState(focusSearchKey);
  if (seenFocusKey !== focusSearchKey) {
    setSeenFocusKey(focusSearchKey);
    setTab("search");
  }
  useEffect(() => {
    if (!focusSearchKey) return;
    const timer = window.setTimeout(() => searchInput.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [focusSearchKey]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  function chooseTab(next: SourceTab) {
    setTab(next);
    writeScoped(SOURCE_TAB_KEY, next);
  }

  async function search(offset = 0) {
    const q = query.trim();
    const seq = (searchSeq.current += 1);
    setBusy(true);
    setError("");
    const result = await quoteRequest<{ rows: HistoryHit[]; total: number }>(`/api/quote/history?view=search&q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`);
    if (seq !== searchSeq.current) return; // 더 늦게 보낸 검색이 있다. 이 결과는 버린다.
    setBusy(false);
    if (!result.ok) { setError(result.body.error ?? "검색하지 못했습니다."); return; }
    setHits((current) => ({ q, total: result.body.total, rows: offset && current ? [...current.rows, ...result.body.rows] : result.body.rows }));
  }

  /** 옛 FR-11: 입력을 멈추면 따라오는 검색. Enter 는 기다리지 않고 바로 찾는다. */
  function onQueryChange(value: string) {
    setQuery(value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void search(0); }, SEARCH_DEBOUNCE_MS);
  }

  const isSelected = (kind: "issued" | "file", id: number) => selected?.kind === kind && selected.id === id;

  return (
    <section className="quote-card quote-history" aria-label={mail ? "메일·최근·검색" : "최근·검색"}>
      <div className="quote-segment" role="tablist">
        {mail && <button type="button" role="tab" aria-selected={activeTab === "mail"} className={activeTab === "mail" ? "active" : ""} onClick={() => chooseTab("mail")}>메일</button>}
        <button type="button" role="tab" aria-selected={activeTab === "recent"} className={activeTab === "recent" ? "active" : ""} onClick={() => chooseTab("recent")}>최근 작성{recent?.length ? ` ${recent.length}` : ""}</button>
        <button type="button" role="tab" aria-selected={activeTab === "search"} className={activeTab === "search" ? "active" : ""} onClick={() => chooseTab("search")}>검색{hits?.total ? ` ${hits.total.toLocaleString("ko-KR")}` : ""}</button>
      </div>
      {error && activeTab !== "mail" && <p className="quote-error" role="alert">{error}</p>}

      {/* 메일 패널은 탭을 옮겨도 붙여 넣은 글·스크린샷이 남도록 숨기기만 한다. */}
      {mail && <div hidden={activeTab !== "mail"}>{mail}</div>}

      {activeTab === "recent" && (
        recent === null ? <p className="quote-muted">불러오는 중…</p>
          : recent.length === 0 ? <p className="quote-muted">아직 이 탭에서 작성한 견적이 없습니다. 견적을 만들면 &lsquo;미확정&rsquo;으로 여기 쌓입니다. 과거 견적은 「검색」에서 찾을 수 있습니다.</p>
            : (
              <ul className="quote-list">
                {recent.map((row) => (
                  <li key={row.id} className="quote-list-row">
                    <button type="button" className={isSelected("issued", row.id) ? "selected" : ""} onClick={() => onOpen({ kind: "issued", id: row.id })}>
                      <span className="quote-list-main"><strong>{row.customer || "(기관 없음)"}</strong><small>#{row.id} · {row.contact}{row.author_name ? ` · ${row.author_name}` : ""}</small></span>
                      <span className="quote-list-side"><StatusChip status={row.status} /><small>{row.issue_date} · {shortWon(row.total)}</small></span>
                    </button>
                    {(row.files.xlsx || row.files.pdf) && (
                      <span className="quote-list-files">
                        {row.files.xlsx && <a href={quoteFileUrl(row.id, "xlsx")} download aria-label={`#${row.id} xlsx 받기`}>xlsx</a>}
                        {row.files.pdf && <a href={quoteFileUrl(row.id, "pdf")} download aria-label={`#${row.id} PDF 받기`}>PDF</a>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )
      )}

      {activeTab === "search" && (
        <>
          <form className="quote-search" onSubmit={(event) => { event.preventDefault(); if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } void search(0); }}>
            <input ref={searchInput} type="search" value={query} maxLength={100} placeholder="기관·담당자·모델·사양으로 찾기" aria-label="견적 검색어" onChange={(event) => onQueryChange(event.target.value)} />
            <button type="submit" disabled={busy}>{busy ? "찾는 중…" : "찾기"}</button>
          </form>
          {hits && <p className="quote-muted">{hits.q ? `「${hits.q}」 ` : "전체 "}{hits.total.toLocaleString("ko-KR")}건</p>}
          {hits && hits.rows.length === 0 && <p className="quote-muted">결과 없음</p>}
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
            <button type="button" className="quote-more" disabled={busy} onClick={() => void search(hits.rows.length)}>더 보기 ({(hits.total - hits.rows.length).toLocaleString("ko-KR")}건 남음)</button>
          )}
        </>
      )}
    </section>
  );
}

// ── 미확정 일괄 확정·폐기(옛 openPending·pendApply·undoStatus) ────────────────────────────
export type StatusChange = { ids: number[]; status: QuoteStatus; changed: number; pending: number };

export function PendingDialog({ onClose, onChanged }: { onClose: () => void; onChanged: (change: StatusChange) => void }) {
  const [rows, setRows] = useState<RecentQuote[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void quoteRequest<{ rows: RecentQuote[]; count: number }>("/api/quote/history?view=pending&limit=200").then((result) => {
      if (!alive) return;
      if (result.ok) setRows(result.body.rows);
      else setError(result.body.error ?? "미확정 목록을 불러오지 못했습니다.");
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = rows?.length ?? 0;
  const count = checked.size;
  const toggle = (id: number) => setChecked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function apply(status: "confirmed" | "discarded") {
    if (!count || busy) return;
    setBusy(true);
    setError("");
    const result = await quoteRequest<{ changed: number; ids: number[]; status: QuoteStatus; pending: number }>("/api/quote/issued", "POST", { action: "SET_STATUS", ids: [...checked], status });
    setBusy(false);
    if (!result.ok) { setError(result.body.error ?? `${status === "confirmed" ? "확정" : "폐기"}하지 못했습니다.`); return; }
    notifyQuoteChanged();
    const done = new Set(result.body.ids);
    setRows((current) => (current ?? []).filter((row) => !done.has(row.id)));
    setChecked(new Set());
    onChanged({ ids: result.body.ids, status, changed: result.body.changed, pending: result.body.pending });
  }

  return (
    <div className="quote-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="quote-modal wide" role="dialog" aria-modal="true" aria-labelledby="quote-pending-title">
        <header>
          <strong id="quote-pending-title">발송 확정</strong>
          <button type="button" className="quote-icon-button" aria-label="닫기" onClick={onClose}>×</button>
        </header>
        <div className="quote-modal-body">
          <p className="quote-muted">고객에게 실제로 보낸 건을 확정하세요. 확정분의 단가만 온전한 등급으로 제안에 쓰입니다. 보내지 않은 건은 폐기하세요 — 되돌릴 수 있습니다.</p>
          {rows === null && !error && <p className="quote-muted">불러오는 중…</p>}
          {rows && rows.length === 0 && <p className="quote-muted">미확정 견적이 없습니다.</p>}
          {rows && rows.length > 0 && (
            <ul className="quote-pending-list">
              {rows.map((row) => (
                <li key={row.id}>
                  <label>
                    <input type="checkbox" checked={checked.has(row.id)} onChange={() => toggle(row.id)} />
                    <span className="d">{row.issue_date}</span>
                    <span className="org"><b>{row.customer || "(기관명 없음)"}</b><small>{row.contact}</small></span>
                    <span className="by">{row.author_name}</span>
                    <span className="amt">{row.total ? shortWon(row.total) : "—"}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="quote-error" role="alert">{error}</p>}
        </div>
        <footer>
          <label className="quote-check">
            <input type="checkbox" checked={count > 0 && count === all} disabled={!all}
              ref={(element) => { if (element) element.indeterminate = count > 0 && count < all; }}
              onChange={(event) => setChecked(event.target.checked ? new Set((rows ?? []).map((row) => row.id)) : new Set())} /> 전체 선택
          </label>
          <span className="spacer" />
          <button type="button" onClick={onClose}>닫기</button>
          <button type="button" disabled={!count || busy} onClick={() => void apply("discarded")}>폐기</button>
          <button type="button" className="primary" disabled={!count || busy} onClick={() => void apply("confirmed")}>{count ? `발송 확정 ${count}건` : "발송 확정"}</button>
        </footer>
      </div>
    </div>
  );
}
