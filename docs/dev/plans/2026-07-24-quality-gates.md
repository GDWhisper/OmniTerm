# 项目质量门禁建设计划

> 状态：已勘误，实施中
> 触发条件：2026-07-24 全面审计项目质量门禁现状，发现 pre-commit hook 已失效、无 PR CI、无 Rust lint/format 检查、无依赖审计
>
> **勘误（2026-07-24 实施）：** 计划设计稿与项目实际工程存在 4 处偏差，已就地修正：
> 1. **分支模型**：项目为 `dev/main/preview/debug` 单人本地 merge 模型（见 `docs/workflows/branch-workflows.md`），无 `feature/**`/`fix/**` 分支、无 PR 流程、§6 已排除 branch protection。CI 门禁点 = **push**（非 PR）。push 触发分支改为 `[dev, main, preview, debug]`，保留 `pull_request` 仅作防御性触发。
> 2. **Phase 1 首次绿灯**：实测现有代码 ~44 个 clippy 警告且未格式化，附录B rus在 Phase 1 即启用 `clippy -- -D warnings` + `fmt --check` 但清理在 Phase 2.2/2.3 → 首次推送必红。已将 clippy/fmt 门禁延至 Phase 2 完成清理后再入 CI，Phase 1 rust CI 仅 `cargo check` + `cargo test`。
> 3. **Phase 2 顺序**：T03 在 2.3 清理之前往 pre-commit 加 `clippy -- -D warnings` 会阻塞所有 commit。已重排为：rustfmt(2.2) → clippy 清理(2.3) → 升级 pre-commit(2.1) → CI 加 fmt/clippy(2.4)。
> 4. **附录B audit job** 与 §3.1 不一致（缺 pnpm audit），已补齐。
> 关联：`AGENTS.md` 工程准则第 5 条「验证闭环」、`docs/dev/plans/2026-07-20-acp-quality-gap.md`（测试缺口填补）

---

## 1. 背景

### 1.1 审计结果摘要

2026-07-24 对项目全量质量门禁进行审计，发现以下核心问题：

| 门禁 | 现状 | 严重度 |
|------|------|--------|
| PR/推送 CI | **不存在**。`.github/workflows/` 仅 `release.yml`（tag 触发，且不做质量检查） | 🔴 致命 |
| pre-commit hook | **已失效**。`core.hooksPath` 指向不存在的 `.githooks`，实际 hook 在 `scripts/hooks/pre-commit` 但从未执行 | 🔴 致命 |
| Rust clippy | `Cargo.toml` 无 `[lints]` 段，无 `clippy.toml`，pre-commit 只跑 `cargo check` 不跑 `cargo clippy` | 🔴 高 |
| Rust 格式化 | 无 `rustfmt.toml`，无自动格式检查 | 🟡 中 |
| 依赖审计 | 无 `cargo-deny` 或 `npm audit` 集成 | 🟡 中 |
| TypeScript 严格模式 | `tsconfig` 未启用 `strict: true`（但启用了 `noUnusedLocals` 等单项检查） | 🟡 中 |
| ESLint | 配置完善：TS + React Hooks + 自定义规则 | ✅ 已就绪 |
| 测试基础设施 | Rust 58 个测试（7 文件）、前端 12 个测试文件，`pnpm test` / `cargo test` 可手动执行 | ✅ 已就绪 |

### 1.2 风险分析

当前最致命的问题是：**合并前零自动化检查**。任意分支的任意代码可无阻力进入 dev/main，lint 错误、编译警告、测试回归均不会被自动发现。同时 pre-commit hook 形同虚设——开发者即使提交了 lint 错误代码也毫无感知。

### 1.3 根因

项目早期以功能验证为优先，质量基础设施投入集中在测试编写而非自动化执行。pre-commit hook 的 `.githooks` 目录可能在不同 worktree 间配置不同步导致丢失。CI 只覆盖了发布流程，日常开发流程未纳入。

---

## 2. 范围与优先级

### 2.1 P0 — 本轮必须完成（阻断性修复，预计 4h）

