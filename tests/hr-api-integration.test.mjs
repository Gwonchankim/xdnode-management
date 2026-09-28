import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase, callRoute, callApi, setIdentity, setAccess, beforeBatch, forbidTableAccess, objects } from './helpers/hr-api-harness.mjs';
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

// R1(Design §8.7): approval-settings·sales/incentives 라우트는 삭제되어 documents만 남는다.
for (const [path, query] of [['documents', '?module=hr&entityType=employee&entityId=audit']]) {
  test(`HR connected API ${path} GET and unauthenticated rejection`, async () => {
    await resetDatabase({ migrate: true });
    expectStatus(await callApi(path, 'GET', undefined, query), 200);
    setIdentity(null);
    expectStatus(await callApi(path, 'GET', undefined, query), 401);
  });
}

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

// ── R1 r1-decouple (Design §12.2·§12.3, §8.2 #31~#38): HR 결재 7흐름의 즉시 반영 ─────────────────
// 전자결재가 없어진 뒤로 편집 권한자가 누르면 곧바로 반영된다. 결재 시절 대기 상태(SUBMITTED·PENDING·
// FINALIZATION_SUBMITTED)도 같은 전이의 from-state 로 받고, 같은 전이가 두 번이면 뒤의 것은 409 CONFLICT 다.

const PAST = '2026-01-02';
const FUTURE = '2099-12-31';
// 같은 요청 안의 감사 행은 created_at 이 같을 수 있어 순서 대신 이름 집합으로 비교한다.
const auditActions = (sql, entityId) => sql.prepare('SELECT action FROM erp_audit_logs WHERE entity_id=?').all(entityId).map(row => row.action).sort();
// 결재·업무 테이블은 더 만들지 않는다(Design §12.4). 없는 테이블은 0건으로 센다.
const approvalRows = sql => ['erp_approval_requests', 'erp_approval_steps', 'erp_approval_events', 'erp_tasks']
  .filter(table => sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
  .reduce((sum, table) => sum + sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
const expectConflict = result => {
  const body = expectStatus(result, 409);
  assert.equal(body.code, 'CONFLICT');
  assert.equal(body.error, '다른 사용자가 먼저 상태를 바꿨습니다. 새로고침해 주세요.');
};
const APPROVAL_AND_FINANCE_TABLES = /erp_approval_|erp_tasks|finance_|sales_/;

test('R1 flow 1: personnel actions are registered as approved and applied through applyDuePersonnelActions', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const base = { resource: 'personnelAction', employeeId: employee.id, actionType: '인사이동(전보)', fromDepartment: employee.department, fromPosition: '', toPosition: '사원', reason: 'Audit transfer' };
  const due = expectStatus(await callRoute('operations', 'POST', { ...base, effectiveDate: PAST, toDepartment: 'Moved Team' }), 201).item;
  const dueRow = sql.prepare('SELECT status, approved_by, approved_at FROM hr_personnel_actions WHERE id=?').get(due.id);
  assert.equal(dueRow.status, 'EFFECTIVE'); assert.equal(dueRow.approved_by, 'gc.kim'); assert.ok(dueRow.approved_at);
  assert.equal(sql.prepare('SELECT department FROM hr_employee_records WHERE employee_id=?').get(employee.id).department, 'Moved Team');
  assert.deepEqual(auditActions(sql, due.id), ['PERSONNEL_ACTION_APPROVED', 'PERSONNEL_ACTION_EFFECTIVE']);
  const future = expectStatus(await callRoute('operations', 'POST', { ...base, effectiveDate: FUTURE, toDepartment: 'Future Team' }), 201).item;
  assert.equal(future.status, 'APPROVED');
  assert.equal(sql.prepare('SELECT department FROM hr_employee_records WHERE employee_id=?').get(employee.id).department, 'Moved Team');
  forbidTableAccess(null);
  assert.equal(approvalRows(sql), 0);
});

test('R1 flow 2: retirement starts IN_PROGRESS with its settlement draft and one "퇴직 예정" history entry', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const body = { resource: 'retirement', employeeId: employee.id, eventDate: FUTURE, reason: 'Audit retirement', tasks: [{ id: 'handover', title: 'Audit handover', ownerType: 'HR' }] };
  const item = expectStatus(await callRoute('operations', 'POST', body), 201).item;
  assert.equal(item.status, 'IN_PROGRESS');
  const request = sql.prepare('SELECT status, approved_by, approved_at FROM hr_retirement_requests WHERE id=?').get(item.id);
  assert.equal(request.status, 'IN_PROGRESS'); assert.equal(request.approved_by, 'gc.kim'); assert.ok(request.approved_at);
  assert.equal(sql.prepare('SELECT status FROM hr_retirement_settlements WHERE request_id=?').get(item.id).status, 'DRAFT');
  const record = sql.prepare('SELECT status, retirement_json, history_json FROM hr_employee_records WHERE employee_id=?').get(employee.id);
  assert.equal(record.status, '퇴직 예정');
  assert.equal(JSON.parse(record.retirement_json).status, 'IN_PROGRESS');
  assert.equal(JSON.parse(record.retirement_json).requestId, item.id);
  const history = JSON.parse(record.history_json);
  assert.equal(history.filter(entry => entry.type === '퇴직 예정').length, 1);
  assert.ok(!record.history_json.includes('결재 승인'));
  assert.deepEqual(auditActions(sql, item.id), ['RETIREMENT_APPROVED']);
  // 진행 중인 요청이 있으면 같은 직원의 두 번째 퇴직 등록은 막힌다.
  expectStatus(await callRoute('operations', 'POST', body), 409);
  forbidTableAccess(null);
  assert.equal(approvalRows(sql), 0);
});

