# 端口转发反向代理：`/proxy/{port}/{*path}`

> 状态：**P1-P3 已实施（2026-08-14）**；P4 安全加固（settings 表白名单 + UI 开关 + 按 session 授权 + 审计日志）留待后续，产出模糊且验收标准未覆盖，实施边界需另行确认
> 触发条件：修改 `src/proxy/`、`src/api/mod.rs`（路由挂载）、`src/main.rs`（`AppState`）、`frontend/vite.config.ts`（代理）、`frontend/src/utils/proxyUrl.ts`、终端/聊天链接重写逻辑中任一项前必读
> 关联：`docs/architecture/backend.md`、`docs/architecture/frontend.md`、`docs/reference/auth-not-enforced.md`（鉴权挂载）、`docs/dev/performance-and-safety.md` §P1/§P4（有界缓冲 / 外部输入速率）、`docs/reference/references.md`（code-server `proxy.ts` / jupyter-server-proxy 参考实现）

> **勘误（2026-08-14 实施偏差）**：
> 1. **路由形态**：D1 的 `/proxy/{port}` + `/proxy/{port}/{*rest}` 两条路由改为单一 `/proxy/{*path}` 通配符——axum 0.8 的 `{*rest}` 不匹配空剩余（`/proxy/3444/` 落空），单通配符统一解析端口 + 剩余路径更稳。
> 2. **WS 分流**：axum 0.8 的 `WebSocketUpgrade` 只实现 `FromRequestParts`、未实现 `OptionalFromRequestParts`，无法直接 `Option<WebSocketUpgrade>`——新增自定义 extractor `OptionalWebSocketUpgrade` 把 reject 折叠为 `None`。
> 3. **有界队列超限策略**：D5 的「满则丢最旧」改为「满则拒新数据 + warn」——丢最旧需独占 `Receiver` 做 `try_recv`，与写侧 `recv().await` 借用冲突；且拒新数据保留帧序（两者都是 §P1 允许的超限策略）。
> 4. **响应流式**：不用 reqwest `stream` feature（其引入 wasm-streams 依赖且当前环境联网受限），改用 `Response::chunk()` + `futures_util::unfold` 等价实现。

---

## 背景

**需求**：机器 A 通过 OmniTerm（跑在机器 B 上）访问机器 B 的 localhost 服务（如 `http://localhost:3000` 的 dev server）。用户在终端/聊天里点 `localhost` 链接时，浏览器 A 无法直达 B 的 `127.0.0.1:3000`——必须由 B 上的 Axum 后端做 server 端转发。

**可行性结论（已审查）**：可行，模式成熟（code-server / jupyter-server-proxy 已验证）。技术栈（Axum 0.8 + reqwest + 已有 WS 能力 + `require_auth_mw`）完全支持，依赖几乎零新增。核心风险按严重度：**安全（开放代理）＞ WS 双向 relay 工程复杂度 ＞ 路径前缀方案的绝对路径缺陷 ＞ 前端重写范围被高估**。

**对标参考**：
- code-server `src/node/proxy.ts`：子域名方案 + 完整 header/`Location` 重写 + WS relay。
- jupyter-server-proxy：路径前缀方案 + HTML/header 大量重写。

本计划采用**路径前缀**（`/proxy/{port}/`），接受绝对路径缺陷，用 `Location`/`Set-Cookie`/CSP 重写兜底。

---

## 范围与优先级

| 级别 | 目标 | 要点 | 预估 |
|---|---|---|---|
| P1 | HTTP 反向代理 | 路由 + handler + header 重写 + 端口白名单 + 流式转发 + 单测 | 覆盖约 80% 场景（静态下载、REST、SSE） |
| P2 | WebSocket relay | `tokio-tungstenite` 双向 relay + 有界队列 | Vite HMR 等依赖 WS 的 dev server |
| P3 | 前端入口 + 链接重写 | `proxyUrl.ts` + Chat `<a>` 拦截 + xterm `WebLinksAddon` handler | 端到端体验 |
| P4 | 安全加固 | 白名单提为 settings 表 + UI、按 session 授权、审计日志 | 公网部署 |

