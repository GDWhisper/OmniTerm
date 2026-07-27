# Auth 鉴权强制实施计划

> 状态：已实施（2026-07-27）
> 触发条件：重审 `docs/reference/auth-not-enforced.md`，确认所有问题仍然成立，且 `RequireAuth` 提取器存在实现 bug（`extensions.get::<String>()` 永取不到 `jwt_secret`）
> 关联：`docs/reference/auth-not-enforced.md`（现状文档，实施后替换为本计划）
> 索引：`docs/reference/auth-not-enforced.md` → 本计划 → 实施后更新 `CHANGELOG.md`

---

## 1. 背景

### 1.1 现状摘要（2026-07-27 重审）

| 维度 | 07-09 报告 | 07-27 重审 |
|------|-----------|-----------|
| 路由保护 | 全部未挂载鉴权 | **不变** |
| `RequireAuth` | 定义后未被使用 | **不变**（仍带 `#[allow(dead_code)]`） |
| `verify_token` | 仅 `RequireAuth` 内部调用 | **不变**（仍带 `#[allow(dead_code)]`） |
| `/auth/check` | 伪造返回 `authenticated: true` | **不变** |
| 前端 | client 方法未被调用 | **不变**（全前端零引用） |
| `RequireAuth` 实现 bug | 未发现 | **新增发现**：`extensions.get::<String>()` 永拿不到 `jwt_secret`，永远走 fallback 硬编码 |

### 1.2 死代码关联

`RequireAuth` / `verify_token` 是 `docs/dev/plans/backlog/dead-code-triage.md` 中的 #1 / #2。本计划实施后两者**接线**，`#[allow(dead_code)]` 随之移除。

### 1.3 风险

- 若部署公网/不可信网络，匿名可操作终端与文件系统，属高危
- 本地单用户暂无明显风险，但功能链路不完整，将来需要时需补

---

## 2. 方案概要

分两阶段，**Phase 1 后端强制鉴权 → Phase 2 前端登录 UI**。建议两阶段一起做完——单独的 Phase 1 会让前端出现无登录入口时直接白屏（无 `authenticated` 状态处理）。

### 设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 用 `from_fn_with_state` 中间件，**不修** `RequireAuth` 提取器 | 中间件在路由层统一保护，避免逐个 handler 改签名；提取器 `FromRequestParts` 难以干净访问 `AppState` |
| 2 | 路由分 public / protected 两组，`.route_layer` 加中间件 | cleaner：公共路由不需个别跳过 |
| 3 | WebSocket 握手走中间件保护 | WS 握手时中间件即检查 cookie/Bearer，无效返回 401，不浪费资源建连接 |
| 4 | `/auth/check` 永远 200，仅返回 `authenticated` / `needs_setup` | 避免 401 暴露路由被保护的事实（side channel）；前端据此决定展示设置密码还是登录 |
| 5 | 前端 AuthPage 为全屏覆盖（unauthenticated 时），非 sidebar popup | popup 依赖 sidebar 按钮定位，unauthenticated 时 Layout 未挂载 sidebar |
| 6 | Cookie 仅 `same_site: Lax`，满足同站使用 | 无需 XSRF token |
| 7 | `Authorization: Bearer` 支持仅在后端（中间件 + check），前端不走 | cookie 自动携带，更简单 |

---

## 3. Phase 1 — 后端强制鉴权

### 3.1 `src/auth/mod.rs` — 新增 `require_auth_mw` 中间件

```rust
pub async fn require_auth_mw(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_token(&req).ok_or(StatusCode::UNAUTHORIZED)?;
    verify_token(&state.jwt_secret, &token).map_err(|_| StatusCode::UNAUTHORIZED)?;
    Ok(next.run(req).await)
}

fn extract_token(req: &Request) -> Option<String> {
    // 1. Cookie: omniterm_token=<value>
    if let Some(cookie) = req.headers().get("cookie")
        .and_then(|v| v.to_str().ok())
    {
        for pair in cookie.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair.strip_prefix("omniterm_token=") {
                return Some(value.to_string());
            }
        }
    }
    // 2. Authorization: Bearer <token>
    if let Some(auth) = req.headers().get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(auth.to_string());
    }
    None
}
```

