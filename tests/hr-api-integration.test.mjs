import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase, callRoute, callApi, setIdentity, beforeBatch, objects } from './helpers/hr-api-harness.mjs';
import { calculateCompensation } from '../app/compensation-calculation.ts';

const reads = {
  'employee-records': '', organizations: '', 'organization-leaders': '', payroll: '?period=2026-09',
  compensation: '?period=2026-09&include=hr', operations: '', leave: '', recruitment: '',
  'recruitment-requisitions': '', 'authorized-users': '', catalogs: '?kind=RANK',
  'message-templates': '', interviews: '?employeeId=audit-employee',
  analytics: '?year=2026', 'workforce-plans': '?year=2026', performance: '?year=2026', training: '?year=2026',
  transcriptions: '?entityType=EMPLOYEE_INTERVIEW&entityId=audit-missing',
  'applicant-interview-recordings': '?applicantId=audit-missing',
};

for (const [name, query] of Object.entries(reads)) {
  test(`HR API fresh database GET ${name} responds without schema errors`, async () => {
    await resetDatabase();
    const result = await callRoute(name, 'GET', undefined, query);
    assert.ok(result.status < 500, `${result.status}: ${JSON.stringify(result.body)}`);
  });
  test(`HR API unauthenticated GET ${name} is rejected`, async () => {
    await resetDatabase(); setIdentity(null);
    assert.equal((await callRoute(name, 'GET', undefined, query)).status, 401);
  });
}

const mutations = {
  'employee-records': ['PUT'], organizations: ['POST', 'PUT'], 'organization-leaders': ['PUT'],
  payroll: ['POST', 'PUT'], compensation: ['POST'], operations: ['POST', 'PUT'], leave: ['POST', 'DELETE'],
  recruitment: ['POST', 'PUT', 'DELETE'], 'recruitment-requisitions': ['POST'], 'authorized-users': ['POST', 'DELETE'],
  catalogs: ['POST', 'DELETE'], 'message-templates': ['PUT', 'DELETE'], interviews: ['POST'],
  analytics: ['POST'], 'workforce-plans': ['POST'], performance: ['POST'], training: ['POST'],
  transcriptions: ['POST'], 'applicant-interview-recordings': ['POST'], 'resume-analysis': ['POST'],
};
for (const [name, methods] of Object.entries(mutations)) {
  for (const method of methods) test(`HR API VIEWER cannot ${method} ${name}`, async () => {
    await resetDatabase(); setIdentity(['VIEWER']);
    const body = name === 'payroll' ? { period: '2026-09', status: 'LOCKED' }
      : name === 'operations' ? { resource: 'retirementSettlement', id: 'audit-missing' }
        : name === 'transcriptions' ? { entityType: 'EMPLOYEE_INTERVIEW', entityId: 'audit-missing', action: 'REVIEW' } : {};
    assert.equal((await callRoute(name, method, body)).status, 403);
  });
}

for (const [name, query] of Object.entries(reads)) test(`HR API migrated database GET ${name}`, async () => {
  await resetDatabase({ migrate: true });
  const result = await callRoute(name, 'GET', undefined, query);
  assert.ok(result.status < 500, `${result.status}: ${JSON.stringify(result.body)}`);
});

const employee = { id: 'audit-employee', name: 'Audit Employee', department: 'Audit Team', title: '', birthDate: '',
  joinDate: '2026-01-01', leaveDate: '', probationMonths: 0, annualSalary: 36000000, basePay: 0,
  manualBasic: false, meal: 200000, car: 200000, child: 200000, monthly: {} };
const settings = { rounding: 'round', columns: { research: true, extra: true, welfare: true, severance: true, deduction: true, annualLeave: true, personalExpense: true } };

