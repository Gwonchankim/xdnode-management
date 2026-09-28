import assert from "node:assert/strict";
import test from "node:test";

import {
  addMonths, annualDaysForAnniversary, buildLeaveGrants, computeLeaveLedger, expandDateRange, leaveKindFromLabel, normalizeDate, promotionNoticeText,
} from "../app/hr-leave-accrual.ts";

const usage = (date, kind, overrides = {}) => {
  const base = { ANNUAL: [1, true], HALF: [0.5, true], QUARTER: [0.25, true], BIRTHDAY_HALF: [0.5, false], OFFICIAL: [1, false] }[kind];
  return { id: `${date}-${kind}`, date, kind, units: base[0], deducts: base[1], ...overrides };
};

test("발생 누계는 월차와 연차를 모두 포함하고 소멸·사용 후에도 종류별 합계가 유지된다", () => {
  const ledger = computeLeaveLedger({ employeeId: "test", joinDate: "2024-01-15", today: "2026-09-21", usages: [usage("2026-08-20", "ANNUAL")] });
  assert.deepEqual(ledger.grantedByKind, { MONTHLY: 11, ANNUAL: 30 });
  assert.equal(ledger.grantedByKind.MONTHLY + ledger.grantedByKind.ANNUAL, ledger.granted);
  assert.equal(ledger.granted, 41);
  assert.equal(ledger.expired, 26);
  assert.equal(ledger.balance, 14);
});

test("종류별 발생은 예정·제외분을 빼고 조정 일수를 반영하며 미발생 종류도 0으로 표시한다", () => {
  const input = { employeeId: "test", joinDate: "2026-07-06", today: "2026-09-21", usages: [] };
  const ledger = computeLeaveLedger({ ...input, adjustments: [
    { grantKey: "MONTHLY-1", units: 0.75 }, { grantKey: "MONTHLY-2", status: "EXCLUDED" },
  ] });
  assert.deepEqual(ledger.grantedByKind, { MONTHLY: 0.75, ANNUAL: 0 });
  assert.equal(ledger.granted, 0.75);
  assert.deepEqual(computeLeaveLedger({ ...input, today: "2026-07-06" }).grantedByKind, { MONTHLY: 0, ANNUAL: 0 });
});

