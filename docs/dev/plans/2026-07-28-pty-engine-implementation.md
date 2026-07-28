# 自管 pty 会话引擎 — 实施计划

> 状态：设计稿（2026-07-28）
> 触发条件：`2026-07-28-remove-tmux-session-engine.md`（方向规划）获批落地，本文件是其要求的独立实施计划。
> 关联：方向规划（同目录）、`src/tmux/`、`src/ws/terminal.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useTerminal.ts`、AGENTS.md §7/§8。

---

## 1. Phase 0 盘点结论（已完成）

### 1.1 关键事实
- **架构已半在 portable-pty 上**：`ws/terminal.rs` 现状即 `portable-pty → spawn tmux 客户端`。pty 读写管线、`master.resize(PtySize)`、`pty_io.rs`（`write_pty` VEOF workaround / `kill_session_process` SIGHUP）**原样可复用**；迁移核心是把 spawn 目标从 tmux 客户端换成 shell/agent 本体，并把进程生命周期从"随 WS"改为"后端常驻"。
- **tmux 能力用得很窄**：全项目每会话固定 1 window / 1 pane；从不使用 split-window / resize-pane / pipe-pane / scrollback。
- **零改动可迁**：`agent_detect.rs` + `manifests/`（纯文本规则引擎）、`agent_state.rs`（纯数据模型）、`process_info.rs`（进程树）。
- **可整体删除**：`control_mode.rs`（403 行只做"最近 2s 有无输出"，自管后退化为读循环时间戳）。

### 1.2 tmux 能力 → 等价实现映射（摘要）

| tmux 能力（使用点） | 自管等价 | 难度 |
|---|---|---|
| `new-session -d`（创建） | `openpty` + `spawn_command` | 直接有 |
| `new-session -A`（attach/重连） | SessionManager 常驻 + 输出广播 + VT 补屏 | 需自建 |
| detach 不杀进程 | 进程由后端 task 持有，WS 断开只解绑订阅 | 需自建 |
| `send-keys` | `write_pty(fd, bytes + "\r")` | 直接有 |
| resize | `master.resize()`（现状已是） | 直接有 |
| `kill-session` | `kill_session_process` + killpg | 直接有 |
| `list-sessions` / `has-session` | SessionManager 内存 map | 直接有 |
| `pane_current_path` | `/proc/<前台pid>/cwd` readlink（macOS libproc） | 需自建（Linux 易） |
| `capture-pane`（agent 检测输入） | wezterm-term 服务端 VT grid | 需自建（重） |
| `#{pane_title}`（osc_title 区域） | wezterm-term 截获 OSC 0/2 | 随模拟器免费 |
| `#{pane_pid}` | spawn 时记录 child pid | 直接有 |
| control mode `%output` → is_active | 读循环更新 `Instant` | 直接有（更简单） |
| `set-option @omniterm_agent` hook 信道 | 本地 HTTP 回调（D7） | 需自建（中） |
| 后端重启后会话幸存 | 无等价 → D5 自动重建 | 无等价 |
| external 会话发现/收养 | 无等价 → D6 删除 | 无等价 |
| `mouse on` / `escape-time` workaround | 不需要（问题消失） | — |

### 1.3 调用面（迁移触点清单）
- **后端**：`api/sessions.rs`（L50/83/99/220/245/330/331/391/512/537/564/593/615）、`ws/terminal.rs`（L66/131/352/438/503/520-767）、`api/files.rs`（L120-173 `resolve_session_base` 含 L167 丢失重建 fallback）、`api/hooks.rs`（L45）、`api/projects.rs`（`tmux_session_name` 冲突检查 + 409 错误码）、`api/system.rs`（`/system/multiplexer`）、`main.rs`（AppState 两个 tmux 设施）、`models/session.rs`（`tmux_session_name` / `runtime_kind='tmux'` / `AdoptSession` / `ExternalSessionResponse`）。
- **前端**：`useTerminal.ts`（copy-mode 字节注入 L321-347、modern 键位 L262-307、`tmuxScrollModeRef`）、`api/client.ts`（类型）、`appStore.ts`（`keybindingMode` / `tmuxCheatsheetOpen` / `activeExternalSession`）、`Sidebar.tsx`（external 区块 L1460-1610 + 轮询）、`TmuxCheatsheet/` 整目录、locales 文案、`manifest.webmanifest`。

