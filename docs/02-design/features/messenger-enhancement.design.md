# messenger-enhancement Design Document

> **Summary**: R5 메신저에 알림·활동함(M2), 반응·읽음 숫자·접속 상태(M3), 고정·북마크·파일·검색 필터(M4)를 얹는다. 공용 기반(M1)이 먼저다. 설계안은 C(균형)다. 라우트 3개(reactions·pins·me)를 더하고, UI 파일 4개를 분리하고, 기존 폴링·이벤트 구조는 그대로 둔다.
>
> **Project**: XDnode management (`xdnode-management`)
> **Version**: 0.1 (기준 커밋 `750b4db`)
> **Author**: gc.kim (Claude Code 협업)
> **Date**: 2026-09-30
> **Status**: Draft
> **Planning Doc**: [messenger-enhancement.plan.md](../../01-plan/features/messenger-enhancement.plan.md) (MD1~MD10, FR-01~FR-13, SC-1~SC-10)
> **Upstream Design**: [xdnode-management.design.md](xdnode-management.design.md) §3.3, §4.2.8, §7.8 (R5)

### Pipeline References

| Phase | Document | Status |
|-------|----------|--------|
| Schema | 이 문서 §3 | ✅ |
| Convention | `CLAUDE.md` Conventions, Harness rules | ✅ |
| Mockup | 이 문서 §5 (ASCII) | ✅ |
| API Spec | 이 문서 §4 | ✅ |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 메시지를 놓치고, 확인 여부를 모르고, 예전 내용을 찾기 어렵다. 그래서 카톡으로 되돌아간다(PRD O3). |
| **WHO** | 경영지원실 5~6명. 사내 LAN, HTTP, 여러 PC에서 접속한다. 관리자 1명이 계정과 탭 권한을 준다. |
| **RISK** | `chat_events.kind`의 CHECK 제약 때문에 새 이벤트 종류를 추가할 수 없다(D4). 폴링 hot path의 쿼리와 쓰기가 늘 수 있다. HTTP LAN에서는 `Notification`을 쓸 수 없다. |
| **SUCCESS** | 다른 탭에서도 폴링 1주기 안에 DM·멘션 알림이 온다. 반응·읽음 숫자가 폴링 1주기 안에 반영된다. 비멤버는 새 기능 어디서도 비공개 대화를 볼 수 없다. poll 쿼리 증가는 1개 이하, 쓰기는 0이다. |
| **SCOPE** | M1 공용 기반 → M2 알림·활동함 → M3 확인 문화 → M4 정보 정리. E·F·D는 범위 밖이다. |

---

## Decision Record (Design 추가분)

Plan MD1~MD10을 그대로 따른다. 아래는 이 문서에서 새로 정한 것이다. 코드 주석에서는 `ME-DD3`처럼 쓴다.

| ID | 결정 | 근거 |
|----|------|------|
| DD1 | 설계안은 **C(균형)**다 | Checkpoint 3, 2026-09-30 |
| DD2 | 반응은 DTO에 `reactions: [{ emoji, accountIds[] }]`로 싣는다. "내가 눌렀나"와 이름은 클라이언트가 `accountId`와 `people`로 계산한다. `messageDtos(db, ids)`의 시그니처(보는 사람 무관)를 유지하기 위해서다 | 코드: `messageDtos`에 viewer 인자가 없고, poll 한 번에 여러 사람 DTO를 공유한다 |
| DD3 | 북마크는 사람마다 다르므로 **DTO에 넣지 않는다**. 클라이언트가 `GET /api/chat/me?view=bookmarks`로 id 집합을 들고 있다 | DD2와 같은 이유 |
| DD4 | 고정은 DTO에 `pinnedAt: number \| null`로 싣는다(보는 사람 무관). 채널 DTO에 `pinCount`를 둔다 | |
| DD5 | 반응 변경은 `message.edited` 이벤트로, 고정 변경은 `message.edited` + `channel.updated` 두 이벤트로 알린다. 반응·고정은 `edited_at`을 바꾸지 않는다. 그래서 `(수정됨)`이 뜨지 않는다 | MD7 |
| DD6 | 접속 상태는 **모듈 메모리 맵**(`app/chat-presence.ts`)에 둔다. poll이 `touch(accountId)`를 호출한다(D1 쓰기 0). 프로세스가 재시작되면 비고, 메모리 맵에 없는 사람은 `summary=1` poll에서만 `auth_sessions.last_seen_at`(시간 단위로 거칠다)으로 채운다 | `platformSchemaReady`의 모듈 전역 memo가 선례다. 운영은 단일 `vite preview` 프로세스다(D18) |
| DD7 | 읽음 숫자용 읽음 위치는 **이벤트가 아니라 poll 스냅샷**이다. 클라이언트가 `active=<channelId>`를 보내고, 그 채널의 현재 멤버라면 `reads: { channelId, members: [{ accountId, lastReadMessageId, joinedAt }] }`를 매 poll마다 싣는다(쿼리 1개) | Plan 위험 #2, NFR "poll 쿼리 +1" |
| DD8 | 읽음 숫자에서 메시지 작성 **뒤에 들어온 멤버**(`joinedAt > createdAt`)는 세지 않는다 | 카톡 동작과 같다. 새 멤버가 옛 글 전부에 숫자를 올리지 않게 |
| DD9 | 알림 판정·토스트·비프음·파비콘은 **셸**(`app/page.tsx`)에서 `useChatNotifier(chatPoll, …)`로 띄운다. 채팅 화면은 이 훅이 알려 주는 "지금 보고 있는 채널"만 설정한다 | 다른 탭에 있을 때는 셸의 poll만 살아 있다 |
| DD10 | 알림에 필요한 채널 메타(kind, name, notifyLevel)는 `UnreadSummary.channels[]`에 **필드로 덧붙인다**. 추가 요청을 하지 않는다 | `unreadSummary`는 이미 `chat_channels`를 조인한다 |
| DD11 | 알림음은 **WebAudio로 합성한 짧은 2음 비프**(약 180ms)다. 음원 파일은 없다. 첫 사용자 제스처 뒤에 `AudioContext`를 만든다 | 저작권·자산 관리가 없다. autoplay 정책 |
| DD12 | 파비콘 배지는 `/brand/xdnode-favicon-32.png`를 canvas에 그리고 빨간 원(숫자는 99+까지)을 얹어 `<link rel="icon">`의 href를 dataURL로 바꾼다. 0이면 원래 href로 되돌린다 | `app/layout.tsx` icons |
| DD13 | 활동함의 "참여 스레드 새 답글"은 새 테이블 `chat_thread_reads`로 계산한다. 참여 = 루트 작성 또는 답글 작성. 스레드 패널을 열거나 열린 패널에 답글이 오면 `THREAD_READ`로 전진시킨다 | 채널 읽음 위치와 스레드 읽음은 다르다(MD10) |
| DD14 | 감사 예외 파일은 `chat/read-state/route.ts`와 **`chat/me/route.ts`** 두 개다. `tests/erp-platform.test.mjs` 가드의 예외 분기를 목록으로 바꾼다 | MD9 |
| DD15 | "메시지로 이동"은 `GET /api/chat/messages?channelId&around=<id>`다(앞 25개, 대상, 뒤 25개). 기록 상태에 `hasNewer`를 더한다. `hasNewer`가 참이면 poll의 새 최상위 글을 붙이지 않고 "최신 메시지로 ↓" 버튼을 띄운다. 아래로 스크롤하면 `after=<lastId>`로 이어 읽는다 | 기존 기록은 "바닥부터 연속"을 가정한다 |
| DD16 | 고정 8개 반응 목록은 `CHAT_REACTIONS`로 한 번만 정의한다. `chat-server.ts`(서버 검증)와 `chat-client.ts`(UI)에 같은 배열을 두고, 두 배열이 같은지 테스트로 고정한다 | 기존 `CHAT_ALLOWED_EXTENSIONS` 중복 패턴과 같다(클라이언트는 서버 모듈을 값으로 import하지 않는다) |

