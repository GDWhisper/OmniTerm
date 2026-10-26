# Frontend Architecture

React (Vite + TypeScript) frontend. Source under `frontend/src/`.

## Source Tree

```
src/
├── main.tsx, App.tsx, index.css
├── version.ts           # Single source of truth for version
├── i18n.ts              # i18n configuration
├── api/client.ts        # Typed fetch wrapper for all API endpoints
├── stores/
│   ├── appStore.ts      # Zustand: layout, projects, sessions, font size, mobile detection + 断连/回收超时（分钟，可配置）+ 桌面通知开关（localStorage `omniterm_desktop_notification`）
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   ├── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
│   ├── agentStore.ts    # Zustand: agent registry (Phase 3 — static catalog, no live state)
│   ├── gitStore.ts      # Zustand: git panel status/branches + mutate 串行化 + refreshHint（设计见 docs/dev/plans/archive/2026-07-26-git-panel.md）
│   └── chatStore.ts     # Zustand: per-session chat state (Phase 4a — state-only; WS in useAcpChat)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size + blur/idle 断连定时器（分钟可配）+ 自动重连引擎（「聚焦页面才重连」：意外断开/拆除后在页面可见时指数退避自愈，见下方断连小节）+ pty 滚轮接管（方案 C，ViewportController 接线）+ mid-stream error/exit 状态行直写后强制 resync（2026-09-08 增量同步加固 C1）+ Unicode11Addon 激活 '11' 宽表（2026-09-09：xterm 默认表停留 Unicode 6，与后端 alacritty unicode-width 的 2 列布局不一致致像素方块 logo 压扁；proposed API 需 allowProposedApi）
│   ├── useCellFrame.ts  # pty cell_frame 解码渲染：rAF 有界有序队列（超限 keepFrom 锚点 + resync 节流补发）+ seq 连续性校验（2026-09-08 A2：断链即 armResync；无 seq 帧跳过）+ applyCursor 光标污染恢复（2026-09-09：渲染 rows 的 CUP 把光标带到重画终点，帧缺 cursor 字段（后端去重省略）时回写 WeakMap 学习的最近显式 cursor；viewport>0 历史窗口帧不学习）
│   ├── useLongPress.ts  # 移动端长按手势（500ms + 位移取消），终端 paste 菜单、聊天气泡动作菜单与 Sidebar 会话行菜单共用（D3）
│   ├── useMediaQuery.ts # Mobile breakpoint detection + useKeyboardHeight/useIsLandscape
│   ├── useMinuteNow.ts  # 共享分钟级时钟：会话行共用一个 interval 刷新「距今多久」，最后一行卸载即停；页面恢复可见时补一拍（隐藏期定时器被浏览器节流）
│   ├── useFileWatcher.ts # SSE file watcher for live directory updates
│   ├── useAcpChat.ts    # Phase 4a: ACP WS lifecycle → chatStore actions
│   ├── useSessionExport.ts # 会话导出 Markdown 的编排（取数→转换→拼装→下载→toast；入口在侧栏会话右键菜单，仅 ACP 会话）
│   ├── useConfirmCheckbox.ts # 确认层复选框的类型与勾选状态单一真源（ConfirmDialog 与 PopoverConfirm 共用；「记住上次选择」只由 defaultChecked 驱动）
│   ├── useStickScroll.ts # 流式内容滚动锚定（stick-to-bottom）：默认钉底、上翻解除、滚回恢复（ChatMessage thinking/工具块）
│   └── useTerminalEngine.ts # 默认终端引擎× 宿主复用器可用性 → 实际引擎（「在此打开终端」等无点选环节的入口共用，勿各自读 multiplexerAvailable）
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
├── utils/               # 共享纯函数（path.ts, fonts.ts, agentAggregate.ts 会话组状态聚合 blocked>done>working——tmux agent_state 与 ACP chatStore 派生状态在此归一, imageAttachment.ts 聊天图片附件处理——mime 白名单/canvas 降采样/5MB 硬限, atReference.ts 聊天 @ 文件引用 token 检测/替换——与后端 extract_at_paths 语义对齐, touchScroll.ts 移动端终端触摸滚动桥（纵向 drag→合成 wheel）, projectReorder.ts 侧栏项目卡片拖拽排序纯计算（draggedId 插到 targetId 前/后的新 id 序列；Sidebar 提交、乐观重排与 PUT /projects/order 载荷共用，渲染序与落盘序不可能漂移）, viewportController.ts pty 历史视口状态机（方案 C：live/viewport 模式、wheel 接管、rAF 合并、alt-screen 互斥；2026-09-12 有状态锚——请求意图经 `refresh` 位显式区分（滚动 false / 输出重拉 true），锚的位置记忆驻后端 `VtState`，前端不做任何锚定换算，仅做响应 y 权威同步）, swipe.ts 移动端滑动切 tab 手势判定（横向滚动面用 `data-x-scroll` 标记抬手：agent 代码块/宽表格/内联 diff 自己吃横向手势，index.css 配套 `touch-action: pan-x pan-y`，判定选择器见 `components/Layout/Layout.tsx` 的 `PANE_SWIPE_LIFT_SELECTOR`）, haptics.ts 触觉反馈, sessionNav.ts 会话循环切换, clipboard.ts 统一剪贴板复制（async API + textarea 兜底，D1）, chatDraft.ts 会话草稿存取（sessionStorage，从 ChatInput 提取，D7）, messageText.ts extractMessageText 消息正文提取（复制/引用共用）, messageMarkdown.ts 单条消息导出 Markdown（D5；图片默认不渲染 `images:'omit'`——剪贴板不该被 base64 撑爆，会话级导出传 `inline`/按预算决策的解析器，两条导出路径共用这一处渲染规则), sessionMarkdown.ts **会话级 Markdown 导出纯函数**（复用 messageToMarkdown 逐条拼；条数+字节双上限触顶即停并显式标注省略量——静默截断会让用户以为导出的是完整会话；图片按剩余预算逐图决定内联 data URI 还是降级为可见占位符；头部写明导出时刻/图片只有缩略图/thinking 不导出/工具输出截断口径；导出件文案固定中文，与单条复制同源同貌 D1）, sessionExport.ts **会话导出的取数与落盘**（fetchAllMessages 独立分页拉全量——不复用 store 已加载的页，那只有首屏+用户上拉过的页，导出会静默缺前半段；页数与原始载荷双预算，触顶即停并标记不完整；downloadMarkdown 走 Blob+object URL，释放必须延后一拍否则打断刚触发的下载；exportFileName 清洗会话名里的路径分隔符与控制字符）, markdownI18n.ts **导出件的 i18n 接线**（序列化器是纯函数不依赖 react-i18next，文案经 markers/labels 参数注入；导出件用到的 i18n key 只有这一处，改文案 = 改本文件 + 两份 locale；会话级导出与消息级「复制为 Markdown」共用同一套文案）, textBytes.ts UTF-8 字节数（`String.length` 是 UTF-16 code unit，中文会低估一半，体积预算须与 Blob 口径一致）, storedMessages.ts **DB 行 → ChatMessage 的单一真源**（`GET /messages` 行的类型定义 + `toChatMessages` 转换 + 原始帧包裹判定 `isRawFrameWrapper`；首屏 hydrate、上拉分页、会话导出三处共用，勿各写一份。blocks **解码器是注入参数**——真解码器 `decodeStoredBlocks` 住在 hooks/useAcpChat（要经重放分类器还原），而 utils/ 不反向依赖 hooks/）, proxyUrl.ts rewriteLocalUrl 本机 localhost 链接→/proxy/{port}/ 重写 + setProxyDomain/setProxyEnabled 模块级开关（端口转发代理 P3/P4；关闭 = 不重写）, turnStats.ts 后端 `turn_stats` 推送读数的模块级有界缓存 + 订阅（`MAX_TRACKED_SESSIONS` 淘汰；刻意不进 zustand——读数到达直写 DOM，估算计算整体在后端，见 `plans/archive/2026-08-30-acp-work-time.md` E23；旧本地估算模块 `turnClock.ts` 已删除）, terminalEngine.ts 终端引擎偏好单一真源（默认 tmux、存档白名单解析、旧「上次使用」键一次性继承、`resolveTerminalEngine` 把缺复用器的回落收敛到一处）, reportedPath.ts 聊天气泡/ACP locations 路径点击的单一入口（revealReportedPath：getState 取 activeSessionId → looksLikeDirectory 分流 → revealPathInFileManager；三处调用点共用，不订阅 store 以保 memo 契约）, inlineCodeStyle.ts 行内代码基础样式单一真源（background/padding/radius/size/font；MarkdownCore 默认渲染与 Chat 的路径点击态共用，刻意不放组件文件——ESLint react-refresh/only-export-components）, thinkingCollapsed.ts 思考块收起态档位单一真源（`hide` 完全隐藏 / `brief` 显示简要；选项数组顺序即设置面板按钮顺序、localStorage `omniterm_thinking_collapsed` 白名单存档、`thinkingPreviewLine` 取最后一个非空行——尾部反向定位而非整篇 split，思考文本随 turn 累积可达数万字符而 chunk 逐词到达；`ThoughtBlockView` 与 Settings 会话区共用）, sessionDisplayName.ts **会话显示名单一真源**（优先级 `name ?? agent_title ?? ${agent}_${MMdd-HHmm}`；用户手写名永不被 agent 侧标题覆盖由 schema 保证——`name` 非空即手写，create 路径不再落库默认名。7 个调用点全部经它取值，勿再写 `session.name || session.tmux_session_name`（那套写法有两个站点缺 `?? 未命名` 兜底，历史依赖 ACP 默认名非空才没暴露）。默认名用 agent_id + created_at 在**展示期**现算而非落库：前端默认名口径是本地时间、后端 created_at 是 UTC，落库会让「按 created_at 重算比对」类判据因时区静默失效）, defaultAcpAgentId.ts ACP agent 选择默认值（lastAcpAgentId → 第一个；CreateSessionModal 与 AgentHistory 面板共用，勿各自复制）, desktopNotification.ts **浏览器桌面通知的能力探测与发送**（F07：判据以 `'Notification' in window` 为主、`isSecureContext` 只用于解释原因——非安全上下文根本不暴露构造器，故 blocked 天然覆盖「局域网 http」主部署形态；发送失败记日志并静默降级；跨标签页去重用 BroadcastChannel「先声明者发、后到者静默」+ 短窗口本地去重，去重表有容量上限）, sessionLookup.ts **按 id 找会话**（appStore 的会话表按项目切片，展开+查找此前在 Layout/ChatView 等处重复出现，收敛为单一真源）, chatSearch.ts **会话内全文检索的前端调用层**（F06：类型 + 请求 + 命中词高亮切段；检索口径的真源在后端 `chat_persistence::search_session_messages`，前端不重复实现 LIKE / 转义 / 预算任何一条）, popover.ts 锚定浮层的锚点（`PopoverAnchor` = 视口矩形快照 + 最近的滚动祖先；`popoverAnchor()` 由 PopoverConfirm 与行内删除按钮共用——定位不持有 DOM 引用，滚动关闭限定在触发列表内）, …）
└── components/
    ├── Layout/  — Layout.tsx, MobileNav.tsx
    ├── Auth/ — AuthPage.tsx（登录 / 首次设密码页：用户名 + 密码；setup 预填默认用户名、登录态 placeholder 提示）
    ├── Sidebar/ — Sidebar.tsx（列表渲染+状态提升+右键菜单/批量选择态；行数已超 800 行约定，待拆分；cover-conflict「切换到现有项目」的聚焦回执 `focusProjectCard`：折叠态展开 + 滚动进视口 + 闪烁，计时器/rAF 卸载即收；项目卡片拖拽排序：鼠标移动超 4px 立即起拖、触摸长按 500ms（与滚动消歧），`projDrag`/`projDragRef`/`draggedElRef` 三轨——跟随指针的 transform 直写行内（高频不走 React）+ window 级 pointermove/up + `elementFromPoint` 定位目标卡 + 松手乐观重排并 PUT /projects/order，失败回滚 toast）、ProjectCard.tsx（项目树渲染；`flashing` prop = cover-conflict「切换到现有项目」的聚焦闪烁，根节点 `data-proj-id` 供滚动定位与拖拽命中，动画见 index.css `.sidebar-project-focus-flash`；`lifted` prop = 起拖达成后的拽起态（投影/描边/z-index）；头部 `onPointerDown` 接起拖判定——起拖区即头部，无独立手柄，收起/展开态都可拖）、SessionRow.tsx（会话行：单击激活 / 选择模式勾选；桌面右键与移动长按触发菜单；含长按后补发 click 抑制；标题溢出时右缘渐隐、hover 往返滚动；行尾时间槽显示 `last_turn_at ?? created_at` 的紧凑相对时间，hover/focus/触屏时扩展为动作按钮槽并淡出时间（聚焦/active 行不再常显动作）——按钮绝对定位，空闲不挤占标题宽度）、SessionContextMenu.tsx（基于 `Common/ContextMenu.tsx` 的会话行菜单：批量操作 / 重命名）、BatchActionBar.tsx（选择模式底部操作栏：已选计数 + 归档/释放/删除/取消）、BatchSessionDialog.tsx（批量操作二次确认 + 串行执行 + 终端跳过语义）、Create{Project,Session,Worktree}Modal.tsx、Rename/Delete{Confirm,Worktree}/ReleaseConfirm/RepairPath 对话框（DeleteConfirmDialog 的会话分支 = 锚定气泡 PopoverConfirm，项目分支仍为 Modal；批量删除仍走 BatchSessionDialog）、ExternalSessionsSection.tsx（外部会话轮询+adopt；无右键/长按——行以 tmux name 为键、非 DB id）、ArchivedSessionsSection.tsx（已归档 ACP 会话全局折叠区块——点击只读查看历史/取消归档/删除；无右键/长按，保持只读与主列表的差异；数据存 appStore.archivedSessions，SessionView 与 ChatView 据此兜底解析归档态活跃会话；**查看走 `activateSession` 的归档例外：只设内存 `activeSessionId`，不写 `omniterm_active_session`（刷新恢复位）与 `workspaceSessionMemory`（worktree 回到上次会话位）——否则一个个查看归档历史会冲掉在用的会话记忆（且被 prune effect 清除），刷新后恢复不出来；这两个持久位只在会话经取消归档回默认列表后被正常激活才写**）、DuplicateProjectsDialog.tsx、UpdateBadge.tsx（版本探测 + 升级/重启面板：挂载时查询，之后每 10min 轮询，页面恢复可见/网络恢复时补查（1min 节流）；探测失败保留 console 诊断并在下周期重试，长期打开的标签页不会错过新版本；点「立即重启」前查 `/system/restart-preflight`，有活跃 pty/ACP 会话进程时先在面板内展开中断确认（文案写明 tmux 进程不受影响），无活跃会话才直接重启）、RowActionButtons.tsx（含 SidebarBottomButton）、sidebarModalStyles.ts、useAgentAttentionPolling.ts
    ├── Terminal/ — Terminal.tsx
    ├── Chat/ — ChatView.tsx, ChatMessage.tsx, ChatInput.tsx (Phase 4a: ACP session rendering), ChatSearchBar.tsx（**会话内搜索条**，F06：`Ctrl/Cmd+F` 打开的延迟展开浮层——**没有独立入口按钮**（标题栏图标与像素标题条违和，用户反馈）；输入 + 结果列表 + 键盘导航 + 预算状态行；搜的是后端整个会话库，命中未加载时由 ChatView 拉「定位页」把窗口整体替换到目标附近）, FileLocationLink.tsx（agent 上报的文件路径 → 目录则导航 FM 列表 / 文件则开抽屉；经 `utils/reportedPath.ts` 的 `revealReportedPath`，内部走 `getState()`，不动 ChatMessageView props）, messageActions.ts（气泡动作注册表——copy/quote/edit/regenerate/copyMarkdown 唯一真源，桌面 hover + 移动长按共用，D2）, MessageActionBar.tsx（动作条渲染：按 visible 过滤，桌面 hover 动作条 + 移动 portal 浮动菜单）；会话级 Markdown 导出的**入口在侧栏会话右键/长按菜单**（`Sidebar/SessionContextMenu.tsx` 的「导出为 Markdown」项，**仅 ACP 会话显示**——终端会话没有 chat_messages，导出必为空文件；归档区块保持行内按钮、无右键菜单）；编排见 `hooks/useSessionExport.ts`
    ├── Attention/ — AttentionProvider.tsx（**attention 唯一触发点** `fire(targetId, sessionKey, reason)`：侧栏红点 + ping 声 + tab 标题闪 + **桌面通知**（F07）。桌面通知判据见下方「桌面通知」章；文案组装在组件外的 `notifyDesktop`——`fire` 的 deps 为空（长寿命回调），语言/会话表/agent 注册表必须调用时现读）
    ├── AgentPicker/ — AgentPicker.tsx (Phase 3: <select> for create-session modal)
    ├── FileManager/ — FileManager.tsx（文件表格：>200 行虚拟滚动 + 后端列表截断提示/「加载全部」；目录 Size 由后端懒统计；搜索结果显示 rel_path 父目录 + 搜索态横幅，见 frontend-patterns「搜索结果态」）, FileDrawer.tsx, FileEditor.tsx, FilePreview.tsx, MarkdownPreview.tsx（.md 预览：相对图片/链接改写，渲染核心复用 `Common/MarkdownCore.tsx`）, HtmlPreview.tsx（.html/.htm 渲染预览：sandbox iframe（`allow-scripts`，不给 `allow-same-origin` ⇒ opaque origin，页面脚本读不到应用 token/cookie）+ srcdoc 相对引用改写，见 frontend-patterns「外部 HTML 沙箱预览」）, filePreviewShared.ts（预览策略单一真源：扩展名分类、SSE 去抖常量、行数/字节阈值、相对路径解析、下载 URL 构造、HTML srcdoc 改写）, fileSearch.ts（抽屉编辑器内搜索的匹配计算纯函数：正则编译失败/零长匹配/匹配数截断三条边界收敛于此，组件只把结果搬进 CodeMirror 装饰，见 frontend-patterns「抽屉文件编辑器内搜索」；查询输入经 150ms 防抖（`SEARCH_INPUT_DEBOUNCE_MS`）才触发计算——computeMatches 是全文档同步扫描，大文件逐键重扫会卡输入，受控回显仍即时、导航键不受防抖影响，2026-10-10 计划 ④）, fileListWindow.ts（文件表格虚拟滚动窗口计算——阈值/行高/overscan 常量与上下 spacer 高度纯函数，见 frontend-patterns「大列表虚拟滚动」）, OpenTerminalDialog.tsx（「在此打开终端」目录无归属项目时的创建引导）, OpenTerminalConfirmDialog.tsx（目录有归属项目时的二次确认：告知归属项目、生效引擎及更改入口；展示目录在侧栏无同根项目时另有「创建新项目并打开终端」备选——以该目录为根新建项目，显隐由 `utils/path.ts` 的 `findExactProject` 判定）, openTerminal.ts（两个弹窗共用的创建步骤：目录 basename 默认项目名 + 后端 409 already_covered 回退覆盖项目）, icons.tsx（纯内容组件，标题栏/折叠归 RightPanel）
    ├── RightPanel/ — RightPanel.tsx（右栏容器：FILES | GIT 标签、统一标题栏、折叠 rail；两 tab 常挂载 display 切换）
    ├── GitPanel/ — GitPanel.tsx（分支/远端操作 + CHANGES|HISTORY + 底部提交框；分支行内合并/变基/重命名/删除、HISTORY 提交行右键/长按菜单、提交框 AMEND/「提交并推送」/AI GENERATE；中断态横幅与 BASE 对比选择器见下）, OperationBanner.tsx（merge/rebase/cherry-pick/revert/am 中断态常驻横幅：冲突计数 + CONTINUE（有冲突时禁用）+ ABORT 二次确认；数据来自 `/git/status.in_progress`）, FileSections.tsx（STAGED/CHANGES 文件行与只读 RangeFileSection 列表，range 不渲染 stage/discard 操作）, BranchDialogs.tsx（分支重命名/删除确认：未合并时需显式勾选强制删除，可同时删远端）, StashPanel.tsx（stash 列表 + 暂存/Apply/Pop/Drop）, GeneratedMessageDialog.tsx（已有提交信息时二选一替换/追加）, GitDrawer.tsx（diff/commit/range 抽屉：tracked 文件走 `/git/hunks` 并支持 hunk stage/unstage/revert 与 U3↔U10 上下文切换；untracked/commit 保持 raw diff；range 走 `/git/range` 只读）, DiffView.tsx（hunk header 操作按钮，解析 header 与后端 patch 按序精确匹配、失配即隐藏全部按钮）, diffParser.ts（unified diff 展示解析）。BASE 选择器列出本地分支（排除当前分支；中断态禁用），选中后 CHANGES 切换为只读 `base...HEAD` 文件列表并隐藏提交框，点击文件打开 range 抽屉；数据只在选择/手动刷新/ACP 编辑提示时拉取，不参与 5s 轮询。文件行时钟按钮进入该文件的 HISTORY（路径过滤 chip），HISTORY 顶栏 ALL 切换全分支；commit 抽屉在元信息下展示变更文件列表（含 rename 原路径、截断提示）
    ├── Settings/ — Settings.tsx, SettingsPopup.tsx, AgentSettings.tsx（PermissionTimeoutSection 权限超时三态 + SessionsSection 四个分钟滑块，共用 DisconnectSlider 组件）, AiCommitSection.tsx（Settings → GIT：AI 提交 provider/Base URL/model/key 配置；/v1/models 拉取；key 只写不回显，支持 `$VAR` 环境变量引用并提示是否已设置）, AuthSection.tsx（密码验证总开关 / 本地访问校验开关 / 用户名与改密 / 登出）, AuditLogSection.tsx（审计日志只读区块）, DesktopNotificationSection.tsx（Settings → 通知：桌面通知开关 + 能力/权限态行 + 权限被拒时的「重新请求」；**开关=用户意图**、**状态行=现实**两件事分开陈述，不让用户「以为开了其实没生效」）
    ├── TmuxCheatsheet/ — TmuxCheatsheet.tsx (render), TmuxCheatsheetPopup.tsx (popup), data.ts (command list, single source of truth — 增/删/改命令改本文件 + 两个 translation.json；维护指引见 data.ts 顶部 JSDoc)
    ├── TmuxHealthAlert/ — TmuxHealthAlert.tsx（tmux server 聋 server 全局告警横幅 + 「重建 tmux server」按钮 + 孤儿控制客户端堆积提示；自持 10s `GET /tmux/health` 轮询（inFlight 防重入 + cleanup 清定时器），App 级浮层学 `ToastContainer` 挂载先例，桌面/移动/侧栏折叠均可见；四态消费见组件头注释——deaf 且连续确认 ≥3 才告警，重建 409 两分支文案与防双击见 `TmuxHealthAlert.test.tsx`）、TmuxHealthAlert.test.tsx
    ├── Icons/ — GitBranchIcon.tsx, KeyboardIcon.tsx
    ├── Common/ — ContextMenu.tsx（右键/长按菜单）、PopoverConfirm.tsx（锚定确认气泡）、ConfirmCheckbox.tsx（ConfirmDialog 与 PopoverConfirm 共用的复选框行）、OverlayScroll.tsx、MarkdownCore.tsx、DrawerShell.tsx 等（跨页共享的浮层/滚动/渲染件）
    ├── Modal/ — Modal.tsx, ConfirmDialog.tsx
    └── Toast/ — Toast.tsx
```

