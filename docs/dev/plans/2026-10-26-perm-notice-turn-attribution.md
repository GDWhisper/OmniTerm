# 权限超时告知的 turn 归属：pin 化内联帧 + 归位过程容器

> 状态：已实施（2026-10-26）
> 触发条件：修改 `src/acp/turn_accumulator.rs`（帧窗口驱逐 / `append_host_update`）、`src/acp/chat_persistence.rs`（`insert_message` / `ChatMessageRow` 读口）、`src/acp/reaper.rs`（`persist_system_row`）、`src/acp/client.rs`（turn 行 id 暴露）、`frontend/src/stores/chatStore.ts`（`dropInlinedSystemMessages` 邻域 / system 行归块）、`frontend/src/utils/storedMessages.ts` 任一项前**必读**
> 关联：`docs/dev/plans/archive/2026-09-21-permission-timeout-modes.md`（10-18 勘误的双轨告知即本计划的修复对象）、`docs/dev/plans/2026-09-19-acp-failure-visibility.md`（10-18 勘误同题）、`docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md`（10-18 勘误：合并后 noticeId 收敛）、`docs/architecture/backend.md`（blocks 两态 / mid-turn 告知内联段）、`docs/dev/performance-and-safety.md` §P1（pin 区上限红线）

## 背景

正式库会话 `1362afb6`（agent_title=Port Forward Security，preset-qoder）：第二回合 28 分钟（14:34:07→15:02:30），41 条权限超时自动放行的 `role='system'` 行按时间序沉在消息流底部，agent 最终输出（在该回合 assistant 行末尾）被顶到上方不可见。数据证据：assistant 行 `created_at=14:34:07`（turn 级一行、时间戳锚定首次落库，`upsert_streaming_message` 的 `ON CONFLICT DO UPDATE` 不动 `created_at`），41 条 system 行 `created_at` 分布 14:34:11–15:02:09，按 `created_at` 排序（`list_messages_page`）后全部晚于 assistant 行。

2026-10-18 的「内联 + 独立行兜底 + noticeId 去重」双轨已防过此问题（backend.md 明载实测「15m22s 的 turn 后跟 54 条 system 行」），但保护被自身目标场景打穿：

1. 内联 notice 帧进的是**有界帧窗口**（`MAX_FRAMES=2000` / `MAX_BLOCKS_BYTES=128KB`），长 turn 下被驱逐——`persist_system_row` 注释自认独立行是「帧窗口有界驱逐时」的兜底。
2. 帧被逐出后 assistant 行 blocks 解不出 `noticeId` → `dropInlinedSystemMessages` 按设计保留独立行（「宁可在列表位置上回落」）→ 回落 = 沉底。
3. 本案实测该 turn 行 blocks 的 `omnitermSystem`/`noticeId` 出现次数均为 0（内联帧全被逐出），41 条独立行全量展示。

## 范围与优先级

- **P0（A1）**：内联告知帧 pin 化——不参与常规驱逐，长 turn 下去重依据不丢。
- **P0（A2）**：独立 system 行落库带 `turn_row_id` 归属 + 前端归块进对应 turn 的过程容器；历史无归属行按「permTimeout 且时间落在 turn 区间内」启发式归块。
- **不纳入（理由）**：
  - 改消息排序键（assistant 行用 `finished_at` 排序）——破坏流式追加语义（live 中该行持续生长，`created_at` 锚定是「一行一 turn」的必然结果），且 system 沉底只是症状。
  - B1「同类告知折叠组」——归块后告知已随过程容器折叠（2026-10-18「SYSTEM 跟随工作块折叠」既有语义），再做一层聚合是重复设计；历史数据由启发式归块覆盖。
  - 给 blocks 内块加时间戳做精确时序插位——告知块只能近似插到「结论前过程区末尾」；精确时序需要帧级持久化时间轴，代价不成比例。翻盘条件：用户明确要求告知出现在 turn 内精确时点。
  - 删除/合并 DB 里的独立 system 行——它们是 durable 兜底（帧窗口 pin 也有上限），删了就是数据丢失。
  - 无 `turn_row_id` 且 label 非 `system.permTimeout.*` 的行（turn 失败 / 回收终态告知）不归块——终态告知必须留在消息流可见位（`ChatMessage.tsx`「独立 system 消息不进过程容器」约束）。

## 设计决策 / ADR

