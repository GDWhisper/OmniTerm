import { useEffect, useState } from 'react'
import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { AttentionProvider } from './components/Attention/AttentionProvider'
import { AuthPage } from './components/Auth/AuthPage'
import { useMobileDetection } from './hooks/useMediaQuery'
import { useImmersive } from './hooks/useImmersive'
import { useThemeStore } from './stores/themeStore'
import { useAppStore } from './stores/appStore'
import { api } from './api/client'

function App() {
  useMobileDetection()
  useImmersive()

  const resolved = useThemeStore((s) => s.resolved)
  const { authState, setAuthState, setAuthEnabled, parchmentTextureEnabled, pixelFontEnabled } = useAppStore()
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    document.body.classList.toggle('parchment-texture', resolved === 'light' && parchmentTextureEnabled)
    document.body.classList.toggle('pixel-font-on', pixelFontEnabled)
  }, [resolved, parchmentTextureEnabled, pixelFontEnabled])

  useEffect(() => {
    api.check()
      .then((res) => {
        setAuthEnabled(res.auth_enabled ?? true)
        if (res.authenticated) {
          setAuthState('authenticated')
        } else {
          setNeedsSetup(res.needs_setup ?? false)
          setAuthState('unauthenticated')
        }
      })
      .catch(() => setAuthState('unauthenticated'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (authState === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-base)' }}>
        <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 13 }}>...</span>
      </div>
    )
  }

  if (authState === 'unauthenticated') {
    return (
      <>
        <AuthPage needsSetup={needsSetup} />
        <ToastContainer />
      </>
    )
  }

  return (
    <AttentionProvider>
      <Layout />
      <ToastContainer />
    </AttentionProvider>
  )
}

export default App
