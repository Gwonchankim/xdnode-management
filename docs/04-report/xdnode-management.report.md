# xdnode-management Completion Report

> **Status**: Complete · R0~R6 운영 반영 완료(마지막 릴리스 R6, 2026-10-01). 상태 동기화 2026-10-02
>
> **Project**: XDnode management (`xdnode-management`)
> **Version**: 보관 기준 `02f6ba5`(태그 `erp-final-20260923`) → R3 `bf98693`(`r3-release-20260929`) → R5 `f7bf9e9`(`r5-release-20260929`) → 운영 현재 `c09eb32`(`msg1-release-20261001`)
> **Author**: gc.kim (Claude Code 협업)
> **Completion Date**: 2026-10-01 (R6) / 보고 2026-10-02
> **PDCA Cycle**: #1 (PRD → Plan v0.2 → Design v0.1 → R0~R6 → Check 92%)

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | xdnode-management: XD NODE ERP를 경영지원실 5~6명용 "XDnode management"로 재편(노출 차단, 재무·영업·결재 제거, 계정·탭 권한, LAN 운영, 메신저, 리네임) |
| Start Date | 2026-09-23 (PRD·Plan·Design, R0 즉시 보안) |
| End Date | 2026-10-01 (R6 폴더 리네임) |
| Duration | 9일. R0(09-23) → R1·R2(09-28) → R3·R4·R5(09-29) → R5.1·R5.2(09-30) → R6(10-01) |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Match Rate: 92% (FR 21/21, 체크리스트 92.8%) │
├─────────────────────────────────────────────┤
│  ✅ FR Done:        21 / 21                   │
│  ✅ SC 충족:         8 / 13 (부분 3, 미실시 2)  │
│  ⏳ 남은 체크 항목:  10 (운영 보완 4, 측정 5, lint 1) │
│  ❌ Cancelled:       0                        │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | 접속자 전원이 한 신원(최고 권한)이었다. dev 서버가 `0.0.0.0`에 떠 있어 LAN의 누구나 Miniflare explorer로 D1에 SQL을 실행하고 `.wrangler` sqlite·소스를 받을 수 있었다. 클라이언트 번들에 급여·연락처가 있었고, 어시스턴트 브리지는 `.env.local`과 직원 명부를 읽을 수 있었다. 쓰지 않는 재무·영업·결재가 코드의 절반 이상이었다. |
| **Solution** | R0에서 노출을 먼저 닫았다(127.0.0.1 바인딩, explorer off, fs.deny, 방화벽 정리, 브리지 무도구·빈 cwd). R1에서 HR 결재 7흐름을 즉시 반영으로 바꾸고 재무·영업·결재 120개 파일을 지웠다(−41,888줄). R3에서 계정·세션·탭 권한과 `vite preview` 운영 전환을 한 번에 배포하고 운영 폴더 `C:\xdm\prod`로 데이터를 옮겼다. R4에서 매일 백업·자동 기동·Deploy를, R5에서 메신저를 붙였다. |
| **Function/UX Effect** | 로그인하면 허용된 탭만 보이고, 숨긴 탭의 API는 403이다. 브라우저 번들에 실데이터가 없다. 다른 PC에서 `http://192.168.0.77:3000`으로 접속하고, 어시스턴트는 서버가 권한 검사 뒤 넘긴 JSON으로만 답한다. 메신저는 2초 폴링으로 채널·DM·스레드·첨부를 지원한다. |
| **Core Value** | 감사 로그에 실제 로그인한 사람이 남는다. 서버 PC가 재부팅돼도 로그온 없이 1~2분 안에 올라오고(2026-10-02 08:58 실제 재부팅에서 확인), 매일 03:00 검증된 백업이 쌓이며 복구 리허설이 끝났다. 새 탭은 레지스트리 한 줄과 라우트로 붙는다(다음 사이클의 총무 탭이 실증). |

---

## 1.4 Success Criteria Final Status

