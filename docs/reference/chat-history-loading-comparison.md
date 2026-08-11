# 聊天历史加载：参考实现对比

调研日期 2026-08-10。对象与版本：`claudecodeui` @ `015e892`（**AGPL-3.0-or-later，只看设计不抄代码**）、`openchamber` @ `83acecde`（MIT）、`obsidian-agent-client` @ `7eea4ca`（Apache-2.0，**同为 ACP 客户端，最可对照**）。

背景：OmniTerm 的 `GET /sessions/{id}/messages` 已改为游标分页（见 `docs/architecture/backend.md`）。本文记录两个同类项目的做法、**它们与我们的处境差异**，以及待借鉴项。

## 最重要的结论：正文限界这件事没有先例可抄

**两个项目都没有对消息正文做存储层截断**，但原因不是他们找到了更优雅的办法，而是**他们没有这个问题**：

| | 谁拥有聊天历史的写入端 | 于是「单条消息能多大」由谁决定 |
|---|---|---|
| claudecodeui | 不拥有 —— 只读 Claude Code 写的 `~/.claude/projects/**/*.jsonl` | Claude Code |
| openchamber | 不拥有 —— 由上游 opencode server 托管，客户端经 SDK 取 | opencode server |
| obsidian-agent-client | 拥有（写 vault 里的 transcript JSON），但**存 cooked 不存原始帧**，见下节 | 折叠后的产物，天然小 |
| **OmniTerm** | **拥有** —— `turn_accumulator` 自己累积并写 SQLite | **我们自己** |

所以 `turn_accumulator` 的 `text` 列无界累积（`st.text.push_str()`）是我们独有的责任，抄不到答案，阈值和截断策略只能自己定。同理 `MESSAGES_PAGE_MAX_BYTES`（每页字节预算）在两者中都不存在——**因为它们都只是客户端，只能传 `limit` 条数，无法按字节切页**。拥有服务端是我们的优势，不是多余的复杂度。

## 最有价值的对照：存 cooked 还是存原始帧

obsidian-agent-client 存 **cooked** 产物（`MessageContent[]` 联合类型：text / agent_thought / tool_call / plan / …，`src/types/chat.ts:137-157`），不存原始 ACP 帧。我们相反：`blocks` 存 `{"v":1,"frames":[...]}` 原始帧，前端复用 live 分类器还原（理由见 `docs/architecture/backend.md`：杜绝 TS/Rust 双份分类）。

这个取舍现在可以量化了。查本地两个库的 `blocks` 格式分布（2026-08-10）：

| blocks 格式 | dev 库 | preview 库 | 单行最大 |
|---|---|---|---|
| cooked（已被 `sync_messages` 覆盖，形如 `[...]`） | 49 行 | 7 行 | 114 KB / 91 KB |
| 原始帧（从未被覆盖，形如 `{"v":1,"frames":...`） | 8 行 | 6 行 | 607 KB / **9,150,950 字符** |

**所有超大行都是「原始帧、从未被 cooked 覆盖」的行；cooked 行最大只有 114KB。** 同一份数据差两个数量级——因为 cook 会把 2000 个 `tool_call_update` 折叠成 2 个 `tool_call`（每帧重复携带的 `rawInput` 副本在折叠后只剩一份）。

于是 blocks 膨胀的根因有了更准确的表述：**不是「缺少上限」，而是「原始帧这个中间状态可能永久留存」**。`sync_messages` 会用前端 cooked blocks `UPDATE` 覆盖（`chat_persistence.rs:214`），是天然的收敛机制，但它**只在 `replay_end`（用户手动 restore）时触发**，所以没做过 restore 的行永远停在原始帧状态。

据此，比「压缩存储」或「截断」更根本的方向是：**让 turn 结束时就落 cooked**。前端已有完整路径（`messagesToSyncPayload` → `sync_messages`），只缺一个触发点（`prompt_done` 时也 sync，而非只在 `replay_end`）。注意两点：
- 窗口字节上限（`MAX_BLOCKS_BYTES`）**仍然必需，不能撤** —— 前端不在线时（用户关了浏览器而 agent 继续跑）没人 cook。
- 代价是失去「分类器升级后重新解释历史」的能力。obsidian-agent-client 证明存 cooked 是可行的主流选择。

