## ADDED Requirements

### Requirement: 一键启用 Agent 监控按钮

对于已检测到 agent 进程但未启用 hook 的 session，前端 SHALL 在 session 行上显示醒目的「启用监控」按钮。

#### Scenario: 显示启用按钮
- **WHEN** session 的 `agent_detected` 为 `"claude"` 或 `"codex"`，且 `hook_enabled` 为 `false`
- **THEN** session 行右侧显示「🔍 启用监控」按钮

#### Scenario: 已启用 hook 的 session 不显示按钮
- **WHEN** session 的 `hook_enabled` 为 `true`
- **THEN** session 行不显示「启用监控」按钮（已有 badge 和状态指示器）

#### Scenario: 无 agent 的 session 不显示按钮
- **WHEN** session 的 `agent_detected` 为 `null`
- **THEN** session 行不显示「启用监控」按钮

### Requirement: 点击启用按钮的行为

用户点击「启用监控」按钮后，系统 SHALL 调用 `POST /sessions/{id}/hook-enable`，并给予用户反馈。

#### Scenario: 启用成功
- **WHEN** 用户点击「启用监控」按钮
- **AND** `hook-enable` API 返回成功
- **THEN** 按钮消失，session 进入正常监控状态（后续轮询将获取 agent 状态）
- **AND** 显示 Toast 提示「Agent 监控已启用」

#### Scenario: 启用失败
- **WHEN** 用户点击「启用监控」按钮
- **AND** `hook-enable` API 返回失败
- **THEN** 按钮保持显示
- **AND** 显示 Toast 错误提示

### Requirement: 功能说明 Tooltip

启用按钮旁 SHALL 提供 Tooltip，说明启用后的功能价值。

#### Scenario: 鼠标悬停显示说明
- **WHEN** 用户鼠标悬停在「启用监控」按钮上超过 500ms
- **THEN** 显示 Tooltip：「开启后可获得实时状态通知、决策提醒音、侧边栏标记」

### Requirement: 首次使用引导

当系统首次检测到 agent 进程时，SHALL 显示引导横幅，介绍 Agent 监控功能。

#### Scenario: 首次检测到 agent 时显示引导
- **WHEN** 用户首次打开 OmniTerm 且有 session 的 `agent_detected` 不为 `null`
- **AND** 用户之前未见过引导（localStorage 无标记）
- **THEN** Sidebar 顶部显示横幅：「🔍 检测到 AI Agent — 开启 Agent 监控，实时掌握运行状态、接收决策提醒」
- **AND** 横幅右侧有「了解更多」和「✕」按钮

#### Scenario: 用户关闭引导后不再显示
- **WHEN** 用户点击「✕」关闭引导横幅
- **THEN** localStorage 记录 `omniterm_onboarding_agent_done = true`
- **AND** 后续 session 不再显示引导横幅

### Requirement: 创建 Session 弹窗简化

创建 Session 弹窗 SHALL 移除 `command` 输入框，简化为仅需 Session Name。

#### Scenario: 创建弹窗无 command 字段
- **WHEN** 用户打开创建 Session 弹窗
- **THEN** 弹窗中仅显示「Session Name」输入框和创建/取消按钮
- **AND** 不显示「Command」输入框
