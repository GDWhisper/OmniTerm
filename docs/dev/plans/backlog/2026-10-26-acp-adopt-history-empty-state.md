# ACP 会话「载入历史」：聊天空态入口 · 改绑当前会话

> 状态：**设计稿，已搁置**（2026-10-26 设计；**同日用户裁定「有点不是很必要」，移入 backlog**）——设计已成型且复用既有 machinery，搁置原因是需求强度不足而非方案有缺陷
> 触发条件：改 `src/ws/acp.rs::restore_acp_session`、ACP 会话创建 / 改绑链路、聊天面板空态（`ChatView.tsx` 的 `chat.empty`）、或补齐「agent 侧会话发现」能力前**必读**
> 关联：`docs/dev/plans/2026-10-04-acp-session-history-management.md`（E1 面板已实施 / **E2 载入未实施**，本文是 E2 的**替代入口形态**——E2 走侧栏面板建新行，本文走聊天空态改绑当前行，两者的后端原语可共用）、`docs/dev/plans/2026-10-16-session-title-backfill.md`（`name` / `agent_title` 双列不变式）、`docs/reference/acp-protocol-reference.md`（§17 多实现实测差异）、`docs/dev/plans/backlog/improvement-directions-remaining.md`（X18 归档态守卫缺口）

## 0. 搁置结论（2026-10-26）

**方案本身无硬伤，卡在需求强度。** 用户提出该 UX 想法后完成设计（入口时机、产物语义、cwd 约束、能力门控、竞态防护五项均已定），随后明确表示「有点不是很必要」，故移入 backlog 不排期。

- **不是「做不了」**：重放 machinery（`spawn_and_load` → `session/load` → 重放帧 → `commitReplay` → `syncToDb`）早已存在且经多轮加固（ghost 行 / 对齐写回 / 门控），本方案对它**零改动**。
- **卡点**：真正的价值来自 agent 侧历史「可发现」——那正是 `2026-10-04` 计划 E1/E2 的命题，而 E1 面板已实施（可浏览、可看已纳管徽标），只是「未纳管行不可载入」。E2 的未实施原因是**用户没提出过具体需求**（见该文 §7「仍未闭环」），本文属同一缺口的不同入口设想，同样缺真实需求驱动。
- **重启条件**：① 用户在真实场景里出现「新建 agent 会话时想接着以前聊」的诉求；或 ② 2026-10-04 计划的 E2（侧栏面板行内「载入」）重启时——届时本文的 ADR 直接适用，两种入口的差异只在「产物语义」（改绑当前行 vs 建新行）与「入口位置」。

**重启时必须先做的两件事**（本文已把结论写死，不需重新推导）：

1. **Phase 0 实探 `session/load` 的实现支持度**（§5）——这是本方案唯一未取证的前置，协议参考文档对 `session/load` **零记载**（只记了 v2 的 `session/resume`，语义不同）。
2. **同批修 X18 缺口②**：`restore_acp_session` 的 SELECT **缺 `archived_at IS NULL` 守卫**（§6 风险表 R1）——本方案让「载入」走 restore 链路，会放大这个既有缺口。

## 1. 背景与现状取证

### 1.1 用户提出的 UX（2026-10-26 原话要点）

> 用户创建指定的 acp agent 后，在首次会话之前，屏幕中央有个「暂无消息 — 在下方输入提示词开始。」，改成「载入历史会话 或 在下方输入提示词开始」，这个历史会话点击后，会展示 acp agent 侧给出的历史记录，点击后加载。

拆成两级交互：**空态中央文案挂一个可点的「载入历史会话」→ 展开 agent 侧历史记录列表 → 点某条 → 加载**。

### 1.2 为什么这个入口位置成立

决策时机对：用户新建了一个 agent 会话、正准备开口说第一句话的那一刻，「接续以前的历史」才是一个**真实待决的问题**。

