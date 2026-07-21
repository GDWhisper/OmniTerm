# OmniTerm 性能优化方案

> ⚠️ **本方案仅为快照分析，不构成精确测量。禁止刻舟求剑。**
>
> - **分析时间**：2026-06-28（基于当日进程实测）
> - **测量样本**：单 session 静置状态（无活跃 PTY、无 WebSocket 客户端、无文件编辑、无 SSE 文件监听）
> - **测量方法**：`/proc/[pid]/status` + `/proc/[pid]/cmdline` + `ss -tlnp` + 文件系统交叉验证
> - **估算精度**：内存拆解为"定性判断 + 数量级估算"，**非精确 profiling**。各子项置信度单独标注
> - **禁止刻舟求剑**：实施前**必须**重新跑基线测量。
>   - Vite 升级（8 → 9+）、React 20、CodeMirror 7 GA、`portable-pty` 0.9.x → 0.10、
>     `rust-embed` 行为变化、新功能引入新重型依赖 —— 任何一项都可能让本文假设全部失效
>   - 本文价值是"**可能值得优化**"的方向清单 + 排查起点，**不是**权威基准数字
>   - 比较基线请以"实施当天实测值"为准，不要用本文数字直接做 before/after diff

---

## 1. 现状快照（2026-06-28 实测）

| 进程 | PID | VmRSS | VmSize | VmPeak | Threads | 监听端口 |
|---|---|---|---|---|---|---|
| 后端 `omniterm` (cargo run, dev profile) | 1659205 | **30 MB** | 2.3 GB | 2.4 GB | 31 | 9075 |
| 前端 `vite` (pnpm dev) | 1659298 | **720 MB** | 14.5 GB | 14.5 GB | 55 | 9076 |
| **合计 RSS** | — | **~750 MB** | — | — | 86 | — |

**复现命令**（实施前再次跑）：

```bash
# 找到 active 进程
ss -tlnp | grep -E ":(9075|9076|9777|9778) "
BACKEND_PID=$(ss -tlnp | grep ":9075 " | grep -oP 'pid=\K[0-9]+' | head -1)
FRONTEND_PID=$(ss -tlnp | grep ":9076 " | grep -oP 'pid=\K[0-9]+' | head -1)

# 后端
grep -E "Vm(RSS|Size|Peak)|Threads" /proc/$BACKEND_PID/status
# 前端
grep -E "Vm(RSS|Size|Peak)|Threads" /proc/$FRONTEND_PID/status
```

**前置条件**：单 workspace 静置（无打开的 FileEditor、无活跃 session PTY、无 SSE 文件监听）。
否则 RSS 会有 100-300MB 的合理波动（PTY buffer、CodeMirror 初始化、HMR 模块缓存）。

---

## 2. 内存拆解（估算，含置信度）

### 2.1 后端 30 MB 拆解

| 组成 | 估算 | 置信度 | 依据 |
|---|---|---|---|
| Axum + Tokio runtime + signal driver | ~8 MB | 高 | `tokio = features = ["full"]` + axum 0.8 base |
| sqlx pool (5 连接) + SQLite handle | ~5 MB | 高 | `SqlitePoolOptions::new().max_connections(5)` |
| portable-pty master fd + tmux 子进程路由 | ~2 MB | 中 | 当前无活跃 PTY，静态占位 |
| bcrypt + jsonwebtoken + serde (lazy) | ~3 MB | 中 | 启动期加载的静态段 |
| `rust-embed` FrontendAssets 索引 | ~1 MB | 高 | `frontend/dist` 不存在时走 embed 分支（虽然没文件） |
| notify / tracing / libc / 其他 | ~5 MB | 中 | 静态段 |
| **未计入** 的 VmSize → RSS 差 | — | — | 2.3GB VSZ vs 30MB RSS 差 2.27GB，几乎全是**未映射的保留地址空间**（mmap 预留 + 线程栈 + debuginfo 符号表），不影响真实内存压力 |

> **结论**：后端 30MB RSS 在合理范围，**不是优化重点**。即使把所有 1MB 级项都砍掉也只能省 ~10MB，性价比极低。

### 2.2 前端 720 MB 拆解

