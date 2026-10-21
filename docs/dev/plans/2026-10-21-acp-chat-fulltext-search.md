# ACP 会话内搜索（会话级消息全文检索）

> 状态：**已实施**（2026-10-21）——实施偏差见 §0.2（D9 高亮只覆盖用户气泡、检索改两步实现、响应 camelCase、计划外补「回到最新消息」出口）
> 触发条件：改 `chat_messages` 查询 / 分页游标、新增检索端点、动 `ChatView` 标题栏与消息定位链路前**必读**
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md` F06（本文是它的落地计划）、`docs/dev/plans/backlog/improvement-directions-remaining.md` X02（本文承担 X02 的「搜索」半边）、`docs/dev/performance-and-safety.md` §P1/§P4/§S1

## 0. 实施记录（2026-10-21）

### 0.1 落地文件

| 文件 | 作用 |
|---|---|
| `src/acp/chat_persistence.rs` | `search_session_messages`（LIKE 匹配 + 双扫描预算 + 命中片段）+ `list_messages_page_at`（定位页）+ 预算常量（`MAX_SEARCH_ROWS` / `MAX_SEARCH_BYTES` / `MAX_SEARCH_TERMS` / `MAX_SEARCH_RESULTS`）；页收尾逻辑 `finalize_page` 与普通分页共用 |
| `src/api/sessions.rs` | 新端点 `GET /sessions/{id}/messages/search`；`GET /sessions/{id}/messages` 增 `?at=<cursor>` 定位页参数（与 `before` 互斥） |
| `frontend/src/utils/chatSearch.ts` | 检索调用层（类型 + 请求 + 命中词高亮切段） |
| `frontend/src/components/Chat/ChatSearchBar.tsx` | 搜索条：延迟展开的内联浮层（输入 / 结果列表 / 键盘导航 / 预算状态行） |
| `frontend/src/components/Chat/ChatView.tsx` | 标题栏搜索入口 + Ctrl+F；命中跳转（窗口内直跳 / 未加载则拉定位页替换窗口）+ 高亮闪烁 + 「回到最新消息」出口 |
| `frontend/src/components/Chat/ChatMessage.tsx` | 助手消息行补 `chat-msg-row-flash`（助手消息没有单一气泡外壳，见 §0.2-1） |
| `frontend/src/stores/chatStore.ts` | 新增 `replaceMessages`（窗口整体替换，D8） |
| `frontend/src/hooks/useChatShortcuts.ts` | Ctrl/Cmd+F 接入（容器作用域，D11） |
| `frontend/src/index.css` | `.chat-search*` / `.chat-msg-row-flash` / `.panel-title-bar-btn` / `.panel-title-bar-text-btn` |
| `frontend/src/locales/{zh,en}/translation.json` | `chat.search.*`（12 个 key，两份同步） |

### 0.2 实施偏差

1. **D9 的高亮只覆盖用户气泡，助手消息另立一个 class**（唯一的机制偏差）。
   D9 写「高亮复用 `highlightedMessageId` + `chat-msg-flash`」——但既有 `chat-msg-flash`
   打在**用户气泡**上（`ChatMessage.tsx` 的 user 分支）；助手消息的正文是**多个 block
   堆叠**（过程容器 + 结论气泡），没有单一气泡外壳可挂 ring。故助手消息改打**行**
   （新增 `.chat-msg-row-flash`，ring 无气泡硬投影）。「指向某条消息」仍只有
   `highlightedMessageId` 一条通道（D9 的核心不变）。
2. **检索实现成两步（候选窗口 → 范围内 LIKE）**：计划写「Rust 侧累计字节触顶即停」，
   实施时发现若一次性取回候选行的 `text` 本体，大会话会把几十 MB 文本搬进内存。
   改为先只取 `(id, created_at, LENGTH(text))`（**不取文本本体**），在 Rust 侧累计字节
   定出「参与检索的范围」，再在该范围内做 LIKE。两条查询都走
   `idx_chat_messages_session(session_id, created_at)`，范围扫描有界。
3. **响应字段 camelCase**（`#[serde(rename_all = "camelCase")]`）：与本仓其它 HTTP 响应
   一致（`createdAt` / `nextCursor`）。**教训**：手工 `json!` 映射字段名会与结构体漂移
   ——实施中第一版就是手工映射，输出成了 snake_case，前端按 camelCase 读会拿到
   `undefined`；现改为直接序列化结构体。
