import { useEffect } from 'react'
import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { AttentionProvider } from './components/Attention/AttentionProvider'
import { useMobileDetection } from './hooks/useMediaQuery'
import { useImmersive } from './hooks/useImmersive'
import { useThemeStore } from './stores/themeStore'

function App() {
  useMobileDetection()
  useImmersive()

  const resolved = useThemeStore((s) => s.resolved)

  useEffect(() => {
    document.body.classList.toggle('parchment-texture', resolved === 'light')
  }, [resolved])

  return (
    <AttentionProvider>
      <Layout />
      <ToastContainer />
    </AttentionProvider>
  )
}

export default App