test('R1 flow 3: legacy leave form saves an approved request and legacy PENDING rows are decided directly', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const item = expectStatus(await callRoute('operations', 'POST', { resource: 'leaveRequest', employeeId: employee.id, leaveType: 'ANNUAL', startDate: '2026-08-20', endDate: '2026-08-20', units: 100, reason: 'Audit leave' }), 201).item;
  assert.equal(item.status, 'APPROVED');
  const row = sql.prepare('SELECT status, approver_employee_id, decided_at FROM hr_leave_requests WHERE id=?').get(item.id);
  assert.equal(row.status, 'APPROVED'); assert.equal(row.approver_employee_id, 'gc.kim'); assert.ok(row.decided_at);
  assert.deepEqual(auditActions(sql, item.id), ['LEAVE_REQUEST_APPROVED']);
  sql.prepare(`INSERT INTO hr_leave_requests (id, employee_id, leave_type, start_date, end_date, units, reason, status, approver_employee_id, decided_at, created_at, updated_at)
    VALUES ('legacy-leave', ?, 'ANNUAL', '2026-08-21', '2026-08-21', 100, 'Legacy', 'PENDING', '', NULL, 1, 1)`).run(employee.id);
  expectStatus(await callRoute('operations', 'PUT', { resource: 'leaveRequest', id: 'legacy-leave', status: 'APPROVED' }), 200);
  assert.equal(sql.prepare("SELECT status FROM hr_leave_requests WHERE id='legacy-leave'").get().status, 'APPROVED');
  forbidTableAccess(null);
  assert.equal(approvalRows(sql), 0);
});

test('R1 flow 4: payroll approval, lock and reopen stay inside HR on a database without approval or finance tables', async () => {
  const sql = await resetDatabase(); const draft = draftFor();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  const put = body => callRoute('payroll', 'PUT', { period: draft.period, ...body });
  expectStatus(await put({ status: 'REVIEW' }), 200);
  const approved = expectStatus(await put({ status: 'APPROVED' }), 200).item;
  assert.equal(approved.status, 'APPROVED'); assert.equal(approved.approved_by, 'gc.kim'); assert.equal(approved.reviewed_by, 'gc.kim');
  const locked = expectStatus(await put({ status: 'LOCKED' }), 200).item;
  assert.equal(locked.status, 'LOCKED'); assert.ok(locked.locked_at);
  const reopened = expectStatus(await put({ status: 'DRAFT', reopenedReason: 'Audit correction of payroll details' }), 200).item;
  assert.equal(reopened.status, 'DRAFT'); assert.equal(reopened.approved_by, ''); assert.equal(reopened.locked_at, null);
  assert.equal(reopened.reopened_reason, 'Audit correction of payroll details');
  forbidTableAccess(null);
  assert.deepEqual(auditActions(sql, draft.period).filter(action => action.startsWith('PAYROLL_RUN')),
    ['PAYROLL_RUN_LOCKED', 'PAYROLL_RUN_REOPENED', 'PAYROLL_RUN_STATUS_UPDATED', 'PAYROLL_RUN_STATUS_UPDATED']);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'finance_%'").get().n, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM erp_audit_logs WHERE module='finance'").get().n, 0);
  assert.equal(approvalRows(sql), 0);
});

