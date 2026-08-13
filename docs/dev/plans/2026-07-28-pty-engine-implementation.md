# 会话引擎解耦 + 自管 pty 引擎 — 实施计划

> 状态：设计稿（2026-07-28，同日方向修订 v2；2026-08-09 盘点勘误 v3；2026-08-13 D8 选型翻盘 v5）
> 触发条件：`2026-07-28-remove-tmux-session-engine.md`（方向规划）获批落地，本文件是其要求的独立实施计划。
> 关联：方向规划（同目录）、`docs/reference/herdr-reference.md`（herdr 借鉴清单）、`src/tmux/`、`src/ws/terminal.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useTerminal.ts`、AGENTS.md §7/§8。

> **勘误（2026-07-28 v2）**：初版目标为"一次性去除 tmux"。产品决策修订为：**解耦 tmux → 双引擎过渡共存 → tmux 冻结维护（不再迭代）→ 未来可无痛摘除**。即方向规划 D3（SessionBackend 抽象）由 P2 待定提为 **P0 必做**；原 D9（舍弃抽象）作废，D6/D10/D11 相应修订。tmux 能力的自管实现尽量沿 herdr 已验证路径（含分屏与现代化交互）。

> **勘误（2026-08-13 v5，D8 翻盘）**：`wezterm-term` git 依赖阻塞 crates.io 发布（v4 已记录事实），**替代方案调研完成并选定 `alacritty_terminal` 0.26**（registry 可用、应答闭环齐全、本项目净新增 7 个依赖包）。选型对照与实测证据见 D8 v5；代码改动列为 **Phase 2.5**（本轮仅决策与文档，未动代码）。

> **勘误（2026-08-09 v3，核查后修订）**：① 仓库已有 pty 脚手架（commit `477d79c`/`9a731de`，2026-08-05）：`RuntimeKind::Pty`、pty 创建分支、`handle_pty_terminal`、`PtyEngine` 骨架——但生命周期是"WS 连接期"（断开即杀进程），与本计划 D5 常驻设计冲突，定性为**临时件**，详见 §1.4；② `wezterm-term` **未发布到 crates.io**，只能 git 依赖引入（D8 修订）；③ `research/herdr` 目录不存在，herdr 参考以 `docs/reference/herdr-reference.md` 为准；④ `pty_io.rs` 须提为引擎公共件而非随 tmux 冻结，否则 PtyEngine 依赖冻结目录、摘除演练必失败（D9/Phase 1 修订）；⑤ §1.3 调用面补漏 `api/settings.rs`、`test_utils.rs`；⑥ Phase 2 改为垂直切片推进（§3）。

## 0. 新会话上手指引

- **当前状态（2026-08-13 更新）**：**Phase 2.5（VT 模拟器换 registry 依赖）已完成**——`wezterm-term` git 依赖已换为 `alacritty_terminal` 0.26（crates.io），`cargo package` 通过、crates.io 渠道恢复；顺带修双应答（服务端应答门控在 detach 期）。完成记录与执行偏差见 §3 Phase 2.5 节尾。**下一步 = Phase 3（pty hook 信道）**。
- **Phase 2 完成情况（2026-08-12）**：**Phase 2（PtyEngine 地基）已完成**（commit `6065fa1` / `e7aab2a` / 切片 C，分支 `feature/pty-phase2`）：三个垂直切片全部落地并端到端验收——切片 A 常驻会话（断开不杀进程、重连补屏）、切片 B wezterm-term VT 模拟器（capture/title/resize nudge，spike 通过未触发 D8 翻盘）、切片 C 恢复能力（scrollback 落盘 + `last_cwd` 回写 + 重启重建回放）。~~下一步 = **Phase 3（pty hook 信道）**~~（v5：先做 Phase 2.5）。Phase 2 完成记录见 §3 Phase 2 节尾。
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