**D1 pin 化 = 帧窗口内豁免驱逐，不另立存储区**：`frames` 条目加 `pinned` 标志（`append_host_update` 的告知帧置位）。常规驱逐从头找第一个非 pinned 帧移除（时序天然正确，`wrap_frames` 零改动）；pinned 独立预算 `MAX_PINNED_NOTICES=64` + `MAX_PINNED_BYTES=64KB`，超限淘汰最旧 pinned 并 warn（回退到独立行兜底 + D2 归块，语义闭环）。
- 理由：另立 pin 区再按 seq 归并回窗口是重复设计；「参与窗口但豁免驱逐」保持位置正确性。
- 红线（P1）：pin 区是累积结构，必须条目 + 字节双上限 + 超限策略 + 单测（单条 notice 帧大小由请求 options/content 决定，只限条目数等于没限）。
- 否决项：pinned 无界常驻（案例 3「兜底字段就是缺口」）；pin 帧永不出窗（违背 `MAX_BLOCKS_BYTES` 的 I/O 有界承诺）。

**D2 归块条件与位置**：纯函数 `relocateOrphanSystemMessages`（与 `dropInlinedSystemMessages` 同处同入口：hydrate / 上拉前插 / `turn_snapshot` / 聚焦补拉合并后）。
- 归块条件（命中其一）：① system 行 `turnRowId` 命中某 assistant 行 `dbId`；② 历史行（`turnRowId` 空）且 label 前缀 `system.permTimeout.` 且 `created_at ∈ [turn.created_at, turn.finished_at]`（`finished_at` NULL 的老 turn 不匹配，保守保留独立行）。
- 归块动作：system 块插入该 assistant 行 blocks 的**最终 text 块之前**（过程区末尾，多条按 `created_at` 序）；独立行从消息列表移除。同 `noticeId` 已在 blocks 时跳过（幂等，与 `dropInlinedSystemMessages` 协作：先归块再去重）。
- 位置近似是知情取舍（见「不纳入」第三条）：过程区末尾 ≫ 沉底，且随过程容器折叠符合 2026-10-18 语义。
- 历史启发式只对 `system.permTimeout.*` 白名单生效（非黑名单）：未来新增告知类型默认走 `turnRowId`，历史行只有 permTimeout 有归块收益，白名单面更小。
- 否决项：消息列表层重排（按 turn 分组排序）——不动 blocks 就不进过程容器，折叠语义不成立；live 路径改动——`appendSystemBlock` 已内联，仅 hydrate/补拉路径需要归块。

**D3 `turn_row_id` 列通用、无索引**：`chat_messages.turn_row_id TEXT` 可空（NULL = 无归属 / 历史行 / 非 mid-turn 告知）。`persist_system_row` 落库时从 `AcpClient` 取当前 turn 的 `row_id`（`append_host_update` 已返回它，accumulator 内部已知）；无活跃 turn 时 NULL。查询模式是「会话内按行 id 内存分组」，不走 SQL 过滤 → 不建索引（奥卡姆）。
- 翻盘条件：出现按 `turn_row_id` 跨会话检索的需求再补索引。

**D4 读口按 camelCase 透传**：`ChatMessageRow`/分页/定位页/搜索读口加 `turn_row_id`，serde `rename_all = "camelCase"` 自动出 `turnRowId`；前端 `StoredMessage`/`ChatMessage` 加可选 `turnRowId`，`toChatMessages` 透传。禁手工 `json!` 映射（backend.md 既有约束）。

**D5 翻盘条件汇总**：pin 预算（64 条 / 64KB）不够用的信号 = warn 日志出现 pin 淘汰且用户反馈告知仍沉底 → 提预算或改 D2 位置策略；启发式误归块的信号 = 终态告知被折进容器 → 收窄白名单或给 system 行加 kind 枚举列（另立）。

## 多实现差异（AGENTS §8）

| 项 | 差异事实 | 兜底 |
|---|---|---|
| 权限请求 options 的 kind | 可能只给 `other`/自定义 name（permission-timeout 计划 D5） | 不影响本计划：归块只看 label 前缀，不解析 detail |
| 告知帧形态 | `_meta.omnitermSystem` 合成 `session_info_update`；无活跃 turn 时走 `system_message` 独立帧 | 后者本就无 turn 归属（`turnRowId` NULL + 不进帧窗口），保持独立展示，行为不变 |
| `session_info_update` 是否被 agent 占用 | 帧字段 `meta` 由宿主合成，与 agent 的 `SessionInfo.title` 等共存 | pin 标志只对宿主注入帧置位，agent 帧一律参与常规驱逐 |

## 实施分期

