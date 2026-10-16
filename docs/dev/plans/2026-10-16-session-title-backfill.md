# agent 侧会话标题回填 + session/list 发现面板

> 状态：**已实施**（2026-10-16）
> 触发条件：侧栏会话名只有两种来源——用户手写，或 `${agent 显示名}_${MMdd-HHmm}` 的宿主默认拼接（dev 库实证：`CodeBuddy_1014-1945` / `oh-my-pi_1001-1422` / `Pi ACP_0921-2328`）。多开几个 agent 会话后列表不可辨读，而 agent 侧其实有标题。
> 关联：`docs/reference/acp-protocol-reference.md` §17.4（多实现实测）、`docs/dev/plans/2026-10-04-acp-session-history-management.md`（Phase 1 + E1 面板，本文档落地其未实施部分）、`docs/architecture/backend.md`「Sessions Table」/「ACP Module」

## 1. 背景与问题清单

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| Q1 | ACP 会话名不可辨读：没手写时就是 agent 名 + 创建时刻 | `CreateSessionModal.tsx` 的 `${display_name}_${MMdd-HHmm}`；dev 库 12 个 ACP 会话里 11 个是该形态 | P1 |
| Q2 | 终端会话（FileManager「在此打开终端」三处）`name` 恒 NULL → 侧栏显示「未命名」 | `api.createSession(..., undefined, ...)` | P2（本次顺带收敛口径，不改语义） |
| Q3 | agent 侧有标题却拿不到：`session_info_update.title` 已流到浏览器然后被丢弃 | `useAcpChat.ts` 的 `DROP_VARIANTS` 含 `SessionInfoUpdate` | P1 |
| Q4 | agent 侧历史完全不可见（只能看自己纳管过的） | `session/list` 零引用 | P1 |

**根因**：两条协议通道（live `session_info_update` 通知、`session/list` 查询）一条被前端丢弃、一条未实现；且 `sessions.name` 无法区分「用户手写」与「宿主自动生成」，导致即便拿到标题也不敢写。

## 2. Phase 0 实探结论（2026-10-16，已完成）

最小 JSON-RPC 探针直连各 agent（`initialize` + `session/list`，只读、不建会话）：

| agent | 版本 | `sessionCapabilities` | `session/list` 的 `title` | live `session_info_update.title` |
|---|---|---|---|---|
| opencode | 2.0.24 | `list`+`delete`+`fork`+`resume`+`close`+`additionalDirectories` | ✅ 48 条全有，质量高（`检查待提交改动`）；旧会话退化成 `New session - <ISO>` | ❌ 从不发（只发 `_meta` 厂商键） |
| qodercli | 1.1.68 | `list`+`delete`+`fork`+… | ✅ 短而干净（`查看未发布改动`） | ❌ 只有 schema 定义，无发送点 |
| pi-acp | 0.0.34 | `list`+`delete` | ✅ 有，但=**用户首条消息原文**（可能很长、含 shell 提示符） | ⚠️ 仅在用户敲 `/name <t>` 后发 |
| omp | 18.7.0 | `list`+`fork`+`resume`+`close`（无 delete） | ⚠️ 50 条里只有 1 条有 | ✅ **自动 LLM 生成**（首条消息后一次模型调用，3-7 词；`refreshOnReplan` 会重生成） |
| **codebuddy（默认 agent）** | — | **无 `sessionCapabilities`** | ❌ `-32601 Method not found` | ❌ 只发 `_meta` |

