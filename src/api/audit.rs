//! 安全审计日志（S5）：敏感操作的落痕与有界查询。
//!
//! # 为什么单独一张表
//!
//! 放进 `settings` 表当 JSON 大列既不界也难查；只打 `tracing` 日志则用户
//! 不可查（日志轮转不在我们手里）。两者都否决，理由见计划 D4。
//!
//! # 写入点收敛（AGENTS §7①）
//!
//! 全部敏感操作经[`record`]这一个函数落库，**禁止任何 handler 自己拼 SQL**。
//! 同一判断/写入散在 ≥2 处必然漂移，这正是历史上「安全机制实现后未接入
//! 链路」的根因。
//!
//! # 有界性（§P1 双上限）
//!
//! | 维度 | 常量 | 超限策略 |
//! |------|------|----------|
//! | 条目数 | [`MAX_AUDIT_ROWS`] | 滚动删最旧（每次写入后修剪） |
//! | 单条 detail 字节数 | [`MAX_AUDIT_DETAIL_BYTES`] | 截断 + **显式标注省略量** + 按字符边界切 |
//!
//! 只限条目数不管单条大小 = 没限（§P1 案例 2 的教训：上限维度必须匹配真实
//! 增长维度）。反过来只限大小不管条数同样没限，故两个维度都要。
//!
//! # 只记成功操作（一致的取舍）
//!
//! 全部写入点只在**业务操作成功之后**调用[`record`]。失败的操作没有改变
//! 系统状态，「谁试过但没成功」对事后追查的增量价值低于它带来的复杂度
//! （每个 handler 的错误分支都要再插一次调用，极易漏）。若将来要审失败尝
//! 试，应作为独立动作（`*_failed`）统一加，**不要**在部分写入点加、部分
//! 不加——那会让「没记录」变成歧义信号。
//!
//! # 不在职责内
//!
//! * **不断言审计是否成功影响业务**：写库失败只记 warn，业务响应照常返回。
//!   审计是观测手段，不该让「查不到痕迹」升级为「功能不可用」——那会诱导
//!   调用方绕过审计（§S2 的边界）。
//! * **不提供删除/清空接口**：入口只有读。清理只由[`MAX_AUDIT_ROWS`] 滚动。

use serde::Deserialize;
use sqlx::SqlitePool;

/// 审计表最大条目数。超限时删除最旧行（滚动窗口）。
///
/// 取值依据：本表只收低频高危动作（写/删/传/push/配置变更/代理首访），
/// 正常使用一年远达不到此量；1k 条 × 单条约 300B ≈ 300KB，对 SQLite 无压力。
/// 真到量说明使用模式异常，那时该看的是「为什么」，而不是把上限调大。
pub const MAX_AUDIT_ROWS: i64 = 1000;

/// 读口一次返回的最大条目数（`GET /settings/audit-log` 的 limit 硬顶）。
///
/// 取 200：远小于 [`MAX_AUDIT_ROWS`]，保证单次响应体固定有界，
/// 与历史分页「每页字节预算」的思路一致（§P5：无界数据源的每个出口都要限）。
pub const MAX_AUDIT_READ_LIMIT: i64 = 200;

/// 读口未显式传 limit 时的默认条目数。
pub const DEFAULT_AUDIT_READ_LIMIT: i64 = 50;

/// 单条 `detail_json` 的字节上限（§P1）。超限按字符边界截断并在末尾显式
/// 标注省略量——静默截断会让下游无法区分「本来就短」与「被剔了」。
pub const MAX_AUDIT_DETAIL_BYTES: usize = 2048;

/// `target` 列的字节上限。路径往往比 detail 更值得保留完整，故给得更宽；
/// 仍须有界——路径长度由用户输入决定（§P1 外部输入）。
pub const MAX_AUDIT_TARGET_BYTES: usize = 1024;

/// 动作枚举。**不是自由文本**：UI 按此分类筛选，故必须稳定。
///
/// 新增动作时同步 `backend.md` 的「安全审计日志」表与前端分类（如有）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditAction {
    /// 文件写入（绝对路径 / allow_escape / 受限三分支合并记录）。
    FileWrite,
    /// 文件删除。
    FileDelete,
    /// 文件上传（一个请求含多个文件时记一条，detail 列文件名清单）。
    FileUpload,
    /// git push（**成功才记**：失败的推送没有改变远端状态，且 push 的失败
    /// 文案已由 git_error_response 返回给调用方；与 files 系列一致）。
    GitPush,
    /// 新增 agent 配置。
    AgentCreate,
    /// 修改 agent 配置。
    AgentUpdate,
    /// 删除 agent 配置。
    AgentDelete,
    /// 代理端口首次被访问（非「开通」：代理无原子开通事件，见计划 D4）。
    ProxyAccess,
}

