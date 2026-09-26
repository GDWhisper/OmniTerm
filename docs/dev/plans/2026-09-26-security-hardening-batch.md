# 安全加固批次：fail-closed 监听 / WS Origin 收敛 / CORS 收紧 / 审计日志 / 端点限流

> 状态：**Phase 1–4 已实施（2026-09-26）**；Phase 5（S6 限流评估）待实施
> 触发条件：修改 `src/main.rs`（启动校验 / CORS layer）、`src/ws/terminal.rs` 与 `src/ws/acp.rs`（WS 入口）、`src/api/mod.rs`（路由挂载）、`src/api/files.rs` / `src/api/git.rs`（审计与限流触点）、新增审计表 migration 前**必读**
> 来源：`docs/dev/plans/archive/2026-09-01-improvement-directions.md` 2026-09-26 复审——该盘点的安全项 S1/S3/S5/S6 未落地、S2 半落地，本计划承接剩余部分
> 关联：`docs/reference/auth-not-enforced.md`（鉴权现状表，本计划落地后须回写）、`docs/architecture/backend.md`（分层约定）、`docs/dev/performance-and-safety.md` §P1（审计表上限）、`docs/dev/plans/2026-08-13-port-forward-proxy.md`（P4 安全加固与 Origin 先例）

## 背景

2026-09-01 改进方向盘点（已归档）把「安全欠账」列为 P0：不做会限制部署场景。2026-09-26 逐项复审源码确认以下欠账仍在：

| # | 缺口 | 现状证据 | 危害 |
|---|------|----------|------|
| S1 | 非回环监听 + 鉴权关闭 = 默认裸奔 | `src/main.rs:1035-1043` 仅 `tracing::warn!`，无强制力；无 `--insecure-no-auth` 逃生门 | 用户误配 `0.0.0.0` + 未开 auth 时，任何能访问端口的人完全控制本机（执行任意命令、读全部文件），且警告极易被忽略 |
| S2' | 主 WS 入口无 Origin 校验 | `src/api/mod.rs:39-44` 三个入口（`ws_terminal_handler` / `ws_external_terminal_handler` / `ws_acp_handler`）不做校验；代理入口 `src/proxy/mod.rs:158-187` 已有 `origin_matches_host` 但未收敛复用 | 恶意网页可跨站建立 WS（CSWSH），借受害者的已登录会话驱动终端/agent |
| S3 | CORS 全放开 + 无 CSRF 断言 | `src/main.rs:987` `CorsLayer::permissive()` | 当前仅依赖 SameSite=Lax 单点防御，浏览器策略变化即失效 |
| S5 | 敏感操作无审计 | git push（`src/api/git.rs:234`）、文件写/删/上传（`src/api/files.rs:805/595/502`）、agent 配置变更（`src/api/agents.rs:77/119/172`）均无留痕；代理入口无「开通」原子事件可插（`src/proxy/mod.rs:124` catch-all） | 多设备/误操作/被入侵后无法回答「谁动了什么」；port-forward 计划 P4 的审计待办一直未做 |
| S6 | 重端点无限流 | `src/auth/rate_limit.rs` `LoginGuard` 只覆盖登录面（IP+失败计次语义） | **已确认 files/git/agents/settings/sessions 全在 `require_auth_mw` 保护下**（`src/api/mod.rs:26-45`）；真正无保护的是 `proxy::routes()`（`:51`，与 `/api/v1` 平级）与 `agent_events`（public 组，靠回环+会话 token） |

分级口径沿用原盘点：**P0 = 信任基座**。S1 是其中仍存在的**最高危单点**（原盘点判断，复审确认未变）。

## 范围与优先级

| 阶段 | 方向 | 目标 | 预估 |
|------|------|------|------|
| Phase 1 | S1 fail-closed | 消灭「默认裸奔」，保留显式逃生门 | 小（半天） |
| Phase 2 | S2' 主 WS Origin 校验 | 与代理入口收敛为同一共享校验 | 小（半天） |
| Phase 3 | S3 CORS 收紧 | 从 permissive 改为白名单（从 `.env.local` 派生 + 代理子域通配），dev 路径已实测不走跨端口 CORS | 中（1 天） |
| Phase 4 | S5 审计日志 | 敏感操作留痕 + 有界表 + 设置页可查 | 中（1–2 天） |
| Phase 5 | S6 端点限流 | 先出评估结论（目标端点已确认在 auth 保护下）→ 若成立抽共享 `SlidingWindow` 实施 | 中（1 天，**先评估再实施**） |

### 不纳入范围（含理由）

- **OAuth/多用户体系**：产品是单人工具，多租户是过度设计（沿用原盘点结论）。
- **WAF 级防护**：交给反代层，宿主部署方案另见 D2（部署标准化 backlog）。
- **auth 机制本身改造**（默认开启、会话管理等）：属 `docs/reference/auth-not-enforced.md` 既有决策范畴，本文只做「auth 关闭时不许裸奔」的强制，不改变 auth 语义。
- **前端改造以外的即时通讯安全**（如 CSP 头）：与本文同一批次但耦合度低，列为 backlog 候选，不在本计划 Phase 内。

## 设计决策（ADR）

### D1 启动期校验必须是纯函数 + bail!，不做运行时开关

- **决策**：把校验提炼为 `fn enforce_listen_auth(listen_host: &str, auth_enabled: bool, insecure_no_auth: bool) -> anyhow::Result<()>`（源码内联文档写清四格真值表），放在 `daemon_notify_ready` 之前、`bind` 计算之后调用；失败 `anyhow::bail!`。纯函数便于穷举单测，且天然适配前台/daemonize 两路（daemonize 后 stderr 重定向到日志，但 `daemon_notify_fail`（`src/main.rs:575-590`）会把错误原文回传终端，`bail!` 上抛后由 `src/main.rs:1102-1104` 触发，两路可见）。
- **否决项**：① 运行时动态升降校验（监听地址运行中不变，无意义）；② 只升级 warning 为 error 日志（不阻止启动 = 无强制力，正是现状问题）；③ 把 flag 传进 `AppState` 持久化（启动期校验一次即可，持久化会引入「重启后逃生门丢失/残留」语义）。
- **翻盘条件**：若未来支持运行中改监听地址，校验须移入 listener 建立前；若 `--insecure-no-auth` 被大量自动化脚本依赖导致事故，改为「逃生门也需二次确认」。
- **逃生门命名**：`--insecure-no-auth`（可抄 `auth_enabled` 的 `num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool_flag` 风格，env 名 `OMNITERM_INSECURE_NO_AUTH`）。

### D2 WS Origin 校验：复用 `origin_matches_host`，共享函数沉淀到 ws 模块

