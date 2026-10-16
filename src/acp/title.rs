//! agent 侧会话标题快照持久化。
//!
//! 数据来源两条（都不随 `session/load` 重放、broadcast 无补发，故必须落库）：
//! 1. **live 通知**：`session/update` 的 `session_info_update` 带 `title`
//!    （ACP §17.2）。实测只有 omp 会自动推送（首条消息后 LLM 生成 3-7 词标题），
//!    pi-acp 仅在用户敲 `/name` 后推，opencode / qodercli / codebuddy 从不推。
//! 2. **`session/list` 反查**：`SessionInfo.title`（ACP §17.1）。opencode /
//!    qodercli / pi-acp 有值，omp 部分缺省，codebuddy 整个方法 `-32601`。
//!
//! 多实现差异实测（2026-10-16）沉淀在 `docs/reference/acp-protocol-reference.md`
//! §17.4，**勿把单一实现的行为当约定**：title 是可选字段，可能缺省、可能是用户
//! 消息原文（pi-acp）、可能退化成 `New session - <时间>`（opencode 旧会话）。

use sqlx::SqlitePool;

/// 标题字节上限。侧栏行宽约 200px 且 CSS 已 `truncate`，512 字节覆盖任何现实
/// 标题（含 CJK）。**超限跳过而非截断**：截断要么静默（P1 禁止，下游无法区分
/// 「本来就短」与「被剔了」），要么把 `…(已省略 N 字符)` 这种内部标注渲染进
/// 侧栏——而超限标题本身就是异常的 agent 行为，保留上一次可用值比展示半句话
/// 诚实。与 `usage::MAX_USAGE_SNAPSHOT_BYTES` 同一策略。
pub const MAX_TITLE_BYTES: usize = 512;

/// 把 agent 下发的标题规范成「可展示的非空字符串」。
///
/// `None` = 无可用标题（agent 清除 / 空串 / 纯空白）。空串按「清除」处理而非
/// 原样落库：展示层渲染空串会得到一行空白，比回落宿主默认名更糟。
pub fn normalize_title(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 持久化 agent 侧标题（整体覆盖语义，只写 `agent_title` 列）。返回
/// `rows_affected`：0 = 被同值判据跳过（未产生写），调用方可据此留痕。
///
/// **绝不碰 `name`**：`name` 是用户手写名的唯一居所，本列只是展示兜底
/// （`name ?? agent_title ?? 宿主默认名`）。「用户命名不被覆盖」由该优先级 +
/// `name` 非空即手写这一 schema 级不变式共同保证，不依赖任何可能漂移的标记列。
///
/// `title = None` 表示 agent 主动清除（协议 §17.2：`null` 清除字段），同样落库。
/// 同值跳过用 SQL 层 NULL 安全的 `IS NOT` 比较，避免读回：agent 可能在一个
/// turn 内高频重推同一标题（omp 的 replan 重生成即如此）。失败仅 warn，不阻断
/// 实时帧透传。
pub async fn persist_title(db: &SqlitePool, session_id: &str, title: Option<&str>) -> u64 {
    // 规范化为 None 时也写库（清除语义），但纯空白不值得一次写——那与「从未
    // 收到过」在展示上完全等价，跳过可省掉无意义 UPDATE。
    let value = title.and_then(normalize_title);
    if title.is_some() && value.is_none() {
        return 0;
    }
    if let Some(v) = value
        && v.len() > MAX_TITLE_BYTES
    {
        tracing::warn!(
            session_id,
            bytes = v.len(),
            "agent 会话标题超过 {} 字节上限，跳过持久化（保留上一次可用值）",
            MAX_TITLE_BYTES
        );
        return 0;
    }
    match sqlx::query(
        "UPDATE sessions SET agent_title = ?1 WHERE id = ?2 AND agent_title IS NOT ?1",
    )
    .bind(value)
    .bind(session_id)
    .execute(db)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            tracing::warn!(session_id, "save agent session title failed: {}", e);
            0
        }
    }
}

/// [`backfill_from_list`] 的结果。
#[derive(Debug, Default)]
pub struct TitleSync {
    /// 实际发生写入的行数（同值/未纳管都不计）。
    pub written: usize,
    /// 本次列表里**已被 omniterm 纳管**的 `acp_session_id` 集合（「已纳管」徽标）。
    pub managed: std::collections::HashSet<String>,
}

