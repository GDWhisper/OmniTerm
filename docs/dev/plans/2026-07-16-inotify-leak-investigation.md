# inotify 泄漏排查方案

> 日期：2026-07-16
> 作者：Qoder
> 状态：**待启动**（Phase 4a ACP 重构完成后独立并行）
> 优先级：**高** — 影响用户长期使用（后端跑一周即可撑满系统 inotify 上限）

---

## 1. 事故背景

### 1.1 触发事件

2026-07-16 启动 `./dev.sh start` 时，前端 Vite 报错：

```
Error: ENOSPC: System limit for number of file watchers reached,
watch '/home/pax/coding/OmniTerm-dev/frontend/vite.config.ts'
```

完整日志：`.dev/frontend.log`。

### 1.2 现场诊断

`lsof | grep inotify` 统计各进程 inotify fd 占用：

| PID | 进程 | worktree | 运行时长 | inotify fd |
|-----|------|----------|----------|-----------|
| 197189 | `omniterm-dev` | `OmniTerm-preview` | **5 天 8 小时** | **1320** |
| 5216 | `qq` | — | — | 261 |
| 5460 | `qq` | — | — | 138 |
| 448493 | `omniterm-dev` | `OmniTerm-dev`（新启动） | 5 分钟 | 78 |
| 2071901 | `clash-verge` | — | — | 75 |

**关键观察**：
- 同一个 `omniterm-dev` 二进制，跑 5 天的实例 1320 fd，跑 5 分钟的新实例只有 78 fd —— **差 17 倍，且明显随时间单调增长**。
- 系统原上限 `fs.inotify.max_user_watches = 65536`，加上 qq/clash/gnome-shell 的消耗，Vite 启动时凑不够就 ENOSPC。

### 1.3 临时缓解（已做）

```bash
echo 'fs.inotify.max_user_watches = 524288' | sudo tee /etc/sysctl.d/60-inotify.conf
sudo sysctl -p /etc/sysctl.d/60-inotify.conf
```

上限调到 524288（8 倍），短期内不会再 ENOSPC。但**不治本**：泄漏持续，1-2 周后会再次撑满。

### 1.4 影响评估

| 维度 | 影响 |
|------|------|
| 用户体验 | 长时间运行后 dev 环境启动失败；生产部署同理（Docker 容器默认共享 host 的 inotify 上限） |
| 内存 | 每个 inotify watch ≈ 1 KB kernel memory；1320 watch ≈ 1.3 MB kernel 内存占用（不算大，但会持续增长） |
| 稳定性 | 泄漏到 `max_user_watches` 后，任何新 `inotify_add_watch` 调用都返 ENOSPC，包括 `tmux` / `cargo watch` / `tailwindcss` / 其他依赖文件监听的服务 |
| 关联范围 | 与 Phase 3 ACP 重构**无关** — 泄漏模块在 Phase 2 即存在 |

---

## 2. 嫌疑模块（代码侧）

按「持有 inotify fd 的概率」从高到低：

### 2.1 `src/api/files_watch.rs`（最高嫌疑）

SSE 端点，用 `notify` crate 监听目录变更。每个前端 FileManager 打开的目录都会注册一个 watch。

**嫌疑点**：
- 前端关闭 FileManager / 切换目录时，后端是否调用 `Watcher::unwatch()`？
- SSE 连接断开（客户端 tab 关闭、网络断）后，watch 是否被释放？
- 同一目录多次打开是否复用 watch？

**定位入口**：
```bash
grep -n 'RecommendedWatcher\|Watcher::new\|watch(\|unwatch(' src/api/files_watch.rs
```

### 2.2 `src/tmux/control_mode.rs`（中等嫌疑）

`SessionActivityMonitor` — 长期 tokio task 监听 tmux control mode 输出。可能内部维护 session 集合，每个 session 起一个 watcher。

**嫌疑点**：
- `ensure_session(name)` 加 session 时是否 spawn 新 tokio task？
- `remove_session(name)` 是否 abort task + 释放关联的 inotify？
- 5 天内创建/删除了多少 tmux session？是否每个都留下一个孤儿 task？

**定位入口**：
```bash
grep -n 'tokio::spawn\|JoinHandle\|abort(' src/tmux/control_mode.rs
```

### 2.3 `src/acp/terminal.rs`（低嫌疑，但 Phase 3 新加）

`AcpTerminalManager` 用 `tokio::process::Command` spawn 子进程。虽然不直接用 inotify，但：
- 子进程退出后，`Child` handle 是否 drop？
- 有没有 `tokio::spawn` 的 reaper task 累积？

**定位入口**：
```bash
grep -n 'tokio::spawn\|Child\|kill(' src/acp/terminal.rs
```

### 2.4 `src/acp/client.rs` / `src/acp/supervisor.rs`（低嫌疑）

`AcpClient` 持有 `ConnectionTo<Agent>` + broadcast channel + 子进程 handle。`AcpSupervisor` 用 `Arc<Mutex<HashMap>>` 管理。

