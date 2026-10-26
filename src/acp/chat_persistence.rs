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

/// `turn_row_id`：mid-turn 告知归属的 turn 行 id（见 migration
/// `20261026_add_chat_message_turn_row_id.sql`）；非告知消息与无归属告知传 `None`。
pub async fn insert_message(
    db: &SqlitePool,
    session_id: &str,
    role: &str,
    text: &str,
    blocks: Option<&str>,
    turn_row_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO chat_messages (id, session_id, role, text, created_at, blocks, turn_row_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(role)
    .bind(text)
    .bind(&now)
    .bind(blocks)
    .bind(turn_row_id)
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
    let rows: Vec<ChatMessageRow> = sqlx::query_as(
        "SELECT role, text, created_at, id, blocks, status, last_seq, duration_ms, wait_ms, \
                tool_ms, tps, finished_at, turn_row_id \
         FROM chat_messages \
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

    Ok(finalize_page(rows, limit, max_bytes))
}

/// 页的收尾：字节预算裁剪 + 反转（oldest-first 输出）+ next cursor 计算。
///
/// 两处取页（普通分页 / 定位页）共用同一套预算语义——拆出去是为了让两条路径
/// 不各写一份（禁 Copy-Paste），改预算口径时只改这一处。
fn finalize_page(mut rows: Vec<ChatMessageRow>, limit: usize, max_bytes: usize) -> MessagePage {
    let more_by_count = rows.len() > limit;
    rows.truncate(limit);

    // Byte budget: keep newest rows until the next one would blow the budget. `kept > 0`
    // guarantees forward progress when a single row exceeds the whole budget.
    let mut bytes = 0usize;
    let mut kept = 0usize;
    for row in &rows {
        let row_bytes = row.text.len() + row.blocks.as_deref().map_or(0, str::len);
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
        rows.first().map(|r| MessageCursor { created_at: r.created_at.clone(), id: r.id.clone() })
    } else {
        None
    };

    MessagePage { rows, next_cursor }
}

/// 定位页：以 `at` 指向的行为**最新行**取一页（倒序取 N 行后反转），供前端把
/// 消息窗口整体替换到目标附近（F06 D7）。
///
/// 为什么要有这个端点：命中消息通常**还没被前端加载**（首屏只取最近一页），
/// 用 `?before=` 一页页往前翻到目标需要 O(页数) 次请求、最坏传几百 MB——
/// 不可接受。定位页一次查询解决（D7）。
///
/// 语义：返回的行**含目标行**且目标行是**最新**的那一行；`next_cursor` 指向本页
/// 最旧行，前端替换窗口后继续上翻即从这里接上（D8）。
pub async fn list_messages_page_at(
    db: &SqlitePool,
    session_id: &str,
    at: &MessageCursor,
    limit: usize,
    max_bytes: usize,
) -> Result<MessagePage, sqlx::Error> {
    let limit = limit.max(1);
    // 与 list_messages_page 同序（created_at DESC, id DESC）：`id <= ?` 保证同一秒内
    // 的并列行里目标行也在页内。
    let rows: Vec<ChatMessageRow> = sqlx::query_as(
        "SELECT role, text, created_at, id, blocks, status, last_seq, duration_ms, wait_ms, \
                tool_ms, tps, finished_at, turn_row_id \
         FROM chat_messages \
         WHERE session_id = ? \
           AND (created_at < ? OR (created_at = ? AND id <= ?)) \
         ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(&at.created_at)
    .bind(&at.created_at)
    .bind(&at.id)
    .bind((limit + 1) as i64)
    .fetch_all(db)
    .await?;

    Ok(finalize_page(rows, limit, max_bytes))
}

// ── 会话内全文检索（F06，计划 docs/dev/plans/2026-10-21-acp-chat-fulltext-search.md）──
//
// **为什么用 LIKE 而不是 FTS5**（计划 D1/D2 的实测结论）：搜索范围天然被「一个会话」
// 框住，LIKE 全表扫描在真实量级够快（实测 5000 行/20MB = 28ms、20000 行/77MB =
// 51ms），而 FTS5（trigram）实测让 DB 涨 6.7×，还要搭一套迁移 + 触发器 + 中文分词
// ADR——为一个会话级搜索付这个代价是过度设计。LIKE 还**天然支持中文子串**
// （原 X02 担心的「unicode61 不切中文」在 LIKE 方案下根本不存在）。
// 升级条件是量化的：会话文本量 p99 > 20MB 或单次检索 p99 > 200ms 时才上 FTS5（D2）。

/// 扫描预算·行数：只检索会话内**最近 N 行**（索引
/// `idx_chat_messages_session(session_id, created_at)` 让这个范围扫描有界）。
pub const MAX_SEARCH_ROWS: usize = 20_000;
/// 扫描预算·文本字节：与行数是**两个独立轴**——一万条短消息与五十条长消息的
/// 行数/字节量级完全不同，只限一个维度等于没限（计划 D4）。
pub const MAX_SEARCH_BYTES: usize = 16 * 1024 * 1024;
/// 关键词个数上限：每个词一次 LIKE 扫描，成本与词数线性（计划 D5）。
pub const MAX_SEARCH_TERMS: usize = 8;
/// 返回条数上限：响应体积有界（计划 D13）。
pub const MAX_SEARCH_RESULTS: usize = 100;
/// 命中片段的最大字符数（超出部分以省略号标注）。
const SEARCH_SNIPPET_MAX_CHARS: usize = 160;

/// 一条检索命中。
///
/// 序列化用 camelCase（与本仓其它 HTTP 响应一致——`createdAt` / `nextCursor` 等）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 消息行 id（DB 主键）——前端据此判断「是否已在窗口内」。
    pub id: String,
    /// 角色（user / assistant；system 行不参与检索）。
    pub role: String,
    /// 消息时刻（RFC3339, UTC）。
    pub created_at: String,
    /// 命中片段：首个命中词周围的截断文本。
    pub snippet: String,
    /// 定位游标（`<created_at>|<id>`）：前端据此请求「定位页」把窗口挪到目标附近。
    pub cursor: String,
}

/// 检索结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// 命中项（按时间倒序，最多 `MAX_SEARCH_RESULTS` 条）。
    pub hits: Vec<SearchHit>,
    /// 扫描窗口内命中的行数（`more_matches` 为真时这是下界）。
    pub match_count: usize,
    /// 命中数超过返回上限——还有更多命中没列出来（UI 必须如实说明）。
    pub more_matches: bool,
    /// 实际参与检索的行数 / 文本字节数（预算触顶时小于会话总量）。
    pub scanned_rows: usize,
    pub scanned_bytes: usize,
    /// 预算触顶：**更早的内容没有参与检索**。UI 必须显式标注省略量——
    /// 静默截断会让用户以为搜全了，比搜不到更糟（计划 D4）。
    pub truncated: bool,
    /// 关键词数超上限被截断（用户以为搜了全部词，实际只搜了前 N 个）。
    pub terms_truncated: bool,
}

/// 转义 LIKE 通配符（计划 D6，§S1 外部输入进 SQL 前必须 sanitize）：
/// 用户搜 `100%` 必须匹配字面 `100%`，不能变成「以 100 开头」。
/// 与 SQL 里的 `ESCAPE '\'` 一一对应。
fn escape_like_term(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 8);
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 命中片段：取首个命中词周围的窗口，超出部分以省略号标注（计划 D13）。
fn build_snippet(text: &str, terms: &[&str], max_chars: usize) -> String {
    let max_chars = max_chars.max(1);
    let lower = text.to_lowercase();
    // 首个命中词的位置（字节偏移；`find` 返回的一定是字符边界）。
    let mut first: Option<usize> = None;
    for term in terms {
        let needle = term.to_lowercase();
        if needle.is_empty() {
            continue;
        }
        if let Some(pos) = lower.find(&needle) {
            first = Some(match first {
                Some(best) => best.min(pos),
                None => pos,
            });
        }
    }
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let (start, end) = match first {
        Some(byte_pos) => {
            let char_pos = text[..byte_pos].chars().count();
            // 命中词靠前时多留点前文（用户要看到上下文），其余往后铺。
            let start = char_pos.saturating_sub(max_chars / 3);
            (start, (start + max_chars).min(total))
        }
        None => (0, max_chars.min(total)),
    };
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < total {
        snippet.push('…');
    }
    snippet
}

/// 会话内全文检索：按关键词（空格分隔、AND 语义）匹配消息正文。
///
/// 预算语义（计划 D4，两个独立轴，任一触顶即停并显式标注）：
/// - **行数**：`MAX_SEARCH_ROWS`——只扫会话内最近 N 行（索引让范围扫描有界）。
/// - **字节**：`MAX_SEARCH_BYTES`——累计参与检索的文本字节。
///
/// 实现分两步，为的是**别把大文本搬进内存**：
/// 1. 候选窗口：只取 `(id, created_at, LENGTH(text))`（不取 text 本体），
///    在 Rust 侧累计字节并定出「参与检索的范围」；
/// 2. 在该范围内做 LIKE 匹配，取命中行。
///
/// 两步都走 `idx_chat_messages_session(session_id, created_at)`，范围扫描有界。
///
/// 只搜 `text`（对话正文），**不搜 `blocks`**（工具调用 / 思考内容是 JSON、MB 级，
/// 且工具输出常含大段代码，搜索噪声大）；`system` 行（宿主内部事件）不参与检索。
pub async fn search_session_messages(
    db: &SqlitePool,
    session_id: &str,
    terms: &[String],
    max_rows: usize,
    max_bytes: usize,
) -> Result<SearchResult, sqlx::Error> {
    let max_rows = max_rows.max(1);
    // 关键词数上限（计划 D5）：超出的词被丢弃并如实上报 `terms_truncated`——
    // 静默丢词会让结果看起来像「全部词都匹配上了」。
    let terms_truncated = terms.len() > MAX_SEARCH_TERMS;
    let used_terms: Vec<&str> = terms.iter().take(MAX_SEARCH_TERMS).map(|s| s.as_str()).collect();

    if used_terms.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            match_count: 0,
            more_matches: false,
            scanned_rows: 0,
            scanned_bytes: 0,
            truncated: false,
            terms_truncated,
        });
    }

    // ① 候选窗口：最近 N 行，只取 id / 时刻 / 文本长度（不取文本本体）。
    let candidates: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, created_at, LENGTH(text) FROM chat_messages \
         WHERE session_id = ? AND role <> 'system' \
         ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(max_rows as i64)
    .fetch_all(db)
    .await?;

    // 预算：行数触顶（候选窗口取满 ⇒ 后面还有更早的行没参与检索）与字节触顶
    // 都要显式上报，不能让用户以为搜全了。
    let mut truncated = candidates.len() >= max_rows;
    let mut scanned_rows = 0usize;
    let mut scanned_bytes = 0usize;
    // 参与检索的范围下界：最后一个纳入预算的行（含）。范围用
    // (created_at, id) 元组表达——created_at 只到秒，同秒并列行靠 id 定序。
    let mut boundary: Option<(String, String)> = None;
    for (id, created_at, len) in &candidates {
        let len = (*len).max(0) as usize;
        // 至少保留一行（与分页同口径）：单条就超预算的消息也要能被搜到。
        if boundary.is_some() && scanned_bytes + len > max_bytes {
            truncated = true;
            break;
        }
        scanned_bytes += len;
        scanned_rows += 1;
        boundary = Some((created_at.clone(), id.clone()));
    }

    // ② 范围内做 LIKE 匹配（多词 AND：每个词都要在同一行出现，位置任意）。
    let mut sql = String::from(
        "SELECT id, role, text, created_at FROM chat_messages \
         WHERE session_id = ? AND role <> 'system'",
    );
    if boundary.is_some() {
        sql.push_str(" AND (created_at > ? OR (created_at = ? AND id >= ?))");
    }
    for _ in &used_terms {
        sql.push_str(" AND text LIKE ? ESCAPE '\\'");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, (String, String, String, String)>(&sql);
    query = query.bind(session_id);
    if let Some((b_at, b_id)) = &boundary {
        query = query.bind(b_at).bind(b_at).bind(b_id);
    }
    for term in &used_terms {
        query = query.bind(format!("%{}%", escape_like_term(term)));
    }
    // 多取一条用来判断「命中数超过返回上限」。
    let rows: Vec<(String, String, String, String)> =
        query.bind((MAX_SEARCH_RESULTS + 1) as i64).fetch_all(db).await?;

    let more_matches = rows.len() > MAX_SEARCH_RESULTS;
    let hits: Vec<SearchHit> = rows
        .into_iter()
        .take(MAX_SEARCH_RESULTS)
        .map(|(id, role, text, created_at)| SearchHit {
            cursor: MessageCursor { created_at: created_at.clone(), id: id.clone() }.encode(),
            snippet: build_snippet(&text, &used_terms, SEARCH_SNIPPET_MAX_CHARS),
            id,
            role,
            created_at,
        })
        .collect();
    let match_count = hits.len();

    Ok(SearchResult {
        hits,
        match_count,
        more_matches,
        scanned_rows,
        scanned_bytes,
        truncated,
        terms_truncated,
    })
}

