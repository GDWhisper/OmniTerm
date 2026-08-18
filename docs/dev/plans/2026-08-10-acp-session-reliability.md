# ACP 会话可靠性加固：存储限界与数据正确性

> 状态：Phase 0 / Phase 1 / Phase 2 已实施（2026-08-11 起，提交 `2d18fa1` 起）；Phase 3-4 待办
> 触发条件：修改 `src/acp/turn_accumulator.rs`、`src/acp/chat_persistence.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx` 中任一项前必读
> 关联：`docs/reference/chat-history-loading-comparison.md`（三方参考实现对比与实测数据）、`docs/dev/performance-and-safety.md` §P1/§P2/§P5、`docs/architecture/backend.md`（blocks 两态）、`docs/dev/plans/2026-07-28-pty-engine-implementation.md`
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
| 测试 | 后端单测：同一会话两条 text 相同但 id 不同的 assistant 行，sync 后各自 blocks 独立（当前实现会失败——先写测试复现，见 `docs/dev/plans/2026-07-24-quality-gates.md` 的 TDD 约定） |
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

| 项 | 内容 |
|---|---|
| 改动 | `frontend/src/components/Chat/ChatView.tsx`：`handleScroll` 与 `loadOlderHistory`（含 `TOP_LOAD_THRESHOLD_PX`、`prependAnchorRef` 一带） |
| 测试 | 前端单测覆盖：停在顶部时不连续触发第二次加载；离开顶部再回来可再次触发 |
| 验收 | 手动回归：长历史会话滚到顶只加载一页，滚开再回来才加载下一页；阅读位置不跳动 |

### Phase 4（P4）— 会话数上限

| 项 | 内容 |
|---|---|
| 改动 | 会话创建路径 + `src/api/sessions.rs`；常量命名上限；淘汰按 `created_at` |
| 阻塞点 | **淘汰语义需先与维护者确认**（见 D5：不删 `sessions` 行，倾向只清 `blocks` 或标记归档）——涉及用户可见数据消失，不得自行决定 |
| 验收 | 单测：超限时淘汰的是 `created_at` 最早的；淘汰后 `sessions` 行仍存在（若采纳归档语义） |

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

## 文档闭环

| 文档 | 更新触发 |
|---|---|
| `docs/architecture/backend.md` | Phase 0（sync 匹配语义）、Phase 1（blocks 两态收敛时机）、Phase 2（text 限界）、Phase 4（会话上限） |
| `docs/architecture/frontend.md` | Phase 1（prompt_done 回写）、Phase 3（触顶锁与阈值口径） |
| `docs/dev/performance-and-safety.md` | Phase 2（§P1 新增无界项收口）；Phase 0 若定性为容量/正确性缺陷则补案例索引 |
| `docs/dev/debug-patterns/` | Phase 0 的"匹配键不唯一导致批量误更新"值得提炼为模式（与"上限维度选错""淘汰轴选错"同族：**键/轴选错等于没有约束**） |
| `CHANGELOG.md` | 每个 Phase 一条，带 scope tag 与 `(YYYY-MM-DD HH:MM)` 时间戳 |
| 本文件 | 实施中发现偏差就地加「勘误」块（PLAN-TEMPLATE 写作纪律 §3），不要默默改掉 |
