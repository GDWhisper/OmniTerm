-- 会话配置选项快照（已结束会话的配置栏只读展示，见 docs/architecture/backend.md 配置节）
-- 内容：最后一次已知的完整 configOptions（ACP §12.5 全量状态语义，ConfigOptionUpdate
-- 通知 / set_config_option / load_session 响应到达即整体覆盖写入）。
--
-- 可空：NULL = 从未收到过配置（agent 未下发、能力探针会话、快照超限被跳过），
-- 前端对 NULL 不渲染配置栏（维持旧行为）。列随 sessions 行删除自然清理，无需挂钩。
ALTER TABLE sessions ADD COLUMN config_options_json TEXT;
