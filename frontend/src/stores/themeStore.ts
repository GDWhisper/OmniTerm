import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'system'

interface ThemeState {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement
  if (resolved === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export const useThemeStore = create<ThemeState>((set) => {
  const saved = (localStorage.getItem('omniterm_theme') as Theme) || 'system'
  const resolved = resolveTheme(saved)
  applyTheme(resolved)

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    set((state) => {
      if (state.theme === 'system') {
        const r = resolveTheme('system')
        applyTheme(r)
        return { resolved: r }
      }
      return state
    })
  })

  return {
    theme: saved,
    resolved,
    setTheme: (theme) => {
      localStorage.setItem('omniterm_theme', theme)
      const resolved = resolveTheme(theme)
      applyTheme(resolved)
      set({ theme, resolved })
    },
  }
})
