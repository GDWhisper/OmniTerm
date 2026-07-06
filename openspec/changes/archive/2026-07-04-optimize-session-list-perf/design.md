## Context

OmniTerm 后端通过 `tmux` CLI 与 tmux server 交互。目前 session 列表相关 API 采用"逐 session 查询"模式，每次查询 spawn 一个 tmux 子进程。由于 tmux 本身支持通过 `-F` format string 在一次 `list-sessions` 调用中返回任意 session option（包括 `@omniterm_agent`）和 pane 属性（包括 `#{pane_current_path}`），可以利用此能力消除重复进程 spawn。

现有 `tmux::list_sessions()` 已在 format string 中包含 `#{@omniterm_agent}`，但 `list_sessions` handler 未使用它，而是对每个 session 单独调用 `get_session_agent_option()`。同样，`pane_cwd` 未被收入 format string，导致 `list_external_sessions` 需要额外调用。

## Goals / Non-Goals

**Goals:**
- 将 `list_sessions` 的 per-session `show-options` 替换为基于 `tmux::list_sessions()` 的批量 join
- 将 `list_external_sessions` 的 per-session `pane_cwd` 替换为 format string 批量获取
- 保持 API 响应格式完全不变
- 正确处理以下边缘情况：
  - tmux session 存在但 `@omniterm_agent` option 未设置
  - tmux session 存在但 `pane_current_path` 为空（极少见）
  - DB 中有 session 记录但对应 tmux session 已不存在

**Non-Goals:**
- 不改变轮询间隔
- 不改变前端代码
- 不改变 `is_active`（control mode）的查询方式
- 不涉及 PTY / WebSocket 层面的优化

## Decisions

### Decision 1: 在 `list_sessions` handler 中使用 `tmux::list_sessions()` 做批量 join

**方案**：`list_sessions` handler 先调用 `tmux::list_sessions()` 获取所有 tmux session 的 agent 快照，构建 `HashMap<String, AgentSnapshot>`，然后遍历 DB sessions 时从 map 中查找，不再调用 `get_session_agent_option()`。

**Rationale**：
- 将 N 次 `tmux show-options` 进程 spawn 减少为 1 次 `tmux list-sessions`
- `list_sessions` format string 已经包含 `#{@omniterm_agent}`，无需改变 tmux 调用
- `AgentSnapshot` 的解析逻辑（`parse_agent_value`）已在 `list_sessions` 中复用

**Alternatives considered**：
- 在 sqlx query 后用单个 batch command 获取所有 session 的 agent option：tmux 不支持 `show-options` 对多个 session 批量操作
- 缓存 agent state：状态变化需要实时感知，缓存引入一致性问题

### Decision 2: 在 `list-sessions` format string 中追加 `#{pane_current_path}`

**方案**：将现有 format 从：
```
#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{session_name}
```
改为：
```
#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{pane_current_path}|#{session_name}
```

**Rationale**：
- 一个字段的增量成本几乎为零
- `list_external_sessions` 不再需要 per-session `pane_cwd` 调用
- `pane_current_path` 对 DB sessions 的 `list_sessions` 无额外用途，但保持 format 统一更简单

### Decision 3: 保持 `is_active` 查询不变

**方案**：`is_active` 仍然通过 `activity_monitor.is_active()` 逐 session 查询。

**Rationale**：
- `is_active` 查询是内存操作（读 Mutex），不涉及进程 spawn
- ControlModeClient 的 reader 是异步事件驱动，CPU 开销极低
- 改动 `is_active` 需要修改 control mode 架构，不在本次范围

### Decision 4: 保持轮询间隔不变

**方案**：3 秒 session 轮询和 10 秒 external session 轮询保持不变。

**Rationale**：
- 减少进程 spawn 数量后，轮询的 CPU 开销已经大幅降低
- 调大间隔会影响 agent 状态变化的响应延迟
- 间隔优化可以作为后续独立 change

## Risks / Trade-offs

- **[数据一致性]**：`tmux::list_sessions()` 返回的是调用时刻的快照。如果 tmux session 在快照之后才创建/删除，DB 中存在但快照中不存在的 session 会丢失 agent state。
  - Mitigation：tmux session 由 OmniTerm 管理（创建和删除都通过 API），且 session 在 DB 中创建之前就已经有 tmux session，因此时间窗口极小。最坏情况是丢失一次轮询的 agent state，下次轮询会补上。
- **[format string 解析兼容性]**：session name 中可能包含 `|` 字符，当前解析已经处理（`parts[4..].join("|")`），新增一个字段后索引需要调整。
  - Mitigation：正确更新索引为 `parts[5..]`。

## Open Questions

1. 是否需要在 `list_sessions` 中也使用 `pane_current_path` 来验证 session 的 workspace_path 是否仍然有效？→ 暂不纳入，可作为后续改进。
