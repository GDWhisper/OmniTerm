use std::sync::Arc;
use std::time::Duration;

use tokio::time::interval;

use crate::acp::client::TurnEndEvent;
use crate::acp::supervisor::AcpSupervisor;

/// 静默待命回收阈值（秒）：无进行中 prompt、无未决权限、且距最后活动满 5 分钟即回收。
pub const IDLE_RECYCLE_SECS: u64 = 300;

/// 权限请求无响应兜底阈值（秒）：有未决权限但久无活动满 30 分钟则取消并回收。
/// 注：PermissionManager 不做超时自动应答（ACP 规范 Cancelled 仅用于
/// session/cancel 语义，且审批须等真人决策），此为无人应答时的唯一兜底。
pub const REQUIRES_ACTION_RECYCLE_SECS: u64 = 1800;

/// prompt 卡死兜底阈值（秒）：有进行中 prompt 但久无 agent 通知满 10 分钟，
/// 强制定稿 turn 并广播结束。兜底不发送 PromptResponse 的 agent（§8 多实现兼容）。
/// 定稿后下一轮 idle 检查会按常规回收进程。
pub const PROMPT_STALE_SECS: u64 = 600;

/// 看护任务扫描间隔（秒）。
const TICK_SECS: u64 = 30;

/// 空闲回收看护任务。
///
/// 周期性遍历 supervisor 中所有 ACP client，按后端可观测的活跃度信号决定回收：
/// - idle 超时（静默待命）→ 直接 disconnect 杀进程
/// - 权限请求超时无响应（requires_action 但无人应答）→ 先 cancel 再 disconnect
/// - prompt 卡死（有进行中 prompt 但久无通知）→ 强制定稿 turn，不杀进程
///
/// 活跃判定逻辑见 `AcpClient::is_idle_stale` / `is_permission_stale` / `is_prompt_stale`。
/// 进程所有权在后端，回收即 kill 子进程、释放内存。
pub async fn run_reaper(supervisor: AcpSupervisor) {
    let mut ticker = interval(Duration::from_secs(TICK_SECS));
    loop {
        ticker.tick().await;

        // 1) 快照 + 判定（不在持锁状态下做 async 回收）
        let mut to_reap: Vec<(String, bool /*perm_stale*/)> = Vec::new();
        for (sid, client) in supervisor.snapshot().await {
            if client.is_idle_stale(IDLE_RECYCLE_SECS).await {
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
                });
            }
        }

        // 2) 回收
        for (sid, perm_stale) in to_reap {
            if let Some(client) = supervisor.dispose(&sid).await {
                if perm_stale {
                    // 先取消卡住的权限请求，避免 agent 永久阻塞
                    let _ = client.cancel();
                }
                // Arc 引用归零后 drop → connection_task 结束 → 子进程被 kill
                if let Ok(c) = Arc::try_unwrap(client) {
                    c.disconnect().await;
                }
            }
        }
    }
}