**P1 → P2 顺序强制**：HTTP 转发是 WS relay 的地基（同一路由分流）。P3/P4 相对独立。

### 不纳入范围（含理由）

| 排除项 | 理由 |
|---|---|
| **前端拦截 fetch/XHR** | 目标应用在 iframe/新标签里运行，其内部请求相对自身 origin 自动走代理，无需拦截。拦截需 Service Worker / monkey-patch，高成本且脆弱（奥卡姆剃刀） |
| **子域名方案**（`{port}.host`） | 需 wildcard DNS + wildcard TLS，部署复杂度显著上升。路径前缀对单端口 + 已有 auth cookie 场景是务实选择 |
| **iframe 内嵌**（P3 阶段） | 需剥离 `X-Frame-Options`/CSP `frame-ancestors`，引入安全权衡。MVP 用新标签页 |
| **代理到非本机 IP** | 目标 IP 永远硬编码 `127.0.0.1`。放行任意 IP 即成公网开放代理（SSRF/端口扫描/内网穿透），属安全红线，永不开 |
| **大文件流式上传** | MVP 请求体走 `Bytes` + `DefaultBodyLimit`（axum 默认 2MB）。静态下载/REST/SSE 响应方向为主，不受此限；上传留待后续 `Body` 流式提取 |

---

## 设计决策

### D1：路径前缀 `/proxy/{port}/{*path}`

**决策**：代理 URL 形态为 `http://omniterm-host/proxy/{port}/{剩余路径}`，目标 = `http://127.0.0.1:{port}/{剩余路径}?{原始 query}`。

**理由**：单端口穿透，无需额外开放业务端口；避免 wildcard DNS/TLS 复杂度。

**否决项**：套进 `/api/v1` 前缀下（`/api/v1/proxy/...`）。目标应用的绝对路径资源与 query 会与 `/api/v1` 冲突，且语义混乱。proxy 路由必须与 `/api/v1` **平级**挂载。

**已知缺陷（明确接受）**：目标应用内**硬编码绝对路径**的资源（Vite 的 `/@vite/client`、`/src/main.tsx`，Next.js 的 `/_next/...`）会绕过 `/proxy/{port}/` 前缀，直接请求 `omniterm-host/...` 而 404。用 `Location` 头重写 + 响应 HTML 内相对化兜底，但无法根治。**翻盘条件**：若用户反馈绝对路径应用不可用且影响面大，升级为子域名方案（引入 wildcard DNS/TLS）。

### D2：安全边界 —— 硬编码 127.0.0.1 + 端口白名单

**决策**：目标 IP 永远是字面量 `127.0.0.1`，**绝不从 path/header/query 解析任何地址**。端口白名单 = `3000..=65535` 范围 − 黑名单。

**黑名单两层**：
1. 常量表：数据库/内部服务端口——`3306`(MySQL)、`5432`(PostgreSQL)、`6379`(Redis)、`27017`(MongoDB)、`11211`(memcached)、`8500-8503`(Consul)、`9200-9300`(ES)。（这些都在 3000+ 段内，必须显式封。）
2. **运行时动态排除 OmniTerm 自身监听端口**（`args.port`，生产 9077 / preview 9075 / dev 9777）——防 `/proxy/{port}` 回环打 OmniTerm 自己造成无限转发。自身端口经 `AppState` 注入 proxy 模块。

**鉴权**：路由挂 `require_auth_mw`（auth 开启时）。auth 关闭 + 非回环监听时，依赖 `main.rs` 既有启动告警（`src/main.rs:760-768`），proxy 不额外处理。

**cookie 隔离**：请求转发时**剥离 OmniTerm 自己的 `omniterm_token`**（JWT 绝不泄漏给目标服务，S3/S4）。

**否决项**：默认全封、用户逐端口显式放行——更安全但多一步操作，与「本地开发工具」定位不符。留作 P4 可选项。

### D3：嵌入形态 —— MVP 新标签页

**决策**：重写后的 localhost 链接用 `window.open('/proxy/{port}/', '_blank')` 打开。

**理由**：免 `X-Frame-Options`/CSP 剥离的安全权衡，最简。

