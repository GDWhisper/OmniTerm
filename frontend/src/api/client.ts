import { useToastStore } from '../stores/toastStore'
import { useAppStore } from '../stores/appStore'

const BASE = '/api/v1'

/**
 * Error thrown by `request` for non-2xx responses. Carries the HTTP status
 * and the parsed JSON body so callers can react to specific codes
 * (e.g. 409 Conflict on `/projects`).
 */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, opts?: RequestInit & { silent?: boolean }): Promise<T> {
  const authVersion = useAppStore.getState().authVersion
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 401) {
      const state = useAppStore.getState()
      if (state.authState === 'authenticated' && state.authVersion === authVersion) {
        useAppStore.getState().setAuthState('unauthenticated')
      }
    }
    const msg = body.error || `HTTP ${res.status}`
    if (!opts?.silent) {
      useToastStore.getState().addToast('error', msg)
    }
    throw new ApiError(res.status, body, msg)
  }

  return res.json()
}

export interface Project {
  id: string
  target_id?: string
  name: string
  path: string
  created_at: string
  /** Whether the project path currently exists on disk (computed server-side). */
  path_valid: boolean
}

/** One project inside a duplicate group. */
export interface DuplicateProject {
  id: string
  name: string
  path: string
  created_at: string
  session_count: number
}

/** Group of projects that share coverage of the same git repo (or exact path). */
export interface DuplicateGroup {
  group_id: string
  /** "shared_toplevel" or "exact_path" */
  reason: string
  projects: DuplicateProject[]
}

// Minimal file entry shape returned by /files and /system/dirs.
// Kept here (not in a component file) so both FileManager and
// the new-project modal can use the same type without coupling.
export interface FileEntry {
  path_type: 'Dir' | 'File' | 'SymlinkDir' | 'SymlinkFile'
  name: string
  mtime: number
  size: number | null
  /** 相对搜索根的路径，仅 /files/search 返回。 */
  rel_path?: string
}

export interface Workspace {
  id: string
  project_id: string
  path: string
  label: string
  branch?: string
  is_main: boolean
  is_git_repo: boolean
  is_git_worktree: boolean
}

export interface Session {
  id: string
  project_id: string
  workspace_path: string
  name?: string
  tmux_session_name?: string
  hook_enabled: boolean
  hook_status?: string
  created_at: string
  // Runtime discriminator: 'tmux' = tmux-backed pane, 'acp' = ACP adapter subprocess
  runtime_kind: 'tmux' | 'acp'
  // ACP adapter session id; present only when runtime_kind='acp'
  acp_session_id?: string
  // Agent config id (from `agents` table); present when runtime_kind='acp'
  agent_id?: string
  // Runtime activity indicator (tmux control mode)
  is_active?: boolean
  // ACP agent subprocess currently resident in the backend supervisor.
  // true = process alive (can chat directly); false = released/reaped (restore to resume).
  acp_process_alive?: boolean
  // Agent state fields (from tmux @omniterm_agent option)
  agent_kind?: string
  agent_state?: string
  attention_reason?: string
  agent_event?: string
  agent_nonce?: string
  // Agent process detection (runtime scan, not hook-based)
  agent_detected?: string
}

export interface AgentEnvVar {
  key: string
  value: string
}

/**
 * Agent configuration (row in `agents` table). Describes how to spawn an
 * ACP-compatible agent subprocess: the executable, its argv, and env vars.
 * Credential management is the agent's own responsibility — OmniTerm only
 * spawns the process and speaks ACP over its stdio.
 */
export interface Agent {
  id: string
  display_name: string
  command: string
  args: string[]
  env: AgentEnvVar[]
  npm_package?: string
  created_at: string
  updated_at: string
}

export interface CreateAgent {
  id?: string
  display_name: string
  command: string
  args?: string[]
  env?: AgentEnvVar[]
  npm_package?: string
}

export interface UpdateAgent {
  display_name?: string
  command?: string
  args?: string[]
  env?: AgentEnvVar[]
  npm_package?: string | null
}

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

