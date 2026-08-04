# 去除 tmux 作为会话引擎 — 方向规划

> 状态：方向规划稿（2026-07-28），**已冻结为历史依据，不再更新**。
> 触发条件：产品决策 —— tmux 的交互范式与现代化 UX 诉求持续冲突，决定长期去除对 tmux 的依赖。
> 关联：`src/tmux/mod.rs`、`frontend/src/hooks/useTerminal.ts`、AGENTS.md §8（多实现兼容性）、`docs/reference/herdr-reference.md`（待建）。
> **⚠️ 本文档仅为方向规划，不含实施方案、不含代码、不含文件级改动清单。后续 LLM 实施前须先产出独立的实施计划，不得把本文件当作可直接执行的规格。**

> **📌 现状指针（2026-08-04 复核）**：本文档所描述的方向已落地为实施计划 `2026-07-28-pty-engine-implementation.md`（双引擎过渡 + tmux 冻结 + 自研 PtyEngine）。当前状态——**tmux 已冻结为 `TmuxEngine`（只修致命 bug，不加功能），新建会话默认 pty 引擎**；"一次性摘除 tmux" 推迟到该实施计划的 Phase 5（未来独立触发）。**本文档仅作方向史保留，实施细节一律以 pty-engine 计划为准。** 计划 Phase 5 摘除后，本文档随同移入 `archive/`。

> **勘误（2026-07-28）**：实施计划评审后产品决策修订——不做一次性去除，改为**解耦 tmux → 双引擎过渡共存 → tmux 冻结维护 → 未来可无痛摘除**。本文 §3 决策 D3（SessionBackend 抽象）由 P2 待定**提为 P0 必做**；§2.2 P0 的"去除 tmux 依赖"修正为"解耦 tmux 依赖（可摘除）"。落定细节见 `2026-07-28-pty-engine-implementation.md`（D9/D12）。

---

## 1. 背景与根因

### 1.1 现状
OmniTerm 当前架构：`React 前端 → Axum 后端 → tmux（会话引擎）`。**终端（TUI 前端面板）是产品的核心载体——终端内能做大量工作（shell、编辑器、交互式 CLI、TUI 程序等），去除 tmux 仅替换其底层会话引擎，终端交互层不仅保留，且因摆脱 tmux 范式约束而得以强化。** tmux 实际承担四件事：
1. **保活**：shell 进程在浏览器断开后继续运行，重连可接回。
2. **多路复用**：一个后端管理多个 session / pane / window。
3. **pty 承载**：为 shell 提供伪终端（行规、信号、窗口大小）。
4. **agent 检测/状态钩子的事件源**：`src/tmux/` 下 `agent_detect / agent_hooks / agent_state / agent_watch`（约 1500 行）依赖 tmux control mode 与 hook 机制做 agent 状态检测与事件上报。**这是自管 pty 后需要自行实现等价机制的最大隐性成本**——`portable-pty` 不提供 control mode / hook 等价物，须基于进程树（`process_info`）与 pty 流自建事件源。

### 1.2 问题清单（与 tmux 耦合导致的冲突）
| 问题 | 严重度 | 根因 |
|------|--------|------|
| 复制交互受 tmux 鼠标模式掣肘（普通左键拖拽被 tmux 捕获，须 Shift 绕过） | 高 | tmux `mouse on` 优先吃掉鼠标事件，前端无法获得原生选区 |
| 分屏 / resize / 布局切换必须映射 tmux 键位或命令，无法自由定义现代交互 | 高 | UX 范式受限于 tmux 的 multiplexer 模型 |
| 配置依赖 `.tmux.conf` 式文本，难以可视化 | 中 | tmux 配置模型古早 |
| 复制链路与 tmux copy-mode 的边界需手动维护，易回归 | 中 | 前端选区与 tmux 选区两套语义并存 |

### 1.3 根因结论
用户体感的"古早"并非来自 tmux 存在本身，而是来自 **OmniTerm 把 tmux 的 multiplexer 范式暴露给了上层 UX**。只要会话引擎仍由 tmux 提供，现代交互（拖拽即选、点击分屏、命令面板驱动布局）就始终要与其鼠标模式 / 键位模型**协商**，冲突无法根除。