**否决项**：MVP 阶段就做 iframe 内嵌（需剥离响应安全头，且移动端体验差）。留作后续增强。

### D4：dev 流量 —— 相对路径 + Vite 代理

**决策**：前端重写生成**相对路径** `/proxy/{port}/...`（用 `window.location.origin`），dev 模式下 `vite.config.ts` 加一条 `/proxy` 代理到后端。

**理由**：
1. 前端零感知后端端口（符合 AGENTS.md「分支专属端口走 `.env.local`，不硬编码」）。
2. 同源 → `omniterm_token`（HttpOnly + SameSite=Lax）自动携带，`/proxy` 鉴权无缝。
3. 与现有 `/api` 代理模式一致（`vite.config.ts:32-38`），无新模式。

**否决项**：前端用绝对后端地址 `http://localhost:{BACKEND_PORT}/proxy/...`。会引入端口耦合 + 跨域 CORS + SameSite=Lax cookie 可能不带导致鉴权失败三个坑。

**注意**：`vite.config.ts` 的 `/proxy` 代理项必须 `ws: true`（P2 的 WS relay 依赖）。

### D5：有界缓冲（命中 §P1/§P4 红线）

| 方向 | 策略 |
|---|---|
| 请求体 | `Bytes` + `DefaultBodyLimit`（axum 默认 2MB 即是保护） |
| 响应体 | `Response::bytes_stream()` → `axum::Body::from_stream()`，**边读边写，绝不 collect 到内存**（SSE/长连接/大文件下载天然安全） |
| WS 消息队列 | 每方向 `mpsc::channel(64)` 有界，满则丢弃旧消息 + `warn`（上游推送速率不由我们决定，§P4） |

### D6：Header 重写表

**请求侧**（转发前）：

| Header | 处理 |
|---|---|
| `Host` | 重写为 `127.0.0.1:{port}` |
| `Connection`/`Keep-Alive`/`TE`/`Trailer`/`Upgrade` | **删除**（hop-by-hop，禁止透传） |
| `X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host` | 追加/重写为 OmniTerm 侧值 |
| `Origin` | WS 握手时重写为 `http://127.0.0.1:{port}`；普通 HTTP 默认保留 |
| `Cookie` | 透传但**剥离 `omniterm_token`** |

**响应侧**（回写前）：

| Header | 处理 |
|---|---|
| `Set-Cookie` | 重写 `Domain`/`Path`（去掉 `Domain=localhost`，`Path` 补 `/proxy/{port}` 前缀） |
| `Location` | 重写：绝对路径 `/x` → `/proxy/{port}/x`；`http://localhost:{port}/x` → `/proxy/{port}/x`；外部 `https://…` 保持不动 |
| `X-Frame-Options`/CSP `frame-ancestors` | MVP（新标签页）**不剥离** |
| `Content-Encoding`/`Content-Length` | `Content-Encoding` 原样透传（不解压再压）；流式转发时丢弃 `Content-Length` 改 chunked |
| hop-by-hop 响应头 | 删除 |

---

## 多实现差异（AGENTS §8）

反向代理的「协议」= HTTP/WS，被无数 dev server 实现满足。**不得以某一种（如 Vite）的行为推断全部**：

| 维度 | 差异 | 兜底 |
|---|---|---|
| 绝对路径资源 | Vite（`/@vite/client`、`/src/main.tsx`）、Next.js（`/_next/...`）用绝对路径；静态文件服务器常用相对路径 | `Location` 头重写 + 明确接受「绝对路径应用需配合 base path」的已知限制（D1） |
| WS 子协议 | Vite HMR 用 `vite-hmr`；Socket.IO 自定义；graphql-ws 用 `graphql-transport-ws` | **透传 `Sec-WebSocket-Protocol`**，不假设、不硬编码 |
| Origin 校验 | 部分 dev server（webpack-dev-server 等）严格校验 Origin；Vite 较宽松 | WS 握手统一重写 Origin 为 `http://127.0.0.1:{port}` 兜底 |
| Cookie 域 | 目标服务可能 `Set-Cookie` 带 `Domain=localhost` 或绝对 `Path` | 响应侧统一重写（D6） |

