## Why

OmniTerm v0.1.0 发布前需要一轮低风险的性能清理。当前前端存在已确认的死依赖和 CodeMirror 语言包全量静态导入，导致生产 bundle 体积和运行时内存高于必要水平；后端日常开发使用 dev profile，正式发布时应以 release profile 构建以降低内存占用。本变更在 dev 分支完成，随后合并到 main，为 release 提供干净的性能基线。

## What Changes

- **清理前端死依赖**：从 `frontend/package.json` 移除并卸载以下未使用或重复的包：
  - `@cubone/react-file-manager`（仅有占位 `.d.ts`，无 runtime 引用）
  - `xterm@5.3.0`（与正在使用的 `@xterm/xterm@6.0.0` 重复）
  - `@codemirror/autocomplete`（零 import）
  - `@codemirror/lint`（零 import）
  - 删除 `frontend/src/cubone-file-manager.d.ts`

- **CodeMirror 语言包按需加载**：将 `FileEditor.tsx` 中 13 个 `@codemirror/lang-*` 的静态导入改为按文件扩展名动态 `import()`，仅在实际打开对应类型文件时加载对应 parser。

- **懒加载文件编辑器组件**：使用 `React.lazy` 将 `FileEditor` 从 `FileDrawer` 的主 chunk 中拆分出去，未打开文件编辑器时不加载 editor 相关代码；打开后再按需加载具体语言包。

- **发布构建基线测量**：建立 v0.1.0 性能验收脚本，测量并记录以下指标：
  - `frontend/dist/assets` 主 JS 体积
  - `cargo build --release` 产物大小
  - release binary 静置 30s 后的 `VmRSS`

- **不做的范围**：
  - 不替换 CodeMirror 为 Monaco
  - 不拆微前端
  - 不大改 i18n 或 Tailwind 配置（当前收益有限）
  - 不调整后端架构（portable-pty、axum、SQLite 等已足够高效）

## Capabilities

### New Capabilities

- `frontend-performance`: 定义前端 bundle 清理、CodeMirror 懒加载及按需语言加载的性能目标与验收标准。

### Modified Capabilities

- 无现有 spec 的行为级变更需要修改。

## Impact

- `frontend/package.json` 与 `pnpm-lock.yaml`：依赖列表变化
- `frontend/src/components/FileManager/FileEditor.tsx`：静态 import 改为动态加载
- `frontend/src/components/FileManager/FileDrawer.tsx`：改为 `React.lazy` 引入 `FileEditor`
- `frontend/src/cubone-file-manager.d.ts`：删除
- `Cargo.toml` / 构建流程：发布流程必须使用 `cargo build --release`
- 最终 release binary 体积和运行时内存均会下降
