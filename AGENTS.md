# OmniTerm

Web-based tmux terminal manager. Three-panel layout: Sidebar | Terminal | FileManager.
Rust (Axum) backend + React (Vite + TypeScript) frontend. FSL-1.1-MIT licensed.

> 进度里程碑见 `PROGRESS.md`

## Quick Start

```bash
./dev.sh start|stop|status|logs
```

## 核心规则

1. **严格遵守AGENTS.md所有条例**
2. **每次改动后提交**：功能的开发/修复用 `feat:` / `fix:`，文档/配置用 `docs:` / `chore:`
3. **CHANGELOG 只写实质性的功能改动，排除开发文档改动** — 反复修改未解决的 bug、中间调试状态、回退的改动不写
4. **查源码**：先 `codegraph sync`。不知道代码在哪 → `codegraph_explore`；已知符号名/路径 → `rg -n` + `read(offset/limit)`，勿对同一文件重复 explore；要 callers/影响面 → `codegraph_callers` / `codegraph_impact`；主战场单文件通读一遍；配置/文档/非索引文件直接 Read/Grep

## 工程准则

1. **自主执行与沟通边界**
   - **先规划后编码**：接收任务后，须先理清实现思路（可简述方案），分析确认无架构冲突后再编写代码。
   - **常规任务自主推进**：对于方案清晰、不违背软件工程规范的 Bug 修复、局部重构、遵循现有模式的常规开发，无需反复人类请示确认，直接实施。
   - **仅在以下高风险或方向模糊情况停止编码并请示**：
     1. 必须破坏现有分层架构或修改核心基础类才能完成任务。
     2. 需引入新的外部依赖或重大框架升级。
     3. 存在多种实现方案，且各方案在性能/可维护性上有明显取舍，你无法确定最优解。
   - **请示时汇报**：1. 结构阻碍/方案分歧；2. 你的倾向性建议；3. 影响范围。
2. **长期主义** — 代码将长期留存并被他人接手。禁止为快速完成当前任务而牺牲可维护性或制造新技术债。
3. **严守分层** — 遵循项目分层架构（Controller/Service/Repository），严禁越权调用。不盲从历史遗留代码（超长函数、硬编码、全局状态），新代码必须高内聚低耦合。
4. **局部改善** — 修改某文件时，顺手处理当前修改区域内的重复代码或硬编码。禁止扩大到不相关范围。
5. **缺陷修复** — 追溯根因而非掩盖症状（禁止仅用 try-catch 吞异常或 if-else 绕过），必要时添加诊断日志请求用户复现问题。修复后评估对依赖模块的副作用，确保方案普适。
6. **技术债红线**（严禁）：
   - 禁 Copy-Paste 代码（须提取公共函数）
   - 禁魔法数字/硬编码（须提取至常量/配置）
   - 禁留存无用死代码
   - 禁无界累积/无界缓冲（一切 push/append/collect 的累积结构必须有显式上限 + 超限策略 + 单测，详见 `docs/dev/performance-and-safety.md` §P1）
7. **奥卡姆剃刀与可维护性的平衡（抽象有度）**
   - **默认不增实体**：没有真实收益时，不引入多余的抽象层、配置项、依赖、工具函数或开关；新实体须由**当前已确证**的需求证明，而非"将来可能用到"。
   - **但出现以下任一信号时，必须主动增加抽象层或拆分模块来解耦**——此时"当下代码量最少"要让位于"未来改起来省力"：
     1. **逻辑重复**：同一段判断 / 转换 / 校验 / 分支在 ≥2 处出现（含复制粘贴或近似实现），应抽出共享函数 / 模块 / 工具，确立单一真源。
     2. **修改影响面大**：一处改动因耦合会牵动多个文件、多个层或多种命令，应引入边界（接口 / 适配器 / 状态机 / 注册表）把易变部分隔离，使改动收敛在局部。
     3. **业务易变**：参数集、字段、外部协议或 UI 形态预期会持续扩展（例如「一键传参」的参数识别表），应以**数据驱动 + 类型安全**的表 / 配置 / 注册机制承载，而非散落的 `if/else` 与硬编码分支。
   - **判定准绳**：一个抽象层是否成立的唯一标准是——它是否降低了"未来修改同一类需求"的代价。若抽离后同类改动被收敛到一处、新增同类只需加一行数据，则抽象成立；若只是把一件事拆成三件却没缩小影响面，则属过度设计，应按奥卡姆剃刀回退。
