import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, type AppState } from '../../stores/appStore'
import { Sidebar } from '../Sidebar/Sidebar'
import { Terminal } from '../Terminal/Terminal'
import { FileManager } from '../FileManager/FileManager'
import { SettingsPopup } from '../Settings/SettingsPopup'
import { MobileNav } from './MobileNav'
import { MobileStatusBar } from './MobileStatusBar'

export function Layout() {
  const [isDragging, setIsDragging] = useState(false)
  const {
    isMobile,
    sidebarOpen,
    sidebarCollapsed,
    settingsOpen,
    fileManagerOpen,
    fileManagerCollapsed,
    sidebarWidth,
    fileManagerWidth,
    activeSessionId,
    setSidebarWidth,
    setFileManagerWidth,
  } = useAppStore()

  const layoutRef = useRef<HTMLDivElement>(null)

  // Drag resize handlers
  const handleSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = sidebarWidth
      const maxSidebar = Math.floor(window.innerWidth / 3)
      setIsDragging(true)

      const onMove = (e: MouseEvent) => {
        const delta = e.clientX - startX
        const newWidth = Math.max(140, Math.min(maxSidebar, startWidth + delta))
        setSidebarWidth(newWidth)
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setIsDragging(false)
        localStorage.setItem('omniterm_sidebar_width', String(useAppStore.getState().sidebarWidth))
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth, setSidebarWidth]
  )

  const handleFileManagerDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = fileManagerWidth
      const maxFileManager = Math.floor(window.innerWidth / 2)
      setIsDragging(true)

      const onMove = (e: MouseEvent) => {
        const delta = startX - e.clientX
        const newWidth = Math.max(240, Math.min(maxFileManager, startWidth + delta))
        setFileManagerWidth(newWidth)
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setIsDragging(false)
        localStorage.setItem('omniterm_fm_width', String(useAppStore.getState().fileManagerWidth))
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [fileManagerWidth, setFileManagerWidth]
  )

  // Mobile layout
  if (isMobile) {
    return <MobileLayout />
  }

  // Desktop layout: Sidebar | Terminal | FileManager
  return (
    <div
      ref={layoutRef}
      className="flex"
      style={{ height: '100dvh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {/* Sidebar */}
      {sidebarOpen && (
        <div
          className="flex-shrink-0"
          style={{
            width: sidebarCollapsed ? 40 : sidebarWidth,
            overflow: 'hidden',
            background: 'var(--bg-base)',
            borderRight: '1px solid var(--border-subtle)',
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          <Sidebar />
        </div>
      )}

      {/* Sidebar drag handle — hidden when collapsed */}
      {sidebarOpen && !sidebarCollapsed && (
        <div
          className="omniterm-drag-bar omniterm-drag-bar-v"
          onMouseDown={handleSidebarDrag}
        />
      )}

      {/* Terminal — key forces full remount on session switch for clean WebSocket lifecycle */}
      <div className="flex-1 min-w-0">
        <Terminal key={activeSessionId ?? 'empty'} />
      </div>

      {/* FileManager drag handle — hidden when collapsed */}
      {fileManagerOpen && !fileManagerCollapsed && (
        <div
          className="omniterm-drag-bar omniterm-drag-bar-v"
          onMouseDown={handleFileManagerDrag}
        />
      )}

      {/* FileManager */}
      {fileManagerOpen && (
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{
            width: fileManagerCollapsed ? 40 : fileManagerWidth,
            background: 'var(--bg-base)',
            borderLeft: '1px solid var(--border-subtle)',
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          <FileManager />
        </div>
      )}

      {/* Settings popup — fixed positioning, independent of all panels */}
      {settingsOpen && <SettingsPopup />}
    </div>
  )
}

function MobileLayout() {
  const { t } = useTranslation()
  const {
    activeTab,
    activeSessionId,
    sessions,
    connected,
    mobileGestureEnabled,
    settingsOpen,
    setActiveTab,
  } = useAppStore()

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    const order: AppState['activeTab'][] = ['sessions', 'terminal', 'files']
    const idx = order.indexOf(activeTab)
    if (idx === -1) return
    const next = direction === 'left' ? idx + 1 : idx - 1
    if (next >= 0 && next < order.length) {
      setActiveTab(order[next])
    }
  }, [activeTab, setActiveTab])

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeSessionName = activeSession?.name || activeSessionId || t('sidebar.noSessions')

  return (
    <div
      className="flex flex-col"
      style={{ height: '100dvh', background: 'var(--bg-base)', color: 'var(--text-primary)', overflow: 'hidden' }}
    >
      <style>{`
        @keyframes mobileSlideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes mobileSlideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes mobileSlideOutLeft {
          from { transform: translateX(0); }
          to { transform: translateX(-100%); }
        }
        @keyframes mobileSlideOutRight {
          from { transform: translateX(0); }
          to { transform: translateX(100%); }
        }
      `}</style>
      <MobileStatusBar
        connected={connected}
        sessionName={activeSessionName}
        onSessionClick={() => setActiveTab('sessions')}
        onNewSession={() => setActiveTab('sessions')}
      />
      <div
        className="flex-1 overflow-hidden"
        onTouchStart={mobileGestureEnabled ? (e) => {
          const touch = e.touches[0]
          ;(e.currentTarget as HTMLDivElement).dataset.startX = String(touch.clientX)
          ;(e.currentTarget as HTMLDivElement).dataset.startY = String(touch.clientY)
        } : undefined}
        onTouchEnd={mobileGestureEnabled ? (e) => {
          const div = e.currentTarget as HTMLDivElement
          const startX = parseFloat(div.dataset.startX ?? '0')
          const startY = parseFloat(div.dataset.startY ?? '0')
          const touch = e.changedTouches[0]
          const dx = touch.clientX - startX
          const dy = touch.clientY - startY
          const edgeMargin = 24
          if (Math.abs(dx) < Math.abs(dy)) return
          if (Math.abs(dx) < 40) return
          if (startX < edgeMargin || startX > window.innerWidth - edgeMargin) return
          handleSwipe(dx < 0 ? 'left' : 'right')
        } : undefined}
      >
        <MobileContent />
      </div>
      <MobileNav />
      {settingsOpen && <SettingsPopup />}
    </div>
  )
}

function MobileContent() {
  const activeTab = useAppStore((s) => s.activeTab)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const [displayedTab, setDisplayedTab] = useState(activeTab)
  const [animState, setAnimState] = useState<'idle' | 'exiting'>('idle')

  useEffect(() => {
    if (activeTab === displayedTab) return
    
    // Determine if current content needs exit animation
    const needsExit = displayedTab === 'sessions' || displayedTab === 'files'
    
    if (needsExit) {
      setAnimState('exiting')
      const timer = setTimeout(() => {
        setDisplayedTab(activeTab)
        setAnimState('idle')
      }, 200)
      return () => clearTimeout(timer)
    } else {
      setDisplayedTab(activeTab)
    }
  }, [activeTab, displayedTab])

  const getAnimation = () => {
    if (animState === 'exiting') {
      if (displayedTab === 'sessions') return 'mobileSlideOutLeft 0.2s ease-in forwards'
      if (displayedTab === 'files') return 'mobileSlideOutRight 0.2s ease-in forwards'
    }
    // Enter animations
    if (displayedTab === 'sessions') return 'mobileSlideInLeft 0.25s ease-out'
    if (displayedTab === 'files') return 'mobileSlideInRight 0.25s ease-out'
    return ''
  }

  const wrapperStyle = { height: '100%', animation: getAnimation() || undefined }

  switch (displayedTab) {
    case 'terminal':
      return <Terminal key={activeSessionId ?? 'empty'} />
    case 'files':
      return <div style={wrapperStyle}><FileManager /></div>
    case 'sessions':
      return <div style={wrapperStyle}><Sidebar /></div>
    default:
      return <Terminal key={activeSessionId ?? 'empty'} />
  }
}