---

## 2. 设计决策（本计划新增，续方向规划 D1-D4）

### D5：后端重启 = 会话丢失 + 自动重建
- **决策**：接受进程丢失。DB 已存 `workspace_path` + 启动命令；新增两项恢复能力：
  1. **cwd 回写**：pty 会话定期（30s + 会话操作时）从 `/proc/<前台pid>/cwd` 采样回写 DB 新列 `last_cwd`，重建时用最后 cwd。
  2. **scrollback 落盘**：读循环 tee 进环形缓冲（内存 256KB/会话）并异步落盘（`$DATA_DIR/scrollback/<session_id>.log`，截尾保留末 256KB）；重启重建后先回放落盘内容再接新 pty，用户可见断点前上下文。
- **P1 增强**：agent 会话重建命令附加 resume 参数（如 `claude --continue`）。
- **否决项**：守护进程分离（保活等价 tmux 但引入进程架构 + IPC，违反奥卡姆剃刀）。
- **翻盘条件**：若用户实测"重建 + 回放"不足以恢复工作流，再评估守护进程方案。

### D6：external 会话发现/收养整体删除
- **决策**：`/sessions/external`、`/sessions/adopt`、`/ws/terminal/external/{name}`、`AdoptSession`/`ExternalSessionResponse` DTO、Sidebar 外部会话区块与轮询，全链路删除。
- **理由**：本质是 tmux server 概念，自管 pty 无外部枚举对象。
- **翻盘条件**：若 P2 恢复 tmux 只读后端则一并恢复。

### D7：agent hook 信道 = 本地 HTTP 回调
- **决策**：`agent_hooks.rs` 生成的 hook 命令由 `tmux set-option -q @omniterm_agent <v>` 改为 `curl -s -X POST http://127.0.0.1:$PORT/api/v1/internal/agent-event -H 'X-OmniTerm-Token: <会话专属token>' -d '<kind>:<state>:<reason>:<event>:<ts>.$$'`。后端内存 KV（session_id → AgentSnapshot）+ tokio watch channel。
- **收益**：`ws/terminal.rs` 的 1s 轮询（L352）改为事件订阅推送；`api/hooks.rs` 读内存 KV。
- **安全**：端点仅回环可用 + 每会话随机 token（spawn 时经环境变量注入），防同机其它进程伪造状态。
- **否决项**：Unix socket（Windows/psmux 路径不兼容）；约定文件（竞态 + 清理负担）。
- **翻盘条件**：容器内 curl 不可用比例高 → 回退"约定文件 + watch"。

### D8：VT 模拟器 = wezterm-term
- **决策**：新增依赖 `wezterm-term`（与 portable-pty 同作者同仓库），每会话服务端维护 grid，提供：`capture_screen` 等价（agent 检测输入）、OSC 0/2 标题、attach/重连补屏（渲染当前屏为 ANSI 序列发给新客户端）。
- **否决项**：alacritty_terminal（API 面向 Alacritty 内部，集成摩擦大）；vt100（scrollback 与边缘序列覆盖弱）。
- **翻盘条件**：wezterm-term 依赖树过重或编译时间不可接受 → 降级 vt100 并接受 osc_title 区域弱化。

### D9：舍弃 SessionBackend 抽象（方向规划 D3 落定）
- **决策**：不保留 tmux 可切换后端。触发方向规划 D3 自带翻盘条件——external 链路已删（D6）、无近期回退需求，抽象层只增复杂度。
- **翻盘条件**：同方向规划 D1（portable-pty 平台缺陷不可修）。

