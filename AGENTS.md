# OmniTerm

Web 版 tmux/pty 终端管理器，一个浏览器标签页观察并驱动多个 AI coding agent。Rust (Axum) 后端 + React (Vite/TS) 前端，FSL-1.1-MIT。`CLAUDE.md` 是本文件的符号链接。

## 关键目录

- `src/` — Rust 后端（`api/` 路由、`ws/` WebSocket、`acp/` agent 协议、`engine/` 终端引擎 pty/tmux、`proxy/` 端口转发）；架构见 `docs/architecture/backend.md`
- `frontend/src/` — React 前端（`components/`、`stores/` zustand、`hooks/`）；架构见 `docs/architecture/frontend.md`
- `migrations/` — SQLite 迁移（新增即登记，勿改已有文件）
- `tests/` — Rust 集成测试；前端测试与源码同目录放置（`*.test.ts`）
- `docs/` — 开发文档，改动前按下文「文档索引」强制比对
- `.env.local` — 分支专属变量（端口/域名/数据库隔离标识，**gitignored**，各 worktree 独立，缺了先问维护者要，勿自行编造）

## 常用命令

```bash
./dev.sh start|restart|stop|status|logs   # 开发环境唯一入口（禁止直接 cargo run / target 二进制）
cargo test --workspace                    # Rust 全量测试
cargo test <名称> -- --exact              # 单个测试；跑 tests/ 下某个集成测试加 --test <文件>
cd frontend && pnpm lint                  # ESLint
cd frontend && pnpm test --run <过滤>     # vitest 单测（不带 --run 进 watch 模式）；性能基准单独用 pnpm bench，不进 test
cd frontend && pnpm build                 # 构建，含 typecheck
cd frontend && pnpm exec tsc -b           # 前端 typecheck
cargo fmt --all && cargo clippy --quiet --workspace --all-targets -- -D warnings
./scripts/check-doc-index.sh              # 校验本文件文档索引完整性（提交前自动跑不到，改索引后手动跑）
```

陷阱（都真实发生过）：

- **fresh clone 必须先构建前端**（`cd frontend && pnpm install && pnpm build`），否则任何 `cargo check/test` 被 `build.rs` 拦下（`src/embedded.rs` RustEmbed 要求 `frontend/dist/index.html` 编译期存在）。
- **cargo test 需要 tmux 二进制**（tmux control-mode 测试）。
- **前端 typecheck 必须 `tsc -b`**：根 tsconfig 是 references 空壳，裸 `tsc --noEmit` 不检查任何文件，类型错误会漏网。
- pre-commit hook（`scripts/hooks/pre-commit`）自动跑 fmt/clippy/tsc/lint/前端测试；`dev.sh start` 会自动把 `core.hooksPath` 指到 `scripts/hooks`，勿改回 `.githooks`（历史上因此失效过）。

## 核心规则

1. **提交约定**：每次改动后提交；功能开发/修复用 `feat:`/`fix:`，文档/配置用 `docs:`/`chore:`。
2. **CHANGELOG.md 只写实质性功能改动**：开发文档改动不写；反复修改未解决的 bug、中间调试状态、已回退的改动不写。
3. **启动开发服务只走 `./dev.sh`**：开发构建（debug / `target/` 产物）默认连 `~/.omniterm/omniterm-dev.db`，release 正式安装默认连 `~/.omniterm/omniterm.db`。手动运行 release 二进制或跨 worktree 必须显式传 `--db`（路径见 `.env.local` 的 `BRANCH_BINARY_NAME`）。
4. **查源码**：先 `codegraph sync`；不知道代码在哪用 `codegraph_explore`，已知符号/路径用 `rg -n` + `Read`，要影响面用 `codegraph_impact`；配置/文档等非索引文件直接 Read/Grep。

## 工程准则

