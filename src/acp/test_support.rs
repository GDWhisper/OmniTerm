//! fake agent 测试公共设施（`cfg(all(test, target_os = "linux"))`）。
//!
//! 抽出动机（工程准则 6）：协议链路测试（`fake_agent_tests`）与 `supervisor` 测试
//! 需要同一套「最小 JSON-RPC fake agent + 进程探针」，复制两份必然漂移。
//!
//! 形态决策见 `docs/dev/plans/2026-10-01-acp-sdk-v2-upgrade.md` D5：
//! crate 的 `Responder::new` 为私有（`agent-client-protocol` 2.2.0
//! `jsonrpc.rs:4540`），`PermissionManager` / `AcpTerminalManager` 无法在单测中
//! 直构 Responder——只能由 fake agent 经真实连接驱动，故本文件是它们的测试基座。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::acp::client::AcpClient;
use crate::models::agent::{Agent, AgentEnvVar};

/// spawn 超时：fake agent 不响应时 `conn_rx.await` 会永久挂起（既有行为），
/// 测试必须自己设限，否则坏脚本会让 CI 挂死而不是失败。
pub(crate) const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
/// agent 退出后连接任务 unwind / 孙进程登记的限时。
pub(crate) const UNWIND_TIMEOUT: Duration = Duration::from_secs(5);
/// shutdown 后进程死亡的限时。旧实现要等 crate 优雅路径 ~1s 宽限期后才击杀，
/// killpg 在 shutdown() 返回前已发出 → 750ms 足以区分且留足新路径余量。
pub(crate) const KILL_TIMEOUT: Duration = Duration::from_millis(750);
/// 进程被完整回收（不残留僵尸）的限时。
pub(crate) const REAP_TIMEOUT: Duration = Duration::from_secs(5);
/// fake agent / 孙进程的存活上限（秒）：断言失败时也不无限驻留。脚本内以
/// `@LIFETIME@` 占位，`write_fake_agent` 时替换。
const FAKE_AGENT_LIFETIME: &str = "25";

