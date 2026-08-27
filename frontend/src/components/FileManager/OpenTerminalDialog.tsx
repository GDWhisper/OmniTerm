import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError, type Session } from '../../api/client'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { inputClass, inputStyle } from '../Sidebar/sidebarModalStyles'

export interface OpenTerminalTarget {
  /** FM 当前浏览目录——既是新终端启动目录，也是新建项目的根。 */
  cwd: string
  /** 当前激活项目（如有）——作为「挂到当前项目」的逃生通道选项。 */
  attachProject: { id: string; name: string } | null
}

/**
 * 「在此打开终端」点击时目录不被任何已打开项目覆盖的引导弹窗：
 * 主路径 = 以该目录为根新建项目并在其下打开终端（后端 409 already_covered
 * 时改挂覆盖项目——同仓库 worktree 覆盖前端前缀探测看不到，后端权威）；
 * 次路径 = 挂到当前激活项目（会话以孤儿身份显示在其主 worktree 下）。
 * 自持表单/提交状态（同 Sidebar modal 契约），FM 只持有打开目标与收尾回调。
 */
export function OpenTerminalDialog(props: {
  target: OpenTerminalTarget | null
  onClose: () => void
  onDone: (session: Session, projectId: string, projectCreated: boolean) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState<'create' | 'attach' | null>(null)

  // 打开时预填项目名 = 目录 basename（'/' 等无 basename 时回退整个路径）
  useEffect(() => {
    if (props.target) {
      setName(props.target.cwd.split('/').filter(Boolean).pop() ?? props.target.cwd)
      setSubmitting(null)
    }
  }, [props.target])

  const close = () => {
    if (submitting) return
    props.onClose()
  }

  const handleCreate = async () => {
    const target = props.target
    if (!target || !name.trim() || submitting) return
    setSubmitting('create')
    try {
      let projectId: string
      let created = true
      try {
        projectId = (await api.createProject({ name: name.trim(), path: target.cwd })).id
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const body = e.body as Record<string, unknown> | undefined
          const covering =
            body?.error === 'already_covered'
              ? (body.covering_project as { id: string } | undefined)
              : undefined
          if (!covering) throw e
          projectId = covering.id
          created = false
        } else {
          throw e
        }
      }
      const session = await api.createSession(projectId, target.cwd, undefined, undefined, 'pty')
      props.onDone(session, projectId, created)
      props.onClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(null)
    }
  }

  const handleAttach = async () => {
    const target = props.target
    if (!target?.attachProject || submitting) return
    setSubmitting('attach')
    try {
      const session = await api.createSession(
        target.attachProject.id,
        target.cwd,
        undefined,
        undefined,
        'pty',
      )
      props.onDone(session, target.attachProject.id, false)
      props.onClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(null)
    }
  }

  const target = props.target
  return (
    <Modal open={!!target} onClose={close} title={t('fm.openTerminalHere')} maxWidth="max-w-md">
      {target && (
        <div className="space-y-4">
          <p style={{ fontSize: 13, color: 'var(--text-primary)' }}>
            {t('fm.openTerminalDialog.message')}
          </p>
          <div
            className="rounded-md px-3 py-2"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-strong)',
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--reader-font)',
            }}
          >
            {target.cwd}
          </div>
          <div>
            <label
              className="block text-xs font-medium mb-1.5"
              style={{ color: 'var(--text-muted)' }}
            >
              {t('fm.openTerminalDialog.projectName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleCreate()
                }
              }}
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)'
                e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)'
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1 flex-wrap">
            <PixelButton variant="secondary" onClick={close} disabled={!!submitting}>
              {t('sidebar.cancel')}
            </PixelButton>
            {target.attachProject && (
              <PixelButton variant="secondary" onClick={handleAttach} disabled={!!submitting}>
                {submitting === 'attach'
                  ? t('fm.openTerminalDialog.opening')
                  : t('fm.openTerminalDialog.attachCurrent', { name: target.attachProject.name })}
              </PixelButton>
            )}
            <PixelButton
              variant="accent"
              onClick={handleCreate}
              disabled={!name.trim() || !!submitting}
            >
              {submitting === 'create' ? t('sidebar.creating') : t('fm.openTerminalDialog.createAndOpen')}
            </PixelButton>
          </div>
        </div>
      )}
    </Modal>
  )
}
