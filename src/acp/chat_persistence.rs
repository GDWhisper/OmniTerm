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
) -> Result<Vec<ChatMessageRow>, sqlx::Error> {
    let rows: Vec<ChatMessageRow> = sqlx::query_as(
        "SELECT role, text, created_at, id, blocks, status, last_seq FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
    )
    .bind(session_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// A persisted chat message row: (role, text, created_at, id, blocks, status, last_seq).
/// `status` is 'streaming' for an in-progress assistant turn or 'complete' otherwise;
/// `last_seq` is the monotonic notification sequence folded at the last write (NULL for
/// legacy / non-streaming rows).
pub type ChatMessageRow = (String, String, String, String, Option<String>, String, Option<i64>);

/// Insert-or-update the single in-progress assistant row for a turn. The backend turn
/// accumulator owns `row_id` (a uuid generated at turn start) and calls this on each
/// debounced flush, so the row is created lazily on the first write and refreshed in
/// place afterwards. `status` stays 'streaming' until [`finalize_message`].
pub async fn upsert_streaming_message(
    db: &SqlitePool,
    row_id: &str,
    session_id: &str,
    text: &str,
    blocks: Option<&str>,
    last_seq: i64,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks, status, last_seq) \
         VALUES (?, ?, 'assistant', ?, ?, ?, 'streaming', ?) \
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, blocks = excluded.blocks, last_seq = excluded.last_seq",
    )
    .bind(row_id)
    .bind(session_id)
    .bind(text)
    .bind(&now)
    .bind(blocks)
    .bind(last_seq)
    .execute(db)
    .await?;
    Ok(())
}

/// Mark an in-progress assistant row as finalized. Called once at turn end (normal
/// completion, cancel, or crash). Idempotent — a missing/already-complete row is a no-op.
pub async fn finalize_message(db: &SqlitePool, row_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE chat_messages SET status = 'complete' WHERE id = ?")
        .bind(row_id)
        .execute(db)
        .await?;
    Ok(())
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