| 组成 | 估算 | 置信度 | 依据 |
|---|---|---|---|
| V8 heap（含已加载的 module graph） | ~590 MB | 中 | `RssAnon 664MB - VmExe 41MB - VmLib 31MB ≈ 590MB` |
| ├─ CodeMirror 13 lang 包 + lezer parsers | **~250-350 MB** | 中-高 | FileEditor.tsx 顶部 13 个 static import（见 §3.2）|
| ├─ @tailwindcss/vite plugin（dev 模式 AST 持有）| ~50-100 MB | 中 | Tailwind 4 vite plugin 扫描全部 .ts/.tsx 构建 utility class 索引 |
| ├─ React 19 + react-dom + zustand + react-i18next | ~50-80 MB | 中 | 基线 + 重渲染优化（memo）尚未做 |
| ├─ i18next 全 locale 探测 | ~20-40 MB | 低 | `i18next-browser-languagedetector` 默认会探测 navigator 全部语言 |
| ├─ Vite dev server + HMR + esbuild + WS | ~50-80 MB | 中 | dev 模式常驻开销 |
| └─ @xterm/xterm + addons + 渲染 canvas | ~30-50 MB | 中 | xterm.js 6 静态加载 |
| @cubone/react-file-manager（**dead dep**） | **~30-60 MB** | 中 | `src/` 中**只有** `cubone-file-manager.d.ts` 占位文件，零 runtime 引用（见 §3.1）|
| `xterm@5.3.0`（**dead dep**） | **~10-20 MB** | 中 | 实际代码用 `@xterm/xterm@6`，`xterm` 5.x 冗余老包（见 §3.1）|
| @codemirror/autocomplete（**unused**） | ~5-10 MB | 中 | package.json 有，src 无 import |
| @codemirror/lint（**unused**） | ~5-10 MB | 中 | package.json 有，src 无 import |

> **结论**：前端 720MB 中**约 60-70% 是 dev 模式特有**（HMR、esbuild、tailwind plugin 持有 AST），production preview/build 后这部分会消失。前端优化核心是**删 dead deps + CodeMirror 按需加载**。

---

## 3. 优化 Tier 排序

### Tier 1：删 dead deps（预计回收 60-120 MB，零风险）

**触发条件**：任何时候，5 分钟改完

**目标依赖**：
- `@cubone/react-file-manager` —— 死代码，仅 `cubone-file-manager.d.ts` 占位
- `xterm@5.3.0` —— 实际用 `@xterm/xterm@6`
- `@codemirror/autocomplete` —— 零 import
- `@codemirror/lint` —— 零 import

**实施步骤**：
```bash
cd frontend
pnpm remove @cubone/react-file-manager xterm @codemirror/autocomplete @codemirror/lint
rm src/cubone-file-manager.d.ts
cd .. && rm -rf frontend/node_modules frontend/node_modules/.vite pnpm-lock.yaml
pnpm install
./dev.sh restart
```

**验证**：
```bash
# Tier 1 后基线
FRONTEND_PID=$(ss -tlnp | grep ":9076 " | grep -oP 'pid=\K[0-9]+' | head -1)
grep VmRSS /proc/$FRONTEND_PID/status
# 期望：VmRSS 显著下降（-60MB 至 -120MB，具体数字以实测为准）
```

**回滚**：`git revert` 即可

---

### Tier 2：CodeMirror 13 lang 包按需加载（预计回收 150-300 MB，中风险）

**触发条件**：FileEditor 实际打开过 ≥3 种不同类型文件后（证明 lang 包是真用而不是装饰）

**问题**：
- `frontend/src/components/FileManager/FileEditor.tsx` 顶部 static import 全部 13 个 lang 包
- 打开任何文件 → 全部 13 个 lang + 各自 lezer parser 都进 V8 heap
- 不打开 FileEditor → lang 包不加载（已正确）

**改法**：按文件扩展名 dynamic import

```ts
// Before (FileEditor.tsx):
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
// ... 11 more static imports

// After:
const langLoaders: Record<string, () => Promise<any>> = {
  js: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  rs: () => import('@codemirror/lang-rust').then(m => m.rust()),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
  go: () => import('@codemirror/lang-go').then(m => m.go()),
  java: () => import('@codemirror/lang-java').then(m => m.java()),
  cpp: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  c: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  php: () => import('@codemirror/lang-php').then(m => m.php()),
}
```