/// A persisted chat message row.
///
/// 命名字段而非元组：到这里已有 9 个字段，且 `last_seq`/`duration_ms`/`wait_ms` 同型
/// （都是 `Option<i64>`），元组解构里把它们写颠倒编译器抓不住，只能靠人眼。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatMessageRow {
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub id: String,
    pub blocks: Option<String>,
    /// 'streaming' for an in-progress assistant turn, 'complete' otherwise.
    pub status: String,
    /// The monotonic notification sequence folded at the last write (NULL for legacy /
    /// non-streaming rows).
    pub last_seq: Option<i64>,
    /// 该 turn 的 agent 工作时长（ms，已扣除审批等待）。NULL = 迁移前的历史行 ——
    /// `chat_messages` 从不记录 turn 结束时刻，老行的时长**不可追溯**，区别于 0。
    pub duration_ms: Option<i64>,
    /// 该 turn 内等真人审批的时长（ms）。NULL 同上。
    pub wait_ms: Option<i64>,
    /// 该 turn 可归因于工具执行的时长（ms，估算，口径见 `turn_accumulator`）。
    /// NULL = 迁移前的历史行或跟踪越界失效；0 = 有效观测下没记到工具。
    pub tool_ms: Option<i64>,
    /// 该 turn 的输出速率估算（tokens/s，估算）。NULL = 无可测窗口（含迁移前历史行）。
    pub tps: Option<f64>,
    /// 该 turn 的定稿时刻（RFC3339，UTC）。NULL = 迁移前的历史行（无结束时刻记录，
    /// 不可追溯）——前端底部读数主段「结束于 14:32」据此渲染，NULL 不渲染。
    pub finished_at: Option<String>,
    /// mid-turn 告知归属的 turn 行 id（本表 `id`）。NULL = 无归属（非 mid-turn 告知）
    /// 或迁移前的历史行——前端据此把独立 system 行归块进对应 turn 的过程容器。
    pub turn_row_id: Option<String>,
}

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