1. **自主执行与沟通边界** — 先规划后编码；方案清晰的 bug 修复、局部重构、遵循现有模式的常规开发直接实施，不反复请示。以下情况停止编码并请示：① 须破坏现有分层架构或修改核心基础类；② 须引入新外部依赖或重大框架升级；③ 多方案在性能/可维护性上有明显取舍且无法确定最优解。请示时汇报：结构阻碍/方案分歧、倾向性建议、影响范围。
2. **长期主义** — 禁止为快速完成当前任务牺牲可维护性或制造新技术债。
3. **严守分层** — 遵循 `docs/architecture/backend.md` 的分层约定，不越权调用；不盲从历史遗留代码（超长函数、硬编码、全局状态），新代码高内聚低耦合。
4. **局部改善** — 修改某文件时顺手处理当前修改区域内的重复代码或硬编码，禁止扩大到不相关范围。
5. **缺陷修复** — 追溯根因而非掩盖症状（禁止仅用 try-catch/Result::ok() 吞异常或 if-else 绕过）；必要时加诊断日志请用户复现；修复后评估对依赖模块的副作用。排查 bug 先读 `docs/dev/debug-guide.md`。
6. **技术债红线**（严禁）：禁 Copy-Paste（须提取公共函数）；禁魔法数字/硬编码（提取至常量/配置）；禁死代码；禁无界累积/无界缓冲（一切 push/append/collect 必须有显式上限 + 超限策略 + 单测，见 `docs/dev/performance-and-safety.md` §P1）。
7. **抽象有度** — 默认不增实体，新实体须由当前已确证的需求证明。但出现以下信号必须主动解耦：① 同一判断/转换/校验在 ≥2 处出现 → 抽共享函数立单一真源；② 一处改动牵动多文件/多层 → 引入边界隔离易变部分；③ 参数集/字段/协议预期持续扩展 → 数据驱动 + 类型安全的表/注册机制，不散落 if/else。判定准绳：抽象是否降低了「未来修改同一类需求」的代价；只把一件事拆成三件却没缩小影响面 = 过度设计，按奥卡姆剃刀回退。
8. **多实现兼容性** — 代码服务于多实现满足的协议/接口/约定时，不得把单一实现的行为当作约定的全部事实；可选/可能缺省的字段/通知/能力必须显式回退兜底（回退针对已确认的真实差异，非臆测）。改动前先确认各实现的行为差异，差异知识沉淀到对应索引文档，勿只留代码注释里。

## 配置统一管理

分支专属变量（端口/域名/数据库隔离标识等）只在 `.env.local`（gitignored，各 worktree 独立），变量清单见该文件注释与 `dev.sh`。**禁止在代码里硬编码**端口/域名（`src/main.rs` default_value、Vite allowedHosts、Dockerfile EXPOSE、docker-compose ports 等）；改端口/域名只改 `.env.local`。

硬性规则：

- **版本号**：`Cargo.toml` 的 `version` 是唯一真相源（前端经 `vite.config.ts` 构建时注入，Rust 用 `env!("CARGO_PKG_VERSION")`）。改版本只用 `./scripts/bump-version.sh <X.Y.Z>`，禁止手改 `frontend/package.json`。
- **后端配置只走命令行参数或 `OMNITERM_*` 前缀 env**：禁止 export 通用名环境变量（`BIND_ADDR`/`BACKEND_PORT`/`DATABASE_URL`/`JWT_SECRET` 等）。后端派生的用户终端会继承其环境，通用名会让正式版 omniterm 在用户终端里被开发配置劫持（实测报 `Address already in use`）。
- **二进制名**：`Cargo.toml` 的 `[package] name` 全分支统一为 `omniterm`，不按分支区分（保证 merge 不覆盖、发布渠道一致）。
- **数据库隔离**：db 路径由 dev.sh 基于 `BRANCH_BINARY_NAME` 拼出并以 `--db` 传给后端（`~/.omniterm/<BRANCH_BINARY_NAME>.db`）。无 `--db` 时的默认库（`src/main.rs` `default_db_stem`）：开发构建固定 `omniterm-dev.db`，release 正式版按 `omniterm.db`。历史上开发二进制曾因按 argv0 推导撞正式版库并应用新 migration（20260812 / 20260823 两次事故），勿回退该逻辑。

## 边界与禁区

- 禁止直接 `cargo run` / `target/debug/omniterm` 启动开发服务（原因见核心规则 3）。
- 禁止跳过 pre-commit（`--no-verify`）绕过检查；检查失败先修根因。
- 禁止提交 `.env.local`、密钥、token；`.gitignore` 覆盖的产物不入仓。
- 文档必须按分类放入 `docs/` 子目录（architecture / workflows / dev / reference / visual-design），根目录不放；新文档若对应「改某处代码前必读」，须登记到下方文档索引（`check-doc-index.sh` 校验）。
- 分支/发布操作（merge、sync-main.sh、打 tag）先读 `docs/workflows/branch-workflows.md` 与 `release-guide.md`；main 分支不含本文件与 `docs/`（sync 黑名单）。

## 测试约定

- Rust 单测随源码（`#[cfg(test)]`），集成测试在 `tests/`（spawn 抽象/运行时矩阵相关新增变体前必读 `docs/workflows/integration-checklist.md`）；tmux control-mode 测试依赖 tmux 二进制。
- 前端测试与源码同目录（`*.test.ts`，vitest + jsdom，入口 `frontend/src/test/setup.ts`）；性能基准在 `vitest.bench.config.ts`，已移出 `pnpm test`（避免 pre-commit 随机失败）。
- 手动回归用例见 `docs/reference/user-testing.md`；pty 帧渲染有自动化回归脚本 `scripts/pty-frame-regression.mjs`。

## 术语

聊天面板术语（queued follow-up / queue slot / drain / chip / in-flight 等）见 `CONTEXT.md`；ACP 协议细节见 `docs/reference/acp-protocol-reference.md`。