**已知影响**：
- 打开非预览过的文件类型时首屏延迟 +30-100ms（动态 import + esbuild 懒编译）
- `vite.config.ts` 需把 CodeMirror lang 全部加进 `optimizeDeps.exclude`（避免预构建抵消动态加载收益）

**验证**：
```bash
# 1. 启动后空载
grep VmRSS /proc/$FRONTEND_PID/status
# 期望：-30-50MB vs Tier 1 后（无 FileEditor 打开时 lang 包不加载）

# 2. 打开 rust 文件 → 关闭 → 等待 10s → 测
# 期望：+50-80MB（只有 lang-rust + lezer-rust 加载）
# 3. 再打开 python 文件 → 关闭 → 等待 10s → 测
# 期望：+50-80MB（lang-python + lezer-python 累加）
# 4. 关闭 FileEditor → 等 5min → 测
# 期望：内存不下降（CodeMirror 不主动卸载）—— 这是已知 trade-off
```

**回滚**：`git revert` 即可，FileEditor 退回 static import 模式

---

### Tier 3：i18n / tailwind / release build 优化（预计回收 30-80 MB，中风险）

**触发条件**：Tier 1-2 已落地且项目进入稳定期（功能完成度 ≥80%）

| 优化项 | 预期收益 | 风险 | 备注 |
|---|---|---|---|
| i18next 按需 locale | 20-40 MB | 低 | 把 `i18next-browser-languagedetector` 探测结果限制为单 locale，或直接移除 detector 用 `i18n.changeLanguage()` |
| Tailwind 4 vite plugin `content` 排除 | 30-50 MB | 中 | 排除 `node_modules`、测试文件、未用 entry；需扫描确认全部用到的 class 都被保留 |
| dev profile → release build（`cargo run --release`）| 15-20 MB 后端 | 低 | 启动慢 2-5x（编译优化），日常开发不推荐，但部署时收益明显 |

---

### Tier 4：架构级优化（高风险，不建议现在规划）

| 方案 | 预期收益 | 风险 | 触发条件 |
|---|---|---|---|
| CodeMirror → Monaco Editor | idle 内存可能更低、bundle 体积大 | 高：worker 复杂、首次打开慢、TS 类型支持弱 | 项目需要支持 50+ 语言 + 复杂 LSP 集成 |
| 拆 Vite micro-frontend（FileEditor 独立 build）| dev 内存 -30% | 高：状态同步、路由、CSS 隔离 | 项目进入企业级、多团队维护 |
| 日常用 `pnpm preview` 替代 `pnpm dev` | 内存 -50% | 高：失去 HMR，开发体验大幅下降 | 仅做性能回归测试或 demo 时使用 |

---

## 4. 实施前必须重新做的事

**无论实施哪个 Tier，**开始前先跑这套 checklist：

### 4.1 重新测量基线

```bash
# 1. 确认应用静置
#    - 无打开的 FileEditor
#    - 无活跃 session PTY（除默认 workspace 之外）
#    - 无 SSE 文件监听
# 2. 等 30s 让 Vite HMR / esbuild 完成所有预热

# 3. 测量
BACKEND_PID=$(ss -tlnp | grep ":9075 " | grep -oP 'pid=\K[0-9]+' | head -1)
FRONTEND_PID=$(ss -tlnp | grep ":9076 " | grep -oP 'pid=\K[0-9]+' | head -1)
grep -E "Vm(RSS|Size|Peak)|Threads" /proc/$BACKEND_PID/status /proc/$FRONTEND_PID/status
```

把结果记到 commit message 或 PR description 里。**这是本方案 §1 数字的真正权威值**。

### 4.2 检查环境变化

```bash
# 1. 是否有新增/删除 dep
cd frontend && pnpm outdated
cat package.json | jq '.dependencies, .devDependencies'

# 2. vite / node 版本
node --version
pnpm vite --version

# 3. 后端 cargo 依赖
cd .. && cargo tree --depth 1
```

