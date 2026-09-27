# 账号登录增强（用户名）+ 本地免密访问（区分回环与远程）

> 状态：已实施（2026-09-27，待独立审查与真机验证）
> 触发条件：修改 `src/api/auth.rs`、`src/auth/*`、`src/main.rs` 的 auth 初始化、`users` 表结构、`frontend/src/components/Auth/*`、`frontend/src/components/Settings/AuthSection.tsx` 任一项前**必读**
> 关联：`docs/reference/auth-not-enforced.md`（鉴权现状，实施后回写）、`docs/dev/plans/2026-09-26-security-hardening-batch.md`（S1 fail-closed 与 D1/D3 判据先例）、`docs/dev/performance-and-safety.md` §S1-S5、`docs/workflows/subagent-code-review.md`
> 需求来源：用户 2026-09-27（① 账号登录增强，新增用户名；② 区分本地 127.0.0.1 与远程接入的校验，设置面板新增本地校验开关，关闭时本地免密、远程防线不变）

## 背景

现状（勘察于 2026-09-27，dev HEAD `1e7eb8e`）：

- `users` 表（`migrations/20260620_init.sql` + `20260731_add_token_version.sql`）：`id / password_hash / created_at / token_version`，**单用户**，bcrypt 哈希。
- 登录**仅密码**：`src/api/auth.rs` 的 `setup` / `login` 只收 `password`；`src/auth/mod.rs::create_token` 把 `Claims.sub` **硬编码为 `"admin"`**。
- `auth_enabled` 总开关（`settings` 表 + `AppState.auth_enabled: Arc<AtomicBool>`，`src/main.rs:865-881` 启动读取）：关闭时全放行（现状默认）。
- `require_auth_mw` 保护全部业务 + 三个 WS 路由（`src/api/mod.rs:46`）；`verify_request` 是共享校验真源，proxy 路径前缀（经同一中间件）与子域形态（`proxy_host_mw` 显式调用）都走它。
- 用户从**本机**与从**远程**访问，当前没有任何区分；`/auth/check` 也完全依赖 cookie。
- 既有先例可复用：`src/ws/origin_guard.rs` 的 `host_from_headers` / `strip_port` / `origin_matches_host`（Phase 2 收敛的 host 判据真源）、`src/main.rs::enforce_listen_auth` 的回环宿主判定（Phase 1，5 种宿主穷举）+ `--insecure-no-auth` 逃生门。

## 范围与优先级

| 级别 | 项 | 要点 |
|------|----|------|
| P0 | 用户名全链路 | migration 加列 → setup/login 带用户名 → JWT `sub` 写用户名 → 设置页改用户名（bump 撤销） |
| P0 | 本地免密 | 四条件纯函数判据（fail-closed）→ `verify_request` 接线（全部调用点）→ `/auth/check` → 设置读写 API → 设置面板开关 |
| P1 | 质量闭环 | 单测穷举、真机链路验证、独立子代理审查、文档回写、CHANGELOG |

### 不纳入范围（含理由）

- **多用户 / 多租户**：产品是单人工具（既定决策，见安全加固计划「不纳入范围」）。用户名是**单账号的可自定义标识**，不是第二账号。
- **用户名枚举防护的专门处理**：登录失败已统一 401 + 1s 延迟 + `LoginGuard` IP 限流，枚举成本与在线爆破同级，不另加措施。
- **改密码免验证路径**：本地免密命中时 `change-password` / `change-username` **仍要求 `current_password`**（语义一致、最小改动）。忘记密码的唯一出路仍是 `--reset-auth`（记录为已知边界）。
- **审计新增**：auth 设置变更不入 `audit_log`（与 `auth_enabled` 现状一致；`local_auth_required` 变更属安全敏感事件，列入后续批次，本次不做以免范围蔓延）。
- **密码强度策略 / 2FA / 会话管理重构**：与需求无关。

## 设计决策（ADR）