- 放在侧栏 popup 里，它是「管理动作」（与 E1 面板同质）；
- 放在空态，它是「开工前的选择」。

两种入口不互斥，但**空态入口的价值更高**——它不需要用户先意识到「有个面板能看 agent 历史」。

### 1.3 现状取证（2026-10-26 源码核查）

| # | 事实 | 位置 |
|---|------|------|
| F1 | 空态渲染点：`chatState.messages.length === 0` 时居中显示 `t('chat.empty')` | `frontend/src/components/Chat/ChatView.tsx:1188` |
| F2 | 空态文案现为「暂无消息 — 在下方输入提示词开始。」（zh/en 各一份） | `frontend/src/locales/{zh,en}/translation.json:333` |
| F3 | **ACP 会话创建即 `session/new`**——`create_session` 直接 `spawn_and_connect` 拿到全新 `acp_session_id` 落库，**不存在「未绑定任何 agent 会话」的 ACP 会话** | `src/api/sessions.rs:144,172` |
| F4 | agent 侧历史枚举端点**已存在**：`GET /agents/{id}/acp-sessions?cwd=` → 起短命探针进程 → `session/list` → `{sessions, truncated}`，含 `managed`（已纳管）标记 | `src/api/agents.rs:24,71` |
| F5 | `session/list` 能力位与 `session/load` 能力位**互相独立**：前者是 `session_capabilities.list`（marker 空结构），后者是顶层 `agent_capabilities.load_session`（bool） | SDK `agent-client-protocol-schema` v1 `AgentCapabilities` / `SessionCapabilities` |
| F6 | `capabilities` WS 帧**只有** `image` / `embedded_context` / `agent_delete` / `agent_name`——**无 list 位、无 load 位** | `src/ws/acp.rs:256,1030,1221` |
| F7 | `restore_acp_session` 的 SELECT：`WHERE id = ? AND runtime_kind = 'acp'`——**无 `archived_at IS NULL` 守卫** | `src/ws/acp.rs:966-973` |
| F8 | `sessions` 表**无 `acp_session_id` 唯一索引**（`20260715_add_runtime_kind.sql` 只加了列） | `migrations/20260715_add_runtime_kind.sql` |
| F9 | 「Agent 历史」面板已实施：可浏览、可看已纳管徽标、可点击已纳管行切过去；**未纳管行无任何动作**（代码注释明写「载入是另一个用户动作（计划 E2，未实施）」） | `frontend/src/components/Sidebar/AgentHistory.tsx` |
| F10 | `session/load` 的 cwd 必须与 agent 侧建会话时的形态一致：qodercli 把 cwd 编码进目录名并原样查找，opencode 对 `session/list` 的 cwd 做字符串级过滤；omniterm 侧已有 `normalize_agent_cwd` 收口（去尾斜杠） | `src/acp/client.rs:785`；协议参考 §17 |
| F11 | codebuddy（默认 agent）**无 `sessionCapabilities`** → `session/list` 回 `-32601`；pi-acp 的 `session/list` **不列出刚新建的会话** | 协议参考 §17.3 / §17.4 |

### 1.4 问题清单

| # | 问题 | 严重度 |
|---|------|--------|
| Q1 | 新建 ACP 会话后**无法接续 agent 侧已有会话**——`acp_session_id` 唯一来源是 `session/new` 响应（F3），无任何入口传入既有 id | P0（与 `2026-10-04` 计划 Q1 同源） |
| Q2 | 上述缺口的唯一现存入口是 E1 面板，而面板未纳管行**刻意不给动作**（F9）——用户看得见历史却用不上 | P0 |
| Q3 | 恢复链路缺归档态守卫（F7），归档会话可被 restore 复活 | 中（既有缺口，X18②） |