---

## 1. Overview

### 1.1 Design Goals

1. **기존 계약을 깨지 않는다.** DTO는 필드 추가만 한다. 이벤트 kind는 늘리지 않는다. 기존 R5 테스트 20개는 그대로 통과해야 한다.
2. **poll hot path를 지킨다.** 쿼리는 +1(reads)만 늘고, D1 쓰기는 0이다(presence는 메모리).
3. **접근 판정은 하나다.** 새 라우트도 모두 `loadChannelAccess`를 거친다. 비멤버는 404다.
4. **알림은 셸, 표시는 워크스페이스.** 다른 탭에서도 동작해야 하는 것(알림, 파비콘)과 채팅 화면 안의 것(반응, 읽음 숫자, 패널)을 나눈다.

### 1.2 Design Principles

- **Fail closed**: 반응 이모지·알림 수준·view 값이 목록 밖이면 400이다. 접근을 모르면 404다.
- **Viewer-independent DTO**: 메시지 DTO는 보는 사람과 무관하다(DD2~DD4).
- **추가만 한다**: 새 테이블 5개만 추가하고, ALTER·DROP은 하지 않는다(MD8).
- **순수 함수로 판정**: 알림 여부(`shouldNotify`), 읽음 숫자(`unreadCountFor`), 접속 표시(`presenceLabel`)는 순수 함수로 만들어 `node --test`로 직접 검증한다.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | A: Minimal | B: Clean | **C: Pragmatic** |
|----------|:-:|:-:|:-:|
| 방식 | messages·channels 라우트에 action 추가, UI는 한 파일 | 기능별 라우트 7개, 워크스페이스 재작성 | 라우트 3개 추가(감사 기준으로 나눔), UI 파일 4개 분리 |
| New Files | 1 | ~14 | 8 |
| Modified Files | ~8 | ~12 | ~10 |
| Complexity | Low | High | Medium |
| Maintainability | Medium (워크스페이스 ~1,400줄) | High | High |
| Effort | Low | High | Medium |
| Risk | 감사 예외 판정이 흐려짐 | R5 회귀 | 중간 |

**Selected**: **Option C**. **Rationale**: 감사 예외를 파일 단위 가드로 유지할 수 있다(`me`만 예외). 워크스페이스는 뼈대를 유지해 R5 회귀를 줄이면서, 새 UI는 분리해 파일 크기를 억제한다.

### 2.1 Component Diagram

```
┌──────────────────────── Browser ─────────────────────────────────────┐
│ page.tsx (셸)                                                         │
│   useChatPoll ──events──▶ useChatNotifier ──▶ 토스트·비프·파비콘·시스템알림 │
│        │  ▲ setActive(channelId) / setViewing                          │
│        │  │                                                           │
│        ▼  │                                                           │
│   ChatWorkspace ── chat-message.tsx (반응 바·읽음 숫자·저장 버튼)        │
│        │          chat-panels.tsx (고정·파일·저장됨·활동함)             │
└────────┼──────────────────────────────────────────────────────────────┘
         │ fetch (same-origin, xdm_session)
┌────────▼──────────────────── Worker (vite preview) ────────────────────┐
│ /api/chat/poll ──┬─ chat_events (seq)                                   │
│                  ├─ reads snapshot (chat_members, active 채널)   ← +1 쿼리 │
│                  └─ chat-presence.ts (메모리 맵)                ← 쓰기 0   │
│ /api/chat/messages  (+around, +after, +검색 필터)                         │
│ /api/chat/attachments (+GET ?channelId 목록)                             │
│ /api/chat/reactions  (NEW, 감사)                                          │
│ /api/chat/pins       (NEW, 감사)                                          │
│ /api/chat/me         (NEW, 감사 예외: 북마크·알림 수준·스레드 읽음·활동함)    │
│ chat-server.ts: loadChannelAccess · messageDtos(+reactions, +pinnedAt)    │
│                 unreadSummary(+notify, +threads, +meta)                   │
└────────┬────────────────────────────────────────────────────────────────┘
         ▼
      D1 (SQLite): 기존 7 테이블 + chat_reactions · chat_pins · chat_bookmarks
                                  · chat_member_prefs · chat_thread_reads
```

### 2.2 Data Flow

**반응 (FR-07)**
```
👍 클릭 → POST /api/chat/reactions {messageId, emoji}
  → authorize(chat:write) → 메시지 조회 → loadChannelAccess(404) → 보관/삭제 409
  → batch[ INSERT … ON CONFLICT DO NOTHING | DELETE (토글) , event message.edited ]
  → writeErpAudit(CHAT_REACTION_ADDED/REMOVED) → { message: DTO }
  → 다른 사람: poll → message.edited(DTO) → applyMessage(replace)
```

**읽음 숫자 (FR-08)**
```
ChatWorkspace가 채널을 연다 → poll.setActive(channelId)
poll GET ?active=ch → reads { members[{accountId,lastReadMessageId,joinedAt}] }
MessageItem: unreadCountFor(message, reads, authorId) → 0이면 숨김
상대가 읽음 → 상대의 read-state PUT → 내 다음 poll의 reads가 바뀜 → 숫자 감소
```