**对 Q3/Q4 的回答**：两条通道都真实可用，但**没有一条对所有 agent 可用**。因此两条都接，互为兜底；codebuddy 侧无法闭环（agent 能力缺失，非宿主可实现范围）。

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | `name` 只放用户手写名；agent 标题入**新列** `sessions.agent_title`；展示优先级 `name ?? agent_title ?? ${agent}_${MMdd-HHmm}` | 「用户命名不被覆盖」由 **schema 级不变式**保证（`name` 非空即手写），不依赖任何可能与现实漂移的 provenance 标记列。`agent_title` 照 `usage_json` 范式（可空、随行删除清理、写入有上限 + 同值跳过） | ① 复用 `name` + `name_source` 布尔/枚举列（状态列会漂移）；② 后端重算默认名再比对（**坏**：前端用本地时间生成默认名、后端 `created_at` 是 UTC，重算永不相等 → 回填永不触发且不报错）；③ 正则猜 `_\d{4}-\d{4}$`（误判 = 静默改用户名字） | 出现「用户要把会话改回自动标题」的诉求 → 补显式清空 `name` 的入口（当前 `PATCH` 用 `COALESCE` 故意不清空） |
| **D2** | 默认名改为**展示期派生**（`utils/sessionDisplayName.ts` 用 `agent_id` + `created_at` 现算），不再落库 | D1 否决项②的根因是时区口径分裂；展示期用 `new Date(created_at)` + 本地 getter，与历史行为**逐字相同**（dev 库 12 个会话名可原样重现），且让「未命名」变成 schema 可判的事实 | 继续在 create 时落库默认名（则 D1 的判据退化成猜） | 前端需要按名字排序/筛选（派生值每次重算，成本可忽略但语义要确认） |
| **D3** | 展示收敛到单一函数 `sessionDisplayName()`，7 个调用点全部改接 | 工程准则 7①：同一判断 ≥2 处必须收敛。原口径 `name \|\| tmux_session_name` 有**两个站点没有 `?? 未命名` 兜底**（`SessionRow.tsx:167` / `ArchivedSessionsSection.tsx:69`），历史依赖 ACP 默认名非空才没暴露 | 各处散落 fallback（必然漂移，且 agent 标题永远接不进去） | — |
| **D4** | `session/list` 走 `AcpClient::spawn_probe`（不发 `session/new`） | 每次展开面板都起一个短命进程；走 `spawn_and_connect` 会在 agent 自己历史里留一条空会话（opencode 实测即多一行 `New session - <时间>`）——**面板往它正在展示的列表里掺数据** | 复用 `spawn_and_connect`（与 agent 侧删除同构，省一个 `SessionMode` 变体） | 实测某 agent 的 `session/list` 要求先有绑定会话 → 退回 `New`（当前四个实现均无此要求） |
| **D5** | `session/list` **不做能力 gate**，错误原文透出为 502 | 能力位在实测实现里覆盖不一（omp 声明 `list` 却对部分会话不给 title），gate 会把「不支持」与「声明了但 RPC 失败」混成一谈；`Method not found: session/list` 原文已足以对用户如实交代 | 学 `session/delete` 加 `supports_list_session` 门控（会把三种失败折叠成一种） | 出现「能力未声明但 RPC 实际可用」的实现 → 再评估 |
| **D6** | 标题写入上限 `MAX_TITLE_BYTES=512`，**超限跳过而非截断** | 截断要么静默（P1 禁止，下游无法区分「本来就短」与「被剔了」），要么把 `…已省略 N 字符` 渲染进侧栏。超限标题本身就是异常 agent 行为，保留上次可用值比展示半句话诚实。同 `usage::MAX_USAGE_SNAPSHOT_BYTES` 策略 | 截断 + 显式标注（侧栏展示形态不可接受） | 实测有 agent 的合法标题超 512 字节 → 上调并补回归 |
| **D7** | `SessionInfo.title` **缺省 ≠ 清除**；只有 `SessionInfoUpdate.title: null` 是清除 | 两者类型不同：前者是普通 `Option`（字段缺席 = 这个实现没给），后者是 `MaybeUndefined`（`Null` = 协议规定的显式清除）。混为一谈会让 omp 一拉列表就擦掉 live 通知刚写好的标题（**实施中被单测抓出的真实缺陷**） | 统一按 `Option::None` 处理（清除） | — |
| **D8** | 面板行只读 + 「已纳管」徽标；已纳管行点击 = `activateSession`，未纳管行无动作 | 「发现」与「纳管」是**两个用户动作**；一次列表拉取不该产生不可预期的库变更（也不代用户建会话） | 面板内直接「载入」（= 计划 E2，未实施，需建库行 + 复用 restore 重放，独立范围） | E2 落地后面板行加「载入」按钮 |

## 4. 多实现差异与兜底（AGENTS §8）

| 差异点 | 处理 |
|---|---|
| `title` 是可选字段，可能缺省 | 展示层：`title ?? session_id 截断`（不显示空行/占位符）；回填层：缺省跳过（D7） |
| 标题形态各异（短句 / 用户原话 / `New session - <时间>`） | 原样展示，不替 agent「美化」；侧栏行 CSS `truncate` 负责视觉截断 |
| pi-acp 标题 = 用户首条消息，可能极长 | 512 字节上限跳过（D6） |
| codebuddy 整个 `session/list` 不可用 | 面板显示 agent 原文错误 + 「该 agent 可能不支持」提示，**不是空白列表**（空白会被读成「你没有历史」） |
| `session_info_update` 只有部分实现发 | 两条通道互为兜底；都不发的 agent 维持 `${agent}_${时间}` 默认名 |
| `_meta` 厂商键与本功能无关 | 不解析（omp/pi-acp 的 `_meta` 只承载 queueDepth/running 等运行时状态） |

