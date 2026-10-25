# 离开浏览器后「假死」残余项：可见反馈与错峰

> 状态：**P1（①②③）与 P2 小项（④⑨）已实施**（2026-10-25，实施记录见文末）；⑤⑥⑦⑧ 未实施（见文末「未实施项」）
> 触发条件：改 `useAcpChat.sendPrompt` 的失败路径、`ChatView` 聚焦补拉的触发时机、`chatStore.mergeLatestMessages` 的扫描预算、`FileEditor` 内建搜索、侧栏/健康检查轮询矩阵，或推进终端 WS 侧心跳前**必读**
> 关联：`docs/dev/plans/2026-09-19-ws-idle-disconnect-heartbeat.md`（Phase 1 已部分落地，文末勘误）、`docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md`（10-10 勘误）、`docs/dev/performance-and-safety.md` §P1/§S2、`docs/architecture/frontend.md`

## 背景

2026-10-10 用户报告「长时间离开浏览器，omniterm 假死」。拆出两条根因，**P0 已修**：

| # | 根因 | 状态 |
|---|---|---|
| A | `liveBuffer` 只由 rAF flush，隐藏页不派发 rAF 而 WS 帧照常到达 ⇒ 缓冲无界累积，回来一帧吐完半天 | ✅ `utils/liveBuffer.ts` 限界 + 1s 兜底定时器 |
| B | ACP WS 无心跳，空闲 ~125s 被重置且冻结页不补派 `onclose` ⇒ 前端握死 socket 而不自知 | ✅ `src/ws/acp.rs` ping/pong + 前端半开检测 + 隐藏期停发/挂起重连 |

修完 P0 后**仍存在的三个用户可感缺口**，以及两项预防性收尾，即本计划范围。共同特征：都不是「内容丢失」，而是**恢复时刻的成本与可感知性**。

## 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P1 | ① `sendPrompt` 静默失败 |  socket 不可用时用户**看得到**失败，不再「打字毫无反应」 | 小（1 文件 + 单测） |
| P1 | ② 回来那一刻三件事错峰 | flush / 聚焦补拉 GET / 合并不要挤在同一帧 | 中（1 文件 + 单测） |
| P1 | ③ 合并扫描预算显式化 |  `mergeLatestMessages` 的前缀对账有与 replay 同源的显式上限 | 小（1 文件 + 单测） |
| P2 | ④ FileEditor 搜索防抖 |  大文件上每次按键不全文档扫描 | 小 |
| P2 | ⑤ 轮询矩阵收敛 |  3s/5s/10s/10s 四条轮询并成单一 ticker，隐藏期暂停 | 中 |
| P2 | ⑥ 终端 WS 侧心跳 |  心跳计划 D3 的另一半（终端可见态意外断开且无 onclose） | 中 |
| P2 | ⑦ Phase 0 四格探针 |  判定 H1–H4 归属（诊断项，不阻塞其他） | 中（需公网环境） |
| P2 | ⑧ WS 集成测试脚手架 + ping/pong handler 级用例 |  本仓无任何 WS 集成测试（`tests/` 三个文件都是内部函数级）；补一套「起 Router + 临时库 + WS 客户端」设施（端口/库目标须满足 §S6），把 `2026-09-19-ws-idle-disconnect-heartbeat.md` 验收标准里的「后端单测（收到 ping 回 pong）」从「仅线格式 serde 单测」补成行为级 | 大（新设施） |
| P2 | ⑨ 两处 HEAD 起就有的边界（本次未触碰、未恶化） |  a) `preHydrateBuffer` 是无 cap 数组（窗口 = 一次 `GET /messages`，hydrate 落定前同批帧在此二次累积）；b) cleanup 里 `flushLiveBuffer()` 读 `sessionIdRef.current`，而该 ref 在 render 期已被赋成新 sessionId——切会话时旧会话残留动作理论上会落进新会话 store | 小（各 1 处 + 单测） |
### 不纳入范围

