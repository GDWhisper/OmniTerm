# OmniTerm v0.3.4 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- GIT 面板支持 hunk 级暂存 / 取消暂存 / 回滚：diff 抽屉内按块操作，应用前与当前 diff 逐字比对，内容已变化时提示并自动刷新；diff 上下文可在 U3 / U10 间切换。
- GIT 面板支持分支对比与 merge/rebase：BASE 选择器查看 `base...HEAD` 文件列表与只读 diff；分支行内可直接合并或变基，冲突时面板常驻中断态横幅提供 CONTINUE / ABORT。
- GIT 提交详情展示变更文件（状态字母、重命名原路径、截断提示）；HISTORY 支持按单个文件或全分支过滤。
- 文件管理器大目录体验优化：大列表启用虚拟滚动，目录列表默认最多返回 5000 条并显示「前 N / 共 M 项」与「加载全部」；搜索改为按需 stat，结果确定性排序并明示截断（2 万文件树罕见查询实测约 0.8s → 0.05s）。

## 重要修复

- 修复文件搜索结果路径错误：同名嵌套文件此前可能指向根目录同名文件，现统一使用后端相对路径并在结果行显示所在目录。
- 修复 GIT 面板快速连点写操作时第二个操作未执行却提示成功。
- 修复长期打开的标签页收不到新版本提醒：改为每 10 分钟轮询，并在页面恢复可见 / 网络恢复时补查。

## 工程改进

- 版本探测支持可选 GitHub token（`GH_TOKEN` / `GITHUB_TOKEN`，有效时 API 额度提升至 5000 次/时），缺失或失效时继续按渠道降级；两个变量不再继承进终端 / agent / update 子进程。
- 文件管理器目录元数据读取合并为一次 stat，不再为每个子目录预统计条目数，降低大目录加载开销。
- **BREAKING**（API）：项目兜底 `GET /files?workspace=` 返回从裸数组改为 `{files,total,truncated}`（当前前端未使用该路径）。

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.3.3...v0.3.4