**Phase 1（后端）**：migration `20261026_add_chat_message_turn_row_id.sql` → `turn_accumulator.rs`（帧条目 pinned 标志 + 双上限 + 驱逐跳过 + 单测）→ `chat_persistence.rs`（`insert_message` 加参、读口透传）→ `client.rs`（`current_turn_row_id()`）→ `reaper.rs`（`persist_system_row` 传归属）。依赖：无。

**Phase 2（前端）**：`utils/storedMessages.ts`（`turnRowId` 透传）→ `chatStore.ts`（`ChatMessage.turnRowId`、`relocateOrphanSystemMessages` 纯函数 + 四个统一入口接线）。依赖 Phase 1 读口。

**Phase 3（测试与文档）**：见验收清单；`CHANGELOG.md` Fixed；backend.md（mid-turn 告知内联段补 pin + 归属）、permission-timeout-modes 勘误块、AGENTS 文档索引登记本文件。

## 验收标准 / 验证清单

- [x] `./dev.sh test` 全过；pin 驱逐单测：常规驱逐跳过 pinned、pin 超限淘汰最旧、双上限断言（P1 三问）——`pinned_notices_survive_regular_eviction` / `pinned_budget_evicts_oldest_pinned` / `pinned_budget_evicts_on_bytes_too`
- [x] 后端单测：`insert_message`/读口 roundtrip `turn_row_id`（`turn_row_id_roundtrips_through_read_paths`，含定位页）；有活跃 turn 时写入 row_id 的端到端断言落在 `fake_agent_tests::always_auto_mode_answers_permission_on_arrival_not_next_tick`（断言 system 行 `turn_row_id` == assistant 行 id）
- [x] 前端单测 `relocateOrphanSystemMessages`：①归属命中归块并移除独立行 ②历史 permTimeout 区间匹配归块 ③`system.turnFailed.*` 不归 ④`finished_at` NULL 不归 ⑤同 noticeId 幂等 ⑥先归块后 `dropInlinedSystemMessages` 不重复
- [x] `pnpm test`（1526 全过）/ `pnpm exec tsc -b` / `pnpm lint`（0 errors，18 项存量 warning 与改动前一致）/ `pnpm build` 零新增告警
- [ ] 手动回归（dev 实例，需维护者执行）：长 turn + 多次权限超时（临时调小 `acp_perm_timeout_secs`）→ 告知随过程容器折叠、消息流底部为最终输出；刷新后形态一致
- [ ] 历史数据回归（只读）：对正式库该会话形态的 fixture（或 dev 复制库）跑归块，41 条告知进容器

## 实施勘误（2026-10-26）

- **D2 的落库顺序依赖**：`persist_system_row` 取 `turn_row_id` 必须发生在内联帧写入**之后**——`append_host_update` 才是惰创建 turn 行 `row_id` 的地方（告知先于首个可见帧到达的场景），先落库会拿到 `None` 归属。`persist_and_broadcast` 因此改为「先内联/广播、后落库」；`auto_advance_permissions` 路径本就先 `resolve_permission_with_notice` 再落库，只需补读 `current_turn_row_id()`。功能等价（落库与广播顺序互不影响「告知先于 agent 后续输出」的有序通道保证），但顺序是归属正确性的前提——改回调用点时勿反转。
- **归属验证的落点**：计划原文写「后端单测 `persist_system_row` 有/无活跃 turn」，实际落为 `fake_agent_tests` 端到端断言（走完整 `resolve_permission_with_notice` 链路，比 mock `persist_system_row` 参数更真实）+ `chat_persistence` 的读口 roundtrip；无活跃 turn 时 `None` 归属由 `current_turn_row_id()` 的类型与 `turn_row_id` 可空语义保证，未单独造用例（奥卡姆）。

## 风险与文档闭环

| 风险 | 缓解 |
|---|---|
| pin 区变相无界 | 双上限 + 淘汰最旧 + 单测（D1 / P1） |
| 启发式误归块 | 白名单 `system.permTimeout.*` + `finished_at` 区间 + NULL 保守（D2） |
| 归块位置近似（不在真实时点） | 知情取舍（「不纳入」）；翻盘条件已列 |
| 归块与 cooked 回写交互 | 归块只动 store 呈现层；assistant 行 blocks 回写仍走 `messagesToSyncPayload`（system 块随 blocks 持久化后 `noticeId` 去重自动收敛），`would_drop_inline_notices` 守卫语义不变 |

- `CHANGELOG.md`（Fixed）
- `docs/architecture/backend.md`（blocks 两态 / mid-turn 告知段）
- `docs/dev/plans/archive/2026-09-21-permission-timeout-modes.md`（勘误块指向本计划）
- `AGENTS.md` 文档索引（本文件登记行）
