import assert from "node:assert/strict";
import test from "node:test";
import { monthlyOrdinaryWageOn } from "../app/hr-ordinary-wage.ts";
import { contractPay } from "../app/hr-employment-contract.ts";
import { calculateCompensation } from "../app/compensation-calculation.ts";

const employee = {
  joinDate: "2026-07-06", annualSalary: 36000000, basePay: 2400000,
  mealAllowance: 200000, childcareAllowance: 200000, vehicleAllowance: 200000,
};

for (const [kind, percent, monthly] of [["experienced", 100, 3000000], ["new", 90, 2700000]]) {
  test(`${kind} hire: ordinary wage, contract and full-month payroll agree at ${percent}%`, () => {
    const person = { ...employee, firstTermPayPercent: percent };
    assert.equal(monthlyOrdinaryWageOn(person, "2026-08-31"), monthly);
    const contract = contractPay(person, { kind: "FIXED_TERM", firstTermPayPercent: String(percent) });
    assert.equal(contract.total, monthly);
    const payroll = calculateCompensation({
      id: "test", name: "Test", department: "", title: "", birthDate: "", leaveDate: "",
      joinDate: person.joinDate, annualSalary: person.annualSalary, basePay: person.basePay,
      manualBasic: false, meal: person.mealAllowance, car: person.vehicleAllowance,
      child: person.childcareAllowance, probationMonths: 3, probationRate: percent / 100,
      probationEndDate: "2026-10-05", monthly: {},
    }, 2026, 8, "round", { research: true, extra: true, welfare: false, severance: true });
    assert.equal(payroll.total, monthly);
    assert.equal(contract.meal + contract.vehicle + contract.childcare, 600000);
  });
}

test("new-hire rate ends after the last day of the first three-month contract", () => {
  const person = { ...employee, firstTermPayPercent: 90 };
  assert.equal(monthlyOrdinaryWageOn(person, "2026-10-05"), 2700000);
  assert.equal(monthlyOrdinaryWageOn(person, "2026-10-06"), 3000000);
});

test("conversion uses full pay from its effective date, including normalized stored dates", () => {
  const person = { ...employee, joinDate: "2026.07.06", firstTermPayPercent: 90, regularContractDate: "2026.09.01" };
  assert.equal(monthlyOrdinaryWageOn(person, "2026/08/31"), 2700000);
  assert.equal(monthlyOrdinaryWageOn(person, "2026/09/01"), 3000000);
});

test("fixed allowances are included once with or without a recorded annual salary", () => {
  assert.equal(monthlyOrdinaryWageOn(employee, "2026-08-31"), 3000000);
  assert.equal(monthlyOrdinaryWageOn({ ...employee, annualSalary: 0 }, "2026-08-31"), 3000000);
  assert.equal(monthlyOrdinaryWageOn({ ...employee, annualSalary: 0, firstTermPayPercent: 90 }, "2026-08-31"), 2700000);
});

test("ordinary wage preserves fractional won until settlement and handles a missing employee", () => {
  assert.equal(monthlyOrdinaryWageOn({ ...employee, annualSalary: 44000000 }, "2026-08-31"), 44000000 / 12);
  assert.equal(monthlyOrdinaryWageOn(null, "2026-08-31"), 0);
});
