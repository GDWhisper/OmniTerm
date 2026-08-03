import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { Modal } from '../Modal/Modal'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { PixelButton } from '../PixelUI/PixelButton'
import { READER_FONT } from '../../utils/fonts'
import { inputClass, inputStyle } from './sidebarModalStyles'

/**
 * Create-worktree modal with the git-init confirmation flow. Holds all
 * form/branch state internally; the Sidebar only supplies the target
 * project (`projectId`, null = closed) and a reload callback.
 *
 * Three-phase state machine (replaces the old createWtOpen + gitInitConfirm
 * pair, preserving the pre-check timing frame-for-frame):
 * - 'loading-branches': branch pre-check in flight — neither overlay renders
 *   (today the modal only opens after the pre-check resolves).
 * - 'form': the create-worktree form modal.
 * - 'git-init-confirm': the "initialize git repo?" ConfirmDialog. When the
 *   pre-check hits not_a_git_repo the form never rendered; when a submit
 *   failed (submit-worktree mode) the form modal stays mounted underneath,
 *   matching the original stacked createWtOpen + gitInitConfirm behavior.
 */
type Phase = 'loading-branches' | 'form' | 'git-init-confirm'

// 非 git 仓库时弹确认框：询问是否先初始化 git（用户确认后自动 init + 继续）
type GitInitConfirmState = {
  projectId: string
  projectName: string
  /** open-modal = 打开创建弹窗前检测到；submit-worktree = 提交创建时检测到（带表单参数重试） */
  mode: 'open-modal' | 'submit-worktree'
  /** 项目目录是否有 .gitignore——无则初始化会提交全部现有文件，确认框需附加警告 */
  hasGitignore: boolean
  params?: { branch: string; path: string; baseBranch: string }
}

