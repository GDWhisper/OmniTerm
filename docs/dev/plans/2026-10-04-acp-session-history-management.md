# ACP 会话历史管理：session/list 发现 · 外部会话载入 · session/delete 清理

> 状态：**Phase 0 + Phase 3（后端 delete）+ Phase 4（前端删除确认勾选）已实施**（2026-10-06）；Phase 1（list）/ Phase 2（adopt）/ E1 面板 **未实施**；E3-2 的**后端端点已落地**（2026-10-09，两段式第二段复用，面板 UI 仍待 E1）；2026-10-09 三条勘误（§5.2）：E-7/E-8/E-9 无活连接由后端临时拉起补删（推翻 E-2 的「已释放 → 禁用」）、E-10 删除不阻塞界面（右下角 toast 上报）、E-11 拆两段式（`pending` + agent 侧删除端点，E-7 的「请求内拉起」被取代）
> 触发条件：补足 omniterm 侧对「agent 侧 ACP 会话历史」的发现 / 读取 / 删除能力（2026-10-04 盘点结论：ACP 11 个 session 命令 omniterm 只用 5 个，`session/list` / `session/delete` 零引用）
> 关联：`docs/reference/acp-protocol-reference.md`（§17.3 实探结论）、`docs/dev/plans/archive/2026-09-10-sidebar-session-context-menu.md`（菜单 / 批量确认范式）、`docs/architecture/frontend-patterns.md`（sidebar 弹出面板约定）、`docs/dev/plans/archive/2026-10-01-acp-sdk-v2-upgrade.md`（SDK 2.2 + V1 握手背景）

## 0. Phase 0 实探结论（2026-10-06，已完成）

用最小 JSON-RPC 探针直连各 agent 的 `initialize` / `session/list` / `session/delete`：

| agent | `sessionCapabilities` | `session/delete` 行为 |
|-------|----------------------|----------------------|
| opencode 2.0.24 | `list`+`delete`+`fork`+`resume`+`close`+`additionalDirectories` | ✅ 0.1s 回 `{}`，删后 list 中消失，重复删仍 `{}` |
| pi-acp 0.0.34 | `list`+`delete` | ✅ 1.2s 回 `{}`；⚠️ 新建会话不出现在 `session/list`（无法用它验证删除） |
| omp 18.7.0 | `list`+`fork`+`resume`+`close`（无 delete） | 未调用 |
| codebuddy（默认 agent） | **无 `sessionCapabilities`** | 未调用；`session/list` 回 `-32601` |

**对 §5 Phase 0 结论的回答**：能力位确实存在且 `session/delete` 真实可用（opencode /
pi-acp），但**用户的主力 agent codebuddy 未声明** → 勾选框对其恒禁用、删除请求跳过。
按本文档 §7 预案执行：删除弹窗文案指向手动清理路径，不隐藏功能本身
（换 opencode/pi-acp 时立刻可用）。Q2 对 codebuddy 未闭环，属 agent 侧能力缺失，
非 omniterm 可实现范围内的问题。

## 1. 背景与问题清单

现状取证（2026-10-04，源码 + crate schema 双查证）：

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| Q1 | agent 侧历史**读不到**：只能重放 omniterm 亲手创建的会话；外部会话（用户裸 CLI 跑的、别的机器拷来的 `acp_session_id`）既不能枚举也不能载入 | `acp_session_id` 唯一来源是 `create_session` 里 `session/new` 的响应（`src/api/sessions.rs:180`），无任何入口传入既有 id | P0（**未闭环**） |
| Q2 | agent 侧历史**删不掉**：omniterm 删除会话只杀进程 + 删自己库（`chat_messages` 级联），agent 侧文件（codebuddy：`~/.codebuddy/projects/<项目>/<acp_session_id>.jsonl`，见 `acp-protocol-reference.md:618`）永久残留 | `cleanup_session_runtime` acp 分支只 `dispose + shutdown`（`src/api/sessions.rs:427`）；`AcpClient::shutdown()` 不发任何 ACP 方法（`src/acp/client.rs:1349`）；全仓 `DeleteSessionRequest` 零引用 | P0 → **已闭环（声明能力的 agent）** |
| Q3 | 无发现入口 | `session/list` 零引用 | P0（**未闭环**，Q1 的前置） |