---

## 2. 范围与优先级

### 2.1 目标方向
用 **Axum 后端直接管理 pty（基于 `portable-pty`，参考 herdr 的做法）** 替代 tmux 作为会话引擎，使 UX 完全自由、彻底去除 tmux 外部依赖。

目标架构（方向示意，非实施规格）：
```
React 前端 ──WebSocket──> Axum 后端 ──portable-pty──> shell
                              │
                         自管 session / pane / 保活 / 窗口大小同步
```

### 2.2 优先级分级
- **P0（必做，方向锁定）**：去除 tmux 依赖，Axum 自管 pty 与多 session/pane 生命周期；保活与断线重连由 WebSocket 层接管。
- **P1（UX 现代化，随去 tmux 一并解锁）**：命令面板、点击分屏 / 拖拽 resize、松手即复制（纯左键拖拽，无 Shift 妥协）、可视化设置面板。
- **P2（可选，架构弹性）**：保留 `SessionBackend` 抽象，使 tmux 仍可作为一个可切换后端（非默认），用于兼容历史场景。

### 2.3 不纳入范围（奥卡姆剃刀）
- **不引入 herdr 作为第二引擎**：herdr 的现代感在其自身 TUI，Web 前端套用后用户无感知；且其 agent 编排语义超出 OmniTerm 当前需求，引入即带来概念耦合与技术债。仅在"去 tmux 依赖"的硬性诉求下，借鉴其 `portable-pty` 自管模式，而非依赖其二进制。
- **不重写前端整体**：前端现代化（P1）建立在现有 React 组件 / store 之上，仅新增交互层，不重构既有结构。
- **终端（TUI 前端）必须保留并强化**：去除 tmux 仅替换底层会话引擎（pty 承载 / 多路复用 / 保活），**不是弱化或移除终端**。终端面板是 OmniTerm 的核心载体，去除 tmux 后其交互能力（复制、分屏、resize、命令面板驱动）反而因不再受 tmux 范式约束而增强。不发展独立于 Web 的 ratatui 式外部 TUI 客户端，但 Web 内的终端交互层是重点建设方向。

---

## 3. 设计决策 / ADR

### 决策 D1：去除 tmux，Axum 自管 pty
- **决策**：以 `portable-pty` 在 Axum 内直接管理伪终端与会话，弃用 tmux。
- **理由**：根除 UX 与 tmux 鼠标模式 / 键位的冲突；消除外部依赖与配置；复制 / 分屏等交互完全自定义。
- **否决项**：保留 tmux 并仅在前端做现代化包裹（路径 1）。
- **否决理由**：该路径只能"挡住"古早感，无法根除；冲突（如左键拖拽）仍须与 tmux 协商，长期持续产生回归成本。
- **翻盘条件**：若 `portable-pty` 在目标平台（含容器内）的保活 / 信号 / 窗口大小同步出现无法接受的缺陷，且短期无修复，则回退到"前端包裹 tmux"路径并重新评估。

### 决策 D2：herdr 仅作借鉴，不作依赖
- **决策**：参考 herdr 的 `portable-pty` 自管模式，但不将 herdr 二进制 / socket 纳入架构。
- **理由**：herdr 是独立单二进制 + TUI，无 `[lib]` 只能 IPC 嵌入；其 agent 语义与 OmniTerm 需求不匹配，引入即耦合。
- **否决项**：将 herdr 作为可切换会话后端。
- **翻盘条件**：若未来 OmniTerm 明确需要 agent 编排能力，则重新评估 herdr 集成的成本收益。

### 决策 D4：终端（TUI 前端）保留并强化
- **决策**：去 tmux 仅替换底层会话引擎，终端交互层（Web 内的 TUI 前端面板）必须保留，且是现代化建设的重点。
- **理由**：终端是 OmniTerm 的核心载体，用户大量工作在终端内完成（shell、编辑器、交互式 CLI、TUI 程序）。tmux 被移除后，终端不再受其鼠标模式 / 键位范式约束，现代交互（拖拽即选、点击分屏）得以自由实现。
- **否决项**：将"去 tmux"误解为"弱化终端"或"转向无终端的纯 GUI"。
- **翻盘条件**：不适用（终端保留为恒定前提）。