test('R1 flow 4: a concurrent payroll transition loses with 409 CONFLICT', async () => {
  const sql = await resetDatabase(); const draft = draftFor();
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'REVIEW' }), 200);
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('UPDATE hr_payroll_runs SET status'))) {
      sql.prepare("UPDATE hr_payroll_runs SET status='LOCKED' WHERE period=?").run(draft.period);
      beforeBatch(null);
    }
  });
  expectConflict(await callRoute('payroll', 'PUT', { period: draft.period, status: 'APPROVED' }));
  assert.equal(sql.prepare('SELECT status FROM hr_payroll_runs WHERE period=?').get(draft.period).status, 'LOCKED');
  // 두 번째 재오픈도 같은 규칙이다.
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT', reopenedReason: 'First reopen' }), 200);
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('UPDATE hr_payroll_runs SET status'))) {
      sql.prepare("UPDATE hr_payroll_runs SET status='DRAFT' WHERE period=?").run(draft.period);
      beforeBatch(null);
    }
  });
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'LOCKED' }), 200);
  sql.prepare("UPDATE hr_payroll_runs SET status='LOCKED' WHERE period=?").run(draft.period);
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith('UPDATE hr_payroll_runs SET status'))) {
      sql.prepare("UPDATE hr_payroll_runs SET status='DRAFT' WHERE period=?").run(draft.period);
      beforeBatch(null);
    }
  });
  expectConflict(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT', reopenedReason: 'Second reopen' }));
});

test('R1 flow 5: performance finalization finalizes the cycle and calibrated participants in one batch', async () => {
  const sql = await resetDatabase();
  expectStatus(await callRoute('performance', 'GET', undefined, '?year=2026'), 200);
  const seedCycle = (id, status) => {
    sql.prepare(`INSERT INTO hr_performance_cycles (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
      calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
      VALUES (?, ?, '2026-H2', '', ?, '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', 'gc.kim', 1, '', NULL, 1, 1)`).run(id, `Audit ${id}`, status);
    sql.prepare(`INSERT INTO hr_performance_participants (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
      final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
      VALUES (?, ?, 'gc.kim', '', '', 'CALIBRATED', 90, 'A', 'Audit', '', NULL, 1, 1)`).run(`${id}-p`, id);
  };
  seedCycle('cycle-new', 'CALIBRATION');
  seedCycle('cycle-legacy', 'FINALIZATION_SUBMITTED');
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  for (const cycleId of ['cycle-new', 'cycle-legacy']) {
    expectStatus(await callRoute('performance', 'POST', { action: 'SUBMIT_FINALIZATION', cycleId }), 200);
    const cycle = sql.prepare('SELECT status, finalized_by, finalized_at FROM hr_performance_cycles WHERE id=?').get(cycleId);
    assert.equal(cycle.status, 'FINALIZED'); assert.equal(cycle.finalized_by, 'gc.kim'); assert.ok(cycle.finalized_at);
    assert.equal(sql.prepare('SELECT status FROM hr_performance_participants WHERE cycle_id=?').get(cycleId).status, 'FINALIZED');
    assert.deepEqual(auditActions(sql, cycleId), ['PERFORMANCE_CYCLE_FINALIZED']);
  }
  forbidTableAccess(null);
  seedCycle('cycle-race', 'CALIBRATION');
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith("UPDATE hr_performance_cycles SET status = 'FINALIZED'"))) {
      sql.prepare("UPDATE hr_performance_cycles SET status='FINALIZED' WHERE id='cycle-race'").run();
      beforeBatch(null);
    }
  });
  expectConflict(await callRoute('performance', 'POST', { action: 'SUBMIT_FINALIZATION', cycleId: 'cycle-race' }));
  assert.equal(sql.prepare("SELECT status FROM hr_performance_participants WHERE cycle_id='cycle-race'").get().status, 'CALIBRATED');
  assert.equal(approvalRows(sql), 0);
});

test('R1 performance appeal "accept" is RESOLVED on the server (ACCEPTED is still rejected)', async () => {
  const sql = await resetDatabase();
  expectStatus(await callRoute('performance', 'GET', undefined, '?year=2026'), 200);
  const now = Date.now();
  sql.prepare(`INSERT INTO hr_performance_cycles (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
    calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
    VALUES ('cycle-final', 'Audit Final', '2026-H1', '', 'FINALIZED', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', 'gc.kim', 1, 'gc.kim', ?, 1, 1)`).run(now);
  sql.prepare(`INSERT INTO hr_performance_participants (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
    final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
    VALUES ('participant-final', 'cycle-final', 'gc.kim', '', '', 'FINALIZED', 80, 'B', '', 'gc.kim', ?, 1, 1)`).run(now);
  sql.prepare(`INSERT INTO hr_performance_appeals (id, participant_id, reason, status, response, submitted_by, submitted_at, resolved_by, resolved_at, created_at, updated_at)
    VALUES ('appeal-1', 'participant-final', 'Audit appeal reason for the final rating', 'SUBMITTED', '', 'gc.kim', ?, '', NULL, ?, ?)`).run(now, now, now);
  const resolve = outcome => callRoute('performance', 'POST', { action: 'RESOLVE_APPEAL', participantId: 'participant-final', appealId: 'appeal-1', outcome, response: 'Accepted after review of evidence' });
  expectStatus(await resolve('ACCEPTED'), 400);
  expectStatus(await resolve('RESOLVED'), 200);
  assert.equal(sql.prepare("SELECT status FROM hr_performance_appeals WHERE id='appeal-1'").get().status, 'RESOLVED');
});

