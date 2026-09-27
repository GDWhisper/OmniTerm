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
  - **WS 入口 CSWSH 防护**（`src/ws/origin_guard.rs`，2026-09-26 起，四类入口共五条路径共用同一真源）：三个主 WS 入口 + 代理 WS relay（**路径前缀 `/proxy/{port}` 与子域名 `{port}.{base_host}` 两条路径都要**——后者绕过 `dispatch_proxy`，须在 `proxy_host_mw` 的 WS 分支内单独校验）在 `on_upgrade` 之前校验 **Origin 的 host 与请求 Host 一致**（均忽略端口，大小写不敏感），不一致 → `403 origin not allowed`。浏览器发起的 WS 握手必带 `Origin`，恶意页面 `new WebSocket()` 的 Origin host 必然不同于 OmniTerm 的 Host，故被封死（`SameSite=Lax` **不**防 WS 握手，这是独立于 cookie 策略的一道防线）。两条显式放行：**无 `Origin`**（curl / Node `WebSocket` / 原生客户端——CSWSH 只能由浏览器触发，`pty-*-regression.mjs` 等裸握手回归依赖这条）与**无 `Host`**（HTTP/1.1 规定必带，缺失即非浏览器流量）。畸形 Origin（无 scheme / 空 host 段）按拒绝处理，不放行。
  - **CORS 收紧**（`src/ws/cors_policy.rs` + `src/main.rs::build_cors_layer`，2026-09-26 起）：取代 `CorsLayer::permissive()`（对所有来源回 `Access-Control-Allow-Origin: *`），改为**默认仅同源 + 显式 origin 白名单**。三条规则并集：无 `Origin` 放行（框架保证，`AllowOrigin::to_future` 的 `origin.filter(...)`）、**Origin host 与请求 Host 一致**放行（复用 WS 入口的 `origin_matches_host`，同一条判据不复制）、逐字命中 `OMNITERM_CORS_ALLOWED_ORIGINS` 放行。白名单**不推导、不兜底**（dev.sh 不 export `BACKEND_PORT`、dev 不传 `--proxy-domain`，后端推不出前端域），上限 32 条 × 256 字节；`X-Forwarded-Host` **不作判据**（CorsLayer 不读，且客户端可伪造）。方法与 header 集显式列白（不再 `Any`），否则跨源预检拿不到 `Access-Control-Allow-Methods`/`-Headers`，带 `content-type` 的 POST 会被浏览器拦在预检上。**反向代理改写 `Host` 时（nginx 默认 `proxy_set_header Host $proxy_host`）必须显式配白名单**，否则前端跨源读不到响应。**边界**：CORS 是「读取权」防线不是「执行权」防线（跨源简单请求在服务端照样执行），也**不能**替代 WS Origin 校验（WS 握手不受 CORS 约束）——详见 `docs/architecture/backend.md`「CORS 策略」。
- **`/auth/check`**（`src/api/auth.rs`）：真实校验本实例的 token cookie（名取自 `AppState.token_cookie`），返回 `{ authenticated, auth_enabled, needs_setup? }`；未启用时返回 `authenticated: true, auth_enabled: false`（同时返回 `needs_setup`，供设置页决定「开启密码验证」是弹新建密码表单还是验证既有密码）。
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
| `/auth/check` | ✅ 真实校验 token |
| 前端登录 UI | ✅ AuthPage / AuthSection / App 集成 |
| token 校验 | ✅ 从 state 读 jwt_secret，无 fallback bug |
| 登录防爆破 | ✅ LoginGuard 限流 |
| WS CSWSH 防护 | ✅ 三主 WS 入口 + 代理 WS relay（路径前缀与子域名两条路径）统一 `origin_matches_host`（host 一致性比对；无 Origin / 无 Host 放行，畸形 Origin 403） |
| CORS 跨源读取 | ✅ 默认仅同源 + 显式白名单 `OMNITERM_CORS_ALLOWED_ORIGINS`（2026-09-26）；反代改写 `Host` 的部署需显式配置 |
| 高危暴露预警 | ✅ 非回环 + auth 关闭时**拒绝启动**（fail-closed，2026-09-26；逃生门 `--insecure-no-auth`） |

**注意**：`settings.auth_enabled` 默认关闭（本地开发便利）。部署到公网/不可信网络前必须开启密码验证（设置页开关，或 `OMNITERM_AUTH_ENABLED=1`）。若确需在可信内网以无鉴权方式监听非回环地址，2026-09-26 起必须显式传 `--insecure-no-auth`，否则后端拒绝启动。

## 相关文件

- `src/auth/mod.rs` — `create_token` / `verify_token` / `require_auth_mw` / `extract_token`（按 `AppState.token_cookie` 精确匹配键位）
- `src/auth/rate_limit.rs` — `LoginGuard` 登录限流
- `src/api/auth.rs` — `setup` / `login` / `logout` / `check` / `protected_routes`
- `src/api/mod.rs` — 路由注册与 `require_auth_mw` 挂载
- `src/ws/origin_guard.rs` — WS 入口 CSWSH 校验收敛点（`enforce_ws_origin` / `origin_matches_host`），`src/proxy/mod.rs` 与三个主 WS 入口共用
- `src/ws/cors_policy.rs` — CORS 判据真源（同源/白名单/无 Origin 三规则并集，复用 `origin_matches_host`）+ 白名单解析上限
- `src/main.rs` — `build_cors_layer`（`--cors-allowed-origins` / `OMNITERM_CORS_ALLOWED_ORIGINS`）、`enforce_listen_auth`、`auth_enabled` 初始化；`instance_id` / `instance_suffix` / `token_cookie_name` / `jwt_secret_file_name`（cookie 名与密钥的实例隔离派生）
- `frontend/src/components/Auth/AuthPage.tsx`、`frontend/src/components/Settings/AuthSection.tsx`、`frontend/src/api/client.ts`