## 会话级限界：第三个维度

obsidian-agent-client 限的不是单条消息、也不是每页，而是**保存多少个会话**：`MAX_SAVED_SESSIONS = 50` + LRU 淘汰（`src/services/session-storage.ts:65,74-88`）。我们的 `sessions` 表无上限——这是一个我们尚未覆盖的维度。

两个实现细节值得直接借用：

1. **淘汰轴必须与读取/排序轴一致**。他们的注释写明：读取与 UI 都按 `updatedAt` 排序，所以淘汰也必须按 `updatedAt` 挑最旧的，「a positional `pop()` would drop an old-inserted entry that is still in active use」（`session-storage.ts:68-71`）。这与我们踩过的「上限维度选错等于没有上限」是同族规律：**淘汰轴选错等于淘汰错对象**。（我们 `turn_accumulator` 的 `VecDeque` 队首淘汰 = 插入序 = 帧序 = 读取序，轴一致，无此问题。）
2. **淘汰只删索引，正文留作归档**：「Eviction removes only the index entry: the transcript file under `sessions/` is intentionally kept as an archive」（同处）。且 `saveSessionMessages` 会把索引条目快照写进 transcript 文件本身，使被淘汰的会话仍保有 cwd/title/timestamps 以供将来搜索或恢复（`session-storage.ts:337-372`）。**这就是「冷藏」的一个成熟实现：从活跃索引移除 ≠ 删除数据。**

## 写入策略：他们是我们的反面

| | OmniTerm | obsidian-agent-client |
|---|---|---|
| 写入时机 | turn 进行中，防抖 250ms / max 1s | **turn 结束才写一次**（`saveSessionMessages`） |
| 写入粒度 | `UPDATE` 单行（一行 = 一 turn） | **全文件重写整个会话的全部消息** |
| 单 turn 内重写放大 | O(n²)（`text` 无上限时） | 无 |
| 会话级重写放大 | 无 | O(m²)，m = turn 数 |
| 崩溃损失 | ≤250ms（`status='streaming'` + 启动自愈） | **整个进行中的 turn** |
| 并发写 | 行级 `UPDATE`，天然无竞态 | 两个写者都全文件重写，必须 `sessionLock` 串行化，否则「rename racing a turn end could overwrite newer messages」（`session-storage.ts:330-335`，真实踩坑注释） |

结论：**我们的存储粒度（一行一 turn）优于全文件重写**，两类放大只能选一个的话，行级 `UPDATE` 更好。他们的 turn-end 单次写值得学的是「不在 turn 进行中反复重写同一份全量数据」这个原则——但我们靠防抖 + 行级粒度已部分实现，真正的缺口只在 `text` 列无上限。

## 分页策略对比

| 维度 | claudecodeui | openchamber | OmniTerm |
|---|---|---|---|
| 分页方式 | `offset` + `limit` 数组切片（`claude-sessions.provider.ts:188-190`） | `limit` + `before` 游标，游标从响应头 `x-next-cursor` 取（`session-message-loader.ts:588,610`） | `limit` + `before` 复合游标 `(created_at, id)` |
| 首屏页大小 | 20（`useChatSessionState.ts:13`） | 50，受限运行时（VSCode / mobile）30（`session-message-loader.ts:21-22`） | 100 |
| 往前翻页 | 20/页 | 100/页（`session-message-loader.ts:23`） | 100/页 |
| 字节预算 | 无 | 无 | 2 MiB/页 |
| 触顶阈值 | `scrollTop < 100`px（`useChatSessionState.ts:386`） | **1.5 个视口高度**（`MessageList.tsx:85,991`） | 200px |

**claudecodeui 的 offset 分页是反面教材**：`ln()` 先把整个 jsonl 读进内存并排序，再 `slice(total-offset-limit, total-offset)`（`claude-sessions.provider.ts:180-190`）。分页只减少了传给前端的量，没减少读取+解析的量；且 offset 从最新端计数，新消息到来后同一 offset 指向不同消息。我们选游标而非 offset 正是为避开这两点。

## 值得借鉴的三个机制

