# 改进方向盘点遗留项跟踪（功能 × 体验）

> 来源：`docs/dev/plans/archive/2026-09-01-improvement-directions.md` 2026-09-26 复审
> 安全项 S1/S2'/S3/S5/S6 已拆为实施计划 `docs/dev/plans/2026-09-26-security-hardening-batch.md`，不在本文件重复。
> 本文件跟踪**未落地的功能/体验方向**；每项均经 2026-09-26 逐项源码复审确认「未落地」。

## 跟踪表

| ID | 方向 | 现状（2026-09-26 复审） | 前置依赖 / 触发 |
|----|------|--------------------------|------------------|
| X01 | **F3 任务状态通知** | 未落地。product 代码零 Notification API 使用（`rg -i Notification frontend/src` 仅命中注释/CSS 类名/i18n key；Sidebar.tsx 五处 "commented out pending notification scheme decision"）。**事件源已全部就绪**：ACP turn 终态 `frontend/src/hooks/useAcpChat.ts:847` `prompt_done`（四级链 queued>cancel>abnormal>done）/`:932` `prompt_error`，两处均已在调 `attention.fire`；站内通知总线 `frontend/src/components/Attention/AttentionProvider.tsx`（`fire(targetId,sessionKey,reason)`，reason∈decision/done/error + playPing + `document.hidden` 标题闪 🔔）。**缺口**：浏览器 Notification 通道、webhook 后端发送、pty 侧静默判定（`src/engine/pty/vt.rs` feed 热路径无 last_output_at；近似物=hook 60s alive 窗口） | 站内部分几乎零成本（attention 已三态，勿再造通知中心）；webhook URL 走 settings 表（**无共享读写助手**，见 X11）；勿在 feed 热路径加锁写时间戳 |
| X02 | **F4 聊天历史全文搜索 + 导出** | 未落地。`chat_messages` 表无 FTS 索引；聊天面板无搜索；无 Markdown 导出。分页查询已存在于 `chat_persistence.rs:90`（`list_messages_page`，行数+字节双预算）。**可行性前置（2026-09-26 已实证）**：FTS5 可用、零新依赖——本地 `libsqlite3-sys` 编译产物含 567 个 `fts5*` 符号，dev 库 `PRAGMA compile_options` 亦含 `ENABLE_FTS5`。**仍需拍板**：中文分词（默认 unicode61 tokenizer 不切中文，方案=接受整段匹配 / 换 trigram，SQLite ≥3.34 支持）——本次实施最需要先定的技术取舍 | §P1 红线约束索引增长（external content 必须 content-linked + 触发器同步，禁手工维护增量）；只索引 `text`，MB 级 `blocks` 列不进索引 |
| X03 | **F5 命令面板（Ctrl+K）** | 未落地。**Ctrl+K/Cmd+K 全仓无占用**（`window.addEventListener('key...'` 零命中；已占用仅 FileManager Escape/Delete/r/Ctrl+A、GitPanel Ctrl+Enter、useChatShortcuts Shift+Tab）。数据源充足：`appStore.ts`（projects/sessions/worktrees + 全部 UI toggle）、`chatStore`/`gitStore`/`agentStore`，**无 projectStore/sessionStore**（都在 appStore）。弹层基座：`frontend/src/components/Modal/Modal.tsx`（Portal 必需——移动端 300% strip transform 会破坏 fixed；Esc/backdrop 已内置），但**无 focus trap、无 aria-modal/role=dialog** | ADR 约束（`archive/2026-07-30-ui-polish.md`）：D3 木条标题 + `--modal-backdrop` 平涂遮罩（否决 backdrop-blur）、D4 按钮统一 PixelButton；动作清单照 `frontend-patterns.md:103-131` action-registry 范式（`messageActions.ts` 先例）；**勿建缓存副本 store**（getState 派生）；全仓第四种快捷键范式（输入框内也响应）需写进 frontend.md 约定；i18n 两份同步 |
| X04 | **D1 内建 HTTPS（ACME）** | 未落地。裸 HTTP 零 TLS：`src/main.rs:1001-1008` `TcpListener::bind` → `:1093` `axum::serve`；CLI/env 面只有 `-H/--host`、`-p/--port`，**无 tls/acme 参数**；`Cargo.toml` 唯一 TLS 字样是 `reqwest`（仅出站）。**ACME 现实阻碍**：HTTP-01 需 80 端口（默认 127.0.0.1:9077）、DNS-01 需 API 凭据、TCP-01 已废弃 → 只能是可选特性默认关 + 后台续期任务 + 证书落盘（须遵守 BRANCH_BINARY_NAME 隔离纪律） | **触发 AGENTS 工程准则 1②：须引入新外部依赖 → 停止编码并请示**。候选 `instant-acme`+`tokio-rustls`+`axum-server` 或 `rustls-acme`（影响 Cargo.lock 与编译产物，一次性大决策）。建议拆两期：先 `--tls-cert/--tls-key` 用户证书（仍要 rustls）→ 再 ACME 自动化；与 X05 合并为同一「部署形态」任务 |
| X05 | **D2 部署形态标准化** | 未系统化：`docs/` **无部署章节**（仅 `docs/dev/reverse-proxy-fixes-report.md` 是 proxy 模块缺陷清单，非部署指南）；`docker-compose.yml` 单服务（`ports: ${DOCKER_PORT_MAPPING:-9077:9077}`、`OMNITERM_AUTH_ENABLED=1`、`/home:/home:ro`），**无 caddy/nginx/traefik service、无证书 volume、无 healthcheck** | 与 X04 打包为「部署形态」批次；须新建部署文档并登记 AGENTS.md 文档索引（边界与禁区要求），同步改 user-testing.md:887 |
| X06 | **D3 备份/恢复** | 未落地。无 `VACUUM INTO` 导出/导入；settings + SQLite + agent 配置的一键备份不存在 | 数据丢失真实风险出现、或多设备迁移需求出现时优先 |
| X07 | **D4 亮色主题终端适配** | 未落地。调色板单点定义：`frontend/src/hooks/useTerminal.ts:155-178` `DARK_TERMINAL_THEME`（模块级常量，`:844` 传给 `new Terminal`）；后端 `src/engine/pty/vt.rs` **无色板概念**（只做 SGR 编码，纯前端改动）。主题机制 `frontend/src/stores/themeStore.ts`（`theme/resolved`，仅 App.tsx + Settings:147 两处消费），**终端完全不消费**。**隐藏坑**：`frontend/src/index.css:1864-1866` `.terminal-panel-pixel .xterm-viewport, .xterm { background: #12141A !important }`——只改 xterm theme 不改这行 = 「边框亮内部暗」半亮态 | user-testing.md:880 与 ui-style-guide §7.2 均明文记录「终端保持深色护眼」是**刻意设计**，落地=推翻该决策，须同步回写两处文档；亮色 ANSI 16 色须按 ui-style-guide 色板重挑（禁自造 hex）；xterm 支持热改 theme 但须注意 useTerminal 现有 fit/字体 effect 依赖数组；cell_frame 走 canvas，主题热改重渲染要验证；**动终端视觉必跑 `scripts/pty-frame-regression.mjs`** |
| X08 | **D5 文件管理器内联编辑** | **编辑器已完整存在，原计划低估了现状**：`frontend/src/components/FileManager/FileEditor.tsx` 是 CodeMirror 6 封装（props `editable/onChange/onSave` Mod-s，主题 HighlightStyle 用 CSS var，已支持明暗）；`FileDrawer.tsx:529-535` 已接线且 `editable={mode==='edit'}`，`:186 runSave` 已调 `api.writeFile2`（含越界确认 `handleSave:195`、useFileWatcher 500ms 去抖外部变更、mode='edit' 时只置 externalChange 不覆盖）；drawer 态在 `appStore.ts:49-54`（`drawerPath`/`drawerMode`，view/edit 默认 view）。**真实缺口**：FileManager 表格行无编辑入口按钮（现有 `IconPencil:1231` 是重命名）+ 「选中行 → setDrawer + setDrawerMode('edit')」链路未接，约 20–40 行纯前端 | 交互需拍板：抽屉（复用 FileDrawer，成本最低，不新造 dirty/保存状态机，**推荐**）vs 表格行内 inline（须自建状态）；越界写必须复用 `FileManager.tsx:241 gateWrite`（ConfirmDialog 闸），勿直接 fetch；后端 `src/api/files.rs:805 write_file` 与上传共用 ≈200MiB body limit（`MAX_UPLOAD_BODY_DEFAULT`），inline 场景宜前端对 >1MiB 禁用并提示；**session 模式绝对路径绕过 sanitize（files.rs:833-836）是既有行为，本次勿顺手修**（属安全线 S1-S6） |
| X09 | **F1 汇总记账（每项目/每日成本汇总）** | F1 的**呈现层已落地**（`frontend/src/components/Chat/UsageIndicator.tsx` + `chatStore.setUsage`），但**持久化累积与跨会话汇总面板未做**——原文「每会话/每项目/每日」目标只兑现了会话内实时展示 | usage 落库须先定 §P1 上限（累积结构）；跨会话汇总涉及 ACP usage 字段多实现差异（AGENTS §8），先沉淀差异 |
| X10 | **F2 project 级权限策略分层** | F2 的**超时策略形态已落地**（`src/acp/permission.rs` `pick_auto_option` + abort/auto/wait，见 `docs/dev/plans/archive/2026-09-21-permission-timeout-modes.md`），但「按项目配置只读放行/写操作人工/高危强制」的策略分层未做 | 审批疲劳的真实反馈；依赖 `session/request_permission` 各实现的 options 语义差异调研（AGENTS §8） |
| X11 | **settings 读写共享助手重构（前置 Refactor）** | `src/api/settings.rs` **无共享 helper**：每 key 一对 handler（读 `:54 get_acp_idle_recycle`、`:98 get_permission_timeout`；写 `:74 set_acp_idle_recycle`、`:127 set_permission_timeout`），多 key 样例 `:138-151`；另 `src/main.rs:845/865/882/890` 一份启动期读取。同型样板 ≥4 处 | 触发工程准则 §7 信号①；X01（webhook key）与 X09（usage 记账 key）都会撞上，**建议作为两者的前置 commit 先做**，否则违反反 copy-paste 红线 |
| X12 | **工程准则 §8 差异沉淀补课** | F1/F2 已落地实现据复审确认有兜底，但 ACP usage/权限相关字段的**多实现差异未沉淀**到 `docs/architecture/backend.md`（准则 8 的显式要求） | 下次动 ACP 层代码前顺手补；或 X09/X10 启动时作为第一步 |