**알림 (FR-02~FR-04)**
```
poll events(message.created) + unread.channels[meta]
  → shouldNotify(event, { me, meta, viewing, visible }) → 'sound+toast' | 'badge' | null
  → 비프(설정 on) · 토스트(클릭 → openTarget(messageId)) · 시스템 알림(secure && granted && hidden)
unread.total(음소거 반영) → 탭 제목 (N) + 파비콘 배지
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| `reactions`/`pins`/`me` 라우트 | `chat-server.ts` (`loadChannelAccess`, `messageDto`, `eventStatement`), `erp-platform.ts` | 접근·DTO·이벤트·감사 |
| `poll` 라우트 | `chat-presence.ts`, `chat-server.ts` | 스냅샷 |
| `useChatNotifier` (`chat-notify.ts`) | `useChatPoll`(`chat-client.ts`) | 이벤트 구독 |
| `chat-message.tsx` | `chat-client.ts` (`CHAT_REACTIONS`, `unreadCountFor`) | 표시 |
| `chat-panels.tsx` | `chatRequest`, `openTarget` 콜백 | 목록·이동 |

---

## 3. Data Model

### 3.1 Entity Definition

```typescript
// DTO 확장 (chat-server.ts). 모두 "추가" 필드다.
interface ChatReactionDto { emoji: ChatReaction; accountIds: string[] }        // 누른 순서
interface ChatMessageDto { /* 기존 필드 … */ reactions: ChatReactionDto[]; pinnedAt: number | null }
interface ChatChannelDto { /* 기존 … */ notifyLevel: ChatNotifyLevel; pinCount: number }
type ChatNotifyLevel = "all" | "mentions" | "mute";
type ChatReaction = "👍" | "✅" | "👀" | "🙏" | "😂" | "🎉" | "❤️" | "😮";

interface UnreadSummary {
  total: number;          // 알림 수준 반영 합계(§3.4)
  mentions: number;
  threads: number;        // NEW: 참여 스레드 새 답글(나를 멘션한 답글은 mentions 쪽에서 센다)
  channels: Array<{
    channelId: string; unread: number; mentions: number; lastMessageId: number;
    kind: ChatChannelKind; name: string; notifyLevel: ChatNotifyLevel;   // NEW(DD10)
  }>;
}

interface ChatReadsSnapshot { channelId: string; members: Array<{ accountId: string; lastReadMessageId: number; joinedAt: number }> }
type ChatPresence = Record<string, number>;   // accountId → lastSeen(ms)

interface ChatActivityItem {
  kind: "mention" | "channel_mention" | "thread_reply";
  message: ChatMessageDto;                      // 이동 대상
  channel: { id: string; kind: ChatChannelKind; name: string };
  unread: boolean;
}
```

### 3.2 Entity Relationships

```
chat_channels 1 ── N chat_messages 1 ── N chat_reactions (message_id, account_id, emoji)
      │                    │
      │                    ├── 0..1 chat_pins (channel_id, message_id)
      │                    └── N chat_bookmarks (account_id, message_id)
      ├── N chat_members ── 1 chat_member_prefs (channel_id, account_id)
      └── (thread root) 1 ── N chat_thread_reads (account_id, thread_root_id)
```

FOREIGN KEY는 선언하지 않는다(R5 관례). 메시지·채널은 지우지 않으므로 고아 행이 생기지 않는다. 삭제된 메시지의 반응·고정·북마크 행은 남기고, 조회 시 `deleted_at IS NULL`로 거른다.

### 3.3 Database Schema (`app/chat-schema.ts`의 `CHAT_DDL` 끝에 추가)

```sql
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, account_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions(message_id, created_at);

