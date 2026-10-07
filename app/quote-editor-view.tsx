"use client";

// 견적 편집 화면(quote-tool Design §10.2, QT-FR-14, 옛 index.html hdrbar·hdrform·lines·notebox·footbar).
// 머리 요약·머리 편집 폼(수신자·거래 조건·문서 설정·담당자 블록), 품목 편집(세트·단품·상세·병합·확약 문구), 각 행 아래 제안 막대,
// 비고·마진, 하단 생성 바를 그린다. 상태(현재 견적·제안)는 quote-workspace.tsx 가 갖고, 이 파일은 그리기와 편집 콜백만 한다.
// 권한(§10.3): 보기 권한이면 모든 칸이 읽기 전용이고 매입단가 열·마진율·생성·발송 확정·담당자 관리가 없다(서버도 margin 을 지운다).
// 값은 React 텍스트 노드로만 그린다(HTML 문자열 주입 없음). 금액은 KRW, 문구는 한국어다.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { readScoped, writeScoped } from "./client-runtime";
import QuotePriceChart, { Sparkline, shortWon } from "./quote-price-chart";
import {
  formatWon, koreanAmount, quoteFileUrl, type GenerateFailure, type GenerateResult, type QuoteSuggestions, type QuoteVocab, type StaffProfile,
} from "./quote-client";
import { QUOTE_LIMITS, isGroup, itemsPriced, lineAmount, sheetNameError, subtotal, type Quote, type QuoteItem, type QuoteLine } from "./quote-model";
import { quoteFilename } from "./quote-filename";
import { pyRoundInt } from "./quote-pyfmt";
import type { CustomerMatch, HistRow, Suggestion } from "./quote-pricing";

const HEADER_OPEN_KEY = "xdnode-quote-header-open";
const MERGE_COL_KEY = "xdnode-quote-merge-col";

export type QuoteUpdater = (update: (quote: Quote) => Quote) => void;
export type PriceUndo = { entries: Array<{ key: string; before: number | null }>; label: string };

// ── 순수 도우미(편집 규칙) ─────────────────────────────────────────────────
const isEmpty = (value: number | null | undefined) => value === null || value === undefined;
export const letterOf = (index: number) => String.fromCharCode(65 + index);

export function blankItem(category = ""): QuoteItem {
  return { category, spec: "", qty: 1, unit_price: null, extra_categories: [] };
}
export function blankLine(kind: "group" | "single"): QuoteLine {
  return kind === "group"
    ? { label: "Server", name: "", items: [blankItem("Chassis")], sets: 1, qty: null, unit_price: null, notes: [] }
    : { label: "GPU", name: "", items: [], sets: null, qty: 1, unit_price: null, notes: [] };
}

/** 단가 미입력 칸 수(옛 emptyPriceCount): 단품은 단가, 세트는 세트 단가가 없을 때 상세 단가. */
export function emptyPriceCount(quote: Pick<Quote, "lines">) {
  let count = 0;
  for (const line of quote.lines) {
    if (!isGroup(line)) { if (isEmpty(line.unit_price)) count += 1; continue; }
    if (isEmpty(line.unit_price)) for (const item of line.items) if (isEmpty(item.unit_price)) count += 1;
  }
  return count;
}

/** 같은 품목명·같은 수량이 두 번 이상 나오면 '유사 품목'(옛 findDupes). */
function findDupes(line: QuoteLine) {
  const out = new Set<number>();
  line.items.forEach((a, i) => line.items.forEach((b, j) => {
    if (j > i && a.category && a.category.toUpperCase() === b.category.toUpperCase() && Number(a.qty) === Number(b.qty)) { out.add(i); out.add(j); }
  }));
  return out;
}

/** 단가 자리 'li' 또는 'li.ii' 읽기·쓰기(옛 priceAt·setPriceAt). */
export function priceAt(quote: Quote, key: string) {
  const [li, ii] = key.split(".").map(Number);
  const line = quote.lines[li];
  if (!line) return null;
  return Number.isNaN(ii) || ii === undefined ? line.unit_price : line.items[ii]?.unit_price ?? null;
}
export function withPriceAt(quote: Quote, key: string, price: number | null): Quote {
  const [li, ii] = key.split(".").map(Number);
  return {
    ...quote,
    lines: quote.lines.map((line, index) => {
      if (index !== li) return line;
      if (Number.isNaN(ii) || ii === undefined) return { ...line, unit_price: price };
      return { ...line, items: line.items.map((item, itemIndex) => (itemIndex === ii ? { ...item, unit_price: price } : item)) };
    }),
  };
}

/** 매입단가 키('li.ii')를 줄·상세 이동·삭제에 맞춰 옮긴다. map 이 null 을 돌려주면 그 키를 지운다. */
function remapBuy(quote: Quote, map: (li: number, ii: number) => [number, number] | null): Quote {
  if (!quote.margin) return quote;
  const buy: Record<string, number> = {};
  for (const [key, value] of Object.entries(quote.margin.buy_units)) {
    const [li, ii] = key.split(".").map(Number);
    if (!Number.isInteger(li) || !Number.isInteger(ii)) continue;
    const next = map(li, ii);
    if (next) buy[`${next[0]}.${next[1]}`] = value;
  }
  return { ...quote, margin: { ...quote.margin, buy_units: buy } };
}

