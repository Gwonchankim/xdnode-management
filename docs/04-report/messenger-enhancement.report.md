# messenger-enhancement Completion Report

> **Status**: Complete · 운영 반영 완료(`msg1-release-20261001`, 2026-10-01 17:16)
>
> **Project**: XDnode management (`xdnode-management`)
> **Version**: 기준 `750b4db` → 기능 완료 `2141a1a` → 병합 `c09eb32`(태그 `msg1-release-20261001`, 운영 반영본)
> **Author**: gc.kim (Claude Code 협업)
> **Completion Date**: 2026-10-01
> **PDCA Cycle**: #1 (Act 1회 + 브라우저 QA 보완 2회)

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | messenger-enhancement: R5 메신저 MVP 의 알림·확인·정리 기능 |
| Start Date | 2026-09-30 (기획) |
| End Date | 2026-10-01 |
| Duration | 2일. Plan → Design(설계안 C) → Do(M1~M4) → Check(93%) → Act → 브라우저 QA(7단계) |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Completion Rate: 100% (FR 13/13)            │
├─────────────────────────────────────────────┤
│  ✅ Complete:     13 / 13 FR                  │
│  ✅ SC met:        9 / 10 (SC-10 은 운영 뒤)    │
│  ❌ Cancelled:     0                          │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | 메신저 탭 밖에서는 새 메시지를 놓쳤고, 상대가 봤는지 알 수 없어 카톡으로 다시 물었다. 공지·파일·결정이 대화에 묻혔다(PRD O3). |
| **Solution** | 기존 폴링·이벤트 구조는 그대로 두고 테이블 5개와 라우트 3개(reactions·pins·me)를 더했다. 셸 알림, 고정 8개 반응, 읽음 숫자, 접속 상태, 고정, 즐겨찾기, 파일 목록, 검색 필터를 넣었다. `chat_events` 의 이벤트 종류는 바꾸지 않았다. |
| **Function/UX Effect** | 브라우저에서 확인한 결과: 다른 대화를 보고 있어도 2초 안에 토스트와 알림음이 온다. 반응이 2초 안에 상대 화면에 반영된다. 상대가 읽으면 읽음 숫자 `1` 이 1~3초 안에 사라진다. 음소거 채널은 직접 멘션만 알린다. 📌·파일·활동·즐겨찾기·필터에서 원래 메시지로 바로 이동한다. |
| **Core Value** | 외부 메신저 없이 "보냈다 → 봤다 → 찾는다"가 사내 도구 하나에서 끝난다. 모든 데이터는 같은 D1 에 있다. poll 은 DB 에 쓰지 않는다. |

---

## 1.4 Success Criteria Final Status

| # | Criteria | Status | Evidence |
|---|---------|:------:|----------|
| SC-1 | 다른 곳을 보고 있을 때 DM 이 오면 15초 안에 알림음·토스트, 누르면 강조 | ✅ Met | 브라우저 QA 2번(토스트 → 이동·강조) · 5번 재시험(알림음). 파비콘 배지는 브라우저가 이 앱의 아이콘을 표시하지 않아 미확인(§4) |
| SC-2 | 음소거 채널 일반 글은 알림·합계 없음, 직접 멘션은 알림 | ✅ Met | QA 5번: 일반 글 합계 4→4, 멘션 4→5, 멘션에만 토스트·알림음. E2E 같은 결과 |
| SC-3 | 활동함에 멘션과 참여 스레드 답글이 모이고, 누르면 그 위치(스레드 포함)로 이동 | ✅ Met | QA 6-3, E2E(thread_reply·focusReplyId) |
| SC-4 | 반응이 2초 안에 상대 화면에 반영, 다시 누르면 해제 | ✅ Met | QA 3번(👍 감지 1초 안에 ✅ → 화면 반영), `(수정됨)` 없음 |
| SC-5 | 읽음 숫자가 상대가 읽으면 줄고, 명단은 어디에도 없다 | ✅ Met | QA 4번 재측정: 읽음 처리 16:00:49.438 → 1~3초 안에 사라짐. 가드 테스트(명단 문구 없음) |
| SC-6 | 접속을 끊으면 "N분 전 활동" | ✅ Met | QA 화면에서 "11분 전 활동", "○ 52분" 확인. E2E: workerd 메모리가 요청 사이에 유지된다 |
| SC-7 | 일반 멤버는 고정 불가(403), 소유자 고정 시 📌 수 증가·감사 기록 | ✅ Met | E2E + QA 6-1(일반 멤버 화면에 해제 버튼 없음) |
| SC-8 | 비공개 채널 비멤버는 새 기능 어디서도 404 이거나 빈 결과 | ✅ Met | E2E: 경로 7곳 모두 404, 검색 빈 결과, reads null. 하니스 테스트 |
| SC-9 | poll 쿼리 +1 이하, 이벤트 없는 poll 의 D1 쓰기 0 | ✅ Met | 테스트: poll 5회 동안 쓰기 0. reads 조회 1개만 추가 |
| SC-10 | 운영 1주 뒤 "카톡으로 다시 물어본 적" 감소 | ⏳ Pending | 운영 반영 뒤 인터뷰 |