## 5. 实施记录（2026-10-16）

### 后端

| 改动 | 文件 |
|---|---|
| 新列 `sessions.agent_title TEXT` | `migrations/20261016_add_session_agent_title.sql` |
| `Session` 模型 + `src/models/session.rs` 加字段（4 处字面量构造点同步） | `src/models/session.rs`、`src/api/sessions.rs` |
| 标题规范化 + 落库 + 同值跳过 + `session/list` 回填 | `src/acp/title.rs`（新模块） |
| `on_agent_notification` 加 `SessionInfoUpdate` 分支（照 `usage::persist_usage_snapshot` 范式，复用已绑定的 `config_prefs` handle → create 与 restore 两条注册点都生效） | `src/acp/client.rs` |
| `list_sessions()`：`session/list` + 有界翻页（`ACP_LIST_MAX_SESSIONS=200` / `ACP_LIST_MAX_PAGES=10` 双维度） | `src/acp/client.rs` |
| `SessionMode::Probe` + `spawn_probe()`（不发 `session/new`，D4） | `src/acp/client.rs` |
| `GET /agents/{id}/acp-sessions?cwd=`：临时拉起（spawn/RPC 各 15s）+ 分页 + 标题回填 + 「已纳管」徽标 + 必收尸 | `src/api/agents.rs` |
| `EPHEMERAL_AGENT_TIMEOUT` 提升为 `pub(crate)`（list 与 delete 共用） | `src/api/sessions.rs` |
| fake agent 增补 `session/list`（分页 + title 缺省 + method-not-found）、`session_info_update`（title / title:null）、`new-session` 事件日志 | `src/acp/test_support.rs` |

**单测**：`acp::title` 11 条（规范化 + 落库同值/超限/边界/清除/不碰 name）、`fake_agent_tests` 7 条（live 标题落库与清除、分页、cwd 下发、两个上限维度、探针不发 session/new、method-not-found）、`api::agents` 10 条（404/400 前置 + 端到端 fake agent 全链路 + 回填 5 条库侧契约）。

### 前端

| 改动 | 文件 |
|---|---|
| 展示名单一真源 | `frontend/src/utils/sessionDisplayName.ts`（新）+ 同名 `.test.ts`（10 条） |
| 7 个调用点改接（`SessionRow` ×2、`ArchivedSessionsSection`、`Layout`、`Sidebar` ×4） | 见 D3 |
| `defaultAcpAgentId` 从 `CreateSessionModal` 抽出为共享 util（准则 7①） | `frontend/src/utils/defaultAcpAgentId.ts` |
| 「Agent 历史」面板 + 弹出面板 + appStore 互斥 toggle + Sidebar 底部按钮 + i18n ×2 | `Sidebar/AgentHistory.tsx`、`AgentHistoryPopup.tsx`、`appStore.ts`、`Sidebar.tsx`、`Layout.tsx`、`locales/{en,zh}` |
| `listAgentAcpSessions` + `AgentAcpSession` 类型 + `Session.agent_title` | `frontend/src/api/client.ts` |
| 面板单测（自动拉一次不轮询 / title 缺省回落 / 已纳管点击 / 未纳管不可点 / 截断提示 / 错误原文 / 空态 / 无工作区） | `Sidebar/AgentHistory.test.tsx`（8 条） |

## 6. 验收标准

