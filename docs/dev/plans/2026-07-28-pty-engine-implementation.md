# 会话引擎解耦 + 自管 pty 引擎 — 实施计划

> 状态：设计稿（2026-07-28，同日方向修订 v2；2026-08-09 盘点勘误 v3）
> 触发条件：`2026-07-28-remove-tmux-session-engine.md`（方向规划）获批落地，本文件是其要求的独立实施计划。
> 关联：方向规划（同目录）、`docs/reference/herdr-reference.md`（herdr 借鉴清单）、`src/tmux/`、`src/ws/terminal.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useTerminal.ts`、AGENTS.md §7/§8。

> **勘误（2026-07-28 v2）**：初版目标为"一次性去除 tmux"。产品决策修订为：**解耦 tmux → 双引擎过渡共存 → tmux 冻结维护（不再迭代）→ 未来可无痛摘除**。即方向规划 D3（SessionBackend 抽象）由 P2 待定提为 **P0 必做**；原 D9（舍弃抽象）作废，D6/D10/D11 相应修订。tmux 能力的自管实现尽量沿 herdr 已验证路径（含分屏与现代化交互）。

> **勘误（2026-08-09 v3，核查后修订）**：① 仓库已有 pty 脚手架（commit `477d79c`/`9a731de`，2026-08-05）：`RuntimeKind::Pty`、pty 创建分支、`handle_pty_terminal`、`PtyEngine` 骨架——但生命周期是"WS 连接期"（断开即杀进程），与本计划 D5 常驻设计冲突，定性为**临时件**，详见 §1.4；② `wezterm-term` **未发布到 crates.io**，只能 git 依赖引入（D8 修订）；③ `research/herdr` 目录不存在，herdr 参考以 `docs/reference/herdr-reference.md` 为准；④ `pty_io.rs` 须提为引擎公共件而非随 tmux 冻结，否则 PtyEngine 依赖冻结目录、摘除演练必失败（D9/Phase 1 修订）；⑤ §1.3 调用面补漏 `api/settings.rs`、`test_utils.rs`；⑥ Phase 2 改为垂直切片推进（§3）。

## 0. 新会话上手指引

- **当前状态（2026-08-09 更新）**：**Phase 1（解耦）已完成**（commit `3b394de` / `0ffbeb6` / `70840c5`）：`SessionEngine` trait + `EngineRegistry` 落地，`src/tmux/` 全部移入 `src/engine/tmux/` 冻结边界，agent 检测体系提为 `src/agent/`，所有调用方经注册表访问引擎；摘除演练通过（删 `src/engine/tmux/` + 打桩注册行后 `cargo build` 零改动通过）。pty 脚手架收敛进 `src/engine/pty/terminal_ws.rs`，仍是连接期生命周期——下一步 = **Phase 2 切片 A（常驻会话）**（§3），不得在脚手架上打补丁。
- **阅读顺序**：本文件 §2 决策 + §3 分期 → `docs/reference/herdr-reference.md`（Phase 2 实现细节，含 herdr 文件行号）→ 方向规划（仅需背景时）。
- **执行纪律**：每 Phase 结束提交并过 `cargo build`/`tsc`；Phase 1 是纯重构，**不得夹带任何行为变化**；`src/engine/tmux/` 落位后即冻结（D9）。
- **注意**：§1 盘点中的行号是 2026-07-28 快照，代码演进后以符号名为准（用 CodeGraph 查）。~~herdr 源码在 `research/herdr`~~（v3 勘误：该目录不存在）——herdr 参考以 `docs/reference/herdr-reference.md` 为准；确需对照源码移植时先自行 clone herdr（Apache-2.0）。

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
- **后端**：`api/sessions.rs`（L50/83/99/220/245/330/331/391/512/537/564/593/615）、`ws/terminal.rs`（L66/131/352/438/503/520-767）、`api/files.rs`（L120-173 `resolve_session_base` 含 L167 丢失重建 fallback）、`api/hooks.rs`（L45）、`api/projects.rs`（`tmux_session_name` 冲突检查）、`api/system.rs`（`/system/multiplexer`）、`main.rs`（AppState 两个 tmux 设施）、`models/session.rs`。（v3 补漏：`api/settings.rs`、`test_utils.rs` 亦含 tmux 引用。）
- **前端**：`useTerminal.ts`（copy-mode 字节注入 L321-347、modern 键位 L262-307、`tmuxScrollModeRef`）、`api/client.ts`、`appStore.ts`（`keybindingMode` / `tmuxCheatsheetOpen` / `activeExternalSession`）、`Sidebar.tsx`（external 区块 + 轮询）、`TmuxCheatsheet/`、locales。