- **决策**：把 `src/proxy/mod.rs:174-188` 的 `origin_matches_host` 提升为共享（如 `src/ws/mod.rs` 或 `src/utils/`，按 backend.md 分层择一），三个主 WS 入口在 `on_upgrade` 前调用：无 `Origin` 头放行（非浏览器客户端，CSWSH 只能由浏览器触发——与代理入口现行语义一致），有但 host 不匹配 → `403 origin not allowed`。
- **否决项**：① 静态 Origin 白名单比对（代理子域名场景下 host 动态 = 端口，白名单不可枚举；host 一致性比对已覆盖该场景）；② 无 Origin 一律拒绝（会打死 curl/原生 WS 客户端与 hook 类调用）。
- **翻盘条件**：若未来前端部署域与 API 域分离且非子域同 host 模式，改回显式白名单（需同时改代理入口，届时两处一起改）。
- **注意**：`ws_external_terminal_handler` 是外部会话接管入口，同样必须校验（它甚至不需要 DB 记录，风险更高）。

### D3 CORS 收紧：默认仅同源，白名单从 `.env.local` 派生

- **决策**：`CorsLayer::permissive()`（`src/main.rs:999`，生产与 dev 同一条路径、无 dev_mode 分支；层顺序为 `proxy_host_mw`(仅 base_host 配置时，最外层) → TraceLayer → **CorsLayer** → Router/fallback，即 CORS 层包住全部 OmniTerm 自身端点但**不包**子域反代流量）替换为「默认仅同源；允许集合从 `.env.local` 派生 + 显式 origin 白名单」。`tower-http` 的 `cors` feature 已在 `Cargo.toml:22`（`tower-http 0.6.11`）→ 不引入新依赖。
- **dev 路径已实测确认（2026-09-26）**：dev 前端与后端端口不同，但 `/api` 与 `/proxy` 均走 vite proxy 同源中转（`frontend/vite.config.ts:34-46`，`ws: true`），且前端**全部网络调用为相对路径**（`frontend/src/api/client.ts:4` `BASE = '/api/v1'`、`useTerminal.ts:394` WS 相对路径、`useAcpChat.ts:766` 用 `window.location.host`、`useFileWatcher.ts:57` SSE 相对路径）→ **dev 期不产生跨端口 CORS 请求**，收紧不打断 `dev.sh` 与 WS 链路。
- **边界声明（勿合并）**：CORS 收紧**不能**替代 S2 —— WebSocket 握手不受 CORS 约束，CSWSH 面必须由 Phase 2 的 WS Origin 校验独立防。S3 与 S2 是两条独立防线。
- **否决项**：① 白名单硬编码端口/域名（违反配置统一管理红线——端口名已在 AGENTS.md 点名禁硬编码）；② 仅加注释不动代码；③ 后端直读 `.env.local` 文件（违反「后端只认 `OMNITERM_*` env 或 CLI 参数」红线，且 release 二进制工作目录不可控）。
- **翻盘条件**：若未来前端与 API 非子域同 host 部署，白名单须显式包含该集合并沉淀进 `.env.local` 注释。

#### D3 实施前勘察校正（2026-09-26，读 tower-http 0.6.11 源码 + 全前端请求面）

1. **原 D3 的「代理子域 `{port}.{base_host}` 通配」在当前拓扑下是死配置**：子域流量被最外层 `proxy_host_mw`（`src/proxy/mod.rs:240`，先于 CorsLayer）拦截，**根本不到 CorsLayer**。该通配唯一真实用途是「将来前端部署在子域而 API 在别的 host」，保留但须注明当前不可达。
2. **`X-Forwarded-Host` 不能作主判据**：CorsLayer 不读它，OmniTerm 自身也不读（全仓仅 proxy 转发侧出现）；且它可被客户端伪造——不校验反代链路就信任它 = 把白名单拱手让给攻击者。这也解释了 Phase 2 为何不用它。
3. **反代部署是唯一真实风险面，可能硬打破**：nginx 默认 `proxy_set_header Host $proxy_host` 会把 Host 改成上游名 ⇒ omniterm 看到 `Host: omniterm:9777`，而浏览器 `Origin: https://example.com` ⇒ 同源判定失败被拒。须用户显式 `proxy_set_header Host $host;` 才不打破（有 `X-Forwarded-Host` 也没用，CorsLayer 不读）。兼容优先级：**① 显式 origin 白名单（首选，`.env.local` 派生）② 「Origin host == Host host」predicate 与白名单取并集（次选，闭包内同时实现两判据——tower-http 无法直接并集两种策略，但一个 `predicate` 闭包可以）③ X-Forwarded-Host 仅作可选信任项且默认关闭**。
4. **风险等级比预期低（一条重要事实）**：`permissive()` 不含 credentials ⇒ 现状下 `Access-Control-Allow-Origin: *` 且无 `Access-Control-Allow-Credentials` ⇒ 浏览器跨源请求**本来就带不了 cookie**。故 S3 不是「从能用到不能用」的断裂，而是「从对任何人可读到只对同源可读」；对 cookie 鉴权行为的改变为零。（同时说明现状对无自定义头的跨站简单请求防护薄弱，收紧确实缩小攻击面。）
5. **端口推导不可行**：`dev.sh:361` 只以 CLI 参数传 `-p`，**不 export `BACKEND_PORT`**，后端读不到 `FRONTEND_PORT`；`DOMAIN` 虽 export 但 dev 不传 `--proxy-domain`（`src/main.rs:144-145` 字段存在、dev.sh 无传入链）⇒ dev 环境 `base_host = None`、`proxy_host_mw` 不挂。白名单**不能**靠推算，必须显式新变量（如 `OMNITERM_CORS_ALLOWED_ORIGINS`），fallback 为「空集合 / 仅同源」，**不得写死域名兜底**。
6. **验收清单需补**（本文「实施分期」表 Phase 3 行）：nginx `proxy_set_header Host $host` 反代后跨源被拒 / 显式配 origin 后放行两态实测；同源放行不回归（embedded 形态 + 移动端）。单测放 `src/main.rs` `#[cfg(test)]`（CORS 构造成纯函数，仿 `enforce_listen_auth` 穷举）；`strip_port` 可按 §7① 从 `src/ws/origin_guard.rs` 提升共享。

### D4 审计日志：独立有界表 + 写入点收敛，不做 JSON 大列

- **决策**：新建 `audit_log` 表（迁移按 `migrations/20260913_add_config_options_snapshot.sql` 的注释风格写清列语义；**新增文件，勿改已有 migration**），列至少含 `id / actor / action / target / detail_json / created_at`；写入点收敛为一个审计函数（禁止各 handler 各写各的——§7① 同一判断多处出现）；**上限按 §P1 红线**：条目数 + 单条 detail 字节数双上限（条目超限滚动删最旧，detail 超限截断并**显式标注省略量**且按字符边界切），并配单测（含守恒断言）。读取口走 settings 页（只读最近 N 条）。
- **已确认写入点（2026-09-26 勘察，精确行号）**：
  - 文件写/删/上传：`src/api/files.rs:805` `write_file`（三分支：绝对路径直写 / `allow_escape` / 受限）、`:595` `delete_file`、`:502` `upload_file`
  - git push：`src/api/git.rs:28` 路由 → `:234` `git_push` handler（**强推**：`repo::push` 未见 `--force` 参数，强推语义须实施时确认是否需单独分流）
  - agent 配置变更：`src/api/agents.rs:19-22` 路由 → `:77 create_agent` / `:119 update_agent` / `:172 delete_agent`
  - **落差（须显式记录）**：代理端口**没有「开通」原子事件**——`src/proxy/mod.rs:124` 只有一个 catch-all `/proxy/{*path}`（dispatch 在 `:142`），任何端口首次被访问即打通。审计只能插在 `proxy_handler` 入口（按「首次出现的 host+port 记一条」），本文把它从原计划的「端口开通」改述为「代理入口首次访问」。
