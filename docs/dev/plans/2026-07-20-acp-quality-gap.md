# ACP 模块质量缺口填补计划

> 状态：设计定稿，待实施
> 触发条件：2026-07-20 审查发现 ACP 核心模块零自动化测试覆盖；`useAcpChat` 职责偏高；FileManager 持续增长
> 关联：`AGENTS.md` 工程准则第 5 条「验证闭环」、第 7 条「奥卡姆剃刀」

---

## 1. 背景

### 1.1 当前缺口

| 模块 | 代码量 | 测试覆盖 | 风险等级 |
|------|--------|----------|---------|
| `src/acp/client.rs` | ~200 行 | 0 | **高** — 核心协议交互，包含连接/发送/取消/disconnect 全链路 |
| `src/acp/supervisor.rs` | 35 行 | 0 | 中 — HashMap 增删查，逻辑简单但跨模块调用多 |
| `src/acp/terminal.rs` | 225 行 | 0 | **高** — spawn 子进程 + 输出采集 + kill/release，涉及 tokio task 管理 |
| `src/acp/permission.rs` | ~90 行 | 0 | 中 — 包含 PermissionManager 状态机逻辑 |
| `src/acp/chat_persistence.rs` | 新建 | 0 | 中 — DB 读写 |
| `src/acp/handler.rs` | 新建 | 0 | 中 — 消息分发 |
| `src/ws/acp.rs` | ~240 行 | 0 | **高** — WS 帧解析 + extract_text_from_notification 多 format 适配 |
| `frontend/src/hooks/useAcpChat.ts` | 449 行 | 0（hook 级） | 中 — 下一节单独讨论 |
| `frontend/src/stores/chatStore.ts` | 367 行 | 8 个 store 测试 | 低 — 已有部分 coverage（Phase 4a 时写的） |

### 1.2 风险分析

当前 ACP 模块无自动化回归保护。每次后端改动（依赖升级、重构、协议适配）必须靠手工测试（`docs/reference/user-testing.md` §12）+ 联调验证。`agent-client-protocol` crate 还处于活跃开发期（v1.4.0 → v2 迁移），**依赖升级不触发编译错误不一定意味着行为正确**。

### 1.3 根因

Phase 3~7 采用策略性高速度推进：先验证功能通路，再补基础设施。现在 Phase 7（rich message rendering）已落地，**填补测试缺口就是 Phase 8 的核心任务**。

---

## 2. 范围与优先级

### 2.1 P0 — 本轮必须覆盖（预计 2 天）

| 序号 | 目标 | 测试策略 | 预估 |
|------|------|---------|------|
| T01 | `extract_text_from_notification` 多 format 解析 | 纯函数测试，直接喂 JSON value 断言输出 | 2h |
| T02 | `AcpSupervisor::insert/get/dispose/shutdown_all` | 简单集成测试，create client → insert → get → dispose → shutdown_all | 2h |
| T03 | `AcpTerminalManager` 核心路径 | 集成测试：spawn echo 命令 → 读 output → kill 验证退出状态；release 验证清理 | 4h |
| T04 | `PermissionManager` 状态机 | 纯函数测试：request → resolve（accept/reject）→ expiry 验证 | 3h |
| T05 | `AcpClient::send_prompt/cancel/disconnect` | mock `ConnectionTo` 验证请求帧发送 + `broadcast::Sender` 验证通知传播 | 4h |

**小计：15h（~2 个完整工作日）**

### 2.2 P1 — 下个迭代补（预计 1 天）

| 序号 | 目标 | 测试策略 | 预估 |
|------|------|---------|------|
| T06 | `src/ws/acp.rs` WS handler 主路径 | 集成测试：mock WS stream → 注入 acp_client → 验证帧编码/解码/错误传播 | 4h |
| T07 | `handler.rs` 消息分发逻辑 | 纯函数 + 少量 mock，验证各类 notification 被正确路由到对应 handler | 3h |
| T08 | `chat_persistence.rs` DB 读写 | 集成测试（内存 SQLite），验证 save/load/hydrate/cleanup | 2h |

**小计：9h（~1 个工作日）**

### 2.3 P2 — 技术债跟踪（不设硬截止，触发再处理）

| 序号 | 项目 | 现状 | 触发条件 |
|------|------|------|---------|
| R01 | `useAcpChat.ts` 449 行拆分 | hook 同时管 WS 生命周期 + 协议解析 + store 分发 | 下次新增功能需要改 useAcpChat 时，顺带将 WS 连接管理提取为独立 hook |
| R02 | `FileManager.tsx` 1061 行重构 | 已知"巨组件"，但 07-30 列宽拖动修复已验证组件内部伸缩性尚可 | 新增第三个列拖动类型或修改排序逻辑时，考虑按职责拆分子组件 |
| R03 | `user.rs` dead model | `User` struct 从未使用 | 移除或加注释标记为预留 |
| R04 | `auth/mod.rs` dead code | `verify_token`、`RequireAuth` 未使用 | 清除或确认已由其他机制替代 |

---

## 3. 测试架构决策

### 3.1 Rust 侧：模块级单元测试 + 集成测试

