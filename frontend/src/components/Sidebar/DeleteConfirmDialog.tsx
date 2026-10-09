import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AgentSideDeleteResult, type Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { readDeleteAgentSidePref, writeDeleteAgentSidePref } from '../../utils/deleteAgentSidePref'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { buildAgentSideDeleteCheckbox, shouldRequestAgentSideDelete } from './agentSideDelete'

export interface DeleteTarget {
  type: 'project' | 'session'
  id: string
  name: string
  /**
   * 会话的运行时类型与进程驻留状态（`type === 'session'` 时才有意义）。
   * 决定是否显示「同时永久删除 agent 侧会话记录」勾选框——项目删除不带该框。
   */
  runtimeKind?: Session['runtime_kind']
  acpProcessAlive?: boolean
}

/**
 * Delete confirmation shared by projects and sessions. Holds its own
 * `submitting` state; store cleanup (clearing the active project/workspace/
 * session triple, workspace session memory) happens here via useAppStore.
 * The Sidebar only supplies the delete target and reload callbacks.
 *
 * ACP 会话额外带「同时永久删除 agent 侧会话记录」勾选框（红字，见
 * `agentSideDelete.ts` 的三态判据）：只有 `agent_side=deleted` 才算真删了，
 * `skipped` 必须如实告知用户（不可谎报已删）。
 */
export function DeleteConfirmDialog(props: {
  target: DeleteTarget | null          // null = 关闭
  onClose: () => void
  reloadProjects: () => Promise<void>  // Sidebar 侧 loadProjects
  reloadSessions: () => Promise<void>  // Sidebar 侧 loadSessions
  /** 会话删除成功后的附加刷新（Sidebar 用于同步已归档区块）。 */
  onSessionDeleted?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const workspaceSessionMemory = useAppStore((s) => s.workspaceSessionMemory)
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const setSessions = useAppStore((s) => s.setSessions)
  const clearWorkspaceSession = useAppStore((s) => s.clearWorkspaceSession)
  const agentDeleteSupported = useChatStore((s) =>
    props.target?.type === 'session' ? s.states[props.target.id]?.agentDeleteSupported : undefined,
  )
  const [submitting, setSubmitting] = useState(false)

  const target = props.target
  const isSession = target?.type === 'session'

  // 勾选框：仅 ACP 会话出现；默认值 = 用户上次的选择（记住偏好，不反复询问）
  const { checkbox, eligibleIds } =
    isSession && target?.runtimeKind === 'acp'
      ? buildAgentSideDeleteCheckbox({
          candidates: [{ id: target.id, runtime_kind: target.runtimeKind, acp_process_alive: target.acpProcessAlive }],
          capabilityOf: () => agentDeleteSupported,
          defaultChecked: readDeleteAgentSidePref(),
          t,
        })
      : { checkbox: undefined, eligibleIds: new Set<string>() }

  /** agent 侧删除的如实交代：只有 `deleted` 才说「已删除」。 */
  const reportAgentSide = (requested: boolean, result: AgentSideDeleteResult | undefined) => {
    if (!requested) return
    const outcome = result ?? 'not_requested'
    if (outcome === 'deleted') {
      addToast('success', t('sidebar.agentSideDeleted') ?? 'Agent-side session record deleted')
    } else if (outcome === 'skipped') {
      addToast('warning', t('sidebar.agentSideSkipped') ?? 'Session deleted, but the agent-side record was not')
    }
  }

  const handleDeleteProject = async () => {
    if (!target || target.type !== 'project') return
    setSubmitting(true)
    try {
      await api.deleteProject(target.id)
      await props.reloadProjects()
      if (activeProjectId === target.id) {
        setActiveProject(null)
        setActiveWorkspace(null)
        setSessions(target.id, [])
      }
      addToast('success', t('sidebar.projectDeleted', { name: target.name }) ?? `Project "${target.name}" deleted`)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      props.onClose()
    }
  }

  const handleDeleteSession = async (checked: boolean) => {
    if (!target || target.type !== 'session') return
    const deleteAgentSide = shouldRequestAgentSideDelete(eligibleIds, target.id, checked)
    // 记住用户的选择（勾选与取消都记）：仅在勾选框**可用**时记录——禁用态
    // 是系统的限制而非用户的表达，写进去会把「不支持」固化成偏好。
    const rememberChoice = !!checkbox && !checkbox.disabled
    setSubmitting(true)
    // Clear active session immediately so FileManager stops requesting
    // files for a session whose tmux process is about to be killed.
    if (activeSessionId === target.id) {
      setActiveSession(null)
    }
    try {
      const res = await api.deleteSession(target.id, { deleteAgentSide })
      // 确认成功后才记住偏好：删除失败时不该固化一个未生效的选择
      if (rememberChoice) writeDeleteAgentSidePref(checked)
      await props.reloadSessions()
      // 从「已归档」区块发起的删除也要把该行从归档列表里清掉
      await props.onSessionDeleted?.()
      // Clean workspace session memory for the deleted session
      for (const wsId of Object.keys(workspaceSessionMemory)) {
        if (workspaceSessionMemory[wsId] === target.id) {
          clearWorkspaceSession(wsId)
        }
      }
      addToast('success', t('sidebar.sessionDeleted', { name: target.name }) ?? `Session deleted`)
      reportAgentSide(deleteAgentSide, res?.agent_side)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      props.onClose()
    }
  }

  return (
    <ConfirmDialog
      open={!!target}
      onClose={props.onClose}
      onConfirm={target?.type === 'project' ? handleDeleteProject : () => void handleDeleteSession(false)}
      onConfirmWithChecked={
        checkbox ? (checked: boolean) => void handleDeleteSession(checked) : undefined
      }
      title={target?.type === 'project' ? (t('sidebar.deleteProject') ?? 'Remove Project from List') : t('sidebar.deleteSession')}
      message={
        target?.type === 'project'
          ? (t('sidebar.confirmDeleteProject', { name: target?.name }) ?? `Remove project "${target?.name}" from the list? Files on disk are not affected.`)
          : t('sidebar.confirmDeleteSession', { name: target?.name })
      }
      checkbox={checkbox}
      confirmText={target?.type === 'project' ? t('sidebar.remove') : t('sidebar.delete')}
      destructive={target?.type === 'session'}
      loading={submitting}
    />
  )
}