## Key Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Vite proxy: `/api` → backend port (varies by branch `.env.local`)

## React Hooks 约定（强制）

> 背景：曾因 `useCallback` 定义晚于引用它的 `useEffect` 触发 TDZ `ReferenceError`，
> 导致 `FileManager` 组件白屏（见 `FileManager.tsx` 修复记录）。以下规则用于从根上避免此类问题。

1. **`useCallback` / 普通 handler 必须定义在使用它的 `useEffect` 之前。**
   `useEffect` 的依赖数组在 render 阶段就会被求值以构造数组，若其中引用的
   `const` 尚未初始化（定义在其下方），会抛 `Cannot access 'X' before initialization`。
   即使该 handler 当前不在依赖数组里，也要保持"先定义、后引用"的顺序，防止后续为满足
   `exhaustive-deps` 把 handler 加进依赖数组时引爆 TDZ。
2. **依赖数组必须完整**：effect / `useCallback` 内引用的每个响应式值都要列入依赖数组，
   开启 `react-hooks/exhaustive-deps`；确需排除时必须写注释说明原因，禁止静默关闭。
3. **默认不 memoize**：`useMemo` / `useCallback` 只在以下情况使用——
   (a) 值传给 `React.memo` 子组件且 identity 敏感；(b) 值本身是另一个 hook 的依赖；
   (c) 计算经 profiling 确认昂贵。过早 memoize 增加噪音、掩盖 bug。
