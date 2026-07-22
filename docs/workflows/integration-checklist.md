# Integration Checklist

> **Agent 触发条件**：以下任一情况**开始动手前**读本文：
> 1. 集成新的 **spawn 抽象**（subprocess / container / FFI / 第三方 CLI 包装）—— 任何会 fork 出独立进程并期望它有特定运行时状态的代码
> 2. 给已有枚举新增一个变体（如 `runtime_kind: tmux → acp → ???`、新增 `agent_kind`、新增 `project_type`、新增任何 enum / sealed trait 的新分支）
>
> **核心规则**：跨层不变量必须由至少一个**真进程 / 真 OS 状态**的 e2e 测试覆盖。仅 mock 协议层是不够的——这次踩的两个 bug 都是协议层 mock 全过、OS 层是错的。

## 背景：2026-07-23 连续两个 bug

> 完整诊断见 [`docs/dev/debug-log.md`](../dev/debug-log.md) `## 2026-07-23` 条目。

**Bug A — spawn 没设 cwd**：`agent-client-protocol` crate 的 `AcpAgent::spawn_process` 不调 `Command::current_dir()`，子进程 OS cwd 继承父进程（后端）。后端在 `NewSessionRequest` 协议层传对了 cwd，但 agent 子进程实际在错的目录里跑——所有 git / 文件读取 / 派生子进程都用错的 cwd。

**Bug B — 老代码假设旧 runtime 字段非 NULL**：后端 `resolve_session_base` 写于「只有 tmux session」时代，强制 `SELECT tmux_session_name`。ACP session 该列 NULL → 整个函数返 None → `/files?session=…` 返 404。修 Bug A 之前 404 被「错的数据」掩盖；修完后立刻暴露。

**共同根因**：两个 bug 都是「**没验证运行时假设**」+「**没审旧 call site 适配新维度**」。

---

## 清单 A：集成新的 spawn 抽象

适用于：subprocess、container sidecar、FFI 调用、第三方 CLI 包装、tokio 任务 + 子进程组等任何会 fork 出独立进程的代码。

### A.1 必做：e2e 测试验证 OS 运行时状态

**写一条 5-10 行的测试**，spawn 后**用 /proc / lsof / cgroup 看真实状态**，不依赖 mock。

```rust
// 模板：spawn 后立刻验证 OS 状态
#[tokio::test]
async fn spawned_process_actual_cwd_matches_expected() {
    let workspace = std::env::temp_dir().join("acp-cwd-test");
    std::fs::create_dir_all(&workspace).unwrap();

    // spawn 你的抽象
    let child_pid = spawn_my_thing(&workspace).await.unwrap();

    // 立刻 readlink /proc/<pid>/cwd —— 这是 OS 给的真相
    let actual_cwd = std::fs::read_link(format!("/proc/{child_pid}/cwd")).unwrap();
    assert_eq!(actual_cwd, workspace);
}
```

**具体要查的运行时信号**（按场景选）：

| 想验证 | 命令 / 调用 |
|--------|-------------|
| 子进程 OS cwd | `readlink /proc/<pid>/cwd` (Linux) / `lsof -p <pid> -d cwd` (macOS) |
| 子进程环境变量（含 PATH、HOME、代理等） | `cat /proc/<pid>/environ \| tr '\0' '\n'` |
| 子进程是否真的拉起（不是僵尸） | `ps -o pid,stat,cmd -p <pid>` 看 STAT 不是 Z |
| 子进程在哪个 cgroup / container | `cat /proc/<pid>/cgroup` |
| 子进程的 fds 是否泄漏 | `ls /proc/<pid>/fd \| wc -l` 前后对比 |
| 容器内 / chroot 路径 | `readlink /proc/<pid>/root` |
| child of parent 关系 | `cat /proc/<pid>/status \| grep PPid` |

**不要只信**：
- 函数返回值（"spawn 成功"≠"子进程在正确状态"）
- mock（mock 协议层通≠OS 层通）
- 文档（"the cwd is X" 文档经常滞后于代码）

### A.2 必做：spawn 代码旁留 VERIFIED 注释

```rust
pub async fn spawn_my_thing(workspace: &Path) -> Result<...> {
    // VERIFIED 2026-07-23: /proc/<pid>/cwd == workspace
    // 见 docs/workflows/integration-checklist.md §A.1
    // 不要相信参数名像什么就当它是什么 —— 必须 e2e 验证。
    ...
}
```

**注释内容包括**：验证日期、用了什么命令验证、链接到 checklist / debug-log 条目。**6 个月后看这段代码的人（包括你自己）不会重新踩坑**。

### A.3 必做：跨库 API 假设校验

第三方 crate / 操作系统 API 的"看起来对"≠"实际对"。必查：

- spawn API 是否有 `current_dir` 参数？不代表用了——**查源码确认是否调**
- 协议层 `cwd` / `working_dir` 字段？是不是「提示」vs「强制执行」？agent 是否真会遵守？
- 文档说"运行在 X 目录"——查 `/proc/<pid>/cwd` 验证

**反例**：`agent-client-protocol` 的 `NewSessionRequest::new(cwd)` 名字像 cwd，但**只是协议层提示**，spawn 出来的子进程不读这个。

### A.4 考虑：进程组 / 信号 / 清理

- 子进程是 process group leader 吗？（决定能否 `kill_process_group`）
- `disconnect` / `Drop` 时信号能透传到子进程吗？
- 子进程的子进程（grandchildren，如 `npx → node`）会不会变孤儿？