### D8：VT 模拟器（**v5 定案：`alacritty_terminal`**；初版 wezterm-term 因 git 依赖弃用）
- **决策**：新增依赖 `wezterm-term`（与 portable-pty 同作者），每 pty 会话服务端维护 grid：capture（agent 检测）、OSC 0/2 标题、重连补屏、重启 ANSI seed 恢复。herdr 用 libghostty-vt 验证了"模拟器唯一真相源"模式，wezterm-term 纯 Rust 等价且免 FFI。
- **v3 修订（2026-08-09）**：`wezterm-term` **未发布到 crates.io**（crates.io API / lib.rs 均 404，系 wezterm 工作区内部 crate），只能以 **git 依赖**引入（pin wez/wezterm 仓库 `term/` 子目录，锁 commit hash）。License 为 MIT，与本项目兼容。Phase 2 spike 第一项因此改为"**git dep 可拉取 + 编译通过**"，再验 feed + capture + 补屏。
- **否决项**：libghostty-vt（Zig 构建链）；alacritty_terminal（API 摩擦）；vt100（覆盖弱）。
- **翻盘条件**：git dep 拉取/编译不可接受、依赖树过重 → 降级 vt100（registry 备选，接受 osc_title 弱化）或 vte 自建。
- **v4 勘误（2026-08-13）**：git 依赖阻塞 **crates.io 发布**（此前 v3 只记录「git dep 可拉取」，未评估对发布流程的影响）。
  - **事实**：`cargo package` / `cargo publish` 报 `dependency 'wezterm-term' does not specify a version`——crates.io 打包要求所有依赖有 version 且能解析到 registry；git 依赖即使补 `version` 也会在用户 `cargo install` 时解析失败。`wezterm-term` 及其依赖 `wezterm-cell` 均未发布 crates.io（API 404），兄弟 crate（termwiz/vtparse/wezterm-bidi/wezterm-dynamic）已发布但版本与锁定的 git tag 20240203 不同。
  - **影响**：crates.io 渠道（`cargo install omniterm`）被阻塞；GitHub Release / npm / Docker 渠道不受影响。2026-08-13 发布 v0.2.14 时因此在 CI 全绿后中止，撤回 tag 与已发产物。
  - **替代调研**（2026-08-13 实测）：`vt100` 0.16.2（MIT）、`vte` 0.15（Alacritty 团队，Apache-2.0/MIT）在 crates.io 可用。`vt.rs`（183 行）使用面小：调用点仅 `mod.rs` 4 处（feed/title/resize/capture_visible），`scrollback.rs` 独立实现不依赖模拟器。
  - ~~**倾向方案（待定）**：`vt100` 为主 + `vte` 补 OSC 0/2 标题解析~~——v5 定案为 `alacritty_terminal`（见下）；`vt100` 降为翻盘备选。
