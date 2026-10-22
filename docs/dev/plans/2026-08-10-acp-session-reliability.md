# ACP 会话可靠性加固：存储限界与数据正确性

> 状态：Phase 0 / Phase 1 / Phase 2 已实施（2026-08-11 起，提交 `2d18fa1` 起）；Phase 3 / Phase 4 已排期（2026-10-22，见各自章节），P3 无阻塞可实施、P4 待维护者拍板 Q1/Q2
> 触发条件：修改 `src/acp/turn_accumulator.rs`、`src/acp/chat_persistence.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx` 中任一项前必读
> 关联：`docs/reference/chat-history-loading-comparison.md`（三方参考实现对比与实测数据）、`docs/dev/performance-and-safety.md` §P1/§P2/§P5、`docs/architecture/backend.md`（blocks 两态）、`docs/dev/plans/archive/2026-07-28-pty-engine-implementation.md`
> 前置认识：**样本量不能当作"极端情况罕见"的证据**。本项目开发库会话数少，是因为维护者不信任 ACP 会话而习惯改用终端——这是不可靠导致的结果，不是"不需要加固"的理由。实测那条 9,150,950 字符的巨行出现在一个**仅 19 条消息**的会话里。

## 背景

四项限界缺口 + 一个实施过程中新发现的数据正确性缺陷。全部有实测证据，不是推测。

| # | 问题 | 严重度 | 实测证据 |
|---|---|---|---|
| P0 ✅ | `sync_messages` 的 `UPDATE` 无行限定，同文本消息的 `blocks` 互相污染 | **高（损坏数据）** | dev 库某会话 14 行 assistant `"OK"`、14 个不同 `id`，但 `count(DISTINCT blocks) = 1` —— 全被同一份覆盖 |
| P1 ✅ | 原始帧 `blocks` 可能永久留存，不收敛成 cooked | 高（体积差 2 个数量级） | 所有超大行都是未被 sync 覆盖的原始帧；cooked 行最大 114KB，原始帧行达 9,150,950 字符 |
| P2 ✅ | `text` 列无字节上限 | 中（O(n²) 写放大） | `turn_accumulator.rs:188` `st.text.push_str()` 无上限；当前实测最大 36,834 字符，属未爆发风险 |
| P3 | 触顶加载无滞后锁 | 中（交互失控） | 停在顶部时请求落定后下一个滚动事件立刻触发下一页 |
| P4 | 会话数无上限 | 低 | `sessions` 表无任何行数约束 |

## 范围与优先级

**必须按 P0 → P1 顺序**：P0 不修就做 P1 会放大污染（P1 把 sync 触发频率从"手动 restore 时"提升到"每个 turn"）。P2/P3/P4 相互独立，可任意顺序。

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| 存量巨行迁移（截断/删除已有大行） | 正式库 `omniterm.db` 的 `chat_messages` 为 0 行，只有开发库有 14 行超限。P1 落地后新数据不再产生大行；存量可直接删会话 |
| `blocks` 压缩存储（zstd/gzip） | 实测压缩比 116x（gzip -6）/ 333x（zstd -19），技术上可行，但 P1 让体积从源头降 2 个数量级后收益重叠。**留作 P1 无法覆盖场景（前端长期不在线）的后备方案** |
| 感知 agent 上下文压缩（compaction）以冷藏历史 | ACP v1.4 无 compaction 通知（`client.rs:99-139`），只能靠 `UsageUpdate.used` 骤降推断，三个参考项目均未做。且无损压缩已能解决体积，不需要"何时可安全丢弃"这个判断。压缩事件更适合做**用户可见的时间线标记**（UI 需求，非存储优化） |
| 虚拟滚动 / 渲染窗口与加载窗口分离 | 分页已把首屏加载量压到 2MiB 以内，尚无实测渲染瓶颈。等 P1-P4 落地后再评估 |

## 设计决策

### D1：P0 的修复方式 —— payload 带 id，按 id 精确匹配

**现状**：前端 payload 是 `{ role, text, blocks }`，不带 id（`chatStore.ts:1086`）；后端只能 `UPDATE ... WHERE session_id=? AND role=? AND text=?`（`chat_persistence.rs:214`），**无 `LIMIT`**，所以 text 相同的所有行被一次覆盖。

**决策**：`SyncMessagePayload` 增加可选 `id`；后端优先按 `id` 匹配，无 id 或 id 不存在时才退回文本匹配，且退回路径必须限定单行。

**为何 id 只能是可选的**：前端消息的 id 有两个来源 —— hydrate 来的消息 id = DB 行 id（`ChatView.tsx` 的 `toChatMessages`），而 live / replay 重建的消息 id 是前端生成的、DB 中不存在。所以 id 存在性必须运行时判断，不能假设。