impl AuditAction {
    /// 落库的稳定字符串值。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileWrite => "file_write",
            Self::FileDelete => "file_delete",
            Self::FileUpload => "file_upload",
            Self::GitPush => "git_push",
            Self::AgentCreate => "agent_create",
            Self::AgentUpdate => "agent_update",
            Self::AgentDelete => "agent_delete",
            Self::ProxyAccess => "proxy_access",
        }
    }
}

/// 调用者上下文：谁是调用者、来自哪里、作用于哪个工作区。
///
/// # actor 为什么带 IP
///
/// OmniTerm 是单人工具，JWT `sub` 恒为 `"admin"`（见 `auth::create_token`），
/// 单写 actor 等于每条记录都一样，回答不了「谁动的」。**区分度来自来源 IP**：
/// 多设备/误操作/被入侵三种场景下，`admin@192.168.1.7` 与 `admin@<外网IP>`
/// 的区别就是全部信息量。scope 进一步区分「对哪个会话/工作区动手」。
#[derive(Debug, Clone, Default)]
pub struct AuditContext {
    /// 身份标识，形如 `admin@192.168.1.7`；取不到 IP 时为 `admin@-`。
    pub actor: String,
    /// 可选范围限定：会话 id / 工作区 id / 端口号等，供筛选。
    pub scope: Option<String>,
}

impl AuditContext {
    /// 构造上下文。`ip` 为连接对端地址，取不到时 actor 退化为 `admin@-`
    /// （**不虚构 IP**：反代背后 `ConnectInfo` 给的是反代地址，如实记录；
    /// 127.0.0.1 之类的假值会让追查时误判来源）。
    pub fn from_ip(ip: Option<std::net::IpAddr>, scope: Option<String>) -> Self {
        let actor = match ip {
            Some(ip) => format!("admin@{ip}"),
            None => "admin@-".to_string(),
        };
        Self { actor, scope }
    }
}

/// 一条审计记录（读口返回形态）。
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct AuditEntry {
    pub id: i64,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub scope: Option<String>,
    pub detail_json: Option<String>,
    pub created_at: String,
}

/// 读口请求（`GET /settings/audit-log`）。
#[derive(Debug, Deserialize)]
pub struct AuditLogQuery {
    /// 返回条目数上限，缺省 [`DEFAULT_AUDIT_READ_LIMIT`]，硬顶
    /// [`MAX_AUDIT_READ_LIMIT`]（超限收敛而非拒绝：读口无副作用）。
    pub limit: Option<i64>,
}

/// 按 [`AuditLogQuery::limit`] 收敛后的实际读取条数（纯函数，便于穷举单测）。
pub fn effective_read_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_AUDIT_READ_LIMIT).clamp(1, MAX_AUDIT_READ_LIMIT)
}

/// 落一条审计记录并维持条目数上限。
///
/// # 失败语义
///
/// 写库失败只 `tracing::warn!` 后返回，**不向上传播**：调用方不得因为审计
/// 写失败就改变业务响应（否则「审计故障」会升级为「功能故障」，诱导绕过）。
/// 也不 `Result::ok()` 静默吞掉——warn 就是留给运维的痕迹（§S2：要么上抛到
/// 有意义的边界，要么记日志 + 显式降级，不掩盖根因）。
///
/// # 截断策略（§P1）
///
/// * `target` 超 [`MAX_AUDIT_TARGET_BYTES`]：保留前 N 字节（按字符边界）+ 尾部标注。
/// * `detail` 超 [`MAX_AUDIT_DETAIL_BYTES`]：保留并显式写入省略字符数。
///   截断后的 detail 形如 `{原 JSON}{"omitted_chars":N}` 前的省略标记，
///   由 [`truncate_detail`] 生成，下游可据此判断内容是否完整。
pub async fn record(
    pool: &SqlitePool,
    ctx: &AuditContext,
    action: AuditAction,
    target: &str,
    detail: Option<&str>,
) {
    let target = truncate_field(target, MAX_AUDIT_TARGET_BYTES);
    let detail = detail.map(|d| truncate_detail(d, MAX_AUDIT_DETAIL_BYTES));

    if let Err(e) = insert_audit(pool, ctx, action, &target, detail.as_deref()).await {
        tracing::warn!(
            action = action.as_str(),
            actor = %ctx.actor,
            error = %e,
            "audit write failed (业务响应不受影响，但该操作未留痕)"
        );
        return;
    }
    prune_old_rows(pool).await;
}

