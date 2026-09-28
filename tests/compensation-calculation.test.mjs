import assert from "node:assert/strict";
import test from "node:test";

import { calculateCompensation } from "../app/compensation-calculation.ts";

const columns = { research: true, extra: true, welfare: false, severance: true };

function employee(patch = {}) {
  return {
    id: "employee-1",
    name: "테스트 직원",
    department: "경영지원팀",
    title: "사원",
    birthDate: "1990-01-01",
    joinDate: "2024-01-01",
    leaveDate: "",
    probationMonths: 0,
    annualSalary: 60_000_000,
    basePay: 0,
    manualBasic: false,
    meal: 200_000,
    car: 200_000,
    child: 200_000,
    monthly: {},
    ...patch,
  };
}

test("full-month salary removes included tax-free allowances from basic pay", () => {
  const result = calculateCompensation(employee(), 2026, 8, "round", columns);
  assert.equal(result.days, 31);
  assert.equal(result.basic, 4_400_000);
  assert.equal(result.meal + result.car + result.child, 600_000);
  assert.equal(result.total, 5_000_000);
});

test("partial-month pay follows the confirmed 365-day method and rounds basic pay per the selected mode", () => {
  const result = calculateCompensation(employee({
    annualSalary: 39_000_000,
    joinDate: "2026-08-19",
    meal: 200_000,
    car: 0,
    child: 0,
  }), 2026, 8, "round", columns);
  assert.equal(result.days, 13);
  assert.equal(result.basic, 1_303_562);
  assert.equal(result.meal, 85_479);
  assert.equal(result.total, 1_389_041);
});

test("partial-month basic pay honors down/up rounding instead of always flooring", () => {
  const base = employee({ annualSalary: 39_000_000, joinDate: "2026-08-19", meal: 200_000, car: 0, child: 0 });
  const down = calculateCompensation(base, 2026, 8, "down", columns);
  const up = calculateCompensation(base, 2026, 8, "up", columns);
  assert.equal(down.basic, 1_303_561);
  assert.equal(up.basic, 1_303_562);
});

test("probation ending mid-month splits 90 and 100 percent salary segments", () => {
  const result = calculateCompensation(employee({
    annualSalary: 30_000_000,
    joinDate: "2026-04-06",
    probationMonths: 3,
    meal: 200_000,
    car: 0,
    child: 0,
  }), 2026, 7, "round", columns);
  assert.equal(result.probationEnd?.toISOString().slice(0, 10), "2026-07-05");
  assert.equal(result.days, 31);
  assert.equal(result.mixedProbation, true);
  assert.equal(result.basic, 2_303_013);
  assert.equal(result.total, 2_503_013);
});

test("manual monthly basic pay and optional columns stay explicit", () => {
  const result = calculateCompensation(employee({
    annualSalary: 0,
    manualBasic: true,
    meal: 0,
    car: 0,
    child: 0,
    monthly: { "2026-08": { basic: 3_000_000, extra: 500_000, research: 200_000, severance: 100_000 } },
  }), 2026, 8, "down", { ...columns, research: false });
  assert.equal(result.basic, 3_000_000);
  assert.equal(result.research, 0);
  assert.equal(result.total, 3_600_000);
});

test("HR base-pay default is used and prorated when a manual-basic employee leaves mid-month", () => {
  const result = calculateCompensation(employee({
    annualSalary: 0,
    basePay: 3_100_000,
    manualBasic: true,
    leaveDate: "2026-08-15",
    meal: 200_000,
    car: 100_000,
    child: 0,
  }), 2026, 8, "down", columns);
  assert.equal(result.days, 15);
  assert.equal(result.basic, Math.floor(3_100_000 * 12 / 365 * 15));
  assert.equal(result.meal, Math.floor(200_000 * 12 / 365 * 15));
  assert.equal(result.car, Math.floor(100_000 * 12 / 365 * 15));
});