4. **hook 调用集中在组件顶部、任何条件逻辑之前**；禁止在循环 / 条件 / 嵌套函数 / 提前 return 之后调用。
5. **effect 只用于同步外部系统**（订阅、浏览器 API、第三方库），不用于派生状态、
   数据转换、通知父组件（应在事件处理中调用）。
6. 每个订阅 / 定时器 / 事件监听 / 在途请求都必须在 cleanup 中释放，避免内存泄漏与竞态。

## 提取决策：共享函数 vs 自定义 Hook

当多处出现相同逻辑时，选择正确形式提取：

| 判别条件 | 共享函数 (`utils/`) | 自定义 Hook (`useXxx`) |
|---|---|---|
| 纯计算 / 数据转换 / 格式化 | | |
| 不含 React API（`useState`/`useEffect`/ref） | | |
| 含 `useState` / `useRef` / `useEffect` 任一 | | |
| 含 DOM 事件监听或浏览器 API 订阅 | | |
| 多组件复用且需要封装组件生命周期 | | |

**判断流程**：

1. 这段逻辑需要 React 运行时吗（状态/副作用/ref）？
   - 不需要 → 共享函数
   - 需要 → 进第 2 步
2. 这段逻辑只在一个组件用，还是多处复用？
   - 单组件 → 留在组件内（不违反奥卡姆剃刀）
   - 多处 → 自定义 hook

> 此规则与工程准则"禁 Copy-Paste"（必须提取）和"奥卡姆剃刀"（不过度抽象）协同 ——
> 重复代码必须提取，但形式由以上条件决定；单一组件内的 Hook 级逻辑不必急于抽出。

## 测试约定

- 前端测试与源码同目录（`*.test.tsx` / `*.test.ts`，vitest + jsdom，入口 `frontend/src/test/setup.ts`）。
- **假时钟 helper 的共享真源在 `frontend/src/test/timers.ts`**（`realTick` / `advanceClock`，UpdateBadge.test 与 TmuxHealthAlert.test 同用）：React 19 调度器走 MessageChannel，fake timers 每推进一拍后必须让真实宏任务队列转一圈才能完成重渲染——两份拷贝会各自漂移，新增定时器/轮询测试一律 import 这份，勿本地复制。

## 断连 / 空闲回收超时 + 权限请求超时（可配置）

设置 → 会话（`Settings.tsx`）四个 range 滑块 + 一组三态模式按钮把超时类设置提为可调（三个断连/回收滑块值域 1..60 分钟、`WARNING_THRESHOLD_MIN=30`；权限超时滑块走秒制档位，见下）：

| 设置 | store 字段 | 默认 | 持久化 |
|------|-----------|------|--------|
| 权限请求超时模式 | `permTimeoutMode`（wait/auto/abort） | abort | 后端 settings 表（`PUT /api/v1/settings/permission-timeout`），点击模式按钮整体 PUT `{mode, seconds}` |
| 权限请求超时（秒） | `permTimeoutSecs` | 1800 | 同上；wait 模式下滑块隐藏（该模式无超时）；「总是」档仅 auto 模式可用 |
| ACP 空闲回收 | `acpIdleRecycleMin` | 5 | 后端 settings 表（`PUT /api/v1/settings/acp-idle-recycle`），onChange 调 `api.setAcpIdleRecycle` |
| tmux 失焦断连 | `blurDisconnectMin` | 10 | localStorage `omniterm_blur_disconnect_min` |
| tmux 空闲断连 | `idleDisconnectMin` | 15 | localStorage `omniterm_idle_disconnect_min` |

- **权限超时 UI**（`Settings.tsx` 的 `PermissionTimeoutSection`，排在 SessionsSection 前）：三模式按钮行复用主题/引擎选择同款 `btnBase`/`btnActive`；auto 模式常驻一条无人值守风险警告（`--warning` 色）；当前模式的 hint 文案随选中态切换。模式与时长是同一设置，任一侧改动都整体 PUT（后端白名单校验 + 热更新）。**时长滑块是秒制档位**（`PERM_TIMEOUT_STEP_SECS=30` 步进，上限 `MAX_PERM_TIMEOUT_SECS=3600`）：最左档 `0`「总是」只对 auto 有语义（有请求即自动放行、不等待），故只在 auto 模式把 `min` 放到 0，其余模式从 30 秒起——从 auto 切走时按时长下限夹回（`clampPermTimeoutSecs`），避免面板停在拖不到且语义无效的值上。
- **store 层**（`appStore.ts`）：导出 `MIN_DISCONNECT_MIN=1` / `MAX_DISCONNECT_MIN=60`；权限超时另导出 `PERM_TIMEOUT_NEVER_SECS=0` / `PERM_TIMEOUT_STEP_SECS=30` / `MAX_PERM_TIMEOUT_SECS=3600` 与 `clampPermTimeoutSecs`（吸附到 30 秒档；非分钟滑块，共用 `clampDisconnectMin`）。`acpIdleRecycleMin`/`permTimeout*` 为后端设置的内存镜像（App 启动时 GET 回填，无 localStorage）。
- **启动回填**（`App.tsx`）：`api.getAcpIdleRecycle()` / `api.getPermissionTimeout()` 在挂载时拉取持久值写入 store——刷新后面板显示后端真相源而非默认值（修复了 `getAcpIdleRecycle` 定义后从未被调用的缺口）。
- **消费方**（`useTerminal.ts`）：删除 `BLUR_DISCONNECT_DELAY_MS`/`IDLE_DISCONNECT_DELAY_MS` 常量，blur/idle 断连定时器改从 store 读分钟值 ×60_000；acpIdleRecycleMin 仅在前端渲染（后端 reaper 消费，见 backend.md Settings 表与权限超时计划）；permTimeout* 另有一个消费点——`useAcpChat` 的 `permission_request` 分支据它豁免 decision 通知，见下条。
- **滑块组件**（`Settings.tsx`）：`DisconnectSlider` 为共享 range 滑块（title/hint/warning 三文案 + value/onChange/onCommit + 可选 `min`/`max`/`step`/`renderValue` 覆盖档位与数值展示），四个用例复用同一组件；ACP 与权限超时滑块 onCommit 调对应 API 持久化。警告触发线默认 `value >= 30`；权限超时滑块传 `warnAboveMin={30 * 60}`（秒制，默认 30 分钟即历史行为，只有调得更长才提醒内存驻留）。
- **时长文案口径**（`utils/permTimeout.ts`，面板与聊天共用同一真源）：`permTimeoutSeconds` 从 detail 取秒（历史 `minutes × 60` 回退）、`permTimeoutDuration` 按「整分钟报分钟、其余报秒」产出 i18n key + 数字、`permTimeoutNoticeLabel` 在「总是」档（秒=0）把 auto 告知换成无等待句式 `system.permTimeout.autoAlways`。新增档位或改口径只改这一个文件。
- **decision 通知豁免**（`useAcpChat.ts` 的 `permission_request` 分支）：`permTimeoutMode === 'auto' && permTimeoutSecs === PERM_TIMEOUT_NEVER_SECS`（「自动推进 + 总是」）时跳过 `attention.fire(sid, sid, 'decision')`——该档位下后端 reaper 由 `Notify` 唤醒、在权限请求到达时即 `auto_advance_permissions` 代为应答（2026-10-09 勘误），用户永远无需决策，通知没有接收人（无声音 / 无标题闪 / 无侧栏徽标）。判定经 `useAppStore.getState()` 读当前值（设置可热更新，帧处理器是长寿命闭包，禁读闭包旧值）；谓词单一真源在 `utils/permTimeout.ts` 的 `permDecisionNoticeExempt`（与后端 reaper 语义对应）。**`abort` + 「总是」不豁免**——其语义是永不超时、请求挂起等用户，通知仍是唯一提醒。banner（`setPermission`）与 done/error 通知不受影响。判定只读本 tab 的 store 镜像，其他设备改设置不会推送到已打开的 tab（刷新后生效，既有镜像语义）。
- **权限超时告知渲染**（`ChatMessage.tsx` 的 `SystemBlockView`）：后端下发的 system 消息可带 `detail`（工具名/类型、内容预览、可选项、自动选中项、超时秒数），命中 i18n key（`system.permTimeout.*`）时本地化渲染，未命中原样显示（2026-08-18 起的历史中文数据）。mid-turn 告知（带 `noticeId`）由后端内联进 assistant 行的有序帧窗口，**live** 经同一 `session_update` 通道下发（classifier 识别 `_meta.omnitermSystem`）→ `appendSystemBlock` → **直接内联进尾部 assistant 消息**（不再铸独立 SYSTEM 消息；过程容器把结论之前的 system 块收进折叠器，随工作块一起折叠）。**hydrate/快照/聚焦补拉**解码出内联 system block 后，统一由 `dropInlinedSystemMessages` 按 `noticeId` 去掉重复的独立行（assistant 行解不出该 id 时保留独立行——帧窗口驱逐/旧数据的兜底）。非 mid-turn 告知（turn 失败等）仍走 WS `system_message{label, detail, notice_id?}` → `pushSystemEvent` → 独立 SYSTEM 消息。所有 system 告知的渲染统一走 `SystemBlockView`，形态为嵌流信息面板 `.chat-system-panel`（`※` 标记 + detail 细分隔线 + 内容预览走 `OverlayScroll`），规格见 ui-style-guide §7.11。详见 backend.md「mid-turn SYSTEM 告知内联 / live 通道」。

