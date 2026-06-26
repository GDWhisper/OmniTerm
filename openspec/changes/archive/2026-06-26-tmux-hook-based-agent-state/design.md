## Context

OmniTerm 当前 agent 状态检测方案：`capture-pane` 抓最后 50 行 → `scan_agent_state` 正则匹配。存在根本性缺陷——依赖 pane 缓冲区中恰好可见的文本，大量漏报误报，且每次查询多一次子进程调用。

tmuxes 的方案是利用 agent CLI 生命周期 hook，在每个状态变化时触发 `tmux set-option @tmuxes_agent <value>`，服务端读 session 列表时一并拿到状态。但 tmuxes 的前端体验依赖于 5 秒轮询——不差，但远非最优。OmniTerm 已经有常驻的终端 WebSocket 连接，可以做到更好。

## Goals / Non-Goals

**Goals:**
- **Tier 1 — 对标 tmuxes**: Hook 驱动的精确 agent 状态、前端 Attention 通知系统（声音/badge/标签页闪烁）、智能 diff 去抖
- **Tier 2 — 超越 tmuxes**: 通过现有终端 WebSocket 连接实时推送 agent 状态变化（1s 延迟 vs tmuxes 的 5s），侧边栏轮询提速到 3s
- API 向后兼容
- 支持 Claude Code + Codex 两种 agent CLI

**Non-Goals:**
- 支持 Claude Code / Codex 以外的 agent CLI（架构预留扩展点，但本次不实现）
- 修改 session 创建 API 契约（command 字段可选，不强制）
- 修改前端布局或组件结构（在现有组件基础上增量添加通知功能）

## Decisions

### Decision 1: 双层状态通道 —— Session 列表轮询 + WebSocket 实时推送

tmuxes 只有一层：前端每 5s 轮询 session 列表。OmniTerm 做两层：

| 通道 | 延迟 | 覆盖范围 | 用途 |
|------|------|----------|------|
| Session 列表轮询 | 3s | 所有 session | 侧边栏 badge + 全局通知 |
| 终端 WebSocket 推送 | ~1s | 当前活跃 session | 终端内状态指示 + 即时声音通知 |

**实现方式**: 终端 WebSocket handler (`ws/terminal.rs`) 通过 `tokio::spawn` 启动一个独立的 agent 轮询 task，用 `tokio::sync::oneshot` channel 做取消信号。检测到 nonce 变化时通过 JSON control frame 推送给前端。轮询 task 必须在 `handle_terminal` 返回前被显式取消并 await join，防止 task 泄漏。详见 Resource Safety 节。

**Alternatives considered**:
- 只用轮询（tmuxes 做法）: 简单但延迟高。Rejected — 我们有 WS 连接，不利用是浪费。
- Hook 命令直接回调 OmniTerm HTTP API: `curl http://localhost:9777/...` 耦合严重、需要 curl 可用、有网络开销。Rejected。
- tmux `monitor-session-option` 等价物: tmux 无此功能。不可行。
- inotify 监听 tmux server 的 socket: 过于 hacky，跨平台问题。Rejected。

### Decision 2: Session option 名称 `@omniterm_agent`，值格式对标 tmuxes

```
<agent_kind>:<state>:<reason>:<event>:<nonce>
```

示例: `claude:waiting:decision:PermissionRequest:1719000000.12345`

- `agent_kind`: `claude` | `codex`
- `state`: `running` | `waiting` | `idle`
- `reason`: `decision` | `done` | `error` | 空
- `event`: hook 事件名（如 `UserPromptSubmit`, `PermissionRequest`, `Stop`）
- `nonce`: `$(date +%s).$$` — 时间戳+进程号，前端用来检测是否为新的状态事件

**Rationale**: 与 tmuxes 完全一致的格式，方便互操作。nonce 字段是实现智能 diff 的关键——没有它，前端无法区分"还是同一个 waiting 状态"和"新一轮 waiting 状态"。

### Decision 3: Hook 注入时机

- **Session 创建时**: 检测命令中的 agent CLI，自动注入 hook 配置参数
- **手动 hook-enable**: 用户调用 `POST /sessions/{id}/hook-enable` 时，检测 session 中是否有 agent 进程，有则重新注入
- **初始 option 值**: 创建 session 后、启动 agent 前，先 `tmux set-option @omniterm_agent omniterm:running::launch:<ts>` 确保 option 存在

### Decision 4: Claude Code hook 映射

| Hook 事件 | Agent 状态 | Attention 原因 |
|-----------|-----------|---------------|
| `UserPromptSubmit` | `running` | — |
| `PreToolUse` | `running` | — |
| `PostToolUse` | `running` | — |
| `PermissionRequest` | `waiting` | `decision` |
| `Notification.permission_prompt` | `waiting` | `decision` |
| `Notification.elicitation_dialog` | `waiting` | `decision` |
| `Stop` | `idle` | `done` |
| `StopFailure` | `idle` | `error` |
| `SessionEnd` | `idle` | `done` |

