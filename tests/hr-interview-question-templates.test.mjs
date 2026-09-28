import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMON_CLOSING,
  COMMON_COLLABORATION,
  COMMON_OPENING,
  DEFAULT_QUESTION_SHEET_MARK,
  GENERAL_FAMILY,
  INTERVIEW_QUESTION_FAMILIES,
  buildDefaultInterviewQuestions,
  matchInterviewQuestionFamily,
} from "../app/hr-interview-question-templates.ts";

const familyOf = (...sources) => matchInterviewQuestionFamily(sources).id;

test("실제 지원 직무 문구가 맞는 포지션 질문지로 이어진다", () => {
  // 지원자 관리에 실제로 쓰인 지원 직무 문구들이다.
  assert.equal(familyOf("영업/AI사업부"), "SALES");
  assert.equal(familyOf("영업지원"), "SALES_SUPPORT");
  assert.equal(familyOf("구매팀 국내 소싱 및 재고 관리"), "PURCHASE");
  assert.equal(familyOf("구매팀"), "PURCHASE");
  assert.equal(familyOf("물류"), "LOGISTICS");
  assert.equal(familyOf("물류관리자(재고관리), 유통관리자(상품입출고), SCM"), "LOGISTICS");
  assert.equal(familyOf("IT 개발 담당자"), "DEVELOPER");
  assert.equal(familyOf("[엑스디노드] IT 개발 담당자"), "DEVELOPER");
  assert.equal(familyOf("온라인 MD"), "ONLINE_MD");
  assert.equal(familyOf("총무"), "MANAGEMENT_SUPPORT");
});

test("팀 이름이 앞에 붙어도 뒤의 직무로 판단한다", () => {
  // 「구매팀」이 앞에 있어도 물류 직무다.
  assert.equal(familyOf("구매팀 물류 관리 팀원"), "LOGISTICS");
  assert.equal(familyOf("[구매팀] 물류 관리 팀원"), "LOGISTICS");
});

test("지원 직무로 판단이 안 되면 채용요청 직무·제목을 보고, 그래도 없으면 공통 질문지를 쓴다", () => {
  assert.equal(familyOf("바리스타", "영업", "AI사업팀 영업 채용"), "SALES");
  assert.equal(familyOf("", "", "지원팀 총무 채용"), "MANAGEMENT_SUPPORT");
  assert.equal(familyOf("바리스타"), GENERAL_FAMILY.id);
  assert.equal(familyOf(undefined, null, ""), GENERAL_FAMILY.id);
});

test("기본 질문지는 도입·직무 역량·업무 상황·협업·마무리 순서로, 질문마다 확인 포인트를 단다", () => {
  const sheet = buildDefaultInterviewQuestions({ role: "영업/AI사업부" });
  assert.equal(sheet.familyLabel, "영업");
  assert.ok(sheet.text.startsWith(`${DEFAULT_QUESTION_SHEET_MARK} · 영업`));
  const order = ["[도입·지원 동기]", "[직무 역량 · 영업]", "[XD NODE 업무 상황]", "[협업·문제해결]", "[마무리 확인]"].map((title) => sheet.text.indexOf(title));
  assert.ok(order.every((index) => index > 0), "모든 묶음이 있어야 한다");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "묶음 순서가 고정돼야 한다");
  const questions = sheet.text.split("\n").filter((line) => /^\d+\. /.test(line)).length;
  const checkpoints = sheet.text.split("\n").filter((line) => line.startsWith("   → 확인 포인트: ")).length;
  assert.equal(questions, checkpoints);
  const family = INTERVIEW_QUESTION_FAMILIES.find((item) => item.id === "SALES");
  assert.equal(questions, COMMON_OPENING.length + family.roleSkill.length + family.scenario.length + COMMON_COLLABORATION.length + COMMON_CLOSING.length);
});

test("기본 질문지는 직무와 무관한 민감한 개인정보를 묻지 않는다", () => {
  // 「장애」는 시스템 장애(고장) 뜻으로도 쓰이므로 장애인·장애 여부처럼 사람을 가리키는 표현만 잡는다.
  const sensitive = /나이|출신|고향|결혼|혼인|임신|출산|자녀|부모|가족|종교|건강|장애인|장애 여부|장애가 있|정치|병력|신장|체중|몸무게|재산/;
  const all = [...INTERVIEW_QUESTION_FAMILIES, GENERAL_FAMILY]
    .flatMap((family) => [...family.roleSkill, ...family.scenario])
    .concat(COMMON_OPENING, COMMON_COLLABORATION, COMMON_CLOSING);
  for (const item of all) {
    assert.doesNotMatch(item.question, sensitive, item.question);
    assert.ok(item.checkpoint.trim(), `확인 포인트가 비어 있다: ${item.question}`);
  }
});
