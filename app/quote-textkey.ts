// 텍스트 키(quote-tool Design §4.2, 옛 quote_gen/textkey.py — "변경 금지" 함수). 순수 모듈.
// QT2 는 발행 기록(dedup 키 머리·단가 로그 name_key)에 필요한 norm·tokens 만 둔다. scoreOne·SequenceMatcher·SLOT 은 QT3 에서 더한다.
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
