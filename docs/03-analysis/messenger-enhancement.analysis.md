# messenger-enhancement Gap Analysis (Check)

> **Feature**: messenger-enhancement · **Date**: 2026-10-01 · **Commit analysed**: `7d3114a` · **Act-1 fixes**: this commit
> **Plan**: [messenger-enhancement.plan.md](../01-plan/features/messenger-enhancement.plan.md) · **Design**: [messenger-enhancement.design.md](../02-design/features/messenger-enhancement.design.md) (v0.5)

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 메시지를 놓치고, 확인 여부를 모르고, 예전 내용을 찾기 어렵다. 그래서 카톡으로 되돌아간다(PRD O3). |
| **WHO** | 경영지원실 5~6명. 사내 LAN, HTTP, 여러 PC에서 접속한다. |
| **RISK** | `chat_events` CHECK 제약, poll hot path, HTTP LAN 의 `Notification` 부재 |
| **SUCCESS** | 폴링 1주기 안에 알림·반응·읽음이 반영된다. 비멤버는 비공개 대화를 볼 수 없다. poll 쿼리는 +1 이하, 쓰기는 0이다. |
| **SCOPE** | M1 공용 기반 → M2 알림·활동함 → M3 확인 문화 → M4 정보 정리 |

## 1. Match Rate

| 축 | 결과 | 비고 |
|---|---|---|
| 정적 분석 종합(gap-detector, 7d3114a) | **93%** | 구조·기능·계약을 정적으로 분석한 공식(Structural×0.2 + Functional×0.4 + Contract×0.4)으로 계산 |
| 하니스 테스트 | 502/502 통과 | 메신저 R5 20개 + 이번 기능 31개 포함 |
| 실제 개발 서버 API E2E (workerd + miniflare D1) | 24/24 통과 | 스크립트는 작업 메모장에 있다. SC-2~SC-8 의 데이터 경로를 확인했다 |
| 브라우저 UI(L2) | **미실행** | Chrome 확장이 연결되지 않았다. 토스트·비프·파비콘·팝오버·배치는 화면으로 확인해야 한다 |

Act-1 이후 정적 재분석은 하지 않았다. 아래 항목은 모두 고쳤고, 고친 부분마다 테스트를 더했다.

## 2. Gaps and Resolution (Act-1)

| 심각도 | 항목 | 근거 | 조치 |
|---|---|---|---|
| Critical | 채팅 화면이 effect 를 반복 실행한다. `useChatPoll` 은 렌더마다 새 객체를 돌려주는데 `markRead`·`markThreadRead`·기록 로드 effect 가 `poll` 을 의존성으로 썼다. 그래서 읽음 PUT → `setUnread` → 셸 재렌더 → 기록 재요청이 되풀이되고, 이동한 구간(around)도 풀렸다. R5 패턴이었고 reads·presence 상태가 늘면서 더 자주 터졌다 | `app/chat-workspace.tsx` 훅 의존성 | 고정된 콜백(`setUnread`, `setWatch`, `setViewing`, `consumeOpen`, `subscribe`, `pollNow`)만 의존성으로 쓴다. `useChatNotifier` 도 같다. 같은 요약이면 `setUnread` 가 상태를 바꾸지 않는다. 회귀 가드: 훅 의존성 배열에 `poll` 이 있으면 실패한다 |
| Important | 참여하지 않은 공개 채널(예: `#일반`)에서 받은 @멘션이 토스트·배지·활동함 어디에도 나오지 않는다 | poll·unreadSummary·activity 가 모두 멤버 채널만 본다 | **사용자 결정: 보내기 전에 경고.** 보낸 직후 "OO 님은 이 채널에 없어 알림을 받지 못합니다. 채널에 초대할까요?"를 묻고, 초대하면 `ADD_MEMBERS` 로 참여시킨다 |
| Minor | 나를 멘션한 답글은 스레드를 읽어도 채널 읽음 위치를 넘기 전까지 안 읽음으로 남는다 | `unreadSummary`, `me` activity | 답글이면 `chat_thread_reads.last_read_reply_id` 도 본다 |
| Minor | @ 자동완성에 접속 점이 없다(FR-09) | `Composer` | `presence` 를 넘기고 `PresenceDot` 을 그린다 |
| Minor | DM 머리에 접속 점이 없다(글자만 있다) | 대화 머리 | 상대 이름 옆에 `PresenceDot` 을 둔다 |
| Minor | 일반 poll 의 presence 는 chatPeople 로 거르지 않는다 | `poll/route.ts` | summary poll 때 `prunePresence(chatPeople)` 로 권한을 잃은 계정을 맵에서 뺀다(일반 poll 쿼리 수는 그대로) |
| Minor | 설계 §4.2 의 파일 목록 응답은 `hasMore` 인데 구현은 `nextBefore` 다 | design §4.2 | 설계 문서를 고쳤다(v0.5) |
| Minor | 읽음 숫자가 머리에 있다(설계는 말풍선 아래) | `chat-message.tsx` | 말풍선 바로 아래로 옮겼다. footer 에 두지 않았다. R5 CSS 가 footer 의 두 번째 버튼부터 숨기므로 "답글" 링크가 가려지기 때문이다 |

## 3. Success Criteria

| SC | 상태 | 근거 |
|---|---|---|
| SC-1 다른 PC 에서 DM 이 오면 15초 안에 비프·토스트·파비콘 | ⚠️ 화면 미확인 | 판정 규칙은 테스트 G4(14가지)로 확인. poll 경로는 E2E 로 확인 |
| SC-2 음소거 | ✅ | E2E: 일반 글 합계 0→0, 직접 멘션 0→1 |
| SC-3 활동함 → 이동 | ✅(API) / ⚠️(화면) | E2E: thread_reply·mention, around 의 focusReplyId |
| SC-4 반응이 2초 안에 반영 | ✅(API) | E2E: 상대 poll 에 message.edited 로 도착, editedAt 은 null |
| SC-5 읽음 숫자 | ✅(API) | E2E: reads 스냅샷 0 → 메시지 id |
| SC-6 접속 상태 | ✅(API) | E2E: workerd 모듈 메모리가 요청 사이에 유지된다 |
| SC-7 고정 권한·감사 | ✅ | E2E: 멤버 403, 소유자 200, pinCount 반영, 감사 로그 기록 |
| SC-8 비공개 채널 비멤버 | ✅ | E2E: 경로 7곳 모두 404, 검색은 빈 결과, reads 는 null |
| SC-9 poll 쿼리 +1 이하·쓰기 0 | ✅ | 테스트: poll 5회 동안 D1 쓰기 0 |
| SC-10 사용자 인터뷰 | ⏳ | 운영 반영 1주 뒤 |

## 4. Known Follow-ups

- 브라우저 화면 확인(L2): 토스트·비프·파비콘·반응 팝오버·패널 배치·Critical 수정이 실제로 반복 요청을 멈췄는지(네트워크 탭).
- 초대·참여(JOIN·ADD_MEMBERS)된 사람은 읽음 위치가 0에서 시작한다(R5 동작). 그래서 오래된 `#일반` 에 초대되면 기록 전체가 안 읽음으로 잡힌다. 초대 시점의 마지막 글 id 로 시작하게 바꿀지는 따로 정한다.
- 반응 추가 버튼(☺+)은 마우스를 올려야 보인다(터치 화면에서는 보이지 않을 수 있다).
