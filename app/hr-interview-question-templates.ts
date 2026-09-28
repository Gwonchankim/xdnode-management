/** 포지션별 기본 면접 질문지.
 *
 *  면접 일정이 확정되면(면접일이 들어오면) 지원 포지션에 맞는 질문지를 AI 없이 바로 채운다.
 *  그 뒤 면접 상황에 따라 「심화 질문 생성」(이력서·면접 메모 기반 AI)이나
 *  「역제안 질문 생성」(역제안 포지션 AI)으로 아래에 덧붙인다. 흐름: app/hr-workspace.tsx ApplicantDetail.
 *
 *  질문을 고치려면 이 파일의 문구만 바꾸면 된다. 직무와 무관한 민감한 개인정보(출신·나이·가족·혼인·임신·
 *  종교·건강·장애·정치성향)는 묻지 않는다 — tests/hr-interview-question-templates.test.mjs 가 막는다. */

export type InterviewQuestionTemplateItem = { question: string; checkpoint: string };

export type InterviewQuestionFamily = {
  id: string;
  /** 질문지 머리말과 직무 역량 묶음 제목에 쓰는 이름. */
  label: string;
  /** 지원 직무·채용요청 문구에서 찾을 말. 소문자·공백 제거 후 비교한다. */
  keywords: string[];
  roleSkill: InterviewQuestionTemplateItem[];
  scenario: InterviewQuestionTemplateItem[];
};

const q = (question: string, checkpoint: string): InterviewQuestionTemplateItem => ({ question, checkpoint });

export const COMMON_OPENING: InterviewQuestionTemplateItem[] = [
  q("간단한 자기소개와 함께, 최근 경력에서 가장 비중 있게 맡았던 업무를 설명해 주세요.", "핵심 경력을 1~2분 안에 구조적으로 전달하는지"),
  q("XD NODE와 이 포지션에 지원한 이유는 무엇인가요?", "회사 사업(AI·GPU 인프라 B2B)과 직무를 이해하고 지원했는지"),
  q("이전 직장을 떠나려는(떠난) 이유와 다음 직장에서 기대하는 점을 말씀해 주세요.", "이직 사유의 일관성, 기대와 실제 업무의 차이"),
];

export const COMMON_COLLABORATION: InterviewQuestionTemplateItem[] = [
  q("다른 부서와 의견이 부딪혔던 경험과 어떻게 조율했는지 말씀해 주세요.", "상대 입장 이해, 근거를 들어 조율하는지, 결과"),
  q("업무 중 실수나 누락을 발견했을 때 어떻게 처리했는지 사례를 들어 주세요.", "즉시 공유, 원인 파악, 재발 방지 태도"),
];

export const COMMON_CLOSING: InterviewQuestionTemplateItem[] = [
  q("입사가 가능한 시점과 현재 재직·인수인계 상황을 알려 주세요.", "입사예정일 협의 가능 범위"),
  q("희망하시는 처우 수준과 그 근거를 말씀해 주세요.", "기대 처우와 제안 가능 범위의 차이"),
  q("회사나 업무에 대해 궁금한 점이 있으신가요?", "질문의 구체성으로 관심도 확인"),
];

/** 순서가 곧 우선순위다. 두 직무의 말이 같은 수만큼 맞으면 앞의 것을 고른다
 *  (예: 「사업개발」은 영업과 개발에 모두 걸리지만 영업이 앞이다). */
