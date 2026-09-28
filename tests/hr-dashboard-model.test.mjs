import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardModel, dayGapFrom, exitDateOf, monthRange, tenureLabel } from "../app/hr-dashboard-model.ts";

const TODAY = "2026-09-08";
const REJECTED = ["서류 탈락", "면접 탈락", "면접 불참 탈락"];
const FUNNEL = ["서류 검토", "서류 합격", "면접", "면접 합격", "채용 제안 준비", "입사 예정", "입사 완료"];

const employee = (overrides) => ({
  id: "e1", name: "직원", department: "구매팀", position: "사원", type: "일반직4.5", joinDate: "2024.11.14", status: "재직",
  email: "e@x.kr", phone: "010-0000-0000", address: "서울", birth: "1990.01.01", history: [], ...overrides,
});
const shift = (date, months, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const firstTerm = (joinDate) => ({ endDate: shift(joinDate, 3, -1), nextStart: shift(joinDate, 3, 0) });
const isCurrent = (item) => item.status.trim() !== "퇴직" && !["EFFECTIVE", "COMPLETED"].includes(item.retirement?.status ?? "");

function build(overrides = {}) {
  return buildDashboardModel({
    today: TODAY, employees: [], organizations: [{ id: "o1", name: "구매팀" }, { id: "o2", name: "AI사업팀" }], applicants: [], requisitions: [],
    lifecycleTasks: [], payrollRuns: [], roles: ["HR_ADMIN"], isCurrent, isRejectedStage: (stage) => REJECTED.includes(stage), funnelStages: FUNNEL, firstTerm,
    ...overrides,
  });
}

test("날짜 도우미 — 점 구분 입사일도 D-day 와 근속 단위를 바르게 낸다", () => {
  assert.equal(dayGapFrom(TODAY, "2026.09.10"), 2);
  assert.equal(dayGapFrom(TODAY, "미입력"), null);
  assert.equal(tenureLabel(TODAY, "2026.09.07"), "1일");
  assert.equal(tenureLabel(TODAY, "2026.06.10"), "2개월");
  assert.equal(tenureLabel(TODAY, "2024.11.14"), "1년 9개월");
  assert.equal(tenureLabel(TODAY, "2026.10.01"), "-");
  assert.deepEqual(monthRange("2026-02-15", 3), ["2025-12", "2026-01", "2026-02"]);
});

test("퇴직일은 퇴직 요청 날짜, 없으면 인사이력의 퇴직 항목에서 읽는다", () => {
  assert.equal(exitDateOf(employee({ status: "퇴직", retirement: { date: "2026-08-31", status: "EFFECTIVE" } })), "2026-08-31");
  assert.equal(exitDateOf(employee({ status: "퇴직", history: [{ date: "2026.07.06", type: "입사", detail: "" }, { date: "2026.08.31", type: "퇴직", detail: "" }] })), "2026-08-31");
  assert.equal(exitDateOf(employee({ status: "재직", retirement: { date: "2026-09-30", status: "IN_PROGRESS" } })), "");
});

test("처리 대기함은 긴급(마감 경과) → 주의 → 참고 순으로, 같은 급에서는 마감이 이른 순으로 선다", () => {
  const model = build({
    employees: [
      employee({ id: "lee", name: "이퇴직", status: "퇴직", retirement: { date: "2026-08-31", status: "EFFECTIVE" } }),
      employee({ id: "kim", name: "김미입력", email: "미입력", birth: "" }),
      employee({ id: "new", name: "박신입", joinDate: "2026.06.10" }),
    ],
    applicants: [
      { id: "a1", name: "오퍼대기", role: "영업", stage: "채용 제안 준비", offer: { status: "APPROVED", startDate: "2026-09-15", department: "AI사업팀", proposedTitle: "영업" } },
      { id: "a2", name: "입사자", role: "구매", stage: "입사 완료", offer: { status: "ONBOARDED", startDate: "2026-06-10", employeeId: "new" } },
      { id: "a3", name: "문용상", role: "영업", stage: "입사 예정", offer: { status: "ACCEPTED", startDate: "2026-10-06", employeeId: "ys.moon" } },
    ],
    lifecycleTasks: [
      { id: "t1", employee_id: "new", lifecycle_type: "ONBOARDING", title: "계정 발급", due_date: "2026-09-01", status: "OPEN" },
      { id: "t2", employee_id: "new", lifecycle_type: "ONBOARDING", title: "장비 지급", due_date: "2026-09-01", status: "OPEN" },
      { id: "t3", employee_id: "new", lifecycle_type: "ONBOARDING", title: "완료건", due_date: "2026-08-13", status: "DONE" },
      // 아직 인사기록카드에 없는 입사 예정자 — 오퍼의 사번으로 지원자 이름을 찾는다.
      { id: "t5", employee_id: "ys.moon", lifecycle_type: "ONBOARDING", title: "근로계약서 작성·서명", due_date: "2026-10-06", status: "OPEN" },
      // 퇴직 절차는 일반 체크리스트라 대시보드에 올리지 않는다.
      { id: "t4", employee_id: "lee", lifecycle_type: "RETIREMENT", title: "퇴직 승인", due_date: "2026-08-31", status: "OPEN" },
    ],
    payrollRuns: [{ period: "2026-08", status: "DRAFT", employee_count: 28, net_pay: 1000 }, { period: "2026-07", status: "LOCKED" }],
  });
  const kinds = model.inbox.map((item) => `${item.priority}:${item.kind}`);
  // 입사 과제는 마감 경과라 긴급. 주의 셋은 마감이 이른 순 — 8월 급여(8/31) → 첫 계약 만료(입사 6/10 → 9/9) → 오퍼 입사 예정(9/15).
  assert.deepEqual(kinds, ["critical:입사 절차", "warning:급여 마감", "warning:정규직 전환", "warning:오퍼 회신 대기", "info:입사 절차", "info:인사정보 미입력"]);
  assert.match(model.inbox.find((item) => item.id === "tasks:ONBOARDING:ys.moon").title, /^문용상님 입사 절차 미완료 1건$/);
  assert.match(model.inbox[0].title, /박신입님 입사 절차 미완료 2건/);
  assert.match(model.inbox[0].detail, /D\+7/);
  assert.equal(model.inbox[0].target.view, "onboarding");
  assert.match(model.inbox.at(-1).detail, /이메일·생년월일 미입력/);
  assert.equal(model.inbox.at(-1).target.employeeId, "kim");
  assert.equal(model.renewals.length, 1);
  assert.equal(model.renewals[0].state.tone, "due");
  assert.equal(model.payroll.staleCount, 1);
  assert.equal(model.payroll.currentMonthPrepared, false);
});

test("타임라인은 면접·입사·회신 대기·퇴사·계약 만료를 날짜순으로 한 줄에 세운다", () => {
  const model = build({
    employees: [employee({ id: "go", name: "고퇴사", retirement: { date: "2026-09-20", status: "IN_PROGRESS", reason: "이직" } })],
    applicants: [
      { id: "a1", name: "면접자", role: "영업", stage: "서류 합격", interview: { date: "2026-09-10", time: "14:00", type: "1차 대면" } },
      { id: "a2", name: "탈락자", role: "영업", stage: "면접 탈락", interview: { date: "2026-09-09", time: "10:00" } },
      { id: "a3", name: "입사예정", role: "구매", stage: "입사 예정", offer: { status: "ACCEPTED", startDate: "2026-10-06", department: "구매팀" } },
    ],
  });
  assert.deepEqual(model.timeline.map((item) => `${item.date} ${item.kind} ${item.who}`), ["2026-09-10 면접 면접자", "2026-09-20 퇴사 고퇴사", "2026-10-06 입사 입사예정"]);
  assert.equal(model.timeline[0].target.applicantId, "a1");
  assert.equal(model.metrics.find((metric) => metric.label === "면접 예정").value, 1);
  assert.equal(model.metrics.find((metric) => metric.label === "퇴사 예정").value, 1);
});

test("채용 파이프라인은 단계별 인원과 채용요청별 충원(확정·입사) 수를 센다", () => {
  const model = build({
    requisitions: [
      { id: "r1", title: "AI사업팀 영업 채용", role: "영업", organizationId: "o2", requestedHeadcount: 2, status: "OPEN" },
      { id: "r2", title: "닫힌 요청", role: "MD", organizationId: "o2", requestedHeadcount: 1, status: "CLOSED" },
    ],
    applicants: [
      { id: "a1", name: "확정", role: "영업", stage: "입사 예정", requisitionId: "r1", offer: { status: "ACCEPTED", startDate: "2026-10-06" } },
      { id: "a2", name: "진행", role: "영업", stage: "서류 합격", requisitionId: "r1" },
      { id: "a3", name: "탈락", role: "영업", stage: "서류 탈락", requisitionId: "r1" },
    ],
  });
  assert.equal(model.requisitions.length, 1);
  assert.deepEqual({ filled: model.requisitions[0].filled, active: model.requisitions[0].active, organization: model.requisitions[0].organization }, { filled: 1, active: 1, organization: "AI사업팀" });
  assert.equal(model.funnel.find((item) => item.stage === "서류 합격").count, 1);
});

test("12개월 흐름은 입사·퇴사 건수와 월말 재직 인원을 달마다 낸다", () => {
  const model = build({
    employees: [
      employee({ id: "a", joinDate: "2025.04.04", status: "퇴직", retirement: { date: "2026-08-31", status: "EFFECTIVE" } }),
      employee({ id: "b", joinDate: "2026.08.10" }),
      employee({ id: "c", joinDate: "2026.09.07" }),
      employee({ id: "d", joinDate: "2024.11.14", type: "일반직" }),
    ],
  });
  const august = model.flow.find((month) => month.month === "2026-08");
  const september = model.flow.find((month) => month.month === "2026-09");
  assert.deepEqual({ joins: august.joins, exits: august.exits, headcount: august.headcount }, { joins: 1, exits: 1, headcount: 2 });
  assert.deepEqual({ joins: september.joins, exits: september.exits, headcount: september.headcount }, { joins: 1, exits: 0, headcount: 3 });
  assert.equal(model.flow.length, 12);
  assert.equal(model.metrics[0].delta, "+1 전월 대비");
  assert.deepEqual(model.employmentTypes.map((item) => `${item.type}:${item.count}`), ["일반직4.5:2", "일반직:1"]);
  assert.deepEqual(model.headcount.map((row) => `${row.organization}:${row.count}`), ["구매팀:3", "AI사업팀:0"]);
});

test("채용담당자만 가진 사람에게는 채용 파이프라인이 처리 대기함보다 앞선다", () => {
  assert.equal(build({ roles: ["RECRUITER"] }).sectionOrder[0], "pipeline");
  assert.equal(build({ roles: ["RECRUITER", "HR_ADMIN"] }).sectionOrder[0], "inbox");
  assert.equal(build({ roles: [] }).sectionOrder[0], "inbox");
});

test("정규직 전환 예정은 재직자 전원이 대상이고, 만료 60일이 지나도록 기록이 없으면 누락으로 따로 센다", () => {
  const model = build({
    employees: [
      employee({ id: "fresh", name: "신입", joinDate: "2026.07.01" }),                               // 만료 9/30 → 30일 안, 표에 오른다 (오퍼 기록 없어도)
      employee({ id: "late", name: "지연", joinDate: "2026.05.01" }),                                // 만료 7/31 → 39일 경과, 아직 표에 남는다
      employee({ id: "old", name: "고참", joinDate: "2025.04.04" }),                                 // 만료가 1년 넘게 지남 → 기록 누락
      employee({ id: "done", name: "전환완료", joinDate: "2026.05.01", regularContractDate: "2026-08-01" }),
      employee({ id: "ended", name: "종료", joinDate: "2026.05.01", firstTermReview: { decision: "END" } }),
      employee({ id: "far", name: "먼미래", joinDate: "2026.09.01" }),                               // 만료 11/30 → 아직 멀다
    ],
  });
  assert.deepEqual(model.renewals.map((item) => `${item.employee.id}:${item.state.tone}`), ["late:overdue", "fresh:soon"]);
  assert.deepEqual(model.missingRegularRecords.map((item) => item.employee.id), ["old"]);
  assert.equal(model.metrics.find((metric) => metric.label === "정규직 전환 예정").value, 2);
});

test("연차 촉진 2차와 초과 사용은 주의로, 1차 촉진은 참고로 처리 대기함에 오른다", () => {
  const model = build({ leaveLedgers: [
    { employeeId: "a", name: "가", department: "구매팀", balance: 3, promotions: [{ stage: "SECOND", label: "11개월차 월차", remaining: 0.25, expiresAt: "2026-09-22", daysLeft: 1 }] },
    { employeeId: "b", name: "나", department: "AI사업팀", balance: -1.25, promotions: [{ stage: "FIRST", label: "2주년 연차", remaining: 14, expiresAt: "2027-01-15", daysLeft: 116 }] },
  ] });
  // 초과 사용은 마감이 오늘이라 같은 주의 급에서 소멸 예정(9/22)보다 앞선다.
  assert.deepEqual(model.inbox.map((item) => `${item.priority}:${item.kind}`), ["warning:연차 초과 사용", "warning:연차 촉진 2차", "info:연차 촉진 1차"]);
  assert.equal(model.inbox[0].title, "나님 연차 1.25일 초과 사용");
  assert.equal(model.inbox[0].target.view, "leave");
});