### D1 username 数据模型：单账号可自定义，默认 `admin`，只加列不改表

- **决策**：新 migration（**新增文件，勿改已有**，命名 `20260927_add_username.sql`）执行
  `ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT 'admin';`
  `SetupRequest.username: Option<String>`；缺省 / 空串 / 全空白 → `"admin"`。登录比对存储的 `username`（区分大小写）。
- **规范化（写入前，setup 与 change-username 同一函数，禁两处各写一份）**：`trim()` 后长度 `1..=32` 个字符；拒绝含控制字符（`char::is_control()`，含 `\n` `\t`）——不满足即 400。
- **兼容性**：老库（已 setup）经 migration 自动得 `'admin'`；老 API 调用方（脚本）不传 username 仍按 `"admin"` 比对 → 与现状等价，不打断自动化。
- **否决项**：① 多用户表（过度设计，需重做会话模型）；② 强制必填 username（打断脚本，且老库语义无从表达）；③ 大小写不敏感比较 / Unicode 归一化（额外规则无用户价值，登录页提示即可）；④ 用户名唯一索引（单行表，无意义）。
- **翻盘条件**：若未来支持多账号，`users` 表与 `Claims` 需整体重设计，届时回退本决策并重写 migration 链。

### D2 JWT `sub` 写用户名；改用户名沿用 `token_version` 撤销

- **决策**：`create_token(secret, ver, username)` 把 `sub` 写成用户名（不再硬编码 `"admin"`）。`POST /auth/change-username` 校验 `current_password` 后更新 `username` 并 `token_version + 1`，旧 token 全部立即失效（与 `logout` / `change-password` 同一机制）；前端改完引导重新登录。
- **理由**：`ver` 是单调递增的既有撤销原语，语义完全覆盖「改名后旧会话失效」；`sub` 只作为身份标记（当前无消费方，未来审计/多实例可读）。
- **否决项**：**不**在 `verify_token_for_state` 中比对 `claims.sub == users.username`——`ver` 已足够，多一层比对会让「改名」进每请求热路径，且与「改密」的撤销语义重复。
- **翻盘条件**：若未来出现「部分会话撤销」（多设备精细管理）需求，需引入 `jti`/会话表，届时 `sub` 校验才有独立价值。

### D3 本地免密判据：四条件纯函数，任一不成立即不放行（fail-closed）

`pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool` 为 `true` 当且仅当**四条全部成立**：

| # | 条件 | 判据 |
|---|------|------|
| 1 | TCP 对端是回环 | `peer.ip().is_loopback()`（覆盖 `127.0.0.0/8` 与 `::1`；`peer` 缺失 → false） |
| 2 | `Host` 头的 host 部分是回环字面量 | `strip_port` 去端口后：`localhost`（忽略大小写、容忍尾点）或可 `parse::<IpAddr>()` 且 `is_loopback()`（`[::1]` 去方括号）；缺失 / 非 UTF-8 / 畸形 → false |
| 3 | `Origin` 头缺失，或其 host 部分是回环字面量 | 解析方式与 `origin_matches_host` 一致（`split_once("://")` + 截断 `/?#` + `strip_port`）；`Origin: null` / 畸形 / 非回环 → false |
| 4 | 无代理转发头 | 不存在 `x-forwarded-for` / `x-forwarded-host` / `x-real-ip` / `forwarded`（任一存在 → false） |

