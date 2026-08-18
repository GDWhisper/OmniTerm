use sqlx::SqlitePool;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

/// One entry of the frontend's `/sessions/{id}/messages/sync` payload.
///
/// `id` is `Some` **only when the frontend knows the real DB row id** — hydrated rows
/// (`GET /messages` returns row ids) and the in-progress turn row (the backend pushes its
/// `row_id` down in `turn_snapshot` / `prompt_done`). Messages the frontend built itself
/// (replay reconstruction, live streaming before any snapshot) carry frontend-generated
/// ids that do not exist in the DB, and must leave this `None` — see [`sync_messages`]
/// for why the two cases cannot share one matching rule.
pub struct SyncMessageInput {
    pub id: Option<String>,
    pub role: String,
    pub text: String,
    pub blocks: Option<String>,
}

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

/// 恢复会话重放完成后，把前端重建出的消息落库，使刷新浏览器后仍可还原；
/// turn 结束时前端也用它把 cooked `blocks` 回写到后端累积器建的那一行
/// （见 `docs/dev/plans/2026-08-10-acp-session-reliability.md` Phase 0/1）。
///
/// 两条匹配路径，由 [`SyncMessageInput::id`] 的有无决定：
/// - **带 id（权威路径）**：id 就是 DB 行 id，只更新那一行的 `blocks`。匹配不到就
///   跳过——带 id 表达的是「更新这一行」的明确意图，猜测式回退到文本匹配只会制造
///   重复行。**不更新 `text`**：`text` 的权威在后端累积器，前端回写的只是结构化内容。
/// - **无 id（重放重建的消息）**：按 `(session, role, text)` 找一行，找不到才 INSERT。
///
/// 设计要点（避免丢失或污染已有数据）：
/// - **不删除**任何已有记录。此前整轮 `DELETE` 重建会误删实时 prompt 已落库的
///   user 消息——而 ACP `session/load` 重放流不含 user prompt，导致恢复后 user
///   历史永久丢失。
/// - 文本路径下**一条 payload 只消费一行**，且同一次调用内不重复消费同一行。此前的
///   `UPDATE ... WHERE session_id AND role AND text` 无行限定，把 text 相同的所有行
///   一次覆盖成同一份 `blocks`（dev 库实测：14 行 `assistant`/"OK" 只剩 1 份 blocks）。
/// - 实时 prompt 的 user/assistant 仍由 `insert_message` / `upsert_streaming_message`
///   负责；本函数只补齐重放历史与回写结构化内容。
pub async fn sync_messages(
    db: &SqlitePool,
    session_id: &str,
    messages: &[SyncMessageInput],
) -> Result<(), sqlx::Error> {
    // 本次调用已消费的行 id：防止 payload 里多条同 text 消息命中同一行。
    let mut consumed: HashSet<String> = HashSet::new();
    // 每个 (role, text) 的候选行 id，按 (created_at, id) 升序，每组只查一次。
    // 只取 id 列，不取正文——`blocks` 可达数 MB，匹配用不到它。
    let mut candidates: HashMap<(&str, &str), VecDeque<String>> = HashMap::new();

    for m in messages {
        if let Some(row_id) = &m.id {
            let Some(blocks) = &m.blocks else { continue };
            let affected =
                sqlx::query("UPDATE chat_messages SET blocks = ? WHERE id = ? AND session_id = ?")
                    .bind(blocks)
                    .bind(row_id)
                    .bind(session_id)
                    .execute(db)
                    .await?
                    .rows_affected();
            if affected == 0 {
                // 行还没落库（短 turn 抢在防抖写之前）或 id 不属于本会话。留在原样
                // 比猜一行更新更安全：该 turn 的 blocks 停在后端写的原始帧态。
                tracing::debug!(row_id = %row_id, "sync_messages: no such row, skipped");
            } else {
                consumed.insert(row_id.clone());
            }
            continue;
        }

        // 无 id 路径才要求 text 非空：它靠 text 匹配，空 text 无法定位，也不该 INSERT
        // 空行。带 id 的路径无此限制——**纯工具调用 turn 的 `text` 本就是空的**
        // （后端只累积 `AgentMessageChunk`），却恰好是 blocks 最肥的一类 turn。
        if m.text.is_empty() {
            continue;
        }

        let key = (m.role.as_str(), m.text.as_str());
        let queue = match candidates.entry(key) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let ids: Vec<String> = sqlx::query_scalar(
                    "SELECT id FROM chat_messages WHERE session_id = ? AND role = ? AND text = ? \
                     ORDER BY created_at, id",
                )
                .bind(session_id)
                .bind(&m.role)
                .bind(&m.text)
                .fetch_all(db)
                .await?;
                e.insert(ids.into())
            }
        };
        let matched = loop {
            match queue.pop_front() {
                // 已被带 id 的 payload 更新过 → 让给下一条同 text 的 payload。
                Some(id) if consumed.contains(&id) => continue,
                other => break other,
            }
        };

        if let Some(id) = matched {
            consumed.insert(id.clone());
            // 已有行的 blocks 可能为 NULL（实时 insert_message 落库时未带 blocks）。
            // UPDATE 而非 skip，否则刷新后丢失工具调用 / 思考 / 计划。
            if let Some(blocks) = &m.blocks {
                sqlx::query("UPDATE chat_messages SET blocks = ? WHERE id = ?")
                    .bind(blocks)
                    .bind(&id)
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
            .bind(&m.role)
            .bind(&m.text)
            .bind(&now)
            .bind(&m.blocks)
            .execute(db)
            .await?;
        consumed.insert(id);
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
    async fn system_role_message_can_be_inserted_and_read_back() {
        let db = fresh_db().await;

        // migration 放宽 CHECK 约束后，reaper 的权限超时回收告知（role='system'）可落库
        insert_message(
            &db,
            SESSION,
            "system",
            "权限请求 30 分钟未获响应，系统已自动取消该请求并回收会话",
            Some(r#"[{"type":"system","label":"权限请求 30 分钟未获响应"}]"#),
        )
        .await
        .expect("role='system' insert must succeed after migration");

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        assert!(
            page.rows.iter().any(|(role, text, ..)| {
                role == "system" && text.starts_with("权限请求 30 分钟未获响应")
            }),
            "hydrate 应能回读 system 消息"
        );
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

    /// Seed one row with an explicit id/text so collision cases can be built.
    async fn seed_row(db: &SqlitePool, id: &str, role: &str, text: &str, created_at: &str) {
        sqlx::query(
            "INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks) \
             VALUES (?, ?, ?, ?, ?, NULL)",
        )
        .bind(id)
        .bind(SESSION)
        .bind(role)
        .bind(text)
        .bind(created_at)
        .execute(db)
        .await
        .expect("seed row");
    }

    async fn blocks_of(db: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT blocks FROM chat_messages WHERE id = ?")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("fetch blocks")
    }

    async fn row_count(db: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE session_id = ?")
            .bind(SESSION)
            .fetch_one(db)
            .await
            .expect("count rows")
    }

    /// A payload entry from replay reconstruction: no DB row id, matched by text.
    fn text_entry(text: &str, blocks: &str) -> SyncMessageInput {
        SyncMessageInput {
            id: None,
            role: "assistant".into(),
            text: text.into(),
            blocks: Some(blocks.into()),
        }
    }

    /// A payload entry carrying the authoritative DB row id.
    fn id_entry(id: &str, text: &str, blocks: &str) -> SyncMessageInput {
        SyncMessageInput {
            id: Some(id.into()),
            role: "assistant".into(),
            text: text.into(),
            blocks: Some(blocks.into()),
        }
    }

    /// Two rows sharing the same text must not share one `blocks`. Regression for the
    /// unbounded `UPDATE ... WHERE session_id AND role AND text`, which overwrote every
    /// same-text row with the last payload entry (observed in the dev DB: 14 rows of
    /// `assistant`/"OK" collapsed to a single distinct `blocks`).
    #[tokio::test]
    async fn same_text_rows_keep_independent_blocks() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;
        seed_row(&db, "row-b", "assistant", "OK", "2026-08-10T00:00:02Z").await;

        let msgs = vec![text_entry("OK", "[\"first\"]"), text_entry("OK", "[\"second\"]")];
        sync_messages(&db, SESSION, &msgs).await.expect("sync");

        assert_eq!(blocks_of(&db, "row-a").await.as_deref(), Some("[\"first\"]"));
        assert_eq!(blocks_of(&db, "row-b").await.as_deref(), Some("[\"second\"]"));
        assert_eq!(row_count(&db).await, 2, "两条 payload 对应两条既有行，不得新增");
    }

    /// More same-text payload entries than rows: the surplus becomes a new row rather
    /// than re-overwriting an already-consumed one.
    #[tokio::test]
    async fn surplus_same_text_entry_inserts_instead_of_overwriting() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;

        let msgs = vec![text_entry("OK", "[\"first\"]"), text_entry("OK", "[\"second\"]")];
        sync_messages(&db, SESSION, &msgs).await.expect("sync");

        assert_eq!(blocks_of(&db, "row-a").await.as_deref(), Some("[\"first\"]"));
        assert_eq!(row_count(&db).await, 2, "多出的一条新增行，不覆写已消费的行");
    }

    /// The row-id path targets exactly one row and must not touch `text` — `text` is the
    /// backend accumulator's authority, the frontend only owns the cooked `blocks`.
    #[tokio::test]
    async fn row_id_path_updates_only_that_rows_blocks() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;
        seed_row(&db, "row-b", "assistant", "OK", "2026-08-10T00:00:02Z").await;

        sync_messages(&db, SESSION, &[id_entry("row-b", "stale frontend text", "[\"cooked\"]")])
            .await
            .expect("sync");

        assert_eq!(blocks_of(&db, "row-b").await.as_deref(), Some("[\"cooked\"]"));
        assert_eq!(blocks_of(&db, "row-a").await, None, "同 text 的另一行不得被注入");
        let text: String = sqlx::query_scalar("SELECT text FROM chat_messages WHERE id = 'row-b'")
            .fetch_one(&db)
            .await
            .expect("fetch text");
        assert_eq!(text, "OK", "text 的权威在后端，不得被前端 payload 覆盖");
        assert_eq!(row_count(&db).await, 2);
    }

    /// An id that is not in the DB (row not yet flushed, or belongs to another session)
    /// must be skipped — never guessed at by text, never inserted as a duplicate.
    #[tokio::test]
    async fn unknown_row_id_is_skipped_not_inserted() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;

        sync_messages(&db, SESSION, &[id_entry("row-missing", "OK", "[\"cooked\"]")])
            .await
            .expect("sync");

        assert_eq!(blocks_of(&db, "row-a").await, None, "不得回退到文本匹配");
        assert_eq!(row_count(&db).await, 1, "不得 INSERT 重复行");
    }

    /// The row-id path consumes its row, so a later same-text entry without an id lands
    /// on a different row instead of undoing the cooked write.
    #[tokio::test]
    async fn row_id_path_consumes_the_row_for_later_text_matches() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;
        seed_row(&db, "row-b", "assistant", "OK", "2026-08-10T00:00:02Z").await;

        let msgs = vec![id_entry("row-a", "OK", "[\"cooked\"]"), text_entry("OK", "[\"replay\"]")];
        sync_messages(&db, SESSION, &msgs).await.expect("sync");

        assert_eq!(blocks_of(&db, "row-a").await.as_deref(), Some("[\"cooked\"]"));
        assert_eq!(blocks_of(&db, "row-b").await.as_deref(), Some("[\"replay\"]"));
        assert_eq!(row_count(&db).await, 2);
    }

    /// Replay history that predates the DB still has to be inserted (the original reason
    /// this function exists).
    #[tokio::test]
    async fn text_path_inserts_messages_absent_from_db() {
        let db = fresh_db().await;

        let msgs = vec![text_entry("hello", "[\"a\"]"), text_entry("world", "[\"b\"]")];
        sync_messages(&db, SESSION, &msgs).await.expect("sync");

        assert_eq!(row_count(&db).await, 2);
        let blocks: Vec<String> =
            sqlx::query_scalar("SELECT blocks FROM chat_messages ORDER BY text")
                .fetch_all(&db)
                .await
                .expect("fetch");
        assert_eq!(blocks, ["[\"a\"]", "[\"b\"]"]);
    }

    /// Re-running the same sync must be idempotent: the second pass matches the rows the
    /// first pass inserted rather than duplicating them.
    #[tokio::test]
    async fn repeated_sync_does_not_duplicate_rows() {
        let db = fresh_db().await;
        let msgs = vec![text_entry("hello", "[\"a\"]"), text_entry("hello", "[\"b\"]")];

        sync_messages(&db, SESSION, &msgs).await.expect("first sync");
        sync_messages(&db, SESSION, &msgs).await.expect("second sync");

        assert_eq!(row_count(&db).await, 2, "重复 sync 不得累积行");
        let blocks: Vec<String> =
            sqlx::query_scalar("SELECT blocks FROM chat_messages ORDER BY created_at, id")
                .fetch_all(&db)
                .await
                .expect("fetch");
        assert_eq!(blocks, ["[\"a\"]", "[\"b\"]"], "第二轮按同顺序落到同两行");
    }

    /// A tool-only turn accumulates no `AgentMessageChunk` text, so its row has an empty
    /// `text` — yet those are exactly the turns with the fattest `blocks`. The row-id path
    /// must not skip them.
    #[tokio::test]
    async fn row_id_path_accepts_empty_text_rows() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "", "2026-08-10T00:00:01Z").await;

        sync_messages(&db, SESSION, &[id_entry("row-a", "", "[\"cooked\"]")]).await.expect("sync");

        assert_eq!(blocks_of(&db, "row-a").await.as_deref(), Some("[\"cooked\"]"));
        assert_eq!(row_count(&db).await, 1);
    }

    /// An empty-text entry *without* an id has nothing to match on — inserting it would
    /// create a blank history row.
    #[tokio::test]
    async fn text_path_skips_empty_text_entries() {
        let db = fresh_db().await;

        sync_messages(&db, SESSION, &[text_entry("", "[\"cooked\"]")]).await.expect("sync");

        assert_eq!(row_count(&db).await, 0, "空 text 无 id 无法定位，不得 INSERT 空行");
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
