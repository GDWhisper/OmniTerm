# ACP 会话导出 Markdown

> 状态：**已归档（2026-10-21）**——已实施（2026-10-21），实施记录与验收对照见本文
> 触发条件：改 `frontend/src/utils/messageMarkdown.ts` / `sessionMarkdown.ts` / `sessionExport.ts` / `hooks/useSessionExport.ts`、新增/改会话级导出、动侧栏会话右键菜单或消息分页链路前**必读**
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md` F08（本文是它的落地计划）、`docs/dev/plans/backlog/improvement-directions-remaining.md` X02（本文承担 X02 的「导出」半边）、`docs/dev/performance-and-safety.md` §P1/§P5

## 0. 实施记录（2026-10-21）

**落地文件**

| 文件 | 作用 |
|---|---|
| `frontend/src/utils/messageMarkdown.ts` | 加图片渲染分支（`images: 'omit' \| 'inline' \| 'placeholder' \| 解析器`），单条复制默认 `omit`（行为逐字不变） |
| `frontend/src/utils/sessionMarkdown.ts` | 纯函数 `sessionToMarkdown`（头部说明 + 条数/字节双上限 + 图片按预算逐图决策） |
| `frontend/src/utils/sessionExport.ts` | `fetchAllMessages`（独立分页拉全量 + 载荷预算）、`downloadMarkdown`（Blob 下载 + 释放 object URL）、`exportFileName`（文件名清洗） |
| `frontend/src/utils/markdownI18n.ts` | 导出件的 **i18n 接线**：导出件用到的全部 i18n key 只有这一处（序列化器是纯函数，不依赖 react-i18next） |
| `frontend/src/utils/textBytes.ts` | UTF-8 字节数（`length` 是 UTF-16 code unit，中文会低估一半） |
| `frontend/src/utils/storedMessages.ts` | `GET /messages` 行的**单一类型定义** + 行 → `ChatMessage` 的**单一转换** `toChatMessages`（原在 ChatView 私有，导出侧也要用）+ 原始帧包裹判定 `isRawFrameWrapper`（原在 useAcpChat）。blocks **解码器是注入参数**：真解码器 `decodeStoredBlocks` 住在 `hooks/useAcpChat.ts`（要经重放分类器还原），而 `utils/` 不反向依赖 `hooks/` |
| `frontend/src/hooks/useSessionExport.ts` | 导出的**编排**（取数 → 转换 → 拼装 → 下载 → toast）。放 hook 而非 util：它需要界面语言（`t`）、agent 注册表与 toast 出口——塞进 util 会让 util 依赖 react-i18next/store，破坏「utils = 共享纯函数」分层 |
| `frontend/src/components/Sidebar/SessionContextMenu.tsx` | **入口**：会话右键/长按菜单的「导出为 Markdown」项（仅 ACP 会话显示） |
| `frontend/src/components/Chat/ChatView.tsx` | 只保留 hydrate/分页的 `toChatMessages` 调用（转换已下沉到 utils） |
| `frontend/src/index.css` | `.panel-title-bar .title-bar-icon-btn`（透明底、无边框，区别于不可点的状态徽章） |

**实施偏差（相对本文 D1–D9 的补充决策，均为「原计划未涉及」的部分）**

1. **导出件的文案跟随界面语言**（维护者拍板：2026-10-21「导出的要做 i18n」）。
   实现：`messageMarkdown.ts` / `sessionMarkdown.ts` 是纯函数、不依赖
   react-i18next，文案经 `markers` / `labels` 参数注入；界面语言版本由
   `utils/markdownI18n.ts` 依 i18n key 构造（**导出件用到的 key 只有这一处**）。
   - **两种载体一起本地化**：会话级导出 + 消息级「复制为 Markdown」（后者经
     `MessageActionContext.markers` 注入——动作注册表是模块级常量，拿不到 `t`）。
     只改其一会让两条导出路径分叉，违反 D1。
   - **不本地化的部分**：`## Agent:` / `## Turn:` 两行是导出**格式**的字段名
     （既有单条复制产物逐字如此），不是散文；改它等于改格式，收益低于破坏面。
   - **默认仍是中文**（`DEFAULT_MARKERS` / `DEFAULT_SESSION_LABELS`）：序列化器
     不传参数时行为与实施前逐字不变，纯函数模块仍可在非组件上下文里复用与单测
     （口径同 `utils/sessionDisplayName.ts`）。
