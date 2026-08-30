-- ACP 会话工作时长计时（见 docs/dev/plans/2026-08-30-acp-work-time.md）
-- 口径：work_ms = turn 墙钟时长 - 等真人审批时长，由后端在 turn 定稿时增量写入。
--
-- chat_messages 上的时长为可空：迁移前的历史行没有结束时刻记录，NULL 表示「未知」，
-- 与 0（确实耗时 0）语义不同，前端对 NULL 不渲染。
ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER;
ALTER TABLE chat_messages ADD COLUMN wait_ms INTEGER;

-- sessions 上的累计用 NOT NULL DEFAULT 0：现有 INSERT 站点（创建会话、采纳外部会话、
-- 测试 seed）无需逐一改动，非 ACP 会话恒为 0。
ALTER TABLE sessions ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN wait_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;

-- 最近一次 turn 定稿时刻（RFC3339）；NULL = 从未有过 turn。
ALTER TABLE sessions ADD COLUMN last_turn_at TEXT;
