## ADDED Requirements

### Requirement: 实时检测 session 输出活跃度

系统 SHALL 通过 tmux control mode 监听每个 session 的 pane 输出事件，当 pane 在指定时间窗口内有输出时，将 session 标记为活跃状态。

#### Scenario: pane 有输出时 session 变为活跃
- **当** 某个 tmux session 的 pane 产生了新的输出
- **则** 该 session 在后续 API 响应中返回 `is_active: true`

#### Scenario: pane 一段时间无输出后 session 变为不活跃
- **当** 某个 tmux session 的 pane 超过配置的阈值时间（默认 2 秒）没有任何输出
- **则** 该 session 在后续 API 响应中返回 `is_active: false`

#### Scenario: 控制模式连接断开后不阻塞响应
- **当** tmux control mode 连接意外断开
- **则** 该 session 的 `is_active` 字段返回 false，且不影响其他 session 数据的正常返回

### Requirement: Session API 暴露 is_active 字段

Session API 响应对象 SHALL 新增 `is_active` 字段，类型为 `boolean`，表示该 session 的 pane 是否最近有输出。

#### Scenario: Session 对象包含 is_active
- **当** 调用 `GET /projects/{pid}/sessions`
- **则** 每个 session 对象包含 `is_active` 字段，值为 `true` 或 `false`

### Requirement: Sidebar 用视觉指示器展示活跃状态

前端 SHALL 在 Sidebar 的 session 行使用小圆点视觉指示器展示 `is_active` 状态。当 session 活跃时显示呼吸动画的 accent 色圆点。

#### Scenario: 活跃 session 显示呼吸灯
- **当** session 的 `is_active` 为 `true`
- **则** session 行前面的小圆点显示为呼吸动画的 accent 色

#### Scenario: 不活跃 session 保持默认状态
- **当** session 的 `is_active` 为 `false` 且没有其他 attention 状态
- **则** session 行前面的小圆点显示为灰色

#### Scenario: 不区分输出来源
- **当** session 中有任何输出（agent、shell 命令、用户输入回显等）
- **则** 统一触发活跃指示器，不做来源区分
