-- Phase 2 切片 C：pty 会话 cwd 回写列（D5 重建能力）。
-- tmux/acp 会话不使用（保持 NULL）。
ALTER TABLE sessions ADD COLUMN last_cwd TEXT;
