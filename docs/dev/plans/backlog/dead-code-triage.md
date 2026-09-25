# Dead Code 待核清单

> 来源：质量门禁建设（`docs/dev/plans/archive/2026-07-24-quality-gates.md` Phase 2）
> 生成：2026-07-24，`cargo clippy --all-targets` 检出的 15 处 rustc `dead_code` 警告
> 当前处置：**15 项已全部判定（2026-09-26）**，详见下表；处置后全仓仅剩 5 处 allow，均为有意保留（协议预留 2、写侧契约 2、bench 研究二进制 1）
> 目标：逐条判断"删除 / 永久保留并改注释 / 启用接线"，清理后移除对应 allow ✅

## 判定维度

- **删除**：确认无任何调用方（含测试、未来空调用），属于历史重构残留
- **保留**：有意保留的协议变体/预留 API，应将 allow 注释改为说明用途
- **接线**：本应被使用但漏接，补回调用后 allow 自然移除

## 清单

| # | 位置 | 符号 | 处置 | 备注 |
|---|------|------|------|------|
| 1 | ~~`src/auth/mod.rs:30`~~ | `verify_token` | **已接线**（2026-07-27） | 由 `require_auth_mw` 中间件 + `/auth/check` 接线，见 `docs/dev/plans/archive/2026-07-27-auth-enforcement.md` | ✅ |
| 2 | ~~`src/auth/mod.rs:72`~~ | `RequireAuth`（axum 提取器） | **已消失**（2026-09-26 核对） | auth-enforcement 实施过程中随代码演进被移除，`rg RequireAuth src/` 无结果 | ✅ |
| 3 | ~~`src/fs/mod.rs:139`~~ | `normalize_path` | **已消失**（2026-09-26 核对） | fs 模块后续演进中已移除，`rg normalize_path src/` 无结果 | ✅ |
| 4 | ~~`src/models/user.rs:4`~~ | `User`（sqlx 模型） | **已删除**（2026-09-26） | 全部 auth 查询用内联元组 `query_as`，无 `FromRow` 消费方；users 表本身不受影响 | ✅ |
| 5 | ~~`src/tmux/mod.rs` `capture_pane`~~ | **已处置**（2026-07-26） | 改造为 `capture_screen`（可见屏捕获），由 `agent_watch` 接线 | ✅ |
| 6 | ~~`src/tmux/mod.rs` `detect_agent_in_session`~~ | **已删除**（2026-07-26） | 被 `agent_watch::identify_agent`（前台进程组优先）取代 | ✅ |
| 7 | ~~`src/agent/state.rs:120`~~ | `AGENT_OPTION` 常量 | **已接线**（2026-09-26） | `engine/tmux/mod.rs` 的 set-option / show-options 两处字面量改用常量；tmux format 串内 `#{@omniterm_agent}` 令牌受语法限制保持字面量（已在常量 doc 注明） | ✅ |
| 8 | `src/agent/state.rs:164` | `agent_value` | **保留**（2026-09-26） | 五段格式的 Rust 权威编码器：生产写侧在 tmux hook shell 模板（`agent_hooks.rs` 硬编码 `claude:{}` 等），round-trip 测试以它定义格式契约；hook 模板改动应以此为准 | 📌 |
| 9 | `src/agent/state.rs:180` | `clean_token` | **保留**（2026-09-26） | `agent_value` 依赖它 + agent_hooks 测试以它校验 shell 写侧的等价清洗行为；`cfg(test)` 化会反过来破坏非测试构建里的 `agent_value` | 📌 |
| 10 | ~~`src/engine/tmux/control_mode.rs:173`~~ | `ControlModeClient::pid` | **cfg(test) 化**（2026-09-26） | 仅同文件单测使用 | ✅ |
| 11 | ~~`src/tmux/process_info.rs` `read_process_cmdline`~~ | **已接线**（2026-07-26） | `agent_watch` 前台进程识别调用 | ✅ |
| 12 | ~~`src/tmux/process_info.rs` `walk_process_tree`~~ | **已接线**（2026-07-26） | `agent_watch` 回退路径调用 | ✅ |
| 13 | ~~`src/tmux/process_info.rs` `read_cmdline_impl`~~ | **已接线**（2026-07-26） | 随 #11 | ✅ |
| 14 | ~~`src/tmux/process_info.rs` `walk_children`~~ | **已接线**（2026-07-26） | 随 #12 | ✅ |
| 15 | `src/ws/terminal.rs:45` | `ServerControl` 枚举变体 `Pong`/`Exit` | **拆分判定**（2026-09-26） | 枚举级 allow 收窄为变体级：`Attached`/`Error`/`AgentState` 均有构造点无需 allow；`Pong` 预留（心跳计划 `2026-09-19-ws-idle-disconnect-heartbeat.md` Phase 1 接线）；`Exit` 为**已知缺口**——前端 useTerminal 已处理 `exit` 帧（渲染退出码），后端从未构造，子进程退出目前仅以 WS 关闭 + 重连呈现，接线与否待决策 | 📌 |

## 清单外核对补录（2026-09-26 全仓 `rg allow(dead_code)` 时发现）

| 位置 | 符号 | 处置 | 备注 |
|------|------|------|------|
| ~~`src/api/files.rs:1557`~~ | `_assert_path`（测试助手） | **已删除** | 无调用方的测试编译断言残留 | ✅ |
| ~~`src/engine/tmux/control_mode.rs:577`~~ | `assert_send_sync` 块 | **改写** | `const _: ()` 内改为直接调用 `const fn`，类型不再满足 Send/Sync 即编译错，allow 移除且断言语义不变 | ✅ |
| ~~`src/engine/pty/metrics.rs`~~ | 整个模块（`record/last/total_cell_frame_bytes`） | **已删除** | 读口自创建起无消费方（监控 hook 从未建设），write-only 指标无意义；`vt.rs` 3 处 `record` 调用一并移除。如需帧尺寸观测从 git 历史找回 | ✅ |
| ~~`src/engine/pty/session.rs:8`~~ | `PtyError` 枚举级 allow | **已移除** | 三个变体（Open/Spawn/Io）均有构造点，allow 为历史过时残留 | ✅ |
| ~~`src/engine/tmux/client_registry.rs:165`~~ | `ClientRegistry::path` | **cfg(test) 化** | 仅同文件单测使用 | ✅ |
| `src/engine/pty/bench.rs:106` | bench 内部符号 | **保留** | 独立研究二进制 `bench-frames`，不进生产路径（AGENTS「反常点」），不在本清单管理范围 | 📌 |

## 升级路径

处置后剩余 5 处 allow 均为有意保留，R01（clippy 逐级升 deny）的前置从「清零」改为「对这 5 处做出最终决策」：

- `Pong`：心跳计划 Phase 0 四格探针出结论 → H1 成立即接线移除；H1 不成立可删。
- `Exit`：决策「接线退出码帧」或「删变体 + 删前端 exit 分支」，二选一后消除。
- `agent_value` / `clean_token`：若未来 hook 写侧从 shell 模板收编进 Rust（届时 `agent_value` 自然接线），或彻底废弃五段格式的 Rust 侧契约定义，二选一后消除。