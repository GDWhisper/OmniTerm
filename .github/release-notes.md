# OmniTerm v0.2.7 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- npm 安装完成时新增引导提示：`npm install -g @gdwhisper/omniterm` 装完即提示「打开新终端运行 `omniterm start`」，不再让新用户对着 PATH 缓存困惑
- daemon 模式日志落盘：`omniterm start --daemonize` 后台运行的日志从静默丢弃改为写入 `~/.omniterm/<binary>.log`，排查后台问题有据可查

## 重要修复

- 修复 `BIND_ADDR` 环境变量劫持端口问题：用户显式传 `-p`/`-H` 不再被环境变量覆盖（此前残留的 dev 环境变量会导致 npm 正式版启动报 Address already in use），未显式传参时环境变量仍作为部署兜底生效

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.6...v0.2.7
