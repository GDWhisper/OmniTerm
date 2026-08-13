# ACP 聊天气泡动作体系（复制 / 引用 / 动作注册表）

> 状态：已归档（2026-08-11 设计稿；2026-08-13 评审修订见 §8；同日 Phase 1-4 全部落地，2026-08-14 归档。约束已沉淀到 `docs/architecture/frontend-patterns.md` action-registry 条目）
> 触发条件：修改 `frontend/src/components/Chat/ChatMessage.tsx` 的消息动作、块级操作、剪贴板相关代码前必读
> 关联：`docs/architecture/frontend-patterns.md`（数据/渲染分离、getState-action）、`docs/visual-design/ui-style-guide.md` §13（图标规则）、`docs/dev/plans/2026-07-30-mobile-interaction-optimization.md` D6（长按菜单范式）、`docs/dev/plans/2026-08-10-acp-session-reliability.md`（`sync_messages` 不变量）

## 1. 背景与现状审计

ACP 聊天气泡当前只有两个动作，均藏在 hover 层（`index.css:1865` `.chat-msg-row:hover .chat-msg-actions`）：

| 位置 | 动作 | 代码 |
|---|---|---|
| user 气泡 | ✎ 编辑重发（不截断历史，作为新 prompt 发出） | `ChatMessage.tsx:565` → `ChatView.tsx:231` `handleEditResend` |
| 最后一条 assistant | ↻ 重新生成 | `ChatMessage.tsx:581`（`isLastAssistant` 限定） |

审计出的缺口与严重度：

| # | 问题 | 严重度 | 证据 |
|---|---|---|---|
| 1 | **聊天区没有任何复制能力** — agent 输出的代码、命令、diff、工具原始内容都只能手工选中 | 🔴 P0 | `ChatMessage.tsx` 全文无 clipboard 调用 |
| 2 | **剪贴板逻辑重复且一处缺兜底** — `FileManager.tsx:625` 有 `navigator.clipboard` + textarea 兜底；`useTerminal.ts:550` 只有 `navigator.clipboard`，裸 http 下静默失效 | 🔴 P0（技术债 + 既存 bug） | 两处实现；AGENTS §7.1 去重要求 |
| 3 | **动作只能内联硬写** — user / assistant 是两条独立渲染分支，动作从 2 个涨到 5+ 个必然复制粘贴 | 🟡 P1 | `ChatMessage.tsx` 已 608 行，两分支各写一遍按钮 |
| 4 | **移动端动作完全不可达** — 触发依赖 `:hover` | 🟡 P1 | `index.css:1869` |
| 5 | 图标体系不一致 — 气泡用 `✎ ↻` 等宽符号，项目功能图标规范要求走 `icons.tsx` 线性图标库（`IconCopy` / `IconPencil` / `IconRefresh` 均已存在） | 🟢 P2 | ui-style-guide §13.1 |
| 6 | 无「引用上文提问」路径 — 用户要针对某段回答追问只能手抄 | 🟡 P1 | 无实现 |

根因（#1/#3/#4 共因）：气泡从一开始就把「动作」当成两处一次性 JSX，没有承载动作集合的结构，于是每加一个动作的边际成本都是「两条分支 × 两种触发方式」。

## 2. 范围与优先级

### P0（Phase 1-2）
- `utils/clipboard.ts`：统一复制入口 + 非安全上下文兜底；收敛 FileManager 与 useTerminal 两处重复（顺带修 #2 的缺兜底 bug）。
- `utils/messageText.ts`：`extractMessageText(message)` 纯函数 ——「复制正文」与「引用」共用同一份文本提取逻辑，避免两处实现（AGENTS §7.1）。
- 气泡动作注册表 + `MessageActionBar`：桌面 hover / 移动长按两套触发共用一份动作定义。
- 首批动作：**复制正文**、**引用到输入框**、编辑重发（迁移现有）、重新生成（迁移现有）。

