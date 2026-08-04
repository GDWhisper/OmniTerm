# Auth 鉴权：从「实现未接入」到完整启用

> 类别：历史缺陷记录（已修复）
> 状态：✅ **已完整实现并接入**（2026-07-27 修复，见实施计划 `docs/dev/plans/2026-07-27-auth-enforcement.md`）
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
- **`/auth/check`**（`src/api/auth.rs`）：真实校验 `omniterm_token` cookie，返回 `{ authenticated, auth_enabled, needs_setup? }`；未启用时返回 `authenticated: true, auth_enabled: false`。
- **登录限流** `LoginGuard`（`src/auth/rate_limit.rs`）：滑动窗口，单 IP 5 次失败 / 5 分钟触发 429，成功登录重置。
- **启动安全**：监听非回环地址且 auth 关闭时打印高危警告（`src/main.rs`）；`OMNITERM_AUTH_ENABLED` 环境变量 / `--auth-enabled` 可强制开启。

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
| 高危暴露预警 | ✅ 非回环 + auth 关闭时启动警告 |

**注意**：`settings.auth_enabled` 默认关闭（本地开发便利）。部署到公网/不可信网络前必须开启密码验证（设置页开关，或 `OMNITERM_AUTH_ENABLED=1`）。

## 相关文件

- `src/auth/mod.rs` — `create_token` / `verify_token` / `require_auth_mw` / `extract_token`
- `src/auth/rate_limit.rs` — `LoginGuard` 登录限流
- `src/api/auth.rs` — `setup` / `login` / `logout` / `check` / `protected_routes`
- `src/api/mod.rs` — 路由注册与 `require_auth_mw` 挂载
- `src/main.rs` — `auth_enabled` 初始化与启动警告
- `frontend/src/components/Auth/AuthPage.tsx`、`frontend/src/components/Settings/AuthSection.tsx`、`frontend/src/api/client.ts`
