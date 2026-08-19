# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]` for in-progress work.
- Changes grouped by category: `Added`, `Changed`, `Fixed`, `Removed`, `Refactored`.
- One line per change — concise, describes **what** and **why**, not how.
- Each entry ends with a timestamp in `(YYYY-MM-DD HH:MM)` format.
- Breaking API changes prefixed with **BREAKING**.
- File paths are relative to project root (e.g. `src/api/files.rs`, `frontend/src/components/...`).

### When to add an entry

- New API endpoint, new component, new feature → `Added`
- Behavior change, UI adjustment, dependency bump → `Changed`
- Bug fix → `Fixed`
- Deleted code, removed endpoint, dropped dependency → `Removed`
- Code reorganization without behavior change → `Refactored`

**只写实质性的改动**：对用户或下游开发者可见的行为变化。反复提交→修复→再出问题的循环 bug，在彻底解决前不写条目。

### When NOT to add an entry

- Typo fixes in comments, whitespace cleanup, lint fixes
- Changes to `AGENTS.md`, `PROGRESS.md`, or other internal docs
- Dev-only tooling tweaks (`.gitignore`, editor config)
- 提交后又回退的改动
- 同一 bug 的多次未遂修复（只写最终修复那次）

### Scope tags

Prefix each entry with the area it affects:

| Tag | Scope |
|-----|-------|
| `[backend]` | Rust backend (`src/`) |
| `[frontend]` | React frontend (`frontend/src/`) |
| `[api]` | REST/WebSocket API contract |
| `[infra]` | Docker, CI, build, dev scripts |
| `[docs]` | User-facing documentation |

---

## [Unreleased]

### Added

- (2026-08-19 12:40) `[update]` 一键升级后自动重启生效：Unix 上更新成功即调度延迟自重启（exec 新二进制、PID 不变，回收 ACP 子进程后原地替换），前端显示倒计时并自动刷新页面拿到新版本，不再需要手动执行 `omniterm stop && omniterm start`；Windows 维持手动重启提示。`/system/version` 新增 `container` 字段、`/system/update` 新增 `auto_restart` 字段，容器环境（Docker 等）禁用一键升级并提示重新拉取镜像（容器内替换无法持久）（`src/update.rs`、`src/api/system.rs`、`frontend/src/components/Sidebar/UpdateBadge.tsx`）

### Fixed

- (2026-08-19 00:26) `[frontend]` 修复 ACP 会话流式输出中刷新页面丢失早期 assistant 正文：后端 turn 累积器帧窗口按字节上限从头部驱逐旧帧，刷新后 hydrate/续接快照只含窗口残片，且 turn 结束时前端把残缺 cooked blocks 回写覆盖 DB 行使缺失永久化——现收到续接快照的 turn 跳过 cooked 回写（DB 保留完整 text 列的原始帧行），且 RAW 帧解码与快照还原时用后端全量 text 把被驱逐的正文前缀补回显示（精确后缀匹配守卫，失配宁缺勿错）（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`）

---

## [0.2.16] - 2026-08-18

### Changed

- (2026-08-16 15:10) `[backend]` `[frontend]` `/files/watch` SSE 事件去抖：后端 100ms 窗口按 `(kind, path)` 去重合并后批量下发，合并缓冲超限或广播溢出时下发 `resync` 全量重同步；前端收到事件 500ms 防抖刷新一次，切到 GIT tab 时断开 SSE（后端 watcher 注销）——降低「单次保存多个事件 → 多次全量列表请求」的放大，面板不可见时不再持续 watch 目录树（`src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts`、`frontend/src/components/FileManager/FileManager.tsx`）

### Fixed

- (2026-08-18 16:45) `[frontend]` 修复 ACP 会话幽灵行：turn 结束时前端不在线（切走/关页面）→ 该行停在原始帧包裹态（体积比 cooked 大两个数量级）；页面刷新时若 agent 重放帧先于历史加载落定到达，store 为空窗口内用重建消息（无 DB 行 id）覆盖历史并全量写回，后端按文本匹配失败即静默插入重复的 assistant 消息——重放帧纳入 hydrate 门控（历史先落定、重放被抑制），hydrate 后 RAW 残留行以带行 id 的 cooked 形态回写收敛（UPDATE 该行不 INSERT）（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-08-18 16:05) `[backend]` `[frontend]` 权限请求 30 分钟无人审批被 reaper 强制回收（cancel + kill）时，在聊天会话写入并广播一条 system 消息告知用户回收原因（此前 agent 静默消失，权限弹窗只推给对应会话的 WS 客户端、切走即不知情）：`chat_messages.role` 放宽为 `user/assistant/system`（表重建 migration）、reaper 注入 db 落库 + 经 `system_message` WS 帧实时推送、前端 hydrate 与实时两条路径均以 system 消息渲染（`migrations/20260818_chat_message_role_system.sql`、`src/acp/reaper.rs`、`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-08-18 13:58) `[frontend]` 修复移动端滑动聊天上下文时长按误触气泡功能菜单：慢速拖动（位移未达取消阈值）时内容已滚动但长按计时器未取消，手指停住即弹菜单且关闭后循环复现——滚动容器 scrollTop 变化即取消长按（与位移大小无关），滚动停止后 400ms 冷却期内不启动新长按（`frontend/src/hooks/useLongPress.ts`）

---

## [0.2.15] - 2026-08-16

### Added

- (2026-08-14 01:04) `[frontend]` ACP 聊天桌面动作条浮层动态定位：优先显示在图标下方，空间不足（贴近视口底部）时翻转到上方，避免操作条浮层被视口裁切（`frontend/src/components/Chat/MessageActionBar.tsx`、`frontend/src/index.css`）
- (2026-08-14 00:38) `[frontend]` ACP 聊天桌面动作条两段式 hover：气泡 hover 仅显示图标（文字隐藏），hover 到具体图标时才以浮层显示功能文字——动作条常驻态更简洁，避免误触与双重原生 tooltip（`frontend/src/components/Chat/MessageActionBar.tsx`、`frontend/src/index.css`）
- (2026-08-14 00:26) `[backend]` `[frontend]` 新增 localhost 端口转发反向代理 `/proxy/{port}/{*path}`：机器 A 的浏览器经跑在机器 B 上的 OmniTerm 访问 B 的 localhost 服务（如 dev server）。目标 IP 硬编码 `127.0.0.1`、端口白名单（`3000..=65535` 减数据库/内部服务端口黑名单，并动态排除自身监听端口防回环），请求/响应 header 重写（Host/Origin/hop-by-hop 剥离/`Set-Cookie` 域与路径/`Location` 相对化，转发时剥离 `omniterm_token`），响应 `chunk()` 流式回写不落内存；WebSocket 双向 relay（每方向 `mpsc(64)` 有界，满则拒新数据 + warn）支撑 Vite HMR 等 WS dev server。前端 Chat 与终端里的 localhost 链接自动重写为 `/proxy/{port}/` 新标签打开（`src/proxy/`、`src/api/mod.rs`、`src/main.rs`、`frontend/src/utils/proxyUrl.ts`、`frontend/src/components/Chat/Markdown.tsx`、`frontend/src/hooks/useTerminal.ts`、`frontend/vite.config.ts`）
- (2026-08-14 02:00) `[backend]` `[frontend]` 端口转发反向代理新增子域名形态 `{port}.{proxy_domain}`：配置 `--proxy-domain`（`OMNITERM_PROXY_DOMAIN`）后，绝对路径资源的 SPA（Vite/Next.js）不再白屏——浏览器对 `/assets/*`、`/_next/*` 的解析天然落到子域名 Host，由最外层 middleware 按 Host 头路由到 `127.0.0.1:{port}`。鉴权 cookie 跨子域名（`Domain={base}`）、`/system/info` 透出 `proxy_domain`、前端 `rewriteLocalUrl` 按需生成子域名 URL；未配置时行为不变（路径前缀兜底）。DNS 通配符解析为用户部署负担（dnsmasq/公网/hosts 三选一）（`src/proxy/mod.rs`、`src/auth/mod.rs`、`src/api/auth.rs`、`src/api/system.rs`、`src/main.rs`、`frontend/src/utils/proxyUrl.ts`、`frontend/src/App.tsx`、`frontend/vite.config.ts`）
- (2026-08-14 14:11) `[backend]` 反向代理路径前缀形态支持绝对路径 SPA（局域网 IP 直连场景不再白屏）：新增 HTML/JS 响应体字节级重写——`text/html` 的 `src`/`href`/`srcset`/`action`/`poster` 属性与 `text/javascript` 的 `"/api/`、`'/api/`、`` `/api/ `` 字符串字面量统一补 `/proxy/{port}` 前缀（全局一致重写保证 `===` 比较逻辑自洽；外部 URL/协议相对/相对路径/已带前缀不动）。子域名方案在局域网纯 IP（`3000.192.168.5.216` 非法）与非 secure context（SW 不可用）场景失效，此兜底是唯一通用解；HTML 4MiB / JS 16MiB 上限，超限回退流式透传（`src/proxy/mod.rs`）
- (2026-08-14 21:30) `[backend]` 修复反代响应体重写破坏 gzip 压缩体导致浏览器 `ERR_CONTENT_DECODING_FAILED`（3000 端口等绝对路径 SPA 经代理打开仍白屏的根因）：reqwest 未启用自动解压（`default-features=false` 无 gzip feature），上游返回的 gzip 压缩字节经 `from_utf8_lossy` 转码被损坏，响应头却保留 `Content-Encoding: gzip` → 浏览器解码失败。请求侧剥离 Accept-Encoding 强制上游回明文（回环传输压缩收益可忽略），响应侧 `Content-Encoding` 非空时跳过重写走流式原样透传作双重保险（`src/proxy/mod.rs`）
- (2026-08-15) `[backend]` 反代路径前缀形态支持 SPA 客户端路由（new-api 等 React Router 应用不再渲染 404，浏览器无 MIME 报错）：JS 重写注入 React Router v7 `<BrowserRouter>` `basename:"/proxy/{port}"`（以 `v7_startTransition` 特征匹配）——React Router 自动剥前缀匹配路由、Link/navigate 自动带前缀、地址栏正确、刷新正常；另改写 Vite 8 preload helper `return"/"+e` → `return"/proxy/{port}/"+e`（Vite 8 把依赖硬编码成根绝对路径绕过 `import.meta.url`，反代下 chunk 请求根路径 404）。早期 polyfill 方案（劫持 `Location.prototype.pathname`）因 Chrome 的 Location 是 [LegacyUnforgeable] 特殊对象而无效，已废弃。子域名方案仍为根治，本修复让局域网纯 IP 场景也能用（`src/proxy/mod.rs`）

### Fixed

- (2026-08-15) `[backend]` 反向代理（`src/proxy/`、`src/api/auth.rs`）正确性加固一轮（修复审查报告 P0 项）：
  1. JS 重写补上**无尾随斜杠的 `/api` 字面量**（`"/api"`、`"/api?x"`、`"/api#x"`）——此前只重写 `/api/`，`fetch('/api')` 等请求落 OmniTerm 根路径 404；regex crate 不支持 lookahead，边界判定改捕获组 + 函数式检查（`/api` 后须为 `/`、引号、空白、`?`、`#`、`$` 或字符串结束，避免误匹配 `/apix`）
  2. 请求转发补 `X-Forwarded-For`（已有链逗号追加客户端 IP，无则新建）/ `X-Forwarded-Proto`（缺失补 `http`）/ `X-Forwarded-Host`（缺失取原始 Host）——已有值保留不覆盖（外层 nginx 已带 https/真实 Host 时覆盖会误导上游）
  3. HTML 属性重写补 `formaction`（`<button formaction>` / `<input formaction>` 提交目标）；`<base href>` 已由 `href` 分支覆盖，补单测确认
  4. `Location` 重写支持 `http(s)://0.0.0.0:{port}` 与 `https://localhost|127.0.0.1:{port}` 的回环重定向
  5. WS 入口新增 **Origin 校验（CSWSH 防御）**：Origin 的 host（忽略端口）与请求 Host 不一致的 WS 握手 403，无 Origin（curl/原生 WS 等非浏览器）放行
  6. 子域名登录 cookie 对 **IP / localhost / 无点域名 base 不再设 `Domain`**——浏览器规范要求 `Domain` 必须含点，`Domain=192.168.5.216` 会被直接拒绝导致子域名鉴权永久失效（`src/proxy/mod.rs`、`src/proxy/ws.rs`、`src/api/auth.rs`）
- (2026-08-15) `[backend]` 反向代理健壮性加固一轮（修复审查报告 P1 项）：
  1. WS relay 收尾**发送 Close 帧**：任一侧结束（EOF/Close）时 abort 读侧后，写侧把队列中残留的 Close 帧发完再自然退出（有界 2s 超时兜底），上游/客户端不再干等连接超时（此前直接 abort 写侧，Close 来不及发出）
  2. `Content-Encoding: identity`（明文标识）/空视为无编码，**仍可做响应体重写**——旧 `is_none()` 判断把它当非明文误跳过（提取 `rewrite_allowed_for_encoding` 纯函数并单测）
  3. 请求体上限（默认 2MB）**可配置化**：新增 `--proxy-max-body` / `OMNITERM_PROXY_MAX_BODY`，注入 `ProxyState.max_request_body`，大文件上传场景可调大
  4. `parse_proxy_host` 对 IPv6 字面量 Host（`[::1]:8080`）不再误剥端口（按 `]` 结尾判别），返回 None 而非错误端口（`src/proxy/mod.rs`、`src/proxy/ws.rs`、`src/main.rs`）
- (2026-08-16) `[backend]` 修复文件监控（`/files/watch` SSE）在项目含 node_modules 时内存无界增长（正式版 RSS +~5MB/s 直至 OOM，实测最高 7GB）：notify 的 `RecursiveMode::Recursive` 内部 WalkDir **不跳过任何目录**，node_modules/.git/target 的目录全被注册进 inotify（实测 OmniTerm-dev 项目 1 万+ watch），notify 8.2 在该规模 + 持续文件事件下 `notify-rx` 线程 `handle_inotify` 内层循环饿死 mio poll——100% CPU 忙循环 + 高频分配致堆膨胀。现改为**手动递归注册**（walkdir `filter_entry` 剪枝，跳过 ignore 目录及整棵子树，watch 数降到实际业务目录量级）+ 新目录经通道由消费循环补注册（`should_ignore` 从仅回调过滤提升为注册剪枝）（`src/api/files_watch.rs`、`Cargo.toml`）

## [0.2.14] - 2026-08-13

### Added

- (2026-08-13 23:26) `[frontend]` ACP 聊天气泡动作体系：复制正文、引用到输入框、编辑重发、重新生成四个动作统一由 `messageActions.ts` 注册表驱动（桌面 hover 动作条 + 移动端长按菜单两套触发共用同一份定义）；新增块级复制（text / thought / tool_call 卡片各自 hover 复制原文）与「复制为 Markdown」（单条消息含工具卡片摘要导出到剪贴板，thought 默认省略）。剪贴板写入统一走 `utils/clipboard.ts`（async API + textarea 兜底，修复裸 http 下 `useTerminal` 选中复制静默失效），引用经 chatStore `pendingInsert` 通道注入输入框（`frontend/src/components/Chat/`、`frontend/src/utils/`、`frontend/src/hooks/useLongPress.ts`）
- (2026-08-13 00:16) `[frontend]` Agent 预设新增 CodeBuddy：`codebuddy --acp` 以 ACP（ndJsonStream）模式启动 CodeBuddy Code（`frontend/src/components/Settings/presets.ts`）
- (2026-08-12 23:52) `[backend]` ACP agent 的 API key 从 `~/.omniterm/api_keys.toml` 加载并注入 agent 子进程：此前只靠 dev.sh 里 export 环境变量透传，正式版（systemd / docker / `omniterm start`）不经过 dev.sh 而缺失。现新增 `resolve_api_keys()` 统一读取，环境变量同名 key 优先、`agent.env` 显式配置优先且不覆盖，dev 与正式版行为一致（`src/main.rs`、`src/acp/client.rs`）
- (2026-08-12 01:40) `[backend]` 自管 pty 会话引擎落地（Phase 2）：`runtime_kind='pty'` 会话由后端常驻持有——WS 断开不杀进程，重连补屏 + resize 重绘 nudge；子进程退出自动注销、下次 attach 重建；wezterm-term VT 模拟器提供干净屏幕捕获与 OSC 标题（agent 屏幕检测覆盖 pty 会话）；后端重启后按最后采样 cwd 重建会话并回放 ANSI 历史（落盘 0600，5s 去抖）。创建入口的前端分流为下一步（Phase 4），当前经 API 可用（`src/engine/pty/`、`migrations/20260812_add_last_cwd.sql`）

### Changed

- (2026-08-13 23:00) `[backend]` pty 会话 VT 模拟器改用 crates.io registry 依赖 `alacritty_terminal` 0.26，恢复 crates.io 发布渠道：原 `wezterm-term` 为 git 依赖，`cargo package`/`cargo publish` 要求全部依赖可解析到 registry，发布 0.2.14 时因此中止。模拟器对外四件套（feed/屏幕捕获/标题/resize）语义不变；顺带修复双应答缺陷——前端 xterm.js 会把自己对 DA/DSR 的应答经 onData 回送后端、服务端 VT 此前也应答一次，现服务端应答按 attach 状态门控（有客户端订阅时浏览器应答、detach 期间服务端应答保持闭环），应答缓冲有界（≤64 条且 ≤8KB）（`src/engine/pty/vt.rs`、`src/engine/pty/mod.rs`、`Cargo.toml`）

