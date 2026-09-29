// 메신저 스키마(R5, Design §3.3). ensureErpPlatformSchema 가 audit → auth → ops 다음에 한 batch 로 실행한다.
// 라우트의 ensureSchema 에는 두지 않는다. 모든 문장은 멱등이고, 추가만 하며 DROP 은 하지 않는다(D4).
// FOREIGN KEY 는 선언하지 않는다. 채널·메시지는 지우지 않고 상태(archived_at, left_at, deleted_at)만 바꾼다.

const CHAT_DDL = [
  `CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('public','private','dm','group_dm')),
  name TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  dm_key TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_dm_key ON chat_channels(dm_key) WHERE dm_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_name ON chat_channels(name) WHERE kind IN ('public','private') AND archived_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS chat_members (
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER,
  PRIMARY KEY (channel_id, account_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_members_account ON chat_members(account_id, left_at)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  thread_root_id INTEGER,
  author_account_id TEXT NOT NULL,
  body TEXT NOT NULL,
  mention_channel INTEGER NOT NULL DEFAULT 0 CHECK (mention_channel IN (0,1)),
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, thread_root_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_root_id, id)`,
  // 이벤트 로그. seq 가 poll 커서다. 읽음 위치 PUT 은 여기에 쓰지 않는다(남의 읽음이 내 poll 증분이 되지 않게).
  `CREATE TABLE IF NOT EXISTS chat_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message.created','message.edited','message.deleted','channel.updated','channel.archived','member.joined','member.left')),
  message_id INTEGER,
  subject_account_id TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_events_channel_seq ON chat_events(channel_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_events_subject ON chat_events(subject_account_id, seq) WHERE subject_account_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS chat_mentions (
  message_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, account_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_mentions_account ON chat_mentions(account_id, message_id)`,
  `CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  message_id INTEGER,
  uploader_account_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_attachments_uploader ON chat_attachments(uploader_account_id, message_id)`,
];

/** 공개 채널 '일반'. 멤버는 없고 각자 참여하거나 첫 전송 때 자동 참여한다. */
export const GENERAL_CHANNEL_ID = "ch_general";

export function chatSchemaStatements(db: D1Database) {
  const now = Date.now();
  return [
    ...CHAT_DDL.map((sql) => db.prepare(sql)),
    db.prepare(`INSERT OR IGNORE INTO chat_channels (id, kind, name, topic, dm_key, created_by, created_at, updated_at, archived_at)
      VALUES (?, 'public', '일반', '', NULL, 'system', ?, ?, NULL)`).bind(GENERAL_CHANNEL_ID, now, now),
  ];
}
