# React 与前端 — 调试模式

覆盖：key 重挂载、同步→异步破坏 cleanup、依赖数组对象字面量、mousemove setState 重渲染、三态 loading、高频流聚合、StrictMode 异步回调。

---

## 模式 1：key 只承载「必须重建」的维度

**React-key**：key 变化 = 整棵子树 unmount + remount。当组件内部已为「会话切换」实现原地重连，key 却在每个 id 变化时强制重挂载，内部重连逻辑全部变死代码。**key 应该只承载「必须重建」的维度**（视图类型），同一类型内的切换交给组件自身生命周期 effect。判定：key 值的变化是否会同时改变渲染的组件树？不会，就不要用它做 key。

**适用**：列表/切换类组件的 key 设计；先确认组件内部是否已有「状态变化时原地重连」的 effect。

**案例证据**：
- 2026-08-01 `key={activeSessionId}` 导致每次切 tmux 会话整个 Terminal 重挂载，黑屏 250ms（xterm 销毁重建 + 新 WS 握手 + attach 全屏重绘）。修复：key 改视图类型 `'empty'|'tmux'|'acp'|'external'`，tmux↔tmux 保持挂载由 `useTerminal` 原地重连。

---

## 模式 2：同步→异步重构会破坏框架隐式原子性

**React-async-init**：React effect cleanup 依赖「effect 返回前完成所有副作用设置」的隐式前提。改为 async 后前提被打破：cleanup 跑时副作用还没开始，ref 为 null，cleanup 变空操作。**每个 await 都是竞态窗口**——await 之后的「状态修改 + DOM 操作」序列都要加 `if (signal.aborted) return` 或等价 guard。凡是把同步初始化逻辑改为 async 的重构，必须同步审视 cleanup 路径是否仍有效。

**适用**：动态 import addon / 懒加载资源 + effect 初始化的组件；StrictMode dev-only 行为但必须在 dev 下测过才能宣称修复有效。

**案例证据**：
- 2026-07-08 `createTerminal` 改 async（动态加载 xterm addons）后，StrictMode cleanup 在 await 期间是空操作，两个并发 `term.open()` 覆盖同一容器 DOM，输入错位黑屏。修复：AbortController，await 后检查 aborted 才碰 DOM。

---

## 模式 3：render 中创建的对象字面量绝不能进依赖数组

**React-deps**：render 中新建的对象字面量（`{}` / `[]`）引用每次渲染都不同（`===` 永远 false），放进 `useCallback`/`useEffect`/`useMemo` 依赖数组会引发死循环刷新。TypeScript 无法检测此 bug——对象内容相同但引用不同。**必须用 `useMemo` 稳定引用**；依赖数组里有对象时向上追溯其来源。

**适用**：`fmSource = { type: 'session', id }` 类每次渲染新建的对象。

**案例证据**：
- 2026-06-27 `/files` 接口被疯狂重复请求。修复：`useMemo` 包裹，仅 `activeSessionId`/`activeWorkspaceId` 变化时创建新对象。

---

## 模式 4：高频事件 setState = O(组件) 重渲染

**React-性能**：大组件中 `mousemove`/`scroll` 触发 `setState` 等于 O(组件大小) 重渲染。应只更新 DOM（inline style 直写），松手时再 sync state 一次。同理高频 mousemove 中避免同步 I/O（localStorage）、CSS transition 影响拖拽响应性。

**适用**：拖拽条、列宽调整、滚动条等 60fps 交互；大列表组件。

**案例证据**：
- 2026-06-30 FileManager 列宽拖动 mousemove 每帧 `setColWidths` → 958 行巨组件完整重渲染，文件多时卡顿。修复：mousemove 只写 `<col>` DOM 宽度，mouseup 同步 state 一次。
- 2026-06-23 侧栏拖拽条：mousemove 写 localStorage + 200ms transition。修复：松手持久化一次 + 拖拽时禁 transition。

---

## 模式 5：UI dispatch 依赖多个异步加载状态时的三态区分

**React-三态**：`id 从 localStorage 同步恢复` vs `数据从 API 异步加载` 是两种时序。第一帧数据未到时 `find` 返回 undefined → 分发到 fallback view（可能误开错误的连接）。区分三种状态：`id==null`（空态）→ `id!=null && data==null`（loading 占位）→ `id!=null && data!=null`（就绪主 view）。

**适用**：任何「从本地恢复 id / 从 API 加载数据」两相异步的组合。