**Success Rate**: 9/9 측정 가능한 기준 충족. SC-10 은 운영 뒤 측정한다.

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|--------|----------|:---------:|---------|
| [PRD] | 실시간은 폴링, 메시지는 같은 D1 (D6) | ✅ | SSE 없이 2초 폴링으로 반응·읽음·알림이 체감상 즉시 |
| [Plan] MD2 | HTTP LAN 이라 앱 안 알림이 기본, 시스템 알림은 보안 컨텍스트에서만 | ✅ | 다른 PC 화면에 "앱 안 알림만 사용할 수 있습니다" 안내. 토스트·알림음은 동작 |
| [Plan] MD3 | 읽음은 숫자만 | ✅ | UI 는 숫자만 보여 준다(poll 응답에는 멤버별 위치가 있다, §4) |
| [Plan] MD7 | `chat_events` CHECK 를 건드리지 않고 반응·고정은 `message.edited` 로 보낸다 | ✅ | 스키마 변경 없이 전달. `(수정됨)` 표시 없음 |
| [Plan] MD8 | ALTER 대신 새 테이블 | ✅ | 테이블 5개, 멱등 DDL, 스레드 참여 백필 |
| [Design] DD1 | 설계안 C(균형) | ✅ | 라우트 3개 추가, UI 파일 4개 분리. 다만 워크스페이스는 842줄 → 1,116줄로, 설계 때 예상한 약 900줄보다 커졌다(이동·패널 상태·QA 보완). 다음에 패널 상태를 훅으로 분리할 후보 |
| [Design] DD6 | 접속 상태는 모듈 메모리 | ✅ | 쓰기 0. 재시작 뒤 빈 값은 세션 시각으로 채운다(QA 보완: 일반 poll 에서도 유지) |
| [Design] DD9 | 알림은 셸에서 낸다 | ✅ | 채팅 화면 밖에서도 동작 |
| [Check] | 비멤버 멘션 → 보내기 전 경고(사용자 결정) | ✅ | 보낸 직후 초대를 묻는다(QA 7번) |
| [QA] | @ 자동완성은 멤버만, 작성란 멘션 강조 | ✅ | 사용자 요청으로 추가(§3.1 비고) |

---

## 2. Related Documents

| Phase | Document | Status |
|-------|----------|--------|
| Plan | [messenger-enhancement.plan.md](../01-plan/features/messenger-enhancement.plan.md) | ✅ v0.1 |
| Design | [messenger-enhancement.design.md](../02-design/features/messenger-enhancement.design.md) | ✅ v0.5(구현 중 바뀐 점 기록) |
| Check | [messenger-enhancement.analysis.md](../03-analysis/messenger-enhancement.analysis.md) | ✅ 93%, Act-1 |
| Act | 이 문서 | ✅ |

---

## 3. Completed Items

### 3.1 Functional Requirements

| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| FR-01 | 메시지로 이동(around·after, 스레드 답글이면 패널까지) | ✅ | 검색·활동·고정·파일·즐겨찾기·토스트가 같은 경로를 쓴다 |
| FR-02 | 앱 안 알림(알림음·토스트) | ✅ | 알림음은 QA 뒤 음량 0.6, 220ms 로 키웠고 "소리 시험" 버튼을 넣었다 |
| FR-03 | 파비콘 배지 | ✅(코드) | 화면 표시는 미확인(§4) |
| FR-04 | 대화별 알림 수준(전체·멘션만·음소거) | ✅ | 합계 규칙은 Design §3.4 |
| FR-05 | 활동함(멘션 + 참여 스레드 답글) | ✅ | 멘션 답글은 스레드를 읽으면 읽음 처리(Act-1) |
| FR-06 | 시스템 알림(보안 컨텍스트에서만) | ✅ | localhost 에서만 켤 수 있다 |
| FR-07 | 고정 8개 반응 | ✅ | QA 뒤 "☺ 반응"을 footer 로 옮겼다 |
| FR-08 | 읽음 숫자(최상위 글, 숫자만) | ✅ | 말풍선 바로 아래 |
| FR-09 | 접속 상태(온라인 점·N분 전) | ✅ | DM 목록·DM 머리·멤버 관리·@ 자동완성 |
| FR-10 | 채널 고정(소유자·관리자, 10개) | ✅ | |
| FR-11 | 북마크 | ✅ | 화면 문구는 "즐겨찾기"(사용자 요청) |
| FR-12 | 채널 파일 모아보기 | ✅ | 50개씩, 커서 `<createdAt>_<id>` |
| FR-13 | 검색 필터(대화·보낸 사람·기간·첨부, 파일 이름) | ✅ | 대화 필터 파라미터는 `in` |
| (QA) | @ 자동완성은 대화 멤버만 / 작성란 멘션 강조 / 비멤버 멘션 초대 안내 | ✅ | 범위 밖이었으나 Check·QA 중 사용자 결정으로 추가 |

### 3.2 Non-Functional Requirements

| Item | Target | Achieved | Status |
|------|--------|----------|--------|
| poll 쿼리 증가 | +1 이하 | +1(reads, active 가 있을 때) | ✅ |
| poll D1 쓰기 | 0 | 0(시간당 세션 갱신만 예외, R5 와 같다) | ✅ |
| 반영 지연 | 폴링 1주기(2초) | 반응·읽음·알림 1~3초(브라우저 실측) | ✅ |
| 접근 경계 | 비멤버 404·빈 결과 | E2E 7경로 + 하니스 테스트 | ✅ |
| 감사 | 반응·고정 기록, 개인 상태 제외 | 예외는 `chat/read-state`·`chat/me` 두 파일뿐(가드 2곳) | ✅ |
| 스키마 | 추가만, 멱등 | 두 번 적용해도 오류 없음, 백필 멱등 | ✅ |
| 접근성 | 키보드 조작·aria | 반응 팝오버(화살표·Esc), 토스트 `role="status"`, jsx-a11y 통과 | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| 새 라우트 3 | `app/api/chat/{reactions,pins,me}/route.ts` | ✅ |
| 확장 라우트 3 | `app/api/chat/{messages,poll,attachments}/route.ts` | ✅ |
| 서버 | `app/chat-schema.ts`(테이블 5·백필), `app/chat-server.ts`, `app/chat-presence.ts` | ✅ |
| 클라이언트 | `app/chat-notify.ts`, `chat-toasts.tsx`, `chat-message.tsx`, `chat-panels.tsx`, `chat-client.ts`, `chat-workspace.tsx/.css`, `page.tsx` | ✅ |
| 테스트 | `tests/chat-enhancement.test.mjs` 34개 + 가드 수정 3파일 | ✅ |
| 문서 | Plan, Design v0.5, Analysis, 이 보고서 | ✅ |
| 커밋 | `7d3114a`, `2056b34`, `36de366`, `2141a1a` (26 files, +3,818/−205) | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over