1. **触顶滞后锁（hysteresis）** — claudecodeui 用 `topLoadLockRef`，且要求 `scrollTop > 20` 才解锁（`useChatSessionState.ts:407`）。我们目前只有 `loadingHistory` 防重入：请求落定后若用户仍停在顶部，下一个滚动事件会立刻触发下一页，**连续翻页可能失控**。
2. **阈值用视口比例而非固定像素** — openchamber 的 `HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5`（`MessageList.tsx:85`）。固定 200px 在大屏/小字号下相当于很短的距离，在手机上又偏长。
3. **加载窗口与渲染窗口分离** — claudecodeui 的 `INITIAL_VISIBLE_MESSAGES = 100` 独立于每页 20 条，`visibleMessageCount` 控制渲染多少条（`useChatSessionState.ts:14,118`）。我们目前加载多少就渲染多少。

## openchamber 的两个精细设计（移动端相关）

- **首屏页扩张至包含一条 user 消息**：先取 50 条，若该页既未取完历史又不含任何 user 消息，则依次扩张到 100、150（`INITIAL_PAGE_EXPANSION_LIMITS`，`session-message-loader.ts:24,531-551`），**且在找到边界前不 commit**（`deferFirstCommit`）。理由：首屏若只有 assistant 回答而看不到对应提问，上下文是断裂的，用户看不懂。纯条数/字节预算切页会产生这种断头页。
- **惯性滚动期间推迟前插落地**：触摸手势活跃且不在近顶部时，前插的新内容先 hold，等滚动静止 `HISTORY_PREPEND_QUIET_MS = 160` 后再落地，最多推迟 `HISTORY_PREPEND_MAX_HOLD_MS = 1500`，用 90ms 轮询检测静止窗口（触摸惯性没有完成事件可 await）（`MessageList.tsx:83-86,996-1028`）。这是移动端专属问题：惯性滑动中途改变内容高度会跳飞。

## 分页架构的必然代价：搜索需要全集

claudecodeui 在「跳转到搜索命中的历史消息」时不得不 `limit: null` 全量加载并 `setVisibleMessageCount(Infinity)`，还硬编码 `setTimeout(300)` 等渲染完成（`useChatSessionState.ts:636-650`）。我们将来做历史搜索会撞上同一个问题——**搜索要么在服务端做（返回命中位置的游标，然后定向翻页），要么被迫全量加载**。前者是正确方向，记在这里以免届时重新踩。

## 三个项目一致的一件事：截断必须明示

- openchamber：加载时剥离 diff 快照（`stripMessageDiffSnapshots`，`sanitize.ts:166`）、丢弃噪音 part（`SKIP_PARTS`，`session-message-loader.ts:20`）
- obsidian-agent-client：wikilink 超出硬顶时输出 `<links truncated="N">` 显式标注省略了多少（`wikilink-formatter.ts:16,50-51`）；入口侧限注入给 agent 的笔记内容 `DEFAULT_MAX_NOTE_LENGTH = 10000` 字符（`message-sender.ts:166-167`），但**输出侧（agent 回答）不截断**
- claudecodeui：未找到消息正文截断

若我们将来对 `text` 做限界，**中段折叠 + 显式标注省略量**是三个项目里唯一被印证过的交代方式（静默丢弃无人采用）。

## 压缩事件（compaction）：三个项目都不感知

ACP v1.4 的 `SessionUpdate` 13 个变体里没有 compaction 通知（`agent-client-protocol-schema-1.4.0/src/v1/client.rs:99-139`），最接近的是 `UsageUpdate { used, size, cost }`（同文件 `:302-311`）。三个项目对它的处理：

- obsidian-agent-client：只转发给 UI 展示（`acp-handler.ts:141-149`）
- openchamber / claudecodeui：未做压缩推断
- OmniTerm：前端已解析进 `chatState.usage`（`useAcpChat.ts:429`），后端不感知

也就是说「用 `used` 骤降推断压缩发生」没有先例。**而且并不需要**：实测那条 12.85MB 的原始帧 blocks 用 gzip -6 压到 113.5KB（116x）、zstd -19 压到 40.4KB（333x）——熵极低（>97% 是同一份 `rawInput` 副本）。既然无损压缩就能解决体积，就不需要「何时可以安全丢弃」这个判断，也就不需要压缩事件感知。压缩事件更适合作为**用户可见的时间线标记**（"此前内容 agent 不再直接引用"），那是 UI 功能而非存储优化。
