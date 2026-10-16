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

### 勘误（2026-10-16，用户实测回填）

上线后用户实测 `OpenCode_1016-1944` **没有**回填成 agent 标题。两条缺陷，都是**读侧改了、写侧漏改**或**参数没传到 RPC**这一类「看起来做了」的坑：

| # | 缺陷 | 根因 | 证据 | 修复 |
|---|---|---|---|---|
| **E-16** | 新建 ACP 会话不手写命名时，`name` 仍被落成 `${agent}_${MMdd-HHmm}` | **D2 只实施了读侧**：`sessionDisplayName.ts` 展示期现算做了，`CreateSessionModal.tsx` 的**写侧**（第 128-135 行的 IIFE 默认名生成）漏删。而 D1 的判据是「`name` 非空即用户手写」→ 自动名把 agent 标题**永久挡死** | dev 库该行 `name='OpenCode_1016-1944'`；UTC+8 下按 `created_at` 重算与生成器输出**逐字节相同**（另两条历史行也精确吻合），证明是机器生成而非手写 | 写侧改 `sessName.trim() \|\| undefined`；`CreateSessionModal.test.tsx` 补 2 条回归（原断言写的是 `expect.any(String)`，**正是它把错误行为钉住的**） |
| **E-17** | 「Agent 历史」面板对带尾斜杠的工作区返回**空列表** | `canonical_cwd` 归一只作用于 `spawn_probe` 的**进程 cwd**，`list_sessions(Some(&query.cwd))` 传的还是**原始查询串**。opencode 对 `session/list` 的 cwd 参数做字符串级过滤，而它建会话时会把 `/home/pax/` 规范化成 `/home/pax` 再存 | 直连实测：`?cwd=/home/pax` → 25 条，`?cwd=/home/pax/` → **0 条**；库里 `workspace_path='/home/pax/'`（14 行里 2 行带尾斜杠） | RPC 改传 `&cwd.to_string_lossy()`；`spawn_probe` 处 `cwd.clone()` 解所有权冲突 |

**两条共同教训**（均已写进代码注释，勿再犯）：

1. **「读侧派生 + 写侧落库」必须成对删**。D2 的否决项原文就写着「继续在 create 时落库默认名 → D1 的判据退化成猜」——我沿着自己写下的失效模式走了一遍。派生值与落库值产生的**字符串完全相同**，所以删漏了在界面上看不出任何异常，只有「agent 标题永远不出现」这一个间接症状。
2. **空列表是静默失败，不是「没有数据」**。E-17 的 0 条被读成「这个目录没有历史」——面板不报错、用户无法区分、代码也无法区分。凡是「下游按字符串精确匹配」的边界，宿主侧传入的路径表示差异（尾斜杠/重复分隔符）都必须先归一。

**假绿测试的教训**：E-17 的第一版回归断言写的是 `events.contains("list-cwd /a/b")`，而 `"list-cwd /a/b/"` 会把该子串**判为命中**——带 bug 时测试照样绿。已改为 `events.lines().any(\|l\| l == expected)` 逐行精确比对，并用**变异检验**（把修复改回 bug 态）确认测试确实会失败。凡是对事件日志/多行文本做 `contains` 断言的，都要先想清楚「目标串是否是另一合法输出的前缀」。

> **`session/delete` 为何不套 `canonical_cwd`**：purge 路由最初也加了归一，但 `delete_agent_side_record_via_ephemeral_spawn` 只把 cwd 用作被拉起进程的工作目录，`session/delete` 按 sessionId 定位——尾斜杠对它无影响，加了就是死改动，且注释会做出未验证的断言。已撤回。

### 勘误二（2026-10-16，用户追加要求：turn 结束时回填 + 改名即阻止）

用户在实测通过后进一步要求两件事：**turn 结束时自动回填**（opencode 等没有 live 通道的 agent 只能靠反查，否则会话名永远停在默认拼接），以及**「turn 结束前用户就自己重命名了，要阻止回填」**。

