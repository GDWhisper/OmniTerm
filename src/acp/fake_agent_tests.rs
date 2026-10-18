//! fake agent 回归测试（计划 D5 / P1-2）：最小 JSON-RPC agent 驱动真实 ACP
//! 连接时序，钉住 omniterm 侧契约。公共设施（脚本 / spawn / 进程探针）在
//! [`crate::acp::test_support`]。
//!
//! 覆盖：
//! 1. **agent 死于 turn 进行中**（现场真实时序）：在途 prompt 快速失败（死连接
//!    的实时失败语义——生产实际靠请求失败兜底，**不**依赖 `is_alive()`：崩溃后
//!    其取值不确定，见下方「边界」），agent 被回收无残留，shutdown 干净收尾；
//! 2. **agent 死于 handshake**（initialize 后、session/new 前）：spawn 限时
//!    失败而不是挂死（`conn_rx` 错误路径有界）；
//! 3. **agent 无流量静默退出**：进程被回收无残留；此后 shutdown 的 killpg 命中
//!    `should_kill_group` 第 2 分支（pid 已 reap 且组空 → 跳过 + WARN），整条
//!    teardown 无 panic 走完；
//! 4. **shutdown 对存活 agent 的进程组击杀**：killpg 在 `shutdown()` 返回前已
//!    发出——旧实现要等 crate 优雅路径的 1s 宽限期（`SHUTDOWN_GRACE_PERIOD`）
//!    后才借 `ChildGuard::drop` 击杀，750ms 断言区分两条路径（计划 D3 的回归
//!    防线：删掉 killpg 本测试即红）；
//! 5. **进程组语义**（wrapper launcher / `npx → node` 场景，计划 D2）：孙进程与
//!    leader 同进程组、持有继承 stdio，只杀单进程会留下孤儿 agent——shutdown
//!    必须连孙进程一起带走；
//! 6. **pid 捕获端到端**（D1）：真实 spawn 路径（wrapper `echo $$` 自报）上
//!    `agent_pid()` 非空；create（`spawn_and_connect`）与 restore
//!    （`spawn_and_load`）两条构造路径都覆盖（防 272 行重复只改一处）；
//! 7. **prompt 正常链路**（R08，2026-10-01）：agent 流式 `session/update` +
//!    `end_turn` 应答 → 广播带 seq、累积器正文折叠正确；
//! 8. **cancel 链路**（R08）：`session/cancel` 通知到达 agent，prompt 以
//!    `cancelled` 返回；**粘滞取消重发**（2026-10-06）：cancel 之后紧接的新 prompt
//!    被 agent 秒回 `cancelled`（实测 codebuddy 的异步清理窗口）→ `send_prompt` 按
//!    「本世代没有 cancel 请求」判定并有界重发，用户主动取消的那一轮不重发；
//! 9. **权限往返**（R07，`PermissionManager`）：`resolve` 选中项送达 agent 且
//!    resolved 广播；`cancel` 对未决审批以 `Cancelled` 应答（规范 MUST）；
//! 10. **shutdown/disconnect 语义**（R08）：shutdown 后 `is_alive()` 立即 false
//!     且发送快速失败；disconnect 消费 self 同样杀进程；
//! 11. **terminal 往返**（R07，`AcpTerminalManager`）：create→wait_for_exit→
//!     output→release 全链路 + 事件广播；kill 路径退出状态无 exit_code；
//! 12. **重复 env 键最后一条胜出**（升级计划 D4 的端到端 pin）；
//! 13. **usage 快照落库**：`usage_update` 通知经 `on_agent_notification` 写
//!     `sessions.usage_json`（刷新 / 换设备后 `GET /messages` hydrate 的恢复来源，
//!     通知本身不随 session/load 重放、广播无补发）；
//! 14. **agent 侧记录删除**（2026-10-06）：`sessionCapabilities.delete` 的存在性
//!     判据（声明 / 未声明两态）+ `session/delete` 的 sessionId 送达与失败上报
//!     ——「删除会话时顺带抹掉 agent 侧记录」的后端契约；
//! 15. **「自动推进 + 总是」到达即应答**（2026-10-09）：权限请求到达唤醒 reaper，
//!     不等 30 秒 tick 即自动放行——告知消息（广播 + 落库）与选中项送达一并钉住。
//!
//! **边界（勿过度解读）**：
//! - 本测试**不复现**上游 crate 的 pidfd 空转（依赖未识别的 poll/wake 交错，
//!   最小复现实验阴性），只固化 omniterm 侧可控契约；crate 自身在连接 actor
//!   健康时也会经 `ChildGuard::drop` killpg，故断言的是「shutdown 后限时无残留」
//!   这一结果契约，而非 killpg 的唯一责任人；
//! - **agent 死亡不会结束连接任务、也不产生崩溃广播**（2026-09-21 实测）：
//!   setup 完成后内层闭包 parks 在 `shutdown_rx` 上，crate 的
//!   `run_until_connection_close` 在 background（EOF 关闭链）先完成时
//!   `foreground.await`，pidfd 检出的 child_wait 分支不再被轮询——任务要等
//!   shutdown 的 signal 才结束（返回 Ok）。因此 crash 广播（`crash_subscribe`）
//!   实际只在 **setup 阶段**（initialize/session/new 在途）崩溃时触发，而那
//!   时 client 尚未构造、无人订阅。**`is_alive()` 对已崩溃 agent 的取值不
//!   确定**（2026-10-16 更正）：它组合 `alive` 显式标志 + 库的
//!   `is_incoming_closed()`（agent 崩溃走 EOF 的兜底路径，见
//!   `docs/architecture/backend.md`）；连接任务是否及时观测到崩溃 agent 的
//!   EOF 随调度而异——同机连跑 30 次稳定误报 true，CI 上则可能已被 EOF 兜底
//!   置 false。故**不可 pin 崩溃后的 `is_alive()` 取值**（本文件曾在此 pin
//!   true，CI 偶发翻 false 致 flaky，2026-10-16 移除）；生产实际靠
//!   `send_request` 报 "connection is no longer running" 兜底。本文件因此
//!   不断言广播、也不断言崩溃后的 `is_alive()`，只断言请求失败/进程回收/
//!   teardown 鲁棒这些真实契约（shutdown 后的 `is_alive()==false` 是确定的，
//!   由用例 10 覆盖）。2026-10-01 升级 SDK 1.3→2.2.0 后上述契约仍成立。
//!
//! wire 契约（crate 2.2.0 / schema 1.9.1 复核，改测试前先核对）：
//! - 换行分隔 JSON-RPC 2.0，client 请求 `{"jsonrpc":"2.0","id":"<uuid>","method":"initialize","params":{...}}`；
//! - **请求 id 是 UUID 字符串**（`RequestId::Str(uuid)`，非数字），响应必须原文回抄；
//! - `ProtocolVersion` 是 newtype u16 → 裸数字；`SessionId` 透明字符串；
//! - `InitializeResponse` 的 `agentCapabilities` / `authMethods` 均可缺省；
//! - method 名：`initialize` / `session/new` / `session/prompt` / `session/load` /
//!   `session/cancel`（通知）/ `session/request_permission` / `terminal/*`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate, StopReason};

