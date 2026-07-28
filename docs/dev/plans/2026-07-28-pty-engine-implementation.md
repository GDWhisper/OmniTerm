# 会话引擎解耦 + 自管 pty 引擎 — 实施计划

> 状态：设计稿（2026-07-28，同日方向修订 v2）
> 触发条件：`2026-07-28-remove-tmux-session-engine.md`（方向规划）获批落地，本文件是其要求的独立实施计划。
> 关联：方向规划（同目录）、`docs/reference/herdr-reference.md`（herdr 借鉴清单）、`src/tmux/`、`src/ws/terminal.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useTerminal.ts`、AGENTS.md §7/§8。

> **勘误（2026-07-28 v2）**：初版目标为"一次性去除 tmux"。产品决策修订为：**解耦 tmux → 双引擎过渡共存 → tmux 冻结维护（不再迭代）→ 未来可无痛摘除**。即方向规划 D3（SessionBackend 抽象）由 P2 待定提为 **P0 必做**；原 D9（舍弃抽象）作废，D6/D10/D11 相应修订。tmux 能力的自管实现尽量沿 herdr 已验证路径（含分屏与现代化交互）。

---

## 1. Phase 0 盘点结论（已完成）

### 1.1 关键事实
- **架构已半在 portable-pty 上**：`ws/terminal.rs` 现状即 `portable-pty → spawn tmux 客户端`。pty 读写管线、`master.resize(PtySize)`、`pty_io.rs`（`write_pty` VEOF workaround / `kill_session_process` SIGHUP）**原样可复用**。
- **tmux 能力用得很窄**：全项目每会话固定 1 window / 1 pane；从不使用 split-window / resize-pane / pipe-pane / scrollback。
- **零改动可共用**：`agent_detect.rs` + `manifests/`（纯文本规则引擎）、`agent_state.rs`（纯数据模型）、`process_info.rs`（进程树）——引擎无关，提为公共模块。
- **tmux 专属**：`control_mode.rs`（403 行只做"最近 2s 有无输出"）、`mod.rs`（tmux 子进程命令门面）——随 TmuxEngine 冻结，摘除时删。

### 1.2 tmux 能力 → PtyEngine 等价实现映射（摘要）

| tmux 能力（使用点） | PtyEngine 等价 | 难度 |
|---|---|---|
| `new-session -d`（创建） | `openpty` + `spawn_command`（herdr：dup 裸 fd + drop(PtyPair)） | 直接有 |
| `new-session -A`（attach/重连） | 常驻会话 + 输出订阅 + VT 补屏 + resize nudge | 需自建 |
| detach 不杀进程 | 进程由后端 task 持有，WS 断开只解绑订阅 | 需自建 |
| `send-keys` | `write_pty(fd, bytes + "\r")` | 直接有 |
| resize | `master.resize()`（现状已是）+ 最新值覆盖槽去抖 | 直接有 |
| `kill-session` | SIGHUP→TERM→KILL 三级进程树清理（herdr） | 直接有 |
| `list-sessions` / `has-session` | 引擎内存 map | 直接有 |
| `pane_current_path` | `/proc/<前台pid>/cwd`（macOS libproc） | 需自建（Linux 易） |
| `capture-pane`（agent 检测输入） | wezterm-term 服务端 VT grid | 需自建（重） |
| `#{pane_title}`（osc_title 区域） | wezterm-term 截获 OSC 0/2 | 随模拟器免费 |
| `#{pane_pid}` | spawn 时记录 child pid | 直接有 |
| control mode `%output` → is_active | 读循环更新 `Instant` | 直接有（更简单） |
| `set-option @omniterm_agent` hook 信道 | 本地 HTTP 回调（D7） | 需自建（中） |
| 后端重启后会话幸存 | 无等价 → D5 自动重建 + ANSI 回放 | 无等价 |
| external 会话发现/收养 | 无等价 → tmux 专属，随 TmuxEngine 冻结（D6） | 无等价 |
| `mouse on` / `escape-time` workaround | 不需要（问题消失） | — |

