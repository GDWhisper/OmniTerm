# Auth 验证未生效（半成品 / 死代码）

> 类别：已知缺陷（待正规开发流程处理）
> 状态：已确认，未修复
> 发现日期：2026-07-09

## 摘要

后端实现了完整的 JWT 鉴权逻辑（`src/auth/mod.rs`），但**从未接入路由保护层**，且 `/auth/check` 端点伪造返回值；前端虽写了 `auth` 的 API 客户端方法，但**没有任何页面或组件调用**，也没有登录/设置密码/登出 UI。整体处于"名义上有 auth、实际匿名可完全访问"的状态。

## 触发条件（何时读本文档）

- 评估安全模型、部署到公网前的安全评审
- 规划"登录页 / 设置密码 / 登出"等前端功能
- 排查"为什么没有登录也能用所有功能"类问题
- 准备把 auth 真正启用时的改造方案设计

## 现状明细

### 1. 后端 `RequireAuth` 定义后从未被使用

- `src/auth/mod.rs:38` 实现了 `RequireAuth` 提取器，会校验 `omniterm_token` cookie / `Bearer` header。
- 全仓库 grep `RequireAuth` 仅命中定义处，**无任何路由处理器 `use` 它**。
- `src/api/mod.rs` 中 `targets` / `projects` / `sessions` / `files` / `files_watch` / `ws` 等路由**全部未挂载 `RequireAuth`**，handler 签名中也没有该参数。
- 后果：**匿名用户可直接调用所有业务 API、读写文件系统、创建 tmux 会话、连 WebSocket 终端**，鉴权形同虚设。

### 2. 后端 `/auth/check` 返回伪造值

- `src/api/auth.rs:108` 的 `check` 处理器**无条件**返回 `{ authenticated: true }`，不校验请求是否携带合法 token。
- 该端点无法用于前端判断登录态。

### 3. 前端仅有 client 方法，无 UI 调用

- `frontend/src/api/client.ts:134-139` 实现了 `auth.setup / login / logout / check`。
- 全前端 grep 确认：无组件调用 `api.auth.*` / `useAuth` / `authClient` 等；无登录页、设置密码页、登出入口。
- 前端不会在启动后调用 `check`、不会发起登录、不会处理 401。

### 4. 校验逻辑本身正确（可复用）

- `src/auth/mod.rs` 的 `create_token` / `verify_token` 实现正确，token 通过 cookie（`omniterm_token`，http_only，24h）下发与读取逻辑也完整。问题仅在"未被挂载使用"。

## 影响范围

| 维度 | 现状 |
|------|------|
| 路由保护 | ❌ 所有业务/文件/WS 路由均未挂载鉴权，匿名可访问 |
| `/auth/check` | ❌ 伪造返回 `authenticated: true`，无实际校验 |
| 前端登录 UI | ❌ 仅有 client 方法，无页面/组件/状态/拦截器调用 |
| token 校验逻辑 | ✅ `verify_token` 正确，但无人调用 |

- 若当前部署在公网/不可信网络，**任何人都可未经授权操作终端与文件系统**，属高危。
- 本地/受信任网络单用户使用暂无明显风险，但功能链路不完整。

## 修复方案（建议，交由正规开发流程细化）

### 后端
1. 将 `RequireAuth`（或 `axum::middleware::from_extractor::<RequireAuth>`）挂到除 `health`、`auth/setup`、`auth/login` 之外的所有 `/api/v1` 路由，作为统一保护层。
2. 修正 `check`：真实校验当前请求的 token，未携带/无效返回 `401` + `authenticated: false`。
3. WebSocket 终端路由（`/ws/terminal/*`）需单独在 handler 内校验 token（WS 握手阶段取 cookie/query，无法走 `RequireAuth` 提取器）。

### 前端
1. 启动时调用 `auth.check` 判断登录态；未登录则展示登录/设置密码页（首次为 setup，之后为 login）。
2. 新增登录页、设置密码页、登出入口（建议放入 `components/Auth/` 或 `Settings/`）。
3. 封装 `request` 拦截：遇到 `401` 自动跳转登录页。
4. 在 `appStore` 或独立 `authStore` 维护登录态。

### 注意（项目约束）
- 端口/域名/版本等分支专属变量走 `.env.local`，勿硬编码。
- 涉及前端架构模式（新增页面/状态栏）前，先读 `docs/architecture/frontend-patterns.md` 与 `docs/visual-design/ui-style-guide.md`。
- 改动后端分层时遵守 `docs/architecture/backend.md`；新增 API 端点需同步更新该文档的端点列表。

## 相关文件

- `src/auth/mod.rs` — JWT 创建/校验 + `RequireAuth` 提取器
- `src/api/auth.rs` — `setup` / `login` / `logout` / `check` 路由
- `src/api/mod.rs` — 路由注册（未挂载鉴权）
- `frontend/src/api/client.ts` — 前端 auth API 客户端（未被调用）
