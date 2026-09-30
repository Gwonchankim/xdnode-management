// 총무 알림 실행(general-affairs Design §4·§5, GD-7~GD-9). 하루(KST) 한 번, 메신저 '총무 알림' 채널에 요약 글을 남긴다.
// 멱등: ga_alert_runs(run_date PK)를 같은 batch 첫 문장으로 넣는다. 같은 날 두 번째 실행(동시 실행 포함)은 UNIQUE 로 실패하고 posted:false 다.
// 채널 멤버는 실행 때마다 '총무 보기 이상 활성 계정'으로 맞춘다(GA-D3). 글 작성자는 계정이 아닌 예약 id(system:ga)다(GD-8).
import { resolveTabs } from "./access-tabs";
import { currentMemberIds, eventStatement as chatEvent, joinStatements } from "./chat-server";
import { alertMessage, collectAlerts, kstToday, newlyEntered } from "./ga-alerts";
import { alertInputs } from "./ga-server";

export const GA_ALERT_CHANNEL_ID = "ch_ga_alerts";
export const GA_ALERT_AUTHOR = "system:ga";
const CHANNEL_NAME = "총무 알림";

export type AlertRunResult = { runDate: string; posted: boolean; itemCount: number; alreadyRan: boolean; members: number };

async function eligibleAccountIds(db: D1Database) {
  const rows = await db.prepare(`SELECT id, is_admin, tabs_json FROM auth_accounts WHERE active = 1`).all<{ id: string; is_admin: number; tabs_json: string }>();
  return rows.results.filter((row) => resolveTabs(row.tabs_json, row.is_admin === 1).general !== "none").map((row) => row.id);
}

/** 채널이 없으면 만든다. 사람이 같은 이름의 채널을 먼저 만들었으면 '(자동)'을 붙인다(이름 부분 UNIQUE). */
async function channelStatements(db: D1Database, now: number) {
  const existing = await db.prepare(`SELECT id, archived_at FROM chat_channels WHERE id = ?`).bind(GA_ALERT_CHANNEL_ID).first<{ id: string; archived_at: number | null }>();
  if (existing) return [];
  const taken = await db.prepare(`SELECT 1 FROM chat_channels WHERE name = ? AND kind IN ('public','private') AND archived_at IS NULL`).bind(CHANNEL_NAME).first();
  return [db.prepare(`INSERT INTO chat_channels (id, kind, name, topic, dm_key, created_by, created_at, updated_at, archived_at)
    VALUES (?, 'private', ?, '만료·반납 예정 자동 알림(총무 탭 권한자)', NULL, ?, ?, ?, NULL)`)
    .bind(GA_ALERT_CHANNEL_ID, taken ? `${CHANNEL_NAME}(자동)` : CHANNEL_NAME, GA_ALERT_AUTHOR, now, now)];
}

export async function runGaAlerts(db: D1Database, { trigger, now = Date.now() }: { trigger: string; now?: number }): Promise<AlertRunResult> {
  const runDate = kstToday(now);
  const already = await db.prepare(`SELECT 1 FROM ga_alert_runs WHERE run_date = ?`).bind(runDate).first();
  if (already) return { runDate, posted: false, itemCount: 0, alreadyRan: true, members: 0 };

  const inputs = await alertInputs(db);
  const items = collectAlerts({ ...inputs, today: runDate });
  const marks = new Map((await db.prepare(`SELECT item_key, bucket, due_on FROM ga_alert_marks`).all<{ item_key: string; bucket: string; due_on: string | null }>())
    .results.map((row) => [row.item_key, { bucket: row.bucket, dueOn: row.due_on }]));
  const fresh = newlyEntered(items, marks);

  const eligible = new Set(await eligibleAccountIds(db));
  const archived = (await db.prepare(`SELECT archived_at FROM chat_channels WHERE id = ?`).bind(GA_ALERT_CHANNEL_ID).first<{ archived_at: number | null }>())?.archived_at ?? null;
  const members = new Set(await currentMemberIds(db, GA_ALERT_CHANNEL_ID));
  const clientKey = `${GA_ALERT_AUTHOR}:${runDate}`;
  const post = fresh.length > 0 && archived === null;

  const statements: D1PreparedStatement[] = [
    // 첫 문장: 오늘 실행 표지. 이미 있으면 batch 전체가 롤백된다(동시 실행 방어).
    db.prepare(`INSERT INTO ga_alert_runs (run_date, trigger, item_count, message_id, created_at) VALUES (?, ?, ?, NULL, ?)`)
      .bind(runDate, trigger.slice(0, 20), fresh.length, now),
    ...(await channelStatements(db, now)),
    ...[...eligible].filter((id) => !members.has(id)).flatMap((id) => joinStatements(db, GA_ALERT_CHANNEL_ID, id, "member", now)),
    ...[...members].filter((id) => !eligible.has(id)).flatMap((id) => [
      db.prepare(`UPDATE chat_members SET left_at = ? WHERE channel_id = ? AND account_id = ? AND left_at IS NULL`).bind(now, GA_ALERT_CHANNEL_ID, id),
      chatEvent(db, { channelId: GA_ALERT_CHANNEL_ID, kind: "member.left", subject: id, now }),
    ]),
  ];
  if (post) {
    statements.push(
      db.prepare(`INSERT INTO chat_messages (client_key, channel_id, thread_root_id, author_account_id, body, mention_channel, reply_count, last_reply_at, created_at)
        VALUES (?, ?, NULL, ?, ?, 0, 0, NULL, ?)`).bind(clientKey, GA_ALERT_CHANNEL_ID, GA_ALERT_AUTHOR, alertMessage(fresh, runDate), now),
      db.prepare(`INSERT INTO chat_events (channel_id, kind, message_id, subject_account_id, created_at)
        SELECT ?, 'message.created', id, NULL, ? FROM chat_messages WHERE client_key = ?`).bind(GA_ALERT_CHANNEL_ID, now, clientKey),
      db.prepare(`UPDATE ga_alert_runs SET message_id = (SELECT id FROM chat_messages WHERE client_key = ?) WHERE run_date = ?`).bind(clientKey, runDate),
    );
  }
  // 지금 보이는 항목의 구간을 모두 기록한다(내일은 이보다 급해진 것만 알린다).
  for (const item of items) {
    statements.push(db.prepare(`INSERT INTO ga_alert_marks (item_key, bucket, due_on, run_date) VALUES (?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET bucket = excluded.bucket, due_on = excluded.due_on, run_date = excluded.run_date`).bind(item.key, item.bucket, item.dueOn, runDate));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && await db.prepare(`SELECT 1 FROM ga_alert_runs WHERE run_date = ?`).bind(runDate).first()) {
      return { runDate, posted: false, itemCount: 0, alreadyRan: true, members: 0 };
    }
    throw error;
  }
  return { runDate, posted: post, itemCount: fresh.length, alreadyRan: false, members: eligible.size };
}