4. **计划外补充：「回到最新消息」出口**。D8 的定位页语义是**替换**窗口，目标成为窗口
   最新行——于是**更新的消息不在窗口内**（这是定位页「一次查询取到目标」的必然代价：
   任何有界的定位页都装不下从目标到最新的全部消息）。没有出口的话用户会卡在一段
   历史里（「回到底部」只能回到这个窗口的底）。故标题栏在窗口被替换期间显示
   「回到最新消息」，点击即重新拉最新一页并替换窗口。
5. **结果条数上限取 100**（`MAX_SEARCH_RESULTS`，计划未给具体值）：命中过多时状态行
   写明「仅显示前 N 条」，不静默丢。
6. **Ctrl+F 再按一次 = 聚焦并全选**（FileEditor 同款口径）：搜索条已开着时再按 Ctrl+F
   不清空查询，只把焦点拉回输入框。

### 0.3 验收对照

- [x] 在 50 条消息的会话里搜一个只出现在第 3 条的词 → **命中**（证明搜的是全库不是已加载页）
      —— 后端单测直接对 DB 检索（不经前端窗口）；Chromium 实测命中的消息不在首屏窗口内也能搜到
- [x] 搜中文子串「上下文」能命中「上下文窗口」（LIKE 天然支持，无分词问题）
      —— 单测 `search_matches_chinese_substring_without_tokenizer`
- [x] 多词空格分隔 = AND 语义 —— 单测 `search_multiple_terms_use_and_semantics`
- [x] 搜含 `%` 或 `_` 的字面词不会变成通配符 —— 单测 `search_escapes_like_wildcards`
- [x] 命中消息**未被加载过**时 → 自动拉定位页 → 滚动到该条 → 气泡闪烁
      —— 组件测试「命中未加载 → 拉定位页替换窗口 → 目标气泡滚动并闪烁」
- [x] 定位页替换后，向上滚动能继续加载更早的消息（`historyCursor` 正确）
      —— 组件测试断言 `historyCursor` = 定位页的 `nextCursor`；后端单测 `location_page_contains_target_row_as_newest`
- [x] 超行数/字节预算 → 结果面板**写明省略量**（不是静默截断）
      —— 后端单测两个预算触顶用例（`truncated=true`）；前端状态行显示「仅搜索了最近 N 行」
- [x] `system` 角色消息不出现在结果里 —— 单测 `search_excludes_system_rows`
- [x] Ctrl+F 在聊天面板内打开搜索；文件编辑器内的 Ctrl+F 不受影响
      —— 容器作用域绑定（`useChatShortcuts`），文件编辑器在编辑器容器内捕获阶段拦截
- [x] 切换会话后搜索结果清空、输入框收起 —— 组件测试「切换会话后搜索条收起」
- [x] `cd frontend && pnpm lint` / `pnpm exec tsc -b` / `pnpm test` 零新增警告
- [x] `cargo clippy --workspace --all-targets -- -D warnings` 零新增；`cargo test` 全绿
      （新增后端单测 10 例、前端测试 18 例）

**真实浏览器端到端**（Chromium + Playwright）：聊天面板标题栏搜索入口 → 展开搜索条 →
输入「上下文」→ 命中 1 条（片段含高亮词，状态行「共 1 条匹配」）→ 点击命中 → 目标
消息被闪烁标记并滚动到视野中央 ✓。定位页端点另经 `curl` 验证（含目标行、目标为
页内最新、`nextCursor` 指向最旧行）✓。

## 1. 背景

