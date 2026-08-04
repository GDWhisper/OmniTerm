-- ACP 会话底部配置（mode/model/thinking/config 选择器）持久化记忆。
-- 两层模型：
--   * session_config_options     — 会话级覆盖：单个会话内用户改过的配置，restore 该会话时优先恢复
--   * agent_config_preferences   — agent 级全局偏好：用户为该 agent 设过的配置，新建/恢复会话时作为默认值
-- 本项目 SQLite 未启用 foreign_keys（main.rs SqlitePoolOptions 未显式开启），
-- 删除清理走显式手动删除（delete_session / delete_project / delete_agent），
-- 与 chat_messages 的清理模式一致。REFERENCES 子句仅作声明性文档。
CREATE TABLE session_config_options (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    config_id   TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, config_id)
);

CREATE TABLE agent_config_preferences (
    agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    config_id  TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, config_id)
);

-- 复合 PK 的 session_id / agent_id 前缀已可支撑 WHERE 查询，无需额外索引。
