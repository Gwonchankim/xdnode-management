"use client";

// 견적 탭 루트(quote-tool Design §10). 상단 상태 알약·미확정 버튼·단축키 도움말, 왼쪽 메일(AI 추출)·최근·검색, 오른쪽 편집 화면과 하단 생성 바.
// 상태(현재 견적·단가 제안·고객 후보·불러온 원본일·마지막 생성 결과)를 여기서 갖고, 그리기는 quote-editor-view.tsx 등이 한다.
// 권한(§10.3): 편집(또는 관리자)은 전체 편집기, 보기는 읽기 전용(매입단가·마진·AI 추출·생성·발송 확정·미확정 일괄·담당자 관리 없음).
// 서버 403 이 최종 방어다. HTML 문자열 주입은 쓰지 않는다. 브라우저는 로컬 도우미(AI·PDF)를 직접 부르지 않고 /api/quote/* 만 부른다.
//
// 단가 제안 성능(QT3b): compute SUGGEST 는 상세 행마다 수 ms 가 들어 큰 견적 전체를 매번 다시 물으면 느리다. 줄 내용 키로 결과를 기억하고
// (app/quote-suggest-plan.ts), 입력이 SUGGEST_DEBOUNCE_MS 동안 멈추면 키가 바뀐 줄만 lineIndexes 와 함께 묻는다(customers:false).
// 응답은 그 줄 키로 저장되므로 늦게 온 응답이 지금 화면을 틀리게 만들지 않고, 기억을 비운 뒤(발송 확정·상태 변경) 도착한 응답은 버린다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useErpDialog } from "./erp-dialog";
import QuoteAssistView from "./quote-assist-view";
import QuoteEditorView, { emptyPriceCount, priceAt, withPriceAt, type FooterState, type PriceUndo } from "./quote-editor-view";
import QuoteHistoryView, { PendingDialog, type OpenRequest, type StatusChange } from "./quote-history-view";
import QuoteStaffDialog, { type StaffSaved } from "./quote-staff-dialog";
import {
  downloadBase64, formatWon, notifyQuoteChanged, quoteRequest,
  type ExtractResult, type GenerateFailure, type GenerateResult, type LoadedWithSuggestions, type QuoteOverview, type QuoteSuggestions, type QuoteVocab, type StaffProfile,
} from "./quote-client";
import { DEFAULT_REMARKS, DEFAULT_TERMS, QUOTE_LIMITS, isGroup, kstToday, sheetNameError, type Quote } from "./quote-model";
import type { CustomerMatch } from "./quote-pricing";
import { SuggestCache, lineSuggestKey } from "./quote-suggest-plan";

const VIEW_ONLY = "보기 권한만 있습니다. 견적을 만들거나 상태를 바꿀 수 없습니다.";
/** 입력이 이만큼 멈추면 바뀐 줄의 단가 제안을 묻는다(Design §10.4: 600ms 이상). */
export const SUGGEST_DEBOUNCE_MS = 600;
const CUSTOMER_DEBOUNCE_MS = 600;
/** 한 번에 묻는 상세 행 수의 대략 상한. 큰 견적을 처음 물을 때 결과가 조금씩 나타난다. */
const SUGGEST_CHUNK_ROWS = 40;

const SHORTCUTS: Array<[string, string]> = [
  ["Alt+1", "첫 미입력 단가 칸으로"], ["Enter", "같은 열 다음 행 단가"], ["Shift+Enter", "같은 열 이전 행"], ["Alt+Enter", "그 행의 제안 단가 적용"],
  ["Alt+G", "xlsx + PDF 생성"], ["/", "이전 견적 검색"], ["Alt+P", "담당자 관리"], ["?", "이 도움말"],
];

function defaultQuote(withMargin: boolean): Quote {
  return {
    customer: { org: "", contact: "", tel: null, email: null }, terms: { ...DEFAULT_TERMS }, staff: { name: "", tel: "", email: "" }, issue_date: null,
    lines: [], remarks: [...DEFAULT_REMARKS], sheet_name: "견적", model_hint: null,
    margin: withMargin ? { rate: 0.1, buy_units: {}, gpu_buy_unit: null, gpu_sell_unit: null } : null,
  };
}

