import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AgentSideDeleteResult, type Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { readDeleteAgentSidePref, writeDeleteAgentSidePref } from '../../utils/deleteAgentSidePref'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { buildAgentSideDeleteCheckbox, shouldRequestAgentSideDelete } from './agentSideDelete'

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
 * - 批量删除额外带「同时永久删除 agent 侧会话记录」勾选框：**逐条**判据（能力
 *   已知支持且进程驻留才带 `delete_agent_side=true`），所以混合选择也不会对
 *   不满足条件的会话盲发。
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
  // 每个会话的能力位（capabilities 帧写入）；整对象订阅后按键取用。
  // 选择器返回 states 引用：帧到达时必然变化，够用且不额外分配。
  const chatStates = useChatStore((s) => s.states)
  const [submitting, setSubmitting] = useState(false)

  const target = props.target
  const action: BatchAction = target?.action ?? 'archive'
  const sessions = target?.sessions ?? []
  // 归档 / 释放池 = ACP 会话（release 对已释放会话幂等返回 200，无需按 alive 过滤）
  const pool = action === 'delete' ? sessions : sessions.filter((s) => s.runtime_kind === 'acp')
  const skipped = sessions.length - pool.length

  // agent 侧删除勾选框：仅批量删除出现，且仅当选中项含 ACP 会话
  const { checkbox, eligibleIds } =
    action === 'delete'
      ? buildAgentSideDeleteCheckbox({
          candidates: pool.map((s) => ({
            id: s.id,
            runtime_kind: s.runtime_kind,
            acp_process_alive: s.acp_process_alive,
          })),
          capabilityOf: (id) => chatStates[id]?.agentDeleteSupported,
          defaultChecked: readDeleteAgentSidePref(),
          t,
        })
      : { checkbox: undefined, eligibleIds: new Set<string>() }

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

  const handleConfirm = async (agentSideChecked: boolean) => {
    if (!target) return
    setSubmitting(true)
    const ids = new Set(pool.map((s) => s.id))
    // 删除前先清活跃会话：停止 FileManager 等对即将被 kill 的会话的请求
    // （与 DeleteConfirmDialog.handleDeleteSession 同一顺序约定）
    if (action === 'delete' && activeSessionId && ids.has(activeSessionId)) {
      setActiveSession(null)
    }
    let succeeded = 0
    // agent 侧删除的如实交代：deleted / skipped 分开计数（不可把跳过报成已删）
    let agentSideDeleted = 0
    let agentSideSkipped = 0
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
          const deleteAgentSide = shouldRequestAgentSideDelete(
            eligibleIds,
            session.id,
            agentSideChecked,
          )
          const res: { agent_side?: AgentSideDeleteResult } = await api.deleteSession(session.id, {
            deleteAgentSide,
          })
          if (deleteAgentSide) {
            if (res?.agent_side === 'deleted') agentSideDeleted += 1
            else agentSideSkipped += 1
          }
          for (const wsId of Object.keys(workspaceSessionMemory)) {
            if (workspaceSessionMemory[wsId] === session.id) clearWorkspaceSession(wsId)
          }
        }
        succeeded += 1
      } catch {
        // 单条失败继续执行；错误 toast 由 api client 自动弹出
      }
    }
    // 记住用户的选择：仅在勾选框可用时（禁用态是系统限制，不是用户表达）
    if (action === 'delete' && checkbox && !checkbox.disabled) {
      writeDeleteAgentSidePref(agentSideChecked)
    }
    if (succeeded > 0) {
      addToast('success', t('sidebar.batchDone', { count: succeeded }) ?? `Processed ${succeeded} session(s)`)
      if (agentSideDeleted > 0) {
        addToast('success', t('sidebar.agentSideDeletedCount', { count: agentSideDeleted }))
      }
      if (agentSideSkipped > 0) {
        addToast('warning', t('sidebar.agentSideSkippedCount', { count: agentSideSkipped }))
      }
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
      onConfirm={() => void handleConfirm(false)}
      onConfirmWithChecked={checkbox ? (checked: boolean) => void handleConfirm(checked) : undefined}
      title={title}
      message={message}
      checkbox={checkbox}
      confirmText={action === 'release' ? t('sidebar.batchRelease') : action === 'archive' ? t('sidebar.archive') : t('sidebar.delete')}
      destructive={action === 'delete'}
      loading={submitting}
    />
  )
}