### Fixed

- (2026-08-12 15:35) `[frontend]` 密码验证开启改为在设置界面就地设置，不再立即踢回登录页：根因是 `/auth/check` 在开关关闭时不返回 `needs_setup`，前端误判为「已有密码」直接翻转开关，而鉴权关闭期间无有效会话 cookie，开启后下一个受保护请求 401 即被登出跳转。现点击开启时弹窗就地处理——未设过密码走「新密码 + 确认」提交后开启并触发重新登入，已设过密码走「当前密码」验证通过后开启且保持登录不跳转；`client.ts` 对 `/auth/login`、`/auth/setup`、`/auth/change-password` 的 401（密码错误属业务错误而非会话过期）不再误触发登出（`frontend/src/components/Settings/AuthSection.tsx`、`frontend/src/api/client.ts`、`src/api/auth.rs`）
- (2026-08-12 18:30) `[frontend]` 修复文件拖拽悬浮预览不贴鼠标：预览元素此前在全局 `zoom`（`Layout.tsx` 根容器已按 `uiZoom` 缩放一次）内又重复套了 `zoom: uiZoom/100`，且 `translate` 直接使用视口物理坐标——外层 zoom 会把 translate 的 px 值再放大 z 倍（实测 z=1.25 时鼠标在 200px 处预览落到 265px），界面缩放 ≠ 100% 时悬浮文件名越拖离鼠标越远。现移除内层 zoom、translate 坐标除以 zoomFactor（与 `Layout.tsx` 的 `translateY(vvOffsetTop / zoom)` 同一补偿惯例）（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-08-12 02:30) `[backend]` ACP 聊天正文 `text` 列收口为有界：此前它是**故意留的无界兜底**（帧窗口有帧数与字节双上限，正文却不设限），而每次防抖 flush 都重写整列，一个长 turn 就是 O(n²) 写放大——实测 dev 库某行达 9,150,950 字符，所在会话只有 19 条消息。现上限 1 MiB（当前正常最大 36,834 字符，留两个数量级余量），超限后保留头部 256 KiB 与尾部滑窗，中段替换为用户可读的 `…（已省略 N 字符）…` 标记，绝不静默丢弃：头尾都留是因为纯尾窗会让正文从句子中间开始，而 `text` 同时是 blocks 解码失败时的兜底渲染源。头部一旦封口即永久冻结（UTF-8 边界会让它停在预算之下几字节，续填会把新文本插到旧文本之前）；尾窗按 1/4 预算的块摊还修剪（修剪到恰好等于预算会让此后每个 chunk 都 memmove 整个尾窗，即要避免的 O(n²)）；单个 chunk 自身超预算时先裁再入缓冲，否则内存峰值等于 chunk 大小、上限形同虚设。切割一律走 `floor_char_boundary` / `ceil_char_boundary`——切在多字节字符中间会 panic 并折断整个 ACP 连接任务。附 6 条单测（含中文/emoji 边界样本与「保留量+省略量==输入量」守恒断言）与 3 条编译期不变式（`src/acp/turn_accumulator.rs`）
- (2026-08-11 23:20) `[backend]` `[infra]` 修复正式版（npm / cargo / install.sh 各渠道）在某些终端里 `omniterm start` 必然报 `Address already in use (os error 98)`：后端以往把 `BIND_ADDR` / `BACKEND_PORT` / `DATABASE_URL` / `JWT_SECRET` 这些**通用名**环境变量作为配置来源，而开发实例（dev.sh）会 export 它们，其派生的每个终端都继承——用户在这种终端里启动正式版会被劫持去绑开发实例已占用的端口（实测 `env -u BIND_ADDR -u BACKEND_PORT` 后立刻正常启动）。**BREAKING**：后端现在只读 `OMNITERM_*` 前缀的环境变量（`OMNITERM_HOST` / `OMNITERM_PORT` / `OMNITERM_DB` / `OMNITERM_JWT_SECRET` / `OMNITERM_AUTH_ENABLED`），旧名一律忽略并在启动时 warn 提示改名；`BIND_ADDR` 兜底整条移除，监听地址只由 `-H/--host` + `-p/--port` 决定。自建 Docker/compose 部署若设过 `DATABASE_URL` / `JWT_SECRET` / `BIND_ADDR`，须改用新名（否则回落默认库路径与随机密钥，需重新登录）（`src/main.rs`、`dev.sh`、`dev.ps1`、`Dockerfile`、`Dockerfile.release`、`docker-compose.yml`）
- (2026-08-11 22:52) `[frontend]` 修复「新建项目」弹窗第二次打开起目录浏览区持续显示「空目录」：关闭/创建成功时把路径输入框重置为 `homeDir + '/'`，导致下次打开时 `projPath` 值未变化、驱动自动补全的 effect 不重新运行，`loadDirs` 不被调用，而打开时的 `reset()` 已把条目清空。现改为关闭时重置为 `''`，每次打开都会从空值变化到 `homeDir + '/'` 从而重新加载目录列表（`frontend/src/components/Sidebar/CreateProjectModal.tsx`）

## [0.2.13] - 2026-08-11

### Added

- (2026-08-10 16:12) `[frontend]` ACP 聊天里 agent 上报的文件路径可一键点开：工具调用卡片展开后的 `locations` 从纯文本变为可点击链接，点击直接在 FileManager 抽屉打开该文件（自动展开右栏、切到 FILES 标签，移动端切到 files 面板）。路径取自 ACP `ToolCallLocation`（协议权威值，非正文猜测），相对路径以 session 的 `workspace_path` 为基准归一（新增 `toAbsolutePath`）；无效路径/目录由抽屉展示后端错误而非静默失败。新增 store 原子动作 `revealFileInDrawer` 单次 `set()` 提交面板可见性与抽屉路径，链接组件用 `getState()` 读取以完全不触碰 `ChatMessageView` 的 memo 契约、流式渲染期零新增成本（`frontend/src/components/Chat/FileLocationLink.tsx`、`ChatMessage.tsx`、`frontend/src/stores/appStore.ts`、`frontend/src/utils/path.ts`）

### Fixed

- (2026-08-11 16:20) `[backend]` `[api]` `[frontend]` ACP 聊天记录体积从源头收敛：turn 正常结束时前端把 **cooked** blocks 回写数据库那一行，取代此前只在用户手动「恢复会话」时才发生的收敛。后端累积器落的是原始 ACP 帧，同一份内容与 cooked 差两个数量级（实测同库：cooked 行最大 114KB，未被覆盖的原始帧行达 9,150,950 字符——cook 把同一 `toolCallId` 的上千个 `tool_call_update` 折叠成一个，每帧重复携带的 `rawInput` 副本只剩一份），未做过恢复的行以往会永久停在原始帧态，是存量巨行的唯一来源。WS `prompt_done` 帧新增 `row_id`（三个广播点均经新的轻量访问器 `turn_row_id()` 取值，不走会克隆全量 text + 序列化 128KB 帧窗的 `turn_snapshot()`），前端据此按行 id 精确回写并**只发本 turn 一条**——全量回写会随会话增长变成 O(m²) 写放大；同时修复纯工具调用 turn（`text` 为空但 blocks 最肥）以往被 sync 的空 text 守卫整体排除在外。帧窗口上限（`MAX_BLOCKS_BYTES` / `MAX_FRAME_BYTES`）保持不变——前端不在线时无人 cook，两者是优化与兜底、不可互相替代（`src/ws/acp.rs`、`src/acp/client.rs`、`src/acp/turn_accumulator.rs`、`src/acp/reaper.rs`、`src/acp/chat_persistence.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`）
- (2026-08-11 15:55) `[backend]` `[api]` 修复聊天历史回写互相污染：`POST /sessions/{id}/messages/sync` 以往用 `UPDATE ... WHERE session_id AND role AND text` 定位行，**无行限定**——text 相同的所有历史行被同一份 `blocks` 一次覆盖（dev 库实测：同一会话 14 行 `assistant`/“OK” 但 `count(DISTINCT blocks)` 只有 1，工具卡片/思考/计划全部串位）。现改为行 id 优先匹配：payload 新增可选 `id`，带 id 时只更新 `WHERE id=? AND session_id=?` 那一行的 `blocks`（未命中则跳过，不猜也不 INSERT 重复行），无 id 的 replay 重建消息退回文本匹配但**一条 payload 只消费一行**且同一次调用内不重复命中同一行；`text` 不再被前端回写覆盖（其权威在后端累积器）。前端 `ChatMessage` 新增 `dbId` 字段区分「真 DB 行 id」与「本地 `genId()`」，只有前者会作为 `id` 上报；附 7 条后端 + 2 条前端单测（`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-08-11 14:05) `[backend]` 修复 Windows 上 `omniterm update` 与 Web 端一键升级对 npm 渠道必然失败：报 `failed to run npm / Caused by: program not found`——`std::process::Command` 在 Windows 只按 PATH 补 `.exe`、不读 `PATHEXT`，而 npm 实际是 `npm.cmd`；前置存在性检查用的 `which` 遵循 PATHEXT 所以通过，友好提示分支反而被跳过。现统一经 `resolve_program()` 将命令 `which` 解析为绝对路径后再 spawn（`.cmd` 由 std 自动用 cmd.exe 包装，含 CVE-2024-24576 参数转义）。同时升级命令由 `npm update -g <pkg>` 改为 `npm install -g <pkg>@latest`：`update` 受已安装 semver range 约束（不跨 major），且对分发平台二进制的 optionalDependencies 重解析不可靠（`src/update.rs`、`src/api/system.rs`）
- (2026-08-10 20:40) `[frontend]` 弹窗里的长路径/分支名不再冲出边框：删除 worktree 确认框展示 opencode 这类带 40 位 hash 目录的路径时，文本溢出弹窗右侧约 320px——无空格超长 token 在默认 `overflow-wrap: normal` 下不参与换行，`max-w-*` 只限住盒子宽度、拦不住内容。修在 `Modal` body 容器（`overflow-wrap: anywhere`），一处覆盖全部 8 个弹窗及所有 `ConfirmDialog` 调用点，而非逐个弹窗打补丁；同时修复复选框行的 flex 布局（文本 `min-width: 0` + 控件 `flex-shrink: 0`，避免长分支名撑破容器、复选框被压变形）（`frontend/src/components/Modal/Modal.tsx`、`frontend/src/components/Sidebar/DeleteWorktreeDialog.tsx`）
- (2026-08-10 20:05) `[backend]` `[api]` `[frontend]` 删除 worktree 时可一并删除其分支：`git worktree remove` 只删工作目录、保留分支 ref，导致已删除的 worktree 的分支仍出现在「创建 Worktree」的基准分支下拉里，且用同名分支重建 worktree 会被 git 拒绝（`fatal: 分支已经存在`）。删除确认框新增「同时删除分支」勾选项（**默认不勾**——基于无 worktree 的既有分支创建 worktree 是正常用法），勾选时 `DELETE /projects/{pid}/worktrees` 带 `?delete_branch=true`，后端在移除 worktree 前从 `git worktree list` 反查分支名（不信任前端传值），成功返回 `branch_deleted`；worktree 已删但分支删除失败（含 detached HEAD）时返回 `branch_error` 并由前端以 warning toast 提示，不伪装为完全成功（`src/git/mod.rs`、`src/api/projects.rs`、`frontend/src/components/Sidebar/DeleteWorktreeDialog.tsx`、`ProjectCard.tsx`、`frontend/src/api/client.ts`）
- (2026-08-10 18:05) `[backend]` `[api]` `[frontend]` ACP 聊天历史改为游标分页加载：`GET /sessions/{id}/messages` 新增 `?before=<cursor>&limit=<n>`，响应新增 `hasMore` / `nextCursor`，首屏只取最近一页（默认 100 条，且单页 payload 上限 2MiB——条数不约束体积，单条 `blocks` 可达 MB 级），用户滚到聊天区顶部时自动向前加载下一页并保持阅读位置不跳动。游标为复合 `(created_at, id)`——`created_at` 单键不是全序（真实数据里 4 条消息同为一秒），仅用它会在同秒边界重取或漏取。实测 11MB 历史的会话：首屏响应从 15.9MB / 843ms 降到 2.1MB / 286ms（`src/api/sessions.rs`、`src/acp/chat_persistence.rs`、`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/stores/chatStore.ts`）
- (2026-08-10 17:05) `[backend]` `[frontend]` 修复切到 ACP 会话时的卡顿（历史越多越明显，实测阻塞 ~0.5s）：`turn_accumulator` 的帧窗口以往只限帧数（`MAX_FRAMES=2000`），而单帧大小由 agent 决定——codebuddy 每个 `tool_call_update` 只带 1 字符增量却重复携带完整 `rawInput`（4.5KB/帧），使单条消息的 `blocks` 列达 8.7MB、`GET /messages` 下发 15MB。现补齐字节维度上限（`MAX_BLOCKS_BYTES=128KB` 窗口 + `MAX_FRAME_BYTES=64KB` 单帧，超限帧不入窗、`text` 全量兜底），帧改存预序列化 `RawValue` 使 flush 不再重格式化每帧（`src/acp/turn_accumulator.rs`）；前端对已 hydrate 的会话不再重复 `GET /messages`（结果本就会被 hydrate 守卫丢弃，白付一次多 MB 传输与逐条解码）（`frontend/src/components/Chat/ChatView.tsx`）。**已存在的超大历史行不受影响**，那些会话首次打开仍慢

### Refactored

- (2026-08-10 01:03) `[backend]` 会话引擎解耦 Phase 1 落地：tmux 模块整体移入 `src/engine/` 边界（冻结件），agent 检测体系提为引擎无关公共模块 `src/agent/`（state/detect/process/manifests），新增 `SessionEngine` trait + `EngineRegistry` 按 `runtime_kind` 路由（`TmuxEngine` 纯包装既有门面），终端 WS attach 分发移入各引擎侧 `terminal_ws.rs`。纯结构重组、行为零变化（187 测试全过），为后续 pty 原生会话铺路（`src/engine/`、`src/agent/`、`src/ws/terminal.rs`）

## [0.2.12] - 2026-08-09

### Added

- (2026-08-09 16:12) `[frontend]` sidebar 新增「会话展开模式」切换按钮（Projects 标题栏、新建项目按钮旁）：模式 1 自动展开所有含会话的项目及其下所有含会话的 worktree，模式 2（默认）仅展开聚焦中的 worktree；折叠优先——模式 1 下手动折叠的项目不再自动弹回；偏好经 localStorage（`omniterm_expand_all_sessions`）持久化（`frontend/src/components/Sidebar/Sidebar.tsx`、`ProjectCard.tsx`、`frontend/src/stores/appStore.ts`、`frontend/src/utils/worktreeSessions.ts`）
- (2026-08-08 23:20) `[backend]` `[frontend]` 项目路径失效检测与提示：`GET /projects` 响应新增 `path_valid` 字段，`list_projects` 实时计算项目路径是否仍存在（`src/api/projects.rs`、`src/models/project.rs`、`src/fs/mod.rs`）；Sidebar 项目行在路径失效时标红并显示 ⚠ 修复按钮，点击打开既有 `RepairPathDialog` 重新定位项目路径（改造为支持无 workspace 的纯项目修复），页面切回时自动刷新项目列表（`frontend/src/components/Sidebar/ProjectCard.tsx`、`RepairPathDialog.tsx`、`Sidebar.tsx`）

### Changed

- (2026-08-09 16:10) `[backend]` CLI 输出统一改为英文：`--help` 全部子命令/参数说明、启动/停止/状态提示、`start -d` 成功消息、自更新消息（此前 clap help 与 daemon 启动提示为中文；CLI 与前端 i18n 相互独立，后端不引入语言切换）
- (2026-08-07 16:34) `[frontend]` ThinkingIndicator 乱码特效自适应帧率节流：rAF 回调频率本身等于浏览器实际刷新率，高刷屏（>60Hz）压到上限 60fps 削减无谓 layout 抖动、低刷屏跟着屏走，零额外测量成本；随后上限提高到 90fps 以充分利用高刷屏，动画在高性能设备上更流畅（`frontend/src/components/Chat/ChatView.tsx`）

### Fixed

- (2026-08-09 00:35) `[frontend]` 修复侧栏分支名过长被省略号截断时 bidi 重排：`direction: rtl` 容器（左侧省略号截断）中 LTR 分支名末尾中性字符被挪到视觉开头，分支名显示错乱——分支名改用 `<bdi dir="ltr">` 隔离，截断方向保留为「省略开头」且文字视觉保持 LTR（`frontend/src/components/Sidebar/ProjectCard.tsx`、`frontend/src/index.css`）
- (2026-08-09 22:58) `[backend]` `[frontend]` 文件浏览器文本预览改为**内容兜底**：不再依赖扩展名白名单，非常见后缀的文本文件（如 `Cargo.lock`）也能以普通文本查看。`GET /files/read` 响应新增 `is_text` 字段——后端按内容探测文件是否为合法 UTF-8（先探测头部 64KB 判定、**NUL 字节快检短路**，避免把大型二进制文件整体读入内存，再全量严格校验），非文本返回 `is_text:false` 而非报错（`src/fs/mod.rs`、`src/api/files.rs`）；前端 `FileDrawer` 移除 `TEXT_EXTS` 白名单，非图片文件一律尝试按文本读取，读取结果非文本时降级为「无法预览」（`frontend/src/components/FileManager/FileDrawer.tsx`、`frontend/src/api/client.ts`）
- (2026-08-09 18:45) `[frontend]` 修复激活会话未同步激活所属 worktree：点击/新建/键盘切换会话时，sidebar 的 worktree 高亮底色不跟随（展开模式下可点非聚焦 worktree 的会话而该行不亮）。`activateSession` 现从会话 `workspace_path` 跨所有项目反查所属 project + worktree 并原子激活——会话可能登记在 A 项目但其路径属于 B 项目的 worktree（渲染为孤儿显示在主 worktree 下），此时激活路径实际归属的 B 项目 worktree；会话记忆归位到所属 worktree；无任何 worktree 匹配的孤儿/外部会话保持原行为（`frontend/src/stores/appStore.ts`）
- (2026-08-09 15:20) `[backend]` `start -d` 启动成功不再静默：daemon 握手扩展为携带启动结果消息，父进程打印「OmniTerm vX.Y.Z 后台已启动 — http://host:port (PID)」并返回 0；配合上一项，后台启动无论成败终端都有明确反馈（`src/main.rs`）

- (2026-08-09 14:10) `[backend]` 修复 `start -d` 后台模式启动失败静默无反馈并残留 stale PID 文件：daemonize 增加启动握手（pipe 就绪/失败通知），父进程阻塞等待 daemon 完成端口绑定后才返回，失败时把错误原文打印到终端并以非零退出——此前 daemon 的 stdout/stderr 已重定向到日志，端口被占/DB 连不上等失败对用户完全无感知且命令返回 0（`src/main.rs`）；PID 文件写入移到 bind 成功之后，启动失败不再留下 stale PID、也不会覆盖已在运行实例的 PID 文件

- (2026-08-07 18:40) `[backend]` `[frontend]` ACP 权限审批链路健壮性加固（防「banner 丢失/陈旧、会话卡死」同族问题）：(1) 前端 `pendingPermission` 单槽改为按 id 队列（上限 16，超限丢新到达项并 warn），并发多个 `request_permission` 不再互相覆盖导致被覆盖项无 UI 入口，banner 显示队首并提示 `+N queued`（`frontend/src/stores/chatStore.ts`、`ChatView.tsx`、`PermissionBanner.tsx`）；(2) 后端连接重放 pending 审批后新增 `permissions_synced` 标记帧，restore 出的新 client 同样发送，前端据此对账清掉断连窗口错过 `permission_resolved` 广播的陈旧 banner（`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`）；(3) `permission_response` resolve 失败（审批已被其他连接应答/cancel/会话已释放）不再静默吞掉，向本连接回发 `permission_resolved` 使陈旧点击收敛清除（`src/ws/acp.rs`）；(4) `respondPermission` 发送失败保留队列并报错、不再裸 `ws.send`；WS 错误/断连走 `markError` 清队列时同步清 decision 提醒（`frontend/src/hooks/useAcpChat.ts`）；附 7 条 store 单测

- (2026-08-07 18:01) `[frontend]` 修复 ACP 会话「需要决策」banner 长时间等待后消失、会话卡死无法恢复：后端 PermissionManager 每次连接重放未决审批，但重连/二次发送后 `markDone`（turn 收尾）会误清 `pendingPermission`——尤其 hydrate 门控缓冲把 `turn_state{active:false}` 延后到 `permission_request` 之后回放，banner 刚出现即被抹掉，用户再无入口批准/拒绝。`markDone` 不再清 `pendingPermission`，未决审批的合法清除路径收敛为后端 `permission_resolved` 广播（resolve/cancel_all，含 reaper 超时）与 `markError`（turn 出错/连接死亡）；附 2 条回归测试（`frontend/src/stores/chatStore.ts`、`chatStore.test.ts`）

## [0.2.11] - 2026-08-06

### Fixed

- (2026-08-06 23:45) `[frontend]` ACP 会话输入框等 textarea 滚动条统一走 `overlay-scroll-content` 主题化样式：ChatInput/ChatMessage/GitPanel 的滚动条与全局主题一致，不再出现浏览器默认滚动条样式（`frontend/src/components/Chat/ChatInput.tsx`、`ChatMessage.tsx`、`GitPanel.tsx`）
- (2026-08-06 23:31) `[frontend]` 修复外部改名（SSE rename 事件）后 drawer 预览同样显示「加载失败」：tmux/IDE 里 `mv` 触发的 rename 事件被 basename 匹配命中后仍用旧 filePath 重新加载而 404（图片 bump version 重载旧路径同样失败）。新增 `resolveRenamedPath`（`frontend/src/utils/path.ts`）：drawer 绝对路径以「/ + 相对旧路径」结尾时还原 watch 根并拼出新绝对路径，同目录改名与跨目录 move 均覆盖、同名不同目录不误切；FileDrawer 收到 rename 事件经 `onPathChange` 回调切换 drawerPath（`frontend/src/components/FileManager/FileDrawer.tsx`、`FilePreview.tsx`、`FileManager.tsx`）
- (2026-08-06 23:06) `[frontend]` 修复图片预览在文件改名后显示「加载失败」：drawer 打开图片时 `filePath` 冻结为打开时的绝对路径，文件在 FileManager 中改名后磁盘旧路径消失，后端 download 返回 404 → `<img>` onError → 显示「图片加载失败」；SSE 自动刷新按 basename 匹配，新旧名不匹配也无法挽救。`runRename` 成功后若 drawer 正打开被改名的文件（session 模式 `drawerFilePath` / workspace 模式 `workspaceDrawerPath`）则同步 drawerPath 到新绝对路径（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-08-06 18:04) `[backend]` 修复已释放会话发送 prompt 报原始库错误 `connection is no longer running`：自动恢复路径 `let _ = handle.await` 只等 replay 任务结束不取 load 结果，session/load 失败后 prompt 仍发进未加载/已死连接；死 client 滞留 supervisor 使重试无法触发新恢复。改为 replay 任务返回 load 结果，仅 load 成功才 dispatch；load 失败时 dispose+shutdown 死 client（Arc::ptr_eq 守卫）；dispatch 失败且连接已主动释放（reaper 回收/手动 release）时不再透传库原始错误，改发可操作提示「会话进程已释放，请重新发送以自动恢复连接」（`src/ws/acp.rs`）
- (2026-08-06 16:35) `[backend]` `[frontend]` 修复在工作区内编辑文件仍误弹「文件不在当前工作区内」二次确认：根因是 `is_outside_workspace` 用 tmux 静态 cwd + session 创建时记录的 `workspace_path` 静态边界判断，而用户实际浏览/编辑的目录常与二者都不一致（adopt 外部 tmux 会话时 pane_cwd 偶发不在项目根、跨 worktree 浏览、tmux 临时 cd 出去又回到项目内等）。修复点：(1) `listFiles2` 的 `is_outside_workspace` 与 `workspace_root` 改基于用户实际浏览目录（`list_base.canonicalize()`），并在原始判断为越界时**回退探测**——先查 session 所属 project 的 worktrees，再退化为 `git rev-parse --show-toplevel`，命中则视为在工作区内（`src/api/files.rs`）；(2) `fs::sanitize_path[_new]_inner` 同步加入 git_toplevel 兜底，让 mkdir/rename/move/copy/delete 在跨 worktree / workspace_path 失配场景下不再 403，与 listFiles2 兜底语义一致（`src/fs/mod.rs`）；(3) 前端 `FileDrawer.isOutside` 在 `workspaceRoot` 为空（DB 暂未返回 / 会话无 workspace_path / 瞬时网络错误）时不再视为越界，与后端 `is_outside_workspace` 在 `ws_root` 为空时返回 `false` 的语义对齐，避免后端不拦前端却误弹（`frontend/src/components/FileManager/FileDrawer.tsx`）；(4) 切换 `fmSource` 类型（workspace ↔ session）时清空遗留的 `workspaceDrawerPath`，避免 workspaceRoot 切换为新源后与旧 filePath 失配而误弹（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-08-06 16:04) `[frontend]` 修复 ACP 会话旧通知残留：用户已在会话中继续发送新 prompt（即时发送或排队续发）时清除该会话的 done/error/decision 提醒——发送成功即视为用户已知晓最新状况，不再反复提示（`frontend/src/hooks/useAcpChat.ts`）

## [0.2.10] - 2026-08-05

### Added

- (2026-08-05 17:12) `[backend]` `[api]` 新增 Pty 原生运行时（runtime_kind=pty）：会话可直接由后端通过 portable_pty spawn 子进程 + PTY master fd 读写，不依赖 tmux；新增 PTY websocket 链路与 runtime-aware 会话 API（创建/清理/cwd 查询按 runtime_kind 分流，`src/engine/pty/mod.rs`、`src/tmux/pty.rs`、`src/ws/terminal.rs`、`src/api/sessions.rs`、`src/models/session.rs`）
- (2026-08-05 16:48) `[backend]` `[infra]` 新增 `PtySession`（portable_pty 封装：openpty/spawn/resize/write/Drop 兜底清理）与 ACP replay 诊断日志：replay 任务关键节点（load_session/restore_config_prefs/replay_end/notify task 移交）与 notify 转发异常均补 debug/warn 日志，便于定位 ACP 恢复链路问题（`src/tmux/pty.rs`、`src/ws/acp.rs`）
- (2026-08-05 15:49) `[backend]` `[api]` 文件写类 API 支持显式 `allow_escape=true` 越界放行：delete/write/mkdir/upload/rename/move/copy 在 query 传 `allow_escape=true` 时允许目标路径逃逸出 workspace 根目录（受信调用方显式请求），未传时保持严格越界校验不变；`GET /files` 响应新增 `workspace_root` 字段（session/workspace_id 模式，值为 workspace 根路径，供前端判断越界）；`GET /files/download` 对相对路径越界不再返回 403，直接以 base 拼接原始路径放行下载（`src/api/files.rs`、`src/fs/mod.rs`）
- (2026-08-05 15:49) `[frontend]` 文件管理「跳过越界确认」：FileManager 越界操作透传 `allow_escape=true`，确认框提供跳过选项直接放行（`frontend/src/api/client.ts`、`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-08-05 05:43) `[backend]` 新增 `omniterm start --debug` 强制开启调试日志：无需设置 `RUST_LOG` 即可查看 omniterm 内部 debug 日志，优先级高于 `RUST_LOG` 中 omniterm 的级别设置（其余 target 的 directive 保留）；未传 `--debug` 时日志级别由 `RUST_LOG` 控制、未设置默认 `omniterm=info`（不再硬编码 debug，正式版不再刷屏）（`src/main.rs`）