### 1.3 调用面（抽象层须覆盖的触点）
- **后端**：`api/sessions.rs`（L50/83/99/220/245/330/331/391/512/537/564/593/615）、`ws/terminal.rs`（L66/131/352/438/503/520-767）、`api/files.rs`（L120-173 `resolve_session_base` 含 L167 丢失重建 fallback）、`api/hooks.rs`（L45）、`api/projects.rs`（`tmux_session_name` 冲突检查）、`api/system.rs`（`/system/multiplexer`）、`main.rs`（AppState 两个 tmux 设施）、`models/session.rs`。
- **前端**：`useTerminal.ts`（copy-mode 字节注入 L321-347、modern 键位 L262-307、`tmuxScrollModeRef`）、`api/client.ts`、`appStore.ts`（`keybindingMode` / `tmuxCheatsheetOpen` / `activeExternalSession`）、`Sidebar.tsx`（external 区块 + 轮询）、`TmuxCheatsheet/`、locales。

---

## 2. 设计决策

### D5：后端重启 = pty 会话丢失 + 自动重建
- **决策**：PtyEngine 接受进程丢失。DB 已存 `workspace_path` + 启动命令；新增两项恢复能力：
  1. **cwd 回写**：pty 会话定期（30s + 会话操作时）采样前台进程 cwd 回写 DB 新列 `last_cwd`，重建时用最后 cwd。
  2. **scrollback 落盘**：读循环 tee 进环形缓冲（内存 256KB/会话）并异步落盘；重启重建后把落盘 ANSI seed 进新 VT 模拟器（herdr `seed_history_ansi` 模式），再接新 pty。
- **落盘纪律（herdr 验证）**：ANSI 历史与结构数据**分文件**（终端输出可能含密钥）、权限 0600、tmp+rename 原子写、5s 去抖后台写、UTF-8 边界截断。"落盘可关闭"开关记为 P1 待定。
- **P1 增强**：agent 会话重建附加 resume 参数（herdr `AgentResumePlan`：hook 上报 session id → `claude --resume <id>`）。
- **否决项**：守护进程分离（奥卡姆剃刀）；SCM_RIGHTS 活 fd 热切换（herdr 为单二进制自更新设计，不值）。
- **翻盘条件**：实测"重建 + 回放"不足以恢复工作流 → 再评估守护进程。
- **过渡期语义**：tmux 会话保活行为不变（tmux server 幸存）。

### D6（v2 修订）：external 会话发现/收养 = tmux 专属能力，冻结随葬
- **决策**：`/sessions/external`、`/sessions/adopt`、`/ws/terminal/external/{name}`、Sidebar 外部会话区块**过渡期保留现状、不再迭代**，实现收进 TmuxEngine 边界内；摘除 tmux 时一并删除（见 §3 摘除清单）。
- **理由**：功能现成可用，过渡期删除徒增用户损失；但它本质依赖外部 tmux server，PtyEngine 无对应物，不做抽象化。
- ~~初版决策：立即全链路删除~~（v2 作废）。

### D7：agent hook 信道 = 本地 HTTP 回调（仅 PtyEngine）
- **决策**：PtyEngine 会话的 hook 命令为 `curl POST $OMNITERM_HOOK_URL`（回环 + 会话专属 token）。后端内存 KV（session_id → AgentSnapshot）+ tokio watch channel。
- **herdr 三件套照搬**：① spawn 时 env 注入 `OMNITERM_HOOK_URL` / `OMNITERM_SESSION_ID`（hook 命令引用 env，不硬编码端口）；② 按 source 记 seq 幂等去重；③ hook 侧 fail-silent + 0.5s 超时。**HookAuthority 仲裁**：hook 存活时为状态权威，屏幕检测降级 fallback。
- **过渡期语义**：tmux 会话沿用 `@omniterm_agent` option 信道（冻结不改）；抽象层以 `agent_snapshot(session)` 统一读口，两引擎各自实现。
- **否决项**：Unix socket（Windows/psmux 不兼容）；约定文件（竞态）。
- **翻盘条件**：容器内 curl 缺失比例高 → 回退"约定文件 + watch"。

