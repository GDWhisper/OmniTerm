import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { IconSessions, IconTerminal, IconFiles } from '../Icons/MobileIcons'
import { hapticTap } from '../../utils/haptics'

const tabs = [
  { id: 'sessions' as const, Icon: IconSessions },
  { id: 'terminal' as const, Icon: IconTerminal },
  { id: 'files' as const, Icon: IconFiles },
]

export function MobileNav() {
  const { activeTab, setActiveTab } = useAppStore()
  const [pulseTab, setPulseTab] = useState<string | null>(null)

  useEffect(() => {
    setPulseTab(activeTab)
    const timer = setTimeout(() => setPulseTab(null), 200)
    return () => clearTimeout(timer)
  }, [activeTab])

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        // Vertical padding kept minimal: the 44pt touch target lives inside the
        // buttons, so the bar itself must not stack extra height on a phone.
        padding: '2px 0',
        paddingBottom: 'calc(2px + env(safe-area-inset-bottom, 0px))',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}
    >
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '0 24px',
          borderRadius: 20,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id
          const isPulsing = pulseTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => { hapticTap(); setActiveTab(tab.id) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                background: isActive ? 'rgba(167,139,250,0.10)' : 'transparent',
                border: 'none',
                borderRadius: 8,
                transition: 'all 0.15s ease',
              }}
              aria-label={tab.id}
            >
              <tab.Icon width={20} height={20} style={isPulsing ? { animation: 'mobileNavPulse 0.2s ease-in-out' } : {}} />
            </button>
          )
        })}
      </nav>
    </div>
  )
}
