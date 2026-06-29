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
    ├── Icons/ — GitBranchIcon.tsx, KeyboardIcon.tsx
    ├── Modal/ — Modal.tsx, ConfirmDialog.tsx
    └── Toast/ — Toast.tsx
```

## Key Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Vite proxy: `/api` → backend port (varies by branch `.env.local`)