**根因**：三个协议命令（`session/list` / `session/delete` / 「绑定既有 id 的会话创建」）从未接入。协议侧已就绪：rust-sdk 2.2.0 的 **v1 schema 即含** `ListSessionsRequest/Response`（`SessionInfo{session_id, cwd, title?, updated_at?}` + `next_cursor` 分页）与 `DeleteSessionRequest`（schema-1.9.1 `v1/agent.rs:1549/1675`），omniterm 的 `ProtocolVersion::V1` 握手（`src/acp/client.rs:713`）可直接调用；删除能力位在 v1 `AgentCapabilities.session_capabilities.delete`（marker 空结构，存在即支持）。

## 2. 入口方案：用户如何触发（核心）

三个用户动作，全部挂在既有 UI 范式内，不新造界面骨架：

### E1 · 发现 agent 侧会话 — Sidebar 底部按钮「Agent 历史」弹出面板

- **触发**：Sidebar 底部状态栏新增按钮（与 tmux 速查同级），点开弹出面板（照 `TmuxCheatsheetPopup` / `useAnchorPopup` 骨架 + `.panel-title-bar` + `<OverlayScroll>` 填满型，约定见 `frontend-patterns.md`「sidebar 弹出面板」）。
- **面板内容**：顶部 AgentPicker（默认当前项目最近使用的 agent，复用 `CreateSessionModal` 的同款 picker 与 `lastAcpAgentId` 记忆）+ 刷新按钮；列表行：`title ?? session_id 截断`、`updated_at`、`cwd`（标注是否属于当前项目）、徽标「已纳管」（对照 appStore sessions 的 `acp_session_id`）。
- **数据获取时机**：展开面板时拉一次 + 手动刷新；**不轮询**。
- **原因**：`session/list` 需要活连接 → 每次拉取后端现起一个短命 agent 进程（复用 `test_agent` 的 `spawn_and_connect` + 15s timeout + `shutdown` 模式，`src/api/agents.rs`），spawn 成本以秒计，轮询等于定时起进程；「发现」是低频主动动作，手动刷新满足。
- **后端**：`GET /api/v1/agents/{id}/acp-sessions?cwd=<绝对路径>` → spawn ephemeral client → cursor 翻页（上限见 D2）→ shutdown → `{ sessions: [...], truncated: bool }`。

### E2 · 载入外部会话读历史 — 面板行内「载入」

- **触发**：E1 面板中「未纳管」行点击「载入」→ 弹一次 `ConfirmDialog`（告知将在当前项目下创建会话并重放该 agent 会话的全部历史）→ 确认。
- **链路**：`POST /projects/{pid}/sessions` 带新可选字段 `acp_session_id`（`runtime_kind=acp`、`agent_id` 原样必填）→ 后端**跳过 spawn 与 `session/new`**，只写库行绑定该 id（`name` 缺省用面板行 `title`）→ 前端 `activateSession` → ChatView 挂载连 WS → 后端发现 supervisor 无 client → released 态 → 用户点「恢复会话」（或首个 prompt 自动恢复）→ 既有 `restore_acp_session` → `spawn_and_load` → `session/load` 重放 → `replay_start/replay_end` → 前端 sync 落库（`src/ws/acp.rs:793-870` 全链路已存在）。
- **原因**：读历史的重放 machinery 已完整且经过多轮加固（ghost 行 / 对齐写回 / 门控），本方案对它**零改动**；create 时直接 load 不可行——HTTP create 没有 WS 订阅者，重放帧无人接收（ws restore 的重放转发任务必须在 WS handler 内起）。
- **已纳管行**：点击 = `activateSession` 切过去（与侧栏行行为一致）。

### E3 · 删除 agent 侧记录 — 删除确认弹窗勾选 + 面板行内删除

两条触发，同一后端原语：

