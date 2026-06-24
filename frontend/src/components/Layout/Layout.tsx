import { useRef, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Sidebar } from '../Sidebar/Sidebar'
import { Terminal } from '../Terminal/Terminal'
import { FileManager } from '../FileManager/FileManager'
import { Settings } from '../Settings/Settings'
import { MobileNav } from './MobileNav'

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
    return (
      <div className="flex flex-col h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-200">
        <MobileNav />
        <div className="flex-1 overflow-hidden">
          <MobileContent />
        </div>
      </div>
    )
  }

  // Desktop layout: Sidebar | Terminal | FileManager
  return (
    <div
      ref={layoutRef}
      className="flex h-screen"
      style={{ background: '#0a0a0f', color: '#e2e8f0' }}
    >
      {/* Sidebar */}
      {sidebarOpen && (
        <div
          className="flex-shrink-0"
          style={{
            width: sidebarCollapsed ? 40 : sidebarWidth,
            overflow: (sidebarCollapsed && settingsOpen) ? 'visible' : 'hidden',
            background: '#0a0a0f',
            borderRight: '1px solid #1e293b',
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
            background: '#0a0a0f',
            borderLeft: '1px solid #1e293b',
            transition: isDragging ? 'none' : 'width 0.2s ease',
          }}
        >
          <FileManager />
        </div>
      )}
    </div>
  )
}

function MobileContent() {
  const activeTab = useAppStore((s) => s.activeTab)
  const activeSessionId = useAppStore((s) => s.activeSessionId)

  switch (activeTab) {
    case 'terminal':
      return <Terminal key={activeSessionId ?? 'empty'} />
    case 'files':
      return <FileManager />
    case 'sessions':
      return <Sidebar />
    case 'settings':
      return <Settings />
    default:
      return <Terminal key={activeSessionId ?? 'empty'} />
  }
}