### Fixed

- (2026-08-05 15:17) `[backend]` 修复 ACP「发送即自动恢复」在进程刚被释放后无效：`is_incoming_closed()` 在主动 shutdown 后恒返回 false，`is_alive()` 又把已关闭连接误判为存活，导致自动恢复的 restore 分支永不触发——改为显式维护 shutdown 标记，恢复流程与手动「恢复会话」一致（`src/acp/client.rs`）
- (2026-08-05 15:49) `[backend]` 修复 `sanitize_path_new` 多层缺失目录拼接反序：`tail` 循环漏 `.rev()` 导致 `a/b/c` 解析成 `a/c/b`（当 `a` 存在而 `b/c` 不存在时，mkdir/嵌套写入/越界 move 到多层新目录会生成错误目录结构）（`src/fs/mod.rs`）
- (2026-08-05 05:37) `[backend]` 修复正式版默认输出 DEBUG 日志：日志过滤器硬编码 `omniterm=debug` 会覆盖 `RUST_LOG` 中 omniterm 的级别设置（tracing EnvFilter 同 target 后添加 directive 替换先添加），npm 正式版（无 RUST_LOG）启动即刷 debug 日志——改为尊重 `RUST_LOG`、未设置时默认 `omniterm=info`，需要调试日志时用 `omniterm start --debug` 或 `RUST_LOG=omniterm=debug`（`src/main.rs`）

## [0.2.9] - 2026-08-05

### Added