「复制正文」的确切语义（避免歧义）：user 消息复制 `message.text`；assistant 消息复制**所有 `text` 块拼接**（`\n\n` 连接），**不含** thought / tool_call / plan / todo —— 思考过程与工具日志属块级复制（P1）的范畴，混进正文会让粘贴结果不可用。「引用」复用 `extractMessageText` 同一函数。边界：assistant 消息无任何 text 块时，复制正文 / 引用均不可用（见 D2 visible 边界）。

### P1（Phase 3）
- **块级复制**：text / thought / tool_call 卡片各自可复制（tool_call 复制 `block.content`，diff 复制原文）。
- **复制为 Markdown**：单条消息含工具卡片摘要的 Markdown 形态。

### P2（不在本计划实施，仅记录）
- 助手长文本折叠（把 `CollapsibleUserText` 提升为通用 `CollapsibleText`）。
- prompt 间跳转（上/下一条 user 消息）。
- 任意 assistant 消息重新生成（当前限最后一条）。**需先回答语义问题**：ACP 无 rewind，对历史中间的消息「重新生成」只能追加新 turn，会让历史更难读——语义未定前不做。

### 不纳入范围（含理由）

| 排除项 | 理由 |
|---|---|
| **分叉（fork）** | ACP 协议无 fork/branch 语义，agent 侧上下文不可复制。能实现的只有「复制 DB 消息到新会话 + agent 从零上下文重开」——UI 假装分叉、agent 实际失忆，是骗人的功能。且 `ws/acp.rs:508` 已存在 "agent does not support session/load" 分支，说明连历史恢复都不是所有 agent 都支持（AGENTS §8：不为单一实现背书）。 |
| **转发到其他会话** | 系统剪贴板已覆盖该场景。要做需把 `ChatInput.tsx:40-48` 私有的 sessionStorage 草稿机制提升为跨会话公共模块，收益不足。 |
| **删除单条 / 从此处截断历史** | 价值高但被持久化不变量卡住，见 §3 D6，另立计划。 |
| **会话内搜索** | 前端历史分页不全，必须后端端点；与本计划正交。 |
| **导出为文件下载** | 见 D5。 |

## 3. 设计决策（ADR）

### D1：剪贴板统一走 `utils/clipboard.ts`，保留 textarea 兜底
- **决策**：`copyText(text: string): Promise<boolean>` — 优先 `navigator.clipboard.writeText`，缺失或抛错时回退隐藏 textarea + `document.execCommand('copy')`。util **不依赖** i18n / toast store，成功/失败文案由调用方决定。
- **理由**：OmniTerm 常以裸 http 在局域网访问，非安全上下文下 `navigator.clipboard` 为 undefined——`FileManager.tsx:629` 的注释已实证这不是理论问题，而 `useTerminal.ts:550` 缺兜底属既存 bug。util 不碰 i18n/store 才能同时服务三类调用方且不跨层。
- **否决项**：只用 async API（局域网静默失效）；封装成带 toast 的 hook（把纯工具绑到 i18n 与 store，违反分层，且 FileManager 与 chat 的文案不同）。
- **翻盘条件**：项目改为强制 https 部署 → 可删兜底分支。

