## ADDED Requirements

### Requirement: 清理前端死依赖
发布构建产物中不得包含未使用或重复的依赖包，以减小 bundle 体积和运行时内存。

#### Scenario: 移除死依赖后构建成功
- **当** 从 `frontend/package.json` 移除 `@cubone/react-file-manager`、`xterm`、`@codemirror/autocomplete`、`@codemirror/lint`，并删除 `frontend/src/cubone-file-manager.d.ts`
- **则** `pnpm install` 成功，`pnpm build` 成功，`frontend/dist/assets` 中不再出现上述包的代码

#### Scenario: 源码无残留引用
- **当** 在 `frontend/src/` 全目录搜索上述 4 个包的名称
- **则** 找不到任何 import 或 runtime 引用

### Requirement: CodeMirror 语言包按需加载
`FileEditor` 不得一次性静态加载全部 13 个 `@codemirror/lang-*` 包，而应按实际打开文件的扩展名动态加载。

#### Scenario: 打开不同语言文件时只加载对应语言包
- **当** 用户首次打开 `.rs` 文件
- **则** 仅 `@codemirror/lang-rust` 及其 lezer parser 被加载

#### Scenario: 重复打开同类型文件不重复加载
- **当** 用户关闭 `.rs` 文件后再次打开另一个 `.rs` 文件
- **则** 浏览器不会再次请求 `lang-rust` chunk

#### Scenario: 所有支持的文件类型高亮正常
- **当** 用户依次打开 `.js`、`.ts`、`.py`、`.json`、`.html`、`.css`、`.md`、`.yaml`、`.sql`、`.go`、`.java`、`.cpp`、`.php` 文件
- **则** 每个文件都显示正确的语法高亮，且无 console error

### Requirement: 文件编辑器组件懒加载
`FileEditor` 不应被包含在应用初始加载的主 chunk 中，只有在用户打开文件编辑器时才加载。

#### Scenario: 主 chunk 不包含 FileEditor
- **当** 执行 `pnpm build` 并查看 `frontend/dist/assets`
- **则** 主 JS chunk 中不包含 `FileEditor.tsx` 的代码，且存在一个独立的 editor chunk

#### Scenario: 打开文件时显示加载态
- **当** 用户第一次点击文件打开 editor
- **则** 在 editor chunk 下载期间显示 loading 占位，chunk 加载完成后正常显示编辑器

### Requirement: 建立发布性能基线
在 v0.1.0 发布前必须测量 release 构建的真实内存和体积基线，并记录在案。

#### Scenario: 测量 release binary 内存
- **当** 使用 `cargo build --release` 构建后启动 binary，静置 30 秒
- **则** 可读取 `/proc/[pid]/status` 中的 `VmRSS` 并记录到 `docs/performance-baseline-v0.1.0.md` 或 PR 描述中

#### Scenario: 测量前端产物体积
- **当** 执行 `pnpm build` 后
- **则** 可列出 `frontend/dist/assets` 中主 JS 与 editor chunk 的文件大小并记录
