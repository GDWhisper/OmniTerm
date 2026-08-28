import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js')
}

// 开发期调试钩子：在控制台/Playwright 通过 window.__appStore 直接调 store action
//（不打包到生产构建，import.meta.env.DEV 由 Vite 在构建时内联为 false）
if (import.meta.env.DEV) {
  // 动态 import 避免在生产 bundle 中引用 useAppStore
  import('./stores/appStore').then(({ useAppStore }) => {
    ;(window as unknown as { __appStore: typeof useAppStore }).__appStore = useAppStore
  })
}