### D2：气泡动作数据驱动（注册表），不在两条渲染分支内联
- **决策**：新增 `components/Chat/messageActions.ts`（frontend-patterns「数据/渲染分离」约定），导出模块级常量数组：
  ```ts
  interface MessageActionContext {
    message: ChatMessage
    isLastAssistant: boolean
    handlers: MessageActionHandlers  // 由 ChatView 注入的稳定回调
  }
  interface MessageAction {
    id: string
    Icon: (p: SVGProps<SVGSVGElement>) => ReactElement  // React 19 已移除全局 JSX 命名空间，勿用 JSX.Element（TS 6 编译不过）
    labelKey: string
    visible: (ctx: MessageActionContext) => boolean
    run: (ctx: MessageActionContext) => void
  }
  ```
  `MessageActionBar` 只负责按 `visible` 过滤并渲染，桌面/移动两套触发共用同一数组。`handlers` 由 ChatView 聚合成**单个对象**（`useMemo` 保持引用稳定），ChatMessageView 只依赖这一个引用——避免每个动作单独 prop，放大 memo 浅比较契约面。
  `visible` 边界清单（迁移现有逻辑时逐条对照，防回归）：
  - `role === 'system'`：无任何动作；
  - user 且 `undelivered`：不显示编辑重发（现有 `ChatMessage.tsx:565` 条件）；
  - `message.streaming`：不显示复制正文 / 重新生成（复制会拿到半截内容；重新生成现有 `ChatMessage.tsx:581` 已限定 `!streaming`）；
  - assistant 无 text 块：复制正文 / 引用不可用；
  - editing 态：整个动作条隐藏（编辑分支自带 ⏎/✕ 操作按钮，现有 `ChatMessage.tsx:555-563`）。
- **理由**：AGENTS §7.2 判定准绳——新增同类动作只需加一行数据，且改动收敛到一个文件；否则每个动作都要在 user / assistant 两条分支 × hover / 长按两种触发下各写一遍（4 份）。
- **否决项**：继续内联（第 3 个动作起开始复制粘贴）；做成通用 `ContextMenu` 组件——Terminal 的 paste 长按菜单虽是同类形态，但它是单按钮无子项的浮层，不构成组件复用点；待出现带子项菜单的第二消费方再提取。
- **翻盘条件**：最终动作数稳定在 ≤3 且移动端不做长按 → 注册表可退回内联。

### D3：移动端走「长按 → 浮动菜单」，不做常显动作条
- **决策**：复用 mobile 计划 D6 范式（`LONG_PRESS_MS` 500ms、位移 `LONG_PRESS_CANCEL_PX` 取消、`hapticTap()`）。`Terminal.tsx:97-124` 的内联长按逻辑同时提取为 `hooks/useLongPress.ts`，两处消费（终端粘贴 + 气泡动作），**Terminal 的 paste 菜单一并迁移到该 hook**，不留两套内联实现。
- **长按触发区域**（关键取舍）：长按是移动端系统文本选择的标准手势，若整条消息绑定长按，iOS Safari 的系统选择菜单会与动作菜单叠加成双菜单。因此**长按只绑定消息行的非正文区域**（label 行 + 气泡外 padding 区），text 块正文不绑定，保留系统文本选择能力——移动端用户对局部文本用系统选择，对整条消息用动作菜单「复制正文」。动作菜单锚点随触点在消息行侧弹出。
- **理由**：窄屏常显按钮挤占正文并破坏气泡视觉密度；长按已是本项目移动端既有肌肉记忆。提取 hook 是因为出现了第二个消费方（AGENTS §7.1），不是预留。
- **否决项**：常显动作条（挤压正文）；双击（与文本选择冲突）；整条消息绑定长按（与系统文本选择叠加，iOS 实测会出现双菜单）。
- **翻盘条件**：长按在聊天区与纵向滚动误触率高，或触发区域限定后移动端复制使用率过低 → 改为气泡右上角常显「⋯」按钮。

### D4：复制反馈用 toast，不改按钮态
- **决策**：成功/失败各出一条 toast（`toast-pixel` 体系，`useToastStore.getState().addToast`，走 frontend-patterns「getState-action」约定，避免 memo 组件订阅 store）。
- **理由**：toast 体系现成；按钮态需为每个按钮引入 setTimeout + 局部状态，在 memo 气泡里放大重渲染面。
- **否决项**：按钮文字变「已复制」并定时还原。