use crate::acp::agent_proc;
use crate::acp::agent_proc::spawn_test_lock_async;
use crate::acp::client::AcpClient;
use crate::acp::reaper::{PERM_TIMEOUT_NEVER_SECS, PermissionTimeoutConfig, PermissionTimeoutMode};
use crate::acp::terminal::TerminalActivity;
use crate::acp::test_support::{
    KILL_TIMEOUT, REAP_TIMEOUT, SPAWN_TIMEOUT, UNWIND_TIMEOUT, agent_for, agent_for_with_env,
    proc_alive, proc_dead, proc_reaped, read_events, spawn_connect, spawn_probe, unique_dir,
    wait_for_event, wait_until, wait_until_some, write_fake_agent,
};
use crate::models::agent::AgentEnvVar;

// ── 1. agent 死于 turn 进行中：prompt 失败 + 进程回收 + 干净收尾 ─────────

#[tokio::test]
async fn agent_dying_mid_prompt_fails_prompt_and_shuts_down_clean() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("crash");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "crash", &dir), workspace).await;
    let pid = client.agent_pid().expect("D1：crash 模式也必须捕获 pid");

    // agent 收到 prompt 后不回响应直接退出。在途 prompt 必须快速失败——死连接
    // 的实时失败语义，生产靠它兜底（不依赖 is_alive 判存活：崩溃后其取值不
    // 确定，见模块文档「边界」）。
    let prompt_result =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("send_prompt 未在限时内返回（挂死）");
    assert!(
        prompt_result.is_err(),
        "agent 死于 prompt 在途时 send_prompt 应失败，实际: {prompt_result:?}"
    );

    // 进程必须被回收。此处**不**断言 is_alive()：崩溃后它可能已被 EOF 兜底置
    // false，也可能因连接任务尚未观测到 EOF 而短暂误报 true——取值随调度而异
    // （2026-10-16 更正；原按「误报存活」pin true，在同机连跑 30 次虽稳过，
    // 但 CI 上偶发翻 false 致 flaky）。
    assert!(wait_until(|| proc_reaped(pid), UNWIND_TIMEOUT).await, "agent 死亡后未被 crate 回收");

    client.shutdown().await;
    assert!(wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await, "shutdown 后 agent 仍残留");

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 1b. agent 死于 handshake：spawn 限时失败而不是挂死 ──────────────────

#[tokio::test]
async fn spawn_fails_promptly_when_agent_dies_during_handshake() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("handshake");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    // initialize 后有响应、session/new 前 agent 退出：conn_rx 的发送端随内层
    // 闭包 Err 被 drop，spawn_and_connect 必须经错误路径快速返回（该路径同时
    // best-effort 清理 pid 自报文件），而不是永久挂在 conn_rx.await 上。
    let result = tokio::time::timeout(
        SPAWN_TIMEOUT,
        AcpClient::spawn_and_connect(
            agent_for(&script, "handshake", &dir),
            workspace,
            &HashMap::new(),
        ),
    )
    .await
    .expect("spawn 挂起：agent 死于 handshake 时 spawn_and_connect 未限时返回");
    assert!(result.is_err(), "agent 死于 handshake 时 spawn_and_connect 应快速失败");

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 2. 无流量静默退出：进程回收 + shutdown 干净收尾 ─────────────────────

#[tokio::test]
async fn agent_exits_without_traffic_shutdown_stays_clean() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("exit");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);
    let exit_gate = dir.join("exit.gate");

    let client = spawn_connect(agent_for(&script, "exit", &dir), workspace).await;
    let pid = client.agent_pid().expect("D1：exit 模式也必须捕获 pid");
    assert!(proc_alive(pid), "放行前 agent 必须驻留");

    std::fs::write(&exit_gate, b"go").expect("write exit gate");
    assert!(wait_until(|| proc_reaped(pid), UNWIND_TIMEOUT).await, "agent 退出后未被 crate 回收");

    // 注意：不断言 is_alive() 转 false——无流量退出时连接任务 parks 在
    // shutdown_rx 上（crate 既有行为，见模块文档），is_incoming_closed 也不
    // 置位，is_alive() 误报存活。这里只钉 shutdown 的鲁棒性。
    client.shutdown().await;
    assert!(wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await, "shutdown 后 agent 仍残留");

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 3. shutdown 对存活 agent 的进程组击杀（D3 回归防线）─────────────────