### 决策 D3：SessionBackend 抽象（P2 可选）
- **决策**：去 tmux 后，是否保留抽象层使 tmux 可回退，作为 P2 待定项。
- **理由**：保留弹性，降低迁移风险；但默认后端为自管 pty。
- **翻盘条件**：若抽象层显著增加复杂度且无近期回退需求，则舍弃（遵循奥卡姆剃刀）。

---

## 4. 多实现差异（AGENTS §8）
- 本期不涉及多客户端协议兼容问题；但 `portable-pty` 在不同 OS / 容器内的 pty 行为存在差异（窗口大小同步、信号处理），实施时须显式处理并兜底，沉淀至对应索引文档，而非仅留在代码注释。
- 若 P2 保留 tmux 后端，则须保证同一套 UX 在两种后端下行为一致，差异点（鼠标模式、复制语义）须显式降级。

---

## 5. 实施分期（仅顺序，不含任务拆解）
> 以下为依赖顺序方向的占位，具体 Phase 与文件改动须由后续实施计划细化。

- **Phase 0（前置）**：盘点 tmux 的全部调用面，绘制"tmux 能力 → 自管 pty 等价实现"映射表。盘点范围不限于 `src/tmux/`（8 文件约 2447 行），须显式覆盖全部调用方——现状全仓 17 个文件约 294 处引用，重点包括 `src/api/sessions.rs`（约 60 处）、`src/ws/terminal.rs`、`src/api/files.rs`、`src/api/hooks.rs`、`src/api/projects.rs`、`src/models/session.rs` 及前端 `useTerminal.ts` 等。
- **Phase 1（地基）**：Axum 引入 `portable-pty`，实现单 session 的 pty 创建 / 流式输出 / 输入转发 / 窗口大小同步 / 断线保活。
- **Phase 2（多路）**：扩展为多 session / 多 pane 的生命周期管理，提供与原 tmux 调用等价的后端接口。
- **Phase 3（切换）**：前端经 Axum 新接口驱动会话，移除对 tmux 的所有调用与配置。
- **Phase 4（UX 现代化，P1）**：命令面板、点击分屏 / 拖拽 resize、松手即复制、可视设置面板。
- **Phase 5（清理）**：移除 tmux 依赖、`.tmux.conf` 相关逻辑、文档更新。

---

## 6. 验收标准（方向级，待实施计划细化）
- [ ] 无 tmux 进程参与，shell 会话仍可保活与重连。
- [ ] 复制 / 分屏 / resize 等 UX 不再受 tmux 鼠标模式或键位约束。
- [ ] `cargo build` / `tsc` 零新增错误；clippy / fmt 通过。
- [ ] 现有三面板（Sidebar | Terminal | FileManager）功能不退化。

---

## 7. 风险与文档闭环
- **主要风险**：pty 自管的保活 / 信号 / 窗口同步在边缘场景（容器、超大输出、异常退出）的稳定性；迁移期双引擎并存导致的状态不一致。
- **缓解方向**：Phase 0 先盘点调用面，降低遗漏风险；保活逻辑优先验证断线重连。
- **文档闭环（实施后）**：更新 `docs/architecture/backend.md`（会话引擎变更）、`CHANGELOG.md`、`PROGRESS.md`；新建 `docs/reference/herdr-reference.md` 沉淀借鉴点；本文件移入 `archive/`。

---

## 8. 术语表
- **会话引擎**：提供 pty 承载、多路复用、保活能力的底层组件。当前为 tmux，目标为 Axum 自管 pty。
- **终端 / TUI 前端**：OmniTerm 内承载 shell 与交互式程序的面板，是产品核心载体；去 tmux 后仍保留并强化，区别于独立的 ratatui 式外部 TUI 客户端。
- **保活**：浏览器 / 客户端断开后，shell 进程不终止，可重连接回。
- **portable-pty**：Rust pty 抽象库（herdr 所用），替代直接调用 tmux。
