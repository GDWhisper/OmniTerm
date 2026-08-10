import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { READER_FONT } from '../../utils/fonts'

export interface DeleteWorktreeTarget {
  projectId: string
  path: string
  label: string
  /** Branch checked out in this worktree; `null` when detached (nothing to delete). */
  branch: string | null
}

/**
 * Worktree deletion confirmation with an explicit acknowledgement checkbox.
 * Holds its own `checked` / `submitting` state (formerly Sidebar's
 * `confirmDeleteWtChecked` / shared `submitting`); clears the workspace
 * selection if the deleted worktree was the active one.
 */
export function DeleteWorktreeDialog(props: {
  target: DeleteWorktreeTarget | null   // null = 关闭
  onClose: () => void
  reloadWorktrees: (projectId: string) => Promise<void>  // Sidebar 侧 loadWorktrees
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  // 渲染期选择器：与原实现闭包读取同语义（handleDeleteWorktree 执行期间
  // 捕获的是删除前的快照），仅数据源从 Sidebar 闭包改为 store 选择器。
  const worktrees = useAppStore((s) => s.worktrees)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const [checked, setChecked] = useState(false)
  // `git worktree remove` keeps the branch ref, which then lingers in the
  // "Base Branch" dropdown. Opt-in, because creating a new worktree from an
  // existing branch that has no worktree is a legitimate workflow.
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const target = props.target

  const handleClose = () => {
    props.onClose()
    setChecked(false)
    setDeleteBranch(false)
  }

  const handleDeleteWorktree = async () => {
    if (!target) return
    const alsoBranch = deleteBranch && !!target.branch
    setSubmitting(true)
    try {
      const res = await api.deleteWorktree(target.projectId, target.path, { deleteBranch: alsoBranch })
      await props.reloadWorktrees(target.projectId)
      // If the deleted worktree was active, clear the workspace selection
      if (activeWorkspaceId) {
        const wtList = worktrees[target.projectId] || []
        const stillExists = wtList.some(w => w.id === activeWorkspaceId)
        if (!stillExists) {
          setActiveWorkspace(null)
          setActiveSession(null)
        }
      }
      // The worktree is gone either way; a failed branch deletion is surfaced
      // as a warning rather than swallowed.
      if (res.branch_error) {
        addToast('warning', t('sidebar.worktreeDeletedBranchFailed', { name: target.label, reason: res.branch_error })
          ?? `Worktree "${target.label}" deleted, but the branch could not be removed: ${res.branch_error}`)
      } else if (res.branch_deleted) {
        addToast('success', t('sidebar.worktreeDeletedWithBranch', { name: target.label, branch: res.branch_deleted })
          ?? `Worktree "${target.label}" and branch "${res.branch_deleted}" deleted`)
      } else {
        addToast('success', t('sidebar.worktreeDeleted', { name: target.label }) ?? `Worktree "${target.label}" deleted`)
      }
      handleClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={!!target}
      onClose={handleClose}
      title={t('sidebar.deleteWorktree') ?? 'Delete Worktree'}
      maxWidth="max-w-sm"
    >
      <div className="space-y-4">
        <div
          className="px-3 py-2.5 rounded-md"
          style={{ background: 'var(--danger-12)', border: '1px solid var(--danger)', color: 'var(--text-primary)', fontSize: 12, fontFamily: READER_FONT }}
        >
          <p className="font-semibold mb-1" style={{ color: 'var(--danger)' }}>
            {t('sidebar.deleteWorktreeWarning') ?? '⚠ 不可逆操作'}
          </p>
          <p>
            {t('sidebar.deleteWorktreeConfirm', { name: target?.label ?? '', path: target?.path ?? '' }) ??
              `将永久删除 worktree「${target?.label ?? ''}」（${target?.path ?? ''}），包括其中所有未提交的更改。此操作无法撤销。`}
          </p>
        </div>
        {target?.branch && (
          <div>
            <label
              className="flex items-start gap-2 cursor-pointer select-none"
              style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: READER_FONT }}
            >
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
                style={{ accentColor: 'var(--danger)', flexShrink: 0, marginTop: 2 }}
              />
              {/* min-w-0: 不加则 flex 子项按 min-content 尺寸撑开，长分支名顶破弹窗 */}
              <span style={{ minWidth: 0 }}>
                {t('sidebar.deleteWorktreeAlsoBranch', { branch: target.branch }) ?? `Also delete branch "${target.branch}"`}
              </span>
            </label>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
              {t('sidebar.deleteWorktreeAlsoBranchHint')}
            </p>
          </div>
        )}
        <label
          className="flex items-start gap-2 cursor-pointer select-none"
          style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: READER_FONT }}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ accentColor: 'var(--danger)', flexShrink: 0, marginTop: 2 }}
          />
          <span style={{ minWidth: 0 }}>{t('sidebar.deleteWorktreeAck') ?? '我已知悉，确认删除'}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <PixelButton variant="secondary" onClick={handleClose}>
            {t('sidebar.cancel')}
          </PixelButton>
          <PixelButton
            variant="danger"
            onClick={handleDeleteWorktree}
            disabled={!checked || submitting}
          >
            {submitting ? t('sidebar.deleting') ?? 'Deleting...' : t('sidebar.delete')}
          </PixelButton>
        </div>
      </div>
    </Modal>
  )
}
