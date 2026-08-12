# 布局与 CSS — 调试模式

覆盖：flex 三件套、共享 CSS 类隐性契约、visual viewport 三层模型、containing block、RTL bidi 隔离、table-layout、white-space、底部不可见分层排查清单。

---

## 模式 1：flex 子项必须显式 minHeight: 0

**布局-flex**：flex 布局里 `flex: 1` 子项默认 `min-height: auto`，无法收缩到内容最小高度以下。内容 min-content 很大时（聊天长列表、长 pre），flex-grow 分配的高度被顶高，容器被撑爆，父容器 `overflow: clip` 把后续兄弟（底部导航、输入区）静默裁掉。诊断信号：**子项 computed `height` = 内容自然高度，而不是 flex 分配高度**。修复：`flex: 1` 子项加 `minHeight: 0`。这是「弹性布局三件套」（flex:1 + minHeight:0 + overflow）里最容易漏的一件。

**适用**：flex-col 容器 + 内部长内容 + 外部 overflow clip 的组合；移动端布局尤其。

**案例证据**：
- 2026-07-31 移动端 ACP 会话底部不可见（第三次「底部不可见」根因）：strip 容器 `flex-1 overflow-hidden` 缺 minHeight:0，ACP 长消息列表 min-content 2132px 撑爆 strip，MobileNav 与 ChatInput 被裁。修复：strip 加 `minHeight: 0`。

---

## 模式 2：共享 CSS 类名是隐性契约

**布局-类复用**：复用一个带副作用样式类（`.terminal-panel-pixel` 的 `overflow: clip`、`touch-action: none`）之前，先问：它的 overflow/touch-action/pointer-events 等行为类属性对我的组件意味着什么？外观（背景/边框/阴影）与行为（overflow/touch）应分离，跨域复用只取外观。

**适用**：跨组件复用 CSS 类做外观容器时；「底部不可见」类症状先扫共享样式类。

**案例证据**：
- 2026-07-31 第二次「底部不可见」：ChatView 复用 `.terminal-panel-pixel`，空间不足时输入区被 `overflow: clip` 静默裁掉，移动端聊天列表触摸滚动被禁。修复：内容容器改内联样式仅复刻外观 + 输入区 `flexShrink: 0` + 可牺牲内容 `flexShrink: 1 + minHeight: 0 + overflow: hidden`。

---

## 模式 3：visual viewport 三层模型（vv 三元组）

**布局-移动端**：移动端"页面上移/底部裁切"有三个独立层，逐层排查，修掉一层不代表根治：① 布局滚动（`window.scrollY`/祖先 `scrollTop`，`overflow: clip` + `scrollTo(0,0)` 可治）；② visual viewport pan（`vv.offsetTop`，键盘挂起时浏览器在布局视口内平移**不是滚动**，`scrollTo` 是 no-op，Android 上 `scrollY` 恒 0）；③ 布局视口缩放（`interactive-widget`/dvh）。诊断用三元组 `window.scrollY / vv.offsetTop / vv.height` 快照定位在哪一层。浏览器状态值有数学不变量（`offsetTop + height ≤ innerHeight`），防御性钳制优于信任事件。

**适用**：移动端键盘弹出/收起的布局适配；隐藏 input 的聚焦滚动（xterm `_syncTextArea` 钉在光标行 → IME 弹出必然 pan）。

**案例证据**：
- 2026-07-31 移动端键盘弹出后底部裁切二次复发：布局只消费 `vv.height`、锚在 y=0，pan 后整体上移、底部离开可见区。修复：`useKeyboardHeight` 跟踪 `vvOffsetTop`，根容器 `translateY(offsetTop)`；`offsetTop` 按不变量钳制。

---

## 模式 4：transform/will-change 祖先链创建 containing block

**布局-containing block**：`will-change: transform` / `transform` 会把后代 `position: fixed` 的包含块从视口改为该元素。300% 宽的滑动容器内部 fixed 弹层，几何基准变容器 → 弹层宽度膨胀、位置错位。排查「弹层出现在奇怪位置/尺寸」时，先沿祖先链找 transform/will-change/perspective/filter。修复：fixed 弹层 `createPortal(children, document.body)` 恢复相对视口。