原计划 F06「会话内搜索 — Ctrl+F 唤起搜索栏，匹配消息文本，高亮 + 跳转」自 2026-07-27 挂起，未实施。

backlog X02 原把它与「Markdown 导出」合为一项，但两者技术栈完全不同：导出是纯前端零风险（见 `2026-10-21-acp-session-markdown-export.md`），搜索要碰后端查询与消息定位链路。**本文只做搜索，导出单独立计划。**

2026-10-21 可行性审查推翻了 X02 的一个前提。X02 原文假设「`chat_messages` 表无 FTS 索引 → 必须上 FTS5，且中文分词是本次实施最需要先定的技术取舍（unicode61 不切中文 vs trigram）」。实测结论：

| 事实 | 证据 |
|---|---|
| FTS5 确实可用、零新依赖 | `libsqlite3-sys` 0.30.1 的 `build.rs:129` **无条件**加 `-DSQLITE_ENABLE_FTS5`；bundled SQLite **3.46.0** |
| trigram 分词器可用（需 ≥3.34） | 同上版本 |
| **但 trigram 的存储开销极高** | 实测：5000 行 / 10MB 文本 → 建索引后 DB 从 10MB 涨到 **77MB**（**≈6.7×**） |
| **LIKE 扫描在真实量级下够快** | 实测：5000 行 / 20MB → **28ms**；20000 行 / 77MB → **51ms** |
| LIKE **天然支持中文子串** | 无需分词器，无 tokenization 取舍 |

结论：**会话级搜索不需要 FTS5**。搜索范围天然被「一个会话」框住，LIKE 扫描的代价可控；而 FTS5 换来的只是把 51ms 降到 3ms，代价是 6.7× 存储 + 一套迁移 + 触发器 + 一个中文分词 ADR——为一个 P2 功能付这个代价是过度设计（奥卡姆剃刀）。

