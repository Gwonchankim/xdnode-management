# xdnode-management Gap Analysis (Check)

> **Feature**: xdnode-management · **Date**: 2026-10-02 · **Commit analysed**: `b08d517`(개발 폴더 HEAD) · **운영**: `C:\xdm\prod` = `msg1-release-20261001`(`c09eb32`)
> **Plan**: [xdnode-management.plan.md](../01-plan/features/xdnode-management.plan.md)(v0.3, 이 분석으로 상태 동기화) · **Design**: [xdnode-management.design.md](../02-design/features/xdnode-management.design.md)(v0.1 검증 반영) · **Runbook**: [lan-operations-runbook.md](../lan-operations-runbook.md)

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 접속자 전원이 같은 신원(최고 권한)이라 책임 추적이 안 됐다. LAN explorer·파일 서빙, 번들 PII, 어시스턴트 파일 읽기로 급여·인사 데이터가 실제로 노출돼 있었다. 쓰지 않는 재무·영업·결재 기능이 많았고 팀 대화가 도구 밖에 흩어져 있었다. |
| **WHO** | 경영지원실 5~6명. 관리자 1명(gc.kim)이 계정·권한을 관리한다. |
| **RISK** | 제거 작업의 HR 회귀, 탭만 숨기고 API로 새는 권한, 첫 관리자 위조, 서버 PC 단일 장애점 |
| **SUCCESS** | 권한 없는 탭은 DOM에 없고 API는 403. `dist/client` 실데이터 0건. 다른 PC에서 explorer·저장소 파일 404/403. 감사 actor가 실제 사용자. 백업 복구·재부팅 리허설 성공 |
| **SCOPE** | R0 즉시 보안 → R1 제거·PII 분리 → R2 리네임 → R3 계정·탭 권한·preview 운영 전환 → R4 백업·자동 기동 → R5 메신저 → R6 폴더 리네임 |

## 1. Match Rate

| 축 | 결과 | 비고 |
|---|---|---|
| FR 충족 | **21/21 (100%)** | 모든 FR에 검증 테스트나 운영 기록이 있다(§3) |
| Plan 체크리스트 | **128/138 (92.8%)** | 전체 139개 중 해당 없음 1개(`conventions.md`) 제외. 남은 10개는 §2.2 |
| Success Criteria | **8/13 충족, 3 부분, 2 미실시 (73%)** | 부분은 0.5로 계산. §4 |
| **종합** | **92%** | FR×0.4 + 체크리스트×0.4 + SC×0.2 = 40 + 37.1 + 14.6 |
| 하니스·소스 가드 테스트 | 514/514 통과 | 2026-10-02, build가 필요 없는 25개 파일. `rendered-html`·`bundle-exposure`는 다른 에이전트와 build가 겹치지 않게 돌리지 않았다. 두 파일은 릴리스마다 `npm test`로 통과했다(msg1 병합 528/528) |
| 운영 점검(읽기 전용) | 통과 | `/api/me` 401, explorer(Host 위조) 404, 3000 규칙 Private·LocalSubnet·켜짐, portproxy 없음, 고정 IP, 03:00 백업 `OK`, 08:58 재부팅 뒤 자동 기동 |
| Lint | **미충족** | §2.2 G-6 |

판정 방법: Plan의 체크박스·FR·SC 각각에 대해 코드(`app/`, `scripts/`, `build/`, `worker/`, `vite.config.ts`), 테스트 제목과 실행 결과, 커밋, Design의 '실행 결과' 기록(§11.5.9 R3·R4·R5, §12.1·§12.4·§12.5·§12.7·§12.8), runbook(§11 SC-7 기록), 운영 PC 읽기 전용 점검을 대조했다. 근거가 있는 항목만 Plan에서 `[x]`로 바꿨고 근거를 괄호에 적었다.

## 2. Gaps

### 2.1 Design과 다르게 구현된 점 (의도된 변경, 문제 아님)

