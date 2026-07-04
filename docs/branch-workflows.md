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
- 详见 `docs/release-guide.md`

#### 日常更新推送（非发布）

不做完整发布时，将开发分支的局部改动同步到公共仓库以保持项目活跃：

1. **切到 release** → `git checkout release`
2. **cherry-pick 目标 commit** → `git cherry-pick <hash>`
3. **推送到公开仓库** → `git push public release:main`
4. **切回开发分支** → `git checkout main` / `dev`

> **规则**：只 cherry-pick main/dev 已有的 commit，切勿在 release 上直接做修改。
> 目的是让公共仓库的 main 有可见更新，不触发 CI 发布。
> 无需执行 `sync-release.sh`、打 tag 等完整发布步骤。
>
> **放心，日常推送的提交不会丢**：
>
> - 日常推送 `git push public release:main` 会把 cherry-pick commit
>   永久写入 GitHub 的 `main` 分支历史。
> - 正式发布时 `sync-release.sh` 基于 `public/main`（含这些 commit）
>   重建 release，新版本 commit 以它们为 parent——日常提交成为历史一环。
> - **会丢的只是本地 release 指针**（被 `checkout -fB` 覆盖），
>   而本地 release 是 disposable 的工作分支，丢了无妨。
>
> **⚠️ 唯一禁忌**：日常推送后，正式发布前，**禁止** force push
> 覆盖远程历史（`git push public release:main -f`）。

---

## 多 Agent 协作安全守则

- **撤销已推送提交**：必须用 `git revert`，严禁 `git reset --hard` 或 `--force`
- **禁止**从 debug/dev 直接 `git push origin debug:dev` 覆盖其他分支
- **冲突处理**：发生在哪个工作树，就在哪个工作树解决
