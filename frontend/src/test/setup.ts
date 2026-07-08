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
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    // xterm.js v6 still uses the deprecated addListener/removeListener
    // API (via matchMedia), which jsdom does not implement.  Without
    // these the xterm constructor throws in jsdom.
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
})

// jsdom does not implement ResizeObserver.  Terminal tests that mount a
// session trigger useTerminal's createTerminal, which instantiates a
// ResizeObserver inside an async callback; without this polyfill the
// async path throws a ReferenceError after the test has unmounted,
// surfacing as an unhandled rejection.  A no-op observer is enough —
// we're not testing layout in these unit tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