CREATE TABLE IF NOT EXISTS chat_pins (
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_pins_message ON chat_pins(message_id);

CREATE TABLE IF NOT EXISTS chat_bookmarks (
  account_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_bookmarks_account ON chat_bookmarks(account_id, created_at);

CREATE TABLE IF NOT EXISTS chat_member_prefs (
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  notify_level TEXT NOT NULL DEFAULT 'all' CHECK (notify_level IN ('all','mentions','mute')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, account_id)
);

CREATE TABLE IF NOT EXISTS chat_thread_reads (
  account_id TEXT NOT NULL,
  thread_root_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  last_read_reply_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_root_id)
);
```

행이 없으면 기본값이다: 알림 수준은 `all`, 스레드 읽음은 0이다. 하지만 스레드 읽음이 0이면 참여 전 답글까지 전부 새 답글로 잡힌다. 이를 막기 위해 **답글을 쓸 때** 그 스레드의 읽음을 자기 답글 id로 UPSERT한다. 루트 작성자는 **첫 답글이 달릴 때** 0으로 INSERT OR IGNORE한다. 그래서 루트 작성자에게는 첫 답글부터 새 답글이다. 이 두 문장은 messages POST batch 안에 넣는다(`threadParticipationStatements`). 참여 판정은 "이 테이블에 행이 있다"가 된다.

> v0.2 변경(M1 구현): 원안은 "루트를 쓸 때 0으로 UPSERT"였다. 그렇게 하면 최상위 글마다 행이 생긴다. 답글이 없는 루트에는 참여할 스레드가 없으므로, 행을 첫 답글 때 만들도록 바꿨다. 결과(루트 작성자는 첫 답글부터 새 답글로 받는다)는 같다.

> ⚠️ 배포 전 기존 참여 이력 백필: R5 운영 중에 이미 쓴 루트·답글에 대해 `INSERT OR IGNORE INTO chat_thread_reads … SELECT author, COALESCE(thread_root_id, id), channel_id, MAX(id)… GROUP BY` 한 문장을 `CHAT_DDL` 뒤에 둔다(멱등). 그래야 옛 스레드도 "참여"로 잡히고, 옛 답글이 새 답글로 폭증하지 않는다.

### 3.4 Unread 합계 규칙 (FR-04)

| notify_level | 채널 배지(목록) | `total`(탭 제목, 파비콘, 셸 탭 배지)에 넣는 값 | 알림(소리, 토스트) |
|---|---|---|---|
| `all` | unread (굵게) | unread | 새 최상위 글 전부, 나를 멘션한 답글 |
| `mentions` | unread (보통 굵기) | mentions(직접 + `@channel`) | 멘션만 |
| `mute` | unread (흐리게) | 직접 멘션 수만 | 직접 멘션만(`@channel` 제외) |

`total`에는 `threads`를 더한다. 직접 멘션 수는 `unreadSummary`의 서브쿼리 하나(`EXISTS chat_mentions … = me`)를 따로 센다. 메시지 id 기준 읽음 규칙(`id > last_read_message_id`)은 R5와 같다.

---

## 4. API Specification

### 4.1 Endpoint List

| Method | Path | Description | Auth | Audit |
|--------|------|-------------|------|-------|
| GET | `/api/chat/poll?since&summary&watch&active` | **변경**: `active` 추가, 응답에 `reads`와 `presence` 추가 | chat:read | – |
| GET | `/api/chat/messages?channelId&around` | **신규 파라미터**: 이동(FR-01) | chat:read | – |
| GET | `/api/chat/messages?channelId&after` | **신규 파라미터**: 아래로 이어 읽기 | chat:read | – |
| GET | `/api/chat/messages?q&channelId?&authorId?&from?&to?&hasFile?` | **변경**: 검색 필터(FR-13) | chat:read | – |
| GET | `/api/chat/attachments?channelId&before?` | **신규 분기**: 파일 목록(FR-12) | chat:read | – |
| POST | `/api/chat/reactions` | 반응 토글(FR-07) | chat:write | ✅ |
| GET | `/api/chat/pins?channelId` | 고정 목록(FR-10) | chat:read | – |
| POST | `/api/chat/pins` | 고정·해제(FR-10) | chat:write + 소유자/관리자 | ✅ |
| GET | `/api/chat/me?view=bookmarks\|activity` | 저장됨·활동함(FR-05·FR-11) | chat:read | – |
| PUT | `/api/chat/me` | `BOOKMARK`, `UNBOOKMARK`, `SET_NOTIFY`, `THREAD_READ` | chat:read(개인 상태) ※ | 예외(DD14) |

※ `me` PUT의 권한: `BOOKMARK`·`SET_NOTIFY`·`THREAD_READ`는 보기 권한자(chat=view)도 쓸 수 있는 **개인 상태**다. read-state PUT이 `chat:read`인 것과 같은 논리다. 남에게 보이는 쓰기(반응, 고정)는 `chat:write`다.

### 4.2 Detailed Specification

#### `GET /api/chat/poll` (변경)

- `active=<channelId>`(80자 이하): 현재 멤버인 채널일 때만 `reads`를 싣는다. 멤버가 아니거나 없는 채널이면 `reads: null`로 준다(오류 아님, 존재를 숨김).
- `touch(accountId, now)`: 모든 poll에서 메모리 맵만 갱신한다.
- `presence`: 매 응답에 싣는다. `chatPeople` 대상 가운데 맵에 있는 사람만 넣는다(6명 규모라 작다). `summary=1`이면 맵에 없는 사람을 `auth_sessions` `MAX(last_seen_at)`(활성 세션)로 채운다. 이 조회는 summary 경로에서만 일어난다.
- 쿼리 수: 게이트(0) → 세션(1) → 이벤트(1) → **reads(1, `active`가 있을 때만)** → [이벤트나 summary가 있을 때] unreadSummary. 쓰기는 없다(세션 `last_seen_at` 시간당 1회 갱신은 R5부터 있던 예외다).

```json
{ "cursor": 912, "hasMore": false, "events": [],
  "unread": null,
  "reads": { "channelId": "ch_…", "members": [{ "accountId": "acct_a", "lastReadMessageId": 910, "joinedAt": 1727… }] },
  "presence": { "acct_a": 1727…, "acct_b": 1727… } }
```

#### `GET /api/chat/messages?channelId&around=<id>`

- `loadChannelAccess` 404 → 대상이 그 채널의 메시지인지 확인한다(아니면 404).
- 대상이 답글이면 루트 id로 바꾸고 `focusReplyId`를 함께 준다.
- 결과: `{ messages: [...25 before, target, ...25 after], hasMore, hasNewer, focusId, focusReplyId? }`
- 대상이 삭제된 메시지여도 자리는 준다(`deleted: true`). 클라이언트는 "삭제된 메시지입니다" 줄을 강조한다.

#### `GET /api/chat/messages?channelId&after=<id>`

- `m.id > after`, 최상위, ASC, `CHAT_PAGE_SIZE + 1` → `{ messages, hasNewer }`

#### `GET /api/chat/messages?q=…` (검색 필터)

| 파라미터 | 규칙 |
|---|---|
| `q` | 2~80자. **필터가 하나 이상 있으면 생략할 수 있다**(없으면 기존 400). |
| `channelId` | 검색 범위 안의 채널이어야 한다. 아니면 결과가 비어 있다(404가 아니라 빈 결과로 존재를 숨긴다). |
| `authorId` | 계정 id, 80자 이하 |
| `from`, `to` | `YYYY-MM-DD`(KST 자정 기준 ms로 변환), `from ≤ to`, 범위는 최대 366일 |
| `hasFile` | `1`이면 첨부가 있는 메시지만 |
| 파일명 | `q`가 있으면 `body LIKE` **또는** `EXISTS(chat_attachments file_name LIKE, deleted_at IS NULL)` |

범위(내가 멤버인 대화 + public)와 한도(50)는 R5와 같다. 응답 모양도 같다(`results[{message, channel}]`).

#### `GET /api/chat/attachments?channelId=<id>&before=<attachmentCreatedAt>?`

- `id` 파라미터가 있으면 기존의 파일 내려받기다. `channelId`만 있으면 목록이다. 둘 다 있거나 둘 다 없으면 400이다.
- 조건: `loadChannelAccess`(public 비멤버도 볼 수 있다. 메시지를 볼 수 있으므로). `message_id IS NOT NULL`, 첨부와 메시지 모두 `deleted_at IS NULL`.
- 응답: `{ files: [{ attachment: ChatAttachmentDto, messageId, threadRootId, uploaderName, createdAt }], hasMore }`, 50개씩.

#### `POST /api/chat/reactions`

**Request**: `{ "messageId": 123, "emoji": "👍" }`
**처리**: 메시지 → `loadChannelAccess`(404) → 보관이면 409 `CHANNEL_ARCHIVED` → 삭제된 메시지면 409 `CONFLICT` → public 비멤버면 403(`채널에 참여한 뒤 반응할 수 있습니다.`) → 이미 누른 반응이면 DELETE, 아니면 INSERT → `message.edited` 이벤트 → 감사
**Response 200**: `{ "message": ChatMessageDto, "added": true }`
**Errors**: 400 `VALIDATION`(emoji가 목록 밖, messageId 형식), 403, 404, 409

감사: `action: CHAT_REACTION_ADDED | CHAT_REACTION_REMOVED`, `entityType: CHAT_MESSAGE`, `after: { messageId, channelId, emoji }`

#### `GET /api/chat/pins?channelId` / `POST /api/chat/pins`

- GET: `loadChannelAccess` → `{ pins: [{ message: ChatMessageDto, pinnedBy: {accountId,name}, pinnedAt }] }`, 최신순, 삭제된 메시지 제외
- POST `{ "action": "PIN" | "UNPIN", "messageId": 123 }`
  - 채널 kind가 public·private가 아니면 400(`대화방에서는 고정할 수 없습니다.`, MD5)
  - 권한: `myRole === "owner" || isAdmin`. 아니면 403. 관리자라도 비공개 채널의 비멤버면 404(R5 원칙)
  - 최상위 메시지만 가능하다(답글이면 400). 삭제된 메시지면 409. 보관된 채널이면 409.
  - PIN은 `COUNT(*) < 10`일 때만 된다. 넘으면 409 `PIN_LIMIT`(`고정은 채널당 10개까지입니다.`)
  - batch: INSERT OR IGNORE / DELETE + `message.edited` + `channel.updated`
  - 감사: `CHAT_MESSAGE_PINNED | CHAT_MESSAGE_UNPINNED`

#### `GET /api/chat/me?view=bookmarks|activity`

- `bookmarks`: `{ bookmarks: [{ message, channel, savedAt }] }`. 지금 접근할 수 있는 대화만 보인다(내가 멤버인 대화 + public). 접근을 잃은 행은 남기되 숨긴다(FR-11). 최신 100개.
- `activity`: 최근 30일, 최신 100개.
  - (a) `chat_mentions.account_id = me` 또는 `mention_channel = 1`(내가 현재 멤버인 채널)인 메시지. 작성자가 나인 글은 뺀다.
  - (b) `chat_thread_reads`에 행이 있는 스레드의 답글 중 작성자 ≠ 나.
  - `unread` 판정: (a)는 `id > chat_members.last_read_message_id`, 단 답글이면 스레드 읽음 기준. (b)는 `id > last_read_reply_id`.
  - 응답: `{ items: ChatActivityItem[] }`

#### `PUT /api/chat/me`

| action | body | 동작 |
|---|---|---|
| `BOOKMARK` / `UNBOOKMARK` | `{ messageId }` | 접근 확인 뒤 INSERT OR IGNORE / DELETE. 삭제된 메시지는 BOOKMARK만 409 |
| `SET_NOTIFY` | `{ channelId, level }` | 현재 멤버일 때만 UPSERT. level이 목록 밖이면 400 |
| `THREAD_READ` | `{ threadRootId, lastReadReplyId }` | 접근 확인, `MAX()`로만 전진, 행이 없으면 만든다(= 스레드를 열어 본 사람도 참여자가 된다) |

응답: `{ ok: true, unread: UnreadSummary }`(`THREAD_READ`, `SET_NOTIFY`는 배지를 곧바로 갱신하려고 요약을 함께 준다) 또는 `{ ok: true }`.

---

## 5. UI/UX Design

### 5.1 Screen Layout

```
┌ 셸 상단 탭: 인사 | 급여 | 메신저 (3) | …          [토스트 ▸ 이두리 · #경영지원 "내일 마감…"] ┐
├───────────────┬───────────────────────────────────────────────┬──────────────────┤
│ [검색 ▾필터]   │ # 경영지원   📌 2  📎 파일  🔔 전체 ▾  멤버 4명   │ 스레드 / 패널     │
│ ◎ 활동    3   │───────────────────────────────────────────────│ (고정·파일·저장됨· │
│ ☆ 저장됨      │  이두리 ●                            09:12     │  활동함 중 하나)   │
│ 채널          │  ┌ 내일까지 급여대장 올려주세요 ─────┐            │                  │
│  # 일반    2  │  └────────────────────────────────┘ 2          │                  │
│  # 경영지원 @1 │  👍 3  ✅ 1  [☺+]         답글 2개 · ☆ 저장      │                  │
│  🔕 # 잡담     │                              ┌ 네 확인 ─┐ 09:13 │                  │
│ 대화          │                              └─────────┘ 1     │                  │
│  ● 김하나      │───────────────────────────────────────────────│                  │
│  ○ 박세나 5분  │ [ 최신 메시지로 ↓ ]  (hasNewer일 때)              │                  │
│               │ ┌ 메시지 쓰기 (@이름으로 멘션) ───────────────┐  │                  │
└───────────────┴───────────────────────────────────────────────┴──────────────────┘
```

- 읽음 숫자 `2`, `1`은 말풍선 바깥쪽 아래(내 글은 왼쪽, 남의 글은 오른쪽)에 작은 강조색 숫자로 둔다(카톡 위치).
- 접속 점: ●(온라인, 초록) / ○(오프라인) + "5분" 같은 짧은 표기. 제목(title)에는 "5분 전 활동"을 넣는다.

### 5.2 User Flow

```
다른 탭에서 작업 중 → DM 도착 → (15초 안에) 비프 + 토스트 + 파비콘 빨간 점
  → 토스트 클릭 → 메신저 탭으로 전환 → openTarget(messageId) → around 로드 → 강조 2초
채널 → 🔔 메뉴 → "음소거" → 목록에 🔕, 흐리게 표시, 배지 합계에서 빠짐
메시지 hover → ☺+ → 8개 중 👍 → 즉시 반영(내 응답 DTO) → 상대 2초 안에 반영
📌 2 → 고정 패널 → 항목 클릭 → openTarget
◎ 활동 → 멘션·스레드 답글 목록 → 클릭 → openTarget(답글이면 스레드 패널까지)
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `useChatNotifier` | `app/chat-notify.ts` (NEW) | poll 구독 → `shouldNotify` → 비프·토스트 큐·시스템 알림. 파비콘 배지. 설정(알림음 on/off, 시스템 알림)은 `readScoped`/`writeScoped` |
| `shouldNotify`, `faviconBadge`, `beep` | `app/chat-notify.ts` | 순수 판정·부수효과 분리 |
| `ChatToasts` | `app/chat-notify.ts`(TSX를 쓰면 `chat-toasts.tsx`) | 셸 우상단 토스트 스택(최대 3개, 6초, `role="status"`) |
| `MessageItem` (이동) | `app/chat-message.tsx` (NEW) | 기존 MessageItem + 반응 바 + 읽음 숫자 + 저장 버튼 + 고정 표시 + 강조(focus) |
| `ReactionBar`, `ReactionPicker` | `app/chat-message.tsx` | 8개 고정 목록, 키보드 조작 |
| `PinsPanel`, `FilesPanel`, `SavedPanel`, `ActivityPanel` | `app/chat-panels.tsx` (NEW) | 오른쪽 패널(스레드 자리를 공유), 항목 클릭 → `onOpen(target)` |
| `SearchFilters` | `app/chat-panels.tsx` | 검색창 옆 ▾: 대화, 보낸 사람, 기간, 첨부만 |
| `PresenceDot`, `presenceLabel` | `app/chat-message.tsx` | 점 + 짧은 표기 |
| `unreadCountFor`, `CHAT_REACTIONS`, `ChatNotifyLevel` | `app/chat-client.ts` (수정) | 공용 순수 함수와 상수 |
| `ChatWorkspace` | `app/chat-workspace.tsx` (수정) | `openTarget`, `hasNewer`, 패널 전환, 🔔 메뉴, 활동/저장됨 항목, reads·presence 전달 |

### 5.4 Page UI Checklist

#### 셸 (모든 탭)

- [ ] 토스트: 보낸 사람 이름, 대화 이름(DM이면 "1:1 대화"), 본문 미리보기 80자(첨부만 있으면 "📎 파일"), 클릭하면 메신저 탭 + 해당 메시지, × 닫기
- [ ] 알림음: 알림 대상에서만 울리고, 설정이 꺼져 있으면 울리지 않는다
- [ ] 파비콘: `unread.total > 0`이면 빨간 원 + 숫자(99+)
- [ ] 탭 제목 `(N)`: 음소거가 반영된 total

#### 메신저 사이드바

- [ ] 항목: "◎ 활동" + 안 읽음 배지(`mentions + threads`)
- [ ] 항목: "☆ 저장됨"
- [ ] 채널 행: 음소거면 🔕 아이콘 + 흐림(`.muted`), 멘션만이면 보통 굵기
- [ ] DM 행: 상대 접속 점(그룹 DM은 온라인 인원 수 `●2`)
- [ ] 검색: ▾ 필터 버튼 → 대화 select, 보낸 사람 select, 시작일·종료일 date, "첨부 있는 것만" checkbox, 초기화

#### 대화 머리

- [ ] `📌 N` 버튼(public·private에서만, N=0이면 `📌`만)
- [ ] `📎 파일` 버튼
- [ ] `🔔` 알림 수준 메뉴: 전체 / 멘션만 / 음소거 (현재 값에 체크)
- [ ] DM 머리: 상대 이름 옆 접속 점과 "N분 전 활동"

#### 메시지

- [ ] 반응 바: 반응마다 `이모지 개수` 칩. 내가 누른 칩은 `.mine` 강조. hover/focus 시 title에 이름 목록
- [ ] 반응 추가 버튼 `☺+`: 누르면 8개 팝오버, Esc로 닫힘, 화살표 키 이동
- [ ] 읽음 숫자: 최상위 메시지만, 0이면 숨김, 공개 채널 비멤버에게는 숨김
- [ ] 저장 버튼 `☆ 저장` / `★ 저장됨`
- [ ] 고정 표시: `📌 고정됨`(소유자·관리자에게는 "고정 해제" 링크, 그 외에는 표시만)
- [ ] 소유자·관리자 메뉴: "고정" 링크
- [ ] 강조: `openTarget` 대상에 `.focus` 2초
- [ ] "최신 메시지로 ↓" 버튼(`hasNewer`)

#### 패널 (오른쪽)

- [ ] 고정: 작성자, 시각, 본문 3줄, "고정: 이름 · 시각", 클릭하면 이동
- [ ] 파일: 이미지 썸네일 격자 + 파일 목록(이름, 크기, 올린 사람, 날짜), "메시지 보기", "더 보기"
- [ ] 저장됨: 대화 이름, 작성자, 본문, 저장 해제 ×
- [ ] 활동: 종류 아이콘(@ / 💬), 대화 이름, 작성자, 본문, 안 읽음 점, "모두 확인"은 범위 밖

#### 설정 (메신저 사이드바 하단 ⚙)

- [ ] 알림음 켜기/끄기
- [ ] 시스템 알림: `isSecureContext`면 "켜기"(권한 요청), 아니면 안내 문구 "이 PC에서는 앱 안 알림만 사용할 수 있습니다"

---

## 6. Error Handling

### 6.1 Error Code Definition

기존 `erpError` 형식(`{ error, code, field? }`)과 헬퍼를 재사용한다.

| Status | code | Message | 사용처 |
|---|---|---|---|
| 400 | `VALIDATION` | "반응을 확인해 주세요." / "알림 설정을 확인해 주세요." / "기간을 확인해 주세요." / "대화방에서는 고정할 수 없습니다." / "답글은 고정할 수 없습니다." | reactions, me, messages, pins |
| 403 | `FORBIDDEN` | "채널을 만든 사람이나 관리자만 고정할 수 있습니다." / "채널에 참여한 뒤 반응할 수 있습니다." | pins, reactions |
| 404 | `NOT_FOUND` | "대화를 찾을 수 없습니다." (`chatNotFound`) | 전부 |
| 409 | `CHANNEL_ARCHIVED` | 기존 문구 | reactions, pins |
| 409 | `CONFLICT` | 기존 문구(삭제된 메시지) | reactions, pins, BOOKMARK |
| 409 | `PIN_LIMIT` | "고정은 채널당 10개까지입니다." | pins |

클라이언트 처리: 실패하면 기존 `flash()`로 문구를 보여 준다. 반응은 낙관적 갱신을 하지 않는다(응답 DTO로 교체. LAN이라 지연이 작다). 이동 대상이 404면 "메시지를 찾을 수 없습니다."를 띄운다.

---

## 7. Security Considerations

- [ ] 새 라우트는 모두 **본문을 읽기 전에** `authorizeErpRequest(db, "chat", …)`를 호출한다(문자열 리터럴 module, CLAUDE.md).
- [ ] 메시지 id를 받는 모든 경로(reactions, pins, me BOOKMARK·THREAD_READ, messages around)는 메시지 → `loadChannelAccess` 순서로 확인한다. 없는 id와 비멤버를 같은 404로 답한다.
- [ ] 검색 필터 `channelId`가 범위 밖이면 404가 아니라 **빈 결과**로 답해, 존재 여부를 흘리지 않는다.
- [ ] `reads`는 현재 멤버에게만 준다. `presence`는 chat 권한자 목록(`chatPeople`) 범위로만 준다(이메일은 싣지 않는다).
- [ ] 읽음 명단은 어디에도 내리지 않는다(MD3). `reads`에는 accountId별 위치가 있어 클라이언트가 계산할 수는 있다. 하지만 멤버끼리는 이미 서로를 알고 규모가 6명이라 수용한다. UI는 숫자만 보여 준다. ⚠️ 이 점은 Report에 명시한다.
- [ ] 토스트와 패널의 본문은 React 텍스트 노드로만 그린다(R5 §7.8). 파비콘 canvas에는 숫자만 그린다.
- [ ] `emoji`는 서버의 허용 목록과 **정확히 일치**하는 것만 받는다(유니코드 변형 선택자 포함한 문자열 비교).
- [ ] LIKE 검색은 기존 `escapeLike`를 쓴다. 날짜는 정규식 `^\d{4}-\d{2}-\d{2}$`로 검증한 뒤 변환한다.
- [ ] 감사 예외는 `read-state`와 `me` 두 파일뿐이다. 가드 테스트로 고정한다(DD14).

---

## 8. Test Plan

기존 방식을 따른다: `node --test` + `tests/helpers/hr-api-harness.mjs`(실제 라우트 코드를 메모리 SQLite에서 실행). 새 파일 `tests/chat-enhancement.test.mjs`를 만들고 `package.json`의 `test` 목록에 추가한다. Playwright는 이 저장소에 없으므로 L2·L3는 수동 체크리스트와 Chrome MCP로 확인한다.

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| L0: 순수 함수 | `shouldNotify`, `unreadCountFor`, `presenceLabel`, `CHAT_REACTIONS` 동기화 | node --test | Do |
| L1: API | 새/변경 라우트 전부 | harness | Do |
| L1': 소스 가드 | 감사 예외 목록, poll 쓰기 0, DDL 위치 | node --test (regex) | Do |
| L2/L3: UI·E2E | §5.4 체크리스트, SC-1~SC-7 | Chrome MCP(두 계정, 두 창) | Check/QA |

### 8.2 L1: API Test Scenarios

| # | Endpoint | Test | Expected |
|---|----------|------|----------|
| 1 | POST reactions | 멤버가 👍 → 다시 👍 | 200 added:true → 200 added:false. DTO `reactions` 변화, `message.edited` 이벤트 2건, 감사 2건, `edited_at` 그대로 |
| 2 | POST reactions | 목록 밖 emoji "🔥" | 400 VALIDATION |
| 3 | POST reactions | 비공개 채널 비멤버(관리자 포함) | 404 |
| 4 | POST reactions | 보관 채널 / 삭제된 메시지 / chat=view | 409 / 409 / 403 |
| 5 | poll | B가 반응한 뒤 A의 poll | `message.edited` + DTO reactions 포함 |
| 6 | poll `active` | 멤버 채널 / 비멤버 비공개 채널 | `reads.members` 3명 / `reads: null` |
| 7 | poll | 반복 poll 10회 | D1 쓰기 문장 0(harness의 prepare 기록으로 확인), presence에 본인 포함 |
| 8 | read-state → poll | B가 읽음 PUT 뒤 A poll | A의 `reads`에서 B의 lastRead 증가 |
| 9 | POST pins | 일반 멤버 PIN | 403 |
| 10 | POST pins | 소유자 PIN → GET pins | 200, 목록 1, `pinCount` 1, `channel.updated` 이벤트, 감사 |
| 11 | POST pins | 11번째 PIN / DM에서 PIN / 답글 PIN | 409 PIN_LIMIT / 400 / 400 |
| 12 | POST pins | 관리자·비공개 비멤버 | 404 |
| 13 | PUT me SET_NOTIFY | mute → unread.total | 음소거 채널 일반 글이 total에서 빠지고, 직접 멘션 글은 들어감 |
| 14 | PUT me SET_NOTIFY | level "loud" / 비멤버 채널 | 400 / 404 |
| 15 | PUT me BOOKMARK → GET bookmarks | 저장 → 목록 → 비공개 채널에서 내보내진 뒤 목록 | 1건 → 0건(행은 남음) |
| 16 | GET me activity | A가 B를 멘션, B가 참여한 스레드에 C가 답글 | B의 items: mention 1, thread_reply 1, unread:true |
| 17 | PUT me THREAD_READ | 전진 → 뒤로 | MAX로만 전진, `threads` 감소 |
| 18 | messages POST | 답글 작성 | `chat_thread_reads`에 (작성자, 루트) 행 생성, last_read_reply_id = 새 답글 id |
| 19 | GET messages around | 120개 중 id 30 | 앞 25개 + 30 + 뒤 25개, hasMore:true, hasNewer:true, focusId 30 |
| 20 | GET messages around | 답글 id | 루트 기준 창 + focusReplyId |
| 21 | GET messages around | 다른 채널의 id / 비멤버 | 404 / 404 |
| 22 | GET messages after | after=last-10 | 10개, hasNewer:false |
| 23 | GET messages q+filters | authorId, hasFile, from/to, 파일명 일치, q 없이 필터만 | 각 필터가 결과를 좁힘. 필터 없이 q도 없으면 400 |
| 24 | GET messages q channelId | 범위 밖 비공개 채널 id | 200, results [] |
| 25 | GET attachments channelId | 멤버 / 비공개 비멤버 / 삭제 메시지 첨부 | 목록 / 404 / 제외 |
| 26 | DDL | `ensureErpPlatformSchema` 두 번 + R5 데이터 백필 | 오류 없음, 백필 행 수 = 참여 (작성자, 스레드) 쌍 수 |

### 8.3 L0 / 가드

| # | 대상 | 검증 |
|---|------|------|
| G1 | `tests/erp-platform.test.mjs` | 예외 목록이 정확히 `chat/read-state`, `chat/me`. `reactions`, `pins`에는 `writeErpAudit`가 있다 |
| G2 | poll 소스 | `.run(`, `INSERT`, `UPDATE`가 없다(`touch`는 메모리) |
| G3 | `CHAT_REACTIONS` | 서버와 클라이언트 배열이 같다 |
| G4 | `shouldNotify` | 표 §3.4의 모든 칸 + 내 글 제외 + 보고 있는 채널·보이는 상태면 소리·토스트 없음 + `message.edited` 무시 |
| G5 | `unreadCountFor` | 작성자 제외, joinedAt 이후 멤버 제외, 답글은 null |
| G6 | `presenceLabel` | 45초 경계, 분·시간·날짜 표기 |
| G7 | 스키마 위치 | 새 테이블 DDL은 `chat-schema.ts`에만 있고, 라우트 `ensureSchema`에는 없다 |

### 8.4 L3: E2E Scenario (수동 / Chrome MCP)

| # | Scenario | Success Criteria |
|---|----------|-----------------|
| 1 | SC-1: B 창은 HR 탭, A가 DM 전송 | 15초 안에 B에서 비프, 토스트, 파비콘. 클릭하면 강조 |
| 2 | SC-2: 음소거 채널 일반 글 / 직접 멘션 | 알림 없음 / 알림 있음 |
| 3 | SC-4·SC-5: 두 창에서 반응, 읽음 | 2초 안에 반영, 숫자 감소 |
| 4 | SC-6: B 창 닫기 | 약 1분 뒤 A 화면에서 "N분 전" |
| 5 | SC-3: 활동함 → 스레드 답글 클릭 | 스레드 패널 열림, 답글 강조 |

### 8.5 Seed Data

| Entity | Count | 비고 |
|--------|:-----:|------|
| 계정 | 3~4 | `person('김하나')` 등 기존 헬퍼 |
| 채널 | public 1, private 1, DM 1 | |
| 메시지 | 120 (around 테스트) | 루프로 POST |
| 첨부 | 2 (이미지, pdf) | 기존 가짜 R2 |

---

## 9. Clean Architecture (이 저장소의 레이어 대응)

| Layer | Responsibility | Location |
|-------|---------------|----------|
| Presentation | 셸·워크스페이스·패널·메시지 | `app/page.tsx`, `app/chat-workspace.tsx`, `app/chat-message.tsx`, `app/chat-panels.tsx` |
| Application | 알림 디스패치, poll 훅, 요청 헬퍼 | `app/chat-notify.ts`, `app/chat-client.ts` |
| Domain | 순수 판정·상수·DTO 타입 | `app/chat-client.ts`의 순수 함수, `app/chat-server.ts`의 타입 |
| Infrastructure | 라우트·SQL·스키마·메모리 presence | `app/api/chat/*`, `app/chat-server.ts`, `app/chat-schema.ts`, `app/chat-presence.ts` |

규칙: 클라이언트 파일은 서버 모듈을 **타입으로만** import한다(R5 규칙). 서버 코드는 확장자 없는 상대 경로로만 import한다.

---

## 10. Coding Convention Reference

| Item | Convention Applied |
|------|-------------------|
| 파일 이름 | `app/chat-<feature>.ts(x)`, kebab-case (기존 `chat-mentions.ts` 등과 같다) |
| 컴포넌트 | PascalCase, 파일 안에 여러 개 허용(기존 스타일) |
| 상수 | `CHAT_*` UPPER_SNAKE (`CHAT_REACTIONS`, `CHAT_PIN_LIMIT = 10`, `CHAT_AROUND_SIDE = 25`, `CHAT_PRESENCE_ONLINE_MS = 45_000`) |
| 상태 관리 | `useState` + ref + poll 구독(기존) |
| 오류 | `chatNotFound`, `chatValidation`, `chatForbidden`, `chatConflict`, `chatArchived` 재사용. 새 헬퍼는 `chatPinLimit()` |
| 문구 | 한국어, 존댓말 안내형 |
| 주석 | 파일 머리에 `// messenger-enhancement Design Ref: §4.2 …`, 핵심 분기에 `// ME-FR-08`, `// ME-DD7` |
| 로컬 저장 | `readScoped`/`writeScoped`(`client-runtime.ts`) 키: `xdnode-chat-sound`, `xdnode-chat-system-notify` |

---

## 11. Implementation Guide

### 11.1 File Structure

```
app/
├── chat-schema.ts            (수정) 새 테이블 5개 + 스레드 참여 백필
├── chat-server.ts            (수정) DTO 확장, unreadSummary 확장, CHAT_REACTIONS, 상수, 헬퍼
├── chat-presence.ts          (NEW)  메모리 맵 touch/snapshot/reset(하니스용)
├── chat-client.ts            (수정) poll active/reads/presence, CHAT_REACTIONS, unreadCountFor, presenceLabel
├── chat-notify.ts            (NEW)  shouldNotify, beep, faviconBadge, useChatNotifier
├── chat-toasts.tsx           (NEW)  셸 토스트 스택
├── chat-message.tsx          (NEW)  MessageItem(이동), ReactionBar/Picker, PresenceDot
├── chat-panels.tsx           (NEW)  Pins/Files/Saved/Activity 패널, SearchFilters
├── chat-workspace.tsx        (수정) openTarget, hasNewer, 패널, 🔔 메뉴, 사이드바 항목
├── chat-workspace.css        (수정) 반응, 읽음 숫자, 점, 패널, 토스트, 강조
├── page.tsx                  (수정) useChatNotifier + <ChatToasts/> 마운트, openTarget 전달
└── api/chat/
    ├── poll/route.ts         (수정) active → reads, touch, presence
    ├── messages/route.ts     (수정) around, after, 검색 필터, POST에 thread_reads UPSERT
    ├── attachments/route.ts  (수정) GET channelId 목록 분기
    ├── reactions/route.ts    (NEW)
    ├── pins/route.ts         (NEW)
    └── me/route.ts           (NEW)
tests/
├── chat-enhancement.test.mjs (NEW)  §8.2·§8.3
├── erp-platform.test.mjs     (수정) 감사 예외 목록
└── helpers/hr-api-harness.mjs (수정 가능) presence 리셋 훅
package.json                  (수정) test 목록에 chat-enhancement 추가
```

새 파일은 8개다(라우트 3, 서버 1, 클라이언트 4). 테스트 파일은 따로 센다. 수정 파일은 약 10개다.

### 11.2 Implementation Order

1. [ ] **M1** 스키마·DTO·이동: `chat-schema.ts` → `chat-server.ts`(DTO `reactions: []`·`pinnedAt`, 상수) → messages `around`/`after` + POST thread_reads → `chat-message.tsx`로 MessageItem 이동(동작 동일) → 워크스페이스 `openTarget`/`hasNewer` → 테스트 #18~22, #26, G7
2. [ ] **M2** 알림·활동함: `chat_member_prefs` + `unreadSummary` 확장(§3.4, `threads`, 메타) → `me` 라우트(SET_NOTIFY, THREAD_READ, activity) → `chat-notify.ts` + `chat-toasts.tsx` + `page.tsx` → 🔔 메뉴, 활동 항목·패널 → 테스트 #13, #14, #16, #17, G1, G4
3. [ ] **M3** 확인 문화: `reactions` 라우트 → ReactionBar/Picker → `chat-presence.ts` + poll `active`/`reads`/`presence` → `unreadCountFor`, 읽음 숫자 UI, PresenceDot → 테스트 #1~8, G2, G3, G5, G6
4. [ ] **M4** 정보 정리: `pins` 라우트 + 패널 → `me` BOOKMARK + 저장됨 패널 → attachments 목록 + 파일 패널 → 검색 필터 → 테스트 #9~12, #15, #23~25
5. [ ] 모듈마다: `npm run lint`, `node --test tests/chat-api.test.mjs tests/chat-enhancement.test.mjs`, 모듈 완료 시 `npm test`

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| 공용 기반 | `M1` | 스키마 5테이블 + 백필, DTO 확장, around/after, thread_reads, MessageItem 분리, openTarget | 30-40 |
| 알림·활동함 | `M2` | prefs·unreadSummary 규칙, me 라우트(notify·thread·activity), 셸 알림(비프·토스트·파비콘·시스템), 🔔·활동 UI | 40-50 |
| 확인 문화 | `M3` | reactions 라우트·UI, presence 메모리, poll reads, 읽음 숫자, 접속 점 | 35-45 |
| 정보 정리 | `M4` | pins 라우트·패널, 북마크, 파일 목록, 검색 필터 | 35-45 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| Session 1 | Plan + Design | 전체 | 완료 |
| Session 2 | Do | `--scope M1` | 30-40 |
| Session 3 | Do | `--scope M2` | 40-50 |
| Session 4 | Do | `--scope M3` | 35-45 |
| Session 5 | Do | `--scope M4` | 35-45 |
| Session 6 | Check + QA + Report | 전체 | 30-40 |

릴리스는 모듈마다 할 수 있다. 운영(`C:\xdm\prod`)에 반영하는 절차는 `docs/lan-operations-runbook.md`의 태그 → 빌드 → 스냅샷 순서를 따른다.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-09-30 | 초안: 설계안 C 선택, DD1~DD16, 스키마 5테이블, API 10개 경로, 테스트 26+7 | gc.kim |
| 0.2 | 2026-09-30 | M1 구현 반영: 루트 작성자의 스레드 참여 행을 첫 답글 때 만든다(§3.3) | gc.kim |
| 0.3 | 2026-09-30 | M2 구현 반영: 활동함은 오른쪽 패널이 아니라 가운데 영역(검색 결과 자리)에 연다(대화를 가로지르는 목록이라서). 고정·파일은 채널 단위라 오른쪽 패널로 둔다. 감사 예외 가드는 `erp-platform`·`tab-permissions` 두 테스트에 있다 | gc.kim |
| 0.4 | 2026-10-01 | M3·M4 구현 반영: (1) 검색의 대화 필터 파라미터는 `channelId` 가 아니라 `in` 이다(`channelId` 는 messages GET 의 선택자라 겹친다). (2) 파일 목록은 public 비멤버에게도 403 이다(내려받기와 같은 조건, §4.2 원안은 비멤버 허용). (3) 파일 목록 커서는 `<createdAt>_<attachmentId>` 다. (4) 반응 고르기 팝오버의 역할은 `toolbar` 다(화살표 키 이동). | gc.kim |
