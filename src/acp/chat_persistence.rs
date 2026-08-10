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

/// Opaque pagination cursor for [`list_messages_page`]. `created_at` alone is not a
/// total order — messages written in one batch share the same RFC3339 second (observed
/// in real data: four rows at `06:17:57`) — so the cursor pairs it with the row `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageCursor {
    pub created_at: String,
    pub id: String,
}

impl MessageCursor {
    /// Wire form: `<created_at>|<id>`. Neither part can contain `|` (RFC3339 timestamp
    /// and uuid), so a single split is unambiguous.
    pub fn encode(&self) -> String {
        format!("{}|{}", self.created_at, self.id)
    }

    /// Parse the wire form. Returns `None` for anything malformed so callers can reject
    /// the request instead of silently serving the first page (which would make a
    /// paginating client loop forever).
    pub fn parse(raw: &str) -> Option<Self> {
        let (created_at, id) = raw.split_once('|')?;
        if created_at.is_empty() || id.is_empty() {
            return None;
        }
        Some(Self { created_at: created_at.to_string(), id: id.to_string() })
    }
}

/// One page of chat history, oldest-first (ready to render / prepend as-is).
pub struct MessagePage {
    pub rows: Vec<ChatMessageRow>,
    /// Cursor for the next (older) page, or `None` when the page reaches the start of
    /// the history.
    pub next_cursor: Option<MessageCursor>,
}