#[tokio::test]
async fn shutdown_kills_live_agent_process_group_promptly() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("live");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "live", &dir), workspace).await;

    // D1 端到端：真实 spawn 路径上 pid 必须捕获成功（wrapper $$ 自报）。
    let pid = client.agent_pid().expect("D1：真实 spawn 路径必须捕获 agent pid");
    assert!(proc_alive(pid), "shutdown 前 agent 必须存活");

    client.shutdown().await;

    // killpg 在 shutdown() 返回前已发出（同步 OS 调用）。旧实现要等 crate 优雅
    // 路径的 1s 宽限期后才借 ChildGuard::drop 击杀——750ms 断言即两条路径的
    // 分水岭，删掉 D2/D3 的 killpg 本测试立刻转红。
    assert!(
        wait_until(|| proc_dead(pid), KILL_TIMEOUT).await,
        "shutdown 后 agent 未在 {KILL_TIMEOUT:?} 内死亡（killpg 未生效或走了 1s 优雅宽限期）"
    );
    // 完整回收：async-process reaper 收割 direct child，不残留僵尸。
    assert!(
        wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await,
        "agent 死亡后未被回收（僵尸残留）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 4. 进程组语义：孙进程随组一起被击杀（D2 回归防线）───────────────────

#[tokio::test]
async fn shutdown_kill_reaches_grandchild_in_same_process_group() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("group");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);
    let grandchild_pid_file = dir.join("grandchild.pid");

    let client = spawn_connect(agent_for(&script, "group", &dir), workspace).await;

    let leader = client.agent_pid().expect("D1：group 模式也必须捕获 leader pid");
    // 等孙进程登记（fake agent 响应 session/new 后 fork 并写 pid 文件）。
    let grandchild = wait_until_some(
        || {
            std::fs::read_to_string(&grandchild_pid_file)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
        },
        UNWIND_TIMEOUT,
    )
    .await
    .expect("孙进程未在限时内登记 pid");
    assert_ne!(grandchild, leader);
    assert!(proc_alive(leader), "shutdown 前 leader 必须存活");
    assert!(proc_alive(grandchild), "shutdown 前孙进程必须存活");

    client.shutdown().await;

    // killpg(-leader) 必须同时带走孙进程：只杀单进程会留下持有继承 stdio 的
    // 孤儿 agent（EOF 永不触发，连接层无法自愈，计划 D2 否决项）。
    assert!(
        wait_until(|| proc_dead(leader), KILL_TIMEOUT).await,
        "shutdown 后 leader 未在 {KILL_TIMEOUT:?} 内死亡"
    );
    assert!(
        wait_until(|| proc_dead(grandchild), KILL_TIMEOUT).await,
        "shutdown 后孙进程未随进程组被击杀（D2 回归：只杀了单进程？）"
    );
    // 孙进程是 leader 的子进程，leader 死后被过继；容器 PID 1 若非 init 式
    // 收割者可能残留僵尸——只断言「不再执行」，不断言完整回收（leader 是
    // omniterm 直接子进程，由 async-process reaper 可靠回收）。
    assert!(
        wait_until(|| proc_reaped(leader), REAP_TIMEOUT).await,
        "leader 死亡后未被回收（僵尸残留）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 5. restore 构造路径同样捕获 pid 并杀进程（D1 落地范围）──────────────

#[tokio::test]
async fn restore_path_captures_pid_and_shutdown_kills_agent() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("restore");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = tokio::time::timeout(
        SPAWN_TIMEOUT,
        AcpClient::spawn_and_load(
            agent_for(&script, "live", &dir),
            workspace,
            "fake-acp-session".to_string(),
            &HashMap::new(),
        ),
    )
    .await
    .expect("spawn_and_load 超时：fake agent 未响应 initialize")
    .expect("spawn_and_load 失败");

    assert!(client.supports_load_session(), "fake agent 已声明 loadSession 能力");
    // D1 落地范围：restore（spawn_and_load）与 create（spawn_and_connect）共用
    // 同一 spawn 核，两条路径都必须捕获 pid（防 272 行重复只改一处）。
    let pid = client.agent_pid().expect("D1：restore 路径必须捕获 agent pid");
    assert!(proc_alive(pid), "shutdown 前 agent 必须存活");

    client.shutdown().await;

    assert!(
        wait_until(|| proc_dead(pid), KILL_TIMEOUT).await,
        "restore 路径 shutdown 后 agent 未在 {KILL_TIMEOUT:?} 内死亡"
    );
    assert!(
        wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await,
        "restore 路径 agent 死亡后未被回收（僵尸残留）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 5b. session/load 下发的 cwd 去尾斜杠（qoder 恢复兜底回归）─────────────
//
// 背景：qoder 按「路径非字母数字 → -」编码会话存储目录——库中带的
// workspace_path 形态 `/home/pax/` 会编码成 `-home-pax-`，而创建时落盘的是
// `-home-pax`，恢复必报 INVALID_SESSION_IDENTIFIER（2026-10-11 实测复现）。
// 兜底在下发前规范化 cwd；本测试钉住「agent 实际收到的 cwd 无尾斜杠」。

#[tokio::test]
async fn load_session_strips_trailing_slash_cwd_before_sending_to_agent() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("load-cwd");
    // 还原 omniterm 库里的形态：workspace_path 带尾斜杠（如 /home/pax/）。
    let plain = dir.join("ws");
    let workspace = PathBuf::from(format!("{}/", plain.display()));
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = tokio::time::timeout(
        SPAWN_TIMEOUT,
        AcpClient::spawn_and_load(
            agent_for(&script, "live", &dir),
            workspace.clone(),
            "fake-acp-session".to_string(),
            &HashMap::new(),
        ),
    )
    .await
    .expect("spawn_and_load 超时：fake agent 未响应 initialize")
    .expect("spawn_and_load 失败");

    client
        .load_session("fake-acp-session", workspace.clone())
        .await
        .expect("session/load 应成功（fake agent 恒回空结果）");

    // load_session 返回即 agent 已处理请求：事件日志应已有 load-cwd 行。
    assert!(
        wait_for_event(&dir, "load-cwd ", SPAWN_TIMEOUT).await,
        "fake agent 未收到 session/load：{}",
        read_events(&dir)
    );
    let expected = format!("load-cwd {}", plain.display());
    let events = read_events(&dir);
    assert!(
        events.lines().any(|l| l == expected),
        "session/load 下发的 cwd 应为去尾斜杠形态 {expected:?}，实际事件：{events}"
    );
    // 反向钉住：尾斜杠形态不得出现（它正是 qoder 侧 -home-pax- 编码错位的来源）。
    assert!(
        !events.contains(&format!("load-cwd {}/", plain.display())),
        "cwd 不应带尾斜杠，实际事件：{events}"
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 6. spawn 握手期超时不得泄漏 agent 进程（P2-3 回归防线）──────────────

#[tokio::test]
async fn spawn_timeout_during_handshake_does_not_leak_agent_process() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("hang");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    // P2-3：探针（test_agent/test_agent_raw 的 15s 超时）会在 handshake 期间
    // drop 掉 spawn future。修复前（Phase 1 之前）没有任何机制终止连接任务，
    // 闭包卡在 initialize 等待里出不来——shutdown_tx 虽随外层 future 释放，
    // 但闭包还没走到 shutdown_rx.await，连接任务带着 agent 进程（含孙进程）
    // 永远驻留。现在由 Phase 1 D4 兜底：abort_tx 随外层 future 释放 → crash
    // watcher abort 连接任务 → crate 的 ChildGuard::drop killpg 进程组。
    // pid 自报文件由任务内的 PidFileCleanup 守卫统一清理（agent_proc.rs）。
    let children_before = agent_proc::snapshot_direct_children();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        AcpClient::spawn_and_connect(
            agent_for(&script, "hang", &dir),
            workspace.clone(),
            &HashMap::new(),
        ),
    )
    .await;
    assert!(result.is_err(), "hang agent 必须让 spawn 限时失败而不是挂死");

    // 测试锁下无并发 spawn 污染，diff 即本用例的 hang agent。
    let pid = agent_proc::resolve_child_pid(&children_before, &workspace)
        .expect("应能 diff 出 hang agent 的 pid");
    assert!(proc_alive(pid), "spawn 超时前 agent 必须还在跑（否则测了个空）");
    // abort 连接任务 → crate 连接 future 被 drop → ChildGuard::drop killpg。
    // 4s 上界覆盖 abort 传播与调度抖动。
    assert!(
        wait_until(|| proc_dead(pid), Duration::from_secs(4)).await,
        "spawn 超时（调用方消失）后 agent 进程泄漏（P2-3 回归）"
    );
    assert!(
        wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await,
        "hang agent 死亡后未被回收（僵尸残留）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 7. prompt 正常链路：流式通知广播（带 seq）+ 累积器折叠 + end_turn ────

#[tokio::test]
async fn prompt_roundtrip_streams_session_update_and_completes() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("prompt-ok");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "prompt_ok", &dir), workspace).await;
    let mut updates = client.session_update_subscribe();

    // 生产路径：WS 层在发 prompt 前 mark_prompt_active（开启累积器 turn 门控），
    // 返回后 mark_prompt_idle。本测试按生产时序驱动。
    client.mark_prompt_active();
    let resp =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("send_prompt 未在限时内返回（挂死）")
            .expect("prompt 正常链路应返回 Ok");
    assert_eq!(resp.stop_reason, StopReason::EndTurn, "fake agent 以 end_turn 应答");
    client.mark_prompt_idle();

    // 通知在 send_prompt 返回前已被内联派发（1.3/2.2 通知派发均为串行，
    // 升级计划 D3 取证），故此处必然已收到广播。
    let frame = updates.try_recv().expect("应收到 session/update 广播");
    assert!(frame.seq.is_some(), "turn 内折叠的帧必须带 seq（重连对账依赖）");
    match frame.notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => assert!(
            matches!(&chunk.content, ContentBlock::Text(t) if t.text == "hello-from-agent"),
            "AgentMessageChunk 文本不符"
        ),
        other => panic!("期望 AgentMessageChunk，实际 {other:?}"),
    }
    let snap = client.turn_snapshot();
    assert!(snap.text.contains("hello-from-agent"), "累积器应折叠正文，实际: {:?}", snap.text);

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 8. cancel 链路：session/cancel 到达 agent，prompt 以 cancelled 返回 ──