// 서버 검증식(app/api/compensation/route.ts 의 validateDraft)이 이 total 산식과 어긋나면
// 자동 저장이 통째로 400 으로 막힌다. 화면에서 고친 값이 조용히 사라지고 새로고침하면
// 예전 값으로 되돌아가는데, 실제로 공제가 있는 달에서 그렇게 됐다. 두 식을 같이 묶어 둔다.
test("지급총액은 연차수당을 더하고 공제를 뺀 값이다", () => {
  const withColumns = { research: true, extra: true, welfare: false, severance: true, deduction: true, annualLeave: true };
  const row = calculateCompensation(employee({
    basePay: 4_216_667, meal: 200_000, manualBasic: true,
    monthly: { "2026-08": { deduction: 84_703, deductionNote: "마이너스 연월차 공제 0.5일", annualLeave: 0, severance: 0 } },
  }), 2026, 8, "round", withColumns);
  const 항목합 = row.basic + row.meal + row.car + row.child + row.incentive + row.bonus
    + row.extra + row.research + row.severance + row.annualLeave - row.deduction;
  assert.equal(row.deduction, 84_703);
  assert.equal(row.total, 항목합);
});

test("서버 검증식이 연차수당·공제를 함께 센다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/api/compensation/route.ts", import.meta.url), "utf8");
  assert.match(source, /values\.annualLeave! \+ values\.personalExpense! - values\.deduction!/);
  assert.match(source, /"severance", "annualLeave", "personalExpense", "deduction", "welfare", "total"/);
  // 공제 사유는 숫자 항목이 아니라 따로 실어야 확정할 때 살아남는다.
  assert.match(source, /deductionNote: String\(row\.deductionNote \?\? ""\)\.trim\(\)/);
});

// 개인비용지급은 업무에 쓴 개인 돈을 되돌려 주는 실비다. 일할계산하지 않고 적은 금액 그대로
// 지급총액에 더한다. 서버 검증식(validateDraft)도 같은 항목을 세야 자동 저장이 막히지 않는다.
test("개인비용지급은 일할계산 없이 지급총액에 더해진다", () => {
  const withColumns = { research: true, extra: true, welfare: false, severance: true, deduction: false, annualLeave: false, personalExpense: true };
  // 15일만 근무해도 실비는 깎이지 않는다.
  const row = calculateCompensation(employee({
    basePay: 3_000_000, meal: 200_000, manualBasic: true, joinDate: "2026-08-16",
    monthly: { "2026-08": { personalExpense: 150_000, personalExpenseNote: "출장 택시비 실비" } },
  }), 2026, 8, "round", withColumns);
  assert.equal(row.personalExpense, 150_000);
  const 항목합 = row.basic + row.meal + row.car + row.child + row.incentive + row.bonus
    + row.extra + row.research + row.severance + row.annualLeave + row.personalExpense - row.deduction;
  assert.equal(row.total, 항목합);

  // 열이 꺼져 있으면 금액이 있어도 지급총액에 들어가지 않는다 (다른 선택 열과 같은 규칙).
  const off = calculateCompensation(employee({
    basePay: 3_000_000, meal: 200_000, manualBasic: true, joinDate: "2026-08-16",
    monthly: { "2026-08": { personalExpense: 150_000 } },
  }), 2026, 8, "round", { ...withColumns, personalExpense: false });
  assert.equal(off.personalExpense, 0);
  assert.equal(off.total, row.total - 150_000);
});

test("서버 검증식이 개인비용지급을 함께 센다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/api/compensation/route.ts", import.meta.url), "utf8");
  assert.match(source, /values\.annualLeave! \+ values\.personalExpense! - values\.deduction!/);
  assert.match(source, /"annualLeave", "personalExpense", "deduction"/);
  // 확정하면 급여기록의 personal_expense 로 넘어가야 금액의 출처가 남는다.
  assert.match(source, /personal_expense/);
});

// 선택 열 토글은 settings_json 에 저장된다. normalizeSettings 의 목록에서 빠진 열은 저장되지 않고
// 다시 열 때 꺼진 채로 돌아오는데, 연차수당·개인비용지급은 열이 꺼지면 지급총액에서도 빠지므로
// 지급액이 조용히 줄어든다. 새 선택 열을 만들면 반드시 이 목록에 넣어야 한다.
test("선택 열 토글은 일곱 개가 모두 저장된다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/compensation-settings.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const columnDefaults"), source.indexOf("const standardDefaults"));
  for (const field of ["research", "extra", "welfare", "severance", "deduction", "annualLeave", "personalExpense"]) {
    assert.ok(block.includes(`${field}:`), `${field} 가 columnDefaults 에 없습니다`);
  }
  // 목록을 손으로 다시 적지 말고 defaults 의 키를 그대로 쓴다 — 그래야 빠뜨릴 수 없다.
  assert.match(source, /Object\.keys\(columnDefaults\)\.map/);
});

