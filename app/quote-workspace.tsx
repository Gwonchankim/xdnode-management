"use client";

// 견적 탭 루트(quote-tool Design §10). QT1 은 읽기 전용이다: 상단 상태 알약, 최근·검색 목록, 불러온 과거 견적의 미리보기.
// 편집·생성·발송 확정·AI 추출은 QT2~QT3 에서 더한다. 서버 403 이 최종 방어이고, HTML 문자열 주입은 쓰지 않는다.
import { useEffect, useState } from "react";
import QuoteHistoryView, { type OpenRequest } from "./quote-history-view";
import { STATUS_LABEL, formatWon, koreanAmount, quoteRequest, type LoadedQuote, type QuoteOverview } from "./quote-client";
import { isGroup, lineAmount, subtotal, type Quote } from "./quote-model";

const VIEW_ONLY = "보기 권한만 있습니다. 견적을 만들거나 상태를 바꿀 수 없습니다.";

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={ok ? "quote-pill ok" : "quote-pill off"}>{label} {ok ? "사용 가능" : "사용 불가"}</span>;
}

function QuotePreview({ loaded, showMargin }: { loaded: LoadedQuote; showMargin: boolean }) {
  const quote: Quote = loaded.quote;
  const sum = subtotal(quote);
  const vat = Math.round(sum * 0.1);
  const terms = quote.terms;
  return (
    <article className="quote-preview-body">
      {loaded.source_date && <p className="quote-banner info">원본 작성일 {loaded.source_date} — 새 견적의 작성일은 생성하는 날입니다.</p>}
      <header className="quote-preview-head">
        <div>
          <h3>{quote.customer.org || "(기관 없음)"}</h3>
          <p>{quote.customer.contact}{quote.customer.tel ? ` · ${quote.customer.tel}` : ""}{quote.customer.email ? ` · ${quote.customer.email}` : ""}</p>
        </div>
        <div className="quote-preview-meta">
          <span>{loaded.source.kind === "issued" ? `작성 견적 #${loaded.source.id}` : `과거 파일 #${loaded.source.id}`}</span>
          {loaded.source.status && <span className={`quote-chip ${loaded.source.status}`}>{STATUS_LABEL[loaded.source.status]}</span>}
          <span>시트 {quote.sheet_name}</span>
        </div>
      </header>
      <dl className="quote-terms">
        <div><dt>견적유효기간</dt><dd>견적 후 {terms.valid_weeks}주 이내{terms.stamp_omitted ? " (직인생략)" : ""}</dd></div>
        <div><dt>납품기일</dt><dd>{terms.delivery}</dd></div>
        <div><dt>결제조건</dt><dd>{terms.payment}</dd></div>
        <div><dt>납품장소</dt><dd>{terms.place}</dd></div>
        {terms.project && <div><dt>프로젝트</dt><dd>{terms.project}</dd></div>}
        <div><dt>담당자</dt><dd>{[quote.staff.name, quote.staff.tel, quote.staff.email].filter(Boolean).join(" · ") || "—"}</dd></div>
      </dl>
      <div className="quote-table-wrap">
        <table className="quote-table">
          <thead><tr><th>NO.</th><th>품목명</th><th>제품사양</th><th className="num">수량</th><th className="num">세트</th><th className="num">단가</th><th className="num">금액</th></tr></thead>
          <tbody>
            {quote.lines.map((line, li) => (
              <LineRows key={li} letter={String.fromCharCode(65 + li)} line={line} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="quote-foot">
        <div className="quote-remarks">
          <h4>Remark</h4>
          {quote.remarks.length ? <ul>{quote.remarks.map((remark, index) => <li key={index}>{remark}</li>)}</ul> : <p className="quote-muted">없음</p>}
          {showMargin && quote.margin && <p className="quote-muted">마진율 {(quote.margin.rate * 100).toFixed(1)}% · 매입단가 {Object.keys(quote.margin.buy_units).length}건</p>}
        </div>
        <div className="quote-sum">
          <dl>
            <div><dt>소액</dt><dd>{formatWon(sum)}</dd></div>
            <div><dt>세액</dt><dd>{formatWon(vat)}</dd></div>
            <div className="total"><dt>총액</dt><dd>{formatWon(sum + vat)}</dd></div>
          </dl>
          <p>{koreanAmount(sum + vat)}</p>
        </div>
      </div>
    </article>
  );
}

function LineRows({ letter, line }: { letter: string; line: Quote["lines"][number] }) {
  const group = isGroup(line);
  return (
    <>
      <tr className="quote-line">
        <td>{letter}</td><td>{line.label}</td><td className="spec">{line.name}</td>
        <td className="num">{group ? "" : line.qty ?? 1}</td><td className="num">{group ? line.sets ?? 1 : ""}</td>
        <td className="num">{line.unit_price !== null ? formatWon(line.unit_price) : group ? "상세 합계" : "—"}</td>
        <td className="num">{formatWon(lineAmount(line))}</td>
      </tr>
      {line.items.map((item, ii) => (
        <tr key={ii} className="quote-item">
          <td>{ii + 1}</td>
          <td>{item.category}{item.extra_categories.length ? <small> + {item.extra_categories.join(", ")}</small> : null}</td>
          <td className="spec">{item.spec}</td>
          <td className="num">{item.qty ?? ""}</td><td />
          <td className="num">{item.unit_price !== null ? formatWon(item.unit_price) : ""}</td>
          <td className="num">{item.unit_price !== null && item.qty ? formatWon(item.unit_price * item.qty) : ""}</td>
        </tr>
      ))}
      {line.notes.map((note, ni) => (
        <tr key={`n${ni}`} className="quote-note-row"><td /><td /><td className="spec" colSpan={5}>{note}</td></tr>
      ))}
    </>
  );
}

export default function QuoteWorkspace({ canEdit, isAdmin, userName }: { canEdit: boolean; isAdmin: boolean; accountId: string; userName: string }) {
  const [overview, setOverview] = useState<QuoteOverview | null>(null);
  const [selected, setSelected] = useState<OpenRequest | null>(null);
  const [loaded, setLoaded] = useState<LoadedQuote | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    void quoteRequest<QuoteOverview>("/api/quote/overview").then((result) => { if (alive && result.ok) setOverview(result.body); });
    return () => { alive = false; };
  }, []);

  async function open(request: OpenRequest) {
    setSelected(request);
    setLoading(true);
    setLoadError("");
    const param = request.kind === "issued" ? "issuedId" : "corpusId";
    const result = await quoteRequest<LoadedQuote>(`/api/quote/history?${param}=${request.id}`);
    setLoading(false);
    if (result.ok) setLoaded(result.body);
    else { setLoaded(null); setLoadError(result.body.error ?? "견적을 불러오지 못했습니다."); }
  }

  return (
    <main className="quote-page">
      <header className="quote-head">
        <div>
          <h2>견적</h2>
          <p>작성자 {userName} · 과거 견적을 찾아 내용을 확인합니다.</p>
        </div>
        {overview && (
          <div className="quote-pills" aria-label="견적 도구 상태">
            <Pill ok={overview.helpers.ai} label="AI" />
            <Pill ok={overview.helpers.pdf} label="PDF" />
            <span className={overview.template.ready ? "quote-pill ok" : "quote-pill off"}>견적서 양식 {overview.template.ready ? "준비됨" : "없음"}</span>
            <span className="quote-pill">카탈로그 제품 {overview.catalog.products.toLocaleString("ko-KR")}개</span>
            {overview.pending > 0 && <span className="quote-pill warn">미확정 {overview.pending}건</span>}
          </div>
        )}
      </header>
      {!canEdit && <p className="quote-banner">{VIEW_ONLY}</p>}
      <p className="quote-banner info">견적 작성·생성 화면은 다음 업데이트에서 열립니다. 지금은 과거 견적의 검색과 미리보기만 됩니다.</p>
      <div className="quote-layout">
        <QuoteHistoryView selected={selected} onOpen={(request) => void open(request)} />
        <section className="quote-card quote-preview" aria-label="견적 미리보기" aria-busy={loading}>
          {loading ? <p className="quote-muted">불러오는 중…</p>
            : loadError ? <p className="quote-error" role="alert">{loadError}</p>
              : loaded ? <QuotePreview loaded={loaded} showMargin={canEdit || isAdmin} />
                : <p className="quote-muted">왼쪽 목록에서 견적을 고르면 내용이 여기에 보입니다.</p>}
        </section>
      </div>
    </main>
  );
}