### 终端自动重连引擎（useTerminal，2026-09-14）

「聚焦页面才重连」：blur/idle 主动拆除的省资源语义不变，但断连不再要求手动点击——引擎在页面可见时自愈。节奏与门控对齐 useAcpChat 的自动重连（指数退避 `min(1000×2^n, 30s)`，onopen 归零）：

- **调度面**：① ws `onclose`（onerror 不重复调度）与 ② `createTerminal` 失败（initTerminal catch）→ 页面可见时布退避定时器；③ 用户回来信号（`visibilitychange`→visible / `window focus` / 任意活动事件——空闲拆除全程无可见性变化，靠活动事件收口）→ 立即尝试一次并把退避计数归零。
- **隐藏门控**：页面隐藏时不调度、到期定时器直接跳过（隐藏期间不计入退避），回可见由 ③ 接管。引擎函数经 ref/store 取值保持稳定身份（被 mousemove 等高频事件与长寿命 WS 闭包引用），`reconnect` 经 `reconnectRef` 晚绑定。
- **廉价路径**：意外断开时 xterm 仍存活（termRef 非空），重连走 `connectWs` 复用实例；teardown 态（termRef 空）走整端重建并置 `skipAutoFocusRef` 跳过一次 autoFocus（防抢聊天面板焦点），init 失败在引擎路径不弹 toast（`announceFailure: false`）。connectWs 入口 / disposeTerminal / effect cleanup 三处取消排队重试。
- **Terminal.tsx 挂载 effect 的 `terminalDisconnected` 刻意不进依赖数组**（body 条件仍读它）：flag 翻转 true 时若触发 cleanup 会把刚断开的 xterm/WS 连带拆毁，自动重试随之被取消——「不自动重建」由 body 条件保证。
- **遮罩语义**：`autoReconnecting`（引擎在管）时遮罩显示「正在自动重连…」状态行（`role="status"`，固定浅色——遮罩底色不随主题翻转），「重连」按钮保留为立即手动兜底。
- **API client**（`client.ts`）：`getAcpIdleRecycle()` / `setAcpIdleRecycle(minutes)` 对应后端 `GET/PUT /api/v1/settings/acp-idle-recycle`；`getPermissionTimeout()` / `setPermissionTimeout(mode, seconds)` 对应 `GET/PUT /api/v1/settings/permission-timeout`（时长单位为秒，`0` = 「总是」档）。

## 桌面通知（`utils/desktopNotification.ts` + `Attention/AttentionProvider.tsx`）

agent 回合结束 / 出错 / 需要审批时，除站内提醒（侧栏红点 + ping 声 + tab 标题闪）外，
可再走一条 **OS 级桌面通知**（浏览器 `Notification` API，F07）。四条口径：

- **能力探测以 `'Notification' in window` 为主**（D3）：`window.isSecureContext === false`
  只用于**解释原因**，不作独立否决——真实浏览器在非安全上下文里根本不暴露构造器，
  故 `blocked` 态天然覆盖「局域网 IP + 明文 http」这个主部署形态；混用两个判据会让
  jsdom（`isSecureContext` 为 `undefined`）与真实浏览器判定不一致。
- **触发判据 = 「用户是否在眼前」**：① 非当前会话；② 当前会话但 `document.hidden`
  （他已切到别的应用/窗口，标题闪的目标签栏在别的窗口里看不见）。**只按「非当前会话」
  判会误杀主场景**：ACP 的 WS 是按会话建的（切换会话即拆除），故 ACP 回合事件**只在
  用户正看着该会话时到达**。桌面通知已启用且已授权时**不再叠加自己的 ping**（D7，双响）。
- **内容只含会话名 + 事件类型**（D2）：OS 通知在锁屏明文显示，agent 正文可能含
  代码/路径/凭据（`performance-and-safety.md` §S3）。
- **多标签页去重**（D5）：`BroadcastChannel` 上「先声明者发、后到者静默」（同一毫秒
  并列按随机 id 决胜，保证恰好一个发送方）+ 短窗口本地去重；去重表有容量上限。

**开关存 localStorage**（`omniterm_desktop_notification`，不进 settings 表——通知权限
本身是浏览器级状态，跨设备无法共享，落库无语义优势，且落表要 X11 前置）。设置项把
**「开关 = 用户意图」**与**「状态行 = 现实（浏览器权限）」**分开陈述：权限被拒时开关
不弹回 OFF，状态行以危险色写明「浏览器已拒绝」并给「重新请求」入口——不让用户
「以为开了、其实没生效」。

## 会话显示名（`utils/sessionDisplayName.ts`）

侧栏/对话框里所有会话名的**单一真源**（工程准则 7①）。三级优先级：

| 级 | 来源 | 语义 |
|---|---|---|
| ① | `sessions.name` | 用户手写名。非空即「命名过」，**永不被 agent 侧标题覆盖** |
| ② | `sessions.agent_title` | agent 侧标题快照（live `session_info_update` / `session/list` 回填，见 backend.md「agent 侧会话标题回填」） |
| ③ | `${agent}_${MMdd-HHmm}` | 宿主默认名，**展示期现算**（`agent_id` + `created_at`，本地时间） |
| ④ | `tmux_session_name` / 「未命名」 | tmux/pty 等无 agent 的会话 |

**默认名为什么不落库**：`CreateSessionModal` 历史上在 create 时用 `new Date()`（本地时间）生成并落库，而后端 `created_at` 是 UTC——任何「按 created_at 重算再比对」的判据都会因时区永不相等而**静默失效**。改为展示期用 `new Date(created_at)` + 本地 getter 现算，与历史输出逐字相同，且让「未命名」成为 schema 可判定的事实（`name IS NULL` ⇔ 从未命名），不需要 provenance 标记列。

**调用方**（7 处，全部经本函数取值）：`SessionRow.tsx`（主行 + 上下文菜单）、`ArchivedSessionsSection.tsx`、`Layout.tsx`（`activeSessionName`）、`Sidebar.tsx`（归档/释放/删除确认 + 改名预填）。改名预填用**展示名**而非仅 `name`——agent 标题/默认名也要能作为编辑起点（`RenameDialog` 对未改动会自行 bail，不会把派生名固化成用户命名）。

## Agent 历史面板（`session/list` 发现入口）

Sidebar 底部按钮 → 弹出面板（sidebar-popup 约定，见 frontend-patterns.md）：枚举 agent 侧的 ACP 会话，让用户看到裸 CLI 跑的、别处拷来的 `acp_session_id`。

- **数据获取**：`GET /agents/{id}/acp-sessions?cwd=<活动 worktree 路径>`，展开时按 `agent × cwd` 自动拉一次 + 手动刷新。**不轮询**——后端每次调用都临时拉起一个短命 agent 进程（spawn + RPC 各 15s 预算），轮询等于定时起进程。自动拉的一次性用 `autoLoadedKeyRef` 钉住（不用 `rows === null` 判断：手动刷新失败后那会把自动重试又放行一次，覆盖掉已有的错误展示）。
- **行内容**：`title ?? session_id 截断`、`cwd`（等于当前 worktree 时显示「当前工作区」）、`updated_at`、「已纳管」徽标。已纳管行点击 = `activateSession`；未纳管行**无动作**（「载入」是另一个用户动作，未实施）。
- **§8 降级**：`title` 缺省 → 回落 session_id 截断（不显示空行）；agent 不支持 `session/list`（如实测 codebuddy 回 `-32601`）→ 显示 agent 原文错误 + 提示，**不是空白列表**（空白会被读成「你没有历史」）；`truncated=true` → 顶部明示「看到的是截断后的列表」。
- **顺带收益**：后端把命中行的 `agent_title` 回填进 omniterm 自己的会话行，故打开一次面板会让侧栏里「懒得命名」的会话从默认名变成 agent 起的标题（用户手写过的名字不受影响）。

## 新建项目：原生目录选择器（2026-10-18）

`CreateProjectModal` 路径输入右侧新增 `IconFolder` 按钮（i18n `sidebar.pickDirectory`）→ `api.pickDirectory(initialDir, signal)` → `POST /system/pick-directory`。对话框由后端在**运行 OmniTerm 的机器**上打开（浏览器拿不到所选目录的绝对路径），因此**仅 localhost 访问可用**：远程请求返回 403（稳定 code `native_picker_local_only`），该请求走 `silent` 并由弹窗映射到 `sidebar.pickDirectoryLocalOnly` 的 en/zh 文案，用户回退到弹窗内已有的目录浏览器。

- 起始目录 = 输入框当前值（不存在时后端回溯到最近存在的祖先目录）。
- 成功回填时反斜杠统一为 `/`、去尾斜杠后补一个 `/`——Windows 路径兼容现有 `getParentPath`/自动补全，并让下方目录列表立即展示所选目录的子目录。
- `AbortController` 挂在关闭弹窗/卸载：请求取消 → 后端 handler future 丢弃 → `kill_on_drop` 终止子进程并关闭原生对话框。
- 图标在 `picking` 期间禁用；用户取消静默，其余错误由 api wrapper 统一 toast。

## ACP Chat View (Phase 4a)

Session pane splits on `Session.runtime_kind`:

| runtime_kind | Component | Transport |
|--------------|-----------|-----------|
| `tmux` | `components/Terminal/Terminal.tsx` | xterm.js + `/api/v1/ws/terminal/{id}` |
| `pty` | `components/Terminal/Terminal.tsx` | xterm.js + `/api/v1/ws/terminal/{id}` |
| `acp` | `components/Chat/ChatView.tsx` | React DOM + `/api/v1/ws/acp/{id}` |

### 双引擎交互分流（D12，Phase 4）

tmux 与 pty 会话共用 Terminal 组件与 WS 路由，但交互语义按引擎分流，
判别值 = 会话 `runtime_kind`（`Terminal.tsx` 从 sessions 查得传入
`useTerminal`；external 会话无 DB id，恒按 tmux 处理）：

- **tmux 路径**（冻结不改）：滚动/翻页注入 copy-mode 字节（prefix+`[`），
  `tmuxScrollModeRef` 跟踪 copy-mode 状态；modern 键位注入 prefix 组合；
  复制需 Shift 拖选绕过 mouse mode。
- **pty 路径**：零注入字节——滚轮/翻页/退出滚动全部经 `utils/viewportController.ts`
  请求后端历史窗口帧（方案 C，D1-D6；2026-09-12 起锚定为后端有状态锚：滚动
  发 `refresh=false`、输出触发的重拉发 `refresh=true`，位置记忆驻后端
  `VtState`，前端零位置推算；`attachCustomWheelEventHandler` 接管
  wheel，alt-screen / 鼠标协议激活时交还 xterm 默认路径；开关
  `VITE_TERMINAL_SCROLLBACK_VIEWPORT`，详见计划文档 Phase 2 勘误）；
  `scrollMode`（MobileKeyBar 高亮 + 软键盘抑制复用）由控制器的
  viewport 模式启停回调驱动（`y > 0` 即滚动中）；modern 键位拦截直接
  放行；鼠标上报模式经 cell_frame `mouse_mode`/`mouse_encoding` 中继同步 xterm 解析态（2026-09-23，同步生效后上述「鼠标协议激活」放行分支即生效、wheel 走 xterm 鼠标上报），TUI 未开启鼠标上报时直接拖选即复制（autoCopySelect 机制共用）。