## 2. 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P0 | ① Phase 0：`session/load` 能力位实探 | 确认哪些 agent 真能 `session/load` 且重放历史 | 小 |
| P0 | ② 后端 adopt 端点 | 改绑当前会话行到所选 agent 会话 | 中 |
| P0 | ③ 归档态守卫（X18②） | `restore_acp_session` 的 SELECT 补 `archived_at IS NULL` | 小 |
| P1 | ④ 前端空态入口 + 列表展开 | 「载入历史会话」文案 + 就地展开列表 | 中 |
| P1 | ⑤ 能力位下发 | `capabilities` 帧补 `agent_list` / `agent_load` 两个 bool | 小 |

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| **跨 cwd 载入** | `session/load` 按 cwd 定位会话（F10）；改 `workspace_path` 会让该会话的归属漂到别处（前端按 `workspace_path` 反查 owner project/worktree，匹配不上即成 orphan）。跨 cwd 的行**照常显示但标为不可载入**（附路径），留给将来的「跨项目 adopt」 |
| **侧栏面板未纳管行的「载入」按钮** | 与本文入口**竞争同一后端原语但产物语义不同**（建新行 vs 改绑当前行）。两者都做需先定「同一 agent 会话被两行绑定」的语义（见 D6）→ 排期时二选一，不并行 |
| **`session/resume`** | 语义不同：resume 恢复会话但**不重放历史**（SDK v2 `SESSION_RESUME_METHOD_NAME`），我们要的是带重放的 load（v1 `SESSION_LOAD_METHOD_NAME`） |
| **不落库存列表** | list 结果纯拉取（§P1 无界红线 + 不引入 migration）。与 `2026-10-04` 计划同结论 |
| **离线可见 agent 历史** | 同上，翻盘条件：出现「不连 agent 也要看历史目录」诉求 |
| **历史内容预览（未载入前先看几行）** | ACP 无「读历史内容但不计入会话」的方法；只有 `session/load` 会改会话状态。预览 = 载入后重放，即本文主线 |

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | **载入 = 改绑当前会话行**（`UPDATE sessions SET acp_session_id = ?`），随后复用既有 restore 链路重放 | 用户在空态时**已经有一个会话**了；再建一行会留下孤儿会话行。且改绑后重放 machinery 零改动 | 建新行（E2 形态）：多一条孤儿行、侧栏突兀 | 引入「同一 agent 会话被两行绑定」的一等语义（见 D6） |
| **D2** | **「首次会话之前」判定 = 该会话零消息 + 未归档** | 一旦发过话，本地库已有历史，再灌一份 agent 侧历史会语义混杂；归档会话是只读的，不该出现载入入口 | 「任何时候都能载入」：会让已聊过的会话被内容覆盖 | 用户明确要求「把已有对话换成 agent 侧历史」 |
| **D3** | **只允许同 cwd 载入**；跨 cwd 行显示但禁用 | `session/load` 按 cwd 定位（F10）；改 `workspace_path` 会漂移归属 | 允许跨 cwd 并接受归属漂移 | 引入跨项目 adopt 语义（届时 cwd 与归属一起设计） |
| **D4** | **重放由既有 `restore_acp_session` 承担**，不新造重放机制 | 该 machinery 已经 ghost 行 / 对齐写回 / 门控多轮加固；新造必重蹈覆辙 | 独立 adopt 重放路径 | 无 |
| **D5** | **改绑与重放之间前端禁输入** | 改绑完成、restore 换 client 之前，用户抢先发 prompt 会写进**即将被弃用的**那条 agent 会话 → 错写 | 不禁输入：数据错写 | 无 |
| **D6** | **同一 `acp_session_id` 不得被两行绑定**（应用层拦，非唯一索引） | F8 无唯一索引；补唯一索引的迁移有历史重复数据风险（迁移会失败）。先在 adopt 端点查「是否已有行绑定该 id」→ 409 | 直接加唯一索引迁移：存量重复会让迁移失败 | 存量数据确认无重复后，可另议补索引 |
| **D7** | **后端不提前 dispose 旧 client**，让 `restore_acp_session` 完整地 dispose + shutdown + 装新 client | 提前 dispose 会让 restore 里的 `dispose(sid)` 取不到旧 client → **旧 agent 进程残留**（`restore_acp_session` 的 dispose→shutdown 是唯一收尸点） | 改绑后立即 dispose + shutdown 旧 client：需在两处各写一次收尸逻辑，易漏 | 无 |
| **D8** | **后端在改绑后顺带清掉刚 `session/new` 出来的那条空 agent 会话**（仅当 agent 声明 delete 能力） | 不清则 agent 侧永久留一条空会话（用户下次在 agent 自己的 UI 里看到「多了一条没用的会话」） | 不清：留一条孤儿 | 若实测发现 delete 会误删活跃会话则撤销 |
| **D9** | **列表数据层与侧栏 `AgentHistory` 共用**（hook + 列表组件），差别只在 adopt 语义 | AGENTS 工程准则 7：同一判断/转换在 ≥2 处出现 → 必须立单一真源 | 复制一份到 ChatView：两份漂移 | 无 |
| **D10** | **列表在空态区就地展开，不弹 Modal** | 空态下遮罩无必要；就地展开保持「当前上下文」连续感 | Modal：移动端遮罩与焦点管理成本 | 移动端实测列表过长难滚动时改用底部抽屉 |

