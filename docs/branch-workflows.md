# Branch Workflows

## 各分支工作流

### debug 分支

1. **拉取最新 dev**：`git merge dev`
2. **原子化提交**：核心修复 → `fix:`，本地定制 → `chore:` 单独提交
3. **只做修复，不加功能**
4. **独立验证**：启动服务测试
5. **合入 dev**：切换到 `dev` worktree 执行 `git merge debug`

### dev 分支（主开发分支，最活跃）

- **作用**：日常功能开发 + bug 修复的主战场，所有代码改动先在此完成
- **合入来源**：定期从 `debug` 合并修复
- **合出目标**：功能稳定后合并到 `main` 进入发布前哨

### main 分支（发布前哨站）

- **作用**：以用户视角体验即将发布的新版本，冻结后不再加功能
- **合并 dev 后验证**：合并 dev 最新代码后，必须主动执行 `./dev.sh restart` 确认服务启动正常
- **文档**：保留 AGENTS.md、dev.sh、docs/ 等开发文件
- **排除**：main 不含 npm/、install.sh、.github/workflows/release.yml（这些是 release 专属）

## 分支身份约定

每个 worktree 通过以下几项标识自己，**互不冲突**：

| 分支 | 端口（dev.sh 开发端口） | 域名 | 二进制名 | Docker 部署端口 | 含义 |
|------|----------------------|------|---------|---------------|------|
| `release` | — | — | `omniterm` | — | 干净的正式发布版 |
| `main` | 9075 / 9076 | `term-main.tokitoken.com` | `omniterm-main` | 9077 | 发布前哨站 |
| `dev` | 9777 / 9778 | `term-dev.tokitoken.com` | `omniterm-dev` | 9777 | 日常开发 |
| `debug` | 19777 / 19778 | `term-debug.tokitoken.com` | `omniterm-debug` | — | 紧急修复 |

**核心规则**：
- 二进制名 = `omniterm-<branch>`，release 例外为干净 `omniterm`
- 端口 = `<base>-<branch>` 后缀（dev=9777 / debug=19777 / main=9075 无后缀）
- 域名 = `term-<branch>.tokitoken.com`
- 这些身份字段在双向 merge 时**保留各自值**（即 git 看到冲突时手工选 ours）
- **端口/域名实际值由各 worktree 的 `.env.local` 决定**（gitignored），代码里硬编码的只是 fallback / Docker 部署值
- release 时把 main 的 `omniterm-main` 改回 `omniterm` 即可

### release 分支

- **作用**：干净的公开代码，剔除所有开发文件
- **发布**：tag push → CI 自动构建多平台 binary + GitHub Release + npm + Docker
- 详见 `docs/release-plan.md`

---

## 多 Agent 协作安全守则

- **撤销已推送提交**：必须用 `git revert`，严禁 `git reset --hard` 或 `--force`
- **禁止**从 debug/dev 直接 `git push origin debug:dev` 覆盖其他分支
- **冲突处理**：发生在哪个工作树，就在哪个工作树解决