**Rationale**: `PermissionRequest` 和两个 `Notification` 事件都映射为 `waiting + decision`，因为此时 agent 都在等用户输入。其他事件做详细区分以便未来扩展。

### Decision 5: 前端 Attention 系统架构

对标 tmuxes 的 `attention.tsx`，但做 Rust 后端适配：

```
AttentionProvider (React Context)
├── alerts: Map<sessionKey, AttentionReason>
├── fire(targetId, session, reason) → setState + playSound
├── clearAlert(targetId, session) → remove from map
├── setActive(targetId, session) → acknowledge viewed session
└── useEffect → tab title flash when hidden

TargetGroup / Sidebar
├── detectAttention(sessions[]) → compare eventKey across polls
│   ├── new waiting+decision → wait 1 more cycle → fire('decision')
│   ├── new done/error → fire immediately
│   └── running → clearAlert
└── render SessionRow with badge
```

**Sound**: 使用 Web Audio API 生成短促 sine wave ping（880Hz, 300ms decay），无需加载音频文件。

### Decision 6: `list_sessions` 格式串统一使用 `|` 分隔

tmuxes 使用 `|` 作为 `list-sessions -F` 格式串的分隔符，并将 free-form 字段（session name）放在最后，用 `parts[N..].join("|")` 恢复——即使 name 中包含 `|` 也不会错位。

OmniTerm 现有代码使用 `\t`（tab）分隔。新方案需要加入 `#{@omniterm_agent}` 字段，如果混用 `\t` 和 `|` 会导致字段错位风险（session name 可以合法包含 `|`）。

**决策**: 统一改用 `|` 分隔符，agent option 字段放在 `session_created` 之后、`session_name` 之前（name 永远是最后一个字段）。

**Rationale**: tmuxes 验证过的方案。`|` 在 tmux format string 中未经转义直接输出，只有 name 可能包含它，放最后用 join 恢复即可。

### Decision 7: `hook_enabled` 语义重新定义

| 值 | 旧语义 | 新语义 |
|----|--------|--------|
| `false` | 不监控 | hook 未注入 |
| `true` | 监控中（capture-pane 扫描） | hook 已注入，读 session option |

## Resource Safety

本节分析新设计引入的运行时资源风险和缓解方案，确保无内存泄漏、无 task 泄漏、无子进程僵尸。

### S1. Agent 轮询 task 生命周期

**风险**: `handle_terminal` 中 `tokio::spawn` 的 agent 轮询 task 在 WS 断开后继续运行，每 1s spawn 一次 `tmux show-options` 子进程，永久泄漏。

当前代码的 `tokio::select!` 模式（`ws/terminal.rs` 第 262 行）在任意分支完成后直接返回，放弃其余 `tokio::spawn` 的 JoinHandle。被放弃的 task 不会自动取消——它们依赖 channel close 来间接退出。新加入的轮询 task 没有这种被动退出路径，必须显式管理。

**缓解**:
- 使用 `tokio::sync::oneshot` 作为显式取消信号
- agent 轮询 task 内用 `tokio::select!` 同时监听 interval tick 和 shutdown signal
- `handle_terminal` 返回前 send 关闭信号 + await agent handle join

```rust
let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

let agent_handle = tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                // poll @omniterm_agent, push if nonce changed
            }
            _ = &mut shutdown_rx => break,
        }
    }
    debug!("agent poll task exited cleanly");
});

// ... 主 select! 处理 PTY/WS 数据 ...

// 显式取消 + 等待清理
let _ = shutdown_tx.send(());
let _ = agent_handle.await;
```

**验证方式**: 单元测试中 drop WS 连接后，等待 2s 确认无额外 `tmux show-options` 子进程。

### S2. tmux 子进程超时与 hang

**风险**: `get_session_agent_option()` 调用 `tmux show-options`。如果 tmux server 无响应（挂死、网络文件系统卡住），子进程永久阻塞，tokio task 永远无法完成。

**缓解**:
- 每次 `Command` 调用包裹 `tokio::time::timeout(Duration::from_secs(2), cmd.output())`
- timeout 后 tokio 在 drop `Child` 时自动 SIGKILL 子进程（tokio 1.x 行为）
- 连续 3 次 timeout → 停止该 session 的轮询（tmux server 可能已挂），发送 `{ "type": "agent_state", "state": "unknown" }` 通知前端

### S3. 子进程 PID 竞态（现有代码，不在本次范围）

