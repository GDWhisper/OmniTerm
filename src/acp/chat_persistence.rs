use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn insert_message(
    db: &SqlitePool,
    session_id: &str,
    role: &str,
    text: &str,
    blocks: Option<&str>,
) -> Result<(), sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(session_id)
        .bind(role)
        .bind(text)
        .bind(&now)
        .bind(blocks)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn list_messages(
    db: &SqlitePool,
    session_id: &str,
) -> Result<Vec<(String, String, String, String, Option<String>)>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT role, text, created_at, id, blocks FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// 恢复会话重放完成后，把前端重建出的消息落库，使刷新浏览器后仍可还原。
///
/// 设计要点（避免丢失已有数据）：
/// - **不删除**任何已有记录。此前整轮 `DELETE` 重建会误删实时 prompt 已落库的
///   user 消息——而 ACP `session/load` 重放流不含 user prompt，导致恢复后 user
///   历史永久丢失。
/// - 逐条**按内容去重**插入（同 session + role + text 已存在则跳过），避免多次
///   恢复会话 / 与实时 `insert_message` 产生重复。
/// - 实时 prompt 的 user/assistant 仍由 `insert_message` 负责；本函数只补充重放
///   得到的 assistant 历史。
pub async fn sync_messages(
    db: &SqlitePool,
    session_id: &str,
    messages: &[(String, String, Option<String>)],
) -> Result<(), sqlx::Error> {
    for (role, text, blocks) in messages {
        if text.is_empty() {
            continue;
        }
        // 去重：同会话同角色同文本已存在则跳过（重放历史可能已被实时写入或上一次
        // 恢复写入过）
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chat_messages WHERE session_id = ? AND role = ? AND text = ?",
        )
        .bind(session_id)
        .bind(role)
        .bind(text)
        .fetch_one(db)
        .await?;
        if exists > 0 {
            // 已有行存在但 blocks 可能为 NULL（实时 insert_message 落库时未带
            // blocks）。UPDATE 而非 skip，否则刷新后丢失工具调用/思考/计划。
            if let Some(blocks) = blocks {
                sqlx::query(
                    "UPDATE chat_messages SET blocks = ? WHERE session_id = ? AND role = ? AND text = ?",
                )
                .bind(blocks)
                .bind(session_id)
                .bind(role)
                .bind(text)
                .execute(db)
                .await?;
            }
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(session_id)
            .bind(role)
            .bind(text)
            .bind(&now)
            .bind(blocks)
            .execute(db)
            .await?;
    }
    Ok(())
}

