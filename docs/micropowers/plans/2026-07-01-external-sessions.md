# 外部 tmux 会话接管 — Implementation Plan

**Goal:** 让 OmniTerm Sidebar 底部展示所有未被数据库记录的 tmux 会话，用户可将其「接管」到指定项目下，接管后与自创会话同等对待。

**Tech Stack:** Rust (Axum + sqlx + tokio), TypeScript (React + Zustand)

**Plan saved via:** micropowers/make-a-plan

---

### Task 1: Backend — `GET /sessions/external` + `POST /sessions/adopt`

**Files:** `modify src/api/sessions.rs`, `modify src/models/session.rs`

**Change:**

新增两个 endpoint，注册到 `routes()`：

1. `GET /sessions/external`
   - 调 `tmux::list_sessions()` 获取所有 tmux session
   - 查 `SELECT tmux_session_name FROM sessions` 拿到所有已记录的 name
   - 从全集中扣除已记录的，得到差集 `Vec<TmuxSessionInfo>`
   - 对每个外部 session 跑 `tmux::pane_cwd` 获取 CWD（失败时 CWD 为 `null`）
   - 返回 JSON：`{ sessions: [{ name, attached, windows, created, cwd, agent_kind, ... }] }`
   - 边界：tmux server 没跑 → 返回空数组（`list_sessions` 已处理）；所有 session 都已被接管 → 返回空数组

2. `POST /sessions/adopt`
   - 接收 `{ tmux_name: String, project_id: String }`
   - 验证 session 仍存在（调 `tmux::session_exists`），且未被接管（再次查 sessions 表防竞态）
   - 调 `tmux::pane_cwd` 获取 CWD 作为 `workspace_path`（失败则用 HOME 兜底）
   - 生成新 UUID，INSERT 到 sessions 表（`name`=`tmux_name`，`hook_enabled`=false，`created_at`=now）
   - 启动 activity monitor：`state.activity_monitor.ensure_session(&tmux_name)`
   - 返回 `(StatusCode::CREATED, Json(session))`
   - 错误：session 不存在 → 404；session 已被接管 → 409；project 不存在 → 404

新增 request DTO `AdoptSession` 到 `src/models/session.rs`。

**Verify:**
- [ ] `GET /sessions/external`：在没有外部 session 时返回空数组
- [ ] `GET /sessions/external`：手动 `tmux new-session -d -s test_external` 后出现在列表中，含 name/windows/attached/cwd
- [ ] `POST /sessions/adopt { tmux_name: "test_external", project_id: "<valid>" }`：返回 201 + Session JSON，session 出现在对应 project 下
- [ ] 再次 `GET /sessions/external`：已接管的 session 不再出现
- [ ] `POST /sessions/adopt` 重复接管同一个 session → 409
- [ ] `POST /sessions/adopt` 给不存在的 project → 404
- [ ] 现有 `GET /projects/{pid}/sessions` 测试（如有）仍然通过；现有 create/delete session 行为不变

---

### Task 2: Frontend — API client + 类型

**Files:** `modify frontend/src/api/client.ts`

**Change:**

新增 `ExternalSession` 接口：
```ts
export interface ExternalSession {
  name: string
  attached: boolean
  windows: number
  created: string
  cwd?: string
  agent_kind?: string
  agent_state?: string
  attention_reason?: string
  agent_event?: string
  agent_nonce?: string
}
```

在 `api` 对象中新增两个方法：
- `listExternalSessions: () => request<{ sessions: ExternalSession[] }>('/sessions/external')`
- `adoptSession: (tmuxName: string, projectId: string) => request<Session>('/sessions/adopt', { method: 'POST', body: JSON.stringify({ tmux_name: tmuxName, project_id: projectId }) })`

不新增 store state——Sidebar 用本地 `useState` 管理外部 session 列表。