### D10：命名与 DB 迁移
- **决策**：`runtime_kind` 值 `'tmux'` → `'pty'`（migration UPDATE）；`tmux_session_name` 列重命名为 `engine_session_name`（语义：引擎内会话标识，沿用 `lt_{uuid8}` 生成规则）；新增 `last_cwd` 列。存量 tmux 会话迁移后按"进程已丢"处理，走 D5 重建流程。
- **理由**：列名去 tmux 语义，避免长期误导；SQLite `ALTER TABLE RENAME COLUMN` 直接支持。

---

## 3. 实施分期（文件级）

> 每 Phase 结束提交并保持 `cargo build` / `tsc` 通过。Phase 1-2 为纯新增（不动 tmux 链路），Phase 3 为切换点（单次提交内完成后端切换），风险集中可控。

### Phase 1：`src/pty/` 会话引擎（纯新增）
- **新增** `Cargo.toml`：`wezterm-term` 依赖。
- **新增** `src/pty/mod.rs`：`SessionManager`（`HashMap<String, PtySession>`，create/get/kill/list/exists）。
- **新增** `src/pty/session.rs`：`PtySession` —— openpty(初始尺寸) + spawn（shell 或 agent 命令，注入 hook token 环境变量）+ 读循环（tee → ① 订阅者广播 mpsc ② 环形缓冲 + 落盘 ③ wezterm-term feed ④ `last_output_at: Instant`）+ `write` / `resize` / `kill`（killpg）+ `capture_screen()` / `pane_title()` / `render_screen_ansi()`（补屏）。
- **新增** `src/pty/scrollback.rs`：环形缓冲 + 异步落盘 + 截尾 + 重启回放读取。
- **新增** `src/pty/cwd.rs`：`/proc/<pid>/cwd`（Linux）/ libproc（macOS）前台进程 cwd 采样，30s 定时回写 `last_cwd`。
- **迁移** `src/tmux/pty_io.rs` → `src/pty/io.rs`（原样）。
- **产出**：单元测试覆盖 create/write/read/resize/kill/capture/回放。

### Phase 2：hook 信道 + agent 检测改源（纯新增/并行）
- **新增** `src/api/agent_events.rs`：`POST /api/v1/internal/agent-event`（回环 + token 校验）→ 内存 KV + watch channel。
- **改** `src/tmux/agent_hooks.rs` → `src/pty/agent_hooks.rs`：hook 命令模板换 curl；`initial_agent_option_value` 改写 KV 初值。
- **迁移** `agent_state.rs` / `agent_detect.rs` / `manifests/` / `process_info.rs` → `src/pty/` 下（内容不变）。
- **改** `agent_watch.rs` → `src/pty/agent_watch.rs`：`list-panes -a` 改 SessionManager 枚举；`capture_screen`/`pane_title` 改 `PtySession` 方法；`window_activity` 改 `last_output_at`。

### Phase 3：后端切换（单提交切换点）
- **改** `src/ws/terminal.rs`：删 `build_tmux_attach_cmd`；连接改为 `SessionManager` 订阅（不存在则按 DB 重建 + scrollback 回放 + 补屏）；断开只解绑订阅；agent_state 轮询改 watch 订阅；**删** external 入口（L520-767）。
- **改** `src/api/sessions.rs`：`new_session`/`kill_session`/`list_sessions`/`session_exists`/`pane_cwd` 全部换 SessionManager；`is_active` 改 `last_output_at`；**删** `/sessions/external`、`/sessions/adopt`。
- **改** `src/api/files.rs`：`resolve_session_base` 改 `last_cwd` 实时采样，丢失重建走 D5。
- **改** `src/api/hooks.rs`：读 agent-event KV。
- **改** `src/api/projects.rs`：列名/错误码随 D10 改（`engine_session_name_collision`）。
- **改** `src/api/system.rs`：`/system/multiplexer` 恒返 available（前端解耦后 Phase 5 删）。
- **改** `src/models/session.rs` + **新增** migration：D10 三项。
- **改** `src/main.rs`：AppState 换 `SessionManager` + agent-event KV；删 `check_multiplexer` 告警与 `SessionActivityMonitor`。

