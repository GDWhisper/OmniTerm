# Git 面板能力提升计划（对标 openchamber-v2）

> 状态：**Phase 1 + Phase 2 + Phase 3 + AI commit message 已实施**（Phase 1 2026-10-19、Phase 2 2026-10-20、Phase 3 2026-10-20）；P2 候补按信号触发
> 触发条件：修改 `src/git/repo.rs`、`src/git/mod.rs`、`src/api/git.rs`、`frontend/src/components/GitPanel/`（GitPanel/GitDrawer/DiffView/diffParser）、`frontend/src/stores/gitStore.ts` 任一项前**必读**
> 关联：`docs/dev/plans/archive/2026-07-26-git-panel.md`（v1 设计与排除清单——本计划重开其中多项，实施后需在该归档文档加勘误指针）、`docs/architecture/backend.md`（git 端点章）、`docs/architecture/frontend.md`（GitPanel 结构）
> 来源：2026-10-15 对 `/home/pax/coding/research/openchamber-v2`（VSCode SCM 级 git 实现：服务端 59 文件 + UI ~12000 行 + GitHub 全集成）的逐文件对比研究，证据行号随附各节

## 1. 背景与现状

**对标对象的量级**（仅供理解差距性质，非照搬对象）：
- API 表面 60+ 操作（`openchamber-v2:packages/web/src/api/git.ts` / `packages/ui/src/lib/gitApiHttp.ts`，后者 2368 行是能力总汇）；服务端 `packages/web/server/lib/git/`（59 文件 1.7MB，simple-git + credential broker + network operation registry + identity storage）；UI `packages/ui/src/components/views/git/`（40+ 组件）。
- 架构与我们同构：客户端从不直接跑 git，全部走后端（我们 = Rust 后端 CLI 子进程）。

**OmniTerm 现状**（v1，2026-07-26 落地）：14 个端点（`src/api/git.rs:16`）+ `src/git/repo.rs`（654 行）+ GitPanel/GitDrawer/DiffView（~714 行）。可见时 5s 串行轮询 + ACP 编辑事件刷新提示；diff 为自研 unified 单栏渲染、256KB 截断；错误码 auth/non_fast_forward/no_upstream/dirty_worktree/timeout/generic。

**差距判定结论**：差距集中在七项——hunk 级操作、stash、merge/rebase、历史操作（cherry-pick/revert/reset）、分支对比（range diff）、AI commit message、分支删除/重命名。其余（GitHub 集成、凭据管理、网络操作状态机等）或属新领域、或与「终端-first、单用户」定位冲突，明确不补（§2 排除项）。

| 能力域 | OmniTerm 现状 | openchamber-v2 | 本计划处置 |
|---|---|---|---|
| 基础读写（status/diff/log/stage/unstage/commit/discard/分支/远端） | ✅ 有 | ✅ 更厚（log 支持 range/单文件/all；删除远程分支） | P0 补分支管理；log 过滤 P2 |
| hunk 级 stage/unstage/revert | ❌（v1 明确排除） | ✅ `applyHunk`，含**防 stale 校验**（`server/lib/git/service.js:3987`） | **P1（第二刀，差距最大项）** |
| stash | ❌ | ✅ 全套 + 文件计数（`gitApiHttp.ts:1902-1952`） | **P0** |
| merge/rebase | ❌ | ✅ 启动/abort/continue + 冲突对话框 + 中断态恢复 | **P1（第三刀）** |
| cherry-pick/revert/reset | ❌ | ✅（`gitApiHttp.ts:2207-2255`，reset 含 hard） | **P0（reset 限 soft/mixed，见 D4）** |
| 分支对比（range diff） | ❌ | ✅ 对 base/commit/PR 三种 selector（`getRangeDiff`/`getBranchBase`） | **P1（第三刀）** |
| 分支删除/重命名/删远程分支 | ❌（仅 worktree 删除时删本地分支） | ✅（`gitApiHttp.ts:1403/1984`；`gitService.ts:837`） | **P0** |
| AI commit message | ❌（v1 明确排除） | ✅ 30 文件/120K 字符限额 + 10 条风格采样 + JSON 输出（`vscode/src/git-commit-message.ts:5-7,95,117`） | **独立项，待拍板（D6）** |
| diff 视图 | unified 单栏只读 | split-view、context 展开、隐藏 whitespace | hunk 批顺手做 context 展开；split view P2 |
| commit 增强 | 仅 `-m` | addAll/files/stageFiles 附带 stage、AI highlights | **P0（amend + commit&push）** |
| 写操作健壮性 | 撞 index.lock 直接失败 | 250/750ms 重试 + 文件身份比对 + 清锁（`gitService.ts`） | **P0（限次重试，不删锁，见 D1）** |
| 提交图（graph） | ❌ | ✅ 自研 lane 算法（`views/git/gitGraph.ts:56`） | P2 候补 |
| blame | ❌ | ❌（仅 VS Code 类型声明 `git.d.ts:217`，无 UI/API） | 双方都无，非差距，不补 |
| GitHub/GitLab 集成、SSH 凭据 broker、多身份、子模块/LFS、网络操作状态机、worktree bootstrap | ❌ | ✅ | **不补**（理由见排除项） |

