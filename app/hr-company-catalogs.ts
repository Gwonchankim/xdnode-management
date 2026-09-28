// 조직·직급·직책 카탈로그. 개인정보가 없어 클라이언트 번들에 들어가도 된다(R1 M1-3, Design §12.5).
// 직원 명부·보상 시드는 서버 전용 app/hr-company-data.ts에 있다.

export type CompanyOrganizationSeed = {
  id: string;
  name: string;
  leaderEmployeeId: string | null;
  description: string;
};

export const companyOrganizations: CompanyOrganizationSeed[] = [
  { id: "org-purchase", name: "구매팀", leaderEmployeeId: null, description: "구매 및 조달 업무" },
  { id: "org-online", name: "온라인팀", leaderEmployeeId: null, description: "온라인 채널 및 마케팅 업무" },
  { id: "org-ai-business", name: "AI사업팀", leaderEmployeeId: null, description: "AI 사업 영업 및 고객 관리" },
  { id: "org-support", name: "지원팀", leaderEmployeeId: null, description: "경영지원 및 영업지원 업무" },
  { id: "org-technology", name: "기술팀", leaderEmployeeId: null, description: "기술지원 업무" },
  { id: "org-unassigned", name: "소속 미지정", leaderEmployeeId: null, description: "원본 자료에 소속 조직이 입력되지 않은 인원" },
];

// 직위 서열. 낮은 쪽부터 늘어놓는다 — 승진·강등은 이 순서로 판정한다.
export const companyRanks = ["사원", "주임", "대리", "과장", "차장", "팀장", "대표"];
export const companyJobTitles = ["구매", "마케팅", "영업", "경영지원", "기술지원", "영업지원", "미지정", "조직장"];