// ── 입력 부품 ─────────────────────────────────────────────────────────────
const parseMoney = (text: string) => {
  const cleaned = text.replace(/[,\s₩원]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

/** 금액 칸: 천 단위 쉼표, 비어 있으면 주황 점선(markEmpty). data-col 이 같은 칸끼리 Enter·Shift+Enter 로 오르내린다(워크스페이스 단축키). */
function MoneyInput({ value, onChange, placeholder = "미입력", markEmpty = true, col, sugKey, readOnly, label }: {
  value: number | null; onChange: (value: number | null) => void; placeholder?: string; markEmpty?: boolean; col: "set" | "price" | "buy";
  sugKey?: string; readOnly: boolean; label: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const empty = isEmpty(value);
  const shown = editing ?? (empty ? "" : Math.round(value as number) === value ? (value as number).toLocaleString("ko-KR") : String(value));
  return (
    <input className={["quote-money", empty && markEmpty ? "empty" : ""].filter(Boolean).join(" ")} type="text" inputMode="numeric"
      data-col={col} data-sugkey={sugKey} placeholder={placeholder} value={shown} readOnly={readOnly} aria-label={label}
      onFocus={() => { if (!readOnly) setEditing(empty ? "" : String(value)); }}
      onBlur={() => setEditing(null)}
      onChange={(event) => {
        setEditing(event.target.value);
        const parsed = parseMoney(event.target.value);
        if (parsed !== undefined && (parsed === null || Math.abs(parsed) <= 1e12)) onChange(parsed);
      }} />
  );
}

function NumberInput({ value, onChange, readOnly, label, min = 0 }: { value: number | null; onChange: (value: number | null) => void; readOnly: boolean; label: string; min?: number }) {
  return (
    <input className="quote-num" type="number" min={min} max={100000} step="any" value={value ?? ""} readOnly={readOnly} aria-label={label}
      onChange={(event) => onChange(event.target.value === "" ? null : Math.min(100_000, Math.max(min, Number(event.target.value))))} />
  );
}

/** 사양 칸: 3줄까지 보여 주고 '+N줄 더'. 누르면 여러 줄 입력 칸으로 바뀐다(옛 editSpec·blurSpec). */
function SpecCell({ value, onChange, readOnly, label }: { value: string; onChange: (value: string) => void; readOnly: boolean; label: string }) {
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editing || !area.current) return;
    area.current.focus();
    area.current.selectionStart = area.current.value.length;
  }, [editing]);
  const lines = value.split("\n");
  if (editing && !readOnly) {
    return (
      <textarea ref={area} className="quote-spec-edit" rows={Math.min(14, Math.max(2, lines.length))} value={value} maxLength={QUOTE_LIMITS.spec} aria-label={label}
        onChange={(event) => onChange(event.target.value)} onBlur={() => setEditing(false)} />
    );
  }
  return (
    <button type="button" className={value ? "quote-spec-view" : "quote-spec-view empty"} aria-label={`${label}: ${lines[0] || "비어 있음"}${readOnly ? "" : " (눌러서 고치기)"}`}
      onClick={() => setEditing(true)} onFocus={() => { if (!readOnly) setEditing(true); }}>
      <span>{lines.slice(0, 3).join("\n") || (readOnly ? "" : "사양 입력")}</span>
      {lines.length > 3 && <small>+ {lines.length - 3}줄 더 ▾</small>}
    </button>
  );
}

// ── 제안 막대(옛 sugBar) ───────────────────────────────────────────────────
const CONFIDENCE_LABEL = { high: "높음", medium: "보통", low: "낮음" } as const;