## 2. 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P0 | ① 后端检索端点 | `GET /sessions/{id}/messages/search`，会话内 LIKE 检索 + 双预算 | 中 |
| P0 | ② 搜索条 UI | 标题栏入口 → 内联输入框 + 结果列表 + 键盘导航 | 中 |
| P0 | ③ 跳转定位 | 命中消息**未必已加载** → 需「定位页」端点 + 滚动 | 大 |
| P1 | ④ 高亮 | 复用既有 `highlightedMessageId` + `chat-msg-flash` | 小 |
| P1 | ⑤ 边界与降级 | 超预算显式标注 / 空结果 / 会话切换清理 | 中 |

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| **FTS5 全文索引** | 见 §1 实测：LIKE 在真实量级已够快，FTS5 换 6.7× 存储 + 迁移 + 触发器 + 分词 ADR 不划算。**保留升级路径**（见 D2 翻盘条件） |
| **跨会话 / 全局搜索** | 需要作用域选择器 + 跨会话权限/路径语境，与「会话内搜索」是不同产品动作。范围控制（奥卡姆） |
| 搜索 `blocks` 列（工具调用 / 思考内容） | `blocks` 是 JSON、MB 级、进搜索即引入解析与体积问题；且工具输出常含大段代码，搜索噪声大。**只搜 `text`（对话正文）** |
| 搜索 `system` 角色消息 | 宿主内部事件（权限回收 / 连接态），不是对话内容；与 F08 的 D7 同口径 |
| 文本内子串高亮 | react-markdown 下成本高、收益低；复用既有气泡闪烁（`chat-msg-flash`）已能指示「跳到这里」 |
| 搜索历史 / 搜索语法（正则 / 布尔） | 单会话检索已够；语法解析是另一条产品线 |

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | 检索用 **`LIKE '%term%' ESCAPE '\'`**，不用 FTS5 | 实测 LIKE 在 5000 行/20MB = 28ms、20000 行/77MB = 51ms；搜索范围天然被会话框住。且 LIKE **天然支持中文子串**——X02 原文担心的「unicode61 不切中文」在 LIKE 方案下**根本不存在** | FTS5（6.7× 存储 + 迁移 + 触发器 + 分词 ADR）／前端过滤已加载页（只能搜到当前几页，等于没有搜索） | 见 D2 |
| **D2** | **FTS5 升级条件（可量）**：实测会话文本量 p99 > 20MB 或单次检索 p99 > 200ms → 届时按「external content + 触发器 + trigram」升级 | 把升级条件写成**可测的阈值**而不是「以后再说」，避免要么过度设计要么无限期不升级 | 现在就上 FTS5（存储代价与收益不成比例）／「永不升级」（不留升级路径） | — |
| **D3** | 搜索**只在当前会话内** | 与 F06 原意一致；跨会话搜索需要作用域 UI 与不同的话题模型 | 全局搜索（范围与 UX 都大一档） | 用户出现「搜另一个会话的某句话」的强需求 → 另立计划 |
| **D4** | **扫描预算双维度**：`MAX_SEARCH_ROWS`（扫多少行）+ `MAX_SEARCH_BYTES`（扫多少字节），任一触顶即停，**并在响应与 UI 里显式标注省略量** | §P1 要求上限维度匹配真实增长维度。行数与字节是两个独立轴（一条 1 字符 system 行 vs 一条 1MiB 工具输出）。只限行数 = 没限（案例 2 同型）。**静默截断会让用户以为搜全了**（比搜不到更糟） | 不设上限（超大会话把后端拖住，§P4）／只限行数 | 实测典型会话规模（预计 p50 < 2000 行 / < 2MB）远低于上限时，可下调 |
| **D5** | 多个关键词以**空格分隔，AND 语义**（每个词都要在同一行出现，位置任意）；**关键词数上限 `MAX_SEARCH_TERMS`** | 多词 AND 是最常见的真实用法；每词一次扫描 → 成本与词数线性，故须有上限（§P4） | 单关键词（能力不足）／OR 语义（噪声大）／正则（用户输入即正则 = 注入面 + 复杂度） | — |
| **D6** | 关键词里的 `%` `_` `\` 必须 **ESCAPE 转义**；参数走 sqlx 绑定（不用字符串拼接） | §S1：外部输入进 SQL 前必须 sanitize。LIKE 通配符不转义 = 用户搜 `100%` 会变成「以 100 开头」 | 直接拼 LIKE（通配符注入 + 转义 bug） | — |
| **D7** | 新增**定位页端点** `GET /sessions/{id}/messages?at=<cursor>`：返回以目标行为**最新行**的一页（倒序取 N 行后反转） | 命中消息**通常还没加载**（前端是懒加载分页）。用现有 `?before=` 逐页往前翻到目标，需要 O(页数) 次请求、最坏传几百 MB——不可接受。定位页一次查询解决 | 逐页翻（慢到不可用）／只搜已加载页（搜不到旧消息 = 功能半残） | 前端改为全量常驻消息（与 §P1 冲突，不会发生） |
| **D8** | 定位页返回时前端**替换**当前窗口（而非前插），并把 `historyCursor` 重置为该页最旧行 | 替换后「继续上翻加载更早」从该页最旧行继续，语义正确；前插会让窗口出现空洞 | 前插（窗口不连续，滚动位置计算失真）／追加（目标不在视口内） | — |
| **D9** | 高亮**复用** `highlightedMessageId` + `chat-msg-flash`（ChatView 既有机制，用于「跳到上一条用户消息」） | 既有机制现成可用（`ChatView.tsx:217/979` + `ChatMessage.tsx:1179`），且是仓库已确立的「指向某条消息」范式 | 新造一套文本内高亮（react-markdown 下成本高）／纯滚动不加高亮（用户不确定跳到了哪） | — |
| **D10** | 搜索条是**聊天面板标题栏内的内联展开输入框**（延迟展开式，照 FileManager 顶栏搜索按钮范式），**不是弹窗** | 聊天面板无 header 插槽；弹窗会遮住消息且与 Modal 基座的 focus trap 问题纠缠（X03 已记该基座待改造） | Modal 弹窗（与 Modal 基座 a11y 欠账耦合）／固定顶栏常驻输入框（挤占移动端窄栏） | — |
| **D11** | Ctrl+F 绑定在 **ChatView 容器作用域**（`useChatShortcuts` 既有范式：事件从面板内冒泡才生效），打开聊天搜索 | 容器作用域天然保证「焦点在聊天面板内才响应」，不与 `FileEditor` 的 Ctrl+F（`FileEditor.tsx:367`，文件编辑器内）冲突——两者在不同 DOM 子树 | 全局监听（会抢文件编辑器与终端的 Ctrl+F）／不绑快捷键（原计划 F06 明写 Ctrl+F） | — |
| **D12** | 输入 **200ms 防抖**（照 `ChatInput` 的 @ 引用搜索防抖口径） | §P4：外部输入速率不受控，入口设防线 | 每键即查（放大 5× 后端扫描） | — |
| **D13** | 结果列表展示：时间 + 命中片段（截断）+ 命中词高亮；**结果条数上限 `MAX_SEARCH_RESULTS`** | 命中片段比全文有用；结果条数须有界（§P1） | 展示全文（长文本撑爆 UI）／无上限列表 | — |

## 4. 实施分期

### Phase 1 — 后端检索端点

| 改动 | 文件 |
|---|---|
| `search_session_messages(db, session_id, terms, max_rows, max_bytes)`：`WHERE session_id=? AND role<>'system' AND (text LIKE ? ESCAPE '\' AND ...)`，`ORDER BY created_at DESC` + `LIMIT`，Rust 侧累计字节触顶即停；返回 `{hits:[{id, role, created_at, snippet}], scannedRows, scannedBytes, truncated}` | `src/acp/chat_persistence.rs`（新函数） |
| 常量：`MAX_SEARCH_ROWS` / `MAX_SEARCH_BYTES` / `MAX_SEARCH_TERMS` / `MAX_SEARCH_RESULTS`（具名，不魔法数字） | 同上 |
| 端点 `GET /sessions/{id}/messages/search?q=<空格分隔>&limit=` | `src/api/sessions.rs`（新路由，挂在 `sessions::routes()` → 前缀 `/api/v1` → 自动继承 `require_auth_mw`，§S4/S5） |
| 定位页端点 `GET /sessions/{id}/messages?at=<cursor>`：倒序取 N 行（含目标行）后反转，`nextCursor` = 该页最旧行 | `src/api/sessions.rs` + `chat_persistence.rs::list_messages_page_at` |
| 单测：中文命中 / 多词 AND / `%` `_` 转义 / 超行数上限截断且 `truncated=true` / 超字节上限截断 / `role='system'` 排除 / `at` 定位页包含目标行 | `src/acp/chat_persistence.rs` 测试模块 |

### Phase 2 — 前端搜索条

| 改动 | 文件 |
|---|---|
| 新组件 `ChatSearchBar`：延迟展开输入框 + 结果列表 + 键盘导航（↑↓ / Enter / Esc）+ 200ms 防抖 | `frontend/src/components/Chat/ChatSearchBar.tsx`（新） |
| 标题栏入口（图标 → 点击展开），照 `panel-title-bar` 既有布局（`title-bar-spacer` 之后） | `frontend/src/components/Chat/ChatView.tsx` |
| Ctrl+F 接入 `useChatShortcuts`（容器作用域，D11） | `frontend/src/hooks/useChatShortcuts.ts` |
| 会话切换时关闭并清空搜索（避免跨会话结果串台） | `ChatView.tsx` |
| i18n 两份同步（zh/en） | `frontend/src/locales/{zh,en}/translation.json` |

### Phase 3 — 跳转定位 + 高亮

| 改动 | 文件 |
|---|---|
| 点击命中 → 若目标未在已加载窗口内：请求 `?at=<cursor>` → **替换**窗口（D8）→ 滚动到目标 → `setHighlightedMessageId(target.id)` 复用既有闪烁（D9） | `frontend/src/components/Chat/ChatView.tsx` + `chatStore`（窗口替换动作） |
| 滚动到目标：既有「跳到上一条用户消息」的定位逻辑（`ChatView.tsx:695` 附近）可参照 | 同上 |
| 单测：命中已加载 → 直接滚动；命中未加载 → 先拉定位页再滚动；定位页替换后 `historyCursor` 正确 | `frontend/src/components/Chat/ChatView.search.test.tsx`（新） |

### Phase 4 — 边界与联调

| 项 | 要点 |
|---|---|
| 空查询 | 不发请求 |
| 搜索期间切换会话 | 丢弃在途响应（`cancelled` 标志），不把 A 会话的结果写进 B 会话 |
| 超预算 | 结果面板显式写「仅搜索最近 N 条（共 M 条）」 |
| 无结果 | 明确的空态文案（不是空白） |
| 归档会话 | 归档不删 `chat_messages`（X18 已知），搜索照常可用 |
| 非 ACP 会话 | 聊天面板只服务 ACP 会话；不出现搜索入口 |
| 流式中的消息 | `text` 正在被 `upsert_streaming_message` 更新，搜到的可能是半截；不特殊处理（与 F08 同一口径：导出/搜索都是「已落库那一刻」的内容） |

## 5. 验收标准

> 实施后的逐条对照见 §0.3（原验收清单已逐条勾验并附证据，此处不再重复）。
>
> 原始清单（2026-10-21 计划稿）：50 条消息的会话里搜第 3 条才出现的词要命中（证明
> 搜的是全库）；中文子串要能命中；多词 AND；`%` / `_` 不当通配符；命中未加载的消息
> 能自动定位并闪烁；定位页替换后仍能上翻加载更早；超预算要写明省略量；system 行不进
> 结果；Ctrl+F 打开搜索；切会话清空结果；lint / tsc / test / clippy 零新增。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 超大会话扫描变慢 | 后端占用上升 | D4 双预算 + D5 词数上限 + D12 防抖；扫描按 `created_at DESC` 取，命中早停 |
| 「搜到了但漏了更早的」 | 用户失去信任 | D4 强制显式标注省略量（**宁可说「只搜了最近 N 条」也不静默漏**） |
| 搜索结果跨会话串台 | 显示错误内容 | 会话切换时清空 + 在途请求丢弃标志 |
| LIKE 通配符注入 | 语义错误 / 全表扫 | D6 转义 + 绑定参数 |
| 定位页替换窗口后滚动位置跳变 | 用户体验断裂 | 参照既有 `loadOlderHistory` 的 `prependAnchorRef` 补偿逻辑（`ChatView.tsx:463-474`） |
| 实测会话规模远超预期（p99 > 20MB） | LIKE 扫描进入百毫秒级 | D2 的 FTS5 升级路径已写明量化阈值 |
| 与 F08 导出共用分页链路被改坏 | 回归 | 两条链路各自独立端点/参数，不共享可变状态 |

## 7. 文档闭环

实施完成后需更新：

- `docs/architecture/backend.md` — 新增检索端点与定位页参数；`chat_persistence` 的检索函数与预算常量 ✅
- `docs/architecture/frontend.md` — `components/Chat/` 补 `ChatSearchBar.tsx`；聊天面板标题栏新增搜索入口；`utils/chatSearch.ts`；`chatStore.replaceMessages` ✅
- `docs/visual-design/ui-style-guide.md` — 搜索条 / 标题栏按钮 / 行级闪烁的视觉规格 ✅
- `docs/dev/plans/backlog/improvement-directions-remaining.md` — X02 拆为「搜索（F06，本文，已实施）」与「导出（F08，已实施）」✅
- `docs/dev/plans/2026-07-27-acp-session-enhancements.md` — F06 标注已实施 + 指向本文 ✅
- `CHANGELOG.md` — **需加条目** ✅
