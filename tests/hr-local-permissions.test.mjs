import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase, callRoute, callApi, setIdentity } from './helpers/hr-api-harness.mjs';

for (const role of ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'FINANCE_ADMIN', 'SALES_ADMIN', 'VIEWER']) {
  test(`local HR role boundaries: ${role}`, async () => {
    await resetDatabase(); setIdentity([role]);
    const hrRead = ['SUPER_ADMIN', 'HR_ADMIN', 'VIEWER'].includes(role);
    const hrWrite = ['SUPER_ADMIN', 'HR_ADMIN'].includes(role);
    const recruitmentRead = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'VIEWER'].includes(role);
    const recruitmentWrite = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'].includes(role);
    assert.equal((await callRoute('employee-records')).status, hrRead ? 200 : 403);
    assert.equal((await callRoute('compensation', 'GET', undefined, '?period=2099-01')).status, hrRead ? 200 : 403);
    assert.equal((await callRoute('recruitment')).status, recruitmentRead ? 200 : 403);
    assert.equal((await callRoute('employee-records', 'PUT', { employeeId: 'role-test', name: 'Synthetic User' })).status, hrWrite ? 200 : 403);
    // The authorized path reaches field validation; all other roles must stop at the access gate.
    assert.equal((await callRoute('recruitment', 'PUT', {})).status, recruitmentWrite ? 400 : 403);
    assert.equal((await callApi('approval-settings')).status, role === 'SUPER_ADMIN' ? 200 : 403);
  });
}