### 3.1 流程（时序）

```
[空态] ChatView 显示「载入历史会话，或在下方输入提示词开始」
   │  「载入历史会话」可点（accent 色）
   ↓ 点击
[展开] 空态区就地展开 agent 侧历史列表（agent × cwd 固定为当前会话的）
   │  后端 GET /agents/{id}/acp-sessions?cwd=<当前会话 workspace_path>
   │  复用 F4 端点；agent 不支持 list → 显示明确错误（不空白）
   ↓ 点某条（未纳管 / 同 cwd）
[载入]
   1. 前端置「载入中」→ 输入框禁用（D5）
   2. POST /sessions/{id}/adopt-acp  {acp_session_id, agent_id, cwd, title?}
        后端校验（D2 未归档 + 零消息 / D3 cwd 匹配 / D6 未被别的行绑定 / agent 存在）
        → UPDATE sessions SET acp_session_id=?, agent_title=?
        → 尝试 session/delete 清掉刚 session/new 出来的空会话（D8，仅能力支持时）
        → 返回更新后的行
   3. 前端发既有 {type:'load_session'} WS 消息
        → restore_acp_session（F7 待补 archived 守卫）→ spawn_and_load → session/load
        → 重放帧 → replay_start/replay_end → commitReplay → syncToDb 落库
   4. 列表收起，聊天区显示 agent 侧重放的历史
```

### 3.2 关键取舍说明

- **为什么改绑而不是建行**（D1）：这是本文与 `2026-10-04` 计划 E2 的**唯一实质差异**。E2 从侧栏面板发起，用户此刻**没有**手头的会话行可改绑，只能建新行；本文从空态发起，用户手头**正有**一条空会话行，改绑它最自然。两者后端原语（把某行绑定到既有 `acp_session_id`）可共用。
- **标题写 `agent_title` 而非 `name`**：`2026-10-16` 计划的不变式是「`name` 非空即用户手写、永不被 agent 标题覆盖」。载入的标题来自 agent 侧 → 必写 `agent_title`；`name` 留 NULL。**这条与 `2026-10-04` 计划 E2 原文（「`name` 缺省用面板行 `title`」）冲突**——重启时须在 `2026-10-04` 计划就地加勘误块纠正。
- **不复用侧栏面板的「已纳管 → 切换」行为**：空态列表里若某条已被别的行绑定，**不可载入**（D6），应显示为「已纳管」并禁用（与 F9 面板的徽标语义一致）。面板里已纳管行点击 = 切换过去，那是在**同一行集合内**跳转，不涉及绑定。