export const INTERVIEW_QUESTION_FAMILIES: InterviewQuestionFamily[] = [
  {
    id: "SALES_SUPPORT", label: "영업지원",
    keywords: ["영업지원", "영업관리", "영업사무"],
    roleSkill: [
      q("견적서·발주서·계약서 같은 영업 문서를 작성하거나 검토해 본 경험을 구체적으로 말씀해 주세요.", "문서 종류별로 확인할 항목을 알고 있는지"),
      q("주문 접수부터 납품, 세금계산서 발행, 수금 확인까지의 흐름 중 맡아 본 부분은 어디인가요?", "주문 흐름 전체에 대한 이해도"),
      q("여러 영업 담당자의 요청이 동시에 몰릴 때 우선순위를 어떻게 정하셨나요?", "우선순위 기준과 공유 방식"),
      q("엑셀 등으로 영업 데이터를 정리·집계해 본 경험과 자주 쓴 기능을 말씀해 주세요.", "데이터 정확성, 도구 활용 수준"),
    ],
    scenario: [
      q("고객에게 나간 견적 금액과 발주서 금액이 다르다는 것을 발견했다면 어떻게 처리하시겠습니까?", "즉시 확인·보고, 근거 문서 대조"),
      q("납기가 임박했는데 입고가 늦어진다는 연락을 받았다면 누구에게 어떤 순서로 알리시겠습니까?", "영업·구매·고객 사이 전달 순서"),
    ],
  },
  {
    id: "SALES", label: "영업",
    keywords: ["영업", "세일즈", "sales", "사업개발", "ai사업", "b2b", "어카운트"],
    roleSkill: [
      q("신규 고객을 발굴해 첫 계약까지 이끈 과정을 단계별로 설명해 주세요.", "리드 발굴 경로, 의사결정자 접근, 계약까지 걸린 기간"),
      q("고객 요구사항이 모호할 때 무엇을 먼저 확인해 제안서를 만드셨나요?", "요구사항을 묻는 역량, 기술·예산·일정 확인 순서"),
      q("견적을 낼 때 마진과 수주 가능성 사이에서 판단했던 사례가 있나요?", "원가·마진 감각, 가격 협상 기준"),
      q("계약 이후 납기 지연이나 수금 문제를 겪었다면 어떻게 대응했나요?", "계약·납기·수금까지 책임지는 태도"),
    ],
    scenario: [
      q("고객이 GPU 서버 10대를 한 달 안에 요청했는데 공급사 납기가 6주라면 고객에게 어떻게 제안하시겠습니까?", "부분 납품·대체 사양 같은 대안, 솔직한 커뮤니케이션"),
      q("경쟁사가 10% 낮은 견적을 냈다고 고객이 알려 오면 어떻게 대응하시겠습니까?", "가격 외 가치 제시, 마진 하한 인식"),
    ],
  },
  {
    id: "PURCHASE", label: "구매",
    keywords: ["구매", "소싱", "조달", "발주", "벤더", "협력사", "원가"],
    roleSkill: [
      q("새 공급처를 발굴하고 평가해 거래를 시작한 경험을 말씀해 주세요.", "공급처 평가 기준(가격·품질·납기·신뢰도)"),
      q("원가를 절감했던 사례와 그 결과를 수치로 설명해 주세요.", "협상 방식, 절감 효과의 근거"),
      q("발주 후 납기가 늦어지거나 사양이 다른 물품이 들어왔을 때 어떻게 대응했나요?", "리스크 대응, 공급사 관리"),
      q("서버·부품처럼 사양 호환성이 중요한 품목을 다뤄 본 적이 있나요?", "사양 확인 습관, 기술 담당과의 협업"),
    ],
    scenario: [
      q("영업이 급하게 요청한 GPU 모델이 단종 예정이라는 정보를 들었다면 어떻게 하시겠습니까?", "대체 모델 확인, 영업과의 조율, 재고 확보 판단"),
      q("한 공급사는 싸지만 납기가 불확실하고 다른 곳은 비싸지만 안정적이라면 어떻게 결정하시겠습니까?", "판단 기준을 먼저 세우는지"),
    ],
  },
  {
    id: "LOGISTICS", label: "물류",
    keywords: ["물류", "입출고", "재고관리", "scm", "유통관리", "창고", "배송", "출고"],
    roleSkill: [
      q("입고부터 보관·출고까지 직접 운영해 본 물류 흐름을 설명해 주세요.", "흐름 전체 이해도와 맡았던 범위"),
      q("재고 실사에서 수량 차이가 났을 때 원인을 어떻게 찾고 바로잡았나요?", "원인 추적 방법, 재발 방지"),
      q("사용해 본 재고·물류 시스템(ERP, WMS, 엑셀 등)과 활용 수준을 말씀해 주세요.", "도구 숙련도"),
      q("고가 장비나 파손 위험이 큰 물품을 출고할 때 무엇을 확인하셨나요?", "검수·포장·운송 확인 습관"),
    ],
    scenario: [
      q("오늘 출고할 서버의 시리얼 번호가 발주 서류와 다르다면 어떻게 하시겠습니까?", "출고 보류, 확인 순서, 보고"),
      q("월말에 출고가 몰려 당일 처리가 어려울 때 우선순위를 어떻게 정하시겠습니까?", "납기·고객 영향 기준의 판단"),
    ],
  },
  {
    id: "TECH_SUPPORT", label: "기술지원",
    keywords: ["기술지원", "인프라", "서버", "구축", "네트워크", "유지보수", "시스템엔지니어"],
    roleSkill: [
      q("서버·스토리지·네트워크 장비를 구성하거나 설치해 본 경험을 설명해 주세요.", "실제 장비 경험과 담당 범위"),
      q("GPU 서버 사양(CPU·GPU·메모리·전원·냉각)을 고객 용도에 맞게 검토해 본 적이 있나요?", "호환성·구성 판단 역량"),
      q("고객 현장에서 장애가 났을 때 대응한 사례를 순서대로 말씀해 주세요.", "원인 파악, 고객 커뮤니케이션"),
      q("기술 내용을 비전문가 고객에게 설명해야 했던 경험이 있나요?", "쉽게 설명하는 능력"),
    ],
    scenario: [
      q("납품한 서버가 부팅은 되는데 GPU 하나를 인식하지 못한다는 연락을 받으면 어떻게 진행하시겠습니까?", "원격 확인, 현장 점검, 교체 판단의 순서"),
      q("영업이 고객 요구와 맞지 않는 사양으로 견적을 냈다는 것을 발견하면 어떻게 하시겠습니까?", "즉시 공유, 대안 사양 제시"),
    ],
  },
  {
    id: "DEVELOPER", label: "IT 개발",
    keywords: ["개발", "개발자", "프로그래머", "developer", "소프트웨어", "it", "웹"],
    roleSkill: [
      q("최근 프로젝트에서 맡은 역할과 사용한 기술, 본인이 직접 구현한 부분을 설명해 주세요.", "기여 범위를 구체적으로 구분하는지"),
      q("운영 중인 서비스의 장애나 버그를 원인·조치·재발 방지 순서로 해결한 경험을 말씀해 주세요.", "문제 해결 과정의 논리성"),
      q("현업 담당자의 요청을 기능으로 바꿀 때 요구사항을 어떻게 정리하셨나요?", "비개발자와의 소통, 요구사항 정의"),
      q("데이터베이스 설계나 외부 API 연동 경험이 있다면 설명해 주세요.", "데이터 구조 이해, 연동 경험"),
    ],
    scenario: [
      q("사내 ERP의 급여 계산 결과가 엑셀과 몇 원 차이 난다는 문의를 받으면 어떻게 확인하시겠습니까?", "재현, 비교, 원인 분리의 순서"),
      q("영업팀이 고객별 견적 이력을 한눈에 보고 싶어 한다면 어떤 화면과 데이터를 먼저 설계하시겠습니까?", "사용자 관점 설계, 우선순위"),
    ],
  },
  {
    id: "ONLINE_MD", label: "온라인 MD·마케팅",
    keywords: ["md", "온라인", "마케팅", "상품기획", "쇼핑몰", "콘텐츠", "광고", "브랜드", "이커머스"],
    roleSkill: [
      q("온라인 채널에서 상품을 기획·등록·운영해 본 경험을 설명해 주세요.", "운영 채널과 담당 범위"),
      q("매출이나 전환율을 끌어올린 캠페인 사례를 수치와 함께 말씀해 주세요.", "성과 지표 이해, 원인 분석"),
      q("판매 데이터를 보고 가격·구성·노출을 바꿔 본 경험이 있나요?", "데이터에 근거한 판단"),
      q("상세페이지나 콘텐츠를 만들 때 누구와 어떻게 역할을 나눠 협업했나요?", "디자이너·영업과의 협업"),
    ],
    scenario: [
      q("IT 장비처럼 사양이 복잡한 상품을 온라인에서 판다면 상세페이지에 무엇을 먼저 보여주시겠습니까?", "고객 관점의 정보 구조"),
      q("광고비를 늘렸는데 문의만 늘고 주문이 늘지 않는다면 무엇부터 확인하시겠습니까?", "퍼널 분석, 가설 검증"),
    ],
  },
  {
    id: "MANAGEMENT_SUPPORT", label: "경영지원·총무",
    keywords: ["총무", "경영지원", "인사", "회계", "재무", "세무", "경리", "사무", "급여"],
    roleSkill: [
      q("총무·경영지원 업무 중 직접 맡아 운영한 일을 구체적으로 말씀해 주세요.", "실무 범위(자산·계약·비품·문서 관리 등)"),
      q("비용 처리나 증빙 관리를 해 봤다면 어떤 기준으로 처리했나요?", "증빙 정확성, 내부 규정 준수"),
      q("반복 업무를 줄이려고 절차나 서식을 바꿔 본 사례가 있나요?", "개선 의지와 실제 결과"),
      q("인사·급여 같은 기밀 정보를 다룰 때 지켜 온 원칙은 무엇인가요?", "기밀 유지 태도"),
    ],
    scenario: [
      q("여러 부서가 같은 날 비품·장비 요청을 급하게 보낸다면 어떻게 처리하시겠습니까?", "우선순위 기준, 소통 방식"),
      q("거래처 계약 갱신일을 놓치지 않으려면 어떤 관리 방식을 쓰시겠습니까?", "기한 관리 체계"),
    ],
  },
];

