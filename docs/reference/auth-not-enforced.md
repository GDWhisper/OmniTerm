# Auth 鉴权：从「实现未接入」到完整启用

> 类别：历史缺陷记录（已修复）
> 状态：✅ **已完整实现并接入**（2026-07-27 修复，见实施计划 `docs/dev/plans/archive/2026-07-27-auth-enforcement.md`）
> 发现日期：2026-07-09 · 重审：2026-07-27（RequireAuth 提取器 fallback bug）· 修复：2026-07-27
>
> ⚠️ 本文档早期版本描述「鉴权从未接入路由」——**该状态已修复**。下面的「历史缺陷」仅作为教训留存，**当前实现以「现状」章节为准**。

## 本文档的用途

1. 记录「安全机制实现后未接入链路」的教训（映射到 `docs/dev/performance-and-safety.md` §S5）。
2. 说明当前鉴权架构，供安全评审 / 修改鉴权代码 / 排查登录问题参考。

## 历史缺陷（2026-07-09 发现 → 2026-07-27 修复）

当初后端实现了 JWT 鉴权逻辑但从未接入路由，`/auth/check` 伪造返回，前端无登录 UI——整体「名义上有 auth、实际匿名可完全访问」。**教训：启用任何安全机制时必须验证它真正挂在链路上，而非只有定义处**（grep 确认 extractor/中间件被路由引用）。

## 当前实现（已生效）

### 后端

- **统一保护中间件** `require_auth_mw`（`src/auth/mod.rs`）：从 `State<AppState>` 读取 `jwt_secret`（无 extensions fallback）；master switch `state.auth_enabled`（`AtomicBool` 镜像 `settings.auth_enabled`，单次 relaxed load，**无每请求 DB round-trip**）。auth 关闭时全部路由放行。
- **路由挂载**（`src/api/mod.rs`）：
  - public：`/auth/setup`、`/auth/login`、`/auth/logout`、`/auth/check`（及 health 等）
  - protected：其余全部业务路由 + 三个 WS 路由（`/ws/terminal/*`、`/ws/terminal/external/*`、`/ws/acp/*`），经 `route_layer(middleware::from_fn_with_state(require_auth_mw))` 统一保护
  - WS 握手同样走中间件（请求头携带 cookie），无需 handler 内单独校验
  - **WS 入口 CSWSH 防护**（`src/ws/origin_guard.rs`，2026-09-26 起，四类入口共五条路径共用同一真源）：三个主 WS 入口 + 代理 WS relay（**路径前缀 `/proxy/{port}` 与子域名 `{port}.{base_host}` 两条路径都要**——后者绕过 `dispatch_proxy`，须在 `proxy_host_mw` 的 WS 分支内单独校验）在 `on_upgrade` 之前校验 **Origin 的 host 与请求 Host 一致**（均忽略端口，大小写不敏感），不一致 → `403 origin not allowed`。浏览器发起的 WS 握手必带 `Origin`，恶意页面 `new WebSocket()` 的 Origin host 必然不同于 OmniTerm 的 Host，故被封死（`SameSite=Lax` **不**防 WS 握手，这是独立于 cookie 策略的一道防线）。两条显式放行：**无 `Origin`**（curl / Node `WebSocket` / 原生客户端——CSWSH 只能由浏览器触发，`pty-*-regression.mjs` 等裸握手回归依赖这条）与**无 `Host`**（HTTP/1.1 规定必带，缺失即非浏览器流量）。畸形 Origin（无 scheme / 空 host 段）按拒绝处理，不放行。**代理层必须原样透传 `Host`**：`Host` 一旦被改写（nginx 默认 `proxy_set_header Host $proxy_host`、Vite `changeOrigin: true`），Origin 与 Host 必然不等 → 全部 WS 403，且该判据**无白名单逃生门**（与 CORS 不同）。dev 的 `frontend/vite.config.ts` 两条代理固定 `changeOrigin: false`，勿改回（2026-09-27 勘误，见安全加固计划）。
  - **CORS 收紧**（`src/ws/cors_policy.rs` + `src/main.rs::build_cors_layer`，2026-09-26 起）：取代 `CorsLayer::permissive()`（对所有来源回 `Access-Control-Allow-Origin: *`），改为**默认仅同源 + 显式 origin 白名单**。三条规则并集：无 `Origin` 放行（框架保证，`AllowOrigin::to_future` 的 `origin.filter(...)`）、**Origin host 与请求 Host 一致**放行（复用 WS 入口的 `origin_matches_host`，同一条判据不复制）、逐字命中 `OMNITERM_CORS_ALLOWED_ORIGINS` 放行。白名单**不推导、不兜底**（dev.sh 不 export `BACKEND_PORT`、dev 不传 `--proxy-domain`，后端推不出前端域），上限 32 条 × 256 字节；`X-Forwarded-Host` **不作判据**（CorsLayer 不读，且客户端可伪造）。方法与 header 集显式列白（不再 `Any`），否则跨源预检拿不到 `Access-Control-Allow-Methods`/`-Headers`，带 `content-type` 的 POST 会被浏览器拦在预检上。**反向代理改写 `Host` 时（nginx 默认 `proxy_set_header Host $proxy_host`）必须显式配白名单**，否则前端跨源读不到响应。**边界**：CORS 是「读取权」防线不是「执行权」防线（跨源简单请求在服务端照样执行），也**不能**替代 WS Origin 校验（WS 握手不受 CORS 约束）——详见 `docs/architecture/backend.md`「CORS 策略」。
