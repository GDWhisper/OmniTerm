use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::Duration;

use sqlx::sqlite::SqlitePool;
use tokio::time::interval;

use crate::acp::chat_persistence;
use crate::acp::client::{AcpClient, SystemNotice, TurnEndEvent};
use crate::acp::permission::{
    MAX_PERM_NOTICE_REQUESTS, PermissionRequestSummary, pick_auto_option,
    summarize_permission_request,
};
use crate::acp::supervisor::AcpSupervisor;

/// 静默待命回收阈值（秒）默认值：无进行中 prompt、无未决权限、且距最后活动满 5 分钟即回收。
/// 实际阈值可由 `run_reaper` 的 `Arc<AtomicU64>` 在运行时覆盖（main.rs 从 settings 表注入），
/// 此常量作为 DB 无配置时的兜底默认值。
pub const IDLE_RECYCLE_SECS: u64 = 300;

/// 权限请求无响应兜底阈值（秒）默认值：有未决权限但久无活动满 30 分钟则按
/// [`PermissionTimeoutMode`] 行动（默认取消并回收）。实际阈值与模式均可由
/// settings 表运行时覆盖（main.rs 注入 `PermissionTimeoutConfig`），此常量作为
/// DB 无配置时的兜底默认值。
/// 注：PermissionManager 不做超时自动应答（ACP 规范 Cancelled 仅用于
/// session/cancel 语义，且审批须等真人决策），此为无人应答时的唯一兜底。
pub const REQUIRES_ACTION_RECYCLE_SECS: u64 = 1800;

/// prompt 卡死兜底阈值（秒）：有进行中 prompt 但久无 agent 通知满 10 分钟，
/// 强制定稿 turn 并广播结束。兜底不发送 PromptResponse 的 agent（§8 多实现兼容）。
/// 定稿后下一轮 idle 检查会按常规回收进程。
pub const PROMPT_STALE_SECS: u64 = 600;

/// 看护任务扫描间隔（秒）。
const TICK_SECS: u64 = 30;

/// 权限超时「超时中止」行动写入会话的 system 消息 label（i18n key；前端未命中
/// key 时原样显示，2026-08-18 起的历史中文数据靠该回退保持可读）。
pub const SYSTEM_LABEL_PERM_TIMEOUT_ABORT: &str = "system.permTimeout.abort";

/// 权限超时「自动推进」行动写入会话的 system 消息 label（i18n key）。
pub const SYSTEM_LABEL_PERM_TIMEOUT_AUTO: &str = "system.permTimeout.auto";

/// 权限请求超时后的行为模式（settings 表 `acp_perm_timeout_mode`，线格式为
/// 小写字符串；`Abort` 为默认，保留 2026-08-18 起的安全策略）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionTimeoutMode {
    /// 超时取消请求并回收会话（agent 终止）——默认。
    #[default]
    Abort,
    /// 超时自动代替用户应答未决审批，agent 继续执行（不 cancel、不杀会话）。
    Auto,
    /// 一直等待：权限未决期间不做任何超时动作（含 prompt-stale 定稿）。
    Wait,
}

impl PermissionTimeoutMode {
    /// 线格式（API / settings 表存储值，白名单校验用）。
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionTimeoutMode::Abort => "abort",
            PermissionTimeoutMode::Auto => "auto",
            PermissionTimeoutMode::Wait => "wait",
        }
    }

    /// 从线格式解析；非白名单值（含空/大小写不符）返回 `None`，调用方回退默认。
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.trim() {
            "abort" => Some(PermissionTimeoutMode::Abort),
            "auto" => Some(PermissionTimeoutMode::Auto),
            "wait" => Some(PermissionTimeoutMode::Wait),
            _ => None,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            PermissionTimeoutMode::Abort => 0,
            PermissionTimeoutMode::Auto => 1,
            PermissionTimeoutMode::Wait => 2,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => PermissionTimeoutMode::Auto,
            2 => PermissionTimeoutMode::Wait,
            _ => PermissionTimeoutMode::Abort,
        }
    }
}

/// 权限超时配置（模式 + 秒级阈值）。原子字段使 reaper 每个 tick 读到最新值
/// （PUT 路由热更新，无需重启）；`Default` 即 [`PermissionTimeoutMode::Abort`]
/// + [`REQUIRES_ACTION_RECYCLE_SECS`]，与 DB 无配置时的行为一致。
#[derive(Debug)]
pub struct PermissionTimeoutConfig {
    mode: AtomicU8,
    secs: AtomicU64,
}