#[tokio::test]
async fn cancel_notification_reaches_agent_and_prompt_ends_cancelled() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("cancel");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "cancel", &dir), workspace).await;
    client.mark_prompt_active();

    let prompt_fut = client.send_prompt("hi", vec![], vec![], vec![]);
    let cancel_when_delivered = async {
        assert!(
            wait_for_event(&dir, "prompt", UNWIND_TIMEOUT).await,
            "agent 未在限时内收到 prompt：{}",
            read_events(&dir)
        );
        client.cancel().expect("session/cancel 通知应发送成功");
    };
    let (resp, ()) = tokio::join!(prompt_fut, cancel_when_delivered);
    let resp = resp.expect("cancel 后 prompt 应以 cancelled 正常返回");
    assert_eq!(resp.stop_reason, StopReason::Cancelled);
    assert!(
        wait_for_event(&dir, "cancel", UNWIND_TIMEOUT).await,
        "agent 未收到 session/cancel：{}",
        read_events(&dir)
    );
    client.mark_prompt_idle();

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 8b. 粘滞取消：cancel 后紧接的新 prompt 被秒回 cancelled → 须透明重发 ────

/// 复现 2026-10-06 现场：用户点聊天队列 chip 的「立即发送」→ 后端 cancel 当前 turn
/// → `prompt_done` 触发 drain 发出排队消息 → 新 prompt 落在 agent 清理取消状态的
/// 窗口里，被秒回 `cancelled` **且不生成 userMessageId**（实测 codebuddy 2.161.4：
/// 0ms / 250ms 必现，500ms 起正常），用户那条消息静默丢失。
/// 判据是「本世代没有对应的 cancel 请求」，与具体实现的时序无关。
#[tokio::test]
async fn stale_cancel_after_user_cancel_is_resent_not_swallowed() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("stale-cancel");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);
    let prompts = || read_events(&dir).lines().filter(|l| l.trim() == "prompt").count();

    let client = spawn_connect(agent_for(&script, "sticky_cancel", &dir), workspace).await;

    // 第 1 轮：用户主动 cancel → 合法 cancelled，**不得**重发（否则用户停不下来）。
    client.mark_prompt_active();
    let prompt_fut = client.send_prompt("turn1", vec![], vec![], vec![]);
    let cancel_when_delivered = async {
        assert!(
            wait_for_event(&dir, "prompt", UNWIND_TIMEOUT).await,
            "agent 未在限时内收到 prompt：{}",
            read_events(&dir)
        );
        client.cancel().expect("session/cancel 通知应发送成功");
    };
    let (resp, ()) = tokio::join!(prompt_fut, cancel_when_delivered);
    let resp = resp.expect("第 1 轮应以 cancelled 正常返回");
    assert_eq!(resp.stop_reason, StopReason::Cancelled);
    client.mark_prompt_idle();
    assert_eq!(prompts(), 1, "用户自己取消的这一轮不该被重发：{}", read_events(&dir));

    // 第 2 轮：drain 紧接着发（新世代、无 cancel 请求）→ agent 粘滞秒回 cancelled
    // → 宿主重发一次并拿到 end_turn，agent 侧累计收到 3 次 prompt。
    client.mark_prompt_active();
    let resp2 =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("turn2", vec![], vec![], vec![]))
            .await
            .expect("send_prompt 未在限时内返回（挂死）")
            .expect("重发后 prompt 应正常返回");
    client.mark_prompt_idle();
    assert_eq!(
        resp2.stop_reason,
        StopReason::EndTurn,
        "粘滞取消须被重发吞掉，不得把 cancelled 上报给用户"
    );
    assert_eq!(
        prompts(),
        3,
        "第 2 轮应恰好重发一次（受 STALE_CANCEL_MAX_RETRIES 约束）：{}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 9. 权限往返（R07：PermissionManager 经真实连接）─────────────────────

#[tokio::test]
async fn permission_request_resolve_roundtrip() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("perm-resolve");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "perm", &dir), workspace).await;
    let mut perm_rx = client.permission_subscribe();
    let mut resolved_rx = client.permission_resolved_subscribe();
    client.mark_prompt_active();

    let prompt_fut = client.send_prompt("hi", vec![], vec![], vec![]);
    let resolve = async {
        let ev = tokio::time::timeout(UNWIND_TIMEOUT, perm_rx.recv())
            .await
            .expect("等待权限请求事件超时")
            .expect("权限事件通道关闭");
        assert_eq!(client.pending_permissions().await, 1, "请求登记后未决数应为 1");
        assert!(
            client.resolve_permission(&ev.id, "allow").await,
            "首个 resolve 应消费未决项并返回 true"
        );
        let resolved = tokio::time::timeout(UNWIND_TIMEOUT, resolved_rx.recv())
            .await
            .expect("等待 resolved 广播超时")
            .expect("resolved 通道关闭");
        assert_eq!(resolved, ev.id, "resolved 广播载荷应为审批 id");
    };
    let (resp, ()) = tokio::join!(prompt_fut, resolve);
    assert!(resp.is_ok(), "权限被应答后 prompt 应正常收尾: {resp:?}");
    assert_eq!(client.pending_permissions().await, 0, "resolve 后未决数应归零");

    // agent 侧收到的应答必须是用户的选中项（optionId 原样透传）。
    assert!(
        wait_for_event(&dir, "\"optionId\":\"allow\"", UNWIND_TIMEOUT).await,
        "agent 未收到 Selected 应答：{}",
        read_events(&dir)
    );
    client.mark_prompt_idle();

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn cancel_answers_pending_permission_with_cancelled_outcome() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("perm-cancel");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "perm", &dir), workspace).await;
    let mut perm_rx = client.permission_subscribe();
    client.mark_prompt_active();

    let prompt_fut = client.send_prompt("hi", vec![], vec![], vec![]);
    let cancel_when_pending = async {
        let _ev = tokio::time::timeout(UNWIND_TIMEOUT, perm_rx.recv())
            .await
            .expect("等待权限请求事件超时")
            .expect("权限事件通道关闭");
        client.cancel().expect("session/cancel 通知应发送成功");
    };
    let (resp, ()) = tokio::join!(prompt_fut, cancel_when_pending);
    // agent 收到 cancel 即以 cancelled 应答（perm 模式下审批应答与 prompt 应答
    // 可能竞速，只认到达顺序，不影响断言）。
    let resp = resp.expect("cancel 后 prompt 应正常返回");
    assert_eq!(resp.stop_reason, StopReason::Cancelled);
    // ACP 规范 MUST：session/cancel 后所有未决 request_permission 必须以
    // Cancelled outcome 应答。
    assert!(
        wait_for_event(&dir, "\"outcome\":\"cancelled\"", UNWIND_TIMEOUT).await,
        "agent 未收到 Cancelled 应答：{}",
        read_events(&dir)
    );
    assert_eq!(client.pending_permissions().await, 0, "cancel_all 后未决数应归零");
    client.mark_prompt_idle();

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 9b. 「自动推进 + 总是」到达即应答（不等 30 秒 tick）────────────────────

