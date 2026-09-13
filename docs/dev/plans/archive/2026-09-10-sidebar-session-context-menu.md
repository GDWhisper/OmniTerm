# Sidebar 会话上下文菜单与批量操作

> 状态：已实施（2026-09-10）
> 触发条件：修改 Sidebar 会话行的右键/长按菜单、`SessionRow` / `SessionContextMenu` / `BatchActionBar` / `BatchSessionDialog`、批量选择模式相关逻辑前必读。
> 关联：`docs/architecture/frontend-patterns.md`（会话行上下文菜单 pattern、Sidebar modal 子组件契约）、`docs/visual-design/ui-style-guide.md`（§6.1 浮层工具类、§6.3 菜单与操作栏、§13.1 线性图标）、`docs/workflows/agent-edit-manual.md`。

## 背景

侧栏会话行当前把全部操作（释放 / 归档 / 重命名 / 删除）渲染为 hover 才出现的行内按钮；移动端靠 `pointer: coarse` 恒显，行内密度高、误触面大，且无法对多个会话做同一操作。本次为会话行引入「右键（桌面）/ 长按（移动端）」上下文菜单，并提供批量选择模式。

## 需求与范围

- P0 上下文菜单：桌面 `onContextMenu`、移动端 `useLongPress`（500ms）触发同一菜单，含「批量操作」「重命名」。
- P0 重命名入口迁移：行内铅笔按钮移除，菜单成为唯一入口（功能复用现有 `RenameDialog`）。
- P0 批量选择模式：混选终端（tmux/pty）与 ACP 会话，批量执行归档 / 释放进程 / 删除；三个动作均二次确认。
- P0 终端不适用提示：归档 / 释放对终端会话无意义，混合选择时确认弹窗另起一行提示跳过数量。

### 不纳入（含理由）

- `ArchivedSessionsSection`（归档区块）：语义是只读查看历史 / 取消归档 / 删除，入口已收敛为行内按钮，且刻意保持与主列表的差异（奥卡姆剃刀，避免两套菜单分发）。
- `ExternalSessionsSection`（外部会话）：行以 tmux name 为键、无 DB session id，批量动作 API 不适用。
- 全选 / 跨项目范围选择：需求未提出，且「全选」的作用域（当前 worktree / 项目 / 全部）语义模糊，待真实需求出现再议。

## 设计决策（ADR）

| # | 决策 | 理由 | 否决项 / 翻盘条件 |
|---|---|---|---|
| D1 | 批量操作 = 多选模式（行内 checkbox + 底部操作栏），而非菜单内批量动作子菜单 | 用户确认；与 FileManager `downloadMode` 先例一致，选择范围可见可控 | 若多数会话数量 <3 且用户反馈多选步骤冗余，可退回子菜单式「批量归档本列表」 |
| D2 | 重命名入口从行内移除，菜单为唯一入口 | 用户确认（2A）；两端均有菜单（桌面右键 / 移动长按），功能不丢失 | 若长按手势在移动端不可发现性成为问题，可恢复行内按钮 |
| D3 | 终端会话在归档/释放确认弹窗中「另起一行」提示跳过；操作按钮在无可执行项时禁用 | 用户确认混合选择弹窗提醒；全终端选择时禁用避免 400 请求与无意义弹窗 | 若用户要求「无论如何都能点，弹窗解释」，改为恒可用 + 弹窗说明 |
| D4 | 批量执行串行 `for`、单条失败继续、结束汇总 toast | 对齐 `DuplicateProjectsDialog` 先例；避免 SQLite 写竞争与批量杀进程竞态；失败继续符合批量预期 | 若单批数量级增大到卡顿，改并发 + 限流 |
| D5 | 选择态与菜单态放 Sidebar 本地 state（`selectionMode` / `selectedSessionIds` / `contextMenu` / `batchTarget`），不进 store | 纯 Sidebar 局部 UI 态，无跨组件消费者；避免 appStore 膨胀 | 若移动端需要在其他 pane 显示选择态，再提升到 store |
| D6 | 释放池 = 全部选中 ACP 会话（含已释放），后端 `release_session` 幂等返回 200；归档池同 | 后端 `src/api/sessions.rs:504-512` 对无驻留进程的 ACP 会话直接 OK | 若后端改为对已释放会话报错，前端需过滤 `acp_process_alive` |
| D7 | 移动端长按后抑制一次补发 `click`（`longPressFiredRef`） | 浏览器在 touchend 后会向 touchstart 目标补发 click，会误激活会话（Chat 行无 onClick 所以先例未覆盖） | 不适用 |

