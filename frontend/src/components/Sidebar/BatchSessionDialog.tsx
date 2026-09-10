import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { ConfirmDialog } from '../Modal/ConfirmDialog'

export type BatchAction = 'archive' | 'release' | 'delete'

export interface BatchTarget {
  action: BatchAction
  sessions: Session[]
}

/**
 * 批量会话操作的二次确认 + 执行。
 *
 * - 归档 / 释放仅作用于 ACP 会话（后端对非 ACP 返回 400）；终端会话被跳过，
 *   有跳过项时在 message 中另起一行提示。
 * - 串行执行、单条失败继续（错误 toast 由 api client 自动弹出），结束按成功
 *   数汇总；副作用逐条复刻单条路径（活跃会话清理 / markEnded /
 *   workspaceSessionMemory），见 DeleteConfirmDialog / releaseSessionNow。
 * - `submitting` 期间 onClose 守卫为 no-op：Modal 的 Esc / 遮罩 / ✕ 都走这里，
 *   防止执行中关闭弹窗。
 */
export function BatchSessionDialog(props: {
  /** null = 关闭。 */
  target: BatchTarget | null
  onClose: () => void
  /** 成功执行 ≥1 条后调用：刷新列表并退出选择模式（Sidebar 提供）。 */
  onDone: () => Promise<void>
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const workspaceSessionMemory = useAppStore((s) => s.workspaceSessionMemory)
  const clearWorkspaceSession = useAppStore((s) => s.clearWorkspaceSession)
  const [submitting, setSubmitting] = useState(false)

  const target = props.target
  const action: BatchAction = target?.action ?? 'archive'
  const sessions = target?.sessions ?? []
  // 归档 / 释放池 = ACP 会话（release 对已释放会话幂等返回 200，无需按 alive 过滤）
  const pool = action === 'delete' ? sessions : sessions.filter((s) => s.runtime_kind === 'acp')
  const skipped = sessions.length - pool.length

  const title =
    action === 'archive'
      ? t('sidebar.batchArchiveTitle')
      : action === 'release'
        ? t('sidebar.batchReleaseTitle')
        : t('sidebar.batchDeleteTitle')

  const baseMessage =
    action === 'archive'
      ? t('sidebar.batchArchiveConfirm', { count: pool.length })
      : action === 'release'
        ? t('sidebar.batchReleaseConfirm', { count: pool.length })
        : t('sidebar.batchDeleteConfirm', { count: pool.length })
  // 跳过提示另起一行（ConfirmDialog 的 message 走 whiteSpace: pre-line）
  const message =
    skipped > 0
      ? `${baseMessage}\n${t('sidebar.batchSkipUnsupported', { count: skipped })}`
      : baseMessage

  const handleConfirm = async () => {
    if (!target) return
    setSubmitting(true)
    const ids = new Set(pool.map((s) => s.id))
    // 删除前先清活跃会话：停止 FileManager 等对即将被 kill 的会话的请求
    // （与 DeleteConfirmDialog.handleDeleteSession 同一顺序约定）
    if (action === 'delete' && activeSessionId && ids.has(activeSessionId)) {
      setActiveSession(null)
    }
    let succeeded = 0
    // 串行执行：避免 SQLite 写竞争与批量杀进程竞态（对齐 DuplicateProjectsDialog 先例）
    for (const session of pool) {
      try {
        if (action === 'archive') {
          await api.archiveSession(session.id)
          if (session.id === activeSessionId) setActiveSession(null)
        } else if (action === 'release') {
          await api.releaseSession(session.id)
          // 释放活跃会话：立即标记结束，使 ChatView 即时显示「恢复会话」
          if (session.id === activeSessionId) useChatStore.getState().markEnded(session.id)
        } else {
          await api.deleteSession(session.id)
          for (const wsId of Object.keys(workspaceSessionMemory)) {
            if (workspaceSessionMemory[wsId] === session.id) clearWorkspaceSession(wsId)
          }
        }
        succeeded += 1
      } catch {
        // 单条失败继续执行；错误 toast 由 api client 自动弹出
      }
    }
    if (succeeded > 0) {
      addToast('success', t('sidebar.batchDone', { count: succeeded }) ?? `Processed ${succeeded} session(s)`)
      await props.onDone()
    }
    setSubmitting(false)
    props.onClose()
  }

  return (
    <ConfirmDialog
      open={!!target}
      onClose={() => {
        if (!submitting) props.onClose()
      }}
      onConfirm={handleConfirm}
      title={title}
      message={message}
      confirmText={action === 'release' ? t('sidebar.batchRelease') : action === 'archive' ? t('sidebar.archive') : t('sidebar.delete')}
      destructive={action === 'delete'}
      loading={submitting}
    />
  )
}
