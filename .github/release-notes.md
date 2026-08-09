# OmniTerm v0.2.12 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- Sidebar 新增「会话展开模式」切换按钮：一键展开所有含会话的项目与 worktree，折叠状态自动记忆
- 项目路径失效检测：路径被移动/删除时项目行标红并提示修复，可重新定位项目路径
- `omniterm start -d` 后台启动不再静默：成功打印监听地址与 PID，失败直接报错到终端

## 重要修复

- 文件浏览器文本预览改为内容兜底：`Cargo.lock` 等非常见后缀的文本文件也能直接预览，二进制文件自动降级为「无法预览」
- 修复 ACP 权限审批链路：并发多个权限请求不再互相覆盖、断连后陈旧 banner 自动清除、「需要决策」提示不再卡死会话
- 修复 `start -d` 后台启动失败无感知并残留失效 PID 文件的问题
- 修复点击会话未同步高亮所属 worktree、侧栏分支名过长被省略号截断时显示错乱

## 工程改进

- CLI 输出统一为英文（`--help` 与运行时提示）
- ThinkingIndicator 乱码特效自适应帧率节流，高刷屏动画更流畅

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.11...v0.2.12