- **`/auth/check`**（`src/api/auth.rs`）：真实校验本实例的 token cookie（名取自 `AppState.token_cookie`），返回 `{ authenticated, auth_enabled, needs_setup? }`；未启用时返回 `authenticated: true, auth_enabled: false`（同时返回 `needs_setup`，供设置页决定「开启密码验证」是弹新建密码表单还是验证既有密码）。**本地免密命中时**返回 `{ authenticated: true, auth_enabled: true, local_bypass: true }`，不读 cookie；该端点**不返回用户名**（公开端点不泄露账号名）。
- **用户名（2026-09-27 起）**：单账号可自定义标识（`users.username`，默认 `'admin'`，老库经 migration 自动获得），`setup` / `login` 均可传 `username`（缺省/空白 → `admin`，与「仅密码」时代脚本兼容），JWT `sub` 写当前用户名；`POST /auth/change-username`（受保护，需 `current_password`）改名并 `token_version + 1` 撤销旧 token。token 校验**不**比对 `claims.sub`——`ver` 已覆盖撤销语义（见计划 D1/D2）。
- **本地免密（`local_auth_required`，2026-09-27 起）**：`settings.local_auth_required` 默认 `"1"`（本地也校验，不默认弱化）。置 `"0"` 后，**四条件全真**才放行：① TCP 对端回环；② `Host` host 部分是回环字面量（`localhost` 忽略大小写/容忍尾点，或回环 IP）；③ `Origin` 缺失或其 host 部分是回环字面量；④ 无 `x-forwarded-for` / `x-forwarded-host` / `x-real-ip` / `forwarded` 任一代理头（任一存在 → 不放行）。任一不成立即走 token 校验（fail-closed）。判据集中在 `src/auth/local_access.rs::is_local_request`，由 `verify_request` 统一接线，覆盖 `require_auth_mw`（全部业务 + WS 路由 + 代理路径前缀）与 `proxy_host_mw`（子域形态；子域 Host 恒非回环 → 永不免密）。**已知边界**：① **`Host` 是客户端可控头**——条件 2 只对浏览器（无法在 URL 外自定义 Host）或「规范化 Host / 注入转发头」的中间层可靠；**原样透传客户端 Host 且不注入转发头**的同机代理（Vite dev `changeOrigin:false`、nginx `Host $http_host`、裸 TCP 转发、`ssh -R`）下，能自定 Host 的客户端（curl/脚本）可伪造回环 Host 命中免密（**2026-09-28 实测**，见计划 D3 勘误二）；Caddy 默认注入 `X-Forwarded-For`/`-Host`/`-Proto`，不受影响（条件 4 命中）；**Cloudflare Tunnel（cloudflared 2026.5.0）实测（2026-09-28，真实命名隧道打到本机回显服务）**：CF 边缘注入 `X-Forwarded-For`（客户端自带值被追加真实 IP，不可清除）+ `X-Forwarded-Proto` + `CF-Connecting-IP`，条件 4 必然命中；且伪造回环 `Host` 的请求在 CF 边缘被 **403 拒绝**（未到达源站）——该部署下两层防护均成立、不受误判影响；② 反代把 Host 改写为回环且不注入代理头同理不可区分（勘误一）；③ SSH 隧道（用户本人建立）与无 `Origin` 的非浏览器客户端命中免密属接受范围；④ 恶意网页 CSRF 由条件 3 挡（免密后不再有 cookie 兜底）；⑤ **本地免密命中 = 信任本机全部进程/账号**（含无凭据 `POST /auth/settings {auth_enabled:false}` 关闭总开关的能力）。缓解：让代理注入转发头（条件 4 生效），或不在「LAN/公网可达 + 透传 Host 的中间层」部署上关闭开关。**解析收紧（2026-09-28）**：`strip_port` 的方括号串只校验 `]` 之后为 `:数字`（或空），括号内容原样保留（`[localhost]` 亦按字面量返回、由调用方 `parse::<IpAddr>()` 判定）；畸形形态（如 `[::1]@evil.com`）原样返回并按解析失败处理（此前会截出 `::1` 被误判回环）——畸形 `Host`/`Origin` 一律按拒绝/非回环处理。**v4-mapped 边界**：`--host ::` 双栈下 v4 客户端的对端为 `::ffff:127.0.0.1`，std `is_loopback` 仅认 `::1` → 判非回环、本地免密不可用（刻意 fail-closed，无安全风险）。忘记密码时改密仍需 `current_password`（出路 `--reset-auth`）。
- **cookie 名与 JWT 密钥按实例隔离**（`src/main.rs` 的 `instance_id` / `instance_suffix` / `token_cookie_name` / `jwt_secret_file_name`）：实例身份取自生效 db 的文件名 stem，正式版得 `omniterm_token` + `~/.omniterm/jwt_secret`（历史名不变），dev/preview 得 `omniterm_token_dev` + `jwt_secret_dev` 等。**浏览器 cookie 不区分端口**，同 host 上并存多个实例（如本机 dev 9777 与正式版 9077）时必须各写各的键位——否则后登录者覆盖前者的 cookie，被覆盖方因 `token_version` 不匹配而 401，表现为「一边登录、另一边自动登出」；两者再共用签名密钥时，`ver` 巧合相等即串号登录。
- **登录限流** `LoginGuard`（`src/auth/rate_limit.rs`）：滑动窗口，单 IP 5 次失败 / 5 分钟触发 429，成功登录重置。**按 IP 记录表有界**（§P1）：tracked IP 数上限 `MAX_TRACKED_IPS`（4096），超限淘汰 least-recently-seen——淘汰只丢弃已滑出窗口、本就无价值的时间戳，不构成绕过（按 IP 限流之下轮换源 IP 本来就不在防护范围内）；更严格的「满了就拒绝一切新 IP」会把单次境外流量 burst 升级成 admin 无法登录，故不取。`is_blocked` 是纯查询，未出现过的 IP 不占槽（旧实现用 `entry().or_default()`，一次探测即插入）。IP 取自 `ConnectInfo` 的真实对端地址而非 `X-Forwarded-For`：反代部署下所有客户端共享反代 IP（更防伪造，但限流粒度退化为「全体共用一个配额」）。
- **启动安全**：监听非回环地址且 auth 关闭时**拒绝启动**（fail-closed，2026-09-26 起；`src/main.rs` `enforce_listen_auth` 四格真值表单测），显式逃生门 `--insecure-no-auth` / `OMNITERM_INSECURE_NO_AUTH`。此前仅打印高危警告（极易被忽略 = 默认裸奔），已升级为强制力；`OMNITERM_AUTH_ENABLED` 环境变量 / `--auth-enabled` 可强制开启。

