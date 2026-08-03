# 大文件优化方向计划（Code Quality Pass）

> 状态：进行中（2026-08-03）
> 触发条件：代码规模审计产出；后续接「拆分 Sidebar / 拆分 ws 处理函数」等具体任务时，以此为方向指引
> 关联：`docs/architecture/frontend-patterns.md`（Section 拆分原则）、`docs/dev/plans/PLAN-TEMPLATE.md`、AGENTS.md §7 奥卡姆剃刀
> 定位：**方向性计划**，只记录现象与解决方向，不含具体代码改动；具体拆分任务落地时另出实施计划

---

## 1. 背景（现象与根因）

对 `src/` 与 `frontend/src/` 全量行数审计（2026-08-03，排除 dist/node_modules/target）：

| 文件 | 行数 | 现象归类 |
|------|------|----------|
| `frontend/src/index.css` | 2,657 | 见排除项（不处理） |
| **`frontend/src/components/Sidebar/Sidebar.tsx`** | **2,618** | **God Component** |
| `src/acp/client.rs` | 1,260 | 核心类偏大（暂缓） |
| `frontend/src/components/FileManager/FileManager.tsx` | 1,080 | 大组件（暂缓） |
| `frontend/src/hooks/useAcpChat.ts` | 1,053 | hook 偏大（暂缓） |
| `frontend/src/stores/chatStore.ts` | 1,010 | store 偏大（暂缓） |
| `src/ws/acp.rs` | 879 | 巨型函数 |
| `src/api/files.rs` | 879 | 超长函数 |
| `frontend/src/components/Chat/ChatInput.tsx` | 842 | 暂缓 |
| `src/ws/terminal.rs` | 826 | 暂缓 |

**核心现象**：
1. **`Sidebar.tsx`：单个组件承载全部职责**。一个 `Sidebar()` 主组件横跨 2,500+ 行，内部 50+ 个 useState 管理五类互不相干的状态（项目/会话/worktree 创建、路径浏览、路径修复），8 个 modal/dialog 全部内联在返回 JSX 中，数据加载副作用（projects/worktrees/sessions 三套）与渲染混杂。**违背项目自身 `frontend-patterns.md` 的 Section 拆分原则**，且无 `Settings` 那样的子组件结构。
2. **`src/ws/acp.rs`：`handle_acp_ws` 约 530 行巨型函数**（`ws/acp.rs:307-838`）。一个函数内串联订阅、快照、多事件分支（prompt/permission/todo/turn）处理，改动一处需通读全局。
3. **`src/api/files.rs`：`resolve_base_from_query` 约 360 行超长函数**（`files.rs:188-549`）。路径解析多分支（project/session/query 来源）全部挤在一个函数里。

**根因**：功能迭代中「往主文件里加」的惯性积累，没有在职责边界形成时及时拆分子模块；前端缺少对 Section 拆分原则的强制约束，后端 handler 缺少函数级拆分习惯。

## 2. 范围与优先级

### P0 — `Sidebar.tsx` 拆分（首要靶点）
- 目标：主组件回归「列表渲染 + 状态提升」，modal/dialog 与 loading 副作用外移
- 要点：按 modal 拆独立子组件（Create Project / Create Session / Create Worktree / Rename / Delete Confirm / Repair Path 等），各自持有本地状态；data loading 抽为 hook
- 依据：`frontend-patterns.md:220` Section 拆分原则 + `Settings` 先例
- 预估：影响面最大（组件文件、目录结构、可能涉及 store 切片），收益也最大

### P1 — Rust 超长函数拆分
- `ws/acp.rs` `handle_acp_ws`：各事件分支（forward / notify / permission / turn）抽为独立 handler 函数
- `api/files.rs` `resolve_base_from_query`：按解析来源拆小函数
- 依据：AGENTS.md §7「修改影响面大 → 引入边界」信号

