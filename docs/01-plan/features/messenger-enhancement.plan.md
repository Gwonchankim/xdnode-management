# messenger-enhancement Planning Document

> **Summary**: R5 메신저 MVP 위에 "놓치지 않게(알림·활동함) · 확인했는지 알게(반응·읽음 숫자·접속 상태) · 다시 찾게(고정·북마크·파일·검색 필터)" 세 묶음을 얹는다. ERP 연동과 SSE는 2차로 미룬다.
>
> **Project**: XDnode management (`xdnode-management`)
> **Version**: 0.1 (기준 커밋 `750b4db`, 브랜치 `codex/local-erp-updates-20260831`)
> **Author**: gc.kim (Claude Code 협업)
> **Date**: 2026-09-30
> **Status**: Draft
> **Upstream**: [xdnode-management.prd.md](../../00-pm/xdnode-management.prd.md) §6 Phase 1(메신저 MVP 컷, "Later" 항목), [xdnode-management.design.md](../../02-design/features/xdnode-management.design.md) §3.3·§4.2.8(R5)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 메신저 탭 밖에 있으면 새 메시지를 놓친다. 상대가 확인했는지 알 수 없어서 결국 카톡으로 다시 묻는다. 공지·파일·결정사항은 대화 속에 묻혀 다시 찾기 어렵다. 이 세 가지가 PRD O3(카톡 대체)의 걸림돌이다. |
| **Solution** | 기존 폴링·이벤트 구조를 그대로 두고, 그 위에 추가 테이블 4개와 조회 경로 몇 개를 얹는다. 알림은 HTTP LAN에서 동작하는 앱 안 알림(소리·토스트·파비콘)으로 한다. 확인 신호는 고정 8개 반응, 읽음 숫자, 접속 점으로 준다. 정리는 소유자 공지 고정, 개인 북마크, 파일 모아보기, 검색 필터로 한다. |
| **Function/UX Effect** | 어느 탭에 있든 DM과 멘션이 소리·토스트로 온다. 메시지마다 안 읽은 사람 수가 보이고, 👍 하나로 "확인했어요"가 끝난다. 채널 머리의 📌에서 공지를 보고, 파일·검색 결과에서 원래 메시지로 바로 이동한다. |
| **Core Value** | 외부 메신저 없이 사내 도구 하나로 "보냈다 → 봤다 → 찾는다"가 끝난다. 모든 데이터는 같은 D1에 남는다. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 메시지를 놓치고, 확인 여부를 모르고, 예전 내용을 찾기 어렵다. 그래서 카톡으로 되돌아간다(PRD O3). |
| **WHO** | 경영지원실 5~6명. 사내 LAN, HTTP, 여러 PC에서 접속한다. 관리자 1명이 계정과 탭 권한을 준다. |
| **RISK** | `chat_events.kind`의 CHECK 제약 때문에 새 이벤트 종류를 추가할 수 없다(D4 DROP 금지). 폴링 hot path의 쿼리가 늘거나 쓰기가 생길 수 있다. `Notification` API는 비보안 컨텍스트(HTTP LAN)에서 쓸 수 없다. |
| **SUCCESS** | 다른 탭에서도 폴링 1주기 안에 DM·멘션 알림이 온다. 반응·읽음 숫자가 폴링 1주기 안에 상대 화면에 반영된다. 비멤버는 새 기능 어디서도 비공개 대화를 볼 수 없다. poll 쿼리 증가는 1개 이하다. |
| **SCOPE** | M1 공용 기반(메시지로 이동, 스키마, 이벤트 전달) → M2 알림·활동함 → M3 확인 문화 → M4 정보 정리. E(ERP 연동)·F(SSE·관리 도구)·D(서식·단축키)는 2차로 미룬다. |

---

## Decision Record

이 문서 안에서만 쓰는 번호다. 코드 주석에서는 `ME-MD3`, `ME-FR-07`처럼 접두사 `ME-`를 붙인다(xdnode-management의 D1~D23, FR-01~FR-21과 겹치지 않게). 충돌하면 xdnode-management D1~D23이 우선한다.