| 序号 | 目标 | 方案 | 预估 |
|------|------|------|------|
| T01 | 修复 pre-commit hook，使其实际生效 | `git config core.hooksPath scripts/hooks`（每个 worktree 执行一次）；在 `dev.sh start` 中自动设置 | 1h |
| T02 | 新建 CI workflow（PR + push 触发） | 新建 `.github/workflows/ci.yml`，包含：`cargo check` + `cargo clippy` + `cargo test` + `pnpm lint` + `pnpm test` + `pnpm build`（验证前端可构建） | 3h |

**小计：4h**

### 2.2 P1 — 本迭代完成（加固性改进，预计 6h）

| 序号 | 目标 | 方案 | 预估 |
|------|------|------|------|
| T03 | 升级 pre-commit hook 检查范围 | 在 `scripts/hooks/pre-commit` 中加入 `cargo fmt --check`、`cargo clippy -- -D warnings`、`pnpm test --run`（仅前端，Rust test 耗时偏大放 CI） | 1h |
| T04 | 配置 `rustfmt.toml` | 以当前代码风格为基线生成标准配置，后续 CI + pre-commit 统一执行 | 0.5h |
| T05 | 配置 `Cargo.toml [lints.clippy]` | 渐进策略：第一轮仅启用 `warn` 级别（`correctness` + `suspicious` + `complexity` 组），待现有代码清理后再升 `deny` | 1h |
| T06 | CI 中加入依赖审计 | `cargo-deny check`（license + advisories）+ `pnpm audit`（仅检查 critical/high） | 1.5h |
| T07 | TypeScript `strict: true` 评估与分步启用 | 先在 CI 中单独跑 `tsc --strict --noEmit` 获取错误清单，评估修复量后决定一步到位还是逐规则打开 | 1h |
| T08 | CI 加入 `cargo fmt --check` | 对齐 T03 的格式化要求 | 0.5h |
| T09 | CI 加入 `scripts/check-doc-index.sh` | 文档索引完整性也纳入自动化 | 0.5h |

**小计：6h**

### 2.3 P2 — 技术债跟踪（不设硬截止，渐进推进）

| 序号 | 项目 | 现状 | 触发条件 |
|------|------|------|---------|
| R01 | clippy warn → deny 升级 | 首次配置为 `warn`，历史代码可能触发大量警告 | 待 warn 级别全部清零后（或各模块 owner 自行清理），按模块逐步升 deny |
| R02 | `cargo-deny` 许可证合规 | `FSL-1.1-MIT` 是较少见的双许可证组合，需确认 `cargo-deny` 配置的许可证白名单与项目实际一致 | T06 时一并处理 |
| R03 | PR CI 总耗时优化 | 加入 clippy + test + lint 后 CI 可能延长至 5-8min | 首次落地以正确性优先，后续观察实际耗时决定是否引入缓存/并行 |
| R04 | `dev.sh` 集成质量检查 | 考虑增加 `./dev.sh check` 子命令（一键跑全部质量门禁） | 视开发者反馈决定 |

---

## 3. 技术决策

### 3.1 CI workflow 设计

```
.github/workflows/ci.yml

触发条件：
  push: [dev, main, preview, debug]     # 项目实际分支（无 feature/fix 分支）
  pull_request: [dev, main]              # 防御性保留；项目为单人本地 merge，PR 非主要门禁

矩阵：
  - Rust 侧（ubuntu-latest）：
      cargo check --workspace
      cargo clippy --workspace -- -D warnings
      cargo fmt --check
      cargo test --workspace
  - 前端侧（ubuntu-latest）：
      pnpm install --no-frozen-lockfile
      pnpm lint
      pnpm test --run
      pnpm build
  - 审计（ubuntu-latest，允许失败）：
      cargo-deny check
      pnpm audit --audit-level=high
      scripts/check-doc-index.sh
```

关键决策：
- **门禁点 = push**：项目为单人本地 merge 模型（无 PR 流程、§6 排除 branch protection），实际阻拦靠 push CI；`pull_request` 触发仅防御性保留
- **分阶段门禁**：Phase 1 仅 `cargo check` + `cargo test` + 前端 lint/test/build（保证首次绿灯）；`cargo fmt --check` 与 `clippy -- -D warnings` 在 Phase 2 完成 rustfmt 统一(2.2)与 clippy 清理(2.3)后并入 CI
- **cargo fmt 和 clippy 都在 CI 跑**：pre-commit 是最后防线，CI 是公共真相源
- **`cargo test` 只在 CI 跑，不进 pre-commit**：Rust 测试编译耗时，pre-commit 应保持在 <5s
- **审计 job 标记 `continue-on-error: true`**：不阻塞合并，但保持可见性