### D5：导出只做「复制为 Markdown」，不做文件下载
- **决策**：P1 的导出产出到剪贴板，不生成 `.md` 文件。
- **格式样例**（text + tool_call 混合的 assistant 消息）：
  ```markdown
  ## Agent: demo-agent
  ## Turn: 12:34:56

  正文第一段…

  正文第二段…

  ### 工具调用
  - **execute**: `cargo build` → ✓ completed
    ````text
    <content 前 40 行，超出截断>
    ````
  ```
  规则：text 块按序拼接（`\n\n` 连接）；tool_call 只列 kind/title/status + content 前 N 行；diff 类内容不展开（取原样文本已由块级复制覆盖）；thought 默认省略（后续可加开关）。
- **理由**：文件下载要处理文件名、编码、移动端 Blob 兼容，而当前诉求是「把内容拿出去用」，剪贴板即完成闭环。
- **翻盘条件**：出现整会话归档需求 → 走后端导出端点（能顺带解决历史分页不全的问题），届时另立计划。

### D6：删除 / 截断历史本期排除 —— 与 ACP 重放语义冲突
- **事实**：`acp/chat_persistence.rs:208` 明确「**不删除**任何已有记录」，因为 `session/load` 重放流不含 user prompt；且 `sync_messages` 对前端自建消息走 text 匹配，**匹配不到就 INSERT**（`:295`）。
- **推论**：删掉一条消息后，会话 resume → agent 重放该消息 → 前端重建 → sync 回写 → **消息复活**。加一个 `DELETE` 端点解决不了问题，必须引入墓碑（`deleted_at` 列或 tombstone 表）让 `sync_messages` 显式跳过已删内容。
- **决策**：本计划不做删除/截断；作为独立计划设计墓碑机制，避免在刚修好的 `sync_messages` 不变量上叠加改动（该不变量是 acp-session-reliability 计划的 P0 修复成果）。
- **翻盘条件**：墓碑设计通过评审后单独实施。

### D7：引用回复经 store 通道注入输入框，不绕过 React 写 sessionStorage
- **决策**：`ChatInput` 的 `text` 是组件本地 state（`ChatInput.tsx:85`），外部写 sessionStorage 不会触发重渲染。因此：把私有草稿函数提升为 `utils/chatDraft.ts`（`getDraft`/`saveDraft`/`deleteDraft`，两个消费方），并在 chatStore 增加 `pendingInsert: { sessionId: string; text: string } | null` 通道 —— 动作写入，`ChatInput` 以 effect 消费（仅当 `sessionId` 匹配自身）后置 null。
- **理由**：唯一真源仍是 ChatInput 的 state；通道是显式的一次性信号，不引入双向绑定。
- **否决项**：把 `text` 提升到 store（每次按键触发全局订阅者重渲染，聊天区在流式期间尤其敏感）；直接写 sessionStorage（不重渲染，用户看不到）。

### D8：动作条图标统一用 `icons.tsx` 线性图标
- **决策**：动作条改用 `IconCopy` / `IconPencil` / `IconRefresh`（均已存在于 `components/FileManager/icons.tsx`），现有 `✎ ↻` 一并替换；label 保留 reader 字体（现 `.chat-msg-action-btn` 即 reader 字体）。
- **理由**：ui-style-guide §13.1 要求功能型图标统一收在通用图标库；§13.3 禁 emoji。
- **否决项**：继续用等宽符号（虽被 §13.3 允许，但与新增的复制/引用图标混排会出现两套视觉语言）。

### 多实现差异（AGENTS §8）
- 不同 agent 对 `session/load` 支持不一（`ws/acp.rs:508` 有显式 unsupported 分支）——这是排除 fork 的直接依据之一。
- `tool_call` 的 `kind` 可能只给模糊的 `'other'`（`ChatMessage.tsx:166-169` 已有相关处理）。块级复制的可见性判据**只用 `block.content` 是否非空**，不依赖 `kind`，避免把某个 agent 的字段习惯当作事实。

## 4. 实施分期

