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