export const api = {
  // Health
  health: () => request<{ status: string }>('/health'),

  // System
  systemInfo: () => request<{ home_dir: string; multiplexer?: string }>('/system/info'),
  listDirs: (path: string) =>
    request<{ files: FileEntry[] }>(`/system/dirs?path=${encodeURIComponent(path)}`, { silent: true }),
  pathExists: (path: string) =>
    request<{ exists: boolean }>(`/system/exists?path=${encodeURIComponent(path)}`),
  versionCheck: () =>
    request<{ current: string; latest: string; update_available: boolean; channel: 'npm' | 'cargo' | 'github_release' }>('/system/version', { silent: true }),
  systemUpdate: () =>
    request<{ status: string; version: string; restart_required: boolean }>('/system/update', { method: 'POST' }),

  // tmux options
  tmuxGetMouse: () =>
    request<{ enabled: boolean }>('/system/tmux/mouse'),
  tmuxSetMouse: (enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>('/system/tmux/mouse', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // Settings
  getAcpIdleRecycle: () =>
    request<{ minutes: number }>('/settings/acp-idle-recycle'),
  setAcpIdleRecycle: (minutes: number) =>
    request<{ minutes: number }>('/settings/acp-idle-recycle', {
      method: 'PUT',
      body: JSON.stringify({ minutes }),
    }),

  // Auth
  setup: (password: string) =>
    request('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  check: () => request<{ authenticated: boolean; needs_setup?: boolean; auth_enabled?: boolean }>('/auth/check'),
  setAuthSettings: (authEnabled: boolean) =>
    request('/auth/settings', { method: 'POST', body: JSON.stringify({ auth_enabled: authEnabled }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),

  // Projects (formerly workspaces)
  listProjects: () => request<Project[]>('/projects'),
  createProject: (data: { name: string; path: string; target_id?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name?: string; path?: string }) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request(`/projects/${id}`, { method: 'DELETE' }),

  /** Find groups of projects that share a git toplevel (or exact path). */
  listDuplicates: () =>
    request<DuplicateGroup[]>('/projects/duplicates'),
  /** Merge source project `id` into `target_id` (moves sessions, deletes source). */
  mergeProject: (id: string, targetId: string) =>
    request<{ ok: true; merged_into: string }>(
      `/projects/${id}/merge-into/${targetId}`,
      { method: 'POST' },
    ),

  // Worktrees (real-time git worktree discovery)
  listWorktrees: (projectId: string) =>
    request<Workspace[]>(`/projects/${projectId}/worktrees`),
  createWorktree: (projectId: string, data: { branch: string; path?: string; base_branch?: string; detach?: boolean; init?: boolean }) =>
    request<Workspace>(`/projects/${projectId}/worktrees`, {
      method: 'POST',
      body: JSON.stringify(data),
      silent: true, // caller handles the not_a_git_repo prompt / error toast
    }),
  deleteWorktree: (projectId: string, path: string) =>
    request<{ ok: true }>(`/projects/${projectId}/worktrees?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  listBranches: (projectId: string) =>
    request<{ branches: string[]; current: string }>(`/projects/${projectId}/branches`, { silent: true }),
  initGit: (projectId: string) =>
    request<{ ok: true }>(`/projects/${projectId}/git-init`, { method: 'POST' }),

  // Sessions
  listSessions: (projectId: string) =>
    request<Session[]>(`/projects/${projectId}/sessions`),
  createSession: (
    projectId: string,
    workspacePath: string,
    name?: string,
    command?: string,
    runtimeKind?: 'tmux' | 'acp',
    agentId?: string,
  ) =>
    request<Session>(`/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        workspace_path: workspacePath,
        command,
        runtime_kind: runtimeKind,
        agent_id: agentId,
      }),
    }),
  updateSession: (id: string, data: { name?: string }) =>
    request<Session>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSession: (id: string) =>
    request(`/sessions/${id}`, { method: 'DELETE' }),
  /** Release a running ACP agent subprocess without deleting the session record. */
  releaseSession: (id: string) =>
    request(`/sessions/${id}/release`, { method: 'POST' }),
  /** Send a user prompt to an ACP session. Returns the model's stop reason. */
  sendPrompt: (sessionId: string, text: string) =>
    request<{ stop_reason?: string }>(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // Agents (ACP-compatible agent process configurations)
  listAgents: () => request<Agent[]>('/agents'),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  createAgent: (data: CreateAgent) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: UpdateAgent) =>
    request<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request(`/agents/${id}`, { method: 'DELETE' }),
  testAgent: (id: string) =>
    request<{ ok: boolean }>(`/agents/${id}/test`, { method: 'POST' }),
  testAgentRaw: (data: CreateAgent) =>
    request<{ ok: boolean }>('/agents/test-raw', { method: 'POST', body: JSON.stringify(data) }),

  // Session CWD
  getSessionCwd: (sessionId: string) =>
    request<{ cwd: string }>(`/sessions/${sessionId}/cwd`),

  // External sessions (not yet adopted into any project)
  listExternalSessions: () =>
    request<{ sessions: ExternalSession[] }>('/sessions/external', { silent: true }),
  adoptSession: (tmuxName: string, projectId: string) =>
    request<Session>('/sessions/adopt', {
      method: 'POST',
      body: JSON.stringify({ tmux_name: tmuxName, project_id: projectId }),
    }),

  // Hooks
  hookStatus: (sessionId: string) =>
    request<unknown>(`/sessions/${sessionId}/hook-status`),
  hookEnable: (sessionId: string) =>
    request(`/sessions/${sessionId}/hook-enable`, { method: 'POST' }),
  hookDisable: (sessionId: string) =>
    request(`/sessions/${sessionId}/hook-disable`, { method: 'POST' }),

  // Files
  listFiles: (workspace: string, path?: string, sort?: string, desc?: boolean) => {
    let url = `/files?workspace=${workspace}&path=${path || ''}`
    if (sort) url += `&sort=${sort}`
    if (desc) url += `&order=desc`
    return request<FileEntry[]>(url)
  },
  deleteFile: (workspace: string, path: string) =>
    request(`/files?workspace=${workspace}&path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  uploadFile: (workspace: string, path: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`/api/v1/files?workspace=${workspace}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: form,
    }).then((r) => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
      return r.json()
    })
  },
  downloadUrl: (workspace: string, path: string) =>
    `/api/v1/files/download?workspace=${workspace}&path=${encodeURIComponent(path)}`,
  downloadUrlBySession: (sessionId: string, path: string) =>
    `/api/v1/files/download?session=${sessionId}&path=${encodeURIComponent(path)}`,
  readFile: (workspace: string, path: string) =>
    request<{ content: string }>(`/files/read?workspace=${workspace}&path=${encodeURIComponent(path)}`),
  writeFile: (workspace: string, path: string, content: string) =>
    request(`/files/write?workspace=${workspace}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  mkdir: (workspace: string, path: string, name: string) =>
    request('/files/mkdir', { method: 'POST', body: JSON.stringify({ path, name, workspace }) }),
  rename: (workspace: string, path: string, newName: string) =>
    request('/files/rename', { method: 'POST', body: JSON.stringify({ path, newName, workspace }) }),
  moveFiles: (workspace: string, paths: string[], destination: string) =>
    request('/files/move', { method: 'POST', body: JSON.stringify({ paths, destination, workspace }) }),
  copyFiles: (workspace: string, paths: string[], destination: string) =>
    request('/files/copy', { method: 'POST', body: JSON.stringify({ paths, destination, workspace }) }),
  searchFiles: (workspace: string, query: string, path?: string) =>
    request<FileEntry[]>(`/files/search?workspace=${workspace}&q=${encodeURIComponent(query)}&path=${path || ''}`),

  // Files by session (follows terminal CWD)
  listFilesBySession: (sessionId: string, path?: string, sort?: string, desc?: boolean) => {
    let url = `/files?session=${sessionId}&path=${path || ''}`
    if (sort) url += `&sort=${sort}`
    if (desc) url += `&order=desc`
    return request<{ files: FileEntry[]; cwd: string; is_outside_workspace: boolean }>(url)
  },
  uploadFileBySession: (sessionId: string, path: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`/api/v1/files?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: form,
    }).then((r) => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
      return r.json()
    })
  },
  deleteFileBySession: (sessionId: string, path: string) =>
    request(`/files?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  mkdirBySession: (sessionId: string, path: string, name: string) =>
    request('/files/mkdir', { method: 'POST', body: JSON.stringify({ path, name, session: sessionId }) }),
  renameBySession: (sessionId: string, path: string, newName: string) =>
    request('/files/rename', { method: 'POST', body: JSON.stringify({ path, newName, session: sessionId }) }),
  searchFilesBySession: (sessionId: string, query: string, path?: string) =>
    request<FileEntry[]>(`/files/search?session=${sessionId}&q=${encodeURIComponent(query)}&path=${path || ''}`),
  readFileBySession: (sessionId: string, path: string) =>
    request<{ content: string }>(`/files/read?session=${sessionId}&path=${encodeURIComponent(path)}`),
  writeFileBySession: (sessionId: string, path: string, content: string) =>
    request(`/files/write?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  // Generic file methods — support session or workspaceId (choose one)
  listFiles2: (params: { session?: string; workspaceId?: string; projectId?: string; path?: string; sort?: string; desc?: boolean }) => {
    let url = `/files?path=${params.path || ''}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    if (params.sort) url += `&sort=${params.sort}`
    if (params.desc) url += `&order=desc`
    return request<{ files: FileEntry[]; cwd: string; is_outside_workspace: boolean; workspace_root?: string }>(url)
  },
  deleteFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; allowEscape?: boolean }) => {
    let url = `/files?path=${encodeURIComponent(params.path)}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    if (params.allowEscape) url += `&allow_escape=true`
    return request(url, { method: 'DELETE' })
  },
  uploadFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; file: File; allowEscape?: boolean }) => {
    const form = new FormData()
    form.append('file', params.file)
    let url = `/api/v1/files?path=${encodeURIComponent(params.path)}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    if (params.allowEscape) url += `&allow_escape=true`
    return fetch(url, { method: 'POST', body: form }).then((r) => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
      return r.json()
    })
  },
  downloadUrl2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string }) => {
    let url = `/api/v1/files/download?path=${encodeURIComponent(params.path)}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    return url
  },
  readFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string }) => {
    let url = `/files/read?path=${encodeURIComponent(params.path)}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    return request<{ content: string | null; is_text: boolean }>(url)
  },
  writeFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; content: string; allowEscape?: boolean }) => {
    let url = `/files/write?path=${encodeURIComponent(params.path)}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    if (params.allowEscape) url += `&allow_escape=true`
    return request(url, { method: 'POST', body: JSON.stringify({ content: params.content }) })
  },
  mkdir2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; name: string; allowEscape?: boolean }) => {
    const body: { path: string; name: string; session?: string; workspace_id?: string; workspace?: string } = {
      path: params.path,
      name: params.name,
    }
    if (params.session) body.session = params.session
    if (params.workspaceId) body.workspace_id = params.workspaceId
    if (params.projectId) body.workspace = params.projectId
    let url = '/files/mkdir'
    if (params.allowEscape) url += '?allow_escape=true'
    return request(url, { method: 'POST', body: JSON.stringify(body) })
  },
  rename2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; newName: string; allowEscape?: boolean }) => {
    const body: { path: string; newName: string; session?: string; workspace_id?: string; workspace?: string } = {
      path: params.path,
      newName: params.newName,
    }
    if (params.session) body.session = params.session
    if (params.workspaceId) body.workspace_id = params.workspaceId
    if (params.projectId) body.workspace = params.projectId
    let url = '/files/rename'
    if (params.allowEscape) url += '?allow_escape=true'
    return request(url, { method: 'POST', body: JSON.stringify(body) })
  },
  moveFiles2: (params: { session?: string; workspaceId?: string; projectId?: string; paths: string[]; destination: string; allowEscape?: boolean }) => {
    const body: { paths: string[]; destination: string; session?: string; workspace_id?: string; workspace?: string } = {
      paths: params.paths,
      destination: params.destination,
    }
    if (params.session) body.session = params.session
    if (params.workspaceId) body.workspace_id = params.workspaceId
    if (params.projectId) body.workspace = params.projectId
    let url = '/files/move'
    if (params.allowEscape) url += '?allow_escape=true'
    return request(url, { method: 'POST', body: JSON.stringify(body) })
  },
  searchFiles2: (params: { session?: string; workspaceId?: string; projectId?: string; query: string; path?: string }) => {
    let url = `/files/search?q=${encodeURIComponent(params.query)}&path=${params.path || ''}`
    if (params.session) url += `&session=${params.session}`
    if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
    if (params.projectId) url += `&workspace=${params.projectId}`
    return request<FileEntry[]>(url)
  },

  // ── Git panel (docs/dev/plans/2026-07-26-git-panel.md ADR-2: repo bound
  //    to session/workspace id only; the backend resolves the repo root) ──
  gitStatus: (bind: GitBind) =>
    request<GitStatus>(`/git/status?${gitBindQuery(bind)}`, { silent: true }),
  gitDiff: (bind: GitBind, params: { path: string; staged?: boolean; untracked?: boolean }) => {
    let url = `/git/diff?${gitBindQuery(bind)}&path=${encodeURIComponent(params.path)}`
    if (params.staged) url += '&staged=true'
    if (params.untracked) url += '&untracked=true'
    return request<{ diff: string; truncated: boolean; root: string }>(url)
  },
  gitLog: (bind: GitBind, params: { skip?: number; limit?: number }) =>
    request<{ entries: GitLogEntry[]; has_more: boolean } | { is_repo: false }>(
      `/git/log?${gitBindQuery(bind)}&skip=${params.skip ?? 0}&limit=${params.limit ?? 50}`,
    ),
  gitShow: (bind: GitBind, sha: string) =>
    request<GitCommitDetail>(`/git/show?${gitBindQuery(bind)}&sha=${encodeURIComponent(sha)}`),
  gitBranches: (bind: GitBind) =>
    request<{ branches: GitBranch[] } | { is_repo: false }>(`/git/branches?${gitBindQuery(bind)}`),
  gitStage: (bind: GitBind, paths: string[]) =>
    request('/git/stage', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), paths }), silent: true }),
  gitUnstage: (bind: GitBind, paths: string[]) =>
    request('/git/unstage', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), paths }), silent: true }),
  gitCommit: (bind: GitBind, message: string) =>
    request('/git/commit', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), message }), silent: true }),
  gitDiscard: (bind: GitBind, files: { path: string; untracked: boolean }[]) =>
    request('/git/discard', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), files }), silent: true }),
  gitCheckout: (bind: GitBind, branch: string) =>
    request('/git/checkout', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), branch }), silent: true }),
  gitCreateBranch: (bind: GitBind, name: string) =>
    request('/git/branch', { method: 'POST', body: JSON.stringify({ ...gitBindBody(bind), name }), silent: true }),
  gitPush: (bind: GitBind) =>
    request('/git/push', { method: 'POST', body: JSON.stringify(gitBindBody(bind)), silent: true }),
  gitPull: (bind: GitBind) =>
    request('/git/pull', { method: 'POST', body: JSON.stringify(gitBindBody(bind)), silent: true }),
  gitFetch: (bind: GitBind) =>
    request('/git/fetch', { method: 'POST', body: JSON.stringify(gitBindBody(bind)), silent: true }),
}

