import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { ConfirmDialog } from '../Modal/ConfirmDialog'

export interface DeleteTarget {
  type: 'project' | 'session'
  id: string
  name: string
}

/**
 * Delete confirmation shared by projects and sessions. Holds its own
 * `submitting` state; store cleanup (clearing the active project/workspace/
 * session triple, workspace session memory) happens here via useAppStore.
 * The Sidebar only supplies the delete target and reload callbacks.
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
  const [submitting, setSubmitting] = useState(false)

  const target = props.target

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

  const handleDeleteSession = async () => {
    if (!target || target.type !== 'session') return
    setSubmitting(true)
    // Clear active session immediately so FileManager stops requesting
    // files for a session whose tmux process is about to be killed.
    if (activeSessionId === target.id) {
      setActiveSession(null)
    }
    try {
      await api.deleteSession(target.id)
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
      onConfirm={target?.type === 'project' ? handleDeleteProject : handleDeleteSession}
      title={target?.type === 'project' ? (t('sidebar.deleteProject') ?? 'Remove Project from List') : t('sidebar.deleteSession')}
      message={
        target?.type === 'project'
          ? (t('sidebar.confirmDeleteProject', { name: target?.name }) ?? `Remove project "${target?.name}" from the list? Files on disk are not affected.`)
          : t('sidebar.confirmDeleteSession', { name: target?.name })
      }
      confirmText={target?.type === 'project' ? t('sidebar.remove') : t('sidebar.delete')}
      destructive={target?.type === 'session'}
      loading={submitting}
    />
  )
}