## 文档索引

> **强制执行**：接收用户指令或编码前，必须扫描此表，将任务与「何时读取」列逐一比对，**命中即读**，读完全部命中文档后再动手。跳过导致遗漏架构约束或已有踩坑记录属违规。新增文档按分类入 `docs/` 子目录，并按需登记本表。

| 文档 | 何时读取（触发条件） | 何时维护（写回触发） |
|------|---------------------|---------------------|
| `docs/architecture/backend.md` | 修改 Rust 后端（API 路由、中间件、数据库模型、tmux/fs 模块） | 新增 API 端点、模块拆分/合并、变更 CLI 参数或环境变量；**记录协议多实现行为差异**（工程准则 8） |
| `docs/architecture/frontend.md` | 修改 React 前端（组件、store、hook、路由、依赖升级） | 新增组件/store/hook、目录结构变化、关键依赖版本变更 |
| `docs/architecture/frontend-patterns.md` | 决定组件结构、复用已有前端架构模式时；**新加状态栏按钮 / sidebar 弹出面板前必读** | 新增前端架构模式 entry、记录已有约定 |
| `docs/workflows/agent-edit-manual.md` | 接具体修改任务（加命令/改配置/修 bug/加翻译）时，搜目标组件列文件 | 新增「有特殊维护约定的组件」entry、记录修改路径 |
| `docs/workflows/integration-checklist.md` | 集成新的 spawn 抽象（subprocess / container / FFI）**或**给已有枚举新增变体（`runtime_kind` / `agent_kind` / `project_type`）前**必读** | 新增踩坑案例 / 补检查项 |
| `docs/workflows/branch-workflows.md` | 执行 git 分支操作（merge、rebase、cherry-pick）、操作多 worktree、执行 sync-main.sh 同步 | 分支策略变更、新增分支类型、安全守则调整 |
| `docs/workflows/worktree-setup.md` | 初始化开发环境、添加新 worktree、配置 remote | worktree 目录/用途变更、remote 地址变更、排除文件列表调整 |
| `docs/workflows/release-guide.md` | 执行正式发布（同步 main、打 tag、推送公共仓、npm 发布） | 发布流程变更、CI 配置调整、sync-main.sh 黑名单调整 |
| `docs/visual-design/ui-style-guide.md` | 任何涉及 UI 的**修改或规范撰写**（组件样式、布局、色板、字体、尺寸 token、面板/弹窗视觉态、动效）— **必读** | 新增通用组件规范、调整设计语言（色板/圆角/间距）、补充面板/弹窗尺寸规格 |
| `docs/reference/user-testing.md` | 功能开发完成后的手动回归测试 | 新增测试用例、发现并记录已知限制 |
| `docs/dev/debug-guide.md` | 遇到 bug 先读它（路由索引）定位领域，再按需读 `docs/dev/debug-patterns/` 下对应领域文件 | 新踩坑后提炼为模式（规律 → 弯路 → 案例证据），按领域归档到 `debug-patterns/` 并**登记一行到 debug-guide.md 索引**；详见其写作规范 |
| `docs/dev/performance-and-safety.md` | 涉及数据累积/缓冲、持久化写入策略、外部输入（agent 通知/用户输入/文件内容）、命令执行、跨层数据传输或吞吐量相关的代码前**必读** | 新增性能/安全红线、检查项调整、补充新案例 |
| `docs/reference/requirements.md` | 规划新功能、确认待办优先级 | 新增/变更功能需求、标记需求完成 |
| `docs/reference/auth-not-enforced.md` | 修改鉴权/认证相关代码（auth 路由、`require_auth_mw`、登录限流、前端登录 UI）、部署公网前的安全评审 | 鉴权架构变更、安全机制启用/关闭逻辑调整 |
| `docs/reference/references.md` | 需要查看外部参考实现或 License 合规规则 | 新增参考仓库、License 规则变更 |
| `docs/reference/chat-history-loading-comparison.md` | 调整聊天历史加载策略（分页阈值、触顶加载、前插锚点、正文限界）前读 | 新增参考实现对比、本项目阈值变更 |
| `docs/dev/plans/2026-07-30-ui-polish.md` | 修改侧栏宽度/行布局、Modal 体系、文件表格列宽、像素控件（range/toast/badge）前参考其 ADR（D1-D7） | ADR 决策被推翻或翻盘条件触发时更新状态 |
| `docs/dev/plans/2026-08-10-acp-session-reliability.md` | 修改 `turn_accumulator.rs` / `chat_persistence.rs` / `useAcpChat.ts` / `ChatView.tsx` 任一项前**必读** | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-08-13-port-forward-proxy.md` | 修改 `src/proxy/`、`src/api/mod.rs`（路由挂载）、`src/main.rs`（`AppState`）、`frontend/vite.config.ts`（代理）、`frontend/src/utils/proxyUrl.ts`、终端/聊天链接重写逻辑任一项前**必读** | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-08-16-files-watch-hardening.md` | 修改 `src/api/files_watch.rs`、`src/fs/mod.rs` 的 ignore 规则、`frontend/src/hooks/useFileWatcher.ts`、`FileManager.tsx` 文件变更刷新链路任一项前**必读** | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-08-18-permission-recycle-notice.md` | 修改 `src/acp/reaper.rs`（回收分支）、`src/acp/client.rs`（system 通知通道）、`src/ws/acp.rs`（system_message 帧）、`chat_messages.role` 语义任一项前**必读** | 行为变更、勘误时更新 |
| `docs/dev/plans/2026-08-18-ghost-message-and-known-issues.md` | 修改 `useAcpChat.ts`（replay 帧门控 / hydrate 收敛）、`chatStore.ts`（sync 路径）、`chat_persistence.rs`（sync_messages 匹配）、`turn_accumulator.rs`（text 语义）前**必读** | Phase 推进、方案实施后更新状态 |
| `docs/dev/plans/archive/2026-08-30-acp-work-time.md` | 修改 `turn_accumulator.rs`（`WriterCmd` / `finalize_turn` 记账）、`chat_persistence.rs`（`finalize_message` / `ChatMessageRow`）、`client.rs`（审批 pause / shutdown 收尾）、`sessions` 时长列、`ChatMessage` 耗时、`utils/turnClock.ts`（流式实时计时）任一项前**必读** | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-09-03-pty-viewport-fingerprint-anchor.md` | 修改 pty 历史视口锚定相关代码（`utils/viewportController.ts` 的锚点/重拉、`src/engine/pty/vt.rs` 的 `encode_viewport_frame`/`relocate_anchor`、`frame.rs` 与 `ws/terminal.rs` 的 `viewport_request`/`viewport_fp` 字段）前**必读**——「距底偏移 y 不是稳定标识」这条结论是两轮排查的产出，不看方案容易退回按位置换算的老路 | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-09-08-pty-incremental-sync-hardening.md` | 修改 cell_frame 增量同步链路（`src/engine/pty/vt.rs` 的 `encode_cell_frame`/帧序号、`terminal_ws.rs` 转发循环、`frame.rs` 的 `CellFrame.seq`、`frontend/src/hooks/useCellFrame.ts` 队列、`useTerminal.ts` 状态行写入）前**必读**——「无校准的增量镜像必不自愈」是六轮修后仍复发的结论，止血方案 A（周期全帧+seq）+C（状态行 resync）在此 | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/plans/2026-09-10-chat-file-attachments.md` | 修改聊天输入框附件链路（`ChatInput` 的 + 按钮/隐藏 input/文件 chip、`ChatAttachDrawer.tsx`、`fileAttachment.ts`、WS `prompt.files` 帧、`build_prompt_blocks`）前**必读**——「文件走 base64 blob 内联、落库只存元数据、能力缺失即拒绝」三条决策及翻盘条件在此 | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `docs/dev/reference/PLAN-TEMPLATE.md` | 在 `docs/dev/plans/` 下新建实施/设计计划文档前，过一遍其检查点清单（非强制结构，按任务裁剪） | 检查点需调整时更新 |
| `docs/dev/plans/backlog/qa-quality-gates-followups.md` | 推进质量门禁 P2 项（warn→deny、CI 耗时、`dev.sh check`）时 | P2 项状态变更、dead-code allow 清理 |
| `PROGRESS.md` | 了解项目整体进展、架构决策背景 | 完成一个完整阶段（如 Phase N）后更新里程碑 |
| `CHANGELOG.md` | 查看面向用户的版本变更历史 | 有实质性的新功能/修复/重构/破坏性变更后**必须添加条目**（核心规则 2） |

## 有意为之的「反常」点（勿顺手修正）

- `dev.sh` 刻意不 export 后端配置环境变量，只用命令行参数传端口/`--db`（原因见「配置统一管理」）。
- `src/engine/pty/bench.rs` 是独立研究二进制 `bench-frames`，不进生产路径。
- 开发期前端暴露 `window.__appStore` 调试钩子，是刻意的。
- `.env.local` 在仓内但被 gitignore：各 worktree 身份不同，禁止提交或同步。

---

**复核说明**：以下内容因会过时或可从配置推断而**故意未写入**——具体端口号（在 `.env.local`）、`.env.local` 变量逐项表格（文件自身注释即清单）、依赖与技术栈版本（`Cargo.toml` / `package.json`）、CI job 步骤（`.github/workflows/ci.yml`）、pre-commit 具体检查项（`scripts/hooks/pre-commit`）、README 的产品介绍、`dev.sh` 内部实现细节。