/// 用户实测缺陷（2026-10-09）：「权限超时-自动推进-总是」档位下仍有 ~0-30 秒
/// 等待——「总是」的到达即应答只在 reaper 的 30 秒 tick 上被评估。修复为
/// 权限请求到达时唤醒 reaper（`PermissionTimeoutConfig::notify_perm_request`）。
///
/// 本用例放过 reaper 首轮立即 tick 后才发 prompt：此后下一次 tick 要等 30 秒，
/// 若自动应答仍在数秒内完成，只可能来自唤醒链路。同时钉住告知帧（session_update
/// 内联进 assistant 行 + 独立 system 行兜底）与 agent 侧收到的选中项。
#[tokio::test]
async fn always_auto_mode_answers_permission_on_arrival_not_next_tick() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("perm-always-auto");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let state = crate::test_utils::test_state().await;
    // 会话行：权限超时告知要落 chat_messages（外键指向 sessions）。
    sqlx::query(
        "INSERT INTO projects (id, target_id, name, path, created_at) VALUES ('p1', NULL, 'p', '/tmp', '2026-10-09T00:00:00Z')",
    )
    .execute(&state.db)
    .await
    .expect("insert project");
    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, created_at) VALUES ('s-always', 'p1', '/tmp', 'n', '2026-10-09T00:00:00Z')",
    )
    .execute(&state.db)
    .await
    .expect("insert session");

    let client = Arc::new(spawn_connect(agent_for(&script, "perm", &dir), workspace).await);
    // 真实会话注册点会 attach_persistence（见 ws/acp.rs / api/sessions.rs）；
    // 本用例要验证告知帧内联进 assistant 行，必须挂上同一个 sink。
    client.attach_persistence(state.db.clone(), "s-always".to_string());
    // 真实注册点的绑定（见 AcpClient::attach_perm_timeout）：「自动推进 + 总是」。
    let cfg = Arc::new(PermissionTimeoutConfig::new(
        PermissionTimeoutMode::Auto,
        PERM_TIMEOUT_NEVER_SECS,
    ));
    client.attach_perm_timeout(cfg.clone());
    state.acp_supervisor.insert("s-always".to_string(), client.clone()).await;

    let reaper = tokio::spawn(crate::acp::reaper::run_reaper(
        state.acp_supervisor.clone(),
        state.db.clone(),
        Arc::new(std::sync::atomic::AtomicU64::new(300)),
        cfg,
    ));
    // 放过首轮立即 tick（tokio interval 首次 tick 立即到点），确保后续应答
    // 只能来自唤醒链路而不是 tick。
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut update_rx = client.session_update_subscribe();
    let mut perm_rx = client.permission_subscribe();
    client.mark_prompt_active();
    // prompt 必须被并发推进（未 poll 的 future 不会真正发出请求）。
    let prompt_task = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.send_prompt("hi", vec![], vec![], vec![]).await })
    };

    // 请求先登记为未决（此刻距下一次 tick 还有 ~30 秒）。
    let _ev = tokio::time::timeout(UNWIND_TIMEOUT, perm_rx.recv())
        .await
        .expect("等待权限请求事件超时")
        .expect("权限事件通道关闭");

    // 数秒内必须被自动应答（远小于 30 秒 tick）：超时即说明退回 tick 粒度。
    // 告知现在与 agent 更新走同一有序 session_update 通道（内联进 turn 帧窗口），
    // 不再是独立的 system_message 广播。
    let notice = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notif = update_rx.recv().await.expect("session_update 通道关闭");
            let value = serde_json::to_value(&notif.notification).expect("serialize update");
            if value.to_string().contains(crate::acp::reaper::SYSTEM_LABEL_PERM_TIMEOUT_AUTO) {
                break value;
            }
        }
    })
    .await
    .expect("「总是」档应在到达后立即自动应答，而不是等下一个 reaper tick");
    let omni = &notice["update"]["_meta"]["omnitermSystem"];
    assert_eq!(omni["label"].as_str(), Some(crate::acp::reaper::SYSTEM_LABEL_PERM_TIMEOUT_AUTO));
    assert_eq!(
        omni["detail"]["selected"].as_str(),
        Some("Allow"),
        "自动应答选中项应为 allow_once（优先于 reject_once）"
    );
    assert_eq!(client.pending_permissions().await, 0, "自动应答后未决数应归零");

    // agent 收到的应答是选中项（optionId 原样透传）。
    assert!(
        wait_for_event(&dir, "\"optionId\":\"allow\"", UNWIND_TIMEOUT).await,
        "agent 未收到 Selected 应答：{}",
        read_events(&dir)
    );
    let resp = tokio::time::timeout(UNWIND_TIMEOUT, prompt_task)
        .await
        .expect("权限应答后 prompt 应正常收尾")
        .expect("prompt task 不应 panic")
        .expect("prompt 应成功返回");
    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    client.mark_prompt_idle();

    // 告知双轨落盘：独立 system 行（帧窗口驱逐后的兜底）+ assistant 行的内联帧
    // （hydrate 时按同一 noticeId 过滤独立行，保证正确的 turn 内顺序）。
    let notice_id = omni["id"].as_str().expect("inline SYSTEM notice 必须带去重 id").to_string();
    let rows: Vec<(String, Option<String>)> = tokio::time::timeout(UNWIND_TIMEOUT, async {
        loop {
            let rows: Vec<(String, Option<String>)> = sqlx::query_as(
                "SELECT role, blocks FROM chat_messages WHERE session_id = 's-always' \
                 ORDER BY created_at, id",
            )
            .fetch_all(&state.db)
            .await
            .expect("读 chat_messages");
            if rows.iter().any(|(r, _)| r == "assistant") && rows.iter().any(|(r, _)| r == "system")
            {
                break rows;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("assistant 内联帧 + 独立 system 兜底行都应在定稿后落库");
    let system_blocks = rows
        .iter()
        .find(|(r, _)| r == "system")
        .and_then(|(_, b)| b.clone())
        .expect("独立 system 行");
    assert!(
        system_blocks.contains(crate::acp::reaper::SYSTEM_LABEL_PERM_TIMEOUT_AUTO),
        "落库的 system 行应带 i18n label"
    );
    assert!(system_blocks.contains(&notice_id), "system 行应带同一 noticeId");
    let assistant_blocks = rows
        .iter()
        .find(|(r, _)| r == "assistant")
        .and_then(|(_, b)| b.clone())
        .expect("assistant 行");
    assert!(
        assistant_blocks.contains("omnitermSystem") && assistant_blocks.contains(&notice_id),
        "告知帧应内联进 assistant 行的有序帧窗口：{assistant_blocks}"
    );

    reaper.abort();
    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 10. shutdown / disconnect 语义（R08）────────────────────────────────

#[tokio::test]
async fn shutdown_flips_alive_false_and_prompt_fails_fast() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("shutdown-alive");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "live", &dir), workspace).await;
    assert!(client.is_alive(), "shutdown 前应存活");
    let pid = client.agent_pid().expect("D1：live 模式必须捕获 pid");

    client.shutdown().await;

    // is_alive 必须即时翻转（WS 层据此触发「发送即自动恢复」），不等连接任务
    // 真正结束。
    assert!(!client.is_alive(), "shutdown 后 is_alive() 必须为 false");
    let result =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("shutdown 后 send_prompt 应快速失败而不是挂死");
    assert!(result.is_err(), "shutdown 后发送必须失败，实际: {result:?}");
    assert!(
        wait_until(|| proc_dead(pid), KILL_TIMEOUT).await,
        "shutdown 后 agent 未在 {KILL_TIMEOUT:?} 内死亡"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn disconnect_consumes_client_and_kills_agent() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("disconnect");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "live", &dir), workspace).await;
    let pid = client.agent_pid().expect("D1：live 模式必须捕获 pid");

    // disconnect 消费 self（探针路径）：杀进程组 + 优雅信号，不 await 连接任务。
    client.disconnect().await;

    assert!(
        wait_until(|| proc_dead(pid), KILL_TIMEOUT).await,
        "disconnect 后 agent 未在 {KILL_TIMEOUT:?} 内死亡"
    );
    assert!(
        wait_until(|| proc_reaped(pid), REAP_TIMEOUT).await,
        "disconnect 后 agent 未被回收（僵尸残留）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ── 11. terminal 往返（R07：AcpTerminalManager 经真实连接）───────────────

#[tokio::test]
async fn terminal_roundtrip_create_wait_output_release() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("term");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "term", &dir), workspace).await;
    let mut terminal_events = client.terminal_event_subscribe();
    client.mark_prompt_active();

    let resp =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("terminal 链路的 prompt 未限时返回")
            .expect("terminal 链路应正常收尾");
    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    client.mark_prompt_idle();

    // wait_for_exit 的响应必须带真实退出码（命令 exit 7）。
    assert!(
        wait_for_event(&dir, "\"exitCode\":7", UNWIND_TIMEOUT).await,
        "terminal/wait_for_exit 未返回 exitCode 7：{}",
        read_events(&dir)
    );
    // output 必须带命令 stdout。
    assert!(
        wait_for_event(&dir, "term-hello", UNWIND_TIMEOUT).await,
        "terminal/output 未返回命令输出：{}",
        read_events(&dir)
    );
    // release 得到应答。
    assert!(
        wait_for_event(&dir, "term-release ", UNWIND_TIMEOUT).await,
        "terminal/release 未得到应答：{}",
        read_events(&dir)
    );
    // 前端可见性依赖的终端事件广播：Created 与 Exited 都要到达。
    let (mut created, mut exited) = (false, false);
    while !(created && exited) {
        let ev = tokio::time::timeout(UNWIND_TIMEOUT, terminal_events.recv())
            .await
            .expect("等待终端生命周期事件超时")
            .expect("终端事件通道关闭");
        match ev {
            TerminalActivity::Created { .. } => created = true,
            TerminalActivity::Exited { .. } => exited = true,
        }
    }

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn terminal_kill_then_wait_reports_no_exit_code() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("termkill");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "termkill", &dir), workspace).await;
    client.mark_prompt_active();

    let resp =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("terminal kill 链路的 prompt 未限时返回")
            .expect("terminal kill 链路应正常收尾");
    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    client.mark_prompt_idle();

    // kill 分支构造的空退出状态（被杀进程无 exit_code）——handle_kill 的
    // kill_tx → child.kill 路径，wait_for_exit 阻塞等待者被唤醒；空
    // TerminalExitStatus 序列化后 exitStatus 整体省略（实测 result 为 `{}`），
    // 与「有 exitCode 的正常退出」形态区分。
    assert!(
        wait_for_event(&dir, "\"id\":\"term-killwait\",\"result\":{}", UNWIND_TIMEOUT).await,
        "terminal/kill 后 wait_for_exit 应返回无 exit_code 的退出状态：{}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 12. 重复 env 键最后一条胜出（升级计划 D4 端到端 pin）────────────────

#[tokio::test]
async fn duplicate_env_keys_last_value_wins() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("dup-env");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    // 1.3 逐条 Command::env（后写覆盖）与 2.x BTreeMap insert（同名后插覆盖）
    // 的最终子进程环境一致；本用例经真实 spawn 钉住该语义（升级计划 D4）。
    let extra = vec![
        AgentEnvVar { key: "FAKE_DUP".into(), value: "first".into() },
        AgentEnvVar { key: "FAKE_DUP".into(), value: "second".into() },
    ];
    let client = spawn_connect(agent_for_with_env(&script, "live", &dir, extra), workspace).await;

    let dup_file = dir.join("dup.txt");
    let value = wait_until_some(|| std::fs::read_to_string(&dup_file).ok(), UNWIND_TIMEOUT)
        .await
        .expect("fake agent 未落盘 FAKE_DUP（脚本未生效？）");
    assert_eq!(value, "second", "重复 env 键必须最后一条胜出（计划 D4 pin）");

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 13. usage 快照落库：usage_update 通知 → sessions.usage_json ──────────

#[tokio::test]
async fn usage_update_notification_is_persisted() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("usage");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "usage", &dir), workspace).await;
    // 生产路径：会话注册点先 attach_config_prefs（usage 落库与配置快照共用该
    // 句柄）；未绑定时落库为 no-op（能力探针会话不写库）。
    let db = crate::acp::test_db::test_pool().await;
    client.attach_config_prefs(db.clone(), "s1".to_string(), "agent1".to_string()).await;

    client.mark_prompt_active();
    tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
        .await
        .expect("send_prompt 未在限时内返回（挂死）")
        .expect("prompt 正常链路应返回 Ok");
    client.mark_prompt_idle();

    // 通知在 send_prompt 返回前已被内联派发（通知派发串行，同第 7 节论证），
    // 落库分支已 await 完成——直接断言，无需轮询。
    let snap = crate::acp::usage::load_usage_snapshot(&db, "s1")
        .await
        .expect("usage_update 应已落库（on_agent_notification 接线）");
    assert_eq!(snap["used"], 1234);
    assert_eq!(snap["size"], 200000);
    // 会话隔离：未收到 usage 的会话不受影响。
    assert_eq!(crate::acp::usage::load_usage_snapshot(&db, "s2").await, None);

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 14. agent 侧记录删除：sessionCapabilities.delete + session/delete ────