| # | 改动 | 要点 |
|---|---|---|
| **E-18** | 新增第三条触发点：`AcpClient::refresh_agent_title`，在 `dispatch_prompt` 的 `Ok` 分支（`Done` 帧之后）调用 | live 通知（只有 omp 等少数推）+ `session/list` 反查（面板手动）+ **turn 结束自动反查**三条通道。三道门控，任一不满足**一个 RPC 都不发**：① 用户已命名；② 已有 `agent_title`（写放大防线）；③ agent 未声明 `sessionCapabilities.list`（实测 codebuddy 默认 agent 未声明且方法 `-32601`，盲问=每轮 turn 一次无效往返 + 一条 WARN） |
| **E-19** | 「用户已命名」从**调用方先查后写**改为 **UPDATE WHERE 里的原子判据** | 这是用户点名的核心。用户可以在 turn 进行中的任意一刻改名，与跑在别的任务上的 live 通知 / turn 结束反查**真并发**；先读 `name` 再决定写不写，「读」与「写」之间会被改名插进来。判据下沉到 `persist_title` 的 SQL 后，改名只要在 UPDATE 提交前完成，本次写入自然成为 0 行，无需锁或事务协调。事前查询只是省 RPC 的优化，竞态下最坏多问一次 |
| **E-20** | 删掉 E-17 里新造的 `api::agents::canonical_cwd`，归一下沉到 `AcpClient::list_sessions` 内部 | 复查时发现 `client.rs` **早有** `normalize_agent_cwd`（2026-10-11 为 qoder 的 `session/load` 加的），覆盖 session/new 与 session/load 两端——我 E-17 又造了一个功能重复的 helper，正是工程准则 7① 禁止的。且「在调用点归一」本身就是 E-17 的根因：归一了一处（spawn 的 cwd）、漏了另一处（RPC 参数）。下沉到方法内部后，任何调用方都不可能再漏 |

**「空白名 = 未命名」的两侧对齐**：`PATCH /sessions/{id}` 用 `COALESCE(?, name)`，客户端送 `{"name":""}` 会真落下空串。前端 `sessionDisplayName` 按 `name?.trim()` 判空，故 SQL 判据也必须裁空白后比对——否则会出现「界面显示 agent 标题、库里却再也不回填」的分叉。第一版直接用了 SQLite 的 `TRIM(name)`，被单测抓出**它只去空格、不去 tab/换行**（JS `trim()` 去全部空白），改为显式列出 ASCII 空白字符集（`SQL_BLANK_CHARS`）。不追 Unicode 空白：UI 输入框产生不了，手搓 API 那种行的后果仅是「不回填」，展示仍正常。

**回归测试的变异检验**（这次全部做过，确认不是假绿）：
- 删掉 `dispatch_prompt` 里的 `refresh_agent_title` 调用 → `dispatch_prompt_backfills_the_agent_title_on_turn_end` 红
- 把「未命名」判据改成恒真 → `dispatch_prompt_does_not_relist_after_the_user_renames` 红
- 门控去掉 `agent_title IS NULL` → `dispatch_prompt_does_not_relist_when_title_already_present` 红
- 把 `persist_title` 的 SQL 判据降为恒真（门控仍生效）→ `persist_never_touches_the_user_supplied_name` + `persist_stops_updating_once_the_user_renames` 红
- `list_sessions` 内不做归一 → `list_sessions_strips_trailing_slash_before_sending` 红
- 删掉能力门控 → `refresh_agent_title_skips_when_agent_lacks_list_capability` 红

**未做（留口）**：打开 / 切换到某个 ACP 会话时的回填。`refresh_agent_title` 已是 client 方法，补这个触发点只需在 WS 连上并拿到 client 后调一次；未做的原因是它触碰 WS 连接/重放链路，而用户只点名了 turn 结束这一条。