| 排除项 | 理由 |
|---|---|
| 虚拟滚动 / 消息列表窗口化 | 分页已把首屏压到 2MiB 内；①–③ 落地后重测，若仍卡再评估（`2026-08-10` 计划已列为「待 P1-P4 后评估」） |
| 服务端 per-session 通知补发（seq 账本） | refocus 计划 D2 已否决（新增服务端状态 + 与 DB 副本重复） |
| 改 cloudflared / 反代超时 | 未证实前不碰运维配置（心跳计划原结论不变） |
| `blocks` 压缩存储 | `2026-08-10` 计划已留作后备方案，体积已从源头降两个数量级 |

## 设计决策 / ADR

### ① D1：`sendPrompt` 失败必须留下可见痕迹，且不改变「成功才乐观」的既有语义

**现状**：`useAcpChat.sendPrompt` 首行 `if (!ws || ws.readyState !== WebSocket.OPEN || …) return`——静默。用户侧表现：输入框能打字、回车后毫无变化，与「假死」完全同形。这是 AGENTS §S2（禁吞异常掩盖症状）在前端的对应形态：**不是 try-catch 吞异常，而是卫哨条件吞掉了整个失败语义**。

**决策**：卫哨失败时按「原因分档」落一个用户可见状态，且**不**插入用户气泡（那会让历史里多一条从没发出去的消息）：

- 无 socket / 非 OPEN → `chatStore.setError(sid, <i18n key>)`，文案区分「连接已断开，消息未发送」与「正在重连，稍候重发」；
- 参数为空（无文字无附件）→ 保持静默 return（这是正常的用户输入守卫，不是失败）。

**否决项**：
- *自动重试排队*——把消息塞进 `queuedMessage` 看起来更贴心，但该槽位的语义是「agent 忙碌期的下一条」，与连接恢复混用会让 N=1 语义和 drain 时序都要重新论证（`CONTEXT.md` 队列术语）。翻盘条件：若实测「用户回来第一件事就是重打」占比高，再评估自动入队。
- *toast*——错误状态已有连接态指示 + store error 渲染路径，toast 是第三条通道，容易和既有的断连留痕（`sending→error`、`undelivered`）重复打扰。

**翻盘条件**：若 P0 的心跳已让「可见态握死 socket」几乎不可能，则本项退化为纯兜底，仍保留（成本一行）。

### ② D2：回来那一刻的成本要错峰，不是合并

**现状**：`visibilitychange→visible` 同一帧内可能发生：`flushLiveBuffer`（隐藏期积压 + 兜底定时器残留）→ `catchUpIfNeeded` 的 `GET /messages` → `mergeLatestMessages`（含 `scanTodoBoard` 全列表反向扫描）。三者各自有界，但**串联在同一帧**，且用户的输入事件排在它们后面。

**决策**：把「补拉」从事件回调里挪到一个独立的短延迟任务（`requestIdleCallback` 降级 `setTimeout(0)`），并保证：

- flush 保持同步（它是内容正确性的一部分，且已有上限）；
- 补拉失败/在飞时不影响 flush；
- 上拉加载历史（`loadOlderHistory`）与补拉互斥（同一 `loadingHistory` 语义扩展为「历史在飞」）。

**否决项**：*把 flush 也推迟*——离开期间的输出晚一步出现，用户会觉得「补拉也没用」；且 flush 与 `prompt_done` 的定稿顺序有耦合（`59de90a` 修过的「终态帧先 flush」）。翻盘条件：实测 flush 单批 >100ms 再考虑分批。

**多实现差异（§8）**：`requestIdleCallback` 在 Safari 不存在 → 必须降级；且在移动端「空闲」可能很久不到来（用户正盯着屏幕），故降级用 `setTimeout(0)` 而非死等 idle。

### ③ D3：合并扫描预算与 replay 对齐，防「全失配 O(n×m)」