1. **删会话时顺带删**：`DeleteConfirmDialog` / `BatchSessionDialog`（批量删除）确认框内，对 ACP 目标新增checkbox「同时删除 agent 上的会话记录」。三态：
   - 已知支持（该会话 WS 连接过、`capabilities` 帧带回 `agent_delete:true`）→ 可勾选，**默认勾选**；
   - 已知不支持 / 未知（本浏览器未连过该会话 WS、后端重启后未连）→ 禁用 + 不勾选 + 说明文案「该 agent 未确认支持删除，agent 侧记录需手动清理」。
   - 能力来源：`initialize` 响应 `agent_capabilities.session_capabilities.delete`（`src/acp/client.rs` 新增 `supports_delete_session()`）→ 扩展 `capabilities` 帧（`src/ws/acp.rs:232`，连接建立与 restore 两条路径均已发该帧）→ 前端 chatStore 按会话存（照 `setImageSupported` 先例）。
   - **原因**：「删会话」在用户心智里=痕迹消失；但 agent 侧删除不可逆且能力未必有，「未知→不删」是安全默认（宁可漏删，不可谎报已删）。不做 agents 表能力列——staleness（agent 配置可改、版本可升）会让 UI 撒谎。
   - 请求形态：`DELETE /api/v1/sessions/{id}?delete_agent_side=true`。后端在 acp 清理分支：dispose 得 client 后（**连接还活着才能发 RPC**），若勾选且 `supports_delete_session()` → `session/delete` best-effort（失败 WARN、不阻断删除、响应体报 `agent_side:"skipped"`）→ 随后 `shutdown`。
2. **面板内直接清理未纳管历史**：E1 面板行 hover「删除」→ ConfirmDialog → `DELETE /api/v1/agents/{id}/acp-sessions/{acp_session_id}` → 后端同 E1 的 ephemeral spawn + 现场 gate（该 spawn 的 initialize 响应说了算）+ `session/delete` + shutdown → 面板刷新该行消失。
   - **原因**：没被 omniterm 纳管过的会话没有「删会话」流程可挂，这是唯一入口；能力 gate 用现场 probe 的结果（真实 RPC 前的唯一权威），比任何缓存都诚实。
   - agent 未声明 delete 能力 → 409 + 文案提示手动清理路径（`~/.codebuddy/projects/...`）。

### 不做 / 缓做（含理由）

- **`session/fork`（P1 缓做）**：从 agent 历史分叉新会话。落地形态=E2 的载入链路 + fork RPC（fork 出的新 id 再走 `acp_session_id` 绑定），E2 落地后它是面板行上一个动作 + 一个方法调用。先不做的原因：消费链路（载入）不存在时它是悬空按钮；且无真实需求反馈（AGENTS §7 奥卡姆）。
- **`session/close`（不做）**：omniterm 删除=销毁进程与库行，close 的多余 RPC 不改变结果；close ≠ delete，删不掉 agent 侧记录（对 Q2 无贡献）。
- **`session/resume`（不做）**：omniterm 已用 `session/load`（v1 同一能力位 `load_session` 覆盖），两方法在本场景等价，选已有实现。
- **不落库存列表**：list 结果纯拉取（§P1 无界红线 + 不引入 migration）。翻盘条件：出现「离线也要能看到 agent 历史目录」诉求。
- **project 级联删除不代发 agent 侧 delete**：`delete_project` 删全项目会话属于可能误删的大动作，不替用户做不可逆决定；agent 侧历史保留。翻盘条件：用户明确要求项目删除=彻底抹除。

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| D1 | 载入 = 建库行绑定既有 `acp_session_id`，重放完全复用既有 restore 链路 | E2 已证；重放加固全部保留 | create 时 spawn_and_load 直读（重放帧无订阅者，必丢） | create 后首连前用户就要看到重放内容且自动恢复不触发 |
| D2 | list 用短命进程现拉，**显式上限**：`ACP_LIST_MAX_SESSIONS=200`、`ACP_LIST_MAX_PAGES=10`，超限截断 + 响应 `truncated:true` + UI 提示 | spawn 贵 + §P1「一切 collect 必须显式上限 + 超限策略 + 单测」 | 后台轮询 + DB 缓存（成本、staleness、无界三重问题） | 用户反馈「看不到全部」→ 加分页 UI；出现轮询诉求 → 重评缓存 |
| D3 | delete 能力 gate = 现场 probe（删除弹窗走 `capabilities` 帧；面板内清理走 ephemeral spawn 的 initialize），不落库、不盲发 | v1 能力位是 marker 结构，probe 是唯一权威；§8 显式回退 | agents 表加 caps 列（陈旧）；无条件盲发（method-not-found 与真失败混） | 批量删除大量会话进程已释放且用户要求代删 → 补「后端代发」端点 |
| D4 | list 的 `cwd` 过滤口径 = 当前 active project 主 worktree 路径，面板标题注明 agent + 项目 | agent 侧历史按 cwd 组织（codebuddy `~/.codebuddy/projects/<项目>`）；一 project 多 worktree 全传会列表翻倍 | 不过滤传全部（列表噪音、跨项目串扰） | 多 worktree 实测需求 → 加 worktree 下拉 |
| D5 | HTTP 形态：`GET/DELETE /api/v1/agents/{id}/acp-sessions[/{acp_session_id}]` + `DELETE /sessions/{id}?delete_agent_side=true` | REST 资源语义清晰；DELETE 不带 body（query param） | DELETE 带 JSON body（curl/代理不友好） | — |
| D6 | capabilities 帧加 `agent_delete: bool`（连接建立 / restore 两条路径都发） | 前端拿到「这个会话的 agent 到底支不支持删」的唯一实时真源 | 前端猜测 / 一律显示勾选项 | — |
| D7 | 前端入口唯一：Sidebar 底部按钮弹面板（E1）+ 删除确认勾选（E3），CreateSessionModal 不加「载入」分支 | 弹面板是列表 + picker + 刷新的自然载体（Settings/TmuxCheatsheet 先例）；create 弹窗保持单一职责 | create 弹窗内嵌 agent 历史列表（弹窗套列表，移动端灾难） | 用户反馈找不到面板入口 → 在 CreateSessionModal 加指引链接 |