- **v5 决策（2026-08-13）：VT 模拟器改用 `alacritty_terminal` 0.26**（crates.io，Apache-2.0/MIT），取代 v3 的 wezterm-term git 依赖路线。
  - **选型对照**（2026-08-13 于 `/tmp` 独立 spike 实测 + crates.io API 核查，非文档推断）：

    | 候选 | crates.io | 传递依赖包数 | 服务端应答（DSR/DA/颜色查询） | 结论 |
    |---|---|---|---|---|
    | `wezterm-term`（v3 现状） | ❌ crate 不存在（API 404） | 164 | 自动（不可关） | 阻塞发布，弃用 |
    | `alacritty_terminal` 0.26.0 | ✅ 活跃（2026-04） | 子树 35，本项目**净新增 7**（alacritty_terminal / vte / arrayvec / unicode-width / home / rustix-openpty / cursor-icon） | `Event::PtyWrite` 显式闭环（可门控） | **采用** |
    | `vt100` 0.16.2 | ✅（950 万下载） | 3 | 无（需自建 `unhandled_csi` 白名单） | 备选 |
    | `vt100-ctt` 0.17.1 | ✅（vt100 fork，vte 0.13 偏旧） | 4 | 无 | 备选之备选 |

  - **语义等价性实测**：对照 `vt.rs` 现有 5 条单测 + 4 项补充场景，`alacritty_terminal` 全部通过——ANSI 剥离、CR 覆写、OSC 0/2 标题、resize 保内容、跨 feed 切断的 CSI、滚屏可见窗口、alt-screen（vim/htop）切换与回落、宽字符 + UTF-8 半包切块。
  - **API 映射**：`Processor::advance(&mut term, bytes)` = feed；`Term::resize(impl Dimensions)` = resize；`grid()[Line(i)][Column(j)].c` 逐行 `trim_end` = `capture_visible`（**必须跳过 `Flags::WIDE_CHAR_SPACER | LEADING_WIDE_CHAR_SPACER`**，否则宽字符重复）；标题与应答经自实现 `EventListener`（`Event::Title` / `ResetTitle` / `PtyWrite` / `ColorRequest` / `TextAreaSizeRequest`；`send_event(&self)` 只给不可变引用 → 内部 `Mutex` 收集）；`Dimensions` 自实现三方法，不用上游标为 test helper 的 `term::test::TermSize`。
  - **配置要点**：`Config { scrolling_history: VT_SCROLLBACK_LINES, osc52: Osc52::Disabled, ..default() }`——OSC 52 剪贴板归前端 xterm.js，服务端不参与（上游默认 `OnlyCopy`，须显式关闭）；`default-features = false` 去掉 serde。
  - **P1 有界（AGENTS §6）**：`EventListener` 收集的应答缓冲必须有显式上限（建议 ≤64 条且 ≤8KB，超限丢弃 + `warn` + 单测），否则无人 drain 时无界累积。`Term` 自身 damage 状态为按屏幕行数定长的 `Vec<LineDamageBounds>`（已核 `TermDamageState`），无累积风险。
  - **顺带修的既存缺陷（双应答）**：前端 xterm.js 会把自己对 DA/DSR 的应答经 `onData` 回送后端（`frontend/src/hooks/useTerminal.ts:235-256`），而服务端 VT 也应答一次 → **有客户端连接时应用收到两份应答**（多余字节可能落进 shell 输入）。迁移时将服务端应答**门控在「无客户端订阅」**：复用 `out.tx.receiver_count() == 0`（`list_sessions` 已以此作 attached 判据，不新增实体）。attach 时浏览器唯一应答，detach 时服务端应答——这是选 `alacritty_terminal` 而非更轻的 `vt100` 的唯一理由（detach 期间保持应答闭环）。
  - **已知细微差异**：进入 alt-screen 时 alacritty 保留当前光标行（`\x1b[?1049h` 后 capture 首行为空），wezterm/vt100 归位首行。xterm 语义上 alacritty 更正确，对 agent 屏幕检测（整屏文本匹配）无影响。
  - **否决项**：vendoring wezterm-term 源码（需连带未发布的 `wezterm-cell` 等兄弟 crate + termwiz 版本错配，git checkout 740MB）；「放弃 crates.io 渠道」（release-guide Step 8 与验证表将其列为正式渠道）。
  - **v4「vt100 为主 + vte 补标题」判断勘误**：`vt100` 自带标题回调（`callbacks.rs:23 set_window_title`、`perform.rs:201-208` 处理 OSC 0/1/2），不需第二个解析器。
  - **翻盘条件**：`alacritty_terminal` 的 `capture_visible` 在真实 agent 屏幕（Claude Code / Codex TUI）上与 tmux `capture-pane` 明显不一致，或新增依赖面被判过重 → 降级 `vt100`（依赖 3 个，代价是自建 DSR/DA 白名单应答、且 detach 期无应答）。

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
- **完成记录（2026-08-12）**：三切片独立提交、独立验收：
  - **切片 A**：`PtyEngine` 实现 `SessionEngine`，会话 map 常驻持有 pty 进程；WS 断开只解绑订阅；attach 同锁「先快照后订阅」保证补屏与增量不重不漏；子进程退出自动注销、下次 attach 重建；三级信号清理 + child 收割（`mem::forget` 已移除）。引擎级验收（断开→重连存活可输入）+ 真实 WS 冒烟通过；fd 计数/spawn cwd OS 真相回归测试就位。
  - **切片 B**：spike 结论——wezterm-term 以 git 依赖锁 tag `20240203-110809-5046fc22` 可拉取、全树编译通过（D8 翻盘条件不触发）；`vt.rs` 提供 feed/capture/title/resize，capture 走 VT grid 消除 ANSI 碎片；重连 resize nudge 落地（`reconnected` 标志）。**执行偏差**：补屏未采用「模拟器重渲染整帧」，沿用补屏环原始 ANSI 回放——前端 xterm.js 消费原始 ANSI 流，字节回放保真度更高；herdr 的帧重渲染适配其帧 diff 协议，对 ANSI 流客户端无增益（记录在 `vt.rs` 头注）。
  - **切片 C**：`scrollback.rs`（分文件/0600/tmp+rename/UTF-8 截断）+ 5s 去抖 flush（快照对象为 256KB 有界环，避 P2 O(n²)）+ 30s cwd 采样回写 `last_cwd`（migration 仅此一列）+ 重建 ANSI seed。端到端验收：真实重启后端 → 会话重建于最后 cwd、重连补屏见重启前输出。显式 kill 删除历史文件（无需重建）。
  - §B.2 穷举：`runtime_kind_matrix` 6/6 通过（含 pty files/删除 case），无 `?`。

