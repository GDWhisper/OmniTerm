//! fake agent 回归测试（计划 D5 / P1-2）：最小 JSON-RPC agent 驱动真实 ACP
//! 连接时序，钉住 omniterm 侧 teardown 契约。
//!
//! 覆盖（2026-09-21 CPU 尖峰修复 Phase 2）：
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
//!    （`spawn_and_load`）两条构造路径都覆盖（防 272 行重复只改一处）。
//!
//! **边界（勿过度解读）**：
//! - 本测试**不复现**上游 crate 的 pidfd 空转（依赖未识别的 poll/wake 交错，
//!   最小复现实验阴性），只固化 omniuterm 侧可控契约；crate 自身在连接 actor
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
//!
//! wire 契约（crate 1.3.0 / schema 1.4.0 实证，改测试前先核对）：
//! - 换行分隔 JSON-RPC 2.0，client 请求 `{"jsonrpc":"2.0","id":"<uuid>","method":"initialize","params":{...}}`；
//! - **请求 id 是 UUID 字符串**（`RequestId::Str(uuid)`，非数字），响应必须原文回抄；
//! - `ProtocolVersion` 是 newtype u16 → 裸数字；`SessionId` 透明字符串；
//! - `InitializeResponse` 的 `agentCapabilities` / `authMethods` 均可缺省；
//! - method 名：`initialize` / `session/new` / `session/prompt` / `session/load`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::acp::agent_proc::spawn_test_lock_async;
use crate::acp::client::AcpClient;
use crate::models::agent::{Agent, AgentEnvVar};

/// spawn 超时：fake agent 不响应时 `conn_rx.await` 会永久挂起（既有行为），
/// 测试必须自己设限，否则坏脚本会让 CI 挂死而不是失败。
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
/// agent 退出后连接任务 unwind / 孙进程登记的限时。
const UNWIND_TIMEOUT: Duration = Duration::from_secs(5);
/// shutdown 后进程死亡的限时。旧实现要等 crate 优雅路径 ~1s 宽限期后才击杀，
/// killpg 在 shutdown() 返回前已发出 → 750ms 足以区分且留足新路径余量。
const KILL_TIMEOUT: Duration = Duration::from_millis(750);
/// 进程被完整回收（不残留僵尸）的限时。
const REAP_TIMEOUT: Duration = Duration::from_secs(5);
/// fake agent / 孙进程的存活上限（秒）：断言失败时也不无限驻留。脚本内以
/// `@LIFETIME@` 占位，`write_fake_agent` 时替换。
const FAKE_AGENT_LIFETIME: &str = "25";

/// 最小 JSON-RPC fake agent（test-only，勿用于生产路径）。
///
/// 行为由 env 驱动（经 `agent.env` 注入，随 wrapper 的 all_args 前缀传入）：
/// - `FAKE_MODE=handshake`：响应 initialize 后**立刻退出**（exit 3，session/new
///   永远等不到响应）——建模「agent 死于握手期」，`spawn_and_connect` 必须限时
///   失败而不是挂死；
/// - `FAKE_MODE=crash`：响应 initialize + session/new 后，收到 `session/prompt`
///   **不回响应直接退出**（exit 3）——建模「agent 死于 turn 进行中」的现场时序。
///   在途 prompt 请求随之失败 → 内层闭包 Err → 连接任务 Err → crash watcher
///   广播（见模块文档对 crate 竞态的说明）；
/// - `FAKE_MODE=exit`：响应 initialize + session/new 后**等待测试放行哨兵**
///   （`FAKE_EXIT_FILE` 出现）再无流量退出（exit 3）。哨兵把「agent 退出」变成
///   测试可控的同步点（否则断言与退出互相竞速）；stdin 由客户端保持打开，
///   read 循环不会自行结束，故哨兵轮询必须挂在分支内；
/// - `FAKE_MODE=live`：响应后持续驻留（stdin 保持打开，`while read` 阻塞）；
/// - `FAKE_MODE=group`：响应后 fork 孙进程（`sleep`，pid 写入
///   `FAKE_GRANDCHILD_PID_FILE`）再驻留——孙进程与 leader 同进程组且持有继承
///   stdio，模拟 wrapper launcher 场景。
const FAKE_AGENT_SCRIPT: &str = r#"#!/bin/sh
# test-only fake ACP agent（计划 D5）。响应 initialize（声明 loadSession，restore
# 路径也要能建连）与 session/new，之后按 FAKE_MODE 行动。
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{}}}}\n' "$id"
      # handshake 模式：响应 initialize 后立刻崩溃（session/new 永远等不到
      # 响应）——建模「agent 死于握手期」，spawn 必须限时失败而不是挂死。
      if [ "$FAKE_MODE" = "handshake" ]; then
        exit 3
      fi
      ;;
    *'"method":"session/new"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessionId":"fake-session"}}\n' "$id"
      if [ "$FAKE_MODE" = "group" ]; then
        sleep @LIFETIME@ &
        echo $! > "$FAKE_GRANDCHILD_PID_FILE"
      fi
      if [ "$FAKE_MODE" = "exit" ]; then
        while [ ! -f "$FAKE_EXIT_FILE" ]; do sleep 1; done
        exit 3
      fi
      ;;
    *'"method":"session/prompt"'*)
      # crash 模式：agent 在 turn 进行中崩溃——不回响应，直接退出。
      if [ "$FAKE_MODE" = "crash" ]; then
        exit 3
      fi
      ;;
  esac