test("시트의 날짜 표기 네 가지와 내용 문자열을 모두 읽는다", () => {
  assert.equal(normalizeDate("2026. 01.15"), "2026-01-15");
  assert.equal(normalizeDate("24.05.23"), "2024-05-23");
  assert.equal(normalizeDate("2026.02.02"), "2026-02-02");
  assert.equal(normalizeDate(45658), "2025-01-01");
  assert.equal(normalizeDate("2026-02-30"), "");
  assert.equal(normalizeDate("연차"), "");
  assert.equal(leaveKindFromLabel("반반차"), "QUARTER");
  assert.equal(leaveKindFromLabel("오전 반차"), "HALF");
  assert.equal(leaveKindFromLabel(" 오후 반반차"), "QUARTER");
  assert.deepEqual(expandDateRange("2026.07.13~16"), ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"]);
  assert.deepEqual(expandDateRange("2026.03.03~09"), ["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"]);
  assert.deepEqual(expandDateRange("26.12.30~01.02"), []);
  assert.deepEqual(expandDateRange("26.02.06"), ["2026-02-06"]);
  assert.deepEqual(expandDateRange(24.25), []);
  assert.equal(leaveKindFromLabel("생일 반차"), "BIRTHDAY_HALF");
  assert.equal(leaveKindFromLabel("공가 및 대체, 경조 휴가"), "OFFICIAL");
  assert.equal(leaveKindFromLabel("알 수 없음"), null);
});

test("달 더하기는 말일을 짧은 달의 말일로 맞추고, 가산은 3년차부터 2년마다 1일이다", () => {
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2023-01-31", 1), "2023-02-28");
  assert.equal(addMonths("2024-01-15", 12), "2025-01-15");
  assert.deepEqual([1, 2, 3, 4, 5, 21, 22, 30].map((k) => annualDaysForAnniversary(k)), [15, 15, 16, 16, 17, 25, 25, 25]);
  assert.equal(annualDaysForAnniversary(5, { annualDays: 15, seniorityIncrement: false, maxAnnualDays: 25, expiryMonths: 12, promotionFirstDays: 183, promotionSecondDays: 61 }), 15);
});

test("월차는 1~11개월차에 자동 부여되고 입사 1주년에 소멸, 연차는 주년마다 부여되며 다음 1건만 예정으로 보인다", () => {
  const grants = buildLeaveGrants({ joinDate: "2024.01.15", today: "2026-09-21" });
  const monthly = grants.filter((grant) => grant.kind === "MONTHLY");
  const annual = grants.filter((grant) => grant.kind === "ANNUAL");
  assert.equal(monthly.length, 11);
  assert.deepEqual([monthly[0].grantDate, monthly[0].periodStart, monthly[0].periodEnd, monthly[0].expiresAt], ["2024-02-15", "2024-01-15", "2024-02-14", "2025-01-15"]);
  assert.ok(monthly.every((grant) => grant.status === "GRANTED" && grant.units === 1));
  assert.deepEqual(annual.map((grant) => `${grant.key}:${grant.grantDate}:${grant.units}:${grant.status}`),
    ["ANNUAL-1:2025-01-15:15:GRANTED", "ANNUAL-2:2026-01-15:15:GRANTED", "ANNUAL-3:2027-01-15:16:NOT_DUE"]);
  assert.equal(annual[0].expiresAt, "2026-01-15");
});

test("퇴직일 이후는 발생하지 않고, 제외 조정은 부여일수를 0으로 만든다", () => {
  const grants = buildLeaveGrants({ joinDate: "2025-09-08", exitDate: "2026-03-20", today: "2026-09-21", adjustments: [{ grantKey: "MONTHLY-2", status: "EXCLUDED", note: "결근" }] });
  assert.deepEqual(grants.map((grant) => `${grant.key}:${grant.status}:${grant.units}`),
    ["MONTHLY-1:GRANTED:1", "MONTHLY-2:EXCLUDED:0", "MONTHLY-3:GRANTED:1", "MONTHLY-4:GRANTED:1", "MONTHLY-5:GRANTED:1", "MONTHLY-6:GRANTED:1"]);
  assert.equal(grants[1].note, "결근");
});

test("사용은 소멸이 이른 발생분부터 차감되고, 차감 제외 종류는 잔여에 영향이 없다", () => {
  const ledger = computeLeaveLedger({
    employeeId: "e1", joinDate: "2025-04-16", today: "2026-09-21",
    usages: [usage("2026-02-02", "ANNUAL"), usage("2026-04-27", "HALF"), usage("2026-05-29", "QUARTER"), usage("2026-06-19", "BIRTHDAY_HALF"), usage("2026-07-06", "OFFICIAL")],
  });
  // 월차 11 (소멸 2026-04-16) + 1주년 연차 15 (2026-04-16 발생). 2/2 연차 1일은 월차에서, 4/27·5/29 는 연차에서.
  assert.equal(ledger.granted, 26);
  assert.equal(ledger.used, 1.75);
  assert.equal(ledger.expired, 10);
  assert.equal(ledger.balance, 14.25);
  assert.equal(ledger.nonDeductedUnits, 1.5);
  assert.equal(ledger.grants.find((grant) => grant.key === "MONTHLY-1").used, 1);
  assert.equal(ledger.grants.find((grant) => grant.key === "ANNUAL-1").used, 0.75);
  assert.equal(ledger.overdraft, 0);
});

test("발생분보다 많이 쓰면 초과 사용으로 잔여가 음수가 된다. 기준일까지 발생한 분은 발생 전 날짜에도 앞당겨 쓸 수 있다", () => {
  const ledger = computeLeaveLedger({
    employeeId: "e2", joinDate: "2026-01-14", today: "2026-09-21",
    // 1/20 은 발생 전이지만 9/21 기준으로 발생한 월차에서 앞당겨 쓴다. 총 9일 사용, 발생 8일 → 초과 1일.
    usages: [usage("2026-01-20", "ANNUAL"), ...Array.from({ length: 8 }, (_, index) => usage(`2026-09-${14 + index}`, "ANNUAL"))],
  });
  assert.equal(ledger.granted, 8);
  assert.equal(ledger.overdraft, 1);
  assert.equal(ledger.used, 9);
  assert.equal(ledger.balance, -1);
});

test("촉진 대상은 소멸 6개월 전부터 1차, 2개월 전부터 2차로 나뉘고 안내문이 만들어진다", () => {
  const ledger = computeLeaveLedger({ employeeId: "e3", joinDate: "2024-01-15", today: "2026-09-21", usages: [usage("2026-03-06", "ANNUAL")] });
  // ANNUAL-2 (2026-01-15 발생, 2027-01-15 소멸) 잔여 14 → 116일 남음 → 1차.
  assert.deepEqual(ledger.promotions.map((item) => `${item.grantKey}:${item.stage}:${item.remaining}:${item.daysLeft}`), ["ANNUAL-2:FIRST:14:116"]);
  const later = computeLeaveLedger({ employeeId: "e3", joinDate: "2024-01-15", today: "2026-11-20", usages: [] });
  assert.equal(later.promotions[0].stage, "SECOND");
  const text = promotionNoticeText("임영민", ledger.promotions[0]);
  assert.match(text, /임영민님/);
  assert.match(text, /14일이 2027-01-15에 소멸/);
  assert.match(text, /10일 이내/);
  assert.match(promotionNoticeText("임영민", later.promotions[0]), /회사가 사용일을 지정/);
});

test("소멸일이 같은 월차 여러 건은 촉진 안내 하나로 묶인다", () => {
  const ledger = computeLeaveLedger({ employeeId: "e4", joinDate: "2026-01-14", today: "2026-09-21", usages: [usage("2026-03-02", "ANNUAL"), usage("2026-04-01", "ANNUAL"), usage("2026-05-04", "ANNUAL"), usage("2026-06-01", "ANNUAL"), usage("2026-06-15", "HALF")] });
  // 8개월차까지 8일 발생, 4.5일 사용 → 5개월차 0.5 + 6~8개월차 3일 = 3.5일이 2027-01-14 에 함께 소멸.
  assert.equal(ledger.promotions.length, 1);
  assert.deepEqual([ledger.promotions[0].label, ledger.promotions[0].remaining, ledger.promotions[0].expiresAt, ledger.promotions[0].grantKey], ["5~8개월차 월차", 3.5, "2027-01-14", "MONTHLY-5+MONTHLY-6+MONTHLY-7+MONTHLY-8"]);
});