test('recruitment assistant saves applicant, schedule and questions together and rejects duplicate or invalid creates', async () => {
  const sqlite = await resetDatabase();
  const applicant = { id: 'AP-synthetic-helper', name: '가상 지원자', role: '기술지원', applied: '2026.09.21', ownerId: 'gc.kim', stage: '면접', email: 'synthetic@example.test', phone: '010-0000-0001', resumeText: '가상 이력서: 서버 운영 경력', resumeFileName: '가상이력서.txt', createOnly: true, recruitmentHelper: true,
    interview: { date: '2026-10-01', time: '14:30', type: '화상 면접', interviewers: '가상 면접관', location: '가상 회의실', questions: '[지원 직무 역량] 서버 장애를 어떻게 진단합니까?' } };
  assert.equal((await callRoute('recruitment', 'PUT', applicant)).status, 200);
  const saved = (await callRoute('recruitment')).body.applicants.find(item => item.id === applicant.id);
  for (const field of ['date', 'time', 'type', 'interviewers', 'location', 'questions']) assert.equal(saved.interview[field], applicant.interview[field]);
  assert.equal(saved.resumeText, applicant.resumeText);
  assert.equal(saved.stage, '면접');
  assert.equal((await callRoute('recruitment', 'PUT', { ...applicant, name: '덮어쓰기 방지' })).status, 409);
  assert.equal((await callRoute('recruitment', 'PUT', { ...applicant, id: 'different', email: 'SYNTHETIC@EXAMPLE.TEST', phone: '' })).status, 409);
  assert.equal((await callRoute('recruitment', 'PUT', { ...applicant, id: 'different', email: 'other@example.test', phone: '01000000001' })).status, 409);
  for (const interview of [{ date: '2026-02-30', time: '10:00', questions: '질문' }, { date: '2026-10-01', questions: '질문' }, { questions: '' }]) {
    assert.equal((await callRoute('recruitment', 'PUT', { ...applicant, id: 'invalid', email: 'invalid@example.test', phone: '', interview })).status, 400);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM hr_applicants').get().count, 1);
  assert.equal(sqlite.prepare('SELECT name FROM hr_applicants WHERE id=?').get(applicant.id).name, applicant.name);
  const unscheduled = { ...applicant, id: 'AP-unscheduled', email: 'unscheduled@example.test', phone: '', stage: '서류 검토', interview: { questions: '경력 확인 질문' } };
  assert.equal((await callRoute('recruitment', 'PUT', unscheduled)).status, 200);
  setIdentity(['VIEWER']);
  assert.equal((await callRoute('recruitment', 'PUT', { ...applicant, id: 'AP-denied' })).status, 403);
});
const draftFor = (monthly = {}) => {
  const item = { ...employee, monthly: { '2026-09': monthly } };
  const { employee: ignored, ...row } = calculateCompensation(item, 2026, 9, 'round', settings.columns);
  void ignored;
  return { period: '2026-09', settings, employees: [item], rows: [{ ...row, employeeId: item.id }] };
};
const postWage = body => callRoute('compensation', 'POST', body);
const expectStatus = (result, status) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };

test('assistant receipt updates only retirement pay, replaces instead of accumulating, and rejects stale or locked writes', async () => {
  await resetDatabase();
  const draft = draftFor({ incentive: 70000, deduction: 8000, severance: 100000, note: 'Keep this note' });
  const created = expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201).run;
  const request = { action: 'APPLY_RETIREMENT_PAY', period: '2026-09', version: created.version,
    employeeId: employee.id, employeeName: employee.name, amount: 1234567, sourceFileName: 'synthetic-receipt.txt' };
  const applied = expectStatus(await postWage(request), 200).run;
  const monthly = applied.employees[0].monthly['2026-09'];
  assert.equal(monthly.severance, 1234567);
  assert.equal(monthly.incentive, 70000);
  assert.equal(monthly.deduction, 8000);
  assert.equal(monthly.note, 'Keep this note');
  assert.equal(monthly.retirementPaySource, 'synthetic-receipt.txt');
  assert.equal(applied.grossPay - created.grossPay, 1234567 - 100000);
  expectStatus(await postWage(request), 409);
  const repeated = expectStatus(await postWage({ ...request, version: applied.version }), 200).run;
  assert.equal(repeated.grossPay, applied.grossPay);
  for (const patch of [{ amount: -1 }, { amount: 1.5 }, { amount: '100' }, { employeeId: 'missing' }, { employeeName: 'Wrong Person' }, { sourceFileName: '' }]) {
    expectStatus(await postWage({ ...request, version: repeated.version, ...patch }), 400);
  }
  const confirmedDraft = draftFor(monthly);
  const confirmed = expectStatus(await postWage({ ...confirmedDraft, action: 'CONFIRM', version: repeated.version }), 200).run;
  expectStatus(await postWage({ ...request, version: confirmed.version }), 409);
});

