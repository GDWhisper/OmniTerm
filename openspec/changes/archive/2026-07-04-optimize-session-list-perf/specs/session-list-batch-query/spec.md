## MODIFIED Requirements

### Requirement: Session 列表 agent state 通过批量查询获取

系统 SHALL 在 `GET /projects/{pid}/sessions` handler 中通过**一次** `tmux list-sessions -F` 调用批量获取所有 tmux session 的 agent 状态，而非对每个 session 分别调用 `tmux show-options`。

#### Scenario: 批量获取 agent 状态
- **当** 调用 `GET /projects/{pid}/sessions` 且项目中有 N 个 session
- **则** 后端只 spawn **一次** tmux 进程（`tmux list-sessions`），不随 session 数量线性增长

#### Scenario: DB session 在 tmux 中不存在时的降级处理
- **当** DB 中有 session 记录但对应 tmux session 已不存在（批量查询结果中缺失）
- **则** 该 session 的 agent 相关字段（`agent_kind`, `agent_state` 等）返回 `null`

#### Scenario: tmux session 存在但 agent option 未设置
- **当** tmux session 存在但 `@omniterm_agent` option 为空或未设置
- **则** 该 session 的 agent 相关字段返回 `null`

#### Scenario: API 响应格式不变
- **当** 调用 `GET /projects/{pid}/sessions`
- **则** 响应中每个 session 对象的字段结构（`is_active`, `agent_kind`, `agent_state`, `attention_reason` 等）保持不变

### Requirement: 外部 session 列表 CWD 通过批量查询获取

系统 SHALL 在 `GET /sessions/external` handler 中通过 `tmux list-sessions` 的 format string 批量获取所有 tmux session 的 `pane_current_path`，而非对每个外部 session 分别调用 `tmux display-message`。

#### Scenario: 批量获取 CWD
- **当** 调用 `GET /sessions/external` 且有 M 个外部 tmux session
- **则** 后端只 spawn **一次** tmux 进程（`tmux list-sessions`），不随外部 session 数量线性增长

#### Scenario: pane_current_path 为空时的降级处理
- **当** 某个 tmux session 的 `pane_current_path` 返回空字符串
- **则** 该外部 session 的 `cwd` 字段返回 `null`

#### Scenario: 外部 session API 响应格式不变
- **当** 调用 `GET /sessions/external`
- **则** 每个外部 session 对象的 `cwd` 字段仍然存在，语义不变