8. **多实现兼容性（不为单一实现背书）** — 当代码服务于一个被多种实现/客户端/上游满足的协议、接口或约定时，**不得把某一种实现的行为当作该约定的全部事实**。对约定中非强制、可选或可能缺省的字段/通知/能力，必须考虑其他实现可能不提供，并做显式回退或兜底；回退逻辑是应对"已确认的真实差异"，不是臆测的"将来可能用到"（不违反第 7 条）。新增或改动此类逻辑前，先确认该字段/能力在各实现下的行为差异，而非以手头这一个实现推断全局。差异知识应沉淀到对应索引文档（见下方文档索引），勿只留在代码注释里。

## 配置统一管理

**分支专属变量（端口/域名/版本/binary 名等）必须通过 `.env.local` 统一管理，不得硬编码到代码里。**

### `.env.local` 可用变量

| 变量 | 含义 | 消费者 |
|------|------|--------|
| `BACKEND_PORT` | dev.sh 启动的后端 HTTP 端口 | Rust `Args.port` (clap env) / Vite proxy |
| `FRONTEND_PORT` | dev.sh 启动的前端 HTTP 端口 | Vite `server.port` |
| `DOCKER_PORT` | Docker 容器内监听端口 | Dockerfile `ARG` / docker-compose `BIND_ADDR` |
| `DOCKER_PORT_MAPPING` | Docker 端口映射 `host:container` | docker-compose `ports` |
| `BRANCH_NAME` | 当前 worktree 分支名 | Rust 启动日志 |
| `BRANCH_BINARY_NAME` | 数据库隔离标识（`omniterm-dev` / `omniterm-preview` / `omniterm`），决定各 worktree 的 SQLite 文件名 | dev.sh 生成 `DATABASE_URL` |
| `DATABASE_URL` | SQLite 连接串，由 dev.sh 基于 `BRANCH_BINARY_NAME` 生成（`~/.omniterm/<BRANCH_BINARY_NAME>.db`） | Rust `Args.db` (clap env) |
| `DOMAIN` | 部署域名 | Vite `allowedHosts` |

> **版本号不在此配置**：版本号由 `Cargo.toml` 的 `version` 字段作为唯一真相源（git 跟踪，随分支 merge 自动同步）。
> 前端经 `vite.config.ts` 在构建时读取 `Cargo.toml` 注入 `import.meta.env.VITE_APP_VERSION`；Rust 用 `env!("CARGO_PKG_VERSION")`。
> 改版本号统一用 `./scripts/bump-version.sh <X.Y.Z>`（同步 `Cargo.toml` + `frontend/package.json`）。

### 硬性规则

- **禁止在代码里硬编码**端口/域名/binary 名（`src/main.rs` `default_value`、Vite `allowedHosts`、Dockerfile `EXPOSE`、docker-compose `ports` 等）
- 版本号**禁止硬编码**，统一由 `Cargo.toml` 的 `version` 管理；改版本号用 `./scripts/bump-version.sh`
- 改端口/域名/binary 名时**只改 `.env.local`**（各 worktree 独立）；二进制名固定为 `omniterm`，改它需改 `Cargo.toml`（各分支同步，见下）
- dev.sh 已 `source .env.local` 并 export 全部变量；Dockerfile 用 `ARG` + 默认值；docker-compose 用 `env_file` 引入
- **二进制名统一**：`Cargo.toml` 的 `[package] name` 全分支统一为 `omniterm`（编译产物 / Docker 镜像 / crates.io 包名一致），不按分支区分，merge 不会覆盖
- **数据库隔离**：db 路径由 dev.sh 基于 `BRANCH_BINARY_NAME` 生成 `DATABASE_URL`（`~/.omniterm/<BRANCH_BINARY_NAME>.db`）注入后端；`BRANCH_BINARY_NAME` 仅为数据库隔离标识（非二进制名），各 worktree 在 `.env.local` 独立维护，merge 不会串库

