import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type GitBind, type GitStashEntry } from '../../api/client'
import { OverlayScroll } from '../Common/OverlayScroll'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { Modal } from '../Modal/Modal'

interface StashPanelProps {
  open: boolean
  bind: GitBind
  /** Stashing with no local changes is a no-op; disable the save button. */
  hasChanges: boolean
  busy: boolean
  onClose: () => void
  /** Status changed (stash applied/popped) — refresh diff/status consumers. */
  onChanged: () => void
  /** Serialized mutation with localized error toast; resolves true on success. */
  runOp: (op: () => Promise<unknown>, successMsg?: string) => Promise<boolean>
}

export function StashPanel({
  open, bind, hasChanges, busy, onClose, onChanged, runOp,
}: StashPanelProps) {
  const { t } = useTranslation()
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [dropTarget, setDropTarget] = useState<GitStashEntry | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.gitStashList(bind)
      setStashes('stashes' in data ? data.stashes : [])
    } catch {
      setStashes([])
    } finally {
      setLoading(false)
    }
  }, [bind])

  useEffect(() => {
    if (!open) return
    setMessage('')
    setIncludeUntracked(false)
    setDropTarget(null)
    refresh()
  }, [open, refresh])

  const handlePush = async () => {
    const ok = await runOp(
      () => api.gitStashPush(bind, message.trim() || undefined, includeUntracked),
      t('git.stashed'),
    )
    if (!ok) return
    setMessage('')
    setIncludeUntracked(false)
    refresh()
  }

  const handleApply = async (entry: GitStashEntry, mode: 'apply' | 'pop') => {
    const ok = await runOp(
      () => mode === 'apply' ? api.gitStashApply(bind, entry.index) : api.gitStashPop(bind, entry.index),
      t(mode === 'apply' ? 'git.stashApplied' : 'git.stashPopped'),
    )
    if (!ok) return
    onChanged()
    refresh()
  }

  const handleDrop = async () => {
    if (!dropTarget) return
    const target = dropTarget
    setDropTarget(null)
    const ok = await runOp(() => api.gitStashDrop(bind, target.index), t('git.stashDropped'))
    if (ok) refresh()
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={t('git.stashTitle')}>
      <div className="git-stash-form">
        <input
          className="git-input"
          placeholder={t('git.stashPushPlaceholder')}
          value={message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hasChanges && !busy) handlePush()
          }}
        />
        <div className="git-stash-form-row">
          <label className="git-stash-check">
            <input
              type="checkbox"
              className="fm-checkbox"
              style={{ accentColor: 'var(--accent)', flexShrink: 0 }}
              checked={includeUntracked}
              disabled={busy}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            <span>{t('git.stashIncludeUntracked')}</span>
          </label>
          <button
            className="git-btn"
            disabled={busy || !hasChanges}
            title={hasChanges ? undefined : t('git.stashNothingToSave')}
            onClick={handlePush}
          >
            {t('git.stashPushBtn')}
          </button>
        </div>
      </div>

      <div className="git-stash-list">
        {loading ? (
          <div className="git-empty">{t('git.loading')}</div>
        ) : stashes.length === 0 ? (
          <div className="git-empty">{t('git.stashEmpty')}</div>
        ) : (
          <OverlayScroll style={{ maxHeight: 260 }} contentStyle={{ flex: '0 0 auto' }}>
            {stashes.map((entry) => (
              <div key={entry.index} className="git-stash-row">
                <div className="git-stash-meta">
                  <span className="git-stash-message" title={entry.message}>{entry.message}</span>
                  <span className="git-stash-date">{entry.date}</span>
                </div>
                <div className="git-stash-actions">
                  <button className="git-btn" disabled={busy} onClick={() => handleApply(entry, 'apply')}>
                    {t('git.stashApply')}
                  </button>
                  <button className="git-btn" disabled={busy} onClick={() => handleApply(entry, 'pop')}>
                    {t('git.stashPop')}
                  </button>
                  <button
                    className="git-btn git-btn-danger"
                    disabled={busy}
                    onClick={() => setDropTarget(entry)}
                  >
                    {t('git.stashDrop')}
                  </button>
                </div>
              </div>
            ))}
          </OverlayScroll>
        )}
      </div>

      <ConfirmDialog
        open={dropTarget !== null}
        onClose={() => setDropTarget(null)}
        onConfirm={handleDrop}
        title={t('git.stashDropTitle')}
        message={t('git.stashDropConfirm', { message: dropTarget?.message ?? '' })}
        confirmText={t('git.stashDrop')}
        destructive
        loading={busy}
      />
    </Modal>
  )
}
