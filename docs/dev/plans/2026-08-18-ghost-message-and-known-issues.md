# 幽灵行修复与已发现未处理问题清单

> 状态：P0 已实施（2026-08-18）；P1/P2 待办（运维层，另立）
> 触发条件：修改 `src/acp/turn_accumulator.rs`、`src/acp/chat_persistence.rs`、`src/acp/reaper.rs`、`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatView.tsx` 中任一项前必读
> 关联：`docs/dev/plans/2026-08-10-acp-session-reliability.md`（Phase 1 勘误预测的 text 语义漂移在此文档中实测复现）、`docs/dev/plans/2026-08-18-permission-recycle-notice.md`（同次排查的已修复项）、`docs/architecture/backend.md`（blocks 两态 / sync_messages 匹配语义）
> 来源：正式版会话 codebuddy_0818-1141 排查（2026-08-18），全部问题有正式库 `omniterm.db` 实测证据

## 问题清单

| # | 问题 | 严重度 | 证据 |
|---|---|---|---|
| P0 | **幽灵行**：会话出现无对应 user 输入的重复 assistant 消息（cooked 行），每个 RAW 残留 turn 恰产生一条 | **高（数据污染 + DB 膨胀）** | 1141 会话 2 组（465→277、964→641 字符）、1348 会话 1 组（2039→1949）；幽灵行 text 恰好缺 tool 流式描述段 |
| P1 | 正式版 omniterm 进程环境被 preview worktree 变量污染 | 中（违规 + agent 继承脏 env） | `/proc/4007600/environ`：`BRANCH_BINARY_NAME=omniterm-preview`、`BACKEND_PORT=9075`、`DOMAIN=term-preview.tokitoken.com`、`LD_LIBRARY_PATH` 指向 preview `target/debug`、API keys |
| P2 | 正式版日志丢失：`fd 1` 的 inode 与磁盘 `omniterm.log` 不一致（文件被 unlink 后 fd 未重开） | 中（无法取证，本次只能靠 DB 还原时间线） | `/proc/4007600/fd/1` inode 168687739 ≠ `omniterm.log` inode 3034528；日志停在 8月16 10:19 |

---

## P0 幽灵行（Ghost Message）

### 根因链（三段，每段都有代码定位与数据证据）

1. **RAW 残留**：turn 结束时前端 WS 不在线（用户切去其他会话/关页面）→ `prompt_done` 的 `syncTurnToDb`（`useAcpChat.ts:743`，带 row_id 的安全 UPDATE 路径）无人执行 → 该 turn 的行停在原始帧态 `{"v":1,"frames":[...]}`（blocks 体积比 cooked 大两个数量级）。短 turn 竞态（prompt_done 广播早于 250ms 防抖写）是同效应另一来源（`2026-08-10` 计划勘误已记录，未修）。
2. **hydrate/replay 竞态**：`replay_start`/`replay_end` 帧**不在** `HYDRATE_GATED_FRAMES`（`useAcpChat.ts:56-62`，门控仅含 `session_update/turn_snapshot/turn_state/prompt_done/prompt_error`）→ 页面刷新时 replay 帧先于 `GET /messages` 落定到达 → `suppressReplay` 判定为 false（store 仍空）→ `commitReplay` 用**重建消息（无 dbId）**替换 store → `replay_end` 调全量 `syncToDb()`（`useAcpChat.ts:826`）。
3. **text 语义漂移**：`sync_messages` 无 id 路径按 `(session, role, text)` 文本匹配（`chat_persistence.rs:255-277`）。后端累积器 `text` = 全部 `AgentMessageChunk` 的文本（**含 tool 流式描述**，如"现在修改 auth.ts：…"），前端 cook 折叠后重建消息的 `text` = 纯文本（tool 内容进 tool 块）→ **两侧 text 不等价** → 匹配失败 → INSERT 幽灵行（`chat_persistence.rs:279-280`，cooked blocks）。
   - `2026-08-10` 计划 Phase 1 勘误断言"实测语义确实一致，但这是个易漂移的不变式"——**在 codebuddy 上实际漂移**（幽灵行 text 与 RAW 行 text 差 277~323 字符，均为 tool 流式段）。

### 修复方案

**方案 A（消除竞态）**：`HYDRATE_GATED_FRAMES` 纳入 `replay_start`/`replay_end`。hydrate 必先落定 → store 已有带 dbId 的消息 → replay 回放时 `suppressReplay=true` → 内容帧丢弃、不 commitReplay、不 syncToDb → 不再 INSERT。
- 边界：hydrate 为空（全新会话无历史）时 replay 不被 suppress → 正常重放写回 → 全部 INSERT 但无对应行，不产生幽灵行（安全）。
- 代价：replay 内容帧不再更新 store（hydrate 已从 DB 拿到权威历史，含后端落库的最新消息，无丢失）。

**方案 B（收敛 RAW 残留，计划勘误留的补齐路径）**：hydrate 落定后，对 blocks 为原始帧包裹（`{"v":1,"frames"`）且带 dbId 的消息，做一次**带 id 的 cooked 回写**（`turnToSyncPayload` 同构）：带 id → UPDATE 该行 blocks、不写 text → 不 INSERT。副作用：RAW 残留体积从源头收敛；hydrate 解码与 cook（折叠 `tool_call_update`）的衔接需在实施时确认（`decodeStoredBlocks` 是否已折叠）。
- 放置点：`useAcpChat.ts` 的 hydrated 落定 effect（`useAcpChat.ts:1044-1054`）或 ChatView hydrate 完成处。