test('R1 flow 6: workforce plan approval supersedes the previous approved version in the same batch', async () => {
  const sql = await resetDatabase();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const assumptions = 'Audit plan assumptions and basis';
  const firstId = expectStatus(await callRoute('workforce-plans', 'POST', { action: 'CREATE_PLAN', period: '2026-H2', title: 'Audit Plan' }), 201).id;
  expectStatus(await callRoute('workforce-plans', 'POST', { action: 'SAVE_PLAN', planId: firstId, title: 'Audit Plan', assumptions }), 200);
  expectStatus(await callRoute('workforce-plans', 'POST', { action: 'SUBMIT_PLAN', planId: firstId }), 200);
  const first = sql.prepare('SELECT status, approved_by, approved_at, submitted_at FROM hr_workforce_plans WHERE id=?').get(firstId);
  assert.equal(first.status, 'APPROVED'); assert.equal(first.approved_by, 'gc.kim'); assert.ok(first.approved_at); assert.ok(first.submitted_at);
  const secondId = expectStatus(await callRoute('workforce-plans', 'POST', { action: 'CREATE_REVISION', planId: firstId, reason: 'Audit revision' }), 201).id;
  // 결재 시절에 SUBMITTED 로 남은 계획도 같은 버튼으로 확정된다.
  sql.prepare("UPDATE hr_workforce_plans SET status='SUBMITTED' WHERE id=?").run(secondId);
  expectStatus(await callRoute('workforce-plans', 'POST', { action: 'SUBMIT_PLAN', planId: secondId }), 200);
  assert.equal(sql.prepare('SELECT status FROM hr_workforce_plans WHERE id=?').get(firstId).status, 'SUPERSEDED');
  assert.equal(sql.prepare('SELECT status FROM hr_workforce_plans WHERE id=?').get(secondId).status, 'APPROVED');
  assert.deepEqual(auditActions(sql, secondId).filter(action => action === 'WORKFORCE_PLAN_APPROVED'), ['WORKFORCE_PLAN_APPROVED']);
  forbidTableAccess(null);
  const thirdId = expectStatus(await callRoute('workforce-plans', 'POST', { action: 'CREATE_REVISION', planId: secondId, reason: 'Audit race' }), 201).id;
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith("UPDATE hr_workforce_plans SET status = 'APPROVED'"))) {
      sql.prepare("UPDATE hr_workforce_plans SET status='CANCELLED' WHERE id=?").run(thirdId);
      beforeBatch(null);
    }
  });
  expectConflict(await callRoute('workforce-plans', 'POST', { action: 'SUBMIT_PLAN', planId: thirdId }));
  // 대상 전이가 실패하면 이전 승인본도 SUPERSEDED 로 바뀌지 않는다.
  assert.equal(sql.prepare('SELECT status FROM hr_workforce_plans WHERE id=?').get(secondId).status, 'APPROVED');
  assert.equal(approvalRows(sql), 0);
});

