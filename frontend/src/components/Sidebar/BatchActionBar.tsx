import { useTranslation } from 'react-i18next'
import { IconX } from '../FileManager/icons'
import type { BatchAction } from './BatchSessionDialog'

export interface BatchActionBarProps {
  selectedCount: number
  /** 选中会话中可归档的数量（ACP）。0 → 归档按钮禁用。 */
  archivableCount: number
  /** 选中会话中可释放的数量（ACP）。0 → 释放按钮禁用。 */
  releasableCount: number
  onAction: (action: BatchAction) => void
  onCancel: () => void
}

/**
 * 批量选择模式的底部操作栏（替换 Sidebar 常规状态栏，保持同一
 * `.absolute bottom-0` 节点位置）。归档/释放仅对 ACP 会话有效——可执行数
 * 为 0 时禁用（终端会话对应的后端接口返回 400，禁用以避免无意义请求）；
 * 选中数 > 0 即可删除。
 */
export function BatchActionBar({
  selectedCount,
  archivableCount,
  releasableCount,
  onAction,
  onCancel,
}: BatchActionBarProps) {
  const { t } = useTranslation()

  return (
    <div
      className="absolute bottom-0 left-0 right-0 px-3.5 py-3 flex items-center justify-between gap-2"
      style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-base)' }}
    >
      <span
        className="font-pixel"
        style={{
          fontSize: 11,
          letterSpacing: 'var(--pixel-tracking-sm)',
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {t('sidebar.batchSelectedCount', { count: selectedCount })}
      </span>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <BatchButton
          label={t('sidebar.archive')}
          title={archivableCount === 0 ? t('sidebar.batchArchiveNoTarget') : t('sidebar.archiveAcp')}
          disabled={archivableCount === 0}
          onClick={() => onAction('archive')}
        />
        <BatchButton
          label={t('sidebar.release')}
          title={releasableCount === 0 ? t('sidebar.batchReleaseNoTarget') : t('sidebar.releaseAcp')}
          disabled={releasableCount === 0}
          onClick={() => onAction('release')}
        />
        <BatchButton
          label={t('sidebar.delete')}
          title={t('sidebar.delete')}
          danger
          disabled={selectedCount === 0}
          onClick={() => onAction('delete')}
        />
        <button
          type="button"
          onClick={onCancel}
          className="flex-shrink-0 flex items-center justify-center transition-all"
          style={{
            width: 24,
            height: 24,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: 'var(--border-strong)',
            color: 'var(--text-faint)',
            background: 'transparent',
          }}
          title={t('sidebar.cancel')}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)'
            e.currentTarget.style.color = 'var(--accent)'
            e.currentTarget.style.background = 'var(--accent-10)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-strong)'
            e.currentTarget.style.color = 'var(--text-faint)'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <IconX width={12} height={12} />
        </button>
      </div>
    </div>
  )
}

function BatchButton({
  label,
  title,
  disabled,
  danger = false,
  onClick,
}: {
  label: string
  title: string
  disabled: boolean
  danger?: boolean
  onClick: () => void
}) {
  const idleColor = danger ? 'var(--danger)' : 'var(--text-secondary)'
  const idleBorder = danger ? 'var(--danger-30)' : 'var(--border-strong)'
  return (
    <button
      type="button"
      className="pixel-press"
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{
        padding: '3px 7px',
        fontSize: 11,
        lineHeight: '14px',
        background: 'var(--bg-elevated)',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: idleBorder,
        color: idleColor,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.borderColor = danger ? 'var(--danger)' : 'var(--accent)'
        e.currentTarget.style.color = danger ? 'var(--danger)' : 'var(--accent)'
        e.currentTarget.style.background = danger ? 'var(--danger-12)' : 'var(--accent-10)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = idleBorder
        e.currentTarget.style.color = idleColor
        e.currentTarget.style.background = 'var(--bg-elevated)'
      }}
    >
      {label}
    </button>
  )
}
