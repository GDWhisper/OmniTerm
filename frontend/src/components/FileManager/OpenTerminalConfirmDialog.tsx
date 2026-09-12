import { useTranslation } from 'react-i18next'
import { useTerminalEngine } from '../../hooks/useTerminalEngine'
import { terminalEngineLabel } from '../../utils/terminalEngine'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'

export interface OpenTerminalConfirmTarget {
  /** 会话将挂入的项目（覆盖探测命中或当前激活项目）。 */
  projectId: string
  /** 项目展示名；激活项目在列表查不到时回退 i18n 的「当前项目」。 */
  projectName: string
  /** FM 当前浏览目录 = 新终端的启动目录。 */
  cwd: string
}

/**
 * 「在此打开终端」点击时目录已有归属项目（覆盖探测命中或当前激活项目）的
 * 二次确认：告知将挂入哪个项目 + 实际生效的引擎（默认引擎按宿主复用器可用性
 * 收敛，见 useTerminalEngine）及其更改入口。确认后由 FileManager 发起创建；
 * 目录无归属项目时不走本弹窗（OpenTerminalDialog 引导新建/挂载已承担告知职责）。
 */
export function OpenTerminalConfirmDialog(props: {
  target: OpenTerminalConfirmTarget | null
  onClose: () => void
  onConfirm: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const terminalEngine = useTerminalEngine()
  const target = props.target
  return (
    <Modal
      open={!!target}
      onClose={props.onClose}
      title={t('fm.openTerminalHere')}
      maxWidth="max-w-md"
    >
      {target && (
        <div className="space-y-4">
          <p style={{ fontSize: 13, color: 'var(--text-primary)' }}>
            {t('fm.openTerminalConfirm.message', { name: target.projectName })}
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
          <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            {t('fm.openTerminalDialog.engineHint', {
              engine: terminalEngineLabel(terminalEngine, t),
            })}
          </p>
          <div className="flex justify-end gap-2 pt-1 flex-wrap">
            <PixelButton variant="secondary" onClick={props.onClose}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton
              variant="accent"
              onClick={() => props.onConfirm(target.projectId)}
              autoFocus
            >
              {t('fm.openTerminalConfirm.open')}
            </PixelButton>
          </div>
        </div>
      )}
    </Modal>
  )
}