- **威胁模型（为什么四条缺一不可，全部有真实穿透路径）**：
  1. **同机反代穿透（最重要）**：nginx `proxy_pass http://127.0.0.1:9777` 时后端看到对端 = `127.0.0.1`，仅凭条件 1 会让**公网用户全部免密**。条件 2 挡住「Host 被改写为域名」（`proxy_set_header Host $host`）；条件 4 挡住「Host 被改写为上游回环地址」——这正是 nginx **默认** `proxy_set_header Host $proxy_host` 的形态（Host 变成 `127.0.0.1:9777`）。
  2. **dev Vite 代理穿透**：dev 下浏览器请求经 Vite（同机）转发，后端一律看到对端 `127.0.0.1`——含局域网用户（`http://192.168.5.216:18778`）。条件 2 用 Host 判据挡住（LAN Host 非回环字面量），使「LAN 访问 dev 前端」仍要求密码。
  3. **恶意网页 CSRF**：免密后不需要 cookie，`SameSite=Lax` 不再提供保护。条件 3 挡住浏览器发起的跨站请求（`Origin: https://evil.com`）。**已知边界**：无 Origin 的顶层导航 / 非浏览器客户端（curl）不受条件 3 约束——那属「能连到回环的人本来就能访问本机服务」，接受并记录。
  4. **SSH 隧道**：`ssh -L 18778:localhost:18778 host` 后浏览器访问 localhost，四条全真 → 免密。判定为**可接受**（隧道由用户本人建立，语义上是「本机用户」）；记录为已知边界。
- **生效范围（调用点清单，缺一处 = 缺口）**：
  - `require_auth_mw`（`src/auth/mod.rs`）——覆盖全部业务路由 + 三个 WS 入口 + proxy 路径前缀形态（proxy 自己的 `route_layer` 复用同一函数）。
  - `proxy_host_mw` 的显式 `verify_request` 调用（`src/proxy/mod.rs`，子域形态）。子域 Host 为 `{port}.{domain}`，恒非回环 → 子域访问永远不免密（记录边界）。
  - `/auth/check`（`src/api/auth.rs`）——命中免密时 `authenticated: true`，否则按 cookie 判定。
- **判定与响应不复制**：判据集中在 `src/auth/local_access.rs`（新模块）；Host/Origin 的 host 提取复用 `crate::ws::origin_guard`（若需新增 `origin_host` 纯函数，就地提取并让 `origin_matches_host` 同步改用，**不得留第二份解析**）；「字符串是否回环宿主」须与 `src/main.rs::enforce_listen_auth` 的既有判定**收敛为同一函数**（`main.rs` 改调用它，Phase 1 的四格单测保持全绿）。
- **否决项**：① 仅凭对端 IP（反代 / Vite 双重穿透）；② 信任 `X-Forwarded-For` 判客户端地址（可伪造，红线）；③ 要求 Host 端口 == 后端端口（dev Vite 跨端口会误伤本机用户）；④ 静态 Origin 白名单（回环形态动态、无法枚举，且回环字面量判定已覆盖）。
- **翻盘条件**：出现无法用 Host/Origin 表达的接入形态（如 unix socket / 自定义 mTLS）时，在同一纯函数内补条件并穷举单测；若条件 4 的启发式误伤真实用户（如本机透明代理注入 XFF），评估改为「仅当条件 2/3 无法判定时才参考」并记录。

#### D3 勘误（2026-09-27，实施时由后端子代理指出，编排确认属实）

**原文论据有误**：初稿称条件 4（无代理转发头）能挡「nginx 默认 `proxy_set_header Host $proxy_host`」形态。实际 **nginx 默认不注入任何转发头**（默认只重写 `Host` 与 `Connection`；`X-Forwarded-For` / `X-Real-IP` 均需显式配置才出现），故该形态下条件 4 不生效。

**真实边界（必须披露，不可宣称已完全防住）**：同机反代 + 把 Host 改写为**回环地址**（nginx 默认 `$proxy_host` 恰为 `127.0.0.1:<upstream_port>`）+ **未注入任何转发头**时，远程流量在应用层与「本机浏览器直连」**不可区分**：

- 带 `Origin` 的请求（同源 POST/PUT/DELETE、WS 握手、SSE）仍被条件 3 挡住；
- **无 `Origin` 的同源 GET 与顶层导航会命中免密**（浏览器导航与同源 GET 不发 `Origin`），即远程浏览器可完整免密进入。

