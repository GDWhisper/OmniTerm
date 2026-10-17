-- turn 结束时刻（见 docs/dev/plans/archive/2026-08-30-acp-work-time.md 勘误 E25）
-- 口径：turn 定稿那一刻的墙钟时刻（RFC3339，UTC），由 turn 累积器在 finalize_turn
-- 时生成，随 prompt_done 下发并落 chat_messages.finished_at。
--
-- 可空：NULL = 迁移前的历史行（无结束时刻记录，不可追溯），前端对 NULL 的该段
-- 不渲染（不回退「已工作」——用户 2026-10-16 拍板历史数据不兜底）。
-- 底部读数的主段由此列驱动：「结束于 14:32」（今天）/ 跨天带日期。
ALTER TABLE chat_messages ADD COLUMN finished_at TEXT;
