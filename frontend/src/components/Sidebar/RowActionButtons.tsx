import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IconPencil, IconTrash, IconPower } from '../FileManager/icons'

export function SidebarBottomButton({
  toggle,
  icon,
  title,
  onClick,
  size = 26,
  className = '',
}: {
  toggle: string
  icon: ReactNode
  title: string
  onClick: () => void
  size?: number
  className?: string
}) {
  return (
    <button
      data-toggle={toggle}
      onClick={onClick}
      className={`row-action flex items-center justify-center transition-all ${className}`}
      style={{
        width: size,
        height: size,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-faint)',
        fontSize: 14,
      }}
      title={title}
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
      {icon}
    </button>
  )
}

export function EditButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="row-action flex-shrink-0 flex items-center justify-center transition-all"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.rename')}
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
      <IconPencil width={14} height={14} />
    </button>
  )
}

export function DeleteButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="row-action flex-shrink-0 flex items-center justify-center transition-all sidebar-glow-red-hover"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.delete')}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--danger)'
        e.currentTarget.style.color = 'var(--danger)'
        e.currentTarget.style.background = 'var(--danger-12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-faint)'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <IconTrash width={14} height={14} />
    </button>
  )
}

export function ReleaseButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="row-action flex-shrink-0 flex items-center justify-center transition-all"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.releaseAcp')}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--warning)'
        e.currentTarget.style.color = 'var(--warning)'
        e.currentTarget.style.background = 'var(--warning-12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-faint)'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <IconPower width={14} height={14} />
    </button>
  )
}