**现状**：`alignReplaySyncPayload` 的只读扫描有显式预算 `ALIGN_SCAN_BUDGET`（= 后端默认页大小），理由是「上游分页只界住输入，不界住这次计算」。`mergeLatestMessages` 的 rule 3/4 是**同族扫描**（从尾部向前、逐条比较文本），但**没有自己的预算**——它靠「从尾部向前 + 命中即停」控制最坏情况，理论上全失配时仍是 O(merged × store)。

**决策**：抽一个共享的「有界尾部扫描」纯函数（`chatStore` 内），`mergeLatestMessages` 与 `alignReplaySyncPayload` 共用同一预算常量与同一「超限即降级」语义（合并侧降级 = 停止候选匹配、剩余行按 `createdAt` 插入 = 现有安全路径）。

**否决项**：*给合并加独立数字上限*——又一个会和分页预算漂移的常量（`useAcpChat` 文件末「基线 ref 的有界性」已论证过同款反对理由）。

**翻盘条件**：若实测补拉页行数远小于预算导致扫描从未触顶，可只保留共享函数不保留 warn。

## 实施分期

单 Phase，按 ①→②→③ 顺序（③ 是 ② 的前置重构，② 的错峰改的是 ③ 的调用时机）：

| 项 | 改动 | 测试 |
|---|---|---|
| ① | `useAcpChat.sendPrompt` 卫哨分档 + 两个 locale key（zh/en） | `useAcpChat.*.test.tsx`：无 socket / CONNECTING / 空输入三种形态各一条；成功路径不回归 |
| ② | `ChatView` 补拉触发挪独立任务 + 与上拉分页互斥 | `ChatView.catchup.test.tsx` 补：可见后不同步发请求、在飞时再触发不并发 |
| ③ | `chatStore` 抽有界尾部扫描纯函数，两处共用 | `chatStore.catchup.test.ts` / `chatStore.alignreplay.test.ts` 各补超限降级一条 |
| ④ | `FileEditor` 搜索 effect 加 ~150ms 防抖（与 `fileSearch.ts` 的 1 万匹配上限叠加） | `FileEditor.search.test.tsx` 补：连续按键只算一次 |
| ⑤ | 轮询矩阵并单一 ticker（tmux 健康 10s / 外部会话 10s / 侧栏 5s / attention 3s → 一个 1s ticker + 各自相位），隐藏期暂停 | 各组件现有轮询测试改造成注入 tick；新增「隐藏期零请求」一条 |
| ⑥ | 终端 WS 侧心跳（`useTerminal` + `src/ws/terminal.rs` 的 `ClientControl::Ping` 已有定义，只需发送方 + pong 判定） | `Terminal.autoReconnect.test.tsx` 补半开检测一条 |
| ⑦ | Phase 0 四格探针（直连/公网 × 空闲/30s 心跳，各 ≥15min，真实端点） | 结论回写心跳计划；不写代码 |
| ⑧ | WS 集成测试脚手架（`tests/` 新增或扩 `common`：起 `api::routes` + 临时库 + `tokio-tungstenite` 客户端——后者已是直接依赖，入 dev-dependencies 不新增外部件） | ping→pong 行为级一条；脚手架复用性说明 |
| ⑨ | `preHydrateBuffer` 加上限；cleanup 的 flush 改读「本 effect 的 sessionId」而非 ref | 两条边界各自的回归单测 |
## 验收标准

- [ ] ① 三种失败形态各有可见状态；成功路径与排队语义零回归
- [ ] ② 回到可见时不与 flush 抢同一帧；补拉与上拉分页不并发
- [ ] ③ 合并与对齐共用同一预算常量；超限降级路径有单测
- [ ] ④ 大文件（≥1MB）连续输入时主线程无 >50ms 长任务（Performance 录制验证）
- [ ] ⑤ 隐藏 5 分钟后四条轮询各零请求；回来后一次补齐
- [ ] ⑥ 终端可见态断开且无 onclose 时 ≤90s 自愈（用心跳半开检测）
- [ ] ⑦ 四格结论写回 `2026-09-19-ws-idle-disconnect-heartbeat.md`
- [ ] ⑧ ping→pong 有行为级测试（不再只靠 serde 线格式单测）
- [ ] ⑨ 两条边界各有回归单测
- [ ] `pnpm exec tsc -b` / `pnpm lint` / `pnpm test` / `cargo clippy -D warnings` / `cargo fmt --check` 零新增问题

