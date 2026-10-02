# quote-tool Planning Document

> **Summary**: 바탕화면의 독립 견적서 자동화 툴(`C:\Users\user\Desktop\견적서 자동화`, FastAPI·Python·0.0.0.0:8765·인증 없음)을 XDnode management 안으로 **완전히** 옮긴다. 화면·로직·데이터를 새 탭 `quote`(모듈 `quote`, `app/api/quote/**`, 테이블 `quote_*`)로 다시 만들고, 엑셀 생성은 TS(fflate 템플릿 패치)로, PDF만 서버 PC의 작은 Excel COM 도우미로 남긴다. 옮긴 뒤 8765 서비스·방화벽 규칙·예약 작업을 폐기한다.
>
> **Project**: XDnode management
> **Version**: 0.2
> **Author**: gc.kim / Claude Code
> **Date**: 2026-10-02
> **Status**: Draft
> **근거**: PRD [xdnode-management.prd.md](../../00-pm/xdnode-management.prd.md) D8(:226, "툴이 안정화된 뒤 별도 PDCA"), 상위 계획 [xdnode-management.plan.md](xdnode-management.plan.md) :50·:429·FR-16(:466), 탭 추가 규칙([CLAUDE.md](../../../CLAUDE.md) "How to add a tab")
> **사용자 결정(2026-10-02)**: 완전 내재화(QT-D1), PDF는 로컬 Excel COM 도우미(QT-D2), 챗봇은 웹 검색 없이 내부 자료만(QT-D3), 데이터는 한 번에 모두 D1로 이전(QT-D4), 사용자는 탭 권한을 받은 경영지원실 계정이고 작성자는 로그인 계정(QT-D5)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 견적 툴은 별도 PC 프로그램(Python 3.12+ + FastAPI + openpyxl + Excel COM + Claude CLI)으로 `0.0.0.0:8765`에 떠 있고 로그인이 없다. 사내망 누구나 고객 연락처가 든 견적·과거 코퍼스를 읽고, 담당자 목록을 덮어쓰고, 생성 파일을 이름만으로 내려받을 수 있다. `?file=` 경로 검사가 없어 서버 PC의 임의 xlsx를 읽힐 수 있다(`app/main.py:247`). 이미지 추출은 `Read` 도구를 `bypassPermissions`로 켠 채 돌고(`quote_gen/extract_cli.py:55`), 챗봇은 `WebSearch/WebFetch`를 켠 채 돈다(`quote_gen/chat.py:126`). 데이터(SQLite 1.6 MB + JSON 카탈로그 5종)는 XDnode management 백업(R4)에 들어가지 않고, 회귀 테스트가 기대는 원본 견적 1,003건(581 MB)은 `Downloads` 폴더에만 있다. 작성자는 브라우저 localStorage의 이름 선택이다(`app/static/index.html:531-547`). |
| **Solution** | XDnode management에 견적 탭 `quote`를 레지스트리 1항목으로 더하고(FR-16), FastAPI 20개 경로를 `app/api/quote/**` 라우트로, `quote_gen/*.py`를 순수 TS 모듈(`app/quote-*.ts`)로, `index.html`(1,635줄)을 React 화면으로 옮긴다. `corpus.sqlite` 6개 테이블과 카탈로그 JSON·담당자 목록을 앱 API를 거쳐 D1 `quote_*` 테이블로 한 번 이전한다. 생성 파일은 R2 `quote/` 접두사에 둔다. xlsx는 템플릿 zip을 fflate로 패치해 1~20행(로고·직인·머리글)을 바이트 그대로 두고 21행 이하만 다시 쓴다. PDF는 `127.0.0.1` 전용 Excel COM 도우미가 맡는다. 추출·상담은 기존 브리지 방식(도구 모두 끔, 이미지 stdin, Origin 거부)으로 바꾼다. |
| **Function/UX Effect** | 견적 담당자는 XDnode management에 로그인한 채 같은 화면에서 견적을 쓰고, 과거 견적·단가 제안·구성 추천·상담을 쓴다. 담당자 블록은 목록에서 고르지만 기록의 작성자는 로그인 계정으로 남는다. 견적 생성·확정·폐기·담당자 변경은 감사 로그에 남는다. 서버 PC에 Python을 따로 깔고 유지할 필요가 없어진다. |
| **Core Value** | 고객·단가 데이터를 인증·권한·감사·백업 안으로 들인다. 견적 툴의 실측 기반 판단 규칙(신뢰도 게이트·중복 억제·상태 불변식)을 회귀 기준으로 고정해 옮기는 동안 잃지 않는다. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 인증 없는 LAN 서비스에 고객 연락처·단가·마진이 있다. 데이터가 백업·감사 밖에 있다. 서버 PC가 두 런타임(Node·Python)과 두 개의 상시 서비스를 돌린다 |
| **WHO** | 경영지원실 견적 대행 담당(편집), 실장·대표(보기), 관리자(전체). 견적서에 찍히는 '담당자'는 영업 담당자(기본 임영민 팀장)이고, 작성자와 다를 수 있다(대행 모델, 툴 `docs/06_대행자_온보딩.md`) |
| **RISK** | 엑셀 양식 충실도(openpyxl → 손으로 쓰는 XML), Excel COM의 세션 의존(자동 기동 작업은 비대화형), 병행 기간 데이터 갈라짐, 고객·직원 PII의 클라이언트 번들 유출, 고객 메일·스크린샷의 프롬프트 주입, 유사도 함수(파이썬 `difflib`) 이식 오차로 단가 이력이 갈라지는 것 |
| **SUCCESS** | 회귀 5건에서 TS 생성 xlsx의 계산값이 파이썬 출력과 같다. 상태·중복 억제 불변식과 제안 키 계약이 하니스 테스트로 통과한다. 이전한 행 수가 원본과 같다. 권한 없는 계정은 탭·API 모두 막힌다. 실제 견적 3건을 새 탭에서 끝까지 낸다. 8765 서비스·방화벽 규칙·예약 작업이 사라진다 |
| **SCOPE** | 여섯 릴리스(QT0~QT5). 새 탭 1개, 라우트 약 14개, 테이블 약 14개, 로컬 도우미 2개(AI 브리지 경로·PDF). 기존 스키마는 건드리지 않는다(추가만, D4) |

---

## Decision Record

| ID | 결정 | 근거 |
|----|------|------|
| QT-D1 | **완전 내재화.** 프록시·iframe으로 8765를 감싸지 않는다. UI·로직·데이터를 이 저장소로 옮긴다. 탭 키 `quote`, 모듈 `quote`, 라우트 `app/api/quote/**`, 테이블 `quote_*`. 스키마는 `app/quote-schema.ts`의 라우트 공용 `ensureQuoteSchema`에 둔다(`app/ga-schema.ts:202` `ensureGaSchema`와 같은 방식) | 2026-10-02 사용자 결정 |
| QT-D2 | **PDF는 서버 PC의 작은 Excel COM 도우미가 만든다.** `scripts/`에 두고 기존 브리지와 같은 규칙(127.0.0.1 바인딩, 요청 크기 상한, 한 번에 하나, Origin 있으면 거부, Host 허용 목록)을 따른다. 하는 일은 xlsx→PDF 변환뿐이다. **xlsx 자체는 TS에서 템플릿을 패치해 만든다**(fflate는 이미 의존성이고 `app/hr-employment-contract.ts:268-275`가 docx에서 같은 방식을 쓴다). 로고·직인 이미지는 템플릿 그대로 보존한다 | 2026-10-02 사용자 결정 |
| QT-D3 | **상담 챗봇은 웹 검색을 하지 않는다.** 열려 있는 견적과 내부 데이터(카탈로그·단가 이력·구성 라이브러리)로만 답한다. 도구는 D17대로 모두 끈다. 브리지 기반 시설을 재사용한다 | 2026-10-02 사용자 결정, 상위 D17 |
| QT-D4 | **데이터는 한 번에 모두 D1로 옮긴다.** `corpus.sqlite`의 테이블 전부, 카탈로그 JSON, 담당자 목록. 전환 뒤 파이썬 코퍼스 재구축 도구(`tools/build_*.py` 등)는 폐기한다 | 2026-10-02 사용자 결정 |
| QT-D5 | **사용자는 경영지원실 계정이고 탭 권한(none·view·edit)으로 연다.** 기록의 작성자는 로그인 계정이다. 자유 입력 작성자(현재 `RecordReq.author`, `app/main.py:171`)는 없앤다 | 2026-10-02 사용자 결정 |

### Plan 체크포인트 결정 (2026-10-02)

> 2026-10-02 사용자가 QT-Q1~Q15를 **모두 권장안대로** 확정했다. 아래 표의 "권장안" 열이 결정이고, "다른 선택지"는 기각 기록으로 남긴다. 본문의 "권장안" 표현도 같은 뜻이다.