### P2 — 大而结构清晰的文件（暂缓，不排期）
- `acp/client.rs`（1,260 行）：方法粒度已可，仅评估是否将 persistence 相关方法抽出
- `FileManager.tsx` / `useAcpChat.ts` / `chatStore.ts` / `ChatInput.tsx`（800-1,100 行）：结构尚可，无明确信号

### 明确排除
- **`index.css`（2,657 行）**：58 个分区标记清晰、单一主题文件，属于有意的像素风格整体设计（见 `ui-style-guide`）；拆分收益低、回归风险高
- **`src/tmux/` 相关代码**（如 `agent_detect.rs` 560 行）：已冻结，只修致命 bug（见 `2026-07-28-pty-engine-implementation.md`）
- 拆分不引入任何新依赖、不改变视觉/交互行为，纯结构重组

## 3. 设计决策（方向）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| D1 | Sidebar 拆子组件遵循现有 Section 拆分原则，不发明新模式 | 项目已有 `Settings` 成功先例 + `frontend-patterns.md` 成文约定 | 引入新的状态管理方案（zustand 重构） | 子组件间状态耦合过深，抽 hook 无法收敛时重新评估 |
| D2 | Rust 函数拆分只抽同文件内私有函数，不新建模块文件 | 局部改善原则（AGENTS §4），避免无关扩散 | 为拆分新开 `mod` 文件 | 拆分后单文件仍 >800 行且职责明显可分 |
| D3 | P2 文件一律不动，除非后续有真实修改需求 | 奥卡姆剃刀：无收益不增实体 | 提前重构"以防万一" | 接该类文件的功能修改且行数影响实质时顺势拆 |

## 4. 实施分期

> 每个 Phase 实施前，单独出含具体改动的实施计划（本 plan 不落到代码）。

| Phase | 内容 | 产出 | 依赖 |
|-------|------|------|------|
| 0 | 本方向计划定稿 | 本文件 | — |
| 1 | Sidebar 拆分（P0）（已实施 2026-08-03） | 子组件文件 + 主组件瘦身 + 相关 store/hook 调整 | frontend-patterns.md 约定 |
| 2 | `ws/acp.rs` `handle_acp_ws` 拆分（P1） | 独立事件 handler + 单测 | 需先读 `2026-07-28-pty-engine-implementation.md` |
| 3 | `api/files.rs` `resolve_base_from_query` 拆分（P1） | 小函数化 + 现有测试覆盖 | — |

## 5. 验收标准

- [x] `Sidebar.tsx` 拆分后主文件降至 ~800 行以内，每个 modal 为独立子组件且自带状态
- [x] `Sidebar.tsx` 拆分后全部现有交互（创建/重命名/删除/修复/外部会话）行为不变，`Sidebar.test.tsx` 通过
- [ ] `ws/acp.rs` `handle_acp_ws` 拆出的事件分支均有对应函数名，行为经 ACP 链路手动回归验证
- [ ] `resolve_base_from_query` 拆分后三种路径来源（project / session / query）行为一致
- [ ] 质量门禁零新增违规：`clippy` / `tsc strict` / `cargo test` 全绿
- [ ] CHANGELOG 按实质改动记录（纯重构拆分属可记录范围，见 AGENTS 规则 3）

## 6. 风险与文档闭环

**风险**：
- Sidebar 拆分是纯前端重构，回归面集中在交互弹窗；靠 `Sidebar.test.tsx` + 手动回归兜底
- `ws/acp.rs` 属会话引擎链路（冻结期），拆分须极度保守，只做机械抽取、不改行为；若评审认为风险大于收益，P1 可推迟

**文档闭环**（实施时更新）：
- `docs/architecture/frontend.md` — Source Tree 变更
- `docs/workflows/agent-edit-manual.md` — 若 Sidebar 出现「特殊维护约定」（数据/视图分离等）
- `CHANGELOG.md` — 实质性重构条目
- 本文档状态推进：设计稿 → 进行中 → 已实施