## 风险与降级

| 风险 | 缓解 |
|---|---|
| ① 的错误提示在「正在重连」时误报「未发送」 | 文案分档读 `connectionState`；`connecting` 态提示「重连中」而非「失败」 |
| ② 延迟补拉让用户先看到旧内容一帧 | flush 同步保证内容最新；补拉只补 DB 侧差额（合并幂等） |
| ⑤ 合并轮询改变各组件现有行为 | 保留各自的相位与间隔语义，只换驱动源；逐组件测试先行 |
| ⑥ 终端链路加心跳与 blur/idle 主动拆除打架 | 拆除走 `disposeTerminal`（socket 已关），心跳随 `onclose` 停；半开检测只在 socket 仍 OPEN 时计数 |
| ⑦ 探针仍在非真实链路上跑 | 强制真实端点 + 直连格作对照组（心跳计划 Phase 0 原有纪律） |

## 文档闭环

| 文档 | 更新 |
|---|---|
| `docs/architecture/frontend.md` | ① 失败分档、② 补拉错峰、③ 共享扫描预算、⑤ 轮询矩阵、⑥ 终端心跳 |
| `docs/architecture/backend.md` | ⑥ 终端 WS ping/pong（若落地） |
| `docs/dev/performance-and-safety.md` | ③ 若定性为新的容量面则补案例索引 |
| `docs/reference/archive/user-testing.md` | §24 补「错误可见」「错峰」两条验证点 |
| `CHANGELOG.md` | ①②③ 各一条 Fixed；⑤⑥ 各一条 Changed |
| `2026-09-19-ws-idle-disconnect-heartbeat.md` | ⑦ 的 Phase 0 结论回写 |
| 本文件 | 实施偏差就地加「勘误」块 |

---

## 实施记录（2026-10-25）：①②③④⑨ 已落地

改动文件与测试：

| 项 | 改动 | 测试 |
|---|---|---|
| ③ | `chatStore.ts` 抽 `boundedTailScan`（有界尾部扫描纯函数），`mergeLatestMessages` rule 3/4 用它；预算常量与 `alignReplaySyncPayload` 共用 `ALIGN_SCAN_BUDGET` | `chatStore.catchup.test.ts` 补超限降级 1 条（预算外 echo 即使全等也走插入 + 预算内对照） |
| ② | `ChatView.tsx` 新增 `scheduleCatchUp`（requestIdleCallback 降级 `setTimeout(0)`，`CATCH_UP_IDLE_TIMEOUT_MS=200`，pending 去重 + 卸载取消），挂载/visibility/focus/pageshow/E2 五个触发点全部改走它；`catchUpIfNeeded` 守卫加 `loadingHistory`、`loadOlderHistory` 守卫加 `catchUpInFlightRef`（双向互斥） | `ChatView.catchup.test.tsx` 新增 describe（错峰 1 条 + 双向互斥 2 条）；既有 13 条因错峰改造断言时机（`flushCatchUp` helper 等一拍宏任务；fake-timer 用例切回真时钟前先 `advanceTimersByTime(0)`，否则已排定的 fake 定时器被 `useRealTimers` 丢弃） |
| ① | `useAcpChat.ts` 的 `sendPrompt` 卫哨拆分：空输入/无会话保持静默；socket 非 OPEN 落 `setError`，文案按 `connectionState` 分档（`connecting` → `chat.sendFail.reconnecting`，否则 `chat.sendFail.disconnected`，zh/en 两个 locale key）；hook 引入 `useTranslation`（`t` 与 `connectionState` 进 useCallback deps，消费方经 `AcpConnectionManager` 的 `sendRef` 晚绑定，identity 变化不扩散） | 新文件 `useAcpChat.sendfail.test.tsx` 5 条（CONNECTING / 无 socket / 握死 CLOSED / 空输入 / 成功路径不回归） |
| ④ | `FileEditor.tsx` 拆「受控回显 `query`」与「生效查询 `activeQuery`」两层，150ms（`SEARCH_INPUT_DEBOUNCE_MS`）防抖后计算 effect 才重跑；计算 effect 本体零改动 | `FileEditor.search.test.tsx` 补「连续键入只算一次」1 条（spy `computeMatches` 计数 + 断言最终查询）；既有 9 条靠 `vi.waitFor` 天然容忍 150ms 延迟 |
| ⑨ | a) `preHydrateBuffer` 改存 `{frame, bytes}` 并加条数（`PRE_HYDRATE_MAX_FRAMES`）/UTF-8 字节（`PRE_HYDRATE_MAX_BYTES`）双上限（值与 liveBuffer 同源），越界丢最旧 + 置 `needsCatchUp`；b) `flushLiveBuffer` 加可选 `sid` 参，ws 生命周期 effect cleanup 显式传本 effect 的 `sessionId`；rAF/setInterval 两处传参点包一层 lambda（`setInterval(flushLiveBuffer, …)` 会把 delay number 注进 `sid` 参数） | 新文件 `useAcpChat.prehydrate.test.tsx` 4 条（条数越界 / 字节越界 / 正常窗口不丢帧 / ⑨b 跨会话归属） |

