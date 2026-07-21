import type { PendingPermission } from '../../stores/chatStore'
import { READER_FONT } from '../../utils/fonts'

const KIND_LABELS: Record<string, string> = {
  allow_once: 'Allow Once',
  allow_always: 'Always Allow',
  reject_once: 'Reject',
  reject_always: 'Always Reject',
}

function kindLabel(kind: string, name?: string): string {
  return name ?? KIND_LABELS[kind] ?? kind
}

function isAllow(kind: string): boolean {
  return kind.startsWith('allow')
}

interface Props {
  permission: PendingPermission
  onRespond: (id: string, optionId: string) => void
}

export function PermissionBanner({ permission, onRespond }: Props) {
  return (
    <div
      style={{
        padding: '8px 12px',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        fontFamily: READER_FONT,
        fontSize: 12,
      }}
    >
      <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
        <span style={{ color: 'var(--warning)', marginRight: 6 }}>⚠</span>
        {permission.toolName
          ? `Agent requests permission: ${permission.toolName}`
          : 'Agent requests permission'}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {permission.options.map((opt, i) => (
          <button
            key={opt.option_id || `opt-${i}`}
            onClick={() => onRespond(permission.id, opt.option_id)}
            style={{
              padding: '4px 12px',
              fontSize: 11,
              borderRadius: 4,
              border: `1px solid ${isAllow(opt.kind) ? 'var(--success)' : 'var(--danger, #C85A3A)'}`,
              background: isAllow(opt.kind)
                ? 'color-mix(in srgb, var(--success) 14%, transparent)'
                : 'color-mix(in srgb, var(--danger, #C85A3A) 14%, transparent)',
              color: isAllow(opt.kind) ? 'var(--success)' : 'var(--danger, #C85A3A)',
              cursor: 'pointer',
            }}
          >
            {kindLabel(opt.kind, opt.name)}
          </button>
        ))}
      </div>
    </div>
  )
}