### 3.2 pre-commit hook 设计

```bash
scripts/hooks/pre-commit（升级后）

对暂存文件：
1. 前端 .ts/.tsx → pnpm lint（已有）
2. Rust .rs → cargo fmt --check（增量，仅检查不自动格式化）
3. Rust .rs → cargo clippy（仅对 workspace 做全量 check，因为单文件 clippy 不可行）
4. 前端 .ts/.tsx → pnpm test --run（仅前端测试，快速反馈）
5. Rust .rs → cargo check（已有，保留）
```

不需要进 pre-commit 的：
- `cargo test`（编译慢，放 CI）
- `cargo-deny`（网络依赖，放 CI）
- `pnpm build`（前端构建，放 CI）

### 3.3 Clippy 配置策略

```toml
# Cargo.toml 新增段
[lints.clippy]
# P0：正确性相关，不可降级
correctness = "warn"       # 先 warn，清零后改 deny
suspicious = "warn"
# P1：代码质量
complexity = "warn"
perf = "warn"
style = "warn"
# P2：pedantic 过于严格，暂不启用
# pedantic = "warn"
# 明确允许的规则（与项目惯用法一致）
# （根据 clippy 首次运行结果补充）
```

升级路径：
1. 首次运行 clippy → 收集所有 warning → 分类（可自动修复 / 需人工判断 / 误报）
2. 可自动修复的：`cargo clippy --fix --workspace`
3. 需人工判断的：逐文件修复，记录到本计划
4. 误报的：加入 `[lints.clippy]` 的 `allow` 列表
5. 全部清零后：`correctness` + `suspicious` 升级为 `deny`

### 3.4 `rustfmt.toml` 基线

以当前仓库代码风格为依据，不做风格变更，仅固化现状：

```toml
# 以当前仓库主流风格为基线（不做风格争议性修改）
edition = "2024"
max_width = 100
use_small_heuristics = "Max"
```

首次执行 `cargo fmt --check` 后如有差异，优先用 `cargo fmt` 自动统一，不做手动干预。

---

## 4. 实施计划

### Phase 1 — 阻断性修复（T01 + T02，预计 4h）

| 步骤 | 任务 | 产出 |
|------|------|------|
| 1.1 | 修复 `core.hooksPath`，在 `dev.sh start` 中自动设置为 `scripts/hooks` | pre-commit hook 恢复生效 |
| 1.2 | 手动执行一次 pre-commit 钩子，确认无遗留格式/lint 问题 | 现有代码通过 hook |
| 1.3 | 新建 `.github/workflows/ci.yml`（初版：rust CI 仪 `cargo check` + `cargo test`；前端 lint/test/build；push 触发分支 `[dev, main, preview, debug]`） | CI workflow 文件 |
| 1.4 | 本地验证门禁全绿灯（推送触发远程 CI 需用户确认推送） | 本地 cargo check/test + 前端 lint/test/build 全绿 |

### Phase 2 — 加固性改进（T03-T09，预计 6h）

| 步骤 | 任务 | 产出 |
|------|------------|
| 2.1 | T04: 新建 `rustfmt.toml` 并 `cargo fmt` 统一现有代码 | `rustfmt.toml` + 格式化 commit |
| 2.2 | T05: `Cargo.toml` 增加 `[lints.clippy]`，运行首次 clippy 并修复至零 warning | `Cargo.toml` lint 段 + clippy 修复 commit(s) |
| 2.3 | T03: 升级 pre-commit（加 `cargo fmt --check` + `cargo clippy -- -D warnings` + 前端 `pnpm test --run`）——**依赖 2.1/2.2 先清理**，否则会阻塞所有 commit | 升级后的 `scripts/hooks/pre-commit` |
| 2.4 | T08: CI 加入 `cargo fmt --check` 与 `cargo clippy -- -D warnings`（依赖 2.1/2.2） | CI workflow 更新 |
| 2.5 | T06: CI 加入 `cargo-deny` + `pnpm audit` | CI workflow 更新 |
| 2.6 | T09: CI 加入 `check-doc-index.sh` | CI workflow 更新 |
| 2.7 | T07: CI 加入 `tsc --strict` 试跑（不阻塞），评估错误量 | tsc strict 错误清单 |

