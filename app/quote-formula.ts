// 생성 수식 평가기(quote-tool Design §5.6, QD-10). 순수 모듈.
// 생성기가 쓰는 문법만 받는다: 숫자, 셀 참조($ 허용), 범위(SUM 안에서만), SUM(인자, …), 이항 + - *, 괄호.
// 그 밖의 문법은 throw 한다(생성기 버그를 바로 드러낸다). 빈 셀·문자열 셀은 0 이다(Excel 산술과 같다).
import { cellRef, parseRef } from "./quote-xml";

export type CellLookup = (ref: string) => number | string | null | undefined;

type Token = { kind: "num"; value: number } | { kind: "ref"; value: string } | { kind: "range"; from: string; to: string }
  | { kind: "fn"; value: string } | { kind: "op"; value: string };

const REF = "\\$?[A-Z]{1,3}\\$?\\d+";
const TOKEN_RE = new RegExp(`\\s*(?:(${REF}):(${REF})|(${REF})(?![A-Z0-9(])|(SUM)(?=\\()|(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)|([-+*(),]))`, "y");

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  const source = formula.replace(/^=/, "");
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(TOKEN_RE.lastIndex))) break;
    const match = TOKEN_RE.exec(source);
    if (!match) throw new Error(`unsupported formula syntax: ${formula}`);
    if (match[1]) tokens.push({ kind: "range", from: match[1], to: match[2] });
    else if (match[3]) tokens.push({ kind: "ref", value: match[3] });
    else if (match[4]) tokens.push({ kind: "fn", value: match[4] });
    else if (match[5]) tokens.push({ kind: "num", value: Number(match[5]) });
    else tokens.push({ kind: "op", value: match[6] });
  }
  return tokens;
}

const toNumber = (value: number | string | null | undefined) => (typeof value === "number" ? value : 0);

/** 수식(앞의 '=' 는 있어도 없어도 된다)을 계산한다. 셀 값은 lookup 이 준다(수식 셀이면 이미 계산된 값). */
export function evaluateFormula(formula: string, lookup: CellLookup): number {
  const tokens = tokenize(formula);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const expectOp = (value: string) => {
    const token = take();
    if (!token || token.kind !== "op" || token.value !== value) throw new Error(`expected '${value}' in ${formula}`);
  };

  function rangeValues(from: string, to: string): number[] {
    const a = parseRef(from);
    const b = parseRef(to);
    const out: number[] = [];
    for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row += 1) {
      for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col += 1) out.push(toNumber(lookup(cellRef(col, row))));
    }
    return out;
  }

  function factor(): number {
    const token = take();
    if (!token) throw new Error(`unexpected end of ${formula}`);
    if (token.kind === "num") return token.value;
    if (token.kind === "ref") return toNumber(lookup(token.value.replace(/\$/g, "")));
    if (token.kind === "fn") {
      expectOp("(");
      let sum = 0;
      if (!(peek()?.kind === "op" && (peek() as { value: string }).value === ")")) {
        for (;;) {
          const next = peek();
          if (next?.kind === "range") {
            take();
            for (const value of rangeValues(next.from, next.to)) sum += value;
          } else sum += expression();
          const separator = peek();
          if (separator?.kind === "op" && separator.value === ",") { take(); continue; }
          break;
        }
      }
      expectOp(")");
      return sum;
    }
    if (token.kind === "op" && token.value === "(") {
      const value = expression();
      expectOp(")");
      return value;
    }
    throw new Error(`unsupported token in ${formula}`);
  }

  function term(): number {
    let value = factor();
    while (peek()?.kind === "op" && (peek() as { value: string }).value === "*") {
      take();
      value *= factor();
    }
    return value;
  }

  function expression(): number {
    let value = term();
    for (;;) {
      const next = peek();
      if (next?.kind !== "op" || (next.value !== "+" && next.value !== "-")) return value;
      take();
      value = next.value === "+" ? value + term() : value - term();
    }
  }

  const result = expression();
  if (index !== tokens.length) throw new Error(`trailing tokens in ${formula}`);
  return result;
}

/** 수식 셀 지도(ref → 수식)를 의존 순서로 모두 계산한다. values 는 값 셀(ref → 숫자·문자열). 순환이면 throw. */
export function evaluateAll(formulas: ReadonlyMap<string, string>, values: ReadonlyMap<string, number | string>): Map<string, number> {
  const done = new Map<string, number>();
  const visiting = new Set<string>();
  const lookup: CellLookup = (ref) => {
    if (formulas.has(ref)) return compute(ref);
    return values.get(ref) ?? null;
  };
  function compute(ref: string): number {
    const cached = done.get(ref);
    if (cached !== undefined) return cached;
    if (visiting.has(ref)) throw new Error(`circular formula at ${ref}`);
    visiting.add(ref);
    const value = evaluateFormula(formulas.get(ref) as string, lookup);
    visiting.delete(ref);
    done.set(ref, value);
    return value;
  }
  for (const ref of formulas.keys()) compute(ref);
  return done;
}
