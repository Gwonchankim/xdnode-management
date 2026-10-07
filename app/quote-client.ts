"use client";

// 견적 탭 클라이언트 공용(quote-tool Design §1.2·§10.1). fetch 래퍼, 탭 배지 훅, 금액 표기.
// 서버 모듈(quote-server·quote-schema·quote-import)은 import 하지 않는다. quote-model 은 순수 모듈이라 함께 쓴다.
import { useEffect, useState } from "react";
import type { Quote } from "./quote-model";
import type { CustomerMatch, Suggestion } from "./quote-pricing";
import type { Recommendation, Variant } from "./quote-recommend";

export const QUOTE_BADGE_INTERVAL_MS = 10 * 60 * 1000;
export const QUOTE_CHANGED_EVENT = "xdm:quote-changed";

export type QuoteResult<T> = { ok: boolean; status: number; body: T & { error?: string; code?: string; field?: string } };

export async function quoteRequest<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<QuoteResult<T>> {
  try {
    const response = await fetch(url, {
      method, cache: "no-store", credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as QuoteResult<T>["body"];
    return { ok: response.ok, status: response.status, body: parsed ?? ({} as QuoteResult<T>["body"]) };
  } catch {
    return { ok: false, status: 0, body: { error: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." } as QuoteResult<T>["body"] };
  }
}

// ── 응답 형태(GET /api/quote/history·overview) ──────────────────────────────
export type QuoteStatus = "draft" | "confirmed" | "discarded";
export type RecentQuote = {
  source: "issued"; id: number; created_at: number; issue_date: string; filename: string; customer: string; contact: string; model_hint: string | null;
  total: number; n_lines: number; status: QuoteStatus; author_name: string; files: { xlsx: boolean; pdf: boolean };
};
export type HistoryHit = {
  source: "issued" | "file"; id: number; file: string; quote_date: string | null; customer: string | null; contact: string | null;
  model_hint: string | null; total: number | null; n_items: number | null; sheet_name: string | null; status: QuoteStatus | null;
};
export type LoadedQuote = {
  quote: Quote; source_date: string | null;
  source: { kind: "issued" | "file"; id: number; status?: QuoteStatus; rev?: number; files?: { xlsx: boolean; pdf: boolean } };
};
export type QuoteOverview = {
  pending: number; helpers: { ai: boolean; pdf: boolean }; template: { ready: boolean; code?: string };
  catalog: { versions: Record<string, string | null>; products: number; legacyProducts: number; bom: number; customers: number };
  lastImport: { finishedAt: number; status: string } | null;
};

export const STATUS_LABEL: Record<QuoteStatus, string> = { draft: "미확정", confirmed: "확정", discarded: "폐기" };

// ── QT3 편집 화면 응답 형태(POST /api/quote/compute·issued·extract, GET staff·catalog) ─────────────
export type QuoteSuggestions = Record<string, Suggestion>;
export type LoadedWithSuggestions = LoadedQuote & { suggestions?: QuoteSuggestions; customer_matches?: CustomerMatch[] };
export type StaffProfile = { id: string; name: string; tel: string; email: string; accountId: string | null; sort: number };
export type QuoteVocab = Partial<Record<"group_labels" | "categories" | "remarks" | "payment" | "delivery", string[]>>;
export type ExtractionNotes = {
  field_notes: Array<{ field: string; confidence: "high" | "medium" | "low"; source: string; comment: string | null }>;
  questions: string[]; summary: string;
};
export type ExtractResult = { quote: Quote; extraction: ExtractionNotes; suggestions: QuoteSuggestions; customer_matches: CustomerMatch[] };
export type GenerateResult = {
  issuedId: number; rev: number; status: QuoteStatus; created: boolean; unchanged: boolean; filename: string; subtotal: number; total: number;
  files: { xlsx: boolean; pdf: boolean }; pdfError?: { code: string; message: string }; pending: number;
};
// ── QT4 구성 추천·상담 응답 형태(POST /api/quote/compute RECOMMEND·VARIANTS, POST /api/quote/chat). 편집 권한 화면만 쓴다. ──
export type RecommendResult = { recommendations: Array<Recommendation & { line: Quote["lines"][number] }>; libraryReady: boolean };
export type VariantsResult = { variants: Variant[]; libraryReady: boolean };
export type ChatReply = { reply: string };

/** 기록·저장 실패 때 응답에 실려 오는 xlsx(RECORD_FAILED·STORAGE_FAILED). */
export type GenerateFailure = { error?: string; code?: string; field?: string; xlsxBase64?: string; filename?: string; issuedId?: number };

/** 발행 견적 파일 받기 주소(서버가 권한을 다시 본다. 보기 권한 xlsx 는 견적 시트만). */
export const quoteFileUrl = (issuedId: number, kind: "xlsx" | "pdf") => `/api/quote/files?issuedId=${issuedId}&kind=${kind}`;

/** 응답에 실려 온 xlsx(base64)를 파일로 내려받게 한다. */
export function downloadBase64(fileName: string, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 미확정 견적 수(탭 배지). 견적 보기 이상일 때 10분마다, 창에 돌아올 때, 견적이 바뀔 때 다시 읽는다. */
export function useQuoteBadge(enabled: boolean) {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const result = await quoteRequest<{ pending: number }>("/api/quote/overview?summary=1");
      if (alive && result.ok && typeof result.body.pending === "number") setPending(result.body.pending);
    };
    void load();
    const timer = window.setInterval(() => void load(), QUOTE_BADGE_INTERVAL_MS);
    const onChange = () => void load();
    window.addEventListener("focus", onChange);
    window.addEventListener(QUOTE_CHANGED_EVENT, onChange);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", onChange); window.removeEventListener(QUOTE_CHANGED_EVENT, onChange); };
  }, [enabled]);
  return enabled ? pending : 0;
}

/** 견적 데이터가 바뀌었음을 셸 배지에 알린다. */
export function notifyQuoteChanged() {
  window.dispatchEvent(new Event(QUOTE_CHANGED_EVENT));
}

// ── 금액 표기 ────────────────────────────────────────────────────────────
const wonFormat = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
export const formatWon = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? wonFormat.format(Math.round(value)) : "—");

const DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const SMALL_UNITS = ["", "십", "백", "천"];
const BIG_UNITS = ["", "만", "억", "조", "경"];

/** 금액 한글 표기: 1,234,000 → '일금 일백이십삼만사천원정'(견적서 관행). 음수·소수는 정수로 반올림하고 부호를 붙인다. */
export function koreanAmount(value: number) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(Math.abs(value));
  if (rounded === 0) return "일금 영원정";
  let rest = rounded;
  const groups: string[] = [];
  for (let big = 0; rest > 0 && big < BIG_UNITS.length; big += 1) {
    const chunk = rest % 10_000;
    rest = Math.floor(rest / 10_000);
    if (!chunk) continue;
    let text = "";
    const digits = String(chunk).padStart(4, "0").split("").map(Number);
    digits.forEach((digit, index) => {
      if (digit) text += `${DIGITS[digit]}${SMALL_UNITS[3 - index]}`;
    });
    groups.unshift(`${text}${BIG_UNITS[big]}`);
  }
  return `일금 ${value < 0 ? "마이너스 " : ""}${groups.join("")}원정`;
}