test('assistant retirement pay respects write permission and atomic version checks', async () => {
  await resetDatabase();
  const created = expectStatus(await postWage({ ...draftFor(), action: 'CREATE' }), 201).run;
  const request = { action: 'APPLY_RETIREMENT_PAY', period: '2026-09', version: created.version,
    employeeId: employee.id, employeeName: employee.name, amount: 4000000, sourceFileName: 'synthetic.txt' };
  setIdentity(['VIEWER']);
  expectStatus(await postWage(request), 403);
  setIdentity(['HR_ADMIN']);
  beforeBatch((statements, sql) => {
    if (statements.some(statement => statement.sql.includes("INSERT INTO hr_compensation_lines"))) {
      sql.prepare("UPDATE hr_compensation_runs SET version = version + 1 WHERE period = '2026-09'").run();
      beforeBatch(null);
    }
  });
  expectStatus(await postWage(request), 409);
  const latest = expectStatus(await callRoute('compensation', 'GET', undefined, '?period=2026-09'), 200).run;
  assert.equal(latest.employees[0].monthly['2026-09'].severance, undefined);
  assert.equal(latest.grossPay, created.grossPay);
});

test('wage create/save/confirm/reopen preserves gross, deductions, net and monthly extras', async () => {
  const sql = await resetDatabase();
  const draft = draftFor({ incentive: 100000, annualLeave: 120000, personalExpense: 30000, deduction: 350000 });
  const created = expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201).run;
  assert.equal(created.version, 1);
  assert.equal(created.grossPay, 2900000);
  expectStatus(await postWage({ ...draft, action: 'SAVE', version: 1 }), 200);
  expectStatus(await postWage({ ...draft, action: 'SAVE', version: 1 }), 409);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 2 }), 200);
  const record = sql.prepare('SELECT * FROM hr_payroll_records WHERE employee_id=?').get(employee.id);
  assert.equal(record.gross_pay, 3250000); assert.equal(record.deductions, 350000); assert.equal(record.net_pay, 2900000);
  assert.equal(record.annual_leave_pay, 120000); assert.equal(record.personal_expense, 30000);
  expectStatus(await postWage({ ...draft, action: 'SAVE', version: 3 }), 409);
  expectStatus(await postWage({ ...draft, action: 'REOPEN', version: 3 }), 200);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 4 }), 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_payroll_records WHERE year_month=?').get(draft.period).n, 1);
  assert.ok(sql.prepare("SELECT COUNT(*) AS n FROM erp_audit_logs WHERE entity_type='compensationRun'").get().n >= 5);
});

test('wage negative net is persisted and invalid row sums and duplicate employees are rejected', async () => {
  const sql = await resetDatabase();
  const draft = draftFor({ deduction: 4000000 });
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'SAVE', version: 1, rows: [{ ...draft.rows[0], total: 1 }] }), 400);
  expectStatus(await postWage({ ...draft, action: 'SAVE', version: 1, employees: [...draft.employees, ...draft.employees], rows: [...draft.rows, ...draft.rows] }), 400);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  assert.equal(sql.prepare('SELECT net_pay FROM hr_payroll_records WHERE employee_id=?').get(employee.id).net_pay, -1000000);
});

test('concurrent wage confirmation cannot overwrite payroll records after losing its version', async () => {
  const sql = await resetDatabase(); const draft = draftFor();
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('DELETE FROM hr_payroll_records'))) {
      sql.prepare('UPDATE hr_compensation_runs SET version=version+1 WHERE period=?').run(draft.period);
      beforeBatch(null);
    }
  });
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 409);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_payroll_records').get().n, 0);
  assert.equal(sql.prepare('SELECT status FROM hr_compensation_runs').get().status, 'DRAFT');
});