| 항목 | Plan/Design | 구현 | 판정 |
|---|---|---|---|
| 루프백 로그인 잠금 | Plan M3 '서버 PC 로그인에도 잠금' | D21: 로그인만 면제, 실패는 기록(`auth-session` #7) | 결정 D21로 대체 |
| 부수효과 GET | Plan M3 '검사 적용 또는 POST로' | GET 유지, runbook §8 한계 기록 | Design 부록 C #19로 대체 |
| 하니스 `setIdentity` shim | §4.2 ② '호환 shim으로 남긴다' | r3-tabs에서 삭제(`removal-guards` 'R3 r3-tabs') | 모든 테스트가 `setAccess`로 옮겨 불필요 |
| lockfile 재생성 | R2 '재생성' | 루트 name·engines만 수정 | 의존성 변화 없음(Design §12.8) |
| 재무 헬퍼 삭제 시점 | M1-2 | `r1-delete`(`f203ede`) | 빌드 순서 때문(Design §12.4) |
| local-peer 플러그인 범위 | `/cdn-cgi/*` 404, upgrade 차단 | `/__debug*` 404, 비루프백 부트스트랩 403, 경로 정규화 추가 | 스파이크 발견 반영(부록 C #3) |
| 감독자 | R4 Start/Stop | `Start -Headless`가 감독자로 남고 Stop은 요청 파일을 쓴다(r4.2) | 다른 로그온 세션에서 `taskkill`이 거부돼 추가 |
| 탭 레지스트리 | `hr`·`compensation`·`chat`·`audit`·`admin` | 다음 사이클에 `general`(총무)이 같은 방식으로 추가 | FR-16의 실증 |

### 2.2 남은 항목 (Plan에서 `[ ]`로 둔 것)

| # | 심각도 | 항목 | 근거(2026-10-02 확인) | 권장 조치 |
|---|---|---|---|---|
| G-1 | **High** | `C:\xdm` 전체 ACL이 서버 사용자로 제한되지 않았다(Design §11.5.1, Plan R4·M1-4) | `icacls C:\xdm`, `C:\xdm\backup`, `C:\xdm\archive\finance-data-20260923`: 상속 기본값 `Authenticated Users:(M)`, `Users:(RX)`. 이 PC에는 다른 로컬 계정(`CodexSandbox*`)이 있다. 백업에는 급여·비밀번호 해시·세션 해시가, 운영 폴더에는 `dist\server\.dev.vars`(Cloudflare 토큰)와 `.wrangler\state`가 있다 | 관리자 PowerShell에서 `C:\xdm` 상속을 끊고 서버 사용자·SYSTEM·Administrators만 남긴다. 작업 스케줄러 작업이 같은 사용자로 돌므로 영향은 없다. 적용 뒤 백업·Deploy 1회 확인. **2026-10-07 해결**: 관리자 PowerShell에서 `scripts/Set-XdmAcl.ps1`로 `C:\xdm` 상속을 끊고 SYSTEM·Administrators·`DESKTOP-HVUV0RL\user`만 남겼다(하위 34,521개 파일 재설정, 실패 0, 넓은 권한이 남은 폴더 0). 되돌리기 파일 `C:\xdm-acl-backup-20261007-1053.txt`. 적용 직후 3000 `/api/me` 401, 3150 health 정상, 서버 사용자 쓰기 확인 |
| G-2 | Medium | 백업 2차 복사(⑦)가 설정되지 않았다 | `XDnodeManagement-Backup` 인자에 `-MirrorRoot` 없음. 백업은 서버 PC 같은 디스크에만 있다 | 외장 드라이브·NAS를 정하고 `Register-XDNodeManagementTasks.ps1`에 `-MirrorRoot`를 넘기도록 재등록 |
| G-3 | Medium | AC 최대 절전이 꺼지지 않았다 | `powercfg`: AC 절전 0, AC 최대 절전 10,800초. Design 기록은 '절전 0'만 적었다. Windows Update 사용 시간은 07:00~01:00(08~20시 포함, 충족) | `powercfg /change hibernate-timeout-ac 0`(관리자) |
| G-4 | Medium | SC-4 최종 판정(R3, 다른 PC·점검 인스턴스)과 '임금 계산 전용 계정' 단계 기록이 없다 | Design §11.5.9 R3 결과에 SC-4가 없다. R1 서버 PC 판정은 통과(§12.7) | 다음 배포 전에 점검 인스턴스(3001)에서 `sc4-hr-regression.mjs`를 점검 PC로 1회 실행 |
| G-5 | Low | SC-6(두 PC 10회 3초)·SC-11(어시스턴트 파일 5종)·SC-12 일부(이력서 분석, 첫 백업·Deploy 뒤 AI)가 측정·기록되지 않았다 | §4 | 운영 점검 1회에 묶어 측정하고 Design에 기록 |
| G-6 | Low | `npm run lint` 0건이 아니다 | `eslint .`는 추적되지 않는 `tmp/radar-test-*` 폴더 EPERM으로 멈춘다. 소스 폴더만 돌리면 8건(`incentive-calculator.tsx` 2, `claude-assistant-bridge.mjs` 1, `codex-assistant-bridge.mjs` 3, `erp-platform.test.mjs` 2). 모두 사이클 전 코드(`git blame` 2026-08-16~09-14). messenger 보고서의 '원래 있던 4건'은 스크립트 4건을 빼고 센 수다 | `eslint.config.mjs`에 `tmp/**` 등 비소스 폴더 무시를 더하고 8건을 고친다(별도 소규모 작업) |

### 2.3 코드에서 찾은 문제

설계 대비 기능 결함은 찾지 못했다. 운영 관점에서 두 가지를 기록한다.

| 항목 | 내용 | 판정 |
|---|---|---|
| 총무 알림 작업의 재부팅 경합 | 2026-10-02 08:58 재부팅 뒤 `XDnodeManagement-Alerts`(09:00)가 서버 ready(09:00:20)보다 먼저 돌아 `status 0`으로 실패했다(작업 결과 1). `Start -Headless`가 ready 직후 다시 불러 정상 처리됐다(`ga-alerts: … alreadyRan=False`) | 데이터 손실 없음. 총무 사이클 범위. 작업 스케줄러에 실패로 남으므로, 연결 실패면 몇 초 재시도하거나 실패 코드를 0으로 두는 개선을 총무 후속으로 넘긴다 |
| Design 열린 질문 1 | 과거 LOAD_HR로 저장된 `hr_compensation_lines.snapshot_json`의 생년월일. 출력은 비우지만(`tab-permissions` #29) 저장값 일괄 정리는 정하지 않았다 | 사용자 결정 필요(다음 사이클 후보) |

문서 불일치(이 분석에서는 고치지 않음): PRD §2 표의 `incentive-governance.tsx` '유지' 한 줄(D22로 삭제됨), Design §11.5.10 R6 체크박스(실제로는 완료, Plan R6에 기록).

## 3. Functional Requirements

| FR | 릴리스 | 상태 | 근거 |
|---|---|---|---|
| FR-01 제거, 삭제 API 404 | R1 | ✅ | `f203ede`(190파일 −41,888줄), `removal-guards`, `rendered-html` 404 |
| FR-02 HR 7흐름 즉시 반영·레거시 | R1 | ✅ | `app/hr-transitions.ts`, `hr-api-integration` 'R1 flow 1~7'·'legacy decisions' |
| FR-03 재무·결재 없는 새 DB | R1 | ✅ | 'R1 fresh database', 'R1 flow 4', 'R1 platform' |
| FR-04 영업 없이 임금·인센티브 | R1 | ✅ | 'R1 compensation CONFIRM…', `ASSISTANT_MODULES` incentive |
| FR-05 리네임, 식별자 불변 | R2 | ✅ | `c938ae9`, `removal-guards` R2 |
| FR-06 로그인·세션·잠금·PBKDF2 | R3 | ✅ | `auth-session` #5~#15, R3 운영 로그인 |
| FR-07 첫 관리자 루프백·원자적 | R3 | ✅ | `auth-session` #1~#4, `local-peer-plugin` |
| FR-08 계정 관리 | R3 | ✅ | `auth-session` #14·#18·#19, `tab-permissions` #20 |
| FR-09 허용 탭만 렌더 | R3 | ✅ | `shell-tabs` #1~#4 |
| FR-10 서버 탭 권한·fail closed·전용 명부 | R3 | ✅ | `tab-permissions` #22~#30·소스 가드, `access-policy` |
| FR-11 감사 actor·보안 이벤트 | R3 | ✅ | `auth-session` #5·#9·#16·#16b |
| FR-12 채널·DM·스레드·멤버 검사 | R5 | ✅ | `chat-api` #39~#41·#47 |
| FR-13 첨부 25MB·attachment·nosniff | R5 | ✅ | `chat-api` #50·#51 |
| FR-14 멘션·안 읽은 수·제목 | R5 | ✅ | `chat-api` #43·#48. SC-6 정식 측정은 G-5 |
| FR-15 수정·삭제·검색 | R5 | ✅ | `chat-api` #44·#45 |
| FR-16 탭 추가 구조 | R3 | ✅ | `access-tabs.ts` 레지스트리, 총무 탭 실증 |
| FR-17 preview 운영·백업·복구·자동 기동 | R3·R4 | ✅ | R3·R4 기록, SC-7·SC-13, 매일 백업 `OK`, 재부팅 자동 기동. 운영 보완 G-1~G-3 |
| FR-18 폴더 리네임 | R6 | ✅ | 2026-10-01 `Rename-DevFolder.ps1`, 2026-10-02 확인 |
| FR-19 노출 차단 | R0 | ✅ | `vite.config.ts`, `lan-exposure-guards`, R3 스모크 |
| FR-20 PII 서버 전용 | R1·R3 | ✅ | `hr-company-data.ts` `server-only`, `bundle-exposure`, 전용 명부 |
| FR-21 브리지 파일 읽기 없음 | R0 | ✅ | `--tools ""`, 빈 임시 cwd, `lan-exposure-guards`. SC-11 정식 실행은 G-5 |

## 4. Success Criteria

| SC | 상태 | 근거 |
|---|---|---|
| SC-1 FR 검증 수단 전부 통과 | ⚠️ 부분 | FR 21개 검증 통과. SC-4·6·11·12 수동 판정 일부가 남음 |
| SC-2 권한 매트릭스(DOM·API) | ✅ | `tab-permissions` #22·#23, `shell-tabs`, `chat-api` #49, R3 스모크(URL 조작) |
| SC-3 두 계정 감사 actor 구분 | ✅ | `auth-session` #16 |
| SC-4 HR 회귀 | ⚠️ 부분 | R1 서버 PC: 기존 사본·새 DB 48+4+13 PASS. R3 다른 PC 최종 판정 기록 없음(G-4) |
| SC-5 다른 PC 로그인·어시스턴트·이력서 | ✅ | R3 7단계 점검 PC 192.168.0.98 |
| SC-6 채팅 3초(두 PC 10회) | ❌ 미측정 | 참고값: 개발 서버 상대 poll 수신 78ms, 브라우저 QA 1~3초(서버 PC 두 계정) |
| SC-7 백업 복구 | ✅ | 2026-10-01 staging 복구: integrity ok, 테이블 185·행 10,206 차이 0, R2 154 누락 0, 로그인·HR·메신저·첨부 |
| SC-8 보관 태그·브랜치·스냅샷 | ✅ | `erp-final-20260923`, `archive/erp-finance-sales-20260923`, `r1-pre-20260928-1109` |
| SC-9 다른 PC 파일·explorer 404/403, 번들 0건 | ✅ | R3 스모크, msg1 배포 뒤 LAN 스모크, `bundle-exposure` |
| SC-10 위조·교차 출처·동시 오답 | ✅ | `auth-session` #2·#3·#6·#10 |
| SC-11 어시스턴트 파일 5종 | ❌ 미실시 | 구조적 차단(`--tools ""`)과 가드 테스트만 있음 |
| SC-12 재부팅 무로그온 | ⚠️ 부분 | 2026-09-29 리허설 통과(로그인·어시스턴트). 이력서 분석·첫 백업/Deploy 뒤 AI 기록 없음. 2026-10-02 실제 재부팅에서도 자동 기동 |
| SC-13 운영 이전 데이터 일치 | ✅ | `r3-pre` integrity ok, `--compare` same, `.sqlite` 해시 동일 |

## 5. Known Follow-ups

- G-1 ACL 제한(가장 먼저). G-2 2차 복사 매체 결정. G-3 최대 절전 끄기.
- 다음 운영 점검 1회에 SC-4(점검 인스턴스, 다른 PC), SC-6, SC-11, SC-12 남은 부분을 묶어 측정하고 Design §11.5.9에 기록한다.
- lint 정상화(G-6): `tmp/**` 무시, 기존 8건 수정.
- 개발 브랜치 `codex/local-erp-updates-20260831`이 `main`보다 54커밋, 원격 같은 브랜치보다 50커밋 앞서 있다. 푸시와 `main` 병합이 남았다(보고서 §8).