## 4. 能力门控与多实现差异（AGENTS §8）

### 4.1 需要新增的两个能力位

| 位 | 来源 | 缺失语义 | 用途 |
|---|---|---|---|
| `agent_list` | `agent_capabilities.session_capabilities.list`（marker，`Some` = 声明支持） | 未知 / 不支持 | 不支持 list 的 agent（如 codebuddy，F11）**不显示「载入历史会话」入口**——点了只会得到一句 `Method not found` |
| `agent_load` | `agent_capabilities.load_session`（顶层 bool） | 未知 / 不支持 | 不支持 load 的 agent 不显示入口（load 失败无法重放） |

**已知代码buddy 双重不支持**：`session/list` 回 `-32601`（F11）→ `agent_list=false` → 入口不显示。这是**如实降级**而非 bug（用户主力 agent 不具备该能力，omniterm 无法绕过）。

### 4.2 能力位不下发的后果（现状）

F6：现有 `capabilities` 帧无这两个位 → 前端**无法**判断该不该显示入口。硬做就会出现「codebuddy 用户点了入口 → 后端 502 + `Method not found: session/list`」的坏体验。故 P1-⑤（能力位下发）是 P1-④（前端入口）的**前置**，不可跳过。

### 4.3 `session/load` 的实现支持度：**零实测记载**（最大未验证项）

- 协议参考文档（`docs/reference/acp-protocol-reference.md`）**只记了 `session/resume`**（§3.4 能力表、§5.2 恢复会话段），**`session/load` 零记载**；
- SDK 侧：v1 schema 有 `SESSION_LOAD_METHOD_NAME = "session/load"`（`LoadSessionRequest`，omniterm 用的就是它，方法名确为 `session/load`）；v2 只有 `SESSION_RESUME_METHOD_NAME = "session/resume"`，且注释明说「`session/load` is still handled by the top-level `load_session` capability. This will be unified in future versions」；
- 各实现是否真支持 `session/load` **且重放历史**——**没有实测数据**。已知 `2026-10-19` 计划记录过「omp 回放全量 285 条长历史」，说明 omp 走通了 load 路径，但四家 agent 的完整支持度未系统取证。

**→ Phase 0 必须实探**（§5）。

## 5. Phase 0：实探清单（前置，未做）

用最小 JSON-RPC 探针（直连 `initialize` → `session/list` → `session/new` → `session/load`）对每个可用 agent 取证，逐格填：

| agent | `agentCapabilities.loadSession` | `sessionCapabilities.list` | `session/load` 是否被接受 | 是否重放历史 | 重放条数/字节量级 | 错 cwd 时的报错形态 |
|---|---|---|---|---|---|---|
| opencode 2.0.24 | ? | 有（已知） | ? | ? | ? | ? |
| pi-acp 0.0.34 | ? | 有（已知） | ? | ? | ? | ? |
| omp 18.7.0 | ? | 有（已知） | ? | ? | ? | ? |
| qodercli 1.1.68 | ? | 有（已知） | ? | ? | ? | ? |
| codebuddy | ? | **无**（已知） | ? | ? | ? | ? |

**取证要点**：

1. `session/load` 的 **method 名**必须是 `session/load`（不是 `session/resume`）——四家 agent 认哪个名字，决定本方案是否成立。
2. **`loadSession` 顶层位与实际接受度是否一致**——若某 agent 实际接受 load 但不声明该位，则能力位门控会误伤（须按「能力位 + 实际行为」双判，或以实际行为为准并记差异）。
3. **重放是否发生**——协议只要求 agent 接受 load 请求，是否把历史以 `session/update` 逐帧回放、回放多少条均不保证（协议参考 §17 已记此约束）。若某实现 load 后**不重放**，则「载入历史」对它退化为「绑定一个空会话」，UI 须如实提示（不能宣称载入成功）。
4. **错 cwd 的报错形态**——确认是 `INVALID_SESSION_IDENTIFIER`（qodercli 已知）还是静默空历史。后者更危险（用户以为载入成功，实则空）。
5. **`session/delete` 能力**（D8 依赖）——已在 `2026-10-04` 计划 §0 实探过一轮（opencode ✅ / pi-acp ✅ / omp 无 / codebuddy 无），**但那是删非活跃会话**；D8 要删的是**刚 new 出来、从未用过**的会话，需单独确认删它是否安全（协议：「删除活动 session 的行为由实现定义」）。