/// INSERT 一条审计行（修剪由调用方 [`record`] 在成功后另行执行）。
///
/// 插入与修剪是**两次独立 SQL，不在同一事务里**。正确性不依赖事务：
/// 修剪按「当前总数 − 上限」实时计算删除量，与插入顺序无关地收敛回上限。
/// 即便两路并发同时把表推到上限，各自多删或少删一条也只会在下一路写入时
/// 被再次修剪，**上界本身不会被击穿**。
///
/// 不用显式事务是取舍：审计写在业务热路径上，少一次锁持有就少一分干扰。
/// 若将来要求「插入与修剪严格原子」，改成事务是加强项而非修当前缺陷。
async fn insert_audit(
    pool: &SqlitePool,
    ctx: &AuditContext,
    action: AuditAction,
    target: &str,
    detail: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO audit_log (actor, action, target, scope, detail_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&ctx.actor)
    .bind(action.as_str())
    .bind(target)
    .bind(ctx.scope.as_deref())
    .bind(detail)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// 滚动删除最旧行，使条目数回到 [`MAX_AUDIT_ROWS`]。
///
/// 只在条目数真正超限时发 DELETE（常态零成本，不占写路径）。
async fn prune_old_rows(pool: &SqlitePool) {
    let over: i64 = sqlx::query_scalar("SELECT COUNT(*) - ? FROM audit_log")
        .bind(MAX_AUDIT_ROWS)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if over <= 0 {
        return;
    }

    // 按 id 删最旧 over 条（id 单调，比 created_at 更可靠：同一秒内多条记录
    // 的 created_at 相同，按它删会漏删/多删不确定行）。
    if let Err(e) = sqlx::query(
        "DELETE FROM audit_log WHERE id IN \
         (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)",
    )
    .bind(over)
    .execute(pool)
    .await
    {
        tracing::warn!("audit prune failed: {e}");
    }
}

/// 读取最近 N 条（新→旧）。
pub async fn list_recent(pool: &SqlitePool, limit: i64) -> Result<Vec<AuditEntry>, sqlx::Error> {
    sqlx::query_as::<_, AuditEntry>(
        "SELECT id, actor, action, target, scope, detail_json, created_at \
         FROM audit_log ORDER BY id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// 把字段截到 `max_bytes` 并按字符边界切，尾部标注省略量。
///
/// 返回的串**一定**是合法 UTF-8：`char_indices` 只会停在字符起点。
/// 标注形如 `…（已省略 N 字符）`——与 turn_accumulator 的中段折叠标记风格
/// 一致，读的人一看就知道内容被截过、截了多少。
fn truncate_field(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut kept = String::with_capacity(max_bytes);
    let mut omitted = 0usize;
    for ch in s.chars() {
        // 预留尾部标注的字节空间，避免「截完再标注又把上限破掉」。
        if kept.len() + ch.len_utf8() > max_bytes.saturating_sub(OMISSION_TAG_BYTES) {
            omitted += 1;
            continue;
        }
        kept.push(ch);
    }
    // omitted 统计的是「被跳过的字符数」；串尾被跳过的字符可能不止 omitted 个
    // 已计入，但标签里的 N 需与真实省略量一致——上面 continue 时已逐个计入。
    format!("{kept}{OMISSION_TAG_PREFIX}{omitted}{OMISSION_TAG_SUFFIX}")
}

/// `detail` 超 [`MAX_AUDIT_DETAIL_BYTES`] 时的截断。
///
/// detail 是 JSON 文本。**不能**往里塞中文标签（会让它不再是合法 JSON），
/// 也不能简单丢弃后半段就完事——那样下游无法区分「本来就到此结束」与「被
/// 剔了」。策略：保留头部片段，随后追加一个**独立可解析**的省略字段
/// `,"__omitted_chars__":N}`，使结果**始终**是合法 JSON 的一部分：
///
/// * 保留段恰好在字段边界结束 ⇒ 结果就是合法 JSON；
/// * 保留段落在 JSON 中间 ⇒ 结果是「被截断的 JSON 片段 + 省略字段」，
///   读口按文本展示，不承诺可 parse（但省略量仍然显式可读）。
///
/// 省略量按**字符数**计（与[`truncate_field`]一致），守恒断言见单测。
fn truncate_detail(detail: &str, max_bytes: usize) -> String {
    if detail.len() <= max_bytes {
        return detail.to_string();
    }
    let mut kept = String::with_capacity(max_bytes);
    let mut omitted = 0usize;
    for ch in detail.chars() {
        if kept.len() + ch.len_utf8() > max_bytes {
            omitted += 1;
        } else {
            kept.push(ch);
        }
    }
    format!("{kept},\"__omitted_chars__\":{omitted}}}")
}

/// `truncate_field` 尾部标注的前缀（含省略号）。
const OMISSION_TAG_PREFIX: &str = "…(truncated ";
/// `truncate_field` 尾部标注的后缀。
const OMISSION_TAG_SUFFIX: &str = " chars omitted)";
/// 尾部标注自身的长度：截断时必须给它留位置，否则标注会把字段顶回超限。
const OMISSION_TAG_BYTES: usize = OMISSION_TAG_PREFIX.len() + OMISSION_TAG_SUFFIX.len() + 4;

#[cfg(test)]
mod tests {
    use super::*;

    // ── 读口 limit 收敛 ──

    #[test]
    fn read_limit_defaults_when_absent() {
        assert_eq!(effective_read_limit(None), DEFAULT_AUDIT_READ_LIMIT);
    }

    #[test]
    fn read_limit_clamps_to_hard_cap() {
        assert_eq!(effective_read_limit(Some(i64::MAX)), MAX_AUDIT_READ_LIMIT);
        assert_eq!(effective_read_limit(Some(1_000_000)), MAX_AUDIT_READ_LIMIT);
    }

    #[test]
    fn read_limit_clamps_non_positive_to_one() {
        // 0 / 负数不得变成「返回空」也不得 panic：收敛到 1 条。
        assert_eq!(effective_read_limit(Some(0)), 1);
        assert_eq!(effective_read_limit(Some(-5)), 1);
    }

    #[test]
    fn read_limit_keeps_normal_value() {
        assert_eq!(effective_read_limit(Some(20)), 20);
    }

    // ── 截断：字符边界（§P1） ──

    #[test]
    fn truncate_field_keeps_short_values_verbatim() {
        assert_eq!(truncate_field("abc", 1024), "abc");
        // 恰好等于上限不动。
        assert_eq!(truncate_field(&"a".repeat(1024), 1024), "a".repeat(1024));
    }

    #[test]
    fn truncate_field_cuts_multibyte_on_char_boundary() {
        // 每个「中」3 字节。上限 10 ⇒ 能放 3 个（9B）+ 标注空间，
        // 绝不允许 panic（Rust 字节索引切在字符中间会直接崩）。
        let input = "中".repeat(50);
        let out = truncate_field(&input, 10);
        assert!(out.ends_with(OMISSION_TAG_SUFFIX), "got: {out}");
        assert!(out.contains(OMISSION_TAG_PREFIX));
        // 保留下来的主体部分不含半个字：重新 parse 得到的长度应 < 输入。
        assert!(out.len() < input.len());
    }

    #[test]
    fn truncate_field_marks_omitted_amount() {
        let input = "a".repeat(MAX_AUDIT_TARGET_BYTES + 100);
        let out = truncate_field(&input, MAX_AUDIT_TARGET_BYTES);
        // 从标注里取省略量：标注固定在串尾，形如 `…(truncated N chars omitted)`。
        let (kept_part, tag) = out.rsplit_once(OMISSION_TAG_PREFIX).expect("标注前缀必须逐字固定");
        let omitted: usize = tag
            .strip_suffix(OMISSION_TAG_SUFFIX)
            .expect("标注后缀必须逐字固定")
            .parse()
            .expect("省略量应可解析");
        // 只在保留段里数 'a'——整串计数会把标签里的 `trunc**a**ted` 算进来。
        let kept = kept_part.chars().filter(|c| *c == 'a').count();
        assert_eq!(kept + omitted, input.len(), "截断必须守恒");
        assert!(omitted > 0, "必须报告实际省略量");
    }

    #[test]
    fn truncate_detail_reports_exact_omitted_chars() {
        // 守恒（§P1）：detail 的省略量必须与实际丢弃的字符数一致。
        let input = "b".repeat(MAX_AUDIT_DETAIL_BYTES + 37);
        let out = truncate_detail(&input, MAX_AUDIT_DETAIL_BYTES);
        let kept = out.chars().filter(|c| *c == 'b').count();
        let omitted: usize = out
            .rsplit("\"__omitted_chars__\":")
            .next()
            .and_then(|tail| tail.trim_end_matches('}').parse().ok())
            .expect("省略字段应可解析");
        assert_eq!(kept + omitted, input.len());
        assert_eq!(omitted, 37);
    }

    #[test]
    fn truncate_detail_cuts_multibyte_without_panic() {
        // 复现 Phase 3 blocker B1 的同型：字节索引切在字符中间即 panic。
        let input = "中".repeat(MAX_AUDIT_DETAIL_BYTES / 3 + 50);
        let out = truncate_detail(&input, MAX_AUDIT_DETAIL_BYTES);
        assert!(!out.is_empty());
        assert!(out.len() > MAX_AUDIT_DETAIL_BYTES || out.ends_with('}'));
    }

    #[test]
    fn truncate_detail_keeps_short_values_verbatim() {
        let d = r#"{"path":"x"}"#;
        assert_eq!(truncate_detail(d, MAX_AUDIT_DETAIL_BYTES), d);
    }

    // ── 动作枚举稳定性 ──

    #[test]
    fn action_strings_are_stable_snake_case() {
        // 这些字符串会落库且前端按它分类：改名等于改协议，须显式。
        let all = [
            (AuditAction::FileWrite, "file_write"),
            (AuditAction::FileDelete, "file_delete"),
            (AuditAction::FileUpload, "file_upload"),
            (AuditAction::GitPush, "git_push"),
            (AuditAction::AgentCreate, "agent_create"),
            (AuditAction::AgentUpdate, "agent_update"),
            (AuditAction::AgentDelete, "agent_delete"),
            (AuditAction::ProxyAccess, "proxy_access"),
        ];
        for (action, s) in all {
            assert_eq!(action.as_str(), s);
        }
    }

    // ── actor 构造 ──

    #[test]
    fn actor_uses_ip_for_discrimination() {
        let ctx = AuditContext::from_ip(Some("192.168.1.7".parse().unwrap()), None);
        assert_eq!(ctx.actor, "admin@192.168.1.7");
    }

    #[test]
    fn actor_degrades_without_inventing_ip() {
        // 取不到对端地址时如实写 `-`，不填 127.0.0.1 之类的假值。
        let ctx = AuditContext::from_ip(None, None);
        assert_eq!(ctx.actor, "admin@-");
    }

    // ── DB 级：条目上限与滚动删除（§P1） ──

    /// 内存 sqlite + 全部迁移（audit_log 表在内）。
    async fn test_db() -> sqlx::SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations").run(&db).await.expect("run migrations");
        db
    }

    /// 并发上限测试专用池：连接数 >1 才会真的并发——1 连接的池会把各 task
    /// 串行化，那样测不出「插入与修剪不在同一事务」路径下的竞争。
    async fn concurrent_test_db() -> sqlx::SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations").run(&db).await.expect("run migrations");
        db
    }

    fn ctx() -> AuditContext {
        AuditContext::from_ip(Some("10.0.0.9".parse().unwrap()), Some("session:s1".into()))
    }

    #[tokio::test]
    async fn record_persists_actor_action_target_scope_and_detail() {
        let db = test_db().await;
        record(&db, &ctx(), AuditAction::FileWrite, "/tmp/x", Some(r#"{"n":1}"#)).await;

        let rows = list_recent(&db, 10).await.expect("list");
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.actor, "admin@10.0.0.9");
        assert_eq!(r.action, "file_write");
        assert_eq!(r.target, "/tmp/x");
        assert_eq!(r.scope.as_deref(), Some("session:s1"));
        assert_eq!(r.detail_json.as_deref(), Some(r#"{"n":1}"#));
        assert!(!r.created_at.is_empty(), "created_at 必须落库");
    }

    #[tokio::test]
    async fn row_count_never_exceeds_cap_and_oldest_are_dropped() {
        let db = test_db().await;
        // 写上限 + 20 条，再确认库里**恰好**剩上限条（§P1：超限策略与宣称一致）。
        let total = MAX_AUDIT_ROWS + 20;
        for i in 0..total {
            record(&db, &ctx(), AuditAction::FileWrite, &format!("/tmp/f{i}"), None).await;
        }

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(count, MAX_AUDIT_ROWS, "条目数须恰为上限，不得超出");

        // 保留的须是**最新**的那批：最早 20 条（f0..f19）应已被删。
        let rows = list_recent(&db, MAX_AUDIT_ROWS).await.expect("list");
        assert_eq!(rows.len(), MAX_AUDIT_ROWS as usize);
        assert_eq!(rows[0].target, format!("/tmp/f{}", total - 1), "第一条应是最新写入的");
        let oldest = rows.last().expect("last").target.clone();
        assert_eq!(oldest, "/tmp/f20", "最老一条应为第 21 条（前 20 条已淘汰）");
    }

    #[tokio::test]
    async fn under_cap_nothing_is_pruned() {
        let db = test_db().await;
        // 未超限时不得发 DELETE：常态写路径零额外成本。
        for i in 0..(MAX_AUDIT_ROWS - 1) {
            record(&db, &ctx(), AuditAction::FileWrite, &format!("/tmp/f{i}"), None).await;
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(count, MAX_AUDIT_ROWS - 1);
    }

    #[tokio::test]
    async fn oversized_detail_is_truncated_before_insert() {
        let db = test_db().await;
        // detail 超上限时落库的必须是截断版，且带显式省略量（§P1）。
        let huge = "z".repeat(MAX_AUDIT_DETAIL_BYTES * 3);
        record(&db, &ctx(), AuditAction::FileUpload, "/tmp/u", Some(&huge)).await;

        let rows = list_recent(&db, 1).await.expect("list");
        let stored = rows[0].detail_json.as_deref().expect("detail");
        assert!(stored.len() < huge.len(), "落库值必须被截断");
        assert!(stored.contains("\"__omitted_chars__\":"), "截断必须显式标注省略量，got: {stored}");
    }

    #[tokio::test]
    async fn empty_target_is_stored_as_empty_string() {
        // target 列 NOT NULL：空串是合法值（如上传到根目录），不得 panic 或丢行。
        let db = test_db().await;
        record(&db, &ctx(), AuditAction::FileUpload, "", None).await;
        let rows = list_recent(&db, 1).await.expect("list");
        assert_eq!(rows[0].target, "");
    }

    #[tokio::test]
    async fn scope_is_null_when_unbound() {
        let db = test_db().await;
        // 无显式绑定的请求（如 git push 之外的裸调用）scope 落 NULL。
        let unbound = AuditContext::from_ip(Some("10.0.0.9".parse().unwrap()), None);
        record(&db, &unbound, AuditAction::FileWrite, "/tmp/x", None).await;
        let rows = list_recent(&db, 1).await.expect("list");
        assert_eq!(rows[0].scope, None);
    }

    #[tokio::test]
    async fn concurrent_writers_never_breach_the_cap() {
        // 上限不被击穿的实证：插入与修剪不是同一事务（见 insert_audit 注释），
        // 这里用并发写入证明「不事务」也不会让条目数越过上限。
        // 连接数 4 的池：多个 writer task 才会真的竞争（单连接池会串行化，
        // 测不到竞争路径）。写入总量必须显著超过上限，否则修剪压根不触发。
        let db = std::sync::Arc::new(concurrent_test_db().await);
        let per_writer = MAX_AUDIT_ROWS / 2 + 50; // 2 writer × 550 = 1100 > 1000
        let mut handles = Vec::new();
        for w in 0..2u16 {
            let db = db.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..per_writer {
                    let ctx = AuditContext::from_ip(
                        Some(format!("10.0.0.{w}").parse().unwrap()),
                        Some(format!("session:w{w}")),
                    );
                    record(&db, &ctx, AuditAction::FileWrite, &format!("/tmp/w{w}-{i}"), None)
                        .await;
                }
            }));
        }
        for h in handles {
            h.await.expect("writer task");
        }

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&*db)
            .await
            .expect("count");
        assert_eq!(count, MAX_AUDIT_ROWS, "并发写下限必须仍然恰好收敛到上限");
    }

    #[tokio::test]
    async fn list_recent_returns_newest_first() {
        let db = test_db().await;
        for i in 0..3 {
            record(&db, &ctx(), AuditAction::FileWrite, &format!("/tmp/f{i}"), None).await;
        }
        let rows = list_recent(&db, 2).await.expect("list");
        assert_eq!(rows.len(), 2, "limit 必须被遵守（读口有界）");
        assert_eq!(rows[0].target, "/tmp/f2");
        assert_eq!(rows[1].target, "/tmp/f1");
    }
}