差异知识落地到 `docs/architecture/backend.md` 的 proxy 章节，不只留在代码注释。

---

## 实施分期

### Phase 1 — HTTP 反向代理

**产出**：`src/proxy/mod.rs`（路由 + handler + header 重写 + 白名单）+ 单测。

**改动文件**：
- `src/proxy/mod.rs`（新建）：
  - `pub fn routes(state: AppState) -> Router`：注册 `/proxy/{port}` 与 `/proxy/{port}/{*path}`，`axum::routing::any(proxy_handler)`，`.route_layer(require_auth_mw)`。
  - `async fn proxy_handler(...) -> Response`：`OriginalUri` 取未解码剩余路径（`strip_prefix("/proxy/{port}/")`），校验 port，reqwest 转发，`bytes_stream()` 回写。
  - 常量：`ALLOWED_PORT_RANGE = 3000..=65535`、`DENIED_PORTS` 表、自身端口排除逻辑。
  - header 重写函数（请求侧 `rewrite_request_headers` / 响应侧 `rewrite_response_headers`），独立纯函数便于单测。
- `src/api/mod.rs`：`routes()` 末尾 `.merge(proxy::routes(state.clone()))`（与 `/api/v1` 平级）。
- `src/main.rs`：`AppState` 增加 `proxy: proxy::ProxyState`（含 `client: reqwest::Client` 单例 + `self_port: u16`）；构造 `AppState` 时注入 `args.port`。
- `Cargo.toml`：`reqwest` 加 `stream` feature（`Cargo.toml:43`）。

**依赖关系**：Phase 1 独立，无前置。

### Phase 2 — WebSocket relay

**产出**：`src/proxy/ws.rs`（双向 relay）。

**改动文件**：
- `src/proxy/ws.rs`（新建）：`proxy_handler` 内 `Option<WebSocketUpgrade>` 为 `Some` 时分流——`on_upgrade` 后 `tokio_tungstenite::connect_async` 建立上游 WS，`tokio::select!` 竞跑两方向（`client→upstream` / `upstream→client`），任一 EOF/Close 终止整条 relay；每方向 `mpsc::channel(64)` 有界。
- `Cargo.toml`：新增 `tokio-tungstenite`（选与 tokio 1.43 兼容的最新稳定版）。

**依赖关系**：依赖 Phase 1 的路由骨架。

### Phase 3 — 前端入口 + 链接重写

**产出**：`frontend/src/utils/proxyUrl.ts` + 两个接入点。

**改动文件**：
- `frontend/src/utils/proxyUrl.ts`（新建）：`rewriteLocalUrl(raw: string): string | null`，匹配 `http(s)://(localhost|127.0.0.1|0.0.0.0):{port}` → `{origin}/proxy/{port}/...`。
- Chat 视图 `<a>` 点击拦截（事件委托）：命中本机 URL → `window.open(rewritten, '_blank')`。
- `frontend/src/hooks/useTerminal.ts`（`useTerminal.ts:458` 附近）：`WebLinksAddon` 传 `handler` 选项接管点击。**前置核实**：`@xterm/addon-web-links` 版本是否支持 `handler` 参数。
- `frontend/vite.config.ts`：加 `'/proxy': { target: http://localhost:${backendPort}, changeOrigin: true, ws: true }`。

**依赖关系**：依赖 Phase 1/2 后端就绪。

### Phase 4 — 安全加固

**产出**：白名单提为 settings 表 + UI 开关；按 session 授权（可选）；审计日志（S3：不落敏感 header/body）。

**改动文件**：`src/proxy/`（读 settings 表）、`src/api/settings.rs`（新增 proxy 开关端点）、前端 Settings 页。

**依赖关系**：依赖 Phase 1。

---

## 验收标准