## 文档索引

> **强制执行**：接收用户指令或编码前，必须先扫描此表，将任务与「触发条件」列逐一比对，**命中即读**。读完全部命中文档后再动手。跳过此步骤导致遗漏架构约束、工作流规则或已有踩坑记录，属违规。

> 写新文档时**必须**按分类放入对应子目录，`docs/` 根目录下原则上不放文档，除非有明确理由。

| 文档 | 何时读取（触发条件） | 何时维护（写回触发） |
|------|---------------------|---------------------|
| `docs/architecture/backend.md` | 修改 Rust 后端（API 路由、中间件、数据库模型、tmux/fs 模块） | 新增 API 端点、模块拆分/合并、变更 CLI 参数或环境变量；**记录协议多实现行为差异**（见 §8 多实现兼容性） |
| `docs/architecture/frontend.md` | 修改 React 前端（组件、store、hook、路由、依赖升级） | 新增组件/store/hook、目录结构变化、关键依赖版本变更 |
| `docs/architecture/frontend-patterns.md` | 决定组件结构、复用已有前端架构模式时；**新加状态栏按钮 / sidebar 弹出面板前必读**（含文件结构、hook 用法、子组件拆分、复制清单） | 新增前端架构模式 entry、记录已有约定 |
| `docs/workflows/agent-edit-manual.md` | 接具体修改任务（加命令/改配置/修 bug/加翻译）时，搜目标组件列文件 | 新增「有特殊维护约定的组件」entry、记录修改路径 |
| `docs/workflows/integration-checklist.md` | 集成新的 spawn 抽象（subprocess / container / FFI）**或**给已有枚举新增变体（`runtime_kind` / `agent_kind` / `project_type`）前**必读** | 新增踩坑案例 / 补检查项 |
| `docs/workflows/branch-workflows.md` | 执行 git 分支操作（merge、rebase、cherry-pick）、操作多 worktree、执行 sync-main.sh 同步 | 分支策略变更、新增分支类型、安全守则调整 |
| `docs/workflows/worktree-setup.md` | 初始化开发环境、添加新 worktree、配置 remote | worktree 目录/用途变更、remote 地址变更、排除文件列表调整 |
| `docs/workflows/release-guide.md` | 执行正式发布（同步 main、打 tag、推送公共仓、npm 发布） | 发布流程变更、CI 配置调整、sync-main.sh 黑名单调整 |
| `docs/visual-design/ui-style-guide.md` | 任何涉及 UI 的**修改或规范撰写**（组件样式、布局、色板、字体、尺寸 token、面板/弹窗视觉态、动效）— **必读** | 新增通用组件规范、调整设计语言（色板/圆角/间距）、补充面板/弹窗尺寸规格 |
| `docs/reference/user-testing.md` | 功能开发完成后的手动回归测试 | 新增测试用例、发现并记录已知限制 |
| `docs/dev/debug-guide.md` | 遇到 bug 先读它（路由索引）定位领域，再按需读 `docs/dev/debug-patterns/` 下对应领域文件，看是否有已沉淀模式命中 | 新踩坑后提炼为模式（规律 → 弯路 → 案例证据），按领域归档到 `debug-patterns/` 并**登记一行到 debug-guide.md 索引**；详见其写作规范（家族合并、体积纪律、无理论不入库） |
| `docs/dev/performance-and-safety.md` | 涉及数据累积/缓冲、持久化写入策略、外部输入（agent 通知/用户输入/文件内容）、命令执行、跨层数据传输或吞吐量相关的代码前**必读** | 新增性能/安全红线、检查项调整、补充新案例 |
| `docs/reference/requirements.md` | 规划新功能、确认待办优先级 | 新增/变更功能需求、标记需求完成 |
| `docs/reference/auth-not-enforced.md` | 修改鉴权/认证相关代码（auth 路由、`require_auth_mw`、登录限流、前端登录 UI）、部署公网前的安全评审 | 鉴权架构变更、安全机制启用/关闭逻辑调整 |
| `docs/reference/references.md` | 需要查看外部参考实现或 License 合规规则 | 新增参考仓库、License 规则变更 |
| `docs/reference/chat-history-loading-comparison.md` | 调整聊天历史加载策略（分页阈值、触顶加载、前插锚点、正文限界）前读——内含 claudecodeui / openchamber 的实测阈值与已知难题 | 新增参考实现对比、本项目阈值变更 |
| `PROGRESS.md` | 了解项目整体进展、架构决策背景 | 完成一个完整阶段（如 Phase N）后更新里程碑 |
| `CHANGELOG.md` | 查看面向用户的版本变更历史 | 有实质性的新功能/修复/重构/破坏性变更后**必须添加条目**（反复修改未解决的 bug 不写） |
| `dev.sh` | 启动/停止开发环境（`./dev.sh start\|stop\|status\|logs`） | 端口配置变更、启动逻辑调整 |
| `scripts/bump-version.sh` | 准备发布时同步版本号：`./scripts/bump-version.sh 0.2.0` | 版本号文件路径变更 |
| `scripts/sync-main.sh` | 同步 dev → main（黑名单排除开发文档 + 修复分支配置） | 黑名单调整、分支配置修复逻辑变更 |
| `docs/dev/plans/PLAN-TEMPLATE.md` | 在 `docs/dev/plans/` 下新建实施/设计计划文档前，建议过一遍其**检查点清单**（非强制结构，按任务性质裁剪） | 检查点需调整（新增/精简维度）时更新 |
| `docs/dev/plans/2026-07-28-pty-engine-implementation.md` | 涉及会话引擎（`src/tmux/`、`src/engine/`、pty、`runtime_kind`、终端 WS 链路）的任何开发前**必读**；tmux 相关代码已冻结，只修致命 bug 不加功能 | Phase 推进/决策变更/勘误时更新；Phase 5 摘除后随方向规划移入 archive |
| `docs/dev/plans/2026-07-24-quality-gates.md` | 修改质量门禁（CI、pre-commit、clippy、rustfmt、cargo-deny、tsc strict、check-doc-index）任一配置前 | 新增门禁检查、调整分阶段策略、跟进 backlog（§2.3 P2） |
| `docs/dev/plans/2026-07-30-ui-polish.md` | 修改侧栏宽度/行布局、Modal 体系、文件表格列宽、像素控件（range/toast/badge）前参考其 ADR（D1-D7） | ADR 决策被推翻或翻盘条件触发时更新状态 |
| `docs/dev/plans/2026-07-30-mobile-interaction-optimization.md` | 修改移动端手势（滑动切 tab/触摸滚动/长按）、MobileKeyBar、状态栏交互前参考其 ADR（D1-D6） | ADR 决策被推翻或翻盘条件触发时更新 |
| `docs/dev/plans/2026-08-10-acp-session-reliability.md` | 修改 `turn_accumulator.rs` / `chat_persistence.rs` / `useAcpChat.ts` / `ChatView.tsx` 任一项前**必读**（P0 blocks 污染修复、cooked 收敛、text 限界、触顶锁、会话上限的决策与实施分期） | Phase 推进、决策翻盘、实施偏差（就地加「勘误」块） |
| `.github/workflows/ci.yml` | 修改 CI 门禁（触发分支、检查项、audit job）前 | 调整 CI 检查项、分阶段启用 clippy/fmt/deny、拆分 job |
| `scripts/hooks/pre-commit` | 修改提交前检查前 | 调整 pre-commit 纳入的检查（lint/fmt/clippy/test） |
| `deny.toml` / `rustfmt.toml` | 修改依赖审计或格式化基线前 | 调整许可证白名单、格式化选项 |
| `docs/dev/plans/backlog/qa-quality-gates-followups.md` | 推进质量门禁 P2 项（warn→deny、CI 耗时、`dev.sh check`）时 | P2 项状态变更、dead-code allow 清理 |
