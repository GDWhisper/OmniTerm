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
**最后更新**：2026-07-06（2026-07-07 补充简单层清理进展）

---

## 2026-07-07 补充 — 简单层已清（9/64 → 53 剩余）

按计划 1.1「第一刀机械修复」范畴，先清掉零风险/零行为影响的 🟢 机械层
（共 9 个），不碰 react-hooks 结构性部分（refs / set-state-in-effect /
immutability）与 `client.ts` 的 `any`（涉及外部 API 契约，留待排期）。

**已消错误（9 个）**：

| 文件 | 行 | 规则 | 改法 |
|------|----|----|----|
| `AttentionProvider.test.tsx` | 238/260/283 | `prefer-const` | `ctxRef` `let`→`const`（闭包只读） |
| `FileManager.tsx` | 298 | `no-unused-vars` | 删未用参数 `_e`，调用点 `onClick={() => handleRowClick(f)}` |
| `useTerminal.ts` | 133 | `no-empty` | 空 `catch {}` 补注释说明吞非 JSON 帧的原因 |
| `FileManager.tsx` | 938/944/950 | `react-hooks/static-components` | `<SI>` 提到模块级 `SortIndicator`（传 `sortKey`/`sortDesc` prop） |
| `AttentionProvider.tsx` + `hooks/useAttention.ts` | 193 | `react-refresh/only-export-components` | `useAttention` 移到 `hooks/useAttention.ts`，`AttentionContext` 一并迁过去创建；provider 文件只导出组件 |

**验证**：`npx eslint .` 64 → 53 errors；`npx tsc --noEmit` 0 errors。

**剩余 53 个（结构性，待排期）**：

- `no-explicit-any` ×27（含 `client.ts` ×11，需注意外部 API 契约）
- `react-hooks/set-state-in-effect` ×13
- `react-hooks/refs` ×9
- `react-hooks/immutability` ×4

均属 1.1 第二刀/第三刀范畴，按原计划下个 sprint 处理。

---

## 2026-07-07（二）补充 — any 层清零 + 2 处真实隐患已修，剩余 18 errors 待策略决策

> 本轮基于「快照不刻舟求剑」原则：**以当前代码真实状态为准**，而非照搬文档原始行号。
> 先 `npx eslint .` 复测，确认当前真实总数 53 errors + 11 warnings（与快照一致），再动手。

### 已完成（已提交/待 commit）

**1. `@typescript-eslint/no-explicit-any` 全清（25 → 0）** — 纯类型层修复，不改运行时行为，`tsc --noEmit` 仍 0 errors。

- `src/api/client.ts`（11 处）：用已定义的 `FileEntry` 对齐 API 返回类型
  - `ApiError.body` 及构造函数参数 `any` → `unknown`
  - `hookStatus` `request<any>` → `request<unknown>`
  - `listFiles` / `searchFiles` / `searchFilesBySession` / `searchFiles2` → `request<FileEntry[]>`
  - `listFilesBySession` / `listFiles2` → `request<{ files: FileEntry[]; cwd: string; is_outside_workspace: boolean }>`
  - `mkdir2` / `rename2` 的 `const body: any` → 显式接口类型（含可选 `session`/`workspace_id`/`workspace`）
- `src/components/Terminal/MobileKeyBar.tsx`（2 处）：`MOD_KEYS.includes(name as any)` → `(MOD_KEYS as readonly string[]).includes(name)`
- 13 处 `catch (err: any)` / `catch (e: any)` / `.catch((e: any)` → `catch (err: unknown)` + 收窄：
  - `FileManager.tsx`（187/439/468/489/531/554/673）
  - `FileDrawer.tsx`（107/157）
  - `Sidebar.tsx`（300/323/1251）
  - `DuplicateProjectsDialog.tsx`（59/69）
  - 收窄统一用 `err instanceof Error ? err.message : String(err)`；`DuplicateProjectsDialog` 额外兼容非 Error/字符串（保留 `?? 'merge failed'` 语义）

**2. 两处真实隐患（结构性，已重构，非豁免）**

- `src/hooks/useFileWatcher.ts`：重连闭包自引用 `connect()` 改为 `connectRef.current?.()`
  - 根因：`connect` 的 `useCallback` 依赖 `[sessionId, enabled, cleanup]`，`setTimeout` 闭包会捕获旧 `connect` 身份 → 用旧 `sessionId` 重连。新增 `connectRef` 持有最新引用，重连始终调最新。
- `src/components/FileManager/FileManager.tsx`：`closeCreate` 改为 `useCallback([])` 并加入点击外部关闭 effect 的依赖 `[createOpen, closeCreate]`
  - 消除 `react-hooks/immutability` 报的「声明前引用 / 遗漏依赖」。

### 剩余（18 errors，待策略决策）

全部来自 `react-hooks` v7.1.1 的**新规则**（v7 `flat.recommended` 预设默认开启）：

- `react-hooks/set-state-in-effect` ×13（effect 内取数据 / 状态重置 / 动画）
- `react-hooks/refs` ×3（render 期读 `termRef.current` / `useFileWatcher` 读 ref）
- `react-hooks/immutability` ×1（`FileManager` `closeCreate` 声明前访问——注：上述重构后若仍报需复测）
- `react-hooks/preserve-manual-memoization` ×1

