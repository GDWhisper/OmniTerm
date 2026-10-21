# ACP 会话检查点 / 回滚（重做：turn 边界快照）

> 状态：**设计稿**（2026-10-21）— **原计划 F05 的 git 语义与触发时机均不成立，本文是重做方案，不是原方案的实施计划**
> 触发条件：改 `src/git/repo.rs`、ACP turn 派发路径（`src/ws/acp.rs::dispatch_prompt`）、新增检查点存储或回滚端点、动聊天面板可折叠面板前**必读**
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md` F05（本文取代其 §3.5 与 §4 D10–D11）、`docs/dev/plans/archive/2026-10-15-git-capability-upgrade.md`（stash 五操作与 `in_progress` 探测，本方案复用其零件）、`docs/dev/performance-and-safety.md` §P1/§S1

## 1. 背景：原计划为什么不能直接实施

原计划 F05「agent 工具调用（write/edit/delete）前自动 `git stash create` 快照；ChatView 显示检查点时间线；一键 `git stash apply` 回滚」在 2026-07-27 写下，从未实施。2026-10-21 审查发现**三处硬缺陷**（全部实测复现，非推演）：

### 1.1 git 语义：三处写错

| 原计划断言（§3.5） | 实测结果 |
|---|---|
| 「回滚：`git stash apply <hash>` + `git stash drop <hash>`」 | `git stash drop <sha>` → `error: '<sha>' is not a stash reference`（drop 只接受 `stash@{n}`）；`git stash apply <sha>` 在工作区已被 agent 改过时 → `error: Your local changes to the following files would be overwritten by merge`——**而这正是回滚场景本身** |
| 「不自动清理：stash 条目保留（用户可手动 `git stash list` 管理）」 | `git stash create` **不进 stash 列表**（实测 `git stash list` 仍 0 条）→ 用户根本看不到这个 stash，「可手动管理」是空头支票 |
| 「工具调用前调用 `git stash create`」 | **干净工作区返回空字符串**（实测）→ 最常见的场景（agent 改一个已提交的文件，工作区本来就干净）**根本产不出快照** |

正确原语是 **`git restore --source=<snapshot> -- <paths>`**（实测可把文件还原回快照状态），语义应是「把 agent 改过的路径还原到快照版本」，不是「apply 一个 stash」。

### 1.2 触发时机：协议层拿不到「写入前」的钩子

- ACP 的 `kind` 是**可选**字段（协议参考 §8.2），枚举为 `read/edit/delete/move/search/execute/think/fetch/other`——**没有 `write`**（原计划写的「kind = write / edit / delete」里 `write` 不是 ACP kind）。
- OmniTerm **没有实现** `fs/write_text_file`（`src/` 零命中）→ agent 是**自己直接写文件**，不经 OmniTerm。`tool_call` 通知与实际写入的先后**不由协议保证**，各实现不同（AGENTS §8）。
- 唯一可靠的「写之前」信号是 `session/request_permission`（审批时必然还没写）——但只在 agent 申请审批时存在，yolo/auto mode 下**完全没有**。

→ **追 tool_call 做快照在协议层不可靠**，必须换触发点。

### 1.3 资源：每次快照往用户仓库灌不可达对象

实测：每次 `git stash create` 产生 1 commit + 1 tree + 1 blob 且**全部不可达**（5 次快照 → 16 个 unreachable object）。这些对象在 `git gc --prune`（默认 2 周）前不回收——**往用户自己的仓库里灌垃圾**，与 §P1「无界累积禁止」冲突。

## 2. 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P0 | ① Phase 0：git 管道验证 + 破坏性路径评审 | 先把危险动作的边界钉死，再写代码 | 小 |
| P0 | ② turn 边界快照 | 用户每次发 prompt 前自动留一份工作区快照 | 中 |
| P0 | ③ 存储 + 上限 | DB 落库 + 每会话/全局双上限 + 引用清理 | 中 |
| P0 | ④ 回滚端点 | 路径级还原 + 新建文件清单（**不自动删**） | 中 |
| P1 | ⑤ 时间线 UI | 聊天面板内的可折叠检查点列表 + 回滚确认 | 中 |
| P1 | ⑥ 清理与对账 | 会话删除清引用 + 启动对账清孤儿引用 | 中 |

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| **自动回滚**（无需确认就还原） | 回滚是破坏性动作，会覆盖用户自己在这期间的编辑。必须显式确认 |
| **自动删除 agent 新建的文件** | 无法可靠区分「agent 建的」与「用户在这期间建的」→ 只**列出**让用户勾选，默认不删 |
| **改写 git 历史**（revert commit / reset） | 回滚只还原工作区文件内容；agent 自己提交的 commit 保留在历史里（用户可自己处理） |
| **非 git 目录** | 无法快照。UI 隐藏该功能并说明原因（原计划「非 git 仓库自动禁用」——保留这条） |
| **手动创建检查点** | 用户要「动手前存一份」可以自己 `git commit`；OmniTerm 的独有价值是**自动 turn 边界快照**。手动入口是廉价扩展，留待需要时再加 |
| **跨会话 / 全局检查点** | 范围控制；且跨会话会让「回滚到某会话的某一轮」语义含混 |
| **把 agent 的每次工具调用都快照** | 协议层拿不到可靠时序（§1.2），且对象数量按调用次数膨胀 |

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | 快照触发点 = **turn 边界**：`dispatch_prompt` 把 prompt 发给 agent **之前** | ① 这是协议保证的「agent 即将开始动手」的唯一可靠点；② 语义对用户可讲：「撤销上一轮」；③ 快照频率 = 用户发 prompt 的频率（受人限），不是工具调用次数（受 agent 限） | 追 `tool_call`（时序无保证）/ 追 `request_permission`（yolo mode 下没有）/ 每个工具调用一次（对象量爆炸） | 实测某 agent 的 tool_call 严格早于写入 → 可细化到工具级（但**不得**把「某实现如此」当协议事实，AGENTS §8） |
| **D2** | 快照内容 = **工作区 tree**，通过 `git stash create` 取；**干净工作区**改用 `HEAD^{tree}` | `stash create` 精确表达「工作区当前状态（含未暂存改动）」；干净时它返回空 → 退化为 HEAD 的 tree（= 工作区状态，语义等价） | `git add -A` + `write-tree`（**会改用户 index**，副作用不可接受）／`git stash push`（改工作区，绝对不行） | — |
| **D3** | 快照 commit 用 **ref 锚定**：`refs/omniterm/checkpoints/<session_id>/<seq>` | 不锚定 → commit/tree 变不可达 → `git gc` 后 `git restore --source` 失效（**静默失灵**，最坏的一种坏法）。锚定后对象可达、gc 不回收；丢弃检查点时 `update-ref -d` 删掉，对象随后自然被 gc 回收 | 不锚定（gc 后失效）／`git stash store`（进用户 `git stash list`，污染用户视图）／把快照拷进 OmniTerm 自己的库（工作区可能上万文件，体积无界） | 出现「refs/omniterm/* 出现在用户 `git show-ref` 里被抱怨」→ 改用 `refs/omniterm-checkpoints/*` 之外的空间（无更干净选项）或改为「每次回滚前现场重建快照」（不可行） |
| **D4** | 回滚原语 = **`git restore --source=<快照> -- <变更路径>`**；变更路径由 `git diff --name-only <快照>` 得出（快照 tree ↔ **当前工作区**，含已删除文件） | 实测可行；`git diff <commit>` 比的是 commit vs 工作区，因此**即使 agent 自己 commit 过**，差异仍能检出（回滚只还原工作区内容，commit 保留在历史里） | `git stash apply`（工作区已改时直接拒绝，实测）／`git reset --hard`（会连带丢弃用户在同期的其他改动，且本仓 git 能力已明确排除 `--hard`）／`git checkout <commit> -- .`（不精确，会把快照后新增的文件也覆盖掉） | — |
| **D5** | agent **新建的未跟踪文件**不自动删除：回滚响应里**列出**它们（快照时未跟踪集合 vs 现在的差集），由用户在确认弹窗里勾选删除 | 无法可靠区分「agent 建的」与「用户在这期间建的」；误删用户文件是不可逆损失 | 自动删（可能删掉用户的文件）／完全不提（用户以为回滚干净了，实际残留） | 找到可靠的「本次 turn 内新建文件」判据（如 agent 上报的 created-files）→ 才谈自动删 |
| **D6** | 快照时记录**已存在的未跟踪文件集合**（`git ls-files --others --exclude-standard`），用于 D5 的差集；**上限 `MAX_UNTRACKED_SNAPSHOT`**，超限则截断并置 `truncated` 标志（届时 D5 的删除清单**不可用**，只提示） | D5 的差集需要「之前有什么」的基线。仓库里可能有上万未跟踪文件（node_modules 等被 .gitignore 的不在此列，但自建产物在）→ 必须有界（§P1） | 不记录（无法算差集）／全量记录（无界） | 实测典型仓库未跟踪文件数远低于上限 → 下调 |
| **D7** | **每会话上限 `MAX_CHECKPOINTS_PER_SESSION` + 全局上限 `MAX_CHECKPOINTS_TOTAL`**，超出按最旧淘汰（并同步删 ref） | 每会话上限挡住「长会话几百轮」；全局上限挡住「会话数无界」——**只有前者不够**（§P1 要求上限匹配真实增长维度，这里有两个轴） | 只有每会话上限（会话数无界 ⇒ 全局无界）／只有全局上限（单会话可挤占全部额度） | 实测使用规模稳定远低于上限 → 下调 |
| **D8** | 检查点**落库**（新表 `chat_checkpoints`），不存内存 | 内存态在以下场景直接失效：① 后端重启；② 同一会话在多标签页打开（各自内存不同步）；③ 用户「释放会话」后想回滚——release 只断 agent 进程，**文件还在** | 存内存（原计划 §3.5「session 级检查点列表存内存」——与用户真实需求冲突） | — |
| **D9** | 会话**释放（release）不清**检查点；**删除会话时清**（DB 级联 + 删 ref）；另有**启动对账**清理孤儿 ref（会话已不存在但 ref 还在——进程崩在清理中间） | release ≠ 数据消失；「释放后想回滚」是真实场景。删除会话是用户明确的「不要了」 | release 即清（原计划「session 释放时检查点列表丢弃」——用户会丢回滚能力）／永不清理（ref 在用户仓库里无界累积） | — |
| **D10** | 快照**失败绝不影响 turn**：任何 git 错误 → 记日志 + 跳过本次快照，prompt 照常发出 | 快照是辅助能力，失败就等于「这次没有检查点」，不能让 agent 跑不起来 | 失败则阻断 prompt（用户会莫名其妙发不出消息） | — |
| **D11** | **回滚必须显式确认**：确认弹窗列出「将被还原的文件清单」+「可选删除的新建文件清单」，默认全不删 | 回滚覆盖用户改动，不可逆。D5 已有同类约束 | 直接回滚（可能毁掉用户自己的修改） | — |
| **D12** | 检查点时间线 UI = **聊天面板内的可折叠列表**（照 `TodoBoard` 既有形态），不做抽屉/弹窗 | 聊天面板已有 `TodoBoard` 这类内嵌可折叠面板的先例；抽屉/弹窗会与 Modal 基座的 focus trap 欠账纠缠（X03 已记该基座待改造） | 独立抽屉（与聊天上下文割裂）／独立页面（用户看不到「这个会话有哪些检查点」） | — |
| **D13** | **不实现**「按文件/按工具的细粒度回滚」 | turn 边界快照的粒度就是 turn；细粒度需要 §1.2 不可靠的时序 | 细粒度（时序不可靠 ⇒ 快照与写入错位 ⇒ 回滚出错，比不能回滚更糟） | 拿到可靠的写入前信号（见 D1 翻盘条件） |
| **D14** | 快照**只在 ACP 会话**创建 | 终端（pty/tmux）会话没有「turn」概念 | 终端会话也快照（无 turn 边界，语义不明） | — |

## 4. 实施分期

### Phase 0 — 先验证管道与破坏性边界（不写产品代码）

| 动作 | 产出 |
|---|---|
| 在 scratch 仓库跑通完整管道：`stash create` → `update-ref` → `git diff --name-only <ref>` → `git restore --source=<ref> -- <paths>` → `update-ref -d` | 一份可复制的命令序列 + 每步的失败态 |
| 验证异常态：① 干净工作区；② 有 merge/rebase 中断（`git stash create` 是否报错）；③ 无 commit 的空仓库（无 HEAD）；④ agent 自己 commit 过之后 `git diff <ref>` 是否仍能检出 | 异常态处置表（D10 的降级分支） |
| **破坏性路径评审**：逐条确认「哪些命令会改用户工作区 / index / 仓库元数据」 | 一份「允许执行」命令白名单；`git add` / `git reset` / `git stash push` / `git checkout` 一律禁止 |

### Phase 1 — 后端：快照

| 改动 | 文件 |
|---|---|
| `git` 侧新增：`snapshot_worktree(root) -> Option<Snapshot{commit, tree, untracked}>`、`diff_paths(root, snapshot) -> Vec<String>`、`restore_paths(root, snapshot, paths)`、`delete_ref(root, name)` | `src/git/repo.rs`（复用既有 `git_command` / `run` / `resolve_repo_root` / `probe_operation`；**禁止** `run_write` 之外的写操作扩散） |
| 存储：迁移 `migrations/20261021_add_chat_checkpoints.sql`（表 `chat_checkpoints`：id / session_id / seq / created_at / ref_name / commit_sha / tree_sha / untracked_json / truncated / trigger）+ 索引 | `migrations/` |
| 存储层 CRUD + 上限淘汰（D7）+ ref 同步删除 | 新模块 `src/acp/checkpoint.rs`（或 `src/git/checkpoint.rs`） |
| 触发：`dispatch_prompt` 发 prompt **前**调用快照；失败按 D10 降级 | `src/ws/acp.rs` |
| 单测：① 干净工作区快照 = HEAD tree；② dirty 工作区快照后 `restore` 能还原；③ 上限淘汰时 ref 同步删除；④ 快照失败不阻断 prompt（mock git 失败）；⑤ 非 git 目录跳过 | `src/acp/checkpoint.rs` 测试模块 + `src/ws/acp.rs` |

### Phase 2 — 后端：回滚 + 端点

| 改动 | 文件 |
|---|---|
| 回滚实现：算变更路径 → `git restore --source` → 算新建未跟踪文件差集 → 返回清单（**不删**） | `src/acp/checkpoint.rs` |
| 端点：`GET /sessions/{id}/checkpoints`（时间线）、`POST /sessions/{id}/checkpoints/{seq}/rollback`（body 带 `delete_new_files: [paths]`）、`DELETE /sessions/{id}/checkpoints/{seq}` | `src/api/sessions.rs`（挂 `sessions::routes()` → 前缀 `/api/v1` → 自动继承 `require_auth_mw`，§S4/S5） |
| 清理：会话删除时删 ref（D9）；启动对账清孤儿 ref | `src/api/sessions.rs`（删除路径）+ 启动流程 |
| 单测：回滚还原内容正确；新建文件**默认不被删**、显式传入才删；路径校验（越界/绝对路径/`..` 一律拒绝，§S1）；未跟踪清单为空时不返回该字段 | 同上 |

### Phase 3 — 前端：时间线 + 回滚

| 改动 | 文件 |
|---|---|
| 新组件 `CheckpointPanel`：可折叠列表（时间 + 序号 + 触发说明）+ 每项「回滚」按钮 | `frontend/src/components/Chat/CheckpointPanel.tsx`（新，形态照 `TodoBoard.tsx`） |
| 回滚确认弹窗：还原清单 + 新建文件清单（复选框，默认不勾）+ 确认 | `frontend/src/components/Chat/CheckpointRollbackDialog.tsx`（新） |
| 接入 `ChatView`（会话切换时刷新列表）+ i18n 两份 | `frontend/src/components/Chat/ChatView.tsx`、`frontend/src/locales/{zh,en}/translation.json` |
| 单测：列表渲染 / 确认弹窗默认不勾删除 / 取消不调端点 | 新组件测试文件 |

## 5. 验收标准

- [ ] 用户发一条 prompt → 自动产生 1 个检查点（DB 有行、仓库有 `refs/omniterm/checkpoints/...`）
- [ ] agent 改坏一个已跟踪文件 → 点「回滚」→ **文件内容回到发 prompt 之前**
- [ ] agent 新建的文件 → 回滚后**仍在**（不自动删），确认弹窗里列出且默认不勾
- [ ] 用户在同期自己改的文件 → 也在还原清单里，**回滚前有确认弹窗**明示
- [ ] 干净工作区也能产生快照（= HEAD tree）
- [ ] 非 git 目录：UI 不出现检查点入口（或明确说明「当前目录不是 git 仓库」）
- [ ] 快照失败（git 报错）→ **prompt 照常发出**，日志可查（D10）
- [ ] 长会话（> 上限）→ 最旧检查点被淘汰且其 ref 被删除（D7）
- [ ] 删除会话 → 该会话的 refs 从用户仓库里消失（D9）
- [ ] 后端重启后（崩溃在清理中间）→ 启动对账清掉孤儿 refs（D9）
- [ ] agent 自己 commit 过 → 回滚仍能检出并还原工作区内容，**git 历史不被改写**（D4）
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` 零新增；`cargo test --workspace` 全绿
- [ ] `cd frontend && pnpm lint` / `pnpm exec tsc -b` / `pnpm test` 零新增警告

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **回滚覆盖用户自己的同期改动** | 不可逆的数据损失 | D11 强制确认 + 弹窗列出完整还原清单；不做「一键无确认」 |
| **误删 agent 新建文件** | 同上 | D5 默认不删，只列出 |
| **refs 残留在用户仓库** | 用户困惑 / 仓库「变脏」 | D3 命名空间 `refs/omniterm/*`（不进 `git branch` / `git stash list` / `git status`）；D7 上限 + D9 清理 + 启动对账；文档说明用途与清理方式 |
| **快照对象在用户仓库累积** | 仓库体积增长 | D3 锚定 → 丢弃时对象变不可达 → 由 gc 回收；D7 双上限控制存活数量 |
| **`git stash create` 在中断态/空仓库失败** | 无快照 | Phase 0 异常态处置表 + D10 降级（跳过 + 日志） |
| **时序错位导致回滚内容不对** | 还原了错误的版本 | D1 用协议保证的 turn 边界（不追 tool_call）；快照与回滚都以「快照时的 tree」为唯一真源，不做增量推断 |
| 用户以为「回滚」= 撤销 git commit | 误解 | 确认弹窗写明「只还原工作区文件，不改 git 历史」；D4 已在 ADR 里锁死该语义 |
| **破坏性动作波及用户仓库其他内容** | 事故 | Phase 0 的「命令白名单」评审；禁止 `add`/`reset`/`stash push`/`checkout`；`restore` 限定 `-- <明确路径列表>`，不用通配 |

## 7. 文档闭环

实施完成后需更新：

- `docs/architecture/backend.md` — 检查点表 / 端点 / `src/git/repo.rs` 新增能力 / ref 命名空间约定 / 与 git 能力升级计划的关系
- `docs/architecture/frontend.md` — `components/Chat/` 补 `CheckpointPanel.tsx` / `CheckpointRollbackDialog.tsx`
- `docs/architecture/frontend-patterns.md` — 若确立「聊天面板内可折叠面板」的统一形态，登记为模式条目
- `docs/dev/plans/2026-07-27-acp-session-enhancements.md` — F05 标注「原方案作废，重做见本文」，并**保留原 §3.5 的错误断言作为勘误记录**（不删改历史断言，只加勘误块）
- `docs/dev/plans/backlog/improvement-directions-remaining.md` — 若 F05 曾登记为 backlog 项，标注去向
- `CHANGELOG.md` — **需加条目**
