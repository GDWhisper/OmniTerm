import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 分支专属变量从 .env.local 读（dev.sh 已 source 并 export）
// 详见 AGENTS.md "配置统一管理" 规则
const backendPort = process.env.BACKEND_PORT || '9075'
const frontendPort = process.env.FRONTEND_PORT || '9076'
const domain = process.env.DOMAIN || 'localhost'

// 版本号唯一真相源 = Cargo.toml（git 跟踪，随分支 merge 同步）
// 不再依赖 .env.local 的 BRANCH_VERSION，避免各 worktree 版本号失同步
function readCargoVersion(): string {
  const cargoToml = readFileSync(resolve(__dirname, '..', 'Cargo.toml'), 'utf-8')
  const m = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)
  return m ? m[1] : '0.0.0'
}
const branchVersion = readCargoVersion()

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
