import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../Modal/ConfirmDialog'

export interface ReleaseTarget {
  id: string
  name: string | null
}

/**
 * Thin confirmation shell for releasing an ACP agent process. The release
 * logic itself (`releaseSessionNow`) stays in the Sidebar — it is shared by
 * this dialog and the per-row ReleaseButton's direct-release path.
 */
export function ReleaseConfirmDialog(props: {
  target: ReleaseTarget | null          // null = 关闭
  onClose: () => void
  onRelease: (id: string) => Promise<void>   // Sidebar 的 releaseSessionNow
}) {
  const { t } = useTranslation()

  const target = props.target

  return (
    <ConfirmDialog
      open={!!target}
      onClose={props.onClose}
      onConfirm={() => {
        if (!target) return
        props.onRelease(target.id)
        props.onClose()
      }}
      title={t('sidebar.releaseAgentTitle')}
      message={t('sidebar.confirmReleaseAgent', { name: target?.name ?? '' })}
      confirmText={t('sidebar.release')}
    />
  )
}
