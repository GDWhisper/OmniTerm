# 登录审计留痕（3+1：成功类全记 + 限流触发一条）

> 状态：**实施中**（2026-10-11 用户拍板方案）
> 触发条件：修改 `src/api/audit.rs`（`AuditAction`）、`src/api/auth.rs`（写入点）、`src/auth/rate_limit.rs`（`record_failure` 返回值），或改动审计读口 / 前端 `AuditLogSection` 前**必读**
> 关联：`docs/reference/auth-not-enforced.md`、`docs/architecture/backend.md`「安全审计日志（S5）」、`docs/dev/plans/2026-09-26-security-hardening-batch.md` D4、`docs/dev/plans/2026-09-27-auth-username-local-bypass.md`
> 需求来源：2026-10-11 审查发现「登录成功/失败无任何留痕」；用户裁决 3+1（成功 + 登出/改密/改名全记，失败只在限流触发时记一条）

## 背景

2026-10-11 审查确认：登录成功/失败既不入审计表（`AuditAction` 无 auth 动作、`api/auth.rs` 无 `audit::record` 调用）也不写 tracing；唯一痕迹是内存限流计数（`LoginGuard`，有界但成功即清空、重启即丢、不可检索）。`audit.rs` 既有口径是「只记成功操作；要审失败尝试应作为独立动作统一加」。

## 范围

| 级别 | 项 | 要点 |
|---|---|---|
| P0 | 成功类 5 动作 | `auth_login` / `auth_setup` / `auth_logout` / `auth_password_change` / `auth_username_change` |
| P0 | 失败类唯一动作 | `auth_rate_limited`（凭据失败**首次**达到阈值；每 IP 每窗口一条） |
| P1 | 前端 | `AuditActionName` / `ACTION_KEYS` / 双 locale 6 键 |
| P1 | 文档 | backend.md 审计表、auth-not-enforced.md、AGENTS 索引、CHANGELOG |

### 不纳入范围（含理由）

- **逐次失败记录（`auth_login_failed`）**：爆破面每请求一条 = 写放大，且 `/auth/login` 公开、无认证可灌量——`MAX_AUDIT_ROWS=1000` 的滚动上限会被刷穿（台账被擦除）。失败留痕收敛到「限流触发」这一个信号点。
- **本地免密命中留痕**：每页加载一次 check 即一条，高频噪音；「信任本机」语义下追查价值低。
- **设置开关（`auth_enabled` / `local_auth_required`）变更留痕**：2026-09-27 计划已列为独立后续项，本批不做。
- **密码 / token / cookie 值进 detail**（§S3）：一律不记。

## 设计决策（ADR）

### D1 动作集与 target 语义

- 成功类 target = **当时账号名**（`users.username` 的可读值；单账号下即「谁登录/被改动的账号」）。
- `auth_username_change` 的 target = **新名**，detail = `{"old_username": 旧名}`——UI 只渲染 target（不渲染 detail），`旧 → 新` 的可读形态由 UI 需要时可读 target + action 推断；detail 供查库。
- `auth_rate_limited` 无账号关联（可能是探测者）→ target = `-`，detail = `{"failures":5,"window_secs":300}`。
- **不把 username 塞进 actor**：沿用既有决策（actor 前缀固定 `admin`、区分度靠来源 IP，见 `audit.rs` 的 actor 注释）。

### D2 logout 仅「携带有效 token」才记（防无认证灌量）

`/auth/logout` 是 public 路由（无 `require_auth_mw`），任何能触达端口者可无限调用——无条件记录会让攻击者刷穿滚动上限、冲掉全部旧台账（审计擦除）。
故：logout 提取本实例 cookie → `verify_token_for_state` 通过（**在 `token_version + 1` 之前**校验）才落一条 `auth_logout`；无 token / 无效 token 不记——语义也正确（没有会话被登出）。
target 取 `Claims.sub`（不追加查询）。

### D3 rate_limited 去重：`record_failure` 报告「首次到达阈值」

`LoginGuard::record_failure` 改为返回 `bool`：push 后失败计数**恰好等于** `MAX_FAILURES` 时为 `true`（本次失败首次把该 IP 推过阈值；并发下也恰有一次）。
被限流期间的请求由 `check_rate_limit` 直接 429，不再计次、不重复记。窗口滑出 / 成功登录清除后再次触发 → 各记一条（每次触发事件一条，符合语义）。
调用点中仅 `reject_bad_credentials`（login / change-password / change-username 的凭据校验失败）转发记录；`setup` 的「已存在 409」分支是防滥用计数、不记（非密码猜测面）。

### D4 写入位置与既有失败语义

全部经既有 `audit::record`（写库失败仅 warn、不影响业务响应；上限/截断由既有机制负责，见 `audit.rs`）。写入在业务动作**成功之后**：
- `setup`：插入成功后（签发 session 前）。
- `login`：凭据校验通过后。
- `logout`：token 校验通过 + `token_version` bump 后。
- `change-password`：bump 后（username 复用既有查询加列）。
- `change-username`：bump 后（旧名复用既有查询加列）。
- `auth_rate_limited`：在 `reject_bad_credentials` 内、1s 延迟之前。

### D5 前端

`AuditActionName` 联合类型加 6 值（`Record<AuditActionName, string>` 穷举将强制 `ACTION_KEYS` 同步，漏改即 tsc 失败）+ 双 locale 6 键（`settings.auditLog.action.authLogin` 等）。`AuditLogSection` 组件结构不变。

## 验收标准

- [ ] `cargo test`：`audit` 动作稳定性表更新；`record_failure` 返回值三态（首次到达 `true` / 再次失败 `false` / 成功后重新触发 `true`）；handler 级——login / setup / logout / change-pw / change-uname 成功各留一行且 target 正确；限流触发恰一条（第 6 次失败被 429 拦截时不新增）；logout 无 token 不留痕。
- [ ] 前端 `tsc -b` 通过（Record 穷举强制）+ 相关组件测试全绿。
- [ ] `cargo fmt` / `clippy -D warnings` / `pnpm lint` 零新增告警。
- [ ] 独立子代理审查（T1 + 加挂 B/E）通过，blocker/major 全部处置。

## 相关文件

- 后端：`src/api/audit.rs`、`src/api/auth.rs`、`src/auth/rate_limit.rs`
- 前端：`frontend/src/api/client.ts`、`frontend/src/components/Settings/AuditLogSection.tsx`、`frontend/src/locales/{en,zh}/translation.json`
- 文档：本计划、`docs/architecture/backend.md`、`docs/reference/auth-not-enforced.md`、`AGENTS.md`、`CHANGELOG.md`
