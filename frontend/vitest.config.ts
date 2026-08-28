import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // 性能基准（src/bench/）不进 `pnpm test`：它测的是编码耗时绝对值，
    // 在 vitest 并发跑满 48 个测试文件时会被调度噪声放大两个数量级
    // （单独跑 0.2ms，全量跑曾报到 16.9ms 越过 16ms 预算），随机失败会
    // 卡住 pre-commit。基准改为按需执行：`pnpm bench`（单线程、无并发）。
    exclude: ['**/node_modules/**', '**/dist/**', 'src/bench/**'],
  },
})
