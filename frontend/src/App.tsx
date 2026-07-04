import { useEffect } from 'react'
import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { AttentionProvider } from './components/Attention/AttentionProvider'
import { useMobileDetection } from './hooks/useMediaQuery'
import { useImmersive } from './hooks/useImmersive'
import { useThemeStore } from './stores/themeStore'
import { useAppStore } from './stores/appStore'

function App() {
  useMobileDetection()
  useImmersive()

  const resolved = useThemeStore((s) => s.resolved)
  const { parchmentTextureEnabled } = useAppStore()

  useEffect(() => {
    document.body.classList.toggle('parchment-texture', resolved === 'light' && parchmentTextureEnabled)
    document.body.classList.add('pixel-font-on')
    document.body.classList.add('pixel-ui-on')
  }, [resolved, parchmentTextureEnabled])

  return (
    <AttentionProvider>
      <Layout />
      <ToastContainer />
    </AttentionProvider>
  )
}

export default App