/// Mark an in-progress assistant row as finalized and record the turn's duration.
///
/// 时长与定稿同一条 UPDATE：`duration_ms`/`wait_ms` 只在 turn 结束那一刻才知道，拆开写
/// 就存在「行已 complete 但时长缺失」的半成品状态（前端会把它当 0 而非未知）。
/// `finished_at`（RFC3339）= turn 定稿时刻，由累积器生成并与 `prompt_done` 下发共用
/// 同一值——底部读数主段「结束于 14:32」据此渲染，刷新前后一致。
/// Idempotent — a missing/already-complete row is a no-op.
pub async fn finalize_message(
    db: &SqlitePool,
    row_id: &str,
    duration_ms: i64,
    wait_ms: i64,
    tool_ms: Option<i64>,
    tps: Option<f64>,
    finished_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE chat_messages SET status = 'complete', duration_ms = ?, wait_ms = ?, \
         tool_ms = ?, tps = ?, finished_at = ? WHERE id = ?",
    )
    .bind(duration_ms)
    .bind(wait_ms)
    .bind(tool_ms)
    .bind(tps)
    .bind(finished_at)
    .bind(row_id)
    .execute(db)
    .await?;
    Ok(())
}

/// 把一个已结束 turn 的时长增量累加到会话行上（会话级累计在写时结算，不做读时
/// `SUM ... GROUP BY` —— 会话列表是轮询接口，理由见
/// `docs/dev/plans/archive/2026-08-30-acp-work-time.md` D3）。
///
/// `work_ms` + `wait_ms` = 该 turn 的墙钟时长。累计落在 `sessions` 行上，与 agent 子进程
/// 生命周期无关：idle 回收 → restore 出新 client 后继续累加。
pub async fn accumulate_turn(
    db: &SqlitePool,
    session_id: &str,
    work_ms: i64,
    wait_ms: i64,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE sessions SET work_ms = work_ms + ?, wait_ms = wait_ms + ?, \
         turn_count = turn_count + 1, last_turn_at = ? WHERE id = ?",
    )
    .bind(work_ms)
    .bind(wait_ms)
    .bind(&now)
    .bind(session_id)
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
            if would_drop_inline_notices(db, session_id, row_id, blocks).await? {
                tracing::warn!(
                    row_id = %row_id,
                    "sync_messages: incoming cooked blocks lack an inline system notice; keeping the raw frames"
                );
                consumed.insert(row_id.clone());
                continue;
            }
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
                if would_drop_inline_notices(db, session_id, &id, blocks).await? {
                    tracing::warn!(
                        row_id = %id,
                        "sync_messages: replay blocks lack an inline system notice; keeping the raw frames"
                    );
                    continue;
                }
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