function HistoryTable({ rows }: { rows: readonly HistRow[] }) {
  return (
    <table className="quote-hist-table">
      <thead><tr><th>날짜</th><th className="num">단가</th><th>고객</th><th className="num">수량</th><th>출처</th><th>상태</th></tr></thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <td className="mono">{row.date ?? ""}</td>
            <td className="num">{formatWon(row.price)}</td>
            <td>{row.customer ?? ""}</td>
            <td className="num">{row.qty ?? ""}</td>
            <td><span className={row.source === "issued" ? "quote-tag new" : "quote-tag"}>{row.source === "issued" ? "기록" : "견적"}</span></td>
            <td>{row.source === "issued" ? (row.status === "draft" ? "미확정" : "확정") : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SuggestionBar({ sugKey, s, canApply, onApply }: { sugKey: string; s: Suggestion | undefined; canApply: boolean; onApply: (key: string, price: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!s) return null;
  const toggle = (label: string) => (
    <button type="button" className="quote-small" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "접기" : label}</button>
  );
  if (s.suggested === null) {
    // 단가를 내지 않는 이유가 둘이다: 이력이 아예 없거나, 유사도가 낮아 막았거나(gated). 막은 경우에도 이력은 숨기지 않는다.
    if (s.gated && s.history.length) {
      return (
        <div className="quote-sug low" data-sug={sugKey}>
          <span className="quote-conf low">단가 보류</span>
          <span className="cand">이름만 참고 · {s.name ?? ""}</span>
          <span className="meta" title={s.confidence_reason}>{s.confidence_reason}</span>
          {toggle("이력")}
          {open && (
            <div className="quote-sug-panel">
              <p className="reason">이 표기는 카탈로그의 다른 제품과 비슷할 뿐이라 단가를 제안하지 않습니다. 아래 이력을 직접 보고 판단해 주세요.</p>
              <HistoryTable rows={s.history} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="quote-sug none" data-sug={sugKey}>
        <span className="meta">이력 없음 · 직접 입력</span>
        {s.name && <span className="quote-tag">{s.name}</span>}
      </div>
    );
  }
  const price = s.suggested;
  const flat = s.min === s.max;
  const source = s.suggested_source === "issued" ? "작성 기록" : "과거 견적";
  if (s.caution) {
    return (
      <div className="quote-sug caution" data-sug={sugKey} data-caution="1">
        <span className="flag">⚠ 확인 필요</span>
        <span className="price">제안 {formatWon(price)}</span>
        {toggle("근거 보기")}
        {open && (
          <div className="quote-sug-panel">
            <p className="reason">{s.caution}</p>
            <div className="quote-sug-actions">
              {canApply && <button type="button" className="quote-small data" onClick={() => onApply(sugKey, price)}>이 단가 적용</button>}
              <span className="meta">범위 {shortWon(s.min)}~{shortWon(s.max)} · {s.history.length}건 · {source}</span>
            </div>
            <HistoryTable rows={s.history} />
            <QuotePriceChart history={s.history} label={s.name ?? "품목"} />
          </div>
        )}
      </div>
    );
  }
  const showDelta = s.delta_pct !== null && Math.abs(s.delta_pct) >= 0.1;
  return (
    <div className={s.confidence === "low" ? "quote-sug low" : "quote-sug"} data-sug={sugKey}>
      <span className="price">제안 {formatWon(price)}</span>
      <span className={`quote-conf ${s.confidence}`} title={s.confidence_reason}>신뢰도 {CONFIDENCE_LABEL[s.confidence]}</span>
      {showDelta && (
        <span className={(s.delta ?? 0) > 0 ? "delta up" : "delta down"} title="현재 입력값 대비 최신 이력">
          {(s.delta ?? 0) > 0 ? "+" : ""}{s.delta_pct}%{s.age_days !== null ? ` · ${s.age_days}일 전` : ""}
        </span>
      )}
      {s.anchor_name && <span className="cand" title="단가를 가져온 후보">← {s.anchor_name}</span>}
      <Sparkline history={s.history} />
      <span className="meta" title={s.note ?? undefined}>
        {flat ? `${s.history.length}건 모두 동일` : `${s.history.length}건 · ${shortWon(s.min)}~${shortWon(s.max)}`} · {(s.suggested_date ?? "").slice(0, 10)}{s.note ? " ⓘ" : ""}
      </span>
      {canApply && <button type="button" className="quote-small data" onClick={() => onApply(sugKey, price)}>적용</button>}
      {toggle("이력")}
      {open && (
        <div className="quote-sug-panel">
          <HistoryTable rows={s.history} />
          {!flat && <QuotePriceChart history={s.history} label={s.name ?? "품목"} />}
        </div>
      )}
    </div>
  );
}

// ── 품목 한 줄 ────────────────────────────────────────────────────────────
type LineProps = {
  line: QuoteLine; li: number; count: number; suggestions: QuoteSuggestions; canEdit: boolean; showMargin: boolean; showMerge: boolean;
  buy: Record<string, number>; onLine: (li: number, update: (line: QuoteLine) => QuoteLine) => void; onKind: (li: number, kind: "group" | "single") => void;
  onMove: (li: number, delta: number) => void; onDelete: (li: number) => void; onDeleteItem: (li: number, ii: number) => void;
  onBuy: (key: string, value: number | null) => void; onApply: (key: string, price: number) => void;
};

/** 그 줄의 키('li'·'li.ii')만 비교한다. 다른 줄의 제안·매입단가가 바뀌어도 이 줄은 다시 그리지 않는다(큰 견적의 입력 지연 방지). */
function sameForLine<T>(li: number, a: Record<string, T>, b: Record<string, T>) {
  if (a === b) return true;
  const mine = (key: string) => key === String(li) || key.startsWith(`${li}.`);
  const keysA = Object.keys(a).filter(mine);
  const keysB = Object.keys(b).filter(mine);
  return keysA.length === keysB.length && keysA.every((key) => a[key] === b[key]);
}
function sameLineProps(prev: LineProps, next: LineProps) {
  return prev.line === next.line && prev.li === next.li && prev.count === next.count && prev.canEdit === next.canEdit && prev.showMargin === next.showMargin
    && prev.showMerge === next.showMerge && prev.onLine === next.onLine && prev.onKind === next.onKind && prev.onMove === next.onMove && prev.onDelete === next.onDelete
    && prev.onDeleteItem === next.onDeleteItem && prev.onBuy === next.onBuy && prev.onApply === next.onApply
    && sameForLine(next.li, prev.suggestions, next.suggestions) && sameForLine(next.li, prev.buy, next.buy);
}

const LineEditor = memo(function LineEditor({ line, li, count, suggestions, canEdit, showMargin, showMerge, buy, onLine, onKind, onMove, onDelete, onDeleteItem, onBuy, onApply }: LineProps) {
  const group = isGroup(line);
  const readOnly = !canEdit;
  const letter = letterOf(li);
  const dupes = group ? findDupes(line) : new Set<number>();
  const setPriced = !isEmpty(line.unit_price);
  const setItem = (ii: number, patch: Partial<QuoteItem>) => onLine(li, (current) => ({ ...current, items: current.items.map((item, index) => (index === ii ? { ...item, ...patch } : item)) }));
  return (
    <section className="quote-line-card" aria-label={`${letter} 줄`}>
      <div className="quote-line-head">
        <span className="quote-line-no" aria-hidden="true">{letter}</span>
        <input value={line.label} list="quote-dl-labels" maxLength={QUOTE_LIMITS.label} readOnly={readOnly} aria-label={`${letter} 품목명`}
          onChange={(event) => onLine(li, (current) => ({ ...current, label: event.target.value }))} />
        <input value={line.name} maxLength={QUOTE_LIMITS.name} readOnly={readOnly} placeholder="대표 모델명" aria-label={`${letter} 대표 모델명`}
          onChange={(event) => onLine(li, (current) => ({ ...current, name: event.target.value }))} />
        <select value={group ? "group" : "single"} disabled={readOnly} aria-label={`${letter} 유형`} onChange={(event) => onKind(li, event.target.value as "group" | "single")}>
          <option value="group">세트</option>
          <option value="single">단품</option>
        </select>
        {group
          ? <NumberInput value={line.sets ?? 1} readOnly={readOnly} label={`${letter} 세트 수`} onChange={(value) => onLine(li, (current) => ({ ...current, sets: value }))} />
          : <NumberInput value={line.qty ?? 1} readOnly={readOnly} label={`${letter} 수량`} onChange={(value) => onLine(li, (current) => ({ ...current, qty: value }))} />}
        <MoneyInput value={line.unit_price} col="set" sugKey={String(li)} readOnly={readOnly} placeholder={group ? (itemsPriced(line) ? "상세 합계" : "미입력") : "미입력"}
          markEmpty={!group} label={`${letter} ${group ? "세트 단가" : "단가"}`} onChange={(value) => onLine(li, (current) => ({ ...current, unit_price: value }))} />
        <span className="quote-line-amt">{formatWon(lineAmount(line))}</span>
        {canEdit && (
          <span className="quote-line-tools">
            <button type="button" className="quote-icon-button" disabled={li === 0} aria-label={`${letter} 줄 위로`} onClick={() => onMove(li, -1)}>↑</button>
            <button type="button" className="quote-icon-button" disabled={li === count - 1} aria-label={`${letter} 줄 아래로`} onClick={() => onMove(li, 1)}>↓</button>
            <button type="button" className="quote-icon-button" aria-label={`${letter} 줄 삭제`} onClick={() => onDelete(li)}>✕</button>
          </span>
        )}
      </div>
      <SuggestionBar sugKey={String(li)} s={suggestions[String(li)]} canApply={canEdit} onApply={onApply} />
      {group && (
        <div className="quote-line-body">
          <table className="quote-items">
            <thead>
              <tr>
                <th className="no">#</th><th className="cat">품목명</th><th>제품사양</th><th className="num">수량</th><th className="num">단가</th>
                {showMargin && <th className="num">매입단가</th>}
                {showMerge && <th className="merge">병합</th>}
                {canEdit && <th className="tools" aria-label="삭제" />}
              </tr>
            </thead>
            <tbody>
              {line.items.map((item, ii) => {
                const key = `${li}.${ii}`;
                const columns = 5 + (showMargin ? 1 : 0) + (showMerge ? 1 : 0) + (canEdit ? 1 : 0);
                const suggestion = suggestions[key];
                return [
                  <tr key={`i${ii}`} className={suggestion ? "has-sug" : undefined}>
                    <td className="no">{ii + 1}</td>
                    <td className="cat">
                      <input value={item.category} list="quote-dl-cats" maxLength={QUOTE_LIMITS.category} readOnly={readOnly} aria-label={`${letter}-${ii + 1} 품목명`}
                        onChange={(event) => setItem(ii, { category: event.target.value })} />
                      {dupes.has(ii) && <small className="quote-warn-text">⚠ 유사 품목</small>}
                    </td>
                    <td><SpecCell value={item.spec} readOnly={readOnly} label={`${letter}-${ii + 1} 제품사양`} onChange={(value) => setItem(ii, { spec: value })} /></td>
                    <td className="num"><NumberInput value={item.qty} readOnly={readOnly} label={`${letter}-${ii + 1} 수량`} onChange={(value) => setItem(ii, { qty: value })} /></td>
                    <td className="num">
                      <MoneyInput value={item.unit_price} col="price" sugKey={key} readOnly={readOnly} markEmpty={!setPriced} label={`${letter}-${ii + 1} 단가`}
                        onChange={(value) => setItem(ii, { unit_price: value })} />
                    </td>
                    {showMargin && (
                      <td className="num">
                        <MoneyInput value={buy[key] ?? null} col="buy" readOnly={readOnly} markEmpty={false} placeholder="—" label={`${letter}-${ii + 1} 매입단가`}
                          onChange={(value) => onBuy(key, value)} />
                      </td>
                    )}
                    {showMerge && (
                      <td className="merge">
                        <input value={item.extra_categories.join(",")} readOnly={readOnly} placeholder="Board" aria-label={`${letter}-${ii + 1} 병합 품목`}
                          title="사양 칸을 아래 행까지 세로로 병합할 때 아래 행들의 품목명(쉼표로 구분)"
                          onChange={(event) => setItem(ii, { extra_categories: event.target.value.split(",").map((part) => part.trim()).filter(Boolean).slice(0, QUOTE_LIMITS.extraCategories) })} />
                      </td>
                    )}
                    {canEdit && <td className="tools"><button type="button" className="quote-icon-button" aria-label={`${letter}-${ii + 1} 행 삭제`} onClick={() => onDeleteItem(li, ii)}>✕</button></td>}
                  </tr>,
                  suggestion ? (
                    <tr key={`s${ii}`} className="quote-sug-row"><td colSpan={columns}><SuggestionBar sugKey={key} s={suggestion} canApply={canEdit} onApply={onApply} /></td></tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
          <div className="quote-line-foot">
            {canEdit && (
              <button type="button" className="quote-small" disabled={line.items.length >= QUOTE_LIMITS.itemsPerLine}
                onClick={() => onLine(li, (current) => ({ ...current, items: [...current.items, blankItem()] }))}>+ 상세 행</button>
            )}
            <textarea rows={1} value={line.notes.join("\n")} readOnly={readOnly} placeholder={readOnly ? "" : "확약 문구 등 (줄바꿈으로 구분)"} aria-label={`${letter} 확약 문구`}
              onChange={(event) => onLine(li, (current) => ({ ...current, notes: event.target.value.split("\n").slice(0, QUOTE_LIMITS.notes) }))} />
          </div>
        </div>
      )}
    </section>
  );
}, sameLineProps);

// ── 머리 요약·편집 폼 ───────────────────────────────────────────────────────
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={wide ? "quote-field wide" : "quote-field"}><span>{label}</span>{children}</label>;
}

function QuoteHeader({ draft, update, canEdit, customerMatches, staffProfiles, onManageStaff, sourceDate, vocab }: {
  draft: Quote; update: QuoteUpdater; canEdit: boolean; customerMatches: CustomerMatch[] | null; staffProfiles: StaffProfile[];
  onManageStaff: () => void; sourceDate: string | null; vocab: QuoteVocab | null;
}) {
  const [open, setOpen] = useState(() => readScoped(HEADER_OPEN_KEY) === "1");
  const readOnly = !canEdit;
  const { customer, terms, staff } = draft;
  const setCustomer = (patch: Partial<Quote["customer"]>) => update((quote) => ({ ...quote, customer: { ...quote.customer, ...patch } }));
  const setTerms = (patch: Partial<Quote["terms"]>) => update((quote) => ({ ...quote, terms: { ...quote.terms, ...patch } }));
  const setStaff = (patch: Partial<Quote["staff"]>) => update((quote) => ({ ...quote, staff: { ...quote.staff, ...patch } }));
  const summaryTerms = [`유효 ${terms.valid_weeks}주`, terms.delivery, terms.payment, terms.place].filter(Boolean).join(" · ");
  const sheetError = sheetNameError(draft.sheet_name);
  const toggle = () => setOpen((value) => { writeScoped(HEADER_OPEN_KEY, value ? "0" : "1"); return !value; });
  const profileMatch = staffProfiles.find((profile) => profile.name === staff.name);
  return (
    <section className="quote-card quote-header" aria-label="견적 머리">
      <div className="quote-hdrbar">
        {customer.org || customer.contact
          ? <strong>{customer.org}{customer.contact ? ` · ${customer.contact}` : ""}</strong>
          : <span className="quote-muted">{canEdit ? "기관명을 입력하거나 AI 추출·과거 견적으로 채우세요" : "왼쪽 목록에서 과거 견적을 고르세요"}</span>}
        <span className="quote-hdr-terms">{summaryTerms}</span>
        {staff.name && <span className="quote-hdr-terms">담당 {staff.name}</span>}
        <button type="button" className="quote-small" aria-expanded={open} onClick={toggle}>{open ? "접기 ▴" : canEdit ? "편집 ▾" : "자세히 ▾"}</button>
      </div>
      {sourceDate && <p className="quote-banner info">원본 작성일 {sourceDate} — 새 견적의 작성일은 생성하는 날입니다.</p>}
      {open && (
        <div className="quote-hdrform">
          <h4>수신자</h4>
          <div className="quote-grid four">
            <Field label="기관명 (TO.)"><input value={customer.org} maxLength={QUOTE_LIMITS.org} readOnly={readOnly} onChange={(event) => setCustomer({ org: event.target.value })} /></Field>
            <Field label="담당자 (CC.)"><input value={customer.contact} maxLength={QUOTE_LIMITS.contact} readOnly={readOnly} placeholder="홍길동 교수님" onChange={(event) => setCustomer({ contact: event.target.value })} /></Field>
            <Field label="연락처"><input value={customer.tel ?? ""} maxLength={QUOTE_LIMITS.tel} readOnly={readOnly} onChange={(event) => setCustomer({ tel: event.target.value || null })} /></Field>
            <Field label="이메일"><input value={customer.email ?? ""} maxLength={QUOTE_LIMITS.email} readOnly={readOnly} onChange={(event) => setCustomer({ email: event.target.value || null })} /></Field>
          </div>
          {canEdit && customerMatches && customerMatches.length > 0 && (
            <div className="quote-cands" aria-label="고객 후보">
              <span className="quote-muted">고객 후보</span>
              {customerMatches.slice(0, 4).map((match, index) => (
                <button type="button" key={index} className="quote-link"
                  onClick={() => setCustomer({ org: match.org, ...(match.contact ? { contact: match.contact } : {}), ...(match.tel ? { tel: match.tel } : {}), ...(match.email ? { email: match.email } : {}) })}>
                  {match.org} / {match.contact || "-"}
                </button>
              ))}
            </div>
          )}
          <h4>거래 조건</h4>
          <div className="quote-grid four">
            <Field label="견적유효기간">
              <select value={terms.valid_weeks} disabled={readOnly} onChange={(event) => setTerms({ valid_weeks: Number(event.target.value) })}>
                {[...new Set([1, 2, 3, 4, 6, 8, 12, terms.valid_weeks])].sort((a, b) => a - b).map((weeks) => <option key={weeks} value={weeks}>{weeks}주</option>)}
              </select>
            </Field>
            <Field label="납품기일"><input value={terms.delivery} list="quote-dl-delivery" maxLength={QUOTE_LIMITS.term} readOnly={readOnly} onChange={(event) => setTerms({ delivery: event.target.value })} /></Field>
            <Field label="결제조건"><input value={terms.payment} list="quote-dl-payment" maxLength={QUOTE_LIMITS.term} readOnly={readOnly} onChange={(event) => setTerms({ payment: event.target.value })} /></Field>
            <Field label="납품장소"><input value={terms.place} maxLength={QUOTE_LIMITS.term} readOnly={readOnly} onChange={(event) => setTerms({ place: event.target.value })} /></Field>
          </div>
          <h4>문서 설정</h4>
          <div className="quote-grid four">
            <Field label="프로젝트명 / 입찰 건명" wide><input value={terms.project ?? ""} maxLength={QUOTE_LIMITS.project} readOnly={readOnly} onChange={(event) => setTerms({ project: event.target.value || null })} /></Field>
            <Field label="시트명">
              <input value={draft.sheet_name} maxLength={QUOTE_LIMITS.sheetName} readOnly={readOnly} aria-invalid={sheetError ? true : undefined}
                onChange={(event) => update((quote) => ({ ...quote, sheet_name: event.target.value }))} />
            </Field>
            <Field label="파일명 모델 표기"><input value={draft.model_hint ?? ""} maxLength={QUOTE_LIMITS.modelHint} readOnly={readOnly} placeholder="비우면 자동" onChange={(event) => update((quote) => ({ ...quote, model_hint: event.target.value || null }))} /></Field>
          </div>
          {sheetError && <p className="quote-error">{sheetError}</p>}
          <label className="quote-check">
            <input type="checkbox" checked={terms.stamp_omitted} disabled={readOnly} onChange={(event) => setTerms({ stamp_omitted: event.target.checked })} /> 견적유효기간 뒤에 「(직인생략)」 표기
          </label>
          <h4>담당자 블록 <small>(견적서 H15~H17)</small></h4>
          <div className="quote-grid four">
            <Field label="프로필">
              <select value={profileMatch?.id ?? ""} disabled={readOnly} onChange={(event) => {
                const profile = staffProfiles.find((entry) => entry.id === event.target.value);
                if (profile) setStaff({ name: profile.name, tel: profile.tel, email: profile.email });
              }}>
                <option value="">{profileMatch ? "" : "직접 입력"}</option>
                {staffProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </Field>
            <Field label="이름"><input value={staff.name} maxLength={QUOTE_LIMITS.staffName} readOnly={readOnly} onChange={(event) => setStaff({ name: event.target.value })} /></Field>
            <Field label="연락처"><input value={staff.tel} maxLength={QUOTE_LIMITS.staffTel} readOnly={readOnly} onChange={(event) => setStaff({ tel: event.target.value })} /></Field>
            <Field label="이메일"><input value={staff.email} maxLength={QUOTE_LIMITS.staffEmail} readOnly={readOnly} onChange={(event) => setStaff({ email: event.target.value })} /></Field>
          </div>
          {canEdit && <button type="button" className="quote-small" onClick={onManageStaff} title="Alt+P">담당자 관리</button>}
        </div>
      )}
      <datalist id="quote-dl-delivery">{(vocab?.delivery ?? []).map((value) => <option key={value} value={value} />)}</datalist>
      <datalist id="quote-dl-payment">{(vocab?.payment ?? []).map((value) => <option key={value} value={value} />)}</datalist>
      <datalist id="quote-dl-labels">{(vocab?.group_labels ?? []).map((value) => <option key={value} value={value} />)}</datalist>
      <datalist id="quote-dl-cats">{(vocab?.categories ?? []).map((value) => <option key={value} value={value} />)}</datalist>
    </section>
  );
}

// ── 하단 생성 바 ─────────────────────────────────────────────────────────
export type FooterState = {
  busy: "generate" | "confirm" | "pdf" | null; result: GenerateResult | null; failure: GenerateFailure | null;
  confirmMessage: string; stale: boolean; withPdf: boolean; suffix: string;
};

function QuoteFooter({ draft, canEdit, state, setState, today, onGenerate, onConfirm, onRegeneratePdf, onDownloadFailure }: {
  draft: Quote; canEdit: boolean; state: FooterState; setState: (patch: Partial<FooterState>) => void; today: string;
  onGenerate: () => void; onConfirm: () => void; onRegeneratePdf: () => void; onDownloadFailure: () => void;
}) {
  const [popOpen, setPopOpen] = useState(false);
  const sub = subtotal(draft);
  const total = pyRoundInt(sub * 1.1);
  const empty = emptyPriceCount(draft);
  const fileName = quoteFilename(draft, state.suffix.trim() || null, today);
  const { result, failure } = state;
  return (
    <div className="quote-footbar" aria-label="합계와 생성">
      <span className={!draft.lines.length ? "quote-foot-chip muted" : empty ? "quote-foot-chip warn" : "quote-foot-chip ok"}>
        {!draft.lines.length ? "품목을 추가하세요" : empty ? `⚠ 단가 미입력 ${empty}칸` : "✓ 단가 완료"}
      </span>
      <span className="quote-foot-sum">소계 <b>{formatWon(sub)}</b></span>
      <span className="quote-foot-sum">세액 <b>{formatWon(total - sub)}</b></span>
      <span className="quote-foot-total" title={sub ? koreanAmount(total) : undefined}><span>총액</span><b>{formatWon(total)}</b></span>
      {sub > 0 && <span className="quote-foot-korean">{koreanAmount(total)}</span>}
      {canEdit && (
        <span className="quote-foot-actions">
          <button type="button" className="primary" disabled={!draft.lines.length || state.busy !== null} title="Alt+G" onClick={onGenerate}>
            {state.busy === "generate" ? "생성 중…" : state.withPdf ? "xlsx + PDF 생성" : "xlsx 생성"}
          </button>
          <button type="button" className={result && !state.stale ? "brand" : undefined} disabled={!result || state.busy !== null || result.status === "confirmed"}
            title="고객에게 발송한 것을 확인했다면 눌러 확정하세요. 생성만으로도 '미확정'으로 기록돼 있습니다." onClick={onConfirm}>
            {state.busy === "confirm" ? "확정 중…" : result?.status === "confirmed" ? "발송 확정됨" : "발송 확정"}
          </button>
          <button type="button" className="ghost" aria-expanded={popOpen} aria-label="생성 설정" onClick={() => setPopOpen((value) => !value)}>⋯</button>
          {popOpen && (
            <div className="quote-pop" role="group" aria-label="생성 설정">
              <label className="quote-check"><input type="checkbox" checked={state.withPdf} onChange={(event) => setState({ withPdf: event.target.checked })} /> PDF 함께 생성</label>
              <label className="quote-field"><span>파일명 접미 (선택)</span>
                <input value={state.suffix} maxLength={40} placeholder="2EA, 수정 …" onChange={(event) => setState({ suffix: event.target.value })} />
              </label>
              <p className="quote-muted">생성하면 &lsquo;미확정&rsquo;으로 기록됩니다. 발송을 확인하면 [발송 확정]을 눌러 확정하세요.</p>
            </div>
          )}
        </span>
      )}
      <div className="quote-foot-result" aria-live="polite">
        {canEdit && <span className="quote-filename" title="생성될 파일명">{fileName}</span>}
        {result && (
          <span className="quote-result-links">
            {result.unchanged && <span className="quote-muted">같은 내용의 확정 견적(#{result.issuedId})이 이미 있어 기존 파일을 드립니다.</span>}
            {result.files.xlsx && <a href={quoteFileUrl(result.issuedId, "xlsx")} download>⬇ xlsx 받기</a>}
            {result.files.pdf
              ? <a href={quoteFileUrl(result.issuedId, "pdf")} download>⬇ PDF 받기</a>
              : result.pdfError
                ? <span className="quote-warn-text">PDF 실패: {result.pdfError.message} <button type="button" className="quote-link" disabled={state.busy !== null} onClick={onRegeneratePdf}>{state.busy === "pdf" ? "만드는 중…" : "다시 만들기"}</button></span>
                : null}
            <span className="quote-muted">#{result.issuedId} · {result.status === "confirmed" ? "확정" : "미확정"}</span>
          </span>
        )}
        {failure && (
          <span className="quote-error" role="alert">
            {failure.error ?? "파일 생성에 실패했습니다."}
            {failure.xlsxBase64 && <button type="button" className="quote-link" onClick={onDownloadFailure}>파일 받기</button>}
          </span>
        )}
        {state.confirmMessage && (
          <span className={state.stale ? "quote-error" : "quote-muted"} role={state.stale ? "alert" : undefined}>
            {state.confirmMessage}
            {state.stale && <button type="button" className="quote-link" disabled={state.busy !== null} onClick={onGenerate}>다시 생성</button>}
          </span>
        )}
      </div>
    </div>
  );
}

// ── 편집 화면 전체 ────────────────────────────────────────────────────────
export type EditorProps = {
  draft: Quote; update: QuoteUpdater; canEdit: boolean; showMargin: boolean;
  suggestions: QuoteSuggestions; suggestBusy: boolean; suggestError: string; onRetrySuggest: () => void;
  customerMatches: CustomerMatch[] | null; staffProfiles: StaffProfile[]; onManageStaff: () => void; sourceDate: string | null; vocab: QuoteVocab | null;
  onApply: (key: string, price: number) => void; onApplyAll: () => void; onRefreshPast: () => void; undo: PriceUndo | null; onUndo: () => void;
  onOpenSearch: () => void; footer: FooterState; setFooter: (patch: Partial<FooterState>) => void;
  onGenerate: () => void; onConfirm: () => void; onRegeneratePdf: () => void; onDownloadFailure: () => void; emptyHint: ReactNode;
  /** 파일명 미리보기의 작성일(KST 오늘). 생성 때는 서버가 정한다. */
  today: string;
};

export default function QuoteEditorView(props: EditorProps) {
  const { draft, update, canEdit, showMargin, suggestions, onApply } = props;
  const [showMerge, setShowMerge] = useState(() => readScoped(MERGE_COL_KEY) === "1" || draft.lines.some((line) => line.items.some((item) => item.extra_categories.length)));
  const [notesOpen, setNotesOpen] = useState(false);

  const onLine = useCallback((li: number, change: (line: QuoteLine) => QuoteLine) => {
    update((quote) => ({ ...quote, lines: quote.lines.map((line, index) => (index === li ? change(line) : line)) }));
  }, [update]);
  const onKind = useCallback((li: number, kind: "group" | "single") => {
    update((quote) => {
      const lines = quote.lines.map((line, index) => {
        if (index !== li) return line;
        if (kind === "group") return { ...line, items: line.items.length ? line.items : [blankItem("Chassis")], sets: line.sets ?? 1, qty: null };
        return { ...line, items: [], sets: null, qty: line.qty ?? 1 };
      });
      const next = { ...quote, lines };
      return kind === "single" ? remapBuy(next, (l, i) => (l === li ? null : [l, i])) : next;
    });
  }, [update]);
  const onMove = useCallback((li: number, delta: number) => {
    update((quote) => {
      const target = li + delta;
      if (target < 0 || target >= quote.lines.length) return quote;
      const lines = [...quote.lines];
      [lines[li], lines[target]] = [lines[target], lines[li]];
      return remapBuy({ ...quote, lines }, (l, i) => [l === li ? target : l === target ? li : l, i]);
    });
  }, [update]);
  const onDelete = useCallback((li: number) => {
    update((quote) => remapBuy({ ...quote, lines: quote.lines.filter((_, index) => index !== li) }, (l, i) => (l === li ? null : [l > li ? l - 1 : l, i])));
  }, [update]);
  const onDeleteItem = useCallback((li: number, ii: number) => {
    update((quote) => remapBuy(
      { ...quote, lines: quote.lines.map((line, index) => (index === li ? { ...line, items: line.items.filter((_, itemIndex) => itemIndex !== ii) } : line)) },
      (l, i) => (l !== li ? [l, i] : i === ii ? null : [l, i > ii ? i - 1 : i]),
    ));
  }, [update]);
  const onBuy = useCallback((key: string, value: number | null) => {
    update((quote) => {
      const margin = quote.margin ?? { rate: 0.1, buy_units: {}, gpu_buy_unit: null, gpu_sell_unit: null };
      const buy = { ...margin.buy_units };
      if (value === null) delete buy[key]; else buy[key] = value;
      return { ...quote, margin: { ...margin, buy_units: buy } };
    });
  }, [update]);

  const buyUnits = useMemo(() => draft.margin?.buy_units ?? {}, [draft.margin]);

  const empty = emptyPriceCount(draft);
  const toggleMerge = () => setShowMerge((value) => { writeScoped(MERGE_COL_KEY, value ? "0" : "1"); return !value; });
  const addLine = (kind: "group" | "single") => update((quote) => (quote.lines.length >= QUOTE_LIMITS.lines ? quote : { ...quote, lines: [...quote.lines, blankLine(kind)] }));
  const remarks = draft.remarks.join("\n");
  const rate = draft.margin?.rate ?? 0.1;

  function gotoEmptyFromCounter(event: KeyboardEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>(".quote-module-shell .quote-money.empty");
    if (input) { input.scrollIntoView({ block: "center" }); input.focus(); }
  }

  return (
    <div className="quote-editor">
      <QuoteHeader draft={draft} update={update} canEdit={canEdit} customerMatches={props.customerMatches} staffProfiles={props.staffProfiles}
        onManageStaff={props.onManageStaff} sourceDate={props.sourceDate} vocab={props.vocab} />

      <section className="quote-card quote-lines" aria-label="품목">
        <header className="quote-lines-head">
          <h3>품목</h3>
          {draft.lines.length > 0 && (empty
            ? <button type="button" className="quote-link warn" title="Alt+1" onClick={gotoEmptyFromCounter}>⚠ 단가 미입력 {empty}</button>
            : <span className="quote-ok-text">✓ 단가 완료</span>)}
          {props.suggestBusy && <span className="quote-muted" role="status">단가 제안을 찾는 중…</span>}
          <span className="quote-lines-tools">
            {canEdit && <button type="button" className="quote-small" onClick={props.onApplyAll}>빈 단가 일괄 적용</button>}
            {canEdit && <button type="button" className="quote-small" title="이미 값이 있는 행을 최신 이력으로 갱신합니다(불러온 견적용)" onClick={props.onRefreshPast}>과거 단가 갱신</button>}
            {canEdit && props.undo && <button type="button" className="quote-small ghost" onClick={props.onUndo}>되돌리기 · {props.undo.label}</button>}
            <button type="button" className="quote-small ghost" aria-pressed={showMerge} title="병합 열 표시/숨김" onClick={toggleMerge}>⋯ 병합 열</button>
          </span>
        </header>
        {props.suggestError && (
          <p className="quote-error" role="alert">{props.suggestError} <button type="button" className="quote-link" onClick={props.onRetrySuggest}>다시 시도</button></p>
        )}
        {draft.lines.length === 0 ? (
          <div className="quote-empty-cta">
            {props.emptyHint}
            <div className="cta">
              <h5>과거 견적 불러오기</h5>
              <p>왼쪽 「검색」에서 기관명이나 모델로 찾아 그대로 불러옵니다.</p>
              <button type="button" onClick={props.onOpenSearch}>검색 열기</button>
            </div>
          </div>
        ) : draft.lines.map((line, li) => (
          <LineEditor key={li} line={line} li={li} count={draft.lines.length} suggestions={suggestions} canEdit={canEdit} showMargin={showMargin} showMerge={showMerge}
            buy={buyUnits} onLine={onLine} onKind={onKind} onMove={onMove} onDelete={onDelete} onDeleteItem={onDeleteItem} onBuy={onBuy} onApply={onApply} />
        ))}
        {canEdit && (
          <div className="quote-lines-add">
            <button type="button" className="quote-small" disabled={draft.lines.length >= QUOTE_LIMITS.lines} onClick={() => addLine("group")}>+ 세트 행</button>
            <button type="button" className="quote-small" disabled={draft.lines.length >= QUOTE_LIMITS.lines} onClick={() => addLine("single")}>+ 단품 행</button>
            {draft.lines.length >= QUOTE_LIMITS.lines && <small className="quote-muted">품목 줄은 {QUOTE_LIMITS.lines}줄(A~Z)까지입니다.</small>}
          </div>
        )}
      </section>

      <section className="quote-card quote-notes" aria-label={showMargin ? "비고와 마진" : "비고"}>
        <header className="quote-lines-head">
          <h3>비고{showMargin ? " · 마진" : ""}</h3>
          <button type="button" className="quote-small ghost" aria-expanded={notesOpen} onClick={() => setNotesOpen((value) => !value)}>{notesOpen ? "접기 ▴" : "펼치기 ▾"}</button>
        </header>
        {notesOpen ? (
          <div className="quote-grid two">
            <label className="quote-field"><span>Remark (줄바꿈으로 여러 줄)</span>
              <textarea rows={3} value={remarks} readOnly={!canEdit}
                onChange={(event) => update((quote) => ({ ...quote, remarks: event.target.value.split("\n").slice(0, QUOTE_LIMITS.remarks) }))} />
            </label>
            {showMargin && (
              <label className="quote-field"><span>마진율 (마진계산용 시트, 0~1)</span>
                <input type="number" min={0} max={1} step={0.01} value={rate} readOnly={!canEdit}
                  onChange={(event) => {
                    const value = event.target.value === "" ? 0.1 : Math.min(1, Math.max(0, Number(event.target.value)));
                    update((quote) => ({ ...quote, margin: { ...(quote.margin ?? { buy_units: {}, gpu_buy_unit: null, gpu_sell_unit: null }), rate: value } }));
                  }} />
              </label>
            )}
          </div>
        ) : (
          <p className="quote-muted">{draft.remarks.filter(Boolean).join(" / ") || "비고 없음"}{showMargin ? ` · 마진율 ${rate}` : ""}</p>
        )}
      </section>

      <QuoteFooter draft={draft} canEdit={canEdit} state={props.footer} setState={props.setFooter} today={props.today} onGenerate={props.onGenerate} onConfirm={props.onConfirm}
        onRegeneratePdf={props.onRegeneratePdf} onDownloadFailure={props.onDownloadFailure} />
    </div>
  );
}
