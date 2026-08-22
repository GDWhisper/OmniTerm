# 质量门禁后续跟踪项

> 来源：`docs/dev/plans/2026-07-24-quality-gates.md` §2.3 P2 + §3.3
> 本轮 Phase 1+2 已落地（CI workflow / pre-commit / clippy / rustfmt / cargo-deny / strict / 文档审计）；以下为后续推进项。

| ID | 项目 | 现状 | 触发条件 |
|----|------|------|---------|
| R01 | clippy warn → deny 升级 | `[lints.clippy] correctness/suspicious/style/complexity/perf = warn`，CI/pre-commit 以 `-D warnings` 兜底 | 清理 `docs/dev/plans/backlog/dead-code-triage.md` 全部 allow 后，按组逐级升 `deny` |
| R02 | `cargo-deny` 许可证合规 | ✅ 已完成（2026-07-29）：CI 实跑核对，advisories/bans/sources 均绿；唯一 license 报错为 webpki-roots 的 `CDLA-Permissive-2.0`，已加入 allow；删除未命中的 `MPL-2.0` / `OpenSSL` 死条目；audit job 移除 `continue-on-error` 改为阻塞门禁（pnpm audit 保留 step 级不阻塞） | — |
| R03 | PR CI 总耗时优化 | clippy+test+lint+build 单机串行 | 首次落地以正确性优先；实测若 >8min 引入 `Swatinem/rust-cache`（已加）+ 并行矩阵 / 拆 job |
| R04 | `dev.sh check` 一键质量门禁 | 尚未实现 | 视开发者反馈，按计划附录 A 实现 `check_quality()` 子命令 |
| R05 | dead-code 清零 | 15 处 `#[allow(dead_code)]`，清单见 `dead-code-triage.md` | 逐条删除/接线后移除 allow |
| R06 | 前端 `vi.waitFor` 测试间歇失败（flaky） | 见下方专节 | 再次出现时抓住失败详情，或 CI 出现随机红灯 |
| R07 | ACP 后端零测试模块补测：`supervisor.rs` / `terminal.rs` / `permission.rs` | 三模块共 ~430 行仍零测试。源自已关闭的 `2026-07-20-acp-quality-gap.md` T02/T03/T04，任务描述按当前架构改写 | 下次修改对应模块时顺带补测；或 `agent-client-protocol` crate 大版本升级前集中补 |
| R08 | `AcpClient` 协议交互层测试 | client.rs 已涨至 1433 行，现有 12 个测试仅覆盖 `sh_quote`/`wrap` 子进程包装；prompt/cancel/disconnect 链路无回归保护。原计划的 FakeConnection 方案因 crate API 演进需按当前 schema 重写 | 改动 client.rs 连接/发送/取消路径时 |
| R09 | WS ACP 帧主路径集成测试 | ws/acp.rs 现有 6 个测试仅覆盖 @ 引用解析；帧编解码/replay 门控/重连去重主路径未覆盖 | 新增帧类型或修改帧协议字段时 |

## R06 详情：前端 `vi.waitFor` 测试间歇失败

**现象**（2026-08-10 观测）：一次全量 `pnpm test --run` 出现
`1 failed | 276 passed (277)`，未捕获到失败详情；随后**连续 18 次重跑全绿**，
未能复现。

**归属判断**（已排除当次改动）：当时新增的 23 条测试
（`appStore.test.ts` / `path.test.ts`）全为纯同步 state 断言，无定时器 /
`Date` / 异步，结构上不具备 flaky 条件。

**真实嫌疑**：13 个使用 `vi.waitFor`（默认超时 1000ms）的组件测试在机器
负载高时可能撞上限。风险最高的是
`frontend/src/components/FileManager/FileEditor.dynamic.test.tsx`——它等的是
CodeMirror 的动态 `import()`，冷加载耗时最不可控。

**为何未直接修**：无复现证据时改超时只是掩盖症状，无法验证修复有效。
待再次出现时先拿到具体失败用例再动。

**候选处理方向**（待证据后选择）：

1. 给等待动态 import 的用例显式放宽 `vi.waitFor` 超时（最小改动）
2. 在 test setup 里预热惰加载模块，把冷加载成本移出断言窗口
3. CI 开启 `--retry=1` 仅针对组件测试（下策：会掩盖真实竞态，不推荐）

**复现时请保留证据**：`pnpm vitest run --reporter=verbose > /tmp/vt.log 2>&1`，
失败时把完整日志附到本节。

## 远程 CI 验证

本计划所有改动已在本地逐项验证绿（cargo check/test/clippy/fmt + 前端 lint/test/build + hook + check-doc-index）。
首次推送触发远程 CI 须由仓库维护者确认（外部可见操作），见 `AGENTS.md` 安全约束。