test('R1 flow 7: requisitions open at registration, legacy SUBMITTED rows open directly, deletion needs no approval tables', async () => {
  const sql = await resetDatabase();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const organizationId = expectStatus(await callRoute('recruitment-requisitions'), 200).organizations[0].id;
  const create = role => callRoute('recruitment-requisitions', 'POST', { action: 'CREATE_DRAFT', organizationId, role, requestedHeadcount: 1, targetStartDate: '2026-12-01' });
  const created = expectStatus(await create('Audit Role'), 201);
  assert.equal(created.opened, true);
  const opened = sql.prepare('SELECT status, approved_by, approved_at FROM hr_recruitment_requisitions WHERE id=?').get(created.id);
  assert.equal(opened.status, 'OPEN'); assert.equal(opened.approved_by, 'gc.kim'); assert.ok(opened.approved_at);
  assert.deepEqual(auditActions(sql, created.id), ['REQUISITION_CREATED', 'REQUISITION_OPENED']);
  const legacy = expectStatus(await create('Legacy Role'), 201).id;
  sql.prepare("UPDATE hr_recruitment_requisitions SET status='SUBMITTED' WHERE id=?").run(legacy);
  expectStatus(await callRoute('recruitment-requisitions', 'POST', { action: 'SUBMIT', id: legacy }), 200);
  assert.equal(sql.prepare('SELECT status FROM hr_recruitment_requisitions WHERE id=?').get(legacy).status, 'OPEN');
  expectStatus(await callRoute('recruitment-requisitions', 'POST', { action: 'SUBMIT', id: legacy }), 409);
  expectStatus(await callRoute('recruitment-requisitions', 'POST', { action: 'DELETE', id: legacy, reason: 'Audit deletion' }), 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hr_recruitment_requisitions WHERE id=?').get(legacy).n, 0);
  forbidTableAccess(null);
  const race = expectStatus(await create('Race Role'), 201).id;
  sql.prepare("UPDATE hr_recruitment_requisitions SET status='DRAFT' WHERE id=?").run(race);
  beforeBatch(statements => {
    if (statements.some(statement => statement.sql.startsWith("UPDATE hr_recruitment_requisitions SET status = 'OPEN'"))) {
      sql.prepare("UPDATE hr_recruitment_requisitions SET status='CANCELLED' WHERE id=?").run(race);
      beforeBatch(null);
    }
  });
  expectConflict(await callRoute('recruitment-requisitions', 'POST', { action: 'SUBMIT', id: race }));
  assert.equal(approvalRows(sql), 0);
});

test('R1 legacy decisions: stranded SUBMITTED personnel actions are approved once, then conflict', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  expectStatus(await callRoute('operations', 'GET'), 200);
  const seed = (id, effectiveDate) => sql.prepare(`INSERT INTO hr_personnel_actions (id, employee_id, action_type, effective_date, order_number, before_json, after_json,
    reason, status, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, '인사이동(전보)', ?, '', '{}', '{"department":"Legacy Team","position":"사원"}', 'Legacy', 'SUBMITTED', '', NULL, 1, 1)`).run(id, employee.id, effectiveDate);
  seed('legacy-action', PAST); seed('legacy-reject', PAST);
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const decide = (id, decision) => callRoute('operations', 'PUT', { resource: 'personnelActionDecision', id, decision, reason: 'Audit legacy decision' });
  expectStatus(await decide('legacy-action', 'MAYBE'), 400);
  expectStatus(await decide('missing', 'APPROVED'), 404);
  const approved = expectStatus(await decide('legacy-action', 'APPROVED'), 200).item;
  assert.equal(approved.status, 'EFFECTIVE'); assert.equal(approved.approved_by, 'gc.kim');
  assert.equal(sql.prepare('SELECT department FROM hr_employee_records WHERE employee_id=?').get(employee.id).department, 'Legacy Team');
  expectConflict(await decide('legacy-action', 'APPROVED'));
  assert.equal(expectStatus(await decide('legacy-reject', 'REJECTED'), 200).item.status, 'REJECTED');
  expectConflict(await decide('legacy-reject', 'APPROVED'));
  forbidTableAccess(null);
  assert.deepEqual(auditActions(sql, 'legacy-action'), ['PERSONNEL_ACTION_APPROVED', 'PERSONNEL_ACTION_EFFECTIVE']);
  assert.deepEqual(auditActions(sql, 'legacy-reject'), ['PERSONNEL_ACTION_REJECTED']);
  assert.equal(sql.prepare("SELECT reason FROM erp_audit_logs WHERE entity_id='legacy-reject'").get().reason, 'Audit legacy decision');
  setIdentity(['VIEWER']);
  expectStatus(await decide('legacy-reject', 'APPROVED'), 403);
});

