# OmniTerm 正式发布计划 v0.1.0

> 操作分支：`release`（在 `~/coding/OmniTerm` main worktree 中操作）
> 发布日期：待定

---

## 前置操作：Release 分支重建

当前 `release` 分支基于极早期代码，落后 `main` 大量提交。需要从 `main` 重新构建并排除开发文件。

```bash
cd ~/coding/OmniTerm          # main worktree
git checkout release
git merge main --no-commit

# 排除开发文件（按 AGENTS.md 规则）
git reset HEAD \
  CLAUDE.md AGENTS.md \
  .pi/ .qoder/ .codegraph/ \
  openspec/ docs/superpowers/ \
  docs/proposal-* docs/requirements.md docs/debug-log.md \
  docs/user-testing.md docs/ui-style-guide.md \
  docs/2026-* \
  .dev/ omniterm.db.bak \
  dev.sh PROGRESS.md CHANGELOG.md

git checkout -- [上述所有文件]
git commit -m "release: v0.1.0 base (rebased from main)"
```

---

## Phase 1: 代码改造

### 1.1 默认端口 → 9077

| 文件 | 改动 |
|------|------|
| `src/main.rs` | `BIND_ADDR` fallback: `127.0.0.1:9077`（原 `127.0.0.1:9777`） |
| `Dockerfile` | `ENV BIND_ADDR=0.0.0.0:9077`，`EXPOSE 9077` |
| `docker-compose.yml` | `ports: "9077:9077"`，`BIND_ADDR=0.0.0.0:9077` |

### 1.2 CLI 参数（引入 clap）

```rust
// Cargo.toml
clap = { version = "4", features = ["derive", "env"] }

// main.rs — 期望效果
omniterm                          // 默认 :9077
omniterm -p 8080                  // 指定端口
omniterm --port 8080
omniterm --version | -V           // omniterm 0.1.0
omniterm --db /path/to/omniterm.db
omniterm --jwt-secret my-secret
```

优先级：CLI args > 环境变量（`OMNITERM_PORT`、`OMNITERM_DB` 等）> 代码 fallback 9077。

`--version` 由 clap 自动生成，从 `Cargo.toml` 读取版本号。

### 1.3 前端静态文件嵌入

**问题**：`cargo install` 用户没有 `frontend/dist/` 目录。

**方案**：`build.rs` + `rust-embed`

```rust
// build.rs — 编译期嵌入 frontend/dist/
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct FrontendAssets;
```

```rust
// main.rs — 服务逻辑
// 1. 优先读 FRONTEND_DIR 环境变量（开发模式）
// 2. 否则使用嵌入的 FrontendAssets
// 3. SPA fallback (index.html) 也从嵌入中服务
```

- 开发模式：`FRONTEND_DIR=frontend/dist` 依然有效
- 发布模式：binary 自包含，零外部依赖

**注意**：`rust-embed` 或 `include_dir` 二选一。`rust-embed` 用 impl trait，`include_dir` 用宏。前者更灵活。

### 1.4 SQLite migrations 嵌入

**问题**：`sqlx::migrate!("./migrations")` 宏在 `cargo install` 环境找不到源码目录。

**方案**：编译期嵌入 migrations 目录 + 运行时从嵌入数据执行。

```rust
// build.rs 中将 migrations/ 目录内容写入常量
// 或者用 include_dir! 嵌入
use include_dir::{include_dir, Dir};

static MIGRATIONS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/migrations");
```

运行时：
```rust
// 如果是 cargo install 模式（无源码目录）
// sqlx::Migrator::new() 不支持 Dir，改用 sqlx::query 手动确保迁移
// 或者：将嵌入的 SQL 文件写入临时目录再运行 migrate
```

**替代方案**：运行时不依赖 `migrations/` 目录，改用 database version table + inline SQL 迁移。更简单但改写量大。

**推荐**：写入临时目录方案 —— 首次启动将 embed migrations 写到 `$TMP/omniterm-migrations/`，然后 `sqlx::migrate` 指向该目录。简单可靠。

### 1.5 edition 检查

当前 `Cargo.toml`：`edition = "2024"`