### 1.4 已有 pty 脚手架盘点（2026-08-09 v3 增补）

commit `477d79c` / `9a731de`（2026-08-05）已落地一批 pty 脚手架，均与本计划目标形态有偏差，定性为**临时件**：

- `RuntimeKind::Pty` 变体（`models/session.rs`）+ `POST /sessions` pty 创建分支（`api/sessions.rs:221`）。注意：枚举 `Default` 已随 ACP 阶段推进为 `Acp`（非 `Tmux`）。DB `runtime_kind` 为 TEXT 无 CHECK 约束，`'pty'` 无需 migration。
- `ws/terminal.rs::handle_pty_terminal`（L843-1093）：openpty + bash + 读写/resize 全通，但**生命周期 = WS 连接期**——断开即 SIGHUP 杀子进程（L1083），与 D5/§1.2 "detach 不杀进程"冲突；且未走 `PtyEngine`，内联了一套 openpty/读写循环，与 `src/tmux/pty.rs::PtySession` 近似重复（违反 AGENTS §6 禁 Copy-Paste）。pty 路径还直接依赖 `src/tmux/pty_io::{write_pty, kill_session_process}`（L970/L1084）——这正是 pty_io 须提公共的实证（见 D9 v3 修订）。
- `src/engine/pty/mod.rs::PtyEngine` 骨架：全 `#[allow(dead_code)]`，无调用方；`src/engine/mod.rs` 仅一行 `pub mod pty;`，无 trait/registry。
- 前端**零 pty 支持**：`client.ts` `runtime_kind: 'tmux' | 'acp'`，`CreateSessionModal` 只发这两种；pty 会话目前只能手工 API 创建。
- 未实现：补屏 / VT 模拟器 / scrollback / `last_cwd` / hook env 注入 / 输出订阅。

**处置**：Phase 1 将内联实现收敛进 `src/engine/pty/`（消重复，行为不变——仍是连接期生命周期）；Phase 2 切片 A 以常驻会话替换之。不得在现有脚手架上直接加功能。

**可复用存量资产**：`tests/runtime_kind_matrix.rs`（跨 runtime e2e，按 integration-checklist「验证工具」节扩展 pty case）、`tests/runtime_kind_migration.rs`、`tests/agent_hook_integration.rs`；integration-checklist §A.1 的 `/proc/<pid>/cwd`、fd 计数 OS 级断言模板（对应 Phase 2 的 fd 回归测试要求）。

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
- **v3 修订（2026-08-09）**：`wezterm-term` **未发布到 crates.io**（crates.io API / lib.rs 均 404，系 wezterm 工作区内部 crate），只能以 **git 依赖**引入（pin wez/wezterm 仓库 `term/` 子目录，锁 commit hash）。License 为 MIT，与本项目兼容。Phase 2 spike 第一项因此改为"**git dep 可拉取 + 编译通过**"，再验 feed + capture + 补屏。
- **否决项**：libghostty-vt（Zig 构建链）；alacritty_terminal（API 摩擦）；vt100（覆盖弱）。
- **翻盘条件**：git dep 拉取/编译不可接受、依赖树过重 → 降级 vt100（registry 备选，接受 osc_title 弱化）或 vte 自建。

### D9（v2 重写）：引入 `SessionEngine` 抽象，tmux 为冻结后端
- **决策**：定义 `SessionEngine` trait（方向规划 D3 提为 P0），能力面 = §1.3 调用方实际所需：`create / kill / exists / list / write / resize / subscribe_output / capture_screen / pane_title / current_cwd / is_active / agent_snapshot`。两个实现：
  - `TmuxEngine`：**纯包装现有 `src/tmux/` 代码，行为零变化，此后冻结**（只修致命 bug，不加功能）。
  - `PtyEngine`：新建（Phase 2+），**新会话默认引擎**。
- **按会话路由**：`runtime_kind` 决定引擎（`'tmux'` → TmuxEngine，`'pty'` → PtyEngine；`'acp'` 不经此抽象）。
- **摘除标准（解耦验收）**：`src/engine/tmux/` 之外全仓不出现 tmux 符号（DB 枚举值与前端 runtime_kind 分流除外）；删除 `TmuxEngine` 目录 + 注册行后 `cargo build` 通过、其余模块零改动。
- **否决项**：~~初版 D9：舍弃抽象、一次性切换~~（产品决策要求过渡期）；为 ACP 也套此抽象（ACP 非终端引擎，不强行统一）。
- **翻盘条件**：若过渡期后确认无人使用 tmux 会话且抽象层阻碍 PtyEngine 演进，可提前摘除。
- **v3 修订（2026-08-09）**：`pty_io.rs`（`write_pty` / `kill_session_process`）**不随 tmux 冻结**，提为引擎公共件 `src/engine/pty_io.rs`。理由：其内容零 tmux 逻辑，且现有 pty 路径已在依赖它（`ws/terminal.rs:970/1084`，见 §1.4）；若冻结进 `src/engine/tmux/`，PtyEngine 将依赖冻结目录，摘除演练必失败。