## 2. 范围与优先级

| 批次 | 级别 | 项 | 规模 |
|---|---|---|---|
| Phase 1 | P0 | 1. 分支管理补齐（删除/重命名/删远程分支） | S |
| Phase 1 | P0 | 2. stash 五操作（list/push/apply/pop/drop） | M |
| Phase 1 | P0 | 3. 历史操作菜单（cherry-pick / revert / reset-soft\|mixed） | M |
| Phase 1 | P0 | 4. commit 增强（amend + commit&push） | S |
| Phase 1 | P0 | 5. 写操作 index.lock 限次重试 | S |
| Phase 2 | P1 | 6. hunk 级 stage/unstage/revert（+ context 展开） | L |
| Phase 3 | P1 | 7. 分支对比（range diff） | M |
| Phase 3 | P1 | 8. merge/rebase 基础流 + 统一中断态横幅 | L |
| 独立 | 已完成 | 9. AI commit message（OpenAI 兼容 + Anthropic，无 ACP） | M |
| P2 候补 | 信号触发 | graph、commit 文件列表、log 过滤、split view | — |

### 不纳入范围（含理由）

- **GitHub/GitLab 集成**（PR/Issue/review/checks/device-flow 认证，对方 `source-control.ts` 1867 行）：完全新领域（OAuth + 平台 API + 评审 UI），与「终端-first、不做托管平台绑定」定位冲突；侧栏 GitHub 链接已满足跳转需求。
- **SSH 凭据 broker / transport binding / 多身份 profile**：企业级/多用户复杂度（对方 credential-broker/resolver/helper 三模块 + 审计）；单用户场景走系统 git 凭据即可。若未来有真实多身份诉求，先只做「设置里显示/修改当前 repo 身份」的最小版。
- **网络操作状态机**（plan/execute/progress/cancel/持久化恢复）：单用户短操作 + 现有 60s 超时 + 错误码足够；不做长任务队列。
- **worktree bootstrap/snapshot/preview**：现有 create/remove/delete-branch 覆盖主流程；preview 价值边缘。
- **子模块 / LFS hydration / 嵌套仓库**：边缘场景。
- **blame**：openchamber-v2 也没有（差距不存在）。
- **reset --hard / force push**：不可逆风险大于面板收益，维持 v1 克制。翻盘条件：用户明确要求 + 实现时以「输入分支名二次确认」级别加固。
- **diff split view**：自研渲染器大改（对方用自定义 diff 库 `@pierre/diffs`），仅当 hunk 操作落地后仍有明确诉求再做。

## 3. 设计决策（ADR）

### D1 写操作 index.lock 冲突 = 限次重试，绝不删锁

- **决策**：所有 git 写命令经统一封装；失败且 stderr 匹配 `index.lock`/`Unable to create`/`another git process` 时，250ms/750ms 两次延迟重试（共 3 次尝试），仍失败返回原错误。
- **理由**：面板与用户终端共享同一仓库，写操作撞用户正在跑的 git 是常态；openchamber 验证了重试有效性。
- **否决**：删除锁文件（对方有该行为，带文件身份比对）——锁可能是用户终端**活跃**操作持有的，删锁 = 制造数据损坏窗口；我们的重试等待成本远低于风险。
- **翻盘条件**：实测重试仍高频失败（用户长时 git 操作期间），再调研「mtime + 进程存活」双重校验后的清锁。

### D2 hunk 级操作 = 后端预切分 + canonical patch 防 stale