- **右键拦截（两引擎共用，2026-10-22）**：鼠标上报激活时（`term.modes.mouseTrackingMode !== 'none'`；pty 经 cell_frame 中继、tmux 由原始输出解析）xterm 已把右键作为 button 2 上报给 PTY，浏览器原生菜单若同时弹出会抢走 TUI 交互。终端容器在 capture 阶段 `preventDefault` + `stopPropagation` 拦截 `contextmenu`；Shift+右键在 xterm 中强制选择、不上报鼠标，故保留为使用原生菜单的逃生口；mouse mode 为 none 的普通 shell 不拦截（复制/粘贴菜单照常）。
- 引擎间切换会话时 `Layout::sessionViewKey` 以 runtime_kind 为 key，
  跨引擎切换强制重挂载（pty 的 onScroll 订阅在创建期注册）。

创建入口：`CreateSessionModal` 无 agent 时显示引擎选择器（卡位序 tmux 在前、pty 居后带 BETA 角标；初始高亮 = 默认引擎，见下节）；选了 agent 则隐藏（ACP 会话）。tmux 选项由
`appStore.multiplexerAvailable`（Sidebar 挂载时探测 `/system/multiplexer`，
503/异常 → false）门控禁用。同一标志也门控 Sidebar external 会话区块
的渲染与轮询（external 是 tmux 专属能力，D6）。

### 默认终端引擎（设置 → 终端）

pty 引擎仍在 beta 期，因此「新建终端会话用什么引擎」提到为可调设置，而不是写死
在弹窗与文件管理器里。单一真源在 `utils/terminalEngine.ts`：

| 项 | 值 |
|---|---|
| store 字段 | `appStore.defaultTerminalEngine`（`'pty' \| 'tmux'`） |
| 持久化 | localStorage `omniterm_default_terminal_engine`；新键缺失时一次性继承旧键 `omniterm_last_terminal_engine`（原「记住上次引擎」功能已收编进本设置），两者均非法/缺失 → `tmux` |
| 入口 | Settings → 终端 `DefaultEngineSection`（两按钮，pty 带 `BetaBadge`；宿主无复用器时 tmux 按钮禁用并提示） |
| 消费方 | `CreateSessionModal`（初始高亮）、`FileManager` 与 `OpenTerminalDialog`/`OpenTerminalConfirmDialog` 的「在此打开终端」（经 `useTerminalEngine`）；引擎展示名统一走 `terminalEngineLabel`（勿再散落 `sessionTypeTmux/PtyLabel` 三元映射） |

两条语义约束：

- **弹窗内显式点选才写回默认值**。未点选 = 沿用现有默认；因宿主缺复用器而落到 pty 不写回——那是环境限制不是用户意图，否则会静默改掉设置里的 tmux 偏好（原「记忆上次引擎」写法如此，收编后不再沿用）。
- **回落判定不得抄副本**。三处消费点统一走 `resolveTerminalEngine(pref, multiplexerAvailable)` / `useTerminalEngine()`，否则会出现弹窗开 tmux、FM 开 pty 的分裂。

The dispatcher lives in `components/Layout/Layout.tsx::SessionView` — it
reads `activeSession.runtime_kind` and renders the matching view. Both
desktop and `MobileContent` use it, so the same session opens the same
view regardless of viewport. The wrapper `key={activeSessionId}` forces
a full remount on session switch, giving each view a clean WebSocket
lifecycle without any explicit teardown logic.

### State / connection split

`chatStore.ts` is **state-only**: a `Record<sessionId, ChatSessionState>`

- **`replaceMessages(sessionId, messages, historyCursor)`**（F06 定位页，D8）：把消息窗口**整体替换**成定位页的内容，并把历史游标重置为该页最旧行——替换后「继续上翻加载更早」从该页最旧行接上。**为什么是替换而不是前插**：前插会让目标消息与已加载的新消息之间出现空洞，滚动位置计算随之失真。不动 todo 板（会话级产物，窗口替换不等于会话内容变了）。
holding messages, `sending`, `error`, `mode`, and the queued follow-up
slot (`queuedMessage`). It has no WebSocket or HTTP dependencies —
actions (`appendChunk`, `pushSystemEvent`, `beginPrompt`, `markDone`,
`markError`, `enqueueMessage`, `clearQueuedMessage`,
`addUndeliveredMessage`) are called by `useAcpChat.ts`, which owns the
socket lifecycle and translates `ServerFrame` into store actions.

This split serves three purposes:
1. Testability — the store is trivially unit-testable in isolation.
2. Multiple views (desktop + mobile) can share one slice without
   duplicating sockets.
3. Phase 4b's `PermissionModal` can plug into the same store without
   rewriting connection code.

### 文件拖拽 → @ 引用（pendingMention）

FileManager 的文件图标通过 `useFileDrag` 的 Pointer 拖拽落到 ChatInput
（`data-at-mention-drop="true"`）时不会移动文件，也不走 HTML5 DnD：FileManager 过滤出
`File`/`SymlinkFile` 后调用 `chatStore.requestMention(sessionId, absPaths)`；ChatInput 用
`consumeMention(sessionId)` 原子消费，按 `session.workspace_path` 转相对路径
（`utils/path.ts::relativeToWorkspace`），过滤含空白/`@` 的路径并按后端
`MAX_AT_REFERENCES=8` 截断，插入到最后光标或活跃 `@token`（从未聚焦则追加到末尾）。
`pendingInsert`（整段替换）语义不变。仅桌面/平板可用；移动端 Files/Chat 分 pane。

### 输入草稿：文字与附件（切会话恢复）

`ChatView` 用 `key={activeSessionId}` 重挂载 `ChatInput`，组件本地 state 不跨会话。
两类草稿分开存放：

- **文字**：`utils/chatDraft.ts` → `sessionStorage`（`omniterm_chat_draft:{sid}`），
  刷新后仍在；每次输入写穿，发送时删除。
- **图片 / 文件附件**：`utils/chatAttachmentDraft.ts` → **模块作用域**有界缓存
  （8 个会话 / 32 MiB，插入序 LRU）。base64 原图可达 MiB 级，不能进
  `sessionStorage`（约 5MB 配额会静默失败并挤掉其他草稿）；因此只保证
  **切会话回来恢复**，刷新页面即清（与 `chatStore` 同生命周期，同
  `chatScrollMemory` 的取舍）。`ChatInput` 挂载时读取、之后逐次写穿；发送
  （`doSend`）显式清除。单条草稿超过总预算时不缓存（留在当前会话组件 state）。

**已发送图片的大图预览**：气泡缩略图是 `<button>`，点击经 `Modal`（portal）
打开预览。预览源恒为 `imageFullSrc`（块的 `data`）：live 消息 `data` 是原图
（`thumb` 仅索引缩略图），hydrate 的历史行按「只落缩略图」决策（见
`docs/dev/plans/archive/2026-09-10-chat-file-attachments.md` D3）`data` 即缩略图。

### Queued follow-up (N=1 single slot)

While the agent is busy (`sending: true`), the input box stays editable.
The user can type a follow-up message and press Enter; instead of
interrupting the current prompt, the message is held in
`chatStore.states[sid].queuedMessage` (a single-slot buffer). When the
in-flight prompt completes (`prompt_done` from the WS), `useAcpChat`
drains the queue in the same microtask:

```text
prompt_done → flushLiveBuffer → markDone (sending: false) → inProgressSeq=null →
  if (queuedMessage) {
    clearQueuedMessage → addUserMessage → ws.send('prompt') → beginPrompt
  }
```

User affordances (N=1 + auto-drain semantics):

- **Chip above input** — `Next: <preview 40 chars> ✕`. Always visible
  while the queue is non-empty. ✕ calls `clearQueuedMessage`.
- **Dual buttons during busy** — `Cancel` (red, kills in-flight) +
  `Queue` (accent, submits to queue). Queue is disabled when the slot is
  full (N=1) or when the textarea is empty.
- **Auto-drain on `prompt_done`** — no grace window, no edit-in-queue.
  Once queued, the message is committed to the next slot.
- **F5-friendly** — the queue is mirrored to `sessionStorage` under
  `omniterm_chat_queue:{sid}` and rehydrated on `ChatInput` mount. Per
  Q6, sessionStorage is per-tab; multi-tab same-session views each
  maintain their own queue.
- **Disconnect leaves a trail** — if the WebSocket closes while the queue
  is non-empty, `useAcpChat` writes an `undelivered: true` user message
  to the in-memory message list (not persisted to DB) and clears the
  queue. The user sees a dashed-border "not delivered — connection lost"
  card in the stream and can decide whether to retype.

The drain location rationale is recorded in
`docs/architecture/adr/0001-acp-queue-drain-location.md`. Domain glossary lives in
`CONTEXT.md`.

### Session update parsing

The ACP crate's `SessionNotification` wire format isn't pinned in
Phase 4 — `useAcpChat.extractTextChunk` handles two plausible serde
shapes for `AgentMessageChunk`:
```
{ "AgentMessageChunk": { "content": { "Text": { "text": "..." } } } }
{ "AgentMessageChunk": { "text": "..." } }
```
Other variants are pushed as generic `system` messages labelled by the
top-level key (`ToolCall`, `Plan`, `CurrentModeUpdate`, …). Phase 5
will tighten the types once fixture captures from a real agent exist,
and render rich cards instead of the current text-only fallback.

### Backend-authoritative persistence & reconnect

消息真相源在后端（见 backend.md turn accumulator）：`text` 与消息存在性由累积器权威落库，前端只 hydrate + 无缝续接。**唯一的例外是 `blocks`**——后端落原始帧，只有前端能 cook 成折叠后的结构化 blocks（体积差两个数量级），所以 turn 结束时前端把 cooked blocks 回写到那一行。