**验收对照**：① 三形态可见状态 + 成功路径零回归 ✓；② 不与 flush 抢帧 + 与上拉不并发 ✓（jsdom 无布局，「主线程无长任务」的 Performance 录制验证未做，预算语义由单测固化）；③ 共用预算常量 + 超限降级单测 ✓；④ 防抖单测 ✓（≥1MB 文件的 Performance 录制验证未做）；⑨ 两条边界各有回归单测 ✓。前端 `pnpm test` 1495 全绿、`tsc -b` 通过、`pnpm lint` 0 error。

### 实施偏差（就地记录，方向不变）

1. **② 的互斥不采用「loadingHistory 语义扩展」，改为双向守卫**。原设计「同一 `loadingHistory` 语义扩展为『历史在飞』」会让补拉触发「正在加载更早的记录…」UI 提示与贴底重钉（该字段驱动这两处），文案对补拉（拉最新页）是误导。改为 `catchUpIfNeeded` 读 `st.loadingHistory` 早退 + `loadOlderHistory` 读 `catchUpInFlightRef` 早退：互斥语义等价（两个早退都在同步段、检查与置位间无 await），无 UI 副作用。
2. **③ 共享的是常量与降级语义，不共享函数体**。`alignReplaySyncPayload` 的扫描从 cursor **向后**且叠加整场总量预算（`MAX_ALIGN_COMPARISONS`）与指针提交；`mergeLatestMessages` 的候选扫描从尾部**向前**。方向相反、维度不同，强行参数化方向是为共享而共享（工程准则 7 反例），故只抽 `boundedTailScan` 服务合并侧，两者以 `ALIGN_SCAN_BUDGET` 同源 + 「超限即降级为既有安全路径」同族语义对齐。验收标准「共用同一预算常量」逐字满足。
3. **⑨a 的超限策略是丢最旧 + 置 `needsCatchUp`，不是 liveBuffer 的「越界即 flush」**。hydrate 未落定前应用帧 = hydrate 因 messages 非空 bail = 丢整段历史，本结构下不存在「提前消费」这个选项；被丢帧内容后端累积器 ≤1s 已落库，聚焦补拉从 DB 幂等找回（显式找回路径，非静默丢弃）。

### 未实施项（后续排期）

⑤ 轮询矩阵收敛、⑥ 终端 WS 侧心跳、⑦ Phase 0 四格探针（需公网环境）、⑧ WS 集成测试脚手架——工程量中到大或需外部环境，本轮不动；各自触发条件与验收标准仍以本文件为准。
