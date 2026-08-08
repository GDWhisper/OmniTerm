# 异步与竞态 — 调试模式

覆盖：broadcast/mpsc 通道、订阅-快照顺序、完成信号广播、边生产边消费、identity guard、即时 vs 异步竞态窗口。

---

## 模式 1：完成信号必须广播，不能回发起连接

**异步-信号通道**：长生命周期任务的完成信号（`prompt_done` / `replay_end` 类）跨连接存活，必须走 broadcast（session 级通道），per-connection mpsc 只配转发即时响应。凡是 `tokio::spawn` 持有 per-connection `Sender` 并在未来某时刻发送关键信号的模式，都要问：这个信号跨连接吗？

**适用**：任何「任务存活期 > WS 连接保证存活期」的信号；引入自动重连后「发起连接 == 接收连接」的隐含假设失效。

**案例证据**：
- 2026-07-31 ACP prompt 完成信号走 per-connection mpsc，WS 重连后旧 mpsc 已死、`let _ = tx.send(...)` 静默丢弃 → 前端永远 running，刷新才恢复。修复：`AcpClient` 新增 `turn_end_tx: broadcast`，WS 层订阅转发。

---

## 模式 2：broadcast 订阅必须在快照之前（subscribe-before-snapshot）

**异步-订阅顺序**：tokio broadcast 通道无历史，`subscribe()` 只收订阅之后的消息。当「取状态快照」与「订阅后续事件」分两步执行时，若状态变更恰好落在两步之间，快照陈旧 + 事件丢失，不可恢复。**所有需要在连接建立时同步的 broadcast 通道，订阅必须发生在快照之前**；重叠窗口内至多收到一个幂等事件，而丢帧窗口是不可恢复的。

**适用**：连接建立时「先同步状态、再订阅事件」的续接协议；注意同一函数里所有 broadcast 订阅要统一遵守，不能只给第一个加注释。

**案例证据**：
- 2026-08-02 `turn_end_subscribe()` 在 `turn_snapshot()` 之后 34 行：turn 恰好在该窗口结束时，前端收到陈旧 `turn_state{active:true}` 却永远等不到 `prompt_done`，永久卡 running。修复：订阅移至快照前。

---

## 模式 3：有界通道必须边生产边消费，Lagged 不是终止信号

**异步-背压**：「先等生产者完成、再排空有界通道」在数据量超过通道容量时必然丢数据。凡是有界通道 + 消费延迟到生产结束之后的组合，必须边生产边消费（`tokio::select!` 并发转发）。`RecvError::Lagged` 是「丢了 n 条」的警告，正确做法是记日志后 `continue`，不是 `break`。

**适用**：有界 broadcast + 数据量无上界保证的组合（历史回放、流式转发）。

**案例证据**：
- 2026-07-31 重放 285 条历史 > 广播容量 256 → `try_recv` 遇 Lagged 被当 Closed `break` → 零帧转发 → 前端恢复会话后消息列表清空（DB 未丢，刷新可恢复）。修复：`tokio::select!` 边加载边转发，Lagged 仅 warn。

---

## 模式 4：前端即时生效 vs 后端异步生效 = 竞态窗口

**异步-双端同步**：凡「前端即时变 + 后端异步跟随」的双端尺寸/状态同步，中间窗口内后端按旧状态产出的内容会被前端新状态错误消化。`fit.fit()` 立即改变 xterm 尺寸，但 resize→后端→SIGWINCH→tmux 重绘是异步链路；窗口内 tmux 按旧尺寸绘制 status bar，越界行被推入 scrollback。

**适用**：xterm fit / 布局 resize / 任何「客户端即时生效、服务端异步确认」的链路。

**案例证据**：
- 2026-07-31 ResizeObserver 触发 fit → tmux 尚未收到 SIGWINCH 仍按旧尺寸重绘 status bar → 旧 last-row 越过缩小后的视口底部 → status bar 被永久推入 xterm scrollback。缓解：80ms 去抖（仅降概率，未根治，遗留待自研终端引擎）。

---

## 模式 5：手动管理的事件源被替换时必须解绑全部 handler 或在 handler 内验证身份

**异步-晚到事件**：`ws.onclose = null` 只挡住一个事件；close/error/message 是一组。旧实例被替换但事件仍可能迟到——handler 首行做身份校验（`if (currentRef !== this) return`）天然免疫晚到事件，不依赖清理方记得每个事件名。

**适用**：WebSocket、EventSource、MediaStream、任何「旧实例被替换但事件仍在飞行」的场景；也适用于 async 初始化后被 abort 的竞态（await 后检查 `signal.aborted`）。

**案例证据**：
- 2026-07-26 连点两次重连，废弃 ws2 的 error 事件在 ws3 `onopen` 之后到达，把健康连接盖回「已断开」。修复：onclose/onerror 首行 identity guard。
- 2026-07-08 StrictMode 双重初始化：`createTerminal` 改 async 后，cleanup 在 await 期间是空操作，两个并发调用各自完成 `term.open()`。修复：AbortController，await 后检查 aborted 再碰 DOM。

---

## 模式 6：同一个状态机的事件应走同一通道类型，混用即隐患

**异步-一致性**：审查消息表时按「通道类型」列一遍，孤例优先怀疑。同一状态机 `session_update`/`crash` 全走 broadcast，唯独 `prompt_done` 走 per-connection mpsc——不一致本身就是信号。

**适用**：后端事件流设计审查；「举一反三」审计时按模式复查全链路同构点（如 `replay_end` 也同构，replay 期间断线后前端 `isReplaying` 永不复位）。