test('R1 legacy decisions: a stranded SUBMITTED retirement can be approved or rejected so it no longer blocks a new one', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  expectStatus(await callRoute('operations', 'GET'), 200);
  const seed = id => {
    sql.prepare(`INSERT INTO hr_retirement_requests (id, employee_id, retirement_date, reason, status, checklist_json, total_tasks, completed_tasks,
      requested_by, approved_by, approved_at, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, 'Legacy retirement', 'SUBMITTED', '[]', 1, 0, 'gc.kim', '', NULL, NULL, 1, 1)`).run(id, employee.id, FUTURE);
    sql.prepare(`INSERT INTO hr_lifecycle_tasks (id, employee_id, lifecycle_type, task_group, title, owner_employee_id, due_date, status, completed_at, created_at, updated_at)
      VALUES (?, ?, 'RETIREMENT', 'HR', 'Legacy handover', '', ?, 'OPEN', NULL, 1, 1)`).run(`${id}:handover`, employee.id, FUTURE);
  };
  const decide = (id, decision) => callRoute('operations', 'PUT', { resource: 'retirementDecision', id, decision, reason: 'Audit legacy retirement' });
  const newRetirement = { resource: 'retirement', employeeId: employee.id, eventDate: FUTURE, reason: 'New retirement', tasks: [{ id: 'handover', title: 'Audit handover' }] };
  seed('legacy-retirement-reject');
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  // SUBMITTED 요청은 같은 직원의 새 퇴직 등록을 막는다. 반려하면 풀린다.
  expectStatus(await callRoute('operations', 'POST', newRetirement), 409);
  assert.equal(expectStatus(await decide('legacy-retirement-reject', 'REJECTED'), 200).item.status, 'REJECTED');
  assert.equal(sql.prepare("SELECT status FROM hr_lifecycle_tasks WHERE id='legacy-retirement-reject:handover'").get().status, 'CANCELLED');
  expectConflict(await decide('legacy-retirement-reject', 'REJECTED'));
  forbidTableAccess(null);
  sql.prepare('DELETE FROM hr_retirement_requests').run();
  seed('legacy-retirement-approve');
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const approved = expectStatus(await decide('legacy-retirement-approve', 'APPROVED'), 200).item;
  assert.equal(approved.status, 'IN_PROGRESS'); assert.equal(approved.approved_by, 'gc.kim');
  assert.equal(sql.prepare("SELECT status FROM hr_retirement_settlements WHERE request_id='legacy-retirement-approve'").get().status, 'DRAFT');
  const record = sql.prepare('SELECT status, retirement_json FROM hr_employee_records WHERE employee_id=?').get(employee.id);
  assert.equal(record.status, '퇴직 예정'); assert.equal(JSON.parse(record.retirement_json).status, 'IN_PROGRESS');
  expectConflict(await decide('legacy-retirement-approve', 'APPROVED'));
  forbidTableAccess(null);
  assert.deepEqual(auditActions(sql, 'legacy-retirement-reject'), ['RETIREMENT_REJECTED']);
  assert.deepEqual(auditActions(sql, 'legacy-retirement-approve'), ['RETIREMENT_APPROVED']);
});

test('R1 HR direct-apply flows stay behind the existing write/approve gates', async () => {
  await resetDatabase(); await seedAuditEmployee(); setIdentity(['VIEWER']);
  const denied = [
    ['operations', 'POST', { resource: 'personnelAction', employeeId: employee.id }],
    ['operations', 'POST', { resource: 'retirement', employeeId: employee.id }],
    ['operations', 'POST', { resource: 'leaveRequest', employeeId: employee.id }],
    ['operations', 'PUT', { resource: 'personnelActionDecision', id: 'x', decision: 'APPROVED' }],
    ['operations', 'PUT', { resource: 'retirementDecision', id: 'x', decision: 'APPROVED' }],
    ['payroll', 'PUT', { period: '2026-09', status: 'APPROVED' }],
    ['performance', 'POST', { action: 'SUBMIT_FINALIZATION', cycleId: 'x' }],
    ['workforce-plans', 'POST', { action: 'SUBMIT_PLAN', planId: 'x' }],
    ['recruitment-requisitions', 'POST', { action: 'SUBMIT', id: 'x' }],
  ];
  for (const [name, method, body] of denied) assert.equal((await callRoute(name, method, body)).status, 403, `${method} ${name} ${JSON.stringify(body)}`);
});

test('R1 static legacy period lists block re-confirming and reopening those months', async () => {
  const sql = await resetDatabase(); const draft = draftFor();
  const compensationRoute = await import('../app/api/hr/compensation/route.ts');
  const payrollRoute = await import('../app/api/hr/payroll/route.ts');
  assert.deepEqual([...compensationRoute.LEGACY_SALES_INCENTIVE_PERIODS], []);
  assert.deepEqual([...payrollRoute.LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS], []);
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  compensationRoute.LEGACY_SALES_INCENTIVE_PERIODS.push(draft.period);
  try {
    const blocked = expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 409);
    assert.equal(blocked.code, 'LEGACY_PERIOD_LOCKED'); assert.equal(blocked.period, draft.period);
    assert.equal(blocked.error, '영업 인센티브가 반영된 과거 급여월은 다시 확정할 수 없습니다.');
  } finally { compensationRoute.LEGACY_SALES_INCENTIVE_PERIODS.pop(); }
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'LOCKED' }), 200);
  payrollRoute.LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS.push(draft.period);
  try {
    const blocked = expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT', reopenedReason: 'Audit reopen' }), 409);
    assert.equal(blocked.code, 'LEGACY_PERIOD_LOCKED'); assert.equal(blocked.period, draft.period);
    assert.equal(blocked.error, '재무에서 지급·전기된 과거 급여월은 다시 열 수 없습니다.');
  } finally { payrollRoute.LEGACY_FINANCE_LOCKED_PAYROLL_PERIODS.pop(); }
  assert.equal(sql.prepare('SELECT status FROM hr_payroll_runs WHERE period=?').get(draft.period).status, 'LOCKED');
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'DRAFT', reopenedReason: 'Audit reopen' }), 200);
});