- **hydrate 还原**：`ChatView` mount 时 `GET /messages` 取**最近一页**（后端按条数 + 字节双预算切页，见 backend.md）；`decodeStoredBlocks`（导出自 `useAcpChat`）识别 blocks 列——数组=cooked `ContentBlock[]` 直用，`{"v":1,"frames":[...]}`=原始帧则复用 live 分类器 `classifySessionUpdate(normalizeSessionUpdate(frame))` + `buildReplayMessages` 还原成结构化 blocks（streaming 与 complete 行同源，杜绝 TS/Rust 双份分类）。`status==='streaming'` 映射为 `ChatMessage.streaming`。落定后 `setHydrated(sid, true)`。DB 行→`ChatMessage` 的转换集中在 `toChatMessages`，首屏与上拉分页共用。**被驱逐正文前缀恢复**：后端帧窗口从头部驱逐（见 backend.md turn accumulator），RAW 行 blocks 可能缺早期正文；`decodeStoredBlocks(raw, m.text)` 传入全量 text 列，窗口帧正文恰为其精确后缀时把差集补成 text 块（`prependEvictedProse`，`endsWith` 单一守卫，失配宁缺勿错）。
- **配置快照注入（已结束会话置灰配置栏）**：同一 `GET /messages` 响应还带 `configOptions`（后端持久化的最后已知配置快照，见 backend.md「配置快照」）+ `agentLive`（supervisor 存活位）。`ChatView` hydrate effect 在放行 `preHydrateBuffer` **之前**经 `setConfigSnapshot(sid, parseConfigOptions(data.configOptions), data.agentLive !== true)` 注入——已结束会话配置栏以快照置灰只读展示（样式同活跃态、整体 opacity 0.5、下拉 disabled；`set_config_option` 对无活 client 是静默 no-op，不禁用会无声失败），活会话刷新也注入值以消除配置栏空窗但不置灰。解析与 live 帧共用 `parseConfigOptions`（`useAcpChat` 导出，§7 单一真源）；解除只读的唯一路径是后续 live/replay 配置帧经 `applyTopLevelActions` 覆盖（自动置 `configReadOnly: false`），store 无绕过它的独立配置 setter（原零调用的 `setConfigOptions` action 已删）。
- **上拉加载更早历史**：`historyCursor`（后端 `nextCursor`，`null` = 已到开头，**唯一信号源，不另存 hasMore**）+ `loadingHistory`（防重入）。滚到距顶 `clientHeight × 1.5`（视口比例预取窗口）内且容器真的可滚动时拉下一页 → `prependMessages`（按 id 去重，单次 `set()` 提交消息+游标+清 in-flight）。**前插必须补偿滚动位置**：前插前记 `scrollHeight`，`useLayoutEffect` 里把差值加回 `scrollTop`（绘制前改，否则闪一帧跳动）。**补偿必须有滞后锁兜底**：补偿把 `scrollTop` **抬高** delta，若该页增量很小，补偿自身引发的 scroll 事件仍满足「近顶」→ 连锁翻页直到历史耗尽（`loadingHistory` 只管在飞请求，管不住落定后的下一次）。故发出加载即上闩，解锁判据是**方向**而非绝对位置——「用户确实向上滚过」才解锁：程序性位移全部经 `writeScrollTop` 单一入口写入并同步基准，故补偿/钉底/跳转/恢复位置都不会伪造出「向上滚」；绝对位置判据（如参考实现的 `scrollTop > 20`）会被补偿抬位污染 → 立即误解锁、连锁复现。**解锁不要求手势**（wheel/touchmove）：拖原生滚动条、键盘翻页都不产生手势事件，加手势门槛会把这类用户永久锁死在第一页。**溢出判定与触发窗口必须解耦**：溢出用小绝对余量（`scrollHeight > clientHeight + 32`），触发窗口用视口比例（1.5 屏）——若把比例也用作溢出余量，内容需高出视口 1.5 倍才允许加载，短会话将完全无法上拉加载更早历史（功能回退）。锁与快照按会话隔离（`ChatView` 跨 acp→acp 切换**不重挂载**，故按 sid 重置而非指望重挂载）。只在可滚动时触发是必要的：内容不足一屏时 `scrollTop` 恒为 0，会在 `autoStick` 仍为 true 时自动拉取并被贴底逻辑拽回底部。`commitReplay`（手动 restore）重建的是 agent 侧完整历史，故显式置 `historyCursor: null`。
- **每会话只 hydrate 一次**：`hydrated` 为 true 则直接跳过 `GET /messages`。该接口全量下发 blocks 列（单 turn 可达百 KB 级，存量旧行更大），而 `hydrate` 本身有「messages 非空即 bail」守卫——重复拉取的结果会被整份丢弃，白付一次传输 + `JSON.parse` + 逐条 `decodeStoredBlocks`（实测曾使切会话阻塞 ~0.5s）。跳过安全的依据：切会话不拆 WS（`AcpConnectionManager` 持久 slot——仅对仍存在且未释放/未归档的会话；删除/归档/已释放会话的 slot 会被出清并断开，见 X15），live 帧持续进 store；`commitReplay` 重建条目时刻意保留 `hydrated`；`chatStore` 无 persist，刷新页面 `states` 清空→`hydrated` 回 false 自然重拉。
- **聚焦补拉（断连才刷）**：ACP WS 实测寿命有限（释放态稳定 125.2–125.4s 重置，见 `docs/dev/plans/2026-09-19-ws-idle-disconnect-heartbeat.md`）且后端广播无补发——断连窗口内累积器落库的内容不会随重连回到 store（hydrate 每页面生命周期只跑一次、`load_session` 只走手动恢复），聚焦回来看到旧消息，旧行为只能手动「恢复会话」或刷新页面。修复（`docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md`）：`useAcpChat` 的 `ws.onclose`（非主动拆除，`unmounted` 区分；陈旧 socket 早返）置 `chatStore.needsCatchUp`；`ChatView` 在**挂载**与 `visibilitychange→visible`/`window focus` 时，`hydrated && !replaying && needsCatchUp` 才发一次 `GET /messages` 最新页（不带 cursor，后端双预算切页）经 `mergeLatestMessages` 合并，成功后清标记；fetch 失败保留标记下次重试。合并五规则：① `status==='streaming'` 行跳过（进行中 turn 归 live 路径所有——DB 那份是防抖中的原始帧，覆盖它会丢 live cooked 结构并与后续帧打架）② 同 `dbId` 原位替换（DB 权威）③ 无 dbId 的 user optimistic echo 按 text 全等去重（不双气泡；echo 只在发送成功后产生，与后端行一一对应）④ 无 dbId 的 assistant 按**精确前缀**对账被中断的 turn（补上断连期间跑完的半轮；失配则按 `createdAt` 插入——**宁添不缺**：丢整轮正文比多一个气泡更糟，与 `prependEvictedProse` 的「宁缺勿错」取向相反，那条丢的是已渲染前缀）⑤ 其余按 `createdAt` 排序插入。**③④ 的候选匹配是从尾部向前的位置无关扫描，不是只认尾部一条**：补拉常发生在 turn 结束之后，echo 后面永远跟着 assistant（健康轮带 dbId、断连轮是半截无 dbId），只认尾部永远角色对不上——DB user 行会按 `createdAt` 插成新气泡，用户消息双显示且顺序错乱（2026-10-07 正式版 codebuddy_1007-1314 实测，修复与取证见计划文末 10-07 勘误）。合并后对 `rawStored` 行做带 `dbId` 的 RAW 收敛（与 hydrate 落定路径同函数同语义，id 路径 UPDATE 不 INSERT）；并统一经 `dropInlinedSystemMessages` 按 `noticeId` 去掉 assistant 行已内联的独立 SYSTEM 消息（同一收口也用于 hydrate / 上拉前插 / turn_snapshot，避免同一 mid-turn 告知出现两次）。**本路径绝不触发全量 `syncToDb`**（幽灵行家族入口）。**补拉错峰与扫描预算**（2026-10-10 计划 ②③）：可见性/聚焦恢复的补拉不再在事件回调里同步发请求——`scheduleCatchUp` 挪进独立的短延迟任务（`requestIdleCallback` 降级 `setTimeout(0)`，Safari 无前者且移动端「空闲」可能久等；200ms timeout 上限防饿死；已排定任务去重、卸载取消），让用户的输入事件排在隐藏期积压 flush 与合并扫描之前；flush 保持同步（内容正确性，已有上限）。补拉与上拉分页**双向互斥**（`catchUpIfNeeded` 读 `loadingHistory` 早退、`loadOlderHistory` 读 `catchUpInFlightRef` 早退——刻意不把补拉也置进 `loadingHistory`：该字段驱动「正在加载更早的记录…」提示与贴底重钉，补拉复用会误显文案）。`mergeLatestMessages` rule ③④ 的尾部候选扫描宽度受 `ALIGN_SCAN_BUDGET` 界住（与 `alignReplaySyncPayload` 的对齐扫描**同源常量、同族降级**：超限即放弃该条候选匹配、按 `createdAt` 插入 = 宁添不缺的既有安全路径；不共享函数体——对齐扫描从 cursor 向后且叠加整场总量预算，方向相反，强行参数化是为共享而共享）。**`markDone` 新增 `rowId` 参**：`prompt_done` 把 `frame.row_id` 落到定稿消息的 `dbId`，让健康结束的 turn 全走规则②而非文本猜测（同 text assistant 行可合法多条，文本不是身份）。POST 封装提取为 `utils/syncMessages.ts`（`postSyncPayload`，hook 与 ChatView 共用）。**2026-10-04 勘误（移动端切后台失配）**：桌面切标签只置 hidden、JS 照跑，`ws.onclose`（服务端 ~125s idle 重置 / RST）来得及就位；移动端切后台被 OS 冻结页面（事件派发全停），WebKit 类对冻结页**不补派** onclose（`readyState` 直推 CLOSED），Chromium 类恢复到可见后才派发——迟到晚于 `visibilitychange` ⇒ 标记无人再消费，缺失 ⇒ 标记永不置位，store 陈旧直到手动刷新。故补触发点两条兜底（合并规则不动）：① **E1** `visibilitychange→visible` / `pageshow{persisted}`（bfcache 恢复）时，`appStore.isMobile` 且本次离开 ≥ `RESUME_CATCH_UP_GRACE_MS`(3s) ⇒ 直接置标记补拉一次（幂等 GET，桌面 JS 不冻结、onclose 可靠故不兜底，省流量口径不回归）；② **E2** `ChatView` 经 vanilla `useChatStore.subscribe` 监听标记 **visible 态 false→true** 立即补拉（收迟到 onclose 与可见态意外断开；补拉自身也写该字段，故不走 useSync 自反订阅）。见计划文末勘误块。
- **贴底跟随（`autoStick`）**：贴底态从滚动几何推导（距底 `<CHAT_STICK_THRESHOLD_PX` 视为贴底），`handleScroll` 是唯一解除点（用户上翻超阈值即解除并显示「回到底部」；点按钮 / 手滚回底即恢复）。**解除判定不能只看间距**：scroll 事件只在帧边界派发，而钉底发生在 DOM 提交之后，两者之间任何非 React 来源的布局变化（图片解码完成、字体替换、定时器直写 DOM）都会让那次事件读到 ≥ 阈值的间距 → 几何-only 判定会在无任何用户操作时**永久**解除跟随（此后流式也不跟随）。故 `pinToBottom` 记下钉底后的实际 `scrollTop`（`pinnedTopRef`，浏览器夹紧后的真值；内容不足一屏时不记），`handleScroll` 只在视口移到锚点**之上**时才解除，否则补钉一次并保持跟随；贴底分支同时把锚点同步到实际位置（内容变矮时浏览器夹紧 `scrollTop`，旧锚点会失真）。贴底 effect 用 `useLayoutEffect`（绘制前钉住）而非 `useEffect`：后者要等「提交后跑 effect」排进下一轮任务，DOM 已长高而 `scrollTop` 未钉的窗口里一旦派发 scroll 事件就会被读成上翻（内层 thinking/工具容器同此约定）。**把底缘推远的不只有滚动**，故重钉是两条路径，改动时缺一不可：① 滚动内容高度的**全部**来源（`messages`、`sending` 思考指示、`replaying`、`terminalEvents`、`loadingHistory`）进贴底 effect 的 deps——往里新增条件渲染必须同步登记，否则内容长高而 deps 不动 = 无事件静默失跟；② 容器尺寸变化（键盘收放、todo 看板/权限条/输入区长高、拖面板宽度）经 `ResizeObserver` 重钉。**② 不可省**：浏览器只在滚动容器可见时才替我们保住底缘（滚动锚定），而移动端三面板同挂在一条 300% strip 上，聊天面板离屏时收缩实测底缘直接掉下去且全程不发 scroll 事件，`autoStick` 仍是 true → 切回 sidebar/files 即「没追底」且回底按钮也不显示。两条路径都以 `autoStick` 为门控，用户已上翻时一律不干预（阅读位置优先）；`autoStickRef` 与 state 同写入口，供 RO 回调读当前态而不重建 observer。
- **浏览位置临时记忆（`utils/chatScrollMemory.ts`）**：切走 ACP 会话再回来，视口回到离开前正在读的位置（仅用户上翻浏览中）；用户主动置底或刷新页面后从底部开始。存储是模块作用域 `Map<sessionId, scrollTop>`（§P1 有界 `MAX_TRACKED_SCROLL_MEMORIES=32` + 插入序淘汰最久未写，每次写入刷新新鲜度）——刻意不用 sessionStorage（跨刷新存活，与「刷新即清」相反），与 chatStore 无 persist 同生命周期。**保存是写穿、不是切会话 cleanup 补存**：`handleScroll` 浏览态分支（用户上翻/滚动中）每次写、回底分支每次清——effect cleanup 运行时 DOM 已提交为新会话内容，读 `scrollRef` 只会拿到新会话被夹紧的位置。**清除点**（全部用户主动 `setAutoStick(true)` 路径）：滚动回底 /「回到底部」按钮 / 发送 / 重新生成；另有手动恢复——`useAcpChat` 的 `replay_start` 且 `!suppressReplay`（内容从空白重建，旧位置失去参照；suppress 的「连接即重放」不碰 store 故不清，否则空闲约 125s 一次的 WS 重连会抹掉用户正在用的浏览位置）。**恢复**：进入会话时装配一次性令牌 `pendingScrollRestoreRef`（带 sid），贴底 `useLayoutEffect` 内在 `chatState.hydrated` 门控后消费——`scrollTop` 夹紧到 `[0, maxScrollTop]` 并 `setAutoStick(false)`（「回到底部」按钮即出现），夹紧到底后 scroll 事件自然转贴底并清记忆；内容不足一屏不恢复、维持贴底。三条非直观约束：① 装令牌的 effect 必须是**声明在贴底 effect 之前的 layout effect**（同一提交按声明序执行；passive effect 赶不上贴底 effect 对本会话的第一次执行）；② 无记忆的会话进入时也显式 `setAutoStick(true)`——ChatView 跨 acp→acp 切换**不重挂载**（Layout 的 SessionView 只按 runtime_kind 做 key），不复位的话「在 A 上翻后切到 B」会让 B 停在 A 的滚动偏移上且不跟随新内容；③ 前插补偿锚点带 sid（`prependAnchorRef`），跨会话到达即丢弃（否则陈旧 scrollHeight 会被下一会话的消息变化消费）。移动端同一组件同口径；archived 只读会话同样适用。
- **hydrated 门控**：`GET /messages` 落定前，会改动消息列表的帧（`session_update`/`turn_snapshot`/`turn_state`/`prompt_*`/`replay_start`/`replay_end`，见 `HYDRATE_GATED_FRAMES`）先入 `preHydrateBuffer`，避免抢在 hydrate 前建消息导致 hydrate 因 `messages` 非空而 bail（丢历史）；落定后经 `frameHandlerRef` 按序回放。**preHydrateBuffer 有界**（2026-10-10 计划 ⑨a）：条数 + UTF-8 字节双上限（与 `liveBuffer` 同源常量——界的是同一类「WS 照投、消费方停摆」窗口，这里停摆方是 GET 在飞）；越界**丢最旧**（新帧携带最新 seq 状态）并置 `needsCatchUp`——被丢帧内容后端累积器已落库，聚焦补拉从 DB 幂等找回；**不能**像 liveBuffer 那样越界即提前消费（hydrate 未落定前应用帧 = bail hydrate 丢整段历史）。**replay 帧必须被门控**：刷新后 replay 先于 hydrate 落定到达时 store 仍空 → `suppressReplay` 判 false → `commitReplay` 用重建消息（无 dbId）替换 → `replay_end` 全量 `syncToDb` 无 id 文本匹配失败 → INSERT 幽灵行（2026-08-18 计划 P0）。门控后 hydrate 先落定，store 已有带 dbId 的权威历史 → replay 被 suppress（内容帧丢弃、不 commitReplay 不 syncToDb）。重连（无 remount）时 `hydratedRef` 已 true，帧即时派发。
- **turn_snapshot / turn_state**：连接时后端先发 `turn_state{active}` 再（active 时）发 `turn_snapshot{row_id, text, blocks, seq}`。`applyTurnSnapshot` 按 `row_id` 替换/收编在建 streaming 消息，并把 `inProgressSeq` 水位置为快照 seq。`turn_state{active:false}` 定稿残留 streaming 消息。**中途加入语义**：快照 blocks 同样用其全量 `text` 补被驱逐前缀（`rawFramesToBlocks(frame.blocks, frame.text)`）；收到快照即置 `joinedMidTurn`——本连接只从窗口残片重建了该 turn，`prompt_done` 时跳过 cooked 回写（否则把残缺 blocks 固化进 DB 行，早期正文永久丢失），DB 保留后端原始帧行（text 列完整，下次 hydrate 仍走前缀恢复）；turn 结束即复位，下一 turn 回写恢复。
- **seq 去重**：live `session_update` 帧带 `seq`；`inProgressSeq != null && frame.seq <= inProgressSeq` 时丢弃（subscribe-before-snapshot 的重叠重复帧已体现在快照里），否则应用并推高水位。`prompt_done` 清空水位，下一 turn 从零开始。
- **实时帧缓冲有界（`utils/liveBuffer.ts`）**：`session_update` 动作不是每帧直接进 store——攒进 `LiveBuffer`（相邻同类 prose 动作无损合并），每动画帧 `applyReplayBatch` 一次性提交，把「每 chunk 一次重渲染」降为「每帧最多一次」。**必须有上限**：隐藏页/后台标签/最小化窗口都不派发 rAF，而 WS 消息照常投递——只靠 rAF 的 flush 会让缓冲随离开时长无限累积，回来时一帧吐完半天（`applyActionsToMessages` 每个 action 全量浅拷贝消息列表，O(actions × messages)），主线程阻塞数秒（2026-10-10 用户报告的「假死」）。三条契约（`performance-and-safety.md` §P1）：① 条数（`LIVE_BUFFER_MAX_ACTIONS`=2000）+ UTF-8 字节（`LIVE_BUFFER_MAX_BYTES`=2 MiB）双上限——单条体积由 agent 决定，只限条数等于没限；② 越界即提前 flush（内容零丢失，**不静默丢弃**），单条 action 自身超预算时峰值 = 一条（同后端 `MAX_FRAME_BYTES` 取舍）；③ 相邻 prose 合并带守恒单测。另有一条 1s 兜底定时器（`LIVE_BUFFER_FLUSH_FALLBACK_MS`）覆盖 rAF 停摆窗口——它只是第二道防线：隐藏页定时器会被 Chrome 节流到 1/min、iOS 直接挂起，那时硬上限仍由「越界即 flush」守住。
- **自动重连**（`useAcpChat`，仿 `useFileWatcher`）：WS 连接逻辑封装进 `connect()`，`onclose` 非主动拆除（`unmounted` 区分 session 切换/卸载 vs 网络断）时按指数退避 `min(1000 * 2**retry, 30000)`（1→2→4→8→cap 30s）`setTimeout(connect)`，`onopen` 成功归零 `retry`。陈旧 socket（`wsRef.current !== ws`）的迟到 `onclose` 早返避免重复调度。重连**不重发** `load_session`（保持手动 `restore()` 语义，`suppressReplay`/`isManualRestore` 不受影响），进行中 turn 由 `turn_snapshot`/`turn_state` 续接；cleanup 清 timer + 关 socket。保留原有断连时 `sending→error` 与 `queuedMessage→undelivered` 留痕；断连同时置 `needsCatchUp`（聚焦补拉，见上）。**刻意不做「聚焦即强制立即重连」**（维护者否决：翻看历史时被全重连打扰）——补拉不依赖 socket 状态，累积器独立于 WS 落库。
- **心跳与半开检测**（2026-10-10）：`onopen` 起一条 `HEARTBEAT_INTERVAL_MS`(30s) 定时器，每周期发 `{"type":"ping"}`，收到 `pong` 帧即清零连续缺失计数；连续 `HEARTBEAT_MAX_MISSED`(3) 个周期无 pong 判半开，主动 `ws.close()` 让 onclose 走既有退避重连（**不另起一条重连路径**）。页面隐藏即停发并清零计数：隐藏页定时器被节流（Chrome 5 分钟后 1/min、iOS 挂起），把「节流」误判成「半开」会白拆连接，移动后台白跑握手也是纯电量浪费。间隔取实测空闲重置窗 ~125s 的 1/4 以下，3 × 30s = 90s 早于重置窗。
- **隐藏期不排退避重连**（2026-10-10）：`document.hidden` 时 `onclose` 不排 `setTimeout`，只置 `reconnectDeferred`；页面回来（`visibilitychange`→visible / `window focus` / `pageshow`）立即补连并把退避计数归零（用户回来 = 新一轮退避）。与终端链路「聚焦页面才重连」同一口径（`useTerminal.ts` 已按此运行多版），修的是 ACP 侧此前的缺口：隐藏期照常排退避 = 移动后台白跑握手，且定时器被节流后「指数退避」本就失真。退避定时器回调里也有一道 `document.hidden` 检查（排定后又切走的那一拍同样不握手）。**不翻盘上方「刻意不做聚焦即强制立即重连」**：`resumeReconnect` 只在 `reconnectDeferred`（socket 已断、`wsRef` 为空）时动作，健康连接是 no-op，翻看历史时不会被全重连打扰。
- **`sendPrompt` 卫哨失败可见**（2026-10-10 计划 ①）：socket 非 OPEN（无 socket / CONNECTING / 握死 CLOSED）时不再静默 return——那与「假死」同形（能打字、回车无反应）。按原因分档落 `setError`（错误条渲染路径）：`connecting` 态提示「正在重连，稍候重发」（`chat.sendFail.reconnecting`），其余提示「连接已断开，消息未发送」（`chat.sendFail.disconnected`）；**不**插用户气泡（历史里不该出现从未发出的消息）、**不** toast（与既有断连留痕重复打扰）、**不**自动入队（`queuedMessage` 槽位语义是「agent 忙碌期的下一条」，与连接恢复混用会搅乱 N=1 与 drain 时序）。空输入与无会话上下文仍是静默守卫（正常输入守卫，不是失败）。
- **liveBuffer flush 的会话归属**（2026-10-10 计划 ⑨b）：ws 生命周期 effect 的 cleanup 里 flush 显式传**本 effect 的 `sessionId`**（而非 `sessionIdRef.current`——切会话触发的 cleanup 运行时 ref 已被 render 赋成新会话，读 ref 会把旧会话的积压动作错投进新会话 store）；rAF / 兜底定时器 / 帧终态 flush 不传参，仍读 ref（同一会话内）。
- **两条回写路径，粒度不同**（都经 `POST /messages/sync`，匹配语义见 backend.md）：

  | 触发 | 发什么 | 定位键 | 为什么 |
  |---|---|---|---|
  | `prompt_done`（每 turn） | `turnToSyncPayload` 只发**本 turn 一条** | `frame.row_id`（后端行 id） | 全量重写会随会话增长变成 O(m²) 写放大；本 turn 消息靠 `streaming` 标记界定，故**必须在 `markDone` 之前**调用（它会清掉该标记）。载荷按 store 顺序合并**本 turn 的 streaming assistant blocks + 带 `noticeId` 的 live SYSTEM 消息 blocks**——mid-turn 告知已由后端内联进该行的有序帧窗口，不回写就会在 cooked 覆盖时丢失。**中途加入的 turn 跳过**：收到过 `turn_snapshot`（`joinedMidTurn`）说明本端 blocks 只有帧窗口残片，回写会把早期正文缺失固化进 DB——此时保留后端原始帧行（text 列完整，渲染走前缀恢复） |
   | `replay_end`（手动 restore） | `alignReplaySyncPayload` 发**带 id 的对齐载荷** | 位置 + 角色 + 文本**前缀**守卫 | 手动恢复刻意不 suppress（DB 快照可能缺 thought/tool 块，必须让重放覆盖），故 `commitReplay` 必然从空白重建 store、hydrate 行的 dbId 全部丢失 → 全量无 id 载荷会被后端文本匹配判失配而 INSERT 重复 assistant 行（幽灵行家族的手动恢复入口，2026-09-19 计划 P1）。故在 `replay_start`（早于 `commitReplay`、与 `replay_end` 同在 `HYDRATE_GATED_FRAMES` 故 hydrate 必已落定）快照基线，把重放消息按「同角色 + 基线 text 是重放 text 的前缀」认回既有行。**指针只在命中时推进** ⇒ 已配对基线下标严格递增（更晚的重放消息不可能配到更早的行）+ 一行只被消费一次 ⇒ 误 UPDATE 不可能。失配一律降级为无 id（= 今天的文本匹配/INSERT），降级粒度是单条消息；整场扫描另有总量预算 `MAX_ALIGN_COMPARISONS`，超限整场降级为全量无 id 写回并 warn（不弹 UI） |
  | **hydrate 落定**（每会话一次） | `storedRawRowToSyncPayload` 只发 RAW 残留行 | `dbId`（hydrate 行的真行 id） | RAW 残留（turn 结束时前端 WS 不在线，`prompt_done` 未送达）停在原始帧包裹态，体积比 cooked 大两个数量级；hydrate 已把包裹解码成 cooked blocks，带 id 回写 → UPDATE 不 INSERT。streaming 行跳过（后端累积器仍在写，`prompt_done` 正常路径接管）。`rawStored` 标记由 `ChatView.toChatMessages` 在 hydrate 时设置（解码失败/为空的 RAW 行不标记——回写纯文本兜底会覆盖不可识别帧） |

  **为什么按 `row_id` 而不是文本匹配**：后端一个 turn 一行，前端本 turn 可能不止一条消息；且文本相等这个不变式易漂移（丢帧、cancel 补发帧、拆分粒度），对不上就会 INSERT 重复行。`ChatMessage.dbId` 承载「已知的真 DB 行 id」（hydrate 行 / `turn_snapshot` 的 `row_id`），本地 `genId()` 的消息不填——谎报会静默命中零行。
  **纯工具调用 turn 的 `text` 为空**（后端只累积 `AgentMessageChunk`），却恰好是 blocks 最肥的一类，所以后端的空 text 跳过守卫只作用于文本匹配路径。

