import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 19778,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:19777',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