// 엑셀 내보내기는 화면 표와 같은 열을 담아야 한다. 예전에는 헤더 배열과 값 배열이 따로 있어
// 열을 추가할 때 한쪽만 고쳐졌고(개인비용지급이 그렇게 빠졌다), 표시할 열 선택도 무시됐다.
// 이제 열마다 이름과 값을 한 묶음으로 적고 두 조건으로 한 번에 거른다.
test("엑셀 내보내기는 체크된 열만, 화면과 같은 기준으로 담는다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/compensation-calculator.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function sheetData");
  const end = source.indexOf("async function exportCurrent", start);
  const sheet = source.slice(start, end);

  // 헤더와 값이 한 묶음이라 서로 어긋날 수 없다.
  assert.match(sheet, /type SheetColumn = \{ key: string; label: string; money\?: boolean; value:/);
  // 수당·표시 항목 체크를 그대로 따른다.
  for (const field of ["extra", "research", "annualLeave", "personalExpense", "severance", "deduction", "welfare"]) {
    assert.ok(sheet.includes(`sourceColumns.${field} ?`), `엑셀이 해당 월의 sourceColumns.${field} 를 보지 않습니다`);
  }
  // 표시할 열 선택에서 숨긴 열도 뺀다.
  assert.match(sheet, /hiddenColumnSet\.has\(/);
  // 개인비용지급은 금액과 사유가 짝으로 들어간다.
  assert.match(sheet, /label: "개인비용지급"/);
  assert.match(sheet, /label: "개인비용 사유"/);
});