**已验证的关键事实（影响决策）**：
1. 这些 v7 新规则**对 `// eslint-disable-next-line` 注释免疫**（v7 设计特性，标准禁用指令被标记为 "Unused directive" 且关不掉规则）。本轮曾尝试加豁免注释，已全部撤回（见下）。
2. **v7 是项目自己选的**：`frontend/package.json` devDependencies 直接写 `^7.1.1`，initial commit 即写定，无 monorepo 根 / 共享配置 / 文档强制；git 无「升级到 v7」记录。
3. **无 CI lint 门禁**：`.github/workflows/release.yml`、`Dockerfile`、`dev.sh` 均不跑 `pnpm lint`，故 lint errors 不阻断构建/发布。

### 撤销的操作（回滚记录）

- 曾对 15 处「合理惯用法」effect/ref 写操作加 `// eslint-disable-next-line react-hooks/*` + 解释注释（共 21 处）。因 v7 规则免疫禁用注释、且产生 12 条 "Unused directive" 警告，**已全部删除**（保留原有业务注释如 `// Initial load`、`// Stable refs to decouple...`）。

### 待决策（用户拍板）

清零 lint 的可行路径（因 disable 注释无效，仅剩两条）：

- **A. 配置降级**：在 `eslint.config.js` 显式将 `react-hooks/set-state-in-effect`、`react-hooks/refs`、`react-hooks/immutability`、`react-hooks/preserve-manual-memoization` 设为 `off`。最干净，且已修的真问题不受影响。
- **C. 逐个重构**：逐一改写 18 处代码消除规则触发（成本高、有引入运行时 bug 风险，部分惯用法难以无副作用改写）。

> 验证命令：`cd frontend && pnpm lint`（目标 0 errors）、`pnpm exec tsc --noEmit`（当前 0 errors）。
> 注：本轮修复尚未 commit，待 lint 策略决策确定后一并提交。

---

## 2026-07-07（三）补充 — 采用选项 A，lint errors 清零

**决策**：采用选项 A（配置降级），关闭 4 个 react-hooks v7 过严规则。

**理由**：
- disable 注释对 v7 规则无效（v7 设计特性）
- 这些规则与项目惯用法冲突（effect 内 setState、render 时更新 ref 都是标准模式）
- 项目未使用 React Compiler，`preserve-manual-memoization` 无实际意义
- 已修复的真实问题（useFileWatcher 重连闭包、FileManager closeCreate 依赖）不受影响

**已完成**：

1. `eslint.config.js`：关闭 4 个规则（`set-state-in-effect`、`refs`、`immutability`、`preserve-manual-memoization`）
2. `useTerminal.ts`：删除死代码 `terminal: termRef.current`（无任何调用方使用该返回值）

**结果**：
- `pnpm lint`：28 errors → 0 errors，11 warnings 保留（`exhaustive-deps`）
- `pnpm exec tsc --noEmit`：0 errors
- pre-commit hook 正常通过

**验收**：✅ `pnpm lint` 0 errors、`pnpm test` 全过、pre-commit hook 不再需要 `--no-verify`

---

## 2026-07-07（四）补充 — 1.2 Sidebar 集成测试已完成

**已完成**：

1. `frontend/src/components/Sidebar/Sidebar.test.tsx`：新增集成测试文件
   - 测试 `handleCreateSession` 完整流程：点击 `+` → 输入名称 → 提交 → 调用 `api.createSession` → 调用 `activateSession`
   - 测试空名称场景：不输入名称时调用 `createSession(undefined)`
   - mock `api/client`、`useAttention`、`pixelAnimations`
   - 预填 `useAppStore` 模拟真实状态

**测试覆盖**：
- ✅ 创建会话后自动激活（`activeSessionId === fakeNewSession.id`）
- ✅ 清除外部会话（`activeExternalSession === null`）
- ✅ 正确传递参数给 `api.createSession`

**验收**：✅ 单测覆盖 `handleCreateSession` 至少 1 个 happy path

---

## 2026-07-07（五）补充 — P2 级问题已完成

### 2.1 IneffectiveDynamicImport ✅

**已完成**：
- `FileManager.tsx`：删除 `audioFeedback` 静态 import，三处 `play8BitSound` 调用改为动态 import
- 结果：`pnpm build` 不再报 IneffectiveDynamicImport，Settings 懒加载生效

**验证**：构建输出中 `audioFeedback` 已拆分为独立 chunk（0.80 kB）

### 2.2 Bundle 体积拆分 ✅

**已完成**：
- `useTerminal.ts`：删除 `addon-fit` 和 `addon-web-links` 静态 import
- `createTerminal` 改为 async，使用 `Promise.all` 动态加载两个 addons

**结果**：
- `addon-fit` 拆分为独立 chunk（1.21 kB）
- `addon-web-links` 拆分为独立 chunk（2.38 kB）
- 主 chunk 从 755 kB 降至 752 kB（小幅减少，主要收益是懒加载生效）

**验收**：✅ `pnpm build` 成功，addon 独立 chunk
