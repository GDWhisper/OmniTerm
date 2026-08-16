# OmniTerm v0.2.15 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 新增 localhost 端口转发反向代理 `/proxy/{port}`：浏览器经 OmniTerm 访问远程机器的 localhost 服务，聊天与终端里的 localhost 链接自动改写为代理地址一键打开
- 反代支持子域名形态 `{port}.{proxy_domain}` 与局域网 IP 直连的绝对路径 SPA（HTML/JS 字节级重写 + React Router basename 注入），并支持 Vite HMR 等 WebSocket dev server 双向 relay
- ACP 聊天桌面动作条交互优化：两段式 hover（气泡只显图标、图标 hover 才显文字）+ 浮层动态定位（空间不足自动翻转）

## 重要修复

- 修复文件监控（`/files/watch`）在含 node_modules 的大项目里内存无界增长直至 OOM（正式版曾实测 RSS 涨至 7GB）：手动递归注册 inotify watch 并剪枝 node_modules/.git/target，watch 数降到业务目录量级
- 反向代理正确性/健壮性加固：`/api` 无尾随斜杠字面量重写、`X-Forwarded-*` 透传、`Location` 回环重定向、WS 入口 Origin 校验（CSWSH 防御）、relay 收尾发送 Close 帧、`Content-Encoding: identity` 明文重写、IPv6 Host 解析、请求体上限可配置（`--proxy-max-body`）

## 工程改进

- 新增 `scripts/preflight-release.sh` 发布前渠道可发布性预检（crates.io / npm 版本号可用性 + cargo 依赖可发布性），避免发布中途才发现渠道不可用

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.14...v0.2.15
