import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { inputClass, inputStyle } from './sidebarModalStyles'

export interface RenameTarget {
  type: 'project' | 'session'
  id: string
  name: string
}

/**
 * Rename dialog shared by projects and sessions. Holds its own form state
 * (`renameName` / `submitting`); the Sidebar only supplies the rename target
 * and a reload callback for the renamed entity type.
 */
export function RenameDialog(props: {
  target: RenameTarget | null          // null = 关闭
  onClose: () => void
  onRenamed: (type: 'project' | 'session') => Promise<void>  // Sidebar 侧 loadProjects/loadSessions
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const [renameName, setRenameName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const renameTarget = props.target

  // 打开时以当前名称预填输入框（对齐原编辑按钮回调的 setRenameName），
  // 关闭（target → null）时清空。
  useEffect(() => {
    setRenameName(renameTarget ? renameTarget.name : '')
  }, [renameTarget])

  const handleClose = () => {
    props.onClose()
    setRenameName('')
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const newName = renameName.trim()
    if (!newName || newName === renameTarget.name) {
      handleClose()
      return
    }
    setSubmitting(true)
    try {
      if (renameTarget.type === 'project') {
        await api.updateProject(renameTarget.id, { name: newName })
        await props.onRenamed(renameTarget.type)
        addToast('success', t('sidebar.projectRenamed', { name: newName }) ?? `Project renamed to "${newName}"`)
      } else {
        await api.updateSession(renameTarget.id, { name: newName })
        await props.onRenamed(renameTarget.type)
        addToast('success', t('sidebar.sessionRenamed', { name: newName }) ?? `Session renamed to "${newName}"`)
      }
      handleClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleRename()
    }
  }

  return (
    <Modal
      open={renameTarget !== null}
      onClose={handleClose}
      title={
        renameTarget?.type === 'project'
          ? (t('sidebar.renameProject') ?? 'Rename Project')
          : (t('sidebar.renameSession') ?? 'Rename Session')
      }
      maxWidth="max-w-sm"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
            {renameTarget?.type === 'project'
              ? (t('sidebar.projectName') ?? 'Project Name')
              : t('sidebar.sessionName')}
          </label>
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            placeholder={
              renameTarget?.type === 'project'
                ? (t('sidebar.projectName') ?? 'my-project')
                : (t('sidebar.sessionName') ?? 'dev-server')
            }
            autoFocus
            className={inputClass}
            style={inputStyle}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <PixelButton variant="secondary" onClick={handleClose}>
            {t('sidebar.cancel')}
          </PixelButton>
          <PixelButton
            variant="accent"
            onClick={handleRename}
            disabled={!renameName.trim() || renameName.trim() === renameTarget?.name || submitting}
          >
            {submitting ? t('sidebar.renaming') : t('sidebar.rename')}
          </PixelButton>
        </div>
      </div>
    </Modal>
  )
}
