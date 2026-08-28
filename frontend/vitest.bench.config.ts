import { defineConfig } from 'vitest/config'

/**
 * 性能基准专用配置 —— 与 `pnpm test` 分离，见 vitest.config.ts 的 exclude 注释。
 *
 * 关键差异：`fileParallelism: false` + `maxThreads: 1` 让基准跑在单线程无并发
 * 环境，测出的编码耗时才是可比较的绝对值（并发调度噪声会让同一份代码在
 * 0.2ms 与 16.9ms 之间跳变）。
 *
 * 按需执行：`pnpm bench`。不进 pre-commit（耗时基准不该做提交门禁）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/bench/**/*.test.ts'],
    fileParallelism: false,
    maxThreads: 1,
    minThreads: 1,
  },
})
