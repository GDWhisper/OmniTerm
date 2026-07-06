# 技术债清理清单（2026-07-06）

> **来源**：commit `6ab8e46`（抽 `activateSession` action + pre-commit hook 扩展）执行时记录的非本次改动相关问题。
> **状态**：待执行；本轮**不**修，按优先级排期。
> **预计负责人**：待指派。

---

## 优先级 P1 — 影响每日开发的项

### 1.1 清理 73 个 pre-existing lint 错误

**根因**：`pnpm lint` 在 dev HEAD 上报 73 个问题，**全部 pre-existing**（在 `6ab8e46` 改动前后数量不变）。新增 pre-commit hook（`scripts/hooks/pre-commit`）已能拦截**新**错误，但这 73 个老错误仍卡住本地 commit 流程——开发者需每次 `--no-verify`。

**主要分布**（按文件）：

| 文件 | 错误数 | 主导类型 |
|---|---|---|
| `frontend/src/hooks/useTerminal.ts` | 10+ | `react-hooks/refs`（render 期读 `termRef.current`）|
| `frontend/src/api/client.ts` | 30+ | `@typescript-eslint/no-explicit-any` |
| `frontend/src/components/...` | 30+ | 混合（`no-explicit-any`、`no-empty`、`react-hooks/set-state-in-effect`）|

**推荐路径**：

1. **第一刀（机械修复，1-2 小时）**：全局 `: any` → `unknown` 或具体类型；`catch {}` 空块加注释（`// expected: foo`）。预计消 50+ 错误
2. **第二刀（结构性，半天）**：`useTerminal.ts:443` 的 `termRef.current` 暴露——按 React 19 惯例，hook 不在 render 期返回值对象，调用方应通过 ref 自行追踪。重构为 `const termRef = useRef<Terminal \| null>(null); useTerminal(..., termRef)` 模式
3. **第三刀（零散）**：剩余 `set-state-in-effect`、`react-hooks/refs` 错误逐个评估

**注意**：批量改 `: any` 可能影响外部 API 契约；改前跑 `pnpm test` 锁基线，commit 分小步走。

**验收**：`pnpm lint` 0 errors、`pnpm test` 全过、pre-commit hook 不再需要 `--no-verify`。

---

### 1.2 Sidebar 集成测试缺失

**根因**：`frontend/src/components/Sidebar/` 整个目录零测试。本次 commit `04324bd` 修复的「创建会话后未激活」bug 本质上是 3 行调用遗漏——一个 mock `api.createSession` + 断言 `activeSessionId` 的 ~30 行测试就能拦住。P1（抽 `activateSession` action）的 7 个 store 测覆盖了核心逻辑，但 UI 流程（点 + → 点 Create → 调 activateSession）只有 3 行 JSX，未被任何测试守护。

**推荐路径**：

1. 用 `vi.mock` mock 掉 `api/client`（`listProjects / listWorktrees / listSessions / listExternalSessions / health / systemInfo / listDuplicates` 全部返回空数组）和 `useAttention`（返回 no-op）
2. 预填 `useAppStore`：`projects = [fakeProject]`、`worktrees = { fakeProject.id: [fakeWorkspace] }`、`activeProjectId`、`activeWorkspaceId`、`expandedProjects = { fakeProject.id: true }`（让 worktree 渲染出来）
3. 触发流程：fireEvent.click `+` 按钮 → fireEvent.change 输入框 → fireEvent.click ModalPrimary
4. 断言：`useAppStore.getState().activeSessionId === fakeNewSession.id`

**预估代码量**：~150 行（含 mock setup）。Sidebar 依赖链长（PixelUI、icons、Modal），需要耐心调通。

**验收**：单测覆盖 `handleCreateSession` 至少 1 个 happy path。

---

## 优先级 P2 — bundle 与运行性能

### 2.1 修复 `IneffectiveDynamicImport`

**现象**（`pnpm build` 输出）：

```
[INEFFECTIVE_DYNAMIC_IMPORT] src/utils/audioFeedback.ts is dynamically imported by
src/components/Settings/Settings.tsx but also statically imported by
src/components/FileManager/FileManager.tsx,
dynamic import will not move module into another chunk.
```