### Phase 2.5（已完成 2026-08-13）：VT 模拟器换 registry 依赖——解锁 crates.io（D8 v5）
> 触发：2026-08-13 发布 0.2.14 时 `cargo package` 报「dependency 'wezterm-term' does not specify a version」而中止（tag 已撤回）。
- **`Cargo.toml`**：删 `wezterm-term` git 依赖与 tag 注释，改为 `alacritty_terminal = { version = "0.26", default-features = false }`。
- **`src/engine/pty/vt.rs`**（183 行；对外四件套 `feed` / `title` / `resize` / `capture_visible` 签名不变，调用方零感知）：`Term<Sink>` + `Processor`；自实现 `Dimensions` 与 `EventListener`；应答缓冲有界（D8 v5 P1）；删 `ResponseWriter`，改为「feed 后 drain 应答 → `PtySession::write`」，避免在监听器内回写造成锁嵌套。
- **`src/engine/pty/mod.rs`**：应答门控（`out.tx.receiver_count() == 0` 时才回写，修双应答）；文件头注与 L258 构造调用点措辞。
- **测试**：原 5 条单测保留（构造不再需 spawn `sleep` 提供 fd）+ 新增四条——alt-screen 切换、宽字符不重复、应答缓冲超限丢弃、attach 状态不应答。
- **文档**：`docs/architecture/backend.md`（`vt.rs` 描述 + capture 差异表 + 应答归属）、`docs/reference/herdr-reference.md`（模拟器选型措辞）、`CHANGELOG.md`（Changed：VT 模拟器换 registry 依赖，恢复 crates.io 渠道）。
- **验收**：`cargo package --no-verify --allow-dirty` 通过；`cargo test` / clippy / fmt 全绿；pty 会话人工回归（vim/htop 重连不花屏、agent 屏幕检测、OSC 标题、detach 期间 `printf '\e[6n'` 有应答且 attach 时不双应答）。
- **完成记录（2026-08-13）**：按上述清单落地——`cargo package` 通过（129 文件 / 3.6MiB，全仓无 git/path 依赖）、`cargo test` 248 通过 / clippy / fmt 全绿；vt.rs 11 条单测（原 5 + alt-screen / 宽字符 / DSR drain / 超限丢弃×3）+ mod.rs 门控测试 1 条。依赖净增与 D8 v5 预测一致（alacritty_terminal/vte/arrayvec/unicode-width/home/rustix-openpty/cursor-icon）。**执行偏差**：「detach 期 DSR 应答回显进补屏环」的 e2e 测试废弃——实测 pty 行纪律回显会吞转义字节（`\x1b[1;1R` 只回显尾部 `R`），补屏环观察不到 CPR 应答，该路径改由人工回归覆盖；门控行为由 `dsr_response_gated_by_attach_state` 确定性验证。另发现两个实测点入档：① `Term::new` 收 `&impl Dimensions` 而 `resize` 收值；② `Row` 无 `iter()`，逐行 capture 走 `[Column(0)..Column(cols)]` 切片索引。

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
- **VT 应答归属（D8 v5）**：pty 会话的 DSR/DA 应答有两个可能主体（浏览器 xterm.js / 服务端 VT），约定为**按是否有客户端订阅二选一**，不得两边同时应答；tmux 会话无此概念（tmux server 自己应答）。

## 5. 验收标准
- **Phase 1（解耦）** ✅ 2026-08-09：
  - [x] 现有 tmux 会话全功能回归（创建/输入/复制/agent 检测/external 收养）零变化（187 测试 + clippy/fmt 全绿；纯重构无行为变化）。
  - [x] `rg tmux src/ -g '!src/engine/tmux/*'` 仅剩 DB 枚举值与注册行（口径细化见 Phase 1 完成记录）。
  - [x] 模拟摘除演练：删 `src/engine/tmux/` + 打桩注册行后 `cargo build` 通过，其余模块零改动（未提交）。
