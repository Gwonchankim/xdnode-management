import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const source = await readFile(new URL(name, migrationDirectory), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  return db;
}

test("retirement and recruitment offer ledgers preserve workflow state", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_retirement_requests
    (id, employee_id, retirement_date, reason, checklist_json, total_tasks, completed_tasks, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("retirement-1", "gc.kim", "2026-09-30", "본인 의사", "[]", 10, 0, "gc.kim", now, now);
  db.prepare(`INSERT INTO hr_offer_requests
    (id, applicant_id, proposed_title, department, employment_type, start_date, annual_salary,
      probation_months, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("offer-1", "applicant-1", "연구개발", "기술팀", "일반직", "2026-09-01", 42000000, 3, "gc.kim", now, now);
  db.prepare(`INSERT INTO hr_retirement_settlements
    (request_id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run("retirement-1", now, now);
  const retirement = db.prepare("SELECT status, total_tasks, completed_tasks FROM hr_retirement_requests WHERE id = ?").get("retirement-1");
  const offer = db.prepare("SELECT status, annual_salary, probation_months, employee_id, response_note, responded_by FROM hr_offer_requests WHERE id = ?").get("offer-1");
  const settlement = db.prepare("SELECT status, net_settlement, access_revoked FROM hr_retirement_settlements WHERE request_id = ?").get("retirement-1");
  assert.equal(retirement.status, "SUBMITTED");
  assert.equal(retirement.total_tasks, 10);
  assert.equal(retirement.completed_tasks, 0);
  assert.equal(offer.status, "SUBMITTED");
  assert.equal(offer.annual_salary, 42000000);
  assert.equal(offer.probation_months, 3);
  assert.equal(offer.employee_id, "");
  assert.equal(settlement.status, "DRAFT");
  assert.equal(settlement.net_settlement, 0);
  assert.equal(settlement.access_revoked, 0);
});

test("workforce plans preserve period versions and one organization line per plan", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  const insertPlan = db.prepare(`INSERT INTO hr_workforce_plans
    (id, period, version, title, assumptions, status, revision_reason, created_by, submitted_at,
      approved_by, approved_at, created_at, updated_at)
    VALUES (?, '2026-H2', 1, '하반기 계획', '매출 목표와 생산성 기준', 'DRAFT', '', 'gc.kim', NULL, '', NULL, ?, ?)`);
  insertPlan.run("workforce-1", now, now);
  assert.throws(() => insertPlan.run("workforce-duplicate", now, now), /UNIQUE constraint failed/);
  const insertLine = db.prepare(`INSERT INTO hr_workforce_plan_lines
    (id, plan_id, organization_id, approved_headcount, planned_exits, note, created_at, updated_at)
    VALUES (?, 'workforce-1', 'org-ai-business', 12, 1, '사업계획 기준', ?, ?)`);
  insertLine.run("workforce-line-1", now, now);
  assert.throws(() => insertLine.run("workforce-line-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare("UPDATE hr_workforce_plans SET status = 'SUBMITTED', submitted_at = ? WHERE id = 'workforce-1'").run(now);
  assert.equal(db.prepare("SELECT status FROM hr_workforce_plans WHERE id = 'workforce-1'").get().status, "SUBMITTED");
});

test("recruitment requisitions preserve approved-plan lineage and applicant linkage", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_recruitment_requisitions
    (id, workforce_plan_id, workforce_plan_line_id, organization_id, title, role, requested_headcount,
      owner_employee_id, target_start_date, reason, status, requested_by, approved_by, approved_at,
      closed_by, closed_at, close_reason, created_at, updated_at)
    VALUES ('req-1', 'plan-1', 'line-1', 'org-ai-business', 'AI 연구원 충원', '연구개발', 2,
      'gc.kim', '2026-10-01', '승인 정원 부족 충원', 'OPEN', 'gc.kim', 'ceo', ?, '', NULL, '', ?, ?)`)
    .run(now, now, now);
  db.prepare(`INSERT INTO hr_applicants
    (id, name, role, applied, owner_id, stage, experience, email, phone, source, summary,
      resume_file_name, resume_text, checklist_json, screening_memos_json, interview_json,
      interview_memos_json, requisition_id, updated_at)
    VALUES ('applicant-linked', '홍길동', '연구개발', '2026.08.14', 'gc.kim', '서류 검토', '',
      'hong@example.com', '', '직접 등록', '', '', '', '[]', '[]', NULL, '[]', 'req-1', ?)`)
    .run(now);
  const linked = db.prepare(`SELECT r.status, r.requested_headcount, a.requisition_id
    FROM hr_recruitment_requisitions r JOIN hr_applicants a ON a.requisition_id = r.id WHERE r.id = 'req-1'`).get();
  assert.deepEqual({ ...linked }, { status: "OPEN", requested_headcount: 2, requisition_id: "req-1" });
  const indexes = db.prepare("PRAGMA index_list(hr_applicants)").all();
  assert.ok(indexes.some((row) => row.name === "idx_hr_applicants_requisition"));
});

test("performance ledgers preserve cycle participants and one review per stage", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insertCycle = db.prepare(`INSERT INTO hr_performance_cycles
    (id, name, period, description, status, goal_due_date, self_due_date, manager_due_date,
      calibration_due_date, created_by, opened_at, finalized_by, finalized_at, created_at, updated_at)
    VALUES (?, '하반기 평가', '2026-H2', '', 'GOAL_SETTING', '2026-09-15', '2026-12-10',
      '2026-12-20', '2026-12-27', 'gc.kim', ?, '', NULL, ?, ?)`);
  insertCycle.run("cycle-1", now, now, now);
  assert.throws(() => insertCycle.run("cycle-duplicate", now, now, now), /UNIQUE constraint failed/);
  const insertParticipant = db.prepare(`INSERT INTO hr_performance_participants
    (id, cycle_id, employee_id, organization_id, manager_employee_id, status, final_score,
      final_rating, calibration_note, finalized_by, finalized_at, created_at, updated_at)
    VALUES (?, 'cycle-1', 'employee-1', 'org-1', 'manager-1', 'GOALS_SUBMITTED', NULL, '', '', '', NULL, ?, ?)`);
  insertParticipant.run("participant-1", now, now);
  assert.throws(() => insertParticipant.run("participant-duplicate", now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO hr_performance_goals
    (id, participant_id, title, description, weight, metric_type, target_value, actual_value, unit,
      evidence, employee_comment, manager_comment, status, created_by, created_at, updated_at)
    VALUES ('goal-1', 'participant-1', '매출 목표', '목표 설명', 100, 'NUMBER', 100, NULL, '건', '', '', '', 'LOCKED', 'employee-1', ?, ?)`).run(now, now);
  const insertReview = db.prepare(`INSERT INTO hr_performance_reviews
    (id, participant_id, reviewer_type, reviewer_employee_id, score, rating, strengths, improvements,
      comment, status, submitted_at, created_at, updated_at)
    VALUES (?, 'participant-1', 'SELF', 'employee-1', 80, 'B', '강점 기록', '개선 기록', '종합 의견', 'SUBMITTED', ?, ?, ?)`);
  insertReview.run("review-self", now, now, now);
  assert.throws(() => insertReview.run("review-self-duplicate", now, now, now), /UNIQUE constraint failed/);
  const participantIndexes = db.prepare("PRAGMA index_list(hr_performance_participants)").all();
  const reviewIndexes = db.prepare("PRAGMA index_list(hr_performance_reviews)").all();
  assert.ok(participantIndexes.some((row) => row.name === "idx_hr_performance_participant_cycle_employee" && row.unique === 1));
  assert.ok(reviewIndexes.some((row) => row.name === "idx_hr_performance_review_participant_type" && row.unique === 1));
});

test("training ledgers preserve one employee assignment per course", async () => {
  const db = await migratedDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO hr_training_courses
    (id, title, course_type, year, description, provider, delivery_mode, start_date, due_date,
      duration_minutes, audience_type, organization_id, status, created_by, created_at, updated_at)
    VALUES (?, ?, 'MANDATORY', 2026, '', '교육기관', 'ONLINE', '2026-08-14', '2026-08-31', 60, 'ALL', '', 'OPEN', 'admin', ?, ?)`)
    .run("course-1", "개인정보보호 교육", now, now);
  const insert = db.prepare(`INSERT INTO hr_training_assignments
    (id, course_id, employee_id, employee_name, department, status, progress, completed_minutes, created_at, updated_at)
    VALUES (?, 'course-1', 'employee-1', '홍길동', '경영지원팀', 'ASSIGNED', 0, 0, ?, ?)`);
  insert.run("assignment-1", now, now);
  assert.throws(() => insert.run("assignment-2", now, now), /UNIQUE constraint failed/);
  db.close();
});

test("HR analytics reports preserve immutable period versions", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insert = db.prepare(`INSERT INTO hr_analytics_reports
    (id, report_type, title, period_start, period_end, version, snapshot_json, generated_by, created_at)
    VALUES (?, 'HR_OVERVIEW', '2026년 HR 리포트', '2026-01-01', '2026-08-14', 1, '{}', 'gc.kim', ?)`);
  insert.run("report-1", now);
  assert.throws(() => insert.run("report-duplicate", now), /UNIQUE constraint failed/);
  const indexes = db.prepare("PRAGMA index_list(hr_analytics_reports)").all();
  assert.ok(indexes.some((row) => row.name === "idx_hr_analytics_report_period_version" && row.unique === 1));
  db.close();
});

test("HR audio transcription ledger preserves attempts and locks each human review", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  const insert = db.prepare(`INSERT INTO hr_audio_transcriptions
    (id, entity_type, entity_id, audio_key_snapshot, audio_content_type, status, model, language,
      transcript, vtt, word_count, error_code, error_message, attempt, consent_confirmed_by, consent_confirmed_at,
      requested_by, requested_at, completed_at, reviewed_text, review_note, reviewed_by, reviewed_at, created_at, updated_at)
    VALUES (?, 'EMPLOYEE_INTERVIEW', 'employee-interview-1', 'hr-interviews/employee-1/audio.webm', 'audio/webm', ?,
      '@cf/openai/whisper-large-v3-turbo', 'ko', ?, '', 4, '', '', ?, 'gc.kim', ?, 'gc.kim', ?, ?, '', '', '', NULL, ?, ?)`);
  insert.run("transcription-1", "FAILED", "", 1, now, now, now, now, now);
  assert.throws(() => insert.run("transcription-duplicate", "FAILED", "", 1, now, now, now, now, now), /UNIQUE constraint failed/);
  insert.run("transcription-2", "COMPLETED", "테스트 면담 전사", 2, now, now, now, now, now);
  const firstReview = db.prepare(`UPDATE hr_audio_transcriptions SET reviewed_text = '검토된 면담 전사', review_note = '고유명사 확인',
    reviewed_by = 'gc.kim', reviewed_at = ?, updated_at = ? WHERE id = 'transcription-2' AND status = 'COMPLETED' AND reviewed_at IS NULL`).run(now, now);
  const secondReview = db.prepare(`UPDATE hr_audio_transcriptions SET reviewed_text = '다시 덮어쓰기', reviewed_by = 'gc.kim', reviewed_at = ?, updated_at = ?
    WHERE id = 'transcription-2' AND status = 'COMPLETED' AND reviewed_at IS NULL`).run(now + 1, now + 1);
  assert.equal(firstReview.changes, 1);
  assert.equal(secondReview.changes, 0);
  assert.equal(db.prepare("SELECT attempt, transcript, reviewed_text FROM hr_audio_transcriptions WHERE id = 'transcription-2'").get().reviewed_text, "검토된 면담 전사");
  db.close();
});

test("HR compensation runs preserve one monthly draft and employee snapshots", async () => {
  const db = await migratedDatabase(); const now = Date.now();
  db.prepare(`INSERT INTO hr_compensation_runs
    (period,status,version,employee_count,gross_pay,created_by,created_at,updated_at)
    VALUES ('2026-09','DRAFT',1,1,3100000,'gc.kim',?,?)`).run(now, now);
  assert.throws(() => db.prepare(`INSERT INTO hr_compensation_runs
    (period,status,version,employee_count,gross_pay,created_by,created_at,updated_at)
    VALUES ('2026-09','DRAFT',1,0,0,'gc.kim',?,?)`).run(now, now), /UNIQUE constraint failed/);
  db.prepare(`INSERT INTO hr_compensation_lines(period,employee_id,snapshot_json,gross_pay,updated_at)
    VALUES ('2026-09','employee-1','{"name":"김직원","basePay":3100000}',3100000,?)`).run(now);
  assert.throws(() => db.prepare(`INSERT INTO hr_compensation_lines(period,employee_id,snapshot_json,gross_pay,updated_at)
    VALUES ('2026-09','employee-1','{}',0,?)`).run(now), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT gross_pay FROM hr_compensation_lines WHERE period='2026-09' AND employee_id='employee-1'").get().gross_pay, 3100000);
  db.close();
});
