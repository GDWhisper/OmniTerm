# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]` for in-progress work.
- Changes grouped by category: `Added`, `Changed`, `Fixed`, `Removed`, `Refactored`.
- One line per change — concise, describes **what** and **why**, not how.
- Each entry ends with a timestamp in `(YYYY-MM-DD HH:MM)` format.
- Breaking API changes prefixed with **BREAKING**.
- File paths are relative to project root (e.g. `src/api/files.rs`, `frontend/src/components/...`).

### When to add an entry

- New API endpoint, new component, new feature → `Added`
- Behavior change, UI adjustment, dependency bump → `Changed`
- Bug fix → `Fixed`
- Deleted code, removed endpoint, dropped dependency → `Removed`
- Code reorganization without behavior change → `Refactored`

**只写实质性的改动**：对用户或下游开发者可见的行为变化。反复提交→修复→再出问题的循环 bug，在彻底解决前不写条目。

### When NOT to add an entry

- Typo fixes in comments, whitespace cleanup, lint fixes
- Changes to `AGENTS.md`, `PROGRESS.md`, or other internal docs
- Dev-only tooling tweaks (`.gitignore`, editor config)
- 提交后又回退的改动
- 同一 bug 的多次未遂修复（只写最终修复那次）

### Scope tags

Prefix each entry with the area it affects:

| Tag | Scope |
|-----|-------|
| `[backend]` | Rust backend (`src/`) |
| `[frontend]` | React frontend (`frontend/src/`) |
| `[api]` | REST/WebSocket API contract |
| `[infra]` | Docker, CI, build, dev scripts |
| `[docs]` | User-facing documentation |

---

## [0.1.3] - 2026-07-04

### Fixed

- (2026-07-04) `[backend]` 启动时打印访问地址（`eprintln!`），tracing filter 修正为 `omniterm=info`（`src/main.rs`）

> 0.1.2 已 yank（crash on startup due to wrong tracing filter target）

---

## [0.1.2] - 2026-07-04

### Changed

- (2026-07-04) `[infra]` npm install.js 下载进度条 + 超时处理，版本号从 package.json 自动读取（`npm-package/install.js`）
- (2026-07-04) `[infra]` 发布流程重构为黑名单制 `sync-release.sh`，Release Notes 改为手写面向用户（`scripts/sync-release.sh`、`RELEASE_NOTES.md`）
- (2026-07-04) `[infra]` CI Release Notes 从 `RELEASE_NOTES.md` 读取，npm-publish 改为幂等（`.github/workflows/release.yml`）
- (2026-07-04) `[docs]` 发布指南更新（`docs/release-guide.md`）

### Fixed

- (2026-07-04) `[infra]` npm shim.js fallback URL 修正 pax→GDWhisper, release→main（`npm-package/shim.js`）
- (2026-07-04) `[infra]` pnpm workspace 根目录误判导致依赖安装失败（`frontend/pnpm-workspace.yaml`）

---

## [0.1.1] - 2026-07-04

### Added

- (2026-07-04) `[frontend]` Settings 音效开关旁新增 ▶ 试听按钮 — 点击播放 coin 音效供用户判断是否开启（`frontend/src/components/Settings/Settings.tsx`）

- (2026-07-02) `[infra]` v0.1.0 发布准备 — GitHub Actions CI/CD 发布流水线（tag `v*` 触发，4 平台后端构建矩阵、GitHub Release 自动上传、npm publish、ghcr.io Docker 推送）（`.github/workflows/release.yml`）
- (2026-07-02) `[infra]` v0.1.0 发布准备 — npm 包分发（shim.js + postinstall 自动下载 native binary）（`npm-package/`）
- (2026-07-02) `[infra]` v0.1.0 发布准备 — Shell 一键安装脚本，自动检测 OS/架构、下载 binary、安装 tmux（`install.sh`）
- (2026-07-02) `[docs]` 添加 v0.1.0 性能基线文档，记录 release 构建产物大小与 idle RSS（`docs/performance-baseline-v0.1.0.md`）
- (2026-07-02) `[frontend]` 新增 `FileEditor` 动态语言加载回归测试，覆盖 `.js`、`.ts`、`.py`、`.json`、`.html`、`.css`、`.md`、`.yaml`、`.sql`、`.go`、`.java`、`.cpp`、`.php` 共 13 种扩展名（`frontend/src/components/FileManager/FileEditor.dynamic.test.tsx`）
- (2026-07-02) `[frontend]` 移动端组合键 + 新布局 — MobileKeyBar 重新设计为两行：上行 `[Esc][Shift][Tab][PgUp][PgDn]` + ↑/滚动，下行 `[Ctrl][Alt][Del][Home][End]` + ←↓→；Shift/Ctrl/Alt 为粘滞修饰键（点按激活→点目标键发送组合→自动释放），去掉原不合 tmux 语义的复制/粘贴按钮；新增 PgUp/PgDn/Del/Home/End 五个终端标准键及其全部修饰组合键序列（`frontend/src/components/Terminal/MobileKeyBar.tsx`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-01) `[frontend]` FileManager 操作列新增「复制绝对路径」按钮 — 点击后 `navigator.clipboard` 写入完整绝对路径（含 cwd），按钮 title 悬停预览路径；列宽 80→104px 容纳三个图标，操作列改为 flex 居中（`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/components/FileManager/icons.tsx`、`frontend/src/index.css`、`frontend/src/locales/*/translation.json`）

