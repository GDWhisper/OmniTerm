## ADDED Requirements

### Requirement: 后端检测 session 中的 agent 进程

系统 SHALL 在 session 列表轮询时扫描每个 tmux session 的进程树，检测是否存在已知 agent CLI（Claude Code / Codex）进程。

#### Scenario: 检测到 Claude Code 进程
- **WHEN** 某个 tmux session 中有 `claude` 或 `claude-code` 进程在运行
- **THEN** session 列表 API 响应的该 session 对象包含 `agent_detected: "claude"`

#### Scenario: 检测到 Codex 进程
- **WHEN** 某个 tmux session 中有 `codex` 进程在运行
- **THEN** session 列表 API 响应的该 session 对象包含 `agent_detected: "codex"`

#### Scenario: 未检测到任何 agent 进程
- **WHEN** session 中没有已知 agent CLI 进程在运行
- **THEN** session 列表 API 响应的该 session 对象中 `agent_detected` 为 `null`

#### Scenario: 已有 hook 注入的 session 不重复检测
- **WHEN** session 的 `hook_enabled` 为 `true` 且 `@omniterm_agent` option 已有有效值
- **THEN** 系统跳过进程树扫描，直接使用 option 中的 agent 信息

#### Scenario: 进程树扫描失败不阻塞响应
- **WHEN** 进程树扫描因任何原因失败（超时、权限不足等）
- **THEN** `agent_detected` 为 `null`，不影响其他 session 数据的正常返回

### Requirement: agent_detected 字段定义

Session API 响应对象 SHALL 新增 `agent_detected` 可选字段，类型为 `string | null`，值为 `"claude"` 或 `"codex"` 或 `null`。

#### Scenario: Session 对象包含 agent_detected
- **WHEN** 调用 `GET /projects/{pid}/sessions`
- **THEN** 每个 session 对象包含 `agent_detected` 字段，值为 `"claude"`、`"codex"` 或 `null`