---

## 清单 B：给已有枚举新增变体

适用于：`runtime_kind`、`agent_kind`、`project_type`、新增 enum 分支、sealed trait 新 impl、任何"X 有几种类型"扩展。

### B.1 必做：grep 老 runtime 的特有字段，全 call site 审计

**最易踩的坑**：老代码假设某字段非 NULL / 某值存在，新增变体后这条路径 NULL / 缺失，整个逻辑 break。

```bash
# 例：加新 runtime_kind 前，audit 老 runtime 字段的所有用法
grep -rn "tmux_session_name" src/ frontend/src/
grep -rn "is_active" src/ frontend/src/
grep -rn "runtime_kind" src/ | grep -v "RuntimeKind" | head -30
```

**每个匹配点逐一回答**：
- 这个调用点假设旧 runtime 一定非 NULL 吗？新 runtime 走这里会 NULL 吗？
- 如果 NULL，能 fall back 到「项目 workspace_path / 默认值」吗？
- 调用方是否需要做 `match` 而不是单分支处理？

**反例**：`resolve_session_base` 旧逻辑：
```rust
let tmux_name: (String,) = sqlx::query_as("SELECT tmux_session_name ...")
    .bind(session_id).fetch_optional(...).await.ok().flatten()?;
```
直接 `?` 一 NULL 就整个函数 None——没考虑过「未来某 runtime 这个字段是 NULL」。

### B.2 必做：穷举每种 runtime_kind 走一遍主流程

对每个新枚举值，手动 trace 一次主流程：
- 创建 → 列表 / 详情 API 返回字段是否齐全？
- 状态查询（活跃度 / 进程存活）有没有为新 runtime 实现？
- 资源清理（disconnect / kill）路径完整吗？
- 前端 dispatcher（如 `runtime_kind === 'acp' ? <ChatView> : <Terminal>`）是否覆盖所有分支？
- i18n / 错误提示是否处理了「未知 runtime」?

**建议用一张表**显式过一遍：

| 路径 | tmux | acp | <新值> |
|------|------|-----|--------|
| `POST /sessions` 创建 | ✓ | ✓ | ? |
| `GET /sessions` 列表 | ✓ | ✓ | ? |
| `GET /files?session=…` | ✓ | ✓（修后）| ? |
| 资源清理 | ✓ | ✓ | ? |
| 空闲回收 | ✓ | ✓ | ? |

任何一格 `?` → **block merge**。

### B.3 必做：DB 迁移审计

新增枚举值需要：
- DB schema 是否有 `CHECK` 约束？需要更新吗？
- 老行的 default 值是否能 cover 新值？
- migration 跑完后老数据是否需要 backfill？

**反例**：`runtime_kind TEXT NOT NULL` 没有 CHECK 约束，加新值时 DB 不会拦——但前端 dispatcher 没分支会 silently fallback 到 tmux，用户看到的"对的"行为其实是错的默认。

### B.4 必做：枚举 → 字符串映射双向校验

如果枚举通过 wire format 传（HTTP / WS / 协议），必须：
- serialize / deserialize 两端都认识所有变体
- 未知变体的默认行为（reject / 视为 default / 视为 unknown）

**反例**：ACP wire format 用 `sessionUpdate: "agent_message_chunk"` 蛇形命名，crate 默认是 PascalCase 外部标签——不在边界加 adapter 就 100% 失配（`debug-log.md` 2026-07-19 条目记录了完整案例）。

---

## 清单 C：通用

### C.1 实物检查 > 文档 + 源码推测

当用户报"创建出来的东西不对"时，**第一动作**是看实际产物：

| 错的是 | 看 |
|--------|-----|
| 文件路径 | `ls -la` / `stat` / `readlink` |
| 子进程状态 | `/proc/<pid>/{cwd,status,cmdline,environ,fd/*}` |
| 端口监听 | `ss -tlnp` / `lsof -i` |
| DB 内容 | `sqlite3 db.db "SELECT ..."` |
| 进程树 | `ps auxf` / `pstree` |
| 网络包 | `tcpdump` / `wireshark` |
| 容器内部 | `docker exec` / `nsenter` |

**不要第一动作看代码搜索**。代码搜索适合 "我大概知道在哪"；实物检查适合 "我完全不知道"。

### C.2 修一层别忘跨层不变量

修一个跨层不变量（如 "agent 看到正确 workspace"）涉及多层：

```
DB → 后端 API → 后端 handler → spawn → 子进程 OS → 子进程应用层
↑                                                          ↓
└────────────── FileManager / WS 透传 ◄────────────────────┘
```

每层都可能假设某个状态正确。**修完后必须从入口到 UI 走一遍完整请求流**，确认每层都看到一致的状态。debug-log 2026-07-23 §6 记录了这次的教训：先修 spawn cwd 暴露了后端 FileManager 的 404 假设。

---

## 相关文档

- [`docs/dev/debug-log.md`](../dev/debug-log.md) `## 2026-07-23` — 本 checklist 触发的原始 bug 诊断
- [`docs/architecture/backend.md`](../architecture/backend.md) — 后端架构（含 ACP runtime 章节）
- 关联 commit：`27d815f` (spawn cwd)、`dde6298` (FileManager 404)、`cb49ab3` (debug-log 补遗)
- 关联 issue 字段：`sessions` 表 `runtime_kind` / `tmux_session_name` / `workspace_path` 三列的耦合关系