### 前端

- 登录/setup 页：`frontend/src/components/Auth/AuthPage.tsx`
- 设置页开关与改密：`frontend/src/components/Settings/AuthSection.tsx`
- `frontend/src/App.tsx` 集成登录态判断；`api.client.ts` 提供 `setup / login / logout / check / setAuthSettings / changePassword`。

## 影响范围（当前）

| 维度 | 现状 |
|------|------|
| 路由保护 | ✅ 全部业务 + WS 路由经 `require_auth_mw` 保护（auth 启用时） |
| `/auth/check` | ✅ 真实校验 token；本地免密命中时返回 `local_bypass: true` |
| 前端登录 UI | ✅ AuthPage / AuthSection / App 集成（含用户名字段、本地校验开关、改用户名） |
| token 校验 | ✅ 从 state 读 jwt_secret，无 fallback bug；改名/改密/登出经 `token_version` 撤销 |
| 账号标识 | ✅ `users.username`（默认 `admin`）写入 JWT `sub`，可自定义（改名撤销旧 token） |
| 本地免密 | ✅ 四条件纯函数判据（`src/auth/local_access.rs`），默认关闭（`local_auth_required=1`） |
| 登录防爆破 | ✅ LoginGuard 限流 |
| WS CSWSH 防护 | ✅ 三主 WS 入口 + 代理 WS relay（路径前缀与子域名两条路径）统一 `origin_matches_host`（host 一致性比对；无 Origin / 无 Host 放行，畸形 Origin 403） |
| CORS 跨源读取 | ✅ 默认仅同源 + 显式白名单 `OMNITERM_CORS_ALLOWED_ORIGINS`（2026-09-26）；反代改写 `Host` 的部署需显式配置 |
| 高危暴露预警 | ✅ 非回环 + auth 关闭时**拒绝启动**（fail-closed，2026-09-26；逃生门 `--insecure-no-auth`） |

