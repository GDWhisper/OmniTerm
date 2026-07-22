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

/// 整轮重建会话消息：删除旧记录后批量插入。用于「恢复会话」重放完成后，把前端
/// 重建出的完整历史落库，使刷新浏览器后仍能从 DB 还原（实时 prompt 的增量写入
/// 不在此路径，二者通过幂等重建避免重复）。
pub async fn sync_messages(
    db: &SqlitePool,
    session_id: &str,
    messages: &[(String, String)],
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM chat_messages WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    for (role, text) in messages {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO chat_messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(session_id)
            .bind(role)
            .bind(text)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