/** 생성·발송 확정 요청 본문. 빈 비고·확약 줄은 빼고, 단품의 상세·세트의 수량을 비우고, 보기 권한이면 margin 을 싣지 않는다. 작성일은 서버가 정한다. */
export function quoteForSend(draft: Quote, withMargin: boolean): Quote {
  const lines = draft.lines.map((line) => (isGroup(line)
    ? { ...line, qty: null, notes: line.notes.filter((note) => note.trim()) }
    : { ...line, items: [], sets: null, notes: line.notes.filter((note) => note.trim()) }));
  let margin = null;
  if (withMargin && draft.margin) {
    const buy = Object.fromEntries(Object.entries(draft.margin.buy_units).filter(([key]) => {
      const [li, ii] = key.split(".").map(Number);
      return Boolean(lines[li]?.items[ii]);
    }));
    margin = { ...draft.margin, buy_units: buy };
  }
  return { ...draft, issue_date: null, lines, remarks: draft.remarks.filter((remark) => remark.trim()), margin };
}

// 탭을 옮겨도(패널이 내려가도) 작성 중인 견적과 제안 기억이 남게 모듈에 둔다. 다른 계정으로 로그인하면 쓰지 않는다.
type Session = { accountId: string; draft: Quote; sourceDate: string | null; selected: OpenRequest | null; footer: FooterState; customerMatches: CustomerMatch[] | null };
let session: Session | null = null;
const suggestCache = new SuggestCache();
let cacheOwner: string | null = null;

const EMPTY_FOOTER: FooterState = { busy: null, result: null, failure: null, confirmMessage: "", stale: false, withPdf: true, suffix: "" };

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return <span className={ok ? "quote-pill ok" : "quote-pill off"}>{label} {ok ? "사용 가능" : "사용 불가"}</span>;
}

type Toast = { message: string; undo?: () => void; key: number };

function PastPriceDialog({ rows, onApply, onClose }: {
  rows: Array<{ key: string; name: string; cur: number; to: number; pct: number | null; age: number | null }>;
  onApply: (keys: string[]) => void; onClose: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(rows.map((row) => row.key)));
  return (
    <div className="quote-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="quote-modal wide" role="dialog" aria-modal="true" aria-labelledby="quote-past-title">
        <header><strong id="quote-past-title">과거 단가 갱신</strong><button type="button" className="quote-icon-button" aria-label="닫기" onClick={onClose}>×</button></header>
        <div className="quote-modal-body">
          <p className="quote-muted">불러온 견적의 단가를 최신 이력으로 바꿉니다. 고른 것만 적용되고, 적용 뒤 되돌릴 수 있습니다. &lsquo;확인 필요&rsquo; 제안은 넣지 않았습니다.</p>
          <table className="quote-hist-table">
            <thead><tr><th aria-label="선택" /><th>품목</th><th className="num">현재</th><th aria-hidden="true" /><th className="num">최신 이력</th><th className="num">차이</th><th>시점</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td><input type="checkbox" aria-label={`${row.name} 갱신`} checked={checked.has(row.key)} onChange={() => setChecked((current) => {
                    const next = new Set(current);
                    if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                    return next;
                  })} /></td>
                  <td>{row.name.slice(0, 42)}</td>
                  <td className="num">{formatWon(row.cur)}</td>
                  <td aria-hidden="true">→</td>
                  <td className="num">{formatWon(row.to)}</td>
                  <td className="num">{row.pct !== null ? `${row.pct > 0 ? "+" : ""}${row.pct}%` : ""}</td>
                  <td>{row.age !== null ? `${row.age}일 전` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" className="primary" disabled={!checked.size} onClick={() => onApply([...checked])}>적용 {checked.size}건</button>
        </footer>
      </div>
    </div>
  );
}

function ShortcutDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="quote-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="quote-modal" role="dialog" aria-modal="true" aria-labelledby="quote-keys-title">
        <header><strong id="quote-keys-title">단축키</strong><button type="button" className="quote-icon-button" aria-label="닫기" onClick={onClose}>×</button></header>
        <div className="quote-modal-body">
          <table className="quote-keys">
            <tbody>{SHORTCUTS.map(([key, label]) => <tr key={key}><td><kbd>{key}</kbd></td><td>{label}</td></tr>)}</tbody>
          </table>
          <p className="quote-muted">견적 탭을 보고 있을 때만 동작합니다.</p>
        </div>
        <footer><span className="spacer" /><button type="button" onClick={onClose}>닫기</button></footer>
      </div>
    </div>
  );
}

