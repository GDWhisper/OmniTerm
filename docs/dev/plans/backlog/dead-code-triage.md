# Dead Code 待核清单

> 来源：质量门禁建设（`docs/dev/plans/2026-07-24-quality-gates.md` Phase 2）
> 生成：2026-07-24，`cargo clippy --all-targets` 检出的 15 处 rustc `dead_code` 警告
> 当前处置：已逐项 `#[allow(dead_code)]`（代码内注释均指向本文件），保留 lint 对**新增**死代码的有效性
> 目标：逐条判断"删除 / 永久保留并改注释 / 启用接线"，清理后移除对应 allow

## 判定维度

- **删除**：确认无任何调用方（含测试、未来空调用），属于历史重构残留
- **保留**：有意保留的协议变体/预留 API，应将 allow 注释改为说明用途
- **接线**：本应被使用但漏接，补回调用后 allow 自然移除

## 清单

| # | 位置 | 符号 | 初判 | 备注 |
|---|------|------|------|------|
| 1 | `src/auth/mod.rs:24` | `verify_token` | 仅被 `RequireAuth::from_request_parts` 调用 | #2 若保留则连带保留；若 #2 删则本函数随之删 |
| 2 | `src/auth/mod.rs:34` | `RequireAuth`（axum 提取器） | 未在任何 handler 用作鉴权参数 | 判断是预留鉴权中间件 vs 已弃用脚手架 |
| 3 | `src/fs/mod.rs:139` | `normalize_path` | 仅 `\\`→`/` 辅助 | 无调用方，疑似残留，候选删除 |
| 4 | `src/models/user.rs:4` | `User`（sqlx 模型） | 无 `FROM_ROW` 查询引用 | 是否有计划中的用户表查询路径 |
| 5 | ~~`src/tmux/mod.rs` `capture_pane`~~ | **已处置**（2026-07-26） | 改造为 `capture_screen`（可见屏捕获），由 `agent_watch` 接线 | ✅ |
| 6 | ~~`src/tmux/mod.rs` `detect_agent_in_session`~~ | **已删除**（2026-07-26） | 被 `agent_watch::identify_agent`（前台进程组优先）取代 | ✅ |
| 7 | `src/tmux/agent_state.rs:120` | `AGENT_OPTION` 常量 | 未在 tmux option 读取处使用 | 检查是否漏接 `@omniterm_agent` 读取 |
| 8 | `src/tmux/agent_state.rs:162` | `agent_value` | 与 `parse_agent_value` 不同 | 确认是否旧 API |
| 9 | `src/tmux/agent_state.rs:177` | `clean_token` | **仅测试使用**（agent_hooks tests） | 保留；考虑将 fn 移入测试模块或标记 `#[cfg(test)]` |
| 10 | `src/tmux/control_mode.rs:72` | `ControlModeClient::pid` | **仅测试使用** | 同上，考虑 `#[cfg(test)]` 化 |
| 11 | ~~`src/tmux/process_info.rs` `read_process_cmdline`~~ | **已接线**（2026-07-26） | `agent_watch` 前台进程识别调用 | ✅ |
| 12 | ~~`src/tmux/process_info.rs` `walk_process_tree`~~ | **已接线**（2026-07-26） | `agent_watch` 回退路径调用 | ✅ |
| 13 | ~~`src/tmux/process_info.rs` `read_cmdline_impl`~~ | **已接线**（2026-07-26） | 随 #11 | ✅ |
| 14 | ~~`src/tmux/process_info.rs` `walk_children`~~ | **已接线**（2026-07-26） | 随 #12 | ✅ |
| 15 | `src/ws/terminal.rs:32` | `ServerControl` 枚举变体 `Pong`/`Exit`/`AgentState` | 协议变体未构造 | 评估是否前端期望但后端未发送（潜在 bug）→ 接线 |

## 升级路径

全部清零后：将允许项失效性恢复为默认 `warn`（移除 allow），并恢复 CI/pre-commit 对这些符号的覆盖，作为新增死代码的兜底。