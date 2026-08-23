-- 会话归档（仅 ACP 会话）：NULL = 未归档；非 NULL = 归档时间戳。
-- 归档会话不出现在默认会话列表（GET /projects/{pid}/sessions），
-- 经 GET /sessions/archived 单独列出；聊天记录（chat_messages）保留。
ALTER TABLE sessions ADD COLUMN archived_at TEXT;
