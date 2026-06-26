import { useToastStore } from '../stores/toastStore'

const BASE = '/api/v1'

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const msg = body.error || `HTTP ${res.status}`
    useToastStore.getState().addToast('error', msg)
    throw new Error(msg)
  }

  return res.json()
}

export interface Project {
  id: string
  target_id?: string
  name: string
  path: string
  created_at: string
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
  // Agent state fields (from tmux @omniterm_agent option)
  agent_kind?: string
  agent_state?: string
  attention_reason?: string
  agent_event?: string
  agent_nonce?: string
  // Agent process detection (runtime scan, not hook-based)
  agent_detected?: string
}

export const api = {
  // Health
  health: () => request<{ status: string }>('/health'),

  // System
  systemInfo: () => request<{ home_dir: string }>('/system/info'),

  // Auth
  setup: (password: string) =>
    request('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  check: () => request<{ authenticated: boolean }>('/auth/check'),

  // Projects (formerly workspaces)
  listProjects: () => request<Project[]>('/projects'),
  createProject: (data: { name: string; path: string; target_id?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name?: string }) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request(`/projects/${id}`, { method: 'DELETE' }),

  // Worktrees (real-time git worktree discovery)
  listWorktrees: (projectId: string) =>
    request<Workspace[]>(`/projects/${projectId}/worktrees`),

  // Sessions
  listSessions: (projectId: string) =>
    request<Session[]>(`/projects/${projectId}/sessions`),
  createSession: (projectId: string, workspacePath: string, name?: string, command?: string) =>
    request<Session>(`/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name, workspace_path: workspacePath, command }),
    }),
  deleteSession: (id: string) =>
    request(`/sessions/${id}`, { method: 'DELETE' }),

  // Session CWD
  getSessionCwd: (sessionId: string) =>
    request<{ cwd: string }>(`/sessions/${sessionId}/cwd`),

  // Hooks
  hookStatus: (sessionId: string) =>
    request<any>(`/sessions/${sessionId}/hook-status`),
  hookEnable: (sessionId: string) =>
    request(`/sessions/${sessionId}/hook-enable`, { method: 'POST' }),
  hookDisable: (sessionId: string) =>
    request(`/sessions/${sessionId}/hook-disable`, { method: 'POST' }),

  // Files
  listFiles: (workspace: string, path?: string, sort?: string, desc?: boolean) => {
    let url = `/files?workspace=${workspace}&path=${path || ''}`
    if (sort) url += `&sort=${sort}`
    if (desc) url += `&order=desc`
    return request<any[]>(url)
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
    request<any[]>(`/files/search?workspace=${workspace}&q=${encodeURIComponent(query)}&path=${path || ''}`),

  // Files by session (follows terminal CWD)
  listFilesBySession: (sessionId: string, path?: string, sort?: string, desc?: boolean) => {
    let url = `/files?session=${sessionId}&path=${path || ''}`
    if (sort) url += `&sort=${sort}`
    if (desc) url += `&order=desc`
    return request<{ files: any[]; cwd: string; is_outside_workspace: boolean }>(url)
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
    request<any[]>(`/files/search?session=${sessionId}&q=${encodeURIComponent(query)}&path=${path || ''}`),
  readFileBySession: (sessionId: string, path: string) =>
    request<{ content: string }>(`/files/read?session=${sessionId}&path=${encodeURIComponent(path)}`),
  writeFileBySession: (sessionId: string, path: string, content: string) =>
    request(`/files/write?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
}
