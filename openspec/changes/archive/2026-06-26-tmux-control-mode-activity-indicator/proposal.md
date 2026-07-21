## Why

当前 Sidebar 的 session 行只有一个小圆点，无法直观反映 session 是否正在产生输出。用户无法一眼看出哪个终端正在运行命令、哪个已经空闲，尤其在多 session 场景下体验较差。

通过 tmux control mode 实时监听 pane 输出事件，可以让 session 小灯在 pane 有输出时立即给出视觉反馈，提升终端状态的可感知性。

## What Changes

- **新增** Backend `SessionActivityMonitor`：为每个 tmux session 维护一个 `tmux -C attach-session` 长连接，监听 `%output` 事件
- **新增** session 输出活跃度状态：当 pane 在 N 秒内有输出时，标记 session 为 `is_active=true`
- **新增** API 字段：`Session` 响应增加 `is_active: bool`（runtime，不持久化）
- **修改** Sidebar session 行小灯：当 `is_active=true` 时显示呼吸动画的 accent 色圆点；不区分 agent 和人类输出
- **保持** 现有颜色语义：绿色仍表示 done，黄色表示 decision，红色表示 error

## Capabilities

### New Capabilities

- `session-activity-indicator`: 基于 tmux control mode 的 session 实时输出活跃度检测与可视化

### Modified Capabilities

- 无

## Impact

- **Backend**: 新增 `src/tmux/control_mode.rs` 或 `src/tmux/activity.rs`，新增控制模式连接管理；`src/api/sessions.rs` 的 `list_sessions` 响应增加 `is_active` 字段
- **Frontend**: `frontend/src/api/client.ts` 的 `Session` 接口增加 `is_active?: boolean`；`frontend/src/components/Sidebar/Sidebar.tsx` 的 session 行小灯渲染逻辑调整
- **Dependencies**: 依赖 tmux control mode 支持（tmux 2.1+ 均支持）