2. **入口从「聊天面板标题栏按钮」改为「侧栏会话右键/长按菜单」**
   （维护者拍板 2026-10-21：不要放在 ACP 会话顶部，挪到 sidebar 的会话右键菜单）。
   连带决策：
   - **只有 ACP 会话显示该项**——终端（tmux/pty）会话没有 `chat_messages`，
     导出必然是空文件，给一个点不出结果的菜单项不如不显示。
   - **导出的是「被右键的那个会话」**，与当前打开哪个会话无关——这恰恰是它
     不必待在聊天面板的理由（聊天面板只在 active 会话是 ACP 时挂载）。
   - **归档区块不加该菜单项**：`ArchivedSessionsSection` 刻意与主列表保持差异
     （行内按钮、无右键菜单，见 2026-09-10 侧栏菜单计划）——不为此破例。
   - 导出编排因此从 ChatView 下沉到 `hooks/useSessionExport.ts`；行 → 消息的
     转换也随之从 ChatView 私有函数下沉到 `utils/storedMessages.ts`（导出侧
     要用同一份转换，否则导出的正文口径会与气泡里看到的不一致）。
3. **被省略部分的字节数是估算**（按 `text` 列长度代理）。
   工具输出在 `blocks` 列里、不在 `text` 列，故工具重的消息会被低估；头部写
   「约」字样。条数是精确值。
4. **拉取阶段多了一个原始载荷预算**（`EXPORT_MAX_PAYLOAD_CHARS` = 32 MiB 字符）。
   渲染上限是 8 MiB，但原始载荷通常远大于渲染结果（工具输出在导出件里只留
   40 行）。不设这个上限时，「400MB 工具输出」的长会话会把 200 页 × 2MB
   全部拉进浏览器内存。触顶即停并标记 `truncated`，头部与 toast 都写明
   「更早的历史未包含」——**不静默产出残缺文件**。
5. **文件名做了保守清洗**（路径分隔符等换成 `_`，控制字符剔除，空名兜底
   `session.md`）：会话名由用户/agent 决定，直接当文件名会被浏览器截断。

**验收对照**

| 验收项 | 结果 |
|---|---|
| 导出件含全部已落库消息（独立分页拉全量） | ✅ 实测：15 行会话导出 14 条（1 条 system 按 D7 排除） |
| 头部含导出时刻 / 图片口径 / 省略量 | ✅ |
| 图片 data URI 内联 / 超预算降级为可见占位符 | ✅ 单测 + 纯函数锁死 |
| 工具调用 40 行截断标注可见 | ✅（复用既有口径） |
| system 消息不导出 | ✅ |
| 双上限触发仍能下载且写明省略量 | ✅ |
| `URL.revokeObjectURL` 被调用 | ✅ 单测断言 |
| 非 ACP 会话不出现导出入口 | ✅ 菜单项按 `runtime_kind === 'acp'` 过滤（终端会话无 `chat_messages`，导出必为空文件） |
| 入口在侧栏会话右键菜单 | ✅ 组件测试（ACP 显示 / 终端不显示 / 点击回调）+ Chromium 实测：右键会话行 → 菜单三项 → 导出成功 |
| 真实浏览器端到端 | ✅ Chromium 实测（右键菜单入口）：菜单三项（批量操作/重命名/导出为 Markdown），点击产出 `oh-my-pi_1001-1422.md`（401 KB，头部与正文正确）；zh/en 双语各自验证 |
| 导出件文案跟随界面语言 | ✅ Chromium 双语实测：en → `# Session export: …` / zh → `# 会话导出：…`（组件测试亦有语言切换用例） |

## 1. 背景

原计划 F08「会话导出 Markdown — ChatView 工具栏按钮，将结构化 blocks 序列化为 Markdown 下载」自 2026-07-27 挂起至今，未实施。

2026-10-21 可行性审查结论：**这是四项未完成功能里唯一零阻塞项**——

- 单条消息导出**已有现成实现**：`frontend/src/utils/messageMarkdown.ts::messageToMarkdown`（tool_call 摘要 + 40 行截断 + thought 省略规则齐备）。整会话导出 = 复用它逐条拼接，**不需新造序列化器**。
- 全量消息获取链路已存在：`GET /messages?before=<cursor>` 分页（`ChatView.tsx:446`），后端按条数+字节双预算切页（`chat_persistence.rs:90`）。
- 下载用 `Blob` + `createObjectURL` + `<a download>`，零依赖。
- **后端零改动。**

唯一必须显式处理的口径问题：**图片只有缩略图**（见 D3）。