### Phase 4：前端切换
- **改** `useTerminal.ts`：删 copy-mode 注入（L321-347）/ modern 键位（L262-307）/ `tmuxScrollModeRef`；滚动改 xterm.js 本地 scrollback（`term.scrollLines/scrollPages`）；复制去 Shift 依赖（xterm 本地选区成默认）；重连后处理回放 + 补屏。
- **改** `api/client.ts`：`engine_session_name` / `runtime_kind: 'pty' | 'acp'`；删 `ExternalSession` / `adoptSession` / `listExternalSessions`。
- **改** `appStore.ts`：删 `keybindingMode` / `tmuxCheatsheetOpen` / `activeExternalSession`。
- **改** `Sidebar.tsx`：删 external 区块 + 轮询 + 速查表按钮；`runtime_kind` 三元改 `'pty'`。
- **删** `TmuxCheatsheet/` 整目录 + `Layout.tsx` 接线。
- **改** `Terminal.tsx`（Esc/滚动按钮改本地）、`utils/terminalInputMode.ts`、`agentAggregate.ts` + 测试、`AgentPicker.tsx` 文案、locales（`tmuxCheatsheet.*` 删、`confirmDeleteSession`/`agentPicker.*`/`settings.keybinding*` 改）、`manifest.webmanifest`。

### Phase 5：清理与文档
- **删** `src/tmux/` 整目录（mod.rs / control_mode.rs 及 Phase 1-2 已迁走的残留）。
- **删** `/system/multiplexer` 端点 + 前端消费。
- **文档**：见 §6。

---

## 4. 多实现差异（AGENTS §8）
- **cwd 采样**：Linux `/proc` / macOS libproc / Windows 无可靠等价 → Windows 兜底为 DB `last_cwd`（仅创建/重建时更新），差异记入 `docs/architecture/backend.md`。
- **进程终止**：Unix killpg / Windows `GenerateConsoleCtrlEvent`（`pty_io.rs` 已处理，沿用）。
- **hook 回调**：依赖会话内有 `curl`；容器精简镜像可能缺失 → 启动时探测，缺失则 agent 状态降级为纯屏幕检测（`agent_detect` 链路不受影响），差异记录同上。

## 5. 验收标准
- [ ] 无 tmux 进程参与：创建/输入/输出/resize/kill 全链路可用。
- [ ] WS 断开→重连：进程存活、画面补屏正确；blur/idle 断开策略无丢屏。
- [ ] 后端重启：会话可从 `last_cwd` + 原命令重建，scrollback 回放可见。
- [ ] agent 检测：claude/codex hook 经 HTTP 回调上报；屏幕检测（capture + osc_title）与 tmux 时代行为一致；事件推送替代轮询。
- [ ] 复制：纯左键拖拽即选即复制，无 Shift；移动端滚动用本地 scrollback。
- [ ] FileManager 根目录跟随终端 cwd（含会话丢失重建 fallback）。
- [ ] DB migration 幂等，存量 tmux 会话行走重建流程不报错。
- [ ] `cargo build` / clippy / fmt / `tsc` 零新增错误；现有测试 + 新增 pty 单测通过。
- [ ] `docs/reference/user-testing.md` 手动回归清单执行。

## 6. 风险与文档闭环
| 风险 | 缓解 |
|---|---|
| wezterm-term 集成摩擦/依赖树重 | Phase 1 先做 spike（feed + capture + 补屏三能力验证）再全面接入；不行走 D8 翻盘 |
| 补屏 ANSI 渲染与 xterm.js 显示偏差 | 验收含 TUI 程序（vim/htop）重连用例 |
| Phase 3 单提交切换面大 | Phase 1-2 纯新增先行合入；Phase 3 前全量手测 |
| scrollback 落盘 IO 放大 | 异步批量写 + 截尾；压测超大输出（`yes`）|

**实施后更新**：`docs/architecture/backend.md`（引擎变更 + 多实现差异）、`docs/architecture/frontend.md`、`docs/workflows/agent-edit-manual.md`（tmux 条目清理）、`CHANGELOG.md`、`PROGRESS.md`、`docs/reference/user-testing.md`（新用例）、新建 `docs/reference/herdr-reference.md`；方向规划与本文件移入 `archive/`。