/// 最小 JSON-RPC fake agent（test-only，勿用于生产路径）。
///
/// 行为由 env 驱动（经 `agent.env` 注入，随 wrapper 的 all_args 前缀传入）：
/// - `FAKE_MODE=hang`：**不响应 initialize**（`exec sleep` 驻留）——模拟坏二进制 /
///   npx 冷启动超过探针 15s 预算的时序，用于 P2-3 回归（spawn 超时后 agent 进程
///   必须被回收，不得泄漏）；
/// - `FAKE_MODE=handshake`：响应 initialize 后**立刻退出**（exit 3，session/new
///   永远等不到响应）——建模「agent 死于握手期」，`spawn_and_connect` 必须限时
///   失败而不是挂死；
/// - `FAKE_MODE=crash`：响应 initialize + session/new 后，收到 `session/prompt`
///   **不回响应直接退出**（exit 3）——建模「agent 死于 turn 进行中」的现场时序；
/// - `FAKE_MODE=exit`：响应 initialize + session/new 后**等待测试放行哨兵**
///   （`FAKE_EXIT_FILE` 出现）再无流量退出（exit 3）；
/// - `FAKE_MODE=live`：响应后持续驻留（stdin 保持打开，`while read` 阻塞）；
/// - `FAKE_MODE=group`：响应后 fork 孙进程（`sleep`，pid 写入
///   `FAKE_GRANDCHILD_PID_FILE`）再驻留——孙进程与 leader 同进程组且持有继承
///   stdio，模拟 wrapper launcher 场景；
/// - `FAKE_MODE=prompt_ok`：收到 prompt 后先推一条 `agent_message_chunk`
///   `session/update`（text 固定 "hello-from-agent"），再以 `end_turn` 应答
///   ——覆盖 prompt 正常链路 + 通知广播/累积器折叠；
/// - `FAKE_MODE=usage`：收到 prompt 后推一条 `usage_update`（used=1234 /
///   size=200000）再以 `end_turn` 收尾——覆盖 usage 快照落库接线（刷新 / 换设备
///   后 hydrate 的恢复来源）；
/// - `FAKE_MODE=cancel`：收到 prompt 后驻留，等 `session/cancel` 通知到达才以
///   `cancelled` 应答（同时把 prompt id 记入事件日志）——覆盖 cancel 链路；
/// - `FAKE_MODE=perm`：收到 prompt 后发 `session/request_permission`（id 固定
///   `perm-1`，选项 allow/deny），把收到的应答原文记入事件日志，再以 `end_turn`
///   收尾——覆盖 PermissionManager 往返（resolve 与 cancel_all 共用本模式）；
/// - `FAKE_MODE=term`：收到 prompt 后驱动 `terminal/*` 四连
///   （create→wait_for_exit→output→release，命令 `printf term-hello; exit 7`），
///   每步响应记入事件日志，最后以 `end_turn` 收尾——覆盖 AcpTerminalManager
///   的创建/输出/等待退出/释放；
/// - `FAKE_MODE=termkill`：收到 prompt 后 create（`sleep 30`）→ kill →
///   wait_for_exit，覆盖 kill 路径（被杀进程无 exit_code）；
/// - `FAKE_MODE=delete` / `delete_fail`：initialize **声明**
///   `sessionCapabilities.delete`（其余模式不声明——与 codebuddy 实测一致，
///   覆盖能力 gate 的反面）；前者对 `session/delete` 回空结果，后者回 JSON-RPC
///   错误，两条路径都把收到的 sessionId 记入事件日志（`delete <id>`）——
///   覆盖「agent 侧记录删除」的成功与失败分支；
/// - 任意模式启动时若 `FAKE_DUP` / `FAKE_DUP_FILE` 同时存在，把 `$FAKE_DUP`
///   写入文件——钉「重复 env 键最后一条胜出」语义（计划 D4）。
///
/// 通用事件日志：`FAKE_EVENTS_FILE` 存在时，关键协议事件逐行追加（`prompt` /
/// `cancel` / `perm-response <原文>` / `term-* <原文>`），测试端轮询断言。
pub(crate) const FAKE_AGENT_SCRIPT: &str = r#"#!/bin/sh
# test-only fake ACP agent（计划 D5）。响应 initialize（声明 loadSession，restore
# 路径也要能建连）与 session/new，之后按 FAKE_MODE 行动。
log_event() { [ -n "$FAKE_EVENTS_FILE" ] && printf '%s\n' "$1" >> "$FAKE_EVENTS_FILE"; }
if [ -n "$FAKE_DUP_FILE" ] && [ -n "$FAKE_DUP" ]; then
  printf '%s' "$FAKE_DUP" > "$FAKE_DUP_FILE"
fi
if [ "$FAKE_MODE" = "hang" ]; then
  exec sleep @LIFETIME@