test('R1 compensation CONFIRM no longer adds sales incentive links to payroll records', async () => {
  const sql = await resetDatabase(); const draft = draftFor({ incentive: 50000 });
  sql.exec(`CREATE TABLE sales_incentive_payroll_links (payroll_record_id TEXT, payroll_period TEXT, applied_amount INTEGER)`);
  sql.prepare('INSERT INTO sales_incentive_payroll_links VALUES (?, ?, 777777)').run(`compensation:${draft.period}:${employee.id}`, draft.period);
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  forbidTableAccess(/sales_/);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  forbidTableAccess(null);
  const record = sql.prepare('SELECT incentive FROM hr_payroll_records WHERE employee_id=?').get(employee.id);
  assert.equal(record.incentive, 50000);
});

test('R1 fresh database: leave deletion and decision, payroll approval and requisition deletion never read approval tables', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  forbidTableAccess(APPROVAL_AND_FINANCE_TABLES);
  const recorded = expectStatus(await callRoute('leave', 'POST', { employeeId: employee.id, leaveType: 'ANNUAL', date: '2026-08-20', units: 1 }), 201);
  expectStatus(await callRoute('leave', 'DELETE', undefined, `?id=${recorded.id}`), 200);
  sql.prepare(`INSERT INTO hr_leave_requests (id, employee_id, leave_type, start_date, end_date, units, reason, status, approver_employee_id, decided_at, created_at, updated_at)
    VALUES ('fresh-leave', ?, 'ANNUAL', '2026-08-22', '2026-08-22', 100, '', 'PENDING', '', NULL, 1, 1)`).run(employee.id);
  expectStatus(await callRoute('operations', 'PUT', { resource: 'leaveRequest', id: 'fresh-leave', status: 'REJECTED' }), 200);
  const draft = draftFor();
  expectStatus(await postWage({ ...draft, action: 'CREATE' }), 201);
  expectStatus(await postWage({ ...draft, action: 'CONFIRM', version: 1 }), 200);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'REVIEW' }), 200);
  expectStatus(await callRoute('payroll', 'PUT', { period: draft.period, status: 'APPROVED' }), 200);
  const organizationId = expectStatus(await callRoute('recruitment-requisitions'), 200).organizations[0].id;
  const requisition = expectStatus(await callRoute('recruitment-requisitions', 'POST', { action: 'CREATE_DRAFT', organizationId, role: 'Fresh Role', requestedHeadcount: 1, targetStartDate: '2026-12-01' }), 201).id;
  expectStatus(await callRoute('recruitment-requisitions', 'POST', { action: 'DELETE', id: requisition, reason: 'Fresh deletion' }), 200);
});

test('R1 documents: legacy finance/sales rows are 404 even for administrators, and only hr·recruitment modules are accepted', async () => {
  const sql = await resetDatabase();
  expectStatus(await callApi('documents', 'GET', undefined, '?module=hr&entityType=employee&entityId=audit'), 200);
  sql.prepare(`INSERT INTO erp_documents (id, module, entity_type, entity_id, category, version, file_name, content_type, storage_key, uploaded_by, created_at, deleted_at)
    VALUES ('legacy-finance-doc', 'finance', 'financeExpense', 'payroll:2026-08', '증빙', 1, 'legacy.pdf', 'application/pdf', 'erp-documents/finance/legacy.pdf', 'gc.kim', 1, NULL)`).run();
  const download = await callApi('documents', 'GET', undefined, '?downloadId=legacy-finance-doc');
  assert.equal(download.status, 404); assert.equal(download.body, '문서를 찾을 수 없습니다.');
  expectStatus(await callApi('documents', 'PATCH', { id: 'legacy-finance-doc', category: 'moved' }), 404);
  expectStatus(await callApi('documents', 'DELETE', { id: 'legacy-finance-doc' }), 404);
  expectStatus(await callApi('documents', 'GET', undefined, '?module=finance&entityType=financeExpense&entityId=payroll:2026-08'), 400);
  expectStatus(await callApi('documents', 'GET', undefined, '?module=sales&entityType=salesContract&entityId=x'), 400);
  assert.equal(sql.prepare("SELECT deleted_at FROM erp_documents WHERE id='legacy-finance-doc'").get().deleted_at, null);
  const form = new FormData();
  for (const [key, value] of Object.entries({ module: 'finance', entityType: 'financeExpense', entityId: 'x', category: 'Audit' })) form.set(key, value);
  form.set('file', new File(['Audit'], 'audit.txt', { type: 'text/plain' }));
  expectStatus(await callApi('documents', 'POST', form), 400);
  assert.equal(objects.size, 0);
});

