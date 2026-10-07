// 단가를 승격할지(게이트)와 얼마나 믿을 만한지(라벨)를 정하는 유일한 장소(quote-tool Design §4.3, 옛 quote_gen/confidence.py FR-04·FR-05). 순수 모듈.
// 이 둘은 같은 판단의 앞뒤다. 한 번에 정해 하나의 Verdict 로 내보내면 "confidence=high 인데 suggested 가 비어 있다" 같은 모순이 구조적으로 불가능하다.
// I/O 를 하지 않는다. 입력은 이미 조회된 matches / live / hist 뿐이다.
// 신뢰도는 정보이지 차단이 아니다 — confidence='low' 여도 화면의 '적용' 버튼은 눌린다. 적용을 막는 것은 caution 의 역할이다.
import { pyFormatFixed } from "./quote-pyfmt";

// 단가 승격 최소 점수(FR-04b). 이 아래면 이름 후보는 그대로 보여 주되 단가는 비운다.
// 0.60 을 고른 근거(옛 툴 실측) — 빈출 부품 150종 중 이 게이트에 막히는 20종을 전수 확인했다:
//   진짜 오답 17종  DDR4→DDR5 단가, 870 EVO(SATA)→990 PRO(NVMe), 시소닉 TX-1600→SuperFlower SF-2200, ASMB-830I→816I …
//   오차단  3종  Intel Xeon Silver 4510 표기 2종, '990PRO 1TB'
// 오차단된 것도 이름은 그대로 노출되므로 사용자가 보고 적용할 수 있다. 반대로 막지 않으면 틀린 단가가 조용히 견적에 들어간다.
// 되돌리려면 이 값만 0.0 으로 내리면 된다(감점 FR-04a 와 게이트 FR-04b 는 옛 툴에서 두 커밋으로 나뉘어 있었다).
export const PROMOTE_MIN = 0.60;
/** 이 이상이면 유사도 근거로는 충분 */
export const CONF_HIGH = 0.72;
/** 이 미만이면 유사도만으로는 못 믿는다 */
export const CONF_MED = 0.60;
/** 이력이 이만큼뿐이면 medium 으로 낮춘다 */
export const THIN_HISTORY = 1;
/** 품목 종류 불일치 감점(FR-04, 옛 catalog_v2.CAT_PENALTY = pricing.CAT_PENALTY). 임계값은 손대지 않는다. */
export const CAT_PENALTY = 0.15;
/** 후보 하한(옛 catalog_v2.match 0.38 / pricing.match_product 폴백 0.35). */
export const CANDIDATE_MIN_V2 = 0.38;
export const CANDIDATE_MIN_LEGACY = 0.35;

/**
 * 제안(mergeSuggestion)이 반드시 내보내는 키 23개. 값이 없어도 null 로 낸다(옛 SUGGESTION_KEYS).
 * 조건부 키를 두면 폴백 경로와의 집합 동등성이 깨지고, 소비자가 `d.x ?? 0` 으로 읽다가 '0 = 통과' 같은 거짓 초록불을 만든다.
 */
export const SUGGESTION_KEYS: ReadonlySet<string> = new Set([
  "name", "matches", "suggested", "suggested_date", "suggested_source",
  "kind", "caution", "note", "min", "max", "history",
  // FR-05
  "confidence", "confidence_reason", "match_score", "suggested_grade",
  "cat_rel", "gated", "anchor_name", "contained",
  // FR-09 — 참고 표시용
  "current_price", "delta", "delta_pct", "age_days",
]);

export type Confidence = "high" | "medium" | "low";
export type Grade = "confirmed" | "draft" | "file" | null;
export type CatRel = "match" | "mismatch" | null;
/** decide 가 보는 후보 칸(카탈로그 후보 전체 모양은 quote-pricing.ts 의 ProductMatch). */
export type DecideMatch = { score?: number | null; cat_rel?: CatRel; contained?: boolean; name?: string | null };
export type DecideLive = { status?: string | null };

export type Verdict = {
  promote: boolean;          // 단가를 suggested 로 올릴 것인가
  confidence: Confidence;    // 라벨일 뿐 차단이 아니다
  reason: string;            // 왜 그 라벨인가(툴팁에 그대로 나간다)
  match_score: number | null;
  grade: Grade;              // 발행 로그의 확정분 confirmed / 미확정분 draft / 과거 파일 file
  anchor_name: string | null; // 단가를 가져온 후보 이름(top1 과 다를 때만)
  cat_rel: CatRel;
};