| ID | 결정 | 근거 |
|----|------|------|
| MD1 | 이번 사이클 범위는 A(알림·활동함), B(확인 문화), C(정보 정리)다. E·F는 2차, D(쓰기 편의)는 범위 밖이다 | 사용자 선택 2026-09-30 |
| MD2 | 알림은 앱 안 알림(소리·토스트·파비콘)이 기본이다. 브라우저 시스템 알림은 보안 컨텍스트(서버 PC `localhost`)에서만 opt-in으로 준다 | D10(HTTPS 범위 밖), `Notification`은 secure context 전용 |
| MD3 | 읽음 표시는 **숫자만** 보여 준다. 읽은 사람과 안 읽은 사람의 명단은 보여 주지 않는다 | 사용자 선택 |
| MD4 | 반응은 **고정 8개**(👍 ✅ 👀 🙏 😂 🎉 ❤️ 😮)다. 전체 이모지 피커는 두지 않는다 | 사용자 선택 |
| MD5 | 고정(공지)은 **채널 소유자와 관리자만** 한다. public·private 채널에만 있고, DM·그룹 DM에는 없다 | 사용자 선택. DM에는 소유 개념이 약하다(필요하면 Design에서 다시 연다) |
| MD6 | 접속 상태는 **온라인 점 + "N분 전 활동"**이다. 기존 폴링을 하트비트로 쓴다 | 사용자 선택, PRD "폴링 기반 최근 활동" |
| MD7 | `chat_events`의 CHECK 제약은 건드리지 않는다. 반응·고정 변경은 기존 `message.edited`(메시지 DTO 재전송)로 전달하고, 채널 단위 변경은 `channel.updated`로 전달한다. `(수정됨)` 표시는 이벤트 종류가 아니라 `editedAt`로 판단하므로 영향이 없다 | D4(DROP 금지), SQLite는 CHECK를 ALTER할 수 없다 |
| MD8 | 새 상태는 `ALTER TABLE ADD COLUMN` 대신 **새 테이블**에 둔다. 모든 DDL은 `app/chat-schema.ts`의 `CREATE … IF NOT EXISTS`로만 추가한다 | SQLite `ADD COLUMN`에는 `IF NOT EXISTS`가 없어 멱등이 아니다. CLAUDE.md "Schema placement" |
| MD9 | 반응과 고정은 감사를 남긴다(남에게 보이는 변화이기 때문이다). 북마크·알림 설정·접속 하트비트는 개인 상태로 보고 감사에서 뺀다. 예외 목록은 `tests/erp-platform.test.mjs` 가드에 파일 이름으로 명시한다 | read-state 예외와 같은 논리 |
| MD10 | 읽음 숫자는 **최상위 메시지**에만 붙인다. 스레드 답글에는 붙이지 않는다. 읽음 위치는 채널 단위라서, 채널을 읽었다고 스레드를 읽었다고 볼 수 없다 | 기존 `unreadSummary` 규칙과 일치 |

---

## 1. Overview

### 1.1 Purpose

R5 메신저(채널·DM·스레드·첨부·멘션·검색·폴링)는 "쓸 수 있는" 수준이다. 그런데 팀이 카톡을 끊고 옮겨 오려면 세 가지 경험이 더 필요하다.

1. **놓치지 않기**: 다른 탭이나 창에 있어도 나에게 온 것을 안다.
2. **확인 신호**: 보낸 글을 누가 얼마나 봤는지 알고, 짧게 "확인" 표시를 한다.
3. **다시 찾기**: 공지, 파일, 예전 결정을 대화를 뒤지지 않고 찾는다.

### 1.2 Background

- PRD §6 Phase 1은 이모지 반응, 브라우저 알림, 접속 상태를 "Later"로, 북마크/핀을 "Out"으로 분류했다. 실제로 써 보니 사용자는 세 가지 불편(놓침, 확인 불가, 찾기 어려움)을 모두 겪고 있다(2026-09-30 확인). 그래서 핀과 북마크를 범위 안으로 다시 들인다.
- 현재 구조에서 재사용할 수 있는 것:
  - `chat_events` seq 커서 폴링(`useChatPoll`: 메신저 탭에서는 2초, 다른 탭에서는 15초 간격, focus·visibilitychange에서 즉시)
  - 멤버별 `last_read_message_id`
  - `chat_mentions`
  - `loadChannelAccess` 단일 접근 판정(비멤버는 404)
  - `(N) XDnode management` 탭 제목 배지