**风险**: `handle_terminal` 第 279 行 `unsafe { libc::kill(pid, SIGHUP) }`。child 进程在 `select!` 和 `kill` 之间退出时，PID 可能被内核复用，SIGHUP 误发给无关进程。

**缓解**: 不在本次改动范围。当前代码已有注释说明这是权衡（避免 PTY drop 写入多余 `\n+EOF`）。长期应迁移到 `portable_pty` 的信号 API 或接受 PTY master drop 的行为。

### S4. Hook 命令 Shell 转义

**风险**: `augment_agent_command` 将 hook 配置注入到 shell 命令字符串中。如果 agent 状态值或事件名包含特殊字符（单引号 `'`、反斜杠 `\`），可能破坏 shell 解析。

具体威胁面：
- Claude Code: JSON 值包含单引号 → `--settings '{"hooks":...}'` 断裂
- Codex: TOML 值包含双引号 → `-c 'hooks....=...\"...'` 断裂

**缓解**:
- 当前状态值集合是闭集（`running`/`waiting`/`idle`/`decision`/`done`/`error`），不含特殊字符，天然安全
- `agentEvent`（hook 事件名）来自 Claude Code / Codex 的未来版本，可能引入新事件名
- 防御措施: 在 `agent_value()` 格式化函数中做白名单校验，非法字符替换为 `_`（对标 tmuxes 的 `cleanToken` 函数：`v.replace(/[^A-Za-z0-9_.-]/g, '_')`）
- 单元测试覆盖: 状态值含 `'`、`"`、`\`、换行符的输入应被清理为安全形式

### S5. `list_sessions` 格式串分隔符一致性

**风险**: 现有代码用 `\t` 分隔字段，新增 `@omniterm_agent` 字段如果混用 `|` 和 `\t`，当 session name 包含 `|` 时字段错位。

**缓解**: 统一改用 `|` 作为所有字段的分隔符（Decision 6），session name 固定在最后一个字段，用 `parts[N..].join("|")` 恢复。单元测试覆盖 name 含 `|` 的场景。

### S6. 前端 AttentionProvider 内存

**风险**: React Context 中 alerts map 无限增长。

**缓解**: alerts 按 `<targetId>\x00<sessionName>` 为 key，session 被 kill 时对应 key 清除。最大条目数 = 可见 session 数 × projects 数（通常 < 50）。不存在泄漏路径。

## Risks / Trade-offs

- **[WebSocket 内嵌轮询的开销]**: 每个活跃 WS 连接每 1s 执行一次 `tmux show-options -t <session> @omniterm_agent`。这比轮询 session 列表略重（多一个子进程），但远轻于 `capture-pane`（不抓取终端文本）。→ Mitigation: 仅在 `hook_enabled=true` 的 session 上启用 WS 内嵌轮询；且已有 S2 的 timeout 保护。
- **[竞态: agent 在 option 初始化前就触发 hook]**: → Mitigation: 创建 session 后立即 `tmux set-option` 初始化，再启动 agent 命令。
- **[一个 session 多个 agent]**: `@omniterm_agent` 只能存一个值，后触发者覆盖前者。→ Mitigation: 文档声明"每个 session 一个 agent"，UI 层面只在创建终端 session 时注入 hook。
- **[Codex `-c` 参数中的引号转义]**: 嵌套引号易出错。→ Mitigation: 单元测试覆盖所有特殊字符场景，遵循 tmuxes 的 TOML-like 转义规则；S4 的白名单防御。
- **[浏览器 AudioContext 自动播放限制]**: 多数浏览器要求用户先有交互才允许播放声音。→ Mitigation: OmniTerm 本身就是交互应用，用户点击即可解锁 AudioContext；首次 fire 时尝试 `resume()`。

## Migration Plan

1. **后端**: 实现新 hook 注入 + session option 读取，保留旧扫描器作为 fallback
2. **前端**: 增量添加 AttentionProvider + badge/通知，不影响现有组件
3. **部署**: debug 分支先验证（port 19777/19778）
4. **回滚**: 新版二进制不引入 schema 变更，直接替换旧二进制即可回滚
5. **清理（后续）**: 启发式扫描器在稳定运行 1-2 周后移除

## Open Questions

1. **是否需要单独的全局状态轮询器？** 目前设计为每个 TargetGroup/Project 独立轮询 session 列表。如果 projects 很多，考虑提升到 App 级单一轮询。本次暂不处理——OmniTerm 的 project 概念不同于 tmuxes 的 target，实际 projects 数通常 ≤3。

2. **移动端推送？** OmniTerm 有 mobile 布局支持。当标签页不在前台且 agent 需要决策时，是否通过 Service Worker 发系统通知？本次不作要求，但 AttentionProvider 架构预留扩展点。