/** 어느 직무에도 걸리지 않을 때 쓰는 공통 직무 질문. */
export const GENERAL_FAMILY: InterviewQuestionFamily = {
  id: "GENERAL", label: "공통",
  keywords: [],
  roleSkill: [
    q("지원 직무와 가장 가까운 경험을 하나 골라 맡은 역할과 결과를 설명해 주세요.", "직무 관련 경험의 깊이"),
    q("업무 성과를 스스로 어떤 기준으로 평가해 왔나요?", "성과 기준의 구체성"),
    q("새로운 업무를 빠르게 익혀야 했던 경험과 그 방법을 말씀해 주세요.", "학습 방식"),
  ],
  scenario: [
    q("입사 첫 달에 맡은 업무의 기준이나 자료가 부족하다면 어떻게 시작하시겠습니까?", "스스로 정보를 모으고 확인하는 방식"),
  ],
};

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");

/** 「구매팀 물류 관리 팀원」처럼 팀 이름이 앞에 붙으면 팀 이름이 직무로 잘못 읽힌다. 팀·회사 표기를 걷어 낸다.
 *  걷어 내고 남는 말이 없으면(「구매팀」만 적힌 경우) 원문을 그대로 쓴다. */
function withoutTeamNames(value: string) {
  const stripped = value.replace(/\[[^\]]*\]/g, " ").replace(/\S+팀(?=\s|$)/g, " ").trim();
  return stripped || value;
}

