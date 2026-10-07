use agent_client_protocol::schema::v1::UsageUpdate;
use sqlx::SqlitePool;

/// usage 快照体积上限。正常 `used`/`size`/`cost` 结构 < 1KB；异常 agent 的
/// `_meta` 膨胀时跳过持久化（只影响 hydrate 恢复，活会话实时帧不受影响）。
/// 防无界写入（P1 红线）。
pub const MAX_USAGE_SNAPSHOT_BYTES: usize = 4 * 1024;

/// 持久化最后一次上下文用量（usage_update 通知，整体覆盖语义）。
///
/// 与配置快照（`config_prefs::persist_config_snapshot`）同模式但独立成模块：
/// 前者是用户配置、后者是运行时状态，生命周期与消费方各异。用途是刷新页面 /
/// 换设备后由 `GET /messages` hydrate 恢复用量徽章——该通知不随 session/load
/// 重放、广播无补发，纯内存状态在页面生命周期结束后即丢失。
///
/// 同值跳过（SQL 层比较，避免读回）：agent 可能在一个 turn 内多次重推相同用量，
/// 重复 UPDATE 无意义。失败仅 warn，不阻断实时帧透传。
pub async fn persist_usage_snapshot(db: &SqlitePool, session_id: &str, usage: &UsageUpdate) {
    let Ok(json) = serde_json::to_string(usage) else {
        tracing::warn!("serialize usage snapshot failed");
        return;
    };
    if json.len() > MAX_USAGE_SNAPSHOT_BYTES {
        tracing::warn!(size = json.len(), "usage snapshot exceeds cap; skipping persist");
        return;
    }
    if let Err(e) = sqlx::query(
        "UPDATE sessions SET usage_json = ?1 WHERE id = ?2 \
         AND (usage_json IS NULL OR usage_json <> ?1)",
    )
    .bind(&json)
    .bind(session_id)
    .execute(db)
    .await
    {
        tracing::warn!("save usage snapshot failed: {}", e);
    }
}

/// 读取快照，以原始 JSON Value 返回（前端按可选字段解析，无需类型 roundtrip）。
/// `None` = 未持久化过 / 解析失败，调用方按「无用例」处理（前端不渲染徽章）。
pub async fn load_usage_snapshot(db: &SqlitePool, session_id: &str) -> Option<serde_json::Value> {
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT usage_json FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()?;
    let json = row.0?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::test_db::test_pool;
    use agent_client_protocol::schema::v1::Cost;

    fn usage(used: u64, size: u64) -> UsageUpdate {
        UsageUpdate::new(used, size)
    }

    #[tokio::test]
    async fn usage_snapshot_roundtrip_overwrite_and_isolation() {
        let pool = test_pool().await;

        // 未写 → None（前端不渲染徽章）。
        assert_eq!(load_usage_snapshot(&pool, "s1").await, None);

        // 写入 → 读回与序列化形态一致。
        let u1 = usage(1000, 200_000);
        persist_usage_snapshot(&pool, "s1", &u1).await;
        assert_eq!(
            load_usage_snapshot(&pool, "s1").await,
            Some(serde_json::to_value(&u1).unwrap())
        );

        // 整体覆盖：新值落库。
        let u2 = usage(50_000, 200_000);
        persist_usage_snapshot(&pool, "s1", &u2).await;
        assert_eq!(
            load_usage_snapshot(&pool, "s1").await,
            Some(serde_json::to_value(&u2).unwrap())
        );

        // 会话隔离：s2 无快照。
        assert_eq!(load_usage_snapshot(&pool, "s2").await, None);
    }

    #[tokio::test]
    async fn usage_snapshot_same_value_skips_write() {
        let pool = test_pool().await;
        let u = usage(1000, 200_000);
        persist_usage_snapshot(&pool, "s1", &u).await;

        // 同值重推不再写库（WHERE 比较拦下 UPDATE）——total_changes 统计实际
        // 修改的行数，用前后差判定「未发生写」。
        let before: i64 =
            sqlx::query_scalar("SELECT total_changes()").fetch_one(&pool).await.unwrap();
        persist_usage_snapshot(&pool, "s1", &u).await;
        let after: i64 =
            sqlx::query_scalar("SELECT total_changes()").fetch_one(&pool).await.unwrap();
        assert_eq!(before, after, "同值重推不应产生写入");

        // 不同值仍照常写入。
        persist_usage_snapshot(&pool, "s1", &usage(1001, 200_000)).await;
        let changed: i64 =
            sqlx::query_scalar("SELECT total_changes()").fetch_one(&pool).await.unwrap();
        assert!(changed > after, "不同值应写入");
    }

    #[tokio::test]
    async fn usage_snapshot_skips_oversized_payload() {
        let pool = test_pool().await;
        // 异常 agent 的 _meta 膨胀：超限跳过持久化，不落库。
        let mut meta = serde_json::Map::new();
        meta.insert("blob".to_string(), serde_json::json!("x".repeat(MAX_USAGE_SNAPSHOT_BYTES)));
        let u = usage(1000, 200_000).meta(meta);
        persist_usage_snapshot(&pool, "s1", &u).await;
        assert_eq!(load_usage_snapshot(&pool, "s1").await, None);
    }

    #[tokio::test]
    async fn load_usage_snapshot_tolerates_dirty_json() {
        let pool = test_pool().await;
        sqlx::query("UPDATE sessions SET usage_json = ? WHERE id = 's1'")
            .bind("{not json")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(load_usage_snapshot(&pool, "s1").await, None);
    }

    /// cost 字段随快照往返（可选字段，agent 未提供时不应出现）。
    #[tokio::test]
    async fn usage_snapshot_keeps_optional_cost() {
        let pool = test_pool().await;
        let u = usage(1000, 200_000).cost(Cost::new(0.1234, "USD"));
        persist_usage_snapshot(&pool, "s1", &u).await;
        let loaded = load_usage_snapshot(&pool, "s1").await.expect("snapshot");
        assert_eq!(loaded["cost"]["amount"], 0.1234);
        assert_eq!(loaded["cost"]["currency"], "USD");

        // 无 cost 的快照（新值覆盖）不应带 cost 键。
        persist_usage_snapshot(&pool, "s1", &usage(1001, 200_000)).await;
        let loaded = load_usage_snapshot(&pool, "s1").await.expect("snapshot");
        assert!(loaded.get("cost").is_none());
    }
}