/// 提取 assistant 行里内联 SYSTEM 告知的 `notice_id`。
///
/// 支持两种落盘形态：后端原始帧包裹（`_meta.omnitermSystem.id`）与前端回写的
/// cooked blocks（`{type:'system', noticeId}`）。用于 [`would_drop_inline_notices`]
/// 判断一次 blocks 覆盖会不会把已落库的 mid-turn 告知弄丢。
fn inline_notice_ids(blocks: &str) -> HashSet<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(blocks) else {
        return HashSet::new();
    };
    let mut ids = HashSet::new();
    if let Some(frames) = parsed.get("frames").and_then(|v| v.as_array()) {
        for frame in frames {
            if let Some(id) = frame.pointer("/_meta/omnitermSystem/id").and_then(|v| v.as_str()) {
                ids.insert(id.to_string());
            }
        }
    } else if let Some(blocks) = parsed.as_array() {
        for block in blocks {
            if block.get("type").and_then(|v| v.as_str()) == Some("system")
                && let Some(id) = block.get("noticeId").and_then(|v| v.as_str())
            {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

/// 本次 `blocks` 覆盖是否会丢掉 assistant 行已有的内联 SYSTEM 告知。
///
/// 为什么要这层守卫：内联告知是「后端帧 + live 独立 system 消息」双轨的——前端
/// 在网络正常时会把 live 消息的 blocks 一并回写，但如果帧因慢消费者被 broadcast
/// 丢弃（`spawn_notify_task` 只 log 后继续），cooked 载荷就会少掉这条告知；直接
/// UPDATE 会让原本已持久化的告知永久消失。宁可不收敛该行的 cooked blocks
/// （保留后端原始帧，hydrate 仍能解码出正确顺序），也不静默丢数据。
async fn would_drop_inline_notices(
    db: &SqlitePool,
    session_id: &str,
    row_id: &str,
    incoming_blocks: &str,
) -> Result<bool, sqlx::Error> {
    // LIKE 先过滤：只有带内联标记的行才需要取回 blocks 解析（低频、每 turn 一次），
    // 普通行不额外搬运最多 MB 级的正文。
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT blocks FROM chat_messages WHERE id = ? AND session_id = ? \
         AND (blocks LIKE '%omnitermSystem%' OR blocks LIKE '%noticeId%')",
    )
    .bind(row_id)
    .bind(session_id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing else { return Ok(false) };
    let required = inline_notice_ids(&existing);
    if required.is_empty() {
        return Ok(false);
    }
    let incoming = inline_notice_ids(incoming_blocks);
    Ok(required.iter().any(|id| !incoming.contains(id)))
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
        page.rows.iter().map(|r| r.text.as_str()).collect()
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
            None,
        )
        .await
        .expect("role='system' insert must succeed after migration");

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        assert!(
            page.rows.iter().any(|r| {
                r.role == "system" && r.text.starts_with("权限请求 30 分钟未获响应")
            }),
            "hydrate 应能回读 system 消息"
        );
    }

    /// mid-turn 告知的 `turn_row_id` 归属必须随读口透传（分页 / 定位页共用
    /// `ChatMessageRow`），前端归块全靠它；`None`（无归属 / 历史行）也必须如实回读。
    #[tokio::test]
    async fn turn_row_id_roundtrips_through_read_paths() {
        let db = fresh_db().await;

        insert_message(&db, SESSION, "system", "告知甲", Some("[]"), Some("turn-1"))
            .await
            .expect("insert with turn row id");
        insert_message(&db, SESSION, "system", "告知乙", Some("[]"), None)
            .await
            .expect("insert without turn row id");

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        let by_text = |t: &str| page.rows.iter().find(|r| r.text == t).expect("row present");
        assert_eq!(by_text("告知甲").turn_row_id.as_deref(), Some("turn-1"), "归属应回读");
        assert_eq!(by_text("告知乙").turn_row_id, None, "无归属应回读为 NULL");

        let at = MessageCursor {
            created_at: page.rows.last().expect("non-empty").created_at.clone(),
            id: page.rows.last().expect("non-empty").id.clone(),
        };
        let at_page = list_messages_page_at(&db, SESSION, &at, 10, usize::MAX).await.expect("at");
        let at_row = at_page.rows.iter().find(|r| r.text == "告知甲");
        assert!(
            at_row.is_none_or(|r| r.turn_row_id.as_deref() == Some("turn-1")),
            "定位页同样必须透传归属"
        );
    }

    /// 内联 SYSTEM 告知是「后端帧 + live 独立消息」双轨：cooked 回写若因慢消费者
    /// 少了告知，不能把已持久化的帧覆盖掉——宁可不收敛该行，也不静默丢数据。
    #[tokio::test]
    async fn sync_keeps_blocks_when_inline_system_notice_would_be_lost() {
        let db = fresh_db().await;
        let notice_id = "notice-1";
        let raw = serde_json::json!({
            "v": 1,
            "frames": [{
                "sessionUpdate": "session_info_update",
                "_meta": { "omnitermSystem": { "id": notice_id, "label": "system.permTimeout.auto" } }
            }]
        })
        .to_string();
        seed_row(&db, "a1", "assistant", "hi", "2026-08-10T00:00:00Z").await;
        sqlx::query("UPDATE chat_messages SET blocks = ? WHERE id = 'a1'")
            .bind(&raw)
            .execute(&db)
            .await
            .expect("seed raw frames");

        let text_only = r#"[{"type":"text","text":"hi"}]"#;
        sync_messages(
            &db,
            SESSION,
            &[SyncMessageInput {
                id: Some("a1".into()),
                role: "assistant".into(),
                text: String::new(),
                blocks: Some(text_only.into()),
            }],
        )
        .await
        .expect("sync");
        assert_eq!(
            blocks_of(&db, "a1").await.as_deref(),
            Some(raw.as_str()),
            "缺少内联告知的 cooked 载荷不得覆盖原始帧"
        );

        let cooked = serde_json::json!([
            { "type": "text", "text": "hi" },
            { "type": "system", "label": "system.permTimeout.auto", "noticeId": notice_id }
        ])
        .to_string();
        sync_messages(
            &db,
            SESSION,
            &[SyncMessageInput {
                id: Some("a1".into()),
                role: "assistant".into(),
                text: String::new(),
                blocks: Some(cooked.clone()),
            }],
        )
        .await
        .expect("sync");
        assert_eq!(
            blocks_of(&db, "a1").await.as_deref(),
            Some(cooked.as_str()),
            "载荷已带同 noticeId 时应正常收敛"
        );

        // 已 cooked 的行同样受保护（守卫识别 block.noticeId）。
        sync_messages(
            &db,
            SESSION,
            &[SyncMessageInput {
                id: Some("a1".into()),
                role: "assistant".into(),
                text: String::new(),
                blocks: Some(text_only.into()),
            }],
        )
        .await
        .expect("sync");
        assert_eq!(
            blocks_of(&db, "a1").await.as_deref(),
            Some(cooked.as_str()),
            "cooked 行里的内联告知也不得被缺少它的载荷覆盖"
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

    /// 定稿即写时长与速率/工具读数：消息行与累计必须同一次跃迁落地（拆开写会留下
    /// 「行已 complete 但时长未知」的半成品，前端会把它当 0 而不是缺失）。
    /// 定稿时刻（`finished_at`）与读数同一条 UPDATE 落库，回读原样。
    #[tokio::test]
    async fn finalize_message_records_turn_durations_and_reads_back() {
        let db = fresh_db().await;
        seed_row(&db, "row-a", "assistant", "OK", "2026-08-10T00:00:01Z").await;

        finalize_message(
            &db,
            "row-a",
            4200,
            800,
            Some(1500),
            Some(42.5),
            "2026-10-16T08:00:00+00:00",
        )
        .await
        .expect("finalize");

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        let row = page.rows.first().expect("一行");
        assert_eq!(row.status, "complete");
        assert_eq!(row.duration_ms, Some(4200));
        assert_eq!(row.wait_ms, Some(800));
        assert_eq!(row.tool_ms, Some(1500));
        assert_eq!(row.tps, Some(42.5));
        assert_eq!(row.finished_at.as_deref(), Some("2026-10-16T08:00:00+00:00"));
    }

    /// 工具跟踪越界失效（tool_ms = None）与「无速率」（tps = None）必须原样落为
    /// NULL 而不是 0——前端对 NULL 不渲染，对 0 的 tps 同样不渲染，但语义上
    /// 「失效」与「测得零」是两回事。
    #[tokio::test]
    async fn finalize_message_keeps_null_estimates_null() {
        let db = fresh_db().await;
        seed_row(&db, "row-b", "assistant", "OK", "2026-08-10T00:00:01Z").await;

        finalize_message(&db, "row-b", 1000, 0, None, None, "2026-10-16T08:00:00+00:00")
            .await
            .expect("finalize");

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        let row = page.rows.first().expect("一行");
        assert_eq!(row.tool_ms, None);
        assert_eq!(row.tps, None);
    }

    /// 迁移前的历史行没有结束时刻记录 → 时长必须是 NULL（未知），不得被读成 0。
    /// 工具耗时、速率与定稿时刻同理（NULL = 不可追溯）。
    #[tokio::test]
    async fn legacy_rows_read_back_with_unknown_duration() {
        let db = fresh_db().await;
        seed_row(&db, "row-old", "assistant", "很久以前", "2026-08-10T00:00:01Z").await;

        let page = list_messages_page(&db, SESSION, None, 10, usize::MAX).await.expect("page");
        let row = page.rows.first().expect("一行");
        assert_eq!(row.duration_ms, None, "无记录 ≠ 零耗时");
        assert_eq!(row.wait_ms, None);
        assert_eq!(row.tool_ms, None);
        assert_eq!(row.tps, None);
        assert_eq!(row.finished_at, None, "定稿时刻无记录 → NULL，前端该段不渲染");
    }

    /// 会话累计走**增量**：agent 子进程被 idle 回收后 restore 出新 client，第二个 turn
    /// 的时长必须叠在第一个之上而不是覆盖（计划 D7）。
    #[tokio::test]
    async fn accumulate_turn_increments_across_clients() {
        let db = fresh_db().await;

        accumulate_turn(&db, SESSION, 1000, 200).await.expect("turn 1");
        accumulate_turn(&db, SESSION, 500, 0).await.expect("turn 2");

        let totals: (i64, i64, i64, Option<String>) = sqlx::query_as(
            "SELECT work_ms, wait_ms, turn_count, last_turn_at FROM sessions WHERE id = ?",
        )
        .bind(SESSION)
        .fetch_one(&db)
        .await
        .expect("fetch totals");
        assert_eq!((totals.0, totals.1, totals.2), (1500, 200, 2), "两次 turn 应累加");
        assert!(totals.3.is_some(), "定稿时刻应随最后一次 turn 写入");
    }

    // ── 会话内全文检索（F06，计划 docs/dev/plans/2026-10-21-acp-chat-fulltext-search.md）──

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn search_matches_chinese_substring_without_tokenizer() {
        let db = fresh_db().await;
        seed_row(&db, "m1", "assistant", "上下文窗口很长", "2026-08-10T00:00:00Z").await;
        seed_row(&db, "m2", "user", "完全无关的内容", "2026-08-10T00:00:01Z").await;

        let result = search_session_messages(&db, SESSION, &terms(&["上下文"]), 1000, 1_000_000)
            .await
            .expect("search");
        assert_eq!(result.match_count, 1, "中文子串应命中（LIKE 天然支持，无需分词）");
        assert_eq!(result.hits[0].id, "m1");
        assert!(result.hits[0].snippet.contains("上下文"), "片段应含命中词");
        assert!(!result.truncated);
        assert!(!result.terms_truncated);
    }

    #[tokio::test]
    async fn search_multiple_terms_use_and_semantics() {
        let db = fresh_db().await;
        seed_row(&db, "m1", "assistant", "alpha beta", "2026-08-10T00:00:00Z").await;
        seed_row(&db, "m2", "assistant", "alpha gamma", "2026-08-10T00:00:01Z").await;

        let result =
            search_session_messages(&db, SESSION, &terms(&["alpha", "beta"]), 1000, 1_000_000)
                .await
                .expect("search");
        assert_eq!(result.match_count, 1, "多词应为 AND 语义（每个词都要在同一行出现）");
        assert_eq!(result.hits[0].id, "m1");
    }

    #[tokio::test]
    async fn search_escapes_like_wildcards() {
        let db = fresh_db().await;
        seed_row(&db, "m1", "assistant", "完成 100%", "2026-08-10T00:00:00Z").await;
        seed_row(&db, "m2", "assistant", "完成 100 分", "2026-08-10T00:00:01Z").await;
        seed_row(&db, "m3", "assistant", "a_b", "2026-08-10T00:00:02Z").await;
        seed_row(&db, "m4", "assistant", "axb", "2026-08-10T00:00:03Z").await;

        let pct = search_session_messages(&db, SESSION, &terms(&["100%"]), 1000, 1_000_000)
            .await
            .expect("search");
        assert_eq!(pct.match_count, 1, "`%` 必须当字面量匹配，不能变成通配符");
        assert_eq!(pct.hits[0].id, "m1");

        let under = search_session_messages(&db, SESSION, &terms(&["a_b"]), 1000, 1_000_000)
            .await
            .expect("search");
        assert_eq!(under.match_count, 1, "`_` 必须当字面量匹配");
        assert_eq!(under.hits[0].id, "m3");
    }

    #[tokio::test]
    async fn search_excludes_system_rows() {
        let db = fresh_db().await;
        seed_row(&db, "m1", "system", "权限回收告知", "2026-08-10T00:00:00Z").await;
        seed_row(&db, "m2", "assistant", "权限回收告知", "2026-08-10T00:00:01Z").await;

        let result = search_session_messages(&db, SESSION, &terms(&["权限回收"]), 1000, 1_000_000)
            .await
            .expect("search");
        assert_eq!(result.match_count, 1, "system 行是宿主内部事件，不该进搜索结果");
        assert_eq!(result.hits[0].id, "m2");
    }

    #[tokio::test]
    async fn search_reports_row_budget_truncation() {
        let db = fresh_db().await;
        for i in 0..5 {
            seed_row(
                &db,
                &format!("m{i}"),
                "assistant",
                "关键词",
                &format!("2026-08-10T00:00:0{i}Z"),
            )
            .await;
        }
        // 预算只允许扫 2 行 → 更早的行没参与检索，必须显式上报 truncated。
        let result = search_session_messages(&db, SESSION, &terms(&["关键词"]), 2, 1_000_000)
            .await
            .expect("search");
        assert!(result.truncated, "行数预算触顶必须显式标注（不能静默漏）");
        assert_eq!(result.scanned_rows, 2);
        assert_eq!(result.match_count, 2, "只应返回参与检索的行");
    }

    #[tokio::test]
    async fn search_reports_byte_budget_truncation() {
        let db = fresh_db().await;
        // 每行 ≈103 字节；预算 250 → 只能纳入 2 行（第三行会超）。
        let filler = "x".repeat(100);
        for i in 0..4 {
            seed_row(
                &db,
                &format!("m{i}"),
                "assistant",
                &format!("关键词{filler}"),
                &format!("2026-08-10T00:00:0{i}Z"),
            )
            .await;
        }
        let result = search_session_messages(&db, SESSION, &terms(&["关键词"]), 1000, 250)
            .await
            .expect("search");
        assert!(result.truncated, "字节预算触顶必须显式标注");
        assert_eq!(result.scanned_rows, 2, "只应纳入预算内的行");
        assert!(result.scanned_bytes <= 250);
    }

    #[tokio::test]
    async fn search_caps_term_count_and_reports_it() {
        let db = fresh_db().await;
        // 含前 8 个词、不含第 9 个词的一行：若实现错误地保留了全部 9 个词，这行不会命中。
        seed_row(&db, "m1", "assistant", "a b c d e f g h", "2026-08-10T00:00:00Z").await;
        let many = terms(&["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
        let result =
            search_session_messages(&db, SESSION, &many, 1000, 1_000_000).await.expect("search");
        assert!(result.terms_truncated, "超词数上限必须如实上报");
        assert_eq!(result.match_count, 1, "被丢弃的词不该参与匹配");
    }

    #[tokio::test]
    async fn search_hit_carries_parsable_location_cursor() {
        let db = fresh_db().await;
        seed_row(&db, "m1", "assistant", "命中内容", "2026-08-10T00:00:00Z").await;
        let result = search_session_messages(&db, SESSION, &terms(&["命中"]), 1000, 1_000_000)
            .await
            .expect("search");
        let cursor = MessageCursor::parse(&result.hits[0].cursor).expect("cursor 可解析");
        assert_eq!(cursor.id, "m1");
        assert_eq!(cursor.created_at, "2026-08-10T00:00:00Z");
    }

    #[tokio::test]
    async fn location_page_contains_target_row_as_newest() {
        let db = fresh_db().await;
        for i in 0..5 {
            seed_row(
                &db,
                &format!("m{i}"),
                "assistant",
                &format!("消息{i}"),
                &format!("2026-08-10T00:00:0{i}Z"),
            )
            .await;
        }
        let at = MessageCursor { created_at: "2026-08-10T00:00:02Z".into(), id: "m2".into() };
        // 页大小 2：目标行 + 更早的一行；再往前还有 m0 → 给游标让前端继续上翻。
        let page = list_messages_page_at(&db, SESSION, &at, 2, 1_000_000).await.expect("page");
        // 目标行是页内最新的一行（oldest-first 输出）。
        let ids: Vec<&str> = page.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2"]);
        assert_eq!(
            page.next_cursor.map(|c| c.id),
            Some("m1".to_string()),
            "next cursor 指向本页最旧行（上翻从这里接上）"
        );
    }

    #[tokio::test]
    async fn location_page_at_oldest_row_has_no_cursor() {
        let db = fresh_db().await;
        seed_row(&db, "m0", "assistant", "最老", "2026-08-10T00:00:00Z").await;
        seed_row(&db, "m1", "assistant", "更新", "2026-08-10T00:00:01Z").await;
        let at = MessageCursor { created_at: "2026-08-10T00:00:00Z".into(), id: "m0".into() };
        let page = list_messages_page_at(&db, SESSION, &at, 10, 1_000_000).await.expect("page");
        assert_eq!(page.rows.len(), 1);
        assert!(page.next_cursor.is_none(), "已到历史开头时不得给游标");
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
