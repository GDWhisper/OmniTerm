import { describe, it, expect, vi, beforeEach } from 'vitest'
import { revealReportedPath } from './reportedPath'
import { useAppStore, type AppState } from '../stores/appStore'

describe('revealReportedPath', () => {
  let revealPathInFileManagerMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    revealPathInFileManagerMock = vi.fn()
    useAppStore.setState({
      activeSessionId: 'sess-123',
      // setState 只接受 AppState 形状；这里只覆盖这一个 action，其余保持真实现
      revealPathInFileManager: revealPathInFileManagerMock as unknown as AppState['revealPathInFileManager'],
    })
  })

  it('routes directories to navigation and files to the drawer', () => {
    revealReportedPath('/repo/src')
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', '/repo/src', true)

    revealReportedPath('/repo/src/main.rs')
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', '/repo/src/main.rs', false)
  })

  it('is a no-op when no session is active', () => {
    useAppStore.setState({ activeSessionId: null })
    revealReportedPath('/repo/src/main.rs')
    expect(revealPathInFileManagerMock).not.toHaveBeenCalled()
  })
})
