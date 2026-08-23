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
import { setProxyDomain } from './utils/proxyUrl'

function App() {
  useMobileDetection()
  useImmersive()

  const resolved = useThemeStore((s) => s.resolved)
  const { authState, connected, setAuthState, setAuthEnabled, parchmentTextureEnabled, pixelFontEnabled } = useAppStore()
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
      // Network errors (fetch throws TypeError) are NOT auth failures —
      // the backend may be temporarily unreachable. Skip so the loading
      // placeholder stays visible; Sidebar's health poll will try again
      // every 5 s, and the reconnect effect below re-checks auth once
      // connected becomes true.
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setAuthState, setAuthEnabled, setNeedsSetup])

  // When the Sidebar health poll brings the connection back, re-verify
  // auth so we recover from the initial "check failed" state without
  // requiring a page reload.
  useEffect(() => {
    if (!connected) return
    if (authState !== 'loading') return
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
      // If the backend dropped again between check and now, stay in
      // loading — the reconnect effect will fire again when it returns.
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, setAuthState, setAuthEnabled, setNeedsSetup])

  useEffect(() => {
    // 子域名代理 base：`/system/info` 的 `proxy_domain`（null = 未启用，回退路径前缀）。
    // 首次渲染未加载时 rewriteLocalUrl 自然回退路径前缀，加载后切子域名（链接在点击时才调用，无需重渲染）。
    api.systemInfo().then((res) => setProxyDomain(res.proxy_domain ?? null)).catch(() => {})
  }, [])

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
