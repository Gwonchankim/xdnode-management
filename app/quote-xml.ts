// 작은 XML 도구(quote-tool Design §1.2·§5.2). 순수 모듈.
// 견적 템플릿은 openpyxl 이 쓴 단순한 XML(주석·CDATA·DOCTYPE 없음)이라 정규식 경계 스캐너로 충분하다. 범용 XML 파서가 아니다.

/** 텍스트·속성 값 이스케이프. */
export function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 이스케이프 풀기(이름 있는 다섯 개 + &#N; · &#xN;). 템플릿 문자열은 &#44204; 같은 숫자 참조로 들어 있다. */
export function unescapeXml(text: string) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity[0] === "#") return String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[entity] as string;
  });
}

/** 여는 태그 문자열에서 속성 값(이스케이프 푼 값). 없으면 null. name 에 ':' 가 있어도 된다. */
export function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : null;
}

/** 속성을 바꾸거나 더한다(값은 이스케이프한다). 태그가 /> 로 끝나도 된다. */
export function setAttr(tag: string, name: string, value: string): string {
  const escaped = escapeXml(value);
  const pattern = new RegExp(`(\\s${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}=")[^"]*(")`);
  if (pattern.test(tag)) return tag.replace(pattern, `$1${escaped}$2`);
  return tag.replace(/\s*(\/?)>$/, ` ${name}="${escaped}"$1>`);
}

// ── 셀 참조 ────────────────────────────────────────────────────────────
/** 'A' → 1, 'AA' → 27 */
export function colToNum(col: string) {
  let n = 0;
  for (const character of col.toUpperCase()) n = n * 26 + (character.charCodeAt(0) - 64);
  return n;
}
/** 1 → 'A' */
export function numToCol(n: number) {
  let out = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
/** 'B13' / '$B$13' → { col: 2, row: 13 } */
export function parseRef(ref: string): { col: number; row: number } {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!match) throw new Error(`bad cell reference: ${ref}`);
  return { col: colToNum(match[1]), row: Number(match[2]) };
}
export const cellRef = (col: number, row: number) => `${numToCol(col)}${row}`;

// ── 요소 경계 ──────────────────────────────────────────────────────────
/** 첫 <name …>…</name> 또는 <name …/> 요소의 [start, end). 없으면 null. 같은 이름이 중첩되지 않는 요소에만 쓴다. */
export function findElement(xml: string, name: string, from = 0): { start: number; end: number; text: string } | null {
  const open = new RegExp(`<${name}(?=[\\s/>])[^>]*?(/?)>`, "g");
  open.lastIndex = from;
  const match = open.exec(xml);
  if (!match) return null;
  if (match[1] === "/") return { start: match.index, end: open.lastIndex, text: match[0] };
  const close = xml.indexOf(`</${name}>`, open.lastIndex);
  if (close < 0) throw new Error(`unclosed <${name}>`);
  const end = close + name.length + 3;
  return { start: match.index, end, text: xml.slice(match.index, end) };
}

/** 모든 <name …/> 또는 <name …>…</name> 요소(중첩 없음 전제). */
export function findAllElements(xml: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const found = findElement(xml, name, from);
    if (!found) return out;
    out.push(found.text);
    from = found.end;
  }
}

/** 여는 태그만(<name …> 또는 <name …/>). */
export function openTag(element: string) {
  return /^<[^>]*>/.exec(element)?.[0] ?? "";
}

export type SheetParts = { head: string; rows: string[]; tail: string };

/** 시트 XML → head(…<sheetData>) · rows(<row> 문자열들) · tail(</sheetData>…). <sheetData/> 도 받는다. */
export function splitSheet(xml: string): SheetParts {
  const selfClosing = /<sheetData\s*\/>/.exec(xml);
  if (selfClosing) {
    return { head: `${xml.slice(0, selfClosing.index)}<sheetData>`, rows: [], tail: `</sheetData>${xml.slice(selfClosing.index + selfClosing[0].length)}` };
  }
  const open = /<sheetData\b[^>]*>/.exec(xml);
  const close = xml.indexOf("</sheetData>");
  if (!open || close < 0) throw new Error("sheetData not found");
  const body = xml.slice(open.index + open[0].length, close);
  return { head: xml.slice(0, open.index + open[0].length), rows: findAllElements(body, "row"), tail: xml.slice(close) };
}

export const rowNumber = (rowXml: string) => Number(attr(openTag(rowXml), "r"));

/** 행 문자열 안의 셀 요소(<c r="REF" …/> 또는 <c r="REF" …>…</c>). */
export function findCell(rowXml: string, ref: string): { start: number; end: number; text: string } | null {
  const pattern = new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const match = pattern.exec(rowXml);
  return match ? { start: match.index, end: match.index + match[0].length, text: match[0] } : null;
}

/** 셀 요소의 값: inlineStr → 문자열, <v> → 숫자(또는 t="str"/"s" 문자열), <f> 는 formula 로. */
export function readCell(cellXml: string): { style: number | null; formula: string | null; value: string | number | null } {
  const tag = openTag(cellXml);
  const style = attr(tag, "s");
  const type = attr(tag, "t");
  const formula = /<f>([\s\S]*?)<\/f>/.exec(cellXml)?.[1] ?? null;
  let value: string | number | null = null;
  if (type === "inlineStr") {
    const texts = [...cellXml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => unescapeXml(match[1]));
    value = texts.length ? texts.join("") : null;
  } else {
    const raw = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
    if (raw !== undefined && raw !== "") value = type === "str" || type === "s" ? unescapeXml(raw) : Number(raw);
  }
  return { style: style === null ? null : Number(style), formula: formula === null ? null : unescapeXml(formula), value };
}