/// Fetch the newest page of a session's history, or the page just before `before`.
///
/// Bounded on two axes, mirroring the turn accumulator's window: `limit` rows **and**
/// `max_bytes` of payload. The byte budget is what actually protects the response — one
/// `blocks` column can be megabytes on its own, and row count says nothing about that.
/// At least one row is always returned, so an oversized single message still loads
/// (slowly) rather than paging forever.
///
/// The budget is applied in Rust after the `LIMIT` query rather than in SQL: reading
/// those rows from a local SQLite file is ~10x cheaper than serializing and shipping
/// them (measured on an 11MB session: 50ms to read, 450ms+ to serialize + transfer), so
/// bounding what leaves the process is where the win is.
pub async fn list_messages_page(
    db: &SqlitePool,
    session_id: &str,
    before: Option<&MessageCursor>,
    limit: usize,
    max_bytes: usize,
) -> Result<MessagePage, sqlx::Error> {
    let limit = limit.max(1);
    let (cursor_at, cursor_id) = match before {
        Some(c) => (Some(c.created_at.as_str()), Some(c.id.as_str())),
        None => (None, None),
    };

    // Newest-first so the page can be cut from the newest end; reversed to oldest-first
    // before returning. One extra row is fetched to detect "there is an older page".
    let mut rows: Vec<ChatMessageRow> = sqlx::query_as(
        "SELECT role, text, created_at, id, blocks, status, last_seq FROM chat_messages \
         WHERE session_id = ? \
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) \
         ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(cursor_at)
    .bind(cursor_at)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind((limit + 1) as i64)
    .fetch_all(db)
    .await?;

    let more_by_count = rows.len() > limit;
    rows.truncate(limit);

    // Byte budget: keep newest rows until the next one would blow the budget. `kept > 0`
    // guarantees forward progress when a single row exceeds the whole budget.
    let mut bytes = 0usize;
    let mut kept = 0usize;
    for row in &rows {
        let (_, text, _, _, blocks, _, _) = row;
        let row_bytes = text.len() + blocks.as_deref().map_or(0, str::len);
        if kept > 0 && bytes + row_bytes > max_bytes {
            break;
        }
        bytes += row_bytes;
        kept += 1;
    }
    let more_by_bytes = kept < rows.len();
    rows.truncate(kept);
    rows.reverse();

    let next_cursor = if more_by_count || more_by_bytes {
        rows.first().map(|(_, _, created_at, id, _, _, _)| MessageCursor {
            created_at: created_at.clone(),
            id: id.clone(),
        })
    } else {
        None
    };

    Ok(MessagePage { rows, next_cursor })
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const SESSION: &str = "s1";

    async fn fresh_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations").run(&db).await.expect("run migrations");
        sqlx::query(
            "INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/tmp', '2026-08-10')",
        )
        .execute(&db)
        .await
        .expect("seed project");
        sqlx::query(
            "INSERT INTO sessions (id, project_id, name, created_at) VALUES (?, 'p1', 's', '2026-08-10')",
        )
        .bind(SESSION)
        .execute(&db)
        .await
        .expect("seed session");
        db
    }

    /// Seed `n` messages with deterministic ids/timestamps. `blocks_bytes` sizes the
    /// `blocks` column so byte-budget behaviour can be exercised.
    async fn seed(db: &SqlitePool, n: usize, blocks_bytes: usize) {
        let blocks = "b".repeat(blocks_bytes);
        for i in 0..n {
            sqlx::query(
                "INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks) \
                 VALUES (?, ?, 'assistant', ?, ?, ?)",
            )
            .bind(format!("id-{i:04}"))
            .bind(SESSION)
            .bind(format!("msg-{i}"))
            // Same second on purpose: created_at alone is not a total order.
            .bind(format!("2026-08-10T00:00:{:02}Z", i / 10))
            .bind(&blocks)
            .execute(db)
            .await
            .expect("seed message");
        }
    }

    fn texts(page: &MessagePage) -> Vec<&str> {
        page.rows.iter().map(|(_, text, _, _, _, _, _)| text.as_str()).collect()
    }

    #[tokio::test]
    async fn newest_page_is_oldest_first_and_reports_more() {
        let db = fresh_db().await;
        seed(&db, 25, 0).await;

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        assert_eq!(
            texts(&page),
            [
                "msg-15", "msg-16", "msg-17", "msg-18", "msg-19", "msg-20", "msg-21", "msg-22",
                "msg-23", "msg-24"
            ],
            "取最新 10 条且按旧→新排序"
        );
        let cursor = page.next_cursor.expect("还有更早的消息");
        assert_eq!(cursor.id, "id-0015", "游标指向本页最旧一条");
    }

    #[tokio::test]
    async fn cursor_walks_backwards_without_gap_or_overlap_across_same_second() {
        let db = fresh_db().await;
        // 10 rows per second → paging must not rely on created_at alone.
        seed(&db, 25, 0).await;

        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let page = list_messages_page(&db, SESSION, cursor.as_ref(), 7, usize::MAX)
                .await
                .expect("page");
            let mut batch: Vec<String> = texts(&page).iter().map(|s| s.to_string()).collect();
            batch.extend(seen);
            seen = batch;
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        let expected: Vec<String> = (0..25).map(|i| format!("msg-{i}")).collect();
        assert_eq!(seen, expected, "逐页回溯应拼回完整历史（无重复、无缺失）");
    }

    #[tokio::test]
    async fn byte_budget_cuts_the_page_before_the_row_limit() {
        let db = fresh_db().await;
        seed(&db, 20, 1000).await;

        // Budget fits 3 rows (~1000B each); the row limit would have allowed 20.
        let page = list_messages_page(&db, SESSION, None, 20, 3200).await.expect("page");
        assert_eq!(page.rows.len(), 3, "字节预算应比条数上限先生效");
        assert_eq!(texts(&page), ["msg-17", "msg-18", "msg-19"], "保留的应是最新的那几条");
        assert!(page.next_cursor.is_some(), "被字节预算截断必须报告还有更早");
    }

    /// A single row bigger than the whole budget must still be returned, otherwise the
    /// client would page forever and never render it.
    #[tokio::test]
    async fn oversized_single_row_still_makes_progress() {
        let db = fresh_db().await;
        seed(&db, 3, 5000).await;

        let page = list_messages_page(&db, SESSION, None, 10, 100).await.expect("page");
        assert_eq!(page.rows.len(), 1, "预算再小也得返回一条");
        assert_eq!(texts(&page), ["msg-2"]);
    }

    #[tokio::test]
    async fn short_history_returns_everything_with_no_cursor() {
        let db = fresh_db().await;
        seed(&db, 4, 10).await;

        let page = list_messages_page(&db, SESSION, None, 100, usize::MAX).await.expect("page");
        assert_eq!(page.rows.len(), 4);
        assert!(page.next_cursor.is_none(), "历史已到头时不得给游标（否则前端会无限上拉）");
    }

    #[test]
    fn cursor_round_trips_and_rejects_malformed() {
        let c = MessageCursor { created_at: "2026-08-10T00:00:00Z".into(), id: "id-1".into() };
        assert_eq!(MessageCursor::parse(&c.encode()), Some(c));
        assert!(MessageCursor::parse("no-separator").is_none());
        assert!(MessageCursor::parse("|id").is_none());
        assert!(MessageCursor::parse("ts|").is_none());
    }
}