- 현재 구조의 한계:
  - `chat_events.kind`에 CHECK 제약이 있다(MD7).
  - 메시지 조회가 `before` 방향만 지원해서 "특정 메시지로 이동"이 없다.
  - 검색은 본문 LIKE 하나뿐이다.
  - 스레드 답글은 나를 멘션한 경우에만 안 읽음으로 센다.

### 1.3 Related Documents

- PRD: [docs/00-pm/xdnode-management.prd.md](../../00-pm/xdnode-management.prd.md) §6 Phase 1, §13 Q2(실시간 승격)
- Plan: [docs/01-plan/features/xdnode-management.plan.md](xdnode-management.plan.md) (R5, D5·D6)
- Design: [docs/02-design/features/xdnode-management.design.md](../../02-design/features/xdnode-management.design.md) §3.3 스키마, §4.2.8 chat API, §7.8 첨부 형식
- 코드: `app/chat-schema.ts`, `app/chat-server.ts`, `app/chat-client.ts`, `app/chat-workspace.tsx`, `app/api/chat/*`

---

## 2. Scope

### 2.1 In Scope

**M1 공용 기반**
- [ ] 메시지로 이동: 메시지 id 주변 앞뒤 문맥을 불러오고 강조한다. 활동함·고정·북마크·파일·검색이 함께 쓴다.
- [ ] 새 테이블 DDL: 반응, 고정, 북마크, 멤버 설정.
- [ ] 반응·고정 변경을 기존 이벤트로 전달하고, 메시지 DTO를 확장한다.

**M2 알림·활동함 (테마 A)**
- [ ] 앱 안 알림: 알림음, 토스트, 파비콘 배지
- [ ] 브라우저 시스템 알림: 보안 컨텍스트에서만 opt-in
- [ ] 채널별 알림 수준: 전체 / 멘션만 / 음소거
- [ ] 활동함: 나를 멘션한 메시지와 내가 참여한 스레드의 새 답글

**M3 확인 문화 (테마 B)**
- [ ] 이모지 반응(고정 8개)
- [ ] 읽음 숫자(최상위 메시지, 숫자만)
- [ ] 접속 상태(온라인 점 + N분 전 활동)

**M4 정보 정리 (테마 C)**
- [ ] 채널 고정 메시지(소유자·관리자)
- [ ] 개인 북마크(나중에 보기)
- [ ] 채널 파일 모아보기
- [ ] 검색 필터: 채널, 보낸 사람, 기간, 첨부 있음, 파일 이름

### 2.2 Out of Scope

