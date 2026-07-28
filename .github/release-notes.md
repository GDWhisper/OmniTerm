# OmniTerm v0.2.1 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 重要修复

- **CI 质量门禁修复**：修复 `ci.yml` 的 rust job 与 `build.rs` 契约不匹配——原 rust job 仅创建空 `frontend/dist` 占位目录，但 `build.rs` 校验 `frontend/dist/index.html` 存在，导致 push main 时 rust job 恒红、CI 门禁形同虚设。现 rust job 先 `pnpm build` 再 `cargo check`，与发布脚本及 release 流水线对齐
- **发布流程强化**：crates.io 发布不可逆，发布指导新增「强制发布顺序」铁律——`cargo publish` 必须排在 GitHub Release CI 与 push main 的 CI **全部转绿之后**，禁止抢跑。本次 0.2.0 因抢跑导致 crates.io 上线错版，以 0.2.1 重发覆盖

## 工程改进

- 发布指导（`docs/workflows/release-guide.md`）补充 CI 全绿前置条件与抢跑后果说明，明确配套约束（ci.yml 与 build.rs 契约一致性）

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：从 Releases 下载对应平台 binary 覆盖，或运行 `omniterm update` 一键升级

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.0...v0.2.1