- [x] 用户手写名的会话，agent 侧有自动标题也不覆盖（`persist_never_touches_the_user_supplied_name` / `backfill_never_touches_a_user_supplied_name` / `sessionDisplayName` 优先级单测三重钉住）
- [x] 用户没命名 + agent 支持 → 侧栏显示 agent 标题（omp live 通知 / opencode 等 `session/list` 两条通道）
- [x] 用户没命名 + agent 不支持 → 继续显示 `${agent}_${MMdd-HHmm}`（codebuddy 实测）
- [x] 默认名展示值与历史逐字相同（本地时间 + `created_at` 现算，无需迁移存量行）
- [x] `session/list` 双上限（200 条 / 10 页）有单测，超限 `truncated=true` 且 UI 明示
- [x] title 缺省不清除已有快照（D7，实施中由单测抓出）
- [x] `session/list` 不在 agent 历史里留痕（探针模式，事件日志断言无 `new-session`）
- [x] 临时进程必收尸（不注册 supervisor + `disconnect`）
- [x] 面板不轮询（`useCallback` + `autoLoadedKeyRef` 按 agent×cwd 只拉一次）
- [x] agent 不支持时面板显示 agent 原文错误而非空白列表
- [x] 质量门禁：`cargo fmt` / `clippy -D warnings` / `tsc -b` / `lint`（0 error，warnings 不新增）/ `cargo test`（796 passed，6 个 `health::` 失败为**基线既有环境问题**，已用 HEAD 干净 worktree 复证）/ `pnpm test`（114 文件 1178 条全绿）

## 7. 明确不做（含理由）

- **终端 OSC 标题不作会话名**：数据链路本来就在（`vt.rs::title()` → `WatchTarget.title` → `tmux #{pane_title}`），但实测内容是**状态串**——Claude Code = `⠹ agent is thinking`（`claude.toml:7` 的 spinner 正则）、Codex = `Codex — Action Required`、普通 shell = hostname。且 `agent/watch.rs:109` 只给「识别出 agent 的 pane」建 entry，普通 shell 标题根本进不来。拿它当名字会让侧栏每秒跳一次。结论沉淀在 `acp-protocol-reference.md` §17.4，避免重复调研。
- **存量数据不迁移**：存量 ACP 行的 `name` 里存着自动生成的默认名，按 D1 会被当作「用户手写」→ 永不回填。不做正则清洗（误判 = 静默改用户名字，工程准则 5）。存量会话维持原名，新会话走新口径。
- **`session/fork` / 面板内「载入」/ 面板内删除**：属 `2026-10-04` 计划的 E2/E3-2，独立范围。本面板的「已纳管」徽标与点击切换已为它们留好接缝。
- **标题本地生成兜底**（从首条用户消息截断）：对 codebuddy 是唯一生效路径，但属「宿主猜」而非 agent 侧标题，与本文档目标不同，未做。

## 8. 风险与文档闭环

| 风险 | 缓解 |
|------|------|
| 每次展开面板起一个进程（慢 agent 秒级） | spawn / RPC 各 15s 预算 + 超时即收尸；**不轮询**；面板有 loading 态 |
| 面板把 agent 侧历史全列出来（可能上百条） | `ACP_LIST_MAX_SESSIONS=200` / `MAX_PAGES=10` 双上限 + `truncated` 明示（§P1） |
| 标题来自外部输入，可能极长 / 含换行 | 512 字节上限跳过 + 规范化 trim；展示层 CSS `truncate` |
| agent 标题突变（omp replan 重生成）让侧栏名字跳 | 同值跳过 + 只在 `name IS NULL` 时可见；用户手写即永久固定 |
| `session/list` 与 reaper / 并发拉取叠加（同 agent 多进程） | spawn 不注册 supervisor（不进 reaper 视野）；每次独立 15s 预算 + 结束必 `disconnect`；不做 single-flight（首版从简，spawn 幂等廉价）——若实测频繁重复拉取再加 per-agent in-flight |
| 探针模式的空 `SessionId` 哨兵被误用 | `spawn_probe` 文档明示「不得调用任何按 session 定位的方法」；当前唯一消费者只用 `session/list`（参数是 cwd） |

**文档闭环**：
- [x] `docs/architecture/backend.md`：Sessions Table 新列、新端点、`AcpClient::list_sessions`/`spawn_probe`、上限常量
- [x] `docs/architecture/frontend.md`：`sessionDisplayName` 单一真源 + AgentHistory 面板
- [x] `docs/architecture/frontend-patterns.md`：sidebar-popup 已有案例补 `AgentHistoryPopup`
- [x] `docs/reference/acp-protocol-reference.md`：§17.4 多实现标题实测表 + §18.1 方法矩阵（`session/list` 从未接 → 已接）
- [x] `docs/dev/plans/2026-10-04-acp-session-history-management.md`：Phase 1 + E1 面板实施记录（§5.3）
- [x] `CHANGELOG.md`：实质性功能改动条目
- [x] `CLAUDE.md`：本计划登记进文档索引；`./scripts/check-doc-index.sh` 通过
