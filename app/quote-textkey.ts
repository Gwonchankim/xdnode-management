// 텍스트 키(quote-tool Design §4.2, 옛 quote_gen/textkey.py — "변경 금지" 함수). 순수 모듈.
// 이 모듈은 판단하지 않는다. 정규화·토큰·유사도·카테고리 슬롯까지만 한다("이 점수면 단가를 올려도 되는가"는 quote-confidence.ts).
// 출력이 바뀌면 카탈로그 매칭과 단가 로그 name_key 가 동시에 흔들린다. tests/fixtures/quote/textkey.json(파이썬 출력)과 문자열·비트 단위로 같아야 한다.
import { pyStrip } from "./quote-pyfmt";

/**
 * 비교용 키(옛 textkey.norm): 소문자화 → ®™ 제거 → [^0-9a-z가-힣+.]+ → " " → \s+ → " " → strip.
 * toLowerCase 와 str.lower 는 남는 문자(a-z, 가-힣, 숫자, +.)에 대해 같다. u 플래그 없이 쓴다(서로게이트 쌍은 한 공백 묶음이 된다).
 */
export function norm(value: string | null | undefined): string {
  const lowered = (value || "").toLowerCase().replace(/®/g, "").replace(/™/g, "");
  return pyStrip(lowered.replace(/[^0-9a-z가-힣+.]+/g, " ").replace(/\s+/g, " "));
}

/** set(norm(s).split()) */
export function tokens(value: string | null | undefined): Set<string> {
  return new Set(norm(value).split(" ").filter(Boolean));
}

/** 코드 포인트 길이(파이썬 len). norm 결과는 BMP 뿐이지만 일반화해 둔다. */
const cpLength = (value: string) => Array.from(value).length;

// ── difflib.SequenceMatcher (CPython 3.14 코드 그대로, isjunk = None, autojunk = True) ──────────────
// a, b 는 코드 포인트 배열이다. b 쪽 구조(b2j·popular)는 후보 문자열마다 미리 만들어 재사용해도 결과가 같다(SequenceB).

/** b 쪽 구조(옛 __chain_b). 길이 200 이상이면 n//100+1 번보다 많이 나오는 원소를 b2j 에서 지운다(popular). bjunk 는 늘 비어 있다. */
export class SequenceB {
  readonly b: string[];
  readonly b2j: Map<string, number[]>;
  readonly popular: Set<string>;
  /** isjunk = None 이라 늘 비어 있다(옛 bjunk). popular 는 bjunk 가 아니다. */
  readonly bjunk: ReadonlySet<string> = new Set();
  constructor(b: string) {
    this.b = Array.from(b);
    const b2j = new Map<string, number[]>();
    this.b.forEach((element, index) => {
      const list = b2j.get(element);
      if (list) list.push(index);
      else b2j.set(element, [index]);
    });
    this.popular = new Set();
    const n = this.b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [element, indexes] of b2j) if (indexes.length > ntest) this.popular.add(element);
      for (const element of this.popular) b2j.delete(element);
    }
    this.b2j = b2j;
  }
}

export type MatchBlock = [number, number, number];
const NOTHING: number[] = [];

export class SequenceMatcher {
  private readonly a: string[];
  private readonly sb: SequenceB;
  private blocks: MatchBlock[] | null = null;

  constructor(a: string, b: string | SequenceB) {
    this.a = Array.from(a);
    this.sb = typeof b === "string" ? new SequenceB(b) : b;
  }