/// 声明了 `sessionCapabilities.delete` 的 agent：`supports_delete_session()` 为真，
/// `delete_session()` 把 sessionId 原样送达 agent 并返回 Ok。
///
/// 这是「删除会话时顺带抹掉 agent 侧记录」的后端契约（计划 Phase 3）：删的是
/// **传入的** `acp_session_id`（会话行的值），不是连接自己的 session id。
#[tokio::test]
async fn delete_session_rpc_reaches_agent_and_reports_supported() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("delete-ok");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "delete", &dir), workspace).await;
    assert!(
        client.supports_delete_session(),
        "delete 模式的 agent 应声明 sessionCapabilities.delete"
    );

    tokio::time::timeout(UNWIND_TIMEOUT, client.delete_session("sess-to-delete"))
        .await
        .expect("delete_session 未在限时内返回（挂死）")
        .expect("agent 回空结果时应为 Ok");

    assert!(
        read_events(&dir).contains("delete sess-to-delete"),
        "agent 应收到 session/delete 且 sessionId 原样，实际事件日志: {:?}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 未声明能力的 agent（与 codebuddy 实测一致）：判据为假——调用方据此跳过 RPC，
/// 不盲发（`method not found` 与真失败必须能区分，计划 D3）。
#[tokio::test]
async fn delete_session_capability_absent_is_reported_false() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("delete-unsupported");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "live", &dir), workspace).await;
    assert!(
        !client.supports_delete_session(),
        "未声明 sessionCapabilities.delete 的 agent 判据必须为假（未知≠支持）"
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// agent 拒删（JSON-RPC 错误）：`delete_session` 返回 Err，调用方据此把响应标成
/// `agent_side=skipped` 并 WARN 留痕——删除失败不得被吞成成功（用户以为抹掉了
/// 痕迹、实际还在，是比删除失败更糟的结局）。
#[tokio::test]
async fn delete_session_rpc_error_surfaces_as_err() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("delete-fail");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "delete_fail", &dir), workspace).await;
    assert!(client.supports_delete_session(), "delete_fail 模式同样声明能力（只有 RPC 结果不同）");

    let result = tokio::time::timeout(UNWIND_TIMEOUT, client.delete_session("sess-x"))
        .await
        .expect("delete_session 未在限时内返回（挂死）");
    assert!(result.is_err(), "agent 回 JSON-RPC 错误时 delete_session 必须报错，实际: {result:?}");

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 16. agent 侧会话标题：session_info_update.title → sessions.agent_title ──

