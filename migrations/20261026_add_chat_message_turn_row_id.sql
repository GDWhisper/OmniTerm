-- mid-turn 告知（权限超时自动放行等）归属到其发生时所在的 turn 行（见
-- docs/dev/plans/2026-10-26-perm-notice-turn-attribution.md）。
--
-- 口径：值 = 该告知发生时 assistant 行的 id（`chat_messages.id`）；NULL = 无归属
-- （非 mid-turn 告知：turn 失败 / 后台任务 / 回收终态）或迁移前的历史行。前端按
-- 此列把独立 system 行归块进对应 turn 的过程容器；历史行另按「label 前缀 +
-- created_at ∈ [turn.created_at, turn.finished_at]」启发式归块，不回填本列。
--
-- 不建索引：唯一查询形态是「会话消息载入后在内存里按行 id 分组」，不走 SQL 过滤。
ALTER TABLE chat_messages ADD COLUMN turn_row_id TEXT;