  /** 옛 find_longest_match. bjunk 가 비어 있으므로 isbjunk 는 늘 거짓이다(popular 는 bjunk 가 아니라서 아래 확장이 popular 문자도 이어 붙인다). */
  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): MatchBlock {
    const { a } = this;
    const { b, b2j } = this.sb;
    const bjunk = this.sb.bjunk;
    const isbjunk = (element: string) => bjunk.has(element);
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? NOTHING) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && !isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && !isbjunk(b[bestj + bestsize]) && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    // 옛 코드의 junk 확장 두 루프(bjunk 가 비어 있어 아무 일도 하지 않는다)
    while (besti > alo && bestj > blo && isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && isbjunk(b[bestj + bestsize]) && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  }

  /** 옛 get_matching_blocks: 큐는 스택(list.pop()), 정렬 뒤 인접 블록 병합, 끝에 (la, lb, 0). */
  getMatchingBlocks(): MatchBlock[] {
    if (this.blocks) return this.blocks;
    const la = this.a.length;
    const lb = this.sb.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const found: MatchBlock[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const block = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = block;
      if (k) {
        found.push(block);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const merged: MatchBlock[] = [];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) merged.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    this.blocks = merged;
    return merged;
  }

  /** 2.0 * M / T (T = 0 이면 1.0). 블록 정렬·병합은 합계를 바꾸지 않는다. */
  ratio(): number {
    let matches = 0;
    for (const block of this.getMatchingBlocks()) matches += block[2];
    const length = this.a.length + this.sb.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}

/** SequenceMatcher(None, a, b).ratio() */
export function seqRatio(a: string, b: string | SequenceB): number {
  return new SequenceMatcher(a, b).ratio();
}

/** 후보 문자열의 미리 계산할 수 있는 부분(norm·tokens·SequenceMatcher b 측). 카탈로그 캐시가 제품마다 만든다. */
export type PreparedText = { text: string; norm: string; tokens: Set<string>; seq: SequenceB };
export function prepareText(text: string): PreparedText {
  const normalized = norm(text);
  return { text, norm: normalized, tokens: new Set(normalized.split(" ").filter(Boolean)), seq: new SequenceB(normalized) };
}

/**
 * 정규화된 질의 q(+토큰 qt)와 후보 text 의 유사도 0~1(옛 score_one). 연산 순서까지 그대로다.
 * 자카드(부분 일치 0.6 가중) 0.6 + 시퀀스 유사도 0.4. 부분 일치는 짧은 쪽이 3글자 이상일 때만 인정한다.
 */
export function scoreOne(q: string, qt: Set<string>, text: string | PreparedText): number {
  const prepared = typeof text === "string" ? prepareText(text) : text;
  const pt = prepared.tokens;
  if (!pt.size) return 0.0;
  let exact = 0;
  for (const token of qt) if (pt.has(token)) exact += 1;
  let partial = 0;
  for (const a of qt) {
    if (pt.has(a)) continue;
    const la = cpLength(a);
    for (const b of pt) {
      if ((b.includes(a) || a.includes(b)) && Math.min(la, cpLength(b)) >= 3) {
        partial += 1;
        break;
      }
    }
  }
  const union = qt.size + pt.size - exact;
  const jac = (exact + 0.6 * partial) / union;
  const seq = new SequenceMatcher(q, prepared.seq).ratio();
  return 0.6 * jac + 0.4 * seq;
}

/** 견적서의 다양한 품목명 → 표준 슬롯. 옛 dict 의 삽입 순서 그대로(접두 일치·부분 일치가 순서에 의존한다). */
export const SLOT: ReadonlyArray<readonly [string, string]> = [
  ["CHASSIS", "chassis"], ["CASE", "chassis"], ["샤시", "chassis"], ["케이스", "chassis"],
  ["BAREBONE", "barebone"], ["BARE BONE", "barebone"],
  ["BOARD", "board"], ["M/B", "board"], ["MB", "board"], ["MAINBOARD", "board"], ["메인보드", "board"],
  ["CPU", "cpu"], ["CPU COOLER", "cooler"], ["COOLER", "cooler"], ["CPU CLOOER", "cooler"], ["쿨러", "cooler"],
  ["POWER", "power"], ["PSU", "power"], ["파워", "power"],
  ["FAN", "fan"], ["RAM", "ram"], ["MEMORY", "ram"], ["MEM", "ram"], ["메모리", "ram"],
  ["SSD", "ssd"], ["HDD", "hdd"], ["NVME", "ssd"], ["STORAGE", "hdd"],
  ["GPU", "gpu"], ["VGA", "gpu"],
  ["NIC", "nic"], ["ETHERNET", "nic"], ["NIC CARD", "nic"],
  ["OS", "os"], ["RAID CARD", "raid"], ["NVLINK", "nvlink"],
];
const SLOT_MAP = new Map<string, string>(SLOT);
export const SLOT_ORDER: readonly string[] = ["chassis", "barebone", "board", "cpu", "cooler", "power", "fan", "ram", "ssd", "hdd", "nic", "raid", "nvlink", "gpu", "os"];

/**
 * 질의의 모든 토큰이 후보에 들어 있고, 그중 모델명다운 토큰(5자 이상 + 숫자 포함)이 있는가(옛 is_model_containment).
 * 정규화 뒤 토큰이라 isdigit 은 ASCII 숫자뿐이다.
 */
export function isModelContainment(query: string, candidate: string | PreparedText): boolean {
  const qt = tokens(query);
  const ct = typeof candidate === "string" ? tokens(candidate) : candidate.tokens;
  if (!qt.size) return false;
  for (const token of qt) if (!ct.has(token)) return false;
  for (const token of qt) if (cpLength(token) >= 5 && /[0-9]/.test(token)) return true;
  return false;
}

/** 품목 카테고리 표기 → 표준 슬롯(옛 slot_of): 완전 일치, 아니면 SLOT 순서대로 접두 일치. 모르면 null. */
export function slotOf(cat: string | null | undefined): string | null {
  const c = pyStrip(cat || "").toUpperCase();
  if (!c) return null;
  const exact = SLOT_MAP.get(c);
  if (exact !== undefined) return exact;
  for (const [key, slot] of SLOT) if (c.startsWith(key)) return slot;
  return null;
}

/** 카테고리 표기에서 가능한 슬롯을 모두(옛 slots_of, 감점 판정 전용): 부분 일치하는 키의 값들, 없으면 slotOf. */
export function slotsOf(cat: string | null | undefined): Set<string> {
  const c = pyStrip(cat || "").toUpperCase();
  if (!c) return new Set();
  const found = new Set<string>();
  for (const [key, slot] of SLOT) if (c.includes(key)) found.add(slot);
  if (!found.size) {
    const slot = slotOf(c);
    if (slot) found.add(slot);
  }
  return found;
}