**嫌疑点**：
- `disconnect()` 是否被 `delete_session` 的 ACP 分支正确调用？
- `Arc<AcpClient>` 引用计数是否归零？有没有 supervisor / WS handler 循环引用？

**定位入口**：
```bash
grep -n 'Arc::try_unwrap\|disconnect(\|dispose(' src/api/sessions.rs src/acp/supervisor.rs
```

---

## 3. 排查步骤

### 3.1 复现路径（必做）

写一个 shell 脚本，周期性调用 API 创建/删除 session，同时采集 inotify fd 数：

```bash
# 伪代码
for i in $(seq 1 100); do
  sid=$(curl -s -X POST /projects/$pid/sessions -d '...' | jq -r .id)
  sleep 1
  curl -s -X DELETE /sessions/$sid
  echo "$(date +%s) $(lsof -p $PID | grep -c inotify)" >> leak.csv
done
```

**预期**：如果泄漏，`leak.csv` 的 inotify 列应单调上升；如果正常，应在基线附近波动。

**分别对两类 session 做**：
1. tmux session（覆盖 §2.1 / §2.2）
2. ACP session（覆盖 §2.3 / §2.4；需要一个 ACP-speaking 二进制，可用 Phase 3 P3-19 延期的 fake-agent 顺便做）

### 3.2 文件监听单独复现

只测 `files_watch`（独立于 session 生命周期）：

```bash
# 打开 N 次同一目录的 SSE 连接，再全部关掉
for i in $(seq 1 50); do curl -N /files/watch?path=/tmp &  pids[$i]=$!; done
sleep 2
for p in "${pids[@]}"; do kill $p; done
sleep 2
lsof -p $PID | grep -c inotify   # 应回到基线
```

如果涨了就确认 §2.1 是泄漏点。

### 3.3 代码审计

按 §2 列表 grep + 读代码，重点看：

1. **每个 `Watcher::new()` / `watch()` 调用，是否在对称的生命周期事件里 `unwatch()` / drop**
2. **每个 `tokio::spawn` 是否有 abort 路径**（特别是 long-running task）
3. **`HashMap<_, Arc<X>>` 类型的注册表是否有 remove + drop 路径**

### 3.4 工具

- `lsof -p <pid> | grep inotify`：当前 fd 数
- `strace -p <pid> -e inotify_add_watch,inotify_rm_watch`：实时观察 watch 增删
- `bpftrace -e 'kprobe:inotify_add_watch { @[kstack] = count(); }'`：内核栈 trace，定位调用方

---

## 4. 时间估算

| 阶段 | 预估 |
|------|------|
| 复现脚本 + 数据采集 | 1-2 小时 |
| 嫌疑模块代码审计 | 2-3 小时 |
| 修复 + 验证（每个泄漏点） | 1-2 小时 |
| 文档（`docs/dev/debug-log.md` 条目） | 30 分钟 |
| **总计** | **半天（4-8 小时）** |

**注**：若 §2.1 文件监听是主因，单个修复可能 1-2 小时搞定；若涉及多处，按泄漏点数量线性叠加。

---

## 5. 产出物

1. **`docs/dev/debug-log.md`** 追加「inotify 泄漏」条目（按 AGENTS.md 文档索引约定）
2. **`PROGRESS.md`** 或本执行计划加一条技术债记录
3. **代码修复 commit**：`fix(backend): inotify watch 泄漏（<模块名>）`
4. **回归测试**（可选）：`tests/inotify_leak.rs` 跑 N 次 session 创建/删除，断言 fd 数回到基线 ± 容差

---

## 6. 与 ACP 重构任务的关系

**完全独立**。inotify 泄漏主要在 Phase 3 之前就存在的模块（`notify` crate 的文件目录监听 / tmux `SessionActivityMonitor`），与 Phase 4a 新增代码无关。

**建议**：新会话单独开，不要混在 ACP 重构里。两件事并行不冲突，但合并会让 commit 难以 review、难以 bisect 回滚。

---

## 7. 新会话接手 checklist

1. 读本方案（`docs/dev/plans/2026-07-16-inotify-leak-investigation.md`）
2. 读 AGENTS.md §"工程准则"（特别是「缺陷修复 — 追溯根因而非掩盖症状」）
3. 验证当前进度：
   ```bash
   grep -n 'inotify' docs/dev/debug-log.md  # 是否已有条目
   cat /proc/sys/fs/inotify/max_user_watches  # 应为 524288
   ```
4. 按 §3 排查步骤执行；每完成一个嫌疑模块的审计/修复，单独 commit
5. 输出 §5 列的产出物

---

## 8. 变更历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-07-16 | 初版：基于 `OmniTerm-preview` 5 天实例 1320 fd 现象；定位 4 个嫌疑模块；设计复现 + 审计 + 修复流程；估算半天 | Qoder |
