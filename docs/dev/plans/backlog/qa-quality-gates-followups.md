# 质量门禁后续跟踪项

> 来源：`docs/dev/plans/2026-07-24-quality-gates.md` §2.3 P2 + §3.3
> 本轮 Phase 1+2 已落地（CI workflow / pre-commit / clippy / rustfmt / cargo-deny / strict / 文档审计）；以下为后续推进项。

| ID | 项目 | 现状 | 触发条件 |
|----|------|------|---------|
| R01 | clippy warn → deny 升级 | `[lints.clippy] correctness/suspicious/style/complexity/perf = warn`，CI/pre-commit 以 `-D warnings` 兜底 | 清理 `docs/dev/plans/backlog/dead-code-triage.md` 全部 allow 后，按组逐级升 `deny` |
| R02 | `cargo-deny` 许可证合规 | `deny.toml` 许可证白名单含 FSL-1.1-MIT + 常见宽松许可证；audit job `continue-on-error` | 实际跑 CI 后核对每个 advisories 与 license 报告，增删 allow / ban 名单 |
| R03 | PR CI 总耗时优化 | clippy+test+lint+build 单机串行 | 首次落地以正确性优先；实测若 >8min 引入 `Swatinem/rust-cache`（已加）+ 并行矩阵 / 拆 job |
| R04 | `dev.sh check` 一键质量门禁 | 尚未实现 | 视开发者反馈，按计划附录 A 实现 `check_quality()` 子命令 |
| R05 | dead-code 清零 | 15 处 `#[allow(dead_code)]`，清单见 `dead-code-triage.md` | 逐条删除/接线后移除 allow |

## 远程 CI 验证

本计划所有改动已在本地逐项验证绿（cargo check/test/clippy/fmt + 前端 lint/test/build + hook + check-doc-index）。
首次推送触发远程 CI 须由仓库维护者确认（外部可见操作），见 `AGENTS.md` 安全约束。