### 勘误三（2026-10-16，真机实测才发现的两个坑）

前两轮都是拿 fake agent 验证的，`fe8e5d4` 之后用**真 opencode** 跑端到端，发现两个 fake agent 是桩所以覆盖不到的问题：

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| **E-21** | turn 结束反查抓到的是**占位串** `New session - <ISO>`，且从此锁死 | opencode 的真标题是**异步**生成的：实测 `prompt_done` 后立即读库是 `None`，2s 后是占位串，真标题约 1.5s 后才落到 agent 侧。而当时的门控有「已有 `agent_title` 就别问」→ 占位串被永久锁死，侧栏永远显示 `New session - 2026-10-16T…`，比默认名好不了多少 | **删掉那道门控**（`workspace_needing_title` → `workspace_to_refresh_title`，只保留「用户未命名」）。代价是每轮一次 `session/list`（已量：本地连接 25 条会话远小于 1s、几 KB，且有 `ACP_LIST_MAX_SESSIONS` 封顶），写放大由 `persist_title` 的同值跳过把守。实测两轮 prompt 后占位串被换成真标题。若日后成为问题，正确解法是加「距上次反查的冷却列」，**不是**把「已有标题」加回门控 |
| **E-22** | 已回填好的标题被**擦成 NULL**（实测把 `opencode 添加自定义供应商` 擦没，而 agent 侧标题还在） | `MaybeUndefined` 三态里 `Undefined`（字段缺席）与 `Null`（显式清除）被混为一谈：`MaybeUndefined::value()` 把两者都折成 `None`，而 `persist_title(None)` 正是清除语义。协议原文只授权 "Set to null to clear"。于是 agent 发任何一条**不带 title** 的 `session_info_update`（实测 opencode / pi-acp 用这个变体推 `_meta` 运行时状态）都会擦掉标题 | `if !u.title.is_undefined()` 守住所发三态。这与 D7（`session/list` 的 `title` 缺省 ≠ 清除）是**同一条规则在另一条通道上的重犯**——D7 只在 `backfill_from_list` 里做对了，live 通知通道漏了 |

**两条方法论教训**（比上面两个缺陷本身更值得记住）：

1. **fake agent 是桩，测不到「真 agent 的时序」**。E-21 完全是时序问题（异步生成标题），桩不可能复现；E-22 也是（桩只在特定模式下发 `session_info_update`，不会发「带了 `_meta` 但不带 title」的那种）。凡是「等 agent 侧状态落地」的链路，必须有一次真机端到端。
2. **同一规则跨通道必须逐条复查**。D7 想清楚了「缺省 ≠ 清除」，但只在一条通道上实现；另一条通道用的是同一个 `persist_title`，却用了一个把两态折一的便捷方法。规则写在计划文档里不等于实现在代码里——按通道逐个 grep 落点才对。

## 6. 验收标准

- [x] 用户手写名的会话，agent 侧有自动标题也不覆盖（`persist_never_touches_the_user_supplied_name` / `backfill_never_touches_a_user_supplied_name` / `sessionDisplayName` 优先级单测三重钉住）
- [x] 用户没命名 + agent 支持 → 侧栏显示 agent 标题（omp live 通知 / opencode 等 `session/list` 两条通道）——**上线时此条为假**：写侧仍落库默认名（E-16），面板又因尾斜杠拿不到列表（E-17）；两处修复后实测 `OpenCode_1016-1944` → `opencode 添加自定义供应商`
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
  - **唯一例外（2026-10-16，单行、非清洗）**：E-16 缺陷窗口内由旧写侧建的那一行。判据**不是正则**，而是把生成器按该行 `created_at` 在浏览器时区（UTC+8）下重算、与 `name` **逐字节比对相同**才清（另取两条历史行交叉验证推导正确）。这是「证明该名字是机器产的」而非「猜它像自动名」，与正则清洗有本质区别；已留档原值，用户不认可可还原。
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