### ACP 实时读数（工作时长 / 工具耗时 / tok/s）：后端结算、前端只显示

三项读数的估算**整体在后端**（`src/acp/turn_accumulator.rs`，口径与回归向量见工作时长计划 E23）：流式期经 WS `turn_stats{work_ms, tool_ms?, tps?}` 帧约 1Hz 推送（`TurnEvent::Started` 后立刻一帧、连接时首个 tick 立即就绪），定稿时随 `prompt_done.duration` 下发并落 `chat_messages`（`duration_ms` / `tool_ms` / `tps`），刷新后由 hydrate 逐消息带回。前端退化为纯显示：

- `utils/turnStats.ts`：推送读数的模块级有界缓存（`MAX_TRACKED_SESSIONS` 插入序淘汰）+ 订阅回调；`ChatMessage.tsx` 的流式读数（元信息行 `LiveWorkElapsed`）订阅后直写 DOM，不进 React state——隐藏标签页不受定时器节流影响（驱动源是 WS 帧而非本地 `setInterval`）。**流式读数只挂最后一条 assistant 消息**：`turn_stats` 是会话级读数，同一 turn 可能被 system 通知 / 工具卡切成多条 streaming 消息，逐条渲染会让同一组「工作中 … · 工具 … · … tok/s」重复出现（2026-10-18 修复）。收纳行流式期只显示计数、不显示实时时长；结算后才显示 `durationMs`。
- 定稿读数渲染 `message.toolMs` / `message.tps`（三态：`undefined`/`null` = 无读数不渲染，`0` 同样不渲染），挂在**各自的消息**上——历史行显示自己那一轮的值，不再有「只挂最后一条 assistant」的全局门控（那是内存快照按会话存的旧规避手段）。但同一 turn 的多条 streaming 消息共同对应后端同一行（`turnToSyncPayload` 按 turn 合并回写），`markDone` 只把结算读数（`durationMs`/`waitMs`/`toolMs`/`tps`/`finishedAt`）落到**该 turn 的最后一条**，避免定稿后在多条气泡底部重复同一组读数。
- 旧 `utils/turnClock.ts`（本地估算）已随 E23 删除；`useAcpChat` 不再做字符计数 / 工具状态喂表，`chatStore` 不再有起表/停表/冻表接线。


