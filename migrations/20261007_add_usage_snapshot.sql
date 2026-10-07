-- 会话上下文用量快照（usage_update 通知的最后已知值，见 docs/reference/acp-protocol-reference.md §18.3）。
-- 用途：刷新页面 / 换设备后 hydrate（GET /messages）恢复用量徽章——该通知不随
-- session/load 重放、广播无补发，纯内存状态在页面生命周期结束后即丢失。
-- 实时值仍由 WS 通知驱动覆盖，本列只是「最后已知」。
--
-- 可空：NULL = 从未收到过 usage（agent 未下发）或快照超限被跳过。列随 sessions
-- 行删除自然清理，无需挂钩。
ALTER TABLE sessions ADD COLUMN usage_json TEXT;