**注意**：`settings.auth_enabled` 默认关闭（本地开发便利）。部署到公网/不可信网络前必须开启密码验证（设置页开关，或 `OMNITERM_AUTH_ENABLED=1`）。若确需在可信内网以无鉴权方式监听非回环地址，2026-09-26 起必须显式传 `--insecure-no-auth`，否则后端拒绝启动。

## 相关文件

- `src/auth/mod.rs` — `create_token`（`sub` = 用户名）/ `verify_token` / `verify_request`（auth 总开关 → 本地免密 → token 三序判定）/ `require_auth_mw` / `extract_token`（按 `AppState.token_cookie` 精确匹配键位）/ `normalize_username`（用户名规范化单一真源）
- `src/auth/local_access.rs` — 本地免密判据（`is_local_request` 四条件 + `is_loopback_host`；后者与 `main.rs::enforce_listen_auth` 收敛共用）
- `src/auth/rate_limit.rs` — `LoginGuard` 登录限流
- `src/api/auth.rs` — `setup` / `login` / `logout` / `check` / `change-password` / `change-username` / `GET|POST auth/settings`
- `src/api/mod.rs` — 路由注册与 `require_auth_mw` 挂载
- `src/ws/origin_guard.rs` — WS 入口 CSWSH 校验收敛点（`enforce_ws_origin` / `origin_matches_host`），`src/proxy/mod.rs` 与三个主 WS 入口共用
- `src/ws/cors_policy.rs` — CORS 判据真源（同源/白名单/无 Origin 三规则并集，复用 `origin_matches_host`）+ 白名单解析上限
- `src/main.rs` — `build_cors_layer`（`--cors-allowed-origins` / `OMNITERM_CORS_ALLOWED_ORIGINS`）、`enforce_listen_auth`、`auth_enabled` 初始化；`instance_id` / `instance_suffix` / `token_cookie_name` / `jwt_secret_file_name`（cookie 名与密钥的实例隔离派生）
- `frontend/src/components/Auth/AuthPage.tsx`、`frontend/src/components/Settings/AuthSection.tsx`、`frontend/src/api/client.ts`