**否决项**：给 `UPDATE` 加 `LIMIT 1`。SQLite 默认编译不支持 `UPDATE ... LIMIT`（需 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`），且"随便更新一行"仍是错的——它把污染换成了随机赋值。

**翻盘条件**：若发现 live 消息也能拿到稳定的 DB id（例如后端在 `insert_message` 后回传 id），则 id 可变为必填，退回路径可整个删除。

### D2：P1 触发点 —— `prompt_done` 时 sync，推翻一条既有决策

**这是在推翻一个刻意的设计决策**，`useAcpChat.ts:713-714` 原注释：

> assistant turn 已由后端累积器实时落库，前端不再回写。

**当初决策成立的前提**是"后端已落库，前端回写是重复劳动"。**新证据推翻了这个前提**：后端落的是原始帧，前端 cooked 才是折叠后的产物，两者体积差两个数量级（cook 把同一 `toolCallId` 的上千个 `tool_call_update` 折叠成一个 `tool_call`，每帧重复携带的 `rawInput` 副本只剩一份）。所以前端回写不是重复劳动，而是**唯一的体积收敛路径**。

**决策**：`prompt_done` 分支调用 `syncToDb()`，与 `replay_end`（`useAcpChat.ts:794`）一致。

**必须保留的东西**：`MAX_BLOCKS_BYTES` / `MAX_FRAME_BYTES` / `MAX_FRAMES` 窗口上限**不能撤**。前端不在线时（用户关了浏览器而 agent 继续跑）没有任何一方 cook，后端仍会写原始帧。P1 是优化，窗口上限是兜底，两者不可互相替代。

**代价（明确接受）**：cooked 覆盖原始帧后不可逆，失去"分类器升级后重新解释旧历史"的能力。理由：该能力从未被使用过，且当前已有 56 行处于 cooked 状态（dev 49 + preview 7），即这个能力在大部分历史上早已失效且未造成任何问题（AGENTS.md §7：新实体须由已确证需求证明）。obsidian-agent-client 存 cooked 是可行的主流选择。

**翻盘条件**：若将来需要保留原始帧（如做分类器回归测试语料），改为另存冷层表而非撤销 P1。

### D3：P2 截断策略 —— 头尾保留 + 中段折叠标记

**决策**：`text` 超过上限时保留头部与尾部，中间替换为显式标记（形如 `\n…（已省略 N 字符）…\n`），并按 UTF-8 字符边界切割。

**理由**：三个参考项目一致地采用"截断必须显式标注省略量"（obsidian-agent-client 的 `<links truncated="N">`，`wikilink-formatter.ts:50-51`），**静默丢弃无人采用**。保留头部让用户看到回答的开头（尾部窗口方案会让正文莫名其妙），保留尾部让用户看到结论。

**否决项**：
- 纯尾部窗口（保留最后 N 字节）——正文开头丢失，可读性最差
- 硬上限后停止累积——agent 还在输出而用户看不到，且无任何提示

**上限取值**：**已定 1 MiB**（实施于 2026-08-12；当前实测最大 36,834 字符，留两个数量级余量）。**必须是命名常量**并与 `MAX_BLOCKS_BYTES` 放在同一常量区（`turn_accumulator.rs:80-90`），附带 `const _: () = assert!(...)` 形式的不变式（如折叠后长度必然 ≤ 上限）。

**注意 `text` 的兜底角色**：`ChatView.tsx` 的 `toChatMessages` 在 blocks 解不出结构时回退为 `[{type:'text', text:m.text}]`，所以截断 `text` 会同时削弱这条兜底路径 —— 折叠标记因此必须对用户可读，不能是内部标记。

### D4：P3 阈值 —— 滞后锁 + 视口比例

**决策**：（a）加触顶加载锁，且解锁条件是"用户已离开顶部区域"（参考 claudecodeui 的 `scrollTop > 20`，`useChatSessionState.ts:407`）；（b）触发阈值从固定 `TOP_LOAD_THRESHOLD_PX = 200` 改为视口比例（参考 openchamber 的 `HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5`，`MessageList.tsx:85`）。

**理由**：固定像素在大屏小字号下距离过短、在手机上过长。锁则是防止请求落定后用户仍在顶部导致连续翻页。

**不纳入**：openchamber 的"惯性滚动期间推迟前插落地"（`MessageList.tsx:83-86,996-1028`，含 160ms 静止窗口 + 1500ms 最大推迟 + 90ms 轮询）。它解决的是移动端惯性滑动中途改变内容高度导致跳飞的问题，**真实但尚未在本项目复现**。翻盘条件：移动端实测出现前插跳飞。

### D5：P4 淘汰轴 —— 用 `created_at`，不加新字段

**决策**：会话数上限 + 按 `created_at` 淘汰最早的。

**理由（关键）**：`sessions` 表现有列为 `id / project_id / workspace_path / name / tmux_session_name / hook_enabled / hook_status / created_at / runtime_kind / acp_session_id / agent_id` —— **没有 `updated_at` 或 `last_accessed_at`**，而列表查询是 `ORDER BY created_at DESC`（`src/api/sessions.rs:41`）。obsidian-agent-client 的踩坑注释指出：**淘汰轴必须与读取/排序轴一致**，否则"a positional `pop()` would drop an old-inserted entry that is still in active use"（`session-storage.ts:68-71`）。既然读取轴是 `created_at`，淘汰轴就用 `created_at`，天然一致且**不需要 migration**。

**语义澄清**：这是 FIFO 而非严格 LRU。可接受——用户在列表里看到的顺序就是 `created_at`，淘汰的正是他视觉上"最下面"的会话。若将来要真 LRU，必须**同时**改列表排序轴和淘汰轴（否则违反上述规律）。

**淘汰做什么（重要）**：借鉴 obsidian-agent-client 的"淘汰只删索引，正文留作归档"（`session-storage.ts:71`）——**不删除 `sessions` 行本身**。倾向做法：只清理超限会话的 `chat_messages.blocks`（结构化内容，体积大头）而保留 `text`，或仅标记为归档态而不参与默认列表。**具体语义留待实施时与维护者确认**，因为它涉及用户可见的数据消失。

> **2026-10-22 勘误 — D5 的「淘汰做什么」已被既有机制取代，倾向方案中的两支被否决**
>
> - **「只清 blocks」被否决**：blocks 是工具调用 / 思考 / 计划的**唯一**结构化载体，text 只是纯文本兜底。
>   清 blocks = 内容**不可恢复地损坏**（用户看不到工具调用过程），比「会话从列表消失」严重一个量级。
> - **「标记为归档态」已是既有功能**：D5 写于 2026-08-10，当时尚无归档机制；现在 `sessions.archived_at`
>   （migration `20260823`）+ `idx_sessions_archived_at` + `POST /sessions/{id}/archive` +
>   `GET /sessions/archived` + 前端 `ArchivedSessionsSection`（可展开 / 取消归档 / 删除）全部就位，
>   语义恰好是「移出活跃列表 + 正文原样保留」。
> - **结论**：P4 淘汰动作复用 `archived_at`（详见 Phase 4 的 D8），D5 的「需维护者确认」阻塞点**降级为已解决**；
>   剩余待拍板项收敛为「上限值」与「触发时机」两点（Phase 4 的 D9）。
> - **D5 的「淘汰轴 = created_at」不变**：读轴是 `ORDER BY created_at DESC`，仍无 `updated_at`，仍不需要 migration。

## 多实现差异（AGENTS.md §8）

| 项 | 差异事实 | 兜底要求 |
|---|---|---|
| 每帧重复携带完整 `rawInput` | codebuddy 每个 `tool_call_update` 只带 1 字符增量内容却重复携带完整 `rawInput`（实测 p50=4746B、p90=6465B、max=13030B）；opencode / ccb 未观察到 | 已由 `MAX_BLOCKS_BYTES` / `MAX_FRAME_BYTES` 覆盖，P1 不得撤除 |
| `UsageUpdate` 是否发送 | ACP 正式变体但非强制。前端已解析（`useAcpChat.ts:429`），后端不感知 | 任何依赖它的逻辑必须能在其永不到达时正常工作。本计划不新增此类依赖 |
| `session/cancel` 是否被遵守 | 已有 `spawn_cancel_turn_fallback` 兜底 | 本计划不改动此路径，但 P2 的 `text` 截断需在 cancel 后的补发帧上同样生效 |

## 实施分期

### Phase 0（P0，前置）— 修 blocks 污染 ✅ 已完成（2026-08-11，`2d18fa1`）

| 项 | 内容 |
|---|---|
| 改动 | `frontend/src/stores/chatStore.ts`（`SyncMessagePayload` 加 `id`、`messagesToSyncPayload` 填充，:1079-1093）、`src/api/sessions.rs`（`SyncMessage` 加 `id`，:607-613；`sync_messages` 传递，:590-595）、`src/acp/chat_persistence.rs`（`sync_messages` 按 id 优先匹配，:195-235） |
| 测试 | 后端单测：同一会话两条 text 相同但 id 不同的 assistant 行，sync 后各自 blocks 独立（当前实现会失败——先写测试复现，见 `docs/dev/plans/archive/2026-07-24-quality-gates.md` 的 TDD 约定） |
| 验收 | 上述单测通过；`count(DISTINCT blocks)` 与行数一致 |

### Phase 1（P1）— turn 结束落 cooked ✅ 已实施（2026-08-11，待手动回归）

> **勘误（2026-08-11）— 实施手段与 D2 偏离（方向不变）**
>
> D2 预设的「`prompt_done` 时调 `syncToDb()`」有两个实施时才看清的问题，已改做法：
>
> 1. **不能复用全量 `syncToDb()`**。它发的是整个会话的全部消息。`replay_end` 是手动恢复、罕见，全量可接受；`prompt_done` 每 turn 都发生，全量重写就是本文「写入策略」一节批评 obsidian-agent-client 的 O(m²) 写放大。现只发**本 turn 一条** payload（`chatStore.turnToSyncPayload`）。
> 2. **不靠 text 一致性，改用 `row_id` 精确匹配**。原「前置验证」要求确认两侧 `text` 逐字节一致；实测语义确实一致（后端 `turn_accumulator.rs:187-188` 只追加 `AgentMessageChunk`，前端 `chatStore.ts` `appendChunk` 同样），**但这是个易漂移的不变式**——丢帧、cancel 补发帧、消息拆分粒度任一处变动就静默 INSERT 重复行。而更好的键已存在：后端 turn 行的 `row_id`，且 `turn_snapshot` 帧已有下发先例。现 `prompt_done` 帧一并下发 `row_id`，正确性从「文本相等」上解耦。
> 3. 连带发现：`sync_messages` 原有的 `text.is_empty()` 跳过守卫会把**纯工具调用 turn**（后端 `text` 本就为空，却恰好是 blocks 最肥的一类）全部排除在外。该守卫已收窄到只适用于无 id 的文本匹配路径。
>
> 短 turn（< 250ms 防抖窗）仍有竞态：`prompt_done` 广播可能早于 writer 落库，此时按 id 更新影响 0 行 → 该行留在原始帧态（无害，不会插重复行）。补齐路径（hydrate 落定后对原始帧行回写一次，此时 id 天然是 DB 行 id、无竞态）**未纳入本次范围**，待 Phase 1 效果确认后再评估。

| 项 | 内容 |
|---|---|
| 依赖 | **Phase 0 必须先完成**（已完成，提交 `2d18fa1`） |
| 改动 | 后端：`TurnEndEvent::Done` 与 WS `prompt_done` 帧加 `row_id`（`src/ws/acp.rs`、`src/acp/client.rs`、`src/acp/reaper.rs`），新增 `TurnAccumulator::turn_row_id()` 轻量访问器（不走 `turn_snapshot`——后者克隆全量 text + 序列化 128KB 帧窗）；前端：`prompt_done` 分支在 `markDone` **之前**调 `syncTurnToDb`（`useAcpChat.ts`），约束逻辑抽为纯函数 `turnToSyncPayload`（`chatStore.ts`） |
| 测试 | 后端：`row_id` 跨 `finalize_turn` 存活、仅 `begin_turn` 清除；空 text 行在 id 路径下仍可回写 / 在文本路径下仍被跳过。前端：5 条 `turnToSyncPayload`（streaming 边界、多条合并、纯工具 turn、空 blocks 不写） |
| 验收 | 已做：HTTP 端到端验证（临时实例 + 临时库）——带 id 只改那一行且不动 text、同 text 另一行未被污染、空 text 行可写、未知 id 不插行、无 id 的 replay 路径仍能逐行落位与 INSERT。**待手动回归**：跑一个含工具调用的真实 turn 后，该行 `blocks` 以 `[` 开头（cooked）而非 `{"v":1,"frames"`；消息条数不增加 |

### Phase 2（P2）— `text` 字节上限 ✅ 已实施（2026-08-12）

> **实施说明（2026-08-12）— D3 未写清的三个流式约束（方向不变）**
>
> D3 描述的是“超限时把中段换成标记”这个**结果**，但 `text` 是**流式累积**的，“每次超限就重新折叠整串”正好是本文要消除的 O(n²)。实现为私有结构 `BoundedText`（冻结头部 + 滑动尾窗 + 省略计数），渲染时才拼出标记，追加为摊还 O(1)/字节。三个实施时才看清的约束：
>
> 1. **头部需“封口标志”而不能只看长度**。UTF-8 字符边界会让头部停在预算之下几字节；若以“头部未满”为条件续填，会把**更新的文本插到更旧的文本之前**，正文顺序错乱。故一旦有内容落入尾窗，头部永久冻结（`head_sealed`）。
> 2. **尾窗必须按块摊还修剪**。修剪到恰好等于预算，则此后每个 chunk 都要 memmove 整个尾窗——换了个形式的 O(n²)。现一次修剪掉 1/4 预算的富余量（`TEXT_TAIL_TRIM_SLACK`），代价是尾窗平均持有略少于预算。
> 3. **单个 chunk 自身超预算时要先裁再入缓冲**。先推整段再修剪会让内存峰值等于 chunk 大小，上限形同虚设——与 `MAX_FRAME_BYTES` 存在的理由同构。
>
> 另有一条**已知边界（未修，见下方风险表）**：正文被折叠后，`sync_messages` 的**无 id 文本匹配退回路径**会失配（前端持完整 text、DB 是折叠 text）。仅当正文 > 1 MiB **且**走 replay 恢复路径时触发；Phase 1 已把主路径换成 `row_id` 精确匹配，所以不作为本期范围。

| 项 | 内容 |
|---|---|
| 改动 | `src/acp/turn_accumulator.rs`：常量区新增 `MAX_TEXT_BYTES`（1 MiB）/ `TEXT_HEAD_BYTES`（256 KiB）/ `TEXT_MARKER_MAX_BYTES`（96）/ `TEXT_TAIL_BYTES`（余额）/ `TEXT_TAIL_TRIM_SLACK`（尾窗的 1/4）/ `TEXT_OMISSION_PREFIX\|SUFFIX`，附 3 条 `const _: () = assert!` 不变式；`TurnState::text` 由 `String` 换为 `BoundedText`；边界切割统一走 std 的 `floor_char_boundary` / `ceil_char_boundary`。连带修正四处已失真注释（原文把 `text` 描述为“全量兜底”）与 `ChatView.tsx` 的“text 列总是完整的” |
| 测试 | 6 条新单测：长 turn 折叠后守住上限且头尾均保留；未超限时逐字节原样；中文/emoji 边界不被切坏；单个超大 chunk 到达即限界；`begin_turn` 重置折叠状态；标记最坏情况装得进预算。其中三条带**守恒断言**（保留字符数 + 声称省略数 == 输入字符数）以禁止静默丢弃；两条直接断言**内部缓冲**字节数（仅限界渲染值会让累积缓冲与每次重写仍然无界） |
| 验收 | 已做：先写测试看它们以正确理由失败（4 红）再实现；`cargo test` 231+8+2 全绿；`cargo clippy --all-targets` 零警告；`cargo fmt --check` 通过；前端 `tsc --noEmit` / `pnpm lint` 无新增问题 |

### Phase 3（P3）— 触顶滞后锁 + 视口比例阈值

> **2026-10-22 排期补充**：本 Phase 从「三行表格」扩写为可实施方案。实施前先读本节全部内容。

#### 取证（2026-10-22，代码现状）

| 位置 | 现状 |
|---|---|
| `frontend/src/components/Chat/ChatView.tsx:35` | `const TOP_LOAD_THRESHOLD_PX = 200` —— 固定像素，同时充当**触发窗口**与**可滚动余量**两个角色 |
| `ChatView.tsx:560-563` | `const scrollable = el.scrollHeight > el.clientHeight + TOP_LOAD_THRESHOLD_PX`；`if (scrollable && el.scrollTop < TOP_LOAD_THRESHOLD_PX) void loadOlderHistory()` |
| `ChatView.tsx:388-413` | `loadOlderHistory`：`cursor` 为空（已到开头）或 `loadingHistory` 为真则早退；无滞后锁 |
| `ChatView.tsx:415-426` | **前插补偿**：`useLayoutEffect` 里 `el.scrollTop += delta` 把视口位置补回去 |
| `frontend/src/stores/chatStore.ts:1367/1379` | `loadingHistory` 仅防**请求在飞**重入，请求落定即置 false |

**连锁翻页的确切路径**（不是推测，逐环节可核对）：

1. 用户滚到顶 → `scrollTop ≈ 0 < 200` → 触发 `loadOlderHistory`；
2. 前插 N 条更早消息 → `prependMessages` → 布局落定 → 补偿 `scrollTop += delta`；
3. 补偿后 `scrollTop = delta`。**若该页增量 delta < 200**（一页只含少量短消息即如此），
   补偿本身引发的 scroll 事件仍满足 `scrollTop < 200` → 再次 `loadOlderHistory` → 回到第 2 步，
   连锁直到 `historyCursor` 耗尽。`loadingHistory` 挡不住（它只管在飞请求，不管落定后的下一次）。

**与参考实现的关键差异（本项目独有，参考实现直接抄会失效）**：前插补偿把 `scrollTop` **抬高**了 delta。
claudecodeui 的解锁判据是绝对位置 `scrollTop > 20`——在本项目，补偿刚做完就把用户推离绝对顶部，
任何基于绝对 `scrollTop` 的「是否已离开顶部」判据都会被补偿位移污染，锁会被立即误解锁、连锁复现。

#### D6：滞后锁的解锁信号 = 「用户向上滚动」，不用绝对位置

**决策**：维护两个 per-会话 ref——上次 `scrollTop` 快照与锁标记。触顶加载发出时置锁；
仅当**用户手势（wheel / touchmove）发生后**且 `scrollTop` 相对上次快照**减小**时解锁。

- **理由**：向上滚动是**意图**信号，方向与补偿相反，补偿无法伪造它；而绝对位置会被补偿污染。
- **否决项**：
  - *绝对位置解锁*（claudecodeui `scrollTop > 20`）：补偿抬位 → 锁被立即误解锁 → 连锁复现（同上）。
  - *纯时间窗*（如 500ms 内不重试）：用户停在顶部时 scroll 事件持续（贴底、内容增长），
    窗口一过仍会连发；且需额外定时器与清理。
- **翻盘条件**：若将来前插改为「不补偿」（接受视口跳动），可退回绝对位置判据。

#### D7：触发窗口改视口比例，且与「可滚动余量」判定解耦

- **触发窗口**（距顶多近算触顶）：`clientHeight * TOP_LOAD_NEAR_TOP_VIEWPORTS`，取 **1.5**
  （openchamber `HISTORY_PREPEND_NEAR_TOP_VIEWPORTS` 口径）。这是**预取窗口**，比现行 200px 宽 →
  用户上翻时更早开始加载，减少「看到空白」。大屏小字号下 200px 过近、手机上过远，是 D4 的原判断。
- **「内容确实溢出」判定**：改为 `scrollHeight > clientHeight + 32`（小绝对余量，防 1px 溢出抖动）。
  现行 `+200px` 余量是为压制连锁而设；连锁已由 D6 的滞后锁接管，该余量不再承担该职责。
- **为何必须解耦**：若把 1.5 视口同时用作余量，内容需高出视口 1.5 倍才允许加载，
  **短会话将完全无法上拉加载更早历史**——这是功能回退，不是保守。
- **否决项**：保留 200px 固定窗口（openchamber 已实证视口比例更贴合）。
- **翻盘条件**：移动端实测出现前插跳飞时，按 D4 原文引入 openchamber 的
  「惯性滚动期间推迟前插落地」（`HISTORY_PREPEND_QUIET_MS=160` / `MAX_HOLD_MS=1500`）。

#### 实施分期

| 批次 | 内容 | 依赖 |
|---|---|---|
| 3a | 常量与判定解耦：`TOP_LOAD_THRESHOLD_PX` → `TOP_LOAD_NEAR_TOP_VIEWPORTS = 1.5`；溢出判定改小余量 | 无 |
| 3b | 滞后锁：快照 ref + 锁 ref（会话切换时重置）；解锁 = 手势后 `scrollTop` 减小 | 3a |
| 3c | 回归：既有 `ChatView.*.test.tsx` 全绿 + 手动回归长历史会话 | 3b |

#### 测试要求（前端 vitest；jsdom 无布局，沿用 `ChatView.testUtils` 的 `mockScrollMetrics` / `fireScroll`）

新建 `frontend/src/components/Chat/ChatView.topload.test.tsx`，至少 4 条：

1. **连锁回归**：触顶触发一次加载 → 补偿引发的 scroll 事件**不再**触发第二次加载（D6 的核心防线）。
2. **解锁可用**：用户手势 + 向上滚动后再次触顶，可再加载一页。
3. **比例换算**：`clientHeight = 600` → 触发窗口 900px（不是 200px）。
4. **会话切换**：切换会话后锁与快照重置（新会话首次触顶即可加载）。

#### 风险

| 风险 | 缓解 |
|---|---|
| 锁「锁死」：快照被补偿抬高，用户需滚更多才解锁 → 感知为上翻变慢 | 解锁判据要求**先有用户手势**（复用既有 `lastGestureAtRef` 手势时间戳），纯程序位移不解锁 |
| 窗口放大到 1.5 视口 → 请求量上升 | 滞后锁 + 既有 `loadingHistory` 双层防抖 |
| 与既有 `autoStick` / 贴底逻辑的交互 | 3c 回归必须覆盖「流式输出期间触顶」场景 |

#### 实施记录（2026-10-22，Phase 3 已落地）

改动落在 `frontend/src/components/Chat/ChatView.tsx` + 新增
`frontend/src/components/Chat/ChatView.topload.test.tsx`（4 条用例）。

- **3a**：`TOP_LOAD_THRESHOLD_PX`（200，两义合一）拆为两个独立量——
  `TOP_LOAD_NEAR_TOP_VIEWPORTS = 1.5`（触发窗口，视口比例）与
  `TOP_LOAD_OVERFLOW_SLACK_PX = 32`（溢出余量，小绝对值）。
- **3b**：`topLoadStateRef = { sid, locked, movedUp }` + `lastScrollTopRef` /
  `lastScrollHeightRef` 两个基准快照；所有程序性 `scrollTop` 写入收口到
  `writeScrollTop`（钉底 / 前插补偿 / 位置恢复 / 跳转到消息 / 跳到上次输入），
  写入后同步基准 → 程序性位移不可能被读成「用户向上滚」。
- **3c**：`ChatView.topload.test.tsx` 4 条用例全绿；既有 `ChatView.*.test.tsx`
  与前端全量 1461 条测试全绿，`pnpm lint` 0 error、`tsc -b` 通过。

**勘误（2026-10-22，解锁判据偏离 D6 原文）**：D6 原文写「解锁 = **用户手势**
（wheel/touchmove）发生后且 `scrollTop` 减小」。实施改为**纯方向判据**——
「用户确实向上滚过」即解锁，**不要求手势**。理由：拖原生滚动条、键盘翻页
（PageUp / 方向键）都不产生 wheel/touchmove 事件，加手势门槛会把这类用户
**永久锁死在第一页**（无法再上拉加载更早历史）——那是功能回退，比「多几次
请求」严重得多。方向判据同样无法被程序性位移伪造：程序性位移只会把
`scrollTop` 抬高或等量改写，绝不产生「相对上次快照变小」，且所有程序性写入
都经 `writeScrollTop` 同步基准。风险表里「锁『锁死』」一条的缓解措施（要求手势）
随本勘误作废——实际缓解来自「基准同步 + 方向判据」。

**勘误（2026-10-22，会话切换重置的时机）**：3b 原文写「会话切换时重置」。
实施用 `useLayoutEffect` 监听 `activeSessionId` 变更重置锁与快照，而**不是**
在 `handleScroll` 里比对 sid：切换会话本身不产生 scroll 事件，若只在滚动时
比对，旧会话残留的锁会一直挂着——直到新会话恰好滚一次才被清掉（表现为
「切到新会话后第一次触顶不加载」）。`ChatView` 跨 acp→acp 切换**不重挂载**
（Layout 只按 `runtime_kind` 做 key），故重置必须按 sid 判而非指望重挂载。

**勘误（2026-10-22，jsdom 下的 scrollHeight 度量）**：测试要求里说「沿用
`mockScrollMetrics`」，但它给的是**静态** `scrollHeight`——补偿 effect 靠
`scrollHeight` 差值算 delta，静态值会让 delta 恒为 0，测不到「补偿抬高
`scrollTop`」这条关键路径。故测试内另行覆写 `scrollHeight` getter：按
「当前会话消息条数 × 每条高度」动态给出（并给 `mockScrollMetrics` 一个足够
大的内部 `scroll`，否则其 `scrollTop` setter 的夹紧会把补偿写入值削掉）。

### Phase 4（P4）— 会话数上限 + 按 created_at 淘汰

> **2026-10-22 排期补充**：D5 原定「不删 `sessions` 行，只清 blocks 或标记归档」的语义，
> 经现状复核后**已被既有机制覆盖大半**（详见 D8）。本节重排 Phase 4 的实际范围。

#### 取证（2026-10-22）

| 事实 | 数据 / 位置 |
|---|---|
| `sessions` 表行数上限 | **完全不存在**。全仓 `rg "MAX_SESSIONS\|max_sessions\|session_limit"` 在 `src/` 与 `frontend/src/` 零命中（`ACP_LIST_MAX_SESSIONS=200` 是 agent 侧 `session/list` 的**翻页**上限，与本项无关） |
| 实际规模 | 正式库 `omniterm.db`：92 会话（acp 90 + tmux 2）、8 项目、777 条 chat_messages；dev 库 12 会话 |
| 单项目最集中 | 正式库单项目最多 51 个未归档会话 |
| 排序轴 | `src/api/sessions.rs:47` `ORDER BY created_at DESC`（仅未归档）；`:1350` `DEFAULT_LIST_SQL` 同 |
| **「移出活跃列表但保留正文」的机制已存在** | `sessions.archived_at` + `idx_sessions_archived_at` 索引 + `POST /sessions/{id}/archive` + `GET /sessions/archived` + 前端 `ArchivedSessionsSection`（可展开查看 / 取消归档 / 删除）。归档语义 = 释放 agent 进程 + 移出默认列表 + **chat_messages 原样保留** |
| 归档的既有缺口 | X18（`docs/dev/plans/backlog/improvement-directions-remaining.md`）：归档会话**无保留期 / 无容量上限**，且 `list_archived_sessions` 是 `SELECT *` 全量无分页 |

#### D8：淘汰语义 = 复用既有「归档」机制，不新造

**原 D5 的三个候选**（只清 blocks / 只标记归档 / 不删行）：**「标记为归档态」这一支已经落地为既有功能**
（`archived_at` 列 + 端点 + 前端区块），且它恰好满足 D5 的核心诉求——「淘汰只删索引，正文留作归档」
（obsidian-agent-client 的做法，见 `docs/reference/chat-history-loading-comparison.md` §会话级限界）。

**决策**：P4 的淘汰动作**复用 `archived_at`**，不新造「淘汰」状态、不加新列、不删 `sessions` 行、
**不删 `chat_messages`**。因此 D5 原先的「待维护者确认」阻塞点**降级为已解决**（见 D9 的剩余分歧）。

**为何不选「只清 blocks」**：清 blocks 会让被淘汰会话的**工具调用 / 思考 / 计划结构永久消失**（blocks 是
结构化内容的唯一载体，text 只是纯文本兜底）——这是**不可恢复的内容损坏**，比「会话从列表消失」严重得多。
而归档路径零内容损失。

#### D9：淘汰触发时机 + 上限值（剩余分歧，需拍板）

D5 的「淘汰轴 = created_at」**仍然成立且不动**：列表读轴是 `ORDER BY created_at DESC`（`:47`），
淘汰轴必须与读轴一致，否则淘汰掉用户视觉上「最下面」的那个之外的对象（obsidian-agent-client 的踩坑注释：
`a positional pop() would drop an old-inserted entry that is still in active use`）。
`sessions` 表**没有 `updated_at`**，故仍用 `created_at`，且**不需要 migration**。

待拍板的两点（**实施前必须由维护者决定，本文档不擅自决定**）：

| # | 分歧 | 选项 | 影响 |
|---|---|---|---|
| Q1 | **上限值** | (a) 全局 N（跨项目共享一个池） / (b) 每项目 N / (c) 两者都设 | (a) 实现最简（一个 `COUNT`），但一个项目能吃满全局配额、挤掉别的项目；(b) 语义贴近「列表里看到什么」，但需按 `project_id` 分组计数 |
| Q2 | **触发时机** | (a) 仅在**新建会话**时检查（惰性） / (b) 后台定时扫描 | (a) 零后台成本、零空闲资源占用，但库在用户不建会话时只增不减；(b) 及时，但要引入常驻定时任务 + 与 `archived_at` 保留期策略协调 |

**倾向**：Q1=(b) 每项目上限 + 全局上限双保险；Q2=(a) 新建会话时惰性检查。
理由：归档语义已存在且**用户可见可恢复**（归档区块可展开、可取消归档、可删除），
即使上限设得偏紧，误归档的代价比「删数据」低一个量级，**不需要为了绝对安全而牺牲及时性**。

#### D10：实施分期

| 批次 | 内容 | 依赖 |
|---|---|---|
| 4a | **拍板 Q1/Q2**（维护者决策，写回本节表格） | — |
| 4b | 后端：`src/api/sessions.rs` 新增上限常量 + 计数 + 超限时把最旧的未归档会话标记 `archived_at`（复用 `mark_archived`）。**计数与淘汰必须在同一事务/锁内**，否则并发建会话会重复标记 | 4a |
| 4c | 后端单测：超限时归档的是 `created_at` 最早的；归档后 `sessions` 行仍存在；`chat_messages` 一条不少；未超限时不动 | 4b |
| 4d | 归档列表分页 + 容量上限（**X18① 的解**）：`list_archived_sessions` 当前 `SELECT *` 全量返回，加条数上限（与 `MAX_COLLAPSED_ACP_SESSIONS` 同源思路：超限只截断返回 + 显式标注省略量，**不静默截断**） | 4b |
| 4e | 前端：`ArchivedSessionsSection` 显示「归档会话数已达上限 / 仅显示最近 N 条」 | 4d |

#### 与 X18 的关系

P4 与 X18 缺口①**是同一件事的两半**：P4 管「**活跃**会话数有界」（超限 → 归档），
X18① 管「**归档**会话数有界」（超限 → 归档区也要截断/清退）。**4d 一并做掉 X18①**，
不要留下「归档区无限增长」这个新的无界点——那等于把无界从一处搬到另一处。

#### 风险

| 风险 | 缓解 |
|---|---|
| 归档是**用户可见**的状态变化（会话从侧栏消失） | 归档区块已存在且可恢复（取消归档 / 删除）；前端需在自动归档时给出 toast 说明「已归档 N 个最旧会话」——**静默归档会让用户以为会话丢了** |
| 误归档「正在用」的会话 | 淘汰只选**未归档 + 非当前活跃**的；且 `acp_process_alive` 的会话（agent 进程仍驻留）应排除——但 `acp_process_alive` 是**查询时计算**的（`sessions.rs:88-103`，非持久列），淘汰时须经 `state.acp_supervisor.snapshot()` 判定，不能只看 DB 列 |
| 并发建会话重复标记归档 | 计数 + 淘汰在同一锁内完成（4b） |
| 上限设得过紧 → 用户频繁丢「最近」 | 上限值取实际规模的两个数量级以上（当前单项目峰值 51、总数 92） |

## 风险

| 风险 | 缓解 |
|---|---|
| Phase 1 因 text 不一致插出重复行 | Phase 0 的 id 匹配先落地；Phase 1 前做逐字节一致性验证；验收明确检查"消息条数不增加" |
| Phase 1 后原始帧不可恢复 | 已明确接受（D2）。若需语料，另存冷层而非回退 |
| Phase 2 截断削弱 `text` 的兜底角色 | 折叠标记必须用户可读；保留头尾而非纯尾窗 |
| Phase 2 折叠后与 `sync_messages` 的无 id 文本匹配路径失配（可能 INSERT 重复行） | 仅在正文 > 1 MiB **且**走 replay 恢复路径时触发；Phase 1 已把主路径改为 `row_id` 精确匹配。**未修，待观察**；若实际出现，正确修法是让 replay 路径也携行 id（D1 的翻盘条件），而非放宽正文上限 |
| Phase 4 淘汰导致用户数据消失 | 标为阻塞点，实施前必须确认语义 |
| 四项都动了 `blocks`/`text` 读写路径，可能互相干扰 | 严格分 Phase 提交，每 Phase 独立跑全量测试（后端 `cargo test`、前端 `pnpm test --run`、`tsc --noEmit`、`cargo clippy --all-targets`、`cargo fmt --check`） |

## 未决问题（不阻塞 Phase 0-3）

维护者反馈"觉得 ACP 会话不可靠"，但**具体现象尚未确认**。已列候选：消息未送达 / 刷新后记录缺失或错序 / restore 后历史对不上 / 卡在"正在输出" / 取消无效 / 权限弹窗异常 / 断网后会话报废。本计划四项针对的是**存储限界与数据正确性**，若实际不可靠源于上述其它现象，需另立根因排查（遵循 `~/.pi/agent/skills/systematic-debugging/SKILL.md`：先取证再改）。**Phase 0 的污染 bug 本身即是一个已确证的可靠性缺陷**，无论上述答案为何都该修。

> **勘误（2026-08-19）— 「刷新后记录缺失」的一个已确证实例：流式中刷新丢早期正文**
>
> **现象**：ACP 会话流式输出中刷新页面，聚焦会话缺失 assistant 侧早期一部分内容；turn 结束后刷新仍缺；释放会话再「恢复会话」（agent 重放全量历史）才找回。
>
> **根因链**（两段）：
>
> 1. 帧窗口从头部驱逐（`MAX_BLOCKS_BYTES`/`MAX_FRAMES`，D2 明确保留的兜底）：长 turn 早期帧被 `pop_front`，落库行与 `turn_snapshot` 都只含窗口。设计注释声称"`text` 保留正文所以可接受"，但前端 hydrate/快照两条渲染路径都只走 blocks、不合并 text，该前提不成立。
> 2. `prompt_done` 的 cooked 回写（Phase 1/D2）把刷新后从窗口残片重建的残缺 blocks 带 `row_id` 覆盖进 DB 行——临时缺失被固化为永久缺失。
>
> **修复（前端，后端零改动）**：
>
> - **A 回写门控**：收到 `turn_snapshot` 即置 `joinedMidTurn`，该 turn 的 `prompt_done` 跳过 cooked 回写（DB 保留原始帧行，text 列完整）；turn 结束复位。
> - **B 前缀恢复**：`rawFramesToBlocks`/`decodeStoredBlocks` 接收后端全量 text（快照 `text` / hydrate 的 text 列），窗口帧正文恰为其精确后缀时把差集补成 text 块（`prependEvictedProse`，`endsWith` 单一守卫，失配宁缺勿错；BoundedText 折叠时前缀携带用户可读的省略标记）。
> - **否决项（C）**：后端侧增量 cook。否决理由沿用模块文档：分类器是多实现前端资产（vendor adapters），Rust 复刻 = 双份真相源永久同步（AGENTS.md §8）。翻案条件：出现「后端必须理解消息结构」的新需求（服务端搜索/摘要），届时另立冷层方案而非替换现有路径。
>
> 测试：`useAcpChat.midturn.test.tsx` 8 条（前缀恢复 4 种守卫 + 回写门控 3 条路径）。局限：被驱逐的**结构**（thought/tool 卡片）仍不可恢复，只有正文以纯文本补回——帧窗口是崩溃恢复兜底，不是历史存档，此定位不变。

---

## 勘误（2026-10-10）：前端 live 帧缓冲**不采用** Phase 2 的「先裁再入」原则

**触发**：修「长时间离开浏览器后假死」时给前端实时帧缓冲 `liveBuffer` 加限界（`frontend/src/utils/liveBuffer.ts`），其中「单条 action 自身超字节预算时仍整条入队、峰值 = 一条」与本文 Phase 2 实施说明第 3 条（「单个 chunk 自身超预算时要先裁再入缓冲。先推整段再修剪会让内存峰值等于 chunk 大小，上限形同虚设」）方向相反。按写作纪律就地记录偏离与理由，不默默改掉。

**为什么不裁**：

1. **裁的对象不同**。Phase 2 裁的是**累积器窗口**（落库 / 快照路径），裁完可用中段省略标记（`…（已省略 N 字符）…`）保住「头尾 + 语义完整」；live 缓冲里的 prose 是**用户正在看的那一条消息**，裁它会让屏幕上的正文永久缺一段，且没有可恢复的副本——DB 侧由后端 `MAX_TEXT_BYTES` 独立限界，两边裁在不同位置只会更乱。
2. **省不下峰值**。`JSON.parse` 在进入本缓冲之前就已分配了数倍内存，缓冲内裁剪只影响缓冲自身那一份。

**明示的边界（不是"已有防线"）**：live 路径的单帧体积**没有应用层门禁**——后端 `forward_session_update` 原样转发，`MAX_FRAME_BYTES` 只约束累积器窗口；唯一的硬帽是 axum 传输层默认的 64MiB WS 帧上限。`liveBuffer` 只对「**累积**」负责（条数 2000 / 字节 2 MiB 双上限 + 越界即 flush）。

**翻盘条件**：若实测出现单条 live 帧即数十 MB（当前确证的是 codebuddy 4.5KB/帧量级的重复 `rawInput`），正确修法是在后端 live 转发侧加帧帽（与 `MAX_FRAME_BYTES` 同源），而非在前端缓冲里裁——届时本勘误对应的「峰值 = 一条」取舍随之取消。

## 文档闭环

| 文档 | 更新触发 |
|---|---|
| `docs/architecture/backend.md` | Phase 0（sync 匹配语义）、Phase 1（blocks 两态收敛时机）、Phase 2（text 限界）、Phase 4（会话上限） |
| `docs/architecture/frontend.md` | Phase 1（prompt_done 回写）、Phase 3（触顶锁与阈值口径） |
| `docs/dev/performance-and-safety.md` | Phase 2（§P1 新增无界项收口）；Phase 0 若定性为容量/正确性缺陷则补案例索引 |
| `docs/dev/debug-patterns/` | Phase 0 的"匹配键不唯一导致批量误更新"值得提炼为模式（与"上限维度选错""淘汰轴选错"同族：**键/轴选错等于没有约束**） |
| `CHANGELOG.md` | 每个 Phase 一条，带 scope tag 与 `(YYYY-MM-DD HH:MM)` 时间戳 |
| 本文件 | 实施中发现偏差就地加「勘误」块（PLAN-TEMPLATE 写作纪律 §3），不要默默改掉 |
