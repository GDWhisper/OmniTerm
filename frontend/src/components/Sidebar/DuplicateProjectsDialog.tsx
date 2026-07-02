import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../Modal/Modal'
import { api, type DuplicateGroup, type DuplicateProject } from '../../api/client'

/**
 * Modal that lets the user reconcile legacy duplicate projects.
 *
 * For each group of projects sharing a git toplevel (or exact path), the
 * user picks which one to keep. The others are merged into the chosen
 * project (their sessions are reassigned, then the source projects are
 * deleted). tmux_session_name collisions block the merge and are shown
 * inline.
 */
export function DuplicateProjectsDialog({
  open,
  groups,
  onClose,
  onResolved,
}: {
  open: boolean
  groups: DuplicateGroup[]
  onClose: () => void
  onResolved: () => void
}) {
  const { t } = useTranslation()
  /** Per-group: id of the project to keep. Undefined = not yet chosen. */
  const [keepSelection, setKeepSelection] = useState<Record<string, string | undefined>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setKeepSelection({})
    setSubmitting(false)
    setError(null)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const allChosen = groups.every((g) => keepSelection[g.group_id])

  const handleConfirm = async () => {
    setSubmitting(true)
    setError(null)
    try {
      // For each group, merge every non-kept project into the kept one.
      // Failures stop the loop so the user can fix and retry.
      for (const group of groups) {
        const keepId = keepSelection[group.group_id]
        if (!keepId) continue
        for (const p of group.projects) {
          if (p.id === keepId) continue
          try {
            await api.mergeProject(p.id, keepId)
          } catch (e: any) {
            const msg = e?.message ?? 'merge failed'
            setError(`${t('sidebar.dupMergeFailed', { name: p.name }) ?? `Failed to merge "${p.name}":`} ${msg}`)
            setSubmitting(false)
            return
          }
        }
      }
      reset()
      onResolved()
    } catch (e: any) {
      setError(e?.message ?? 'merge failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('sidebar.dupDialogTitle') ?? 'Reconcile Duplicate Projects'}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('sidebar.dupDialogIntro') ??
            'These projects cover the same git repository. Pick one to keep in each group; the others will be merged into it (their sessions are moved over, and the source projects are removed from the list).'}
        </p>

        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
          {groups.map((group) => (
            <DuplicateGroupCard
              key={group.group_id}
              group={group}
              keepId={keepSelection[group.group_id]}
              onPick={(id) =>
                setKeepSelection((prev) => ({ ...prev, [group.group_id]: id }))
              }
            />
          ))}
        </div>

        {error && (
          <div
            className="rounded-md px-3 py-2"
            style={{ background: 'var(--danger-12)', color: 'var(--danger)', fontSize: 12 }}
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm rounded-lg transition-all"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--accent-10)'
              e.currentTarget.style.borderColor = 'var(--accent)'
              e.currentTarget.style.color = 'var(--text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = 'var(--border-strong)'
              e.currentTarget.style.color = 'var(--text-muted)'
            }}
          >
            {t('sidebar.cancel') ?? 'Cancel'}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!allChosen || submitting}
            className="px-4 py-2 text-sm rounded-lg text-white transition-all disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-bright)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
          >
            {submitting
              ? (t('sidebar.merging') ?? 'Merging…')
              : (t('sidebar.dupMerge') ?? 'Merge')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function DuplicateGroupCard({
  group,
  keepId,
  onPick,
}: {
  group: DuplicateGroup
  keepId: string | undefined
  onPick: (id: string) => void
}) {
  const { t } = useTranslation()
  const reasonLabel =
    group.reason === 'shared_toplevel'
      ? (t('sidebar.dupReasonToplevel') ?? 'same git repository')
      : (t('sidebar.dupReasonPath') ?? 'same path')

  return (
    <div
      className="rounded-lg p-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)' }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {t('sidebar.dupGroupLabel', { reason: reasonLabel }) ?? `Group · ${reasonLabel}`}
        </span>
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-dim)',
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
          }}
          className="truncate ml-2"
          title={group.group_id}
        >
          {group.group_id}
        </span>
      </div>
      <div className="space-y-1.5">
        {group.projects.map((p) => (
          <DuplicateProjectRow
            key={p.id}
            p={p}
            selected={keepId === p.id}
            onPick={() => onPick(p.id)}
          />
        ))}
      </div>
    </div>
  )
}

function DuplicateProjectRow({
  p,
  selected,
  onPick,
}: {
  p: DuplicateProject
  selected: boolean
  onPick: () => void
}) {
  const { t } = useTranslation()
  return (
    <label
      className="flex items-center gap-3 px-2 py-1.5 rounded cursor-pointer transition-all"
      style={{
        background: selected ? 'var(--accent-10)' : 'transparent',
        border: `1px solid ${selected ? 'var(--accent)' : 'transparent'}`,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = 'var(--accent-10)'
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = 'transparent'
      }}
    >
      <input type="radio" checked={selected} onChange={onPick} className="accent-violet-400" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: selected ? 500 : 400 }}>
            {p.name}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {t('sidebar.dupSessionCount', { n: p.session_count }) ??
              `${p.session_count} session${p.session_count === 1 ? '' : 's'}`}
          </span>
        </div>
        <div
          className="truncate"
          style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
          title={p.path}
        >
          {p.path}
        </div>
      </div>
    </label>
  )
}
