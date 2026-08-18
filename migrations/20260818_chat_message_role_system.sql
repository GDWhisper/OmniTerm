-- 权限请求超时回收告知：reaper 在 cancel+kill 前向会话写入 role='system' 的消息，
-- 让用户知道 agent 被系统自动回收的原因（见 docs/dev/plans/2026-08-18-permission-recycle-notice.md）。
-- SQLite 不支持修改 CHECK 约束，按「建新表 + 拷贝 + 换名」重建；列/外键/索引逐字保留原 DDL
-- （20260719_chat_messages + 20260722_blocks + 20260730_status/last_seq），仅 CHECK 加 'system'。
CREATE TABLE chat_messages_new (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    blocks TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    last_seq INTEGER
);

INSERT INTO chat_messages_new (id, session_id, role, text, created_at, blocks, status, last_seq)
    SELECT id, session_id, role, text, created_at, blocks, status, last_seq FROM chat_messages;

DROP TABLE chat_messages;

ALTER TABLE chat_messages_new RENAME TO chat_messages;

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
