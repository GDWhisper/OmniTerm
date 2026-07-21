# 前端内存优化：剩余项（Tier 3-4）

> **来源**：从 `performance-optimization.md`（2026-06-28）提取。原文 Tier 1（删 dead deps）和 Tier 2（CodeMirror 按需加载）已于 2026-07 实施完毕并归档。
> **状态**：待排期
> **日期**：2026-07-19

---

## 已完成项（不再需要）

| 原 Tier | 内容 | 完成时间 |
|---------|------|---------|
| Tier 1 | 删 `@cubone/react-file-manager`、`xterm@5`、`@codemirror/autocomplete`、`@codemirror/lint` | 2026-07 |
| Tier 2 | CodeMirror 13 lang 包从 static import 改为按扩展名 dynamic import | 2026-07 |
| 补充 | xterm addon-fit / addon-web-links 动态加载 | 2026-07 |
| 补充 | audioFeedback 动态 import（修 IneffectiveDynamicImport） | 2026-07 |

---

## Tier 3：配置级优化（预计回收 30-80 MB dev 内存，中风险）

### 3.1 i18next 按需 locale

**现状**（2026-07-19 验证）：
- `src/i18n.ts` 使用 `i18next-browser-languagedetector`（v8.2.1）
- 项目只有 2 个 locale：`en`、`zh`
- detector 默认探测 navigator 全部语言偏好列表，但实际只匹配 2 个

**优化方案**：
- 方案 A：移除 `i18next-browser-languagedetector`，改为 `navigator.language.startsWith('zh') ? 'zh' : 'en'` 一行判断
- 方案 B：保留 detector 但配置 `checkWhitelist: true` + `supportedLngs: ['en', 'zh']`，限制探测范围

**预期收益**：20-40 MB（detector 模块 + 探测逻辑持有的内部状态）
**风险**：低。只有 2 个 locale，逻辑极简。
**建议**：方案 A 最干净（奥卡姆剃刀），但方案 B 保留用户手动切语言的能力。如果 Settings 里有语言切换 UI，选 B。

### 3.2 Tailwind 4 vite plugin content 排除

**现状**（2026-07-19 验证）：
- `vite.config.ts` 中 `tailwindcss()` 无配置参数
- Tailwind 4 的 vite plugin 默认扫描所有 `.ts/.tsx/.html` 文件构建 utility class 索引
- dev 模式下 AST 持有是内存大头之一

**优化方案**：
```ts
tailwindcss({
  // 排除不需要扫描的目录
  exclude: ['node_modules', 'dist', 'src/**/*.test.tsx', 'src/**/*.test.ts'],
})
```

**预期收益**：30-50 MB（减少 AST 持有量）
**风险**：中。需确认排除的文件中没有被实际引用的 class（测试文件通常没有，但需验证）。
**建议**：先排除测试文件（零风险），再评估是否需要更细粒度排除。

### 3.3 后端 release build（部署场景）

**现状**：dev 用 `cargo run`（debug profile），30 MB RSS。
**优化方案**：部署时用 `cargo build --release`，预期 RSS 降至 10-15 MB。
**风险**：低。仅影响部署，不影响开发体验。
**建议**：Dockerfile 已经是 release build 则无需额外操作。仅在日常 `./dev.sh` 场景下无意义（编译慢 2-5x）。

---

## Tier 4：架构级优化（高风险，远期）

| 方案 | 预期收益 | 风险 | 触发条件 | 建议 |
|------|---------|------|---------|------|
| CodeMirror → Monaco Editor | idle 内存可能更低、LSP 集成强 | 高：worker 线程复杂、首次打开慢 500ms+、bundle 体积反而更大 | 需支持 50+ 语言 + 复杂 LSP 集成 | **不建议**。CodeMirror 已按需加载，Monaco 的 worker 模型在单文件编辑器场景下是过度设计 |
| 拆 Vite micro-frontend（FileEditor 独立 build） | dev 内存 -30% | 高：状态同步、路由、CSS 隔离、构建复杂度翻倍 | 企业级、多团队维护 | **不建议**。OmniTerm 是单人/小团队项目，复杂度收益比极差 |
| 日常用 `pnpm preview` 替代 `pnpm dev` | 内存 -50%（无 HMR 进程） | 高：失去 HMR，每次改动需手动刷新 | 仅性能测试或 demo 时 | **可选**。跑 demo 或做性能基线测量时临时用，不作为日常开发模式 |

---

## 综合建议

1. **Tier 3 优先级低**：当前 dev 内存的主要瓶颈（CodeMirror lang 包、dead deps）已解决。剩余 30-80 MB 的回收对开发体验影响有限（Vite dev server 本身占 500+ MB 是常态）。
2. **触发条件**：当项目功能完成度 ≥80%、或用户反馈明显卡顿、或 Vite/React 升大版本时再重新评估。
3. **Tier 4 全部不建议实施**：OmniTerm 的定位（单用户本地终端管理器）不需要企业级前端架构。
4. **如果只做一件事**：3.1 移除 language detector（5 分钟改完，零风险，代码更简洁）。

---

## 重新审视触发条件

满足任一时，重新测量基线并更新本文档：

- Vite 升 9.x 或更高
- React 升 20
- 任意新功能引入新的重型依赖（> 1MB npm 体积）
- 用户反馈明显的卡顿 / 内存问题
- 本文创建后 6 个月内未实施 → 重新评估是否还有价值
- 实施当天实测基线与预期偏差 > 30% → 假设失效，需重写
