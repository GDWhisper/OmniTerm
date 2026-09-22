import { api, ApiError } from '../../api/client'

/**
 * 「在此打开终端」创建流的共享步骤——两个弹窗共用，勿在组件里各写一份：
 * - `OpenTerminalDialog`（目录无归属项目）：主路径「创建项目并打开」；
 * - `OpenTerminalConfirmDialog`（目录有归属项目）：「创建新项目并打开终端」
 *   备选项（展示路径在侧栏无同根项目时才出现）。
 *
 * 语义约束：
 * - 新建项目恒以浏览目录为根（「在此」语义），默认项目名取目录 basename；
 * - 后端 409 `already_covered`（精确路径 / 同仓库 worktree，前端前缀探测看不到）
 *   时回退到覆盖项目——`created: false`，调用方据此跳过侧栏项目列表刷新；
 * - 会话创建不走本模块：调用方直接
 *   `api.createSession(projectId, cwd, undefined, undefined, engine)`，
 *   引擎由调用方经 `useTerminalEngine()` 收敛后传入（本模块不判复用器可用性）。
 */

/**
 * 默认项目名 = 目录 basename。`filter(Boolean)` 丢空段（尾随斜杠/`//`），
 * `?? cwd` 兜 `/'` 这类无 basename 的路径——两处弹窗预填同一规则。
 */
export function projectNameFromPath(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/**
 * 以 `cwd` 为根创建项目。后端 409 already_covered 时改返回覆盖项目 id
 * （`created: false`，调用方无需刷新侧栏项目列表）；其它错误原样抛出
 * （api client 已弹错误 toast，调用方 catch 后静默收尾）。
 */
export async function createProjectForDir(
  cwd: string,
  name: string,
): Promise<{ projectId: string; created: boolean }> {
  try {
    const project = await api.createProject({ name, path: cwd })
    return { projectId: project.id, created: true }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const body = e.body as Record<string, unknown> | undefined
      const covering =
        body?.error === 'already_covered'
          ? (body.covering_project as { id: string } | undefined)
          : undefined
      if (covering) return { projectId: covering.id, created: false }
    }
    throw e
  }
}