fi
prompt_count=0
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      # sessionCapabilities.delete 是 marker 空结构（存在即支持 session/delete）。
      # 默认**不声明**（与 codebuddy 一致），只有 delete/delete_fail 模式声明——
      # 两条初始化响应路径都要覆盖能力 gate 的正反两面。
      case "$FAKE_MODE" in
        delete|delete_fail) sess_caps='"sessionCapabilities":{"delete":{}},' ;;
        *) sess_caps='' ;;
      esac
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{%s"loadSession":true,"promptCapabilities":{}}}}\n' "$id" "$sess_caps"
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
    *'"method":"session/delete"'*)
      # agent 侧记录删除（sessionCapabilities.delete）：把收到的 sessionId 记入
      # 事件日志（测试端据此断言「删的是哪一条」），并回空结果（协议规定对不存在
      # 的会话 SHOULD 静默成功）。delete_fail 模式改为回 JSON-RPC 错误，覆盖
      # 「agent 拒删」这一失败分支。
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      del_sid=$(printf '%s' "$line" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
      log_event "delete $del_sid"
      if [ "$FAKE_MODE" = "delete_fail" ]; then
        printf '{"jsonrpc":"2.0","id":"%s","error":{"code":-32603,"message":"boom"}}\n' "$id"
      else
        printf '{"jsonrpc":"2.0","id":"%s","result":{}}\n' "$id"
      fi
      ;;
    *'"method":"session/prompt"'*)
      prompt_id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      log_event "prompt"
      case "$FAKE_MODE" in
        crash)
          # agent 在 turn 进行中崩溃——不回响应，直接退出。
          exit 3
          ;;
        sticky_cancel)
          # 建模 codebuddy 的「粘滞取消」（实测 2.161.4）：第 1 轮不答话，等
          # session/cancel 来回 cancelled；第 2 轮（cancel 之后紧接的新 prompt）秒回
          # cancelled 且不带 userMessageId——即这一轮 agent 根本没跑，用户消息被吞；
          # 第 3 轮起才正常 end_turn。宿主须识别第 2 轮不是用户要的取消并重发，
          # 见 client.rs 的 STALE_CANCEL_* 常量。
          prompt_count=$((prompt_count + 1))
          case "$prompt_count" in
            1) : ;;
            2) printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"cancelled"}}\n' "$prompt_id" ;;
            *) printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id" ;;
          esac
          ;;
        prompt_ok)
          printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello-from-agent"}}}}\n'
          printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id"
          ;;
        usage)
          printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-session","update":{"sessionUpdate":"usage_update","used":1234,"size":200000}}}\n'
          printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id"
          ;;
        perm)
          printf '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"fake-session","toolCall":{"toolCallId":"t1","title":"Bash","kind":"execute","content":"echo hi"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"deny","name":"Deny","kind":"reject_once"}]}}\n'
          ;;
        term)
          printf '{"jsonrpc":"2.0","id":"term-create","method":"terminal/create","params":{"sessionId":"fake-session","command":"/bin/sh","args":["-c","printf term-hello; exit 7"]}}\n'
          ;;
        termkill)
          printf '{"jsonrpc":"2.0","id":"term-create","method":"terminal/create","params":{"sessionId":"fake-session","command":"/bin/sh","args":["-c","sleep 30"]}}\n'
          ;;
      esac
      ;;
    *'"method":"session/cancel"'*)
      log_event "cancel"
      # cancel 模式的正常收尾；perm 模式下 cancel 与审批应答可能竞速，
      # prompt 应答重复发送无害（客户端只认第一次响应，后者报 id 未知）。
      printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"cancelled"}}\n' "$prompt_id"
      ;;
    *'"id":"perm-1"'*)
      log_event "perm-response $line"
      printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id"
      ;;
    *'"id":"term-create"'*)
      term_id=$(printf '%s' "$line" | sed -n 's/.*"terminalId":"\([^"]*\)".*/\1/p')
      log_event "term-create $term_id"
      if [ "$FAKE_MODE" = "termkill" ]; then
        printf '{"jsonrpc":"2.0","id":"term-kill","method":"terminal/kill","params":{"sessionId":"fake-session","terminalId":"%s"}}\n' "$term_id"
      else
        printf '{"jsonrpc":"2.0","id":"term-wait","method":"terminal/wait_for_exit","params":{"sessionId":"fake-session","terminalId":"%s"}}\n' "$term_id"
      fi
      ;;
    *'"id":"term-wait"'*)
      log_event "term-wait $line"
      printf '{"jsonrpc":"2.0","id":"term-output","method":"terminal/output","params":{"sessionId":"fake-session","terminalId":"%s"}}\n' "$term_id"
      ;;
    *'"id":"term-output"'*)
      log_event "term-output $line"
      printf '{"jsonrpc":"2.0","id":"term-release","method":"terminal/release","params":{"sessionId":"fake-session","terminalId":"%s"}}\n' "$term_id"
      ;;
    *'"id":"term-release"'*)
      log_event "term-release $line"
      printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id"
      ;;
    *'"id":"term-kill"'*)
      log_event "term-kill $line"
      printf '{"jsonrpc":"2.0","id":"term-killwait","method":"terminal/wait_for_exit","params":{"sessionId":"fake-session","terminalId":"%s"}}\n' "$term_id"
      ;;
    *'"id":"term-killwait"'*)
      log_event "term-killwait $line"
      printf '{"jsonrpc":"2.0","id":"%s","result":{"stopReason":"end_turn"}}\n' "$prompt_id"
      ;;
  esac
done
exit 0
"#;

pub(crate) fn unique_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omniterm-fake-agent-{tag}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("create fake agent test dir");
    dir
}

pub(crate) fn write_fake_agent(dir: &Path) -> PathBuf {
    let script = dir.join("fake-agent.sh");
    let content = FAKE_AGENT_SCRIPT.replace("@LIFETIME@", FAKE_AGENT_LIFETIME);
    std::fs::write(&script, content).expect("write fake agent script");
    script
}

