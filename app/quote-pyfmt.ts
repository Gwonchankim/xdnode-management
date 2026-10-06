// 파이썬 호환 숫자·문자열 표기(quote-tool Design §4.1). 순수 모듈이고 import 가 없다.
// 옛 툴(파이썬)의 repr(float)·round()·f"{x:.3f}"·str.strip()·math.log 와 같은 결과를 내야 dedup 키·제안 이유 문구·회귀 픽스처가 바이트 단위로 맞는다.
// Math.round·toFixed·trim 은 정확한 동률(0.0625 등)·공백 집합에서 파이썬과 갈라진다.

/** 파이썬 str.isspace() 공백 집합(str.strip()·split()·정규식 \s). JS trim 은 \uFEFF 를 지우고 \x1c-\x1f·\x85 를 남겨 다르다. */
export const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const SPLIT_RE = new RegExp(`[${PY_WS}]+`);

/** str.strip() */
export function pyStrip(value: string) {
  return value.replace(STRIP_RE, "");
}

/** str.split() (인자 없음: 공백 묶음으로 나누고 빈 조각은 버린다) */
export function pySplitWs(value: string) {
  return pyStrip(value).split(SPLIT_RE).filter(Boolean);
}

/** 문자열 길이·자르기는 코드 포인트 기준(파이썬 len, s[:n]). */
export const pyLen = (value: string) => Array.from(value).length;
export const pySlice = (value: string, end: number) => Array.from(value).slice(0, end).join("");

/** repr(float) / f"{x}" — 최단 왕복 표기. 소수점 위치가 -4 미만이거나 16 이상이면 지수 표기(e-05, e+16). */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? "-" : "+";
    return `${sign}${body}e${expSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const intLength = exponent + 1;
  if (digits.length <= intLength) return `${sign}${digits}${"0".repeat(intLength - digits.length)}.0`;
  return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
}

/** double 의 정확한 값 = sign × mant × 2^exp (mant, exp 는 BigInt). */
function exactParts(value: number) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = (hi >>> 31) === 1;
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (biased === 0) exp = -1074;
  else {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  return { negative, mant, exp };
}

/** |value| × 10^nd 를 짝수 맞춤으로 정수화(정확한 유리수 연산). */
function scaledHalfEven(value: number, nd: number): { negative: boolean; scaled: bigint } {
  const { negative, mant, exp } = exactParts(value);
  let numerator = mant;
  let denominator = 1n;
  if (exp >= 0) numerator <<= BigInt(exp);
  else denominator <<= BigInt(-exp);
  if (nd >= 0) numerator *= 10n ** BigInt(nd);
  else denominator *= 10n ** BigInt(-nd);
  let quotient = numerator / denominator;
  const remainder2 = (numerator % denominator) * 2n;
  if (remainder2 > denominator || (remainder2 === denominator && (quotient & 1n) === 1n)) quotient += 1n;
  return { negative, scaled: quotient };
}

/** round(x, nd) — 정확한 값 기준 짝수 맞춤(파이썬과 같은 정답 반올림). */
export function pyRound(value: number, nd: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const { negative, scaled } = scaledHalfEven(value, nd);
  const result = Number(`${scaled}e${-nd}`);
  return negative ? -result : result;
}

/** round(x) — 정수 짝수 맞춤. */
export function pyRoundInt(value: number): number {
  return pyRound(value, 0) + 0;
}

/** f"{x:.{nd}f}" — 정확한 짝수 맞춤 십진 문자열. 음수(-0.0 포함)는 부호를 남긴다. */
export function pyFormatFixed(value: number, nd: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const { scaled } = value === 0 ? { scaled: 0n } : scaledHalfEven(value, nd);
  let digits = scaled.toString();
  if (nd > 0) {
    digits = digits.padStart(nd + 1, "0");
    digits = `${digits.slice(0, -nd)}.${digits.slice(-nd)}`;
  }
  return `${negative ? "-" : ""}${digits}`;
}

/** f"{int(x):,}" — 버림 뒤 세 자리 쉼표(로케일 함수를 쓰지 않는다). */
export function pyIntStr(value: number): string {
  const truncated = BigInt(Math.trunc(value));
  const negative = truncated < 0n;
  const digits = (negative ? -truncated : truncated).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${digits}`;
}

/**
 * math.log(n), n = 1~54(파이썬 출력을 그대로 박는다). 0.02*log(n) 은 0.08 에서 잘리므로 n ≥ 55 는 상한을 바로 쓴다.
 * V8 Math.log 와 C log 의 마지막 비트 차이를 원천 차단한다(Design §4.1).
 */
export const PY_LOG_TABLE: readonly number[] = [
  0.0, 0.6931471805599453, 1.0986122886681098, 1.3862943611198906, 1.6094379124341003, 1.791759469228055, 1.9459101490553132,
  2.0794415416798357, 2.1972245773362196, 2.302585092994046, 2.3978952727983707, 2.4849066497880004, 2.5649493574615367,
  2.6390573296152584, 2.70805020110221, 2.772588722239781, 2.833213344056216, 2.8903717578961645, 2.9444389791664403,
  2.995732273553991, 3.044522437723423, 3.091042453358316, 3.1354942159291497, 3.1780538303479458, 3.2188758248682006,
  3.258096538021482, 3.295836866004329, 3.332204510175204, 3.367295829986474, 3.4011973816621555, 3.4339872044851463,
  3.4657359027997265, 3.4965075614664802, 3.5263605246161616, 3.5553480614894135, 3.58351893845611, 3.6109179126442243,
  3.6375861597263857, 3.6635616461296463, 3.6888794541139363, 3.713572066704308, 3.7376696182833684, 3.7612001156935624,
  3.784189633918261, 3.8066624897703196, 3.828641396489095, 3.8501476017100584, 3.871201010907891, 3.8918202981106265,
  3.912023005428146, 3.9318256327243257, 3.9512437185814275, 3.970291913552122, 3.9889840465642745,
];
