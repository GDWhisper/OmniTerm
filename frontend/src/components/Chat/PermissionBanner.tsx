import type { PendingPermission } from '../../stores/chatStore'
import { READER_FONT } from '../../utils/fonts'
import { looksLikeDiff } from '../../utils/diff'
import { DiffView } from './DiffView'

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
  // 上游若只给模糊的兜底 'other'，不显示误导性标签（同 ToolCallBlockView 约定）
  const toolKind = permission.toolKind && permission.toolKind !== 'other' ? permission.toolKind : undefined
  const content = permission.content
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
      <div style={{ color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--warning)' }}>▲</span>
        <span>
          {permission.toolName
            ? `Agent requests permission: ${permission.toolName}`
            : 'Agent requests permission'}
        </span>
        {toolKind && (
          <span style={{ color: 'var(--text-faint)', fontWeight: 600, fontSize: 10, letterSpacing: '0.04em' }}>
            {toolKind.toUpperCase()}
          </span>
        )}
      </div>
      {permission.locations && permission.locations.length > 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 6 }}>
          {permission.locations.map((l) => <div key={l}>▸ {l}</div>)}
        </div>
      )}
      {content && (
        <div style={{ marginBottom: 8 }}>
          {looksLikeDiff(content) ? (
            <DiffView text={content} />
          ) : (
            <pre
              style={{
                margin: 0,
                padding: '6px 8px',
                background: 'var(--bg-base)',
                borderRadius: 4,
                fontSize: 11,
                overflow: 'auto',
                maxHeight: 200,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-muted)',
                fontFamily: READER_FONT,
              }}
            >
              {content}
            </pre>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {permission.options.map((opt, i) => (
          <button
            key={opt.option_id || `opt-${i}`}
            onClick={() => onRespond(permission.id, opt.option_id)}
            className="pixel-press"
            style={{
              padding: '4px 12px',
              fontSize: 11,
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
