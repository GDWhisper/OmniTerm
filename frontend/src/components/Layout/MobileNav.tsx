import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { IconSessions, IconTerminal, IconFiles } from '../Icons/MobileIcons'

const tabs = [
  { id: 'sessions' as const, Icon: IconSessions },
  { id: 'terminal' as const, Icon: IconTerminal },
  { id: 'files' as const, Icon: IconFiles },
]

export function MobileNav() {
  const { activeTab, setActiveTab } = useAppStore()
  const [shakeTab, setShakeTab] = useState<string | null>(null)

  useEffect(() => {
    setShakeTab(activeTab)
    const timer = setTimeout(() => setShakeTab(null), 400)
    return () => clearTimeout(timer)
  }, [activeTab])

  return (
    <>
      <style>{`
        @keyframes shake {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-12deg); }
          50% { transform: rotate(12deg); }
          75% { transform: rotate(-6deg); }
        }
      `}</style>
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '6px 0',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}
    >
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 40,
          padding: '5px 32px',
          borderRadius: 20,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id
          const isShaking = shakeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                background: isActive ? 'rgba(167,139,250,0.10)' : 'transparent',
                border: 'none',
                borderRadius: 6,
                transition: 'all 0.15s ease',
              }}
              aria-label={tab.id}
            >
              <tab.Icon width={18} height={18} style={isShaking ? { animation: 'shake 0.4s ease-in-out' } : {}} />
            </button>
          )
        })}
      </nav>
    </div>
    </>
  )
}
