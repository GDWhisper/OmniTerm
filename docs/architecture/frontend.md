# Frontend Architecture

React (Vite + TypeScript) frontend. Source under `frontend/src/`.

## Source Tree

```
src/
├── main.tsx, App.tsx, index.css
├── version.ts           # Single source of truth for version
├── i18n.ts              # i18n configuration
├── api/client.ts        # Typed fetch wrapper for all API endpoints
├── stores/
│   ├── appStore.ts      # Zustand: layout, projects, sessions, font size, mobile detection
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   └── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size
│   ├── useMediaQuery.ts # Mobile breakpoint detection
│   └── useFileWatcher.ts # SSE file watcher for live directory updates
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
└── components/
    ├── Layout/  — Layout.tsx, MobileNav.tsx
    ├── Sidebar/ — Sidebar.tsx
    ├── Terminal/ — Terminal.tsx
    ├── FileManager/ — FileManager.tsx, FileDrawer.tsx, FileEditor.tsx, FilePreview.tsx, icons.tsx
    ├── Settings/ — Settings.tsx, SettingsPopup.tsx
    ├── TmuxCheatsheet/ — TmuxCheatsheet.tsx (render), TmuxCheatsheetPopup.tsx (popup), data.ts (command list, single source of truth — 增/删/改命令改本文件 + 两个 translation.json；维护指引见 data.ts 顶部 JSDoc)
    ├── Icons/ — GitBranchIcon.tsx, KeyboardIcon.tsx
    ├── Modal/ — Modal.tsx, ConfirmDialog.tsx
    └── Toast/ — Toast.tsx
```

## Key Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Vite proxy: `/api` → backend port (varies by branch `.env.local`)

## React Hooks 约定（强制）

> 背景：曾因 `useCallback` 定义晚于引用它的 `useEffect` 触发 TDZ `ReferenceError`，
> 导致 `FileManager` 组件白屏（见 `FileManager.tsx` 修复记录）。以下规则用于从根上避免此类问题。

1. **`useCallback` / 普通 handler 必须定义在使用它的 `useEffect` 之前。**
   `useEffect` 的依赖数组在 render 阶段就会被求值以构造数组，若其中引用的
   `const` 尚未初始化（定义在其下方），会抛 `Cannot access 'X' before initialization`。
   即使该 handler 当前不在依赖数组里，也要保持"先定义、后引用"的顺序，防止后续为满足
   `exhaustive-deps` 把 handler 加进依赖数组时引爆 TDZ。
2. **依赖数组必须完整**：effect / `useCallback` 内引用的每个响应式值都要列入依赖数组，
   开启 `react-hooks/exhaustive-deps`；确需排除时必须写注释说明原因，禁止静默关闭。
3. **默认不 memoize**：`useMemo` / `useCallback` 只在以下情况使用——
   (a) 值传给 `React.memo` 子组件且 identity 敏感；(b) 值本身是另一个 hook 的依赖；
   (c) 计算经 profiling 确认昂贵。过早 memoize 增加噪音、掩盖 bug。
4. **hook 调用集中在组件顶部、任何条件逻辑之前**；禁止在循环 / 条件 / 嵌套函数 / 提前 return 之后调用。
5. **effect 只用于同步外部系统**（订阅、浏览器 API、第三方库），不用于派生状态、
   数据转换、通知父组件（应在事件处理中调用）。
6. 每个订阅 / 定时器 / 事件监听 / 在途请求都必须在 cleanup 中释放，避免内存泄漏与竞态。