/// live 通知落库：`session_info_update` 带 `title` 时写 `sessions.agent_title`。
///
/// 刷新 / 换设备后侧栏的展示兜底（`name ?? agent_title ?? 宿主默认名`）由此恢复
/// ——该通知不随 `session/load` 重放、broadcast 无补发，纯前端内存态在页面生命
/// 周期结束后即丢。标题两侧空白被规范化（agent 可能原样转发用户输入）。
#[tokio::test]
async fn title_update_notification_is_persisted_trimmed() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("title");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_connect(agent_for(&script, "title", &dir), workspace).await;
    let db = crate::acp::test_db::test_pool().await;
    client.attach_config_prefs(db.clone(), "s1".to_string(), "agent1".to_string()).await;

    client.mark_prompt_active();
    tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
        .await
        .expect("send_prompt 未在限时内返回（挂死）")
        .expect("prompt 正常链路应返回 Ok");
    client.mark_prompt_idle();

    let saved = load_agent_title(&db, "s1").await;
    assert_eq!(saved.as_deref(), Some("fake agent title"), "标题应已落库且去除两侧空白");
    assert_eq!(load_agent_title(&db, "s2").await, None, "未收到标题的会话必须保持 NULL");

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// `title: null` 是协议规定的「清除」语义（§17.2），与「省略字段 = 不变」是两回事：
/// 消费方必须区分，否则 agent 清不清标题对一个把通知当增量的宿主毫无区别。
#[tokio::test]
async fn title_null_notification_clears_the_snapshot() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("title-null");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let db = crate::acp::test_db::test_pool().await;
    sqlx::query("UPDATE sessions SET agent_title = 'previous title' WHERE id = 's1'")
        .execute(&db)
        .await
        .expect("seed agent_title");

    let client = spawn_connect(agent_for(&script, "title_null", &dir), workspace).await;
    client.attach_config_prefs(db.clone(), "s1".to_string(), "agent1".to_string()).await;

    client.mark_prompt_active();
    tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
        .await
        .expect("send_prompt 未在限时内返回（挂死）")
        .expect("prompt 正常链路应返回 Ok");
    client.mark_prompt_idle();

    assert_eq!(
        load_agent_title(&db, "s1").await,
        None,
        "title:null 必须把快照清掉（协议「清除」语义），不能当成没收到"
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 回归（2026-10-16 实测复现）：`session_info_update` **不带** title 字段时，
/// 已回填的标题必须**原样保留**。
///
/// `MaybeUndefined` 三态里 `Undefined`（字段缺席）与 `Null`（显式清除）是两回事，
/// 协议原文 "Set to null to clear" 只授权后者。但 `MaybeUndefined::value()` 把
/// 两者都折成 `None`，而 `persist_title(None)` 正是清除语义——于是 agent 发任何
/// 一条不带 title 的 `session_info_update`（实测 opencode / pi-acp 用这个变体推
/// `_meta` 运行时状态）都会把标题擦掉。实测后果：库里的
/// `opencode 添加自定义供应商` 被擦成 NULL，而 agent 侧标题仍在，侧栏名字凭空消失。
#[tokio::test]
async fn title_absent_notification_keeps_the_snapshot() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("title-absent");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let db = crate::acp::test_db::test_pool().await;
    sqlx::query("UPDATE sessions SET agent_title = 'previous title' WHERE id = 's1'")
        .execute(&db)
        .await
        .expect("seed agent_title");

    let client = spawn_connect(agent_for(&script, "title_absent", &dir), workspace).await;
    client.attach_config_prefs(db.clone(), "s1".to_string(), "agent1".to_string()).await;

    client.mark_prompt_active();
    tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
        .await
        .expect("send_prompt 未在限时内返回（挂死）")
        .expect("prompt 正常链路应返回 Ok");
    client.mark_prompt_idle();

    assert_eq!(
        load_agent_title(&db, "s1").await.as_deref(),
        Some("previous title"),
        "title 字段缺席 = 本帧没提，必须原样保留（只有 title:null 才是清除）"
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

async fn load_agent_title(db: &sqlx::SqlitePool, session_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT agent_title FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(db)
        .await
        .expect("session row")
}

/// turn 结束反查的第三道门控：agent **未声明** `sessionCapabilities.list` 时
/// 连 RPC 都不发。
///
/// 实测 codebuddy（默认 agent）连 `sessionCapabilities` 都不声明、方法 `-32601`。
/// 盲问的代价不是那一次往返，而是**每一轮 turn 都问一次**、每次还跟一条 WARN。
/// 与 `list_sessions` 自身「不做能力 gate」是有意分歧：那条路是用户显式打开
/// 面板，必须把「不支持」如实呈现；这条是后台自动的，跳过即最优解。
#[tokio::test]
async fn refresh_agent_title_skips_when_agent_lacks_list_capability() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("title-no-list-cap");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);
    let db = crate::acp::test_db::test_pool().await;
    // 绑上 acp_session_id：否则即便门控坏了、RPC 真发出去，回填也匹配不到行，
    // 断言就只剩「没写库」一个信号，抓不住「省掉这次 RPC」的优化被删。
    sqlx::query("UPDATE sessions SET acp_session_id = 'sess-1' WHERE id = 's1'")
        .execute(&db)
        .await
        .expect("bind acp_session_id");

    // 共享 fake agent 的 list 模式**应答** session/list 但不声明能力——
    // 「能答」与 「声明了」是两件事，这里钉住只认声明。
    let client = spawn_connect(agent_for(&script, "list", &dir), workspace).await;
    assert!(!client.supports_list_session(), "共享 fake agent 默认不声明 list 能力");

    client.refresh_agent_title(&db, "s1").await;

    let events = read_events(&dir);
    assert!(!events.contains("list-cwd"), "未声明 list 能力时不得发 session/list: {events:?}");
    assert_eq!(load_agent_title(&db, "s1").await, None);

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ── 17. session/list：分页、上限截断、能力缺失 ────────────────────────────

/// 正常翻页 + **title 缺省必须被容忍**（§8：opencode 全给、omp 部分缺省、
/// pi-acp 给用户消息原文）。fake agent 只有第 1 条带 title，其余两条必须是
/// `None` 而不是空串或占位符——消费方不能假设「列出来的都有标题」。
#[tokio::test]
async fn list_sessions_paginates_and_tolerates_missing_titles() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    // 探针连接：只读查询不得在 agent 历史里留痕（否则面板往它展示的列表里掺数据）。
    let client = spawn_probe(agent_for(&script, "list", &dir), workspace.clone()).await;

    let (sessions, truncated) = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(None))
        .await
        .expect("list_sessions 未在限时内返回（挂死）")
        .expect("list 模式应成功");

    assert!(!truncated, "3 条未触顶不得报截断");
    assert_eq!(sessions.len(), 3, "两页应被拼齐: {:?}", sessions);
    assert_eq!(sessions[0].title.as_deref(), Some("fake session title"));
    assert_eq!(sessions[1].title, None, "缺省 title 必须是 None（可选字段，§8）");
    assert_eq!(sessions[2].title, None, "缺省 title 必须是 None（可选字段，§8）");
    assert_eq!(&*sessions[0].session_id.0, "sess-1");

    let events = read_events(&dir);
    assert!(
        events.contains("list-cursor") && !events.contains("new-session"),
        "探针模式不得发 session/new（会在 agent 历史里留一条空会话），实际事件: {events:?}"
    );
    // 翻页确实发生了：第二页请求带着第一页给的 cursor。
    assert_eq!(events.matches("list-cursor ").count(), 2, "应有两页请求: {events:?}");
    assert!(events.contains("list-cursor 2"), "第二页应带上游 cursor: {events:?}");

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// `cwd` 过滤参数原样下发（agent 侧按 cwd 组织历史，qoder 等按路径编码目录）。
/// 传 `None` 时请求里不应有 cwd 字段。
#[tokio::test]
async fn list_sessions_forwards_the_cwd_filter() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list-cwd");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_probe(agent_for(&script, "list", &dir), workspace.clone()).await;
    let _ = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(Some(&ws_str(&workspace))))
        .await
        .expect("list_sessions 未在限时内返回（挂死）")
        .expect("list 模式应成功");

    assert!(
        read_events(&dir).contains(&format!("list-cwd {}", ws_str(&workspace))),
        "cwd 应原样下发，实际事件: {:?}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 回归（2026-10-16 实测）：`session/list` 的 cwd 必须在**方法内部**去掉尾斜杠。
///
/// opencode 对该参数做**字符串级过滤**，而它建会话时会把 `/home/pax/` 规范化成
/// `/home/pax` 再存——带斜杠查回来是**空列表**（实测 25 条 vs 0 条）。空列表被
/// 读成「这个目录没有历史」，面板不报错、用户与代码都无法察觉。
///
/// 归一放在 `list_sessions` 里而不是调用点：调用点漏一处就是一次静默失败，而这
/// 正是当初漏掉的原因（当时只在 handler 侧裁了 spawn 用的 cwd，RPC 参数照旧）。
/// 与 session/new、session/load 共用 `normalize_agent_cwd`。
#[tokio::test]
async fn list_sessions_strips_trailing_slash_before_sending() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list-cwd-slash");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_probe(agent_for(&script, "list", &dir), workspace.clone()).await;
    // 复刻库里的形态：workspace_path 带尾斜杠（dev 库 14 行里 2 行如此）。
    let with_slash = format!("{}/", ws_str(&workspace));
    let _ = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(Some(&with_slash)))
        .await
        .expect("list_sessions 未在限时内返回（挂死）")
        .expect("list 模式应成功");

    // 逐行精确比对：`contains` 是子串匹配，"list-cwd /a/b/" 会把 "list-cwd /a/b"
    // 也判为命中——尾斜杠没裁掉时测试会假绿。
    let expected = format!("list-cwd {}", ws_str(&workspace));
    let events = read_events(&dir);
    assert!(
        events.lines().any(|l| l == expected),
        "尾斜杠必须在 list_sessions 内裁掉再下发，期望精确行 {expected:?}，实际: {events:?}"
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 条目数上限（§P1）：250 条可用但只取 200，且 `truncated=true`——上限维度必须
/// 匹配真实增长维度，超限策略必须是「明示截断」而不是悄悄看一部分。
#[tokio::test]
async fn list_sessions_stops_at_the_session_cap_and_reports_truncated() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list-cap");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let agent = agent_for_with_env(
        &script,
        "list",
        &dir,
        vec![
            AgentEnvVar { key: "FAKE_LIST_TOTAL".into(), value: "250".into() },
            AgentEnvVar { key: "FAKE_LIST_PAGE".into(), value: "100".into() },
        ],
    );
    let client = spawn_probe(agent, workspace.clone()).await;

    let (sessions, truncated) = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(None))
        .await
        .expect("list_sessions 未在限时内返回（挂死）")
        .expect("list 模式应成功");

    assert_eq!(sessions.len(), crate::acp::client::ACP_LIST_MAX_SESSIONS);
    assert!(truncated, "触顶必须上报截断，否则 UI 会假装看全了");
    // 触顶即停：拿到 200 条后不再发起第三页（已经决定不用了还再问一次是纯浪费）。
    assert_eq!(
        read_events(&dir).matches("list-cursor ").count(),
        2,
        "应只翻两页: {:?}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 页数上限：单页只回 1 条时，只限总条数会把请求轮次放大到 200 次——故页数
/// 是独立的上限维度（P1「上限维度必须匹配真实增长维度」）。
#[tokio::test]
async fn list_sessions_stops_at_the_page_cap() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list-pages");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let agent = agent_for_with_env(
        &script,
        "list",
        &dir,
        vec![
            AgentEnvVar { key: "FAKE_LIST_TOTAL".into(), value: "50".into() },
            AgentEnvVar { key: "FAKE_LIST_PAGE".into(), value: "1".into() },
        ],
    );
    let client = spawn_probe(agent, workspace.clone()).await;

    let (sessions, truncated) = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(None))
        .await
        .expect("list_sessions 未在限时内返回（挂死）")
        .expect("list 模式应成功");

    assert_eq!(sessions.len(), crate::acp::client::ACP_LIST_MAX_PAGES);
    assert!(truncated, "还有 40 条没拉，必须上报截断");
    assert_eq!(
        read_events(&dir).matches("list-cursor ").count(),
        crate::acp::client::ACP_LIST_MAX_PAGES,
        "请求轮次必须被页数上限钉住: {:?}",
        read_events(&dir)
    );

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 不支持的 agent（复刻 codebuddy：连 `sessionCapabilities` 都不声明，
/// `session/list` 回 `-32601`）：错误必须透出，由 UI 明示「该 agent 不支持」
/// 而不是显示一个空白列表——空白列表会被读成「你没有历史」。
///
/// 注意这里**没有**能力 gate：`session/list` 的能力位在实测实现里覆盖不一
/// （omp 声明了 `list` 却对部分会话不给 title），gate 会把「不支持」与「声明了
/// 但 RPC 失败」混成一谈，而 method-not-found 的原文已足以对用户如实交代。
#[tokio::test]
async fn list_sessions_unsupported_agent_surfaces_error() {
    let _guard = spawn_test_lock_async().await;
    let dir = unique_dir("list-nope");
    let workspace = dir.join("ws");
    std::fs::create_dir_all(&workspace).expect("create workspace");
    let script = write_fake_agent(&dir);

    let client = spawn_probe(agent_for(&script, "list_nope", &dir), workspace.clone()).await;
    let result = tokio::time::timeout(UNWIND_TIMEOUT, client.list_sessions(None))
        .await
        .expect("list_sessions 未在限时内返回（挂死）");
    assert!(result.is_err(), "method not found 必须透出为 Err，实际: {result:?}");

    client.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// workspace 路径的字符串形态（fake agent 原样回抄，测试端按同形态断言）。
fn ws_str(ws: &Path) -> String {
    ws.to_string_lossy().into_owned()
}