| Phase | 产出 | 改动文件 | 依赖 |
|---|---|---|---|
| 1 | 剪贴板 + 文本提取收敛 | 新增 `frontend/src/utils/clipboard.ts` + `clipboard.test.ts`、`frontend/src/utils/messageText.ts` + `messageText.test.ts`；改 `FileManager.tsx`（`handleCopyPath` 改调 util）、`useTerminal.ts`（补兜底） | — |
| 2 | 长按 hook + 动作条 + 首批动作 | 新增 `hooks/useLongPress.ts`、`components/Chat/messageActions.ts`、`components/Chat/MessageActionBar.tsx`；改 `ChatMessage.tsx`（两分支改挂动作条）、`ChatView.tsx`（注入聚合 handlers）、`Terminal.tsx`（paste 菜单迁移 useLongPress）、`stores/chatStore.ts`（`pendingInsert`）、新增 `utils/chatDraft.ts`（从 ChatInput 提取）、`ChatInput.tsx`（消费 pendingInsert + 改用 chatDraft）、`index.css`（长按菜单沿用 `.pixel-float`）、两个 locale | Phase 1 |
| 3 | 块级复制 + 复制为 Markdown | 改 `ChatMessage.tsx`（`TextBlockView` / `ThoughtBlockView` / `ToolCallBlockView` 加复制角标）；新增 `utils/messageMarkdown.ts` + 单测 | Phase 2 |
| 4 | 文档闭环 | `CHANGELOG.md`、`docs/architecture/frontend-patterns.md`（登记 action-registry 约定）、`docs/architecture/frontend.md`（新增 util/hook/组件）、`docs/reference/user-testing.md`（手动用例）、`AGENTS.md` 文档索引追加本计划行、本文件状态 → 已实施 | Phase 1-3 |

## 5. 验收标准

- [ ] `cd frontend && npx tsc -b && npm run lint && npm test` 全绿，零新增告警
- [ ] `clipboard.test.ts`：安全上下文走 `navigator.clipboard`；`navigator.clipboard` 缺失时走 execCommand 兜底；两条路径都失败返回 `false`
- [ ] `messageText.test.ts`：user 取 `text`；assistant 拼接全部 text 块（`\n\n`）且忽略 thought/tool_call/plan/todo；无 text 块返回 `''`
- [ ] **裸 http（非 localhost）访问**下复制成功 —— 这是 D1 的关键降级路径，必须实测而非推断
- [ ] 桌面：hover 气泡显示动作条，移出隐藏；`:focus-within` 键盘可达（现有 CSS 行为不回归）
- [ ] 移动：长按 label 行/消息空白区 500ms 弹菜单，拖动 >10px 取消，菜单不超出视口；**长按正文不弹动作菜单、系统文本选择正常**（D3 触发区域策略，iOS 实测无双菜单）
- [ ] streaming 中的 assistant 消息不显示动作条（避免复制到半截内容）
- [ ] 引用：点「引用」后输入框出现 `> …` 引用块且光标在末尾；切会话不串到别的会话草稿
- [ ] `messageActions.ts` 新增一个动作只需改这一个文件（对 D2 的实证）
- [ ] 流式渲染期间历史消息仍不重渲染（`ChatMessage.tsx:387-391` 的 memo 契约不被新回调打破 —— handlers 聚合为单个对象且 `useMemo` 稳定）

## 6. 风险与降级

| 风险 | 影响 | 缓解 |
|---|---|---|
| `document.execCommand` 已废弃，未来浏览器可能移除 | 裸 http 下复制失效 | 优先 async API；兜底仅在 API 缺失时走；失败返回 false → 调用方出 toast，不静默 |
| 新增 handlers 破坏 memo 稳定性 | 流式期间全量历史重渲染，长会话卡顿 | handlers 聚合为单个对象（`useMemo`）且注册表为模块级常量；验收项显式检查 |
| 移动端长按与聊天区纵向滚动冲突 | 滚动时误弹菜单 | 位移阈值取消（复用终端 `LONG_PRESS_CANCEL_PX`） |
| 长按劫持移动端系统文本选择 | 用户无法长按选中局部文本 | 长按只绑定 label/空白区（D3），正文保留系统选择；iOS 实测双菜单不出现 |
| 动作条挤压窄屏气泡布局 | 视觉密度下降 | 移动端不常显（D3）；桌面动作条为绝对定位淡入层，不参与气泡布局 |
| `pendingInsert` 通道遗留未消费值 | 切会话后旧引用突然出现 | 通道按 sessionId 键入，`ChatInput` 消费后立即清空 |