impl Default for PermissionTimeoutConfig {
    fn default() -> Self {
        Self::new(PermissionTimeoutMode::Abort, REQUIRES_ACTION_RECYCLE_SECS)
    }
}

impl PermissionTimeoutConfig {
    pub fn new(mode: PermissionTimeoutMode, secs: u64) -> Self {
        Self { mode: AtomicU8::new(mode.as_u8()), secs: AtomicU64::new(secs) }
    }

    /// 读取当前 (模式, 秒级阈值)。
    pub fn snapshot(&self) -> (PermissionTimeoutMode, u64) {
        (
            PermissionTimeoutMode::from_u8(self.mode.load(Ordering::Relaxed)),
            self.secs.load(Ordering::Relaxed),
        )
    }

    /// 热更新（PUT 路由写入后调用；reaper 下一 tick 即生效）。
    pub fn store(&self, mode: PermissionTimeoutMode, secs: u64) {
        self.mode.store(mode.as_u8(), Ordering::Relaxed);
        self.secs.store(secs, Ordering::Relaxed);
    }
}

/// 超时行动前写入聊天并广播的系统消息：`label` 为 i18n key，`text` 为中文兜底
/// 文案（`text` 列，与 2026-08-18 起的 system 行语义一致），`detail` 供前端
/// 本地化渲染\"错过了什么\"（请求工具/内容预览/可选项/实际动作）。
struct PermissionTimeoutNotice {
    label: &'static str,
    text: String,
    detail: serde_json::Value,
}

/// 把请求摘要拼成一行中文说明（text 列用；前端渲染走 detail + i18n）。
fn format_request_line(summary: &PermissionRequestSummary) -> String {
    let tool = match (&summary.tool, &summary.kind) {
        (Some(t), Some(k)) if t != k => format!("{t}（{k}）"),
        (Some(t), _) => t.clone(),
        (None, Some(k)) => k.clone(),
        (None, None) => "未知工具".to_string(),
    };
    let mut parts = vec![format!("请求：{tool}")];
    if let Some(content) = &summary.content {
        let mut line = format!("内容：{content}");
        if summary.content_omitted > 0 {
            line.push_str(&format!("…（已省略 {} 字符）", summary.content_omitted));
        }
        parts.push(line);
    }
    if !summary.options.is_empty() {
        parts.push(format!("可选项：{}", summary.options.join(" / ")));
    }
    parts.join("；")
}

/// 组装「超时中止」告知：取消 + 回收前让用户知道错过了哪笔请求、当时有哪些选项。
fn build_perm_notice_abort(
    summaries: &[PermissionRequestSummary],
    extra: usize,
    minutes: u64,
) -> PermissionTimeoutNotice {
    let mut text = format!(
        "权限请求 {minutes} 分钟未获响应，系统已自动取消该请求并回收会话（agent 已终止）。可重新打开会话继续。"
    );
    for s in summaries {
        text.push(' ');
        text.push_str(&format_request_line(s));
    }
    if extra > 0 {
        text.push_str(&format!("（另有 {extra} 项审批一并取消）"));
    }
    PermissionTimeoutNotice {
        label: SYSTEM_LABEL_PERM_TIMEOUT_ABORT,
        text,
        detail: detail_json(summaries.first(), None, minutes, extra),
    }
}

/// 组装「自动推进」告知：代替用户选了哪个选项、原请求是什么。
fn build_perm_notice_auto(
    summary: &PermissionRequestSummary,
    selected: &str,
    minutes: u64,
) -> PermissionTimeoutNotice {
    let mut text =
        format!("权限请求 {minutes} 分钟未获响应，已按设置自动选择「{selected}」继续执行。");
    text.push(' ');
    text.push_str(&format_request_line(summary));
    PermissionTimeoutNotice {
        label: SYSTEM_LABEL_PERM_TIMEOUT_AUTO,
        text,
        detail: detail_json(Some(summary), Some(selected), minutes, 0),
    }
}

fn detail_json(
    summary: Option<&PermissionRequestSummary>,
    selected: Option<&str>,
    minutes: u64,
    extra: usize,
) -> serde_json::Value {
    serde_json::json!({
        "minutes": minutes,
        "tool": summary.and_then(|s| s.tool.clone()),
        "kind": summary.and_then(|s| s.kind.clone()),
        "content": summary.and_then(|s| s.content.clone()),
        "content_omitted": summary.map_or(0, |s| s.content_omitted),
        "options": summary.map(|s| s.options.clone()).unwrap_or_default(),
        "selected": selected,
        "extra": extra,
    })
}