| Item | Reason | Priority | Estimated Effort |
|------|--------|----------|------------------|
| 운영 첫 로그인 확인 | 새 테이블 5개와 스레드 백필은 로그인한 사용자의 첫 요청 때 만들어진다. 배포 뒤 비로그인 스모크만 했다(§8.2) | High | 로그인 1회 |
| HTTP LAN PC 알림 확인 | QA 는 서버 PC(127.0.0.1)에서 했다. 다른 PC 에서 알림음·토스트를 확인하고, 파비콘 배지 표시도 확인한다(QA 브라우저는 이 앱의 정적 아이콘조차 표시하지 않았다) | Medium | 확인 1회 |
| SC-10 사용자 인터뷰 | 운영 1주 뒤 | Medium | — |
| 초대·참여 시 읽음 위치 | JOIN·ADD_MEMBERS 는 읽음 위치 0 에서 시작한다(R5 동작). 오래된 `#일반` 에 초대되면 기록 전체가 안 읽음으로 잡힌다 | Medium | 결정 뒤 0.5일 |
| 2단계(E·F) | ERP 알림 봇, 레코드 링크 카드, AI 요약, SSE, 관리 도구 | — | 다음 PDCA |

### 4.2 Accepted Limitations

| Item | Reason |
|------|--------|
| poll 응답의 `reads` 에는 멤버별 읽음 위치가 있다 | UI 는 숫자만 보여 준다. 개발자 도구로는 누가 읽었는지 알 수 있다. 6명 규모라 수용했다(Design §7). 서버가 숫자만 계산해 주는 방식으로 바꿀 수 있지만 poll 이 무거워진다 |
| HTTP LAN PC 는 창이 최소화되면 토스트를 볼 수 없다 | 보안 컨텍스트가 아니어서 OS 알림을 쓸 수 없다(MD2). 알림음·탭 제목은 동작한다 |
| 반응·더 보기 링크는 마우스를 올려야 보인다 | 터치 화면에서는 보이지 않을 수 있다(R5 footer 규칙과 같다) |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final |
|--------|--------|-------|
| Design Match Rate (정적, gap-detector) | 90% | 93%(Act-1 전). 지적 8건을 모두 고쳤고 정적 재분석은 하지 않았다 |
| Tests (`npm test`, build 포함) | 전부 통과 | 505/505 |
| API E2E (실제 개발 서버) | 전부 통과 | 24/24 |
| 브라우저 QA | 7단계 | 7/7 통과(파비콘 배지 표시만 미확인) |
| Lint | 변경 파일 0 | 0(저장소 전체에는 원래 있던 4건: incentive-calculator 2, erp-platform.test 2) |
| Security | 비멤버 노출 0 | 0 |

### 5.2 Resolved Issues

| Issue | Found in | Resolution |
|-------|----------|------------|
| 열린 대화에서 기록 재요청·읽음 PUT 이 되풀이되고, 이동한 구간이 풀린다 | Check(Critical) | 훅 의존성에서 `poll` 객체를 빼고 고정 콜백만 쓴다. 회귀 가드 |
| 미참여 공개 채널의 @멘션이 아무 데도 안 보인다 | Check(Important) | 보낸 직후 초대 안내 |
| 새로고침 뒤 대화가 '불러오는 중'에 멈춘다(열린 대화를 다시 고를 때도) | QA 2 | 같은 id 면 기록을 비우지 않는다. 즐겨찾기 로드는 첫 선택 뒤에 |
| 상단 탭 배지가 다음 줄로 밀리고, 고친 뒤에는 가로 스크롤바가 생겼다 | QA 2 | 탭 안쪽 모서리에 둔다 |
| 반응이 없어도 빈 줄이 생기고, footer 링크 높이가 어긋난다 | QA 2·3 | 칩은 반응이 있을 때만, "☺ 반응"은 footer 로. 한 줄 가운데 정렬 |
| 일반 poll 에서 세션 기반 접속 시각이 사라진다 | QA 2 | 메모리에 채워 둔다(seedPresence) |
| 알림음이 들리지 않는다 | QA 5 | 음량·길이를 키우고, 일시정지된 오디오를 다시 켜고, "소리 시험" 버튼을 넣었다 |
| 필터 체크박스가 거대하고 글자가 줄바꿈된다, 사이드바 가로 스크롤 | QA 6 | R5 `.chat-search input` 규칙을 검색창에만 적용 |
| 테스트가 같은 ms 정렬에 의존해 간헐적으로 실패 | Do·QA | 정렬 무관하게 비교하고 간격을 둔다 |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- 설계 단계에서 코드를 먼저 읽고 제약(`chat_events` CHECK, 보는 사람과 무관한 DTO, HTTP LAN 의 Notification 부재)을 찾았다. 그래서 스키마 변경과 되돌리기 없이 구현했다.
- 모듈(M1~M4)마다 테스트를 함께 써서, 마지막 통합 때 회귀가 거의 없었다.
- 하니스 테스트 → 실제 개발 서버 API E2E → 브라우저 QA 의 3단 확인이 서로 다른 버그를 잡았다. 각 단계의 결과는 다음과 같다.
  - 하니스: SQL·권한
  - E2E: workerd 메모리 유지
  - 브라우저: 레이아웃과 effect 루프

