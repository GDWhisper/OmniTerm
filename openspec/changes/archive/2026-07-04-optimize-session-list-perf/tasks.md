## 1. 后端：`TmuxSessionInfo` 结构体扩展

- [x] 1.1 在 `src/tmux/mod.rs` 的 `TmuxSessionInfo` 新增 `cwd: Option<String>` 字段
- [x] 1.2 修改 `list_sessions()` format string，在 `#{@omniterm_agent}` 和 `#{session_name}` 之间插入 `#{pane_current_path}`
- [x] 1.3 更新 `list_sessions()` 的解析逻辑：调整字段索引（`parts[0]`~`parts[4]` 不变，新增 `parts[4]` 为 cwd，session name 索引变为 `parts[5..]`）
- [x] 1.4 运行 `cargo test` 验证现有 `TmuxSessionInfo` 相关测试通过

## 2. 后端：`list_sessions` handler 批量化 agent state

- [x] 2.1 在 `src/api/sessions.rs` 的 `list_sessions` handler 开头调用 `tmux::list_sessions()`，构建 `HashMap<String, AgentSnapshot>`（key 为 tmux session name）
- [x] 2.2 遍历 DB sessions 时，从 HashMap 中查找 agent state（`map.get(tmux_name)`），替代原有的 `get_session_agent_option()` 调用
- [x] 2.3 保留 `is_active` 查询逻辑不变（仍通过 `activity_monitor.is_active()`）
- [x] 2.4 处理边缘情况：tmux session 在 HashMap 中不存在时，agent state 字段留 `None`
- [x] 2.5 编译验证：`cargo build`

## 3. 后端：`list_external_sessions` handler 批量化 CWD

- [x] 3.1 在 `src/api/sessions.rs` 的 `list_external_sessions` handler 中，利用 `tmux::list_sessions()` 已返回的 `cwd` 字段，替代 `tmux::pane_cwd(&s.name)` per-session 调用
- [x] 3.2 `ExternalSessionResponse` 的 `cwd` 字段直接从 `TmuxSessionInfo.cwd` 取值
- [x] 3.3 编译验证：`cargo build`

## 4. 测试与验证

- [x] 4.1 运行 `cargo test` 确保所有现有测试通过
- [x] 4.2 运行 `cargo clippy` 确保无新 warning
- [x] 4.3 手动验证：启动 dev 服务，创建 3+ 个 session，打开 Sidebar，确认 session 列表正常显示且 agent 状态正确
- [x] 4.4 手动验证：确认外部 session 列表正常显示且 CWD 正确
- [x] 4.5 性能对比：使用 `time` 或 `strace -c` 对比优化前后 `GET /projects/{pid}/sessions` 的 tmux 进程 spawn 数量
