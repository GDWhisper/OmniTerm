# 需求清单

> 此文档仅在人工明确要求时更新，记录产品功能需求和待办事项。

**优先级说明：**
- 🔴 **高** — 近期重点实现
- 🟡 **中** — 正常排期
- 🔵 **低** — 锦上添花，不着急
- ⚪ **未明确** — 待讨论

---

## 文件管理器工具栏 🟡

- [ ] **「在当前目录打开终端」替换「回到终端当前目录」** — 文件管理器现有终端按钮行为是「回到终端当前目录」，拟改为「在文件管理器当前目录打开终端」（新功能）。
  - 原「回到终端当前目录」功能下沉为一个独立按钮，改用 home 图标承载。
  - 两个按钮职责需明确区分，避免语义混淆。

## 快捷键设置 🟡

- [ ] **插件化快捷键模式** — 通过 tmux 插件生态（如 tmux-sensible, tmux-pain-control 等）实现快捷键定制，OmniTerm 提供 UI 开关和插件管理，不重复造轮子。底层拦截代码已就绪（appStore.keybindingMode + useTerminal handler），等插件系统就绪后激活。

## 改动记录 ⚪

- [ ] **新增改动记录栏** — 在界面中新增一个「改动记录」面板，记录本次会话中改动过的文件和新增的文件，按时间倒序排列，支持点击文件名直接打开文件预览。
  - 💡 **打开文件的基础设施已就绪**（2026-08-10）：`revealFileInDrawer`（`frontend/src/stores/appStore.ts`）与 `FileLocationLink`（`frontend/src/components/Chat/FileLocationLink.tsx`）已实现「给一个路径 → 在 FM 抽屉打开并保证抽屉可见」，本需求实现时直接复用，不要另写一套。
  - 数据来源可复用 ACP 工具调用的 `locations` / diff `path`（见下方 ACP 会话章节 A1）。

## Sidebar 便条 🔵

- [ ] **收起 Sidebar 后显示快捷便条** — 当 Sidebar 收起时，为每个项目、工作区、会话生成小便条（图标/缩略图），方便用户一键展开对应内容。
  - ⚠️ 待打磨：交互形式、视觉样式、信息密度需要进一步设计

## 通知功能 ⚪

- [ ] **任务状态通知** — 当终端任务发生以下情况时，向用户发送通知：
  - 任务完成
  - 任务意外中断（异常退出）
  - 任务死循环（长时间无输出或 CPU 占用异常）
  - ⚠️ 待定：具体检测方式（轮询 tmux pane 状态 / hook / 资源监控）


## ACP 会话 ⚪

- [ ] **todos list 看板功能** — ACP 会话的 todos list 看板功能未成功实现，待评估：放弃该功能，或换用更高级模型处理。（2026-07-24 记录）

### 会话中提到的文件一键点开

目标：agent 说「文档已定稿在 xxx.md」时，用户能直接点开查阅，不必去文件树里翻。
方案分三层（成本/收益差异明显），**层 C 已评估为不做**。

- [x] **A1 · 工具调用 `locations` 可点击** — ✅ 2026-08-10 完成（commit `224d12c`）
  - 工具卡片展开后的路径从纯文本变为可点击链接，点击在 FM 抽屉打开，并自动展开右栏 + 切到 FILES 标签（移动端切 files 面板）。
  - 数据取自 ACP `ToolCallLocation`（**协议权威值，非正文猜测**），故不做存在性校验；无效路径/目录/越界由 FileDrawer 展示后端错误。
  - 相对路径以 session 的 `workspace_path` 归一（`toAbsolutePath`）——agent 子进程 OS cwd 就是该路径，见 `src/api/files.rs` 中 ACP session 取 `workspace_path` 作 FM cwd 的注释。
  - 性能：链接组件不接回调 props、不订阅 store，点击时才 `getState()`，`ChatMessageView` 的 memo 契约零触碰（模式见 `docs/architecture/frontend-patterns.md` 的 getState-action convention）。

- [ ] **A2 · `locations` 缺失时用 diff path 兜底** — ⏸ 待实测触发
  - `locations` 是 ACP **可选**字段（§8 多实现兼容性），有实现不提供。届时工具卡片展开后没有可点路径。
  - 兜底数据已在手上：`useAcpChat.ts` 的 `synthUnifiedDiff` 已解析出 diff 的 `path`，只是没存进 block，并入 `locations` 即可（十来行）。
  - **故意暂缓**：在确认手头 agent 到底给不给之前，这是没有需求证明的抽象（AGENTS §7 奥卡姆剃刀）。**触发条件：实测发现工具卡片展开后无路径行。**