## 4. 多实现差异（AGENTS §8）

| 差异点 | 处理 |
|--------|------|
| `sessionCapabilities.delete` 是 **marker 空结构**，presence = 支持；未声明 = 不支持 | 三态 UI（E3）；后端 `supports_delete_session()` 单一判据 |
| `session/list` 在 v1 schema 已定义（方法串存在），但协议文档将其列为声明了 `session` 能力的 agent 的**必须方法**（`acp-protocol-reference.md:1597`）；未声明 `session` 能力的 agent（`session` capability 缺省 = 不支持整个 session/* 面）可能连 `session/new` 都不认 | list 端点 RPC 失败（method not found / spawn 失败）→ 502 + 前端 toast，不做特殊降级（既然能建 ACP 会话，`session/new` 必然可用） |
| `session/list` 的 `cwd` 过滤语义按实现（可能忽略 cwd 返回全部；title/updated_at 可能缺省） | 面板行**始终显示 `cwd` 与原始 `session_id`**，让用户自行分辨，不替 agent 猜 |
| `session/delete` 是软删还是硬删由实现决定（doc:1579） | UI 文案用「从 agent 会话列表移除」，不承诺「文件已删除」；`agent_side:"deleted"` 仅表示 RPC 成功 |
| 删除不存在的 session SHOULD 静默成功（doc:1578） | best-effort 语义天然兼容；重复删同一 id 不报错 |

## 5. 实施分期

### Phase 0 — 实探（前置，0.5h）
用 `POST /agents/test-raw`（或临时脚本，走 `AcpClient::spawn_and_connect` 同款 spawn）取手头 agent 的 initialize 响应，确认：① `sessionCapabilities.delete` 是否存在；② `session/list` 是否应答、cwd 过滤与 title 填充行为。
**若不声明 delete**：D3 的删除入口对默认 agent 恒禁用——先向用户出示结论再动工（功能退化为「只读发现 + 载入」仍有价值，但 Q2 未闭环）。

### Phase 1 — 后端 list（~1.5h）
- `src/acp/client.rs`：`list_sessions(cwd, cursor) -> (Vec<SessionInfo>, Option<String>)`；init 处读 `session_capabilities.delete` → `supports_delete_session()`；常量 `ACP_LIST_MAX_SESSIONS`/`ACP_LIST_MAX_PAGES` + 翻页循环 + 单测（fake agent 双页 + 超限截断）。
- `src/api/agents.rs`：两条路由 + handler（spawn 15s timeout、失败 502/409、结束必 shutdown）。
- `fake_agent_tests.rs` / `test_support.rs`：fake agent 增补 `session/list` 应答（双页 + 缺省 title）。

### Phase 2 — 后端 adopt（~1h）
- `src/models/session.rs`：`CreateSession` 加 `acp_session_id: Option<String>`。
- `src/api/sessions.rs`：acp 分支——带 `acp_session_id` 时校验 agent 存在 + 非空，跳过 spawn/`session/new`，直接 INSERT；单测（无 spawn、行落库、name 缺省）。

### Phase 3 — 后端 delete（~2h）
- `src/acp/client.rs`：`delete_session(acp_session_id)` + `supports_delete_session` 字段贯穿（init → conn_tx → struct → accessor）。
- `src/ws/acp.rs`：`Capabilities` 帧加 `agent_delete`，两条发送路径（:862 restore / :1049 supervisor hit）。
- `src/api/sessions.rs`：delete_session 的 SELECT 扩字段取 `acp_session_id`；`cleanup_session_runtime` acp 分支收 `delete_agent_side` 参数 → dispose 后 RPC best-effort → shutdown；响应体 `agent_side:"deleted"|"skipped"|"not_requested"`；单测（flag 语义 + 无 client 时跳过）。

### Phase 4 — 前端（~3h）
- `api/client.ts`：`listAgentAcpSessions` / `deleteAgentAcpSession` / `createSession` 第 7 参 / `deleteSession(id, {deleteAgentSide})`。
- 新 `Sidebar/AgentHistorySection.tsx` + `AgentHistoryPopup.tsx` + `appStore` `agentHistoryOpen`（复制清单照 `frontend-patterns.md` sidebar-popup）+ `Layout.tsx` 按钮（Desktop/Mobile）+ i18n 两份。
- `DeleteConfirmDialog.tsx` / `BatchSessionDialog.tsx`：勾选三态（E3）+ chatStore `setAgentDeleteSupported` + `useAcpChat` capabilities 消费。
- `Sidebar.test.tsx` 同目录补：区块渲染 / 载入调 api / 勾选禁用三态。

### Phase 5 — 验证 + 文档（~1.5h）
- 真实链路：dev 后端 + 真实 agent 走 E1→E2→重放→E3 删除→ 面板行消失 → agent 侧文件/列表确认。
- `pnpm lint` / `pnpm exec tsc -b` / `pnpm test` / `cargo clippy -D warnings` / `cargo test` 零新增。
- 文档闭环见 §7。

## 5.1 实施记录（2026-10-06，Phase 0 + Phase 3 + Phase 4 的删除勾选部分）

用户指令：「acp 协议，删除 agent 侧记录，接入，点击 acp 会话删除时，在二次确认弹窗中加入
红字勾选框：同时永久删除 agent 侧会话记录，前端记忆用户选择」。据此只做 E3-1 全链路
（后端 delete + 单条/批量删除确认勾选），E1 面板 / E2 载入 / E3-2 面板内 purge 不做。

**与原设计的偏差（就地勘误）**：

| # | 原设计 | 实施 | 原因 |
|---|--------|------|------|
| E-1 | 勾选框默认**勾选**（能力已知支持时） | 勾选框默认取**用户上次的选择**，首次（无记录）为**不勾选** | 用户明确要求「前端记忆用户选择」；且这是不可逆的附加删除，首次默认替用户做决定不合适。记忆写入时机 = 确认删除成功之后（中途关闭不算表达偏好） |
| E-2 | 三态仅按能力（已知支持 / 已知不支持 / 未知） | 增加第 4 个禁用原因：**agent 进程已释放**（`acp_session_alive === false`）—— 没有活连接就发不出 RPC，勾了也必然 `skipped` | 实测：删一个已释放会话时勾选框若可勾选，用户会得到「勾了但没删」的静默失败；禁用 + 「请先恢复会话」才是如实交代。判据优先级：不支持 > 已释放 > 未知（前者恢复进程也救不回来，后两者动作都是「先把进程跑起来」） |
| E-3 | 勾选框内联在 `DeleteConfirmDialog` | 抽 `Sidebar/agentSideDelete.ts` 共享判据 + `ConfirmDialog` 支持 `checkbox: {label, defaultChecked, danger, disabled, hint}` | 单条与批量删除是同一判据的两个入口，内联两份必然漂移（工程准则 6）；`checkboxLabel: string` 升级为结构化 prop，两个既有调用点（FileManager / FileDrawer）一并迁移 |
| E-4 | 能力位经 `capabilities` 帧下发即可（D6） | 同设计，另在前端按「未知 = 不可勾选」处理（不再是「禁用 + 不勾选」的软表述，而是判据里的一等分支） | 后端对未知能力不盲发（`method not found` 与真失败无法区分），UI 若可勾选就是谎报「已删」 |
| E-5 | `cleanup_session_runtime` 收 `delete_agent_side: bool` 参数 | 收 `AgentSideDelete { requested, acp_session_id }` + 返回 `AgentSide` 枚举 | 位置 bool 参数在 4 个调用点靠顺序对齐；返回枚举让「跳过原因」可进响应与日志，且纯函数 `plan_agent_side_delete` 可单测（不依赖活连接） |
| E-6 | `conn_tx` 传 6 元位置元组 | 改具名 `Handshake` 结构 | 新增能力位就要再加一个 `bool`，位置元组改错顺序编译器不报错 |

**验收结果**（真实链路，dev 实例）：
- opencode 会话：`DELETE …?delete_agent_side=true` → `{"ok":true,"agent_side":"deleted"}`；
  `session/list` 复核该 id 已消失（agent 侧真实删除）✅
- 未勾选（无 query）→ `agent_side:"not_requested"` ✅
- 进程已释放（先 `POST /release`）→ `agent_side:"skipped"` ✅
- codebuddy（未声明能力）→ `agent_side:"skipped"` + 后端 INFO 留痕 ✅
- UI：红字勾选框（`--danger`）渲染、勾选后删除、`localStorage.omniterm_delete_agent_side`
  记 `true`、**刷新页面后重开弹窗仍默认勾选**、已释放进程的会话勾选框禁用并给出原因 ✅

**未闭环项（留给后续 Phase）**：Q1（`session/list` 发现）、Q3（面板入口）、E3-2（面板内
purge 未纳管历史）、以及 codebuddy 的 Q2（agent 侧未声明能力，omniterm 无法代劳）。

## 5.2 实施记录（2026-10-09）：删除链路补「临时拉起 agent」兜底

用户指令：「sidebar 删除 agent 侧 acp 会话这个功能，应该帮用户拉起会话删除，而不是给个
提示让用户自己操作」。据此推翻 §5.1 的偏差 E-2：勾选即承诺，进程不在（reaper 回收 /
手动 release / 后端重启 / 连接已死）由后端**临时拉起一个短命 agent 进程**补发
`session/delete`，不再把动作退回给用户。

**勘误（就地记录，覆盖 §5.1 的 E-2/E-3/E-4 相关表述）**：

| # | 原实施（2026-10-06） | 本次（2026-10-09） | 原因 |
|---|----------------------|--------------------|------|
| E-7 | 无活连接 → 跳过并让前端提示「请先恢复会话」；能力未知 → 禁用 | `cleanup_session_runtime` acp 分支：无活连接（含连接已死）且 requested 时走 `delete_agent_side_record_via_ephemeral_spawn`——`load_agent` + `spawn_and_connect`（不注册 supervisor；spawn / RPC 各 15s `EPHEMERAL_AGENT_TIMEOUT`）现场 gate 能力位后补发，随后 `disconnect` 收尾；窗口内失败（配置 / 目录缺失、spawn 失败或超时、能力未声明、RPC 失败）一律 best-effort `skipped` + 留痕 | 勾选是对删除结果的承诺；`session/delete` 按 id 生效、不要求是创建该会话的那个进程（opencode / pi-acp 实测）。ephemeral 形态本就是 E3-2 设计的原语，此前只规划给面板内 purge 用 |
| E-8 | 前端三态：未知 / 不支持 / 已释放 → 一律禁用 + 原因 | 判据收敛为唯一一条：**agent 已知不支持**（`agentDeleteSupported === false`）才禁用；未知与已释放可勾选（后端现场探明）；`AgentSideCandidate` 去掉 `acp_process_alive`，i18n 删除 `deleteAgentSideHintUnknown` / `deleteAgentSideHintReleased` | 前端能力位只用于提前知情，不再承担「决定能不能做」的职责；进程状态与「拉起的 agent 支不支持」都由后端在删除时现场判定 |
| E-9 | 活连接路径只看 `dispose` 是否拿到 client | 拿到 client 后加 `is_alive()` 判断：连接已死（agent 崩溃 / poll 卡死）时先收尸再落回临时拉起 | 「注册表里有个死句柄」不该成为 skipped 的理由——与 E-7 同一原则 |
| E-10 | 会话删除（单条 / 批量）在模态内 `await` 请求：agent 侧临时拉起期间弹窗转圈、界面被扣住 | 确认后**立即关弹窗**，请求转后台执行；结果（会话已删 / agent 侧 `deleted` / `skipped`）完成后由右下角 toast 如实上报；列表由完成刷新 + 侧栏 3s 轮询收走。批量同时移除 `submitting` 阻断与「执行中不可关闭」守卫（弹窗已立即关闭，守卫无对象） | 用户指令（2026-10-09）：「删除 agent 侧聊天过程中不要卡用户的前端界面，右下角如实上报即可」——agent 侧删除秒级起步，把等待成本转嫁给用户没有任何收益；`archiveSessionNow` 已有「先关弹窗、后报结果」先例 |
| E-11 | E-7 的「无活连接就在删会话请求内临时拉起」：响应最长等 30s（15s spawn + 15s RPC），「已删除」也被拖住 | 拆**两段式**：第一段 `DELETE /sessions/{id}` 不再 spawn，立即返回 `agent_side:"pending"`；前端随即带会话行上下文补发**第二段端点** `DELETE /agents/{id}/acp-sessions/{acp_session_id}?cwd=`（E3-2 原语提前落地）临时拉起补删，结果补报；失败/缺上下文降级 `skipped`。`agent_side` 协议值增 `pending`；`cleanup_session_runtime` / `AgentSideDelete` 回到「只认 `acp_session_id`」 | 用户指令（2026-10-09）「做便宜的」= 评估里的方案 C：无服务端状态（不做 job 表 / 轮询 / 全局推送通道）。实测 opencode：第一段 4ms `pending`、第二段 0.84s `deleted`（对比 E-7 末期单请求 1.08s 且「已删」toast 被拖到末尾）；翻盘条件：出现「关标签页也要完成 agent 侧删除」的强诉求 → 回到服务端后台任务方案（需结果通道） |

**验收（fake agent 真链路 + 单测）**：
- `api::sessions::ephemeral_agent_delete_tests` 三条全绿：拉起 → `session/delete`
  （事件日志 `delete sess-ephemeral`）→ `Deleted` 且不注册 supervisor；能力缺失
  （`live` 模式）→ `Skipped` 且无 delete 事件（不盲发）；缺 agent 配置 / 工作目录 →
  `Skipped` 且不 spawn ✅
- 前端 `agentSideDelete.test.ts` / `DeleteConfirmDialog.test.tsx` 更新后全绿 ✅；
  新增「确认后立即 `onClose`、请求在途时无结果 toast、完成后如实上报」用例
  （勘误 E-10 的不阻塞契约）✅
- 两段式真实链路（dev 实例，2026-10-09）：opencode 会话 release 后
  `DELETE /sessions/{id}?delete_agent_side=true` → **4ms** 返回
  `{"agent_side":"pending"}`；随后
  `DELETE /agents/preset-opencode/acp-sessions/{sid}?cwd=<ws>` → **0.84s** 返回
  `{"agent_side":"deleted"}`；opencode `session_v2` 行消失、omniterm 行照删 ✅
  （对照：E-7 末期单请求口径同一会话 1.08s 且「已删」被拖到末尾）
- 真实链路（dev 实例，2026-10-09）：建 opencode 会话 → `POST /release` 释放进程（确保走
  临时拉起路径）→ `DELETE /sessions/{id}?delete_agent_side=true` → 响应
  `{"ok":true,"agent_side":"deleted"}`；opencode 侧 `session_v2` 行消失（agent 侧真实
  删除）、omniterm 行照删、无孤儿 opencode 进程 ✅。UI 侧手动回归用例见
  `docs/reference/user-testing.md` §23。

## 6. 验收标准

- [ ] E1：展开面板拉到真实 agent 会话列表；cwd/title 缺省时降级显示不崩溃；超限显示截断提示
- [ ] E1：未声明能力的 agent → 面板显示明确错误（不是空白列表）
- [ ] E2：外部会话载入 → 侧栏出现会话 → 打开点「恢复」→ 历史完整重放且 refresh 后仍在（sync 落库生效）
- [ ] E2：已纳管 id 重复载入 → 面板点击 = 切换而非重复建会话
- [ ] E3-1：能力已知支持 → 勾选默认开 → 删除后 agent 列表（E1 刷新）中该 id 消失
- [x] E3-1：能力未知 → **可勾选**，勾选删除时后端临时拉起探明并补删（2026-10-09 勘误 E-7/E-8，取代原「禁用 + 说明」）
- [ ] E3-1：勾选删除但 agent RPC 失败 → 删除仍成功、WARN 留痕、toast 说明 agent 侧未删
- [x] E3-1：能力已知支持 → 勾选后删除 → agent 列表（`session/list` 探针）中该 id 消失
- [x] E3-1：agent 已知不支持 → 勾选禁用 + 说明（唯一禁用原因）；删除照常完成（`agent_side:"skipped"`），omniterm 侧记录照删
- [x] E3-1：进程已释放（含归档会话）→ 勾选删除时后端临时拉起补删（2026-10-09 勘误 E-7，取代原「禁用 + 请先恢复会话」）
- [x] E3-1：勾选删除但 agent RPC 失败 → 删除仍成功、WARN 留痕、toast 说明 agent 侧未删
- [x] E3-1：勾选偏好被记住（`localStorage.omniterm_delete_agent_side`），刷新后仍生效；禁用态不写偏好
- [x] E-10：单条 / 批量删除确认后弹窗**立即关闭**、界面不被阻塞；结果由右下角 toast 如实上报（2026-10-09 勘误）
- [x] E-11：两段式——第一段不 spawn、立即 `pending`；第二段补发端点取 `deleted` / `skipped` 并补报；失败/缺上下文降级 `skipped`（2026-10-09 勘误，实测 4ms / 0.84s）
- [x] E3-2 后端：`DELETE /agents/{id}/acp-sessions/{acp_session_id}?cwd=`（临时拉起现场 gate + `session/delete`，200 + `deleted`/`skipped`；agent 不存在 404 / cwd 非法 400）——两段式第二段复用（原设计的「无能力 → 409」落地为 200 + `skipped`，由前端如实展示）；面板内 purge 的 UI 仍待 E1 面板
- [x] 批量删除：逐条判据——仅「agent 已知不支持」的会话不带 `delete_agent_side=true`（进程未驻留由后端临时拉起）；全不可勾时禁用 + 说明
- [ ] §P1：list 双页 + 超 200 条截断有单测；`AgentHistorySection` 无轮询（**未实施**：Phase 1 不做）
- [x] 质量门禁全绿；`./scripts/check-doc-index.sh` 通过

## 7. 风险与文档闭环

| 风险 | 缓解 |
|--------|------|
| Phase 0 探明 agent 不支持 `session/delete` | **已发生**（codebuddy 未声明）：删除弹窗勾选框对其恒禁用并给出「未声明支持…需手动清理」文案，删除照常完成；结论已回写本文档 §0 与 `acp-protocol-reference.md` §17.3 |
| 勾选框可勾但实际跳过（进程已释放） | ~~前端把 `acp_process_alive === false` 纳入禁用判据（偏差 E-2）~~ 已被勘误 E-7/E-8 取代：进程未驻留由后端临时拉起补删；仍失败则 `skipped` + toast 如实告知，不给「勾了没删」的静默失败 |
| ephemeral spawn 与 reaper / 并发拉取叠加（同 agent 同时多进程） | spawn 不注册 supervisor（不进 reaper 视野）；每次调用独立 15s timeout + 结束必 shutdown；不做单 flight（首版从简，spawn 幂等廉价）——若实测重复拉取频繁再加 per-agent in-flight（Phase 1 落地时适用） |
| 长历史会话 list 慢（agent 侧扫盘） | 15s timeout + 超限截断 + 面板 loading 态（Phase 1 落地时适用） |
| 用户从面板载入一个**别的 worktree/cwd** 的会话 | create 用当前 worktree 作 `workspace_path`；加载 RPC 的 cwd 用 omniterm 的（`restore_acp_session` 已如此），agent 侧按 id 定位历史——若 agent 严格按 cwd 匹配可能 load 空历史，面板行展示原始 cwd 让用户预判（Phase 2 落地时适用） |
| `session/delete` 成功被当成「文件已删」 | 文案只说「从 agent 会话列表移除」；软删/硬删由实现决定（§17.3 结论 2） |

**文档闭环（Phase 0 + Phase 3 + Phase 4-E3-1 已完成部分）**：
- [x] `docs/architecture/backend.md`：`delete_agent_side` 路由语义、capabilities 帧 `agent_delete`、`AcpClient` 两方法 + 能力判据
- [x] `docs/reference/acp-protocol-reference.md`：§17.3 多实现差异表 + §18.1 方法矩阵「omniterm 已接 / 未接」标注
- [x] `AGENTS.md`：本计划已在文档索引（2026-10-04 登记）
- [x] `docs/reference/user-testing.md`：E3-1 手动用例
- [x] `CHANGELOG.md`：条目（Phase 3 + Phase 4-E3-1 为实质性功能改动）
- [x] 2026-10-09 勘误闭环（§5.2）：`backend.md` 临时拉起语义 + 判据更新、协议参考 §17.3、`user-testing.md` §23、CHANGELOG Unreleased
- [ ] Phase 1/2/4-E1/E3-2 落地后补：list/purge 路由文档、AgentHistorySection 渲染用例
