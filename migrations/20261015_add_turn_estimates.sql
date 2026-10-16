-- ACP 会话的速率与工具耗时读数（见 docs/dev/plans/archive/2026-08-30-acp-work-time.md E23）
-- 口径：由后端 turn 累积器在定稿时结算（与 duration_ms 同一跃迁、同一条 UPDATE）：
--   tps    = 观测输出字符 ÷ 4 ÷ 流式活跃时长（白名单：只认连续流式窗口），单位 tokens/s
--   tool_ms = 可归因于工具执行的时长（执行并集扣生成窗口），ms
--
-- 两列均可空：NULL 表示「不可追溯 / 估算失效」（迁移前的历史行、工具跟踪越界、
-- 无可测流式窗口），与 0（有效观测下确实没记到）语义不同，前端对 NULL 不渲染。
-- 读数随 turn 定稿落库后，刷新/换设备仍从 GET /messages 常驻显示。
ALTER TABLE chat_messages ADD COLUMN tool_ms INTEGER;
ALTER TABLE chat_messages ADD COLUMN tps REAL;
