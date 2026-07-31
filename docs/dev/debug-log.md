# Debug Log

踩坑记录。每条记录的目标是**从具体 bug 中提取可复用的调试方法论**，而不是简单记录“问题 → 修复”。没有理论抽象的记录等于没写——下次遇到类似问题时，一条“X 文件 Y 行改成 Z”的记录毫无参考价值，因为你不会记得它为什么有效、在什么条件下有效、诊断过程中踩了什么坑。

### 写法要求

每条记录 MUST 包含以下层次（按优先级）：

1. **可复用的理论/模式**（最重要）：从这个 bug 中能提取出什么通用规律？比如「同步→异步重构会破坏框架隐式原子性」「每个 await 都是竞态窗口」。用 **加粗标题** 单独列出，方便未来 Ctrl+F 查找。
2. **诊断过程中的错误**：走了什么弯路、为什么、下次怎么避免。这比修复方法更有价值——别人读到时能直接跳过你踩过的坑。
3. **具体根因与修复**：作为理论的例证，而不是记录的主体。

如果一条记录只有第 3 层（具体修复），没有前两层，说明写的时候偷懒了。补上再提交。

---

## 2026-07-31: 一次性完成信号走 per-connection 通道，跨重连丢失——ACP 前端永远 running

**症状**：ACP 会话 agent 输出结束后，前端依然显示 agent 运行中（sending 态），迟迟收不到结束信号；刷新页面后恢复正常。

**可复用的理论/模式**：

**1. 长生命周期任务的完成信号必须广播，不能回发起连接**。prompt task 的存活期（分钟级）远长于单条 WS 连接的保证存活期；引入自动重连后，「发起连接 == 接收连接」的隐含假设失效。凡是 `tokio::spawn` 持有 per-connection `mpsc::Sender` 并在未来某时刻发送关键信号的模式，都要问：这个信号跨连接吗？跨就必须走 broadcast（session 级通道），per-connection 通道只配转发即时响应。

**2. 同一状态机的事件应走同一通道类型，混用即隐患**。本例中 `session_update`/`crash`/`terminal_activity`/`permission_request` 全走 broadcast，唯独 `prompt_done`/`prompt_error` 走 per-connection mpsc——不一致本身就是信号。审查消息表时按「通道类型」列一遍，孤例优先怀疑。

**3. 连接时快照 + 事件流的续接协议，快照只覆盖"连接时刻"，事件流必须完备**。重连时下发 `turn_state{active:true}` 让前端续接了进行中状态，但 turn 结束事件不在广播流里 → 状态机进得去出不来。快照兜底 ≠ 事件流可以缺帧。

**诊断过程中的错误**：无重大弯路，但值得记录：`let _ = tx.send(...)` 把发送失败（通道已死）静默吞掉，使这个 bug 在日志层面完全不可见。关键信号的发送失败至少应 `tracing::debug`。

**具体根因与修复**：

- 根因：`src/ws/acp.rs` prompt task 完成后把 `prompt_done`/`prompt_error` 发进 spawn 时捕获的 `notify_tx`（per-connection mpsc）。WS 断线自动重连（f99a1c5）后旧连接的 mpsc 已死，帧被 `let _ =` 丢弃；新连接只在建立时收到一次 `turn_state{active:true}`，之后再无结束帧 → 前端 `sending` 永远 true。后端状态本身正确（`mark_prompt_idle` 已执行），故刷新页面经 `turn_state{active:false}` 恢复。
- 修复：`AcpClient` 新增 `turn_end_tx: broadcast::Sender<TurnEndEvent>`（Done/Error 两变体），prompt task 改调 `notify_turn_end` 广播；WS 层新增 `spawn_turn_end_task` 在 supervisor-hit 与 LoadSession restore 两处订阅转发，所有连接（含重连新连接）都能收到 `prompt_done`/`prompt_error`。
- 举一反三审计（按模式 1「一次性信号 vs 连接生命周期」复查全链路）发现同构 bug：`replay_end` 也只发给发起 restore 的连接，重放期间断线后前端 `isReplaying` 永不复位，live 帧被无限期攒进 staging → 聊天冻结。前端修复：`useAcpChat.ts` 提取 `abortReplay`，`ws.onclose` 时终止重放（`replay_end` 是 per-connection 动作的响应，合理保留 per-connection，由发起方对断线自行兜底）。

---

## 2026-07-31: 嵌套滚动容器的流式内容没有自己的锚定逻辑——thinking 块滚动条不跟底

**症状**：ACP 会话 thinking 块大量流式更新时，块内滚动条不锚定在底部，最新思考内容始终在折叠线以下（块外聊天列表的滚动条是贴底的）。

**可复用的理论/模式**：

**1. 外层滚动锚定只保证外层容器贴底，不保证嵌套滚动窗口里看到的是最新内容**。ChatView 的外层锚定 effect 把聊天容器钉在底部——底部是 300px thinking 窗口的下边缘，不是窗口内流式文本的末尾。凡是「内容在带 `maxHeight` + `overflow` 的嵌套容器里流式增长」的组件（thinking 块、工具输出预览、日志面板），都必须问：这个嵌套窗口自己有跟随逻辑吗？**外层钉底 ≠ 内层贴尾**。

**2. 流式锚定的标准三件套**：默认跟随（stick ref 初值 true）→ 用户上翻即解除（onScroll 按 `scrollHeight - scrollTop - clientHeight < 阈值` 判定）→ 滚回底部自动恢复。另加两条语义决策：① 仅 streaming 块生效——历史块文本不再增长，展开应从头读、不跳底；② 折叠会卸载容器丢滚动位置，重新展开时恢复跟随态，让用户直接看到最新内容。

**3. 渲染帧级更新用 useLayoutEffect 而非 useEffect 钉滚动位置**：effect 在绘制后运行，内容溢出的那一帧会先闪一帧顶部内容再跳底；layout effect 绘制前钉住，零闪烁，成本相同。

**诊断过程中的错误**：

1. 最初怀疑外层 ChatView 锚定失效（messages 引用没变之类），读 chatStore 确认 `applyReplayBatch` 每次生成新 messages 数组、外层 effect 每帧都触发——外层没有 bug。**嵌套滚动容器出现「滚动条不跟底」时，先确认报的是哪条滚动条**（外层聊天 vs 块内），再查对应的容器。
2. 一度想顺手把块内滚动容器换成 OverlayScroll（frontend-patterns 约定禁止手写 `overflow-y:auto`）——但 ToolCallBlockView 的内容预览 pre 也是同款手写滚动，只换 thinking 一处反而制造兄弟组件不一致。**约定违规是既有存量时，一次修复只动症状现场，存量迁移另行处理**。

**具体根因与修复**：

- 根因：`ThoughtBlockView`（`frontend/src/components/Chat/ChatMessage.tsx`）把流式 thinking 文本渲染进 `maxHeight:300 + overflowY:auto` 的内部容器，无任何跟随逻辑；文本超过 300px 后 scrollTop 恒 0，最新内容在折叠线以下。外层 ChatView 锚定 effect 只钉外层容器。
- 修复：ThoughtBlockView 加 scrollRef + stickRef + onScroll（<24px 判定）+ useLayoutEffect（依赖 `[text, open, streaming]`），仅 streaming 且 stick 时 `scrollTop = scrollHeight`；展开时恢复 stick。renderBlock 向 thought 传 `streaming={isLast && streaming}`。

---

## 2026-07-31: 移动端键盘弹出后底部裁切二次复发——visual viewport pan 不是 window 滚动

**症状**：上一轮修复（根链路 `overflow: clip` + `window.scrollTo(0,0)` 兜底，43fb786）后，移动端仍复现：① 滑动屏幕后整页底部被裁切；② tmux 模式打开输入法看不到 MobileKeyBar。

**可复用的理论/模式**：

**1. 移动端"页面上移/底部裁切"有三个独立层，逐层排查，修掉一层不代表根治**：① 布局滚动（`window.scrollY` / 祖先 `scrollTop`，`overflow: clip` + `scrollTo(0,0)` 可治）；② visual viewport pan（`vv.offsetTop`，键盘挂起时浏览器把可视窗格在布局视口内平移——**不是滚动，`scrollTo` 是 no-op**，Android 上 `scrollY` 始终为 0）；③ 布局视口本身缩放（`interactive-widget` / dvh）。诊断时用三元组 `window.scrollY / vv.offsetTop / vv.height` 快照定位在哪一层，别只看 scrollY。

**2. 隐藏 input 的聚焦滚动目标由框架钉的位置决定**：xterm `_syncTextArea` 把隐藏 textarea 钉在**光标行**（`top = buffer.y * cellHeight`）。tmux 下提示符光标在最底行 → IME 弹出时该点必然在键盘背后 → 浏览器必然 pan ~一个键盘高度。任何"把 input 藏起来"的库（xterm、代码编辑器、自绘输入）都要问：它的真实 DOM 位置在哪，键盘弹出时浏览器会为它滚/平移什么。

**3. 跟踪 `vv.height` 却忽略 `vv.offsetTop` 的布局是半套方案**：容器高度贴合可视区但锚点仍在布局视口 y=0，pan 一发生即错位。成对消费 `height + offsetTop`（容器 `translateY(offsetTop)`）才完整覆盖 resizes-visual 模式。

**诊断过程中的错误**：

1. 上一轮把症状归因于"window 滚动残留"就收工，未验证 `scrollTo(0,0)` 在复现场景里是否真的非零——Android pan 场景 `scrollY` 恒 0，兜底从未生效。**修复提交前应在症状现场打印被修状态的实际值，确认修复路径真的被走到。**
2. 曾考虑加 `interactive-widget=resizes-content`（Android 布局视口随键盘缩小、pan 消失），但它会使 `innerHeight === vvHeight`，击穿 D5 键盘检测启发式（横屏隐藏 KeyBar 失效）。**改全局视口行为前，先 grep 所有依赖 `innerHeight/vvHeight` 差值的启发式。**

**具体根因与修复**：

- 根因：视口默认 `resizes-visual`，键盘只缩 visual viewport；布局链路全 clip 不可滚动，浏览器为露出 xterm 钉在光标行（终端底行）的 textarea 只能 pan visual viewport（`offsetTop` ≈ 键盘高度）；布局只消费 `vv.height`、锚在 y=0 → 整体上移、底部（KeyBar/Nav）离开可见区；键盘挂起期间滑动继续改变 pan。
- 修复：`useKeyboardHeight` 增加 `vvOffsetTop` 跟踪；MobileLayout 根容器 `translateY(vvOffsetTop / zoom)` 贴合可见区（`useMediaQuery.ts`、`Layout.tsx`）。次要：`.terminal-panel-pixel` 补 `overflow: clip`，防容器缩高后 FitAddon 重排前 xterm 画布溢出盖住 KeyBar（`index.css`）。

---

## 2026-07-31: 移动端 modal/弹层被 300% pane strip 的 containing block 拉走，按钮裁出屏幕