test('payroll lock blocks wage reopening and needs a reason to unlock', async () => {
  await resetDatabase(); const draft = draftFor();
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'LOCKED' }), 200);
  expectStatus(await postWage({ ...draft, action: 'REOPEN', version: 2 }), 409);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT' }), 400);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT', reopenedReason: 'Audit correction of payroll details' }), 200);
  expectStatus(await postWage({ ...draft, action: 'REOPEN', version: 2 }), 200);
});

async function seedAuditEmployee() {
  expectStatus(await callRoute('employee-records', 'PUT', { employeeId: employee.id, name: employee.name,
    department: employee.department, joinDate: employee.joinDate, annualSalary: employee.annualSalary,
    status: '재직', firstTermPayPercent: 90, mealAllowance: 200000 }), 200);
}

test('leave types, quarter units, deletion and adjustment restore use the real ledger', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  for (const [leaveType, units, deducts] of [['ANNUAL', 1, 1], ['HALF', .5, 1], ['QUARTER', .25, 1], ['BIRTHDAY_HALF', .5, 0], ['OFFICIAL', 1, 0], ['SICK', 1, 0], ['FAMILY', 1, 0], ['OTHER', 1, 0]]) {
    const result = expectStatus(await callRoute('leave', 'POST', { employeeId: employee.id, leaveType, date: '2026-08-20', units }), 201);
    assert.equal(sql.prepare('SELECT deducts FROM hr_leave_requests WHERE id=?').get(result.id).deducts, deducts, leaveType);
    expectStatus(await callRoute('leave', 'DELETE', undefined, `?id=${result.id}`), 200);
    expectStatus(await callRoute('leave', 'DELETE', undefined, `?id=${result.id}`), 404);
  }
  expectStatus(await callRoute('leave', 'POST', { employeeId: employee.id, leaveType: 'ANNUAL', date: '2026-08-20', units: .3 }), 400);
  expectStatus(await callRoute('leave', 'POST', { employeeId: 'missing', leaveType: 'ANNUAL', date: '2026-08-20' }), 404);
  expectStatus(await callRoute('leave', 'POST', { resource: 'adjustment', employeeId: employee.id, grantKey: 'MONTHLY-1', status: 'EXCLUDED', note: 'Audit absence' }), 200);
  assert.equal(sql.prepare('SELECT status FROM hr_leave_grant_adjustments').get().status, 'EXCLUDED');
  expectStatus(await callRoute('leave', 'POST', { resource: 'adjustment', employeeId: employee.id, grantKey: 'MONTHLY-1' }), 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_leave_grant_adjustments').get().n, 0);
});

test('organization and catalogs persist, reject duplicates, and templates can reset', async () => {
  const sql = await resetDatabase();
  expectStatus(await callRoute('organizations', 'POST', { name: 'Audit Team' }), 201);
  expectStatus(await callRoute('organizations', 'POST', { name: 'Audit Team' }), 409);
  assert.equal(sql.prepare('SELECT name FROM hr_organization_records').get().name, 'Audit Team');
  expectStatus(await callRoute('catalogs', 'POST', { kind: 'RANK', value: 'Audit Rank' }), 201);
  expectStatus(await callRoute('catalogs', 'POST', { kind: 'RANK', value: 'Audit Rank' }), 409);
  expectStatus(await callRoute('catalogs', 'DELETE', undefined, '?kind=RANK&value=Audit%20Rank'), 200);
  expectStatus(await callRoute('message-templates', 'PUT', { templateId: 'OFFER', body: 'Audit offer template' }), 200);
  assert.equal(sql.prepare('SELECT body FROM hr_message_templates').get().body, 'Audit offer template');
  expectStatus(await callRoute('message-templates', 'DELETE', undefined, '?templateId=OFFER'), 200);
});

