//! Project ordering (`position` column) — migration contract.
//!
//! DB-only tests (no tmux, no HTTP), mirroring `runtime_kind_migration.rs`.
//! The backfill is the risky part of the migration: an existing install's
//! display order must not change when `position` is introduced. To exercise
//! it against real legacy-shaped data we migrate a fresh pool, drop the new
//! column again (SQLite `DROP COLUMN`), seed rows in the pre-`position`
//! shape, then execute the actual migration file (compile-time included, so
//! this can never drift into a copy of the SQL).

use sqlx::sqlite::SqlitePoolOptions;

/// The real migration under test — `include_str!` keeps the test honest:
/// editing the migration recompiles this file against the new SQL.
const POSITION_MIGRATION_SQL: &str =
    include_str!("../migrations/20261011_add_project_position.sql");

async fn migrated_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory sqlite");
    sqlx::migrate!("./migrations").run(&pool).await.expect("run migrations");
    pool
}

/// Seed a project the way legacy code did: no `position` column involved.
async fn seed_legacy(pool: &sqlx::SqlitePool, id: &str, created_at: &str) {
    sqlx::query("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(id)
        .bind(format!("/tmp/{id}"))
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
}

async fn ordered_ids(pool: &sqlx::SqlitePool) -> Vec<(String, i64)> {
    sqlx::query_as("SELECT id, position FROM projects ORDER BY position ASC, created_at DESC")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn backfill_preserves_display_order_and_breaks_ties_by_rowid() {
    let pool = migrated_pool().await;
    // Back to the pre-migration schema, then seed like an old install would have.
    sqlx::query("ALTER TABLE projects DROP COLUMN position")
        .execute(&pool)
        .await
        .expect("drop position column (legacy shape)");
    seed_legacy(&pool, "old", "2026-01-01T00:00:00Z").await;
    seed_legacy(&pool, "new", "2026-03-01T00:00:00Z").await;
    // Same created_at (second granularity — bulk creates collide): insertion
    // order must decide, deterministically.
    seed_legacy(&pool, "tie_a", "2026-02-01T00:00:00Z").await;
    seed_legacy(&pool, "tie_b", "2026-02-01T00:00:00Z").await;

    sqlx::raw_sql(POSITION_MIGRATION_SQL)
        .execute(&pool)
        .await
        .expect("apply position migration over legacy rows");

    assert_eq!(
        ordered_ids(&pool).await,
        vec![
            ("new".to_string(), 0),
            ("tie_a".to_string(), 1),
            ("tie_b".to_string(), 2),
            ("old".to_string(), 3),
        ],
        "backfill must reproduce the old `created_at DESC` order (newest first) \
         with a deterministic tiebreak"
    );
}

#[tokio::test]
async fn legacy_inserts_after_migration_default_to_zero() {
    let pool = migrated_pool().await;

    // Any INSERT that omits `position` (older call sites) stays valid.
    seed_legacy(&pool, "p", "2026-10-11T00:00:00Z").await;

    let position: i64 = sqlx::query_scalar("SELECT position FROM projects WHERE id = 'p'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(position, 0);
}