- **决策**：新增 `GET /git/hunks`（返回 raw + 结构化 hunks，每个 hunk 携带「文件头 + hunk 段」的完整可 apply patch 文本）；`POST /git/hunk` { path, staged, action, patch } 应用。**应用前必须做 canonical 校验**：重新取当前 diff，要求请求 patch 与某个 hunk 切片逐字匹配，否则 422 `stale_hunk`（前端 toast + 自动刷新）。
- **理由**：仅「能 apply」不够——已 stage 或已提交的旧 hunk 反向也能干净应用（openchamber `service.js:4004-4020` 的实证），必须与当前 diff 比对。patch 文本由后端切分（前端 `diffParser.ts` 只做展示解析，重组原始行有出错面）。
- **实现约束**：临时 patch 文件写系统临时目录、`git apply --check` 预验证后再 apply（stage=`--cached`、unstage=`--cached --reverse`、revert=`--reverse`）、临时文件必须清理；raw 截断（>256KB）时不返回 hunks（禁止在截断 patch 上操作）；untracked 文件无 base，不提供 hunk 操作。
- **否决**：前端重组 patch（重建换行/`\ No newline at end of file` 等边界易错）。
- **翻盘条件**：`git apply` 在用户的 git 版本上有兼容问题（实测为准）时改用 `git apply --3way` 或 stdin 传递。

### D3 stash 语义

- **决策**：`push` 默认不含 untracked（git 默认），UI 提供「含未跟踪文件」勾选（`-u`）；message 可选。pop/apply 冲突 → 错误码 `stash_conflict`，前端提示「有冲突，已保留 stash，请在终端处理」（不自动解冲突、不自动 drop——`pop` 在冲突时不丢 stash 是 git 自身行为，UI 需如实传达）。
- **理由**：与 v1「隐式魔法难排查」的哲学一致（ADR-6 不做自动 stash），这里也不做自动回滚类智能。

### D4 历史操作危险度分级：reset 只做 soft/mixed

- **决策**：`reset_to(sha, mode)` 仅接受 soft/mixed；不做 hard（对方做了 hard+force）。cherry-pick/revert 用 `--no-edit`（不打开编辑器）；冲突时如实报错（错误码 `conflict`）并提示终端处理，Phase 3 统一中断态落地后升级为横幅可 abort。
- **理由**：hard 除了丢弃工作区改动还移动分支指针，双重复合风险；soft/mixed 覆盖「撤销最近提交」的主流需求（改错 message/漏文件用 amend 覆盖）。
- **翻盘条件**：用户明确要求 + 二次输入确认级加固。

### D5 中断态（merge/rebase/cherry-pick/revert）= 横幅 + abort/continue，不做三方合并编辑器

