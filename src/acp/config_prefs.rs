use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOptions,
};
use sqlx::SqlitePool;

/// 配置偏好持久化的 DB 句柄。由 `AcpClient::attach_config_prefs` 绑定，
/// 仅在实际会话注册点（create-session / load restore）设置；能力探针不绑定 →
/// 写入与恢复均为 no-op。
#[derive(Clone)]
pub struct ConfigPrefsHandle {
    pub db: SqlitePool,
    pub db_session_id: String,
    pub agent_id: String,
}

/// 会话级：记录单个会话内用户主动 set 过的配置（restore 时优先覆盖 agent 级）。
pub async fn save_session_config(
    db: &SqlitePool,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO session_config_options (session_id, config_id, value, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(session_id, config_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(session_id)
    .bind(config_id)
    .bind(value)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// agent 级：记录用户为该 agent 设过的配置（新建/恢复会话的默认值）。
pub async fn save_agent_pref(
    db: &SqlitePool,
    agent_id: &str,
    config_id: &str,
    value: &str,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_config_preferences (agent_id, config_id, value, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(agent_id, config_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(agent_id)
    .bind(config_id)
    .bind(value)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn list_session_configs(
    db: &SqlitePool,
    session_id: &str,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT config_id, value FROM session_config_options WHERE session_id = ?")
            .bind(session_id)
            .fetch_all(db)
            .await?;
    Ok(rows)
}

pub async fn list_agent_prefs(
    db: &SqlitePool,
    agent_id: &str,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT config_id, value FROM agent_config_preferences WHERE agent_id = ?")
            .bind(agent_id)
            .fetch_all(db)
            .await?;
    Ok(rows)
}

/// 删除会话时清理其会话级配置行（本项目未开 foreign_keys，手动清理，
/// 与 chat_messages 的删除模式一致）。
pub async fn clear_session_configs(db: &SqlitePool, session_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM session_config_options WHERE session_id = ?")
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

/// 删除 agent 时清理其全局偏好行。
pub async fn clear_agent_prefs(db: &SqlitePool, agent_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM agent_config_preferences WHERE agent_id = ?")
        .bind(agent_id)
        .execute(db)
        .await?;
    Ok(())
}

/// 校验恢复值是否合法（§8 多实现兼容：以 agent 当前下发的配置集合为准）：
/// - Boolean：值必须为 `"true"` / `"false"`。
/// - Select：扁平化 `Ungrouped` / `Grouped` 两种形态匹配 `value`；
///   options 为空（agent 未提供选项列表）时**放行**——不能因信息缺失阻断恢复。
///
/// 返回 `false` 的项在 restore 时跳过，不发给 agent。
pub fn validate_config_value(opt: &SessionConfigOption, value: &str) -> bool {
    match &opt.kind {
        SessionConfigKind::Boolean(_) => value == "true" || value == "false",
        SessionConfigKind::Select(sel) => match &sel.options {
            SessionConfigSelectOptions::Ungrouped(opts) => {
                if opts.is_empty() {
                    return true;
                }
                opts.iter().any(|o| o.value.0.as_ref() == value)
            }
            SessionConfigSelectOptions::Grouped(groups) => {
                let mut any = false;
                for g in groups {
                    for o in &g.options {
                        any = true;
                        if o.value.0.as_ref() == value {
                            return true;
                        }
                    }
                }
                // 所有 group 的 options 均为空 → 放行。
                !any
            }
            // §8：未知 options 形态（协议扩展）不恢复该值。
            _ => false,
        },
        // §8：未知配置 kind（协议扩展）不恢复该值。
        _ => false,
    }
}

/// 合并 agent 级偏好与会话级覆盖为恢复项列表。会话级同名 `config_id`
/// 覆盖 agent 级；其余项保留。返回顺序：agent 项在前、session 独有项追加在后。
pub fn merge_prefs(
    agent: Vec<(String, String)>,
    session: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut out = agent;
    for (k, v) in session {
        if let Some(existing) = out.iter_mut().find(|(ek, _)| ek == &k) {
            existing.1 = v;
        } else {
            out.push((k, v));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption,
        SessionConfigSelectOptions,
    };
    use sqlx::sqlite::SqlitePoolOptions;

    fn select_option(
        opt_id: &str,
        name: &str,
        current: &str,
        values: &[&str],
    ) -> SessionConfigOption {
        SessionConfigOption::select(
            opt_id.to_string(),
            name.to_string(),
            current.to_string(),
            SessionConfigSelectOptions::Ungrouped(
                values
                    .iter()
                    .map(|v| SessionConfigSelectOption::new(v.to_string(), v.to_string()))
                    .collect(),
            ),
        )
    }

    fn grouped_option(
        opt_id: &str,
        name: &str,
        current: &str,
        groups: &[(&str, &[&str])],
    ) -> SessionConfigOption {
        SessionConfigOption::select(
            opt_id.to_string(),
            name.to_string(),
            current.to_string(),
            SessionConfigSelectOptions::Grouped(
                groups
                    .iter()
                    .map(|(g, values)| {
                        SessionConfigSelectGroup::new(
                            g.to_string(),
                            g.to_string(),
                            values
                                .iter()
                                .map(|v| {
                                    SessionConfigSelectOption::new(v.to_string(), v.to_string())
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            ),
        )
    }

    #[test]
    fn validate_boolean() {
        let opt = SessionConfigOption::boolean("thought_level", "Thinking", false);
        assert!(validate_config_value(&opt, "true"));
        assert!(validate_config_value(&opt, "false"));
        assert!(!validate_config_value(&opt, "yes"));
        assert!(!validate_config_value(&opt, ""));
        assert!(!validate_config_value(&opt, "1"));
    }

    #[test]
    fn validate_select_ungrouped() {
        let opt = select_option("model", "Model", "claude", &["claude", "gpt", "gemini"]);
        assert!(validate_config_value(&opt, "claude"));
        assert!(validate_config_value(&opt, "gemini"));
        assert!(!validate_config_value(&opt, "llama"));
        assert!(!validate_config_value(&opt, ""));
    }

    #[test]
    fn validate_select_grouped_flat() {
        let opt = grouped_option(
            "model",
            "Model",
            "claude",
            &[("Anthropic", &["claude", "opus"]), ("OpenAI", &["gpt"])],
        );
        assert!(validate_config_value(&opt, "claude"));
        assert!(validate_config_value(&opt, "opus"));
        assert!(validate_config_value(&opt, "gpt"));
        assert!(!validate_config_value(&opt, "llama"));
    }

    #[test]
    fn validate_empty_options_passes_through() {
        // options 为空 → 放行（§8 兜底：不因信息缺失阻断恢复）。
        let opt = SessionConfigOption::select(
            "model",
            "Model",
            "claude",
            SessionConfigSelectOptions::Ungrouped(Vec::new()),
        );
        assert!(validate_config_value(&opt, "anything"));

        let opt = SessionConfigOption::select(
            "model",
            "Model",
            "claude",
            SessionConfigSelectOptions::Grouped(Vec::new()),
        );
        assert!(validate_config_value(&opt, "anything"));
    }

    #[test]
    fn merge_session_overrides_agent() {
        let agent = vec![
            ("model".to_string(), "claude".to_string()),
            ("mode".to_string(), "plan".to_string()),
        ];
        let session = vec![
            ("model".to_string(), "gpt".to_string()),
            ("thought_level".to_string(), "high".to_string()),
        ];
        let merged = merge_prefs(agent, session);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0], ("model".to_string(), "gpt".to_string())); // 覆盖
        assert_eq!(merged[1], ("mode".to_string(), "plan".to_string())); // agent 独有保留
        assert!(merged.contains(&("thought_level".to_string(), "high".to_string()))); // session 独有追加
    }

    #[test]
    fn merge_prefs_order_independent() {
        let agent = vec![("a".to_string(), "1".to_string())];
        let session = vec![("a".to_string(), "2".to_string())];
        let merged = merge_prefs(agent, session);
        assert_eq!(merged, vec![("a".to_string(), "2".to_string())]);
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory pool");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrations");
        // SQLx 默认开启 foreign_keys（ON DELETE CASCADE 生效），预置父行满足 FK。
        // 顺序：agents → projects → sessions（sessions.agent_id 与 project_id 均为 FK）。
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES ('agent1', 'Test Agent', 'echo', '[]', '[]', ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("agent row");
        sqlx::query(
            "INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', '/tmp', ?)",
        )
        .bind(&now)
        .execute(&pool)
        .await
        .expect("project row");
        for sid in ["s1", "s2"] {
            sqlx::query(
                "INSERT INTO sessions (id, project_id, workspace_path, created_at, runtime_kind, agent_id) \
                 VALUES (?, 'p1', '/tmp', ?, 'acp', 'agent1')",
            )
            .bind(sid)
            .bind(&now)
            .execute(&pool)
            .await
            .expect("session row");
        }
        pool
    }

    #[tokio::test]
    async fn session_config_roundtrip_and_isolation() {
        let pool = test_pool().await;
        save_session_config(&pool, "s1", "model", "claude").await.unwrap();
        save_session_config(&pool, "s2", "model", "gpt").await.unwrap();

        assert_eq!(
            list_session_configs(&pool, "s1").await.unwrap(),
            vec![("model".to_string(), "claude".to_string())]
        );
        assert_eq!(
            list_session_configs(&pool, "s2").await.unwrap(),
            vec![("model".to_string(), "gpt".to_string())]
        );

        // 同 key 二次 save 覆盖（upsert），不产生重复行。
        save_session_config(&pool, "s1", "model", "opus").await.unwrap();
        let rows = list_session_configs(&pool, "s1").await.unwrap();
        assert_eq!(rows, vec![("model".to_string(), "opus".to_string())]);

        clear_session_configs(&pool, "s1").await.unwrap();
        assert!(list_session_configs(&pool, "s1").await.unwrap().is_empty());
        // 清空不影响其他会话。
        assert_eq!(list_session_configs(&pool, "s2").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn agent_prefs_roundtrip_and_clear() {
        let pool = test_pool().await;
        save_agent_pref(&pool, "agent1", "mode", "plan").await.unwrap();
        save_agent_pref(&pool, "agent1", "model", "claude").await.unwrap();

        let mut rows = list_agent_prefs(&pool, "agent1").await.unwrap();
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("mode".to_string(), "plan".to_string()),
                ("model".to_string(), "claude".to_string()),
            ]
        );

        clear_agent_prefs(&pool, "agent1").await.unwrap();
        assert!(list_agent_prefs(&pool, "agent1").await.unwrap().is_empty());
    }
}