export function CreateWorktreeModal(props: {
  projectId: string | null             // null = 关闭
  onClose: () => void
  reloadWorktrees: (projectId: string) => Promise<void>  // Sidebar 侧 loadWorktrees
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  // 路径占位符需要项目路径；submit 失败时取项目名
  const projects = useAppStore((s) => s.projects)

  const projectId = props.projectId

  const [phase, setPhase] = useState<Phase>('loading-branches')
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [gitInitConfirm, setGitInitConfirm] = useState<GitInitConfirmState | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // projectId 变化（含关闭变 null）时重置全部内部状态；非 null 时执行分支预检——
  // 即原「+」按钮回调中 setCreateWtBranchesLoading(true) 之后的部分。
  // 预检 git 仓库：非 git 仓库先弹确认框询问是否初始化，
  // 确认前不打开创建弹窗（避免填完分支名后才发现创建不了）
  useEffect(() => {
    setBranch('')
    setPath('')
    setBaseBranch('')
    setBranches([])
    setCurrentBranch('')
    setGitInitConfirm(null)
    if (!projectId) {
      setPhase('loading-branches')
      setBranchesLoading(false)
      setSubmitting(false)
      return
    }
    let cancelled = false
    setPhase('loading-branches')
    setBranchesLoading(true)
    ;(async () => {
      try {
        const data = await api.listBranches(projectId)
        if (cancelled) return
        setBranches(data.branches)
        setCurrentBranch(data.current)
        setPhase('form')
      } catch (err) {
        if (cancelled) return
        const body = err instanceof ApiError ? (err.body as { code?: string; has_gitignore?: boolean }) : undefined
        if (body?.code === 'not_a_git_repo') {
          const project = useAppStore.getState().projects.find((p) => p.id === projectId)
          setGitInitConfirm({
            projectId,
            projectName: project?.name ?? projectId,
            mode: 'open-modal',
            hasGitignore: body.has_gitignore ?? true,
          })
          setPhase('git-init-confirm')
        } else {
          // 其他错误（网络/权限等）：照常打开弹窗，分支下拉显示默认
          setPhase('form')
        }
      } finally {
        if (!cancelled) setBranchesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectId])

  // 创建 worktree 的公共提交逻辑：成功时刷新 + 关闭弹窗；失败时若
  // 后端返回 not_a_git_repo 且未带 init，则弹确认框询问是否先初始化 git。
  const submitWorktree = async (params: {
    projectId: string
    branch: string
    path: string
    baseBranch: string
    init: boolean
  }): Promise<boolean> => {
    try {
      await api.createWorktree(params.projectId, {
        branch: params.branch,
        path: params.path.trim() || undefined,
        base_branch: params.baseBranch.trim() || undefined,
        init: params.init,
      })
      await props.reloadWorktrees(params.projectId)
      addToast('success', t('sidebar.worktreeCreated', { branch: params.branch }) ?? `Worktree "${params.branch}" created`)
      props.onClose()
      return true
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { code?: string; has_gitignore?: boolean }) : undefined
      if (body?.code === 'not_a_git_repo' && !params.init) {
        const project = projects.find((p) => p.id === params.projectId)
        setGitInitConfirm({
          projectId: params.projectId,
          projectName: project?.name ?? params.projectId,
          mode: 'submit-worktree',
          hasGitignore: body.has_gitignore ?? true,
          params: { branch: params.branch, path: params.path, baseBranch: params.baseBranch },
        })
        setPhase('git-init-confirm')
      } else {
        addToast('error', err instanceof Error ? err.message : String(err))
      }
      return false
    }
  }

  const handleCreateWorktree = async () => {
    if (!projectId || !branch.trim()) return
    setSubmitting(true)
    await submitWorktree({
      projectId,
      branch: branch.trim(),
      path,
      baseBranch,
      init: false,
    })
    setSubmitting(false)
  }

  // 用户确认初始化 git 后：先 init，再继续（打开弹窗 or 带 init 重试创建）
  const handleConfirmGitInit = async () => {
    if (!gitInitConfirm) return
    setSubmitting(true)
    try {
      await api.initGit(gitInitConfirm.projectId)
      if (gitInitConfirm.mode === 'submit-worktree' && gitInitConfirm.params) {
        const { branch: retryBranch, path: retryPath, baseBranch: retryBaseBranch } = gitInitConfirm.params
        const ok = await submitWorktree({
          projectId: gitInitConfirm.projectId,
          branch: retryBranch,
          path: retryPath,
          baseBranch: retryBaseBranch,
          init: true,
        })
        if (ok) setGitInitConfirm(null)
      } else {
        // open-modal 模式：初始化成功后重新加载分支并打开创建弹窗
        setGitInitConfirm(null)
        setBranch('')
        setPath('')
        setBaseBranch('')
        setBranches([])
        setCurrentBranch('')
        setBranchesLoading(true)
        setPhase('loading-branches')
        try {
          const data = await api.listBranches(gitInitConfirm.projectId)
          setBranches(data.branches)
          setCurrentBranch(data.current)
        } catch {
          // 分支加载失败也照常打开弹窗（下拉显示默认项）
        } finally {
          setBranchesLoading(false)
        }
        setPhase('form')
      }
    } catch (err) {
      // initGit 失败：保持当前 phase（确认框不关），与原实现一致
      addToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* ── Create Worktree Modal ──
          submit-worktree 模式下确认框叠在表单之上，表单保持挂载（回归原实现：
          取消回表单不重播动画；Esc 两个监听都触发，整体关闭） */}
      <Modal
        open={projectId !== null && (phase === 'form' || (phase === 'git-init-confirm' && gitInitConfirm?.mode === 'submit-worktree'))}
        onClose={() => props.onClose()}
        title={t('sidebar.createWorktree') ?? 'Create Worktree'}
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreeBranch') ?? 'Branch Name'}
            </label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreateWorktree() } }}
              placeholder="feature-xyz"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreePath') ?? 'Target Path'} <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
            </label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreateWorktree() } }}
              placeholder={projectId
                ? (() => {
                    const proj = projects.find(p => p.id === projectId)
                    if (!proj) return ''
                    const p = proj.path.split('/')
                    const dirname = p[p.length - 1]
                    const parent = p.slice(0, -1).join('/') || '/'
                    return `${parent}/${dirname}-${branch || '<branch>'}`
                  })()
                : ''}
              className={inputClass}
              style={{ ...inputStyle, direction: 'rtl', textAlign: 'left' as const }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
              {t('sidebar.worktreePathHint') ?? '留空则在项目同级目录创建 <项目名>-<分支名>'}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreeBaseBranch') ?? 'Base Branch'} <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
            </label>
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className={inputClass}
              style={{
                ...inputStyle,
                cursor: 'pointer',
                fontFamily: READER_FONT,
              }}
            >
              <option value="">{
  branchesLoading
    ? (t('sidebar.loading') ?? 'Loading...')
    : currentBranch
      ? (t('sidebar.worktreeDefaultBase', { branch: currentBranch }) ?? `默认（${currentBranch} 的最新提交）`)
      : (t('sidebar.worktreeDefaultBaseFallback') ?? '默认（当前分支的最新提交）')
}</option>
              {branches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => props.onClose()}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleCreateWorktree} disabled={submitting || !branch.trim()}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Git Init Confirmation: project directory is not a git repo yet ── */}
      <ConfirmDialog
        open={projectId !== null && phase === 'git-init-confirm'}
        onClose={() => {
          if (gitInitConfirm?.mode === 'submit-worktree') {
            // 提交中取消：回到创建表单（表单值保留）
            setGitInitConfirm(null)
            setPhase('form')
          } else {
            // open-modal 取消：整个流程中止
            props.onClose()
          }
        }}
        onConfirm={handleConfirmGitInit}
        title={t('sidebar.gitInitTitle') ?? 'Initialize Git Repository?'}
        message={
          (t('sidebar.gitInitMessage', { name: gitInitConfirm?.projectName ?? '' }) ?? '该项目目录还不是 Git 仓库。是否先执行 git init 并创建初始提交，再继续创建 Worktree？') +
          (gitInitConfirm && !gitInitConfirm.hasGitignore
            ? (t('sidebar.gitInitNoGitignore') ?? '\n\n注意：未检测到 .gitignore，初始化将把当前目录下所有现有文件（含大文件/敏感文件）纳入首次提交。')
            : '')
        }
        confirmText={t('sidebar.gitInitConfirm') ?? '初始化并继续'}
        loading={submitting}
      />
    </>
  )
}