- **决策**：`/git/status` 响应新增 `in_progress` 字段（探测 `.git` 目录：`rebase-merge/`、`rebase-apply/`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`；经 `git rev-parse --git-dir` 解析以兼容 worktree 的 `.git` 文件）。前端常驻横幅 + ABORT/CONTINUE（CONTINUE 前校验 `conflicted == 0`，否则禁用并提示）。冲突文件的解决（编辑标记/`git add`）引导到内置编辑器与终端完成。
- **理由**：三方合并编辑器成本与定位不符（终端-first）；但「中断中看不到状态、无法 abort」是完整性缺陷，必须覆盖。
- **注意**：merge 只有 `--abort`；continue 的语义按操作类型分派（rebase `--continue`、cherry-pick/revert `--continue`）。

### D6 AI commit message —— **已拍板（2026-10-19）：双 API provider，不用 ACP**

- **决策**：只支持 **OpenAI 兼容 Chat Completions** 与 **Anthropic 原生 Messages** 两种 provider；用户在设置页固定选择 provider / Base URL / Model，并在提交框显式点击 GENERATE。一次点击 = 一次请求；不自动重试、不自动回退到另一 provider。
- **否决 ACP**：一次性拉起完整 agent 过重，还会在 agent 侧留下会话历史；模型与凭据控制面也分散在 agent 配置里，不符合「成本可控」。
- **模型选择**：经 provider 的 `/v1/models` 拉取列表（OpenAI `{base}/models`、Anthropic `/v1/models`），也允许手输 model id；模型选择只在设置页修改。
- **密钥**：API key 存 `~/.omniterm/ai_commit_key[_<实例后缀>]`（Unix `0600`，Windows 依赖用户目录 ACL；按 db 实例隔离），**不落 settings 表、不通过任何 GET 回显**；GET 只返回 `has_api_key` / `api_key_source` / `api_key_env` / `api_key_env_set`。文件内可存字面量或 `$VAR` / `${VAR}` 环境变量引用，请求时解析；环境变量未设置返回 `ai_key_env_missing`。无需密钥的本地端点可留空。
- **输入**：只发 staged diff；≤30 文件、≤120K 字符（超限显式上报省略文件数/字符数）+ 最近 10 条 commit subject 跟随仓库语言与风格；未暂存内容绝不发送。
- **输出**：要求严格 JSON `{"message":"..."}`；容错依次尝试 JSON → 围栏 JSON → 首个 JSON 对象 → 首行；消息上限 4000 字符。结果只填 commit box，已有文字时弹窗二选一「替换 / 追加」，绝不静默覆盖，也不自动提交。
- **请求约束**：输出 `max_tokens=400`、超时 60s、响应上限 512KB；错误码 `ai_not_configured|ai_auth|ai_key_env_missing|ai_rate_limited|ai_timeout|ai_network|ai_upstream|ai_invalid_response`。
- **翻盘条件**：用户明确要求更多 provider（如 Azure/Gemini 的特殊鉴权）或自动重试/fallback 时再扩展；**不回到 ACP 方案**。

### D7 分支对比数据流

- **决策**：`GET /git/range?base=<ref>[&path=]`；无 path 返回 `{ merge_base, files[], diff, truncated }`（`merge-base base HEAD` + `git diff base...HEAD` + `--name-status`）；有 path 返回单文件 range diff（点文件时用）。base 经 `reject_option_like` + `git rev-parse --verify` 存在性校验。
- **前端形态**：不新建第三个 tab——CHANGES 视图顶栏加「BASE ▾」选择器（无对比 = 默认），选中后文件列表切为该范围（复用 FileSection），点文件 GitDrawer 传 `range=base`。控制 UI 复杂度（奥卡姆）。
- **截断**：沿用 256KB + `truncated`（range diff 大是常态，主视图以文件列表为准）。

### D8 批次顺序与依赖

- Phase 1 独立可拆分实施，各项互不阻塞；其中 P0-5（重试封装）**建议先行**（后续所有写操作接入）。
- Phase 2（hunk）依赖 Phase 1 的重试封装与 mutating 串行（已有）。
- Phase 3 的 merge/rebase 依赖 Phase 2 的 diff 交互基础（可选：冲突文件行内体验）与统一中断态（D5）。
- 每批次独立提交、独立 CHANGELOG 条目。

## 4. 实施分期

### Phase 1：快赢批（5 项，独立提交）✅ 2026-10-19

**1）分支管理补齐**
- 后端 `src/git/repo.rs`：`delete_branch(root, name, force)`（`-d` / `-D` 由前端确认框勾选「强制删除」决定；注意与 `src/git/mod.rs::delete_branch` 的既有实现——worktree 流程用 `-D`，实施时提取共享或明确两处语义差异避免复制）、`rename_branch(root, old, new)`（`git branch -m`；重命名当前分支时用单参形式）、`delete_remote_branch(root, name)`（`git push origin --delete`，走 `run_remote` 60s 超时通道）。
- 端点：`POST /git/branch/delete`、`/git/branch/rename`、`/git/branch/delete-remote`。
- 前端 GitPanel 分支菜单：行内 hover 操作（重命名/删除）；删除弹 ConfirmDialog（默认 `-d`，报「未合并」时提供强制勾选重试）；有 upstream 的分支提供「同时删除远程」。
- 测试：删除未合并分支被拒 → 强删成功；重命名后列表刷新；删远程分支失败（无权限）错误文案。

**2）stash 五操作**
- 后端 `src/git/repo.rs`：`stash_list`（`git stash list --format=%gd%x00%cr%x00%gs` 解析 index/相对时间/描述）、`stash_push(message, include_untracked)`、`stash_apply(index)` / `stash_pop(index)` / `stash_drop(index)`（index 必须是纯数字，拒 `-` 前缀）；`refine_error` 增加 `stash_conflict`（stderr 含 `CONFLICT`）。
- 端点：`GET /git/stash/list`、`POST /git/stash/push|apply|pop|drop`。
- 前端：GitPanel CHANGES 视图顶栏 stash 入口 → 弹出面板（stash 列表 + 每项 Apply/Pop/Drop + 头部「暂存当前变更」含 message 输入与「含未跟踪文件」勾选）；空 stash 空态。
- 测试：push 后 status 干净、list 计数正确；pop 冲突返回 `stash_conflict` 且 stash 未丢（git 行为断言）。

**3）历史操作菜单**
- 后端 `src/git/repo.rs`：`cherry_pick(sha)`、`revert_commit(sha)`（均 `--no-edit`）、`reset_to(sha, mode ∈ {soft, mixed})`；sha 经既有 `reject_option_like` + is_ascii_hexdigit 校验（复用 `show_commit` 模式）。
- 端点：`POST /git/cherry-pick`、`/git/revert-commit`、`/git/reset`。
- 前端 HISTORY：commit 行右键/长按菜单（复用 Sidebar SessionContextMenu 交互模式）：复制 SHA、cherry-pick 到当前分支、revert、reset（soft/mixed 子项）；reset 二次确认文案明示「将移动当前分支指针（HEAD）、保留改动」（soft/mixed 语义）。
- 测试：cherry-pick 成功产生新提交；冲突（构造）返回 `conflict` 错误码；reset mixed 后 status 显示改动。

**4）commit 增强（amend + commit&push）**
- 后端 `repo::commit(root, message, amend)`：amend 且 message 空 → `--amend --no-edit`；amend 且非空 → `--amend -m`；非 amend 空 message 仍拒绝。
- 端点：`/git/commit` body 增加 `amend: bool`（默认 false，向后兼容）。
- 前端：commit box 加 AMEND 勾选（勾选时提示「若已推送，需在终端强推」——我们不提供 force push）；按钮区加「提交并推送」（commit 成功 → 同队列串行调 push；push 失败不掩盖 commit 成功，toast 分开报告）。
- 测试：amend 改写 HEAD（sha 变化、父提交不变）；amend 无 HEAD 时报错透传；组合流程前端串行（mutating 队列）不并发。

**5）index.lock 限次重试（建议先行）**
- 后端 `src/git/repo.rs`：写命令统一封装（如 `run_write`），识别锁冲突错误后 250ms/750ms 重试；覆盖 stage/unstage/commit/discard/checkout/create_branch 及本批新增全部写操作。
- 测试：测试内先创建 `.git/index.lock` 再从另一 task 定时删除，断言重试后成功；持锁不放则返回原错误。

**实施记录（AI commit message，2026-10-19）**

- 后端：`src/ai_commit/`（配置、受限密钥文件、`$VAR` 环境变量引用、模型列表、prompt/解析、双 provider 适配）；`GET|PUT /settings/ai-commit`、`POST /settings/ai-commit/models`、`POST /git/commit-message`。
- 前端：Settings 新增 GIT 分类（`AiCommitSection.tsx`，2026-10-19 从 AI 分类调整）；提交框 GENERATE + `GeneratedMessageDialog.tsx`（替换/追加）。
- 测试：本地 mock provider 覆盖 OpenAI/Anthropic 鉴权头、请求体、模型列表、生成与错误映射；staged diff 文件/字符上限与 UTF-8 边界；前端设置表单与提交框替换/追加交互。
- 手动回归：
  1. 设置 OpenAI 兼容端点 → 拉取 `/v1/models` → 选模型 → 保存；刷新页面后配置仍在、key 仅显示为已配置。
  2. 有 staged 改动 → GENERATE 填入空提交框；已有文字 → 弹窗选择替换/追加，取消不改动。
  3. 勾选删除已存 key → 保存后文件删除；再生成返回 `ai_auth`。
  4. Anthropic 端点验证 `x-api-key`、`anthropic-version` 与 Messages 响应解析。
  5. 未配置 / 无 staged 时 GENERATE 禁用；直接调接口返回 `ai_not_configured` / `nothing_staged`。

**实施记录（Phase 1，2026-10-19）**

- 5 项均已落地，按 D8 建议顺序独立提交：P0-5（重试封装）→ P0-1（分支管理）→ P0-2（stash）→ P0-3（历史操作）→ P0-4（commit 增强）。
- 实施偏差：
  1. 删远程分支的 remote 从 `upstream` 前缀解析（缺省 `origin`），而非硬编码 `origin`；`branches` 响应新增 `upstream?`（additive）。
  2. HISTORY 的 reset 以两个平铺菜单项（soft / mixed）代替子菜单，二次确认文案不变。
  3. stash 列表设 100 条上限并返回 `truncated`（性能红线 P1：禁止无界 collect），UI 显示截断提示——计划原文未覆盖此上限。
  4. `commit` 的 amend 允许空 message（`--amend --no-edit`），非 amend 仍拒绝空 message。
- 手动回归（`docs/reference/archive/user-testing.md` 已于 2026-10-16 归档停止更新，用例改记于此）：
  1. 删除未合并分支 → 首次失败后对话框出现强制勾选，勾选后删除成功；有 upstream 的分支可同时删远程。
  2. stash push（含/不含 untracked、带备注）→ 列表计数正确；pop 制造冲突 → toast 提示冲突且 stash 仍在。
  3. 提交行右键/长按 → cherry-pick/revert/reset；reset soft 后改动在暂存区、mixed 后为未暂存，HEAD 均移动且提交保留在 reflog。
  4. AMEND 留空提交 → 提交信息不变、sha 变化；「提交并推送」中 push 失败时 commit 成功 toast 仍保留。
  5. 终端持锁期间在面板 stage → 自动重试后成功；持续持锁 → 原样报错且不删除 `index.lock`。

### Phase 2：hunk 批（差距最大项）✅ 2026-10-20

**6）hunk 级 stage/unstage/revert（+ context 展开）**
- 后端：`GET /git/hunks`（raw + 结构化 hunks，见 D2）；`POST /git/hunk`（canonical 校验 + 临时 patch + `git apply --check` → apply）；错误码 `stale_hunk`；`/git/diff` 契约不动（untracked/commit 详情继续用它）。
- 前端 GitDrawer：文件 diff 场景改调 `/git/hunks`；DiffView 扩展接收 hunks（保留 raw 路径兼容 commit 详情）；hunk header 行加操作按钮组（+ / − / ↺，ui-style-guide §12 按钮规范）；`stale_hunk` → toast「内容已变化」+ 立即重拉；操作后走既有 refreshTick。
- context 展开（顺手项）：`git diff -U3` ↔ `-U<n>` 切换按钮（后端 diff/hunks 增加 `context_lines` 参数）。
- 测试：Rust 集成——每个 action 的三态（正常应用 / stale 拒绝 / 无 `@@` 头拒绝）；行号正确性（stage 第 2 个 hunk 后第 1 个 hunk 的行号是否漂移——断言重新拉取的 diff 内容）；前端 diffParser/hunk 按钮单测；手动回归进 user-testing.md。

**实施记录（Phase 2，2026-10-20）**

- 后端：`GET /git/hunks`（`{diff, truncated, hunks:[{header,patch}], context_lines, root}`）与 `POST /git/hunk`（`{path, action, patch, context_lines}`）；`src/git/repo.rs` 新增 `split_hunks` / `file_hunks` / `apply_hunk`、`HunkAction`、临时 patch 文件 RAII、路径校验。
- 前端：GitDrawer 的 tracked 文件改走 `/git/hunks`（untracked/commit 保持 raw）；DiffView 在 hunk header 加 `+`/`−`/`↺` 按钮；header 提供 `+ctx`/`−ctx` 切换（U3 ↔ U10，截断/untracked/commit 不显示）；revert 走 ConfirmDialog。`stale_hunk`/`invalid_hunk` 纳入本地化 toast，任何失败都会 bump refreshTick 立即重拉。
- 实施偏差/细化：
  1. **POST 不接收 `staged`**：方向由 action 唯一决定（stage/revert=unstaged diff，unstage=staged diff），避免两处语义分叉。
  2. hunk 仅在「未截断 + 单文件 + 非 binary/new/deleted/rename/copy/mode-only/symlink/submodule + 至少一个 `@@`」时提供；其余形态返回空列表，由文件级按钮覆盖（计划原文只排除 untracked）。
  3. `/git/diff` 同步增加 `context_lines`（additive）；服务端把值 clamp 到 1..=20 并在 `/git/hunks` 响应回显，前端原样回传生成 patch 时的值，避免展开期间误报 stale。
  4. 错误码收敛为 `stale_hunk`（canonical 不匹配，或 `git apply --check`/apply 失败）与 `invalid_hunk`（untracked、patch 空/超限、路径非法等）；不单列 `hunk_conflict`。
  5. diff 命令强制 `--no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --full-index`，apply 加 `--whitespace=nowarn`；非合法 UTF-8 的 diff 只展示、不提供 hunk（禁止 U+FFFD 回写）。
  6. 顺带修复 `gitStore.mutate` 忙时「静默丢弃却提示成功」：返回 `Promise<boolean>`，`runMutation` 仅在真正执行后提示成功。
- 手动回归：
  1. MM 文件 staged/unstaged 两栏分别操作单 hunk，另一侧不受影响。
  2. stage 第 2 个 hunk 后重新打开，第 1 个 hunk 行号与内容不漂移；末尾无换行文件可操作。
  3. 展开 U10 后 stage 不误报 stale；终端同时改文件 → 提示内容已变化并自动刷新。
  4. 快速连点 hunk 按钮，第二次不出现假成功 toast。
  5. revert hunk 必须二次确认；取消不改文件。
  6. 移动端（coarse pointer）按钮常显；rename/新增/删除/二进制/大 diff 截断态无 hunk 按钮。
- 自动化验证（2026-10-20）：`src/git/repo.rs` 45 例单测全绿（含 staging 两个 hunk、行号重算、CRLF/无尾换行、Unicode 路径、锁重试）；前端新增 DiffView/GitDrawer/gitStore/client 共 27 例全绿；真机 E2E 走通 UI 的 hunk stage → unstage → revert（二次确认）与 stale toast + 抽屉自动刷新，API 侧 stage/unstage/revert/stale 均按预期落盘。

### Phase 3：协作批 ✅ 2026-10-20

**7）分支对比（range diff）** —— 实现见 D7。测试：merge-base 正确性、空 diff、base 不存在 422、截断标记。

**8）merge/rebase 基础流 + 统一中断态** —— 实现见 D5。补充：
- 端点：`POST /git/merge`、`/git/rebase`（均带 branch 参数，`reject_option_like`；rebase 前端强度确认——历史重写警示）、`POST /git/operation/continue`、`/git/operation/abort`（按 status.in_progress 分派）。
- 前端：中断态横幅（ABORT/CONTINUE + 冲突文件数）、分支菜单加「合并到当前分支」「变基到…」。
- 测试：三态渲染（无中断/merge 中/rebase 中）；abort 后 `.git` 状态清理、横幅消失；冲突未解决时 CONTINUE 禁用；rebase 完成后的线性历史断言。

**实施记录（Phase 3，2026-10-20）**

- 后端：`/git/status` 新增 `in_progress:{kind,conflicted}|null`，用一次 `rev-parse --git-path` 探测（兼容 linked worktree）；`GET /git/range`（`{merge_base,files,files_truncated,diff,truncated,root}` / 单文件模式）；`POST /git/merge|rebase|operation/continue|operation/abort`；`src/git/repo.rs` 新增 `probe_operation`、`resolve_range_base`、`parse_name_status_z`、`merge_branch`、`rebase_branch`、`operation_continue/abort` 与错误码 `invalid_base|no_merge_base|invalid_branch|invalid_path|no_operation|operation_in_progress`。
- 前端：`OperationBanner.tsx` 常驻横幅（冲突数、CONTINUE 禁用、ABORT 二次确认）；分支行内合并/变基按钮（变基弹确认，警告历史重写且面板不提供 force push）；CHANGES 顶栏 BASE 选择器 → 只读 `RangeFileSection`（隐藏提交框）+ range 抽屉；`GitDrawer` target 新增 `{kind:'range'}`；`FileSections.tsx` 抽取共享文件行。`gitStore.mutate` 改为成功与失败都在 finally 刷新 status。
- 实施偏差/细化：
  1. `rebase-apply/` 与 `git am` 共用目录：按 `applying`/`rebasing` 标记区分，`am` 作为独立 kind 并提供 `git am --continue|--abort`，避免把 am 当成 rebase 执行错误命令。
  2. range 文件列表设 1000 条上限并返回 `files_truncated`（性能红线 P1，计划原文未覆盖）；rename 带 `orig_path`。
  3. range 视图为只读：隐藏 STAGED/CHANGES 与提交框；数据只在选择 BASE / 手动刷新 / ACP 编辑提示时拉取，不参与 5s 轮询（全量 diff 太重）。
  4. BASE 仅列本地分支并排除当前分支（与 `branches` 端点一致）；中断态禁用 BASE 与 checkout/merge/rebase。
  5. continue 命令设置 `GIT_EDITOR=true` / `GIT_SEQUENCE_EDITOR=true`，保证后端无 TTY 时不会拉起编辑器；Windows 等价物待 `2026-10-17-windows-desktop-first` 计划。
  6. `gitStore.mutate` 失败也刷新 status（计划外但必需）：merge/rebase/cherry-pick 冲突会留下新的中断态，横幅必须立即出现而不是等 5s 轮询。
  7. `/git/operation/*` 不接受客户端传入 kind，每请求重新探测；continue 仍有冲突时返回 `conflict`。
  8. BASE 选择器独立成 `.git-rangebar` 一行（与 viewbar 并排时在 240px 窄栏会被挤压），空选项文案缩短为「不对比/none」；range 抽屉标题从错误的 `commit` 修正为 `diff`；ABORT 弹窗标题改为「中止当前操作」（避免与 kind 文案「X 进行中」叠加成病句）。
- 手动回归：
  1. 分支菜单合并 → 冲突横幅出现（冲突计数正确）、CONTINUE 禁用；在编辑器解决并 stage 后在横幅 CONTINUE → 横幅消失、历史出现 merge commit。
  2. 变基确认弹窗 → 冲突 → ABORT → 分支与 HEAD 恢复；干净变基后历史为线性、无 merge commit。
  3. 终端完成冲突解决（git add + commit）后 ≤5s 横幅自动消失。
  4. linked worktree 中制造 merge 冲突，绑定该 worktree 的会话能看到横幅，主工作区不受影响。
  5. BASE 选择分支 → 只读文件列表（含 rename 状态与 orig_path tooltip）→ 点文件打开只读 diff 抽屉 → 清除 BASE 恢复 CHANGES 与提交框；分支在终端被删除后选择 → 提示 `invalid_base` 并回到无对比态。
  6. 中断态下分支 checkout/merge/rebase 与 BASE 选择器均不可用；staging/编辑器仍可用于解决冲突。
  7. 240px 窄栏与移动端横幅可换行、ABORT/CONTINUE 可点。
- 自动化验证（2026-10-20）：`src/git/repo.rs` 58 例单测全绿（新增 merge/rebase/cherry-pick 中断态、abort/continue、worktree 探测、am 区分、range 解析与 base 校验、refine_error 映射）；前端新增 `OperationBanner` / `GitPanel.phase3` / `GitDrawer` range / client / gitStore 共 24 例，全量 1301 例通过。
- 真机验证（2026-10-20，临时仓库 + `./dev.sh` + agent-browser）：API 侧 range/merge 冲突/continue/abort/rebase 冲突（detached HEAD 正确上报）均按预期；UI 侧 BASE 选择 feature 显示 `FEATURE ▸ HEAD` 只读列表（A/M 状态）与 range 抽屉（`feature...HEAD` 标签、无 hunk/ctx 按钮），清除 BASE 恢复提交框；分支菜单变基弹历史重写确认（取消不改动）；合并冲突后横幅显示「MERGE IN PROGRESS / 1 conflicted file(s) remain」，CONTINUE 禁用、ABORT 弹确认、BASE 与分支操作用不可用；终端 `git add` 解决后 CONTINUE 成功、横幅消失并生成 merge commit。

### 独立项：AI commit message（✅ 2026-10-19）

### P2 候补（不承诺，按信号触发）

- git graph：HISTORY 视图 graph 开关（自研 lane 布局，参考 `openchamber-v2:packages/ui/src/components/views/git/gitGraph.ts:56` 贪心算法 + SVG）；触发信号 = 多分支工作流的真实诉求。
- commit 详情文件列表（`git show --name-status` 补进 CommitDetail）；log 单文件/全分支过滤。二者低成本，可随手带。
- diff split view。

## 5. 验收标准（每批次通用质量门禁）

- [ ] 后端：`cargo fmt --all`、`cargo clippy --workspace --all-targets -- -D warnings` 零新增；`./dev.sh test` 全绿 + 新增单测/集成测试（测试库/端口同源约定见 AGENTS.md 测试约定）
- [ ] 前端：`pnpm exec tsc -b`、`pnpm lint`、`pnpm test` 全绿；新增交互有单测（含空态/错误态）
- [ ] 错误路径：每个新端点的失败分支（非 repo/未绑定/参数非法/git 报错）都有明确错误码与 i18n 文案（en/zh 双份）
- [ ] 手动回归：新用例登记 `docs/reference/archive/user-testing.md`；hunk/stash/merge 类操作用真实仓库走查（含 stale、冲突、空态）
- [ ] 危险操作（删除分支/reset/rebase/amend）全部有二次确认且文案说明后果
- [ ] 写操作并发：与终端 git 同时操作时行为符合 D1（重试/如实报错，不静默）

## 6. 风险与文档闭环

| 风险 | 缓解 |
|---|---|
| 用户 git 版本差异（`--porcelain=v2` ≥2.11、`stash push` ≥2.13、`rebase --continue` 语义） | 实施时以目标环境实测为准；老语法不引入（目标环境已满足），文档记录最低版本 |
| hunk patch 与 git apply 兼容边界（CRLF、无尾换行） | 集成测试覆盖 `\ No newline` 与 CRLF fixture；失败如实报错 |
| 中断态探测在 worktree（`.git` 为文件）下出错 | 统一走 `git rev-parse --git-dir` 解析；worktree 场景单测 |
| 面板 UI 复杂化（分支菜单/stash 面板/hunk 按钮/中断横幅叠加） | 遵守 ui-style-guide；每项完成后走一遍视觉走查（窄栏 240px 起） |
| i18n 双份遗漏 | 验收清单强制项 |

**实施后需更新的文档**：`docs/architecture/backend.md`（git 端点清单、错误码、in_progress 字段）、`docs/architecture/frontend.md`（GitPanel 组件结构）、`docs/reference/archive/user-testing.md`（手动回归）、`docs/dev/plans/archive/2026-07-26-git-panel.md`（在排除清单处加勘误指针指向本计划）、`CHANGELOG.md`（每批次一条实质功能条目）、AGENTS.md 文档索引（本文件已登记）。