export default function QuoteWorkspace({ canEdit, isAdmin, accountId, userName }: { canEdit: boolean; isAdmin: boolean; accountId: string; userName: string }) {
  const dialog = useErpDialog();
  const showMargin = canEdit || isAdmin;
  const restored = session?.accountId === accountId ? session : null;

  const [overview, setOverview] = useState<QuoteOverview | null>(null);
  const [draft, setDraft] = useState<Quote>(() => restored?.draft ?? defaultQuote(showMargin));
  const [sourceDate, setSourceDate] = useState<string | null>(restored?.sourceDate ?? null);
  const [selected, setSelected] = useState<OpenRequest | null>(restored?.selected ?? null);
  const [footer, setFooterState] = useState<FooterState>(restored?.footer ? { ...restored.footer, busy: null } : EMPTY_FOOTER);
  // 제안 표는 기억(suggestCache)에서 지금 줄 목록으로 맞춰 꺼낸다. 기억이 바뀌면 suggestVersion 을 올린다.
  const [suggestVersion, setSuggestVersion] = useState(0);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestError, setSuggestError] = useState("");
  const [today] = useState(() => kstToday(Date.now()));
  const [customerMatches, setCustomerMatches] = useState<CustomerMatch[] | null>(restored?.customerMatches ?? null);
  const [staffProfiles, setStaffProfiles] = useState<StaffProfile[]>([]);
  const [vocab, setVocab] = useState<QuoteVocab | null>(null);
  const [undoStack, setUndoStack] = useState<PriceUndo[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [recentKey, setRecentKey] = useState(0);
  const [focusSearchKey, setFocusSearchKey] = useState(0);
  const [modal, setModal] = useState<"staff" | "pending" | "keys" | "past" | null>(null);
  const [loading, setLoading] = useState(false);

  const draftRef = useRef(draft);
  const footerRef = useRef(footer);
  useEffect(() => {
    draftRef.current = draft;
    footerRef.current = footer;
  });
  // 다른 계정으로 바뀌면 제안 기억을 비운다(이 effect 가 아래 제안 effect 보다 먼저 돈다).
  useEffect(() => {
    if (cacheOwner === accountId) return;
    cacheOwner = accountId;
    suggestCache.invalidate();
  }, [accountId]);
  const customerKey = useRef<string>(restored ? `${restored.draft.customer.org}|${restored.draft.customer.contact}` : "|");
  const customerSeq = useRef(0);

  const update = useCallback((change: (quote: Quote) => Quote) => setDraft((current) => change(current)), []);
  const setFooter = useCallback((patch: Partial<FooterState>) => setFooterState((current) => ({ ...current, ...patch })), []);
  const showToast = useCallback((message: string, undo?: () => void) => setToast({ message, undo, key: Date.now() }), []);

  // 세션 기억(탭 이동 뒤 복원).
  useEffect(() => {
    session = { accountId, draft, sourceDate, selected, footer, customerMatches };
  }, [accountId, draft, sourceDate, selected, footer, customerMatches]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.key === toast.key ? null : current)), toast.undo ? 8000 : 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ── 처음 읽기: 상태 알약, 담당자 프로필, 어휘 ──
  const loadOverview = useCallback(() => {
    void quoteRequest<QuoteOverview>("/api/quote/overview").then((result) => { if (result.ok) setOverview(result.body); });
  }, []);
  useEffect(() => {
    loadOverview();
    void quoteRequest<{ items: StaffProfile[] }>("/api/quote/staff").then((result) => { if (result.ok) setStaffProfiles(result.body.items); });
    void quoteRequest<QuoteVocab>("/api/quote/catalog?view=vocab").then((result) => { if (result.ok) setVocab(result.body); });
  }, [loadOverview]);

  // 담당자 블록 기본값(§10.4): 비어 있으면 내 계정에 연결된 프로필, 없으면 첫 번째.
  useEffect(() => {
    if (!canEdit || !staffProfiles.length || draftRef.current.staff.name) return;
    const pick = staffProfiles.find((profile) => profile.accountId === accountId) ?? staffProfiles[0];
    setDraft((current) => (current.staff.name ? current : { ...current, staff: { name: pick.name, tel: pick.tel, email: pick.email } }));
  }, [staffProfiles, accountId, canEdit]);

  // ── 단가 제안: 바뀐 줄만 ──
  const fetchMissing = useCallback(async () => {
    const lines = draftRef.current.lines;
    const missing = suggestCache.plan(lines);
    if (!missing.length) return;
    const generation = suggestCache.generation;
    // 상세 행 수로 묶는다(큰 견적은 몇 번에 나눠 묻고, 끝난 묶음부터 보인다).
    const chunks: number[][] = [];
    let current: number[] = [];
    let rows = 0;
    for (const index of missing) {
      const size = 1 + lines[index].items.length;
      if (current.length && rows + size > SUGGEST_CHUNK_ROWS) { chunks.push(current); current = []; rows = 0; }
      current.push(index);
      rows += size;
    }
    if (current.length) chunks.push(current);
    const keysOf = (indexes: number[]) => indexes.map((index) => lineSuggestKey(lines[index]));
    for (const chunk of chunks) suggestCache.markPending(keysOf(chunk));
    setSuggestBusy(true);
    setSuggestError("");
    for (const [position, chunk] of chunks.entries()) {
      const keys = keysOf(chunk);
      const result = await quoteRequest<{ suggestions: QuoteSuggestions }>("/api/quote/compute", "POST", {
        action: "SUGGEST", quote: { customer: draftRef.current.customer, lines: chunk.map((index) => lines[index]) }, lineIndexes: chunk, customers: false,
      });
      if (!result.ok) {
        for (const rest of chunks.slice(position)) suggestCache.clearPending(keysOf(rest));
        if (generation === suggestCache.generation) setSuggestError("단가 제안을 불러오지 못했습니다. 과거 단가 없이 직접 입력해야 합니다.");
        break;
      }
      // 기억을 비운 뒤 온 응답(generation 이 다름)은 버린다. 받은 결과는 보낸 줄의 내용 키로 저장되므로 그사이 바뀐 줄을 틀리게 칠하지 않는다.
      if (!suggestCache.store(generation, chunk, keys, result.body.suggestions)) break;
      setSuggestVersion((value) => value + 1);
    }
    setSuggestBusy(false);
  }, []);

  // suggestVersion 이 바뀌면(응답 도착·기억 비움) 다시 맞춰 꺼낸다. 기억에 없는 줄은 비어 있고, 아래 effect 가 묻는다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => suggestCache.assemble(draft.lines), [draft.lines, suggestVersion]);
  useEffect(() => {
    if (!suggestCache.plan(draft.lines).length) return;
    const timer = window.setTimeout(() => void fetchMissing(), SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft.lines, suggestVersion, fetchMissing]);

  const invalidateSuggestions = useCallback(() => {
    suggestCache.invalidate();
    setSuggestVersion((value) => value + 1);
  }, []);

  /** 불러오기·추출 응답의 제안을 기억에 넣는다(그 줄들은 다시 묻지 않는다). */
  const seedSuggestions = useCallback((lines: Quote["lines"], seeded: QuoteSuggestions | undefined) => {
    if (!seeded) return;
    const indexes = lines.map((_, index) => index);
    suggestCache.store(suggestCache.generation, indexes, lines.map(lineSuggestKey), seeded);
    setSuggestVersion((value) => value + 1);
  }, []);

  // ── 고객 후보(편집 권한): 기관·담당자가 바뀌고 멈추면 ──
  useEffect(() => {
    if (!canEdit) return;
    const key = `${draft.customer.org}|${draft.customer.contact}`;
    if (key === customerKey.current) return;
    const timer = window.setTimeout(() => {
      customerKey.current = key;
      if (!draft.customer.org.trim()) { setCustomerMatches(null); return; }
      const seq = (customerSeq.current += 1);
      void quoteRequest<{ customer_matches: CustomerMatch[] }>("/api/quote/compute", "POST", {
        action: "SUGGEST", quote: { customer: { org: draft.customer.org, contact: draft.customer.contact }, lines: [] },
      }).then((result) => { if (result.ok && seq === customerSeq.current) setCustomerMatches(result.body.customer_matches); });
    }, CUSTOMER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft.customer.org, draft.customer.contact]);

  // ── 불러오기·AI 추출 ──
  async function confirmOverwrite(message: string) {
    if (!draftRef.current.lines.length) return true;
    return dialog.confirm(message, { title: "견적 바꾸기", confirmLabel: "바꾸기" });
  }

  function resetForNewQuote() {
    setFooterState((current) => ({ ...EMPTY_FOOTER, withPdf: current.withPdf }));
    setUndoStack([]);
    setSuggestError("");
  }

  async function open(request: OpenRequest) {
    if (!(await confirmOverwrite(`작성 중인 품목 ${draftRef.current.lines.length}건이 있습니다. 불러온 견적으로 덮어쓸까요?`))) return;
    setLoading(true);
    const param = request.kind === "issued" ? "issuedId" : "corpusId";
    const result = await quoteRequest<LoadedWithSuggestions>(`/api/quote/history?${param}=${request.id}`);
    setLoading(false);
    if (!result.ok) { showToast(result.body.error ?? "견적을 불러오지 못했습니다."); return; }
    const loaded = result.body.quote;
    const next: Quote = {
      ...loaded,
      issue_date: null,
      margin: showMargin ? (loaded.margin ?? { rate: 0.1, buy_units: {}, gpu_buy_unit: null, gpu_sell_unit: null }) : null,
    };
    seedSuggestions(next.lines, result.body.suggestions);
    setSelected(request);
    setSourceDate(result.body.source_date);
    customerKey.current = `${next.customer.org}|${next.customer.contact}`;
    setCustomerMatches(result.body.customer_matches ?? null);
    resetForNewQuote();
    setDraft(next);
    if (next.lines.length > QUOTE_LIMITS.lines) showToast(`이 과거 견적은 ${next.lines.length}줄이라 그대로는 생성할 수 없습니다(${QUOTE_LIMITS.lines}줄까지).`);
  }

  async function applyExtraction(result: ExtractResult) {
    if (!(await confirmOverwrite("AI 추출 결과로 지금 견적의 수신자·조건·품목을 바꿀까요?"))) return false;
    const current = draftRef.current;
    const next: Quote = {
      ...result.quote,
      staff: current.staff.name ? current.staff : result.quote.staff,
      terms: { ...result.quote.terms, place: current.terms.place || result.quote.terms.place },
      sheet_name: current.sheet_name || "견적",
      model_hint: current.model_hint,
      margin: showMargin ? { rate: current.margin?.rate ?? 0.1, buy_units: {}, gpu_buy_unit: null, gpu_sell_unit: null } : null,
    };
    seedSuggestions(next.lines, result.suggestions);
    setSelected(null);
    setSourceDate(null);
    customerKey.current = `${next.customer.org}|${next.customer.contact}`;
    setCustomerMatches(result.customer_matches);
    resetForNewQuote();
    setDraft(next);
    showToast(`AI가 품목 ${next.lines.length}줄을 채웠습니다. 확인한 뒤 생성하세요.`);
    return true;
  }

  // ── 단가 적용·되돌리기(옛 applySug·applyAllSuggestions·refreshPastPrices·undoPrices) ──
  const pushUndo = useCallback((entry: PriceUndo) => { if (entry.entries.length) setUndoStack((stack) => [...stack.slice(-19), entry]); }, []);
  const applySuggestion = useCallback((key: string, price: number) => {
    pushUndo({ entries: [{ key, before: priceAt(draftRef.current, key) }], label: "단가 적용 1건" });
    setDraft((current) => withPriceAt(current, key, price));
  }, [pushUndo]);

  function applyAll() {
    const quote = draftRef.current;
    let next = quote;
    let skipped = 0;
    const entries: PriceUndo["entries"] = [];
    quote.lines.forEach((line, li) => {
      const s = suggestions[String(li)];
      const priced = isGroup(line) && line.items.every((item) => item.unit_price !== null);
      if (s?.suggested && line.unit_price === null && !priced) {
        if (s.caution) skipped += 1; else { entries.push({ key: String(li), before: null }); next = withPriceAt(next, String(li), s.suggested); }
      }
      line.items.forEach((item, ii) => {
        const si = suggestions[`${li}.${ii}`];
        if (si?.suggested && item.unit_price === null && line.unit_price === null) {
          if (si.caution) skipped += 1; else { entries.push({ key: `${li}.${ii}`, before: null }); next = withPriceAt(next, `${li}.${ii}`, si.suggested); }
        }
      });
    });
    pushUndo({ entries, label: `빈 단가 일괄 ${entries.length}건` });
    setDraft(next);
    showToast(entries.length ? `제안 단가 ${entries.length}건 적용` : skipped ? `확인 필요 ${skipped}건은 근거를 펼쳐 직접 적용하세요` : "적용할 빈 단가가 없습니다");
  }

  const pastCandidates = useMemo(() => Object.entries(suggestions).flatMap(([key, s]) => {
    if (!s.suggested || s.caution) return [];
    const cur = priceAt(draft, key);
    if (cur === null || cur === s.suggested) return [];
    return [{ key, name: s.name ?? "", cur, to: s.suggested, pct: s.delta_pct, age: s.age_days }];
  }), [suggestions, draft]);

  function refreshPast() {
    if (!pastCandidates.length) { showToast("제안과 다른 단가가 없습니다"); return; }
    setModal("past");
  }
  function applyPast(keys: string[]) {
    const quote = draftRef.current;
    const chosen = pastCandidates.filter((row) => keys.includes(row.key));
    pushUndo({ entries: chosen.map((row) => ({ key: row.key, before: priceAt(quote, row.key) })), label: `과거 단가 갱신 ${chosen.length}건` });
    setDraft(chosen.reduce((current, row) => withPriceAt(current, row.key, row.to), quote));
    setModal(null);
    showToast(chosen.length ? `${chosen.length}건을 최신 단가로 바꿨습니다` : "선택한 항목이 없습니다");
  }
  function undoPrices() {
    const top = undoStack[undoStack.length - 1];
    if (!top) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setDraft((current) => top.entries.reduce((quote, entry) => withPriceAt(quote, entry.key, entry.before), current));
    showToast(`${top.entries.length}건을 되돌렸습니다`);
  }

  // ── 생성·발송 확정·PDF 다시 만들기 ──
  const generate = useCallback(async () => {
    const quote = draftRef.current;
    const state = footerRef.current;
    if (!canEdit || !quote.lines.length || state.busy) return;
    const sheetError = sheetNameError(quote.sheet_name);
    if (sheetError) { setFooter({ failure: { error: sheetError } }); return; }
    setFooter({ busy: "generate", failure: null, confirmMessage: "", stale: false });
    const result = await quoteRequest<GenerateResult & GenerateFailure>("/api/quote/issued", "POST", {
      action: "GENERATE", quote: quoteForSend(quote, showMargin), suffix: state.suffix.trim() || null, pdf: state.withPdf,
    });
    if (!result.ok) {
      const empty = emptyPriceCount(quote);
      const prefix = result.status === 400 && empty ? `단가가 비어 있는 품목이 ${empty}건 있습니다. ` : "";
      setFooter({ busy: null, result: null, failure: { ...result.body, error: `${prefix}${result.body.error ?? "파일 생성에 실패했습니다."}` } });
      return;
    }
    setFooter({ busy: null, result: result.body, failure: null });
    setOverview((current) => (current ? { ...current, pending: result.body.pending } : current));
    notifyQuoteChanged();
    setRecentKey((value) => value + 1);
  }, [canEdit, showMargin, setFooter]);

  async function confirmSent() {
    const quote = draftRef.current;
    const state = footerRef.current;
    if (!state.result || state.busy) return;
    setFooter({ busy: "confirm", confirmMessage: "", stale: false });
    const result = await quoteRequest<{ issuedId: number; changed: number; status: string; pending: number }>("/api/quote/issued", "POST", {
      action: "CONFIRM", issuedId: state.result.issuedId, quote: quoteForSend(quote, showMargin), suffix: state.suffix.trim() || null,
    });
    if (result.status === 409 && result.body.code === "STALE") {
      setFooter({ busy: null, stale: true, confirmMessage: result.body.error ?? "생성한 뒤 내용이 바뀌었습니다. 다시 생성한 뒤 발송 확정을 눌러 주세요." });
      return;
    }
    if (!result.ok) { setFooter({ busy: null, confirmMessage: result.body.error ?? "발송 확정에 실패했습니다." }); return; }
    setFooter({ busy: null, result: { ...state.result, status: "confirmed" }, confirmMessage: `발송 확정했습니다 (#${state.result.issuedId}).` });
    setOverview((current) => (current ? { ...current, pending: result.body.pending } : current));
    notifyQuoteChanged();
    setRecentKey((value) => value + 1);
    invalidateSuggestions();
  }

  async function regeneratePdf() {
    const state = footerRef.current;
    if (!state.result || state.busy) return;
    setFooter({ busy: "pdf" });
    const result = await quoteRequest<{ files: { xlsx: boolean; pdf: boolean } }>("/api/quote/issued", "POST", { action: "REGENERATE_PDF", issuedId: state.result.issuedId });
    if (!result.ok) {
      setFooter({ busy: null, result: { ...state.result, pdfError: { code: result.body.code ?? "PDF_FAILED", message: result.body.error ?? "PDF를 만들지 못했습니다." } } });
      return;
    }
    setFooter({ busy: null, result: { ...state.result, files: { ...state.result.files, pdf: true }, pdfError: undefined } });
    setRecentKey((value) => value + 1);
  }

  function downloadFailure() {
    const failure = footerRef.current.failure;
    if (failure?.xlsxBase64) downloadBase64(failure.filename ?? "견적서.xlsx", failure.xlsxBase64);
  }

  // ── 미확정 일괄·담당자 ──
  function onStatusChanged(change: StatusChange) {
    setOverview((current) => (current ? { ...current, pending: change.pending } : current));
    setRecentKey((value) => value + 1);
    invalidateSuggestions();
    const verb = change.status === "confirmed" ? "확정" : "폐기";
    showToast(`${change.changed}건 ${verb}했습니다`, async () => {
      const undone = await quoteRequest<{ changed: number; pending: number }>("/api/quote/issued", "POST", { action: "SET_STATUS", ids: change.ids, status: "draft" });
      if (!undone.ok) { showToast(`되돌리기 실패 · ${undone.body.error ?? ""}`); return; }
      notifyQuoteChanged();
      setOverview((current) => (current ? { ...current, pending: undone.body.pending } : current));
      setRecentKey((value) => value + 1);
      invalidateSuggestions();
      setModal(null);
      showToast(`${undone.body.changed}건 미확정으로 되돌렸습니다`);
    });
  }

  function onStaffSaved(result: StaffSaved) {
    setStaffProfiles(result.items);
    setModal(null);
    const current = draftRef.current.staff;
    if (current.name && !result.items.some((profile) => profile.name === current.name)) {
      const pick = result.items.find((profile) => profile.accountId === accountId) ?? result.items[0];
      if (pick) setDraft((quote) => ({ ...quote, staff: { name: pick.name, tel: pick.tel, email: pick.email } }));
    } else {
      const same = result.items.find((profile) => profile.name === current.name);
      if (same) setDraft((quote) => ({ ...quote, staff: { name: same.name, tel: same.tel, email: same.email } }));
    }
    showToast(`담당자 ${result.items.length}명 저장됨`, async () => {
      const undone = await quoteRequest<StaffSaved>("/api/quote/staff", "POST", {
        action: "SAVE", items: result.before.map(({ id, name, tel, email, accountId: linked }) => ({ id, name, tel, email, accountId: linked })),
      });
      if (undone.ok) { setStaffProfiles(undone.body.items); showToast("담당자 목록을 되돌렸습니다"); }
      else showToast(`되돌리기 실패 · ${undone.body.error ?? ""}`);
    });
  }

  // ── 단축키(견적 탭이 열려 있을 때만: 패널이 내려가면 리스너도 떨어진다) ──
  useEffect(() => {
    function gotoEmpty() {
      const input = document.querySelector<HTMLInputElement>(".quote-module-shell .quote-money.empty");
      if (input) { input.scrollIntoView({ block: "center" }); input.focus(); }
    }
    function onKey(event: KeyboardEvent) {
      if (modal) return;
      const target = event.target as HTMLElement | null;
      const inField = Boolean(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.code === "Digit1") { event.preventDefault(); gotoEmpty(); return; }
        if (event.code === "KeyG" && canEdit) { event.preventDefault(); void generate(); return; }
        if (event.code === "KeyP" && canEdit) { event.preventDefault(); setModal("staff"); return; }
      }
      if (!inField && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "/") { event.preventDefault(); setFocusSearchKey((value) => value + 1); return; }
        if (event.key === "?") { event.preventDefault(); setModal("keys"); return; }
      }
      if (inField && target instanceof HTMLInputElement && target.classList.contains("quote-money") && event.key === "Enter") {
        event.preventDefault();
        if (event.altKey) {
          // 그 행의 제안 단가 적용. '확인 필요' 제안은 자동 적용하지 않는다(근거를 보고 직접 적용).
          const key = target.dataset.sugkey;
          const s = key ? suggestions[key] : undefined;
          if (!key || !s?.suggested || !canEdit) return;
          if (s.caution) { showToast("확인 필요 항목입니다. 근거를 읽고 직접 적용하세요"); return; }
          applySuggestion(key, s.suggested);
          return;
        }
        const column = [...document.querySelectorAll<HTMLInputElement>(`.quote-module-shell .quote-money[data-col="${target.dataset.col ?? ""}"]`)];
        const next = column[column.indexOf(target) + (event.shiftKey ? -1 : 1)];
        if (next) { next.focus(); next.select(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, canEdit, generate, suggestions, applySuggestion, showToast]);

  const pending = overview?.pending ?? 0;
  const mailPanel = canEdit ? <QuoteAssistView aiAvailable={overview ? overview.helpers.ai : null} onExtracted={applyExtraction} /> : null;

  return (
    <main className="quote-page">
      <header className="quote-head">
        <div>
          <h2>견적</h2>
          <p>작성자 {userName}{canEdit ? " · 메일을 붙여 넣거나 과거 견적을 불러와 견적서를 만듭니다." : " · 과거 견적을 찾아 내용을 확인합니다."}</p>
        </div>
        <div className="quote-pills" aria-label="견적 도구 상태">
          {overview && (
            <>
              {canEdit && <Pill ok={overview.helpers.ai} label="AI" />}
              {canEdit && <Pill ok={overview.helpers.pdf} label="PDF" />}
              <span className={overview.template.ready ? "quote-pill ok" : "quote-pill off"}>견적서 양식 {overview.template.ready ? "준비됨" : "없음"}</span>
              <span className="quote-pill">카탈로그 제품 {overview.catalog.products.toLocaleString("ko-KR")}개</span>
            </>
          )}
          {canEdit && pending > 0 && <button type="button" className="quote-pill warn" onClick={() => setModal("pending")} title="아직 발송 확정하지 않은 견적입니다. 눌러서 한 번에 확정하거나 폐기하세요">미확정 {pending}건</button>}
          {!canEdit && pending > 0 && <span className="quote-pill warn">미확정 {pending}건</span>}
          <button type="button" className="quote-pill" onClick={() => setModal("keys")} aria-label="단축키 도움말 (?)">⌨ 단축키</button>
        </div>
      </header>
      {!canEdit && <p className="quote-banner">{VIEW_ONLY}</p>}
      <div className="quote-layout">
        <QuoteHistoryView selected={selected} onOpen={(request) => void open(request)} refreshKey={recentKey} mail={mailPanel} focusSearchKey={focusSearchKey} />
        <div className="quote-main" aria-busy={loading}>
          {loading && <p className="quote-muted" role="status">불러오는 중…</p>}
          <QuoteEditorView
            draft={draft} update={update} canEdit={canEdit} showMargin={showMargin}
            suggestions={suggestions} suggestBusy={suggestBusy} suggestError={suggestError} onRetrySuggest={() => { setSuggestError(""); void fetchMissing(); }}
            customerMatches={customerMatches} staffProfiles={staffProfiles} onManageStaff={() => setModal("staff")} sourceDate={sourceDate} vocab={vocab}
            onApply={applySuggestion} onApplyAll={applyAll} onRefreshPast={refreshPast} undo={undoStack[undoStack.length - 1] ?? null} onUndo={undoPrices}
            onOpenSearch={() => setFocusSearchKey((value) => value + 1)} footer={footer} setFooter={setFooter}
            onGenerate={() => void generate()} onConfirm={() => void confirmSent()} onRegeneratePdf={() => void regeneratePdf()} onDownloadFailure={downloadFailure} today={today}
            emptyHint={canEdit ? (
              <div className="cta main">
                <h5>메일로 시작</h5>
                <p>왼쪽 「메일」에 고객 메일이나 스크린샷을 넣고 「AI 추출」을 누르면 품목이 채워집니다. 아래 버튼으로 직접 입력할 수도 있습니다.</p>
              </div>
            ) : <p className="quote-muted">왼쪽 목록에서 견적을 고르면 내용이 여기에 보입니다.</p>}
          />
        </div>
      </div>

      {toast && (
        <div className="quote-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && <button type="button" onClick={() => { const undo = toast.undo; setToast(null); undo?.(); }}>되돌리기</button>}
        </div>
      )}
      {modal === "staff" && canEdit && <QuoteStaffDialog profiles={staffProfiles} accountId={accountId} onClose={() => setModal(null)} onSaved={onStaffSaved} />}
      {modal === "pending" && canEdit && <PendingDialog onClose={() => setModal(null)} onChanged={onStatusChanged} />}
      {modal === "past" && canEdit && <PastPriceDialog rows={pastCandidates} onApply={applyPast} onClose={() => setModal(null)} />}
      {modal === "keys" && <ShortcutDialog onClose={() => setModal(null)} />}
    </main>
  );
}