## 7. 术语表

| 术语 | 含义 |
|---|---|
| 动作条（action bar） | 气泡下方 hover 淡入的按钮行，桌面端形态 |
| 动作注册表 | `messageActions.ts` 里的 `MessageAction[]`，动作的唯一真源 |
| 块级复制 | 复制单个 `ContentBlock`（text/thought/tool_call）而非整条消息 |
| 墓碑（tombstone） | 标记消息已删除、供 `sync_messages` 跳过的持久化标记（本期不实施，见 D6） |

## 8. 评审记录（2026-08-13）

| 意见 | 处置 |
|---|---|
| 移动端长按与系统文本选择（iOS 双菜单）冲突未讨论 | D3 补「长按触发区域」决策（只绑 label/空白区，正文保留系统选择）+ 风险表条目 + 验收项 |
| D2 否决 ContextMenu 依据「只有气泡一个消费方」不成立（Terminal 已有 paste 菜单） | 否决项表述修正为「paste 菜单无子项不构成复用点」；D3 要求 paste 菜单一并迁移 useLongPress |
| 「复制正文」与「引用」文本提取逻辑应共用，否则违反 AGENTS §7.1 | P0 新增 `utils/messageText.ts` 纯函数；Phase 1 产出 + 验收单测同步 |
| 注册表 `visible` 边界未列全（system / undelivered / streaming / 无 text 块 / editing） | D2 补 visible 边界清单 |
| `JSX.Element` 在 React 19 + TS 6 下编译不过 | D2 接口类型改为 `ReactElement` |
| handlers 聚合形态未定，memo 契约表述过弱 | D2 明确聚合为单个 `handlers` 对象 + `useMemo`；验收项措辞同步 |
| D5 Markdown 导出格式缺定义 | D5 补 text + tool_call 转换样例与规则 |

## 9. 实施记录（2026-08-13）

| Phase | 产出 | commit | 备注 |
|---|---|---|---|
| 1 | `utils/clipboard.ts` + test、`utils/messageText.ts` + test；FileManager / useTerminal 改调统一 util | `5969f95`（基线文档）后 1 个 `feat:` | 实施时发现 `useTerminal.ts:550` 实际**已有** textarea 兜底（方案审计 #2「缺兜底」不准确，实为 `navigator.clipboard` 分支失败路径静默吞错）——已统一收敛并补失败反馈 |
| 2 | `useLongPress.ts`、`messageActions.ts`、`MessageActionBar.tsx`、ChatMessage/ChatView/ChatInput/Terminal/chatStore/locale | 1 个 `feat:` | 实施偏差：`handlers` 中的 `startEdit` 无法由 ChatView 注入（编辑态是 ChatMessage 内部 state），实际由 ChatMessage 内部组装，ChatView 注入 copy/quote/regenerate + `canEdit`/`canRegenerate` 能力标志 |
| 3 | 块级复制角标、`utils/messageMarkdown.ts` + test、copyMarkdown 动作 | 1 个 `feat:` | `messageMarkdown` 过滤条件放宽：无 content 的 tool_call 也保留摘要行（记录调用事实） |
| 4 | CHANGELOG、frontend-patterns（action-registry）、frontend.md、user-testing §15、AGENTS.md 索引、本文件状态 | 1 个 `docs:` | — |

**验收状态**：`tsc -b` 通过；`pnpm lint` 0 errors / 19 warnings（与 dev 基线一致，零新增）；`pnpm test --run` 38 files / 315 tests 全绿。手动回归用例见 `docs/reference/user-testing.md` §15。