## 2. 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P0 | ① 纯函数序列化器 `sessionToMarkdown` | 消息数组 → Markdown 文本（可单测，不触网） | 小 |
| P0 | ② 全量分页拉取 | 循环 `?before=` 拉到底，**不依赖 store 已加载页** | 小 |
| P0 | ③ 导出入口 + 下载 | 标题栏按钮 → Blob 下载 | 中 |
| P1 | ④ 体积/条数双上限 + 降级提示 | §P1 红线 | 中 |
| P1 | ⑤ 导出头部说明 | 标注导出时刻 / 图片口径 / 省略量 | 小 |

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| PDF / HTML / zip 导出 | 多格式 = 多套序列化器，违反「单一真源」；Markdown 已是 agent 生态通用交换格式 |
| 导出原图 | 原图**不落库**（F03 2026-09-08 勘误：只存长边 480 的 JPEG 缩略图），**技术上不可能**，不是排期问题 |
| 导出到服务端 / 定时导出 | 产品定位是单人本地终端管理器，无云端存储面 |
| 把导出结果写进聊天历史 | 导出产物不是对话内容，混入会污染 `chat_messages`（DB 权威）与 hydrate 口径 |
| 导出工具调用的完整 stdout | 沿用既有 40 行截断口径；完整内容由块级复制覆盖（`messageMarkdown.ts` 既有注释） |

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | 整会话导出**复用** `messageToMarkdown` 逐条拼接，不新造序列化器 | 单条「复制为 Markdown」与整会话导出必须格式一致；两套规则必然漂移（工程准则 7①：同一转换 ≥2 处 → 抽共享函数立单一真源） | 另写一套「会话级」序列化器（会与单条格式分叉） | 单条导出口径本身需要与整会话分叉时（当前不需要） |
| **D2** | 导出**独立分页循环**拉全量，**不复用** store 已 hydrate 的消息 | store 只有首屏那几页 + 用户上拉加载过的页；导出必须是全量会话，否则用户拿到的是「看起来完整其实缺了前半段」的导出件——比不导出更糟 | 复用 store（导出不完整，**静默失真**） | 未来引入全量常驻 store（与 §P1 冲突，不会发生） |
| **D3** | 图片**内联 data URI**（缩略图），并计入导出字节预算；预算不足时该图降级为占位符 `> [图片 N：未导出（超出体积上限）]` | 缩略图是库里唯一存在的形态（480px JPEG q0.7，约 20–40KB/张），内联后 Markdown 渲染器可直接显示，是唯一「拿到就能用」的形态；占位符保证文件体积有界且**缺失可见**（不静默丢图） | 恒为占位符（导出件不可用）／内联且不计预算（违反 §P1，100 张图即 4MB） | 出现单张缩略图 > 200KB 的形态（改走「导出为独立图片文件」方案） |
| **D4** | 双上限：`MAX_EXPORT_MESSAGES`（条数）+ `MAX_EXPORT_BYTES`（字节），**任一触顶即停止并显式标注省略量** | §P1 要求上限维度匹配真实增长维度。条数与字节是两个独立增长轴（一条 1 字符的 system 行 vs 一条 1MiB 的工具输出）——只限条数等于没限 | 只限条数（§P1 案例 2 同型）／只限字节（消息条数无界，循环拉取本身会拖住后端） | 实测单会话消息数或体积稳定低于上限的 1/10（可下调，反之不能上调） |
| **D5** | 单条「复制为 Markdown」**保持现状**（不内联图片），与导出件的图片策略**同源不同参** | 剪贴板不该被 base64 撑爆（一次复制几 MB 会让粘贴方卡死）；两者规则同源于 `messageMarkdown.ts` 内同一个渲染函数，以参数区分 mode，**不各自造规则** | 两条独立规则（D1 反例）／剪贴板也内联（剪贴板膨胀） | 用户反馈「复制出来的 Markdown 缺图」——但那时应改的是导出件，不是剪贴板 |
| **D6** | 导出件**头部写明**：导出时刻、图片为缩略图、thinking 不导出、被截断的工具内容、被上限省略的量 | 导出件会脱离 OmniTerm 独立流通；缺了这几行，用户会在几周后把「缺图」「缺思考」当成 bug | 无头部说明（用户无从判断完整性） | — |
| **D7** | `system` 角色消息不导出 | `messageToMarkdown` 对 system 返空（既有口径）：system 是 OmniTerm 内部的权限回收/连接事件标签，不是对话内容 | 导出 system 事件（导出件混入宿主内部噪音） | — |
| **D8** | 导出文件名 = `{会话显示名}.md`，会话名取 `sessionDisplayName()` 单一真源 | 会话显示名已有三级优先级收敛（`utils/sessionDisplayName.ts`），另起一套会与侧栏漂移 | 自造命名规则 | — |
| **D9** | 导出为**前端纯客户端**行为，**不新增任何后端端点** | 全量拉取用既有 `GET /messages` 游标分页即可；新端点等于新鉴权面 + 新 P1 面（§S4/S5），而收益为零 | 新增 `/sessions/{id}/export` 端点（多一处要审的面，无必要） | 未来要服务端生成导出件（如超大会话避免浏览器内存峰值）→ 那时才立新端点 |

## 4. 实施分期

### Phase 1 — 纯函数序列化器（不触网）

