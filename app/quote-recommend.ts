// 구성(BOM) 추천(quote-tool Design §4.6, 옛 quote_gen/recommend.py). 순수 모듈.
// 새 구성을 상상해 내지 않고, 같은 GPU 로 실제 견적·납품한 구성을 과거 구성 라이브러리(quote_bom_library)에서 찾아 보여 준다.
// 같은 베이스(케이스/보드/파워)가 과거에 GPU 몇 장까지 쓰였는지(base_max_gpu)가 증설 가능 수량의 근거다.
// 라이브러리는 인자로 받는다(DB 조회는 quote-server.ts loadBomLibrary). 출력은 옛 dict 와 같은 snake_case 키다(QD-2).
// tests/fixtures/quote/recommend(파이썬 출력, QP-10)와 값이 같아야 한다: 점수의 덧셈 순서, 두 번의 안정 정렬, round(score, 3)까지 그대로다.
// 응답의 customer·file·evidence 에는 과거 견적의 기관명·파일명이 들어간다. compute 라우트가 RECOMMEND·VARIANTS 를 편집 권한(quote:write)에만 연다.
import type { QuoteItem, QuoteLine } from "./quote-model";
import { pyRound } from "./quote-pyfmt";
import { norm, SequenceB, SequenceMatcher } from "./quote-textkey";

// ── 입력 모양(bom_library.json 의 칸 이름 그대로) ───────────────────────────
export type BomPart = { slot?: string; category?: string | null; name: string; qty: number | null; unit_price?: number | null };
export type BomEntry = {
  sheet_id?: number | null; file: string | null; date: string | null; customer: string | null; sheet_name?: string | null;
  total: number | null; subtotal?: number | null; system_label: string | null; system_name: string | null;
  gpu_name: string; gpu_key?: string | null; gpu_qty: number; base_key: string; remark: string | null;
  /** {slot: [대표 부품, …]} — 옛 dict 순서를 지킨다(부품 목록 순서가 된다). */
  parts: Record<string, BomPart[]>; n_slots: number; base_max_gpu: number;
};

/** 옛 SLOT_LABEL: 슬롯 → 견적서 품목명 열 표기. 없는 슬롯은 대문자. */
export const SLOT_LABEL: Readonly<Record<string, string>> = {
  chassis: "Chassis", barebone: "Barebone", board: "Board", cpu: "CPU", cooler: "CPU COOLER",
  power: "POWER", fan: "FAN", ram: "RAM", ssd: "SSD", hdd: "HDD", nic: "NIC",
  raid: "RAID CARD", nvlink: "NVLink", gpu: "GPU", os: "OS",
};

export type RecommendPart = { slot: string; category: string; name: string; qty: number | null };
export type Recommendation = {
  score: number; date: string | null; customer: string | null; file: string | null;
  system_label: string | null; system_name: string | null; gpu_name: string; gpu_qty: number; base_max_gpu: number;
  n_slots: number; total: number | null; remark: string | null; parts: RecommendPart[]; evidence: string;
};
export type Variant = { gpu_qty: number; line: QuoteLine; source: Recommendation };

/** 라이브러리 + 미리 계산한 GPU 이름 키(norm·토큰·SequenceMatcher b 측). 서버가 버전별로 캐시한다. */
export type BomLibrary = { entries: BomEntry[]; prepared: Array<{ norm: string; tokens: Set<string>; seq: SequenceB }> };

const tokensOf = (normalized: string) => new Set(normalized.split(" ").filter(Boolean));

export function prepareBomLibrary(entries: BomEntry[]): BomLibrary {
  return {
    entries,
    prepared: entries.map((entry) => {
      const normalized = norm(entry.gpu_name);
      return { norm: normalized, tokens: tokensOf(normalized), seq: new SequenceB(normalized) };
    }),
  };
}

/** 파이썬 f"{x}" 와 같은 표기(None → 'None'). 숫자는 이 라이브러리에서 정수(gpu_qty·base_max_gpu)만 넣는다. */
const pyStr = (value: unknown) => (value === null || value === undefined ? "None" : String(value));

/** 옛 _sim: 공백 토큰 자카드(부분 일치 없음) 0.6 + SequenceMatcher 0.4. 토큰이 없으면 0. */
function simPrepared(queryNorm: string, queryTokens: Set<string>, target: BomLibrary["prepared"][number]): number {
  if (!queryTokens.size || !target.tokens.size) return 0.0;
  let common = 0;
  for (const token of queryTokens) if (target.tokens.has(token)) common += 1;
  const jac = common / (queryTokens.size + target.tokens.size - common);
  return 0.6 * jac + 0.4 * new SequenceMatcher(queryNorm, target.seq).ratio();
}

/** 옛 _sim(a, b) 그대로(테스트·단건용). */
export function sim(a: string, b: string): number {
  const an = norm(a);
  const bn = norm(b);
  return simPrepared(an, tokensOf(an), { norm: bn, tokens: tokensOf(bn), seq: new SequenceB(bn) });
}