**两个方案必须同做**：A 止住新幽灵行，B 收敛存量 RAW 残留（A 生效后 RAW 行不再有幽灵行"补救"，会永久残留，体积问题仍在）。

> **实施说明（2026-08-18）— 两个方案均已落地，补充三个实施时才看清的边界（方向不变）**
>
> 1. **`streaming` 的 RAW 行跳过回写**（方案 B）。进行中 turn 的后端累积器仍在防抖 flush 原始帧，此时回写 cooked 会被下一次 flush 覆盖（白写一次）；turn 结束后由 `prompt_done` 的 `syncTurnToDb` 正常接管；若 turn 在离线期结束，下次 hydrate 时该行 `status='complete'` 自然落入方案 B 回写范围。收敛闭环不依赖跳过路径。
> 2. **解码失败/为空的 RAW 行不标记 `rawStored`**（方案 B）。`decodeStoredBlocks` 对不可识别帧返回空 → 前端回退纯文本兜底；若标记并回写，会用纯文本 blocks 覆盖后端原始帧，堵死「分类器升级后重新解释旧历史」的唯一恢复路径。判定放在 `ChatView.toChatMessages`（解码成功且非空才置 `rawStored`）。
> 3. **后端匹配语义零改动**（符合验收标准中的倾向）：无 id 文本路径的 INSERT 行为由既有测试 `text_path_inserts_messages_absent_from_db` 固化，未新增触发点（replay 帧已门控，该路径不再被幽灵行场景触发）。
>
> **验收落地情况**：前端集成测试 `frontend/src/hooks/useAcpChat.ghost.test.tsx`（6 条：门控集合含 replay 帧、replay 先于 hydrate 被 suppress 不 syncToDb、空会话仍正常重放、RAW 行带 id 回写、streaming RAW 行跳过、无标记行跳过）+ `chatStore.test.ts` 新增 `storedRawRowToSyncPayload` 5 条，全部通过；`pnpm vitest run` 350 全绿；`tsc --noEmit` 通过；lint 0 errors。手动回归与正式库 `count(*)` 检查待办（需 dev/正式环境）。

### 验收标准

- [x] 前端单测：replay 先于 hydrate 到达时不 INSERT 幽灵行（mock WS 帧序）
- [x] 前端单测：hydrate 落定后 RAW 行被带 id 回写成 cooked，消息条数不增加
- [x] 后端单测：`sync_messages` 带 id 路径对 RAW 行 UPDATE 不 INSERT（已有）；无 id 路径行为由既有测试固化（按文档倾向**不改后端匹配语义**）
- [ ] 手动回归：dev 环境造一个 RAW 残留 turn（切走页面等 turn 结束）→ 刷新 → 无幽灵行、RAW 行被收敛
- [ ] 正式库检查：`count(*)` 与 `count(DISTINCT blocks)` 在已修会话上不再增长

### 不纳入（奥卡姆剃刀）

- 后端 `sync_messages` 无 id 路径的匹配语义改动（方案 A 已切断触发源）
- 存量幽灵行数据清理（用户可手动删会话；如需批量清理另立）

---

## P1 正式版进程环境被 preview worktree 污染

**事实**：正式版 omniterm（npm 安装，`omniterm start -d -H 0.0.0.0`）进程 env 携带 preview worktree 的 `.env.local` 变量（`BRANCH_BINARY_NAME`/`BACKEND_PORT`/`FRONTEND_PORT`/`DOMAIN`/`LD_LIBRARY_PATH`/API keys），其 spawn 的 codebuddy agent 全部继承。违反 AGENTS.md「后端配置只走命令行参数或 `OMNITERM_*` 前缀 env」。

**待查**：正式版进程的启动方式（从哪个 shell/脚本启动导致继承了 preview env）。v0.2.15 实测监听 9077（默认端口），说明已不再读 `BACKEND_PORT`，当前无功能性影响，但属违规且 agent 继承脏 env 是隐患（如 `LD_LIBRARY_PATH` 指向 preview 的 `target/debug`）。

**处理**：查启动链 → 清理启动环境 →（可选）给正式版启动脚本加 env 消毒（只保留 `OMNITERM_*` / `PATH` / 白名单）。

## P2 正式版日志 fd 指向已删除文件

**事实**：`/proc/4007600/fd/1` → inode 168687739（已被 unlink），磁盘 `omniterm.log` → inode 3034528。日志文件被 logrotate/手动删除后进程未重开 fd，8月16 之后日志全部写入已删除 inode，**本次排查无法从日志取证**。

**处理候选**：正式版启动方式改用 systemd/logrotate `copytruncate` 或日志轮转后重启进程；或为守护模式加日志重开机制（如 SIGHUP 重开 fd）。

---

## 文档闭环

- ✅ 修复实施后：`CHANGELOG.md` Fixed 条目（2026-08-18 16:45）；`docs/architecture/backend.md`（收敛触发点补 hydrate、无 id 路径失控说明）；`docs/architecture/frontend.md`（replay 门控语义、回写路径表补 hydrate 收敛行）；本文件状态改「已实施」
- ✅ `docs/dev/debug-patterns/frontend-react.md`：模式 10「写回定位键必须来自权威方，触发路径必须与权威数据到达串行化」——幽灵行与 Phase 0 的「匹配键不唯一导致批量误更新」合并为同一家族（**匹配键选错/匹配路径失控等于没有约束**），两条案例证据；debug-guide.md 索引已登记
- ✅ AGENTS.md 文档索引：本文件触发条件已登记（索引表 2026-08-18 行）
- ⏳ P1（正式版进程环境被 preview 污染）与 P2（日志 fd 指向已删文件）为运维层问题，待查启动链后另立处理
