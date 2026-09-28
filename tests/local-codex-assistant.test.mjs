import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compactLeaveContext, recentAssistantConversation } from "../app/hr-assistant-context.ts";
import { validateRecruitmentInterview, formatRecruitmentQuestions } from "../app/assistant-recruitment.ts";

test("recruitment interview validates real dates and paired times, and formats editable questions", () => {
  assert.throws(() => validateRecruitmentInterview({ date: '2026-02-30', time: '10:00' }), /면접일/);
  assert.throws(() => validateRecruitmentInterview({ date: '2026-10-01', time: '' }), /함께/);
  assert.throws(() => validateRecruitmentInterview({ date: '2026-10-01', time: '24:00' }), /시작 시간/);
  assert.throws(() => validateRecruitmentInterview({}, true), /질문지/);
  const questions = formatRecruitmentQuestions([{ category: 'ROLE_SKILL', question: '서버 장애를 어떻게 진단합니까?', checkpoint: '진단 순서와 근거' }]);
  assert.match(questions, /지원 직무 역량/);
  assert.match(questions, /확인 포인트: 진단 순서와 근거/);
  assert.equal(validateRecruitmentInterview({ questions }, true).date, '');
});

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("assistant context bounds conversation and excludes ERP answers when data access is disabled", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i}`, answer: "x".repeat(5000), includedServerData: i % 2 === 0 }));
  const all = recentAssistantConversation(history, true);
  assert.equal(all.length, 4);
  assert.equal(all[0].question, "Question 4");
  assert.equal(all[0].answer.length, 4000);
  assert.deepEqual(recentAssistantConversation(history, false).map(entry => entry.question), ["Question 1", "Question 3", "Question 5", "Question 7"]);
});

test("assistant leave evidence retains source date and negative balance without sending usage reasons", () => {
  const result = compactLeaveContext({ today: "2026-09-21", ledgers: [{ employeeId: "synthetic", name: "Test", department: "Test", status: "재직", granted: 3, used: 4, expired: 0, balance: -1, overdraft: 1, email: "omitted@example.test", usages: [{ reason: "private detail" }] }] });
  assert.equal(result.asOf, "2026-09-21");
  assert.equal(result.employees[0].balance, -1);
  assert.equal(result.employees[0].overdraft, 1);
  assert.equal("usages" in result.employees[0], false);
  assert.equal("email" in result.employees[0], false);
});

test("local Codex assistant is mounted for HR, payroll and sales while its bridge stays read-only", async () => {
  const [page, component, bridge, claudeBridge, launcher, schema] = await Promise.all([
    read("app/page.tsx"), read("app/local-codex-assistant.tsx"), read("scripts/codex-assistant-bridge.mjs"),
    read("scripts/claude-assistant-bridge.mjs"),
    read("scripts/Start-XDNodeERP.ps1"), read("scripts/codex-assistant-response-schema.json"),
  ]);
  assert.match(page, /<LocalCodexAssistant module="hr"\s*\/>/);
  assert.match(page, /<LocalCodexAssistant module=\{compensationAssistantModule\}\s*\/>/);
  assert.match(page, /setCompensationAssistantModule/);
  assert.match(page, /<LocalCodexAssistant module="sales"\s*\/>/);
  assert.match(component, /type AssistantModule = "hr" \| "compensation" \| "sales"/);
  // 화면은 다리를 직접 부르지 않고 ERP 서버의 /api/assistant 를 부른다. 브라우저가 127.0.0.1 을 직접 부르면
  // 태블릿 등 다른 기기에서는 그 기기 자신을 가리켜 실패한다. 다리 호출은 서버 라우트가 데스크탑 안에서 한다.
  assert.match(component, /const assistantEndpoint = "\/api\/assistant";/);
  assert.doesNotMatch(component, /127\.0\.0\.1/);
  const assistantRoute = await read("app/api/assistant/route.ts");
  assert.match(assistantRoute, /CLAUDE_ASSISTANT_BRIDGE_URL\?\.trim\(\) \|\| "http:\/\/127\.0\.0\.1:3130"/);
  // Codex 다리(3110)는 buildPrompt 원본으로만 남고, 어시스턴트는 Claude 다리(3130)가 맡는다.
  assert.match(claudeBridge, /const PORT = Number\(process\.env\.XD_NODE_CLAUDE_ASSISTANT_PORT \|\| 3130\)/);
  assert.match(claudeBridge, /const HOST = "127\.0\.0\.1"/);
  // Codex 의 read-only 샌드박스 대신 도구를 모두 끈다(파일 읽기 포함은 tests/lan-exposure-guards.test.mjs).
  assert.match(claudeBridge, /const DISABLED_TOOLS = \["Bash", "Write", "Edit"/);
  assert.match(bridge, /const HOST = "127\.0\.0\.1"/);
  assert.match(bridge, /"--sandbox", "read-only"/);
  assert.match(bridge, /"--ephemeral"/);
  assert.match(bridge, /MODEL = "gpt-5\.6-terra"/);
  assert.match(bridge, /REASONING_EFFORT = "medium"/);
  assert.match(bridge, /model_reasoning_effort/);
  assert.match(bridge, /\["hr", "compensation", "sales"\]/);
  assert.match(bridge, /MAX_QUESTION_LENGTH = 2000/);
  assert.match(component, /includeServerData/);
  assert.match(component, /analyzeFile/);
  assert.match(component, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(component, /mammoth/);
  assert.match(component, /\.pdf,\.docx/);
  assert.match(component, /local-codex-file-picker/);
  assert.match(component, /분석할 파일 첨부/);
  assert.match(component, /UPDATE_HR_COMPENSATION_DEFAULTS/);
  assert.match(component, /CREATE_COMPENSATION_DRAFT/);
  assert.match(component, /CREATE_RECRUITMENT_APPLICANT/);
  assert.match(component, /RECORD_INTERVIEW_REJECTION/);
  assert.match(component, /CREATE_RECRUITMENT_OFFER/);
  assert.match(component, /priorPayrollRun/);
  assert.match(component, /incentiveCalculator/);
  assert.match(component, /\/api\/hr\/recruitment/);
  assert.match(component, /첨부한 이력서를 분석해 지원자 등록 변경안을 만들어줘/);
  assert.match(component, /맞춤 면접 질문 리스트를 만들어줘/);
  assert.match(component, /지원 포지션/);
  assert.match(component, /companyBusinessProfile/);
  assert.match(component, /AI·GPU 서버와 고성능 IT 인프라/);
  assert.match(component, /첨부 파일의 추출 텍스트/);
  assert.match(bridge, /CREATE_RECRUITMENT_APPLICANT/);
  assert.match(bridge, /CREATE_RECRUITMENT_OFFER/);
  assert.match(bridge, /interviewBrief/);
  assert.match(bridge, /직무와 무관한 민감한 개인정보/);
  assert.match(bridge, /영업·인센티브/);
  assert.match(component, /내용 확인 후 반영/);
  assert.doesNotMatch(bridge, /danger-full-access|--yolo|--full-auto/);
  // 시작 스크립트는 Codex 다리(3110)를 더 띄우지 않는다.
  assert.doesNotMatch(launcher, /\$AssistantPort = 3110/);
  assert.doesNotMatch(launcher, /npm\.cmd run assistant:bridge/);
  assert.match(launcher, /npm\.cmd run assistant:claude/);
  assert.match(schema, /"answer"/);
  assert.match(schema, /"proposedActions"/);
  assert.match(schema, /"CREATE_RECRUITMENT_APPLICANT"/);
  assert.match(schema, /"RECORD_INTERVIEW_REJECTION"/);
});
