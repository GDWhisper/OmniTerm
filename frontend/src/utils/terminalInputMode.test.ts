import { describe, it, expect } from 'vitest'
import { SCROLL_INPUTMODE, NORMAL_INPUTMODE, syncTextareaInputMode } from './terminalInputMode'

/** Build a fake xterm container that holds a <textarea>, mirroring the
 *  minimal DOM shape that @xterm/xterm produces inside its host element. */
function fakeContainer(): HTMLDivElement {
  const container = document.createElement('div')
  // xterm's textarea lives inside the .xterm-helper element; we don't need
  // that wrapper for the test — querySelector('textarea') on the container
  // works because that's exactly what useTerminal's IME composition handler
  // does in production.
  const textarea = document.createElement('textarea')
  container.appendChild(textarea)
  return container
}

describe('syncTextareaInputMode', () => {
  it('sets inputmode="none" on the textarea when scrollMode is true', () => {
    const container = fakeContainer()
    syncTextareaInputMode(container, true)
    expect(container.querySelector('textarea')?.getAttribute('inputmode')).toBe('none')
  })

  it('sets inputmode="text" on the textarea when scrollMode is false', () => {
    const container = fakeContainer()
    // Pre-seed with "none" to prove the call overwrites, not just leaves alone.
    container.querySelector('textarea')!.setAttribute('inputmode', 'none')
    syncTextareaInputMode(container, false)
    expect(container.querySelector('textarea')?.getAttribute('inputmode')).toBe('text')
  })

  it('flips back to "text" after a true→false transition', () => {
    const container = fakeContainer()
    syncTextareaInputMode(container, true)
    syncTextareaInputMode(container, false)
    expect(container.querySelector('textarea')?.getAttribute('inputmode')).toBe('text')
  })

  it('is a no-op when the container is null', () => {
    // Should not throw. The function is called from a useEffect so a null
    // container just means the terminal hasn't been created yet.
    expect(() => syncTextareaInputMode(null, true)).not.toThrow()
  })

  it('is a no-op when the container has no textarea', () => {
    // xterm creates the textarea asynchronously inside term.open(); if the
    // effect fires before that, we just skip the sync this round — the next
    // scrollMode change will pick it up.
    const container = document.createElement('div')
    expect(() => syncTextareaInputMode(container, true)).not.toThrow()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('exposes the expected mode constants', () => {
    // Guard against accidental rename — useTerminal imports these by name.
    expect(SCROLL_INPUTMODE).toBe('none')
    expect(NORMAL_INPUTMODE).toBe('text')
  })
})