test('applicant save, offer decline and memo editing preserve declined stage', async () => {
  const sql = await resetDatabase({ migrate: true });
  const applicant = { id: 'audit-applicant', name: 'Audit Applicant', email: 'audit@example.invalid', stage: '서류 검토', applied: '2026.09.01' };
  expectStatus(await callRoute('recruitment', 'PUT', applicant), 200);
  const result = expectStatus(await callRoute('recruitment', 'POST', { resource: 'offer', applicantId: applicant.id,
    proposedTitle: 'Audit Position', department: 'Audit Team', employmentType: '계약직', startDate: '2026-10-01', annualSalary: 36000000, firstTermPayPercent: 90 }), 201);
  const offerId = result.offer.id;
  expectStatus(await callRoute('recruitment', 'PUT', { resource: 'offerResponse', id: offerId, action: 'DECLINE', declineKind: 'OTHER_OFFER' }), 200);
  expectStatus(await callRoute('recruitment', 'PUT', { ...applicant, stage: '타사 합격', summary: 'Audit memo' }), 200);
  assert.equal(sql.prepare('SELECT stage FROM hr_applicants WHERE id=?').get(applicant.id).stage, '타사 합격');
  expectStatus(await callRoute('recruitment', 'DELETE', { applicantId: applicant.id }), 200);
});

test('HR dashboard parallel loading initializes a new database without duplicate columns', async () => {
  await resetDatabase();
  const results = await Promise.allSettled(Object.entries(reads).map(async ([name, query]) => {
    const result = await callRoute(name, 'GET', undefined, query);
    assert.ok(result.status < 500, name);
  }));
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.message), []);
});

test('payroll locking during confirmation prevents the pending batch from replacing records', async () => {
  const sql = await resetDatabase(); const draft = draftFor();
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  expectStatus(await postWage({ ...draft, action: 'REOPEN', version: 2 }), 200);
  const original = sql.prepare('SELECT net_pay FROM hr_payroll_records WHERE employee_id=?').get(employee.id).net_pay;
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('DELETE FROM hr_payroll_records'))) {
      sql.prepare("UPDATE hr_payroll_runs SET status='LOCKED' WHERE period=?").run(draft.period);
      beforeBatch(null);
    }
  });
  expectStatus(await postWage({ ...draftFor({ incentive: 999999 }), action: 'CONFIRM', version: 3 }), 409);
  assert.equal(sql.prepare('SELECT net_pay FROM hr_payroll_records WHERE employee_id=?').get(employee.id).net_pay, original);
});

test('employee partial updates preserve personal details, history and first term review', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  const details = { employeeId: employee.id, name: employee.name, email: 'audit@example.invalid', phone: '000-0000-0000',
    joinDate: employee.joinDate, department: employee.department, history: [{ date: '2026.01.01', type: '입사' }], firstTermReview: { result: 'PASS' } };
  expectStatus(await callRoute('employee-records', 'PUT', details), 200);
  expectStatus(await callRoute('employee-records', 'PUT', { employeeId: employee.id, name: employee.name, annualSalary: 40000000 }), 200);
  const record = sql.prepare('SELECT * FROM hr_employee_records WHERE employee_id=?').get(employee.id);
  assert.equal(record.email, details.email); assert.equal(record.join_date, details.joinDate);
  assert.equal(record.department, details.department); assert.equal(record.phone, details.phone);
  assert.deepEqual(JSON.parse(record.history_json), details.history);
  assert.deepEqual(JSON.parse(record.first_term_review_json), details.firstTermReview);
  assert.equal(record.first_term_pay_percent, 90);
});

test('leave import and grant adjustment reject missing employees without orphan records', async () => {
  const sql = await resetDatabase();
  expectStatus(await callRoute('leave', 'POST', { resource: 'adjustment', employeeId: 'missing', grantKey: 'MONTHLY-1', status: 'EXCLUDED' }), 404);
  expectStatus(await callRoute('leave', 'POST', { resource: 'import', records: [{ employeeId: 'missing', leaveType: 'ANNUAL', date: '2026-08-20' }] }), 404);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_leave_requests').get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_leave_grant_adjustments').get().n, 0);
});

test('leave invalid end date cannot silently turn into a single-day record', async () => {
  await resetDatabase(); await seedAuditEmployee();
  expectStatus(await callRoute('leave', 'POST', { employeeId: employee.id, leaveType: 'ANNUAL', startDate: '2026-08-20', endDate: 'not-a-date' }), 400);
});