| # | Criteria | Status | Evidence |
|---|---------|:------:|----------|
| SC-1 | FR마다 검증 수단이 있고 전부 통과 | ⚠️ Partial | FR 21개 통과. SC-4·6·11·12 수동 판정 일부 남음 |
| SC-2 | 권한 매트릭스(DOM·API) | ✅ Met | `tab-permissions` #22·#23, `shell-tabs`, `chat-api` #49, R3 스모크 |
| SC-3 | 두 계정 감사 actor 구분 | ✅ Met | `auth-session` #16 |
| SC-4 | HR 회귀(다른 PC, 사본·새 DB) | ⚠️ Partial | R1 서버 PC 점검 인스턴스에서 48+4+13 전부 PASS(새 DB의 조직명 500을 찾아 고침). R3 다른 PC 최종 판정 기록 없음 |
| SC-5 | 다른 PC 로그인·어시스턴트·이력서 분석 | ✅ Met | R3 7단계 점검 PC(192.168.0.98) 스모크 |
| SC-6 | 채팅 3초 이내(두 PC 10회) | ❌ Not measured | 참고: 개발 서버 상대 poll 78ms, 브라우저 QA 1~3초 |
| SC-7 | 백업 복구 | ✅ Met | 2026-10-01: integrity ok, 테이블 185·행 10,206 차이 0, R2 154 누락 0 |
| SC-8 | 보관 태그·브랜치·스냅샷, 옛 테이블 잔존 | ✅ Met | `erp-final-20260923`, archive 브랜치, `r1-pre` 보고서, 테이블 104개 잔존 |
| SC-9 | 다른 PC에서 파일·explorer 404/403, 번들 0건 | ✅ Met | R3 스모크, msg1 배포 뒤 LAN 스모크, `bundle-exposure` |
| SC-10 | 위조 차단·교차 출처 403·동시 오답 | ✅ Met | `auth-session` #2·#3·#6·#10 |
| SC-11 | 어시스턴트 파일 5종 요청 | ❌ Not run | 브리지는 도구 없이 빈 임시 폴더에서 돈다(가드 테스트) |
| SC-12 | 재부팅 무로그온 자동 기동·AI 응답 | ⚠️ Partial | 2026-09-29 리허설 통과(로그인·어시스턴트). 이력서 분석·첫 백업/Deploy 뒤 AI 기록 없음 |
| SC-13 | 운영 이전 데이터 일치 | ✅ Met | `r3-pre` integrity ok, `--compare` same, `.sqlite` 해시 동일 |

**Success Rate**: 8/13 충족. 부분 3건과 미실시 2건은 모두 수동 측정·기록이 빠진 것이고, 기능은 테스트와 운영 사용으로 확인됐다.

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|--------|----------|:---------:|---------|
| [PRD] D2-개정 | 결재 엔진 제거, HR 상태 전환 즉시 반영 | ✅ | `app/hr-transitions.ts` 순수 문장 생성기 + `WHERE status IN (from, legacy)` + 409. 레거시 대기 행 0건이었다 |
| [PRD] D4 | 옛 테이블 DROP 없음 | ✅ | 재무·영업·결재 104개 테이블 잔존, 생성만 중단 |
| [Plan] D16 | R3 전까지 서버 PC 전용 | ✅ | R3 7단계 점검 PC 1대 → LocalSubnet 순서로 열었다 |
| [Plan] D17 | 브리지 파일 읽기 제거 | ✅ | `--tools ""` + 빈 임시 cwd + Origin/Host 검사 |
| [Plan] D18 | 별도 운영 폴더 | ✅ | `C:\xdm\prod`. 개발 폴더에는 운영 데이터가 없다 |
| [Plan] D19 | 시스템 시작 시 자동 기동 | ✅ | 로그온 없는 세션에서도 브리지 자격 증명 동작, 대체안 불필요 |
| [Design] D20 | 설계안 C(균형) | ✅ | `access-tabs.ts` 한 파일을 셸·서버가 공유, `authorizeErpRequest` 시그니처 유지 |
| [Design] D21 | 서버 PC 로그인만 잠금 면제 | ✅ | 관리자 1인 DoS 대응. 실패는 `lockExempt:true`로 감사 |
| [Design] D22 | `incentive-governance.tsx` 삭제 | ✅ | R1 일괄 삭제에 포함 |
| [Design] D23 | 감사·계정 관리는 관리자 전용, 브리지 허용 주소 확대 없음 | ✅ | `tab-permissions` #23, 앱 서버가 브리지를 대신 호출 |
| [Plan] D24 | 총무 탭은 다음 사이클 | ✅ | 범위를 바꾸지 않았고, 2026-09-30 별도 사이클로 시작(GA1) |
| [Plan] D25 | 로고 색 | ✅ | R3 셸 화면과 함께 `:root` 토큰 교체(`3144549`) |

