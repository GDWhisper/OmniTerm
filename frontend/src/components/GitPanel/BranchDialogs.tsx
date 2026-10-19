import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitBranch } from '../../api/client'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'

export function BranchRenameDialog(props: {
  target: GitBranch | null
  busy: boolean
  onClose: () => void
  onConfirm: (newName: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue(props.target?.name ?? '')
  }, [props.target])

  if (!props.target) return null
  const name = value.trim()
  const canSubmit = !props.busy && name.length > 0 && name !== props.target.name

  return (
    <Modal
      open
      onClose={props.busy ? () => {} : props.onClose}
      title={t('git.renameBranchTitle')}
    >
      <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
        {t('git.renameBranchHint', { name: props.target.name })}
      </p>
      <input
        className="git-input"
        style={{ width: '100%' }}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSubmit) props.onConfirm(name)
          if (e.key === 'Escape' && !props.busy) props.onClose()
        }}
      />
      <div className="flex justify-end gap-2 mt-5">
        <PixelButton variant="secondary" onClick={props.onClose} disabled={props.busy}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton variant="primary" onClick={() => props.onConfirm(name)} disabled={!canSubmit}>
          {props.busy ? t('modal.processing') : t('git.renameBranchAction')}
        </PixelButton>
      </div>
    </Modal>
  )
}

export function BranchDeleteDialog(props: {
  target: GitBranch | null
  /** Set after `-d` refused because the branch is not fully merged. */
  unmerged: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (force: boolean, alsoRemote: boolean) => void
}) {
  const { t } = useTranslation()
  const [force, setForce] = useState(false)
  const [alsoRemote, setAlsoRemote] = useState(false)

  useEffect(() => {
    if (props.target) {
      setForce(false)
      setAlsoRemote(false)
    }
  }, [props.target])

  if (!props.target) return null
  const canSubmit = !props.busy && (!props.unmerged || force)

  return (
    <Modal
      open
      onClose={props.busy ? () => {} : props.onClose}
      title={t('git.deleteBranchTitle')}
    >
      <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
        {t('git.deleteBranchMessage', { name: props.target.name })}
      </p>
      {props.unmerged && (
        <label
          className="flex items-start gap-2 select-none mb-2"
          style={{ color: 'var(--danger)', fontSize: 13 }}
        >
          <input
            type="checkbox"
            className="fm-checkbox"
            style={{ accentColor: 'var(--danger)', flexShrink: 0, marginTop: 2 }}
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          <span style={{ minWidth: 0 }}>
            {t('git.deleteBranchForce', { name: props.target.name })}
          </span>
        </label>
      )}
      {props.target.upstream && (
        <label
          className="flex items-start gap-2 select-none mb-2"
          style={{ color: 'var(--text-muted)', fontSize: 13 }}
        >
          <input
            type="checkbox"
            className="fm-checkbox"
            style={{ accentColor: 'var(--accent)', flexShrink: 0, marginTop: 2 }}
            checked={alsoRemote}
            onChange={(e) => setAlsoRemote(e.target.checked)}
          />
          <span style={{ minWidth: 0 }}>
            {t('git.deleteBranchRemote', { upstream: props.target.upstream })}
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <PixelButton variant="secondary" onClick={props.onClose} disabled={props.busy}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton
          variant="danger"
          onClick={() => props.onConfirm(force, alsoRemote)}
          disabled={!canSubmit}
        >
          {props.busy ? t('modal.processing') : t('git.deleteBranchAction')}
        </PixelButton>
      </div>
    </Modal>
  )
}
