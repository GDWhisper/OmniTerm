# Branch Workflows

## 分支模型

```
         ┌──→ main (发布，sync public)
         │
dev (开发) ──┤
         │
         └──→ preview (私人稳定分支)
```

- **dev**：开发前沿，所有代码改动先在此完成
- **preview**：私人稳定分支，全量合并 dev，作为日常工具使用
- **main**：发布分支，从 dev 合并（黑名单排除开发文档），sync 到 public 仓
- **debug**：临时紧急修复分支，不再常驻（见下方工作流）
- **release**：已废弃，由 main 替代

## 各分支工作流

### debug 分支（临时，不再常驻）

2026-09-21 起 debug 不再是常驻分支/worktree（本地与 origin 均已删除）。紧急修复**直接在 dev 上进行**；只有需要与 dev 并行隔离修复时，才临时拉出：

```bash
git worktree add ~/coding/OmniTerm-debug -b debug dev
cp branch.config.example ~/coding/OmniTerm-debug/.env.local
# 编辑 .env.local：端口 19777/19778、BRANCH_BINARY_NAME=omniterm-debug、DOMAIN=term-debug.tokitoken.com
```

修复要求不变：原子化提交（核心修复 `fix:`、本地定制 `chore:` 分开）、只修不加功能、独立验证。完成后合入 dev 并删除 worktree 与分支（`git worktree remove` + `git branch -d`），**远端不留 debug**。

### dev 分支（开发前沿）

- **作用**：日常功能开发 + bug 修复的主战场，所有代码改动先在此完成
- **合入来源**：无（紧急修复直接在本分支进行，不再经 debug 中转）
- **合出目标**：
  - 功能稳定后合并到 `preview`（你的日常工具）
  - 发布时同步到 `main`（通过 sync-main.sh 脚本）

### preview 分支（私人稳定分支）

- **作用**：你的日常开发工具，稳定版
- **合并 dev**：当你觉得 dev 上的功能稳定后，全量合并 dev
- **不参与发布**：preview 是私人分支，不 sync 到 public

### main 分支（发布分支）

- **作用**：干净的发布代码，sync 到 public 仓
- **同步方式**：**必须使用** `./scripts/sync-main.sh` 脚本
- **禁止**：直接 `git merge dev`（会带入黑名单文件）
- **黑名单**：docs/、openspec/、.superpowers/、.pi/、.qoder/、AGENTS.md、CLAUDE.md、PROGRESS.md

**同步 vs 发布（两个独立操作）**：

| 操作 | 命令 | 说明 |
|------|------|------|
| 同步 main | `./scripts/sync-main.sh` | 把 dev 最新代码更新到 main（日常操作，不打 tag） |
| 发布新版本 | `./scripts/sync-main.sh` + `git tag` + `git push public` | 同步 + 打 tag + 推送到公开仓（正式发布） |

## 分支身份约定

每个 worktree 通过以下几项标识自己，**互不冲突**：

| 分支 | 端口（dev.sh 开发端口） | 域名 | DB 隔离标识（BRANCH_BINARY_NAME） | Docker 部署端口 | 含义 |
|------|----------------------|------|---------|---------------|------|
| `dev` | 9777 / 9778 | `term-dev.tokitoken.com` | `omniterm-dev` | 9777 | 日常开发 |
| `preview` | 9075 / 9076 | `term-preview.tokitoken.com` | `omniterm-preview` | 9075 | 私人稳定分支 |
| `debug`（临时） | 19777 / 19778 | `term-debug.tokitoken.com` | `omniterm-debug` | — | 临时分支，重建时参考此行 |
| `main` | — | — | `omniterm` | — | 发布分支（非 worktree） |

**核心规则**：
- DB 隔离标识 = `omniterm-<branch>`（仅决定 `~/.omniterm/<标识>.db` 文件名），main 例外为干净 `omniterm`
- 编译二进制名全分支统一为 `omniterm`（`Cargo.toml` name，merge 不受影响），不再按分支区分
- 端口由各 worktree 的 `.env.local` 决定（gitignored）
- 域名仅 preview 和 dev 需要（main 不暴露到公网）

## 同步规则

- **dev → preview**：全量合并，无排除
- **dev → main**：**必须使用** `./scripts/sync-main.sh`（黑名单排除开发文档）
  - 禁止直接 `git merge dev`（会带入黑名单文件）
  - 注意：同步 ≠ 发布，同步只是更新 main 代码，不打 tag 不推送
- **禁止反向同步**：main 和 preview 不回写到 dev

## 待处理项

- [ ] 创建 `scripts/public-agents.md` 公开版 AGENTS.md 模板（main 需要独立维护公开版）