/// 构造走 wrapper 路径的 Agent：`command = /bin/sh` + `args = [script]`，
/// omniterm 侧包装成 `sh -c 'cd <ws> && echo $$ > <pid 文件> && exec /bin/sh <script>'`。
/// mode / 孙进程 pid 文件 / 退出放行哨兵 / 事件日志 / 重复键落盘文件经 env 注入
/// （`AcpAgent::from_args` 的 KEY=VALUE 前缀）。副作用文件统一落在 `dir` 下
/// （测试侧按同路径取用，见 [`events_file`]）。
pub(crate) fn agent_for(script: &Path, mode: &str, dir: &Path) -> Agent {
    agent_for_with_env(script, mode, dir, Vec::new())
}

/// 同 [`agent_for`]，追加测试自定义 env（如 D4 的重复键用例）。
pub(crate) fn agent_for_with_env(
    script: &Path,
    mode: &str,
    dir: &Path,
    extra: Vec<AgentEnvVar>,
) -> Agent {
    let mut env = vec![
        AgentEnvVar { key: "FAKE_MODE".into(), value: mode.into() },
        AgentEnvVar {
            key: "FAKE_GRANDCHILD_PID_FILE".into(),
            value: dir.join("grandchild.pid").to_string_lossy().to_string(),
        },
        AgentEnvVar {
            key: "FAKE_EXIT_FILE".into(),
            value: dir.join("exit.gate").to_string_lossy().to_string(),
        },
        AgentEnvVar {
            key: "FAKE_EVENTS_FILE".into(),
            value: events_file(dir).to_string_lossy().to_string(),
        },
        AgentEnvVar {
            key: "FAKE_DUP_FILE".into(),
            value: dir.join("dup.txt").to_string_lossy().to_string(),
        },
    ];
    env.extend(extra);
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

/// 事件日志路径（fake agent 追加、测试端轮询读取）。
pub(crate) fn events_file(dir: &Path) -> PathBuf {
    dir.join("events.log")
}

/// 读事件日志原文（文件不存在时为空串）。
pub(crate) fn read_events(dir: &Path) -> String {
    std::fs::read_to_string(events_file(dir)).unwrap_or_default()
}

pub(crate) async fn spawn_connect(agent: Agent, cwd: PathBuf) -> AcpClient {
    tokio::time::timeout(SPAWN_TIMEOUT, AcpClient::spawn_and_connect(agent, cwd, &HashMap::new()))
        .await
        .expect("spawn 超时：fake agent 未在限时内完成 initialize/session/new")
        .expect("spawn_and_connect 失败")
}

/// `/proc/<pid>/stat` 的进程状态字符（None = 进程已不存在）。
/// comm 字段可能含空格/括号，rsplit 到最后一个 ')' 后第 1 个字段即 state
/// （与 acp/agent_proc.rs、agent/process.rs 同口径）。
pub(crate) fn proc_state(pid: u32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = stat.rsplit_once(')')?.1;
    after_comm.split_whitespace().next().and_then(|s| s.chars().next())
}

/// 进程活着（僵尸不算：未被收割前 pid 还在，但已不执行任何代码）。
pub(crate) fn proc_alive(pid: u32) -> bool {
    matches!(proc_state(pid), Some(state) if state != 'Z')
}

/// 进程已死（不存在或僵尸均可——SIGKILL 后先变僵尸，等待收割）。
pub(crate) fn proc_dead(pid: u32) -> bool {
    !proc_alive(pid)
}

/// 进程被完整回收（/proc 条目消失，无僵尸残留）。
pub(crate) fn proc_reaped(pid: u32) -> bool {
    proc_state(pid).is_none()
}

pub(crate) async fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
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
pub(crate) async fn wait_until_some<T>(
    mut f: impl FnMut() -> Option<T>,
    timeout: Duration,
) -> Option<T> {
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

/// 轮询事件日志直到包含 `needle`（超时 false）。
pub(crate) async fn wait_for_event(dir: &Path, needle: &str, timeout: Duration) -> bool {
    wait_until(|| read_events(dir).contains(needle), timeout).await
}