- 验证是否依赖 nightly Rust
- 如果是：降级到 `edition = "2021"`
- 如果 2024 已稳定（Rust 1.85+）：保留

### 1.6 版本号统一

| 文件 | 旧值 | 新值 |
|------|------|------|
| `Cargo.toml` | `version = "0.0.1"` | `version = "0.1.0"` |
| `frontend/src/version.ts` | `APP_VERSION = "0.0.1"` | `APP_VERSION = "0.1.0"` |

---

## Phase 2: 分发渠道

### 2.1 npm 包

**架构**：npm 包不含 binary，仅含 JS shim + postinstall 下载脚本。

```
npm-package/
├── package.json          # name: "omniterm", bin: { omniterm: "shim.js" }
├── shim.js               # child_process.spawn 运行 native binary
└── install.js            # postinstall 下载对应平台 binary
```

**package.json 关键字段**：

```json
{
  "name": "omniterm",
  "version": "0.1.0",
  "bin": { "omniterm": "shim.js" },
  "scripts": { "postinstall": "node install.js" },
  "files": ["shim.js", "install.js"]
}
```

**install.js 行为**：

1. 检测平台：`process.platform` + `process.arch` → 匹配 binary 文件名
   - `linux-x64` → `omniterm-linux-x86_64`
   - `linux-arm64` → `omniterm-linux-aarch64`
   - `darwin-x64` → `omniterm-macos-x86_64`
   - `darwin-arm64` → `omniterm-macos-aarch64`
2. 从 GitHub Releases 下载：`https://github.com/pax/OmniTerm/releases/download/v{version}/{filename}`
3. 放到 `node_modules/omniterm/` 目录，`chmod +x`
4. `shim.js` 负责定位并 spawn 该 binary

**大小**：npm 包 < 50KB。用户 `npm install -g omniterm` 后自动下载 10-20MB native binary。

**更新**：`npm update -g omniterm` 重新触发 postinstall 下载新版本 binary。

### 2.2 Shell 安装脚本

**`install.sh`**，放在 repo 根目录，随 release tag 发布。

```bash
curl -fsSL https://raw.githubusercontent.com/pax/OmniTerm/release/install.sh | bash
```

**行为**：

1. 检测 OS（Linux/macOS）和架构（x86_64/aarch64）
2. 查询 GitHub API：`https://api.github.com/repos/pax/OmniTerm/releases/latest`
3. 下载对应 binary 到 `/usr/local/bin/omniterm`
   - 已有安装且版本相同 → 跳过
   - 已有旧版本 → 覆盖升级
4. `chmod +x /usr/local/bin/omniterm`
5. `omniterm --version` 验证安装
6. 如需 sudo 则提示

**更新**：重新运行脚本即可。

### 2.3 Docker 镜像

发布到 `ghcr.io/pax/omniterm`。

```bash
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/pax/omniterm
```

Dockerfile 调整：
- `EXPOSE 9077`
- `ENV BIND_ADDR=0.0.0.0:9077`
- 内嵌 `frontend/dist`（不需要单独的 volume）

### 2.4 crates.io（保留给 Rust 用户）

编译自带前端嵌入 + migrations 嵌入，`cargo install omniterm` 即可。

### 2.5 环境检测：tmux（所有本地安装方式）

npm（2.1）、shell 脚本（2.2）、crates.io（2.4）三种安装方式，用户本地都需要 tmux。

**原则**：安装阶段检测 → 帮用户装上 → 安装脚本不阻塞退出，留给首次启动报错兜底。

#### 检测位置

| 方式 | 检测时机 | 执行者 |
|------|----------|--------|
| npm | `install.js`（postinstall） | Node.js（`which` / `where`） |
| shell | `install.sh` | bash（`command -v tmux`） |
| crates.io | `build.rs` 或 binary 首次启动 | Rust 或 shell |

#### 处理策略（按优先级顺序）

1. **检测 `command -v tmux`** → 存在则跳过，正常完成安装
2. **不存在** → 提示用户「tmux is required, installing...」
3. **自动安装**（按平台）：
   - Linux：检测包管理器（apt/pacman/yum/apk），`sudo apt install -y tmux` 等
   - macOS：检测 `brew` → `brew install tmux`；无 brew 则提示手动装
