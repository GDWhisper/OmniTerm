import { useRef, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useTerminal } from '../../hooks/useTerminal'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const fontSize = useAppStore((s) => s.fontSize)
  const { initTerminal } = useTerminal({ sessionId: activeSessionId, fontSize })

  useEffect(() => {
    if (containerRef.current) {
      const cleanup = initTerminal(containerRef.current)
      return cleanup
    }
  }, [initTerminal])

  if (!activeSessionId) {
    return (
      <div
        className="h-full flex items-center justify-center"
        style={{ background: '#0a0a0f', color: '#64748b', fontFamily: FONT }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 40,
              marginBottom: 16,
              filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))',
            }}
          >
            ⌨️
          </div>
          <div style={{ fontSize: 14, color: '#94a3b8' }}>选择或创建一个会话</div>
          <div style={{ fontSize: 12, marginTop: 8, color: '#475569' }}>
            使用左侧边栏开始
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', background: '#0a0a0f' }}>
      <div ref={containerRef} className="h-full w-full p-1" />
    </div>
  )
}