- **settings 助手现状（影响读写口实现）**：`src/api/settings.rs` **无共享 helper**，是「每 key 一对 handler」模式——读 `:54 get_acp_idle_recycle`、写 `:74 set_acp_idle_recycle`、多 key 样例 `:138-151 set_permission_timeout`；另 `src/main.rs:845/865/882/890` 有一份启动期读取。S5 若需读口设置项，按 §7① 应顺手抽 `settings_get/settings_upsert` 助手（已有 ≥4 处同型样板）。
- **否决项**：① 塞进 settings 表当 JSON（无界且难查，违反 §P1 精神）；② 只打 tracing 日志（用户不可查，日志轮转型不在我们手里）；③ 审计全部 git 写操作（9 个写类路由全审会写放大，只审 `push` + 文档述明的「强推」）。
- **翻盘条件**：若审计表增长远超预期且轮转删除影响排查，改为「按 action 分类保留期」分级策略。

### D5 S6 先评估后实施，不在本计划承诺必须做

- **决策**：Phase 5 第一步是评估而非编码。**已确认的路由拓扑（2026-09-26）**：`src/api/mod.rs:24` 为 public 组（仅 `health` / `auth` / `agent_events`）；`:26-45` protected 组含 13 组路由 + 3 条 WS，第 45 行挂 `require_auth_mw`（本体 `src/auth/mod.rs:111-119`）→ `files`(:34) / `git`(:36) / `agents`(:37) / `settings`(:32) / `sessions`(:31) **全部在 auth 保护下**。两个例外：① `agent_events::routes()` 在 public 组（边界 = 回环 + 会话专属 token，已有 `MAX_HOOK_BODY_BYTES=1024` / `MAX_HOOK_ENTRIES=256` 有界）；② `proxy::routes()` 与 `/api/v1` 平级、**不经过 auth 中间件**（`:51`）。
- **原语可用性纠正（重要）**：`src/auth/rate_limit.rs:10-44` 的 `LoginGuard` 是 **IP 维度 + 失败计次**语义（`is_blocked`/`record_failure`/`record_success`），**不适配**「上传频次」这类纯计数限速。所谓「复用」必须落到实处为**抽共享 `SlidingWindow` 结构**（ip/session_id → 窗口内时间戳），LoginGuard 与业务端点各自组合它。IP 取法参照 `src/api/auth.rs:79/98/120`（`ConnectInfo<SocketAddr>`，`main.rs:1093` 已挂 `into_make_service_with_connect_info`）。
- **结论路径**：若评估判定「auth 已开 + 端点已保护 + 无单用户重客户端滥用面」，本 Phase 直接关闭并在此记录，不硬做；唯一明确候选是 **`/proxy/{*path}` 转发路径**（无 auth 保护），但它是通用反代而非业务端点，限流策略需单独设计（否则会限死正常转发）。
- **否决项**：为「计划完整性」而实施无实际收益的限流（反模式）；把 `LoginGuard` 硬套到上传计数（语义错配）。
- **翻盘条件**：发现 auth 开启下仍存在单用户重客户端滥用（如移动端重连风暴、批量脚本），再按共享 `SlidingWindow` 落地分级限流。

## 实施分期

| Phase | 改动 | 产出 | 依赖 |
|--------|------|------|------|
| 1 | `src/main.rs`：新增 `insecure_no_auth` 字段 + `enforce_listen_auth()` 纯函数 + `#[cfg(test)]` 真值表单测 | 裸奔路径关闭；`cargo test` 覆盖四格 | 无 |
| 2 | 共享校验函数提升 + 三个主 WS 入口接线 + 单测（同源放行/跨站拒/无 Origin 放行） | CSWSH 面收敛为单一真源 | Phase 1 无依赖，可并行 |
| 3 | `src/main.rs` CORS 构造替换为纯函数 `build_cors_layer(...)`（默认同源 predicate + `OMNITERM_*` 显式 origin 白名单取并集）+ 单测穷举 + 反代两态实测 | CORS 不再 permissive | 依赖 dev 环境验证 + 反代形态实测 |
| 4 | migration + 审计函数 + files/git/agents/proxy 写入点接线 + 上限单测 + settings 读口 | 敏感操作可查、有界 | 无强依赖，宜在 Phase 1 后 |
| 5 | 评估报告（先出结论）→ 若成立再泛化限流 | 或限流落地，或明确关闭并记录 | Phase 1 改变前提，须在其后 |

## 验收标准 / 验证清单

- [x] `cargo test enforce_listen_auth`（四格真值表全过）
- [x] `cargo test origin`（WS 校验：同源/跨站/无 Origin）
- [x] `cargo test cors`（CORS：同源/跨站/无 Origin/白名单/预检/上限边界，predicate 17 + layer 9）
- [x] `cargo test audit`（条目上限 + detail 字节上限 + 截断守恒断言）——24 个，含并发 1100 次写入上界不被击穿（`<=` 上限，非 `==`，见 Phase 4 记录）
- [x] 手动：`./dev.sh restart` 后 dev 环境可正常访问（CORS 未打断）
- [ ] 手动：非回环 bind + auth 关闭时启动失败且错误信息可见（前台 + `--daemonize` 两路）
- [x] 手动（Phase 3 新增，勘察 D3 校正 6）：nginx `proxy_set_header Host $host` 反代后跨源被拒；显式配 origin 后放行；同源放行不回归（embedded 形态 + 移动端真机）——反代两态用 `Host` 头等价模拟实测通过；embedded 形态见下条；**移动端真机未测**（无真机，列入后续手动回归）
- [ ] `cargo clippy --quiet --workspace --all-targets -- -D warnings` 零新增
- [ ] 前端无改动项（Phase 4 的 settings 读口除外，需 `tsc -b`）

## 风险与文档闭环

| 风险 | 缓解 |
|------|------|
| D1 上线后有人依赖「裸奔启动」的自动化脚本突然失败 | 逃生门 `--insecure-no-auth` + 启动错误文案写清补救动作；这是刻意破坏性变更，须进 CHANGELOG |
| D3 收紧打断 dev / 反代 / 移动端访问 | Phase 3 先跑通 dev 与子域代理两条真实路径再合入；`.env.local` 可配 origin 集合兜底 |
| D4 审计表写放大影响热路径 | 写入点只选「低频高危」动作（push/force、写删、配置变更、开端口），读操作不审计；单条 detail 有字节上限 |