## localhost 链接重写（端口转发代理 P3/P4）

机器 A 的浏览器经 OmniTerm 访问宿主机 B 的 localhost 服务时，直接点 `http://localhost:{port}` 会打到浏览器 A 自己的回环地址。前端把它重写为 `/proxy/{port}/`（同源相对路径，计划 D4），由后端转发到 `127.0.0.1:{port}`。

- **`utils/proxyUrl.ts::rewriteLocalUrl(raw)`**：匹配 `http(s)://(localhost|127.0.0.1|0.0.0.0):{port}` 或裸 `hostname:port`，返回 `/proxy/{port}/...` 相对 URL；非本机 URL 返回 `null`。端口范围与后端白名单对齐（`PROXY_MIN_PORT=3000` / `PROXY_MAX_PORT=65535`），黑名单/自身端口由后端 403 兜底。
- **全局开关门控（P4）**：`/system/info` 的 `proxy_enabled` 由 `App.tsx` 启动时写入 `setProxyEnabled`（旧后端缺省按 `true`）；关闭后 `rewriteLocalUrl` 一律返回 `null`，聊天/终端链接不再走代理。设置页保存成功后立即调用 `setProxyEnabled(res.enabled)`，无需刷新。
- **设置页分区（P4）**：`components/Settings/ProxySection.tsx`，挂在 **AUTH** 分类（`groups: [[AuthSection], [ProxySection], [AuditLogSection]]`）。内容 = 全局开关（`ToggleRow`）+ 端口策略（default/allowlist 两个像素按钮）+ 严格模式放行清单（最多 64 行，输入框 + `×` + `+ Add port`）。**显式保存**（参照 `AiCommitSection`）：开关/模式/清单一次性 PUT，避免安全配置逐键半生效；前端只做范围/重复/空行校验，黑名单/自身端口由后端 400 兜底并内联展示。空清单严格模式显示 warning（= 全拒）。API 方法在 `api/client.ts`：`getProxySettings` / `setProxySettings`（`silent: true`，错误在分区内联）。
- **子域名形态（`setProxyDomain` + `proxy_domain`）**：后端配置 `--proxy-domain` 时，`/system/info` 返回 `proxy_domain`，App 启动时 `setProxyDomain` 缓存到模块级变量；此后 `rewriteLocalUrl` 命中本机 URL 时生成 `{protocol}//{port}.{domain}:{backendPort}/...` 子域名绝对 URL（根治绝对路径 SPA），未配置则回退路径前缀。后端端口 = `import.meta.env.VITE_BACKEND_PORT`（dev 构建注入，`vite.config.ts`）/ `window.location.port`（生产同源，`import.meta.env.PROD` 区分）。
- **路径前缀形态的绝对路径 SPA 兜底（后端响应体重写）**：路径前缀下目标应用内绝对路径资源/API（`/assets/*`、`/api/*`）会绕过前缀直达 omniterm-host 而 404——后端对 `text/html`/`text/javascript` 响应做字节级前缀重写兜底（见 `docs/architecture/backend.md`「响应体重写与绝对路径 SPA」），局域网纯 IP 场景开箱即用；子域名方案（有域名时）仍为首选。
- **Chat 接入点**（`components/Common/MarkdownCore.tsx` 的 `MarkdownLink`，聊天 `Chat/Markdown.tsx` 与文件抽屉 `FileManager/MarkdownPreview.tsx` 共用同一渲染核心）：react-markdown 的 `a` 组件渲染时判断 href 是否本机链接——是则保留原始 href（hover/复制仍是 localhost），`onClick` 里 `e.preventDefault()` + `window.open(rewritten, '_blank', 'noopener')`。**圆角差异走 props 勿改默认值**：聊天已上线 `codeRadius=6/inlineCodeRadius=3`，新容器按 UI 规范取默认 0。
- **Chat 本地路径接入点**（`components/Chat/Markdown.tsx`，见 `utils/path.ts` 的 `parseLocalFilePath` / `isLikelyPathString` / `looksLikeDirectory` 与 `utils/reportedPath.ts` 的 `revealReportedPath`）：聊天气泡把三类 agent 输出变为可直接在右侧 FileManager 定位的入口——① markdown 链接指向本地文件系统路径；② 行内代码内容形如路径（真实场景：agent 只输出 `` `/home/pax/coding/OmniTerm-dev` `` 反引号包裹，不带 markdown 链接语法）；③ ACP `ToolCallLocation.path`（`FileLocationLink.tsx`）。三者统一走 `revealReportedPath` 这**单一入口**（`getState()` 读 activeSessionId，不订阅 store → 不破坏 `ChatMessageView` 的 memo 契约；AGENTS.md 工程准则 7 信号 ①：同一判断 ≥2 处须收敛）。判定从严宁可漏判：误判成路径会给非路径行内代码挂上假可点击态，误点还会弹 read_dir 失败 toast，故双词斜杠组合（`and/or`、`true/false`）、代码片段（`const x = a/b`）一律不判路径。目录/文件判定是**启发式非权威**：无扩展名末段（`Makefile`/`Dockerfile`/`LICENSE`）已按文件处理，仍无法区分的（`bin/run`、`src/main`）按文件开抽屉——抽屉的错误可恢复，而误切目录会丢掉用户当前位置。
- **⚠️ react-markdown 陷阱：接管某个 HTML tag 后无法「放行」给默认 renderer**：`components` 按 tag 一对一接管，自定义 renderer `return undefined` 会让该节点连同内容**一起消失**（表现为整块代码/整条气泡不显示）。因此只想给「行内 code」加行为的容器，必须对围栏代码块显式调共享导出 `FencedCodeBlock` 而非回退默认；踩坑记录见 `Markdown.tsx` 的 `code` renderer 注释。同类「只叠加自己的部分、其余复用」的导出还有 `inlineCodeBaseStyle`。
- **终端接入点**（`hooks/useTerminal.ts`）：`WebLinksAddon` 构造传 `handler` 回调接管链接点击，`rewriteLocalUrl` 命中则重写、否则默认 `window.open(uri)`。**已知限制**：addon 0.12 内部用 `new URL()` 校验，无法识别无 scheme 的裸 `localhost:3000`（只识别 `http(s)://` 开头），见计划风险表降级。
- **dev 代理**（`vite.config.ts`）：`/api` 与 `/proxy` 前缀透传到后端，`ws: true` 支撑 WS relay（P2）。两条代理均**必须 `changeOrigin: false`**（原样透传浏览器 `Host`）：后端 WS 入口的 CSWSH 防护按「`Origin` 的 host == 请求 `Host`」判定（`src/ws/origin_guard.rs`），改写 Host 会把一切非 `localhost` 访问（局域网 IP / `DOMAIN` 域名）误判成跨站 → 全部 WS 403、终端与聊天停在重连（2026-09-27 勘误，见安全加固计划）。