- **E. ERP 연동**(2차): 시스템 알림 봇, ERP 레코드 링크 카드, AI 스레드 요약
- **F. 기반·운영**(2차): SSE·long-poll 승격(PRD Q2), 대화 내보내기, 보존 기간, 첨부 용량 현황
- **D. 쓰기 편의**: 서식(마크다운), 임시 저장·재전송, 단축키, 이미지 라이트박스와 PDF 미리보기
- 읽은 사람과 안 읽은 사람의 명단(MD3), 전체 이모지 피커와 커스텀 이모지(MD4), DM 고정(MD5)
- HTTPS 도입과 모든 PC에서의 OS 푸시(D10), 모바일 앱, 예약 메시지, 리마인더, 통화

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Module | Status |
|----|-------------|----------|--------|--------|
| FR-01 | **메시지로 이동.** 메시지 id를 받으면 그 채널을 열고, 대상 메시지 앞뒤 문맥(예: 앞 25개, 뒤 25개)을 불러와 스크롤한 뒤 잠시 강조한다. 스레드 답글이면 루트를 기준으로 채널을 열고 스레드 패널까지 연다. 접근할 수 없거나 삭제된 메시지면 "찾을 수 없음"을 안내한다. | High | M1 | Pending |
| FR-02 | **앱 안 알림.** 새 메시지가 알림 대상이면 알림음을 낸다(개인 설정으로 켜고 끔). 메신저 탭이 아니거나, 보고 있지 않은 채널이면 토스트를 띄운다(보낸 사람, 대화 이름, 미리보기 80자, 클릭하면 FR-01로 이동). 알림 대상: DM과 그룹 DM은 전부, 채널은 알림 수준(FR-04)에 따른다. 내가 쓴 글은 제외한다. | High | M2 | Pending |
| FR-03 | **파비콘 배지.** 안 읽은 멘션이나 DM이 있으면 파비콘에 빨간 점이나 숫자를 그린다. 탭 제목 배지 `(N)`과 같은 숫자를 쓴다. | Medium | M2 | Pending |
| FR-04 | **채널별 알림 수준.** 대화마다 `전체 / 멘션만 / 음소거`를 고른다. 기본값은 채널이 전체, DM도 전체다. 음소거한 채널은 목록에서 흐리게 보이고, 총합 배지에서 빠진다. 단 나를 직접 멘션한 글은 음소거여도 멘션 수와 알림에 넣는다(`@channel`은 뺀다). | High | M2 | Pending |
| FR-05 | **활동함.** 사이드바 맨 위에 "활동" 항목을 둔다. 대상은 (a) 나를 멘션한 메시지와 `@channel`, (b) 내가 루트를 썼거나 답글을 단 스레드의 새 답글이다. 최신순, 안 읽음과 읽음을 구분해 보여 주고, 클릭하면 FR-01로 이동한다. 스레드 새 답글에는 안 읽음 배지를 붙인다. | High | M2 | Pending |
| FR-06 | **브라우저 시스템 알림.** `window.isSecureContext`가 참일 때만 설정에 "시스템 알림 받기"를 보여 준다. 거짓이면 "이 PC에서는 앱 안 알림만 사용할 수 있습니다"라고 안내한다. | Low | M2 | Pending |
| FR-07 | **이모지 반응.** 메시지에 마우스를 올리면 반응 버튼이 나오고, 고정 8개 가운데 하나를 토글한다. 메시지 아래에 `이모지 개수`로 모아 보여 주고, 내가 누른 반응은 강조한다. 마우스를 올리면 누른 사람 이름이 보인다(반응은 명단을 보여 준다. 읽음 명단 금지(MD3)와는 별개다). 삭제된 메시지와 보관된 채널에서는 반응을 막는다. 쓰기 권한(chat=edit)이 필요하다. | High | M3 | Pending |
| FR-08 | **읽음 숫자.** 최상위 메시지마다 "안 읽은 사람 수"를 표시한다. 계산식: 현재 멤버 가운데 작성자를 빼고 `last_read_message_id < 메시지 id`인 사람의 수. 0이면 숨긴다. 명단은 보여 주지 않는다. 공개 채널을 멤버가 아닌 채 보는 사람에게는 표시하지 않는다. 상대가 읽으면 폴링 1주기 안에 숫자가 줄어야 한다. | High | M3 | Pending |
| FR-09 | **접속 상태.** 사람 이름 옆(DM 목록, DM 머리, 멘션 자동완성, 멤버 목록)에 온라인 점을 둔다. 온라인 판정은 최근 poll 요청이 45초 이내인지다(비활성 탭의 poll 간격 15초 × 3). 온라인이 아니면 "N분 전 활동"이나 "오늘 오전 9:12"를 보여 준다. 자기 자신은 항상 온라인이다. | Medium | M3 | Pending |
| FR-10 | **채널 고정 메시지.** 채널 소유자와 관리자는 최상위 메시지를 고정하고 해제한다. 채널당 최대 10개다. 채널 머리에 `📌 N`을 두고, 누르면 목록 패널(고정한 사람, 시각, 클릭하면 FR-01)을 연다. 일반 멤버에게는 고정 버튼이 보이지 않고, API도 403으로 막는다. 삭제된 메시지는 목록에서 뺀다. 감사를 남긴다. | High | M4 | Pending |
| FR-11 | **북마크(나중에 보기).** 메시지마다 "저장"을 토글한다. 사이드바 "저장됨"에 최신순으로 모으고, 클릭하면 FR-01로 이동한다. 나만 보인다. 대화에 접근할 수 없게 되면(퇴장, 권한 회수) 목록에서 숨긴다(데이터는 남긴다). | Medium | M4 | Pending |
| FR-12 | **채널 파일 모아보기.** 채널 머리의 "파일" 패널에 첨부를 최신순으로 보여 준다(파일 이름, 올린 사람, 날짜, 크기). 이미지는 썸네일 격자로 보이고, 메시지로 이동할 수 있다. 삭제된 메시지의 첨부는 뺀다. 접근 판정은 `loadChannelAccess`를 그대로 쓴다. | Medium | M4 | Pending |
| FR-13 | **검색 필터.** 기존 `q` 검색에 선택 필터를 더한다: 대화(channelId), 보낸 사람(authorId), 기간(from·to), 첨부 있음(hasFile). 파일 이름 일치도 결과에 포함한다. 결과를 클릭하면 FR-01로 이동한다. 검색 범위(내가 멤버인 대화 + 공개 채널)는 바꾸지 않는다. | Medium | M4 | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance: poll hot path | `/api/chat/poll`의 쿼리 증가는 **1개 이하**다(읽음 위치와 접속 상태를 합친 조회 1개). 이벤트가 없는 poll에서 D1 쓰기는 0이다. 접속 하트비트는 D1에 쓰지 않거나, 쓰더라도 계정당 30초에 1회 이하다 | 라우트 소스 가드 테스트 + harness로 쿼리 수 확인 |
| Performance: 체감 지연 | 반응·읽음 숫자·고정은 폴링 1주기(메신저 탭 2초, 다른 탭 15초) 안에 상대 화면에 반영된다 | 두 계정으로 harness·수동 확인 |
| Security: 접근 경계 | 반응, 고정, 북마크, 파일 목록, 이동(FR-01), 검색 필터 모두 `loadChannelAccess`를 거친다. 비공개 채널·DM의 비멤버와 없는 id에는 같은 404를 준다. 읽음 숫자와 접속 상태는 현재 멤버와 chat 권한자에게만 준다 | `tests/chat-api.test.mjs`에 비멤버 시나리오 추가 |
| Security: 권한 | 쓰기(반응, 고정, 북마크)는 `chat:write`, 조회는 `chat:read`다. 고정은 추가로 소유자 또는 관리자여야 한다 | route 테스트 |
| Audit | 반응·고정은 `writeErpAudit`를 남긴다. 북마크·알림 설정·하트비트는 예외 목록에 명시한다(MD9) | `tests/erp-platform.test.mjs` 가드 |
| Schema safety | 추가만 하고 DROP·ALTER CHECK는 하지 않는다. 모든 DDL은 멱등이고, `chat-schema.ts`의 batch 안에만 둔다 | 스키마 소스 가드 + 기존 DB 복사본에 두 번 적용하는 테스트 |
| Compatibility | 이미 열려 있는 구버전 클라이언트가 확장된 DTO와 이벤트를 받아도 깨지지 않는다(필드 추가만 한다) | DTO 변경 리뷰 |
| Accessibility | 반응 버튼과 알림 수준 선택은 키보드로 조작할 수 있고, `aria-label`(한국어)을 붙인다. 토스트는 `role="status"` | eslint jsx-a11y + 수동 확인 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] SC-1: 다른 PC(HTTP LAN)에서 계정 A가 HR 탭을 보고 있을 때, B가 보낸 DM에 15초 안에 알림음, 토스트, 파비콘 배지가 뜬다. 토스트를 클릭하면 해당 메시지가 강조된다.
- [ ] SC-2: 음소거한 채널의 일반 글은 소리, 토스트, 총합 배지에 나타나지 않는다. 같은 채널에서 나를 `@이름`으로 멘션한 글은 알림이 온다.
- [ ] SC-3: 활동함에 멘션과 참여 스레드의 새 답글이 모인다. 클릭하면 FR-01로 해당 위치(스레드면 스레드 패널까지)가 열린다.
- [ ] SC-4: A가 👍를 누르면 B의 열린 화면에 2초(메신저 탭) 안에 반영된다. 한 번 더 누르면 해제된다.
- [ ] SC-5: 멤버 4명 채널에 A가 글을 쓰면 3이 뜨고, 두 명이 읽으면 1이 되고, 모두 읽으면 숫자가 사라진다. 누가 읽었는지는 어디에도 나오지 않는다.
- [ ] SC-6: B가 앱을 닫으면 약 1분 안에 A의 화면에서 B의 점이 꺼지고 "N분 전 활동"이 뜬다.
- [ ] SC-7: 일반 멤버에게는 고정 버튼이 없고 API는 403이다. 소유자가 고정하면 모든 멤버의 `📌` 수가 늘고, 감사 로그에 기록이 남는다.
- [ ] SC-8: 비공개 채널의 비멤버가 그 채널 메시지 id로 반응, 고정, 북마크, 이동, 파일 목록, 검색 필터를 호출하면 모두 404이거나 결과가 비어 있다(테스트로 고정).
- [ ] SC-9: poll 쿼리 증가가 1개 이하이고, 이벤트가 없는 poll에서 D1 쓰기가 0이다(가드 테스트).
- [ ] SC-10: 운영 반영 후 1주가 지났을 때 "확인하려고 카톡으로 다시 물어본 적"이 줄었다는 응답을 사용자 인터뷰에서 얻는다(PRD O3 측정 방식과 같다).