/// 把 `session/list` 的结果按 `acp_session_id` 匹配回 omniterm 自己的会话行：
/// 回填 `agent_title`，同时报告哪些 id 已纳管。一次全量读同时喂两个输出。
///
/// 两条约束：
/// 1. **只回填、绝不按列表创建或删除会话行**——「发现 agent 侧历史」与「纳管」
///    是两个动作，混在一起会让一次列表拉取产生不可预期的库变更；
/// 2. **只写 `agent_title`**，`name`（用户手写名）不在本路径的写入集里。
///
/// 读一次全量 `(id, acp_session_id, agent_title)` 再在内存里对账，而不是逐条
/// `SELECT`：列表上限 200 条，逐条查是 200 次往返；而 omniterm 自己的会话数有限，
/// 一次全读 + 内存 HashMap 恒定两次 IO。
pub async fn backfill_from_list(
    db: &SqlitePool,
    sessions: &[agent_client_protocol::schema::v1::SessionInfo],
) -> TitleSync {
    let mut out = TitleSync::default();
    let rows: Vec<(String, String, Option<String>)> = match sqlx::query_as(
        "SELECT id, acp_session_id, agent_title FROM sessions WHERE acp_session_id IS NOT NULL",
    )
    .fetch_all(db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("backfill agent titles: 读会话行失败：{e}");
            return out;
        }
    };
    let existing: std::collections::HashMap<&str, (&str, Option<&str>)> = rows
        .iter()
        .map(|(id, sid, title)| (sid.as_str(), (id.as_str(), title.as_deref())))
        .collect();

    for info in sessions {
        let sid = info.session_id.0.as_ref();
        let Some((row_id, current)) = existing.get(sid).copied() else {
            continue; // agent 侧有、omniterm 侧没纳管——不代为建行
        };
        out.managed.insert(sid.to_string());
        // **title 缺省 ≠ 清除**：`SessionInfo.title` 是普通 `Option`，字段缺席就是
        // 「这个实现没给标题」（§8：omp 对部分会话不给）；而 `SessionInfoUpdate.title`
        // 是 `MaybeUndefined`，`Null` 才是协议规定的显式清除。两者不可混为一谈——
        // 把缺省当清除会让 omp 一拉列表就擦掉 live 通知刚写好的标题。
        // 空串同理：跳过而不清除。
        let agent_title = match info.title.as_deref().map(normalize_title) {
            Some(Some(t)) => t,
            _ => continue,
        };
        if Some(agent_title) == current {
            continue; // 同值，跳过（写放大防线）
        }
        out.written += persist_title(db, row_id, Some(agent_title)).await as usize;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_empty_and_whitespace_only() {
        assert_eq!(normalize_title(""), None);
        assert_eq!(normalize_title("   "), None);
        assert_eq!(normalize_title("\n\t "), None);
    }

    #[test]
    fn normalize_trims_surrounding_whitespace() {
        assert_eq!(normalize_title("  检查待提交改动 \n"), Some("检查待提交改动"));
    }

    #[test]
    fn normalize_keeps_interior_whitespace_verbatim() {
        // 标题可能含换行（pi-acp 直接拿用户首条消息当标题），内部空白原样保留，
        // 展示层负责折叠——这里不替展示层做决策。
        assert_eq!(normalize_title("第一行\n  第二行"), Some("第一行\n  第二行"));
    }

    /// 字节上限必须按字节而非字符：CJK 标题 3 字节/字，512 字节 ≈ 170 个汉字。
    /// 只做 `len()` 比较不做切片，故多字节中间不存在 panic 风险（P1：截断类
    /// 操作必须按字符边界切）。
    #[test]
    fn byte_limit_is_byte_based_not_char_based() {
        let cjk = "检".repeat(200); // 600 字节 / 200 字符
        assert!(cjk.len() > MAX_TITLE_BYTES);
        assert!(normalize_title(&cjk).is_some());
    }

    #[test]
    fn realistic_titles_fit_the_limit() {
        // 实测各 agent 标题的典型长度（含最长的 pi-acp 用户原话）。
        for t in [
            "检查待提交改动",
            "审查 ACP agent connection CPU spin 计划",
            "为什么acp会话常驻一个横向滚动条，实际上并没有什么超出边界的东西要使用",
            "New session - 2026-08-26T14:52:05.820Z",
        ] {
            assert!(t.len() <= MAX_TITLE_BYTES, "标题超限：{t}");
        }
    }

    // ---- 落库行为（DB 维度：同值跳过 / 超限跳过 / 清除语义）----

    async fn title_of(db: &sqlx::SqlitePool, session_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT agent_title FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(db)
            .await
            .expect("session row")
    }

    /// 写入 + 同值跳过。同值跳过不是优化而是**写放大防线**：omp 的 replan 会在
    /// 一个 turn 内重推同一标题，每次都 UPDATE 等于把「读一次列表」变成 N 次写。
    /// 跳过判据在 SQL 层（NULL 安全的 `IS NOT`），避免读回。
    #[tokio::test]
    async fn persist_writes_and_skips_identical_values() {
        let db = crate::acp::test_db::test_pool().await;
        assert_eq!(persist_title(&db, "s1", Some("标题 A")).await, 1, "首次写入应影响 1 行");
        assert_eq!(title_of(&db, "s1").await.as_deref(), Some("标题 A"));

        assert_eq!(
            persist_title(&db, "s1", Some("标题 A")).await,
            0,
            "同值必须被 SQL 层跳过（rows_affected=0），否则 agent 每帧重推就是一次写"
        );

        // 换值照常覆盖。
        assert_eq!(persist_title(&db, "s1", Some("标题 B")).await, 1);
        assert_eq!(title_of(&db, "s1").await.as_deref(), Some("标题 B"));

        // NULL → 有值 也是变化（清除语义），必须真的写。
        assert_eq!(persist_title(&db, "s1", None).await, 1);
        assert_eq!(title_of(&db, "s1").await, None);
        // 再次清除 NULL 是空操作。
        assert_eq!(persist_title(&db, "s1", None).await, 0);
    }

    /// 超限跳过而非截断：保留上一次可用值。截断要么静默（P1 禁止），要么把
    /// 「…已省略 N 字符」渲染进侧栏——而超限标题本身就是异常 agent 行为。
    #[tokio::test]
    async fn persist_skips_oversized_title_and_keeps_previous() {
        let db = crate::acp::test_db::test_pool().await;
        persist_title(&db, "s1", Some("上一个可用标题")).await;
        let huge = "x".repeat(MAX_TITLE_BYTES + 1);
        persist_title(&db, "s1", Some(&huge)).await;
        assert_eq!(
            title_of(&db, "s1").await.as_deref(),
            Some("上一个可用标题"),
            "超限标题必须被跳过，且不能清掉已有值"
        );
    }

    /// 恰好等于上限的标题必须被接受——上限是「含等于」的边界，写成 `>=` 会
    /// 无故丢掉最长的合法标题。
    #[tokio::test]
    async fn persist_accepts_title_exactly_at_the_limit() {
        let db = crate::acp::test_db::test_pool().await;
        let exact = "y".repeat(MAX_TITLE_BYTES);
        persist_title(&db, "s1", Some(&exact)).await;
        assert_eq!(title_of(&db, "s1").await.as_deref(), Some(exact.as_str()));
    }

    /// 纯空白按「无可用标题」处理：不写库（与「从未收到过」在展示上等价，
    /// 省一次无意义 UPDATE），但**不能清掉已有值**。
    #[tokio::test]
    async fn persist_ignores_whitespace_only_without_clearing() {
        let db = crate::acp::test_db::test_pool().await;
        persist_title(&db, "s1", Some("已有标题")).await;
        persist_title(&db, "s1", Some("   \n\t ")).await;
        assert_eq!(
            title_of(&db, "s1").await.as_deref(),
            Some("已有标题"),
            "纯空白不该被当成一次有效更新（更不该清掉已有值）"
        );
    }

    /// `None` = agent 主动清除（协议 §17.2 的 `null` 语义），必须落 NULL。
    /// 与「纯空白」的区别：一个是显式协议语义，一个是无信息输入。
    #[tokio::test]
    async fn persist_none_clears_the_snapshot() {
        let db = crate::acp::test_db::test_pool().await;
        persist_title(&db, "s1", Some("待清除")).await;
        persist_title(&db, "s1", None).await;
        assert_eq!(title_of(&db, "s1").await, None, "None 必须落 NULL（清除语义）");
    }

    /// `name` 永不被本路径触碰——这是「用户手写名不被 agent 自动标题覆盖」的
    /// 根保障（展示优先级只是第二道）。
    #[tokio::test]
    async fn persist_never_touches_the_user_supplied_name() {
        let db = crate::acp::test_db::test_pool().await;
        sqlx::query("UPDATE sessions SET name = '用户手写的名字' WHERE id = 's1'")
            .execute(&db)
            .await
            .expect("seed name");
        persist_title(&db, "s1", Some("agent 自动标题")).await;
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM sessions WHERE id = 's1'")
            .fetch_one(&db)
            .await
            .expect("session row");
        assert_eq!(name.as_deref(), Some("用户手写的名字"));
    }
}