### D10（v2 修订）：DB 与命名 —— 过渡期最小改动
- **决策**：`runtime_kind` 新增值 `'pty'`，**新建会话默认 `'pty'`**；存量 `'tmux'` 会话不迁移、继续走 TmuxEngine。新增 `last_cwd` 列（pty 用）。`tmux_session_name` 列**过渡期不改名**（两引擎共用存引擎内会话 id，改名推迟到摘除阶段，避免冻结代码 churn）。
- ~~初版：UPDATE 'tmux'→'pty' + 立即改名 engine_session_name~~（v2 作废：违背过渡期共存）。
- **v3 修订（2026-08-09）**：`RuntimeKind::Pty` 变体与 pty 创建分支已落地（见 §1.4）；枚举 `Default` 现为 `Acp`（ACP 阶段推进所致，不回改）——本计划"新建会话默认 pty"的含义修正为 **Phase 4 将无 agent 会话的创建路径显式路由到 `Pty`**（前端 `CreateSessionModal` 改发 `'pty'`，后端创建分支已备）。DB `runtime_kind` 为 TEXT 无 CHECK 约束，新变体无需 migration，仅 `last_cwd` 列需要。

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
- **移动** `src/tmux/` → `src/engine/tmux/`（`mod.rs`、`control_mode.rs` 及 tmux 版 hook 注入），实现 `TmuxEngine`，**行为零变化**（用 `git mv` 保历史）。
- **提公共** `pty_io.rs` → `src/engine/pty_io.rs`（v3 修订，D9）：`write_pty` / `kill_session_process` 零 tmux 逻辑，pty 路径已在依赖，不得冻结进 tmux 目录。
- **收敛** `ws/terminal.rs::handle_pty_terminal` 的内联 openpty/读写实现（§1.4）进 `src/engine/pty/`，消除与 `PtySession` 的重复；**行为不变**（仍连接期生命周期，Phase 2 切片 A 才改常驻）。
- **提公共**：`agent_state.rs` / `agent_detect.rs` / `manifests/` / `process_info.rs` → `src/agent/`（引擎无关）。注意 `process_info.rs` 现 `use crate::tmux::agent_hooks`，提公共时先剥离该耦合；`agent_state.rs` 的 `@omniterm_agent` option 常量属 tmux 信道概念，随 tmux 侧实现留在 TmuxEngine，类型本体提公共。
- **改调用方走 trait**：`api/sessions.rs`、`ws/terminal.rs`、`api/files.rs`、`api/hooks.rs`、`api/settings.rs`、`test_utils.rs`、`main.rs`（AppState 持 `EngineRegistry`）；`agent_watch.rs` 改为经 trait 枚举会话 + capture（移入 `src/agent/watch.rs`）。
- **external/adopt 链路**：实现收进 `src/engine/tmux/external.rs`，API 层仅薄转发（标记冻结）。
- **产出**：行为回归——现有 tmux 会话全功能不变；`rg tmux src/ -g '!src/engine/tmux/*'` 仅剩 DB 枚举值/注册行。
- **完成记录（2026-08-09）**：按上述清单落地，187 测试全过、clippy/fmt 零警告。两点执行偏差记录：
  1. **验收口径细化**：`rg tmux`（大小写敏感）边界外残留 = ① `src/engine/mod.rs` 注册行/门面分发（`pub mod tmux;`、WS attach 分发、Windows workaround 门面）；② 冻结持久化/wire 契约——DB 列 `tmux_session_name`、DB 值 `'tmux'`、路由串 `/system/tmux/mouse` 与 `/ws/terminal/external/{tmux_name}`、adopt 请求字段（已 serde rename 中性化）。Phase 5 摘除时 ①②一并处理。
  2. **pty 脚手架消重降级为"搬家"**：原计划"收敛内联实现进 engine/pty 并消除与 `PtySession` 的重复"，执行中发现 `PtySession::spawn` 对 child 做 `mem::forget`（防孤儿），复用它将失去子进程退出检测（WS 提前关闭语义变化）。因该流程本就由 Phase 2 切片 A 整体替换，此处只移动不消重，避免给临时件投入行为风险。

