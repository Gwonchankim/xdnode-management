// 상담 답의 작은 마크다운 해석(quote-tool Design §7.3 '응답 렌더링', 옛 index.html md() — S8 소멸). 순수 모듈(화면 전용).
// HTML 문자열을 만들지 않는다. 글을 블록(문단·목록·표)과 인라인 조각(글·굵게·코드·링크)으로 나누기만 하고, 그리기는 React 노드로 한다
// (app/quote-assist-view.tsx). 그래서 답 안의 <script>·<img onerror> 같은 HTML 은 글자 그대로 보인다.
// 링크는 http(s) 주소만 링크 조각이 된다(javascript:·data:·상대 경로는 글자로 남는다). 링크는 새 창, rel="noopener noreferrer" 로 연다.

export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };
export type ChatBlock =
  | { kind: "paragraph"; lines: ChatInline[][] }
  | { kind: "heading"; inline: ChatInline[] }
  | { kind: "list"; items: ChatInline[][] }
  | { kind: "table"; head: ChatInline[][]; rows: ChatInline[][][] }
  | { kind: "code"; text: string };

/** http(s) 절대 주소만 받는다. 파싱해 프로토콜을 다시 보고, 정규화한 주소를 돌려준다. 아니면 null. */
export function safeHref(raw: string): string | null {
  if (!/^https?:\/\/[^\s<>"'`]+$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// 인라인 토큰: `코드` | **굵게** | [글](주소) | 맨 주소
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<>"'`]+)/g;

export function parseInline(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += value; else out.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    pushText(text.slice(cursor, index));
    cursor = index + match[0].length;
    if (match[1] !== undefined) out.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: "strong", text: match[2] });
    else if (match[3] !== undefined) {
      const href = safeHref(match[4]);
      if (href) out.push({ kind: "link", text: match[3], href });
      else pushText(match[0]); // http(s) 가 아닌 링크는 글자 그대로
    } else if (match[5] !== undefined) {
      // 문장 끝 마침표·쉼표는 주소에서 뺀다.
      const trimmed = match[5].replace(/[.,;:!?]+$/, "");
      const href = safeHref(trimmed);
      if (href) { out.push({ kind: "link", text: trimmed, href }); pushText(match[5].slice(trimmed.length)); } else pushText(match[5]);
    }
  }
  pushText(text.slice(cursor));
  return out;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const FENCE = /^\s*```/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => parseInline(cell.trim()));

/** 답 전체 → 블록 목록(옛 md() 와 같은 규칙: 표·목록·문단, 그리고 제목·코드 울타리). 상한 없이 줄 단위로 한 번 훑는다. */
export function parseChatMarkdown(source: string): ChatBlock[] {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1; // 닫는 울타리(없으면 끝까지)
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      const head = cells(line);
      index += 2;
      const rows: ChatInline[][][] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index])) { rows.push(cells(lines[index])); index += 1; }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (BULLET.test(line)) {
      const items: ChatInline[][] = [];
      while (index < lines.length && BULLET.test(lines[index])) { items.push(parseInline(lines[index].replace(BULLET, ""))); index += 1; }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (HEADING.test(line)) {
      blocks.push({ kind: "heading", inline: parseInline(line.replace(HEADING, "").replace(/\s+#+\s*$/, "")) });
      index += 1;
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    // 첫 줄은 무조건 먹는다(구분선 없는 '| … |' 줄이 문단 조건에서 빠져 같은 자리에 머무는 일이 없게).
    const paragraph: ChatInline[][] = [parseInline(line)];
    index += 1;
    while (index < lines.length && lines[index].trim() && !BULLET.test(lines[index]) && !TABLE_ROW.test(lines[index]) && !HEADING.test(lines[index]) && !FENCE.test(lines[index])) {
      paragraph.push(parseInline(lines[index]));
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}
