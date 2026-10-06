// 견적 파일명(quote-tool Design §4.8, 옛 quote_gen/filename.py). 순수 모듈.
// 파이썬 re(str 패턴)의 \b·\w·\d·\s 는 유니코드다. JS 는 u 플래그와 명시 클래스로 옮긴다:
//   \w → [\p{L}\p{N}_], \d → \p{Nd}, \s → PY_WS, \b( → (?<![\p{L}\p{N}_])( (대안이 모두 단어 문자로 시작하므로 앞쪽 경계만 필요)
import { isGroup, type Quote } from "./quote-model";
import { PY_WS, pySlice, pyStrip } from "./quote-pyfmt";

const BAD = /[\\/:*?"<>|]/g;
const HINT_RE = /(?<![\p{L}\p{N}_])(G\p{Nd}{3}|HPC-?\p{Nd}{4}|T\p{Nd}{4}|DGX [\p{L}\p{N}_]+|DS\p{Nd}{3,4}\+?|S\p{Nd}{4}[\p{L}\p{N}_]*)/u;
const NVIDIA_PREFIX = new RegExp(`^NVIDIA[${PY_WS}]+`, "u");
const GPU_PREFIX = new RegExp(`^[${PY_WS}]*NVIDIA[${PY_WS}]+(RTX[${PY_WS}]+)?`, "u");
const GPU_SUFFIX = new RegExp(`[${PY_WS}]+(Blackwell|Ada Generation|D6 \\p{Nd}+GB|\\p{Nd}+GB)$`, "u");

/** 옛 auto_model_hint: 줄 이름의 모델 패턴(없으면 단품 이름 앞 20자) + GPU 상세 첫 줄, 중복 없이 앞 2개를 ',' 로 잇는다. */
export function autoModelHint(quote: Pick<Quote, "lines">): string {
  const hints: string[] = [];
  for (const line of quote.lines) {
    const name = pyStrip(line.name || "");
    const match = HINT_RE.exec(name);
    if (match) hints.push(match[1]);
    else if (name && !isGroup(line)) hints.push(pySlice(name.replace(NVIDIA_PREFIX, ""), 20));
    for (const item of line.items) {
      if (pyStrip(item.category).toUpperCase() !== "GPU") continue;
      let gpu = pyStrip(item.spec.split("\n")[0].replace(GPU_PREFIX, ""));
      gpu = gpu.replace(GPU_SUFFIX, "");
      // 옛 코드 그대로: 중복 검사는 자르기 전 값으로, 넣는 값은 24자.
      if (gpu && !hints.includes(gpu)) hints.push(pySlice(gpu, 24));
    }
  }
  return hints.length ? hints.slice(0, 2).join(",") : "";
}

/** 'YYYY-MM-DD' → 'yymmdd' */
const yymmdd = (isoDate: string) => `${isoDate.slice(2, 4)}${isoDate.slice(5, 7)}${isoDate.slice(8, 10)}`;

/**
 * 옛 quote_filename: 견적서(엑스디노드)_{yymmdd}_{기관}({힌트})_{담당자} 귀하[-{접미}].xlsx, 파일명 금지문자 제거.
 * model_hint 가 null 이면 자동, 빈 문자열이면 괄호 없음(옛 `is not None`). issue_date 가 없으면 issueDate 인자(호출부의 KST 오늘).
 */
export function quoteFilename(quote: Pick<Quote, "lines" | "customer" | "issue_date" | "model_hint">, suffix?: string | null, issueDate?: string, ext = ".xlsx") {
  const date = quote.issue_date ?? issueDate ?? "";
  const hint = quote.model_hint !== null ? quote.model_hint : autoModelHint(quote);
  const org = pyStrip(quote.customer.org);
  const contact = pyStrip(quote.customer.contact);
  let core = `견적서(엑스디노드)_${yymmdd(date)}_${org}`;
  if (hint) core += `(${hint})`;
  if (contact) core += `_${contact} 귀하`;
  if (suffix) core += `-${suffix}`;
  return core.replace(BAD, "") + ext;
}
