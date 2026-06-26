## 1. 后端：tmux control mode 连接管理

- [ ] 1.1 在 `src/tmux/` 新增 `control_mode.rs`，实现 `ControlModeClient` 结构体：通过 `tokio::process::Command` 启动 `tmux -C attach-session -t <session>`，持有 stdin/stdout
- [ ] 1.2 实现 `ControlModeClient::listen()` 方法：异步读取 stdout，按行解析，过滤出 `%output` 事件，每次收到时更新 `last_output_at`
- [ ] 1.3 实现 `ControlModeClient::is_active(timeout: Duration)` 方法：判断 `now - last_output_at < timeout`
- [ ] 1.4 实现 `Drop` 或显式 `stop()` 方法：关闭 stdin、kill 子进程，避免僵尸进程

## 2. 后端：session 活跃度监控器

- [ ] 2.1 在 `src/tmux/control_mode.rs` 新增 `SessionActivityMonitor` 结构体，维护 `session_name -> ControlModeClient` 的 Map
- [ ] 2.2 实现 `monitor.ensure_session(session_name)`：不存在则创建连接
- [ ] 2.3 实现 `monitor.remove_session(session_name)`：关闭并移除连接
- [ ] 2.4 实现 `monitor.is_active(session_name) -> bool`：查询对应 session 的活跃状态

## 3. 后端：API 集成

- [ ] 3.1 在 `src/models/session.rs` 的 `Session` 结构体新增 `is_active: bool` 字段（`#[sqlx(default)]`，`#[serde(skip_serializing_if = "is_false")]` 或始终序列化）
- [ ] 3.2 在 `src/api/sessions.rs` 的 `list_sessions` handler 中，从 `AppState` 获取 `SessionActivityMonitor`，为每个 session 填充 `is_active`
- [ ] 3.3 在 `src/api/sessions.rs` 的 `create_session` handler 中，为新 session 注册 control mode 连接，初始 `is_active: false`
- [ ] 3.4 在 `src/api/sessions.rs` 的 `delete_session` handler 中，关闭并移除对应 control mode 连接
- [ ] 3.5 在 `src/main.rs` 中将 `SessionActivityMonitor` 放入 `AppState`

## 4. 前端：Session 接口更新

- [ ] 4.1 在 `frontend/src/api/client.ts` 的 `Session` 接口新增 `is_active?: boolean`

## 5. 前端：Sidebar 活跃指示器

- [ ] 5.1 在 Sidebar session 行渲染中，根据 `s.is_active` 显示呼吸动画 accent 色小圆点
- [ ] 5.2 确保 `is_active` 为 true 时覆盖默认灰色状态，但不覆盖 attention badge 的决策/错误/完成状态
- [ ] 5.3 在智能 diff 轮询逻辑中保留 `is_active` 字段（应自动随 `setSessions` 保留）

## 6. 测试与验证

- [ ] 6.1 后端单元测试：模拟 `%output` 事件，验证 `is_active` 在事件触发后为 true，超时后为 false
- [ ] 6.2 后端单元测试：验证 `ControlModeClient` 能正确清理子进程
- [ ] 6.3 手动验证：启动 debug 服务，创建 session 后运行 `while true; do echo ping; sleep 0.5; done`，验证 Sidebar 小灯呼吸闪烁
- [ ] 6.4 手动验证：停止输出后 2 秒内小灯恢复灰色
- [ ] 6.5 手动验证：删除 session 后对应 control mode 进程被清理
