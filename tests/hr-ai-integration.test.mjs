import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase, callRoute, testBindings, objects } from './helpers/hr-api-harness.mjs';

async function audioFixture() {
  const sql = await resetDatabase({ migrate: true });
  const form = new FormData();
  form.set('employeeId', 'audit-audio'); form.set('interviewAt', '2026-09-21T10:00');
  form.set('consentConfirmed', 'true'); form.set('audio', new File(['synthetic audio'], 'audit.webm', { type: 'audio/webm' }));
  assert.equal((await callRoute('interviews', 'POST', form)).status, 201);
  const row = sql.prepare('SELECT id, audio_key FROM employee_interview_records').get();
  testBindings.CLOUDFLARE_ACCOUNT_ID = 'test-account'; testBindings.CLOUDFLARE_API_TOKEN = 'test-token';
  return { sql, row, request: { action: 'TRANSCRIBE', entityType: 'EMPLOYEE_INTERVIEW', entityId: row.id, consentConfirmed: true } };
}
function provider(t, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = callback;
  t.after(() => { globalThis.fetch = original; });
}

test('AI transcription completes, preserves original and locks reviewed text against a second review', async t => {
  const { request, sql } = await audioFixture();
  let calls = 0;
  provider(t, async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api.cloudflare.com\//);
    assert.equal(JSON.parse(options.body).language, 'ko');
    return Response.json({ success: true, result: { transcription_info: { text: 'Synthetic interview', word_count: 2 }, vtt: 'WEBVTT\n' } });
  });
  const completed = await callRoute('transcriptions', 'POST', request);
  assert.equal(completed.status, 201); assert.equal(completed.body.job.status, 'COMPLETED');
  assert.equal((await callRoute('transcriptions', 'POST', request)).status, 409);
  assert.equal(calls, 1);
  const review = { ...request, action: 'REVIEW', transcriptionId: completed.body.job.id, reviewedText: 'Reviewed synthetic interview' };
  assert.equal((await callRoute('transcriptions', 'POST', review)).status, 200);
  assert.equal((await callRoute('transcriptions', 'POST', review)).status, 409);
  const stored = sql.prepare('SELECT transcript, reviewed_text FROM hr_audio_transcriptions').get();
  assert.equal(stored.transcript, 'Synthetic interview'); assert.equal(stored.reviewed_text, review.reviewedText);
});

for (const kind of ['quota', 'timeout', 'empty', 'malformed']) test(`AI transcription ${kind} records failure and permits explicit retry`, async t => {
  const { request, sql } = await audioFixture();
  provider(t, async () => {
    if (kind === 'timeout') throw new DOMException('timeout', 'TimeoutError');
    if (kind === 'quota') return Response.json({ success: false }, { status: 429 });
    if (kind === 'malformed') return new Response('not json');
    return Response.json({ success: true, result: { text: '' } });
  });
  assert.equal((await callRoute('transcriptions', 'POST', request)).status, kind === 'quota' ? 429 : kind === 'empty' ? 422 : 502);
  assert.notEqual(sql.prepare('SELECT status FROM hr_audio_transcriptions').get().status, 'PROCESSING');
  globalThis.fetch = async () => Response.json({ success: true, result: { text: 'Retry completed' } });
  const retried = await callRoute('transcriptions', 'POST', { ...request, force: true });
  assert.equal(retried.status, 201); assert.equal(retried.body.job.attempt, 2);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM hr_audio_transcriptions').get().n, 2);
});

test('AI transcription missing or oversized audio stops before contacting provider', async t => {
  const { request, row } = await audioFixture();
  provider(t, async () => { assert.fail('Provider must not receive missing or oversized audio'); });
  objects.delete(row.audio_key);
  assert.equal((await callRoute('transcriptions', 'POST', request)).status, 404);
  objects.set(row.audio_key, { value: new ArrayBuffer(10 * 1024 * 1024 + 1), options: {} });
  assert.equal((await callRoute('transcriptions', 'POST', { ...request, force: true })).status, 413);
});

test('AI resume malformed output and bridge failure return errors without creating applicants', async t => {
  const sql = await resetDatabase();
  await callRoute('recruitment');
  const count = () => sql.prepare('SELECT count(*) AS n FROM hr_applicants').get().n;
  const before = count();
  const request = { fileName: 'synthetic.txt', resumeText: 'This is a fictional resume for local integration testing only.' };
  provider(t, async () => Response.json({ choices: [{ message: { content: 'not json' } }] }));
  assert.equal((await callRoute('resume-analysis', 'POST', request)).status, 502);
  globalThis.fetch = async () => { throw new TypeError('connection refused'); };
  assert.equal((await callRoute('resume-analysis', 'POST', request)).status, 502);
  assert.equal(count(), before);
});