### 4.2 Quality Criteria

- [ ] `npm test` 통과. 새 테스트 파일은 `package.json`의 `test` 목록에 추가한다(`removal-guards`가 불일치를 잡는다).
- [ ] `npm run lint` 0 오류
- [ ] `npm run build` 성공, `tests/bundle-exposure.test.mjs` 통과
- [ ] 운영 데이터 복사본(`scripts/verify-state-snapshot.mjs` 경로)에서 새 DDL이 두 번 적용돼도 오류가 없다.

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `chat_events.kind` CHECK 때문에 `message.reacted` 같은 새 이벤트를 넣으면 INSERT가 실패한다 | High | High(그대로 넣으면 확실) | MD7: 반응·고정은 `message.edited`(DTO 재전송)로, 채널 단위 변경은 `channel.updated`로 보낸다. 새 종류가 꼭 필요하면 Design에서 별도 `chat_events_v2` 테이블을 검토한다(DROP 없이) |
| 읽음 숫자를 위해 남의 읽음 변경을 전파하면 poll 증분이 폭증한다(기존 설계는 읽음을 이벤트에서 일부러 뺐다) | High | Medium | 이벤트로 만들지 않는다. 보고 있는 채널(`watch`/활성 채널) 멤버의 읽음 위치를 poll 응답에 스냅샷으로 싣는다(조회 1개, 6명 규모). 계산은 클라이언트에서 한다 |
| 접속 하트비트가 poll hot path에 D1 쓰기를 더한다 | Medium | Medium | Design에서 비교할 두 안: (a) Worker 모듈 메모리 맵(단일 프로세스 `vite preview`이고, 재시작하면 사라져도 무방하다. 이때는 세션 `last_seen_at`로 대체) (b) 계정당 30초 스로틀 UPSERT. 우선 (a)를 권장한다 |
| HTTP LAN에서는 `Notification`과 Service Worker 푸시를 쓸 수 없다 | Medium | High(확정) | MD2: 앱 안 알림을 기본으로 한다. 브라우저가 최소화돼 있으면 알림이 안 온다는 한계를 사용자 안내와 Report에 명시한다. 탭 제목과 파비콘이 작업 표시줄에서 보이도록 한다 |
| 알림음 자동 재생이 브라우저 autoplay 정책에 막힌다 | Low | Medium | 첫 사용자 상호작용 뒤에 `AudioContext`를 연다. 실패해도 조용히 토스트만 띄운다 |
| 메시지 DTO가 커져 poll 응답과 목록 조회가 무거워진다(반응 집계) | Low | Low | 반응은 `(emoji, count, mine, names≤8)` 집계만 싣는다. 6명 규모라 영향이 작다 |
| 범위가 커진다("Slack 클론" 위험, PRD 위험 #3) | Medium | Medium | 모듈 M1~M4를 순서대로 릴리스한다. 모듈마다 태그와 롤백 절차를 둔다. D·E·F는 이 문서에서 명시적으로 뺐다 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `chat_reactions` (신규) | DB 테이블 | `(message_id, account_id, emoji)` PK, `channel_id`, `created_at` |
| `chat_pins` (신규) | DB 테이블 | `(channel_id, message_id)` PK, `pinned_by`, `pinned_at` |
| `chat_bookmarks` (신규) | DB 테이블 | `(account_id, message_id)` PK, `channel_id`, `created_at` |
| `chat_member_prefs` (신규) | DB 테이블 | `(channel_id, account_id)` PK, `notify_level ∈ {all, mentions, mute}` |
| `ChatMessageDto` | API 계약 | `reactions`, `pinned`, `bookmarked` 필드 추가(추가만) |
| `ChatChannelDto` | API 계약 | `notifyLevel`, `pinCount` 추가 |
| `GET /api/chat/poll` | API | 응답에 `readPositions`(활성 채널)와 `presence` 추가, 하트비트 기록 |
| `GET /api/chat/messages` | API | `around=<id>`(FR-01) 추가, 검색 필터 파라미터(FR-13) 추가 |
| `unreadSummary()` | 서버 함수 | 음소거 반영(총합에서 제외, 직접 멘션은 포함). 참여 스레드 답글 집계(활동함) |
| 신규 라우트 | API | `/api/chat/reactions`, `/api/chat/pins`, `/api/chat/bookmarks`, `/api/chat/prefs`, `/api/chat/activity`, `/api/chat/files` (Design에서 통합 여부 결정) |
| `useChatPoll` / `chat-client.ts` | 클라이언트 | 알림 디스패처(소리, 토스트, 파비콘), 읽음·접속 상태 저장소 |
| `chat-workspace.tsx` / `.css` | UI | 반응 바, 읽음 숫자, 접속 점, 📌 패널, 파일 패널, 활동함, 저장됨, 알림 수준 메뉴 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `chat_events` | CREATE | `eventStatement`, `joinStatements` (`app/chat-server.ts`), messages·channels 라우트 | 확인 필요: 새 kind를 쓰면 안 된다(MD7) |
| `chat_events` | READ | `app/api/chat/poll/route.ts` | 영향 없음(kind 그대로) |
| `message.edited` 이벤트 | READ | `chat-workspace.tsx` poll 구독(메시지 교체) | 확인 필요: 반응·고정 변경에서도 교체만 하고 `(수정됨)`을 띄우지 않는지(`editedAt` 기준) |
| `unreadSummary` | READ | poll·read-state 라우트, `myChannelDtos`, 셸 탭 배지, 탭 제목 | 확인 필요: 음소거 반영 뒤 배지 숫자의 의미가 바뀐다 |
| `ChatMessageDto` | READ | poll, messages GET, thread, search, 워크스페이스 렌더 | 영향 없음(필드 추가) |
| `chat_members.last_read_message_id` | READ | `unreadSummary`, read-state PUT | 영향 없음(새 소비자인 읽음 숫자만 추가) |
| `auth_sessions.last_seen_at` | READ | `app/auth-session.ts`(시간당 1회 갱신) | 영향 없음(접속 상태의 대체 값으로 읽기만 한다) |
| 감사 가드 | TEST | `tests/erp-platform.test.mjs`(모든 쓰기 라우트는 `writeErpAudit`) | 확인 필요: 북마크·prefs 예외를 명시해야 한다 |
| `npm test` 목록 | CONFIG | `package.json`, `tests/removal-guards.test.mjs` | 확인 필요: 새 테스트 파일을 등록해야 한다 |
| `access-tabs.ts` `apiPrefixes: ["/api/chat/"]` | CONFIG | 탭 권한 라우팅 | 영향 없음(새 라우트도 같은 접두사) |

### 6.3 Verification

- [ ] 위 소비자 전부가 변경 후에도 동작하는지 확인
- [ ] 탭 권한(chat none/view/edit)별 새 라우트 응답 확인
- [ ] 필드 추가가 기존 쿼리(`MESSAGE_SELECT`의 json 서브쿼리)를 깨지 않는지 확인

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | Simple structure | Static sites | ☐ |
| **Dynamic** | Feature-based modules, backend 포함 | Web apps with backend | ☑ (bkend.ai 대신 자체 Worker + D1 + R2) |
| **Enterprise** | Strict layer separation, microservices | High-traffic systems | ☐ |

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| Framework | 기존 vinext(Next 형태) | 유지 | 기존 앱 |
| 실시간 | 폴링 유지 / SSE / long-poll | **폴링 유지** | D6. SSE는 2차(F). 반응·읽음은 폴링 1주기면 충분하다 |
| 이벤트 전달 | 새 kind / 기존 kind 재사용 / 새 이벤트 테이블 | **기존 kind 재사용** | MD7 |
| 읽음 숫자 전파 | 이벤트화 / poll 스냅샷 | **poll 스냅샷(활성 채널)** | 증분 폭증 방지, 기존 설계 의도 유지 |
| 접속 상태 저장 | 메모리 맵 / D1 스로틀 | Design에서 결정(메모리 맵 권장) | hot path 쓰기 0 유지 |
| State Management | 기존 `useState` + ref + poll 구독 | 유지 | 새 라이브러리를 도입하지 않는다 |
| API Client | 기존 `chatRequest` | 유지 | |
| Styling | 기존 `chat-workspace.css` | 유지 | |
| Testing | `node --test` + `hr-api-harness` | 유지 | CLAUDE.md harness 규칙 |

### 7.3 Folder Structure

새 폴더는 없다. `app/chat-*.ts(x)`와 `app/api/chat/<feature>/route.ts` 패턴을 따른다. 알림 로직이 커지면 `app/chat-notify.ts`로 분리한다.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` Conventions / Harness rules / Schema placement
- [x] ESLint (`eslint.config.mjs`, jsx-a11y 포함)
- [x] TypeScript (`tsconfig.json`, 타입 검사 단계는 없고 빌드는 transpile만 한다)
- [ ] Prettier 없음(기존 코드 스타일을 따른다)

### 8.2 Conventions to Follow

| Category | Rule |
|----------|------|
| 라우트 | `authorizeErpRequest(db, "chat", action)`를 먼저 호출하고, 그다음 `readJsonBody`, 그다음 `loadChannelAccess`. 쓰기에는 `writeErpAudit`(MD9 예외만 뺀다) |
| 스키마 | `app/chat-schema.ts`의 `CHAT_DDL`에만 추가한다. 라우트 `ensureSchema`에 두지 않는다 |
| import | 확장자 없는 상대 경로만 쓴다. `@/`, `.tsx` import 금지 |
| 문구 | 한국어로 쓰고, 기존 오류 헬퍼(`chatNotFound` 등)를 재사용한다 |
| 주석 | `// ME-FR-07 …`, `// ME-MD7 …`로 이 문서를 참조한다 |

### 8.3 Environment Variables Needed

없음. 알림음 파일은 `public/`에 둔다(짧은 wav/ogg, 저작권 없는 자체 생성).

---

## 9. Next Steps

1. [ ] `/pdca design messenger-enhancement`: 3가지 설계안 비교(특히 이벤트 전달, 접속 상태 저장, 라우트 통합 여부)
2. [ ] Design §11 Session Guide에 M1~M4 모듈 맵
3. [ ] 모듈 단위 구현: `/pdca do messenger-enhancement --scope M1` → M2 → M3 → M4

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-09-30 | 초안: 사용자 선택(A·B·C, E·F는 2차, 읽음 숫자만, 고정 8개 반응, 소유자 고정, 온라인 점 + 마지막 활동) 반영 | gc.kim |