- (2026-08-05 00:30) `[backend]` `[frontend]` `[api]` 设置面板新增「自动断连/释放超时」调节：设置 → 会话新增三个分钟滑块（值域 1..60，≥30 分钟显示内存占用警告）——ACP 空闲回收（默认 5 分钟，`GET/PUT /api/v1/settings/acp-idle-recycle` 持久化到 settings 表，reaper 每个 tick 动态读取实现运行时热更新）、tmux 失焦断连（默认 10 分钟，localStorage `omniterm_blur_disconnect_min`）、tmux 空闲断连（默认 15 分钟，`omniterm_idle_disconnect_min`）；`useTerminal` 断连定时器改从 store 读分钟值 ×60_000，删除硬编码 `BLUR/IDLE_DISCONNECT_DELAY_MS` 常量（`src/api/settings.rs`、`src/main.rs`、`src/acp/reaper.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useTerminal.ts`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/api/client.ts`）
- (2026-08-04 12:40) `[backend]` ACP 会话「发送即自动恢复」：进程被 reaper 空闲回收/手动 release/后端重启释放后，用户无需先点「恢复会话」，直接发送消息即自动 spawn agent 进程 + 历史重放，重放完成后才发送 prompt（避免与 replay 帧交错）；`AcpClient::is_alive()` 检测连接活性，手动「恢复会话」与自动恢复共用同一恢复流程（`restore_acp_session`）；连接时对「已释放但可恢复」（DB 行存在）与「会话已删除」分流，仅删除才发 `session_not_found`；`acp_process_alive` 恒序列化使「已释放」指示稳定不再被轮询覆盖闪断（`src/ws/acp.rs`、`src/acp/client.rs`、`src/models/session.rs`）

### Fixed

- (2026-08-04 23:22) `[infra]` 强制 migration 文件 LF 换行：`.gitattributes` 声明 `migrations/*.sql text eol=lf` 并 renormalize 存量文件——sqlx::migrate! 编译期内嵌 .sql 原始字节算 Sha384 checksum，Windows CI 的 git autocrlf 会把 .sql 转 CRLF，导致 npm Windows 平台包内嵌 checksum 与 crates.io 包（LF）不一致，已初始化库启动即报 `migration was previously applied but has been modified`

## [0.2.8] - 2026-08-04

### Added

- (2026-08-04 17:00) `[backend]` ACP 会话底部配置（mode/model/thinking/config 选择器）持久化记忆：两层模型——`agent_config_preferences`（按 agent 记住用户全局偏好，新建会话自动应用）+ `session_config_options`（会话级覆盖，restore 该会话时优先恢复）；用户改配置成功即落库，进程 release/reaper 回收/后端重启/新会话后自动逐项恢复，前端零改动（`migrations/20260804_acp_config_preferences.sql`、`src/acp/config_prefs.rs`、`src/acp/client.rs`、`src/api/sessions.rs`、`src/ws/acp.rs`）
- (2026-08-03 18:40) `[backend]` `[frontend]` 非 git 仓库项目创建 worktree 时先弹确认框询问是否初始化 git：用户确认后后端自动 `git init` + 初始提交（缺失 user.name/email 时用仓库级兜底身份，不污染全局配置）再创建 worktree；新增 `POST /projects/{id}/git-init` 端点与 `create_worktree` 的 `init` 标志，错误响应统一带 `code: "not_a_git_repo"` 供前端识别（`src/git/mod.rs`、`src/api/projects.rs`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-08-03 18:50) `[backend]` `[frontend]` 初始化 git 确认框新增 .gitignore 警告：`not_a_git_repo` 错误响应附带 `has_gitignore` 字段，无 .gitignore 时确认框额外提示「初始化将把当前目录下所有现有文件（含大文件/敏感文件）纳入首次提交」（`src/git/mod.rs`、`src/api/projects.rs`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Modal/ConfirmDialog.tsx`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-08-04 18:00) `[frontend]` 修复移动端点击「滚动」按钮退出滚动模式时向终端注入字符：tmux `copy-mode -e` 在滑屏滚回历史底部时会自动退出，前端乐观标记的滚动状态无法感知，此时发送 `q` 会被当作输入注入 shell——退出键改为 Escape（tmux copy-mode 中同样触发 cancel，而 shell 命令行中无可见字符）；同时滑屏滚动仅在「看历史」方向（合成 wheel up）置位滚动模式，回到底部方向不再误标高亮（`frontend/src/hooks/useTerminal.ts`、`frontend/src/utils/touchScroll.ts`）
- (2026-08-04 18:30) `[frontend]` 修复移动端 tmux 终端右侧竖向黑条 + 行尾换行字符截断（分辨率自适应方案）：① xterm FitAddon 计算列数时固定预留 14px 桌面滚动条宽度且未扣除容器 padding，触摸设备滚动条为 overlay（不占空间），内容网格距容器右缘 ~11px 露出纯黑 `.xterm-viewport` 背景——移动端覆盖 fit 尺寸计算改为按容器实际内容盒（`clientWidth − padding`）取整列数，并预留 `0.13 × cellWidth` 比例安全余量（随字体缩放，覆盖「视口宽恰为 cellWidth 整数倍时末列余量 ≈ 0」导致的字形溢出裁剪）；② `.xterm-screen` 与 `.xterm-rows` 行均填满容器并取消行 `overflow: hidden`，列仍自左按 cellWidth 排布，末列在任何视口宽/DPR/字体下都保留 ≥ 安全余量的确定性缓冲，无黑条（缓冲区为终端底色，状态栏高亮段自然延伸至字符区右缘）；③ 隐藏 xterm 原生滚动条避免触摸时 thumb 闪现遮挡末列（`frontend/src/hooks/useTerminal.ts`、`frontend/src/index.css`）
- (2026-08-04 17:30) `[frontend]` 修复移动端滑屏滚动后 MobileKeyBar「滚动」按钮不同步高亮：触摸滚动走合成 wheel 让 tmux 进入 copy-mode，但 `scrollMode` 状态未联动，导致按钮视觉与真实滚动状态漂移——`attachTouchScroll` 新增 `onScrollStart` 回调，每次手势首次实际滚动时同步置位滚动模式，高亮/方向键/输入法行为与 tmux 状态一致（`frontend/src/utils/touchScroll.ts`、`frontend/src/hooks/useTerminal.ts`）
- (2026-08-04 16:40) `[backend]` `[frontend]` 修复长 ACP 任务 CPU 脉冲/内存暴涨/DB 膨胀：turn_accumulator 把每条 agent notification 无界累积进原始帧数组，每次防抖 flush 全量重序列化覆盖写库，长任务（高频 thought/tool chunk，实测单条 blocks 可达 100MB、进程 RES 4.5GB、tokio worker 99%）——改为 `VecDeque` 有界窗口（保留最近 2000 帧，`text` 仍全量累积），前端 `rawFramesToBlocks` 同步限制解码帧数防御存量超大 blocks（`src/acp/turn_accumulator.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-08-04 15:45) `[frontend]` ACP 会话流式输出 CPU 优化：streaming 期间 markdown 降级为纯文本渲染（避免每 rAF 帧对增长中文本全量解析 + 代码块语法高亮，turn 结束再一次性渲染），历史消息气泡 `memo` 跳过流式期间的重渲染（`frontend/src/components/Chat/Markdown.tsx`、`frontend/src/components/Chat/ChatMessage.tsx`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-08-04 13:20) `[backend]` 修复 ACP 会话空闲自动回收（reaper）后 Sidebar 状态与真实进程脱节：reaper 回收、手动释放（release）与删除会话时改用 `AcpClient::shutdown()` 强制 kill 子进程——此前依赖 `Arc::try_unwrap` 在引用归零后自然 drop，但聚焦会话的 WS 连接持有 `Arc<AcpClient>` 时引用永不归零，进程残留且可继续对话，而 supervisor 已移除导致 `acp_process_alive=false`，Sidebar 永久显示「已释放」、进程脱离 reaper 管辖后无限驻留（`src/acp/reaper.rs`、`src/api/sessions.rs`、`src/ws/acp.rs`）
- (2026-08-04 12:30) `[backend]` 移除项目（`DELETE /projects/{id}`）时级联清理其下全部会话的运行时资源：tmux/psmux 会话执行 `kill-session` 杀进程、acp 会话 dispose agent 子进程——此前只删 DB 导致会话进程残留（Windows 上 psmux 会话不随项目删除而清理）。清理逻辑提取为 `api::sessions::cleanup_session_runtime` 与 `delete_session` 共用（`src/api/projects.rs`、`src/api/sessions.rs`）

### Refactored

- (2026-08-03 23:40) `[frontend]` `Sidebar.tsx`（2,618 行）拆分为 14 个自带状态的子组件/模块（含 useDirBrowser、useAgentAttentionPolling 两个 hook），主文件降至 ≤800 行；目录浏览重复逻辑收敛为 useDirBrowser hook，行为零变化（`frontend/src/components/Sidebar/`、`frontend/src/hooks/useDirBrowser.ts`）

## [0.2.7] - 2026-08-03

### Added

- (2026-08-03 02:55) `[backend]` `BIND_ADDR` 监听地址优先级修复：用户显式传 `-p`/`-H` 时不再被 `BIND_ADDR` env 覆盖（此前 `BIND_ADDR` 优先级高于 CLI 参数，残留的 dev 环境变量会劫持 npm 正式版端口导致 Address already in use）；未显式传参时 `BIND_ADDR` 仍作为 dev.sh / docker 的部署层兜底生效（`src/main.rs`）
- (2026-08-03 02:20) `[backend]` daemon 模式日志增强：`omniterm start --daemonize` 后台运行时 stdout/stderr 从 /dev/null 改为追加写入 `~/.omniterm/<binary>.log`（0600，与 jwt_secret 一致；日志文件在 double-fork 前打开，打开失败在前台报错退出，不再静默丢日志）；`omniterm --help` 的 start 子命令与 `-d/--daemonize` 参数描述补充后台运行与日志路径说明（`src/main.rs`）
- (2026-08-03 01:40) `[infra]` npm 安装完成引导提示：主包新增 `postinstall` 脚本，`npm install -g @gdwhisper/omniterm` 完成时提示「打开新终端运行 `omniterm start`」（安装后 PATH 缓存未刷新，需换新终端才能运行命令）（`npm-package/{package.json,postinstall.js}`、`scripts/npm-prepare.sh`）

## [0.2.6] - 2026-08-02

### Added

- (2026-08-02 15:00) `[backend]` `[frontend]` ACP agent 命令解析：PATH 优先 → `~/.omniterm/agents/` 私有目录回退 → 首次使用自动 `npm install`（lazy install）。npx 启动的第三方适配器（Claude/Codex/Pi 预设）改为直接 binary + `npm_package` 字段，消除每次启动 ~1-2s 的 npx resolve 延迟；无 npm 环境时返回明确提示（`src/acp/resolve.rs`、`migrations/20260802_add_npm_package_to_agents.sql`、`frontend/src/components/Settings/presets.ts`）
- (2026-08-02 16:00) `[frontend]` Agent 表单显露 npm 包名字段（高级选项）：预设 agent 的 `npm_package` 可在编辑表单中查看/修改，placeholder 提示原生 ACP agent 无需填写；`installHint` 文案更新为对应 binary 名（`frontend/src/components/Settings/AgentForm.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-08-01 01:40) `[docs]` README 安装方式区块默认展开（`<details open>`）：npm / Shell 脚本 / PowerShell / Docker 等除 cargo 外的安装方式不再折叠，中英同步（`README.md`、`README_ZH.md`）
- (2026-08-01 02:00) `[backend]` 内置 ACP 预设新增 Pi（`pi --acp`）：接入 Pi 的 ACP 服务（`src/presets.rs`、`frontend/src/components/Settings/presets.ts`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-08-02 01:00) `[backend]` 修复 ACP 会话 agent 已输出结论但前端永久卡在运行中（结束信号丢失）：① WS 连接建立时 `turn_end_subscribe()` 在 `turn_snapshot()` 之后调用，turn 若在快照与订阅之间结束，`turn_state{active:true}` 已发出但 `prompt_done` 事件无订阅者而丢失——将 turn_end 订阅移至快照之前（与 session_update 的 subscribe-before-snapshot 模式一致），消除丢帧窗口；② reaper 新增 prompt 卡死兜底（`PROMPT_STALE_SECS`=600s）：有进行中 prompt 但 10 分钟无 agent 通知时强制定稿 turn 并广播结束，兜底不发送 `PromptResponse` 的 agent 实现（§8 多实现兼容）（`src/ws/acp.rs`、`src/acp/client.rs`、`src/acp/reaper.rs`）
- (2026-08-02 14:00) `[backend]` 修复 resolve 对用户自定义 command 误触发 npm 查找：仅 `npm_package` 非空的预设 agent 走 PATH + lazy install 解析，用户手填 command 直接透传不干预（`src/acp/resolve.rs`）

## [0.2.5] - 2026-08-01

### Added

- (2026-08-01 01:20) `[frontend]` `[api]` GIT 面板 diff 抽屉新增「在编辑器中打开」：diff 标题栏铅笔按钮一键把当前文件切到文件编辑器（复用 FileDrawer 的查看/编辑/保存能力），路径由 `/git/diff` 新增的 `root` 字段（仓库根，后端 ADR-2 已解析）拼接相对路径得出（`frontend/src/components/GitPanel/{GitDrawer,GitPanel}.tsx`、`frontend/src/api/client.ts`、`src/api/git.rs`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-08-01 00:15) `[frontend]` ACP 聊天气泡标识行（USER/agent 名）视觉增强：颜色由 `--text-faint` 提升至 `--text-secondary` 并加粗（600）——纯文字方案（无底色/边框，避免与气泡堆叠），与气泡区隔更明显；hover 时间小字保持次级（faint）层级（`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-08-01 00:15) `[frontend]` ACP 聊天气泡 hover 显示消息系统时间：鼠标悬停消息时在标识行（USER/agent 名）旁显示小字本地时间（非浏览器原生 tooltip）——当天仅 `HH:mm`，今年内跨天 `MM-DD HH:mm`，跨年 `YYYY-MM-DD HH:mm`；时间戳沿用既有 `createdAt` 全链路（内存 `Date.now()` + DB `created_at` 持久化），零存储改动（`frontend/src/components/Chat/ChatMessage.tsx`、`frontend/src/utils/formatTime.ts`）

- (2026-07-31 22:54) `[backend]` 内置 ACP 预设新增 oh-my-pi（omp acp）：接入 omp 的 ACP 服务（`src/presets.rs`、`frontend/src/components/Settings/presets.ts`、`frontend/src/locales/{en,zh}/translation.json`）

- (2026-07-31 20:26) `[backend]` 内置 ACP 预设新增 qoder / qoder cn（--acp 模式，国际版 command 用 qodercli）：可直接在设置 → 预设选择（`src/presets.rs`、`frontend/src/components/Settings/presets.ts`、`frontend/src/locales/{en,zh}/translation.json`）

### Changed

- (2026-08-01 01:25) `[frontend]` 文件抽屉默认高度改为视口 50%：FileDrawer（文件管理器与 GIT 面板「在编辑器中打开」两个入口）无历史记录时初始高度由固定 256px 改为视口高度一半（约文件管理器高度的 50%），拖拽后仍按记录值恢复；git diff 抽屉共用同一高度状态，默认同步提升（`frontend/src/utils/drawer.ts`、`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/components/GitPanel/GitPanel.tsx`）
- (2026-08-01 01:20) `[frontend]` 底部抽屉骨架抽取：FileDrawer/GitDrawer 共用的外层容器、木纹标题栏、高度拖拽条（含拖拽状态机）提取为 `DrawerShell` + `useDrawerResize`，消除两处复制逻辑；拖拽把手圆角统一为 0（符合 ui-style-guide 全局硬角约定）（`frontend/src/components/Common/DrawerShell.tsx`、`frontend/src/hooks/useDrawerResize.ts`、`frontend/src/components/FileManager/FileDrawer.tsx`、`frontend/src/components/GitPanel/GitDrawer.tsx`）

- (2026-07-31 23:14) `[backend]` Claude 预设改用社区 ACP 适配器 `@agentclientprotocol/claude-agent-acp`，不再依赖测试性适配器（`src/presets.rs`、`frontend/src/components/Settings/presets.ts`）

- (2026-07-31 23:02) `[backend]` Codex 预设改用社区 ACP 适配器 `@agentclientprotocol/codex-acp`，不再依赖测试性适配器（`src/presets.rs`、`frontend/src/components/Settings/presets.ts`）

- (2026-07-31 20:36) `[docs]` README 默认改回英文（`README.md`），中文版移至 `README_ZH.md` 并中英同步润色（前置条件恢复为需要 tmux）

### Fixed

- (2026-08-01 00:57) `[frontend]` 修复切换 tmux 会话时终端闪烁（~250ms 黑屏/重绘抖动）：`SessionView` 的 remount key 由 `activeSessionId` 改为**视图类型**（`tmux/acp/external/empty`），tmux↔tmux 切换不再销毁重建 xterm 实例（`useTerminal` 原地重连），仅视图类型变化才重挂载；`term.reset()` 从 WS `onopen` 移到**首个二进制帧**到达时执行——旧会话内容保持可见直到新会话全屏重绘抵达，一次交换完成而非先清空后等待（每次连接后端都 spawn 新 tmux client，attach 必发全屏重绘，reset 时机可安全后移）；原地切会话时同步重置 tmux copy-mode 滚动状态（`frontend/src/components/Layout/Layout.tsx`、`frontend/src/hooks/useTerminal.ts`）
- (2026-08-01 01:10) `[backend]` 修复 ACP 会话取消后 agent 补发的尾部帧不落库（刷新后取消前最后一段输出缺失）：cancel 分支原先立即 `mark_prompt_idle` 关闭 turn，agent 响应 cancel 期间补发的收尾帧因 turn 已关闭全部丢弃；改为 cancel 不立即收尾，合作的 agent 让 `send_prompt` 以 `Cancelled` 返回走正常定稿（尾部帧照常落库），另起超时兜底定时器（15s，prompt 世代计数守卫防误杀新 turn）应对无视 cancel 的 agent 实现，超时强制定稿 + 广播结束，会话不会卡在运行中（`src/acp/client.rs`、`src/ws/acp.rs`）
- (2026-07-31 23:35) `[frontend]` 根治移动端 ACP 会话底部不可见（输入区/底部导航被裁，长消息会话必现）：MobileLayout 的 strip 容器（`flex-1`）缺 `minHeight: 0`——flex 子项默认 `min-height: auto` 使其无法收缩到内容最小高度以下，ACP 长消息列表的 min-content 高度达数千 px，strip 连同 MobileNav 被顶出 844px 根容器并被 `overflow: clip` 静默裁掉；tmux 会话正常是因为 xterm 内容有限高（min-content 小）。补 `minHeight: 0` 后 strip 正确收缩到剩余空间，输入区/导航恢复可见（`frontend/src/components/Layout/Layout.tsx`）
- (2026-07-31 23:25) `[frontend]` 修复切换到 ACP 会话时底部（输入区/配置栏/看板）被裁切看不见：① ChatView 内容容器此前复用 `.terminal-panel-pixel`（Terminal/xterm 专用类，`overflow: clip` + `touch-action: none`）——空间不足时（矮窗口/软键盘弹出/看板展开）输入区被静默裁切、聊天列表触摸滚动被禁用；改为内联复刻像素面板外观，底部功能区 `flexShrink: 0` 保证输入区永远可见，TodoBoard 单独承担压缩（`flexShrink: 1` + `overflow: hidden`，可点 header 折叠看全）；② `useKeyboardHeight` 对 `vv.offsetTop` 越界钳制（`offsetTop + vv.height ≤ innerHeight` 数学不变量）：部分浏览器在键盘收起/会话切换时序下残留陈旧 offsetTop，布局整体下移把底部推出视口（「被拉长」感），钳制后自动回弹（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/hooks/useMediaQuery.ts`）
- (2026-08-01 00:45) `[backend]` `[api]` 删除遗留 REST 端点 `POST /sessions/{id}/prompt`：Phase 3 早期的验证通道，未接入 turn 生命周期（不 `mark_prompt_active/idle`）——经它发 prompt 时 agent 回复不落库、不广播结束信号，开着聊天页的前端会永远显示运行中；前端从未使用该端点（聊天走 WS `prompt`），属死路径，按审计结论移除（`src/api/sessions.rs`、`docs/architecture/backend.md`）
- (2026-08-01 00:20) `[backend]` `[frontend]` 修复 ACP 权限审批在别处应答后其余连接 banner 不消失：审批请求经 broadcast 发给所有连接，但 resolve/cancel 结果无任何通知，其他标签页/设备的 banner 与提醒永久残留（再点报 not found）；`PermissionManager` 新增 resolved broadcast 通道，`resolve`/`cancel_all` 应答后广播审批 id，WS 层下发 `permission_resolved{id}` 帧，前端匹配当前挂起审批 id 后清除 banner 与 attention 提醒（`src/acp/permission.rs`、`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-31 23:55) `[frontend]` 修复 ACP 会话恢复重放期间 WS 断线后聊天界面永久冻结：`replay_end` 只发给发起 restore 的连接，断线后不可能到达，而重连不重置重放状态 → 所有后续 live 帧被无限期攒进 staging 缓冲永不提交；提取 `abortReplay` 在 `ws.onclose` 时终止重放（丢弃已攒帧、保留现有消息），与后端 error 帧路径共用（`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-31 23:30) `[backend]` `[api]` 修复 ACP 会话 agent 输出结束后前端仍显示运行中、收不到结束信号：`prompt_done`/`prompt_error` 原先只发给发起 prompt 的那条 WS 连接（per-connection mpsc），WS 断线自动重连后结束帧发进死连接被静默丢弃，新连接永远收不到；改为经 `AcpClient` 新增的 turn 结束 broadcast 通道发给所有连接（与 `session_update`/`crash` 同模式），重连后无需刷新页面即可正常收到结束信号（`src/acp/client.rs`、`src/ws/acp.rs`）
- (2026-07-31 22:45) `[frontend]` 处理 thinking 块滚动锚定修复的遗留：① 工具调用块内容预览补同款流式滚动锚定（工具输出大量更新时保持钉底、上翻解除、滚回恢复，仅 streaming 消息生效）；② thinking/工具块的内部滚动容器统一迁移 OverlayScroll（主题化 6px 滚动条、hover 显现，消除手写 `overflow-y:auto`），锚定逻辑提取为共享 hook `useStickScroll`（`frontend/src/components/Chat/ChatMessage.tsx`、`frontend/src/hooks/useStickScroll.ts`）
- (2026-07-31 22:30) `[frontend]` 修复 ACP 会话 thinking 块大量流式更新时滚动条不锚定底部：thinking 文本超过 300px 后内部滚动容器（`maxHeight:300` + `overflowY:auto`）没有任何跟随逻辑，`scrollTop` 恒为 0，最新思考内容始终在折叠线以下；新增与 ChatView 外层同语义的 stick-to-bottom——流式块默认钉住底部、用户上翻阅读时解除跟随、滚回底部自动恢复，重新展开流式块时直接定位最新内容（历史块不受影响，展开仍从顶部开始读）（`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-31 22:35) `[frontend]` 根治移动端键盘弹出/滑动后整页底部裁切与 tmux 模式下虚拟键栏不可见：软键盘默认只缩小 visual viewport（`resizes-visual`），xterm 把隐藏 textarea 钉在光标行（tmux 下为终端最底行），IME 弹出时该点在键盘背后、布局链路已全部不可滚动，浏览器只能平移 visual viewport（`vv.offsetTop` ≈ 键盘高度，非 window 滚动，此前的 `scrollTo(0,0)` 兜底为 no-op）；布局仅消费 `vv.height`、锚在布局视口 y=0，pan 后整体上移、KeyBar/Nav 离开可见区。`useKeyboardHeight` 新增 `vvOffsetTop` 跟踪，移动端根容器 `translateY` 补偿贴合可见区；`.terminal-panel-pixel` 补 `overflow: clip` 防容器缩高后 FitAddon 重排前 xterm 画布溢出盖住键栏（`frontend/src/hooks/useMediaQuery.ts`、`frontend/src/components/Layout/Layout.tsx`、`frontend/src/index.css`）

- (2026-08-01 00:39) `[frontend]` 已释放会话气泡 agent 名回退：capabilities 帧仅在连接后可达，释放后 agent 名缺失时用会话关联的 `agents.display_name` 兜底（`frontend/src/components/Chat/{ChatMessage,ChatView}.tsx`）

### Removed

- (2026-07-31 23:41) `[frontend]` 清理确定的死代码：删除 GitBranchIcon 组件、pixelAnimations 4 个未调用函数、3 个未使用依赖（`frontend/src/components/Icons/GitBranchIcon.tsx`、`frontend/src/utils/pixelAnimations.ts`、`frontend/package.json`）


## [0.2.4] - 2026-07-31

### Added

- (2026-07-31 16:40) `[backend]` 新增「密码验证」总开关（`settings.auth_enabled`）：**全新安装默认关闭**（免密码直接使用），用户在设置 → 认证自行开启（首次开启需设置密码）；升级保护——已有密码用户的部署迁移后自动保持开启，绝不静默降级；`OMNITERM_AUTH_ENABLED` 环境变量可强制覆盖并写回 DB；鉴权关闭 + 非回环监听时启动输出醒目警告（`src/main.rs`、`src/api/auth.rs`、`src/auth/mod.rs`、`migrations/20260801_add_settings_table.sql`）
- (2026-07-31 16:40) `[frontend]` 设置 → 认证新增「密码验证」开关：关闭需确认弹窗（红字警告），开启时未设过密码则弹窗引导设置新密码（`frontend/src/components/Settings/{AuthSection,toggleRow}.tsx`、`frontend/src/stores/appStore.ts`、`frontend/src/App.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-31 16:40) `[infra]` docker-compose 默认 `OMNITERM_AUTH_ENABLED=1`（容器 `BIND_ADDR=0.0.0.0` 全网暴露，无鉴权等于裸奔；仅本机可信环境可经 `.env.local` 关闭）（`docker-compose.yml`）

- (2026-07-31 15:55) `[backend]` `[api]` `[frontend]` ACP 会话流式消息后端权威持久化：assistant turn 不再只活在浏览器内存靠页面保活，改由 `AcpClient` 的 `on_receive_notification` 回调（不依赖 WS 存活）实时把进行中 turn 的原始 `session_update` 帧折叠进一条 `chat_messages` 行（`status='streaming'`，防抖落库，turn 结束定稿为 `complete`）。原始帧包裹 `{"v":1,"frames":[...]}` 由前端复用现有分类器还原成结构化 blocks（思考/工具/计划卡片），杜绝 TS/Rust 双份分类逻辑。用户在 agent 流式输出期间刷新页面/切换设备，进行中 turn 的完整结构现可从 DB 恢复。配套 per-client 单调 `seq` + 连接时 `turn_snapshot`/`turn_state` 帧（subscribe-before-snapshot），重连时无缝无重复续接进行中 turn（`src/acp/turn_accumulator.rs`、`src/acp/{client,handler}.rs`、`src/ws/acp.rs`、`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`src/main.rs`、`migrations/20260730_chat_message_status.sql`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-31 15:55) `[frontend]` ACP 会话 WebSocket 断线自动重连：网络抖动/服务重启导致 WS 断开时按指数退避（1→2→4→8→cap 30s）自动重连，onopen 成功归零，无需手动刷新；重连不重发 `load_session`（保持手动 restore 语义），进行中 turn 由后端 `turn_snapshot`/`turn_state` 续接（`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-31 12:30) `[frontend]` 设置新增「会话」分类，含「展开思考」「展开工具调用」两个开关（默认关）：开启后聊天消息中的思考块/工具调用块到达时自动展开，偏好持久化到 localStorage（`frontend/src/stores/appStore.ts`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Chat/ChatMessage.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-31 11:50) `[frontend]` 移动端设置新增「触觉反馈」开关（默认开）：`hapticTap` 内统一读取 `mobileHapticEnabled` 门禁，虚拟按键/导航点按/滑动切换等全部震动调用点一处生效（`frontend/src/stores/appStore.ts`、`frontend/src/utils/haptics.ts`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-31 00:50) `[backend]` `[frontend]` ACP 聊天气泡显示 agent 实际名称而非硬编码「agent」：后端 capabilities 帧新增 `agent_name`（连接就绪 + LoadSession 两路径下发 agent 的 `display_name`），前端存入 chatStore，气泡 user→USER / system→SYSTEM / assistant→agent 实际名称（缺省回退 agent）（`src/ws/acp.rs`、`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-31 00:28) `[frontend]` ThinkingIndicator 状态行动效改用像素字体并渐进 hex 长度（`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-31 00:21) `[frontend]` 移动端交互优化（计划 `docs/dev/plans/2026-07-30-mobile-interaction-optimization.md`）：终端支持手指拖动滚动（纵向 drag 合成滚轮事件直达 tmux 历史，横向 drag 保留文本选择）；标签页切换改为跟手滑动（边缘阻尼 + 松手提交/回弹，终端区排除）；虚拟按键/导航/滑动提交/会话切换增加触觉反馈（Android，iOS 静默跳过）；横屏 + 软键盘弹出时自动隐藏虚拟键栏；顶部状态栏左右滑动循环切换会话；虚拟键栏新增 ⏎ 与一键 ^C 且按键触摸目标加大至 36px；长按终端弹出粘贴菜单；底部导航触摸目标加大至 44pt 并修正设置页手势文案（`frontend/src/utils/{touchScroll,swipe,haptics,sessionNav}.ts`、`frontend/src/hooks/{useTerminal,useMediaQuery}.ts`、`frontend/src/components/Terminal/{Terminal,MobileKeyBar}.tsx`、`frontend/src/components/Layout/{Layout,MobileNav,MobileStatusBar}.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-30 20:36) `[backend]` `[frontend]` 设置 → 终端新增「tmux mouse mode」开关：新增 `GET/POST /system/tmux/mouse`（读取/设置 tmux 全局 mouse option），切换时经当前终端 WebSocket 实时下发 tmux 命令即时生效（`src/api/system.rs`、`src/tmux/mod.rs`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/hooks/useTerminal.ts`、`frontend/src/api/client.ts`、`frontend/src/stores/appStore.ts`）

### Fixed

- (2026-07-31 19:55) `[frontend]` 修复移动端软键盘收起后整页底部被裁切（底部导航等所有页面底缘不可见，需刷新恢复）：聚焦输入弹键盘时浏览器对 `overflow: hidden` 的固定高度根容器仍可编程滚动（scrollIntoView），键盘收起后滚动残留使整个布局上移；根链路 `html/body/#root` 与移动端列容器改 `overflow: clip`（老引擎回退 hidden），`useKeyboardHeight` 在视口变化时归零 window 滚动兜底（`frontend/src/index.css`、`frontend/src/components/Layout/Layout.tsx`、`frontend/src/hooks/useMediaQuery.ts`）
- (2026-07-31 15:50) `[backend]` 认证安全加固：① JWT 密钥不再提供公开默认值（`omniterm-default-secret-change-me`），未显式设置 `JWT_SECRET` 时自动生成随机密钥并持久化到 `~/.omniterm/jwt_secret`（0600），修复默认密钥下攻击者可离线伪造 token 绕过全部鉴权的问题；② 会话令牌版本化（`users.token_version`）：登出/修改密码后所有已签发 token 立即失效，修复 token 泄露后无法撤销的问题；③ `/auth/setup|login|change-password` 新增 IP 维度限流（5 次失败/5 分钟 → 429），修复公网暴露时无限流暴力破解的问题；④ 删除含硬编码密钥兜底的死代码 `RequireAuth` extractor（`src/auth/mod.rs`、`src/api/auth.rs`、`src/auth/rate_limit.rs`、`src/main.rs`、`migrations/20260731_add_token_version.sql`）
- (2026-07-31 15:50) `[infra]` docker-compose 移除公开默认 `JWT_SECRET=change-me-in-production`：未显式配置时由服务端自动生成随机密钥（容器重建后需重新登录）（`docker-compose.yml`）
- (2026-07-31 17:19) `[frontend]` 修复移动端虚拟键栏按键大小不一的问题：取消右侧固定宽度按键簇，所有按键均分整行宽度（原混合布局下行内并存 33/36/40/52px 多种宽度），并改为 9 列网格使两行按键逐列对齐（`frontend/src/components/Terminal/MobileKeyBar.tsx`）
- (2026-07-31 15:10) `[frontend]` 修复移动端 sidebar 内弹窗（新建项目/会话、删除确认等 Modal、更新面板、终端长按粘贴菜单）错位且操作按钮被裁出屏幕：三窗格滑动轮播容器（`will-change: transform`，宽 300%）成为后代 `position: fixed` 的 containing block，弹层以 3 倍视口宽为基准定位溢出屏幕，底部 CREATE/REMOVE 等按钮不可见；弹层统一 `createPortal` 到 `document.body`，恢复视口锚定（`frontend/src/components/Modal/Modal.tsx`、`frontend/src/components/Sidebar/UpdateBadge.tsx`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-31 14:55) `[frontend]` 根治 tmux status bar 内容间歇泄漏进终端 scrollback：xterm 实例改为 `scrollback: 0`——tmux 会话的历史完全由 tmux 持有（滚轮 mouse 序列 / copy-mode），本地 scrollback 只可能积累 resize 竞态窗口（fit → WS → SIGWINCH → tmux 重绘异步链路）泄漏的垃圾，取消后泄漏结构性无处持久化，窗口期瞬时错位由 tmux 全屏重绘自愈；此前的 80ms 去抖降级为合并布局抖动、减少 tmux 重绘次数的优化（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-31 14:52) `[frontend]` 修复移动端 ACP 会话下底部导航与实际聚焦窗格偶发错位（导航指 sidebar、屏幕显示终端，且因触摸落在 `.xterm` 被手势守卫排除而无法滑回，只能刷新）：三窗格轮播容器 `overflow: hidden` 仍是可编程滚动容器，软键盘弹出/聚焦聊天输入时浏览器 `scrollIntoView` 会偷偷设置 `scrollLeft` 把 transform 移出屏幕的窗格"滚"回来；改为 `overflow: clip`（非滚动容器）+ `onScroll` 归零兜底（`frontend/src/components/Layout/Layout.tsx`）
- (2026-07-31 12:00) `[backend]` `[frontend]` 修复 ACP 审批请求 60 秒无人响应即被自动以 `Cancelled` 应答的协议违规（ACP 规范 `Cancelled` outcome 仅限响应 `session/cancel`）：用户不在页面前时审批被擅自取消、agent 误读为「用户取消」。移除超时自动应答（无人应答兜底仍由 reaper 30 分钟负责）；`session/cancel` 时按规范以 `Cancelled` 应答全部未决审批；WS 重连时重放未决审批恢复前端 banner；prompt 回合结束时清理残留 banner（`src/acp/permission.rs`、`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/stores/chatStore.ts`）
- (2026-07-31 11:38) `[frontend]` 压缩移动端底部导航垂直空间：保留 44pt 触控目标的前提下收敛容器叠加 padding，总高约 68→51px（`frontend/src/components/Layout/MobileNav.tsx`）
- (2026-07-31 11:16) `[frontend]` 修复 ACP 聊天输入区「发送/排队/取消」按钮与输入框未垂直居中对齐：按钮高度统一为输入框单行基准高度 36px（`INPUT_ROW_HEIGHT` 常量）（`frontend/src/components/Chat/ChatInput.tsx`）
- (2026-07-31 01:30) `[backend]` `[frontend]` 修复 ACP 长会话点击「恢复会话」后聊天记录被清空：后端重放此前「先 await load_session 完成、再 try_recv 排空 broadcast」，历史超过 broadcast 容量 256 条时触发 Lagged 且旧代码直接 break，一帧都未转发；改为 `tokio::select!` 边加载边并发转发（Lagged 仅告警不中断），解除容量上限，并将 broadcast 容量 256→4096（`SESSION_UPDATE_CHANNEL_CAPACITY` 常量）进一步压低慢消费者积压丢帧概率。前端同步改为双缓冲原子提交：重放帧先入 staging 缓冲，`replay_end` 时非空才整体替换消息列表，空重放/加载失败保留本地消息并提示（ACP `session/load` 的历史回放为 agent 可选行为，omp 等实现可能不回放）（`src/ws/acp.rs`、`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatMessage.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-31 01:30) `[frontend]` 修复 ACP 会话聊天记录入库后，恢复/刷新页面时工具调用卡片与文本气泡顺序错乱或重复出现的问题
- (2026-07-31 00:38) `[frontend]` 修复 agent 输出期间 ThinkingIndicator 动画卡顿（`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-30 23:51) `[frontend]` 移动端侧栏功能按钮改为常驻显示，避免触摸误触呼出（`frontend/src/index.css`）

## [0.2.3] - 2026-07-30

### Added

- (2026-07-29) `[infra]` 恢复 npm 分发渠道，改用 esbuild 式原生平台分包：主包 `@gdwhisper/omniterm` 仅含 `shim.js`（`require.resolve` 定位平台包 binary + PATH 回退带递归守卫），`optionalDependencies` 精确锁定 4 个含真实 binary 的平台子包（`omniterm-{linux-x64,linux-arm64,darwin-arm64,win32-x64}`），安装时按 `os`/`cpu` 只拉当前平台——替代原 postinstall 从 GitHub Release 下载的壳包（此前误判「npm 无法原生发布」而下架）。发布经 `release.yml` 的 `npm-publish` job 自动化（tag push 后从 Release 拉资产、`scripts/npm-prepare.sh` staging、幂等发布平台包+主包），并支持 `workflow_dispatch` 补发历史版本（`npm-package/`、`scripts/npm-prepare.sh`、`.github/workflows/release.yml`）

### Fixed

- (2026-07-30 11:16) `[frontend]` 修复侧栏默认宽度过窄（160px）导致 logo 词标、worktree 分支名、会话名被截断或完全不可见：默认/拖拽下限提至 256/200px，旧 localStorage 过窄值加载时自愈，词标窄宽走 ellipsis 优雅降级（`frontend/src/stores/appStore.ts`、`frontend/src/components/Layout/Layout.tsx`、`frontend/src/index.css`）
- (2026-07-30 11:13) `[frontend]` 修复桌面端连接状态 badge 中文文案被 flex 挤压时逐字竖排堆叠：badge 容器 `flexShrink: 0` + 文本 `nowrap`（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-30 11:14) `[frontend]` 修复登录页主按钮引用不存在的 `pixel-button` 类导致零样式、面板双重边框且缺底部角钉：迁移共享 `PixelButton`，面板收敛为单层 `pixel-float` + 四角钉（`frontend/src/components/Auth/AuthPage.tsx`）
- (2026-07-30 11:21) `[frontend]` 修复文件管理器表格默认列宽（name 固定 300px）超出面板导致大小列不可见、日期被裁断：name 列随容器 ResizeObserver 自适应，手动拖列后退出自适应（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-07-29) `[infra]` 修复公开仓 main 的 CI audit job 恒红：`ci.yml` 无条件执行 `scripts/check-doc-index.sh`，但该脚本校验的 AGENTS.md/docs/ 均在 sync 黑名单中不进公开仓，脚本本身也随 main 清理不存在，push main 必然 exit 127；改为脚本存在时才执行（dev 生效、public main 跳过）（`.github/workflows/ci.yml`）

### Changed

- (2026-07-30 11:20) `[frontend]` Modal 弹窗统一木条标题栏（`.panel-title-bar`）与平涂遮罩 token `--modal-backdrop`（弃用 `backdrop-blur`）；弹窗内输入/select/按钮硬角化，按钮统一迁移共享 `PixelButton` 并删除 Sidebar 局部重复按钮组件（`frontend/src/components/Modal/Modal.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Sidebar/DuplicateProjectsDialog.tsx`、`frontend/src/index.css`）
- (2026-07-30 11:29) `[frontend]` 设置页滑杆改为像素方块样式（方块 thumb + 块状 track）；Toast 通知移除 emoji 图标与旧 tailwind 色类，统一 `toast-pixel` 单轨样式；CountBadge 复用 `.status-badge-3d`；右栏标题栏不再展示 session-id hex；FileDrawer/FilePreview 圆角清零（`frontend/src/index.css`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Toast/Toast.tsx`、`frontend/src/components/Common/CountBadge.tsx`、`frontend/src/components/RightPanel/RightPanel.tsx`、`frontend/src/components/FileManager/`）
- (2026-07-30 11:32) `[frontend]` 侧栏行内操作按钮（项目卡/worktree/会话行的重命名、删除、新建等）改为行 hover/键盘聚焦时显现，选中会话行常显，降低常驻视觉噪音（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`）

## [0.2.2] - 2026-07-29

### Changed

- (2026-07-29) `[frontend]` `[backend]` `[api]` Windows 上创建会话弹窗的终端会话类型显示为「psmux」（Windows 用 psmux 平替 tmux，两者无法在运行时区分，按平台编译期确定）：后端新增 `MULTIPLEXER_NAME` 常量经 `GET /system/info` 下发，前端 appStore 持有并在 AgentPicker 选项与提示文案中展示（`src/tmux/mod.rs`、`src/api/system.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/components/AgentPicker/AgentPicker.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-07-29) `[backend]` 修复 Windows 上终端会话只显示「已附加」无 shell 提示符、完全无法输入：psmux 遇 `;` 链式多命令会进入一次性命令模式执行完 exit 0 不 attach（真 tmux 则照常进入交互 attach），`build_tmux_attach_cmd` 按平台拆分：Windows 只跑纯 `new-session -A`，escape-time 改为 attach 前单独一次性 `set-option` 设置；Unix 链式命令保持不变（`src/ws/terminal.rs`）
- (2026-07-29) `[backend]` 降低 Windows 会话切换延迟：escape-time workaround 原为每次 WS 连接串行 `await` 一条 psmux 命令（实测 ~40ms 纯开销），改为 `tokio::spawn` fire-and-forget + 成功一次后 AtomicBool 缓存跳过（escape-time 是 server 级持久选项，设一次即全局生效）；剩余 ~100-200ms 为 Windows 固有成本（ConPTY 创建 + 进程 spawn + psmux DSR 探针/全屏重绘），基线数据见 `docs/architecture/backend.md`（`src/ws/terminal.rs`）
- (2026-07-29) `[frontend]` `[backend]` 修复 Windows 上侧边栏展开项目明显卡顿：前端 `toggleProject` 在 `setExpandedProjects` 前 `await` worktrees/sessions 请求，UI 展开被网络往返阻塞，改为立即展开 + fire-and-forget 加载（未加载时显示 Loading 占位）；后端 `list_workspaces` 串行 spawn 两个 git 子进程（`rev-parse` + `worktree list`，Windows 单次 spawn ~50ms），改用 `tokio::join!` 并发（`frontend/src/components/Sidebar/Sidebar.tsx`、`src/workspaces.rs`）
- (2026-07-29) `[backend]` `[frontend]` 修复 Windows 上工作区路径显示异常（`/g:/Codes` 多前导 `/`）：后端 `canonicalize()` 透传 verbatim 路径（`\\?\G:\...`）、psmux `pane_current_path` 返回反斜杠路径，新增 `fs::display_path[_str]` 剥离 verbatim 前缀并统一正斜杠，files/sessions API 的 cwd 返回与 adopt 入库路径均归一化；前端面包屑与 `getParentPath` 识别盘符路径，不再无条件加 `/` 前缀，盘符段保持 `G:/` 形式避免 drive-relative 路径（`src/fs/mod.rs`、`src/api/files.rs`、`src/api/sessions.rs`、`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/utils/path.ts`）
- (2026-07-29) `[frontend]` 修复 RTL 截断技巧引发的 bidi 重排：`direction: rtl` 容器（左侧省略号截断）中 LTR 文本末尾的中性字符被挪到视觉开头——项目路径尾部 `/` 显示为前导 `/`（`g:/Codes/…/` → `/g:/Codes/…`），三处渲染（Sidebar 项目路径、Git 面板文件路径、文件管理器时间列）内容改用 `<bdi dir="ltr">` 隔离（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/GitPanel/GitPanel.tsx`、`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-07-29) `[infra]` 修复 `dev.ps1` stop/restart 永久挂死：`Get-ProcessTree` 用数组切片模拟出栈，单元素时 `$a[1..0]` 降序切片返回原数组导致死循环，改用 `Queue[int]`；同时修复 Hashtable 用 UInt32 作 key、Int32 查询永远查不到子进程导致进程树杀不干净的问题（`dev.ps1`）
- (2026-07-29) `[backend]` 修复 Windows 上浏览用户主目录返回 500：`list_dir` 对单条目 `metadata` 失败（如 Windows 用户目录下 ACL 拒绝访问的遗留 junction「Application Data」「Cookies」等）直接 `?` 传播导致整个目录列表失败，现跳过不可读条目继续列出其余内容；子目录计数循环同样容错（`src/fs/mod.rs`）

## [0.2.1] - 2026-07-29

### Fixed

- (2026-07-29) `[infra]` 修复 CI 质量门禁（ci.yml）rust job 与 `build.rs` 契约不匹配：原 rust job 仅 `mkdir -p frontend/dist` 空占位，但 `build.rs` 校验 `frontend/dist/index.html` 存在，导致 push main 时 rust job 恒红、CI 门禁失效。现 rust job 先 `pnpm build` 再 `cargo check`，与 sync 脚本及 release.yml 对齐（`scripts/sync-main.sh`、`.github/workflows/ci.yml`、`build.rs`）
- (2026-07-29) `[infra]` 发布流程强化：crates.io 发布不可逆，发布指导新增「强制发布顺序」铁律——`cargo publish` 必须排在 GitHub Release CI（release.yml）与 push main 的 CI（ci.yml）**全部转绿之后**，禁止抢跑。本次 0.2.0 因抢跑导致 crates.io 上线错版，以 0.2.1 重发覆盖（`docs/workflows/release-guide.md`）

## [0.2.0] - 2026-07-29

### Added

- (2026-07-28) `[frontend]` `[backend]` `[api]` Sidebar 版本号旁新版本提醒 badge + 一键升级：检测到 GitHub 有新 release 时显示像素风 `NEW` badge（hover 提示新版本号），点击弹出升级面板（当前→最新版本、`omniterm update` 命令提示、Release 链接、一键升级按钮）；新增 `GET /system/version`（semver 比较 + 进程内缓存：成功 1h/失败 5min，防匿名限流；GitHub 不可达前端静默降级）与 `POST /system/update`（全局锁防并发 409、无新版 409、github_release 渠道自替换、npm 代跑、cargo 编译耗时不支持一键返回 400 只显示命令提示）；升级成功不自动重启服务器（持有 tmux/ACP/WS 连接），面板提示 `omniterm stop && omniterm start`（`src/api/system.rs`、`src/update.rs`、`frontend/src/components/Sidebar/UpdateBadge.tsx`、`frontend/src/api/client.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-28) `[backend]` 新增 `omniterm update` 自更新子命令：渠道感知（npm 装的代跑 `npm update -g`、cargo 装的代跑 `cargo install`、install.sh/手动装的从 GitHub Release 下载对应平台 asset 自替换），semver 三态比对防 dev 构建被降级，sha256 digest 校验 + `--version` 二次验证 + 原子 rename 确保不留半更新状态，`--check` 只查不装；依赖新增 reqwest（rustls）/semver/sha2（`src/update.rs`、`src/main.rs`、`Cargo.toml`）
- (2026-07-28) `[frontend]` `[backend]` `[api]` Sidebar 一键创建 git worktree：项目行新增 `+` 按钮，弹窗填入分支名（必填）、目标路径（选填，留空创建平级目录 `<parent>/<dirname>-<branch>`，含提示文字）、基准分支（下拉框，从 `GET /projects/{id}/branches` 获取本地分支列表，默认当前 HEAD）；后端 `POST /projects/{id}/worktrees` 执行 `git worktree add -b`，创建成功后自动刷新 worktree 列表；新增 `GET /projects/{id}/branches` 获取本地分支（`src/git/mod.rs`、`src/api/projects.rs`、`frontend/src/api/client.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-27) `[frontend]` `[backend]` `[api]` ACP 聊天 `@` 引用文件（F04 Phase A，同计划 §3.4）：输入框光标处键入 `@` 触发文件补全弹窗（复用斜杠命令弹窗模式，200ms 防抖调 `/files/search`，↑↓/Enter/Tab/Esc 键盘导航），选中插入 `@相对路径`；发送时后端从 prompt 文本提取 `@path`（`@` 前须行首/空白排除 email，去重上限 8），经 sanitize（canonicalize + workspace 越界拒绝）读取内容（单文件 ≤64KB 截断、非 UTF-8/目录/不存在静默跳过）注入 `ContentBlock::Resource`；§8 能力门控：`promptCapabilities.embeddedContext` 未声明的 agent 降级为文件内容内联进 text block。`/files/search` 响应新增 `rel_path` 字段（相对搜索根路径，目录列表不返回）（`src/ws/acp.rs`、`src/acp/client.rs`、`src/fs/mod.rs`、`frontend/src/utils/atReference.ts`、`frontend/src/components/Chat/ChatInput.tsx`）

- (2026-07-27) `[frontend]` ACP 聊天消息编辑与重新生成（F02，见 `docs/dev/plans/2026-07-27-acp-session-enhancements.md` §3.2）：用户消息 hover 显示 ✎ 编辑，气泡内 textarea 改稿后作为**新 prompt** 重发（ACP 无编辑历史语义，原消息保留并标灰色 `(edited)`，不做分支对话）；最后一条 assistant 消息 hover 显示 ↻ 重新生成，重发最近一条用户消息、回复追加不替换。sending 期编辑稿自动进 N=1 队列，regenerate 走 enqueue+cancel 复用 Send Now 的 drain 路径规避竞态（`frontend/src/stores/chatStore.ts` `markEdited`、`frontend/src/components/Chat/{ChatMessage,ChatView}.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-27) `[frontend]` `[backend]` `[api]` ACP 聊天图片附件（F03，同计划 §3.3）：输入框支持粘贴/拖拽图片（PNG/JPEG/WebP/GIF，单张 ≤5MB、单次 ≤3 张），缩略图条可逐张 ✕ 移除，>1MB 非 GIF 自动 canvas 降采样重编码 JPEG 缓解 WS 帧压力；WS `prompt` 帧新增可选 `images`（base64+mime，向后兼容），后端 `send_prompt` 构造多 ContentBlock（text + `ContentBlock::Image`），用户消息 blocks JSON 落库、刷新后缩略图可还原。§8 能力门控：initialize 捕获 `promptCapabilities.image`，新 `capabilities` WS 帧下发，前端据此隐藏附件入口、后端二次校验拒绝（`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/utils/imageAttachment.ts`、`frontend/src/components/Chat/{ChatInput,ChatView,ChatMessage}.tsx`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/{chatStore,acpConnectionStore}.ts`）。约束：带附件的消息仅支持 idle 直发（N=1 队列槽保持纯文本）
- (2026-07-27) `[frontend]` ACP 权限审批 banner 增加 diff/内容预览（F01，见 `docs/dev/plans/2026-07-27-acp-session-enhancements.md` §3.1）：permission request 的 `toolCall` 数据（title/kind/content/locations/rawInput）此前被 WS handler 丢弃、banner 只显示工具名盲批，现由新导出的 `parsePermissionRequest` 解析——含 diff 复用 `DiffView` 彩色渲染，含文本/入参降级为只读预览，无数据保持原纯文本 banner；兼容 camelCase/snake_case 及 legacy `tool_name` 格式（附 vitest 单测），`extractLocations` 顺带修复 `{path,line}` 对象形态 locations 在工具卡片中被丢弃的问题（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/{PermissionBanner,ChatMessage}.tsx`）
- (2026-07-27) `[frontend]` 设置 → 外观新增「像素字体（BETA）」开关（默认关，避免初见用户觉得风格不统一）：开启后标题/按钮/状态标签等显示文字使用像素字体，关闭时统一回退 reader 字体；顶栏一行（OMNITERM logo、版本号、面板标题条与 FILES|GIT 标签）始终保持像素。实现为 `body.pixel-font-on` 切换 `--pixel-font` 指向（关=`var(--reader-font)`，开=`var(--pixel-font-static)`），顶栏豁免规则直用 `--pixel-font-static`；顺手清理无 CSS 引用的死类 `pixel-ui-on` 与已无使用者的 `PIXEL_FONT`/`LOGO_FONT` JS 常量（`frontend/src/index.css`、`frontend/src/stores/appStore.ts`、`frontend/src/App.tsx`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Common/CountBadge.tsx`、`frontend/src/utils/fonts.ts`、`docs/visual-design/ui-style-guide.md` §2/§9）
- (2026-07-27) `[frontend]` Sidebar ACP 会话驻留状态可视化：ACP 会话行左侧缩进槽叠加 `A` 徽标（`status-badge-3d` 规范，绝对定位不占行内布局），进程驻留（未释放）→绿字、已释放→灰字，不点进会话即可分辨会话类型与释放状态；Release 按钮改为仅进程驻留时显示（已释放会话无可释放对象）（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[frontend]` ACP 与 tmux 会话状态通知表现对齐：ACP 会话现与 tmux 同款状态点（等待决策→琥珀、执行中→蓝、空闲→灰）并纳入项目/worktree 聚合徽标（blocked>done>working）；`prompt_done` 触发完成提醒（用户取消/排队续发不触发）、`prompt_error` 触发错误提醒，与 tmux 屏幕检测链路的 done/error 一致。`agentAggregate.ts` 归一两类会话状态源（tmux `agent_state` / ACP chatStore `sending`+`pendingPermission`）；ACP 空闲驻留进程不再显示绿点（残留状态见 tooltip 与 Release 按钮）（`frontend/src/utils/agentAggregate.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[backend]` `[frontend]` tmux agent 屏幕状态检测（借鉴 herdr P0，见 `docs/reference/herdr-reference.md`）：后端新增 `src/tmux/agent_detect.rs`（TOML manifest 屏幕规则引擎，`src/tmux/manifests/{claude,codex,qoder}.toml` 声明式判 running/waiting/idle）+ `src/tmux/agent_watch.rs`（每秒轮询活跃 pane，idle 两连击防抖、`#{window_activity}` 未变跳扫描）+ `process_info::foreground_pid`（tpgid 前台进程识别 agent 种类）；屏幕检测为状态权威覆盖 hook 上报，`GET /sessions`/`/sessions/external` 直接返回检测结果，无需 agent 配合、手动启动的 agent 也可监控。前端新增 `utils/agentAggregate.ts` 会话组聚合（blocked>done>working），Sidebar 项目/worktree/会话三级状态徽标：等待输入→琥珀、完成未查看→绿、运行中→蓝脉冲；新增依赖 `regex`/`toml`
- (2026-07-26) `[frontend]` `[backend]` `[api]` 右侧栏 git 管理面板（FILES | GIT 标签路由）：新增 `RightPanel` 容器（统一标题栏/折叠 rail，FileManager 变纯内容组件）+ `GitPanel`（分支切换/新建、ahead/behind 徽标、FETCH/PULL/PUSH、CHANGES|HISTORY 视图、stage/unstage/discard、底部提交框）+ 自研 unified diff 渲染与 diff/commit 抽屉；后端 `src/git/repo.rs` git CLI 子进程服务 + `src/api/git.rs` 14 个 `/api/v1/git/*` 端点（仓库绑定复用 session/workspace 解析，不接受任意路径；错误细分 auth/non_fast_forward/no_upstream/dirty_worktree/timeout）；可见时串行轮询 5s + ACP 编辑工具完成即时刷新提示；设计文档 `docs/dev/plans/2026-07-26-git-panel.md`
- (2026-07-25) `[frontend]` ACP 聊天排队后续消息（queued follow-up）：agent 忙碌期输入框保持可编辑，按 Enter 不打断当前任务而是暂存到单槽队列，agent `prompt_done` 后自动发出。chatStore `queuedMessage` 字段（sessionStorage 镜像，`omniterm_chat_queue:{sid}`，F5 友好）+ `enqueueMessage` / `clearQueuedMessage` / `hydrateQueuedMessage` / `addUndeliveredMessage` actions；ChatInput 输入框上方加 `Next: <预览> ✕` chip，busy 时双按钮（`Cancel` 取消 in-flight + `Queue` 排队新消息），队列满时 Queue 按钮 disabled 强制先 ✕。断连时未发队列消息作为 `undelivered: true` user 消息写入内存流（不入库）留痕。drain 在 `useAcpChat` `prompt_done` 分支内联处理（避免 `useCallback` TDZ 与 ChatView 状态机同步问题），详见 `docs/adr/0001-acp-queue-drain-location.md`；domain glossary 见 `CONTEXT.md`（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/{ChatInput,ChatView,ChatMessage}.tsx`、`frontend/src/locales/{en,zh}/translation.json`、`docs/architecture/frontend.md`）
### Changed

- (2026-07-27) `[frontend]` 像素字体字距收归 token 统一管理并整体收紧 0.5px：新增 `--pixel-tracking-sm/md/lg`（0.5/1.5/2px，原硬编码 1/2/3px），index.css 18 处像素/logo 字体规则与 2 处 TSX 内联字距全部改引 token，Silkscreen 偏宽字形下观感更紧凑；阅读字体字距不受影响（`frontend/src/index.css`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Settings/Settings.tsx`）
- (2026-07-27) `[frontend]` ACP 聊天列套用终端同款像素木框（`.terminal-panel-pixel`，2px 木色边框 + 3px 硬阴影）：聊天面板此前为平面 bg-base，与侧栏/右栏无反差导致三列分界不清；现标题条以下内容整体入框，与终端视图分区语言一致（`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-27) `[frontend]` UI 立体语言统一：所有浮层（Modal、Settings/Tmux 速查 popup、ConfigToolbar 下拉与 tooltip、聊天 @ 补全、Toast）从软阴影+圆角改为像素硬阴影（新增共享工具类 `.pixel-float` 4px / `.pixel-press` 2px+按压位移，禁止组件内联阴影）；补齐可交互元素硬阴影（Sidebar 加号/adopt 按钮、Git 分支/COMMIT 按钮、ConfirmDialog 改用 PixelButton、聊天发送/排队/取消、权限按钮）；圆角统一压平 0-2px；清理未定义变量 `--accent-glow-sm`/`--success-glow` 引用与残留模糊 glow（`frontend/src/index.css`、`docs/visual-design/ui-style-guide.md` §6.1/§12）

- (2026-07-26) `[frontend]` 像素显示字体从 VT323 换为 Silkscreen（几何方块风、自托管 woff2，VT323 保留为回退）：VT323 过于窄长，Silkscreen 专为小字号 UI 标签设计，字形更宽、字高统一；仅改 `--pixel-font` / `PIXEL_FONT` 单一真相源即全站生效（`frontend/src/index.css`、`frontend/src/utils/fonts.ts`、`docs/visual-design/ui-style-guide.md` §2）
- (2026-07-24) `[frontend]` 启用 TypeScript `strict: true`（`tsconfig.app.json`/`tsconfig.node.json`）；评估下零错直接落地，`tsc -b`/`lint`/`test` 通过

- (2026-07-28) `[frontend]` 新建项目时路径输入实时目录补全：输入路径时不再需要回车/失焦确认，浏览面板自动根据已输入内容解析目录前缀并拉取过滤匹配结果（200ms 防抖）；目录项点击补全末尾自动追加 `/`，↑↓/Tab/Enter/Esc 键盘导航；移除「回车或失焦以应用路径」提示文字与刷新按钮（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Fixed

- (2026-07-29) `[backend]` 修复 `omniterm stop` 可能导致 ACP agent 子进程变孤儿：`AcpSupervisor::shutdown_all()` 原依赖 `Arc::try_unwrap` 获取所有权再调 `disconnect()`，WS handler 仍持有引用时 unwrap 失败静默跳过清理；正式版 stop 只发单进程 SIGTERM（非进程组 kill），无 OS 兜底。新增 `AcpClient::shutdown(&self)` 通过共享引用直接回收子进程，`shutdown_all()` 不再依赖 `try_unwrap`（`src/acp/client.rs`、`src/acp/supervisor.rs`）
- (2026-07-27) `[frontend]` 修复服务端数据重置/删除后，localStorage 里的旧 project/workspace/session ID 永不清理导致文件列表等请求持续 404：Sidebar 的恢复逻辑此前以「列表非空」为触发条件，服务端列表为空时（如 DB 重建）早退跳过清理；现以「已完成拉取」判定（projects 加载标记 / worktrees・sessions 按 project 键判空），旧 ID 未命中即连带清空下游 workspace/session（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[backend]` 修复终端内 agent TUI（如 opencode）按 ESC 无法中止任务：tmux 默认 `escape-time` 500ms 使孤立 ESC 延迟 500ms 转发、快速连按两次 ESC 被合并为 Alt+ESC 单次事件；现 spawn tmux client 时链式 `set-option -s escape-time 10`（`src/ws/terminal.rs`）
- (2026-07-26) `[frontend]` 修复终端 idle 断开后重连按钮偶发无反应需刷新页面：被替换 socket 的晚到 close/error 事件会把健康新连接盖回「已断开」（现以 `wsRef.current === ws` 守卫并解绑旧 socket `onerror`）；addon 动态 import 失败被模块级缓存导致重连永久失败（现失败后重建 promise 可重试）；`createTerminal` 异常静默吞掉（现 toast 提示并保留覆盖层可重试）；重连按钮传入实时容器兜底 hook 内 `containerRef` 为 null 的场景（`frontend/src/hooks/useTerminal.ts`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-25) `[frontend]` 修复界面缩放非 100% 时终端鼠标选取文字位置偏移：xterm.js 坐标换算不感知 CSS `zoom`，现给终端挂载容器施加反向 zoom 使 xterm 子树有效缩放归一，字号乘以缩放系数保持视觉尺寸不变（`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-24) `[backend]` 修复 `fs::sanitize_path` 读取路径测试预期与实现契约不符（测试未创建被校验路径导致预先失败，阻塞 CI `cargo test`）（`src/fs/mod.rs`）
- (2026-07-24) `[frontend]` 消除 `Markdown.tsx` 触发 `no-explicit-any` 的 ESLint error（pnpm lint 此前预先失败）；记录 react-markdown 类型双实例根因为 TECH-DEBT（`frontend/src/components/Chat/Markdown.tsx`）

## [0.1.9] - 2026-07-22

### Added

- (2026-07-15) `[backend]` sessions 表新增 `runtime_kind` / `acp_session_id` 列，`Session` DTO 与前端 TypeScript 类型同步；`POST /projects/{pid}/sessions` 接受可选 `runtime_kind`（Phase 2 默认 `tmux`，`acp` 返 501 占位，Phase 3 实装）（`migrations/20260715_add_runtime_kind.sql`、`src/models/session.rs`、`src/api/sessions.rs`、`frontend/src/api/client.ts`）
- (2026-07-15) `[backend]` 新增 `agents` 表 + `Agent` / `CreateAgent` / `UpdateAgent` 模型 + CRUD API（`GET/POST/PUT/DELETE /api/v1/agents[/{id}]`）（`migrations/20260715_add_agents_table.sql`、`src/models/agent.rs`、`src/api/agents.rs`）
- (2026-07-15) `[backend]` 新增 `src/acp/` 模块：`AcpClient`（spawn agent 子进程 + ACP 握手 + session/prompt/cancel/disconnect）、`AcpSupervisor`（`HashMap<omniterm_session_id, Arc<AcpClient>>` 注册表）、`PermissionManager`（auto-allow）、`AcpTerminalManager`（`tokio::process` + mpsc kill channel 服务 agent 的 `terminal/*` 请求）、session/update broadcast handler（`src/acp/{client,supervisor,permission,terminal,handler}.rs`）
- (2026-07-15) `[backend]` ACP session HTTP/WS 路由实装：`POST /projects/{pid}/sessions` ACP 分支加载 agent → spawn `AcpClient` → 注册 supervisor；`DELETE /sessions/{id}` ACP 分支 dispose + disconnect；`POST /sessions/{id}/prompt` 透传用户 prompt；`WS /ws/acp/{session_id}` 订阅 session/update 广播 + 转发 prompt/cancel 命令（`src/api/sessions.rs`、`src/ws/acp.rs`、`src/api/mod.rs`）
- (2026-07-15) `[frontend]` API client 新增 `Agent` / `CreateAgent` / `UpdateAgent` 类型与 `listAgents`/`getAgent`/`createAgent`/`updateAgent`/`deleteAgent`/`sendPrompt` 方法；`createSession` 增加 `runtimeKind` + `agentId` 参数；`Session` 类型加 `agent_id` 字段（`frontend/src/api/client.ts`）
- (2026-07-15) `[frontend]` 新增 `agentStore`（Zustand）：agent 配置列表 CRUD 状态（`frontend/src/stores/agentStore.ts`）
- (2026-07-15) `[frontend]` 新增 `AgentPicker` 下拉组件并接入 Sidebar 「新建会话」 modal：选中 agent 时 `runtime_kind='acp'`、留空时维持原 tmux 行为；新增 `agentPicker.*` 与 `settings.agents.*` 中英文翻译（`frontend/src/components/AgentPicker/AgentPicker.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-15) `[frontend]` Settings 面板新增 AGENTS tab（`AgentSettings` 组件）：支持新建/编辑/删除 agent，含 env 行编辑（`frontend/src/components/Settings/AgentSettings.tsx`、`Settings.tsx`）
- (2026-07-16) `[frontend]` ACP Chat 视图（Phase 4a）：新增 `chatStore`（按 `session_id` 索引的纯状态 Zustand store）、`useAcpChat` hook（管理 `/ws/acp/{id}` 生命周期并把协议帧翻译成 store 动作）、`ChatView` + `ChatMessage` + `ChatInput` 三件套渲染 ACP 会话的 title bar / 滚动消息列表 / 输入行；新增 `.chat-streaming-caret` CSS 动画复用 `blink-cursor` keyframe（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/*`、`frontend/src/index.css`）
- (2026-07-22) `[frontend]` ACP 聊天流在 agent 整轮忙碌期（`sending`，自发送 prompt 至 `prompt_done`）底部持续显示终端式状态行动效（hex 解码噪声，前缀 `▌` 游标，风格对齐 FileManager 路径栏 `b7b08acf56c1`，等宽逐槽滚动、长度恒定无抖动），长任务（工具调用/等待/思考）期间画面不再静默；`pixelAnimationsEnabled` 关闭时回退静态「思考中…」（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-22) `[frontend]` 加速 ACP 会话重放（长时间断连后回连恢复历史）：重放期间后端逐帧推送的历史 `session_update` 不再逐帧触发整列表重渲染，而是攒进本地 buffer 按 `requestAnimationFrame` 批量合并提交（`chatStore.applyReplayBatch` 一次 state 变换处理多条帧），重渲染成本从 O(帧数) 降到 O(动画帧数)；重放结束统一把残留 streaming 消息标为已完成。`replay_start…replay_end` 期间 ChatView 底部显示轻量「正在恢复会话记录…」指示器（spinner + 文案，含 `chat.replaying` 中英翻译），避免用户误以为卡死（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-22) `[backend]` `[frontend]` 修复「恢复会话后聊天记录在浏览器刷新后丢失」：此前 `LoadSession` 重放的历史只推给当前 WS 连接（前端内存 store），从不落库，刷新即从 DB 空还原、需重新释放+恢复。新增 `POST /sessions/{id}/messages/sync`，前端在 `replay_end` 把 store 重建的完整消息写回 DB，刷新后 `list_messages` 可还原历史（`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-22) `[backend]` `[frontend]` 修复 sync 误删历史 + 记录不全：原 `sync_messages` 整轮 `DELETE` 重建会清掉实时 prompt 已落库的 user 消息（ACP `session/load` 重放流不含 user prompt），且只存纯文本导致工具卡片/思考/计划在刷新后丢失。改为**不删除、按内容去重插入**；`chat_messages` 新增 `blocks TEXT` 列（migration `20260722_chat_message_blocks.sql`）持久化结构化内容（工具调用/思考/计划），hydrate 时优先用 blocks 还原富渲染、坏 JSON 回退纯文本；前端 sync 时合并连续 assistant 为整轮（文本+blocks 一并拼接）（`migrations/20260722_chat_message_blocks.sql`、`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-22) `[backend]` `[frontend]` 修复「恢复会话后刷新仍丢历史」（精确边界版）：根因是 `replay_end` 经 notify_tx(mpsc) 转发时可能早于积压的重放 `session_update` 到达前端，导致 sync 写入半截历史。改为**后端保证顺序**——`LoadSession` 分支在 `load_session` 返回前先订阅 `session_update` 广播，返回后 `try_recv` 排空所有重放帧并经 `notify_tx`（FIFO）逐帧转发，确认全部发完再发 `replay_end`；实时帧的 `spawn_notify_task` 推迟到 `replay_end` 之后订阅，避免重复。前端由此可在 `replay_end` **即时 sync**（移除之前的 1s 稳定窗口计时器），无延迟、不漏帧（`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-23) `[backend]` 修复「恢复会话后配置栏（mode/model/thinking）不显示」：根因是 `load_session` 仅在 `session/load` 响应返回 `config_options` 时才发 `ConfigOptionUpdate`，而 opencode 等 agent 不在 load 响应里返回 config（仅 codebuddy 返回，故仅它显示）。改为与实时 `set_config_option` 兜底逻辑一致——load 响应缺 config 时回退到创建会话时缓存的 `initial_config_options`，合成 `ConfigOptionUpdate` 经由重放广播推给前端，恢复后配置栏即有数据（`src/acp/client.rs`）
- (2026-07-23) `[frontend]` 修复「opencode/ccb 恢复会话后配置栏需手动刷新才出现」：根因是重放期间当 session 已有历史（`suppressReplay`）时，前端在 `session_update` 分支整帧丢弃，连 `ConfigOptionUpdate` 状态同步帧也一并丢弃，只能等刷新走 WS 连接分支的 `initial_config_notification` 才补到。`suppressReplay` 期间改为放行配置/命令/模式/用量类状态帧（`setConfigOptions`/`setCommands`/`setMode`/`setUsage`），仅丢弃文本内容帧，恢复即显示配置栏（`frontend/src/hooks/useAcpChat.ts`）

### Changed

- (2026-07-15) `[backend]` tmux 缺失时改为 warning 日志并继续启动，不再 `exit(1)` — 为 ACP runtime 接入解耦启动依赖；tmux-backed session 在运行时按需失败，前端可通过 `/system/multiplexer` 查询可用性（`src/main.rs`）
- (2026-07-16) `[backend]` `RuntimeKind::default()` 由 `Tmux` 翻转为 `Acp`（Phase 4 Chat 视图落地，新会话默认走 ACP runtime）；`DB schema DEFAULT 'tmux'` 保持不变以兼容历史行；Sidebar 「新建会话」 modal 未选 agent 时显式传 `'tmux'`（`src/models/session.rs`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-16) `[frontend]` Layout + MobileContent 按 `activeSession.runtime_kind` 分发：`tmux → <Terminal>`、`acp → <ChatView>`；新增 `chat.*` 中英文 i18n 命名空间（`frontend/src/components/Layout/Layout.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-15) `[docs]` `docs/architecture/backend.md` 源树 + API 端点 + Sessions 表段同步到 Phase 3 状态，新增「ACP Module (Phase 3)」章节；`docs/reference/user-testing.md` 追加 §11 ACP 智能体会话手工测试用例
- (2026-07-16) `[docs]` `docs/architecture/frontend.md` 源树补 `agentStore`/`chatStore`/`useAcpChat`/`Chat/`/`AgentPicker/`；新增「ACP Chat View (Phase 4a)」章节（state/connection split + SessionUpdate 解析策略）；`docs/reference/user-testing.md` 追加 §12 ACP Chat 视图手工测试用例
- (2026-07-20) `[frontend]` ACP 助手回合由「单一气泡」拆分为分块堆叠：文本输出 → 气泡、工具调用 → 带状态色左边框的卡片（运行中 accent / 完成绿 / 失败红，等宽字体标题）、思考 → 低调斜体可折叠（无填充背景）、计划 → 细边框容器；流式光标跟随末尾文本块，工具执行期间独立显示（`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-21) `[frontend]` Sidebar 操作按钮图标（新建/重命名/删除/释放）由固定色 PNG 换成线性描边 SVG（复用 FileManager `icons.tsx` 风格：16×16 / stroke 1.5 / round caps / `currentColor`）：图标随按钮 hover 变色（accent/danger/warning）恢复正常，重命名图标由误用的金币修正为铅笔；删除 4 个 PNG 资源（含无引用的 `hero.png`）；`icons.tsx` 新增通用 `IconPlus` / `IconPower`（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/FileManager/icons.tsx`）

### Removed

- (2026-07-17) `[backend]` 删除 `agents` 表的专属凭据字段 `api_key_env_var` / `api_key_value` — 凭据归 agent 自管，OmniTerm 只负责 spawn + ACP 协议，不再做一等公民的密钥注入；用户仍可通过通用 `env` 字段给子进程传任意环境变量。新增 migration 删列、`AcpClient` 移除注入块、`AgentSettings` 移除两行输入框与 dirty 语义、删 `settings.agents.apiKey*` 翻译（`migrations/20260717_remove_api_key_from_agents.sql`、`src/models/agent.rs`、`src/api/agents.rs`、`src/acp/client.rs`、`frontend/src/api/client.ts`、`frontend/src/components/Settings/AgentSettings.tsx`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-07-17) `[backend]` 修复 `/api/v1/files/watch` SSE 端点的 inotify watch 泄漏：每个连接 spawn 的 `spawn_blocking` 线程持有 `notify::Watcher` 后进入永不退出的 `sleep` 循环，客户端断开时 watcher 不 drop → `inotify_rm_watch` 永不调用，长运行实例 fd 单调增长（5 天累积 1320 个），最终撑满系统上限触发 Vite/cargo-watch 等 ENOSPC。改为 `tokio::sync::watch` channel 把 shutdown sender 绑到 stream generator，generator drop 时触发 blocking task 退出并释放 watcher（`src/api/files_watch.rs`）
- (2026-07-20) `[frontend]` 修复 ACP 工具调用刷屏 `[ToolCallUpdate]` 芯片：`tool_call_update` 是 partial 事件（只带 `toolCallId` + 变更字段，通常无 title/status），此前落入 system chip fallback，每帧生成一条芯片；现改为按 `toolCallId` upsert 合并进同一张工具卡片，undefined 字段保留卡片原值，一个 prompt 内的全部工具事件聚合为单卡（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-20) `[frontend]` 修复 ACP 权限审批完全失效：`permission_request` wire frame 的 options 用 camelCase `optionId`，前端只读 snake_case `option_id` 导致每个 option_id 为空串，点 Allow 发送空 option_id → 后端 60s 超时回退 deny，工具永远到不了 completed；现在 wire 边界同时接受两种命名（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/PermissionBanner.tsx`）
- (2026-07-21) `[backend]` 修复非 codebuddy agent（ccb、opencode 等）的 mode/model/thinking 切换不生效：`set_config_option` 丢弃了 `SetSessionConfigOptionResponse.config_options`（ACP 规范中 agent 返回更新后全量配置的主通道），仅 codebuddy 会额外主动推送 `ConfigOptionUpdate` 通知故只有它能刷新 UI；现在 response 写回本地缓存并合成 `ConfigOptionUpdate` 广播，所有 agent 均可同步；boolean 类型选项改发 `{"type":"boolean"}` 而非字符串值（`src/acp/client.rs`）
- (2026-07-21) `[frontend]` 配置切换乐观更新（对齐参考实现 obsidian-agent-client）：选中下拉项时立即 patch 该选项 `currentValue`，无需等待 agent 往返；后端 `ConfigOptionUpdate` 广播随后全量替换确认，UI 响应即时且对所有 agent 普适（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-21) `[backend]` ACP 空闲自动回收：新增 `src/acp/reaper.rs` 看护任务（默认 30s 扫描），按后端可观测活跃度信号回收孤儿 `codebuddy --acp` 进程——静默待命满 5 分钟（`IDLE_RECYCLE_SECS`）或权限请求无响应满 30 分钟（`REQUIRES_ACTION_RECYCLE_SECS`）即 `disconnect` 杀进程释放内存；活跃工作中（有进行中 prompt / 有未决权限）不回收。`AcpClient` 新增 `ActivityState` 跟踪（prompt 进行中标记 + 任意 session/update 刷新活动时间），`PermissionManager` 暴露 `pending_count`，`AcpSupervisor` 新增 `snapshot`；`main.rs` 启动 reaper；`LoadSession` 覆盖前先 dispose 旧 client 防泄漏（`src/acp/{reaper,client,supervisor,permission}.rs`、`src/ws/acp.rs`、`src/main.rs`）
- (2026-07-21) `[frontend]` ACP 权限请求（对应后端 `requires_action`）接入 `AttentionProvider`：收到 `permission_request` 时 `attention.fire(sid, sid, 'decision')`，用户响应后 `clearAlert`，自动复用 Sidebar 决策徽标闪烁 + 标签栏标题闪烁 + 提示音，断连后仍持续提醒用户回来处置（`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-21) `[backend]` 新增 `POST /sessions/{id}/release`：仅 `supervisor.dispose` + `disconnect` 释放 ACP agent 子进程（`codebuddy --acp` 等），**不删除会话记录**，与 reaper 自动回收语义一致，之后可"恢复会话"重新 spawn；非 acp 会话返回 400（`src/api/sessions.rs`）
- (2026-07-21) `[backend]` `[frontend]` 修复输入 `/` 不弹出斜杠命令列表：agent 在会话创建时即推送 `AvailableCommandsUpdate`，早于 WS 订阅导致通知丢失（与 config options 同类时序问题）——后端现缓存该通知并在 WS 连接时重放（`initial_commands_notification`，同 `initial_config_notification` 模式）；前端 `ChatInput` 过滤逻辑未剥离 `/` 前缀导致永远匹配不到命令、选中后也丢失 `/` 前缀致 agent 无法识别，一并修复（`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/components/Chat/ChatInput.tsx`）
- (2026-07-21) `[frontend]` 斜杠命令补全透传 agent 的 `description` / `input.hint`（此前仅保留命令名）：`SlashCommand {name, description, hint}` 结构化存入 store，`/` 下拉框命令名旁以淡色展示描述（超长省略），对齐参考实现的透传行为（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatInput.tsx`）
- (2026-07-21) `[frontend]` 移除全局 `svg { shape-rendering: crispEdges }` / `stroke-linecap: square` CSS：该规则优先级高于 presentation attribute，把全应用线性描边图标（icons.tsx / BookIcon / Settings / Modal 等）声明的 `round` 端帽压成方角、曲线/斜线锯齿化（GitHub logo 因此难以辨认）；像素精灵（PixelSprites / OmniTermLogo）本就自行声明 `crispEdges` 不受影响。`ui-style-guide.md` §13 同步重写为「线性描边图标 + 像素精灵」双图标体系（`frontend/src/index.css`、`docs/visual-design/ui-style-guide.md`）
- (2026-07-21) `[frontend]` Sidebar ACP 会话条新增「释放」图标按钮（仅 `runtime_kind='acp'` 渲染，hover 用 `--warning` 黄色区别于删除的 `--danger` 红），调用 `releaseSession` 手动 kill 进程但保留会话；新增 `sidebar.releaseAcp` / `sidebar.sessionReleased` i18n 中英词条（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `list_sessions` 用 `supervisor.snapshot()` 一次性标记每个 ACP 会话的 `acp_process_alive`（进程是否在后端驻留），`Session` 模型新增该运行期字段（`src/api/sessions.rs`、`src/models/session.rs`)
- (2026-07-21) `[backend]` 修复后端正常停止/重启时 ACP agent 子进程（codebuddy --acp 等）变孤儿持续占内存：新增 SIGTERM/SIGINT 优雅退出钩子，退出前 `AcpSupervisor::shutdown_all()` 显式 kill 所有 supervisor 中驻留的子进程（实测 22 个孤儿→0）。注：SIGKILL / panic / 崩溃来不及运行，此类场景产生的孤儿仍需下次启动时手动清理或"恢复会话"（`src/main.rs`）
- (2026-07-21) `[frontend]` Sidebar 区分「未释放/已释放」ACP 会话：运行中显示绿点 + tooltip「Agent process running」，已释放显示灰点 + 「已释放」小标签 + tooltip「点击会话可恢复」；ACP 会话不再误用 tmux 的 `is_active` 假状态（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[frontend]` 修复 ACP 会话「断开/释放后不显示恢复按钮、需刷新页面才出现」：ChatView 恢复按钮显示条件从仅 `sessionEnded` 扩展为 `sessionEnded || (acp_process_alive===false)`，进程被手动释放/reaper 回收/后端重启后即时显示「恢复会话」；Sidebar `handleReleaseSession` 释放当前聚焦会话后立刻 `markEnded` 实现零延迟；新增 `chat.status.released` 中英文案（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `[frontend]` ACP 进程存活状态由 3 秒轮询改为 **WS 事件驱动**：`AcpSupervisor` 内置 `broadcast::Sender<AcpProcessEvent>`，在 `insert`/`dispose` 时自动广播；`ws/acp.rs` 订阅后按 `session_id` 过滤转发 `process_alive` 帧（含连接建立时的初始同步帧）；前端 `useAcpChat` 收到后即时 `setAcpProcessAlive` 更新指示灯。恢复会话后绿点从「最多 ~4-5s（spawn+轮询）」降为「进程注册即亮」（约 spawn 耗时 ~1.6s，无需等轮询）。保留 Sidebar 轮询仅服务 tmux 会话（`src/acp/supervisor.rs`、`src/ws/acp.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-22) `[backend]` `[frontend]` 修复 ACP 三类错误被静默丢弃、用户看不到根因：（1）agent 子进程崩溃/异常退出时，`disconnect` 中 `let _ = connection_task.await` 吞掉错误，仅显示「恢复会话」而无崩溃原因——新增 `crash_tx` 广播通道 + `spawn_crash_watcher` 看护任务，连接非正常退出即经 `prompt_error` 帧透传崩溃原因；（2）`set_config_option` 失败仅记日志不回传，现回 `config_option_failed` 错误帧；（3）`cancel` 失败仅记日志不回传，现回 `cancel_failed` 错误帧（`src/acp/client.rs`、`src/ws/acp.rs`）
- (2026-07-22) `[backend]` `[frontend]` 提升 ACP agent 动作可见性，防止静默执行：（1）**修复文件读写空实现**——`ReadTextFile`/`WriteTextFile` 原为空 stub（读返回空串、写假装成功但不落盘），现用 `tokio::fs` 真正读写，路径经 `resolve_fs_path` 限制在 workspace 内防越界，失败如实 `respond_with_internal_error` 回报 agent（不再假装成功）；（2）**终端命令可见**——`AcpTerminalManager` 新增 `TerminalActivity` 事件（创建/退出），经 `terminal_event_tx` 广播 → WS `terminal_activity` 帧 → 前端聊天区紧凑卡片显示「agent 跑了什么命令 + 退出码」，消除后台命令盲点（`src/acp/{client,terminal}.rs`、`src/ws/acp.rs`、`frontend/src/{stores/chatStore.ts,hooks/useAcpChat.ts,components/Chat/ChatView.tsx}`）
- (2026-07-23) `[backend]` 修复 ACP agent 子进程 OS cwd 继承后端而非 session workspace：根因是 `agent-client-protocol` crate 的 `AcpAgent::spawn_process` 不接受 `current_dir` 也不调 `Command::current_dir()`，导致 agent（codebuddy/ccb/opencode 等）OS 进程的 cwd 永远是后端启动时的目录（如 `/home/pax/coding/OmniTerm-dev`），与 session 记录的 `workspace_path` 无关。表现为：用户在任何 project 下创建 ACP session，agent 都跑在后端目录里，读不到 session workspace 的 git 状态、读不到正确文件、看不到该项目的 branch 和 worktree——是用户报告「branch/WORKSPACES 检测不到 + workspace 始终是 OmniTerm-dev」的根因。修复：`AcpClient::spawn_and_connect` / `spawn_and_load` 用 `sh -c "cd <workspace> && exec <cmd> <args>"` 包装 agent 命令，`exec` 替换 shell 进程保留信号透传和进程组清理；新增 `sh_quote` / `wrap_agent_with_cwd` 单元测试 + 端到端测试（spawn `pwd` 验证 cwd 切到目标 workspace，含空格路径回归覆盖）；POSIX-only（`#[cfg(unix)]`，ACP 暂不支持 Windows）（`src/acp/client.rs`）
- (2026-07-23) `[backend]` 修复 FileManager 对 ACP session 返 404：上一条修复了 agent OS cwd 但后端 `resolve_session_base` 只查 `tmux_session_name`、ACP session 该列为 NULL → 整个函数返 None → `/api/v1/files?session=…` 返 404「session not found or tmux unavailable」，前端 FileManager 加载 ACP session 文件列表永远报错；现在一次性查 `(runtime_kind, tmux_session_name, workspace_path)`，识别 `runtime_kind='acp'` 走 workspace_path 分支，FileManager 与 agent 看到同一个工作区（`src/api/files.rs`）

---

## [0.1.8] - 2026-07-13

### Added

- (2026-07-13) `[infra]` 版本号统一为 `Cargo.toml` 单一真相源 — 移除 `.env.local` 的 `BRANCH_VERSION`（gitignored，导致各 worktree 版本号失同步），Rust 编译期读 `CARGO_PKG_VERSION`、前端构建时从 `Cargo.toml` 注入 `VITE_APP_VERSION`；`bump-version.sh` 改为同步 `Cargo.toml` + `frontend/package.json`（`src/main.rs`、`frontend/vite.config.ts`、`scripts/bump-version.sh`）
- (2026-07-13) `[backend]` Windows/psmux 兼容增强 — `check_multiplexer()` 在 Windows 上额外 fallback 到 `psmux`；`list-sessions` 空输出视为无 session；`/sessions/external` 在 tmux 错误时返回空列表而非 500（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-07-12) `[infra]` 新增 Windows 原生启动脚本 `dev.ps1` — `dev.sh` 依赖 bash/`ss`/`kill`/`/proc` 等 Unix 语义，原生 Windows 无法直接运行。PowerShell 版功能对齐：用 Windows 原生机制后台拉起（`Start-Process` + `.dev/*.pid`）、`Get-NetTCPConnection` 端口检测、`Stop-Process` + 进程树递归停止，支持 `start`/`stop`/`restart`/`status`/`logs`（`dev.ps1`）
- (2026-07-12) `[frontend]` Sidebar 图标按钮统一为 PNG 像素风图标 — 创建/编辑/删除按钮由文字与 emoji 改为 `add.png`/`edit.png`/`delete.png`（24×24 像素图标，`imageRendering: pixelated`）（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`、`frontend/public/buttons/`）
- (2026-07-11) `[frontend]` 终端 tab blur/idle 延迟断连 — 切换标签页或空闲时延迟断开 WebSocket，切回立即恢复，避免无谓重连（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-10) `[frontend]` 移动端滚动激活模式临时禁用输入法 — 进入 tmux copy mode 后将 xterm `<textarea>` 的 `inputmode` 同步为 `none`，退出恢复 `text`，避免点按 ↑/↓ 滚动时软键盘弹起遮挡终端（`frontend/src/hooks/useTerminal.ts`、`frontend/src/utils/terminalInputMode.ts`）
- (2026-07-10) `[frontend]` 移动端功能键改用自然焦点 — Modifier 键（Ctrl/Shift/Alt）点按后主动 refocus xterm textarea 保持 IME 打开，非 modifier 键靠按钮自然夺焦关闭键盘（`frontend/src/components/Terminal/MobileKeyBar.tsx`）

### Changed

- (2026-07-13) `[docs]` README 安装说明拆分为独立代码块并标注 tmux/psmux 前置依赖 — 各安装方式（brew/cargo/npm/源码/Windows）配 `<small>` 说明；明确 Linux/macOS 需 tmux、Windows 需 psmux 或 tmux（`README.md`、`README_zh.md`）

### Fixed

- (2026-07-13) `[backend]` `[frontend]` 文件管理器下载文件夹失败 — 下载模式勾选目录被忽略，单选文件夹时提示「正在下载0个文件」且无法下载。修复：后端 `/files/download` 检测目标为目录时递归打包为 zip 流式返回，前端不再过滤目录；新增 `fm.downloadStartedDir` 提示（`src/api/files.rs`、`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/locales/*/translation.json`）
- (2026-07-12) `[frontend]` 终端断连后黑屏、重连按钮不显示 — overlay 依赖全局 `connected`（由 Sidebar 每 5 秒健康检查驱动），blur/idle 断连销毁 xterm 后健康检查把 `connected` 拉回 `true` 导致按钮永不渲染。修复：新增与全局 `connected` 解耦的 `terminalDisconnected` 状态，overlay 改依赖它，断连后跳过自动重建（`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useTerminal.ts`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-10) `[frontend]` 移动端修饰键锁存 + 软键盘输入经 IME 合成被丢弃 — 导致 Ctrl+C 等组合键失效，修复 `useTerminal.ts` 的键序列发送逻辑（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-10) `[frontend]` 移动端按方向键/功能键时呼出软键盘 — 调整 `MobileKeyBar` 焦点管理避免误触（`frontend/src/components/Terminal/MobileKeyBar.tsx`）
- (2026-07-13) `[frontend]` Sidebar 测试：项目标题栏「创建」按钮 class 与工作区「创建会话」按钮冲突 — `querySelector('.sidebar-wt-add-btn')` 总命中先出现的项目按钮导致测试点击错误，项目按钮 class 改为 `sidebar-proj-add-btn`（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`）

---

## [0.1.7] - 2026-07-08

### Added

- (2026-07-08) `[backend]` 智能启动日志 — 检测运行模式自动切换：dev 模式（前端目录存在）输出详细分支/版本/端口信息，生产模式（内嵌前端）输出简洁一行 `OmniTerm v0.1.7 — http://host:port`（`src/main.rs`）
- (2026-07-08) `[infra]` 新增 `scripts/sync-main.sh` 分支同步脚本 — 自动处理黑名单文件删除、Cargo.toml/Dockerfile/docker-compose 分支专属配置修复、Cargo.lock 重新生成，支持 dev → main 单向同步（`scripts/sync-main.sh`）

### Changed

- (2026-07-08) `[docs]` 分支模型重构 — dev/preview/main 三层结构，废弃 release 分支，main 作为发布分支直接同步到 public 仓（`docs/workflows/branch-workflows.md`、`docs/workflows/release-guide.md`、`docs/workflows/worktree-setup.md`）
- (2026-07-08) `[docs]` README 预览图改为 `pic/overview.png`，移除 Contributing 中重复的中英文链接（`README.md`、`README_zh.md`）