这是**拓扑的本质限制**，不是实现缺陷：应用层没有任何信号能区分「本机浏览器」与「同机反代的转发」。可行的缓解（择一即可关闭攻击面）：

1. 让代理注入转发头（`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 等，属反代标准配置）→ 条件 4 生效；
2. 不在反代部署上开启本地免密（开关默认关闭 = 保持校验，用户主动承担风险才开启）。

**处置**：判据保持四条件不变（对直连 LAN、cloudflared、子域形态、Vite dev 的 LAN 访问、配置了转发头的反代均正确）；UI 关闭态 hint 追加**反代提示文案**（本机运行反代时须确认注入转发头）；`auth-not-enforced.md` 同步记录；审核子代理独立复核该结论。

### D4 开关语义与默认值：`local_auth_required` 默认 `"1"`（本地也校验，不搞默认弱化）

- **决策**：`settings` 表新 key `local_auth_required`（`"1"` = 本地访问同样需要密码，**默认**；`"0"` = 本地免密）。镜像为 `AppState.local_auth_required: Arc<AtomicBool>`（仿 `auth_enabled`），启动读、改设置时原子更新，热路径单次 relaxed load、无 DB 往返。
- **与 `auth_enabled` 的关系**：`auth_enabled=false` 时全局放行（现状不变，`local_auth_required` 无效果）；仅当 `auth_enabled=true` 时它决定本地是否免密。两开关独立存储、独立更新。
- **否决项**：① 默认 `"0"`（静默削弱既有部署的安全姿态）；② 合并进 `auth_enabled` 三态枚举（语义正交，迁移复杂）；③ 免密命中时跳过 `auth_enabled` 判断（顺序必须是：总开关关闭 → 全放行；否则才看本地免密）。
- **翻盘条件**：若用户反馈「升级后本地还要登录很烦」且愿意接受默认弱化，可改为 UI 首次引导；不改默认值本身。

### D5 API 形状：设置口部分更新 + 只读口 + check 增字段

| 方法/路径 | 鉴权 | 请求 | 响应/行为 |
|---|---|---|---|
| `POST /api/v1/auth/setup` | public | `{ username?: string, password: string }` | 创建用户（username 缺省 → `"admin"`）；已存在 → 409 |
| `POST /api/v1/auth/login` | public | `{ username?: string, password: string }` | 用户名 + 密码均须匹配；失败统一 401（1s 延迟 + 限流计次） |
| `POST /api/v1/auth/change-username` | protected | `{ current_password: string, new_username: string }` | 校验密码 → 更新 username + `token_version+1` → `{ok:true}`；格式非法 400，密码错 401 |
| `GET /api/v1/auth/settings` | protected | — | `{ auth_enabled: bool, local_auth_required: bool, username: string \| null }`（无用户行 → null） |
| `POST /api/v1/auth/settings` | protected | `{ auth_enabled?: bool, local_auth_required?: bool }` | 部分更新（两项都缺 → 400）；落库 + 更新 AtomicBool |
| `GET /api/v1/auth/check` | public | — | 增可选字段 `local_bypass?: bool`（命中免密时为 true）；命中时 `authenticated: true` |

- **否决项**：① `change-username` 独立限流器（复用 `LoginGuard` 即可，密码校验是同一暴力面）；② check 返回 username（公开端点不泄露账号名）；③ `POST /auth/settings` 保持全量语义并拆新路由（读写口应同源）。
- **翻盘条件**：若前端出现「保存设置时互相覆盖」的竞态（两个开关分别提交），改为单次提交两项；当前 UI 一次只动一个开关，部分更新语义足够。

## 实施分期

| Phase | 承担 | 产出 | 依赖 |
|---|---|---|---|
| 1 后端 | 子代理 A（并行） | migration + `models/user.rs` + `auth/local_access.rs`（判据+单测）+ `auth/mod.rs`（token/verify/中间件）+ `api/auth.rs`（5 处 handler）+ `main.rs`（读取/字段）+ proxy 调用点 + backend.md 回写 | 契约（本文 D1-D5） |
| 2 前端 | 子代理 B（并行） | `client.ts`（5 个 API）+ `AuthPage.tsx`（用户名字段）+ `AuthSection.tsx`（本地校验开关 + 改用户名区块）+ 双 locale + 组件测试 | 契约（本文 D5） |
| 3 集成 | 编排 | 全量门禁（fmt/clippy/cargo test/tsc/lint/vitest）+ 契约一致性核对 + 分组提交 | 1+2 |
| 4 审查与真机 | 编排 + 独立子代理 | T1 审查（加挂安全/前端/测试）→ 逐条处置 → T3 复查 → 独立实例真机链路验证 | 3 |
| 5 闭环 | 编排 | CHANGELOG / auth-not-enforced.md / AGENTS.md 索引 / user-testing.md → 合并回 dev → 清理 worktree | 4 |

## 关键契约（实现细节，子代理以此为准）

### 数据与设置

- migration：`migrations/20260927_add_username.sql`，**唯一语句** `ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT 'admin';`（SQLite 支持带默认值的 ADD COLUMN）。
- settings key：`local_auth_required`，取值 `"1"` / `"0"`；读取处 `src/main.rs`（与 `auth_enabled` 同段，缺失默认 `true`）；写入处 `src/api/auth.rs::set_auth_settings`。
- `AppState`：新增 `pub local_auth_required: Arc<AtomicBool>`；`src/test_utils.rs::test_state()` 同步补默认值（`true`，即默认安全姿态）。

### 判据模块 `src/auth/local_access.rs`（新）

```rust
/// 四条件全真才返回 true（见计划 D3）。纯函数，无 I/O。
pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool

/// Host/Origin 的 host 部分是否为回环字面量（localhost 忽略大小写、容忍尾点；IP 字面量 is_loopback）。
pub fn is_loopback_host(host: &str) -> bool   // 对 strip_port 后的输入
```

- `peer` 取自中间件的 `request.extensions().get::<ConnectInfo<SocketAddr>>()`（`main.rs` 已挂 `into_make_service_with_connect_info`）；**extensions 缺失 → `None` → 不放行**（fail-closed，覆盖测试脚手架等未注入形态）。
- `is_loopback_host` 与 `enforce_listen_auth` 收敛共用（后者改为调用它；`--insecure-no-auth` 四格单测必须保持全绿、断言不动）。
- 单测（表驱动，§P1 之外的穷举要求）：四条件组合（对端 × Host × Origin × 代理头，至少含「全真」「对端非回环」「Host 域名」「Host 缺失」「Origin 跨站」「有 XFF」六类关键反例）+ Host 形态（`localhost` / `LOCALHOST` / `localhost.` / `127.0.0.1:18777` / `127.0.0.2` / `[::1]:18777` / `::1` / `0:0:0:0:0:0:0:1` / `example.com` / 空串）+ `Origin: null` / 畸形 Origin / IPv6 Origin。

### `verify_request` 签名（唯一共享校验）

```rust
pub async fn verify_request(
    state: &AppState,
    token: Option<&str>,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<(), StatusCode>
```

顺序：`auth_enabled` 关 → `Ok`；`local_auth_required` 关 且 `is_local_request` 命中 → `Ok`；否则验 token。`require_auth_mw` 与 `proxy_host_mw` 各自提取 `ConnectInfo` 与 `&HeaderMap` 传入（**两个调用点都要改**，grep 确认无第三处）。

### 用户名规范化（单一函数）

`fn normalize_username(raw: &str) -> Result<String, ()>`（或等价的 400 分支）：`trim()`；`1..=32` 字符；无控制字符。setup / change-username / 前端校验三处语义一致（后端为权威）。

### 前端契约

- `client.ts`：`setup(username, password)`、`login(username, password)`、`changeUsername(currentPassword, newUsername)`（`noAuthRedirect: true`）、`getAuthSettings()`、`setAuthSettings({ auth_enabled?, local_auth_required? })`（旧调用点 `setAuthSettings(false)` 需同步改）。
- `AuthPage.tsx`：登录态与 setup 态都渲染用户名字段（setup 预填 `admin`；登录态 placeholder 提示默认 `admin`）；提交前 trim；disabled 条件含 username。
- `AuthSection.tsx`：auth 开启后新增「本地访问校验」`ToggleRow`（关闭为危险态 dangerHint，文案说明「仅本机 127.0.0.1/localhost 免密，远程仍需密码」）；新增「修改用户名」区块（当前密码 + 新用户名，校验后调 API，成功后提示需重新登录并本地登出）；两 locale 同步加 key。
- i18n：`frontend/src/locales/{en,zh}/translation.json`，键名 `auth.*` 命名空间（两位 locale 键完全一致）。

## 验收标准 / 验证清单

- [ ] `cargo test local_access`：四条件穷举 + Host/Origin 形态全过
- [ ] `cargo test`（workspace 全量）：含既有 auth / enforce_listen_auth 测试零回归
- [ ] `cargo fmt --all` / `cargo clippy --quiet --workspace --all-targets -- -D warnings` 零新增
- [ ] 前端 `pnpm exec tsc -b` / `pnpm lint` / `pnpm test` 全绿；新增组件测试覆盖用户名提交与开关切换
- [ ] 真机（独立实例，隔离端口 + 独立 db）：`Host: 127.0.0.1` 无 token → 200（免密）；`Host: 192.168.x.x` → 401；带 `X-Forwarded-For` → 401；`Origin: https://evil.com` → 401；`local_auth_required=1` 时本地 → 401
- [ ] WS 链路：本地免密可完成握手与数据帧；远程形态 401
- [ ] 用户名：setup 自定义 → 用新用户名登录成功 / 用 `admin` 失败；不传用户名回退 `admin`；改用户名后旧 token 401
- [ ] 独立子代理审查（T1 + 加挂 B/D/E）通过（blocker/major 全部处置）
- [ ] 文档回写：auth-not-enforced.md / backend.md / frontend.md / AGENTS.md 索引 / CHANGELOG.md / user-testing.md

## 风险与文档闭环

| 风险 | 缓解 |
|------|------|
| 反代默认配置（`Host $proxy_host`）导致免密穿透 | 条件 2 + 条件 4 双挡；文档写明「反代部署下若出现免密穿透，检查 Host 改写与代理头」；用户可关开关兜底 |
| 免密使 CSRF 防线从「cookie 缺失」退化为「Origin 判定」 | 条件 3 覆盖浏览器跨站请求；已知边界（无 Origin 导航）写入文档；用户可关开关 |
| 老库升级后用户不知道用户名是 `admin` | 登录页 placeholder + 文档 + CHANGELOG 说明；setup 页预填 |
| 忘记密码 + 本地免密 → 改密需 current_password | 记录为已知限制（出路：`--reset-auth`）；不新增免密改密路径（避免范围蔓延） |

实施后须更新：`docs/reference/auth-not-enforced.md`（现状表 + 本地免密小节 + 相关文件）、`docs/architecture/backend.md`（API 端点表、settings key、判据收敛点、CLI/env 无新增）、`docs/architecture/frontend.md`（Auth 组件登记）、`AGENTS.md`（文档索引登记本计划）、`CHANGELOG.md`（Added：用户名 + 本地免密开关）、`docs/reference/user-testing.md`（手动用例 + 边界）。

---

## 实施记录（2026-09-27，编排 + 两个并行子代理）

**实施方式**：临时 worktree `~/coding/OmniTerm-auth`（分支 `feat/auth-username-local-bypass`），两个子代理并行——后端子代理只碰 Rust 与后端文档、前端子代理只碰 `frontend/`（文件域不重叠），编排负责契约（本文档）、集成、提交、派发独立审查。

**后端产出（子代理 A）**：
- `migrations/20260927_add_username.sql`（新增，唯一语句 `ALTER TABLE ... DEFAULT 'admin'`）
- `src/auth/local_access.rs`（新增：`is_local_request` 四条件 + `is_loopback_host` + 14 个单测）
- `src/auth/mod.rs`（`normalize_username` / `normalize_username_or_default` / `DEFAULT_USERNAME` / 设置 key 常量 / `create_token` 写 `sub` / `verify_request` 三序判定 / `require_auth_mw` 提取 `ConnectInfo`；11 个单测）
- `src/api/auth.rs`（setup/login 用户名、`change_username`、`GET|POST /auth/settings` 部分更新、`check` 本地命中 + `local_bypass`；9 个 handler 级测试）
- `src/models/user.rs`、`src/main.rs`（启动读 `local_auth_required`、`AppState` 字段、`enforce_listen_auth` 收敛到 `is_loopback_host`）、`src/test_utils.rs`、`src/ws/origin_guard.rs`（抽取 `origin_host` 共享解析）、`src/proxy/mod.rs`（子域调用点接线 + 调用点级测试）

**前端产出（子代理 B）**：`client.ts`（5 个 API + `DEFAULT_USERNAME` + `AuthSettings` 类型）、`AuthPage.tsx`（用户名字段）、`AuthSection.tsx`（本地校验开关 + 改用户名 + 设置镜像 effect）、双 locale 各 +12 键、`AuthPage.test.tsx` + `AuthSection.test.tsx`（11 例）。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **`is_loopback_host` 接受原始 host 文本**（自带端口/方括号容错），而非仅接受已 `strip_port` 的输入：否则 `enforce_listen_auth` 的 `0:0:0:0:0:0:0:1`（未压缩 IPv6）会被 `split(':')` 截断成 `0` 而误判为非回环。
2. **启动脏值策略比计划更严**：DB 值仅字面量 `"0"` 关闭本地校验，其余（缺失 / 脏值）一律按 `true`（fail-closed）。
3. **`src/ws/origin_guard.rs` 就地抽取 `origin_host`**（计划允许）：`origin_matches_host` 同步改用，Origin 解析保持单一真源，既有 18 例全绿。
4. **额外补两个调用点级测试**（`require_auth_mw` 与 `proxy_host_mw` 走真实 Router）：针对「判据共享 ≠ 调用点覆盖」的历史教训。
5. **前端改用户名成功提示走 App 级 toast**（而非区块内文案）：改名会立即本地登出切到登录页，区块提示不可见；toast 在登录页可见。
6. **前端「重新开启密码验证」路径先 `GET /auth/settings` 取当前用户名再登录**：否则自定义用户名的账号会因默认 `admin` 而 401（子代理自查发现的真实边界）；失败回退 `DEFAULT_USERNAME`。
7. **审计 actor 前缀保持固定 `admin`**（编排裁决）：`users.username` 是可改展示名，写进 actor 无区分度且会让历史记录前缀漂移；`src/api/audit.rs` 的过时注释（「`sub` 恒为 admin」）已按事实修正。若后续需要「用户名 + IP」联合区分，属独立项。
8. **UI 关闭态文案追加反代提示**（编排在集成时补）：见 D3 勘误的边界披露（中英同步）。

**门禁（子代理各自实跑）**：
- 后端：`cargo fmt --all -- --check` OK；`cargo clippy --quiet --workspace --all-targets -- -D warnings` 零告警；`cargo test --workspace` = bin 664 passed / 0 failed（1 ignored 预存在）+ 集成 8 + 2 passed；定向：`local_access` 14、`auth::tests` 11、`api::auth::tests` 9、`enforce_listen_auth` 4（断言未动）、proxy 调用点 1。
- 前端：`pnpm exec tsc -b` exit 0；`pnpm lint` 0 error（18 warning 全为既有文件）；`pnpm test` 80 文件 / 841 用例全绿（新增 11）。
