//! fake agent 回归测试（计划 D5 / P1-2）：最小 JSON-RPC agent 驱动真实 ACP
//! 连接时序，钉住 omniterm 侧契约。公共设施（脚本 / spawn / 进程探针）在
//! [`crate::acp::test_support`]。
//!
//! 覆盖：
//! 1. **agent 死于 turn 进行中**（现场真实时序）：在途 prompt 快速失败（死连接
//!    的实时失败语义——`is_alive()` 对已崩溃 agent 误报存活是 crate 既有行为，
//!    生产实际靠请求失败兜底，见下方「边界」），agent 被回收无残留，shutdown
//!    干净收尾；
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
//!     通知本身不随 session/load 重放、广播无补发）。
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
//!   时 client 尚未构造、无人订阅。`is_alive()` 对「已崩溃 agent」**误报存活**
//!   同此根因（既有 crate 行为，非 omniterm 引入；生产实际靠 `send_request`
//!   报 "connection is no longer running" 兜底）。本文件因此不断言广播，改为
//!   断言请求失败/进程回收/teardown 鲁棒这些真实契约；`is_alive` 的误报在
//!   mid-prompt 用例里被显式钉住（pin 既有行为，升级 crate 时若变化应主动复查）。
//!   2026-10-01 升级 SDK 1.3→2.2.0 后这两条 pin 仍成立（`./dev.sh test` 全绿）。
//!
//! wire 契约（crate 2.2.0 / schema 1.9.1 复核，改测试前先核对）：
//! - 换行分隔 JSON-RPC 2.0，client 请求 `{"jsonrpc":"2.0","id":"<uuid>","method":"initialize","params":{...}}`；
//! - **请求 id 是 UUID 字符串**（`RequestId::Str(uuid)`，非数字），响应必须原文回抄；
//! - `ProtocolVersion` 是 newtype u16 → 裸数字；`SessionId` 透明字符串；
//! - `InitializeResponse` 的 `agentCapabilities` / `authMethods` 均可缺省；
//! - method 名：`initialize` / `session/new` / `session/prompt` / `session/load` /
//!   `session/cancel`（通知）/ `session/request_permission` / `terminal/*`。

use std::collections::HashMap;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate, StopReason};

use crate::acp::agent_proc;
use crate::acp::agent_proc::spawn_test_lock_async;
use crate::acp::client::AcpClient;
use crate::acp::terminal::TerminalActivity;
use crate::acp::test_support::{
    KILL_TIMEOUT, REAP_TIMEOUT, SPAWN_TIMEOUT, UNWIND_TIMEOUT, agent_for, agent_for_with_env,
    proc_alive, proc_dead, proc_reaped, read_events, spawn_connect, unique_dir, wait_for_event,
    wait_until, wait_until_some, write_fake_agent,
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
    // 的实时失败语义，生产靠它兜底（is_alive 对已崩溃 agent 误报存活，见模块
    // 文档「边界」）。
    let prompt_result =
        tokio::time::timeout(UNWIND_TIMEOUT, client.send_prompt("hi", vec![], vec![], vec![]))
            .await
            .expect("send_prompt 未在限时内返回（挂死）");
    assert!(
        prompt_result.is_err(),
        "agent 死于 prompt 在途时 send_prompt 应失败，实际: {prompt_result:?}"
    );

    // pin crate 既有行为（升级 crate 时若翻转应主动复查 is_alive 判定）：
    // agent 已死但连接任务 parks 在 shutdown_rx 上、incoming 也未关闭，
    // is_alive() 此时误报存活。
    assert!(wait_until(|| proc_reaped(pid), UNWIND_TIMEOUT).await, "agent 死亡后未被 crate 回收");
    assert!(
        client.is_alive(),
        "is_alive() 对已崩溃 agent 的误报存活是 crate 既有行为（见模块文档），\
         此处 pin 住；若本断言失败说明 crate 行为已变，须复查 is_alive 判定与 \
         backend.md 的描述"
    );

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
