use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sqlx::sqlite::SqlitePool;
use tokio::time::interval;

use crate::acp::chat_persistence;
use crate::acp::client::TurnEndEvent;
use crate::acp::supervisor::AcpSupervisor;

/// 静默待命回收阈值（秒）默认值：无进行中 prompt、无未决权限、且距最后活动满 5 分钟即回收。
/// 实际阈值可由 `run_reaper` 的 `Arc<AtomicU64>` 在运行时覆盖（main.rs 从 settings 表注入），
/// 此常量作为 DB 无配置时的兜底默认值。
pub const IDLE_RECYCLE_SECS: u64 = 300;

/// 权限请求无响应兜底阈值（秒）：有未决权限但久无活动满 30 分钟则取消并回收。
/// 注：PermissionManager 不做超时自动应答（ACP 规范 Cancelled 仅用于
/// session/cancel 语义，且审批须等真人决策），此为无人应答时的唯一兜底。
pub const REQUIRES_ACTION_RECYCLE_SECS: u64 = 1800;

/// 权限超时回收时写入会话的 system 消息文案（role='system' 的 `text` 列
/// 与 `blocks[0].label` 一致；前端命中 i18n key 才翻译，未命中原样显示）。
pub const PERMISSION_TIMEOUT_NOTICE: &str = "权限请求 30 分钟未获响应，系统已自动取消该请求并回收会话（agent 已终止）。可重新打开会话继续。";

/// prompt 卡死兜底阈值（秒）：有进行中 prompt 但久无 agent 通知满 10 分钟，
/// 强制定稿 turn 并广播结束。兜底不发送 PromptResponse 的 agent（§8 多实现兼容）。
/// 定稿后下一轮 idle 检查会按常规回收进程。
pub const PROMPT_STALE_SECS: u64 = 600;

/// 看护任务扫描间隔（秒）。
const TICK_SECS: u64 = 30;

/// 空闲回收看护任务。
///
/// 周期性遍历 supervisor 中所有 ACP client，按后端可观测的活跃度信号决定回收：
/// - idle 超时（静默待命）→ 强制 `shutdown` kill 子进程
/// - 权限请求超时无响应（requires_action 但无人应答）→ 先 cancel 再 kill
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
/// `db` 用于权限超时回收时写入 system 告知消息（agent 被 cancel+kill 的原因，
/// 用户刷新会话后仍可见）；idle 回收（用户完全不用）不写。
pub async fn run_reaper(
    supervisor: AcpSupervisor,
    db: SqlitePool,
    idle_recycle_secs: Arc<AtomicU64>,
) {
    let mut ticker = interval(Duration::from_secs(TICK_SECS));
    loop {
        ticker.tick().await;

        // 1) 快照 + 判定（不在持锁状态下做 async 回收）
        // idle 阈值每次判定前动态读取，使运行时改配置即时生效。
        let idle_secs = idle_recycle_secs.load(Ordering::Relaxed);
        let mut to_reap: Vec<(String, bool /*perm_stale*/)> = Vec::new();
        for (sid, client) in supervisor.snapshot().await {
            if client.is_idle_stale(idle_secs).await {
                to_reap.push((sid, false));
            } else if client.is_permission_stale(REQUIRES_ACTION_RECYCLE_SECS).await {
                to_reap.push((sid, true));
            } else if client.is_prompt_stale(PROMPT_STALE_SECS) {
                tracing::warn!(
                    session_id = %sid,
                    "prompt active but no agent activity for {}s; force-finalizing turn",
                    PROMPT_STALE_SECS
                );
                client.mark_prompt_idle();
                client.notify_turn_end(TurnEndEvent::Done {
                    stop_reason: "InactivityTimeout".into(),
                    row_id: client.turn_row_id(),
                });
            }
        }

        // 2) 回收
        for (sid, perm_stale) in to_reap {
            if let Some(client) = supervisor.dispose(&sid).await {
                if perm_stale {
                    // 权限超时回收前，先让用户知道 agent 为什么消失：
                    // 1) 持久化 system 消息（刷新后 hydrate 仍可见）；
                    // 2) 广播给在线 WS 连接（shutdown 前，连接仍存活）；
                    // 3) 再 cancel + kill（安全策略不变，见 PERMISSION_TIMEOUT_NOTICE）。
                    let blocks = serde_json::json!([
                        { "type": "system", "label": PERMISSION_TIMEOUT_NOTICE }
                    ])
                    .to_string();
                    if let Err(e) = chat_persistence::insert_message(
                        &db,
                        &sid,
                        "system",
                        PERMISSION_TIMEOUT_NOTICE,
                        Some(&blocks),
                    )
                    .await
                    {
                        tracing::warn!(
                            session_id = %sid,
                            error = %e,
                            "reaper: failed to persist permission-timeout system message"
                        );
                    }
                    client.notify_system_message(PERMISSION_TIMEOUT_NOTICE.to_string());
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