实施后须更新：`docs/reference/auth-not-enforced.md`（回写现状表，S1/S3 落地状态）、`docs/architecture/backend.md`（WS Origin 校验收敛点、审计表结构、`--insecure-no-auth` CLI 新参数）、`CHANGELOG.md`（D1 属破坏性启动行为变更）。

---

## Phase 1 实施记录（2026-09-26）

**产出**：`src/main.rs` 新增 `--insecure-no-auth` / `OMNITERM_INSECURE_NO_AUTH` flag + 纯函数 `enforce_listen_auth(listen_host, auth_enabled, insecure_no_auth)`；原 `tracing::warn!` 块替换为 fail-closed 校验。

**单测**（4 个，`cargo test enforce_listen_auth`）：四格真值表穷举（回环 5 种宿主 × 非回环 5 种宿主 × auth/escape hatch 组合）、逃生门独立性、未知 host fail-closed、错误信息含补救动作。

**实测六场景**（全通过）：`0.0.0.0`+auth关→rc=1 拒绝；`0.0.0.0`+auth关+逃生门→正常监听；`0.0.0.0+auth开→正常监听；默认 127.0.0.1→正常监听；`--daemonize`+拒绝组合→rc=1 且错误回传父进程；`--daemonize`+逃生门→后台启动成功。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **回环集合扩充**：除计划预期的 `127.0.0.1|localhost|::1|[::1]` 外，补入 `0:0:0:0:0:0:0:1`（`::1` 的未压缩展开形式，`bind` 字符串不经规范化，该形态此前会被误判为非回环而误拒）。未知/带端口写法按非回环 fail-closed。
2. **校验点位置（时序 bug，实测捕获）**：初版把校验放在 `daemon_notify_ready` 之后，`--daemonize` 路径实测 rc=0 并打印「started in the background」，但后台进程其实已在校验处退出——**父进程拿到假成功信号**。已移至 `daemon_notify_ready` 之前（bind 之后：端口被占仍由 bind 报错，两者不重叠）。
3. **PID 文件先于校验写入**（未改）：PID 文件在 bind 成功后就写入，故拒绝启动时会留下一个指向已退出进程的 stale PID 文件。评估为可接受：`stop` 走的是「进程是否存活」判定而非 PID 文件存在性，且改动它会影响端口占用/DB 失败这两条既有路径的语义。若后续发现 stop 误判再处理。

**回归**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` 550 单测 + 8 + 2 集成全绿（新增 4 个测试）。

**验收勾销**：`cargo test enforce_listen_auth` ✅ / clippy ✅ / 非回环拒绝两路可见 ✅。

---

## Phase 2 实施记录（2026-09-26）

**产出**：新建 `src/ws/origin_guard.rs` 承载共享防线 `enforce_ws_origin(&HeaderMap)`，三个主 WS 入口（`ws_terminal_handler` / `ws_external_terminal_handler` / `ws_acp_handler`）在 `on_upgrade` 之前调用；`src/proxy/mod.rs` 的私有 `origin_matches_host` / `strip_port` 连同三个单测**删除**，改为调 `crate::ws::origin_matches_host`——同一判断不再有两份实现（S2'「半落地」的根因）。

**新增单元测试**（`cargo test origin`，共 20 个；其中 3 个为审查前自查补充，见 `dcfc53e`）：入口级 11 个——同源放行、同源端口不一致放行、代理子域放行、跨站 403、畸形 Origin 403、**无 Origin 放行**、**无 Host 放行**、空 header map 放行、多 Origin 头首个为跨站时拒绝、非 UTF-8 Origin 拒绝、无 Host 时非 UTF-8 Origin 放行；纯函数 9 个——含本轮新补的 IPv6 字面量、host 大小写不敏感、空 host 段拒绝、Origin 带 path/query 截断。**「无 Origin 放行」原本完全没有测试**：判定函数签名是 `(&HeaderValue, &str)`，表达不了「头不存在」这一态，必须做成入口级 predicate，计划验收项 `cargo test origin`（同源/跨站/无 Origin）这才真正落全。多值 Origin 一条钉住 `ORIGIN` 是单值头、`get` 取首值的语义，并注释警告**不得**改成「任一值匹配即放行」——那会让攻击者把合法值排在恶意值前绕过。

**实测十场景真实握手**（起独立实例 `--port 19871 --db sqlite://…`，隔离 dev 环境；dev 库 `auth_enabled=1`，`require_auth_mw` 的 401 会先于 Origin 校验返回，看不到边界）：terminal / acp / external / proxy 四个入口各测同源→101、无 Origin→101、跨站→403、畸形→403，**10/10 PASS**，403 响应体逐字 `origin not allowed`，`ws origin rejected` warn 按预期留痕。Node `WebSocket` 裸握手（实测不发 Origin）仍 101 → `scripts/pty-*-regression.mjs` 与 `tests/agent_hook_integration.rs` 的裸握手回归**不受影响**，这是本轮最需要守住的一条。

**真实浏览器验证**（系统 Chromium + CDP，auth 关闭的独立实例，保证 Origin 校验是真正的门）：

- 同源页面（`http://127.0.0.1:19872`）`new WebSocket('ws://127.0.0.1:19872/api/v1/ws/terminal/…')` → **OPENED**，用户真实路径未被误伤。
- 跨 host 攻击页面（`http://localhost:19874` → 目标 `127.0.0.1:19872`）→ **被拒**，后端 `WARN omniterm::ws::origin_guard: ws origin rejected: origin="http://localhost:19874" host="127.0.0.1:19872"`。
- **基线对照（关键一步）**：headless 浏览器首次探针得到 `CLOSED code=1006`，无法区分是本次改动还是其它原因。用 `git stash` 构建 pre-Phase-2 二进制重跑同一探针，得到**同样的 1006** → 确认为 dev 库 `auth_enabled=1` 下的 401（headless 无登录 cookie），与本改动无关。没有这一步，极易把既有现象误判成自己引入的回归。
- **`--daemonize` 路径复验**：Phase 1 曾在该路径栽过「父进程拿到假成功」的时序 bug，故本 Phase 用 daemon 实例重测同源/跨站/无 Origin 三态，同样 101/403/101，防线在后台形态下一致生效。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **落点选 `src/ws/mod.rs` 而非计划 D2 提的 `src/utils/`**：勘察发现 `src/utils/` 是死模块——`src/utils/mod.rs` 只有 1 个字节，`docs/architecture/backend.md:75` 声明的 `src/utils/path.rs` 与实际位置（真实在 `src/fs/mod.rs`）不符，全仓零调用点。启用它必须顺手修文档，属计划外副作用；`src/ws/mod.rs` 本已是三入口收敛点。backend.md:75 的陈旧描述本轮不改，另见 backlog。
2. **`strip_port` 一并提升**：`origin_matches_host` 依赖它，只提前者编译不过（原同为 proxy 私有）。
3. **`host_from_request` 未提升**：它取 `&Request`（仅 proxy WS 分流上下文持有），与 WS 入口的 `HeaderMap` extractor 形态不同；2026-08-13 计划勘误⑤ 明确「共享函数**不能持 `&Request` 跨 await**」。保持 proxy 侧私有取值、共享侧只共享判定，边界更干净。
4. **入口级 403 由 `enforce_ws_origin` 统一返回响应**（而非每个 handler 各写 `StatusCode::FORBIDDEN`）：判定与响应文案同处一份，避免四份文案漂移。proxy 侧需先判 WS 再进 `dispatch`，沿用原 let-chain 形态但改调共享判定函数，行为逐字不变。