const v = (promote: boolean, confidence: Confidence, reason: string, score: number | null, grade: Grade, anchorName: string | null, catRel: CatRel): Verdict =>
  ({ promote, confidence, reason, match_score: score, grade, anchor_name: anchorName, cat_rel: catRel });

/**
 * 게이트와 라벨을 한 번에 정한다(옛 decide, 판정 순서 그대로).
 * matches 카탈로그 후보(점수 내림차순) · live 발행 로그의 완전일치 이력 · hist 위 둘을 합쳐 날짜 역순 정렬한 이력 · anchor 단가를 가져온 후보(없으면 matches[0]).
 */
export function decide(matches: readonly DecideMatch[], live: readonly DecideLive[], hist: readonly unknown[], anchor: DecideMatch | null = null): Verdict {
  const top = anchor || (matches.length ? matches[0] : null);
  const score = top ? (top.score ?? null) : null;
  const catRel = top ? (top.cat_rel ?? null) : null;
  // FR-14 — 확정분은 실제 거래가, 미확정분은 만들기만 하고 발송을 확인하지 않은 값이다.
  let grade: Grade;
  if (live.length) grade = live.some((row) => (row.status || "confirmed") === "confirmed") ? "confirmed" : "draft";
  else grade = hist.length ? "file" : null;
  // 앵커 이름은 객체 동일성으로 top1 과 다를 때만 채운다.
  const anchorName = anchor && matches.length && anchor !== matches[0] ? (anchor.name ?? null) : null;

  // ① 발행 로그가 있으면 점수와 무관하게 승격한다(name_key 완전일치 조회라 유사도 오매칭의 대상이 아니다).
  if (live.length) {
    if (grade === "draft") return v(true, "low", "미확정 견적의 단가 (발송 확인 전)", score, grade, anchorName, catRel);
    if (hist.length <= THIN_HISTORY) return v(true, "medium", "발행 기록이 1건뿐", score, grade, anchorName, catRel);
    return v(true, "high", "발행 기록의 실제 단가", score, grade, anchorName, catRel);
  }
  // ② 이력이 아예 없으면 올릴 단가 자체가 없다.
  if (!hist.length) return v(false, "low", "단가 이력 없음", score, grade, anchorName, catRel);
  // ③ 과거 파일 이력 — 유사도로 끌어온 값이므로 점수를 본다.
  if (score === null) return v(true, "medium", "과거 견적 이력", score, grade, anchorName, catRel);
  if (score < PROMOTE_MIN) {
    // 모델명이 후보에 통째로 들어 있으면 게이트를 면제한다(자카드가 짧은 질의를 부당하게 깎는 구간의 구제. 실측 'DS2422+' 0.597).
    if (top && top.contained) return v(true, "medium", `모델명 일치 (유사도 ${pyFormatFixed(score, 3)})`, score, grade, anchorName, catRel);
    return v(false, "low", `유사도 낮음 (${pyFormatFixed(score, 3)}) — 이름만 참고`, score, grade, anchorName, catRel);
  }
  if (catRel === "mismatch") return v(true, "low", `품목 종류가 다름 (유사도 ${pyFormatFixed(score, 2)})`, score, grade, anchorName, catRel);
  // 현재 도달 불가(PROMOTE_MIN == CONF_MED). PROMOTE_MIN 을 낮추면 즉시 되살아나는 안전망이라 지우지 않는다(옛 주석).
  if (score < CONF_MED) return v(true, "low", `유사도 낮음 (${pyFormatFixed(score, 2)})`, score, grade, anchorName, catRel);
  if (hist.length <= THIN_HISTORY) return v(true, "medium", "과거 이력이 1건뿐", score, grade, anchorName, catRel);
  if (score < CONF_HIGH) return v(true, "medium", `유사도 보통 (${pyFormatFixed(score, 2)})`, score, grade, anchorName, catRel);
  return v(true, "high", `유사도 높음 (${pyFormatFixed(score, 2)})`, score, grade, anchorName, catRel);
}