**Verify:**
- [ ] TypeScript 编译通过（`npx tsc --noEmit`）
- [ ] 现有 `api.listSessions` / `api.createSession` 签名不变

---

### Task 3: Frontend — Sidebar 外部会话 UI

**Files:** `modify frontend/src/components/Sidebar/Sidebar.tsx`

**Change:**

在 Sidebar 项目列表下方、底部状态栏上方，新增「外部会话」折叠区域。

**状态管理（本地 useState，不入 appStore）：**
- `externalSessions: ExternalSession[]` — 当前外部 session 列表
- `externalExpanded: boolean` — 是否展开，默认折叠
- `adoptTarget: { tmux_name: string } | null` — 当前正在接管的 session
- `adoptProjectId: string` — 用户选择的目标 project ID

**布局：**
- 折叠态：一行文字 `外部会话 (N)`，右侧展开箭头 ▶
- 展开态：
  - 每行显示 session name、窗口数（`N windows`）、活动指示灯（attached → accent dot）
  - 右侧「接管」按钮（accent 色边框，hover 高亮）
  - 点击「接管」→ 行内展开项目下拉选择器 + 确认按钮（替代原本的「接管」按钮）
  - 确认后调 `api.adoptSession`，成功 → 从列表移除 + `loadSessions(adoptProjectId)` + toast

**数据加载：**
- `useEffect` 每 10 秒 `api.listExternalSessions()` 轮询（独立于已有 3 秒 session 轮询）
- 接管成功后立即刷新

**样式：** 遵循 `docs/visual-design/ui-style-guide.md` 的色板/间距/圆角约定（与现有 session 条目风格一致）。

**CWD 显示：** 在 session name 下方以小号灰色字显示 CWD 路径（截断）。

**Verify:**
- [ ] Sidebar 底部出现「外部会话 (N)」折叠区
- [ ] 没有外部 session 时不显示
- [ ] 展开后列出所有外部 session，含 name、窗口数、CWD
- [ ] 点击「接管」→ 显示 project 下拉 + 确认按钮
- [ ] 选择 project 并确认 → session 从外部列表消失，出现在对应 project 下
- [ ] 接管失败（如 session 已不存在）→ toast 错误提示
- [ ] 外部 session 出现在`tmux new-session -d` 后 10 秒内可被看到
- [ ] 折叠/展开状态正常切换
- [ ] 现有 Sidebar 行为（create/delete/rename/展开 project）不受影响

---

### Task 4: i18n 翻译

**Files:** `modify frontend/src/locales/en/translation.json`, `modify frontend/src/locales/zh/translation.json`

**Change:**

新增以下 key：

| Key | EN | ZH |
|---|---|---|
| `sidebar.externalSessions` | External Sessions | 外部会话 |
| `sidebar.externalSessionsCount` | External Sessions ({{n}}) | 外部会话 ({{n}}) |
| `sidebar.adopt` | Adopt | 接管 |
| `sidebar.adoptTitle` | Adopt Session | 接管会话 |
| `sidebar.adoptHint` | Select a project to adopt "{{name}}" into | 选择要将「{{name}}」接入的项目 |
| `sidebar.adoptSuccess` | Session "{{name}}" adopted | 会话「{{name}}」已接管 |
| `sidebar.adoptFailed` | Failed to adopt session: {{msg}} | 接管会话失败：{{msg}} |
| `sidebar.noExternalSessions` | No external sessions | 暂无外部会话 |

**对现有 key 的修改：** 无需改动（`sidebar.confirmDeleteSession` 已含终止 tmux 会话的提示）。

**Verify:**
- [ ] 切换语言后外部会话区域文案正确
- [ ] `{{n}}` / `{{name}}` / `{{msg}}` 插值正确渲染
- [ ] 现有翻译 key 没有被覆盖或删除

---

### Task 5: CHANGELOG

**Files:** `modify CHANGELOG.md`

**Change:** 在 Unreleased 区域新增条目描述外部 session 接管功能。