| 改动 | 文件 |
|---|---|
| 新增 `sessionToMarkdown(messages, opts)`：逐条调 `messageToMarkdown` 拼接 + 头部说明（D6）+ 双上限（D4） | `frontend/src/utils/sessionMarkdown.ts`（新） |
| `messageToMarkdown` 增加图片渲染分支（inline / placeholder 两 mode，D3/D5）；单条调用方显式传 mode | `frontend/src/utils/messageMarkdown.ts` |
| 纯函数单测：空数组 / 单条 / 多条 / 图片 inline / 图片占位降级 / 条数上限 / 字节上限（守恒断言：保留量 + 省略量 == 输入量） | `frontend/src/utils/sessionMarkdown.test.ts`（新） |

### Phase 2 — 全量拉取 + 下载

| 改动 | 文件 |
|---|---|
| `fetchAllMessages(sessionId)`：循环 `GET /messages?before=<cursor>`，累计到 D4 双上限即停；**每页独立 fetch，不改 store** | `frontend/src/utils/sessionExport.ts`（新） |
| 下载：`Blob` + `URL.createObjectURL` + `<a download>` + `revokeObjectURL`（**必须 revoke**，否则 blob 驻留内存） | 同上 |
| 标题栏入口：`panel-title-bar` 内（`title-bar-spacer` 之后、`UsageIndicator` 之前）加 icon-only 按钮；导出中 disabled + 进度提示 | `frontend/src/components/Chat/ChatView.tsx` |
| i18n 两份同步（zh/en） | `frontend/src/locales/{zh,en}/translation.json` |

### Phase 3 — 边界与联调

| 项 | 要点 |
|---|---|
| 导出中会话仍在流式 | 导出的是**已落库**内容；流式中的 assistant 行在库里 `status='streaming'`，导出时跳过并在头部标注「导出时刻 HH:MM:SS」 |
| 大会话（>1000 条） | 循环拉取耗时须有可见进度；不得静默卡住 |
| 归档会话 | 归档不删 `chat_messages`（X18 已知），导出对归档会话同样可用 |
| 非 ACP（tmux/pty）会话 | 聊天面板只服务 ACP 会话；若 `runtime_kind !== 'acp'` 不渲染导出按钮 |

### 不改动

后端零改动；`chat_messages` 表结构零改动；WS 协议零改动。

## 5. 验收标准

- [ ] 导出件含该会话**全部**已落库消息（含用户从未上拉加载过的早期消息）——**验证方式**：造一个 50 条消息的会话，只加载首屏，导出后数条数 = 50
- [ ] 导出件头部含导出时刻 / 图片口径说明 / 省略量
- [ ] 图片以 data URI 内联（可用图片渲染器直接显示）；超预算的那张降级为占位符且**占位符可见**
- [ ] 工具调用按既有 40 行截断口径呈现，截断标注可见
- [ ] `system` 消息不出现在导出件中
- [ ] 双上限触发时：文件仍能下载，头部写明「已省略 N 条 / 约 M 字节」
- [ ] `URL.revokeObjectURL` 被调用（单测断言，无内存驻留）
- [ ] 非 ACP 会话不出现导出按钮
- [ ] `cd frontend && pnpm lint` / `pnpm exec tsc -b` / `pnpm test` 零新增警告
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` 零新增（后端未改动，应为恒等）

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 导出循环拉全量把后端 DB 拖慢 | 长会话导出期间后端占用上升 | 每页走既有字节预算（后端已限）；导出循环串行 + 每页间让出；单会话导出互斥（同一时刻只允许一个导出任务） |
| 浏览器内存峰值 | 超大导出件可能 OOM | D4 双上限即内存上限；`Blob` 由浏览器流式落盘，不整份驻留 JS 堆 |
| 用户误以为导出件是「完整原图/原思考」 | 事后争议 | D6 头部说明 + 导出后 toast 再提示一次 |
| `messageToMarkdown` 加图片分支影响既有单条复制 | 单条复制行为回归 | D5：单条调用方显式传 `images: 'omit'`，既有行为逐字不变；纯函数单测锁死两种 mode |

## 7. 文档闭环

实施完成后需更新：

- `docs/architecture/frontend.md` — `utils/` 目录说明补 `sessionMarkdown.ts` / `sessionExport.ts`；聊天面板标题栏新增导出按钮
- `docs/architecture/frontend-patterns.md` — 若确立「导出类工具」的通用形态（消息级 vs 会话级），登记为模式条目
- `docs/dev/plans/backlog/improvement-directions-remaining.md` — X02 拆为「导出（F08，本文，已排期）」与「搜索（F06，另立计划）」
- `docs/dev/plans/2026-07-27-acp-session-enhancements.md` — F08 标注已实施 + 指向本文
- `CHANGELOG.md` — **需加条目**（实质性用户可见功能）