- **单元测试**（`#[cfg(test)] mod tests`）：适合纯逻辑，如 `extract_text_from_notification`、`PermissionManager`、`AcpSupervisor`。不依赖外部进程/网络。
- **集成测试**（`tests/` 目录或 `#[cfg(test)]` 内 spawn tokio runtime）：适合 `AcpClient` + `ConnectionTo` mock、`AcpTerminalManager` + 真实子进程。
- **mock 策略**：优先用 trait + test double，避免 mock 框架。`ConnectionTo` 已经提供了 `send_request/notify` 方法，测试时注入一个 fake backend 验证发送的内容。

### 3.2 `agent-client-protocol` 的 ConnectionTo mock

`ConnectionTo`（来自 `agent-client-protocol` crate v1.2.0）是连接的核心抽象。测试策略：

```rust
// test only: a fake connection that captures sent requests
struct FakeConnection {
    sent_requests: Arc<Mutex<Vec<Box<dyn Any>>>>,
}

#[async_trait]
impl ConnectionTo for FakeConnection {
    async fn send_request<R: RequestType>(&self, req: R) -> Result<R::Response, Error> {
        self.sent_requests.lock().unwrap().push(Box::new(req));
        // return a canned/empty response
        Ok(R::Response::default())
    }
    // ... notify() similar
}
```

原则：**只 mock 外部边界（连接 socket），不 mock 内部模块（AcpSupervisor/PermissionManager）**。

### 3.3 前端侧：已有 vitest + React Testing Library

- 纯逻辑（`chatStore` 的 reducer/selector 逻辑）：已有 8 个 store 测试，按同样的模式扩充。
- Hook 测试（`useAcpChat`）：考虑用 `renderHook` + 模拟 WebSocket，但当前 hook 依赖 `sessionId` 和 `chatStore`，集成成本高。**建议先覆盖 store 逻辑和解析函数**，hook 级测试延后到拆分后。

---

## 4. 实施计划

### Day 1 — P0 核心覆盖

| 时段 | 任务 | 产出 |
|------|------|------|
| 上午 1 | T01: extract_text_from_notification 测试 | `src/ws/acp.rs` 内加 test module，覆盖 canonical external tag / flat vendor / agent_message_chunk / tool_use 等多种 format |
| 上午 2 | T04: PermissionManager 状态机测试 | `src/acp/permission.rs` 内加 test module，覆盖 request / accept / reject / expiry / duplicate resolve |
| 下午 1 | T02: AcpSupervisor 测试 | `src/acp/supervisor.rs` 内加 test module，覆盖 insert/get/dispose/shutdown_all/empty-get |
| 下午 2 | T05: AcpClient send/cancel/disconnect 测试 | `src/acp/client.rs` 内加 test module + FakeConnection，覆盖 prompt 发送、cancel、disconnect、双层 shutdown |

### Day 2 — P0 余量 + P1 入

| 时段 | 任务 | 产出 |
|------|------|------|
| 上午 | T03: AcpTerminalManager 集成测试 | `src/acp/terminal.rs` 内集成测试模块，spawn `echo hello` → read output → verify exit → kill → release |
| 下午 | T06/T07: WS handler + 消息分发 | `src/ws/acp.rs` 集成测试，mock rx 注入 notification → 验证 WS 帧写到 ws_tx；handler 验证 dispatch 正确性 |
| 缓冲 | T08 或复盘清理 | chat_persistence DB 测试，或根据 Day1 实作调整 |

---

## 5. 验收标准

1. `cargo test` 新增 15+ 个测试用例，全部通过
2. ACP 模块函数覆盖率（`cargo tarpaulin` 或 `llvm-cov`）从 <5% 提升到 >60%
3. 前端的 `extract_text_from_notification` 等价逻辑的测试同步补齐
4. `useAcpChat` 拆分条件（R01）记录到本计划"待触发"存档（本文件即为此存档）
5. R02/R03/R04 作为独立 backlog entry，附加到 `docs/dev/plans/backlog/` 下

---

## 6. 不纳入范围

- 端到端集成测试（起真实 agent 子进程）：成本过高，留给手工测试（§12）
- 性能基准测试：已有独立计划 `backlog/performance-remaining-tiers.md`
- `useAcpChat` 现在拆分：不影响当前功能的正确性，触发再处理

---

## 附录 A：`useAcpChat.ts` 拆分方案（触发时参考）

### A.1 现状

```
useAcpChat (449 行)
├── WebSocket 生命周期（connect/disconnect/reconnect）  ~120 行
├── 协议帧解析 + SessionUpdate 适配器表               ~100 行
├── Store 动作分发                                      ~100 行
├── 输入/取消/恢复/权限响应 接口                        ~50 行
└── 副作用管理（State + Ref + identity guard）          ~80 行
```

### A.2 目标结构

```
useAcpChat (orchestrator, ~80 行)
├── useAcpConnection(sessionId)          ─ WS 生命周期 + ref guard
├── useAcpProtocol(ws)                   ─ 帧解析 + adapter table + classify
└── useAcpDispatch(classifiedFrames)     ─ store 动作 + UI state
```

### A.3 触发条件

下次满足任一：
- 需要修改 WS 重连逻辑（如指数退避、max retry）
- 需要新增协议帧类型（如 replay/replay_end）
- 需要支持第二个 vendor 的 wire format
