## 1. 后端：进程树扫描

- [ ] 1.1 在 `src/tmux/mod.rs` 新增 `detect_agent_in_session(session_name: &str) -> Option<AgentKind>` — 通过 `tmux list-panes -t <name> -F '#{pane_pid}'` 获取 PID 列表，读取 `/proc/<pid>/cmdline` 或 `ps -p <pid> -o comm=`，用 `agent_hooks::detect_agent_kind` 匹配（复用已有检测逻辑）
- [ ] 1.2 在 `src/models/session.rs` 的 `Session` 结构体新增 `agent_detected: Option<String>` 字段（`#[sqlx(default)]`，`#[serde(skip_serializing_if = "Option::is_none")]`）
- [ ] 1.3 在 `src/api/sessions.rs` 的 `list_sessions` handler 中，对每个 `hook_enabled=false` 的 session 调用 `detect_agent_in_session`，将结果填入 `session.agent_detected`
- [ ] 1.4 更新 `CreateSession` handler 中 Session 构造，添加 `agent_detected: None`
- [ ] 1.5 编写单元测试：`detect_agent_in_session` 对无 agent session 返回 None；对运行 `sleep` 的 session 不误报

## 2. 前端：Session 接口更新

- [ ] 2.1 在 `frontend/src/api/client.ts` 的 `Session` 接口新增 `agent_detected?: string`
- [ ] 2.2 在 Sidebar 的智能 diff 轮询逻辑中保留 `agent_detected` 字段（已在 `setSessions` 时自动带上）

## 3. 前端：一键启用按钮 + Tooltip

- [ ] 3.1 在 Sidebar session 行渲染中，当 `s.agent_detected && !s.hook_enabled` 时显示「🔍」按钮（在 badge 图标旁），按钮样式使用 accent 色突出
- [ ] 3.2 按钮 hover 500ms 后显示 Tooltip：「开启后可获得实时状态通知、决策提醒音、侧边栏标记」
- [ ] 3.3 点击按钮调用 `api.hookEnable(s.id)`，成功后显示 Toast「Agent 监控已启用」，失败显示错误 Toast
- [ ] 3.4 启用成功后刷新 session 列表（`loadSessions()`），使按钮消失进入正常监控状态

## 4. 前端：首次使用引导横幅

- [ ] 4.1 在 Sidebar 顶部新增内联引导横幅组件 `AgentOnboardingBanner`，显示条件：`localStorage` 无 `omniterm_onboarding_agent_done` 标记，且当前有 session 的 `agent_detected` 不为 null
- [ ] 4.2 横幅内容：「🔍 检测到 AI Agent — 开启 Agent 监控，实时掌握运行状态、接收决策提醒」，右侧有「✕」关闭按钮
- [ ] 4.3 点击关闭按钮设置 `localStorage.setItem('omniterm_onboarding_agent_done', 'true')`，横幅消失
- [ ] 4.4 横幅样式：浅紫色半透明背景、内联在 session 列表上方、不阻塞滚动

## 5. 前端：创建弹窗简化

- [ ] 5.1 移除 Sidebar 创建 session 弹窗中的 `command` 输入框相关代码（`sessCommand` state、输入框 JSX、handleKeyDown 引用）
- [ ] 5.2 `handleCreateSession` 中不再传递 `command` 参数给 `api.createSession`

## 6. 测试与验证

- [ ] 6.1 后端单元测试：`detect_agent_in_session` 的进程扫描逻辑
- [ ] 6.2 手动验证：启动 debug 服务，创建 session 后在其中运行 `claude`，验证 3s 内 Sidebar 显示「🔍」按钮
- [ ] 6.3 手动验证：点击启用按钮后，hook 注入成功，agent 状态 badge 正常显示
- [ ] 6.4 手动验证：首次使用引导横幅出现和关闭逻辑
- [ ] 6.5 手动验证：创建弹窗无 command 输入框