function scoreFamily(family: InterviewQuestionFamily, text: string) {
  const target = normalize(text);
  return family.keywords.filter((keyword) => target.includes(normalize(keyword))).length;
}

/** 지원 직무 → 채용요청 직무 → 채용요청 제목 순으로 보고, 처음 걸리는 문구에서 가장 많이 맞는 직무를 고른다. */
export function matchInterviewQuestionFamily(sources: Array<string | undefined | null>): InterviewQuestionFamily {
  for (const source of sources) {
    const text = withoutTeamNames(String(source ?? "").trim());
    if (!text) continue;
    let best: InterviewQuestionFamily | null = null;
    let bestScore = 0;
    for (const family of INTERVIEW_QUESTION_FAMILIES) {
      const score = scoreFamily(family, text);
      if (score > bestScore) { best = family; bestScore = score; }
    }
    if (best) return best;
  }
  return GENERAL_FAMILY;
}

function block(title: string, items: InterviewQuestionTemplateItem[]) {
  return [`[${title}]`, ...items.map((item, index) => `${index + 1}. ${item.question}\n   → 확인 포인트: ${item.checkpoint}`)].join("\n");
}

/** 기본 질문지 머리말. 이 줄로 시작하면 자동으로 만든 질문지다. */
export const DEFAULT_QUESTION_SHEET_MARK = "※ 기본 질문지";

export function buildDefaultInterviewQuestions(position: { role?: string; requisitionRole?: string; requisitionTitle?: string }) {
  const family = matchInterviewQuestionFamily([position.role, position.requisitionRole, position.requisitionTitle]);
  const text = [
    `${DEFAULT_QUESTION_SHEET_MARK} · ${family.label} — 면접 일정 확정 시 자동 작성. 필요 없는 질문은 지우고 쓰세요.`,
    block("도입·지원 동기", COMMON_OPENING),
    block(`직무 역량 · ${family.label}`, family.roleSkill),
    block("XD NODE 업무 상황", family.scenario),
    block("협업·문제해결", COMMON_COLLABORATION),
    block("마무리 확인", COMMON_CLOSING),
  ].join("\n\n");
  return { familyId: family.id, familyLabel: family.label, text };
}