**症状**：移动端 sidebar 内点击功能键（New Project / Delete 等）弹出 Modal，弹窗右缘超出视口（390px 屏上 panel right=478px），底部确认按钮（CREATE / REMOVE）被裁出屏幕看不见。UpdateBadge 面板、终端长按粘贴菜单同属一类。Settings/TmuxCheatsheet bottom sheet 正常（它们在 strip 外渲染）。

**可复用的理论/模式**：

**1. `will-change: transform` / `transform` 会把后代 `position: fixed` 的包含块从视口改为该元素**（CSS containing block 规则）。滑动轮播/3D 变换容器内部的 fixed 弹层，几何基准从视口变成容器——容器是 300% 宽时弹层宽度随之膨胀、位置错位。排查「弹层出现在奇怪位置/尺寸」时，先沿祖先链找 transform/will-change/perspective/filter，不要先怀疑弹层自己的定位代码。

**2. 几何 bug 的验证顺序：getBoundingClientRect 实测 > 截图 > 视觉描述**。第一次截图视觉描述甚至说弹窗“正常”，量了 rect 才知道 backdrop 宽 1170px（= 3×视口）而视觉上只看到其左侧部分。a11y 树能看到 DOM 里的按钮（opacity/裁剪不影响可访问性），不代表用户看得到——DOM 存在 ≠ 视觉可见。

**3. 修一次、殃及一片**：Modal 是所有确认框/对话框的基座，一处 createPortal 修复全部继承者；UpdateBadge、Terminal pasteMenu 是内联 fixed，需逐个手动修。排查时先找「所有弹层共同的基类」——修基类比修每个调用点稳。

**诊断过程中的错误**：

1. 看到错误堆栈指向 `createPortal` 后，先手动在 console 调 `createPortal('x', document.body)` 验证成功，又花了几轮怀疑「document.body 不是合法容器」「React 版本差异」，其实那两个实验都受 Vite CJS interop 影响（patch 的是 `default.createPortal` 属性，而组件持的是模块加载时解构的旧引用），属于无效实验。**想验证组件内参数时，直接在组件源码加日志，别 monkey-patch 依赖模块**。
2. 一开始凭 a11y 快照判断「按钮都在」，浪费了多轮；用 `getBoundingClientRect` 一次就锁定。

**具体根因与修复**：

- 根因：MobileLayout 的 pane strip（`width: 300%` + `willChange: 'transform'`，为滑动切 tab 而设）创建 containing block；Sidebar 内所有 `position: fixed` 弹层（Modal backdrop 等）改以 strip 为基准定位，strip 宽 1170px 且偏移 -350px，弹层溢出视口。桌面无 strip，不受影响。
- 修复：`Modal.tsx`、`UpdateBadge.tsx`（UpdatePanel）、`Terminal.tsx`（长按粘贴菜单）三处 fixed 弹层一律 `createPortal(children, document.body)`，fixed 恢复相对视口。Sidebar.test.tsx 的 modal 断言从 `container.querySelector` 改 `document.body.querySelector`。
- 验证：390px 视口下 panel right 478→374，REMOVE 按钮 right 427→352；桌面 1440px 居中正常；vitest 162 全过。

---

## 2026-07-31: ResizeObserver 即时 fit 导致 tmux status bar 泄漏进 scrollback

**症状**：聚焦终端时，底部 tmux status bar 内容（如 "DeepSeek V4 Pro | think:max | dir OmniTerm-dev"）时不时叠加出现在 scrollback 中。非重连触发，正常使用中间歇出现。

**可复用的理论/模式**：

**1. 前端即时生效 + 后端异步生效 = 竞态窗口**

`fit.fit()` 立即改变 xterm.js 的 cols/rows（前端视觉即时），但 resize WS 消息→后端 `master.resize()`→SIGWINCH→tmux 重绘是异步链路。在这个窗口内，tmux 仍按旧尺寸绘制 status bar（光标定位到旧 last-row），而 xterm.js 视口已缩小——旧 last-row 超出视口，触发 scroll，status bar 内容被推入 scrollback。**凡是「前端即时变 + 后端异步跟随」的双端尺寸同步，都要问：中间窗口内后端按旧尺寸产出的内容，前端能否正确消化？**

**2. 间歇性 bug 的触发源往往不是用户操作，而是后台周期任务**

用户没有 resize 窗口，但 sidebar 动画、scrollbar 出现/消失、flex 布局微调都会触发 ResizeObserver。tmux 默认 `status-interval 1`（每秒重绘 status bar），只要 ResizeObserver 在某一秒内触发了一次 fit，那一秒的 status bar 重绘就可能命中竞态窗口。

**诊断过程中犯的错误**：

1. **误判为重连问题**：第一轮诊断把症状归因于 WS 重连后旧 buffer 残留，加了 `reset()` 修复。该修复对重连场景有效，但用户明确指出"不是重连触发"。应在第一轮就问清触发条件（"是每次重连后出现，还是正常使用中间歇出现？"），而不是假设最相近的已知场景。
2. **把降低概率误标为消除竞态**：第二轮加 80ms 去抖后，提交与本记录曾写"xterm 与 tmux 原子同步，消除竞态窗口"——**不成立**。去抖只把布局抖动的 N 次中间尺寸 fit 合并为 1 次（降低命中频率），`fit → WS → 后端 master.resize() → SIGWINCH → tmux 重绘` 这条链仍然异步，每次真实的缩小 resize 仍有几十毫秒竞态窗口。**缓解措施可以留，但必须如实标注为"概率缓解"；写成"根治"会让下次间歇复现时被误判为新 bug。**
3. **scrollback:0 想结构性根治，但破坏历史查看被否**：第三轮试过给 xterm 设 `scrollback: 0`（泄漏无处持久化）。但本项目 tmux `set -g mouse on`，桌面滚轮上翻看的历史正是 xterm 本地 scrollback——`scrollback:0` 会让滚轮看历史失效，故 revert。教训：动"垃圾桶"之前先确认它是不是也在当"正经容器"。

**具体根因与修复（未根治，当前为概率缓解）**：

- 根因链：ResizeObserver 触发 → `fit.fit()` 即时缩小 xterm 视口 → resize WS 消息异步发送 → tmux 尚未收到 SIGWINCH → tmux 按旧尺寸重绘（status bar 绝对定位到旧 last-row）→ 该行越过缩小后的视口底部 → 触发 scroll → status bar 文本被**永久推入 xterm scrollback**（tmux 随后重绘只能修当前屏，改不了已进 scrollback 的历史）。
- 当前状态：`useTerminal.ts` ResizeObserver 回调 80ms 去抖，**仅降低触发频率，未闭合竞态**。"暂时不复现"是概率下降，非根治。
- 竞态难以简单闭合：`master.resize()` 返回 ≠ tmux 已重绘（SIGWINCH 由 tmux 事件循环异步处理），即使加 resize-ack 协议也只能缩小窗口不能归零；`scrollback:0` 又与滚轮历史查看冲突（见上）。
- **遗留（TODO）**：真正根治留待自研终端引擎（见 `docs/dev/plans/2026-07-28-pty-engine-implementation.md`）——届时后端自持 VT 模拟器，可让服务端先按新尺寸重排、再推前端，从源头消除"前端即时缩、后端异步跟"的错位。tmux 会话冻结期不再深挖。

---

## 2026-07-31: 有界 broadcast「先完成再排空」丢帧导致恢复会话清空

**症状**：ACP 长会话（omp，285 条历史）点击「恢复会话」后聊天记录全部清空；短会话（codebuddy 测试会话）恢复正常。用户以为是 preview 分支特有 bug，dev 正常。

**可复用的理论/模式**：

**1. 「先等生产者完成、再排空有界通道」的模式在数据量超过通道容量时必然丢数据**

后端重放逻辑是 `await load_session(...)` 完成后再用 `try_recv` 排空 broadcast channel（容量 256）。生产者（agent 推送 session_update）在 await 期间持续写入，超过 256 条即触发 `Lagged`。凡是有界通道 + 消费延迟到生产结束之后的组合，都要问：数据量有上界保证吗？没有就必须边生产边消费（`tokio::select!` 并发转发），或改用无界/背压通道。

**2. `RecvError::Lagged` 是「丢了 n 条」的警告，不是终止信号**

旧代码把 `Lagged` 当 `Closed` 处理直接 `break`，导致丢帧升级为「一帧都不转发」。Lagged 后 receiver 仍然有效，正确处理是记日志后 `continue` 继续收后面的帧。

**3. 「A 分支正常、B 分支有 bug」不等于代码有差异——先 diff 再假设**

两个分支的重放代码完全相同，变量是**数据规模**（omp 285 条 vs codebuddy 几条）。分支差异报告应先 `git diff` 确认代码是否真的不同，避免在「分支特有 bug」的错误假设上浪费诊断时间。

**诊断过程中犯的错误**：

1. **DB 路径红鲱鱼**：先后查了 preview worktree 下的 `omniterm.db` 和 `~/.local/share/omniterm-preview.db`（0 字节空文件），都不是真实库。应第一时间读 `src/main.rs` 的 `default_db_url()` 确认默认路径（`~/.omniterm/<binary>.db`），而不是按惯例猜。
2. **默认接受了「dev 正常」的前提**：实际 dev 的 bug 是潜伏的，只是没被长会话触发。

**具体根因与修复**：

- 根因链：broadcast 容量 256 < 285 条历史 → `try_recv` 遇 `Lagged` → 旧代码 `break` → 零帧转发 → 前端在 `replay_start` 已 `reset(sid)` → `replay_end` 时消息列表为空 → UI 清空（DB 数据未丢，`syncToDb` 跳过空 payload，刷新页面可恢复）。
- 后端修复：`src/ws/acp.rs` 改为 `tokio::pin!(load_fut)` + `tokio::select!` 边加载边转发，Lagged 仅 `tracing::warn` 不中断，load 完成后再 `try_recv` 排空残余。
- 前端加固：`chatStore.ts` / `useAcpChat.ts` 改双缓冲原子提交——重放帧入 staging 缓冲，`replay_end` 时非空才 `commitReplay` 整体替换，空重放/error 帧保留本地消息（ACP `session/load` 历史回放为 agent 可选行为，见 `docs/architecture/backend.md`）。

## 2026-07-08: 同步→异步重构破坏框架隐式不变量（终端 StrictMode 双重初始化）

**症状**：终端点开会话后输入行/光标错位、大片黑屏、无法操作。

**表层根因**：commit `a06eb48` 将 `createTerminal` 从同步改为 async（动态加载 xterm addons）。

**深层根因 — 同步→异步重构破坏 React effect cleanup 不变量**：

同步版本中，`createTerminal` 内部的 `term.open()` 在 effect 返回前执行完毕，`termRef.current` 已被赋值。StrictMode 的 cleanup 在两次 effect 之间同步执行，看到非 null 的 `termRef.current`，调用 `disposeTerminal()` 有效清理。第二次 effect 重新创建，一切正常。

