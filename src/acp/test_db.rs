//! 跨模块共享的测试用内存库 fixture（`#[cfg(test)]`，无平台门控）。
//!
//! 抽出理由：usage 快照单测与 fake agent 链路测试都需要「迁移 + projects →
//! sessions 最小 FK 前置行」的同构内存库，复制两份必然漂移（工程准则 6）。
//! 各测试模块在此之上按需追加自己的预置数据，勿各自再建一份。

use sqlx::SqlitePool;
use sqlx::sqlite::SqlitePoolOptions;

/// 内存库 + 全量迁移 + 最小前置行：projects `p1`、sessions `s1` / `s2`。
///
/// - `max_connections(1)`：内存库单连接，避免并发连接看到不同实例。
/// - `runtime_kind` 走默认值（tmux）；`agent_id` 留空——本 fixture 只满足
///   projects → sessions 的 FK 链，需要 agents 行的模块自行追加。
pub(crate) async fn test_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("memory pool");
    sqlx::migrate!("./migrations").run(&pool).await.expect("migrations");
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', '/tmp', ?)")
        .bind(&now)
        .execute(&pool)
        .await
        .expect("project row");
    for sid in ["s1", "s2"] {
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, created_at) \
             VALUES (?, 'p1', '/tmp', ?)",
        )
        .bind(sid)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("session row");
    }
    pool
}
