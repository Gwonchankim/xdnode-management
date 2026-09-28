import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase, callRoute, setIdentity } from './helpers/hr-api-harness.mjs';

for (const role of ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'VIEWER']) {
  test(`local HR role boundaries: ${role}`, async () => {
    await resetDatabase(); setIdentity([role]);
    // R3(r3-auth, D12): 권한은 탭 단위다. setIdentity shim 이 RECRUITER 를 hr 편집으로 옮기므로(Design §8.5) hr 권한도 갖는다.
    // 이 파일은 r3-tabs 에서 tab-permissions 로 대체되어 삭제된다.
    const hrRead = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'VIEWER'].includes(role);
    const hrWrite = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'].includes(role);
    const recruitmentRead = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'VIEWER'].includes(role);
    const recruitmentWrite = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'].includes(role);
    assert.equal((await callRoute('employee-records')).status, hrRead ? 200 : 403);
    assert.equal((await callRoute('compensation', 'GET', undefined, '?period=2099-01')).status, hrRead ? 200 : 403);
    assert.equal((await callRoute('recruitment')).status, recruitmentRead ? 200 : 403);
    assert.equal((await callRoute('employee-records', 'PUT', { employeeId: 'role-test', name: 'Synthetic User' })).status, hrWrite ? 200 : 403);
    // The authorized path reaches field validation; all other roles must stop at the access gate.
    assert.equal((await callRoute('recruitment', 'PUT', {})).status, recruitmentWrite ? 400 : 403);
  });
}