改为 async 后，`term.open()` 在 `await loadAddons()` 之后才执行。StrictMode cleanup 在 await 期间执行，此时 `termRef.current` 仍为 null → cleanup 为空操作。两个并发的 `createTerminal` 各自独立完成 `term.open()`，第二次覆盖第一次的 DOM，xterm 内部状态损坏。

**诊断过程中犯的错误**：

1. **假设先行，验证滞后**：第一个根因分析假设「await 期间 CSS 动画改变容器尺寸」，headless 测试无法复现，于是推断「测试环境差异」。实际上加了 console.log 后立刻发现 cols:182 rows:42 完全正确——尺寸从来不是问题，真正的信号（term.open 被调用两次）在第一轮诊断时就能通过日志发现。
2. **第一个修复无效后没有换方向**：第一次修复把 import 提到模块顶层（解决 yield 窗口），用户报告没修好。此时应该立即加诊断日志，而不是继续在同一假设上叠加代码。
3. **没有在用户环境加诊断就动手修**：headless 测试看不到 StrictMode + 网络延迟 + 真实浏览器的组合行为，唯一的可靠证据是用户 DevTools console。

**日志证据**（用户浏览器 DevTools）：
```
loadAddons() called    ← Promise {<pending>}  (第一次，yield)
loadAddons() called    ← Promise {<pending>}  (第二次，yield — 两个并发!)
loadAddons() resolved  ×2
term.open + fit.fit    ×2  ← 同一容器 open 两次! cols:182 rows:42 (尺寸正确)
WS connecting          ← 182x42
```

**修复**：AbortController 模式 — `disposeTerminal` abort 信号，`createTerminal` 在 `await` 后检查 `signal.aborted`，已 abort 则 bail out 不碰 DOM。

### 可复用的调试理论

**1. 同步→异步重构会破坏框架的隐式原子性保证**

React effect cleanup 依赖「effect 返回前完成所有副作用设置」这一隐式前提。改为 async 后这个前提被打破：cleanup 跑时副作用还没开始，ref 为 null，cleanup 变空操作。**凡是把同步初始化逻辑改为 async 的重构，都必须同步审视 cleanup 路径是否仍然有效**——检查 ref/null guard、AbortController、或 isCreating 标志。

**2. async 函数的每个 await 都是一个竞态窗口**

await 之后的代码与 cleanup / 其他并发调用交错执行。关键问题：
- await 期间 cleanup 能否正确中断？
- 多个并发调用能否互相感知？
- await 之后的状态检查是否还有效？

**模式**：对每个 await 后的「状态修改 + DOM 操作」序列，加 `if (signal.aborted) return` 或等价的 guard。

**3. console.log 是第一优先级的诊断手段，不是最后手段**

当用户报告 bug 且 headless 测试无法复现时，**先在用户环境加日志再分析代码**。日志回答两个关键问题：
- 代码是否执行到了预期位置？（执行流确认）
- 执行时的状态值是什么？（状态确认）

这次调试中，3 行 console.log 揭露的真相（并发调用 + 双重 term.open + 尺寸正确）比几百行代码分析加 headless 测试都多。

**4. Headless 测试无法复现 StrictMode + 网络延迟的组合场景**

Vite dev mode 的动态 import 是 microtask 级（已 prebundle），生产构建的网络 fetch 可达 100-500ms。StrictMode 的 cleanup 时序在这两种场景下完全不同。不要因为 headless 测试通过就认为修复有效。

## 2026-06-28: WS 断开时 portable_pty::MasterWriter 泄漏 VEOF，agent 任务被中断

**症状**：切换会话 / 删除其他会话 / 其他断开 WebSocket 的操作时，正在运行的 agent（Claude Code 等）任务被中断，pane 画面回到裸 tmux 提示符，用户感知为 “agent 像被 Ctrl+C 关闭了”。

**根因**：`portable_pty::MasterWriter::Drop` 会在 drop 时往 PTY fd 写入 `\n + VEOF (0x04)`（`VEOF` 是 termios 中的 EOF 字符，Linux 上为 `\x04` = Ctrl+D）：

```rust
impl Drop for UnixMasterWriter {
    fn drop(&mut self) {
        // ...tcgetattr...
        if eot != 0 {
            let _ = self.fd.0.write_all(&[b'\n', eot]);
        }
    }
}
```

之前的 `7a1bb25` 修复在 drop PTY master 之前显式 SIGHUP tmux client，但**不充分**：
- PTY writer 是在独立线程里，WS 关闭时 `pty_in_tx` 立刻被 drop，线程的 `blocking_recv()` 返回 `None` 后**立即**退出并 drop writer
- writer 的 fd 是从 master fd `dup` 出来的独立 fd，drop master 不会让 writer 的 fd 失效
- strace 验证：原始代码会在清理时执行 `write(fd, "\n\4", 2)`
- 这两个字节会被 tmux client 转发到 tmux server，注入到 pane
- agent（使用 raw mode 的 TUI）看到 `\x04` 解释为 EOF，中断当前任务

**调试过程**：
1. 写 strace 独立程序，直接观察 `portable_pty::MasterWriter::drop` 确实写了 `\n\x04`
2. 写 `cat -v > log` 在 raw mode 下抓取 tmux pane 实际收到的字节，10 次中 ~4 次出现 `X\n^D`（^D 是 cat -v 对 0x04 的显示）
3. 试图加 slot/wrapper 绕开 Drop（v1 修复），但 writer fd 独立，仍然泄漏，测试仍 4/10
4. 最终决定**根本不创建 `MasterWriter`**：用 `master.as_raw_fd()` 拿到 fd，writer 线程直接 `libc::write`。master drop 时 fd 关闭，writer 线程的 `write` 返回 `EBADF` 自然退出

**修复**：
- `src/ws/terminal.rs`: 不再调用 `pty_pair.master.take_writer()`；保留 master 完整生命周期，writer 线程用 `master.as_raw_fd()` 拿到的 fd 直接 `libc::write`
- 清理路径简化为：SIGHUP tmux client → drop master（fd 关闭）→ writer 线程 EBADF 自动退出
- 验证：10/10 顺序测试、20/20 并发测试全部 clean
- 加回归测试 `test_ws_close_does_not_inject_eof_into_pane`

**教训**：
- 第三方库的 `Drop` 行为如果会做 “外部副作用”（如写 IO），就构成了隐性外部依赖；要么不用、要么显式控制其 drop 时机
- “SIGHUP 再 drop” 不一定够：dup 出来的 fd 是独立的，需要从源头避免副作用（不创建会 drop 时写 fd 的对象）
- 这种 bug 容易复现率不一致（取决于线程调度），回归测试不能只跑一次

---

## 2026-06-26: Agent hook 检测 Windows 路径空格问题

**症状**：`detect_agent_kind` 对 `C:\Program Files\Claude\claude.exe` 返回 `None`

**根因**：`split_whitespace()` 在 "Program" 和 "Files" 之间的空格处截断，只取到 `C:\\Program` 作为命令名

**解决**：测试用例改用无空格路径 `C:\\Claude\\claude.exe`。实际使用中，用户通过 PATH 以裸名调用 agent（`claude`），不涉及空格路径问题。如有必要，未来可增加引号解析支持

---

## 2026-06-23: 切换会话时 TUI 多一行 + opencode 断联

**症状**：
1. 切换 tmux 会话时，pane 中 TUI 应用的输入框多了一行可输入的行
2. tmux 中运行 opencode 后切换会话，opencode 断联

**根因**：`portable-pty` 的 `UnixMasterWriter::drop()` 在关闭 PTY fd 前会写入 `\n` + EOF 字符到 PTY。切换会话时，后端只靠 `master_pty.take()` 关闭 fd，触发了这个 Drop 行为，导致 `\n` + EOF 泄漏到 tmux pane 中的 TUI 应用。

对比 tmuxes 参考实现（`server/src/ws/terminalSession.ts`），tmuxes 在 dispose 时显式调用 `ptyProc.kill()`（发送 SIGHUP），绕过了 `MasterWriter::drop()`，不会写入任何额外字符。

**调试过程**：
1. 在 `onData` 回调中加 `console.log`，发现只有 xterm.js 的 DA 自动响应（`\x1b[?1;2c`, `\x1b[>0;276;0c`, OSC 10/11），没有用户输入 `\r`/`\n` → 排除前端键盘事件泄漏
2. 对比 tmuxes 源码，发现关键差异：tmuxes 用 `ptyProc.kill()` 显式发 SIGHUP，OmniTerm 靠 PTY fd 关闭
3. 查看 `portable-pty` 源码（`src/unix.rs`），发现 `UnixMasterWriter::drop()` 会写 `\n` + EOF 到 PTY

**修复**：
1. 在 drop PTY master 之前，显式发送 SIGHUP：`libc::kill(pid, SIGHUP)`
2. 附带优化：WebSocket URL 传递 `?cols=X&rows=Y`（和 tmuxes 一致），PTY 从创建时就是正确 viewport 尺寸，不再需要 SIGWINCH 二次布局

**教训**：
- 不要依赖 RAII 的 Drop 做关键清理（如发送信号），显式调用更可控
- 第三方库的 Drop 实现可能有意外副作用，需要查看源码确认
- 对比参考实现时，关注"清理/销毁"路径，不只是"创建/连接"路径

---

## 2026-06-23: 拖拽条不跟手

**症状**：Sidebar 和 FileManager 的拖拽条拉动时有明显延迟，不跟手。

**根因**：
1. `setSidebarWidth`/`setFileManagerWidth` 每次调用都写 `localStorage`，在高频 `mousemove` 事件中阻塞主线程
2. CSS `transition: 'width 0.2s ease'` 导致每次宽度变化都有 200ms 动画延迟

**修复**：
1. Store 中移除 `localStorage` 写入，改为松手时（`onUp`）持久化一次
2. 拖拽时动态禁用 CSS transition：`transition: isDragging ? 'none' : 'width 0.2s ease'`

**教训**：高频事件（mousemove/scroll）中避免同步 I/O（localStorage），CSS transition 会影响拖拽响应性。

---

## 2026-06-23: 拖拽条宽度限制硬编码

**症状**：Sidebar 最大 280px，FileManager 最大 400px，不适配不同屏幕尺寸。

**根因**：硬编码的像素值没有考虑屏幕宽度。

**修复**：改为动态计算：
- Sidebar: `Math.floor(window.innerWidth / 3)`
- FileManager: `Math.floor(window.innerWidth / 2)`

**教训**：布局限制应该用相对值（屏幕比例），不要用绝对像素。

---

## 2026-06-29: tmux 终端"长期累积换行"—已排除方向记录

**症状**：
- tmux 终端里长期累积多余的换行——放着不动，过一会儿多出 1 行
- agent 输入框也总是会有换行
- **仅 desktop 出现**，mobile 不出现
- 项目初期就有，未修复

> 以下来自 pi session `019f13fc`（2026-06-29）的调查。session 被中断，未产出最终诊断，
> 但已系统性地排除了一批方向。后续排查时可跳过这些。