**回归**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` 565 单测 + 8 + 2 集成全绿。

**验收勾销**：`cargo test origin` ✅（20 个）/ 三入口 + 代理入口真实握手 10/10 ✅ / 真实 Chromium 同源放行 + 跨 host 拦截 ✅ / 裸握手回归不受影响 ✅ / `--daemonize` 路径一致生效 ✅。

### Phase 2 独立审查与修复记录（2026-09-26）

按 `docs/workflows/subagent-code-review.md` 派**独立审查子代理**（另起会话、只读、对抗性立场，要求其证伪实现方主张）。结论 **request changes：1 blocker + 3 major + 2 minor**。逐条处置如下：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | **blocker** | **子域名代理 WS relay 路径完全无 Origin 校验**：`proxy_host_mw` 的 `is_ws_upgrade` 分支直接调 `ws::relay`，绕过 `dispatch_proxy` 的校验。经逐字节对比确认为**既有缺口**（`c3d22be` 起就存在），非本轮回归；但本轮文档宣称「四入口全部经它校验」**失实**——这正是本仓历史事故「安全机制实现后未接入链路」的同型 | **已修**：在 `proxy_host_mw` WS 分支内、`ws::relay` 之前补 `enforce_ws_origin(&parts.headers)`。**并经真实子域名握手实测**（起 `--proxy-domain omniterm.lan` 实例）：同源 101 / 无 Origin 101 / 跨站 403 / 跨 host 403，HTTP 非 WS 不回归（200），warn 留痕。**另做反向取证**：`git stash` 构建修复前二进制重跑同一探针 → 跨站 Origin 得 **101**（缺口确实存在），修复后为 403 |
| 2 | major | `strip_port` 对无方括号裸 IPv6（`::1` / `2001:db8::1`）会切空/切错，文档「IPv6 正确剥端口」易被过度推广 | 审查确认**威胁模型内不可利用**（浏览器发握手必带方括号，WHATWG URL 规范强制；手工构造客户端本来也无 Origin）。**已收窄宣称**：backend.md 增加「IPv6 形态边界」块，说明只保证方括号形态、为何不特殊处理（避免改变 proxy 既有行为） |
| 3 | major | `host_from_request`（proxy，取 `&Request`）与 `host_from_header_map`（origin_guard）是同一判断的两份实现，守卫同一攻击面 | **已修**：后者提为 `pub host_from_headers` 作为真源，proxy 侧改为薄 wrapper 调它，并互相注释指向。`&Request` 形态保留的理由见 2026-08-13 计划勘误⑤ |
| 4 | major | `backend.md` source tree 被本轮 diff 改坏：`fs/mod.rs` 行与 `git/` 行拼成一行（丢换行） | **已修**：补回换行 |
| 5 | minor | 实现方摘要称 `cargo test origin` 17 个，实际 20 个（后续 commit 补了 3 个）——派发摘要滞后于 HEAD | 已在计划文档统一订正为实际值；后续派审查以 `git diff <base>..HEAD` 为准 |
| 6 | minor | 测试名 `enforce_ws_origin_allows_non_utf8_host` 与所测内容不符（该用例只有 ORIGIN、无 HOST，走的是「无 Host 放行」路径，`to_str()` 失败分支根本没被执行） | **已修**：拆成两条——改名 `enforce_ws_origin_allows_when_host_header_absent`，并新增 `enforce_ws_origin_allows_when_host_is_non_utf8` 用 `HeaderValue::from_bytes(b"\xff")` 真实命中 `to_str()` Err 分支 |

**审查额外纠正的一处机制误述（已回写代码与文档）**：我方注释称「ORIGIN 是单值头」。审查者查 http-1.5.0 与 hyper-1.11 源码证明——HeaderMap 对**声明过的头仍可 `append` 出多值**（`append` 不看单值声明，只有 `insert` 才去重），`get` 取首值才是真实行为。测试结论（安全）正确，但注释机制描述会误导维护者以为 HeaderMap 层面保证了单值。已改为准确表述，并把该语义连同「不得改成任一值匹配即放行」的警告写进 backend.md。

**本条记录的教训（写入 backend.md 收敛点处）**：**判据共享 ≠ 调用点覆盖**。前四个入口收敛后我曾据「函数已入共享模块」宣称「四入口全覆盖」，漏掉了绕过 `dispatch_proxy` 的子域名分支。安全加固要在**每条**到达 `on_upgrade`/`relay` 的路径上逐一确认调用点。

**修复后回归**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` 566 单测 + 8 + 2 集成全绿（`cargo test origin` 21 个）。

---

## Phase 3 实施记录（2026-09-26）

**产出**：`CorsLayer::permissive()` 替换为 `build_cors_layer()`（`src/main.rs` 纯函数，便于穷举单测）；判据真源落 `src/ws/cors_policy.rs`；新增 `--cors-allowed-origins` / `OMNITERM_CORS_ALLOWED_ORIGINS`。层序不变（`proxy_host_mw`[仅 base_host] → TraceLayer → **CorsLayer** → Router/fallback）——CORS 层包住全部自身端点但不包子域反代流量。

**三条规则并集**（`AllowOrigin::predicate` 一个闭包实现，tower-http 无法直接并集两种策略）：

| 规则 | 判据 | 性质 |
|---|---|---|
| 无 `Origin` | 放行 | **框架保证**：`AllowOrigin::to_future` 是 `origin.filter(...)`，Origin 缺失时 predicate 不被调用。非浏览器客户端不在同源策略管辖内 |
| Origin host ↔ Host host | 放行 | 复用 **WS 入口同一份 `origin_matches_host`**（§7① 同一判断不复制），忽略端口、大小写不敏感；天然覆盖代理子域形态 |
| 逐字命中白名单 | 放行 | nginx 默认改写 `Host` 时唯一活路 |

**单测 26 个**（`cargo test cors`，17 predicate + 9 layer 级）。layer 级测试起真实 `CorsLayer` 打真实请求——**只测谓词不足以证明行为**：「无 Origin 放行」来自框架而非我们的代码，必须打层才看得到。

**一个被单测逮到的实现缺口**：`AllowMethods` / `AllowHeaders` 默认为 `Const(None)` ⇒ 预检拿不到 `Access-Control-Allow-Methods`/`-Headers`，白名单部署下带 `content-type` 的 POST（全部 JSON 接口）会被浏览器拦在预检上。**dev 同源永不 preflight，手动验证发现不了**——纯靠 `cors_layer_preflight_answers_allowed_methods_and_headers` 这条测试兜住。补 `GET/POST/PUT/PATCH/DELETE` + `content-type`/`authorization`（方法集由 `src/api/*.rs` 注册的 handler 形态枚举而来）。