### D8：VT 模拟器 = wezterm-term
- **决策**：新增依赖 `wezterm-term`（与 portable-pty 同作者），每 pty 会话服务端维护 grid：capture（agent 检测）、OSC 0/2 标题、重连补屏、重启 ANSI seed 恢复。herdr 用 libghostty-vt 验证了"模拟器唯一真相源"模式，wezterm-term 纯 Rust 等价且免 FFI。
- **否决项**：libghostty-vt（Zig 构建链）；alacritty_terminal（API 摩擦）；vt100（覆盖弱）。
- **翻盘条件**：依赖树过重/编译不可接受 → 降级 vt100 并接受 osc_title 弱化。

### D9（v2 重写）：引入 `SessionEngine` 抽象，tmux 为冻结后端
- **决策**：定义 `SessionEngine` trait（方向规划 D3 提为 P0），能力面 = §1.3 调用方实际所需：`create / kill / exists / list / write / resize / subscribe_output / capture_screen / pane_title / current_cwd / is_active / agent_snapshot`。两个实现：
  - `TmuxEngine`：**纯包装现有 `src/tmux/` 代码，行为零变化，此后冻结**（只修致命 bug，不加功能）。
  - `PtyEngine`：新建（Phase 2+），**新会话默认引擎**。
- **按会话路由**：`runtime_kind` 决定引擎（`'tmux'` → TmuxEngine，`'pty'` → PtyEngine；`'acp'` 不经此抽象）。
- **摘除标准（解耦验收）**：`src/engine/tmux/` 之外全仓不出现 tmux 符号（DB 枚举值与前端 runtime_kind 分流除外）；删除 `TmuxEngine` 目录 + 注册行后 `cargo build` 通过、其余模块零改动。
- **否决项**：~~初版 D9：舍弃抽象、一次性切换~~（产品决策要求过渡期）；为 ACP 也套此抽象（ACP 非终端引擎，不强行统一）。
- **翻盘条件**：若过渡期后确认无人使用 tmux 会话且抽象层阻碍 PtyEngine 演进，可提前摘除。

### D10（v2 修订）：DB 与命名 —— 过渡期最小改动
- **决策**：`runtime_kind` 新增值 `'pty'`，**新建会话默认 `'pty'`**；存量 `'tmux'` 会话不迁移、继续走 TmuxEngine。新增 `last_cwd` 列（pty 用）。`tmux_session_name` 列**过渡期不改名**（两引擎共用存引擎内会话 id，改名推迟到摘除阶段，避免冻结代码 churn）。
- ~~初版：UPDATE 'tmux'→'pty' + 立即改名 engine_session_name~~（v2 作废：违背过渡期共存）。

### D11（v2 修订）：分屏 = 前端原生，布局树参考 herdr BSP（P1，仅 pty 会话）
- **决策**：分屏为**前端网格布局 + 多 xterm.js 实例，每 pane = 独立 pty 会话 + 独立 WS**；布局持久化采用 herdr 的 BSP 结构（`Layout::Pane(id) | Split{direction, ratio, first, second}`，存 DB/前端）。**仅对 pty 会话开放**；tmux 会话冻结现状（用户仍可敲 prefix 分屏）。归方向规划 Phase 4（P1）单独立项。
- **理由**：后端零新增概念；herdr 证明布局纯属客户端层。
- **翻盘条件**：若强需求"同会话多视图"，再评估订阅复用，仍无需服务端 pane 树。

### D12（新增）：现代化交互按 runtime_kind 分流
- **决策**：前端交互按会话引擎分流——**pty 会话**：xterm.js 本地 scrollback、纯左键拖选即复制（无 Shift）、无 prefix 键位、（P1）分屏/命令面板；**tmux 会话**：保留全部现有交互（copy-mode 注入、Shift 复制、TmuxCheatsheet、keybindingMode），冻结不迭代。
- **理由**：过渡期两种会话并存，交互语义不可混用（AGENTS §8：差异显式降级，不为单一实现背书）。
- **摘除时**：tmux 分支代码整体删除（见 §3 摘除清单）。

---

## 3. 实施分期（文件级）

> 每 Phase 结束提交并保持 `cargo build` / `tsc` 通过。Phase 1 为纯重构（行为不变），Phase 2-3 纯新增，Phase 4 切默认，全程 tmux 会话不受影响。