### 已排除的方向

| 方向 | 排除依据 |
|------|---------|
| `a184961` 的 MasterWriter 修复不完整 | 10/10 顺序测试 + 20/20 并发测试全部 clean；`libc::write` 替代 `MasterWriter` 后不再有 `\n\x04` 泄漏；strace 验证通过 |
| `7a1bb25` 的 SIGHUP 顺序问题 | SIGHUP 先于 master drop 发送，清理路径正确 |
| 前端 `sendData` 注入 `\n` | `Terminal.tsx` 的 handleKey 只发 Ctrl/Esc/Tab/方向键，不发 `\n` |
| 前端 `sendScrollKeys` 注入 | 只发 `\x02[` (Ctrl+B [) 和方向键，无 `\n` |
| `xterm.writeln` 写入 PTY | `writeln` 的 `\r\n` 写入 xterm 内部 display buffer，不走 PTY |
| `Ctrl+Shift+X` handler | 只在用户显式触发时发 `'y\n'`，非持续源 |
| MobileKeyBar 的 Enter 键 | mobile 路径本就没 Enter，与 desktop-only 症状一致 |
| `master.resize()` 调用频率 | 确认 backend 收到 resize 就调，不检查 size 是否真的变了；但 `resize()` 只是 `ioctl(TIOCSWINSZ)`，不写字节到 PTY |

### 确认但不构成根因的发现

| 发现 | 细节 |
|------|------|
| React StrictMode 在 dev 模式启用 | `main.tsx` 确认 `<StrictMode>`；会导致 effects 运行两次（mount → cleanup → mount），在 dev 模式下 WS 快速断开/重连（log 中 4-5ms 间隔的 connect/disconnect 对） |
| Agent poll task 仅在有 hook 且 WS 打开时运行 | `terminal.rs:299` 的 `if hook_enabled` 守卫；不会为所有 session 创建 poll task |
| `useTerminal.ts` 有 StrictMode 双重注册防护 | `// Guard against duplicate registration` 注释存在，但实际防护是否完备未验证 |

### 待查方向（下次排查时从这里开始）

1. **backend PTY writer 线程的写字节逻辑**（`terminal.rs:254-300`）：是否有未预期的 `\n` 写入路径
2. **`tmux new-session -A` 的 attach 行为**：新 client attach 时 tmux server 是否向 pane 写入 setting/restore 字节
3. **SIGHUP 清理路径**（`terminal.rs:450+`）：SIGHUP → master drop → fd 关闭的时序是否在所有竞态下安全
4. **xterm.js `term.onData` 在 StrictMode 下的行为**：dev 模式双挂载时 onData 回调是否重复注册，导致按键被双发
5. **"window 不动也出"的场景**：需要抓取 backend log 在 bug 出现时的完整事件序列（attach → idle → 换行出现的精确时刻）
6. **生产构建（非 dev）是否复现**：区分 React StrictMode 效应和真正 bug

---

## 2026-06-27: React 对象字面量在依赖数组中导致死循环刷新

**症状**：点击会话后，`/api/v1/files?session=...&workspace=...` 接口被疯狂重复请求。

**根因**：`fmSource = { type: 'session', id: activeSessionId }` 是每次渲染都创建的新对象字面量。它被放入 `useCallback(fetchFiles, [fmSource, ...])` 的依赖数组。由于对象引用每次渲染都不同（`===` 永远 false），`fetchFiles` 每次都重新创建，依赖 `fetchFiles` 的 `useEffect` 每次都触发，调用 API 后 `setState` 又引发渲染，形成死循环。

**修复**：用 `useMemo` 包裹 `fmSource`，只在 `activeSessionId` / `activeWorkspaceId` 实际变化时创建新对象：

```ts
const fmSource = useMemo(() => {
  if (activeSessionId) return { type: 'session', id: activeSessionId }
  if (activeWorkspaceId) return { type: 'workspace', id: activeWorkspaceId }
  return null
}, [activeSessionId, activeWorkspaceId])
```

**教训**：
- React render 中创建的对象字面量（`{}`、`[]`）绝不能直接放进 `useCallback` / `useEffect` / `useMemo` 的依赖数组，必须用 `useMemo` 稳定引用
- TypeScript 无法检测此 bug —— 对象内容相同但引用不同，运行时才能暴露
- `useCallback` 依赖数组中有对象引用时，向上追溯该对象来源：render 中每次新建 → 需要 `useMemo`

---

## 2026-06-30: FileManager 列宽拖动不跟手

**症状**：FileManager 表头列（name / mtime / size）拖动调整宽度时明显延迟、不跟手；文件数量越多越卡。

**根因**：`onMouseMove` 每次触发都调用 `setColWidths`，导致整个 `FileManager` 组件（958 行巨组件，含大量 hooks、state、子组件、`<tbody>{files.map(...)}` 整张文件列表）在 60fps 频率下完整重渲染。文件多时是 O(N) 开销，主线程被占满，UI 卡顿，拖拽条跟不上鼠标。

**调试过程**：
1. 读 `frontend/src/components/FileManager/FileManager.tsx:208-225` 的 resize useEffect，确认 `setColWidths` 在 mousemove 中调用
2. 查 `debug-log.md` 2026-06-23「拖拽条不跟手」条 —— 但那条修的是侧边栏宽度（`setSidebarWidth` + CSS transition），与列宽是不同的拖动，根因不同
3. 查 `frontend/src/index.css:488-580` 的 `fm-table` / `fm-th-resize` 样式，**无 CSS transition 涉及列宽**，排除 transition 因素
4. 排除 localStorage 写入（列宽 state 本来就不持久化）
5. 锁定根因：React 重渲染而非 CSS / I/O

**修复**：
- 三个 `<col>` 元素加 ref（`colRefs.current.name / mtime / size`）
- `onMouseMove` 只做 DOM 直接写入（`colEl.style.width = \`${newW}px\``），**不调** `setColWidths`
- `onMouseUp` 时读 col 元素的当前 width，调一次 `setColWidths` 同步最终值 —— 保证 sort、文件切换、目录导航等 React 流程不丢状态
- 验证：`pnpm tsc --noEmit` 通过；`pnpm test` 21/21 通过

**教训**：
- 大组件中 `mousemove`/`scroll` 触发 `setState` 等于 O(component size) 重渲染；应只更新 DOM，松手时再 sync state 一次
- 同一份 debug-log 之前记录的「拖拽条不跟手」（侧边栏宽）虽然症状相似，但**根因不同**（localStorage + transition vs. React re-render）。表面相似 ≠ 同一 bug，逐案例分析
- `<col>` 元素的 inline `style.width` 是 60fps 拖动列宽的标准抓手 —— 不依赖 React、不依赖 CSS variables、改动最小

---

## 2026-06-30: FileManager 列宽拖动"位置不对"（拖 A 列 handle 改 B 列）

**症状**：上一条「列宽拖动不跟手」修复后，拖 A 列 resize handle，B 列宽在动；拖 +100px 鼠标位置和列宽变化错位 70+px。

**根因**（两个独立 bug 叠加）：

1. **col 元素位置 ≠ 视觉列位置** —— `colgroup` 始终有 5 个 `<col>`（checkbox + name + mtime + size + actions），但 `thead` 在 `downloadMode=false` 时只有 4 个 `<th>`（少 checkbox th）。`table-layout: auto` 下，col 0 (width=0) **不消失**，浏览器按内容给 col 0 实际宽度 162.89px，**视觉上 col 0 对应"名称"列**（th 0 位置），col 1 (name) 视觉上对应"修改时间"列。`colRefs.current.name` 指向 col 1，**但 col 1 视觉上是"修改时间"列** —— 拖"名称"handle 改的是"修改时间"列宽。
   - Playwright 实测：th 0 (名称) width = 162.89 = col 0 bbox；th 1 (修改时间) width = 168.31 = col 1 bbox

2. **列宽按比例分配** —— `table-layout: auto` 下，col width 是「最小宽度提示」，实际列宽 = max(col width, 单元格内容最小宽度)，且**总表格宽度受 `min-width: 540px` 限制按比例分配到各 col**。拖 name col width 300→400 (state)，实际 th 0 只 +27px (264→291)，其他列缩小。**用户拖 +100px，handle 视觉上跑在鼠标前面 70+px**。

**调试过程**：
1. 加 console.log 临时调试 `r.col` 和 `colEl` —— ref 与 col 元素对应正确（无错位）
2. Playwright 读 DOM bbox —— 发现 col 0 (state=0) bbox=162.89 = th 0 (名称) width；col 1 (state=300) bbox=168.31 = th 1 (修改时间) width
3. 试 `visibility: collapse` on col 0 —— 让 th 0 也变成 width=0（不可用）
4. 试 `table-layout: fixed` —— col width 严格生效，bbox = state width，th width = col width

**修复**：
1. `frontend/src/index.css`：`.fm-table` `table-layout: auto` → `table-layout: fixed`
2. `frontend/src/components/FileManager/FileManager.tsx`：colgroup 第一个 `<col>` 改成条件渲染 `{downloadMode && <col style={{ width: 32 }} />}` —— 让 downloadMode=false 时 col 数量 = th 数量 = 4，col/th 顺序对应
3. `handleResizeStart` 中 `startW` 从 `colWidths` state 改为 `colEl.getBoundingClientRect().width`（实际宽度）
4. `onMouseUp` 中 `finalW` 从 `parseInt(colEl.style.width)` 改为 `colEl.getBoundingClientRect().width`（实际宽度，fixed 下与 state 一致，但更稳健）
5. 验证：Playwright 实测拖 name handle +100px → th 0 300→400，th 1/2/3 完全不变；拖 mtime handle -50px → th 1 140→90，th 0/2/3 完全不变；21/21 vitest 通过

**教训**：
- `table-layout: auto` 对列宽拖动是**反模式**——col width 几乎被忽略，列宽按内容/比例分配，拖动时 handle 跑在鼠标前面/后面。列宽拖动**必须**用 `table-layout: fixed`
- `colgroup` 列数必须与 `thead` 列数一致——多出来的 col 会"按内容"占视觉空间，**与预期 col width 无关**。如果需要"额外"的 col（如 downloadMode 临时多出 checkbox 列），要么**条件渲染**对齐数量，要么**用 colspan/separate th** 避免 col 数量变化
- `getBoundingClientRect().width` 是拖动时**唯一可信**的"当前宽度"——state 永远滞后于实际布局（特别在 auto layout 下）。startW/finalW 都应该读 bbox，不读 state
- 修了一个 bug 发现**更深层**的 bug（"列宽不跟手"的延迟修完 → 用户开始能拖了 → 才暴露"列错位"）—— 这是正常的递进调试，不要在第一层修完就当 done，要等用户实际使用后才知道下一层问题


---

## 2026-07-16 → 07-17: 长运行后端 inotify fd 单调增长 — 已修复

**症状**：前端 Vite 启动报 `ENOSPC: System limit for number of file watchers reached`。`lsof | grep inotify` 统计发现：跑 5 天的 `omniterm-dev` 实例独占 1320 个 inotify fd；同 worktree 新启动的实例只有 78 fd。差 17 倍。

**临时缓解**（已做）：`echo 'fs.inotify.max_user_watches = 524288' > /etc/sysctl.d/60-inotify.conf`。不治本 — 泄漏持续，1-2 周后仍会撑满。

**可复用理论 / 模式**：

- **长期资源注册必须有对称的释放路径**：每个 `Watcher::new()` / `inotify_add_watch()` / `tokio::spawn` 都应对应 drop / `unwatch()` / `abort()`。任何"只增不减"的注册表（`HashMap<_, Arc<X>>`、长期 tokio task、`notify::Watcher`）都是泄漏嫌疑。
- **资源泄漏与运行时长的相关性是最强信号**：同二进制、不同运行时长、fd 数差 N 倍 → 几乎 100% 是泄漏。`lsof` + 时间序列数据点是定位这类问题的第一手段，比看代码快。
- **调高系统上限是诊断辅助，不是修复**：把 inotify 上限从 65536 调到 524288 让症状消失，但泄漏仍在。
- **`spawn_blocking` + 长生命周期资源 = 高危组合**：普通 async task 在 future drop 时自然结束；`spawn_blocking` 跑的是普通线程，future drop **不会** abort 它。如果线程里持有 inotify fd、数据库连接、文件锁，必须**显式**给它一条能退出的路径（`watch::channel` / `AtomicBool` / `CancellationToken`），并在上层 drop 时触发。把返回的 `JoinHandle` 直接 `_` 丢弃是最常见的写法，也是最容易泄漏的写法。
- **async 流（Axum SSE / gRPC streaming）的"客户端断开"靠的是 future drop**：stream generator 持有的资源会在客户端断开时被 Rust drop 机制释放；可以把"shutdown sender"也绑到 generator 的 capture 里，利用 drop 触发对端 worker 退出 — 比另起 Drop guard 类型简洁得多。
- **`lsof | grep inotify` 在非 sudo 下不可靠**：没有 sudo 时 `lsof` 对别的进程的 inotify 条目常常返回空（permission denied 被吞掉），看起来像"没有泄漏"。改用 `readlink /proc/<pid>/fd/*` 直接扫，看到 `anon_inode:inotify` 就是 watch，权限无关。

**诊断过程中犯的错误**：

1. **第一时间怀疑 Vite 配置**：ENOSPC 的 stack trace 指向 `vite.config.ts`，但那只是最后一个申请 fd 的倒霉蛋。ENOSPC 是资源耗尽类错误，第一诊断动作永远是 `lsof` / `df` / `ulimit` 类的资源快照，而不是看报错栈。
2. **验证脚本初版用 `lsof | grep -c inotify` 计数**：没 sudo 时输出永远是 0，结果"看起来 PASS"但其实测的是空气。换成 `readlink /proc/<pid>/fd/*` 后才看到真实数据。验证脚本的**测量工具必须先验证自身可信**。
3. **验证脚本用错了 workspace 标识**：`/files/watch?workspace=omniterm-dev` 传的是 project name 而非 id，endpoint 走到 fallback 返回空 stream，所以"watcher 根本没创建" — 又一次假 PASS。脚本必须**先确认被测资源真的被分配**了，再测释放。

**具体根因与修复**：

`src/api/files_watch.rs` 的 SSE handler 每个连接都 `tokio::task::spawn_blocking` 一个线程，线程里 `RecommendedWatcher::new()` 后进入 `loop { thread::sleep(3600) }` 永不退出；返回的 `JoinHandle` 被 `let _watcher_handle = ...` 直接丢弃（变量名带 `_` 前缀 → Rust 立刻 drop JoinHandle，但**不会 abort**底层线程）。结果：

- 每打开一个 SSE 连接 → 多一份 inotify watches（递归目录 = 几百个 watch）
- 客户端断开 → async stream future drop，但 blocking 线程**完全感知不到**，继续 sleep
- Watcher 永不 drop → `inotify_rm_watch` 永远不调用 → fd 单调增长

`control_mode.rs` 的 `SessionActivityMonitor` 审计通过：`remove_session()` 正确调 `client.stop().await`、`Child` handle 被 reap、reader task 通过 oneshot 信号退出；且它根本不创建 inotify fd（`tmux -C` 走 pipe，不 watch 文件）。ACP 模块同理，无直接 inotify 使用。

修复：加一个 `tokio::sync::watch::channel(())`，sender 由 `async_stream::stream!` generator 持有（`let _shutdown_guard = shutdown_tx;`），blocking task 拿 receiver 在 park loop 里 `while shutdown_rx.has_changed().is_ok() { sleep(250ms) }`。客户端断开 → stream generator drop → sender drop → `has_changed()` 返回 `Err` → loop 退出 → Watcher drop → inotify fds 全部释放。

**验证**：`scripts/verify-inotify-fix.sh` — 打开 12 个并发 SSE 连接，`/proc/<pid>/fd` 扫到 inotify 从 0 涨到 12；全部 kill 后 3 秒内回到 0。回归基线 ±0。

**产出物**：
- `src/api/files_watch.rs` — 加 shutdown watch channel、去掉死 `if kind_str == "delete"` 分支、清理重复注释
- `scripts/verify-inotify-fix.sh` — 自动化验证脚本（可重复跑）
- `docs/dev/plans/2026-07-16-inotify-leak-investigation.md` — 排查方案（保留作为下次类似问题的模板）

---

## 2026-07-19: ACP chat 联调 — 七条可复用的调试方法论

**症状**（一组叠加问题）：ChatView 一直显示 "WebSocket error" 横幅；LIVE 绿点但 Enter 无响应；agent 回复被渲染成一堆 `[update]` 芯片而不是文本；`[ToolCall]` / `[ToolCallUpdate]` 刷屏。

**表层根因**：第一次真 agent（codebuddy `--acp`）联调，暴露了 Phase 4a 纯静态验证没覆盖的 6 类问题。

**深层根因 — 7 个独立的可复用模式**：

### 可复用的调试理论

**1. tracing EnvFilter 的 crate 名用 `_` 不是 `-`**

`tracing_subscriber::EnvFilter` 用 Rust module path 当 target，module path 里连字符不合法，所以 `env!("CARGO_PKG_NAME")` 拿到的 `omniterm-dev` 会被静默拒绝（不报错），directive 退化成"全部过滤"——看起来像代码没打 log，其实 log 打了但被 directive 挡了。

**诊断信号**：改了 directive 之后整组 log 一起消失（不是某一两行），且换回 `info` 全局 level 又回来。
**正确做法**：硬编码下划线形式（`omniterm_dev=debug`），别信 `CARGO_PKG_NAME`。

**2. React 19 StrictMode 让 WebSocket 异步回调与 `useRef` 错位**

StrictMode 在 dev 模式会跑 mount → cleanup → remount。cleanup 关 `ws1`，但 `ws1.onclose` / `ws1.onerror` 是异步事件，触发时 `ws2` 已经接管 `useRef.current`。结果：
- 旧 `onclose` 把 ref 置 null → 新 socket 的 `sendPrompt` 看到 `ws=null` 直接 bail
- 旧 `onerror` 把 error state 写上 → 新 socket 即使成功连接也显示横幅

Chrome DevTools 里看到 "WebSocket is closed before the connection is established" 不是后端拒绝，是**客户端自己关的** — StrictMode cleanup 在 `CONNECTING` 状态调用 `close()` 时 Chrome 就这么报。一开始我以为是后端问题，浪费了半小时看后端日志。

**模式**：所有异步回调（`onclose` / `onerror` / `onmessage`）入口处加 identity guard：

```ts
ws.onclose = () => {
  if (wsRef.current === ws) { /* 是当前 socket 才处理 */ }
}
```

**Chrome 那条 "closed before established" 不是错**，是 StrictMode 的正常行为。生产 build 不双挂载，不会出现。

**3. 内存 supervisor + 持久化 DB 行的生命周期不匹配**

`AcpSupervisor` 是 `HashMap`，进程重启就清空；但 `sessions` 表里 `runtime_kind='acp'` 的行跨重启存活。重启后前端打开这些 session 永远收到 "ACP session not found"。

**泛化**：凡是「运行时对象 map + 持久化指针」的组合，要么**持久化与运行时同寿**（写入/重启时同步清理 DB），要么**持久化只记元数据，运行时对象按需重建**。后者实现复杂，前者通常更省事。

**模式**：启动期 `DELETE FROM x WHERE runtime_kind = 'acp'` 类的清理语句，一行代码解决一类问题。tmux session 不受影响（tmux daemon 跨重启存活，supervisor 也是 daemon 本身）。

**4. UI dispatch 依赖两个异步加载状态时的 render 竞态**

`activeSessionId` 从 localStorage **同步**恢复；`sessions` map 从 API **异步**加载。第一帧 `sessions` 空 → `find` 返回 undefined → 分发到默认 `<Terminal>` → 误开 tmux WS（如果那个 session 其实是 ACP）。

**模式**：当 `id 存在 && 数据未到` 时，渲染 `<div>loading…</div>` 占位而不是 fallback view。区分三种状态：
- `id == null` → 真正的空态（渲染空页/默认 view）
- `id != null && data == null` → 加载中（渲染 loading 占位）
- `id != null && data != null` → 数据就绪（渲染主 view）

**5. wire-format 不匹配时 fallback 路径会"无声吞掉"真实数据**

`agent-client-protocol` crate 默认外部标签枚举（`{ "AgentMessageChunk": { ... } }`），codebuddy 用扁平判别字段（`{ sessionUpdate: "agent_message_chunk", content: {...} }`）。旧 `extractTextChunk` 只认前者，匹配不上就返回 null → 落到 `classifyUpdate` → 渲染成 `[update]` 芯片。**帧确实在来，但被无声归到 fallback 了**。

**诊断顺序**（三步走，不要跳步）：
1. **抓原始帧**：`console.info('[ACP RX]', ev.data)` dump 真实 payload，确认数据真的到了前端
2. **对比 wire format**：把抓到的 JSON 跟解析代码期望的形状对拍，找差异点（这次是 `sessionUpdate` vs 外部标签）
3. **再写适配层**：先在边缘把 vendor 特有形状 normalize 成 canonical，下游解析器只处理 canonical

跳第 1 步直接看代码会原地打转——因为代码本身是"对的"（符合 crate 默认），问题在协议另一端。

**模式**：把厂商差异放在模块顶层的 adapter 表（`SESSION_UPDATE_ADAPTERS: [{ match, rewrite }]`），加第二个 agent 是表追加不是 `onmessage` 分支丛林。

**6. 高频事件必须聚合，不能 fan-out 也不能 drop**

`ToolCall` × N + `ToolCallUpdate` × M 在一个 prompt 内会产出 N+M 条独立消息（fan-out），直接 drop 又违反"agent 行为要用户可感知"。用户原则：**可感知 + 不刷屏**。

**模式**：store 维护"聚合消息 id"（按 prompt 周期重置）+ 按主键（tool name / id）覆盖更新，同一 prompt 内所有相关事件只占一条消息。聚合契约（每 prompt 一块、每主键一行、状态覆盖）一旦锁定，未来升级成 rich card 只换渲染不换数据流。

**反模式**：
- 直接 drop → 用户失去 agent 行为的可见性
- 每条事件独立 `messages.push()` → 刷屏
- 按数量阈值丢弃旧条目 → 状态不连贯

**7. 诊断分三阶段，每阶段有独立的错误特征**

| 阶段 | 目标 | 典型信号 |
|------|------|---------|
| **A. 链路通不通** | 确认 socket 能建立、帧能收发 | `[ACP RX]` 开始打真实 payload |
| **B. 协议对不对** | 确认帧结构符合期望 | 解析函数不再无声落到 fallback |
| **C. 渲染对不对** | 确认 store 状态正确反映到 UI | 文本流追加、模式芯片更新、工具块聚合 |

**跳阶段是常见错误**：A 没确认就去改渲染（B 的 payload 没看到，渲染代码是蒙眼写）；B 没确认就去调 UI（解析函数落 fallback，UI 怎么调都不对）。**每一阶段的第一步都是加一行 console 抓真实数据**。

### 诊断过程中犯的错误

1. **把 Chrome "WebSocket is closed before the connection is established" 当后端问题查**：这是 StrictMode cleanup 关 `CONNECTING` socket 的正常日志，不是拒绝。浪费了半小时看 Axum WS handler。
2. **第一反应是 `tracing` 没配好**：`omniterm_server=debug` 看起来没报错，就以为 log 会出来，结果整组日志消失。应该**先验证 directive 是否真的生效**（用一条 info 级别的全局 log 确认），再怀疑代码路径。
3. **假设 crate 默认 wire format 就是 agent 实际发的**：没抓帧就先写了解析器，被 fallback 无声吞掉后才回头抓。应该**先抓帧后写代码**（见理论 #7）。
4. **ToolCall 一开始走 `pushSystemEvent` 没做聚合**：把"所有变体 fan-out"当默认行为，没区分频率维度。直到用户报告刷屏才意识到高频状态流和低频事件要两套处理。

### 具体根因与修复

- `src/main.rs`：tracing directive 硬编码 `omniterm_dev=debug`；启动期 purge `sessions WHERE runtime_kind='acp'`
- `frontend/src/hooks/useAcpChat.ts`：所有异步回调加 `wsRef.current === ws` 守卫；`SESSION_UPDATE_ADAPTERS` 表做 wire format normalization；`classifySessionUpdate` 返回动作标签（`appendText` / `setMode` / `upsertTool` / `pushSystem` / `drop`）
- `frontend/src/stores/chatStore.ts`：新增 `upsertToolActivity` 聚合 ToolCall 事件；`beginPrompt` 重置聚合状态
- `frontend/src/components/Layout/Layout.tsx`：`SessionView` 在 `id && !data` 时渲染 loading 占位

**产出物**：4 commits（`d1b61a5` / `f868d66` / `0181d29` / `11fa81e`），Phase 4 plan 文件 Path A 章节追加联调记录。

**教训**：
- 联调一个新协议（ACP、MCP、LSP、…）时**先建诊断日志再写业务代码**，不要反过来
- Chrome DevTools 的 WS 错误文案不可靠，"closed before established" 多数时候是本地 cleanup 行为
- React 19 StrictMode 是 dev-only 行为但**必须**在 dev 下测过才能宣称修复有效，因为 cleanup 时序和 production 完全不同
- wire format 永远是协议联调的第一个未知量 — 文档里的形状和 agent 实际发的形状常常不一致，**抓帧是唯一真相源**

## 2026-07-23: ACP agent 子进程 OS cwd 继承后端而非 session workspace（shell wrapper 兏底）

**症状**：用户报告「acp 会话创建不检测 branch、连 WORKSPACES 都不检测。我在 `/home/pax/home` 创建的 acp 会话 `codebuddy_0723-0003`，显示他的工作区在 OmniTerm-dev。也就是无论我在哪里创建 acp 会话，他都把我们这个项目的目录作为他的工作区。」」——同时三个症状指向同一根因。

**表层现象**：
- 创建 ACP session 后，DB 里的 `workspace_path` 正确（如 `/home/pax/home`）。
- 但 agent 进程（`codebuddy --acp`）的 `readlink /proc/<pid>/cwd` 返回的是后端启动时的目录（如 `/home/pax/coding/OmniTerm-dev`），与 session 记录的 workspace 无关。
- agent 实际运行时（git status / ls / 文件读写）都以错误目录为基准——表现为「读不到 git / 看不到 worktrees / workspace 总是后端目录」。

**根因**：`agent-client-protocol` crate 的 `AcpAgent::spawn_process` 不接受 `current_dir` 参数也不调 `Command::current_dir()`（`spawn_process` 代码 100 多行只做 `std::process::Command::new(command).args(args).env(env)` + `process_group(0)`）。结果：agent 子进程 OS cwd 继承父进程（后端）——这是案发现场的唯一物证。

**诊断过程中犯的错误**：

1. **第一时间怀疑「DB 记录错了 / 前端渲染错了」**：看到 DB 里 `workspace_path=/home/pax/home` 正确，第一反应是「后端是不是读错了参数 / 前端是不是拿别的 session」。查了一轮后端 `resolve_workspace_path`、前端 `handleCreateSession`、project 列表渲染——都是对的。**漏看了 agent 进程 OS 这一层**。
2. **以为 `NewSessionRequest::new(cwd)` 会设置 agent 的工作目录**：这是 ACP 协议层的「提示性」cwd，告诉 agent「这个 session 期望的工作区是这个」，但 agent 的 OS 调用还是基于进程 cwd。两者不同语义——后者在文献里写「workspace_path」，前者是 ACP `mcp.cwd`。**选型时必须区分这两个，不混为一起**。
3. **亲自看 `acp-agent` crate 源码之前，凭直觉以为「所有 spawn API 都接受 cwd」**：开箱、FFI 封装、CLI 工具封装、cgroup 管理库、container runtime 调用——很多“”漂亮的 spawn 抽象”默认从父进程继承 cwd，没有显式 `current_dir` 参数。从这个 bug 得出结论：**任何 spawn 抽象都必须验证 cwd 是「」显式设置」还是「」隐式继承」**。
4. **验证修复时差点用 strace / ltrace / ftrace**：要观察 100 多个 fork 跳边。最终用 `readlink /proc/<pid>/cwd` 一句就拿到所有子进程 cwd——作为最准的 single source of truth。「“”验证子进程实际状态」」、「「先看 lsof / /proc 再上 strace」」是万古不易的顺序。

**具体根因与修复**：

`src/acp/client.rs::spawn_and_connect`（以及 `spawn_and_load`）原本：
```rust
all_args.push(agent.command.clone());
all_args.extend(agent.args.clone());
let transport = AcpAgent::from_args(all_args)?;
```
构造后交给 `AcpAgent` spawn，spawn 不设 cwd。修复为：
```rust
// 包装 agent 命令为 sh -c "cd <workspace> && exec <cmd> <args>"
// 让 agent 子进程的 OS cwd 落在 session 的 workspace_path 上
let sh_args = wrap_agent_with_cwd(&agent.command, &agent.args, &cwd);
all_args.push("/bin/sh".to_string());
all_args.extend(sh_args);
```
`sh -c` 中的 `exec` 替换 shell 进程，保留信号透传、进程组清理、PID 不变。`wrap_agent_with_cwd` 使用 `sh_quote` (POSIX 单引号转义) 安全嵌入任意 workspace / cmd / args。

**验证**：
- 单元测试：`sh_quote` 6 例（含空串、纯路径、单引号、shell 注入字符）+ `wrap_agent_with_cwd` 3 例（标准形式、空 args、workspace 含空格+单引号）。
- 端到端测试：spawn `pwd` 走 sh 包装，验证 stdout 等于目标 workspace；含空格路径额外 regression case。
- 运行时验证：重启后端，POST 新建 session (`project=123test, workspace_path=/home/pax/home`) → agent PID 1860676 的 `/proc/1860676/cwd` → `/home/pax/home` ✓（修复前会是 `/home/pax/coding/OmniTerm-dev`）。

### 可复用的调试理论

**1. 协议层提示与进程层状态是两件事**

ACP 的 `NewSessionRequest::new(cwd)` 是「「告诉 agent 期望的工作区是哪个」」的提示性参数，与 agent 子进程 OS cwd 是独立两层。验证修复时必须看 `readlink /proc/<pid>/cwd` 或 `lsof -p <pid>` 或 cgroup 的 `cgroup.procs`，**不能依赖“传了 cwd 参数 = 子进程在那个目录”**。同类型抽象还有：Docker `--workdir` vs 镜像 `WORKDIR`、systemd `WorkingDirectory=` vs `ExecStart=` 、gVisor sandbox root vs container image root——名字、参数名甚至默认值都需逐个看源码确认。

**2. 任何“漂亮的 spawn 抽象”都必须验证 cwd 是显式设置还是隐式继承**

`agent-client-protocol::AcpAgent::spawn_process`、`std::process::Command::new(...).spawn()`、`tokio::process::Command::new(...).spawn()`、`async_process::Command::new(...).spawn()`、FFI 封装的 `subprocess.Popen`、cgroup `clone` 后 exec……默认值都是「继承父进程 cwd」。**默认值不同 → 表现不同**——这在 macOS fork exec 、Linux clone3、FreeBSD rfork、WSL 1/2、容器内 PID 1 都有差异。验证顺序：看源码 `.current_dir()` / `WORKDIR` / `CWD` 设置调用是否存在——比看参数表可靠（参数表可能接受但不使用）。

**3. 验证子进程实际状态是“能动手就别只看代码”**

`/proc/<pid>/cwd`（Linux）、`lsof -p <pid> -d cwd`（macOS）、`/proc/<pid>/environ` 看 `PWD=`、cgroup `cgroup.events` 看容器 root、`ps -o pid,ppid,command,cwd`（Linux）——这些是验证子进程实际状态的最快路径，比单步调试、外部 mock、启动 tracer 快一个数量级。**`/proc/<pid>/cwd` 本质是个 magic：读 symlink 返回的是「子进程认为它在哪里」**，不受其他进程改 cwd 、容器挂载、`chroot` 、`pivot_root` 影响。

**4. shell wrapper 是「无法修改依赖」时的兏底方案**

遇到 `AcpAgent::spawn_process` 这样的 `pub` API 不可改、参数表不接受 cwd、PR 周期漫长——用 `sh -c "cd <dir> && exec <cmd> <args>"` 包装。`exec` 替换 shell 进程保持 PID 不变、信号透传、cgroup 归属、process group 领导不改变。**唯一代价是需要安全转义参数**（POSIX 单引号是黄金标准：'...'\''...'\''...'），加一个 10 行的 `sh_quote` 助手函数成本远低于“”fork 整个依赖 + 改 PR + 等待升级”。该 pattern 也适用于：CLI 包装脚本、Node 子进程传 cwd、Java JNI `Runtime.exec`、Windows `CreateProcess` 缺 `lpCurrentDirectory` 的边缘 case。

**5. 实物检查 > 文档 + 源码推测**

`/proc/<pid>/cwd` 5 秒看到的事实，比读 1000 行 `acp-agent` 源码判断“「这里没设 cwd」」”更有说服力。`readlink /proc/<pid>/cwd` 是第一道武器——可以看多个 agent 进程交叉验证（“一个项目应该看到该项目的 cwd」”——同时存在后端目录的就是 stale spawn）。**调试「「创建出来的东西不对」」 时，能看实际创建的产物（/proc、/sys、container metadata、`/var/log`、sock 文件）先看，再上代码搜索。**

**6. 修一个层别忘了跨层不变量**（补遗）

第一段修复 agent OS cwd 之后，用户上报「修了一半」：FileManager 还是 404。原因：后端 `resolve_session_base` 只查 `tmux_session_name`，ACP session 该列为 NULL，返 None → FileManager 错误。修 agent 但没同步修后端「跟会话走」的文件接口。

**教训**：「「session 的文件上下文」」这个语义贯穿三个进程层（agent OS / 后端 resolve / 前端 FileManager），修一层后必须从入口到 UI 走一遍完整请求流，确认每层都看到一致的 workspace。

## 2026-07-26: 被替换 WebSocket 的晚到事件盖掉新连接状态（重连按钮偶发无反应）

**症状**：终端长时间 idle 自动断开后，点重连按钮有概率无反应，刷新页面才能恢复。

**具体根因（多个叠加，均为「点击看似无效」）**：

1. **晚到事件竞态（测试确凿复现）**：`connectWs` 替换旧连接时只解绑 `onclose` 不解绑 `onerror`，且 handler 里 `setTerminalDisconnected(true)` 无条件执行。对 CONNECTING 中的 socket 调 `close()` 会异步触发 error 事件——用户连点两次重连时，第二次点击废弃的 ws2 的 error 事件在新 ws3 `onopen` 之后到达，把健康连接盖回「已断开」，覆盖层重新弹出。修复：`onclose`/`onerror` 首行 `if (wsRef.current !== ws) return`。
2. **失败的动态 import 被模块级缓存**：xterm addon 的 `import()` promise 在模块顶层缓存，一旦 reject（典型：重新部署后旧 chunk 404，恰与「长时间挂机后」场景吻合）永久失败，每次重连点击都在 `await loadAddons()` 处抛错，无任何提示。修复：catch 后重建 promise 重试。
3. **异步初始化链的异常黑洞**：`createTerminal(...)` 只有 `.finally` 没有 `.catch`，抛错变 unhandled rejection，UI 零反馈。修复：catch 中保持覆盖层 + toast 提示。

**诊断过程要点**：

- 用 mock WebSocket（手动驱动 onopen/onclose/onerror 时序）在 vitest/jsdom 里把「晚到事件」竞态变成确定性复现——竞态类 bug 的 feedback loop 关键是**把事件投递顺序变成测试输入**，而不是指望真实网络重现时序。
- 一个曾被高度怀疑的假设被测试证伪：「Terminal.tsx effect 早退路径丢失 cleanup → session 往返后 xterm 留在已卸载 DOM」。写测试后发现 React reconciliation 按位置/类型复用了 container DOM 节点，xterm 命令式插入的子节点随之幸存，该路径实际不触发。**先写复现测试再定罪**，避免修一个不存在的 bug。

### 可复用的调试理论

**1. 手动管理的事件源被替换时，必须解绑全部 handler 或在 handler 内验证身份**

`ws.onclose = null` 只挡住一个事件；close/error/message 是一组。更稳的模式是 handler 首行做身份校验（`if (currentRef !== this) return`）——它不依赖清理方记得每个事件名，天然免疫晚到事件。适用于 WebSocket、EventSource、MediaStream、任何「旧实例被替换但事件可能仍在飞行」的场景。

**2. 模块级缓存的 promise 会把一次性失败固化成永久失败**

`const p = import(...)` 顶层缓存是常见的预加载优化，但 rejected promise 不会自愈。所有缓存 promise 的地方都要问：reject 后下一次调用者拿到什么？要么 catch 后重建，要么缓存放在函数内按需创建。

**3. 「按钮点了没反应」= 异步链路某环节静默死亡，从点击 handler 顺链路找无 catch 的 await**

点击 → handler 早退（守卫/null ref）→ async 函数抛错无 catch → 状态更新被竞态覆盖，四类都表现为「无反应」。排查顺序：handler 的所有 return 路径 → 每个 await 的 reject 路径 → 状态被谁最后写。给每个静默 return/catch 补用户可见反馈（toast/overlay 文案）本身就是修复的一部分。




---

## 2026-07-26: tmux escape-time 吞掉连按 ESC（opencode 无法中止任务）

**症状**：OmniTerm 终端里跑 opencode，按 ESC 无法中止运行中的任务；本地终端直接跑则正常。

**具体根因**：opencode 中止任务需连按两次 ESC（"esc again to interrupt"）。tmux 收到孤立 `\x1b` 后等待 `escape-time`（默认 500ms）区分 Alt/功能键序列 → 单次 ESC 延迟 500ms 无即时反馈 → 用户自然快速再按 → 第二个 `\x1b` 落入窗口，tmux 将两者合并为 `\x1b\x1b`（Alt+ESC）一次转发 → opencode 收不到两次独立 ESC，中止永不触发。字节级实测：100ms 间隔双 ESC 到达 pane 为单次 `b'\x1b\x1b'`；700ms 间隔为两个独立 `\x1b`。修复：spawn tmux client 时链式 `set-option -s escape-time 10`（`ws/terminal.rs` `build_tmux_attach_cmd`）。

**诊断过程中的正确做法（值得复用）**：

1. **分层二分 + 每层字节级证据**：链路 = xterm.js → WS → PTY write → tmux → pane。在 pane 内程序入口放 raw-mode 字节记录器（`tty.setraw` + `os.read` 打时间戳），从后端模拟每种输入时序，直接观测「到达了什么、何时到达」——比在中间层加日志更快定位。
2. **对协议软件测「时序矩阵」而非单次输入**：单发 ESC 测试会得出「能到达」的误导性结论（它确实到达，只是延迟 500ms）。真正的失效只在「快速连按」时序下出现。对任何涉及转义序列/组合键的链路，必须测：单发、窗口内连发、窗口外连发三种时序。
3. **端到端复现后再下结论**：用 agent-browser 驱动真实浏览器复现了「快按两次失效、慢按两次成功」的完整对照，且 opencode 的 "esc interrupt" → "esc again to interrupt" 提示状态变化提供了免插桩的观测点——TUI 自身的状态提示是最好的探针。

**可复用的理论**：

**1. 终端链路中「字节能到达」≠「语义能到达」**。tmux/终端复用器会对字节流做时序敏感的重新分帧（escape-time 合并、bracketed paste 包裹等）。诊断按键问题时要同时验证字节内容和到达分组：两个 `\x1b` 合并成一个 `\x1b\x1b` 事件，对 TUI 就是完全不同的键。

**2. 「延迟 + 无反馈」会诱导用户行为落入故障窗口**。单次 ESC 延迟 500ms 本身只是慢，但它诱导用户快速重按，恰好触发合并故障。分析用户报告的「完全不工作」时，考虑第一层小故障如何改变用户行为、进而触发第二层大故障。

**3. 经 tmux 的托管终端必须显式设置 `escape-time`**。tmux 默认 500ms 是为 1980s 串行链路设计的；所有把 tmux 当基础设施的产品（web 终端、terminal manager）都应设为 0–50ms。neovim `:checkhealth` 同理建议。

## 2026-07-26: tmux -F 格式串把非打印字节转成字面八进制文本（agent_watch 解析到 0 个 pane）

**症状**：agent_watch 轮询 `tmux list-panes -a -F '…#{…}\x1f#{…}…'` 用 `\x1f`（Unit Separator）做字段分隔符，手动在 shell 里跑同样命令输出正常，但 Rust 侧 `split` 后 `parts.len() == 1`，watcher 始终看到 0 个 pane。

**具体根因**：tmux 对 `-F` 格式串里的**非打印字节**不会原样输出，而是转成字面八进制转义文本——`\x1f`（1 字节）变成 4 个可打印字符 `"\037"`。Rust 按真正的 `\u{1f}` 字符 split 自然切不开。shell 里"看起来正常"是因为肉眼把 `\037` 当成了分隔符位置的杂讯。修复：改用 `:` 作分隔符（tmux session 名不允许含 `:`，中间字段全是数字，唯一自由文本 `pane_title` 放最后一段用 `splitn` 兜住），并在 `FIELD_SEP` 常量上写注释说明原因。

**诊断过程中的错误**：

1. **在两个环境间比较时没有比较字节而是比较观感**：手动 shell 验证时只看"输出有没有分成几段"，没有 `| xxd` 看真实字节。若第一时间 hexdump，`5c 30 33 37`（字面反斜杠+037）与预期的 `1f` 一比即真相大白。
2. **默认怀疑自己的解析代码而不是上游的输出契约**：先反复检查 Rust split 逻辑、字符串转义写法，最后才写独立 probe 测试打印原始输出。对"我发的 X 为什么收到的不是 X"类问题，第一步永远是原样捕获对端实际输出。

**可复用的理论**：

**1. 任何跨进程文本协议的分隔符选型，必须先验证中间层不会改写该字符**。终端多路复用器、shell、日志管道都可能对控制字符做转义/过滤/合并。选分隔符的稳妥顺序：领域内被禁止出现的可打印字符（如 tmux session 名禁 `:`、路径禁 `\0`）> 控制字符（需逐层验证）。

**2. "程序读到的"与"人眼看到的"在含转义序列的输出里可以完全不同**。验证输出格式时用 `xxd`/`od -c` 看字节，而不是肉眼看渲染结果。

---

## 2026-07-29: 批量枚举中单条目错误用 `?` 传播 → Windows 主目录列表 500

**症状**：Windows 正式二进制 `omniterm start` 后，前端浏览 `C:\Users\<name>` 时 `GET /api/v1/system/dirs` 返回 500，整个新建项目目录选择器不可用。Linux/macOS 从未复现。

**根因**：`fs::list_dir` 对每个条目 `fs::metadata(entry.path()).await?`。Windows 用户主目录下存在一批为兼容旧程序保留的遗留 junction（`Application Data`、`Cookies`、`Local Settings` 等），其 ACL 显式 deny 遍历，`metadata` 返回 Access Denied。一个条目失败经 `?` 传播，整个目录列表变成 500。同文件的 `search_recursive` 早已用 `Ok(m) => m, Err(_) => continue` 正确容错——同一模块内两种策略不一致。

**修复**：`list_dir` 的 per-entry `metadata`/`symlink_metadata` 失败改为 `continue` 跳过；子目录计数循环 `next_entry().await?` 改为 `while let Ok(Some(_))`（`src/fs/mod.rs`）。

**可复用的理论**：

**1. 批量枚举 API 中，单条目错误用 `?` 向上传播 = 一颗老鼠屎坏一锅粥**。列目录/批量 stat/递归扫描这类"尽力而为"语义的接口，per-item 错误应跳过（可选记日志），只有容器级错误（read_dir 本身失败）才值得让整个请求失败。写 `?` 前先问：这个错误影响的是整个操作还是当前条目？

**2. "metadata 一定成功"是 Unix 惯性假设，Windows 上不成立**。Windows 用户主目录天然含 ACL deny 的遗留 junction，`GetFileAttributes` 直接 Access Denied。凡是会遍历用户主目录/系统目录的代码，跨平台测试至少要覆盖一次真实 Windows 主目录，CI 的干净 temp 目录测不出来。

**3. 同一模块内已有正确的容错先例时，先对齐再造新逻辑**。`search_recursive` 的 skip-unreadable 模式早已存在，`list_dir` 却用了严格传播——review 时 grep 同类循环的错误处理策略是否一致。

## 2026-07-29: direction:rtl 截断容器把路径尾部斜杠 bidi 重排到视觉开头（「DOM 里不存在的字符」）

**症状**：Windows 上 Sidebar 项目路径显示为 `/g:/Codes/ot/OmniTerm-dev`，多一个前导 `/`；但用户查看元素发现 **DOM 文本里根本没有这个斜杠**。

**具体根因**：DB 里项目路径带尾部斜杠（`g:/Codes/ot/OmniTerm-dev/`）；`.proj-path` 样式用 `direction: rtl` + `text-overflow: ellipsis` 实现「省略号在左、优先保留路径尾部」的截断技巧。Unicode 双向算法下，RTL 段落中 LTR 文本 run 首尾的中性字符（`/` `.` `:` `-` 等）采用段落方向，被重排到视觉另一端——尾部 `/` 「跳」到了最左边，看起来像前导斜杠。修复：外层保留 `direction: rtl`（截断效果不变），内容包 `<bdi dir="ltr">` 做双向隔离；同病同修三处（Sidebar `.proj-path`、GitPanel `.git-file-path`、FileManager `.fm-td-time`）。

**诊断过程中的错误（上一轮）**：

1. **同一症状只找了一个根因就收工**：首次报「路径多前导 /」时，在 FileManager 面包屑找到了真实的字符串拼接 bug（无条件 `'/' + joined`）并修复，但没有全局搜索「还有哪些地方渲染路径」——Sidebar 的同症状是完全独立的另一个根因（bidi）。**同一视觉症状在多处出现时，每处都要独立验证根因，不能修好一处就推定全部同源**。
2. 用户的「DOM 里没有这个字符」观察是决定性线索：它直接排除了所有 JS 字符串拼接路径，剥下只剩 CSS 伪元素（`::before` content）和文本渲染层（bidi、ligature、font shaping）两类嫌疑人。

**可复用的理论**：

**1. 「页面上看得到、DOM 里搜不到」的字符，嫌疑人只有两类**：CSS 生成内容（`::before/::after` 的 `content`）和文本渲染层重排（bidi 算法、连字、RTL/LTR 混排）。按这个分类直接搜 `content:` 和 `direction:`，比盲查字符串拼接快得多。

**2. `direction: rtl` 截断技巧必须配套双向隔离**。用 RTL 实现左侧省略号时，LTR 内容首尾的中性字符会被 bidi 重排（尾部 `/` 变前导、前导 `.` 变尾部、日期段颠倒）。标准做法：容器 `direction: rtl`，内容 `<bdi dir="ltr">`（或 `unicode-bidi: isolate` + `direction: ltr`）。凡新增 RTL 截断样式，隔离是必选项不是优化项。

**3. Unix 路径会掩盖这类 bug，Windows 盘符路径会暴露它**。`/home/…/` 被 bidi 把尾斜杠挪到开头后仍是「斜杠开头」，视觉上正确；`g:/…/` 则立刻露馅。跟平台无关的渲染 bug 可能只在某平台的数据形态下可见——「只在 Windows 复现」不等于「平台相关代码的 bug」。

## 2026-07-29: psmux 遇 `;` 链式命令不进交互 attach → Windows 终端只剩 "attached" 提示无 shell

**症状**：Windows 上创建 tmux 会话后，终端只显示 `[已连接][已附加到 lt_xxx]`，无工作区路径、无 shell 提示符，完全无法输入。后端日志关键证据：`tmux process exited: Some(Some(0))`——client 刚 spawn 就正常退出。

**具体根因**：Windows 上 tmux 由 psmux 平替（winget 同时安装 `tmux.exe`/`psmux.exe`/`pmux.exe` 别名，`-V` 均报 `tmux 3.3.6`）。后端 `build_tmux_attach_cmd` 用链式命令 `set-option -s escape-time 10 ; new-session -A -s <name>`：真 tmux 执行完链式命令后照常进入交互 attach，而 **psmux 一旦命令行含多条命令就进入一次性命令模式，执行完直接 exit 0 不 attach**。修复：`build_tmux_attach_cmd` 按平台 cfg 拆分，windows 版只跑纯 `new-session -A`，escape-time 改为 attach 前单独一次性 `set-option`（`src/ws/terminal.rs`）。

**诊断过程中的弯路**：

1. **首轮怀疑错了方向——binary 名不匹配**：`check_multiplexer` 检测 psmux 但所有命令硬编码 `tmux`，看似矛盾。`where.exe` 实测发现 winget 已装 `tmux.exe` 别名，binary 解析没问题。**先验证「命令能不能找到」再分析「命令行为对不对」**，两者是独立失败层。
2. **管道下测试有迷惑性**：用普通 stdin/stdout 管道跑 attach 类命令，psmux 只打印版本号就退出（非 TTY 环境拒绝 attach），与 ConPTY 下行为完全不同，无法得出任何结论。最终用 portable-pty 写了临时探针（模拟后端真实 openpty+spawn 链路）才复现差异。
3. **psmux attach 前会发 DSR 光标探针 `\x1b[6n` 等待回复**：探针初版只读不写，收到 4 字节后永久卡住，误以为 psmux 挂死。真实链路里 xterm.js 会自动回 `\x1b[1;1R`；探针补上这一手后两种行为（链式→exit 0 / 单命令→完整屏幕重绘）立刻区分开。

**可复用的理论**：

**1. 平替实现只保证主路径兼容，边缘语法是兼容断裂带**（AGENTS §8 的实例）。drop-in replacement（psmux/busybox/mawk 这类）对核心子命令兼容度高，但链式命令、引号展开、隐式默认值这类「语法胶水」最容易行为分岔。对平替实现只用最简单的单命令调用，复合需求拆成多次调用。

**2. 「退出码 0 + 无输出」是「命令被理解成另一种模式」的特征签名**。崩溃/找不到命令会非零退出，而 exit 0 说明程序认为自己正确完成了工作——它执行的「工作」和你以为的不是同一个。此时该做的是逐项剔除参数找到触发模式切换的那一个，而不是查崩溃日志。

**3. 诊断交互式程序必须复制它的真实运行环境（TTY/ConPTY）**。很多程序检测 `isatty` 后切换行为，管道下的表现与真实链路可以完全不同；若目标程序还会发终端探针（DSR/DA 查询），诊断工具还得扮演终端回复它，否则看到的是「卡死」假象。

## 2026-07-29: Windows 会话切换可见延迟（「已连接」横幅停留）——热路径上每连接串行 spawn 子进程

**症状**：Windows+psmux 切换会话时能看到 `[已连接][已附加到 lt_xxx]` 横幅停留片刻才出现会话内容；Linux+tmux 上同一横幅瞬间被重绘覆盖，感知不到。

**具体根因**（两部分叠加）：

1. **自身可消除开销 ~40ms**：上一轮修复引入的 `apply_escape_time_workaround` 每次 WS 连接都串行 `await` 一条一次性 psmux 命令，实测 ~35-40ms。但 escape-time 是 server 级持久选项，设成功一次即全局生效。修复：static AtomicBool 成功后缓存跳过 + 调用方 `tokio::spawn` fire-and-forget（失败如 server 未起不置位，下次重试）。
2. **Windows 固有成本 ~100-200ms**：每次切换 = 新建 WS + 重新 spawn psmux client。portable-pty 探针实测分解：ConPTY openpty ~8ms、spawn ~26ms、attach 首字节 ~18ms、DSR 探针往返 + 全屏重绘 ~45-140ms。Linux 全链路 <10ms，所以同一横幅无感知。彻底消除需保活 client/连接池，属 pty-engine Phase 5 范围，不在 tmux 冻结代码内做。

**诊断过程的弯路**：

1. **先被文案带偏**：grep「恢复会话」命中的是 ACP chat 的 `chat.session.restore`，与终端无关。用户描述的文案未必是目标链路的文案，定位前先确认文案属于哪个模块，再倒推用户真实感知的是什么（这里是终端横幅→重绘的空窗期）。
2. **先怀疑了控制模式**：以为 psmux 不支持 `-C` 导致 `ensure_session` 每次重建。查后端日志证实 psmux 控制模式正常产生 `%output`，且 `SessionActivityMonitor` 按会话名 HashMap 缓存只建一次——看日志时间戳比读代码推测更快排除嫌疑。
3. **删 workaround 前先验证它是否还必要**：用 `tmux -L probe_default` 独立 socket 起干净 server 验证 psmux 默认 escape-time 也是 500ms → workaround 必须保留，只能降频不能删。

**可复用的理论**：

**1. 热路径上每次串行 spawn 子进程，先量化单次成本再决定放哪里**。Windows 进程 spawn ~30-50ms，是 Linux 习惯（fork+exec ~1-5ms）的盲区；同一代码在 Linux 上「免费」的每请求子进程调用，在 Windows 上直接变成可感知延迟（本文档 `list_workspaces` 串行 git spawn 是同一模式的另一例）。

**2. 幂等的、目标状态持久的副作用 → 「成功一次后缓存跳过 + fire-and-forget」模式**。判断三问：目标状态是否持久（server 级选项 vs 会话级）？失败能否下次重试（不置位即可）？调用方是否真需要等结果（ESC 手感优化不阻塞 attach）？三者都成立就不该在热路径上 await。

**3. 「只在某平台慢」的体感问题，先分解链路各段耗时再下结论**。用临时探针（复制真实链路：openpty→spawn→首字节→重绘完成逐段计时）把「感觉慢」变成数字表，才能区分可消除开销（自己加的 40ms）与固有成本（平台 100-200ms），避免在固有成本上白费力气或把可消除开销当成命运接受。