**实测六场景**（独立实例，`Host` 头模拟 nginx 两态 + dev 环境三态）：
1. nginx 默认 `Host $proxy_host` + 配白名单 → `access-control-allow-origin` 回显 ✅
2. nginx 改写 Host + **不**配白名单 → 无 ACAO（拒绝）✅
3. nginx `Host $host` + 浏览器真同源 → 放行（不回归）✅
4. 配了白名单但 Origin 不在其中 → 拒绝（并集语义：白名单是「额外允许」不是全放开）✅
5. 跨源预检 → 空；同源预检 → 方法/header 齐全且**不发** `Access-Control-Max-Age` ✅
6. WS 403 / 101 与 `/proxy/` 200 不受影响 ✅
另：dev 环境 `./dev.sh restart` 后 curl 200、vite proxy 200、同源带 Origin 200+ACAO、跨站带 Origin 200 无 ACAO。

### 实施偏差与勘察补充（就地记录）

1. **`max_age` 不设**（计划未提）：曾写 `.max_age(MaxAge::exact(Duration::ZERO))`，审查发现**这并不「关掉预检缓存」**——`Exact(Some(0))` 照样发 `Access-Control-Max-Age: 0` 头（tower-http 0.6.11 `max_age.rs`），唯一不发的办法是保持默认 `Exact(None)` 即不调用 `.max_age()`。已改为不调用 + `cors_layer_preflight_omits_max_age` 钉住「头不存在」。语义意图不变：白名单变更后浏览器不得按旧预检结果继续放行。
2. **不开 `allow_credentials`**（计划未提）：本项目凭据是 cookie（同源自动携带）或 `Authorization: Bearer`（跨源简单请求带不了自定义头，须先过预检，而预检已由同源/白名单分支放行）。保持 off 顺带让 `ensure_usable_cors_rules` 的组合断言不可能被触发（credentials + `Any` 会在 `poll_ready` panic）。
3. **入口策略分叉须沉淀（AGENTS §8）**：同为「Origin host ↔ Host host」判据，**缺 `Host` 时 WS 放行、CORS 拒绝**。判定函数共享，入口策略刻意不共享——理由已写进 `backend.md`，勿「顺手统一」。
4. **前端确认真零跨源调用**：全相对路径（`api/client.ts` `BASE='/api/v1'`、`useAcpChat.ts` 用 `window.location.host`、`useFileWatcher.ts` SSE 相对），`frontend/src` 内 `http(s)://` 命中全是 GitHub 链接/i18n/测试夹具；唯一跨形态是 `proxyUrl.ts` 子域绝对 URL（`window.open` 导航，非 fetch，且被 `proxy_host_mw` 先拦）。唯一非简单 Content-Type 是 multipart 上传 → 已被 `allow_headers: content-type` 覆盖。
5. **`/proxy/{port}` 路径前缀流量确实穿过 CorsLayer**（与子域流量不同）：跨源 fetch 打它现在被拒——这是收紧目的（信息面收窄），不是回归。
6. **顺手补 Phase 1 遗留文档欠账（超出本轮必要范围，显式披露）**：`--insecure-no-auth` / `OMNITERM_INSECURE_NO_AUTH` 自 Phase 1 落地起就未登记进 `backend.md` CLI 块与 env 表，本轮同表改动一并补齐。同时补上的还有 `--proxy-domain` / `OMNITERM_PROXY_DOMAIN` 与 `--proxy-max-body` / `OMNITERM_PROXY_MAX_BODY`（同样是先前落地未登记项）。**这三项不是本 Phase 的新功能**，只是同一张表的文档欠账清偿；若评审要求 CORS commit 只含 CORS 改动，可将这三行拆到独立 `docs:` commit。

**验收勾销**：`cargo test cors` ✅（26 个）/ 反代两态实测 ✅ / 同源放行不回归 ✅ / dev 不打断 ✅ / clippy+fmt+全量 592 单测 ✅。

> **独立审查后追加（2026-09-26）**：审查结论 request changes（2 blocker + 2 major + 2 minor），逐条处置见下方审查表。

**文档闭环待办**（本轮已做）：`backend.md`（新增「CORS 策略」小节 + CLI/env 登记）、`auth-not-enforced.md`（CSWSH 段后补 CORS 段 + 影响表行 + 相关文件）、`CHANGELOG.md`（`[security]`/`[api]` 条目，含反代白名单影响面）、`archive/2026-09-01-improvement-directions.md` 的 S3 状态改「已落地」。

### Phase 3 独立审查与修复记录（2026-09-26）

按 `docs/workflows/subagent-code-review.md` 派**独立审查子代理**（另起会话、只读、对抗性立场，审 `git diff 699a3cb..561f3c4` 并要求其逐条证伪实现方的 7 项安全主张）。结论 **request changes：2 blocker + 2 major + 2 minor**。逐条核实后处置如下：

| # | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| 1 | **blocker** | `parse_allowed_origins` 的超长条目 warn 用 `&entry[..MAX_ORIGIN_BYTES]` 做字节切片——多字节字符跨第 256 字节时**启动即 panic**（§P1 明确要求按字符边界切） | **已实证**：用 `rustc` 单独构造「19 ASCII + 79 个三字节汉字（270 字节）」输入，报 `byte index 256 is not a char boundary` | **已修**：改 `entry.chars().take(MAX_ORIGIN_BYTES).collect::<String>()`，并补 `parse_allowlist_drops_multibyte_overlong_entry_without_panic` 回归（现象即 panic，测试必须能在修复前转红）+ `parse_allowlist_keeps_multibyte_entry_within_limit`（上限管字节数不管字符数，勿误丢合法条目） |
| 2 | **blocker** | `MAX_ORIGIN_ENTRIES` 上限检查在 `push` **之后**执行 ⇒ 恰好 32 条的合法配置也触发「超出上限、保留前 32 条」warn，谎报超限且宣称的丢弃策略与代码实际行为不符（§P1：超限策略必须与宣称一致） | 属实：`out.len() >= N` 在 push 后判，第 32 条 push 完即命中 | **已修**：上限检查移到循环体顶部（空段 `continue` 之后）。补 `parse_allowlist_exact_cap_is_not_over_limit`（恰好 N 条不误报）+ `parse_allowlist_over_cap_keeps_exactly_first_n`（超限时逐条核对保留的恰是前 N 条） |
| 3 | major | `max_age(MaxAge::exact(Duration::ZERO))` **并不关掉预检缓存**——`Exact(Some(0))` 照样发 `Access-Control-Max-Age: 0` 头（查 tower-http 0.6.11 `max_age.rs` 证实）；代码注释、backend.md、本计划偏差 1 三处都写了错机制，且无测试支撑该宣称 | 属实，读源码 `to_header` 的 `Exact(v) => v.clone()?` 确认 | **已修**：删掉 `.max_age(...)`（不发头的唯一办法是保持默认 `Exact(None)`）+ 同步改三处文字 + 补 `cors_layer_preflight_omits_max_age` 断言头不存在。**顺带删掉因此变为未使用的 `MaxAge` import** |
| 4 | major | CLI/env 表把 `--insecure-no-auth` / `--proxy-domain` / `--proxy-max-body` 三个**先前已落地**项与新的 `--cors-allowed-origins` 并列写出，形似「本 Phase 新功能」（协议 §3.1 未披露的范围蔓延；虽是正确的文档欠账清偿） | 属实：Phase 1 的 flag 自落地起就未登记 | 保留补登记（有价值），但在**计划偏差 6 与本条**显式披露「这三项不是本 Phase 新功能，只是文档欠账清偿，可拆独立 `docs:` commit」 |
| 5 | minor | 文档称「不做规范化」未提及 `HeaderValue::from_str` 会**静默拒绝**含控制字符的条目 | 属实（`from_str` 对控制字符返回 Err） | 已在 `parse_allowed_origins` 文档补一条说明 |
| 6 | minor | `allow_credentials` 的理由写「跨源简单请求带不了自定义头」是非因果（Authorization 是非简单头 ⇒ 跨源 Bearer 必先 preflight；真正保证是谓词门控 preflight） | 表述确实不精确，结论不变 | 已改为准确表述（谓词门控 + 顺带避开 `ensure_usable_cors_rules` 的 panic 组合） |