### Phase 1：解耦地基 —— `SessionEngine` trait + TmuxEngine 包装（纯重构）
- **新增** `src/engine/mod.rs`：`SessionEngine` trait（D9 能力面）+ 按 `runtime_kind` 路由的 `EngineRegistry`。
- **移动** `src/tmux/` → `src/engine/tmux/`（`mod.rs`、`control_mode.rs`、`pty_io.rs` 及 tmux 版 hook 注入），实现 `TmuxEngine`，**行为零变化**。
- **提公共**：`agent_state.rs` / `agent_detect.rs` / `manifests/` / `process_info.rs` → `src/agent/`（引擎无关）。
- **改调用方走 trait**：`api/sessions.rs`、`ws/terminal.rs`、`api/files.rs`、`api/hooks.rs`、`main.rs`（AppState 持 `EngineRegistry`）；`agent_watch.rs` 改为经 trait 枚举会话 + capture（移入 `src/agent/watch.rs`）。
- **external/adopt 链路**：实现收进 `src/engine/tmux/external.rs`，API 层仅薄转发（标记冻结）。
- **产出**：行为回归——现有 tmux 会话全功能不变；`rg tmux src/ -g '!src/engine/tmux/*'` 仅剩 DB 枚举值/注册行。

### Phase 2：PtyEngine 地基（纯新增）
> 实现细节按 `docs/reference/herdr-reference.md` §去 tmux 增补：**dup 裸 fd + drop(PtyPair)**（根除 VEOF，配 fd 计数回归测试）、resize 最新值覆盖槽、reattach **resize nudge**（`rows-1 → 30ms → rows`，防 vim/htop 重连花屏）、SIGHUP→TERM→KILL 三级清理、POLLHUP 当可读、固定 `TERM=xterm-256color`、渲染信号 swap+Notify 合并、DEC 2026 抑制。
- **新增** `Cargo.toml`：`wezterm-term`。先做 spike：feed + capture + 补屏三能力验证。
- **新增** `src/engine/pty/mod.rs`：`PtyEngine` 实现 `SessionEngine`。
- **新增** `src/engine/pty/session.rs`：openpty + spawn（注入 hook env）+ 读循环（tee → 订阅广播 / 环形缓冲落盘 / wezterm-term feed / `last_output_at`）+ write/resize/kill + capture/pane_title/render_screen_ansi（补屏）。
- **新增** `src/engine/pty/scrollback.rs`（D5 落盘纪律）、`src/engine/pty/cwd.rs`（`/proc` / libproc 采样 + `last_cwd` 回写）。
- **新增** migration：`last_cwd` 列 + `runtime_kind` 允许 `'pty'`。
- **产出**：单测覆盖 create/write/read/resize/kill/capture/回放/fd 计数。

### Phase 3：pty hook 信道（纯新增）
- **新增** `src/api/agent_events.rs`：`POST /api/v1/internal/agent-event`（回环 + token + seq 去重）→ 内存 KV + watch channel。
- **新增** `src/engine/pty/agent_hooks.rs`：以 tmux 版为蓝本，hook 命令模板换 `curl $OMNITERM_HOOK_URL`（fail-silent + 0.5s）。
- `PtyEngine::agent_snapshot` 读 KV；`ws/terminal.rs` 对 pty 会话用 watch 订阅推送（tmux 会话维持 1s 轮询，冻结）。

### Phase 4：切换默认 + 前端分流
- **后端**：`api/sessions.rs` 创建会话默认 `runtime_kind='pty'`（无 agent 时；有 agent 仍 `'acp'`）；`ws/terminal.rs` pty 路径接重建 + 回放 + 补屏 + nudge；`api/files.rs` pty 路径用 `last_cwd`/实时采样。
- **前端**（D12 分流，不删 tmux 分支）：
  - `api/client.ts`：`runtime_kind: 'tmux' | 'pty' | 'acp'`。
  - `useTerminal.ts`：按 runtime_kind 分流——pty 路径不注入 copy-mode/prefix 字节，滚动用 `term.scrollLines`，复制走本地选区（无 Shift）；tmux 路径原样。
  - `Terminal.tsx` / `terminalInputMode.ts`：滚动/Esc 按分流处理。
  - `Sidebar.tsx`：创建入口默认 pty；external 区块仅在系统有 tmux 时展示（冻结）。
  - 文案：新增 pty 会话相关措辞；tmux 文案保留。