**注意**：这里**复制**了 `verify_token` 调用，而 `RequireAuth` 提取器不做修复也不做删除——它在 dead-code triage #1 中标记，本次接线后 `#[allow(dead_code)]` 应移除，但 `RequireAuth` struct 本身的 `#[allow]` 也应清理。但我们不用它做鉴权，保留给将来用（如果将来有 handler 级鉴权需求）。最终判断：`verify_token` 被中间件接线 → 移除其 `#[allow(dead_code)]`；`RequireAuth` 未被接线 → 保留 `#[allow(dead_code)]`，但在 triage 文档中标记 "有意保留（预留 handler 级鉴权）"。

### 3.2 `src/api/mod.rs` — 路由分组

```rust
use axum::middleware;

pub fn routes(state: AppState) -> Router {
    let public = Router::new()
        .merge(health::routes())
        .merge(auth::routes());

    let protected = Router::new()
        .merge(system::routes())
        .merge(targets::routes())
        .merge(projects::routes())
        .merge(sessions::routes())
        .merge(hooks::routes())
        .merge(files::routes())
        .merge(files_watch::routes())
        .merge(git::routes())
        .merge(agents::routes())
        .route("/ws/terminal/{session_id}", axum::routing::get(ws::ws_terminal_handler))
        .route("/ws/terminal/external/{tmux_name}", axum::routing::get(ws::ws_external_terminal_handler))
        .route("/ws/acp/{session_id}", axum::routing::get(ws::ws_acp_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth_mw));

    Router::new()
        .nest("/api/v1", public.merge(protected))
        .with_state(state)
}
```

### 3.3 `src/api/auth.rs` — 修正 `check`

```rust
async fn check(
    State(state): State<AppState>,
    jar: CookieJar,
) -> impl IntoResponse {
    let token = jar.get("omniterm_token").map(|c| c.value().to_string());

    let authenticated = token
        .as_ref()
        .map(|t| auth::verify_token(&state.jwt_secret, t).is_ok())
        .unwrap_or(false);

    if authenticated {
        return Json(json!({ "authenticated": true }));
    }

    let needs_setup = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0) == 0;

    Json(json!({
        "authenticated": false,
        "needs_setup": needs_setup,
    }))
}
```

### 3.4 清理死代码标记

| 符号 | 文件 | 处置 |
|------|------|------|
| `verify_token` | `src/auth/mod.rs:24` | 移除 `#[allow(dead_code)]`（被中间件接线） |
| `RequireAuth` | `src/auth/mod.rs:34` | 保留 `#[allow(dead_code)]`，改注释为 "有意保留：预留 handler 级鉴权" |
| dead-code-triage | `docs/dev/plans/backlog/dead-code-triage.md` | #1 标记接线、#2 标记保留 |

---

## 4. Phase 2 — 前端登录流

### 4.1 数据流

```
App.mount
  └─ useEffect → POST /api/v1/auth/check
       ├─ 200 { authenticated: true }  → Layout
       └─ 200 { authenticated: false }
            ├─ needs_setup: true  → AuthPage (setup mode)
            └─ needs_setup: false → AuthPage (login mode)
```

### 4.2 `frontend/src/stores/appStore.ts` — 加 auth 状态

```ts
// 新增字段
authState: 'loading' | 'authenticated' | 'unauthenticated'
setAuthState: (state: AppState['authState']) => void

// 初始化
authState: 'loading',

// Action
setAuthState: (authState) => set({ authState }),
```

### 4.3 `frontend/src/App.tsx` — 启动检查

```tsx
useEffect(() => {
  api.auth.check()
    .then((res) => {
      if (res.authenticated) setAuthState('authenticated')
      else setAuthState('unauthenticated')
    })
    .catch(() => setAuthState('unauthenticated'))
}, [])

// 渲染：
// authState === 'loading' → 空白（或 splash 文字）
// authState === 'unauthenticated' → <AuthPage />
// authState === 'authenticated' → <Layout />
```

### 4.4 `frontend/src/components/Auth/AuthPage.tsx` — 密码页

- 全屏居中，复用项目 pixel 视觉风格（`.panel-title-bar`、羊皮纸背景、`corner-nails`）
- 两种模式（自动检测）：
  - **setup**（`needs_setup`）：title = "SET PASSWORD"，单次输入
  - **login**（已有人）：title = "LOGIN"，输错显示提示
- 提交流程：
  1. 用户输入密码 → 提交
  2. setup 模式：`POST /auth/setup` → 200 设 `authState = 'authenticated'`
  3. login 模式：`POST /auth/login` → 200 设 `authState = 'authenticated'`
  4. 401 / 409 → 提示错误（登录下为 "wrong password"，setup 下 409 则切换到 login 模式）

```tsx
interface AuthPageProps {
  needsSetup: boolean
  onAuthenticated: () => void
}
```