### 6.2 What Needs Improvement (Problem)

- R5 부터 있던 두 패턴이 새 상태를 더하면서 실제 버그가 됐다. 하니스 테스트로는 둘 다 드러나지 않았다.
  - 렌더마다 새로 만들어지는 `poll` 객체를 훅 의존성으로 썼다.
  - 같은 id 로 `selectChannel` 을 부르면 기록이 비었다.
- 넓은 CSS 선택자(`.chat-search input`, footer 의 `:not(:first-child)`)가 새 요소에 그대로 적용됐다.
- Chrome 확장이 연결되지 않아 사용자가 직접 화면을 보고 상대역은 스크립트가 맡았다. 왕복이 많았다.

### 6.3 What to Try Next (Try)

- 훅 의존성에 셸 상태 객체가 들어가는지 확인하는 가드를 다른 워크스페이스에도 둔다.
- 새 UI 요소를 넣을 때는 상위의 요소 선택자(`form input`, `footer button`)부터 검색한다.
- 다음 사이클은 브라우저 확장을 먼저 연결하거나, 두 계정 화면을 자동으로 확인하는 E2E 도구(Playwright)를 도입한다.

---

## 7. Process Improvement Suggestions

| Phase | Current | Improvement Suggestion |
|-------|---------|------------------------|
| Check | 정적 분석(93%)만으로는 effect 루프 같은 런타임 문제를 늦게 본다 | 개발 서버 E2E 와 브라우저 QA 를 Check 에 처음부터 넣는다 |
| Do | 같은 ms 정렬에 기대는 테스트를 썼다 | 순서가 중요한 테스트는 시계를 고정하거나 간격을 둔다 |
| QA | 사용자 화면 + 상대역 스크립트 | 상대역 스크립트(qa-actor·step 스크립트)를 저장소 `scripts/qa/` 로 옮길지 검토 |

---

## 8. Next Steps

### 8.1 Immediate

- [x] `codex/local-erp-updates-20260831`(`f170bb6`, 총무 탭·HR·급여 12커밋)과 병합 → `c09eb32`. 충돌 4곳 해결(§8.2), `npm test` 528/528, 개발 서버 E2E 24/24. 개발 폴더 브랜치를 빨리 감기로 반영.
- [x] 운영 반영: 태그 `msg1-release-20261001` → `Deploy-XDNodeManagement.ps1`(정지 → 스냅샷·검증 → 빌드 → 기동 → 헬스체크 401). 중단 40초.
- [x] 비로그인 스모크(LAN 192.168.0.77:3000, 상태 코드만): 부트스트랩 403, explorer·`__debug` 404, 비밀값 파일 5종 404, WebSocket 업그레이드 끊김, 새 chat API 401, 교차 출처 POST 403. preview 로그 오류 0.
- [x] 이 워크트리의 QA 계정·개발 DB(`.wrangler/state`)와 작업 메모장의 QA 스크립트 정리.
- [ ] 다른 PC 에서 실제 계정으로 로그인 → 메신저(기존 대화·반응·즐겨찾기) 확인. 이때 새 테이블과 백필이 만들어진다.
- [ ] 같은 PC 에서 알림음·토스트, 파비콘 배지 표시 확인.