**Phase 0 结论若为「主流 agent 都不支持 load / 都不重放」** → 本方案**不实施**，只保留 E1 面板的只读发现能力（届时在 `2026-10-04` 计划就地记结论）。

## 6. 风险表

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | **`restore_acp_session` 缺 `archived_at IS NULL` 守卫**（F7） | 归档会话可被载入路径复活，破坏「归档 = 只读」语义 | **同批必修**（P0-③）：SELECT 补守卫。这是既有缺口 X18②，本方案放大它 |
| R2 | **改绑与重放之间的竞态** | 用户抢先发 prompt → 写进即将被弃用的 agent 会话 | D5 前端禁输入；后端可在改绑响应里带「已切勿发」标记做双保险 |
| R3 | **同一 `acp_session_id` 被两行绑定** | 两个 omniterm 会话指向同一 agent 会话 → agent 侧状态互相污染 | D6 应用层 409；面板「已纳管」徽标已是同一判据的现成实现（F4 的 `managed` 字段） |
| R4 | **改绑后旧 agent 进程残留** | 僵尸进程堆积 | D7：不提前 dispose，让 restore 唯一收尸 |
| R5 | **agent 侧残留刚 new 出来的空会话** | 用户在 agent 自己的 UI 里看到多余条目 | D8 尽力 delete；不支持 delete 的 agent 接受残留（README/UI 说明） |
| R6 | **agent 不重放历史**（协议不保证） | 用户点「载入」后聊天区仍空 → 误以为成功 | Phase 0 取证重放行为；UI 须如实提示「该 agent 未提供历史回放」 |
| R7 | **能力位缺失导致入口误显** | codebuddy 用户点了只得到报错 | P1-⑤ 前置下发 `agent_list` / `agent_load` |
| R8 | **多设备并发改绑同一会话** | 后写覆盖先写，两端历史不一致 | 改绑带乐观并发（比对读到的旧 `acp_session_id` 不一致则 409） |

## 7. 实施分期（重启后照此执行）

| Phase | 产出 | 改动文件 | 依赖 |
|---|---|---|---|
| 0 | `session/load` 能力位实探报告（§5 表格填满）+ 结论回写本文 §4.3 | 探针脚本（一次性）、`docs/reference/acp-protocol-reference.md` | — |
| 1 | 后端 adopt 端点 + 归档态守卫 + 能力位下发 | `src/api/sessions.rs`（新路由 + adopt handler）、`src/ws/acp.rs`（`restore_acp_session` SELECT、`Capabilities` 帧加两 bool）、`src/acp/client.rs`（如需暴露 list 能力） | Phase 0 结论为「可行」 |
| 2 | 前端 API + 空态入口 + 就地展开列表 | `frontend/src/api/client.ts`、`frontend/src/hooks/useAgentAcpSessions.ts`（**新建，D9 共享**）、`frontend/src/components/Chat/ChatView.tsx`（空态）、`frontend/src/components/Sidebar/AgentHistory.tsx`（改为消费共享 hook/组件）、`frontend/src/locales/{zh,en}/translation.json` | Phase 1 |
| 3 | 文档闭环 | `docs/architecture/backend.md`（新端点 + 能力位 + 多实现差异）、`docs/architecture/frontend.md`、`docs/dev/plans/2026-10-04-acp-session-history-management.md`（**E2 勘误块**：改绑 vs 建行、`name` vs `agent_title` 冲突）、`CHANGELOG.md`、本文状态转「已实施」 | Phase 2 |