**案例证据**：
- 2026-07-19 首页 session 未加载时误开 tmux WS（实际是 ACP 会话）。修复：`SessionView` 在 `id && !data` 时渲染 loading 占位。

---

## 模式 6：高频事件必须聚合，不能 fan-out 也不能 drop

**React-聚合**：高频状态流（ToolCall × N + ToolCallUpdate × M）直接 fan-out 会刷屏，直接 drop 违反「用户可感知」。**可感知 + 不刷屏**：store 维护「聚合消息 id」（按周期重置）+ 按主键覆盖更新，同一周期内相关事件只占一条消息。

**反模式**：直接 drop（失去可见性）/ 每条独立 push（刷屏）/ 按数量阈值丢弃（状态不连贯）。

**适用**：流式 tool call / 进度事件渲染。

**案例证据**：
- 2026-07-19 ACP ToolCall 刷屏。修复：`upsertToolActivity` 聚合，`beginPrompt` 重置聚合状态。

---

## 模式 7：StrictMode 让异步回调与 useRef 错位

**React-StrictMode**：StrictMode 跑 mount→cleanup→remount，cleanup 关 ws1 但 ws1.onclose/onerror 异步事件触发时 ws2 已接管 ref。旧 onclose 置 null → 新 socket send 见 ws=null bail；旧 onerror 写 error state → 健康连接显示横幅。Chrome "WebSocket is closed before the connection is established" 是本地 cleanup 关 CONNECTING socket 的正常日志，不是后端拒绝。

**适用**：所有手管 WebSocket/EventSource 的组件；处理见 `async-race.md` 模式 5（identity guard）。

---

## 模式 8：后端重放的权威状态，前端不得用无关的本地收尾语义单方面清除

**React-状态权威**：后端持续重放/维护的状态（未决审批、running 态、session 状态），合法清除路径必须与权威来源对齐——只能被后端事件（resolved 广播 / error / 崩溃）清除，不能被本地簿记（turn 收尾）单方面否决。「turn 结束」与「未决审批失效」可能没有蕴含关系。**任何「重连/刷新后状态丢失」的 bug，先在状态机里枚举所有写该状态的 action，再逐条核对触发条件**——bug 往往藏在最不像嫌疑的写方里（语义上无关的收尾 action）。hydrate 门控缓冲会反转 gated 帧与非 gated 帧的到达顺序——连接早期的帧序不代表派发序。

**适用**：前端 store 维护后端权威状态（审批、运行标记、重放缓冲）；重连/刷新后状态丢失的排查。

**案例证据**：
- 2026-08-07 ACP ExitPlanMode 权限请求长挂后 banner 消失、会话卡死：hydrate 门控缓冲把 `turn_state{active:false}` 延迟回放，晚于立即派发的 `permission_request` → 回放触发 `markDone` 清掉 `pendingPermission`（本地收尾否决了后端仍挂着的审批）。修复：`markDone` 不再清 `pendingPermission`，合法清除只剩 `permission_resolved` 广播与 `markError`。

---

## 模式 9：慢速拖动位移未达 slop 也会滚动内容——滚动检测必须看 scrollTop 而非触点位移

**React-手势滚动**：长按/滑动分流等手势判定，用「触点位移 > 阈值」识别滚动不可靠——慢速拖动（每帧位移 < slop，如 10px）时内容已滚动但位移始终不达标，手指停住后长按计时器到期误触（用户「只是滑动上下文」却弹出功能菜单，且关闭后再次轻触静止循环复现）。**滚动的最可靠信号是滚动容器 scrollTop 变化 / scroll 事件，与触点位移大小无关**：位移未达阈值时补查 touchstart 时缓存的最近滚动容器（overflow-y auto/scroll）scrollTop，变化即取消长按；滚动停止后的新触摸加冷却期（如 400ms）不启动计时，覆盖「滚动后轻触静止」误触。scroll 事件不冒泡但捕获阶段在 window 上可统一监听（`{capture:true}`），模块级注册一次即可覆盖所有滚动容器，无需逐消费方传信号。

**适用**：移动端长按/拖拽/滑动手势分流；「滚动/滑动后误触 X、关掉又循环触发」类 bug；长按取消逻辑只依赖位移阈值的实现。

**案例证据**：
- 2026-08-18 移动端滑动聊天上下文时手指停在气泡上触发功能菜单、关闭后按任意气泡又触发：慢速拖动 scrollTop 已变但位移 < 10px，`useLongPress` 计时器未取消。修复：scrollTop 变化即取消 + 滚动后 400ms 冷却；终端长按粘贴菜单同修复。