- **产出**：新会话全部 pty；旧 tmux 会话照常可用。

### Phase 5（未来独立触发，非本计划执行范围）：摘除 tmux
> 触发条件：产品确认过渡期结束。得益于 Phase 1 解耦，此阶段为纯删除：
- 删 `src/engine/tmux/` + `EngineRegistry` 注册行 + `/system/multiplexer`。
- 删前端 tmux 分支：copy-mode 注入、`keybindingMode`、`TmuxCheatsheet/`、external 区块、相关 locales。
- migration：`runtime_kind='tmux'` 存量按 D5 重建流程转 `'pty'`；`tmux_session_name` 改名 `engine_session_name`。
- 文档清理 + CHANGELOG。

---

## 4. 多实现差异（AGENTS §8）
- **双引擎行为差异须显式**：`is_active`（control mode 2s vs 读循环时间戳）、cwd（tmux 跟踪 vs /proc 采样）、agent 信道（option 轮询 vs HTTP 推送）、复制/滚动交互（D12 分流）——差异表记入 `docs/architecture/backend.md`，前端不得以单一引擎行为推断另一引擎。
- **cwd 采样**：Linux `/proc` / macOS libproc / Windows 无可靠等价 → Windows 兜底 DB `last_cwd`。
- **hook 回调**：依赖会话内 `curl`；缺失则降级纯屏幕检测（`agent_detect` 不受影响）。

## 5. 验收标准
- **Phase 1（解耦）**：
  - [ ] 现有 tmux 会话全功能回归（创建/输入/复制/agent 检测/external 收养）零变化。
  - [ ] `rg tmux src/ -g '!src/engine/tmux/*'` 仅剩 DB 枚举值与注册行。
- **Phase 2-4（pty 引擎）**：
  - [ ] pty 会话：创建/输入/输出/resize/kill 全链路无 tmux 进程参与。
  - [ ] WS 断开→重连：进程存活、补屏 + nudge 正确（含 vim/htop 用例）。
  - [ ] 后端重启：pty 会话从 `last_cwd` + 原命令重建，scrollback 回放可见；tmux 会话照常幸存。
  - [ ] agent 检测：pty 会话 hook 经 HTTP 上报（HookAuthority 生效）、屏幕检测行为与 tmux 链路一致。
  - [ ] pty 会话复制：纯左键拖选即复制；移动端滚动本地化。tmux 会话交互不变。
  - [ ] FileManager 根目录在两种会话下均跟随终端 cwd。
- **通用**：
  - [ ] migration 幂等；`cargo build` / clippy / fmt / `tsc` 零新增错误；新增单测通过。
  - [ ] 模拟摘除演练：本地删 `src/engine/tmux/` + 注册行，`cargo build` 通过（解耦达标证明，不提交）。

## 6. 风险与文档闭环
| 风险 | 缓解 |
|---|---|
| Phase 1 重构面大（一次触碰全部调用方） | trait 签名先按 TmuxEngine 现有行为 1:1 定义，不夹带行为变化；回归清单先行 |
| 双引擎并存状态不一致 | §4 差异表 + D12 分流；agent 状态统一经 `agent_snapshot` 读口 |
| wezterm-term 集成摩擦/依赖树重 | Phase 2 先 spike；不行走 D8 翻盘 |
| 补屏 ANSI 与 xterm.js 显示偏差 | 验收含 TUI 程序重连用例 + resize nudge |
| scrollback 落盘 IO 放大 | 异步批量写 + 截尾；压测 `yes` |
| 冻结纪律流失（有人继续给 tmux 加功能） | AGENTS.md 文档索引加冻结说明；PR 审查以 D9 为据 |

**实施后更新**：`docs/architecture/backend.md`（引擎抽象 + 差异表）、`docs/architecture/frontend.md`（D12 分流）、`docs/workflows/agent-edit-manual.md`、AGENTS.md（tmux 冻结说明）、`CHANGELOG.md`、`PROGRESS.md`、`docs/reference/user-testing.md`（双引擎用例）；`docs/reference/herdr-reference.md` 已增补；Phase 5 执行时本文件与方向规划移入 `archive/`。