/// 落库（刷新后 hydrate 仍可见）+ 广播给在线 WS 连接（shutdown/cancel 前连接仍存活）。
async fn persist_and_broadcast(
    db: &SqlitePool,
    session_id: &str,
    client: &AcpClient,
    notice: &PermissionTimeoutNotice,
) {
    let blocks = serde_json::json!([
        { "type": "system", "label": notice.label, "detail": notice.detail }
    ])
    .to_string();
    if let Err(e) =
        chat_persistence::insert_message(db, session_id, "system", &notice.text, Some(&blocks))
            .await
    {
        tracing::warn!(
            session_id = %session_id,
            error = %e,
            "reaper: failed to persist permission-timeout system message"
        );
    }
    client.notify_system_message(SystemNotice {
        label: notice.label.to_string(),
        detail: Some(notice.detail.clone()),
    });
}

/// 自动推进：代替用户应答全部未决审批（不 cancel、不杀会话，agent 继续执行），
/// 并为每笔被应答的请求落一条带详情的 system 消息（§P1：消息数受
/// [`MAX_PERM_NOTICE_REQUESTS`] 限制，超出的笔数只应答不再逐条告知）。
///
/// 返回是否至少成功应答一项；一项都解析不出（agent 发了无合法选项的请求）时
/// 返回 `false`，调用方降级为超时中止——不能解析就绝不瞎猜，也不能永久挂起。
async fn auto_advance_permissions(
    db: &SqlitePool,
    session_id: &str,
    client: &AcpClient,
    minutes: u64,
) -> bool {
    let events = client.pending_permission_events().await;
    let mut resolved = 0usize;
    for event in &events {
        let Some((option_id, selected)) = pick_auto_option(&event.request) else {
            tracing::warn!(
                session_id = %session_id,
                "reaper: permission request has no selectable option; skipping auto-advance for it"
            );
            continue;
        };
        if !client.resolve_permission(&event.id, &option_id).await {
            // 已被其他路径（用户点击 / cancel_all）解决，无需再告知。
            continue;
        }
        resolved += 1;
        if resolved > MAX_PERM_NOTICE_REQUESTS {
            continue;
        }
        let summary = summarize_permission_request(&event.request);
        let notice = build_perm_notice_auto(&summary, &selected, minutes);
        persist_and_broadcast(db, session_id, client, &notice).await;
    }
    if resolved > MAX_PERM_NOTICE_REQUESTS {
        tracing::warn!(
            session_id = %session_id,
            resolved,
            cap = MAX_PERM_NOTICE_REQUESTS,
            "reaper: auto-advance resolved more permissions than the notice cap; extra ones answered without a chat notice"
        );
    }
    resolved > 0
}