| ID | 질문 | 권장안(= 결정) | 다른 선택지(기각) |
|----|------|--------|-------------|
| QT-Q1 | 생성한 xlsx·PDF를 어디에 두나 | R2 `quote/issued/<issuedId>/<rev>.xlsx|.pdf`. 다운로드는 `GET /api/quote/files`가 권한 확인 뒤 `attachmentDownloadHeaders`(`app/attachment-rules.ts:48`)로 내려준다. R4 백업이 R2 전체를 복사하므로(runbook §10 3단계) 따로 할 일이 없다 | D1 BLOB(행 크기 부담), 매번 다시 생성(PDF 도우미가 꺼져 있으면 못 받음) |
| QT-Q2 | 견적 템플릿(`assets/template/견적서_템플릿.xlsx`, 직인 PNG 포함)을 어디에 두나 | QT1 이전 때 R2 `quote/template/v1.xlsx`로 올리고 sha256을 `quote_meta`에 적는다. 라우트는 해시가 맞을 때만 쓴다. 직인 이미지가 `public/`이나 클라이언트 번들에 들어가지 않는다 | 저장소에 server-only 자산으로 커밋(직인이 git·`dist/server`에 남음) |
| QT-Q3 | 담당자 목록(`data/staff.json` 10명)과 계정의 관계 | 견적서에 찍히는 '담당자 블록'(이름+직함·휴대폰·메일)은 `quote_staff_profiles`로 남기고 편집 권한자가 관리한다. 작성자는 따로 `author_account_id`로 남긴다. 대행 모델이라 둘은 다르다. 프로필에 계정을 선택 연결해 기본값으로만 쓴다 | 담당자 블록을 계정+인사기록에서 자동 생성(`auth_accounts`에 전화 열이 없고(`app/auth-session.ts:84-101`), 영업 담당자 상당수는 계정이 없다) |
| QT-Q4 | 중복 억제 키(`make_dedup_key`, 툴 `quote_gen/store.py:138-149`)의 '작성자' 재료 | 지금처럼 **찍히는 담당자 이름**을 쓴다. 옛 툴의 `author`가 곧 고른 담당자 이름이었으므로 이전한 키가 그대로 유효하다. 로그인 계정은 키에 넣지 않고 열로만 남긴다 | 계정 id로 바꿈(이전 키 재계산 필요, 같은 견적을 두 사람이 만들면 두 행) |
| QT-Q5 | 전환(동결) 날짜와 8765 폐기 | QT3 운영 반영일에 옛 툴을 **읽기 전용**으로 돌리고(QT0의 스위치), QT5에서 동결→차분 이전→8765 정지→예약 작업 `XDNODE 견적서 서버` 삭제→방화벽 규칙 `XDNODE Quote 8765` 삭제→바탕화면 아이콘 제거. 날짜는 사용자가 정한다(업무 시간 밖) | 두 툴 병행 쓰기 1~2주(갈라짐을 사람이 맞춰야 함) |
| QT-Q6 | 전환 전 옛 툴을 임시로 막을 것인가(QT0) | 반나절짜리 최소 보강을 한다: ① `?file=` 경로 탈출 차단 ② 추출의 `Read`+`bypassPermissions` 제거 ③ 챗봇 웹 도구 제거(QT-D3를 미리 적용) ④ Host 허용 목록·교차 출처 POST 거부 ⑤ 읽기 전용 스위치 ⑥ 원본 코퍼스 폴더를 접근 제한 보관 폴더로 복사 | 하지 않고 QT5까지 그대로 둠(노출이 몇 주 더 열려 있음) |
| QT-Q7 | 도우미를 어디서 돌리나 | AI(추출·상담)는 새 브리지 `scripts/claude-quote-bridge.mjs`(127.0.0.1:3140), PDF는 별도 `scripts/quote-pdf-helper.mjs`(127.0.0.1:3150, Excel COM은 PowerShell 자식 프로세스). Claude 실행부는 `scripts/lib/claude-cli.mjs`로 빼서 3120·3130·3140이 함께 쓴다 | 3120 이력서 브리지에 경로 추가(바쁨 플래그 하나를 이력서·총무·견적이 나눠 써 429가 잦아짐, `scripts/claude-resume-bridge.mjs:35`·`:202`), PDF도 브리지 안에(Excel 수명과 Claude 수명이 섞임) |
| QT-Q8 | Excel COM을 어떤 세션에서 돌리나 | QT2 첫날 시험: `XDnodeManagement-Autostart`(로그온 여부와 관계없이 실행, runbook :161)가 띄운 도우미에서 `ExportAsFixedFormat`이 되는지 본다. 안 되면 도우미만 '로그온 시' 작업으로 분리하고 Windows 자동 로그온을 켠다(D19의 대안 경로와 같다). 지금 옛 툴은 '로그온 시 + 최고 권한' 작업이다(툴 `docs/03_사무실_공동사용_방안.md`) | LibreOffice 변환(레이아웃이 달라짐, 툴 문서가 이미 지적) |
| QT-Q9 | 회귀 합격 기준 | 아래 QT-SC-01: ① TS 출력 대 파이썬 출력 계산값 차이 0(A1:I45, H14 제외) ② 원본 대비 차이는 파이썬과 같은 4건(`tests/regression.py:127` `BASELINE_DIFFS`) ③ 병합 집합 동일 ④ Excel이 '복구' 없이 연다 ⑤ PDF 1쪽, 5건을 사용자가 눈으로 확인 | ①만 기계 판정 |
| QT-Q10 | 원본 코퍼스 파일(xlsx 1,003 + PDF 1,080, 581 MB, `Downloads`)을 어떻게 하나 | 앱에는 옮기지 않는다. QT1에서 파이썬 `reverse.py`로 파일별 Quote JSON을 한 번 만들어 `quote_corpus_files.quote_json`에 넣는다(과거 견적 '불러오기'는 이것으로 한다). 원본 폴더는 `C:\xdm\archive\quote-corpus\`(ACL 제한)로 복사해 보관 | 원본을 R2 `quote/corpus/`에 올림(백업이 581 MB 늘어남), '파일' 불러오기를 없앰 |
| QT-Q11 | 읽기만 하는 POST(단가 제안·비교 구성 계산)의 감사 | `app/api/quote/compute/route.ts` 한 파일에 모으고 `tests/erp-platform.test.mjs`의 무감사 예외에 '읽기 전용 계산'으로 추가한다. 대신 이 파일에 INSERT·UPDATE·DELETE가 없다는 소스 가드를 둔다 | 호출마다 감사 행(편집할 때마다 수십 행) |
| QT-Q12 | 보기 권한이 마진(매입단가·마진율)을 보나 | 보기 권한에는 마진 열과 '마진계산용' 시트를 주지 않는다. xlsx 다운로드도 보기 권한은 견적 시트만 받는다(PDF와 같은 범위) | 보기도 전부 봄 |
| QT-Q13 | 파이썬 도구 폐기 뒤 새 제품 표기 정규화(`data/normalized/*.json`, 툴 FR-13)는 누가 하나 | 이번 범위 밖. 카탈로그는 이전 시점에 고정되고, 단가 최신화는 `quote_price_log`가 맡는다. 정규화 화면은 후속 사이클 후보로 남긴다 | 이번에 정규화 편집 화면까지 만든다 |
| QT-Q14 | API 키 백엔드(`ANTHROPIC_API_KEY`, 툴 `quote_gen/extract.py:19-28`)를 유지하나 | 버린다. 다른 브리지와 같이 서버 PC의 로그인된 Claude CLI만 쓴다. `.dev.vars` 허용 목록(`scripts/write-dev-vars.mjs:13-19`)도 늘리지 않는다 | 유지(비밀값 관리 대상이 늘어남) |
| QT-Q15 | 탭 이름·위치 | 라벨 '견적', 총무 다음, 관리자 탭 앞. glyph는 Design에서 | — |

---

## 1. Overview

### 1.1 Purpose
견적 대행 업무를 XDnode management 안에서 끝내게 한다. 옛 툴의 기능을 빠짐없이 옮기되, 인증·권한·감사·백업·LAN 노출 규칙을 이 저장소의 기준으로 맞춘다.

### 1.2 Background (2026-10-02 실측)

**옛 툴의 구성**
- 서버: `app/main.py` 352줄, FastAPI 경로 20개(아래 §3 표). `/files`(`:37`)와 `/static`(`:38`)을 정적 서빙한다.
- 화면: `app/static/index.html` 1,635줄, 바닐라 JS. 문자열로 HTML을 만들어 `innerHTML`에 넣는다.
- 로직: `quote_gen/` 14개 모듈 약 2,100줄. 핵심은 `generator.py`(305줄, openpyxl), `store.py`(394줄, 상태·중복 억제·검색), `pricing.py`·`confidence.py`·`textkey.py`·`catalog_v2.py`(단가 제안), `extract*.py`(AI 추출), `chat.py`(상담), `recommend.py`(구성 추천).
- 데이터(`data/`, 툴 git에 커밋되어 있음. `.gitignore`의 "본체 data/corpus.sqlite 는 버전관리한다"):

| 원천 | 내용 | 규모(사본에서 행 수만 셈) |
|------|------|------|
| `corpus.sqlite` `quotes` | 과거 견적 파일 1건당 1행(파일명에서 날짜·기관·모델힌트) | 998 (날짜 없음 110) |
| `sheets` | 시트별 수신자·조건·담당자·합계 | 1,189 |
| `items` | 품목 행(사양 첫 줄 인덱스) | 5,509 |
| `margin_items` | 마진계산용 시트 행 | 59 |
| `issued_quotes` | 툴로 만든 견적(Quote JSON, 상태, dedup_key) | **1** (confirmed, 09-17 시드) |
| `price_log` | 발행 견적의 행별 단가 | **2** (confirmed) |
| `catalog.json` | 표기 단위 제품 480·사양 문구 87·고객 199·어휘 5종 | 359 KB |
| `catalog_v2.json` | 정식 제품 268(part 143·system 92·license 22·junk 7·service 4), 표기·이력 포함 | 338 KB |
| `bom_library.json` | 과거 검증 구성 314 | 435 KB |
| `staff.json` | 담당자 10명(이름·전화·메일) | 1 KB |
| `price_points.json`·`pdf_quotes.json`·`normalized/*`·`products_seed_raw.json` | 재구축 도구 전용(런타임 미사용) | 513·1,080·6파일 |

- 사용량: 툴 보고서가 스스로 "플라이휠은 아직 돌지 않았다"고 적었다(`docs/04-report/quote-tool-v2.report.md` §1.6). 운영 DB의 발행 기록은 1건, `output/견적서/`의 생성 파일은 8개, 서버 로그에는 서버 PC 외에 LAN 주소 2개가 보인다. **이전할 '새 기록'은 아주 적고, 무게는 과거 코퍼스와 카탈로그에 있다.**
- 운영: 예약 작업 `XDNODE 견적서 서버`(로그온 시, 최고 권한, `run_shared.bat`)가 `0.0.0.0:8765`로 띄운다. 단 2026-10-02 08:58 재부팅 뒤에는 작업이 결과 0으로 끝났는데도 8765가 LISTEN 상태가 아니었다(같은 날 오후 `netstat`으로 두 번 확인). `run_shared.bat`이 대화형 콘솔(`pause`)에 기대는 탓으로 보이며, 원인은 QT0에서 확인한다. 방화벽 규칙 `XDNODE Quote 8765`(Private, 켜짐)가 있다. 상위 계획 R0는 이 규칙을 일부러 남겼다(xdnode-management.plan.md :128).

**발견한 보안 문제** (QT0·QT5의 근거)

| # | 문제 | 위치 |
|---|------|------|
| S1 | 모든 경로가 인증 없음. 사내망 누구나 과거 견적·고객 연락처 검색, 견적 생성, 상태 변경 | `app/main.py` 전체 |
| S2 | 생성 파일 전체를 `/files`로 정적 서빙. 파일명이 규칙적이라(`견적서(엑스디노드)_YYMMDD_기관…`) 추측 가능 | `app/main.py:37` |
| S3 | `?file=`을 `CORPUS_DIR / file`로 붙이고 범위 검사를 하지 않는다. `..\`나 절대 경로로 서버 계정이 읽을 수 있는 임의 xlsx를 열어 내용을 돌려준다 | `app/main.py:247-250` |
| S4 | 담당자 목록 저장(전원에게 반영)이 인증 없음 | `app/main.py:288-296` |
| S5 | 이미지 추출 때 `--allowedTools Read --permission-mode bypassPermissions`, 작업 폴더는 서버 cwd(툴 폴더, `.env` 위치). 고객 메일·스크린샷의 지시문이 로컬 파일을 읽어 필드에 싣게 할 수 있다 | `quote_gen/extract_cli.py:51-59` |
| S6 | 챗봇이 `WebSearch WebFetch` + `bypassPermissions`. 견적 내용을 URL로 내보내는 통로가 된다 | `quote_gen/chat.py:123-127` |
| S7 | `subprocess.run(..., shell=(os.name=="nt"))`로 JSON 스키마를 cmd.exe를 거쳐 넘긴다 | `extract_cli.py:59`, `chat.py:132` |
| S8 | `esc()`가 작은따옴표를 바꾸지 않고, 상담 답의 마크다운 링크를 `href`로 그대로 만든다(XSS 표면) | `index.html:491`, `:1584-1590` |
| S9 | Host 검사·교차 출처 POST 검사 없음(DNS rebinding·CSRF 방어 없음). 3000과 같은 호스트라 같은 사이트(SameSite=Lax 쿠키가 실림)지만, 3000 쪽 Origin 검사가 8765발 요청을 막는다(xdnode-management.plan.md :292) | `app/main.py` |
| S10 | 담당자 10명의 휴대폰이 코드 기본값에 박혀 있고(`quote_gen/staff.py:13-24`, `schema.py:43-46`), 고객 연락처가 든 `corpus.sqlite`가 툴 git에 커밋되어 있다 | 툴 저장소 |

**XDnode management 쪽 준비 상태**
- 탭은 레지스트리 1항목 + `TAB_PANELS` 1항목 + 새 라우트로 붙는다(`app/access-tabs.ts:7-14`, `app/page.tsx:41`). 총무 탭이 이 방식으로 붙었다.
- AI 추출 선례: 총무 `POST /api/general/extract`가 권한 확인 → 이미지 형식·크기 검사 → 3120 `/extract` 호출 → 정해진 칸만 통과(`app/api/general/extract/route.ts:13-51`, `app/ga-extract.ts`). 브리지는 이미지를 stream-json으로 stdin에 넘기고 도구를 모두 끈다(`scripts/claude-resume-bridge.mjs:114-150`).
- 파일 규칙: `app/attachment-rules.ts`(25 MB, 확장자 표에 xlsx·pdf 있음, nosniff·sandbox CSP). R2 바인딩은 하나(`HR_AUDIO`)이고 총무는 키 접두사 `ga/`로 나눠 쓴다.
- 운영: 자동 기동 `XDnodeManagement-Autostart`는 로그온 여부와 관계없이 실행한다(runbook :161). 백업은 정지 후 `.wrangler/state/v3` 전체 + R2 blob을 복사한다(runbook §10). 배포는 `Deploy-XDNodeManagement.ps1 -Tag`(runbook §12).

### 1.3 Related Documents
- 상위: [xdnode-management.plan.md](xdnode-management.plan.md)(D4 DROP 금지, D17 브리지 도구 끔, D18 운영 폴더, D19 자동 기동, FR-16), [xdnode-management.design.md](../../02-design/features/xdnode-management.design.md) §4.3.1 레지스트리, §7.8 첨부, §8.5 하니스, §10.4 라우트, §10.7 탭 추가
- 선례: [general-affairs.plan.md](general-affairs.plan.md)(새 탭 한 사이클, AI 자동 채우기 GA-D7~D9)
- 운영: [lan-operations-runbook.md](../../lan-operations-runbook.md) §9 작업, §10 백업, §11 복구, §12 배포
- 옛 툴(이식 명세): `README.md`, `docs/02_템플릿_셀맵_스펙.md`(셀 좌표·서식의 근거), `docs/06_대행자_온보딩.md`(판단 경계), `docs/01-plan/features/quote-tool-v2.plan.md`(FR-01~18), `docs/03-analysis/quote-tool-v2.analysis.md`(옵션 견적 덮어쓰기 치명 결함과 `content_hash`), `tests/regression.py`·`test_status.py`·`test_contract.py`·`test_confidence.py`

---

## 2. Scope

### 2.1 In Scope

**A. 탭·권한·데이터 모델** (QT1)
- [ ] 레지스트리 `{ key: "quote", label: "견적", modules: ["quote"], apiPrefixes: ["/api/quote/"], shellClass: "quote-module-shell" }`, `TAB_PANELS.quote`
- [ ] `app/quote-schema.ts` `ensureQuoteSchema`: `quote_*` 테이블(§10.2), 추가만, FK 없음
- [ ] 이전 라우트 `POST /api/quote/import`(관리자 전용, 청크, `legacy_id` 기준 멱등, 감사 행에는 건수만)와 이전 스크립트 `scripts/import-quote-data.mjs`(`scripts/xdm-login.mjs`로 로그인, 원본 **사본**을 `node:sqlite` read-only로 읽음)
- [ ] 과거 견적 Quote JSON 사전 생성: 툴 저장소에서 `reverse.py`를 파일별로 한 번 돌린 결과(JSON)를 이전 입력으로 쓴다(QT-Q10)

**B. 견적 편집·생성** (QT2·QT3)
- [ ] Quote 모델과 검증(`app/quote-model.ts`, 툴 `schema.py`), 금액 계산(`line_amount`·소계·VAT)
- [ ] 파일명 규칙(`app/quote-filename.ts`, 툴 `filename.py`)
- [ ] xlsx 생성(`app/quote-xlsx.ts`): 템플릿 zip 패치, 견적 시트 + '마진계산용' 시트, 수식은 지금처럼 수식으로 쓴다(툴 셀맵 스펙 §9-4)
- [ ] 생성 즉시 `draft` 기록 + 단가 로그 팬아웃, 같은 내용 재생성은 갱신, `confirmed`는 초안이 덮지 못함(툴 FR-14·15, `store.py:180-222`)
- [ ] PDF: 도우미 호출, 실패해도 xlsx와 기록은 남는다(툴 `main.py:146-162`의 순서 유지)
- [ ] 다운로드 `GET /api/quote/files?issuedId=&kind=xlsx|pdf`(권한 확인, R2 `quote/issued/…`)
- [ ] 편집 화면: 수신자·조건·담당자 블록·품목(그룹/단품/상세, 세로 병합 `extra_categories`, 확약 문구)·비고·마진, 단가 미입력 표시, 금액 한글 표기

**C. 기록·검색·상태** (QT3)
- [ ] 최근 작성 목록, 통합 검색(작성분+과거 파일, 랭킹·페이지, 툴 FR-10 `store.py:237-293`), 불러오기(작성분: 저장 JSON / 과거 파일: 사전 생성 JSON, 원본 작성일 배너)
- [ ] 미확정 배지와 일괄 확정·폐기·되돌리기(툴 `main.py:199-225`, `store.py:308-370`)
- [ ] 담당자 블록 프로필 관리(편집 권한, QT-Q3)

**D. 단가 제안·추천·추출·상담** (QT3·QT4)
- [ ] 단가 제안: 카탈로그 매칭 + 발행 로그 병합, 신뢰도 게이트·라벨, 23개 키 계약(툴 `confidence.py:38-46`, `pricing.py:100-149`), 단가 추이 그래프·이력 표, 빈 단가 일괄 적용, 과거 단가 갱신과 되돌리기
- [ ] 고객 매칭으로 연락처 보완, 서버 바디 멀티라인 사양 문구 보완(툴 `main.py:104-119`)
- [ ] AI 추출: 메일 본문·지시문·스크린샷(최대 4장) → Quote 초안 + 필드별 신뢰도·확인 질문·요약. 저장은 사람이 '생성'을 누를 때만
- [ ] 구성 추천(GPU·장수·증설 목표 → 과거 검증 구성)과 2/3/4장 비교 변형(툴 `recommend.py:44-105`)
- [ ] 상담 챗봇: 열린 견적 + 내부 카탈로그 요약만 문맥, 웹 검색 없음(QT-D3), 무상태, 최근 14턴

**E. 전환·폐기** (QT0·QT5)
- [ ] QT0 옛 툴 임시 보강(QT-Q6)
- [ ] QT5 동결·차분 이전·8765 정지·예약 작업·방화벽 규칙·아이콘 제거, 툴 저장소와 데이터 보관, runbook 갱신

### 2.2 Out of Scope
- 견적 xlsx를 올려 Quote로 되돌리는 기능(`reverse.py`의 런타임 이식). 이전 때 한 번만 쓴다. 필요하면 후속
- 카탈로그 재구축·정규화 편집 화면(QT-Q13), 품질 기준선 도구(`tools/quality_baseline.py` 561줄)와 지표 도구(`tools/metrics.py`)의 이식
- 웹 검색·외부 조회(QT-D3), API 키 백엔드(QT-Q14)
- 결재·승인 흐름(D2). '발송 확정'은 상태 기록일 뿐 결재가 아니다
- 메일 발송·고객 포털, 서버 그룹 견적의 제품 사진 삽입(셀맵 스펙 §4 '선택')
- 원본 코퍼스 파일 1,003+1,080건의 R2 이전(QT-Q10 권장안 기준)
- 판매·재무 모듈 복원. `app/incentive/`와 연결하지 않는다(removal-guards 범위)

---

## 3. 기능 → 새 위치 대응표

난이도: 하(그대로 옮김) · 중(구조를 바꿔 옮김) · 상(동작 동등성을 증명해야 함)

| 옛 툴 기능 (근거) | 새 위치 | 테이블·저장소 | 난이도 | 비고 |
|------|------|------|:---:|------|
| `GET /api/health` 백엔드·공유 주소(`main.py:66-71`, `share_url` :46) | 없앰 | — | — | 앱이 자기 주소를 가진다. 도우미 상태는 overview에 '사용 가능/불가'만 |
| Quote 모델(`schema.py:27-128`) | `app/quote-model.ts`(타입·정규화·`lineAmount`·`subtotal`) | — | 하 | 클라이언트·서버 공용 순수 모듈(PII 없음). 담당자 기본값의 실명·휴대폰(`schema.py:43-46`)은 옮기지 않는다 |
| 파일명 규칙(`filename.py`) | `app/quote-filename.ts` | — | 하 | `auto_model_hint` 정규식 동등성 테스트 |
| xlsx 생성(`generator.py:96-305`, 셀맵 스펙) | `app/quote-xlsx.ts`(fflate unzip → `xl/worksheets/sheet1·2.xml` 21행 이하·`mergeCells`·행 높이·`workbook.xml` 인쇄영역·시트명·`styles.xml` 보강 → zip) | R2 `quote/template/v1.xlsx` | **상** | 1~20행·`xl/media`·`drawing` 관계는 바이트 보존. 서식은 템플릿 21~32행 `s=` 인덱스를 프로토타입으로 재사용(`_capture_protos` :50) |
| PDF(`tools/xlsx_to_pdf.py`, `PDF_LOCK` `main.py:34`) | `scripts/quote-pdf-helper.mjs` + `scripts/quote-xlsx-to-pdf.ps1`(127.0.0.1:3150) | 임시 폴더(요청마다 지움) | 중(세션은 상) | 견적 시트만 보이게, FitToPages 1×1(`xlsx_to_pdf.py`와 같음). 대기열 3, 시간 초과 시 EXCEL.EXE 종료 |
| `POST /api/generate`(`main.py:137-163`) | `app/api/quote/issued/route.ts` POST `action:"GENERATE"` | `quote_issued`, `quote_price_log`, R2 `quote/issued/` | 중 | 순서: 검증 → xlsx → R2 → draft 기록(batch) → PDF(실패 허용) |
| `POST /api/record`·`/api/status`·`/api/pending`·`/api/recent`(`main.py:166-225`) | 같은 라우트 `CONFIRM`·`SET_STATUS`, GET `?view=recent|pending` | 같음 | 중 | `set_status`의 '이미 그 상태면 세지 않음'·price_log 동반 전이 유지 |
| 중복 억제(`store.py:109-149`, `:180-222`) | `app/quote-store.ts`(`contentHash`·`dedupKey`·upsert 문 빌더) | `quote_issued.dedup_key` 부분 UNIQUE | **상** | sha256 앞 16자, 재료 문자열 순서·`None` 표기(`"None"`)까지 같아야 이전 키와 맞는다. D1 `ON CONFLICT(dedup_key) WHERE … DO UPDATE … RETURNING id` |
| 통합 검색(`store.py:237-293`) | `app/api/quote/history/route.ts` GET | `quote_issued`, `quote_corpus_*` | 중 | 문자열로 붙인 `IN (…)`(`:260`)은 서브쿼리로 바꾼다. 이름 붙은 매개변수는 D1 `?N`으로 |
| 불러오기(`main.py:239-254`) | 같은 라우트 `?issuedId=` / `?corpusId=` | `quote_issued.quote_json`, `quote_corpus_files.quote_json` | 하 | 파일 경로를 받지 않는다(S3 소멸). `source_date` 유지 |
| 단가 이력(`main.py:257`, `store.py:373-394`) | `app/api/quote/catalog/route.ts` GET `?view=priceHistory` | `quote_price_log` | 하 | `discarded`만 제외, `NULL`은 confirmed로 읽음(이전 데이터 호환) |
| 제품·사양·어휘(`main.py:262-269`, `:327`) | 같은 라우트 `?view=products|spec|vocab` | `quote_catalog_products`, `quote_catalog_legacy`, `quote_spec_library`, `quote_meta` | 하 | |
| 단가 제안(`pricing.py:152-171`, `confidence.py`, `catalog_v2.py`, `textkey.py`) | `app/quote-textkey.ts`, `app/quote-confidence.ts`, `app/quote-pricing.ts` + `app/api/quote/compute/route.ts` POST `SUGGEST` | 카탈로그 테이블 | **상** | `difflib.SequenceMatcher.ratio()`(자동 junk 규칙 포함)와 `norm()` 정규식을 비트 단위로 맞춰야 한다. 툴이 "변경 금지"로 묶은 함수다(`textkey.py:13-15`) |
| 고객 매칭·사양 보완(`pricing.py:174-201`, `main.py:104-119`) | `app/quote-pricing.ts` | `quote_customers`, `quote_spec_library` | 중 | 고객 연락처는 서버에서만 다룬다 |
| AI 추출(`extract.py`, `extract_cli.py`) | `app/api/quote/extract/route.ts` + `app/quote-extract.ts`(프롬프트·스키마·정규화) + 브리지 `/quote-extract` | 카탈로그(프롬프트용 상위 220개, `extract.py:85`) | 중 | 이미지는 stdin stream-json, 도구 끔, 작업 폴더는 빈 임시 폴더. 출력은 화이트리스트 정규화 |
| 구성 추천·변형(`recommend.py`, `main.py:332-352`) | `app/quote-recommend.ts` + `compute` 라우트 `RECOMMEND`·`VARIANTS` | `quote_bom_library` | 하~중 | `_sim`도 SequenceMatcher를 쓴다 |
| 상담(`chat.py`, `main.py:299-324`) | `app/api/quote/chat/route.ts` + `app/quote-chat.ts`(문맥 조립) + 브리지 `/quote-chat` | 카탈로그 | 중 | 웹 도구 제거, 동시 3(`chat.py:19`) → 한 번에 하나 + 429 |
| 담당자(`staff.py`, `main.py:272-296`) | `app/api/quote/staff/route.ts` | `quote_staff_profiles` | 하 | 저장 전 목록을 응답에 돌려주는 되돌리기 유지, 감사 |
| 화면(`index.html` 1,635줄) | `app/quote-workspace.tsx` + `app/quote-editor-view.tsx`·`quote-history-view.tsx`·`quote-assist-view.tsx` 등 | — | **상** | 문자열 `innerHTML` 대신 React 렌더(S8 소멸). 단축키(Alt+C 등)·localStorage 화면 상태는 유지, 작성자 선택(localStorage `xdnode_whoami`)은 없앰 |
| 단가 추이 그래프(`index.html:868-1000`) | `app/quote-price-chart.tsx`(SVG) | — | 중 | |
| `/files` 정적 서빙(`main.py:37`) | 없앰 → `files` 라우트 | R2 | 하 | S2 소멸 |
| `launcher.pyw`·`run_shared.bat`·`setup_autostart.bat`·예약 작업·방화벽 규칙 | QT5에서 폐기 | — | 하 | |
| `tools/backup_db.py`(VACUUM INTO, 14개 보관) | R4 백업으로 대체 | — | — | |
| `tools/build_*.py`·`parse_pdf_quotes.py`·`seed_issued.py`·`make_clean_template.py`·`make_icon.py`·`quality_baseline.py`·`metrics.py` | QT5에서 폐기(QT-D4). 산출 JSON은 `quote_source_snapshots`에 원문 보관 | `quote_source_snapshots` | — | |
| `tests/regression.py` | `tests/quote-xlsx.test.mjs` + 픽스처 | — | 상 | §8 |
| `tests/test_status.py`·`smoke_record.py` | `tests/quote-api.test.mjs`(하니스) | — | 중 | |
| `tests/test_contract.py`·`test_confidence.py` | `tests/quote-pricing.test.mjs` | — | 중 | |
| `examples/*.json` 4종 | 익명화해 `tests/fixtures/quote/*.json` | — | 하 | 원본에 실제 고객명이 들어 있다 |

---

## 4. Requirements

### 4.1 Functional Requirements

| ID | Requirement | Release | Priority | 검증 |
|----|-------------|:---:|:---:|------|
| QT-FR-01 | 레지스트리에 견적 탭을 더하고 none·view·edit를 적용한다. 권한 없는 계정에는 탭 DOM이 없고 `/api/quote/*`가 403이다 | QT1 | High | tab-permissions·access-policy·shell-tabs(자동 포함), quote-api |
| QT-FR-02 | `ensureQuoteSchema`가 `quote_*` 테이블을 멱등으로 만든다. 다른 도메인 DDL을 건드리지 않는다 | QT1 | High | quote-api(두 번 호출), 소스 가드 |
| QT-FR-03 | 이전: corpus 4개 테이블, 발행 기록·단가 로그, 카탈로그 2종, 사양·고객·어휘, 구성 라이브러리, 담당자, 템플릿, 원본 JSON 스냅샷을 앱 API로 옮긴다. 같은 입력을 다시 넣어도 행이 늘지 않는다. `legacy_id`를 남긴다 | QT1 | High | quote-api(멱등), 행 수·해시 대조 보고서 |
| QT-FR-04 | Quote 검증·정규화. 숫자는 유한값, 줄·품목·문자열 길이 상한(Design에서 값 확정, 예: 줄 50·품목 200·사양 4,000자) | QT2 | High | 단위 테스트 |
| QT-FR-05 | TS xlsx 생성. 견적 시트와 마진 시트, 그룹/단품/상세 단가/세로 병합/확약 문구/다중 비고, 인쇄영역·B13·소액·세액·총액 수식, 작성일 고정값, 로고·직인 보존 | QT2 | High | QT-SC-01, quote-xlsx |
| QT-FR-06 | 생성 즉시 `draft` 기록과 단가 로그 팬아웃. 같은 dedup_key면 갱신, `confirmed`는 초안이 덮지 못함, 생성 실패와 기록 실패를 구분해 알림 | QT2 | High | QT-SC-02, quote-api |
| QT-FR-07 | PDF 도우미 호출. 견적 시트만, 1쪽 맞춤. 도우미 실패·시간 초과여도 xlsx와 기록은 남고 '다시 PDF 만들기'를 준다 | QT2 | High | quote-api(fetch 대역), 도우미 테스트, 운영 스모크 |
| QT-FR-08 | 다운로드는 권한 확인 뒤 R2에서 내려준다. 보기 권한은 견적 시트만 든 xlsx와 PDF(QT-Q12) | QT2 | High | quote-api(헤더·권한) |
| QT-FR-09 | 상태 전이 draft↔confirmed↔discarded, 한 번에 500건 상한, 이미 그 상태면 세지 않음, `quote_price_log`가 함께 전이, 폐기는 행을 지우지 않음 | QT3 | High | QT-SC-02 |
| QT-FR-10 | 통합 검색·최근·미확정 목록·불러오기. 랭킹 1 고객명·모델힌트, 2 담당자·파일명·작성자, 3 사양. 날짜 통합 정렬, `total`·`offset` | QT3 | High | quote-api(랭킹·페이지) |
| QT-FR-11 | 단가 제안과 신뢰도. 23개 키 계약, 폴백 경로도 같은 키, 게이트 0.60·라벨 0.72 등 상수 동일, 적용은 막지 않음(정보) | QT3 | High | QT-SC-03·04·05 |
| QT-FR-12 | 담당자 블록 프로필 CRUD(편집 권한), 최소 1명, 이름 중복 정리, 메일 형식 검사, 저장 전 목록 반환 | QT3 | Medium | quote-api |
| QT-FR-13 | AI 추출. 본문 6만 자·이미지 4장·장당 4 MB 상한, 형식 검사, 정해진 필드만 통과, 고객 매칭·사양 보완 적용, 저장 없음, 감사에는 이미지 수·글자 수·채운 칸 수만 | QT3 | High | quote-api(브리지 대역), 수동 주입 시험 |
| QT-FR-14 | 편집 화면 전체(§2.1 B·C·D), 한국어·KRW 표기 | QT3 | High | 개발 서버 점검표 |
| QT-FR-15 | 구성 추천과 2/3/4장 변형 | QT4 | Medium | quote-pricing(동등성 표본) |
| QT-FR-16 | 상담 챗봇. 도구 없음, 문맥은 서버가 권한 확인 뒤 DB에서 조립, 질문 2,000자·이력 14턴 상한, 감사에는 턴 수·글자 수만 | QT4 | Medium | quote-api(브리지 대역), 브리지 테스트 |
| QT-FR-17 | 모든 변경(생성·확정·폐기·되돌리기·담당자·이전·추출·상담)을 `writeErpAudit`(module `quote`)로 남긴다. 고객명·연락처·단가는 감사 행에 넣지 않는다(id·건수·금액 합계만) | 전부 | High | erp-platform 가드(자동), quote-api |
| QT-FR-18 | 전환: 차분 이전, 8765 정지, 예약 작업·방화벽 규칙·아이콘 제거, 옛 툴 보관 | QT5 | High | 전환 점검표(QT-SC-11) |

### 4.2 Non-Functional Requirements

- **보안**
  - 모든 `app/api/quote/**` 라우트는 본문을 읽기 전에 `authorizeErpRequest(db, "quote", …)`를 부른다. 변경 라우트는 `writeErpAudit`를 부른다. 예외는 QT-Q11의 `compute` 한 파일뿐이다.
  - 고객 연락처·담당자 휴대폰·과거 견적은 서버 전용이다. 서버 모듈(`app/quote-store.ts`, `app/quote-pricing.ts`의 데이터 접근부)은 클라이언트에서 import하지 않는다. `tests/bundle-exposure.test.mjs`에 견적 표지(고객 기관명 표본·담당자 휴대폰)를 더한다.
  - 다운로드는 `attachmentDownloadHeaders`를 쓴다(nosniff, sandbox CSP, `attachment; filename*=`).
  - 크기 상한: 추출 요청 16 MB(브리지와 같음), 생성 요청 Quote JSON 1 MB, PDF 도우미 입력 xlsx 5 MB, 상담 요청 256 KB.
  - 도우미 두 개는 `127.0.0.1`에만 바인딩한다. Origin이 붙은 요청과 허용 목록 밖 Host는 403이다(`claude-resume-bridge.mjs:33`·`:189`와 같다). 방화벽 규칙을 만들지 않는다. `local-peer` 규칙과 portproxy 금지(runbook §6)를 그대로 따른다.
  - 브리지는 도구를 모두 끄고(`--tools ""` + 차단 목록), 빈 임시 폴더를 cwd로 쓰고, 이미지를 디스크에 쓰지 않는다(D17).
- **백업·복구**: 견적 데이터는 D1(`.wrangler/state/v3`)과 R2 `quote/`에 있으므로 R4 백업이 그대로 덮는다. 복원 리허설(runbook §11)에 `quote_*` 행 수와 R2 `quote/` 객체 수를 더한다.
- **성능**: 단가 제안 1회(품목 15행 기준) 500 ms 이내(옛 툴 기준 145~400 ms, quote-tool-v2 plan §3.2), 검색 100 ms 이내, xlsx 생성 1초 이내, PDF 30초 이내(Excel 기동 포함). 카탈로그는 모듈 범위에 캐시하고 `quote_meta.catalog_version`이 바뀌면 다시 읽는다.
- **날짜**: 작성일·파일명 날짜는 KST 기준이다(서버 시계는 UTC).
- **데이터**: 추가만 하고 DROP하지 않는다(D4). 폐기는 상태값이다. 이전한 원본 값(`legacy_id`, 이전 dedup_key, `name_key`)은 고치지 않는다.
- **호환**: 이전한 `status IS NULL` 행은 confirmed로 읽는다(툴 `COALESCE(status,'confirmed')` 규칙).

---

## 5. Success Criteria

### 5.1 Definition of Done
- [ ] QT-FR-01~18 구현, 새 테스트와 기존 테스트 전부 통과, lint 0건
- [ ] **QT-SC-01 회귀(xlsx)**: 툴 `tests/regression.py`의 5건(`CASES`, `:12-18`: 서버 그룹+세로 병합, 파츠 상세 단가, GPU+NAS 혼합, 세트 열 없는 DGX, 확약 문구 서버)을 익명화한 Quote JSON으로
  - ① TS가 만든 xlsx의 계산값(A1:I45, `H14` 제외, 병합 그림자 셀 제외, 수치 허용 오차 0.5 — `regression.py:43-49`의 `same()` 규칙)이 같은 입력으로 파이썬 `generator.py`가 만든 xlsx를 Excel로 계산한 값과 **차이 0**
  - ② 원본 대비 차이는 파이썬과 같은 4건(`BASELINE_DIFFS = 4`, `:127`), 대상 5건
  - ③ 견적 시트 병합 범위 집합이 파이썬 출력과 같다. 시트명, 인쇄영역, B13 수식 참조, 행 높이(±0.5pt), 로고·직인 그림 2개가 같다
  - ④ 마진 시트의 L~P열 수식 결과(총매입·총마진)가 같다
  - ⑤ 5건 모두 Excel이 '복구' 대화상자 없이 열고(PDF 도우미 경유 확인), PDF가 1쪽이며 사용자가 눈으로 확인한다
- [ ] **QT-SC-02 상태·중복 불변식**: 툴 `tests/test_status.py`의 검사 16개를 하니스로 옮겨 통과 — 미확정 목록은 오래된 것부터, 2건 확정 시 `changed=2`와 두 테이블 동시 전이, 이미 그 상태·빈 목록·없는 id는 `changed=0`, 폐기분은 단가 이력에서 사라지고 행은 남음, 되돌리면 이력 복귀, 잘못된 status는 400. 더해서 같은 견적 2회 생성 → 1행·단가 로그 중복 없음, 가격만 다른 옵션 견적 → 2행(툴 analysis §3 치명 결함 재현 방지), confirmed 행을 draft 재생성이 덮지 못함
- [ ] **QT-SC-03 제안 키 계약**: 툴 `tests/test_contract.py`대로 정상·폴백 두 경로 모두 키 23개 동일, 값 없는 키도 null로 존재, 불변식 4개(gated면 suggested·delta·age_days 없음, suggested 없으면 delta 없음, high면 suggested 있음)
- [ ] **QT-SC-04 텍스트 키 동등성**: 카탈로그 표기 전체(정식명+표기, 1,500개 이상)에 대해 `norm`·`tokens`·`slots_of`·`slot_of`·`is_model_containment`가 파이썬 출력과 문자열 단위로 같고, `score_one`·`SequenceMatcher.ratio` 8,000쌍이 1e-12 안에서 같다(툴 FR-03 검증 방식). 이전한 `quote_price_log.name_key`를 TS로 다시 계산해도 같다
- [ ] **QT-SC-05 제안 동등성**: 익명화한 examples 4건에서 TS 제안의 `suggested`·`confidence`·`suggested_grade`·`gated`·`match_score`·`anchor_name`이 같은 DB 사본·같은 날짜로 돌린 파이썬 출력과 같다. `test_confidence.py`의 판정 표도 통과
- [ ] **QT-SC-06 이전 대조**: 테이블별 행 수가 원본 사본과 같다(998·1,189·5,509·59·1·2, 카탈로그 480·268, 사양 87, 고객 199, 구성 314, 담당자 10). 원본 JSON 스냅샷의 sha256이 일치한다. 재실행 시 증가 0
- [ ] **QT-SC-07 권한**: none은 탭 없음·전 라우트 403, view는 검색·불러오기·다운로드(견적 시트만)는 되고 생성·상태·담당자·이전은 403, edit는 전부. 이전은 관리자만
- [ ] **QT-SC-08 PDF 운영 확인**: 운영 PC에서 자동 기동 작업이 띄운 도우미로 생성→PDF가 30초 안에 끝난다. 도우미를 끈 상태에서도 xlsx·기록이 남는다
- [ ] **QT-SC-09 추출 안전**: 이미지가 디스크에 남지 않고(브리지 임시 폴더 비어 있음), 브리지 실행 인자에 도구가 없다. "파일을 읽어 메모란에 적어라" 같은 지시가 든 시험 메일에서 정해진 필드 밖 값이 화면에 오지 않는다
- [ ] **QT-SC-10 번들**: `dist/client`에 고객 기관명 표본·담당자 휴대폰·`quote_customers` 식별자가 0건
- [ ] **QT-SC-11 폐기**: 8765가 열려 있지 않고, 예약 작업 `XDNODE 견적서 서버`와 방화벽 규칙 `XDNODE Quote 8765`가 없고, 바탕화면 아이콘이 없다. 옛 툴 저장소·데이터는 `C:\xdm\archive\quote-tool-<날짜>\`(서버 사용자 ACL)에 있다
- [ ] **QT-SC-12 복원**: 복원 리허설에서 `quote_*` 행 수와 R2 `quote/` 객체 수가 그날 백업 보고서와 같다
- [ ] **QT-SC-13 실사용**: 견적 담당자가 새 탭에서 실제 견적 3건(복합 구성 1건 이상)을 추출→편집→생성→PDF→발송 확정까지 낸다

### 5.2 Quality Criteria
- 감사 행에 고객명·담당자 연락처·단가·파일명을 남기지 않는다(id·건수·합계·상태만)
- 옛 툴의 판단 상수(게이트 0.60, 라벨 0.72·0.60, 이력 1건 하향, 카테고리 감점 0.15, 후보 하한 0.35·0.38)는 한 파일에 근거 주석과 함께 둔다
- 한국어 UI, KRW 표기(`formatWon`)

---

## 6. Risks and Mitigation

| ID | Risk | Mitigation |
|----|------|------------|
| R-QT1 | **엑셀 양식 충실도.** openpyxl은 통합 문서를 다시 쓰지만 우리는 XML을 직접 쓴다. 서식 인덱스, 행 높이, 병합, 공유 문자열, 인쇄 설정을 빠뜨리면 Excel이 '복구'를 띄우거나 모양이 바뀐다 | 1~20행과 그림 관계는 바이트 그대로 둔다. 21행 이하는 템플릿 21~32행의 `s=` 인덱스를 재사용하고, 새 서식(9pt 줄바꿈, 이중선 하단)은 `styles.xml`에 한 번만 더한다. 문자열은 inlineStr로 쓴다. QT-SC-01의 계산값·병합·높이 비교와 Excel 열기 확인, PDF 육안 확인을 QT2 합격 조건으로 둔다 |
| R-QT2 | **Excel COM 세션 의존.** 자동 기동 작업은 비대화형 세션이다. Excel 자동화는 비대화형에서 실패하거나 라이선스·복구 대화상자로 멈출 수 있다. 좀비 EXCEL.EXE가 남는다 | QT2 첫날 시험(QT-Q8). 실패하면 도우미만 '로그온 시' 작업으로 뺀다. 도우미는 한 번에 하나, 60초 시간 초과 시 그 자식 Excel만 종료, `DisplayAlerts=false`, 매 요청 새 인스턴스. PDF 실패가 생성을 막지 않는다(QT-FR-07) |
| R-QT3 | **병행 기간 데이터 갈라짐.** 두 툴에서 견적이 만들어지면 기록·단가 로그·담당자 목록이 갈린다 | QT3 반영일에 옛 툴을 읽기 전용으로 돌린다(QT0 스위치). QT5 동결 때 `legacy_id` 기준 차분 이전을 한 번 더 돌린다(멱등). 이전 보고서에 '옛 툴 마지막 발행 id'를 남긴다 |
| R-QT4 | **고객·직원 PII.** 고객 199곳 연락처, 과거 견적 수신자, 담당자 휴대폰이 앱으로 들어온다 | 서버 전용 모듈, bundle-exposure 표지 추가, 고객 매칭 응답은 상위 8건만, 감사 행에 값 없음, 백업 ACL(runbook §10). 옛 툴 git(`corpus.sqlite` 커밋)과 원본 폴더는 보관 폴더로 옮기고 `Downloads` 사본을 지울지는 사용자가 정한다 |
| R-QT5 | **프롬프트 주입(추출).** 고객 메일·스크린샷은 외부 입력이다 | 도구 끔, 빈 cwd, 이미지 stdin, 시스템 프롬프트에 비밀 없음, 출력은 스키마 화이트리스트·길이 상한으로 거르고, 자동 저장하지 않는다. 상담도 도구가 없어 내보낼 통로가 없다 |
| R-QT6 | **유사도 이식 오차.** `difflib`의 junk 규칙·동률 처리, 파이썬 `str.lower()`와 정규식 `[^0-9a-z가-힣+.]`의 차이가 `name_key`를 바꾸면 단가 이력이 둘로 갈린다 | QT-SC-04·05의 파이썬 출력 픽스처를 먼저 만들고 TS가 통과할 때까지 QT3에 들어가지 않는다. 이전한 `name_key`는 다시 계산하지 않고 그대로 둔다 |
| R-QT7 | **브리지 경합.** 3120의 바쁨 플래그 하나를 이력서 분석·총무 추출이 쓴다. 견적 추출(수십 초)까지 얹으면 429가 잦다 | 견적은 새 3140 브리지(QT-Q7). Claude 실행부를 공용 모듈로 빼서 규칙이 갈라지지 않게 한다 |
| R-QT8 | **큰 JSON 값.** `pdf_quotes.json` 1.1 MB 같은 원문을 한 행에 넣으면 D1 값 크기 한도에 걸릴 수 있다 | 런타임에 쓰는 카탈로그는 행 단위로 정규화하고, 원문 스냅샷은 1 MB 단위로 나눠 넣는다(`quote_source_snapshots.part`) |
| R-QT9 | **옛 툴 지식 손실.** 상수·예외 규칙의 근거가 툴 PDCA 문서에만 있다 | 이식한 함수에 툴 FR 번호를 주석으로 남긴다. 툴 docs를 `docs/archive/quote-tool/`로 복사한다(QT5) |
| R-QT10 | **원본 코퍼스가 백업 밖.** 581 MB 원본이 `Downloads`에만 있다. 회귀 픽스처 재생성도 이 폴더에 기댄다 | QT0에서 보관 폴더로 복사한다. 회귀 픽스처는 QT2에서 한 번 만들어 저장소에 고정한다(익명화) |
| R-QT11 | **업무 중단.** 대행 담당자가 한 명뿐이다(툴 온보딩 문서 §0) | QT3 반영 뒤 옛 툴을 읽기 전용으로 2주 남긴다. 새 화면의 버튼 배치는 옛 화면 순서를 따른다 |

---

## 7. 릴리스 계획

모든 릴리스는 같은 배포 경로를 쓴다: 개발 폴더에서 `npm run lint` + `npm test` → 태그 `qtN-release-yyyyMMdd` → 운영에서 `Deploy-XDNodeManagement.ps1 -Tag <태그>`(runbook §12, 업무 시간 밖) → 헬스체크 401 → 릴리스별 스모크. 공통 롤백은 직전 태그로 같은 Deploy를 다시 하는 것이다. `quote_*` 테이블과 R2 `quote/` 객체는 추가만 했으므로 남겨 둔다(D4).

### QT0 — 옛 툴 임시 보강 (툴 저장소, 이 저장소 코드 변경 없음)
- [ ] `?file=`: `resolve()` 뒤 `CORPUS_DIR` 안인지 확인, 아니면 404(S3)
- [ ] 추출: 이미지를 stream-json stdin으로, `--tools ""`, cwd를 빈 임시 폴더로, `shell=False`(S5·S7)
- [ ] 상담: `--allowedTools WebSearch WebFetch`·`bypassPermissions` 제거(S6, QT-D3 선적용)
- [ ] Host 허용 목록(서버 IP:8765·localhost:8765), POST는 Origin이 Host와 같을 때만(S9)
- [ ] 읽기 전용 스위치(환경변수, 켜면 generate·record·status·staff POST 403)
- [ ] 원본 코퍼스 폴더와 `data/`를 `C:\xdm\archive\quote-tool-<날짜>\`로 복사(R-QT10)
- 배포: 툴 저장소 커밋 → 예약 작업 `XDNODE 견적서 서버` 재시작 → 서버 PC와 LAN PC에서 추출 1건·생성 1건 확인
- 롤백: 툴 저장소 `git revert` 후 재시작

### QT1 — 데이터 모델과 이전
- [ ] 레지스트리 항목·`TAB_PANELS.quote`(이 단계 화면은 검색·최근·불러오기 읽기 전용 목록)
- [ ] `app/quote-schema.ts`·`ensureQuoteSchema`, 테이블(§10.2)
- [ ] 툴 저장소의 일회용 내보내기(`reverse.py`로 파일별 Quote JSON, 카탈로그·담당자 원문) → 저장소 밖 임시 폴더
- [ ] `POST /api/quote/import`(관리자, 청크 500행, 멱등), `scripts/import-quote-data.mjs`
- [ ] 템플릿 R2 업로드와 해시 기록(QT-Q2)
- [ ] `GET /api/quote/history`(검색·최근·불러오기)
- [ ] tests: quote-api(스키마 멱등·권한·이전 멱등·검색 랭킹), package.json 목록
- 배포 뒤: 운영에서 이전 스크립트 실행(옛 툴은 그대로 운영) → 이전 보고서로 QT-SC-06 확인 → 다음 03:00 백업 보고서에 `quote_*` 행 수가 나오는지 확인
- 롤백: 직전 태그로 Deploy. 이전 데이터는 남겨도 무해하다(탭이 사라질 뿐)

### QT2 — xlsx·PDF 생성과 회귀
- [ ] 첫날: Excel COM 세션 시험(QT-Q8). 결과에 따라 도우미 기동 경로를 정한다
- [ ] 툴 저장소에서 회귀 픽스처 생성: 익명화한 5건 Quote JSON → 파이썬 xlsx → Excel 계산값 JSON(값·병합·높이·인쇄영역). 저장소에는 익명화 결과만 넣는다
- [ ] `app/quote-model.ts`·`quote-filename.ts`·`quote-xlsx.ts`·`quote-store.ts`
- [ ] `app/api/quote/issued`(GENERATE·REGENERATE_PDF), `app/api/quote/files`
- [ ] `scripts/quote-pdf-helper.mjs`·`scripts/quote-xlsx-to-pdf.ps1`, Start·Stop 스크립트에 3150 추가, npm 스크립트 `quote:pdf`
- [ ] tests: quote-xlsx(QT-SC-01 ①~④, 테스트 쪽 소형 수식 평가기로 계산), quote-pdf-helper(Origin·Host·크기·한 번에 하나, COM은 대역), quote-api(생성·dedup·다운로드 권한), lan-exposure-guards·ops-scripts 갱신
- 배포 뒤: 관리자 계정으로 5건 생성 → Excel 열기·PDF 1쪽 육안 확인(QT-SC-01 ⑤), QT-SC-08
- 롤백: 직전 태그로 Deploy, 도우미 pid 정리(Stop 스크립트가 3150을 끈다)

### QT3 — 편집 화면, 기록·검색, 단가 제안, 추출 (병행 운영 시작)
- [ ] 파이썬 픽스처: 텍스트 키·제안 동등성(QT-SC-04·05) 먼저
- [ ] `app/quote-textkey.ts`·`quote-confidence.ts`·`quote-pricing.ts`, `app/api/quote/compute`(SUGGEST), `catalog`, `staff`
- [ ] 상태 전이·미확정 일괄 화면, 담당자 프로필
- [ ] `scripts/claude-quote-bridge.mjs`(3140, `/quote-extract`), `scripts/lib/claude-cli.mjs`(3120·3130도 이것을 쓰게 바꾸되 동작은 그대로), `app/api/quote/extract`
- [ ] `app/quote-workspace.tsx`와 화면 파일들
- [ ] tests: quote-pricing, quote-api(상태 불변식 QT-SC-02, 추출 정규화, 감사), bundle-exposure 표지, local-codex-assistant(브리지 공용화 회귀)
- 배포 뒤: 같은 날 옛 툴 읽기 전용 스위치 ON. 견적 담당자와 실제 견적 1건을 함께 낸다. 2주 관찰 시작(QT-SC-13)
- 롤백: 직전 태그로 Deploy, 옛 툴 읽기 전용 OFF(QT3 동안 새 탭에서 만든 견적은 R2·D1에 남는다. 필요하면 xlsx를 내려받아 계속 쓴다)

### QT4 — 상담, 구성 추천, 비교 변형
- [ ] `app/quote-recommend.ts`, `compute` RECOMMEND·VARIANTS
- [ ] 브리지 `/quote-chat`(도구 없음, 한 번에 하나), `app/quote-chat.ts`, `app/api/quote/chat`
- [ ] tests: quote-pricing(추천 표본 동등성), quote-api(상담 문맥에 권한 밖 데이터 없음, 감사)
- 배포 뒤: 상담 3문항(호환성·부품 추천·전력 계산) 확인, 웹 조회 없음 확인(브리지 로그)
- 롤백: 직전 태그로 Deploy

### QT5 — 전환과 폐기
- [ ] 사용자와 동결일 확정(QT-Q5). 동결 시각에 옛 툴 정지 → 차분 이전 → 대조 보고서
- [ ] 예약 작업 `XDNODE 견적서 서버` 삭제, 방화벽 규칙 `XDNODE Quote 8765` 삭제(관리자 PowerShell), 바탕화면 `XDNODE 견적서` 아이콘 제거
- [ ] 옛 툴 저장소·`data/`·`output/`을 보관 폴더로 이동(ACL), 툴 docs를 `docs/archive/quote-tool/`로 복사
- [ ] runbook에 견적 도우미(3140·3150) 운영·복원 항목, 상위 계획 D8 상태 갱신
- [ ] removal-guards: `quote_gen`·`:8765`·`XDNODE Quote 8765` 참조가 앱 코드에 돌아오지 않게
- [ ] 복원 리허설(QT-SC-12)
- 롤백: 보관 폴더에서 옛 툴을 되돌려 예약 작업·방화벽 규칙을 다시 만든다(`setup_autostart.bat`). 동결 이후 새 탭에서 만든 기록은 옛 툴로 되돌리지 않는다(필요하면 xlsx로 전달)

---

## 8. Test Plan

저장소 규약을 따른다: `node --test` 파일, 새 파일은 `package.json` `test` 목록에 넣는다(`tests/removal-guards.test.mjs:169`가 목록과 디렉터리 일치를 검사). 라우트 동작은 `tests/helpers/hr-api-harness.mjs`(인메모리 `node:sqlite`, `setAccess`·`createAccount`·`login`·`setPeer`·`setClock`·`callApi`)로 본다. 브리지·도우미 호출은 fetch 대역으로 막는다(하니스 :128 주석, `hr-ai-integration.test.mjs` 방식).

| 파일 | 내용 | 릴리스 |
|------|------|:---:|
| `tests/quote-api.test.mjs` | 권한 3단계·관리자 이전, 스키마 멱등, 이전 멱등·행 수, 검색 랭킹·페이지, 불러오기(파일 경로 입력 없음), 생성→draft·팬아웃, dedup 갱신·옵션 견적 분리·confirmed 보호, 상태 전이 16개(QT-SC-02), 다운로드 헤더·보기 권한의 시트 제한, 추출 정규화(브리지 대역, 필드 밖 값 버림), 상담 문맥·감사, 감사 행에 고객명 없음 | QT1~4 |
| `tests/quote-xlsx.test.mjs` | 회귀 5건(QT-SC-01 ①~④): 생성 xlsx를 unzip해 셀·수식을 읽고, 테스트 쪽 소형 평가기(`SUM`, `*`, `+`, 셀 참조만 — 생성기가 쓰는 수식이 이것뿐이다, `generator.py:131·166·192·195·221-225·229`, 마진 열 `:264-276`)로 계산해 파이썬 픽스처와 비교. 템플릿 1~20행·`xl/media` 바이트 보존, 그림 2개, 인쇄영역, 시트명 | QT2 |
| `tests/quote-pricing.test.mjs` | 텍스트 키 동등성(QT-SC-04), `decide()` 판정 표(`test_confidence.py`), 키 계약·폴백(QT-SC-03), examples 4건 제안 동등성(QT-SC-05, 시계 고정), 추천·변형 표본 | QT3·4 |
| `tests/quote-pdf-helper.test.mjs` | Origin 있음 403, 허용 밖 Host 403, 크기 초과 413, 동시 요청 429(대기열 초과), 시간 초과 처리. COM 스크립트는 대역 | QT2 |
| 기존 가드 갱신 | `lan-exposure-guards`(Stop의 `BridgePorts`, `:227`의 `@(3120, 3130)` 고정값, 시작 스크립트 모양), `ops-scripts`, `bundle-exposure`(견적 표지), `erp-platform`(무감사 예외에 `quote/compute`, QT-Q11), `removal-guards`(목록, QT5 금지어), `local-codex-assistant`(브리지 공용 모듈) | QT2~5 |
| 자동 포함 | `tab-permissions`·`access-policy`·`shell-tabs`는 레지스트리에서 파생되어 새 탭을 자동으로 검사한다 | QT1 |
| 수동 | 개발 서버(`npm run dev`, 127.0.0.1:3100) 점검표: 추출 1건(이미지), 생성·PDF, 불러오기·재생성, 일괄 확정·되돌리기, 상담 3문항. 운영 스모크는 runbook §5.1 방식(운영 데이터를 바꾸는 항목은 관리자 계정으로 시험 견적 1건 → 폐기) | 각 릴리스 |

픽스처 원칙: 저장소에 넣는 픽스처는 익명화한다(기관명·담당자·연락처를 자리표시자로). 텍스트 키 픽스처는 제품 표기만 담는다. 파이썬 출력 생성 스크립트는 툴 저장소 쪽에 두고, 저장소에는 결과 JSON만 넣는다.

---

## 9. Impact Analysis

| 자원 | 변경 | 영향 |
|------|------|------|
| `app/access-tabs.ts` | 레지스트리 항목 1개 | tab-permissions·access-policy·shell-tabs 자동 포함, 계정 관리 화면의 부여 목록에 '견적' 자동 추가 |
| `app/page.tsx` | `TAB_PANELS.quote` | 셸 |
| `app/api/quote/**` | 새 라우트 약 8개 파일(import·history·issued·files·catalog·compute·staff·extract·chat) | erp-platform 감사 스캔 자동 적용, `compute`만 예외 등록(QT-Q11) |
| 새 테이블 `quote_*` 약 14개 | `ensureQuoteSchema` | 추가만. 플랫폼·HR·총무·채팅 DDL 무변경 |
| R2 `HR_AUDIO` 버킷 | 접두사 `quote/template/`·`quote/issued/` | 백업은 R2 전체 복사라 변경 없음. 복원 리허설 항목 추가 |
| `scripts/` | `claude-quote-bridge.mjs`(3140), `quote-pdf-helper.mjs`·`quote-xlsx-to-pdf.ps1`(3150), `lib/claude-cli.mjs`, `import-quote-data.mjs` | Start(`:37-38`·`:276-279`)·Stop(`BridgePorts`)·npm 스크립트, lan-exposure-guards·ops-scripts 갱신. `write-dev-vars.mjs` 허용 목록은 늘리지 않는다(기본 URL 고정, QT-Q14) |
| `scripts/claude-resume-bridge.mjs`·`claude-assistant-bridge.mjs` | 공용 실행부로 리팩터(동작 동일) | local-codex-assistant·hr-ai-integration 회귀 |
| `tests/bundle-exposure.test.mjs` | 견적 표지 추가 | 고객·담당자 데이터는 서버 전용이어야 한다. `app/quote-model.ts`처럼 클라이언트가 쓰는 모듈에는 데이터가 없어야 한다 |
| 운영 PC | 8765 서비스·예약 작업·방화벽 규칙 폐기(QT5), 도우미 2개 추가(127.0.0.1) | 열린 인바운드 포트가 하나 준다(3000만 남음) |
| 상위 계획 | D8 '보류' → 이 사이클로 진행 | xdnode-management.plan.md Next Steps 갱신 |

---

## 10. Architecture Considerations

### 10.1 원칙
- 탭 추가 규칙(FR-16)과 라우트 패턴(`ensureQuoteSchema` → `authorizeErpRequest(db, "quote", …)` → 원시 D1 SQL → `writeErpAudit`)을 그대로 쓴다. 서버 코드는 확장자 없는 상대 경로로만 import하고, 불린은 1/0으로 바인딩한다(CLAUDE.md Harness rules).
- 판단 로직(`quote-textkey`·`quote-confidence`·`quote-pricing`의 계산부·`quote-xlsx`·`quote-filename`·`quote-model`)은 I/O 없는 순수 모듈로 둔다. 옛 툴의 경계(`confidence.py`는 DB를 모른다, `catalog_v2`는 판단하지 않는다)를 import 방향으로 유지한다.
- 상태 변경 문은 `app/hr-transitions.ts`처럼 `D1PreparedStatement[]`를 돌려주는 빌더로 만들고 라우트가 `db.batch`로 실행한다.

### 10.2 테이블 초안 (Design에서 확정)

| 테이블 | 원천 | 주요 열 |
|------|------|------|
| `quote_corpus_files` | `quotes` 998 | `id`, `legacy_id`, `file`, `quote_date`, `customer_from_name`, `model_hint`, `contact_from_name`, `suffix`, `quote_json`(사전 생성, QT-Q10) |
| `quote_corpus_sheets` | `sheets` 1,189 | 원본 열 전부 + `legacy_id` |
| `quote_corpus_items` | `items` 5,509 | 원본 열 + 인덱스 `spec_first_line` |
| `quote_corpus_margin_items` | `margin_items` 59 | 원본 열 |
| `quote_issued` | `issued_quotes` 1 | 원본 열 + `author_account_id`, `author_name`(표시용 스냅샷), `staff_name`(dedup 재료, QT-Q4), `xlsx_key`, `pdf_key`, `legacy_id`. `dedup_key` 부분 UNIQUE, `status` CHECK(draft·confirmed·discarded·NULL) |
| `quote_price_log` | `price_log` 2 | 원본 열, 인덱스 `(name_key, issue_date)` |
| `quote_catalog_products` | `catalog_v2.json` 268 | `canonical`, `category`, `kind`, `spellings_json`, `history_json`, `n`, `min`, `max`, `last_price`, `last_date`, `note`, `caution` |
| `quote_catalog_legacy` | `catalog.json` products 480 | 폴백 경로와 추출 프롬프트용 |
| `quote_spec_library` | 87 | 모델명 → 멀티라인 사양 |
| `quote_customers` | 199곳 | 기관, 담당자·전화·메일, `last_date`, `n` (PII) |
| `quote_bom_library` | 314 | 원본 키 + `parts_json` |
| `quote_staff_profiles` | `staff.json` 10 | `id`, `name`, `tel`, `email`, `account_id`(선택), `sort`, `active` |
| `quote_meta` | 어휘·버전 | `key`, `value`(어휘 JSON, `catalog_version`, 템플릿 sha256) |
| `quote_source_snapshots` | 재구축 전용 JSON 원문 | `name`, `part`, `sha256`, `body` (QT-D4, R-QT8) |
| `quote_import_runs` | 이전 기록 | 시각, 원천 해시, 테이블별 건수, 결과 |

### 10.3 생성 흐름
`POST /api/quote/issued {action:"GENERATE", quote, suffix}` → 권한(edit) → Quote 정규화 → 파일명(KST 날짜) → 템플릿(R2, 해시 확인) → `buildQuoteXlsx()` → R2 `quote/issued/<id>/<rev>.xlsx` → `db.batch`(issued upsert + price_log 정리·팬아웃 + 감사) → PDF 도우미(실패는 응답에 `pdfError`만) → R2 PDF → `pdf_key` 갱신. issued id는 upsert의 `RETURNING id`로 받는다(툴 `store.py:178-179`가 `lastrowid`의 함정을 기록해 두었다).

---

## 11. Next Steps
1. ~~열린 질문 QT-Q1~Q15 답 받기~~ — 2026-10-02 모두 권장안으로 확정
2. QT0(QT-Q6 확정)을 툴 저장소에서 바로 진행(반나절). Design과 병행한다
3. Design 작성: 테이블 DDL, 라우트·액션 표, xlsx XML 조립 규칙(셀맵 스펙 §2~§6 대응표), 도우미 프로토콜, 화면 구성, 픽스처 생성 절차
4. Do: QT1 → QT2 → QT3 → QT4 → QT5 순서. 각 릴리스는 개발 서버 점검 뒤 운영에 반영한다

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.2 | 2026-10-02 | Plan 체크포인트: QT-Q1~Q15 모두 권장안으로 확정(사용자). 8765 재부팅 뒤 미기동 실측 반영 | gc.kim / Claude Code |
| 0.1 | 2026-10-02 | 초안. 옛 툴 전수 조사(경로 20개, 모듈 14개, 데이터 행 수), 사용자 결정 QT-D1~D5, 열린 질문 QT-Q1~Q15, 릴리스 QT0~QT5 | gc.kim / Claude Code |