4. **安装失败/平台不识别** → WARN 但 **不阻止安装完成**，提示用户手动安装后重新启动

#### 边界情况

- **Docker 镜像**（2.3）：无需检测，tmux 已在 Dockerfile 中 `apt-get install` 内建
- **Windows**：暂不支持，各脚本检测到 `$OSTYPE` / `process.platform` 为 Windows 时提示不支持并退出
- **用户主动选择不装**：安装脚本只给建议不拦截，留给 omniterm 首次启动报错

#### 决策说明

ponytail: 安装脚本帮装 tmux 覆盖了绝大多数用户场景（Linux/macOS 主流发行版），省去「装了 omniterm 发现跑不了」的多余步骤。brew-less macOS、apt-less Linux 等边界情况不阻塞，fallback 到提示，保持安装脚本鲁棒。

---

## Phase 3: CI/CD（GitHub Actions）

### 3.1 触发条件

```yaml
on:
  push:
    tags: ['v*']
```

### 3.2 Job 流程

```
Build Frontend
  ├── pnpm install
  ├── pnpm build
  └── upload dist/ artifact

Build Backend (matrix: linux-x64, linux-arm64, macos-x64, macos-arm64)
  ├── 下载 dist/ artifact（每个 job）
  ├── cargo build --release
  └── upload binary artifact

GitHub Release
  ├── needs: [Build Backend]
  ├── 创建 Release（tag 名）
  ├── 上传 4 个 platform binary
  └── 上传 install.sh

npm Publish
  ├── needs: [GitHub Release]
  └── npm publish

Docker Publish
  ├── needs: [Build Frontend]
  ├── docker build + push to ghcr.io
```

### 3.3 Binary 命名规范

```
omniterm-linux-x86_64
omniterm-linux-aarch64
omniterm-macos-x86_64
omniterm-macos-aarch64
```

---

## Phase 4: 文档

### 4.1 README.md

完整重写，包含：

- **一句话简介**：Web-based tmux terminal manager
- **安装方式**（4 种）：
  - `npm install -g omniterm`（推荐）
  - `curl ... | bash`
  - `cargo install omniterm`
  - `docker run ... ghcr.io/pax/omniterm`
- **快速上手**：`omniterm` → 浏览器打开 `http://localhost:9077`
- **CLI 参考**：
  ```
  -p, --port <PORT>      监听端口（默认 9077）
  --db <PATH>            数据库路径
  --jwt-secret <KEY>     JWT 签名密钥
  -V, --version          显示版本号
  ```
- **前置要求**：系统需安装 tmux
- **截图**（可选，后续补充）

### 4.2 版本号脚本

考虑新增 `scripts/bump-version.sh` 一键改版本号：

```bash
#!/bin/bash
# 用法: ./scripts/bump-version.sh 0.1.1
NEW_VER=$1
sed -i "s/version = .*/version = \"$NEW_VER\"/" Cargo.toml
sed -i "s/APP_VERSION = .*/APP_VERSION = '$NEW_VER'/" frontend/src/version.ts
```

---

## 执行顺序

```
  1. [Release] 分支重建（merge main + 排除 dev 文件）
  2. [Release] Phase 1.1 ~ 1.6（端口、clap、嵌入、版本号）
  3. [Release] Phase 3 CI 骨架（先能构建 + release binary）
  4. [Release] Phase 2.1 npm 包 + 2.2 install.sh
  5. [Release] Phase 4 README 重写
  6. [Release] 打 tag v0.1.0 → CI 触发全自动发布
```

---

## 不纳入 v0.1.0

| 项目 | 原因 |
|------|------|
| `omniterm self-update` 自更新子命令 | 首次发布用 npm/curl 覆盖即可 |
| 首次设置向导 UI | 后续版本迭代 |
| 单元测试覆盖提升 | 已有基本测试，不阻塞发布 |
| 多语言 i18n | 先英文 |
| Windows 支持 | 依赖 tmux，暂不支持 |