### 4.5 `frontend/src/api/client.ts` — 401 拦截

```ts
// request() 中：
if (res.status === 401) {
  const authState = useAppStore.getState().authState
  if (authState === 'authenticated') {
    useAppStore.getState().setAuthState('unauthenticated')
  }
  const body = await res.json().catch(() => ({}))
  throw new ApiError(401, body, body.error || 'Unauthorized')
}
```

### 4.6 `frontend/src/components/Settings/AuthSection.tsx` — 设置面板登出

- 在 Settings 面板加一个 section（参考 `ToggleRow` 模式）：
  - 显示 "LOGGED IN"
  - 按钮：`LOGOUT`（调用 `POST /auth/logout` → `setAuthState('unauthenticated')`）
- 在 Settings `CATEGORIES` 中新增 `general` category，包含此 section

### 4.7 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `frontend/src/components/Auth/AuthPage.tsx` | **新建** | 密码页组件 |
| `frontend/src/stores/appStore.ts` | 修改 | 加 `authState` + `setAuthState` |
| `frontend/src/App.tsx` | 修改 | 启动时 auth check + 条件渲染 |
| `frontend/src/api/client.ts` | 修改 | `request()` 401 拦截 |
| `frontend/src/components/Settings/AuthSection.tsx` | **新建** | 设置面板登出 section |
| `frontend/src/components/Settings/Settings.tsx` | 修改 | 加入 AuthSection |
| `frontend/src/locales/en/translation.json` | 修改 | 加 i18n key |
| `frontend/src/locales/zh/translation.json` | 修改 | 加 i18n key |

### 4.8 不做

- 忘记密码 / 密码重置
- 多用户管理
- 密码强度校验（长度检查仅前端，后端接受任何 bcrypt 加密后字节）
- `Authorization: Bearer` 客户端注入（cookie 自动携带够用）
- WebSocket URL token 参数（cookie 在握手时自动携带）

---

## 5. 验证清单

### 5.1 后端
- [ ] `pnpm build`（前端） + `cargo build`（后端） 无编译错误
- [ ] `cargo test` 全部通过
- [ ] `cargo clippy` 无新增警告（`#[allow(dead_code)]` 是否已清理）
- [ ] 不带 cookie 访问 `GET /api/v1/projects` → 401
- [ ] 不带 cookie 访问 `GET /api/v1/health` → 200（不受保护）
- [ ] `POST /api/v1/auth/setup` 设密码 → 200 + set-cookie
- [ ] 带 cookie 访问 `GET /api/v1/projects` → 200
- [ ] `POST /api/v1/auth/login` 正确密码 → 200 + set-cookie
- [ ] `POST /api/v1/auth/login` 错误密码 → 401
- [ ] `POST /api/v1/auth/setup` 再次调用 → 409
- [ ] `GET /api/v1/auth/check`（无 cookie）→ `{ authenticated: false, needs_setup: false }`
- [ ] `GET /api/v1/auth/check`（无 cookie，DB 无用户）→ `{ authenticated: false, needs_setup: true }`
- [ ] `GET /api/v1/auth/check`（有 cookie）→ `{ authenticated: true }`
- [ ] WebSocket 握手无 cookie → 401（不建连接）

### 5.2 前端
- [ ] 首次访问 → 全屏密码页（setup 模式）
- [ ] 设置密码 → 进入主界面
- [ ] 刷新 → 无需重新登录（cookie 仍有效）
- [ ] 登出 → 回到登录页
- [ ] 登录 → 进入主界面
- [ ] 错误密码 → 错误提示
- [ ] 401 拦截：cookie 失效后 API 调用自动跳回密码页

---

## 6. 文档更新

| 文档 | 操作 |
|------|------|
| `docs/reference/auth-not-enforced.md` | **替换**为简短摘要 + 指向本计划 |
| `docs/architecture/backend.md` | 补充 §API Endpoints 的安全属性说明 |
| `docs/architecture/frontend.md` | 补充 AuthPage 组件 + authState 流 |
| `docs/dev/plans/backlog/dead-code-triage.md` | #1 标记接线，#2 标记保留 |
| `CHANGELOG.md` | 实施后追加 entry |

---

## 7. 技术债 / 后续改进（P2，不在本范围）

- `RequireAuth` 提取器：若将来有 handler 级鉴权需求，需先修复其 secret 获取方式
- 密码复杂度 + 最小长度校验（后端）
- 密码修改功能
- session 过期前端提示（而非默默 401）
- 移动端 AuthPage（当前仅覆盖桌面）
