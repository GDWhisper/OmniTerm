use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn insert_message(
    db: &SqlitePool,
    session_id: &str,
    role: &str,
    text: &str,
) -> Result<(), sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO chat_messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(session_id)
        .bind(role)
        .bind(text)
        .bind(&now)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn list_messages(
    db: &SqlitePool,
    session_id: &str,
) -> Result<Vec<(String, String, String, String)>, sqlx::Error> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT role, text, created_at, id FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}