### Phase 3 — 验证与收尾

| 步骤 | 任务 | 产出 |
|------|------|------|
| 3.1 | 完整 CI 通过一次 | 全部绿灯 |
| 3.2 | 更新 `AGENTS.md` 文档索引（新增 CI workflow 相关条目） | 文档更新 |
| 3.3 | 本计划的 P2 条目记录到 `docs/dev/plans/backlog/` | backlog 条目 |

---

## 5. 验收标准

1. `git config core.hooksPath` 输出 `scripts/hooks`（每个 worktree）
2. pre-commit hook 在提交包含 lint/fmt 错误的文件时**拒绝提交**并给出可读的错误信息
3. `.github/workflows/ci.yml` 在 push 到 `dev/main/preview/debug` 时自动触发，所有 job 通过（/本地验证全绿）
4. `cargo clippy --workspace` 零 warning（或记录至 backlog 逐模块清理）
5. `cargo fmt --check --workspace` 通过
6. `pnpm lint` + `pnpm test --run` + `pnpm build` 在 CI 通过
7. `tsc --strict` 错误清单已记录，修复计划已制定（不要求本次全部清零）

---

## 6. 不纳入范围

- **Branch protection rules**（GitHub repo settings）：需仓库管理员在 GitHub UI 配置，本计划仅提供 CI workflow，不操作 repo 设置
- **代码覆盖率阈值**（tarpaulin / codecov）：让 `docs/dev/plans/2026-07-20-acp-quality-gap.md` 先落地测试补充，覆盖率工具延后
- **端到端测试**：成本过高，留给手工测试（`docs/reference/user-testing.md`）
- **rust-toolchain.toml 版本锁定**：当前未锁定工具链版本是一个独立决策，不混入本计划
- **Docker 构建验证**（`Dockerfile` multi-stage build 在 CI 验证）：低优先级，`Dockerfile.release` 已在 release CI 覆盖

---

## 附录 A：`dev.sh` 质量检查子命令方案（R04 参考）

```bash
# 未来可能的 ./dev.sh check 子命令
check_quality() {
  echo "=== Rust: cargo check ===" && cargo check --workspace --quiet
  echo "=== Rust: cargo clippy ===" && cargo clippy --workspace -- -D warnings
  echo "=== Rust: cargo fmt ===" && cargo fmt --check --workspace
  echo "=== Rust: cargo test ===" && cargo test --workspace
  echo "=== Frontend: pnpm lint ===" && (cd frontend && pnpm lint)
  echo "=== Frontend: pnpm test ===" && (cd frontend && pnpm test --run)
  echo "=== Frontend: pnpm build ===" && (cd frontend && pnpm build)
  echo "=== Docs: check-doc-index.sh ===" && ./scripts/check-doc-index.sh
  echo "✅ 全部质量检查通过"
}
```

## 附录 B：CI workflow 骨架

```yaml
# .github/workflows/ci.yml（骨架，实施时按实际结构调整）

name: CI

on:
  push:
    branches: [dev, main, preview, debug]   # 项目实际分支模型
  pull_request:                              # 防御性保留（单人本地 merge，PR 非主门禁）
    branches: [dev, main]

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
      # Phase 1 基线（首次绿灯）
      - run: cargo check --workspace
      - run: cargo test --workspace
      # Phase 2 闸门（完成 rustfmt 统一 + clippy 清理后启用，见步骤 2.4）
      # - run: cargo fmt --check --workspace
      # - run: cargo clippy --workspace -- -D warnings

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm install --no-frozen-lockfile
        working-directory: frontend
      - run: pnpm lint
        working-directory: frontend
      - run: pnpm test --run
        working-directory: frontend
      - run: pnpm build
        working-directory: frontend

  audit:
    runs-on: ubuntu-latest
    continue-on-error: true  # 审计不阻塞合并
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: taiki-e/install-action@cargo-deny
      - run: cargo deny check
      # 前端依赖审计（对齐 §3.1）
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm install --no-frozen-lockfile
        working-directory: frontend
      - run: pnpm audit --audit-level=high
        working-directory: frontend
      - run: ./scripts/check-doc-index.sh
```
