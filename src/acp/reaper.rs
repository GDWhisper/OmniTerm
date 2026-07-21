use std::sync::Arc;
use std::time::Duration;

use tokio::time::interval;

use crate::acp::supervisor::AcpSupervisor;

/// 静默待命回收阈值（秒）：无进行中 prompt、无未决权限、且距最后活动满 5 分钟即回收。
pub const IDLE_RECYCLE_SECS: u64 = 300;

/// 权限请求无响应兜底阈值（秒）：有未决权限但久无活动满 30 分钟则取消并回收。
/// 注：ACP v1 下 PermissionManager 自身有 60s 超时自动取消，此为双保险。
pub const REQUIRES_ACTION_RECYCLE_SECS: u64 = 1800;

/// 看护任务扫描间隔（秒）。
const TICK_SECS: u64 = 30;

/// 空闲回收看护任务。
///
/// 周期性遍历 supervisor 中所有 ACP client，按后端可观测的活跃度信号决定回收：
/// - idle 超时（静默待命）→ 直接 disconnect 杀进程
/// - 权限请求超时无响应（requires_action 但无人应答）→ 先 cancel 再 disconnect
///
/// 活跃判定逻辑见 `AcpClient::is_idle_stale` / `is_permission_stale`。
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
                if let Some(c) = Arc::try_unwrap(client).ok() {
                    c.disconnect().await;
                }
            }
        }
    }
}
