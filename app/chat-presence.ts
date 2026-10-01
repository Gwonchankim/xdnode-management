// messenger-enhancement ME-FR-09 접속 상태(Design §4.2 poll, ME-DD6). poll 이 부를 때마다 메모리 맵만 갱신한다(D1 쓰기 0).
// 운영은 단일 vite preview 프로세스다(D18). 재시작하면 비고, 비어 있는 사람은 summary poll 이 세션 last_seen_at 으로 채운다.
// platformSchemaReady 의 모듈 전역 memo 와 같은 방식이다. 서버 전용이다(클라이언트는 import 하지 않는다).

/** 하루 넘게 poll 이 없던 항목은 걷는다(맵이 끝없이 자라지 않게). */
const PRESENCE_TTL_MS = 86_400_000;

const lastSeen = new Map<string, number>();

export function touchPresence(accountId: string, now = Date.now()) {
  lastSeen.set(accountId, now);
}

/** accountId → 마지막 poll 시각(ms). */
export function presenceSnapshot(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [accountId, at] of lastSeen) {
    if (now - at > PRESENCE_TTL_MS) lastSeen.delete(accountId);
    else out[accountId] = at;
  }
  return out;
}

/** 맵에 없을 때만 넣는다(summary poll 이 세션 last_seen_at 으로 채운 값을 다음 일반 poll 에도 싣게, QA 2026-10-01). */
export function seedPresence(accountId: string, at: number) {
  if (!lastSeen.has(accountId)) lastSeen.set(accountId, at);
}

/** 메신저 권한을 잃은 계정은 맵에서 뺀다(summary poll 이 chatPeople 로 부른다). */
export function prunePresence(allowed: ReadonlySet<string>) {
  for (const accountId of lastSeen.keys()) if (!allowed.has(accountId)) lastSeen.delete(accountId);
}

/** 하니스 전용: 새 메모리 DB 를 만들 때 비운다. */
export function resetPresence() {
  lastSeen.clear();
}