## 实施分期

| Phase | 产出 | 改动文件 | 依赖 |
|---|---|---|---|
| 1 | 基础件：菜单图标、i18n key、选择态/长按抑制 CSS | `FileManager/icons.tsx`、`locales/{en,zh}/translation.json`、`index.css` | — |
| 2 | 组件：`SessionRow`（提取 + 手势）、`SessionContextMenu`、`BatchActionBar`、`BatchSessionDialog` | 四个新文件 | Phase 1 |
| 3 | 接线：`ProjectCard` 改用 `SessionRow` 并移除铅笔按钮、`Sidebar` 新增 state 与条件渲染 | `ProjectCard.tsx`、`Sidebar.tsx` | Phase 2 |
| 4 | 测试与文档闭环 | 测试 3 文件、`frontend.md`、`frontend-patterns.md`、`ui-style-guide.md`、`user-testing.md`、`CHANGELOG.md` | Phase 3 |

## 验收标准 / 验证清单

- [ ] 桌面右键会话行弹菜单；浏览器默认菜单被阻止
- [ ] 移动端长按 500ms 弹菜单，滚动中长按不触发，长按抬起不激活会话
- [ ] 菜单「重命名」打开现有 `RenameDialog` 并成功改名；行内已无铅笔按钮
- [ ] 菜单「批量操作」进入选择模式并预选该会话；底部状态栏替换为操作栏
- [ ] 混选终端 + ACP 后点归档/释放，弹窗含跳过提示行；全终端选择时按钮禁用
- [ ] 批量删除活跃会话后主视图清空且列表刷新；释放活跃会话后 ChatView 显示恢复入口
- [ ] 执行中弹窗不可被 Esc / 遮罩 / ✕ 关闭
- [ ] `pnpm test --run` / `tsc -b` / `lint` / `build` 零新增报错；`cargo clippy -D warnings` 通过
- [ ] `./scripts/check-doc-index.sh` 通过（新计划文档已登记）

## 风险与文档闭环

| 风险 | 缓解 |
|---|---|
| 长按补发 click 误激活（高） | `longPressFiredRef` 抑制一次 click，单测覆盖 |
| 批量副作用漏清（activeSession / markEnded / workspaceSessionMemory）（高） | `BatchSessionDialog` 内复刻三条单条清理路径，测试断言 |
| 底部状态栏测试断言冲突（中） | 条件替换同一 `.absolute.bottom-0` 节点，默认分支 DOM 不变 |
| `.selected` 与 `.active` 特异性相同（中） | 新规则置于 `.active` 之后 |
| 多失败 toast 刷屏（低） | 结束以 `batchDone` 汇总，单项错误 toast 归 api client |

需更新文档：本文件、`AGENTS.md` 索引、`frontend.md`、`frontend-patterns.md`、`ui-style-guide.md`、`user-testing.md`、`CHANGELOG.md`。

## 勘误

- **实施补记（2026-09-10）**：`BatchActionBar` 的归档/释放禁用按钮额外需要 title 文案说明原因，新增两个 key `sidebar.batchArchiveNoTarget` / `sidebar.batchReleaseNoTarget`（计划 §i18n 只列了禁用行为，未列文案）。
- **实施补记（2026-09-10）**：新增 `SessionRow.test.tsx`（计划未列）——长按补发 click 抑制、选择模式 toggle、右键坐标属组件级行为，放在组件单测比经过 ProjectCard 更直接；`SessionContextMenu.test.tsx` 按计划新增。
- **副作用（待跟进）**：`Sidebar.tsx` 因本次新增选择态/菜单态已超 800 行约定（`docs/architecture/frontend.md` 已如实标注「待拆分」），拆分不在本次范围内。
