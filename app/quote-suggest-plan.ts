// 단가 제안 부분 갱신(quote-tool QT3b, Design §10.4 '제안은 … 600ms 멈추면 다시 부른다'의 성능 보완). 순수 모듈, import 는 타입뿐이다.
//
// compute SUGGEST 는 카탈로그 전체에 대해 상세 행 하나당 약 6 ms 가 든다(26줄 × 7행이면 1.1~1.6초). 큰 견적을 고칠 때마다 견적 전체를
// 다시 보내면 화면이 느려진다. 줄 하나의 제안은 그 줄의 내용(이름·품목명·세트 여부·단가, 상세의 품목명·사양 첫 줄·단가)만으로 정해지므로
// (app/quote-pricing.ts suggestPrices), 그 내용의 키로 결과를 기억해 두고 키가 바뀐 줄만 서버에 묻는다(compute SUGGEST lineIndexes).
// 수량·확약 문구·매입단가·시트명은 제안에 쓰이지 않아 키에 넣지 않는다(고쳐도 다시 묻지 않는다).
// 카탈로그나 단가 기록이 바뀌는 일(생성·발송 확정·상태 변경) 뒤에는 기억을 비운다(generation 을 올린다).
import type { QuoteLine } from "./quote-model";
import type { Suggestion } from "./quote-pricing";

/** 줄 제안의 재료만 담은 키. 같은 키면 같은 제안이다. */
export function lineSuggestKey(line: QuoteLine): string {
  return JSON.stringify([
    line.label, line.name, line.items.length > 0, line.unit_price,
    line.items.map((item) => [item.category, item.spec.split("\n")[0], item.unit_price]),
  ]);
}

/** 줄 하나의 제안 묶음: "" = 줄 자신, "0"·"1"… = 상세 행. 제안이 없는 자리는 키가 없다. */
export type LineSuggestions = Record<string, Suggestion>;

export class SuggestCache {
  private entries = new Map<string, LineSuggestions>();
  private pending = new Set<string>();
  generation = 0;

  constructor(private readonly limit = 400) {}

  /** 기억을 비운다(단가 기록이 바뀐 뒤). 진행 중이던 응답은 generation 이 달라 버려진다. */
  invalidate() {
    this.entries.clear();
    this.pending.clear();
    this.generation += 1;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  /** 서버에 물어야 할 줄 번호(기억에도 없고 묻는 중도 아닌 키). 같은 키의 줄이 여럿이면 처음 것만 묻는다. */
  plan(lines: readonly QuoteLine[]): number[] {
    const asked = new Set<string>();
    const out: number[] = [];
    lines.forEach((line, index) => {
      const key = lineSuggestKey(line);
      if (this.entries.has(key) || this.pending.has(key) || asked.has(key)) return;
      asked.add(key);
      out.push(index);
    });
    return out;
  }

  markPending(keys: readonly string[]) {
    for (const key of keys) this.pending.add(key);
  }

  clearPending(keys: readonly string[]) {
    for (const key of keys) this.pending.delete(key);
  }

  /**
   * 응답(화면 줄 번호 키: 'li'·'li.ii')을 줄 키별로 나눠 기억한다. sentKeys[i] 는 indexes[i] 줄을 보낼 때의 키다.
   * generation 이 다르면(그사이 기억을 비웠으면) 버린다. 받은 줄은 제안이 하나도 없어도 '빈 묶음'으로 기억한다.
   */
  store(generation: number, indexes: readonly number[], sentKeys: readonly string[], suggestions: Record<string, Suggestion>) {
    if (generation !== this.generation) return false;
    const byLine = new Map<number, LineSuggestions>(indexes.map((index) => [index, {}]));
    for (const [key, value] of Object.entries(suggestions)) {
      const [li, ii] = key.split(".");
      const bucket = byLine.get(Number(li));
      if (bucket) bucket[ii ?? ""] = value;
    }
    indexes.forEach((index, position) => {
      const key = sentKeys[position];
      this.pending.delete(key);
      this.entries.delete(key);
      this.entries.set(key, byLine.get(index) ?? {});
    });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** 지금 줄 목록에 맞춘 제안 표('li'·'li.ii'). 기억에 없는 줄은 비어 있다. */
  assemble(lines: readonly QuoteLine[]): Record<string, Suggestion> {
    const out: Record<string, Suggestion> = {};
    lines.forEach((line, li) => {
      const bucket = this.entries.get(lineSuggestKey(line));
      if (!bucket) return;
      for (const [ii, value] of Object.entries(bucket)) out[ii === "" ? String(li) : `${li}.${ii}`] = value;
    });
    return out;
  }
}
