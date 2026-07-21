## Context

当前 OmniTerm 的 Sidebar 已经具备 session 列表和基础的状态指示（attention badge 用于 agent hook 状态），但缺少对 session 是否正在产生输出的实时感知。tmux control mode 可以提供一个结构化事件流，让后端实时知道 pane 是否有输出。

## Goals / Non-Goals

**Goals:**
- 为每个 tmux session 建立 control mode 连接，监听 `%output` 事件
- 根据最近输出时间判断 session 是否活跃
- Session 列表 API 响应增加 `is_active` 字段
- Sidebar session 行小灯在活跃时显示呼吸动画 accent 色

**Non-Goals:**
- 不区分输出是人类还是 agent 产生
- 不实现 agent hook 状态通知（已有其他 change 覆盖）
- 不持久化活跃度状态
- 不在移动端做特殊处理

## Decisions

### Decision 1: 使用 tmux control mode 而不是 capture-pane 轮询

**方案**：为每个 session 启动一个 `tmux -C attach-session -t <session>` 子进程，解析 stdout 中的 `%output` 事件。

**Rationale**：
- 事件驱动，实时性好
- 比每 3 秒 capture-pane 轻量
- 不依赖外部轮询逻辑

**Alternatives considered**：
- `capture-pane` 内容对比：实现简单但 3 秒延迟，且每次抓取整个 pane
- `#{window_activity}` 时间戳：需要挂 control mode client 才更新，不如直接用事件

### Decision 2: 每个 session 独立 control mode 进程

**方案**：Backend 维护一个 `SessionActivityMonitor` 结构，为每个 session 管理一个 tokio process。session 创建时启动连接，session 删除或 tmux session 不存在时关闭。

**Rationale**：
- 隔离性好，一个 session 的连接问题不影响其他 session
- 与现有 session 生命周期对齐

**Alternatives considered**：
- 一个全局 control mode 连接监听所有 session：命令更复杂，事件过滤更麻烦

### Decision 3: 活跃度衰减窗口为 2 秒

**方案**：每次收到 `%output` 事件时更新 `last_output_at = now()`。`is_active = now - last_output_at < 2s`。

**Rationale**：
- 大多数命令行工具输出是连续的，2 秒足够覆盖停顿
- 太短容易闪烁，太长反应迟钝

### Decision 4: 前端使用呼吸动画 accent 色圆点

**方案**：当 `is_active=true` 时，session 行前面的小圆点使用 `var(--accent)` 颜色并添加 `animate-pulse` 类。

**Rationale**：
- 与现有绿色（done）、黄色（decision）、红色（error）语义不冲突
- accent 色是 OmniTerm 的品牌色，适合表示"系统正在工作"

## Risks / Trade-offs

- **[连接管理复杂度]**：每个 session 一个子进程，需要正确清理，避免僵尸进程。
  - Mitigation：在 `drop` 中 kill 子进程；session 删除时显式关闭连接。
- **[tmux 版本差异]**：不同 tmux 版本的 control mode 输出格式可能略有差异。
  - Mitigation：先支持 tmux 3.x；解析逻辑尽量宽松。
- **[输出事件噪音]**：光标闪烁、状态栏更新等可能产生输出事件。
  - Mitigation：只关注 `%output` 事件；2 秒衰减窗口也能过滤短暂噪音。
- **[资源占用]**：大量 session 同时活跃时会创建大量子进程。
  - Mitigation：仅对当前 project 的 sessions 建立连接；后续可优化为连接池或按需连接。

## Open Questions

1. 是否需要对 control mode 连接做超时/心跳检测？
2. 当 tmux server 重启时，是否应该自动重连？
3. 是否需要在 session 长时间不活跃后关闭连接以节省资源？