**根因**：`FileManager.tsx` 静态 import 了 `audioFeedback`，导致 Settings 里的 `React.lazy(() => import('...'))` 失效——模块已被打进主 chunk，动态加载形同虚设。

**修复路径**：

1. 查 `FileManager` 真正用 `audioFeedback` 的何处（猜测是文件操作成功/失败提示音）
2. 改为按需 `import('...')` 或提取到一个不依赖 audioFeedback 的 façade
3. 验证：`pnpm build` 不再报 IneffectiveDynamicImport，Settings 关闭时不加载 audioFeedback

---

### 2.2 Bundle 体积拆分

**现状**（dev 实测）：主 chunk `index-*.js` = **755 kB / gzip 205 kB**（超出 500 kB 阈值）。`FileEditor` 已懒加载（1.68 MB → 755 kB），但 xterm + addons 仍占大头。

**优化方向**（按性价比排）：

1. **xterm addons 按需加载**：`addon-fit`、`addon-web-links` 当前与 xterm 主包同 chunk；改为 `import('xterm-addon-fit')` / `import('xterm-addon-web-links')` 形式
2. **i18n 拆 chunk**：locales 当前 2 个全量进主 bundle；按语言代码动态 import
3. **CodeMirror 语言包进一步按扩展名细分**（已在 `FileEditor.dynamic.test.tsx` 覆盖 13 种扩展名，可继续扩到全量）

**注意**：拆 chunk 会增加首次加载的网络请求数；只对**主 chunk** 优化，二级 chunk 增多不一定是好事。

---

## 优先级 P3 — 工程化

### 3.1 Pre-commit hook 加入 onboarding 文档

**现象**：`scripts/hooks/pre-commit` 已扩展为拦截 frontend lint，但每个 worktree 需手动：

```bash
git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/pre-commit
```

**没有 onboarding 文档**——新人 clone 完直接 commit 会漏掉 hook。

**推荐路径**：在 `AGENTS.md` 的「文档索引」表加 `scripts/hooks/pre-commit` 行，并在 worktree 初始化章节加 1 段 hook 安装说明。或新建 `docs/dev/git-hooks.md` 写详细用法 + 跳过的语义（`--no-verify`）。

---

### 3.2 CI 必跑 lint / test

**现象**：当前 73 个 pre-existing 错误能进 dev 分支，说明 CI 没卡 lint 也没卡 test。`pre-commit hook` 只能拦本地，不能拦通过 GitHub PR 提交的代码。

**推荐路径**：在 `.github/workflows/` 加一条 `lint-and-test.yml`：on `pull_request` 跑 `pnpm install && pnpm lint && pnpm test && pnpm build`。pre-commit hook 失效（`git commit --no-verify` 绕过）时 CI 兜底。

---

## 不在本次范围（明确跳过）

- `useTerminal.ts:443` `termRef.current` 暴露的 React 19 重构（在 1.1 第二刀内处理）
- `src/api/sessions.rs`、`src/tmux/mod.rs` 等后端改动（dev 上 in-flight，与本轮无关）
- 73 个 lint 错误中涉及 ts 严格模式升级的子集（评估后单独 PR）

---

## 时间线

| 建议 | 优先级 | 估时 | 建议周期 |
|---|---|---|---|
| 1.1 清理 lint 错误 | P1 | 1-2 天 | 下个 sprint 优先 |
| 1.2 Sidebar 集成测试 | P1 | 0.5 天 | 配合 1.1 一起做 |
| 2.1 修 IneffectiveDynamicImport | P2 | 0.5 天 | 1.1 完成后 |
| 2.2 bundle 拆分 | P2 | 1 天 | 2.1 完成后 |
| 3.1 hook onboarding 文档 | P3 | 0.1 天 | 任何时候可做 |
| 3.2 CI lint/test | P3 | 0.3 天 | 任何时候可做 |

---

**记录人**：执行 commit `6ab8e46` 时同步记录
**最后更新**：2026-07-06