test('offer acceptance and onboarding retain salary and prevent deleting an onboarded applicant', async () => {
  const sql = await resetDatabase({ migrate: true });
  const applicant = { id: 'audit-onboard', name: 'Audit Hire', email: 'hire@example.invalid', stage: '면접 합격' };
  expectStatus(await callRoute('recruitment', 'PUT', applicant), 200);
  const { offer } = expectStatus(await callRoute('recruitment', 'POST', { resource: 'offer', applicantId: applicant.id,
    proposedTitle: 'Audit Position', department: 'Audit Team', employmentType: '계약직', startDate: '2026-01-01', annualSalary: 36000000, firstTermPayPercent: 90 }), 201);
  expectStatus(await callRoute('recruitment', 'PUT', { resource: 'offerResponse', id: offer.id, action: 'ACCEPT', employeeId: 'audit-hire', position: '사원', jobTitle: 'Audit Position' }), 201);
  expectStatus(await callRoute('recruitment', 'PUT', { resource: 'onboardingComplete', id: offer.id }), 201);
  const record = sql.prepare('SELECT annual_salary,first_term_pay_percent FROM hr_employee_records WHERE employee_id=?').get('audit-hire');
  assert.equal(record.annual_salary, 36000000); assert.equal(record.first_term_pay_percent, 90);
  expectStatus(await callRoute('recruitment', 'PUT', { resource: 'onboardingComplete', id: offer.id }), 409);
  expectStatus(await callRoute('recruitment', 'DELETE', { applicantId: applicant.id }), 409);
});

test('training course opening, evidence submission and confirmation enforce completion controls', async () => {
  const sql = await resetDatabase({ migrate: true });
  const courseId = expectStatus(await callRoute('training', 'POST', { action: 'CREATE_COURSE', title: 'Audit Course',
    description: 'Audit mandatory training', provider: 'Audit Provider', year: 2026, startDate: '2026-01-01', dueDate: '2026-12-31', durationMinutes: 60 }), 201).id;
  expectStatus(await callRoute('training', 'POST', { action: 'OPEN_COURSE', courseId }), 200);
  expectStatus(await callRoute('training', 'POST', { action: 'CLOSE_COURSE', courseId }), 409);
  const assignmentId = sql.prepare('SELECT id FROM hr_training_assignments WHERE course_id=? LIMIT 1').get(courseId).id;
  const data = { action: 'UPDATE_ASSIGNMENT', courseId, assignmentId, progress: 100, completedMinutes: 60 };
  expectStatus(await callRoute('training', 'POST', data), 409);
  expectStatus(await callRoute('training', 'POST', { ...data, evidenceName: 'Audit Certificate', evidenceRef: 'audit:certificate' }), 200);
  expectStatus(await callRoute('training', 'POST', { action: 'VERIFY_ASSIGNMENT', courseId, assignmentId }), 200);
  expectStatus(await callRoute('training', 'POST', data), 403);
});

test('workforce plans and performance cycles reject duplicate or premature transitions', async () => {
  const sql = await resetDatabase({ migrate: true });
  const plan = { action: 'CREATE_PLAN', period: '2026-H2', title: 'Audit Workforce Plan' };
  const planId = expectStatus(await callRoute('workforce-plans', 'POST', plan), 201).id;
  expectStatus(await callRoute('workforce-plans', 'POST', plan), 409);
  expectStatus(await callRoute('workforce-plans', 'POST', { action: 'SAVE_PLAN', planId, title: 'Revised Audit Plan', assumptions: 'Audit only' }), 200);
  const cycleId = expectStatus(await callRoute('performance', 'POST', { action: 'CREATE_CYCLE', name: 'Audit Performance', period: '2026-H2',
    goalDueDate: '2026-09-01', selfDueDate: '2026-10-01', managerDueDate: '2026-11-01', calibrationDueDate: '2026-12-01' }), 201).id;
  expectStatus(await callRoute('performance', 'POST', { action: 'TRANSITION', cycleId, target: 'GOAL_SETTING' }), 200);
  expectStatus(await callRoute('performance', 'POST', { action: 'TRANSITION', cycleId, target: 'SELF_REVIEW' }), 409);
  assert.ok(sql.prepare('SELECT COUNT(*) AS n FROM hr_performance_participants WHERE cycle_id=?').get(cycleId).n > 0);
});

