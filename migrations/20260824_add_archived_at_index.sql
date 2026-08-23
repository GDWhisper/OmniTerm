-- 归档会话索引：archive/unarchive/list_archived 均按 archived_at 过滤，
-- 加上索引后避免全表扫描。
CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions(archived_at);