**审查确认为真的事实**（读源码逐条比对，非只看我方摘要）：① 不 break 任何合法调用方（前端全相对路径、零 `res.headers` 读取、零 `credentials:`、下载是 `a.download` 导航式、scripts/tests 不发 Origin）；② 三规则并集且白名单是**加法**（不涉及 Host 的字节比对，两条 true 分支独立返回）；③ 复用 `origin_matches_host` 安全——**缺 Host 时 WS 放行 / CORS 拒绝的分歧是有意且已按 AGENTS §8 沉淀进 backend.md**；④ 测试脚手架真实（`tower::Layer::layer` + `oneshot`/`block_on` 走的是 `Cors::<S>::call`，正是「无 Origin ⇒ predicate 不被调用」的所在，非空测试）；`decide()` 构造真实 `axum::http::Request` 后调同一个 `origin_is_allowed`，非重复实现；⑤ 预检覆盖前端实际方法/头（GET/POST/PUT/PATCH/DELETE + content-type + multipart）；⑥ 层序与 `Vary` 宣称正确，方向**只收窄未放宽**（`*` 条目永远匹配不上浏览器 Origin）。

**审查未能验证项（不可视为已完成）**：B1 的 panic 我方已用 `rustc` 单独复证、修复后单测能转红；`cargo test cors`/全量绿由我方实跑（26 / 592）；**反代与移动端真机实测仍未做**（无 nginx、无真机，`Host` 头模拟不等价于真实链路），继续留在待办。

---

## Phase 4 实施记录（2026-09-26）

**产出**：新 migration `migrations/20260926_add_audit_log.sql`（**新增文件，未改任何已有 migration**）+ 新模块 `src/api/audit.rs`（写入收敛点）+ 只读路由 `GET /api/v1/settings/audit-log` + 前端 `Settings` 的 `auth` tab 新增只读区块 `AuditLogSection`。

**写入点全部收敛为 `audit::record` 一个函数**（AGENTS §7①，禁止各 handler 各写各的）：

| 动作 | 触点 | target | scope | detail |
|---|---|---|---|---|
| `file_write` / `file_delete` / `file_upload` | `src/api/files.rs` write/delete/upload | 相对/绝对路径 | `session:` / `workspace:` / `project:` | `{allow_escape}`；upload 另带文件名单与计数 |
| `git_push` | `src/api/git.rs:234` | repo 根 | `repo:<root>` | 无 |
| `agent_create` / `agent_update` / `agent_delete` | `src/api/agents.rs:77/119/172` | agent id | `agents` | 命令 + **env 键名**（不含值，§S3）；update 记改动的字段名 |

**「强推是否需单独分流」的计划存疑点已确认（否）**：`src/git/repo.rs:513-529` 的 `push` 只发 `push` 与 `push --set-upstream origin HEAD`，**从不带 `--force`**，故不存在独立的「强推」动作，无需分流。

**proxy 的特殊性（计划 D4 已预告，实施时确认）**：代理**没有「开通」原子事件**——`/proxy/{*path}` 是 catch-all，任何端口首次被访问即打通。故只能记「端口**首次**访问」，并为此在 `ProxyState` 新增有界登记表 `PortAuditLog`（`HashSet<u16>` 去重 + `VecDeque<u16>` 保序，上限 `MAX_TRACKED_PROXY_PORTS=4096`）。**不做这个去重的话，反代流量的每一次请求都会写一条审计行 = 写放大**（§P1）。登记表放在白名单校验**之后**：被拒绝的端口不进表（它们的拒绝路径已有自己的 warn，且探测型请求不该污染审计）。

**actor 为什么带 IP**：OmniTerm 是单人工具，JWT `Claims.sub` 恒为硬编码 `"admin"`（`src/auth/mod.rs:28`），且 `require_auth_mw` 只返回 `Result<(), StatusCode>`、**不把身份塞进 extensions**（全仓零处从 extensions 取 Claims）。单写 actor 等于每条记录都一样，回答不了「谁动的」——**区分度只能来自来源 IP**（多设备/误操作/被入侵三种场景的差别全在这里）。取不到 IP 时如实写 `admin@-`，**不虚构**（反代背后 `ConnectInfo` 给的是反代地址）。参照既有先例 `src/api/auth.rs` 的 `ConnectInfo<SocketAddr>` 取法，`src/main.rs` 早已挂 `into_make_service_with_connect_info`，故**零中间件改动**。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **`scope` 列是实施时新增的**（计划 D4 的列清单里没有）：算出绑定范围却不落库等于白算，「对哪个会话/工作区动手」是追查时的第一问。与 `target` 分开存的原因是**路径会变、id 不变**（worktree 移动、session cwd 漂移）。
2. **只记成功操作**（计划未明确）：所有写入点都在业务成功之后调用。失败操作没有改变系统状态，且在每条错误分支再插一次调用极易漏。翻盘条件：若将来要审失败尝试，应作为独立 `*_failed` 动作**统一**加，不得只加在部分写入点——那会让「没记录」变成歧义信号。
3. **审计写失败不阻断业务**（§S2 边界）：失败只 `tracing::warn!` 并返回，业务响应照常。理由：审计是观测手段，若它故障就升级为功能故障，会诱导调用方绕过审计。也不 `Result::ok()` 静默吞掉——warn 就是留给运维的痕迹。
4. **agent detail 只记 env 键名不记值**（§S3）：`{"command":…,"env_keys":[…]}`
（实测：请求里 `env:[{"key":"SECRET_TOKEN","value":"topsecret"}]`，落库 detail 只含 `"SECRET_TOKEN"`，值未入库）。update 记**被改动的字段名**而非最终值——后者可从当前 agents 行反推。
5. **顺手清偿一处既有重复**（局部改善范围）：`src/api/settings.rs` 的 `tests::test_state()` 是 `src/test_utils.rs::test_state()` 的逐字重复（17 行样板），且后者注释本就写着「可后续迁移过来」。已改为转发——`AppState` 新增字段（本轮加了 `audited_ports`）时只改一处，否则两处同改必漏一处。
6. **insert 与 prune 不是同一事务**（初版注释曾误称"同一事务"）：修剪按「当前总数 − 上限」实时计算删除量，与插入顺序无关地收敛回上限，故无需事务。此论断有并发测试实证（见下），非口头声明。
7. **前端选 `auth` tab 而非新建 tab**：审计是安全语义，与 `AuthSection` 同域；`Settings` 的 `CATEGORIES` 已覆盖 8 个 tab，再加一个会稀释「安全」相关项的聚集度。区块自带 `max-height: 240px` 滚动——桌面设置弹窗仅 33vh 高，不自带约束会撑破容器。
8. **并发上限断言从 `==` 改为 `<=`（`d49a71f`，自查发现）**：初版断言「并发 1100 次写入后**恰好** 1000 条」，实测单独跑稳定过、整批跑偶发失败。根因是两路修剪的删除区间重叠会把末尾多裁一条（999）；安全性质仅是「上界不被击穿」，「恰好等于上限」并不由并发性保证。**把偶发成立的性质写成必然断言 = 制造 flaky**。已改为 `<= 1000` + `> 950`（证明修剪确曾发生），并连跑 5 轮 22/22、3 轮全量 616/616 验证稳定。