// ── Git panel types ──
export interface GitBind {
  session?: string
  workspaceId?: string
  projectId?: string
}

function gitBindQuery(bind: GitBind): string {
  const parts: string[] = []
  if (bind.session) parts.push(`session=${bind.session}`)
  if (bind.workspaceId) parts.push(`workspace_id=${bind.workspaceId}`)
  if (bind.projectId) parts.push(`workspace=${bind.projectId}`)
  return parts.join('&')
}

function gitBindBody(bind: GitBind): { session?: string; workspace_id?: string; workspace?: string } {
  return {
    ...(bind.session ? { session: bind.session } : {}),
    ...(bind.workspaceId ? { workspace_id: bind.workspaceId } : {}),
    ...(bind.projectId ? { workspace: bind.projectId } : {}),
  }
}

export interface GitStatusEntry {
  path: string
  orig_path?: string
  index_status: string
  worktree_status: string
  conflicted: boolean
}

export interface GitStatus {
  is_repo: boolean
  repo_root?: string
  branch?: string | null
  detached?: boolean
  upstream?: string | null
  ahead?: number
  behind?: number
  entries?: GitStatusEntry[]
}

export interface GitLogEntry {
  sha: string
  short_sha: string
  author: string
  date: string
  subject: string
}

export interface GitCommitDetail {
  sha: string
  short_sha: string
  author: string
  email: string
  date: string
  message: string
  diff: string
  truncated: boolean
}

export interface GitBranch {
  name: string
  current: boolean
}