/// 空闲回收看护任务。
///
/// 周期性遍历 supervisor 中所有 ACP client，按后端可观测的活跃度信号决定回收：
/// - idle 超时（静默待命）→ 强制 `shutdown` kill 子进程
/// - 权限请求超时无响应（requires_action 但无人应答）→ 按 [`PermissionTimeoutMode`]
///   行动：`Abort` 先取消再 kill（原安全策略）；`Auto` 代替用户应答让 agent 继续；
///   `Wait` 不做任何动作（含跳过下面的 prompt-stale 定稿）
/// - prompt 卡死（有进行中 prompt 但久无通知）→ 强制定稿 turn，不杀进程
///
/// 活跃判定逻辑见 `AcpClient::is_idle_stale` / `is_permission_stale` / `is_prompt_stale`。
/// 进程所有权在后端，回收即 kill 子进程、释放内存。`shutdown` 走 shared reference，
/// 即使 WS 连接仍持有 `Arc<AcpClient>` 也会立即触发连接任务退出、杀子进程，保证
/// supervisor 移除与进程死亡同步（否则 Sidebar 的 `acp_process_alive` 与实际进程
/// 存活脱节）。
///
/// `idle_recycle_secs` 为共享的 idle 回收阈值（秒）：main.rs 从 settings 表读取
/// `acp_idle_recycle_min` 换算后注入，可在运行时热更新。每个 tick 判定前动态
/// `load`，改动无需重启即可生效；缺省兜底见 [`IDLE_RECYCLE_SECS`]。
///
/// `perm_timeout` 为共享的权限超时配置（模式 + 秒级阈值）：main.rs 从 settings 表
/// 读取 `acp_perm_timeout_mode` / `acp_perm_timeout_min` 注入，运行时热更新；
/// 缺省兜底见 [`PermissionTimeoutConfig::default`]。
///
/// `db` 用于权限超时行动时写入 system 告知消息（agent 被取消/被自动应答的原因，
/// 用户刷新会话后仍可见）；idle 回收（用户完全不用）不写。
pub async fn run_reaper(
    supervisor: AcpSupervisor,
    db: SqlitePool,
    idle_recycle_secs: Arc<AtomicU64>,
    perm_timeout: Arc<PermissionTimeoutConfig>,
) {
    let mut ticker = interval(Duration::from_secs(TICK_SECS));
    loop {
        ticker.tick().await;

        // 1) 快照 + 判定（不在持锁状态下做 async 回收）
        // idle / 权限超时阈值每次判定前动态读取，使运行时改配置即时生效。
        let idle_secs = idle_recycle_secs.load(Ordering::Relaxed);
        let (perm_mode, perm_secs) = perm_timeout.snapshot();
        let mut to_reap: Vec<(String, bool /*perm_stale*/)> = Vec::new();
        for (sid, client) in supervisor.snapshot().await {
            if client.is_idle_stale(idle_secs).await {
                to_reap.push((sid, false));
                continue;
            }
            let pending = client.pending_permissions().await;
            if pending > 0 && client.is_permission_stale(perm_secs).await {
                match perm_mode {
                    PermissionTimeoutMode::Wait => {
                        // 一直等待：权限未决期间不做任何超时动作。回合保持
                        // \"等审批\"语义，用户回来时 banner 由 pending_events
                        // 重放恢复（见 ws/acp.rs 连接重放）。
                    }
                    PermissionTimeoutMode::Auto => {
                        if !auto_advance_permissions(&db, &sid, &client, perm_secs / 60).await {
                            // 一个选项都解析不出来：不能永久挂起，降级为超时中止。
                            tracing::warn!(
                                session_id = %sid,
                                "reaper: auto-advance found no selectable option; falling back to abort"
                            );
                            to_reap.push((sid, true));
                        }
                    }
                    PermissionTimeoutMode::Abort => to_reap.push((sid, true)),
                }
                continue;
            }
            if perm_mode == PermissionTimeoutMode::Wait && pending > 0 {
                // wait 模式下未超时的未决审批同样跳过 prompt-stale：把\"等审批\"\
                // 的回合误判为卡死会强制作废并广播结束，与用户随后的应答产生竞态。
                continue;
            }
            if client.is_prompt_stale(PROMPT_STALE_SECS) {
                tracing::warn!(
                    session_id = %sid,
                    "prompt active but no agent activity for {}s; force-finalizing turn",
                    PROMPT_STALE_SECS
                );
                client.mark_prompt_idle();
                client.notify_turn_end(TurnEndEvent::Done {
                    stop_reason: "InactivityTimeout".into(),
                    row_id: client.turn_row_id(),
                    duration: client.turn_timing(),
                });
            }
        }

        // 2) 回收
        for (sid, perm_stale) in to_reap {
            if let Some(client) = supervisor.dispose(&sid).await {
                if perm_stale {
                    // 权限超时回收前，先让用户知道 agent 为什么消失、错过了什么：
                    // 1) 持久化 system 消息（含请求工具/内容预览/可选项，刷新后
                    //    hydrate 仍可见）；
                    // 2) 广播给在线 WS 连接（shutdown 前，连接仍存活）；
                    // 3) 再 cancel + kill（安全策略不变）。
                    let events = client.pending_permission_events().await;
                    let summaries: Vec<PermissionRequestSummary> = events
                        .iter()
                        .take(MAX_PERM_NOTICE_REQUESTS)
                        .map(|e| summarize_permission_request(&e.request))
                        .collect();
                    let notice = build_perm_notice_abort(
                        &summaries,
                        events.len().saturating_sub(MAX_PERM_NOTICE_REQUESTS),
                        perm_secs / 60,
                    );
                    persist_and_broadcast(&db, &sid, &client, &notice).await;
                    // 先取消卡住的权限请求，避免 agent 永久阻塞
                    let _ = client.cancel();
                }
                // 强制回收：即使仍有 WS 连接持有 Arc 引用也立即 kill 子进程。
                // 旧实现依赖 `Arc::try_unwrap` 在引用归零后自然 drop 再杀进程，但
                // WS handler 持 `Option<Arc<AcpClient>>` 时引用永远不会归零 → 进程
                // 存活、可继续对话，而 supervisor 已移除该 session，`list_sessions`
                // 报 `acp_process_alive=false`，Sidebar 显示「已释放」与实际进程存活
                // 不一致，且进程脱离 reaper 管辖后无限驻留。`shutdown` 走 shared
                // reference 触发连接任务退出 → 子进程被 kill，WS 随之断开。
                client.shutdown().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_wire_format_is_whitelisted() {
        assert_eq!(PermissionTimeoutMode::default(), PermissionTimeoutMode::Abort);
        for mode in
            [PermissionTimeoutMode::Abort, PermissionTimeoutMode::Auto, PermissionTimeoutMode::Wait]
        {
            assert_eq!(PermissionTimeoutMode::from_str_opt(mode.as_str()), Some(mode));
        }
        // 白名单外一律 None（大小写不符、空串、旧值）。
        for bad in ["", "Abort", "AUTO", "never", "0"] {
            assert_eq!(PermissionTimeoutMode::from_str_opt(bad), None, "bad mode: {bad:?}");
        }
        // trim 容忍（DB 值可能带空白，与 acp_idle_recycle_secs_from_setting 一致）。
        assert_eq!(
            PermissionTimeoutMode::from_str_opt(" auto "),
            Some(PermissionTimeoutMode::Auto)
        );
    }

    #[test]
    fn config_defaults_match_legacy_behavior() {
        let cfg = PermissionTimeoutConfig::default();
        assert_eq!(cfg.snapshot(), (PermissionTimeoutMode::Abort, REQUIRES_ACTION_RECYCLE_SECS));
    }

    #[test]
    fn config_snapshot_store_roundtrip() {
        let cfg = PermissionTimeoutConfig::new(PermissionTimeoutMode::Wait, 600);
        assert_eq!(cfg.snapshot(), (PermissionTimeoutMode::Wait, 600));
        cfg.store(PermissionTimeoutMode::Auto, 120);
        assert_eq!(cfg.snapshot(), (PermissionTimeoutMode::Auto, 120));
        // 未知编码字节回退 Abort（不 panic）。
        cfg.mode.store(9, Ordering::Relaxed);
        assert_eq!(cfg.snapshot().0, PermissionTimeoutMode::Abort);
    }

    fn sample_summary() -> PermissionRequestSummary {
        PermissionRequestSummary {
            tool: Some("Bash".into()),
            kind: Some("execute".into()),
            content: Some("git push origin main".into()),
            content_omitted: 0,
            options: vec!["允许一次".into(), "总是允许".into(), "拒绝".into()],
        }
    }

    #[test]
    fn abort_notice_carries_request_details() {
        let notice = build_perm_notice_abort(&[sample_summary()], 0, 30);
        assert_eq!(notice.label, SYSTEM_LABEL_PERM_TIMEOUT_ABORT);
        assert!(notice.text.contains("30 分钟"), "{}", notice.text);
        assert!(notice.text.contains("git push origin main"), "{}", notice.text);
        assert!(notice.text.contains("可选项：允许一次 / 总是允许 / 拒绝"), "{}", notice.text);
        let detail = &notice.detail;
        assert_eq!(detail["minutes"], 30);
        assert_eq!(detail["tool"], "Bash");
        assert_eq!(detail["options"][1], "总是允许");
        assert_eq!(detail["extra"], 0);
        assert!(detail["selected"].is_null());
    }

    #[test]
    fn abort_notice_reports_extra_requests() {
        let notice = build_perm_notice_abort(&[sample_summary()], 3, 30);
        assert!(notice.text.contains("另有 3 项审批一并取消"), "{}", notice.text);
        assert_eq!(notice.detail["extra"], 3);
    }

    #[test]
    fn auto_notice_names_the_selected_option() {
        let notice = build_perm_notice_auto(&sample_summary(), "总是允许", 10);
        assert_eq!(notice.label, SYSTEM_LABEL_PERM_TIMEOUT_AUTO);
        assert!(notice.text.contains("自动选择「总是允许」"), "{}", notice.text);
        assert!(notice.text.contains("10 分钟"), "{}", notice.text);
        assert_eq!(notice.detail["selected"], "总是允许");
        assert_eq!(notice.detail["minutes"], 10);
    }

    #[test]
    fn auto_notice_marks_omitted_content() {
        let mut s = sample_summary();
        s.content = Some("x".repeat(10));
        s.content_omitted = 42;
        let notice = build_perm_notice_auto(&s, "允许一次", 5);
        assert!(notice.text.contains("已省略 42 字符"), "{}", notice.text);
        assert_eq!(notice.detail["content_omitted"], 42);
    }

    #[test]
    fn abort_notice_without_summary_still_readable() {
        // 竞态：cancel_all 已清空 pending 才走到回收——文案不残缺。
        let notice = build_perm_notice_abort(&[], 0, 30);
        assert!(notice.text.starts_with("权限请求 30 分钟未获响应"), "{}", notice.text);
        assert!(notice.detail["tool"].is_null());
    }
}