const truthy = (value: number | null | undefined): value is number => typeof value === "number" && value !== 0 && !Number.isNaN(value);
/** 파이썬 문자열 비교(코드 포인트 순). 날짜 문자열은 ASCII 라 UTF-16 비교와 같지만 일반화해 둔다. */
function pyCompare(a: string, b: string) {
  if (a === b) return 0;
  const ac = Array.from(a);
  const bc = Array.from(b);
  for (let index = 0; index < Math.min(ac.length, bc.length); index += 1) {
    if (ac[index] !== bc[index]) return (ac[index].codePointAt(0) ?? 0) - (bc[index].codePointAt(0) ?? 0);
  }
  return ac.length - bc.length;
}

/**
 * GPU 이름(+수량, 증설 목표 수량)으로 과거 구성 후보를 돌려준다(옛 recommend). 같은 베이스는 대표 1건만.
 * 옛 코드처럼 limit 은 '하나 넣은 뒤 개수가 limit 이상이면 멈춤'이다(limit ≤ 0 이어도 1건). 라우트가 1~10 으로 막는다.
 */
export function recommend(library: BomLibrary, gpu: string, gpuQty: number | null = null, capacity: number | null = null, limit = 5): Recommendation[] {
  const { entries, prepared } = library;
  if (!entries.length) return [];
  const needCap = truthy(capacity) ? capacity : truthy(gpuQty) ? gpuQty : 1;
  const queryNorm = norm(gpu);
  const queryTokens = tokensOf(queryNorm);
  const scored: Array<{ score: number; b: BomEntry }> = [];
  entries.forEach((b, index) => {
    const s = simPrepared(queryNorm, queryTokens, prepared[index]);
    if (s < 0.45) return;
    let score = s;
    if (b.base_max_gpu >= needCap) score += 0.25; // 증설 요구를 충족한 실적이 있는 베이스
    if (truthy(gpuQty) && b.gpu_qty === gpuQty) score += 0.10;
    score += Math.min(0.12, 0.03 * (b.n_slots - 4)); // 구성이 충실할수록(음수 가능)
    if (pyCompare(b.date ?? "", "2026-01-01") >= 0) score += 0.10; // 최근 구성 우선
    scored.push({ score, b });
  });
  // 옛: sort(key=(-score, date)) 뒤 sort(key=-score) — 둘 다 안정 정렬이라 (-score, date, 원래 순서)와 같다.
  scored.sort((x, y) => (y.score - x.score) || pyCompare(x.b.date ?? "", y.b.date ?? ""));

  const out: Recommendation[] = [];
  const seen = new Set<string>();
  for (const { score, b } of scored) {
    if (seen.has(b.base_key)) continue;
    seen.add(b.base_key);
    out.push({
      score: pyRound(score, 3), date: b.date, customer: b.customer, file: b.file,
      system_label: b.system_label, system_name: b.system_name,
      gpu_name: b.gpu_name, gpu_qty: b.gpu_qty, base_max_gpu: b.base_max_gpu,
      n_slots: b.n_slots, total: b.total, remark: b.remark,
      parts: Object.entries(b.parts).map(([slot, list]) => ({
        slot, category: Object.hasOwn(SLOT_LABEL, slot) ? SLOT_LABEL[slot] : slot.toUpperCase(), name: list[0].name, qty: list[0].qty,
      })),
      evidence: `${pyStr(b.date)} ${b.customer || ""} 견적에서 ${b.gpu_name} ${pyStr(b.gpu_qty)}장 구성`
        + (b.base_max_gpu > b.gpu_qty ? `, 같은 베이스로 최대 ${pyStr(b.base_max_gpu)}장까지 사용 실적` : ""),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 추천 결과 → 견적서 세트(그룹) 줄(옛 to_line). GPU 슬롯의 수량은 gpuQty 가 있으면 그 값이다. */
export function toLine(rec: Pick<Recommendation, "parts" | "system_label" | "system_name">, gpuQty: number | null = null, label: string | null = null): QuoteLine {
  const items: QuoteItem[] = rec.parts.map((part) => ({
    category: part.category,
    spec: part.name ?? "",
    qty: part.slot === "gpu" && truthy(gpuQty) ? gpuQty : part.qty,
    unit_price: null,
    extra_categories: [],
  }));
  return {
    label: label || rec.system_label || "SYSTEM",
    name: rec.system_name || (rec.parts[0]?.name ?? ""),
    items, sets: 1, qty: null, unit_price: null, notes: [],
  };
}

/** GPU 장수만 다른 같은 베이스 구성 여러 벌(옛 variants, 예: 2장/3장/4장 비교 견적). counts 는 1개 이상. */
export function variants(library: BomLibrary, gpu: string, counts: number[], capacity: number | null = null): Variant[] {
  const base = recommend(library, gpu, null, truthy(capacity) ? capacity : Math.max(...counts), 1);
  if (!base.length) return [];
  const rec = base[0];
  return counts.map((count) => ({ gpu_qty: count, line: toLine(rec, count), source: rec }));
}