**适用**：滑动轮播/3D 变换容器 + 内部弹层；Modal 是所有确认框的基座，修基类一处覆盖全部继承者。

**案例证据**：
- 2026-07-31 移动端 modal 被 300% pane strip 拉走，backdrop 宽 1170px，按钮裁出屏幕。修复：Modal/UpdateBadge/粘贴菜单三处 fixed 弹层 createPortal 到 body。

---

## 模式 5：RTL 截断技巧必须配套 bidi 隔离

**布局-bidi**：用 `direction: rtl` 实现「省略号在左、优先保留路径尾部」时，LTR 内容首尾的中性字符（`/` `.` `:` `-`）被 bidi 重排到视觉另一端（尾部 `/` 变前导）。标准做法：容器 `direction: rtl` + 内容 `<bdi dir="ltr">`（或 `unicode-bidi: isolate` + `direction: ltr`）。**「页面上看得到、DOM 里搜不到」的字符，嫌疑人只有两类**：CSS 生成内容（`::before/::after` content）和文本渲染层重排（bidi/连字）。

**适用**：路径/日期/ID 类文本的左侧省略号截断；Unix 路径会掩盖此类 bug（尾斜杠挪开头仍像斜杠开头），Windows 盘符路径暴露它。

**案例证据**：
- 2026-07-29 Sidebar 项目路径显示 `/g:/Codes/...` 多前导斜杠，DOM 文本里根本没有。修复：外层 rtl + 内容 `<bdi dir="ltr">`；同病同修三处（Sidebar/GitPanel/FileManager）。

---

## 模式 6：列宽拖动必须 table-layout: fixed 且 colgroup 与 thead 对齐

**布局-table**：`table-layout: auto` 下 col width 几乎被忽略，列宽按内容/比例分配，拖动时 handle 跑在鼠标前后。`colgroup` 列数必须与 `thead` 列数一致——多出来的 col 按内容占视觉空间，ref 指向的 col 与视觉列错位。`getBoundingClientRect().width` 是拖动时唯一可信的「当前宽度」，state 永远滞后于实际布局。

**适用**：任何表格列宽拖动/调整；colgroup 有条件渲染的列时对齐数量。

**案例证据**：
- 2026-06-30 FileManager 列宽拖 A 列改 B 列（colgroup 5 col vs thead 4 th，downloadMode 缺 checkbox th）+ 拖动错位 70px。修复：`table-layout: fixed` + col 条件渲染 + startW/finalW 读 bbox。

---

## 模式 7：长行渲染显式选 white-space

**布局-文本**：`pre` 是「不换行」，不是「保留格式」。diff/代码查看器用 `pre-wrap` + `overflow-wrap: anywhere`（后者兜底无空格超长 token：minified/base64/长字符串字面量）。排查「长行显示不全」先 grep 目标容器 `white-space`；「同文件里旁边就是正确写法」是最快对照实验。

**适用**：diff 视图、日志、代码预览任何可能含长行的容器；以及任何会展示路径 / 分支名 / URL / hash 的弹窗与面板。**`max-width` 只管盒子宽度，不管内容溢出**——盒子被 `max-w-*` 限住了，不能换行的文本照样画到边框外。兜底属性要加在**共享容器**（Modal body）而非每个调用方，否则每个新弹窗都会重犯一次。

**案例证据**：
- 2026-08-01 git diff 长行横向溢出被裁（419px 容器内撑到 3104px）。修复：`.git-diff-line` 改 `pre-wrap`、`.git-diff-text` 加 `overflow-wrap: anywhere`。
- 2026-08-10 删除 worktree 弹窗里的长路径（opencode 的 40 位 hash 目录）冲出弹窗右边界约 320px。修复：`Modal` body 加 `overflow-wrap: anywhere`（一处覆盖 8 个弹窗 + 所有 `ConfirmDialog` 调用点）。验证手法：**把修复属性临时改回 `normal` 再截一张对比图**，比“看起来好了”可信——CSS 修复很容易因为数据恰好不够长而假阳。