- [ ] **B · 正文 inline code 里的路径可点击** — 🟡 待决策
  - agent 说「定稿在 \`docs/xxx.md\`」绝大多数用反引号包裹 → 落在 `Markdown.tsx` 的 `code` 渲染器，**不需要碰 remark AST**。
  - 关键设计：**粗筛 → 验证 → 才渲染成链接**。正则只做候选筛（含 `/` 或已知扩展名、无空格、长度上限），再异步确认文件存在，存在才可点。把「启发式猜测」降级为「提示信号」，误判率趋零。
  - 打开动作直接复用 A1 的 `revealFileInDrawer`，无需重写。
  - ⚠️ **需人工拍板的取舍**：存在性校验走哪条路——
    | 方案 | 成本 | 代价 |
    |------|------|------|
    | 复用 `GET /api/v1/files?session=` 列目录 | 0 后端改动 | 一个目录一次请求，须前端缓存 |
    | 新增 batch exists 端点 | +1 API + `backend.md` 维护 | 更干净，请求可合并 |

    倾向前者（目录列表本身有缓存价值，且不增实体）。
  - ⚠️ **必须配 session 级缓存 + 并发上限**：否则历史消息一多就是一堆并发请求，触犯 `docs/dev/performance-and-safety.md` 的无界红线。

- [x] **C · 裸文本路径（无反引号）识别** — ❌ 评估后不做（2026-08-10）
  - 需自定义 remark plugin 改 AST，误判面大（散文里的 `and/or`、版本号、URL 片段），而 A+B 已覆盖约 95% 真实场景。属过度设计。
  - 翻盘条件：实测发现常用 agent 大量输出不带反引号的裸路径，且用户明确反馈够痛。

## Multiplexer 引擎 ⚪

- [ ] **rmux 双引擎支持** — 新增 rmux 作为 tmux 的替代 multiplexer 引擎，逐步过渡为主引擎，tmux 降级为 fallback。
  - 项目地址：https://github.com/Helvesec/rmux
  - 需要抽象出统一的引擎接口（trait），tmux 和 rmux 各自实现
  - 配置项切换引擎选择
  - 后续计划：rmux → 主引擎，tmux → fallback

## Windows 后台服务支持 ⚪

- [ ] **`--daemonize` / `stop` / `status` Windows 实现** — 目前 `start -d`、`stop`、`status` 在 Windows 上直接报错退出（`bail!` / `exit(1)`），需补齐。
  - **`--daemonize`**：调用 `FreeConsole()` 脱离控制台（一行 API，现有 `windows-sys` 已含 `Win32_System_Console`）
  - **`pid_exists`**：用 `OpenProcess` + `WaitForSingleObject(0)` 替代当前 `return false` stub
  - **`stop`**：用 `OpenProcess(PROCESS_TERMINATE)` → `TerminateProcess` 强杀（等价 Unix `SIGKILL`）；优雅退出需额外 IPC（named event），可后续迭代
  - **优雅退出**：daemonize 后无控制台，`ctrl_c()` 永不触发。如需要 ACP 子进程回收等清理逻辑，需用 named event `"omniterm-shutdown-{pid}"` 做关闭通知
  - 预估改动量 ~50 行，全在 `src/main.rs`，无新增依赖

## 自动断连 / 释放超时可调 ✅（2026-08-05 完成）

- [x] **设置面板调节自动断连/释放超时** — 设置 → 会话新增三个分钟滑块（值域 1..60）：ACP 空闲回收（默认 5，`GET/PUT /api/v1/settings/acp-idle-recycle` 持久化到后端 settings 表，reaper 运行时热更新）、tmux 失焦断连（默认 10，localStorage `omniterm_blur_disconnect_min`）、tmux 空闲断连（默认 15，`omniterm_idle_disconnect_min`）。
- [x] **超时值 ≥30 分钟内存占用提醒** — 长超时会让 tmux/ACP 进程长时间驻留内存，设置面板滑块值 ≥30 分钟时显示警告文案。

## 会话工作时长 ✅（2026-08-30 完成）

- [x] **ACP 会话「实际干了多少活」** — 口径 `work_ms = turn 墙钟 − 等真人审批`，后端在 turn 定稿时增量写 `sessions.work_ms/wait_ms/turn_count/last_turn_at`，消息级写 `chat_messages.duration_ms/wait_ms`。呈现只一处：assistant 回复正文末行右对齐「已工作 2分钟42秒」（右缘贴合气泡），「等待人工」挂该行 tooltip；侧栏会话行不显示累计时长（曾实现过 badge，按设计决策回退），`sessions` 上的累计列当前无 UI 消费者，作为写时账目留存。设计与偏差见 `docs/dev/plans/2026-08-30-acp-work-time.md`。
- [x] **已知边界（非缺陷，登记备查）** — ① 迁移前的历史 turn 无结束时刻记录，时长不可追溯（老行 NULL → 不渲染，不回补）；② agent 侧内部确认门（不发 `session/request_permission`，如 omp propose）后端看不见，那段人的思考时间会计入 `work_ms`。
