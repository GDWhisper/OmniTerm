import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 分支专属变量从 .env.local 读（dev.sh 已 source 并 export）
// 详见 AGENTS.md "配置统一管理" 规则
const backendPort = process.env.BACKEND_PORT || '9075'
const frontendPort = process.env.FRONTEND_PORT || '9076'
const domain = process.env.DOMAIN || 'localhost'
const branchVersion = process.env.BRANCH_VERSION || '0.0.0'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 注入分支版本给前端（运行时代码可用 import.meta.env.VITE_APP_VERSION 访问）
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(branchVersion),
  },
  server: {
    port: Number(frontendPort),
    host: '0.0.0.0',
    allowedHosts: [domain, 'localhost'],
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