---

## 模式 8：嵌套滚动容器的流式内容要有自己的锚定逻辑

**布局-锚定**：外层滚动锚定只保证外层容器贴底，不保证嵌套滚动窗口里看到最新内容——外层底部是内层窗口的下边缘，不是内层流式文本的末尾。凡是「内容在带 `maxHeight` + `overflow` 的嵌套容器里流式增长」的组件（thinking 块、工具输出预览、日志面板），都必须问：这个嵌套窗口自己有跟随逻辑吗？**外层钉底 ≠ 内层贴尾**。

**流式锚定标准三件套**：默认跟随（stick 初值 true）→ 用户上翻即解除（onScroll 按 `scrollHeight - scrollTop - clientHeight < 阈值` 判定）→ 滚回底部自动恢复。渲染帧级更新用 `useLayoutEffect` 而非 `useEffect`（绘制前钉住，零闪烁）。

**适用**：流式输出 + 嵌套滚动窗口；先确认报的是哪条滚动条（外层 vs 块内）。

**案例证据**：
- 2026-07-31 ACP thinking 块大量流式更新时块内滚动条不贴底，最新思考内容在折叠线以下。修复：ThoughtBlockView 加 scrollRef + stickRef + onScroll + useLayoutEffect（仅 streaming 且 stick 时 `scrollTop = scrollHeight`），展开时恢复 stick。

---

## 模式 9：全局 zoom 祖先会放大 fixed 弹层的 translate 值

**布局-zoom 缩放**：CSS `zoom`（界面缩放实现）不改变 fixed 元素的 containing block（仍相对视口），但会把 fixed 后代的**绘制与 transform 长度单位按因子 z 放大**——`transform: translate(clientX px, ...)` 里的 px 值被放大 z 倍，物理位置 = 值 × z，元素自身尺寸也同步放大 z 倍。因此在「全局 zoom 容器 + fixed 弹层用视口物理坐标（`clientX/clientY`）做 translate」的组合里，**translate 坐标必须除以 z**（外层 zoom 恰好把它放大回物理像素，`translate(x/z, y/z) × z = x`）；若弹层自身再套一次 zoom，则是双重缩放，偏差随鼠标/视口位置线性增大，离原点越远越离谱。

**诊断信号**：`getBoundingClientRect()` 的 x/y ≈ 预期值 × z 且元素宽高也放大 z 倍；界面缩放 = 100% 时完全正常，≠ 100% 时明显错位——先怀疑坐标值，实测 rect 再定罪，别在偏移常数上瞎调。修复后对照 `Layout.tsx` 里 `translateY(vvOffsetTop / zoom)` 的既有补偿惯例。

**适用**：任何跟随指针/视口的 fixed 悬浮层（拖拽预览、tooltip、自定义 menu）在全局 zoom 容器内用物理坐标定位时。

**案例证据**：
- 2026-08-12 FileManager 拖拽预览不贴鼠标：鼠标 200px 处预览落 265px（z=1.25），且预览自身又套了 `zoom: uiZoom/100` 二次缩放。修复：去内层 zoom，translate 除以 z。

---

## 元模式：底部不可见分层排查清单

「底部不可见」累计 4 个独立根因，每次都是新层——**同一症状反复出现时，不要假设上一轮修的就是根因**，按以下顺序逐层排查：

1. **布局高度消费不全**：容器高度漏算（vvHeight 漏 offsetTop）→ 底部在视口外。
2. **translateY 补偿（pan）**：visual viewport pan 残留陈旧 offsetTop → 布局被推出视口。
3. **容器 overflow clip 裁切**：flex 溢出被 clip 静默裁掉（共享 CSS 类/固定高度容器）。
4. **flex min-height:auto 撑爆**：子项 min-content 顶高容器（见模式 1）。

**每轮修复后必须按目标平台验证**（桌面验证通过 ≠ 移动端正常，两条独立布局链）；headless 设移动端 viewport（matchMedia 断点自动触发 isMobile）+ 覆写 visualViewport + dispatch resize/scroll 模拟键盘/pan。