---

## 2. Related Documents

| Phase | Document | Status |
|-------|----------|--------|
| PM | [xdnode-management.prd.md](../00-pm/xdnode-management.prd.md) | ✅ (T-01·T-08·Workstream R 정정) |
| Plan | [xdnode-management.plan.md](../01-plan/features/xdnode-management.plan.md) | ✅ v0.3(상태 동기화) |
| Design | [xdnode-management.design.md](../02-design/features/xdnode-management.design.md) | ✅ v0.1 검증 반영 + 릴리스 실행 기록 |
| Ops | [lan-operations-runbook.md](../lan-operations-runbook.md) | ✅ R3·R4, SC-7 기록 |
| Check | [xdnode-management.analysis.md](../03-analysis/xdnode-management.analysis.md) | ✅ 92% |
| Act | 이 문서 | ✅ |

---

## 3. Completed Items

### 3.1 Releases

| 릴리스 | 날짜 | 내용 | 커밋·태그 | 운영 반영 |
|---|---|---|---|---|
| R0 즉시 보안 | 2026-09-23 | dev `127.0.0.1`, explorer off, `DEV_FS_DENY`, 방화벽 18개 규칙 삭제·3000 규칙(꺼짐), 브리지 무도구·빈 cwd·Origin/Host 검사, 3110 기동 제외, 가드 테스트. 비밀값 폐기(사용자, 2026-10-02 확인) | `02f6ba5`에 포함 | 당일 dev 재기동 |
| R1 제거·PII 분리 | 2026-09-28 | 보관 태그·브랜치·정지 후 스냅샷, HR 7흐름 즉시 반영, 직접 SQL 5곳·급여 재무 3곳·영업 합산 제거, 플랫폼 DDL 중단, 셸 정리, `hr-company-data` `server-only` 분리, 120개 파일 삭제, 문서 47개 보관 | `815296a`·`3d3afad`·`f99c5f0`·`f6acb43`·`f203ede`·`064de27` | 개발 폴더 dev(R3 전까지) |
| R2 리네임 | 2026-09-28 | 제목·문구·패키지명, 시작 스크립트 이름, 바로가기, 식별자 불변 가드 | `c938ae9` | 개발 폴더 dev |
| R3 계정·탭 권한·운영 전환 | 2026-09-29 | 계정·세션·잠금(PBKDF2 100k), 탭 레지스트리·권한 가드, 로그인·첫 관리자·계정 관리 화면, local-peer 플러그인, preview 런타임, 운영 폴더 이전, LAN 개방 | `4311563`·`ce18f23`·`3144549`·`c250aab`, `r3-release-20260929` | 수동 전환(업무 외) |
| R4 운영 자동화 | 2026-09-29 | `-Headless`·pid·헬스체크·로그 회전, Stop, 매일 03:00 백업·검증·`ops_backup_runs`, 관리자 백업 경고, 자동 기동 작업, Deploy | `e8db142`·`9aeae85`·`245bf95`, `r4`·`r4.1`·`r4.2` | 첫 적용 수동, 이후 Deploy |
| R5 메신저 | 2026-09-29~30 | 채널·DM·스레드·멘션·첨부·검색·2초 폴링, 이후 말풍선·붙여넣기·@ 자동완성·마지막 대화 복원 | `f7bf9e9`·`b99695f`·`3bb2de7`·`750b4db`, `r5`·`r5.1`·`r5.2` | Deploy |
| R6 폴더 리네임 | 2026-10-01 | 개발 폴더 `XDNODE` → `xdnode-management`(사용자, `Rename-DevFolder.ps1`). 원격 저장소는 2026-10-02 `xdnode-management`로 변경 | `5ea505d`(기록) | 운영 무관(D18) |

### 3.2 Functional Requirements