done
exit 0
"#;

// ── helpers ──────────────────────────────────────────────────────────────

fn unique_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omniterm-fake-agent-{tag}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("create fake agent test dir");
    dir
}

fn write_fake_agent(dir: &Path) -> PathBuf {
    let script = dir.join("fake-agent.sh");
    let content = FAKE_AGENT_SCRIPT.replace("@LIFETIME@", FAKE_AGENT_LIFETIME);
    std::fs::write(&script, content).expect("write fake agent script");
    script
}

/// 构造走 wrapper 路径的 Agent：`command = /bin/sh` + `args = [script]`，
/// omniterm 侧包装成 `sh -c 'cd <ws> && echo $$ > <pid 文件> && exec /bin/sh <script>'`。
/// mode / 孙进程 pid 文件 / 退出放行哨兵经 env 注入（`AcpAgent::from_args` 的
/// KEY=VALUE 前缀）。副作用文件统一落在 `dir` 下（测试侧按同路径取用）：
/// `grandchild.pid`（group 模式孙进程登记）与 `exit.gate`（exit 模式放行哨兵）。
fn agent_for(script: &Path, mode: &str, dir: &Path) -> Agent {
    let env = vec![
        AgentEnvVar { key: "FAKE_MODE".into(), value: mode.into() },
        AgentEnvVar {
            key: "FAKE_GRANDCHILD_PID_FILE".into(),
            value: dir.join("grandchild.pid").to_string_lossy().to_string(),
        },
        AgentEnvVar {
            key: "FAKE_EXIT_FILE".into(),
            value: dir.join("exit.gate").to_string_lossy().to_string(),
        },
    ];
    Agent {
        id: "fake-agent".into(),
        display_name: "Fake ACP Agent".into(),
        command: "/bin/sh".into(),
        args: vec![script.to_string_lossy().to_string()],
        env,
        npm_package: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

async fn spawn_connect(agent: Agent, cwd: PathBuf) -> AcpClient {
    tokio::time::timeout(SPAWN_TIMEOUT, AcpClient::spawn_and_connect(agent, cwd, &HashMap::new()))
        .await
        .expect("spawn 超时：fake agent 未在限时内完成 initialize/session/new")
        .expect("spawn_and_connect 失败")
}

/// `/proc/<pid>/stat` 的进程状态字符（None = 进程已不存在）。
/// comm 字段可能含空格/括号，rsplit 到最后一个 ')' 后第 1 个字段即 state
/// （与 acp/agent_proc.rs、agent/process.rs 同口径）。
fn proc_state(pid: u32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = stat.rsplit_once(')')?.1;
    after_comm.split_whitespace().next().and_then(|s| s.chars().next())
}

/// 进程活着（僵尸不算：未被收割前 pid 还在，但已不执行任何代码）。
fn proc_alive(pid: u32) -> bool {
    matches!(proc_state(pid), Some(state) if state != 'Z')
}

/// 进程已死（不存在或僵尸均可——SIGKILL 后先变僵尸，等待收割）。
fn proc_dead(pid: u32) -> bool {
    !proc_alive(pid)
}

/// 进程被完整回收（/proc 条目消失，无僵尸残留）。
fn proc_reaped(pid: u32) -> bool {
    proc_state(pid).is_none()
}

async fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if cond() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return cond();
        }
        tokio::time::sleep(Duration::from_millis(10).min(deadline - now)).await;
    }
}

/// 轮询直到闭包产出 `Some`（超时返回 None）。用于等待副作用文件出现并取其内容。
async fn wait_until_some<T>(mut f: impl FnMut() -> Option<T>, timeout: Duration) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        let now = Instant::now();
        if now >= deadline {
            return f();
        }
        tokio::time::sleep(Duration::from_millis(10).min(deadline - now)).await;
    }
}

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
