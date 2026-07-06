## Context

OmniTerm 前端目前存在两类明显的内存/体积浪费：

1. **死依赖**：`package.json` 中声明了 `@cubone/react-file-manager`、`xterm@5.3.0`、`@codemirror/autocomplete`、`@codemirror/lint`，但源码中无 runtime 引用。这些包仍可能被打包进生产 bundle，并增加 release binary 体积。
2. **CodeMirror 全量静态加载**：`FileEditor.tsx` 在文件顶部静态 import 了 13 个 `@codemirror/lang-*` 包。即使用户从不打开文件编辑器，或只打开一两种文件，V8 heap 中仍保留全部语言 parser。

后端当前使用 dev profile 启动，正式发布应使用 release profile 以降低 RSS。

本设计文档说明如何在不改变功能的前提下完成清理与懒加载。

## Goals / Non-Goals

**Goals：**
- 移除前端所有已确认的死依赖
- 将 `FileEditor` 从主 chunk 拆分出去，实现组件级懒加载
- 将 CodeMirror 语言包改为按扩展名动态加载
- 建立 v0.1.0 release 构建的内存/体积基线
- 保持所有现有文件编辑/预览功能不变

**Non-Goals：**
- 不替换 CodeMirror 为 Monaco 或其他编辑器
- 不拆微前端
- 不改 i18n 架构或 Tailwind 配置
- 不调整后端服务架构
- 不优化 dev 模式下的 Vite HMR/esbuild 内存（该内存在生产环境不存在）

## Decisions

### Decision 1：在 dev 分支实施，再合并到 main
**原因**：按 `docs/branch-workflows.md`，dev 是主开发分支，main 是发布前哨。当前 dev 与 main 代码一致，直接在 dev 工作树修改，完成后 `git merge dev` 到 main，最符合现有工作流。合并时需注意 `Cargo.toml` 的二进制名冲突，保留目标分支的 `omniterm-main`。

### Decision 2：先删死依赖，再做懒加载
**原因**：
- 死依赖删除是零风险、高确定收益的操作，应单独提交以便回滚。
-  Tier 1 完成后可立即测量一次 bundle 体积，作为 Tier 2 的对比基线。

### Decision 3：`React.lazy` 拆分整个 `FileEditor`，内部再动态加载语言包
**原因**：
- 仅内部动态加载语言包，editor 主题、`HighlightStyle`、`foldGutter` 等仍会随 `FileDrawer` 进入主 chunk。
- 用 `React.lazy` 拆分整个组件，可在不打开文件编辑器时完全不加载 editor 相关代码，收益更大。
- `FileDrawer` 已经是独立组件，只在用户打开文件时渲染，拆分点自然。

### Decision 4：保留当前扩展名到语言包的映射逻辑
**原因**：`FileEditor.tsx` 中的 `getLanguageExtension` 已经按扩展名分发，只需把 `switch` 分支的返回值从静态实例改为动态 `import()` 的工厂函数，改动最小，回归风险最低。

### Decision 5：使用 `import()` + Vite code splitting，不做手动 chunk 配置
**原因**：
- Vite/Rollup 会自动为每个动态 `import()` 创建单独 chunk，无需手动维护 `manualChunks`。
- 对于 release binary 内置前端，这些 chunk 从本地 `http://localhost` 加载，网络延迟可忽略。

### Decision 6：懒加载时提供简单 loading 占位
**原因**：
- 首次打开文件时可能需要等待 editor chunk 下载/解析几十到一百毫秒。
- 在 `FileDrawer` 的 `Suspense` 中使用与现有 loading 样式一致的占位，避免白屏。

## Risks / Trade-offs

| Risk | 影响 | Mitigation |
|---|---|---|
| 动态 `import()` 在 Vite dev 模式下首次打开文件时延迟较高 | 开发体验 | 仅影响首次打开某语言文件；生产 release binary 本地加载，延迟可忽略 |
| `React.lazy` 拆分后，`FileEditor` 的 TypeScript 类型导出需要调整 | 编译错误 | 使用 `lazy(() => import('./FileEditor'))`，确保 `FileEditor` 以 named export 暴露 |
| 删除 `@codemirror/lint` 后未来若需 lint 功能需重新加回 | 功能扩展 | 该包目前零引用，删除是安全清理；需要时再安装即可 |
| 动态加载语言包后，某些语言的高亮回归不易发现 | 用户可见 bug | 回归测试覆盖 13 种支持扩展名，逐一打开并检查 console |
| 合并到 main 时 `Cargo.toml` 二进制名冲突 | 分支身份错误 | merge 时保留目标分支的 `omniterm-main`，`.env.local` 不受影响 |

## Migration Plan

1. **Tier 1：删依赖**
   ```bash
   cd frontend
   pnpm remove @cubone/react-file-manager xterm @codemirror/autocomplete @codemirror/lint
   rm src/cubone-file-manager.d.ts
   pnpm install
   ```
   提交：`fix: remove dead frontend dependencies`

2. **Tier 2：懒加载 FileEditor + 动态语言包**
   - 在 `FileDrawer.tsx` 中将 `import { FileEditor } from './FileEditor'` 改为 `const FileEditor = lazy(() => import('./FileEditor'))`
   - 在 `FileEditor.tsx` 中将静态 lang import 改为 `langLoaders` 映射表
   - 在 `getLanguageExtension` 中返回 `await langLoaders[ext]()`，调用方改为 `async/await` 或 Promise 处理
   - 提交：`feat: lazy-load FileEditor and CodeMirror language packages`

3. **验证与基线测量**
   - `pnpm build` + `cargo build --release`
   - 运行 release binary，记录 `VmRSS` 与 `frontend/dist/assets` 体积
   - 提交：`docs: add v0.1.0 performance baseline`

4. **合并到 main**
   ```bash
   # 在 main worktree
   git merge dev --no-commit
   # 解决 Cargo.toml 二进制名为 omniterm-main
   git commit
   ```

## Open Questions

1. 是否需要对常用语言（如 js/ts/rust）做 idle 预加载，以进一步降低首次打开延迟？
2. `FilePreview` 组件是否也应拆分？当前图片预览逻辑较轻量，可暂不处理。
3. release binary 的内存基线是否需要在 CI 中自动记录，还是仅手动记录一次？