// 임금계산기를 열면 저장된 임금안이 그대로 뜬다. 그게 언제 것인지 밝히지 않으면
// 오늘 고친 값인지 판단할 수 없다.
test("임금 계산 결과 표에 마지막 저장 시각을 보여준다", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/compensation-calculator.tsx", import.meta.url), "utf8");
  assert.match(source, /className="wage-saved-at"/);
  assert.match(source, /run\?\.updatedAt/);
  assert.match(source, /마지막 저장 \$\{new Date\(run\.updatedAt\)\.toLocaleString\("ko-KR"/);
});

test("첫 계약 지급률과 종료일을 넘기면 90% 고정 대신 그 비율로 구간을 나눈다", () => {
  // 9/7 입사, 지급률 80%, 첫 계약 만료 12/6 (입사일 + 3개월 − 1일). 인사기록카드 값 그대로다.
  const first = { joinDate: "2026-09-07", probationMonths: 3, probationRate: 0.8, probationEndDate: "2026-12-06", annualSalary: 33_000_000, meal: 200_000, car: 0, child: 0 };
  const october = calculateCompensation(employee(first), 2026, 10, "round", columns);
  assert.equal(october.probationApplied, true);
  assert.equal(october.mixedProbation, false);
  assert.equal(october.basic, 2_000_000); // 33,000,000 × 80% ÷ 12 − 식대 200,000
  const december = calculateCompensation(employee(first), 2026, 12, "round", columns);
  assert.equal(december.probationEnd?.toISOString().slice(0, 10), "2026-12-06");
  assert.equal(december.mixedProbation, true); // 12/1~12/6 은 80%, 12/7~31 은 100%
  const january = calculateCompensation(employee(first), 2027, 1, "round", columns);
  assert.equal(january.probationApplied, false);
  assert.equal(january.basic, 2_550_000); // 전환 뒤에는 기준 연봉 그대로
  // 비율을 안 넘기면 예전처럼 90% 다.
  const legacy = calculateCompensation(employee({ joinDate: "2026-09-07", probationMonths: 3, annualSalary: 33_000_000, meal: 200_000, car: 0, child: 0 }), 2026, 10, "round", columns);
  assert.equal(legacy.basic, 2_275_000); // 33,000,000 × 90% ÷ 12 − 200,000
});

test("a manual meal amount for one month replaces the prorated meal allowance without touching basic pay", () => {
  const base = employee({ annualSalary: 39_000_000, joinDate: "2026-08-19", meal: 200_000, car: 0, child: 0 });
  const auto = calculateCompensation(base, 2026, 8, "down", columns);
  const manual = calculateCompensation({ ...base, monthly: { "2026-08": { meal: 150_000 } } }, 2026, 8, "down", columns);
  // 8월 19일 입사라 자동 식대는 일할(13일)이다. 직접 적은 달은 그 금액을 그대로 쓴다.
  assert.equal(auto.meal, 85_479);
  assert.equal(manual.meal, 150_000);
  // 기본급은 기준 식대(연봉 산식)를 그대로 쓰므로 바뀌지 않고, 지급총액만 차이만큼 움직인다.
  assert.equal(manual.basic, auto.basic);
  assert.equal(manual.total - auto.total, 150_000 - 85_479);
  // 다른 달에는 영향이 없다.
  const september = calculateCompensation({ ...base, monthly: { "2026-08": { meal: 150_000 } } }, 2026, 9, "down", columns);
  assert.equal(september.meal, 200_000);
});

test("full-month basic pay is ceil(annual × rate / 12) − allowances regardless of the rounding setting, matching the contract formula", () => {
  // 33,000,000 / 12 = 2,750,000 exactly; 35,000,000 / 12 = 2,916,666.67 → ceil 2,916,667.
  const exact = calculateCompensation(employee({ annualSalary: 33_000_000, meal: 200_000, car: 0, child: 0 }), 2026, 9, "down", columns);
  const fraction = calculateCompensation(employee({ annualSalary: 35_000_000, meal: 200_000, car: 0, child: 0 }), 2026, 9, "down", columns);
  assert.equal(exact.basic, 2_550_000);
  assert.equal(fraction.basic, 2_916_667 - 200_000);
  assert.equal(calculateCompensation(employee({ annualSalary: 35_000_000, meal: 200_000, car: 0, child: 0 }), 2026, 9, "round", columns).basic, fraction.basic);
});

test("the first-term pay rate applies through probationEndDate inclusively and full rate from the next day", () => {
  const base = { annualSalary: 36_000_000, meal: 0, car: 0, child: 0, joinDate: "2026-07-06", probationMonths: 3, probationRate: 0.8, probationEndDate: "2026-10-05" };
  const october = calculateCompensation(employee(base), 2026, 10, "round", columns);
  // 10/1~10/5 (5일) 80%, 10/6~10/31 (26일) 100%, 365일법.
  const reduced = Math.round((36_000_000 * 0.8) / 365 * 5);
  const full = Math.round(36_000_000 / 365 * 26);
  assert.equal(october.mixedProbation, true);
  assert.equal(october.basic, reduced + full);
  const november = calculateCompensation(employee(base), 2026, 11, "round", columns);
  assert.equal(november.basic, 3_000_000);
  assert.equal(november.probationApplied, false);
});

test("윤년 2월은 29일을 만근으로 보고, 중도 입사는 29일 기준으로 일할한다", () => {
  const full = calculateCompensation(employee(), 2028, 2, "round", columns);
  assert.equal(full.daysInMonth, 29);
  assert.equal(full.days, 29);
  assert.equal(full.basic, 4_400_000);
  const partial = calculateCompensation(employee({ joinDate: "2028-02-15" }), 2028, 2, "round", columns);
  assert.equal(partial.days, 15);
  // 365일 방식: (연봉 − 연 수당) / 365 × 일수. 윤년이라고 366으로 나누지 않는다.
  assert.equal(partial.basic, Math.round((60_000_000 - 7_200_000) / 365 * 15));
});

test("수기 기본급(연봉 없음)은 첫 계약 지급률과 무관하게 입력값을 그대로 쓴다", () => {
  const result = calculateCompensation(employee({ annualSalary: 0, manualBasic: true, basePay: 3_000_000, probationMonths: 3, joinDate: "2026-07-01" }), 2026, 8, "round", columns);
  assert.equal(result.probationApplied, true);
  assert.equal(result.basic, 3_000_000);
  assert.equal(result.mixedProbation, false);
});

test("전환 계약이 첫 계약 종료보다 앞서면 전환일 전날까지만 지급률을 적용한다", () => {
  // 7/1 입사, 첫 계약은 9/30 까지지만 8/15 에 정규직 전환 → 8월은 14일(90%) + 17일(100%)
  const result = calculateCompensation(employee({ joinDate: "2026-07-01", probationMonths: 3, probationEndDate: "2026-08-14", probationRate: 0.9 }), 2026, 8, "round", columns);
  assert.equal(result.mixedProbation, true);
  const annual = 60_000_000, allowances = 7_200_000;
  const expected = Math.round((annual * 0.9 - allowances) / 365 * 14) + Math.round((annual - allowances) / 365 * 17);
  assert.equal(result.basic, expected);
});
