import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitInProgress } from '../../api/client'
import { ConfirmDialog } from '../Modal/ConfirmDialog'

interface OperationBannerProps {
  state: GitInProgress
  /** Disable actions while any git mutation is in flight. */
  busy: boolean
  onContinue: () => void
  onAbort: () => void
}

/**
 * Persistent banner for a paused merge/rebase/cherry-pick/revert/am (plan D5).
 * Conflict resolution itself happens in the editor/terminal; this only closes
 * the loop with continue/abort. Abort is destructive: it discards whatever
 * conflict resolution progress exists in the worktree.
 */
export function OperationBanner({ state, busy, onContinue, onAbort }: OperationBannerProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const blocked = state.conflicted > 0
  const kindLabel = t(`git.inProgress.${state.kind}`)

  return (
    <>
      <div className="git-op-banner" role="status">
        <span className="git-op-banner-title">▲ {kindLabel}</span>
        {blocked && (
          <span className="git-op-banner-conflict">
            {t('git.inProgressConflicted', { count: state.conflicted })}
          </span>
        )}
        <span className="git-op-banner-hint">{t('git.inProgressHint')}</span>
        <span className="title-bar-spacer" />
        <button
          className="git-btn"
          disabled={busy || blocked}
          onClick={onContinue}
          title={blocked ? t('git.continueBlocked') : undefined}
        >
          {t('git.continueOp')}
        </button>
        <button
          className="git-btn git-btn-danger"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {t('git.abortOp')}
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onAbort()
        }}
        title={t('git.abortTitle')}
        message={t('git.abortConfirm')}
        confirmText={t('git.abortOp')}
        destructive
        loading={busy}
      />
    </>
  )
}