for (const [path, query] of [['documents', '?module=hr&entityType=employee&entityId=audit'], ['approval-settings', ''], ['sales/incentives', '?period=2026-09']]) {
  test(`HR connected API ${path} GET and unauthenticated rejection`, async () => {
    await resetDatabase({ migrate: true });
    expectStatus(await callApi(path, 'GET', undefined, query), 200);
    setIdentity(null);
    expectStatus(await callApi(path, 'GET', undefined, query), 401);
  });
}

test('incentive rule creation and payroll-application permission are enforced', async () => {
  await resetDatabase({ migrate: true });
  expectStatus(await callApi('sales/incentives', 'POST', { action: 'CREATE_RULE', name: 'Audit Rule', effectiveFrom: '2026-01-01',
    eligibleLeadTypes: ['OUTBOUND'], thresholdMarginPercent: 10, payoutRatePercent: 5 }), 201);
  setIdentity(['VIEWER']);
  for (const action of ['CALCULATE_PERIOD', 'SALES_CONFIRM', 'FINANCE_REVIEW', 'SUBMIT_PAYOUT', 'APPLY_PAYROLL']) {
    expectStatus(await callApi('sales/incentives', 'POST', { action, period: '2026-09', resultId: 'audit' }), 403);
  }
});

test('retirement approval, checklist, settlement and effective completion remain consistent', async () => {
  const sql = await resetDatabase({ migrate: true }); await seedAuditEmployee();
  const body = { resource: 'retirement', employeeId: employee.id, eventDate: '2026-08-31', reason: 'Audit retirement',
    tasks: [{ id: 'handover', title: 'Audit handover', ownerType: 'HR' }] };
  const id = expectStatus(await callRoute('operations', 'POST', body), 201).item.id;
  assert.equal(sql.prepare('SELECT status FROM hr_retirement_requests WHERE id=?').get(id).status, 'EFFECTIVE');
  expectStatus(await callRoute('operations', 'PUT', { resource: 'retirementChecklist', id, completedTaskIds: ['handover'] }), 200);
  assert.equal(sql.prepare('SELECT completed_tasks FROM hr_retirement_requests WHERE id=?').get(id).completed_tasks, 1);
  const settlement = { resource: 'retirementSettlement', id, finalSalary: 1000000, retirementPay: 2000000, leaveDays: -1,
    unusedLeavePay: -100000, deductions: 50000, payrollConfirmed: true, insuranceConfirmed: true, accessRevoked: true, assetsReturned: true, handoverConfirmed: true };
  expectStatus(await callRoute('operations', 'PUT', settlement), 200);
  const saved = sql.prepare('SELECT * FROM hr_retirement_settlements WHERE request_id=?').get(id);
  assert.equal(saved.net_settlement, 2850000); assert.equal(saved.status, 'COMPLETED');
  assert.equal(sql.prepare('SELECT status FROM hr_retirement_requests WHERE id=?').get(id).status, 'COMPLETED');
  expectStatus(await callRoute('operations', 'PUT', settlement), 409);
});

test('HR document upload, category update and recoverable deletion use isolated storage', async () => {
  const sql = await resetDatabase({ migrate: true }); await seedAuditEmployee();
  const form = new FormData();
  for (const [key, value] of Object.entries({ module: 'hr', entityType: 'employee', entityId: employee.id, category: 'Audit' })) form.set(key, value);
  form.set('file', new File(['Audit document'], 'audit.txt', { type: 'text/plain' }));
  expectStatus(await callApi('documents', 'POST', form), 201);
  const record = sql.prepare('SELECT * FROM erp_documents').get(); assert.equal(objects.size, 1);
  expectStatus(await callApi('documents', 'PATCH', { id: record.id, category: 'Audit revised' }), 200);
  expectStatus(await callApi('documents', 'DELETE', { id: record.id }), 200);
  assert.ok(sql.prepare('SELECT deleted_at FROM erp_documents WHERE id=?').get(record.id).deleted_at);
  form.set('file', new File(['bad'], 'bad.exe', { type: 'application/octet-stream' }));
  expectStatus(await callApi('documents', 'POST', form), 415);
});

