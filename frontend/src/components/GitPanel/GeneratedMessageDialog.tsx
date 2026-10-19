import { useTranslation } from 'react-i18next'
import { OverlayScroll } from '../Common/OverlayScroll'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'

/**
 * Shown only when the commit box already has text: applying a generated message
 * must never silently discard something the user typed.
 */
export function GeneratedMessageDialog(props: {
  message: string | null
  onClose: () => void
  onApply: (mode: 'replace' | 'append') => void
}) {
  const { t } = useTranslation()

  return (
    <Modal
      open={props.message !== null}
      onClose={props.onClose}
      title={t('git.generateDialogTitle')}
      maxWidth="max-w-lg"
    >
      <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
        {t('git.generateDialogMessage')}
      </p>
      <OverlayScroll style={{ maxHeight: 180, marginBottom: 18 }} contentStyle={{ flex: '0 0 auto' }}>
        <pre className="git-generated-preview">{props.message}</pre>
      </OverlayScroll>
      <div className="flex justify-end gap-2">
        <PixelButton variant="secondary" onClick={props.onClose}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton variant="secondary" onClick={() => props.onApply('append')}>
          {t('git.append')}
        </PixelButton>
        <PixelButton variant="primary" onClick={() => props.onApply('replace')}>
          {t('git.replace')}
        </PixelButton>
      </div>
    </Modal>
  )
}