test('R1 documents POST authorizes before reading the form, then requires hr:write for hr uploads', async () => {
  const sql = await resetDatabase();
  const broken = { rawBody: 'this is not multipart', contentType: 'multipart/form-data; boundary=audit' };
  setIdentity(['VIEWER']);
  expectStatus(await callApi('documents', 'POST', undefined, '', broken), 403);
  setIdentity(null);
  expectStatus(await callApi('documents', 'POST', undefined, '', broken), 401);
  setIdentity(['SUPER_ADMIN']);
  expectStatus(await callApi('documents', 'POST', undefined, '', broken), 400);
  const upload = module => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ module, entityType: 'applicant', entityId: 'audit-applicant', category: 'Audit' })) form.set(key, value);
    form.set('file', new File(['Audit document'], 'audit.txt', { type: 'text/plain' }));
    return callApi('documents', 'POST', form);
  };
  // R3(r3-auth, D12): 권한은 탭 단위라 'recruitment 전용' 계정이 없다. setIdentity 호환 shim 은 RECRUITER 를 hr 편집으로 옮기므로
  // (Design §8.5) 채용 문서 업로드만 확인한다. hr 보기 계정의 거부는 위 VIEWER 403 이 확인한다.
  setIdentity(['RECRUITER']);
  expectStatus(await upload('recruitment'), 201);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM erp_documents WHERE module='hr'").get().n, 0);
  assert.equal(sql.prepare("SELECT action FROM erp_audit_logs WHERE action='DOCUMENT_UPLOADED'").get().action, 'DOCUMENT_UPLOADED');
  setIdentity(['HR_ADMIN']);
  expectStatus(await upload('hr'), 201);
});

test('R1 assistant: the incentive mode authorizes as hr and the old sales mode is rejected before authorization', async () => {
  await resetDatabase();
  expectStatus(await callApi('assistant', 'POST', { module: 'sales', question: 'audit' }), 400);
  setIdentity(null);
  expectStatus(await callApi('assistant', 'POST', { module: 'sales', question: 'audit' }), 400);
  // R3(r3-auth, D12): 'recruitment 전용' 역할이 없어졌다. 탭 권한이 하나도 없는 계정으로 브리지 호출 전 403 을 확인한다.
  setAccess({});
  expectStatus(await callApi('assistant', 'POST', { module: 'incentive', question: 'audit' }), 403);
  expectStatus(await callApi('assistant', 'POST', { module: 'compensation', question: 'audit' }), 403);
});

test('R1 authorized users no longer grant the finance or sales administrator roles', async () => {
  await resetDatabase();
  const { companyEmployees } = await import('../app/hr-company-data.ts');
  const target = companyEmployees.find(item => item.id !== 'gc.kim' && item.email && item.email !== '미입력');
  for (const role of ['FINANCE_ADMIN', 'SALES_ADMIN']) {
    const saved = (await callRoute('authorized-users', 'POST', { employeeId: target.id, roles: [role] })).body;
    assert.deepEqual(saved.user.roles, ['VIEWER'], role);
  }
});

test('R1 platform: a fresh database no longer creates approval, task or sync tables (Design §12.4, D4)', async () => {
  const sql = await resetDatabase(); await seedAuditEmployee();
  expectStatus(await callRoute('employee-records'), 200);
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.includes('erp_audit_logs'));
  assert.deepEqual(tables.filter(name => /^erp_approval_|^erp_tasks$|^erp_sync_runs$/.test(name)), []);
});

test('organization rename succeeds on a fresh database without payroll or compensation tables (SC-4 new DB)', async () => {
  const sql = await resetDatabase();
  // HR 화면은 열 때 직원 기록을 먼저 불러온다. 급여·임금 계산은 한 번도 열지 않은 상태다.
  expectStatus(await callRoute('employee-records'), 200);
  const tableExists = name => Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  assert.equal(tableExists('hr_payroll_records'), false);
  assert.equal(tableExists('hr_compensation_lines'), false);
  const created = expectStatus(await callRoute('organizations', 'POST', { name: 'Fresh Rename Team' }), 201);
  const organizationId = (created.organization ?? created.item ?? created).organizationId;
  assert.ok(organizationId);
  expectStatus(await callRoute('organizations', 'PUT', { organizationId, name: 'Fresh Rename Team 2', previousName: 'Fresh Rename Team' }), 200);
  assert.equal(sql.prepare('SELECT name FROM hr_organization_records WHERE organization_id=?').get(organizationId).name, 'Fresh Rename Team 2');
});
