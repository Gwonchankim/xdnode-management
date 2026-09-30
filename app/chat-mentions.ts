// 멘션(R5, Design §4.2.8·§7.8). 순수 함수만 둔다. 서버(전송·수정)와 화면(강조)이 함께 쓴다.
// `@이름`은 사람 목록의 표시 이름과 맞춘다. 이름에 공백이 있을 수 있어 정규식으로 자르지 않고, 긴 이름부터 맞춘다
// (예: '@김철수' 가 '@김철' 로 잡히지 않게). 이름 뒤에는 글자·숫자가 이어지지 않아야 한다.

export type MentionPerson = { accountId: string; name: string };
export type MentionPiece = { text: string; mention: boolean };

const CHANNEL_WORDS = ["channel", "채널"];

function boundaryAfter(body: string, end: number) {
  if (end >= body.length) return true;
  return !/[\p{L}\p{N}_]/u.test(body[end]);
}

/** '@' 위치에서 맞는 가장 긴 이름. 사람이면 accountId, @channel·@채널이면 "@channel". 없으면 null. */
function matchAt(body: string, at: number, people: MentionPerson[]): { length: number; accountId: string } | null {
  for (const word of CHANNEL_WORDS) {
    if (body.startsWith(word, at + 1) && boundaryAfter(body, at + 1 + word.length)) return { length: word.length + 1, accountId: "@channel" };
  }
  for (const person of people) {
    if (person.name && body.startsWith(person.name, at + 1) && boundaryAfter(body, at + 1 + person.name.length)) {
      return { length: person.name.length + 1, accountId: person.accountId };
    }
  }
  return null;
}

function byLongestName(people: MentionPerson[]) {
  return people.filter((person) => person.name.trim()).slice().sort((a, b) => b.name.length - a.name.length);
}

/** 본문에서 멘션된 계정과 @channel 여부. 같은 사람을 여러 번 불러도 한 번만 센다. */
export function extractMentions(body: string, people: MentionPerson[]): { accountIds: string[]; channel: boolean } {
  const sorted = byLongestName(people);
  const accountIds = new Set<string>();
  let channel = false;
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    const match = matchAt(body, at, sorted);
    if (!match) continue;
    if (match.accountId === "@channel") channel = true;
    else accountIds.add(match.accountId);
  }
  return { accountIds: [...accountIds], channel };
}

/** 화면 강조용 조각. HTML 문자열이 아니라 {text, mention} 배열이다. 그리는 쪽은 React 텍스트 노드만 쓴다(§7.8). */
export function highlightMentions(body: string, people: MentionPerson[]): MentionPiece[] {
  const sorted = byLongestName(people);
  const pieces: MentionPiece[] = [];
  let cursor = 0;
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    if (at < cursor) continue;
    const match = matchAt(body, at, sorted);
    if (!match) continue;
    if (at > cursor) pieces.push({ text: body.slice(cursor, at), mention: false });
    pieces.push({ text: body.slice(at, at + match.length), mention: true });
    cursor = at + match.length;
  }
  if (cursor < body.length) pieces.push({ text: body.slice(cursor), mention: false });
  return pieces;
}

// ── 작성란 자동완성(@ 입력 시 명단) ─────────────────────────────────────────
export const MENTION_QUERY_MAX = 20;
export const MENTION_SUGGESTION_LIMIT = 8;
export const CHANNEL_MENTION = { accountId: "@channel", name: "채널" } as const;

/**
 * 커서 앞의 '@질의'. '@'는 글 처음이거나 공백·문장부호 뒤여야 한다(메일 주소 a@b 는 제외).
 * 질의에는 줄바꿈이 없고 20자까지다(이름에 공백이 있을 수 있어 공백은 허용한다).
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MENTION_QUERY_MAX || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
function syllable(character: string) {
  const code = character.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? { initial: Math.floor(code / 588), medial: Math.floor((code % 588) / 28), final: code % 28 } : null;
}

/**
 * 한글 조합 중에도 앞부분이 맞게 본다. 마지막 글자는 덜 조합된 상태를 허용한다:
 * 자음만('ㄱ')이면 초성이, 받침 없는 글자('기')면 초성·중성이 같으면 맞다(예: 'ㄱ'·'기'·'김' 모두 '김철수'에 맞다).
 */
export function hangulPrefixMatch(name: string, query: string) {
  if (!query) return true;
  if (name.length < query.length) return false;
  const last = query.length - 1;
  if (name.slice(0, last) !== query.slice(0, last)) return false;
  const typed = query[last];
  const target = name[last];
  if (typed === target) return true;
  const initialIndex = INITIALS.indexOf(typed);
  const targetSyllable = syllable(target);
  if (initialIndex >= 0) return targetSyllable?.initial === initialIndex;
  const typedSyllable = syllable(typed);
  return Boolean(typedSyllable && targetSyllable && typedSyllable.final === 0
    && typedSyllable.initial === targetSyllable.initial && typedSyllable.medial === targetSyllable.medial);
}

/**
 * 질의에 맞는 후보. 앞부분이 맞는 사람 → 중간이 맞는 사람 순이고, 같은 순위에서는 넘겨준 순서(멤버 먼저)를 지킨다.
 * @채널은 질의가 비었거나 '채널'·'channel'의 앞부분일 때 맨 뒤에 붙인다. 맞는 사람이 없고 질의에 공백이 있으면 닫는다(빈 배열).
 */
export function mentionSuggestions(people: MentionPerson[], query: string, { includeChannel = true } = {}): MentionPerson[] {
  const needle = query.toLowerCase();
  const prefix: MentionPerson[] = [];
  const inner: MentionPerson[] = [];
  for (const person of people) {
    const name = person.name.toLowerCase();
    if (hangulPrefixMatch(name, needle)) prefix.push(person);
    else if (name.includes(needle)) inner.push(person);
  }
  const matches = [...prefix, ...inner].slice(0, MENTION_SUGGESTION_LIMIT);
  if (includeChannel && ["채널", "channel"].some((word) => hangulPrefixMatch(word, needle))) matches.push(CHANNEL_MENTION);
  if (!matches.length && /\s/.test(query)) return [];
  return matches;
}

/** '@질의'를 '@이름 '으로 바꾼 본문과 새 커서 위치. */
export function applyMention(text: string, start: number, caret: number, name: string) {
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}