- **Phase 2-4（pty 引擎）**：
  - [x] pty 会话：创建/输入/输出/resize/kill 全链路无 tmux 进程参与（Phase 2 ✅）。
  - [x] `tests/runtime_kind_matrix.rs` 含 pty 全路径 case（创建/files/清理），integration-checklist §B.2 表无 `?`（Phase 2 ✅，6/6 通过）。
  - [x] WS 断开→重连：进程存活、补屏 + nudge 正确（Phase 2 ✅：引擎级测试 + 真实 WS 冒烟；vim/htop TUI 用例待 Phase 4 前端分流后人工回归）。
  - [x] 后端重启：pty 会话从 `last_cwd` + 原命令重建，scrollback 回放可见（Phase 2 ✅ 端到端验收；tmux 会话照常幸存不受影响）。
  - [ ] agent 检测：pty 会话 hook 经 HTTP 上报（HookAuthority 生效）、屏幕检测行为与 tmux 链路一致。（Phase 3；屏幕检测输入侧 Phase 2 已就位）
  - [ ] pty 会话复制：纯左键拖选即复制；移动端滚动本地化。tmux 会话交互不变。（Phase 4 前端分流）
  - [x] FileManager 根目录在两种会话下均跟随终端 cwd（Phase 2 ✅：pty 走 /proc 采样，实测 `cd` 后跟随）。
- **Phase 2.5（registry VT 依赖）**：
  - [x] `cargo package --no-verify --allow-dirty` 通过（全仓无 git/path 依赖）。
  - [x] `vt.rs` 原 5 条单测 + 新增 4 条（alt-screen / 宽字符 / 应答缓冲超限 / attach 不应答）全部通过（2026-08-13；vt.rs 共 11 条 + mod.rs 门控测试）。
  - [ ] pty 会话人工回归：agent 屏幕检测与迁移前一致、OSC 标题正常、detach 期间 DSR 有应答。
- **通用**：
  - [ ] migration 幂等；`cargo build` / clippy / fmt / `tsc` 零新增错误；新增单测通过。
  - [ ] 模拟摘除演练：本地删 `src/engine/tmux/` + 注册行，`cargo build` 通过（解耦达标证明，不提交）。

## 6. 风险与文档闭环
| 风险 | 缓解 |
|---|---|
| Phase 1 重构面大（一次触碰全部调用方） | trait 签名先按 TmuxEngine 现有行为 1:1 定义，不夹带行为变化；回归清单先行 |
| 双引擎并存状态不一致 | §4 差异表 + D12 分流；agent 状态统一经 `agent_snapshot` 读口 |
| ~~wezterm-term 仅 git 依赖可得（v3 新发现）~~ → **已发生：git 依赖阻塞 crates.io 发布**（0.2.14 中止） | 已结案：D8 v5 改用 registry 依赖 `alacritty_terminal`，Phase 2.5 执行；今后**新增依赖必须来自 crates.io**，`cargo package --no-verify` 入发布前检查单（release-guide） |
| 存量 pty 脚手架与计划冲突（v3 新发现） | §1.4 定性临时件；Phase 1 收敛、Phase 2 切片 A 替换；禁止在脚手架上加功能 |
| 补屏 ANSI 与 xterm.js 显示偏差 | 验收含 TUI 程序重连用例 + resize nudge |
| scrollback 落盘 IO 放大 | 异步批量写 + 截尾；压测 `yes` |
| 冻结纪律流失（有人继续给 tmux 加功能） | AGENTS.md 文档索引加冻结说明；PR 审查以 D9 为据 |

**实施后更新**：`docs/architecture/backend.md`（引擎抽象 + 差异表）、`docs/architecture/frontend.md`（D12 分流）、`docs/workflows/agent-edit-manual.md`、AGENTS.md（tmux 冻结说明）、`CHANGELOG.md`、`PROGRESS.md`、`docs/reference/user-testing.md`（双引擎用例）；`docs/reference/herdr-reference.md` 已增补；Phase 5 执行时本文件与方向规划移入 `archive/`。