test('employee interview notes and audio require consent, transcription requires explicit consent', async () => {
  const sql = await resetDatabase({ migrate: true }); await seedAuditEmployee();
  const form = new FormData(); form.set('employeeId', employee.id); form.set('interviewAt', '2026-09-01T10:00'); form.set('memo', 'Audit note');
  expectStatus(await callRoute('interviews', 'POST', form), 201);
  form.set('audio', new File(['audit audio'], 'audit.webm', { type: 'audio/webm' }));
  expectStatus(await callRoute('interviews', 'POST', form), 400); assert.equal(objects.size, 0);
  form.set('consentConfirmed', 'true');
  expectStatus(await callRoute('interviews', 'POST', form), 201); assert.equal(objects.size, 1);
  const interview = sql.prepare('SELECT id FROM employee_interview_records WHERE audio_key IS NOT NULL').get();
  const transcribe = { action: 'TRANSCRIBE', entityType: 'EMPLOYEE_INTERVIEW', entityId: interview.id };
  expectStatus(await callRoute('transcriptions', 'POST', transcribe), 400);
  expectStatus(await callRoute('transcriptions', 'POST', { ...transcribe, consentConfirmed: true }), 503);
});

test('analytics report snapshots version correctly and reject reversed periods', async () => {
  const sql = await resetDatabase();
  const body = { action: 'GENERATE_REPORT', from: '2026-01-01', to: '2026-09-01' };
  assert.equal(expectStatus(await callRoute('analytics', 'POST', body), 201).version, 1);
  assert.equal(expectStatus(await callRoute('analytics', 'POST', body), 201).version, 2);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_analytics_reports').get().n, 2);
  expectStatus(await callRoute('analytics', 'POST', { ...body, from: '2026-10-01' }), 400);
});

for (const concurrent of [false, true]) test(`retirement transfer recalculates totals and protects concurrent edits (${concurrent})`, async () => {
  const sql = await resetDatabase({ migrate: true }); await seedAuditEmployee();
  const draft = draftFor({ incentive: 100000 });
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  const id = expectStatus(await callRoute('operations', 'POST', { resource: 'retirement', employeeId: employee.id,
    eventDate: '2026-09-15', reason: 'Audit retirement', tasks: [{ id: 'handover', title: 'Audit handover' }] }), 201).item.id;
  if (concurrent) beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('UPDATE hr_compensation_lines SET snapshot_json'))) {
      sql.prepare("UPDATE hr_compensation_lines SET snapshot_json=json_set(snapshot_json, '$.monthly.\"2026-09\".incentive', 200000) WHERE period=?").run(draft.period);
      sql.prepare('UPDATE hr_compensation_runs SET version=version+1 WHERE period=?').run(draft.period);
      beforeBatch(null);
    }
  });
  expectStatus(await callRoute('operations', 'PUT', { resource: 'severanceToPayroll', id, amount: 1500000, annualLeave: 100000, deduction: 200000 }), concurrent ? 409 : 200);
  const line = sql.prepare('SELECT snapshot_json,gross_pay FROM hr_compensation_lines WHERE period=?').get(draft.period);
  const restored = JSON.parse(line.snapshot_json);
  if (concurrent) assert.equal(restored.monthly[draft.period].incentive, 200000);
  else {
    assert.equal(restored.leaveDate, '2026-09-15'); assert.equal(restored.monthly[draft.period].severance, 1500000);
    const expected = calculateCompensation(restored, 2026, 9, 'round', settings.columns).total;
    assert.equal(line.gross_pay, expected);
    assert.equal(sql.prepare('SELECT gross_pay FROM hr_compensation_runs WHERE period=?').get(draft.period).gross_pay, expected);
    expectStatus(await postWage({ ...draft, action: 'SAVE', version: 1 }), 409);
  }
});