**测试要求**（AGENTS 测试约定）：

- 后端：adopt 端点的各拒绝分支（归档 / 有消息 / cwd 不匹配 / 已被绑定 / agent 不存在）须有 handler 级测试；DB 目标只能来自 `DATABASE_URL` 或 `./.env.local` 的 `BRANCH_BINARY_NAME`（`./dev.sh test` 注入），**禁止回退任何固定真实库**。
- 前端：空态入口的显示条件（能力位未知/不支持/支持）、列表四态（loading / error / empty / truncated）、点击载入的请求体与成功后的收起行为；mock `api/client`（照 `AgentHistory.test.tsx` 现有范式）。
- `capabilities` 帧加字段 → `useAcpChat` 消费分支 → chatStore 字段，三处同批改。

## 8. 验收标准（重启后）

- [ ] Phase 0：§5 表格四家 agent 全部填满，含「是否重放历史」与「错 cwd 报错形态」
- [ ] 后端：`POST /sessions/{id}/adopt-acp` 校验齐备；归档会话 / 有消息会话 / cwd 不匹配 / 已被别的行绑定 → 各自明确错误码
- [ ] 后端：`restore_acp_session` 的 SELECT 带 `archived_at IS NULL`（R1 闭环）
- [ ] 后端：`capabilities` 帧带 `agent_list` / `agent_load`，前端可据此门控
- [ ] 后端：改绑后旧 agent 进程被回收，**无残留**（进程数前后对比）
- [ ] 前端：空态显示「载入历史会话，或在下方输入提示词开始」；agent 不支持 list/load 时**不显示**可点部分
- [ ] 前端：点「载入历史会话」就地展开列表，四态齐备；错误原文透出（不兜成空列表）
- [ ] 前端：点某条 → 载入中禁输入 → 重放完成 → 聊天区显示历史；刷新后历史仍在（`syncToDb` 落库生效）
- [ ] 前端：跨 cwd 的行显示但不可载入，附路径说明
- [ ] 前端：已纳管的行显示徽标且不可载入
- [ ] 边界：agent 不重放历史时 UI 如实提示「该 agent 未提供历史回放」
- [ ] 质量门禁：`cargo fmt` / `clippy -D warnings` / `tsc -b` / `pnpm lint` / `pnpm test` 零新增失败
- [ ] 文档：`backend.md` / `frontend.md` / `2026-10-04` 计划勘误 / `CHANGELOG.md` / AGENTS 文档索引 全部回写

## 9. 文档闭环（重启后需更新）

| 文档 | 更新内容 |
|---|---|
| `docs/architecture/backend.md` | adopt 端点、能力位（list/load）、改绑语义、§8 多实现差异（load 支持度实测表） |
| `docs/architecture/frontend.md` | 空态入口、`useAgentAcpSessions` 共享 hook、ChatView 与 AgentHistory 的共用关系 |
| `docs/architecture/frontend-patterns.md` | 「同一列表两处消费 → 抽共享 hook/组件」这一 entry（D9 的范式沉淀） |
| `docs/dev/plans/2026-10-04-acp-session-history-management.md` | **就地加勘误块**：E2 的「建新行」vs 本文「改绑当前行」的差异；E2 原文「`name` 缺省用面板行 `title`」与 `2026-10-16` 标题不变式冲突 → 应写 `agent_title` |
| `docs/reference/acp-protocol-reference.md` | §5 表格补 `session/load` 方法名与四家实现支持度（Phase 0 产出） |
| `CHANGELOG.md` | 实质功能条目 |
| 本文 | 状态转「已实施」或「已归档」；实施偏差就地加勘误块 |
| `AGENTS.md` 文档索引 | 状态变更时更新触发行 |
