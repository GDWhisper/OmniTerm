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

  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark')
    document.body.classList.toggle('parchment-texture', theme === 'light')
  }, [theme])

  return (
    <AttentionProvider>
      <Layout />
      <ToastContainer />
    </AttentionProvider>
  )
}

export default App