FR-01~FR-21 모두 Done. FR별 근거는 [분석 §3](../03-analysis/xdnode-management.analysis.md#3-functional-requirements)에 있다. 요약은 다음과 같다.

| 묶음 | FR | 근거 |
|---|---|---|
| 제거 | FR-01~04 | `removal-guards`, `hr-api-integration` 'R1 …' 17건 |
| 리네임 | FR-05, FR-18 | `c938ae9`, R6 체크리스트 |
| 계정·권한 | FR-06~11, FR-16 | `auth-session` 25건, `tab-permissions` 20건, `access-policy` 14건, `shell-tabs` 7건 |
| 메신저 | FR-12~15 | `chat-api` 20건 |
| 운영 | FR-17, FR-19 | R3·R4 실행 기록, `lan-exposure-guards` 12건, `ops-scripts` 6건, `local-peer-plugin` 7건 |
| 데이터 보호 | FR-20, FR-21 | `bundle-exposure`, 브리지 가드 |

### 3.3 Non-Functional Requirements

| Item | Target | Achieved | Status |
|------|--------|----------|--------|
| 권한 없는 API | 403 | 매트릭스 테스트, fail closed | ✅ |
| 비밀번호 저장 | PBKDF2-SHA256 100,000 | 단언 테스트, 평문 0 | ✅ |
| 교차 출처 쓰기 | 403 | worker 층 + 인증 라우트 | ✅ |
| 보안 헤더 | nosniff·DENY·same-origin | `worker/index.ts` | ✅ |
| explorer·저장소 파일 | 항상 404/403 | R3·msg1 LAN 스모크 | ✅ |
| http LAN 호환 | `randomId()`·`copyText()` | `client-runtime.ts`, 녹음은 서버 PC 안내 | ✅ |
| 채팅 지연 | 3초 이내 | 측정 기록 없음(참고 1~3초) | ⏳ |
| poll p95 | ≤ 200ms | 측정 기록 없음(참고 78ms 1건) | ⏳ |
| 재시작 뒤 보존 | 세션·채팅·읽음 | SC-7 복구본에서 로그인·메신저 기록 확인 | ✅ |
| 백업 | 매일 성공 | 2026-09-29부터 날짜 폴더가 매일 쌓였고, 2026-10-02 03:00 결과 `OK`(작업 결과 0) | ✅ |
| 자동 기동 | 로그온 없이 | SC-12 리허설, 2026-10-02 실제 재부팅 | ✅ |
| Lint | 0 오류 | 소스 8건(사이클 전 코드), `eslint .`는 `tmp/` EPERM | ❌ |
| Tests | 전부 통과 | 릴리스마다 통과, 2026-10-02 514/514(build 불필요분) | ✅ |

### 3.4 Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| 인증·권한 | `app/auth-password.ts`, `app/auth-session.ts`, `app/access-tabs.ts`, `app/erp-platform.ts`, `app/api/{auth,me,admin}/**` | ✅ |
| 셸 | `app/page.tsx`, `app/auth-screens.tsx`, `app/session-client.ts`, `app/admin-accounts-workspace.tsx`, `app/client-runtime.ts` | ✅ |
| HR 전환 | `app/hr-transitions.ts`, `app/hr-company-catalogs.ts`, `app/api/compensation/**` | ✅ |
| 메신저 | `app/chat-schema.ts`, `app/chat-server.ts`, `app/chat-client.ts`, `app/chat-workspace.tsx`, `app/api/chat/**` | ✅ |
| 런타임 | `build/local-peer-vite-plugin.ts`, `vite.config.ts`, `worker/index.ts` | ✅ |
| 운영 스크립트 | `scripts/{Start,Stop,Backup,Deploy,Register}-XDNodeManagement*.ps1`, `write-dev-vars.mjs`, `verify-state-snapshot.mjs`, `reset-admin-password.mjs`, `xdm-login.mjs`, `sc4-hr-regression.mjs` | ✅ |
| 테스트 | `auth-session`, `tab-permissions`, `access-policy`, `shell-tabs`, `local-peer-plugin`, `lan-exposure-guards`, `removal-guards`, `bundle-exposure`, `admin-backups`, `ops-scripts`, `chat-api` 등 | ✅ |
| 문서 | PRD, Plan v0.3, Design, runbook, 분석, 이 보고서 | ✅ |
| 규모 | `02f6ba5..b08d517` 49커밋, 352파일 +23,453/−45,692(다음 사이클 총무·HR·메신저 개선 포함). R3까지는 288파일 +8,728/−45,599 | — |

---

## 4. Incomplete Items

### 4.1 Carried Over

| Item | Reason | Priority | Estimated Effort |
|------|--------|----------|------------------|
| `C:\xdm` ACL을 서버 사용자로 제한 | 상속 기본값(`Authenticated Users:(M)`)이다. 이 PC에는 `CodexSandboxOffline`·`CodexSandboxOnline` 로컬 계정이 있고, 백업에 급여·해시, 운영 폴더에 `.dev.vars`가 있다 | High | 관리자 작업 10분 + 백업·Deploy 확인 |
| 백업 2차 복사(`-MirrorRoot`) | 매체를 정하지 않아 작업에 넘기지 않았다. 백업이 같은 디스크에만 있다 | Medium | 매체 결정 뒤 재등록 10분 |
| AC 최대 절전 끄기 | `hibernate-timeout-ac`가 10,800초로 남았다(절전만 0) | Medium | 1분 |
| SC-4 최종 판정(다른 PC, 점검 인스턴스, 임금 계산 전용 계정) | R3 전환 기록에 없다 | Medium | 1시간 |
| SC-6·SC-11·SC-12 잔여 측정 | 정식 측정·기록을 하지 않았다 | Low | 운영 점검 1회 |
| lint 정상화 | `tmp/**` 무시, 기존 8건 | Low | 0.5시간 |
| 열린 질문 1: 저장된 snapshot 생년월일 정리 | 사용자 결정 필요 | Low | 결정 뒤 0.5일 |

### 4.2 Accepted Limitations

| Item | Reason |
|------|--------|
| 평문 HTTP | D10. Private·LocalSubnet만 허용, runbook §8에 명시 |
| 부수효과 GET(`applyDue*`) | 멱등이고 응답을 읽을 수 없다(부록 C #19) |
| 쿠키가 포트를 구분하지 않음 | 견적 툴(8765)이 쿠키를 받는다. Origin 검사로 CSRF 차단 |
| 계정 존재 노출(5회 뒤 429) | 사내 이메일은 이미 알려져 있다 |
| 매일 03:00 정지 백업 | 온라인 백업을 쓰지 않는다. 중단 약 20초 |
| HR 탭을 받으면 급여도 본다 | D12 |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final |
|--------|--------|-------|
| Design Match Rate | 90% | 92%(FR 100%, 체크리스트 92.8%, SC 73%) |
| Tests (`npm test`) | 전부 통과 | R1 298, R2 299, msg1 병합 528/528. 2026-10-02 514/514(build 불필요 25파일) |
| SC-4 HR 회귀(R1) | 전부 PASS | 기존 사본·새 DB 각각 48+4+13 |
| 운영 스모크 | 전 항목 | R3 7단계 전 항목, msg1 배포 뒤 LAN 스모크 전 항목 |
| 백업·복구 | 리허설 1회 | SC-7 차이 0 |
| 재부팅 | 무로그온 기동 | 2026-09-29 리허설 1분 35초 만에 ready, 2026-10-02 실제 재부팅 약 1분 30초 |
| Lint | 0 | 8(사이클 전 코드) |
| Security | 노출 0 | explorer·파일·번들·브리지 경로 모두 차단 확인 |

### 5.2 Resolved Issues

| Issue | Found in | Resolution |
|-------|----------|------------|
| `**/dist/**` 거부가 `node_modules/vinext/dist`까지 막아 dev가 멈춤 | R0 | 폴더 패턴을 `PROJECT_ROOT`에 묶었다 |
| preview `/__debug`가 devtools로 넘어감 | 스파이크 | 플러그인이 비루프백 `/__debug*` 404, `inspectorPort:false` |
| 새 DB에서 조직명 수정 500(`hr_payroll_records` 없음) | R1 SC-4 | 표가 있을 때만 갱신, 회귀 테스트 |
| 예시 데이터에 실명·실연봉 | R1 번들 검사 | '예시 직원A/B/C', 예시 거래 담당자는 불러온 목록에서 선택 |
| Windows 'Query User' `node.exe` 전 포트 허용 규칙 자동 생성 | R3 전환 | 지우고 3000 규칙에 프로그램 조건 `node.exe`를 붙였다 |
| 좁은 화면에서 '계정 관리' 탭이 잘림 | R3 전환 | 탭 줄이 잘리지 않고 가로로 스크롤되게 고쳤다(`e8db142`, R4) |
| HR 어시스턴트가 모든 질문에 '자료가 너무 큽니다' | R4 | `compactOperationsContext`(184.5KB → 27.2KB), r4.1 |
| 작업이 띄운 서버를 다른 세션에서 끌 수 없음(Deploy exit 3) | R4 | 감독자 + 정지 요청 파일, r4.2 |
| 메신저 effect 루프·빈 화면 | messenger-enhancement | 그 사이클에서 해결(R5 패턴) |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- 보안을 Design보다 먼저 닫았다(R0). 노출이 '위험'이 아니라 '발생 중'이라는 검토 결과를 그날 조치로 옮겼다.
- 스파이크(preview, 상태 경로, `.dev.vars`)를 R3 전에 해서 런타임을 실측으로 정했다. `vinext start`가 쓸 수 없다는 것도 이때 확정했다.
- 제거 전에 결합을 먼저 끊고(R1 M1-1), 사본 사전 조회로 레거시 행·영업 링크가 0건임을 확인한 뒤 지웠다. 120개 파일을 지우고도 HR 회귀가 없었다.
- 정지 후 스냅샷·`verify-state-snapshot --compare`·파일 해시로 데이터 이전을 검증했다. 이 도구가 R4 백업·SC-7 복구·Deploy 스냅샷까지 그대로 쓰였다.
- 소스 가드(`removal-guards`, `lan-exposure-guards`, 탭 레지스트리 가드)가 다음 사이클(총무·메신저 개선)의 회귀를 막았다.

### 6.2 What Needs Improvement (Problem)

- Plan 체크박스를 릴리스 때 갱신하지 않아 사이클 끝에 115개를 한꺼번에 대조했다. 실행 기록이 Design §11.5·§12에 흩어져 있었다.
- 운영 하드닝 중 '사용자와 함께 하는' 관리자 작업(ACL, 최대 절전, 2차 복사 매체)이 기록 없이 빠졌다. Design 기록은 '절전 0'만 적었다.
- 수동 SC(4·6·11·12)는 '다음에 확인'으로 넘긴 뒤 다시 잡히지 않았다.
- `npm run lint`가 작업 폴더의 비소스 산출물 때문에 깨져도 아무도 알아채지 못했다. 보고서들이 '변경 파일 lint 0'만 봤다.

### 6.3 What to Try Next (Try)

- 릴리스마다 Plan 체크박스와 FR 상태를 같은 커밋에서 갱신한다(Deploy 체크리스트에 한 줄).
- 관리자 권한이 필요한 운영 작업은 runbook에 '확인 명령'(`icacls`, `powercfg /q`, `Get-ScheduledTask … Actions`)까지 적고, 적용 기록에 그 출력을 남긴다.
- 수동 SC는 '운영 점검일'을 정해 한 번에 측정한다.
- lint 대상에서 비소스 폴더를 빼고, 전체 lint를 Deploy 전 확인에 넣는다.

---

## 7. Process Improvement Suggestions

| Phase | Current | Improvement Suggestion |
|-------|---------|------------------------|
| Plan | 체크박스가 릴리스 진행을 따라가지 않았다 | 릴리스 태그 커밋에 Plan 상태 갱신을 포함 |
| Do | 운영 관리자 작업이 대화 중에만 처리됐다 | runbook 확인 명령 + 실행 기록 |
| Check | 사이클 끝에 한 번 | 릴리스마다 짧은 Check(FR·SC 표만) |
| Ops | 수동 측정이 흩어짐 | 분기별 운영 점검(복구 리허설, 재부팅, SC-6·11) |

---

## 8. Next Steps

### 8.1 Immediate

- [ ] `C:\xdm` ACL 제한(관리자 PowerShell, 사용자와 함께). 적용 뒤 `Start-ScheduledTask XDnodeManagement-Backup` 1회로 확인
- [ ] `powercfg /change hibernate-timeout-ac 0`
- [ ] 2차 백업 매체를 정하고 `-MirrorRoot`로 작업 재등록
- [ ] 운영 점검 1회: SC-4(점검 인스턴스, 다른 PC, 임금 계산 전용 계정), SC-6(두 PC 10회), SC-11(파일 5종), SC-12 잔여(이력서 분석). 결과를 Design §11.5.9에 기록
- [ ] lint 정상화(`tmp/**` 무시, 기존 8건)

### 8.2 Branch and Repository

- 개발 브랜치 `codex/local-erp-updates-20260831`이 `main`보다 54커밋, `origin/codex/local-erp-updates-20260831`보다 50커밋 앞서 있다. `main`(`b5e9d1c`, 2026-08-31)에는 재무·영업이 있는 옛 상태가 남아 있다.
- 순서 제안: 원격에 브랜치 푸시 → `main` 병합(PR, 빨리 감기 가능) → 운영 폴더의 `origin`·태그 확인. 보관 태그 `erp-final-20260923`과 `archive/erp-finance-sales-20260923` 브랜치도 원격에 올린다.
- GitHub 저장소 이름은 2026-10-02 `Gwonchankim/xdnode-management`로 바꿨다(사용자). 개발 폴더 `origin`도 갱신했다.

### 8.3 Next PDCA Cycle

| Item | Priority | Expected Start |
|------|----------|----------------|
| 견적서 자동화 툴 탭 연결(D8). 레지스트리에 `quote` 탭과 `app/api/quote/**` 라우트를 더한다. 8765 견적 툴과 데이터 연결 방식(프록시·임베드·데이터 이전)부터 정한다 | High | `main` 병합 뒤 |
| `main` 병합과 원격 정리 | High | 즉시 |
| 운영 보완(§8.1) | High | 즉시 |
| 총무 탭 후속(GA 사이클, 알림 작업의 재부팅 경합 포함) | Medium | 진행 중 |
| 메신저 2단계(ERP 알림 봇, 레코드 카드) | Medium | messenger-enhancement SC-10 인터뷰 뒤 |

---

## 9. Changelog

### xdnode-management R0~R6 (2026-09-23 ~ 2026-10-01)

**Added:**
- 계정·세션(30일), 첫 관리자 부트스트랩(루프백·원자적), 계정 관리 탭, 감사 탭(관리자)
- 탭 레지스트리(`app/access-tabs.ts`)와 탭별 숨김·보기·편집 권한, fail-closed 가드
- local-peer Vite 플러그인, `vite preview` 운영 런타임, 운영 폴더 `C:\xdm\prod`
- 시작·정지·백업·Deploy·작업 등록 스크립트, 매일 백업과 관리자 백업 경고, 자동 기동
- 메신저 탭(채널·DM·스레드·멘션·첨부·검색·2초 폴링)
- 임금 계산 전용 최소 명부(`/api/compensation/roster`), http LAN 대체 경로(`randomId()`·`copyText()`)

**Changed:**
- 제품명 "XDnode management", 패키지 `xdnode-management`, 로고 색
- HR 결재 7흐름을 편집 권한자 즉시 반영으로
- 임금 계산 API를 `/api/compensation`으로 이동
- 어시스턴트 `sales` 모드를 `incentive`로, 맥락은 권한 검사를 마친 JSON만
- dev는 `127.0.0.1:3100` 개발 전용

**Removed:**
- 재무·영업·결재·데이터 거버넌스·마스터 영향·워크벤치(파일 120개, 라우트 44개), `chatgpt-auth.ts`, 역할 6종, `Package-XDNodeDemo.ps1`
- Miniflare explorer 노출, 저장소 파일 서빙, 번들 PII, 브리지 파일 읽기

**Fixed:**
- 성과 이의제기 '수용'이 서버가 받지 않는 값을 보내던 문제
- 새 DB에서 조직명 수정 500

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-10-02 | Completion report created(상태 동기화 Check 92% 반영) | gc.kim / Claude Code |
