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

  // Workspaces
  listWorkspaces: () => request<any[]>('/workspaces'),
  createWorkspace: (data: { name: string; root_path: string }) =>
    request('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) =>
    request(`/workspaces/${id}`, { method: 'DELETE' }),

  // Sessions
  listSessions: (workspaceId: string) =>
    request<any[]>(`/workspaces/${workspaceId}/sessions`),
  createSession: (workspaceId: string, name?: string) =>
    request(`/workspaces/${workspaceId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteSession: (id: string) =>
    request(`/sessions/${id}`, { method: 'DELETE' }),

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
}
