import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from '../FileManager/FileManager'
import { GitPanel } from '../GitPanel/GitPanel'
import { IconFolderOpen } from '../FileManager/icons'
import { READER_FONT } from '../../utils/fonts'

/**
 * Right panel container (ADR-5, docs/dev/plans/2026-07-26-git-panel.md).
 * Owns the FILES | GIT tab state, the unified title bar and the collapsed
 * 40px rail. Both tab contents stay mounted (display toggle) so FileManager
 * keeps its navigation state and GitPanel polling stops when hidden.
 */
export function RightPanel() {
  const { t } = useTranslation()
  const rightPanelTab = useAppStore((s) => s.rightPanelTab)
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab)
  const collapsed = useAppStore((s) => s.fileManagerCollapsed)
  const toggleCollapsed = useAppStore((s) => s.toggleFileManagerCollapsed)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const isMobile = useAppStore((s) => s.isMobile)

  if (collapsed && !isMobile) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: 'var(--bg-base)', fontFamily: READER_FONT, width: 40 }}
      >
        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-center rounded-md transition-all mt-3"
          style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>

        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={toggleCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 28, height: 28, color: 'var(--text-dim)', fontSize: 14 }}
            title={t('fm.expand')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.background = 'transparent' }}
          >
            <IconFolderOpen width={18} height={18} />
          </button>
        </div>

        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-center rounded-md transition-all mb-3"
          style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>
      </div>
    )
  }

  const gitVisible = rightPanelTab === 'git' && !collapsed

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-title-bar">
        <span>◆</span>
        {/* Tab labels stay English in both locales (ui-style-guide §12) */}
        <button
          className={`title-bar-tab ${rightPanelTab === 'files' ? 'active' : ''}`}
          onClick={() => setRightPanelTab('files')}
        >
          FILES
        </button>
        <button
          className={`title-bar-tab ${rightPanelTab === 'git' ? 'active' : ''}`}
          onClick={() => setRightPanelTab('git')}
        >
          GIT
        </button>
        <span className="title-bar-spacer" />
        {activeWorkspaceId && <span className="title-bar-path">~/{activeWorkspaceId}</span>}
        {!isMobile && (
          <button
            className="title-bar-collapse"
            onClick={toggleCollapsed}
            title={t('fm.collapse')}
          >
            ▶
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: rightPanelTab === 'files' ? 'flex' : 'none', flexDirection: 'column' }}>
        <FileManager />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: rightPanelTab === 'git' ? 'flex' : 'none', flexDirection: 'column' }}>
        <GitPanel visible={gitVisible} />
      </div>
    </div>
  )
}
