-- Add runtime_kind + acp_session_id to sessions table.
-- Enables ACP runtime coexistence with tmux; existing rows default to 'tmux'.
ALTER TABLE sessions ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE sessions ADD COLUMN acp_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_runtime_kind ON sessions(runtime_kind);
