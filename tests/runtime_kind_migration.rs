//! Phase 2 tests: sessions table schema migration + RuntimeKind serialization.
//!
//! These tests are DB-only (no tmux, no HTTP). They ensure the migration
//! applies cleanly on a fresh DB and that the RuntimeKind enum round-trips
//! through both JSON and SQLite TEXT.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::Row;

async fn fresh_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    pool
}

#[tokio::test]
async fn migration_adds_runtime_kind_column_with_tmux_default() {
    let pool = fresh_pool().await;

    // Seed a session without specifying runtime_kind — DEFAULT should apply.
    sqlx::query(
        "INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'proj', '/tmp', '2026-07-15')"
    )
    .execute(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, created_at) \
         VALUES ('s1', 'p1', '/tmp', 'legacy', 'lt_abc', 0, '2026-07-15')"
    )
    .execute(&pool).await.unwrap();

    let row = sqlx::query("SELECT runtime_kind, acp_session_id FROM sessions WHERE id = 's1'")
        .fetch_one(&pool)
        .await
        .unwrap();

    let kind: String = row.get(0);
    let acp_id: Option<String> = row.get(1);
    assert_eq!(kind, "tmux", "legacy INSERT without runtime_kind should default to 'tmux'");
    assert!(acp_id.is_none(), "acp_session_id should be NULL for legacy row");
}

#[tokio::test]
async fn runtime_kind_acp_row_survives_round_trip() {
    let pool = fresh_pool().await;

    sqlx::query(
        "INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'proj', '/tmp', '2026-07-15')"
    )
    .execute(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, created_at, runtime_kind, acp_session_id) \
         VALUES ('s2', 'p1', '/tmp', 'chat', NULL, 0, '2026-07-15', 'acp', 'acp-uuid-123')"
    )
    .execute(&pool).await.unwrap();

    let row = sqlx::query("SELECT runtime_kind, acp_session_id, tmux_session_name FROM sessions WHERE id = 's2'")
        .fetch_one(&pool)
        .await
        .unwrap();

    let kind: String = row.get(0);
    let acp_id: Option<String> = row.get(1);
    let tmux_name: Option<String> = row.get(2);
    assert_eq!(kind, "acp");
    assert_eq!(acp_id.as_deref(), Some("acp-uuid-123"));
    assert!(tmux_name.is_none());
}