### Phase 2：PtyEngine 地基（纯新增，v3 改为垂直切片）
> 实现细节按 `docs/reference/herdr-reference.md` §去 tmux 增补：**dup 裸 fd + drop(PtyPair)**（根除 VEOF，配 fd 计数回归测试）、resize 最新值覆盖槽、reattach **resize nudge**（`rows-1 → 30ms → rows`，防 vim/htop 重连花屏）、SIGHUP→TERM→KILL 三级清理、POLLHUP 当可读、固定 `TERM=xterm-256color`、渲染信号 swap+Notify 合并、DEC 2026 抑制。
> **v3 修订**：① `RuntimeKind::Pty` 变体已落地且 DB 无 CHECK 约束——migration 只需 `last_cwd` 列；② 重构为三个垂直切片，每片独立可验证、独立提交；③ 变体虽已存在，checklist B 义务未尽（pty 主流程 files/清理/前端 dispatch 均未走通）——每片按 `docs/workflows/integration-checklist.md` §B.2 穷举验证，并按其「验证工具」节扩展 `tests/runtime_kind_matrix.rs` pty case（任何 `?` block merge）。
- **切片 A（最优先）：常驻会话**。`PtyEngine` 实现 `SessionEngine` + 会话 map 持有 pty 进程；WS 断开只解绑订阅、不杀进程（替换 §1.4 连接期生命周期）；attach = 订阅输出 + 重发。验收：断开→重连后 shell 存活、可继续输入。
- **切片 B：补屏 + VT**。`Cargo.toml` 引入 `wezterm-term`（**git 依赖**，见 D8 v3）。spike 先行：git dep 可拉取 + 编译通过 → feed + capture + 补屏三能力验证；再接 resize nudge。spike 失败 → 走 D8 翻盘（vt100/vte），不硬扛。
- **切片 C：恢复**。`src/engine/pty/scrollback.rs`（D5 落盘纪律）、`src/engine/pty/cwd.rs`（`/proc` / libproc 采样 + `last_cwd` 回写）、migration 仅加 `last_cwd` 列；后端重启重建 + ANSI seed 回放。
- **产出**：单测覆盖 create/write/read/resize/kill/capture/回放/fd 计数（OS 级断言按 integration-checklist §A.1 模板）；runtime_kind_matrix 含 pty 全路径 case。

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
- **Phase 1（解耦）** ✅ 2026-08-09：
  - [x] 现有 tmux 会话全功能回归（创建/输入/复制/agent 检测/external 收养）零变化（187 测试 + clippy/fmt 全绿；纯重构无行为变化）。
  - [x] `rg tmux src/ -g '!src/engine/tmux/*'` 仅剩 DB 枚举值与注册行（口径细化见 Phase 1 完成记录）。
  - [x] 模拟摘除演练：删 `src/engine/tmux/` + 打桩注册行后 `cargo build` 通过，其余模块零改动（未提交）。
- **Phase 2-4（pty 引擎）**：
  - [ ] pty 会话：创建/输入/输出/resize/kill 全链路无 tmux 进程参与。
  - [ ] `tests/runtime_kind_matrix.rs` 含 pty 全路径 case（创建/files/清理），integration-checklist §B.2 表无 `?`。
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
| wezterm-term 仅 git 依赖可得（v3 新发现）+ 集成摩擦/依赖树重 | spike 首项"可拉取 + 编译通过"，锁 commit hash；不行走 D8 翻盘（vt100/vte） |
| 存量 pty 脚手架与计划冲突（v3 新发现） | §1.4 定性临时件；Phase 1 收敛、Phase 2 切片 A 替换；禁止在脚手架上加功能 |
| 补屏 ANSI 与 xterm.js 显示偏差 | 验收含 TUI 程序重连用例 + resize nudge |
| scrollback 落盘 IO 放大 | 异步批量写 + 截尾；压测 `yes` |
| 冻结纪律流失（有人继续给 tmux 加功能） | AGENTS.md 文档索引加冻结说明；PR 审查以 D9 为据 |

**实施后更新**：`docs/architecture/backend.md`（引擎抽象 + 差异表）、`docs/architecture/frontend.md`（D12 分流）、`docs/workflows/agent-edit-manual.md`、AGENTS.md（tmux 冻结说明）、`CHANGELOG.md`、`PROGRESS.md`、`docs/reference/user-testing.md`（双引擎用例）；`docs/reference/herdr-reference.md` 已增补；Phase 5 执行时本文件与方向规划移入 `archive/`。
