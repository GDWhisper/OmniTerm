## Why

当前 `list_sessions` 和 `list_external_sessions` API 在处理多个 session 时会反复 spawn tmux 子进程，造成不必要的 CPU 开销：

1. **`list_sessions`**：对项目中的**每个** session 都调用 `tmux show-options -t <name> @omniterm_agent`（每个 session 一次进程 spawn），而 `tmux::list_sessions()` 已经可以通过**一次** `tmux list-sessions -F` 获取所有 session 的 agent 状态，但未被复用。
2. **`list_external_sessions`**：对**每个**外部 session 都调用 `tmux display-message -t <name> -p "#{pane_current_path}"` 获取 CWD（每个 session 一次进程 spawn），同样可以通过在 format string 中追加 `#{pane_current_path}` 合并为一次调用。

以上 API 分别被前端每 3 秒和每 10 秒轮询。当项目有 10 个 session 时，每 3 秒 spawn 10 个 tmux 进程，等价于每秒约 3.3 个额外进程——分布在轮询间隔中形成持续的 CPU 尖刺。

## What Changes

- **修改** `list_sessions` handler：改为先调用 `tmux::list_sessions()` 批量获取所有 tmux session 的 agent 状态，再与 DB 查询结果按 `tmux_session_name` join，消除 per-session 的 `show-options` 调用
- **修改** `list_external_sessions` handler：在 `tmux::list_sessions()` 的 format string 中追加 `#{pane_current_path}`，一次调用同时获取 agent 状态和 CWD，消除 per-session 的 `pane_cwd` 调用
- **修改** `TmuxSessionInfo` 结构体：新增 `cwd: Option<String>` 字段
- **保持** 前端轮询间隔不变（3s / 10s），API 响应格式不变，前端无需任何改动

## Capabilities

### Modified Capabilities

- `session-activity-indicator`（indirect）：`list_sessions` 的 `is_active` 填充逻辑不受影响，仅改变 agent state 数据来源方式

### New Capabilities

- 无

## Impact

- **Backend**: 修改 `src/api/sessions.rs` 的 `list_sessions` 和 `list_external_sessions` handler；修改 `src/tmux/mod.rs` 的 `list_sessions` format string 和 `TmuxSessionInfo` 结构体
- **Frontend**: 无变化（响应格式不变）
- **Dependencies**: 无新增依赖