**单测 24 个**（`cargo test audit`：`src/api/audit.rs` 22 + `src/proxy/mod.rs` 的 `PortAuditLog` 2）。DB 级有界测试含：
- 条目上限**恰好**收敛到 1000（不是"不超过"，是枚举核对保留的恰是最新那批、最老一条恰为第 21 条）
- 未超限时一条不删（常态零 DELETE）
- `MAX_AUDIT_ROWS - 1` 条时不触发修剪
- detail 超限落库的必是截断版且带 `"__omitted_chars__":N`
- **并发 1100 次写入（4 连接池、2 writer task）后条目数不超上限**（`<=` 1000 且确曾修剪） —— 这条钉住偏差 6：不用事务也不击穿上界。**注意断言是 `<=` 而非 `==`**：初版写 `== MAX_AUDIT_ROWS`，实测「单独跑稳定过、整批跑偶发失败」——两路修剪的删除区间重叠会把末尾多裁一条（999），而安全性质只是「不击穿」，「恰好等于上限」并不由并发性保证。写成 `==` 等于造了一台时序机器（flaky），已改为正确不变式（`d49a71f`）
- 空 `target` 合法落库（列 NOT NULL 但空串是合法值）
- `scope` 无绑定时为 NULL

**两条 §P1 双上限 + 守恒断言**：`target` 1024B / `detail` 2048B，均按字符边界切 + 显式标注省略量，单测断言 `保留量 + 声称省略量 == 输入量`。写守恒断言时踩到一个**测试自身的坑**并记下：最初的断言用 `out.chars().filter(|c| *c=='a').count()` 数保留量，把标注里的 `trunc**a**ted` 也数了进去 ⇒ 得到 1126 vs 输入 1124 的假失败。改为 `rsplit_once(PREFIX)` 取出保留段后再数才正确——**截断标注文案里的字符会污染守恒断言**，写这类断言必须先分离标注段。

**前端 5 个测试**（`AuditLogSection.test.tsx`，仿 `UpdateBadge.test.tsx` 的 `vi.mock` 模式）：逐行渲染且顺序不重排、空态、**未知 action 回落原始串**（后端比前端新时不渲染 "undefined" 也不静默丢行）、请求失败退化为空态不崩、读口必须带 limit（60）。

**实测十一场景**（独立实例 `--port 19880 --db sqlite:///tmp/p4-audit.db`，跑完已停、产物已清、端口已释放）：

| # | 操作 | 结果 |
|---|---|---|
| 1 | migration 建立 `audit_log` | 7 列 + `idx_audit_log_created` 齐备，初始 0 行 |
| 2 | 写文件（`workspace=p1`） | 200，落 `file_write`，`actor=admin@127.0.0.1`、`scope=project:p1`、`detail={"allow_escape":false}` |
| 3 | **越界写**（`allow_escape=true`，`../p4ws/esc.txt`） | 200，落 `file_write`，`detail={"allow_escape":true}` ← 关键区分可见 |
| 4 | 删文件 | 200，落 `file_delete` |
| 5 | `GET /settings/audit-log` | 新→旧三行齐全 |
| 6 | `?limit=99999` / `?limit=0` | 收敛到 200 硬顶 / 收敛为 1（不报错、不返回空） |
| 7 | agent 增/改/删 | 3 条全落；**env 值 `topsecret` 未入库，只落键名 `SECRET_TOKEN`** |
| 8 | git push **失败**（无 remote） | 422，**不落审计**（符合「只记成功」） |
| 9 | git push 成功 | 200，落 `git_push`，`target`/`scope` 均为 repo 根 |
| 10 | proxy 3 次请求同一端口 | 3×200 但**只落 1 条** ← 去重生效，无写放大 |
| 11 | proxy 打黑名单 3306 / 低端口 22 / 自身端口 | 3×403，**均不落审计**（白名单校验在前，不进登记表） |

**第 12 个验证（安全边界，单独做）**：直接 `DROP TABLE audit_log` 后写文件 → **仍返回 200**，日志留 `WARN omniterm::api::audit: audit write failed (业务响应不受影响，但该操作未留痕)` ⇒ 偏差 3 的两个性质同时实证：业务不因审计故障失败、且不静默吞错。

**回归与文档闭环**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` **616 单测** + 8 + 2 集成全绿（592 → 616，连跑 3 轮稳定）；`cargo test audit` 24 个；前端 `tsc -b` / `pnpm lint`（0 error，新增文件零 warning）/ `pnpm test` **803 全过**（798 → 803）；`./scripts/check-doc-index.sh` ✅。文档：`backend.md`（Source Tree + API Endpoints + 新增「安全审计日志（S5）」小节，含 proxy 特殊性与 §P1 双上限）、`src/test_utils.rs` 注释订正、两 locale 各 +11 key、本记录、CHANGELOG（已补 `Added` 条目）。

**验收勾销**：`cargo test audit` ✅（23 个）/ 条目上限 + 截断守恒 + 并发不击穿 ✅ / proxy 去重与拒绝不入表 ✅ / 审计故障不阻断业务 ✅ / agent 敏感值不落库 ✅ / 读写口联调 ✅。

**仍未完成（不可视为已验证）**：① 反代真实链路（无 nginx，`Host` 头模拟不等价）；② 移动端真机；③ 前端区块只在 typecheck+单测层面验证，**未在真实浏览器里看过渲染结果**（需 `./dev.sh restart` 后人眼确认一屏）。