## 已关闭 / 不重复跟踪

| 方向 | 结论 |
|------|------|
| S2/S4/F1/F2 主体 | ✅ 已落地（详见盘点文档复审表与各实现链接），不在本文件跟踪 |
| S1/S3/S5/S6 | 拆入 `docs/dev/plans/2026-09-26-security-hardening-batch.md` |
| D6 rmux 双引擎 | 维持 `docs/reference/requirements.md:82-86` 跟踪，不重复登记 |
| D7 Windows daemonize | 维持 `docs/reference/requirements.md:90-94` 跟踪，不重复登记 |
| D8 移动端可用性 | 已有 `docs/dev/plans/backlog/pty-mobile-termux-feel.md` 专项，不重复展开 |
| OAuth/多用户、WAF | 明确不纳入（单人产品定位 / 反代层职责） |

## 排期建议（弱序，按信号触发）

1. **X08（D5 内联编辑）**：**成本被严重高估的一项**——编辑器/保存/越界闸/外部变更检测全部已存在，只需补行内入口 + drawerMode 链路（20–40 行纯前端），性价比最高。
2. **X01（通知）**：命中产品定位（少盯屏管舰队），事件源已就绪，站内部分近乎零成本；依赖 X11（webhook 落 settings）。
3. **X03（命令面板）**：纯前端、无键位冲突；前置决策 = Modal 的 focus trap/a11y 是否要改造基座（属核心基础组件改动，须请示）。
4. **X11 → X02（搜索/导出）**：X11 是前置 Refactor；X02 需先拍板中文分词（unicode61 不切中文 vs trigram），且是三段改动（migration + Rust 检索 + 前端搜索框）中前端工作量最大的一项——聊天面板无 header 插槽，搜索框须新建（参照 FileManager 延迟展开式）。
5. **X04+X05（部署）、X06（备份）**：运维向，等真实部署诉求；X04 须先请示新依赖。
6. **X07（亮色终端）**：半天可完最小改动，但动终端视觉必跑 pty-frame-regression，且是推翻既有刻意设计（文档闭环 2 处）。
7. **X09/X10/X12**：依赖前置调研（§8 差异沉淀），不与上面抢排期。

**跨项注意**：① X01/X09 都要动 `src/api/settings.rs` → 先做 X11；② X03 的快捷键「输入框内也响应」与 FileManager 现有排除 INPUT/TEXTAREA 的意图相反，是全仓第四种范式，须写进 frontend.md 约定；③ 六项原方向落地都牵动 `docs/reference/user-testing.md` §10 已知限制（:880 D4 / :883 D5 / :887 D1）+ CHANGELOG。