### 8.2 Deployment Record (2026-10-01)

| Item | Value |
|------|-------|
| 병합 | `c09eb32` = 메신저 개선 + `codex/local-erp-updates-20260831`(`f170bb6`). 충돌 4곳. ① `chat-workspace.tsx`: MessageItem 을 옮겼으므로 상위 브랜치의 `system:<이름>` 작성자 클래스를 `chat-message.tsx` 에 반영. ② `page.tsx`: 알림·토스트와 총무 배지·탭 열기 모두 유지. ③ 하니스: presence 와 GA 스키마 게이트 초기화 모두 유지. ④ `package.json`: 테스트 목록 합집합 |
| 교차 확인 | 총무 알림(`system:ga`) 글: DTO(반응·고정), 안 읽은 수, 알림(전체는 알림·음소거는 조용), 읽음 숫자, 반응이 모두 동작(테스트 추가) |
| 태그 | `msg1-release-20261001` → `c09eb32`(개발 폴더 저장소) |
| 배포 | 17:16:12 시작 → 17:16:53 완료, 중단 40초, 직전 `f170bb6` |
| 스냅샷 | `C:\xdm\snapshots\deploy-msg1-release-20261001-20261001-1716\` (integrity ok, 테이블 188, R2 162개 누락 0) |
| 롤백 | `Deploy-XDNodeManagement.ps1 -Tag hr1.1-release-20261001`. 새 테이블은 추가만 했으므로 옛 코드가 무시한다. 데이터까지 되돌릴 때는 위 스냅샷으로 runbook §11 |
| 주의 | 배포 직전 다른 세션이 점검 인스턴스(3001)에서 복구 리허설을 마치고 문서 커밋 `25a49c3` 을 올린 상태였다. 3001 종료·staging 정리를 확인한 뒤 배포했다. `25a49c3` 은 문서만 바꿔서 이번 태그에 넣지 않았다 |

### 8.3 Next PDCA Cycle

| Item | Priority | Expected Start |
|------|----------|----------------|
| 초대·참여 시 읽음 위치를 마지막 글부터 시작 | Medium | 운영 반영 뒤 |
| E. ERP 연동(알림 봇·레코드 카드·AI 요약) | High | SC-10 인터뷰 뒤 |
| F. SSE 승격·관리 도구(내보내기·보존 기간) | Low | 지연 체감이 문제일 때 |

---

## 9. Changelog

### messenger-enhancement (2026-10-01)

**Added:**
- 메시지로 이동, 스레드 참여(백필 포함)
- 셸 알림(알림음·토스트·파비콘·시스템 알림), 대화별 알림 수준, 활동함
- 고정 8개 반응, 읽음 숫자, 접속 상태
- 채널 고정, 즐겨찾기, 채널 파일 목록, 검색 필터(파일 이름 포함)
- 비멤버 멘션 초대 안내, 작성란 멘션 강조, "소리 시험"

**Changed:**
- @ 자동완성은 대화 멤버만 띄운다(공개 채널 포함)
- MessageItem 을 `chat-message.tsx` 로 옮겼다
- 상단 탭 배지 위치, footer 정렬, 내 글 footer 를 오른쪽부터 쌓는다

**Fixed:**
- 열린 대화의 기록 재요청 루프(R5 패턴)
- 열린 대화를 다시 고르면 빈 화면(R5)
- 탭 배지 줄바꿈(R5), 검색 폼 CSS 가 체크박스·날짜에 번지던 문제(R5)

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-10-01 | Completion report created | gc.kim |
| 1.1 | 2026-10-01 | 병합(`c09eb32`)·운영 반영(`msg1-release-20261001`, 중단 40초)·스모크 결과, 워크트리 정리 반영. 남은 확인: 운영 첫 로그인, HTTP LAN PC 알림 | gc.kim |