**Phase 1（后端）**：
- [ ] `GET /proxy/3000/` 能转发到 `127.0.0.1:3000`，静态页面/JSON 正常返回。
- [ ] 白名单拒绝：端口 < 3000 或命中黑名单 → 403；`/proxy/3306/` → 403。
- [ ] 自身端口回环：`/proxy/{self_port}/` → 403（不无限转发）。
- [ ] 流式转发：SSE 端点逐块到达，不 collect（`bytes_stream` 单测断言无累积）。
- [ ] `Location` 重写：目标 302 `/x` → 响应 `Location: /proxy/3000/x`；外部 `https://…` 不动。
- [ ] `Set-Cookie` 重写：`Domain=localhost` 剥离、`Path` 补前缀。
- [ ] hop-by-hop 头剥离（`Connection`/`Upgrade` 等不泄漏）。
- [ ] cookie 隔离：转发请求不含 `omniterm_token`。
- [ ] 鉴权：auth 开启时未登录访问 `/proxy/...` → 401。
- [ ] 质量门禁：`cargo test` 通过、`cargo clippy` 零新增 warning、pre-commit 通过。

**Phase 2（WS）**：
- [ ] Vite HMR 经 `/proxy/3000/` 正常建立 WS、热更新生效。
- [ ] 任一方向关闭 → 整条 relay 干净终止（无泄漏连接）。
- [ ] 有界队列：上游高频推送不导致内存累积（单测）。

**Phase 3（前端）**：
- [ ] Chat 里点 `http://localhost:3000` 链接 → 新标签打开 `/proxy/3000/`。
- [ ] 终端里点 `localhost:3000` 链接 → 同样重写（若 `WebLinksAddon` 支持 handler）。
- [ ] `tsc` strict 零新增错误。

**边界与降级**：
- [ ] 目标端口无服务（连接拒绝）→ 502，前端有可读提示。
- [ ] 目标响应超时 → 504。
- [ ] 目标应用绝对路径资源 404（D1 已知限制）——记录而非阻塞。

---

## 风险与降级

| 风险 | 严重度 | 缓解/兜底 |
|---|---|---|
| 开放代理 / SSRF | **高** | D2 硬编码 127.0.0.1 + 端口白名单 + 动态排除自身端口 + 剥离 `omniterm_token`。**上线前必须单测守住** |
| WS 双向 relay 工程复杂度 | 中 | Phase 2 独立模块 `src/proxy/ws.rs`；复用 `futures-util` `StreamExt`/`SinkExt`；参考现有 `src/ws/terminal.rs` 的 WS 生命周期模式 |
| 绝对路径资源 404 | 中 | D1 `Location` 重写兜底；翻盘条件触发则升子域名 |
| 前端 `WebLinksAddon` 无 handler 支持 | 低 | 降级为「Chat 链接重写 + 终端仅默认打开」，终端重写留待 addon 升级 |
| 目标服务 Header 校验严格（Host/Origin 不匹配） | 低 | D6 header 重写表逐项覆盖，实测三种以上 dev server 验证 |

---

## 文档闭环

实施后需更新：
- `docs/architecture/backend.md`：新增 `/proxy/{port}/{*path}` 端点 + proxy 模块说明 + 多实现差异表。
- `docs/architecture/frontend.md`：新增 `utils/proxyUrl.ts` + 链接重写接入点。
- `docs/reference/references.md`：登记 code-server `proxy.ts` / jupyter-server-proxy 参考。
- `CHANGELOG.md`：新增功能条目（「新增 localhost 端口转发反向代理」）。
- `AGENTS.md` 文档索引：本计划登记行（触发条件指向 `src/proxy/` 等）。
- `docs/dev/debug-guide.md`：按需补「代理链路排查」模式（502/504/绝对路径 404 定位）。

---

## 术语表

| 术语 | 含义 |
|---|---|
| 反向代理 | 后端作为 HTTP client 转发浏览器请求到目标服务并回传响应 |
| 路径前缀方案 | 以 `/proxy/{port}/` 前缀区分不同目标端口 |
| 子域名方案 | 以 `{port}.host` 子域名区分目标端口（code-server 默认，本计划否决） |
| hop-by-hop 头 | 只对单跳连接有意义、不可跨代理透传的 Header（`Connection` 等） |
| WS relay | 浏览器 WS ↔ OmniTerm ↔ 目标 WS 的双向全双工转发 |