### Changed

- (2026-07-04) `[docs]` 修正 `ui-style-guide.md` 文档 — CRT Scanlines / Pixel Animations / Sound 默认值从 `true` 更正为 `false`（代码早就默认为关），Pixel UI / Pixel Font / Transitions 行一并清理（`docs/ui-style-guide.md`）

- (2026-07-02) `[backend]` v0.1.0 发布准备 — clap `--port` 默认值 9075→9077，版本号 0.0.1→0.1.0（`src/main.rs`、`Cargo.toml`）
- (2026-07-02) `[infra]` v0.1.0 发布准备 — `bump-version.sh` 适配 version.ts 已改为读 env var（改为更新 `.env.local` 的 `BRANCH_VERSION`）（`scripts/bump-version.sh`）
- (2026-07-02) `[docs]` README CLI 参考环境变量名修正 `OMNITERM_PORT`→`BACKEND_PORT`（`README.md`）
- (2026-07-02) `[frontend]` 优化发布包体积与启动内存 — `FileEditor` 改为 `React.lazy` 懒加载，CodeMirror 语言包按文件扩展名动态 `import()`，主 chunk 从约 1.68 MB 降至 754 kB；未打开文件编辑器时不加载 editor 相关代码（`frontend/src/components/FileManager/FileEditor.tsx`、`frontend/src/components/FileManager/FileDrawer.tsx`）
- (2026-07-03) `[frontend]` Sidebar 底部 WebSocket 状态指示器改像素风 — 5 格信号条 sprite + `LINK/LOST` 像素字标签，1px 硬边 + 2px 硬阴影，CSS 变量填充以适配明暗主题（`frontend/src/components/PixelUI/PixelSprites.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/*/translation.json`）
- (2026-07-03) `[frontend]` Settings + TmuxCheatsheet 弹出面板 UI 打磨 — 提取 `useAnchorPopup` hook 统一定位（底部贴按钮 + maxHeight 贴合 logo 顶），Tmux 速查面板加 `.panel-title-bar` 统一标题风格，popup 滚动条 8px 硬角主题感知（`frontend/src/hooks/useAnchorPopup.ts`、`frontend/src/components/Settings/SettingsPopup.tsx`、`frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx`、`frontend/src/index.css`）
- (2026-07-03) `[frontend]` Settings 面板改游戏风格标签菜单 — 左侧 92px tab 列（APPEARANCE / AUDIO / EDIT / LANGUAGE / MOBILE），右侧滚动内容区；11 个 section 拆为 sub-component，复用 `ToggleRow` 消除复制代码；mobile-only 分类自动隐藏（`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Settings/SettingsPopup.tsx`、`frontend/src/index.css`、`frontend/src/locales/*/translation.json`）
- (2026-07-03) `[frontend]` Settings 面板固定高度为视口 1/3 — 切 tab 时 popup 高度不变，右侧 `.settings-content` 负责滚动以处理超出内容；maxHeight 保留为 logo 到按钮的硬上限以防极短视口溢出（`frontend/src/components/Settings/SettingsPopup.tsx`、`frontend/src/index.css`）
- (2026-07-03) `[frontend]` Settings 面板宽度从固定 340px 改为视口 1/4 — `width: 25vw` + hook 的 `width` 参数同步随 `resize` 更新，以保证水平 clamp 不会让 popup 溢出右侧（`frontend/src/components/Settings/SettingsPopup.tsx`）
- (2026-07-03) `[frontend]` Settings 面板 i18n 补齐 — 顶部标题、ToggleRow 的 ON/OFF 状态走 i18n，en/zh 各加 `settings.on` / `settings.off` 2 个 key（`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Settings/SettingsPopup.tsx`、`frontend/src/locales/*/translation.json`）
- (2026-07-03) `[frontend]` Tmux 速查面板结构与 Settings 对齐 — popup 改为 `display: flex; flexDirection: column; overflow: hidden`，顶部 `.panel-title-bar` 不再被 4px padding 隔开，滚动交给新加的 `.tmux-cheatsheet-content` 容器（`frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx`、`frontend/src/index.css`）
- (2026-07-03) `[docs]` 「状态栏游戏风格面板模板」写进 `docs/frontend-patterns.md` — 以 Settings 为 reference implementation，记录布局/尺寸/Tab/section 拆分/i18n/复制清单/验证清单，供后续状态栏新增按钮参考；`agent-edit-manual.md` 的 Settings 入口同步指向新模板（`docs/frontend-patterns.md`、`docs/agent-edit-manual.md`）
- (2026-07-03) `[docs]` 面板规范拆分：视觉规格搬到 `docs/ui-style-guide.md` §12 — `frontend-patterns.md` 只保留代码架构，尺寸/颜色/态等 token 集中在 `ui-style-guide`；两份文档顶部互链避免重复；`AGENTS.md` 索引触发条件补上「规范撰写」与「状态栏面板/弹窗前必读」（`docs/ui-style-guide.md`、`docs/frontend-patterns.md`、`AGENTS.md`）
- (2026-07-03) `[frontend]` 禁止纯白底色规则落地 — `--bg-surface` 从 `#FDF8EA` (RGB 253/248/234，接近纯白) 改为 `#F0E1B0` (明显黄调羊皮纸)，解决设置面板左侧栏发白问题；`ui-style-guide` §1.2 新增「底色规则：禁止纯白」条款（检测口诀 + 接受/不接受示例 + `git grep` 检测命令），§14 检查清单同步补上（`frontend/src/index.css`、`docs/ui-style-guide.md`）
- (2026-07-03) `[frontend]` 底部连接状态改为黑底黑框 badge，避免 button 误解 — 参照 Terminal 顶部 `.title-bar-badge`（`● LIVE`）的「木底阴影 + 亮色文字」pattern，移除 `border` + `boxShadow` + `var(--bg-surface)` 亮底，背景改 `var(--wood-shadow)`；`SignalBarsSprite` 同时改为固定亮色（`#7EE787` / `#FF7B72`）不随主题变化（需在深棕底上可读）；`ui-style-guide` 新增 §4.1「Status Badge — 木底黑框（不可按状态指示器）」完整规范 + §14 检查项加上一条（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/PixelUI/PixelSprites.tsx`、`docs/ui-style-guide.md`）
- (2026-07-03) `[frontend]` SignalBarsSprite 改粗：5 根 2px 细条 → 3 根 4px 粗条 — 深棕底上 2px 细条视觉太轻几乎看不到，换成 3 根 4px 宽 / 2px 间距的粗条（`x={0, 6, 12}`，依然 16x8 viewBox，无 sub-pixel），原有「全亮 / 全暗」二值语义保持（`frontend/src/components/PixelUI/PixelSprites.tsx`）
- (2026-07-03) `[frontend]` 黑底 status badge 加 inset 3D 立体感 — Terminal 顶部 `.title-bar-badge`（`● LIVE`）与 Sidebar 底部连接状态同时加上 1px inset box-shadow（顶/左 `--wood-inset-dark: #1F1812` 凹边阴影，底/右 `--wood-inset-light: #5A4530` 凹边高光），从「纸片」变「木板上鐵入的铁环」质感；token 化不引入新色相；`ui-style-guide` §4.1 补充「Inset 3D 立体感（必须）」子节并明记适用与例外（`frontend/src/index.css`、`frontend/src/components/Sidebar/Sidebar.tsx`、`docs/ui-style-guide.md`）
- (2026-07-03) `[frontend]` Terminal 无 session 状态 title bar 改为常驻顶部 — 修 `Terminal.tsx` no-session 分支的 layout bug（`flex items-center justify-center` 默认 row 会把 title bar 推到面板**左侧中央**，与有 session 状态顶部对齐不一致），改为 `flex flex-col` + title bar 置顶 + 内容在剩余空间 `flex-1` 居中，与有 session 状态完全一致（`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-03) `[frontend]` **终端 pane 始终深色（修复 实现 vs 规范 不一致）** — `useTerminal.ts` 一直有 `LIGHT_TERMINAL_THEME` 在 app 亮色主题下用 `#ece8e1` 亮羊皮纸背景，但 `ui-style-guide` §1.2 明记「**Terminal always stays dark**: even in light theme, xterm viewport uses `#12141A` background」。删除 `LIGHT_TERMINAL_THEME` 常量与依赖主题的 `useEffect` 动态切换逻辑，`createTerminal` 直接用 `DARK_TERMINAL_THEME`；清理不再使用的 `useThemeStore` import 与 `const resolved`（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-03) `[frontend]` **Sidebar 顶部 logo-title-bar 固定木色（不随主题变色）** — 重新调整上一条「暗色模式色值一致化」的设计方向：用户明确要求 logo-title-bar 作为品牌识别区，在亮/暗主题下都保持木色（`--wood-dark` 底 + `--wood-shadow` 底边），不随主题切到深石墨色。回退：删 `.dark .logo-title-bar` 覆盖；删 `--logo-frame` token；`OmniTermLogo` 外框回退为硬编码 `#3A2E1F`（永远与木色底边匹配，CRT 「嵌入」错觉在两个主题下都能成立）。**保留**上一条的次要修复：`logo-version` 与 `title-bar-path` 统一使用 `var(--gold-light, #FFCB6B)`（与「title bar 是否变色」无关，是另一个一致性问题）。`ui-style-guide.md` §3.1 新增「Fixed-color branding elements」小节记录这个设计规则（`frontend/src/index.css`、`frontend/src/components/PixelUI/OmniTermLogo.tsx`、`docs/ui-style-guide.md`）
- (2026-07-04) `[frontend]` 终端字体栈与 UI 对齐 — `useTerminal.ts` xterm 的 `fontFamily` 从孤立的 `'ui-monospace, Consolas, monospace'` 改为 `READER_FONT`，与 FileManager / Sidebar / Settings / Modal 等所有 UI 面板保持同一回退链，视觉一致；装了 JetBrains Mono 的系统现在终端也会用上它（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-04) `[frontend]` 像素字体 self-host — Press Start 2P + VT323 从 Google Fonts 远程 `<link>` 改为本地 `@font-face` + woff2，`font-display: block`，消除离线/弱网时整个 pixel UI 视觉体系崩塌问题；8 个子集约 84KB，dist 增量可忽略（`frontend/src/assets/fonts/*.woff2`、`frontend/src/index.css`、`frontend/index.html`）
- (2026-07-04) `[frontend]` 像素 UI / 像素字体风格固化 — 移除 Settings 的 Pixel UI 和 Pixel Font 开关，`body.pixel-ui-on` / `body.pixel-font-on` 始终生效；CSS 选择器 gate 清除、appStore 状态删除、i18n key 清理；Sidebar 分支名/会话名硬编码 `font-family: 'VT323'` 清除，继承 reader 字体栈与项目名一致（`frontend/src/App.tsx`、`frontend/src/index.css`、`frontend/src/stores/appStore.ts`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/locales/*/translation.json`）

### Removed

- (2026-07-04) `[frontend]` 删除「过场动效」(Transitions) 开关 — `body.transitions-on` CSS 规则和 `@keyframes workspace-fade` 已在早期清理中删除，开关只剩空壳（只往 body 加 class 但无 CSS 消费）；移除 Settings 的 `TransitionsSection`、appStore 的 `transitionsEnabled` 状态及 localStorage 读写、App.tsx 的 body class 切换、2×2 i18n key，docs/ui-style-guide.md §8/§9/§11 同步清理（`frontend/src/components/Settings/Settings.tsx`、`frontend/src/stores/appStore.ts`、`frontend/src/App.tsx`、`frontend/src/locales/*/translation.json`、`docs/ui-style-guide.md`）

- (2026-07-02) `[frontend]` 移除未使用的前端依赖 — `@cubone/react-file-manager`、`xterm`（与 `@xterm/xterm` 重复）、`@codemirror/autocomplete`、`@codemirror/lint`，并删除占位类型文件（`frontend/package.json`、`frontend/src/cubone-file-manager.d.ts`）

### Fixed

- (2026-07-01) `[frontend]` 修复：删除会话时大量弹出 "session not found or tmux unavailable" 错误通知 — `handleDeleteSession` 异步删除 session 后才清 `activeSessionId`，期间 FileManager 多个 effect 请求已删除 session 导致后端 404。现改为先清 session 再删（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-01) `[frontend]` 修复：接管外部会话后在目标项目中不可见 — `sessionsForWorktree()` 严格按 `workspace_path === wtPath` 过滤，接管 session 的 CWD 不匹配任何 worktree 路径，被静默隐藏。现改为将「孤儿」session 纳入主 worktree 下显示（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-01) `[frontend]` 修复：点击外部会话后终端空白 — `Terminal.tsx` 中 `initTerminal` useEffect 仅依赖稳定的回调引用，空状态→活跃会话过渡时容器 div 出现但 effect 不触发，终端从未创建（`frontend/src/components/Terminal/Terminal.tsx`）

### Added

- (2026-07-01) `[frontend]` 工作区终端聚焦记忆 — 切换工作区时自动恢复上次使用的会话，无需手动重选；映射持久化到 localStorage，会话删除时自动清理（`frontend/src/stores/appStore.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-01) `[backend]` `GET /sessions/external` + `POST /sessions/adopt` — 外部 tmux 会话发现与接管 API（`src/api/sessions.rs`、`src/models/session.rs`）
- (2026-07-01) `[frontend]` Sidebar 底部外部会话折叠区 — 自动发现未被数据库记录的 tmux 会话，一键接管到指定项目（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/*/translation.json`）
- (2026-06-29 12:30) `[frontend]` Sidebar 底部新增 tmux 常用命令速查书本图标按钮，点击弹出固定定位速查面板（`frontend/src/components/TmuxCheatsheet/*`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Icons/BookIcon.tsx`）
- (2026-06-29 20:20) `[frontend]` tmux 速查命令表拆分为 `data.ts` — 组件只负责渲染，命令结构 (sections/items/cmd) 与文案 (i18n key) 分离，TS 类型校验；新增/修改命令只需改 data.ts + 两个 translation.json（`frontend/src/components/TmuxCheatsheet/data.ts`、`frontend/src/components/TmuxCheatsheet/TmuxCheatsheet.tsx`）
- (2026-06-29 20:25) `[docs]` 新增 `docs/frontend-patterns.md` — 收录前端设计模式与约定，首个 entry 为「数据/渲染分离 (data.ts convention)」，并在 `AGENTS.md` 文档索引添加读取/维护触发条件（`docs/frontend-patterns.md`、`AGENTS.md`）
- (2026-06-29 20:40) `[docs]` 新增 `docs/agent-edit-manual.md` — 收录「有特殊维护约定的组件」的文件级索引，首个 entry 为 TmuxCheatsheet（数据/视图分离），agent 接具体修改任务时可索引到「涉及哪些文件 / 改哪个会触达什么」（`docs/agent-edit-manual.md`、`AGENTS.md`）

- (2026-06-27 16:20) `[backend]` Project 覆盖检测函数 `find_covering_project` — 基于 `git worktree list` 双向检测（精确路径 / worktree 归属 / toplevel 归属），含 9 个单元测试（`src/workspaces.rs`）
- (2026-06-27 16:20) `[api]` `POST /api/v1/projects` 覆盖检查 — 命中已有 Project 时返回 409 + `covering_project` 详情，阻止创建重复项目（`src/api/projects.rs`）
- (2026-06-27 16:20) `[api]` `GET /api/v1/projects/duplicates` — 返回老数据中重复项目组（按精确路径或 git toplevel 分组），供侧边栏 banner 提示用户合并（`src/api/projects.rs`）
- (2026-06-27 16:20) `[api]` `POST /api/v1/projects/{id}/merge-into/{target_id}` — 迁移 sessions 并删除源 project，`tmux_session_name` 冲突时返回 409（`src/api/projects.rs`）
- (2026-06-27 16:20) `[frontend]` ApiError 类型 — `request` 抛出带 `status` + `body` 的结构化错误，方便区分 409 冲突（`frontend/src/api/client.ts`）
- (2026-06-27 16:20) `[frontend]` 新建项目 409 弹窗 — 识别 already_covered 后展示「项目已存在」对话框，提供「切换到现有项目」按钮（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-06-27 16:20) `[frontend]` 重复项目警告 banner + 合并 dialog — 启动时调用 `/projects/duplicates`，黄色 banner 提示用户逐组选择保留项后串行合并，DuplicateProjectsDialog 显示路径与会话数（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Sidebar/DuplicateProjectsDialog.tsx`）
- (2026-06-25 14:30) `[frontend]` 鼠标拖选自动复制 — Shift+拖拽绕过 tmux 鼠标模式，松手自动写入剪贴板，支持 navigator.clipboard 降级方案（`frontend/src/hooks/useTerminal.ts`）
- (2026-06-25 11:00) `[backend]` Git worktree 发现模块 — `git worktree list --porcelain` 解析，实时查询 project 下所有分支/工作树（`src/git/mod.rs`）
- (2026-06-25 11:00) `[backend]` Project 模型替代 Workspace — 语义明确为 git 仓库，持久化到 DB（`src/models/project.rs`）
- (2026-06-25 11:00) `[backend]` `GET /api/v1/projects/{pid}/worktrees` 端点 — 实时返回项目的所有 git worktree，确定性 ID（SHA1 前 12 位）（`src/api/projects.rs`）
- (2026-06-25 11:00) `[backend]` Workspace 运行时模块 — 非 git 仓库退化为单 workspace，git 仓库自动发现 worktree（`src/workspaces.rs`）
- (2026-06-25 11:00) `[backend]` 数据库迁移脚本 — `workspaces` → `projects` 改名，`sessions` 新增 `project_id` + `workspace_path` 列（`migrations/20260625_workspace_to_project.sql`）
- (2026-06-25 11:00) `[frontend]` GitBranchIcon 组件 — SVG 分支图标，模仿 git logo 节点分叉形状（`frontend/src/components/Icons/GitBranchIcon.tsx`）
- (2026-06-26 08:00) `[backend]` Agent 状态数据模型 — `AgentKind`/`AgentState`/`AttentionReason` 枚举、`AgentSnapshot` 结构体、`@omniterm_agent` session option 解析器（`src/tmux/agent_state.rs`）
- (2026-06-26 08:00) `[backend]` Agent hook 配置生成 — Claude Code `--settings` JSON + Codex `-c` 命令行参数自动注入，detect_agent_kind + augment_agent_command（`src/tmux/agent_hooks.rs`）
- (2026-06-26 08:00) `[backend]` Session 列表集成 agent 状态 — `list_sessions` 格式串改用 `|` 分隔，新增 `#{@omniterm_agent}` 字段，API 响应自动填充 agent 字段（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-06-26 08:00) `[backend]` Session 创建时自动检测 agent CLI 并注入 hook — `CreateSession.command` 可选字段，`new_session` 返回是否注入（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-06-26 08:00) `[backend]` WebSocket 实时 agent 状态推送 — 终端 WS 连接内嵌 1s 轮询 task，nonce 变化时 JSON push，2s timeout + 3 次连续失败自动停止，oneshot 显式关闭（`src/ws/terminal.rs`）
- (2026-06-26 08:00) `[backend]` hook-status API 重构 — 优先读 session option，fallback 到 capture-pane 启发式扫描（`src/api/hooks.rs`）
- (2026-06-26 08:00) `[frontend]` Attention 通知系统 — AttentionProvider Context、useAttention hook、Web Audio ping 声音、标签页闪烁、智能 diff 去抖（decision 2 周期确认）（`frontend/src/components/Attention/`、`frontend/src/hooks/useAttention.ts`）
- (2026-06-26 08:00) `[frontend]` Sidebar session 行 badge — ⏳/⚠️/✓ 图标 + 脉冲动画，点击清除，轮询间隔 3s（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Changed

- (2026-06-25 14:30) `[frontend]` 亮色主题改为暖灰底色 — 背景 `#f0ece6`、文字 `#1c1917`，对比度 AAA 级，消除纯白刺眼（`frontend/src/index.css`）
- (2026-06-25 14:30) `[frontend]` 亮色终端主题同步改为暖灰 — 底色 `#ece8e1`、前景 `#1c1917`、ANSI 16 色暖调适配（`frontend/src/hooks/useTerminal.ts`）
- (2026-06-25 14:30) `[frontend]` Settings 面板 UI 比例优化 — 节标题 11px uppercase、按钮缩小、字号显示 18px、间距收紧（`frontend/src/components/Settings/Settings.tsx`）
- (2026-06-25 14:30) `[frontend]` 终端空状态 emoji ⌨️ 替换为 SVG KeyboardIcon — stroke-based、currentColor，符合 UI 规范（`frontend/src/components/Icons/KeyboardIcon.tsx`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-06-25 14:30) `[frontend]` Slogan 更新为「万千智能体汇于一端」/ "All agents in one term"，移除 Phase 7 标签（`frontend/src/locales/*/translation.json`）
- (2026-06-25 11:00) `[frontend]` Sidebar 从两级（Workspace → Session）重构为三级树（Project → Workspace/Worktree → Session）— 展开 project 自动显示 git 分支，选中分支后显示关联 session（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-06-25 11:00) `[backend]` Session 绑定从 workspace 改为 worktree 路径 — `pane_cwd` 自动等于 `workspace_path`，文件管理器跟随切换（`src/api/sessions.rs`）
- (2026-06-25 11:00) `[api]` 端点从 `/workspaces/*` 迁移到 `/projects/*` — `POST /projects/{pid}/sessions` 新增 `workspace_path` 参数（`src/api/projects.rs`）
- (2026-06-25 11:00) `[frontend]` appStore 状态重构 — `workspaces` → `projects` + `worktrees`（Record 按 project 分组），新增 `activeProjectId`（`frontend/src/stores/appStore.ts`）
- (2026-06-25 11:00) `[frontend]` 移除 Sidebar 中的 emoji — 项目名去除 📁 前缀，worktree 使用 GitBranchIcon 替代 🌿（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Removed

- (2026-06-25 11:00) `[backend]` Workspace 模型和 API — 被 Project 替代（`src/models/workspace.rs`、`src/api/workspaces.rs`）

### Fixed

- (2026-06-30 16:00) `[frontend]` 移动端键盘弹出时窗口不跟随上移 — 根因：`useKeyboardHeight()` 返回对象但 `MobileLayout` 未解构（`const kbHeight = useKeyboardHeight()` → `const { vvHeight } = useKeyboardHeight()`），导致 `paddingBottom: "[object Object]px"` 无效 CSS 被静默忽略；修复方案：改用 `window.visualViewport.height` 直接作为容器高度，移除不可靠的 `100dvh` + `paddingBottom` 组合（`frontend/src/hooks/useMediaQuery.ts`、`frontend/src/components/Layout/Layout.tsx`）
- (2026-06-30 14:30) `[dev.sh]` 分支名不再硬编码 — `cmd_start`/`cmd_status` 使用 `$BRANCH_NAME` 替代写死的 `main（发布前哨站）`（`dev.sh`）
- (2026-06-30 14:30) `[dev.sh]` `kill_port_orphans` / `pid_by_port` 用 `sed` 替代 `grep -oP`，去除 PCRE 依赖（`dev.sh`）
- (2026-06-30 14:30) `[dev.sh]` `cargo run` / `pnpm dev` 前加 `stdbuf -oL -eL`，强制行缓冲确保崩溃日志实时输出（`dev.sh`）
- (2026-06-30 14:00) `[dev.sh]` 修复 `cargo run` + `vite` 启动后被 SIGHUP 杀死 — subshell 加 `trap '' HUP`（`dev.sh`）

- (2026-06-29 12:00) `[frontend]` 点击 Sidebar 工作区时文件管理器未切换到目标目录 — 修复：worktree 点击时清除 activeSession，使 fmSource 回退到 workspace 模式（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-06-25 11:00) `[backend]` 迁移 SQL 中 `w.path` 修正为 `w.root_path` — 旧表列名错误导致迁移失败（`migrations/20260625_workspace_to_project.sql`）

- (2026-06-23 19:30) `[frontend]` FileManager 搜索框改为图标触发式弹出 — 点击搜索图标后输入框浮现在图标下方，支持 Escape 和点击外部关闭（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-06-23 19:35) `[frontend]` FileManager 面包屑根路径从 `/` 改为工作台图标 — 带紫色边框方框，风格与 WRKSPACES `+` 号一致（`frontend/src/components/FileManager/icons.tsx`）
- (未记录时间) `[frontend]` FileManager: replaced all emoji icons (📁🔗📄⬆⟳📂✏️🗑️) with stroke-based inline SVG icons (`frontend/src/components/FileManager/icons.tsx`) — unified with the dark-tech visual language defined in `docs/ui-style-guide.md`
- (未记录时间) `[frontend]` FileManager: merged dual-table architecture (main table + absolute-positioned actions overlay) into a single 4-column table — Actions header now aligns perfectly with Name/Last Modified/Size; removed ~80 lines of JS row-height/scroll sync code
- (未记录时间) `[frontend]` FileManager action icons: pencil hover → violet (`#a78bfa`), trash hover → red (`#ef4444`) via `.fm-act-icon` / `.fm-act-icon-danger` CSS classes
- (未记录时间) `[frontend]` FileManager: fixed `addToast` calls to use `(type, message)` signature matching `toastStore.ts` API (was passing object)
- (未记录时间) `[frontend]` FileManager: fixed API method names — `api.rename` (was `api.renameFile`), `api.mkdir` (was `api.createDir`)

### Removed

- (未记录时间) `[frontend]` Removed unused `handleMkdir` function and `showNewDir`/`newDirName` state (no UI was wired to them)
- (未记录时间) `[frontend]` Removed `.fm-table-actions`, `.fm-td-actions`, `.fm-action` CSS rules (dead overlay-table styles)

### Added

- (未记录时间) `[frontend]` `frontend/src/components/FileManager/icons.tsx` — 10 SVG icon components (Folder, File, Link, ArrowUp, Refresh, Upload, FolderPlus, Pencil, Trash, FolderOpen), all 16×16 stroke-based with `currentColor`
- (2026-06-23 00:44) `[backend]` 新增 `GET /api/v1/sessions/{id}/cwd` 端点 — 查询终端实时工作目录（`src/api/sessions.rs`）
- (2026-06-23 00:47) `[backend]` 文件 API 全面支持 `session` 参数 — list/upload/delete/download/read/write/mkdir/rename/move/copy/search 均可基于终端 CWD 操作（`src/api/files.rs`）
- (2026-06-23 00:51) `[frontend]` FileManager 跟随终端 CWD 功能 — 双模式导航（跟随模式 + 手动导航），3 秒轮询同步，per-session 状态记忆（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-06-23 00:48) `[frontend]` 新增 WarningIcon、HomeIcon 图标组件（`frontend/src/components/FileManager/icons.tsx`）
- (2026-06-23 00:48) `[frontend]` appStore 新增 `fmSessionStates` 状态及 `setFmSessionMode`、`setFmManualPath`、`resetFmToFollowing` actions（`frontend/src/stores/appStore.ts`）
- (2026-06-23 00:48) `[frontend]` API client 新增 7 个 session-based 文件操作方法（`frontend/src/api/client.ts`）
- (2026-06-23 00:48) `[docs]` UI 风格规范新增 `warning` 语义色（`#f59e0b`）（`docs/ui-style-guide.md`）
- (2026-06-23 19:30) `[frontend]` 新增 IconSearch、IconWorkbench 图标组件（`frontend/src/components/FileManager/icons.tsx`）
- (未记录时间) `[infra]` `react-refresh` dev dependency — fixes pre-existing `$RefreshSig$ is not defined` error caused by missing peer dependency of `@vitejs/plugin-react` 6.x

### Fixed

- (2026-06-23 01:01) `[frontend]` FileManager 轮询改为只检查 CWD 变化，CWD 不变时不刷新文件列表 — 消除终端未 cd 时的闪烁
- (2026-06-23 01:07) `[frontend]` FileManager 静默轮询 + 浅比较：后台刷新不显示 loading 状态，文件列表无变化时跳过 setFiles() — 消除 agent 频繁增删文件时的闪烁

### Refactored

- (2026-07-04) `[frontend]` 抽离 reader 字体栈为单一来源 — 新建 `frontend/src/utils/fonts.ts` 导出 `READER_FONT`（`'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace`），干掉 6 处 `const FONT =` 顶层声明 + 14 处 inline `fontFamily: "..."` 字符串。后续调整 reader 字体只需改 `utils/fonts.ts` 一处。顺带修 `DuplicateProjectsDialog.tsx` 之前漏写的 `'Fira Code', 'Cascadia Code'` 截断 stack（`frontend/src/utils/fonts.ts` + 12 个消费方）

---

## Phase 1–8b (completed 2026-06-22)

Initial build. See `AGENTS.md` Current Progress table and `PROGRESS.md` for full details.

### Added

- `[backend]` Axum server with SQLite, JWT auth, CRUD APIs for targets/workspaces/sessions
- `[backend]` tmux session management, PTY bridge (portable-pty), WebSocket terminal
- `[backend]` Agent hook monitoring — pane content scanning, heuristic state detection
- `[backend]` File management API — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
- `[frontend]` Vite + React 19 + Tailwind 4 + xterm.js, three-panel layout (Sidebar | Terminal | FileManager)
- `[frontend]` Custom dufs-inspired file table replacing `@cubone/react-file-manager`
- `[frontend]` Dark violet-on-black palette, shared drag-bar styling, localized empty states
- `[frontend]` Drag-bar architecture upgrade — MutationObserver-based pane boundary relocation
- `[infra]` Dockerfile, docker-compose, `dev.sh` dev orchestration script
