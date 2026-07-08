import { vi } from 'vitest'

// React 19 + vitest compatibility
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement matchMedia; polyfill for themeStore and useMediaQuery
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    // xterm.js v6 still uses the deprecated addListener/removeListener API.
    // jsdom's matchMedia doesn't implement them, so polyfill here.
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
})

// jsdom does not implement ResizeObserver. useTerminal installs one
// inside an async createTerminal; without this polyfill the async path
// throws ReferenceError after the test has unmounted, surfacing as an
// unhandled rejection. A no-op observer is enough — the test only needs
// the panel to mount, not a real layout flush.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