如果以下任一变化，本方案的估算很可能失效：
- vite 升大版本（8 → 9+）
- React 升 20
- CodeMirror 升 7
- @tailwindcss/vite 大版本变化
- portable-pty 升 0.10+
- rust-embed 行为变化（默认 8.x → 9.x）

### 4.3 重新读 FileEditor.tsx

```bash
# 检查 CodeMirror 静态 import 列表
grep "^import.*@codemirror" frontend/src/components/FileManager/FileEditor.tsx
```

如果 import 列表跟 §3.2 不一致（数量更多/更少/不同包），按实际情况调整 Tier 2 方案。

---

## 5. 验证清单（每个 Tier 独立）

### Tier 1 验证

| 步骤 | 命令 | 期望 |
|---|---|---|
| 实施前基线 | `grep VmRSS /proc/$FRONTEND_PID/status` | 记录数字 A |
| pnpm remove + 重启 | `./dev.sh restart` | 服务恢复 |
| 实施后基线 | `grep VmRSS /proc/$FRONTEND_PID/status` | 数字 B（B < A，差值 = 释放内存）|
| 回归测试 | 打开主页、Sidebar、Settings、FileManager 列表页 | 全部功能正常，无 console error |

### Tier 2 验证

| 步骤 | 命令 | 期望 |
|---|---|---|
| 实施前基线（无 FileEditor 打开） | `grep VmRSS /proc/$FRONTEND_PID/status` | 记录数字 C |
| 打开 .rs 文件 → 关闭 → 等 10s | 同上 | 数字 D（D - C ≈ lang-rust 单独内存）|
| 打开 .py 文件 → 关闭 → 等 10s | 同上 | 数字 E（E - D ≈ lang-python 单独内存）|
| 打开 5 种不同类型 → 关闭 → 等 10s | 同上 | 数字 F（F ≈ 总 lang 内存）|
| 回归测试 | 5 种文件类型逐一打开 + 编辑 + 关闭 | 全部语法高亮正常，无 console error，无首屏卡顿 > 200ms |

### Tier 3+ 验证

参照 §3 表格中每项的"验证"列。

---

## 6. 不优化清单（明确不动的部分）

| 组件 | 原因 |
|---|---|
| portable-pty 进程模型 | 终端核心能力，每个 WS 连接独立 PTY 是设计正确性，idle 状态内存占用已经极低 |
| axum 路由结构 | 当前路由 < 10 个，拆 micro-service 收益为负 |
| SQLite + sqlx (5 连接) | 单机使用 5 连接完全够用，调小会限制并发 |
| `rust-embed` 嵌入 frontend/dist | 让单 binary 自包含发布，编译期一次成本、运行时近乎零开销 |
| WS 二进制帧协议 | 已优化为 raw fd write（`src/ws/terminal.rs`），不要再加 buffer 抽象层 |
| `Cargo.toml` 的 `clap` / `libc` | 都是 dev tools 必需的；`time` 0.3 看是否真用再决定（`grep -r 'use time' src/`） |

---

## 7. 重新审视本文的触发条件

满足任一条件时，应重新跑 §4 checklist 并更新本文档：

- [ ] Vite 升 9.x 或更高
- [ ] React 20 发布且项目升级
- [ ] CodeMirror 7 GA 且项目升级
- [ ] 任意新功能引入新的重型依赖（> 1MB npm 体积）
- [ ] 用户反馈明显的卡顿 / 内存问题
- [ ] 本文创建后 6 个月内未实施 Tier 1-2 → 重新评估是否还有价值
- [ ] OmniTerm 进入企业级使用（≥10 并发用户）→ Tier 3-4 优先级提升
- [ ] 实施当天实测基线与本文 §1 偏差 > 30% → 说明假设失效，需重写

---

## 8. 元信息

- **创建日期**：2026-06-28
- **创建原因**：调查 vite 资源占用时顺带分析
- **关联 commit**：`7d530a2 fix(dev.sh): start 防御性清理 vite/cargo 孤儿进程`（即本文诞生的契机）
- **下次审视**：项目功能完成度 ≥80% 时（或触发 §7 任意条件时）
- **本文件 release 状态**：因位于 `docs/dev/plans/` 被 release 排除规则自动过滤，不入 release branch
