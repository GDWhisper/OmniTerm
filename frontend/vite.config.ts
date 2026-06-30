import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendPort = process.env.BACKEND_PORT || '9777'
const frontendPort = process.env.FRONTEND_PORT || '9778'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(frontendPort),
    host: '0.0.0.0',
    allowedHosts: ['term-main.tokitoken.com'],
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
