## 0. 修复预先存在的 TypeScript 构建错误

- [x] 0.1 移除 `FileManager.tsx` 中未使用的 `triggerScorePop`、`triggerStomp` 导入
- [x] 0.2 修复 `FileManager.tsx` 中 `FileDrawer` 的 `sessionId`/`workspaceId` 类型不匹配（`null` → `undefined`）
- [x] 0.3 在 `Sidebar.tsx` 中补全 `Project`/`Workspace` 类型导入，并更新 `api/client.ts` 的 `updateProject` 类型以支持 `path`
- [x] 0.4 修复 `MobileKeyBar.test.tsx` 的 type-only import 和 `latchMod` 默认值
- [x] 0.5 移除 `Terminal.tsx` 中未使用的 `terminal` 变量
- [x] 0.6 在 `useTerminal.ts` 中为 `attention.fire/clearAlert` 添加 `sessionId` 非空保护
- [x] 0.7 运行 `pnpm build` 确认 TypeScript 通过，并提交：`fix: resolve pre-existing TypeScript build errors`
- [x] 0.8 修复 `MobileKeyBar.test.tsx` 的状态管理，运行 `pnpm test` 确认全部通过

## 1. 清理死依赖

- [x] 1.1 在 `frontend/package.json` 中移除 `@cubone/react-file-manager`、`xterm`、`@codemirror/autocomplete`、`@codemirror/lint`
- [x] 1.2 删除 `frontend/src/cubone-file-manager.d.ts`
- [x] 1.3 在 `frontend/` 下执行 `pnpm install` 并确认无报错
- [x] 1.4 在 `frontend/src/` 全目录搜索上述 4 个包名，确认零 runtime 引用
- [x] 1.5 运行 `pnpm build`，确认产物构建成功
- [x] 1.6 提交：`fix: remove dead frontend dependencies`

## 2. 懒加载 FileEditor 组件

- [x] 2.1 在 `frontend/src/components/FileManager/FileDrawer.tsx` 中将 `FileEditor` 改为 `React.lazy(() => import('./FileEditor'))`
- [x] 2.2 在 `FileDrawer` 渲染 `FileEditor` 的位置添加 `Suspense` 与 loading 占位
- [x] 2.3 确认 `FileEditor` 仍以 named export 暴露，通过 `then(m => ({ default: m.FileEditor }))` 映射给 `React.lazy`
- [x] 2.4 运行 `pnpm build`，确认生成独立的 editor chunk
- [x] 2.5 提交：`feat: lazy-load FileEditor component`

## 3. CodeMirror 语言包按需加载

- [x] 3.1 删除 `frontend/src/components/FileManager/FileEditor.tsx` 顶部 13 个静态 `@codemirror/lang-*` import
- [x] 3.2 新增 `langLoaders` 映射表，按扩展名返回动态 `import()` 工厂函数
- [x] 3.3 将 `getLanguageExtension` 改为 async 函数，返回对应 language extension Promise
- [x] 3.4 在 `createExtensions` 中 `await` 语言包加载，并处理加载失败 fallback（plain text）
- [x] 3.5 确认 `vite.config.ts` 无需特殊配置即可自动拆分 lang chunks
- [x] 3.6 提交：`feat: load CodeMirror language packages on demand`

## 4. 回归测试与基线测量

- [x] 4.1 启动 dev 服务，验证 Sidebar、FileManager、Settings、Terminal 正常（通过 `./dev.sh restart` + HTTP 200 + 测试通过验证）
- [x] 4.2 通过新增回归测试 `FileEditor.dynamic.test.tsx` 覆盖 13 种文件类型的动态语言加载，确认无 error 且 editor 正常渲染
- [x] 4.3 执行 `cargo build --release`，记录产物路径与大小
- [x] 4.4 执行 `frontend/pnpm build`，记录 `frontend/dist/assets` 主 JS 与 editor chunk 大小
- [x] 4.5 启动 release binary，静置 30s 后读取 `/proc/[pid]/status` 的 `VmRSS`
- [x] 4.6 将测量结果写入 `docs/performance-baseline-v0.1.0.md`
- [x] 4.7 提交：`docs: add v0.1.0 performance baseline`

## 5. 合并到 main

- [x] 5.1 在 main worktree 执行 `git merge dev --no-commit`
- [x] 5.2 解决 `Cargo.toml` 中二进制名冲突，保留 `omniterm-main`；同时解决 `dev.sh` 与 origin/main 的冲突
- [x] 5.3 在 main worktree 执行 `./dev.sh restart`，确认服务正常启动
- [x] 5.4 提交 merge commit
- [x] 5.5 推送 main 到 origin

## 6. 发布前最终确认

- [ ] 6.1 按 `docs/release-plan.md` 确认 release 分支重建时不会带入开发文件
- [ ] 6.2 确认 CHANGELOG 已添加本次性能清理条目
- [ ] 6.3 关闭本 change 或在 OpenSpec 中标记完成
