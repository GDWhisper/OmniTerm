import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

export function canFullscreen(): boolean {
  const d = document as unknown as Record<string, unknown>
  return !!(document.fullscreenEnabled || d.webkitFullscreenEnabled)
}

function isFullscreen(): boolean {
  const d = document as unknown as Record<string, unknown>
  return !!(document.fullscreenElement || d.webkitFullscreenElement)
}

async function enterFS() {
  const el = document.documentElement as unknown as Record<string, () => Promise<void>>
  try {
    if (el.requestFullscreen) await el.requestFullscreen()
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
  } catch { /* ignore */ }
}

async function exitFS() {
  const d = document as unknown as Record<string, unknown | (() => Promise<void>)>
  try {
    if (document.exitFullscreen) await document.exitFullscreen()
    else if (typeof d.webkitExitFullscreen === 'function') await (d.webkitExitFullscreen as () => Promise<void>)()
  } catch { /* ignore */ }
}

export function useImmersive() {
  const immersiveMode = useAppStore((s) => s.immersiveMode)
  const setImmersiveMode = useAppStore((s) => s.setImmersiveMode)

  // Apply fullscreen when state changes
  useEffect(() => {
    if (!canFullscreen()) return
    if (immersiveMode && !isFullscreen()) enterFS()
    else if (!immersiveMode && isFullscreen()) exitFS()
  }, [immersiveMode])

  // Sync state when fullscreen changes externally (ESC key, browser UI)
  useEffect(() => {
    const onChange = () => setImmersiveMode(isFullscreen())
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [setImmersiveMode])
}
