import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MobileKeyBar } from './MobileKeyBar'

function setup(props: Partial<Parameters<typeof MobileKeyBar>[0]> = {}) {
  const onKey = vi.fn()
  const onToggleScrollMode = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  function Wrapper() {
    const [latchMod, setLatchMod] = useState<string | null>(null)
    return (
      <MobileKeyBar
        latchMod={latchMod}
        onSetLatchMod={setLatchMod}
        onKey={onKey}
        scrollMode={false}
        onToggleScrollMode={onToggleScrollMode}
        {...props}
      />
    )
  }

  root.render(<Wrapper />)
  return { container, root, onKey, onToggleScrollMode }
}

function teardown(container: HTMLElement, root: Root) {
  root.unmount()
  document.body.removeChild(container)
}

function btn(container: HTMLElement, text: string): HTMLElement | null {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) ?? null
}

async function findBtn(container: HTMLElement, text: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const b = btn(container, text)
    expect(b).toBeTruthy()
    return b!
  })
}

describe('MobileKeyBar', () => {
  it('calls onKey when special key pressed', async () => {
    const { container, root, onKey } = setup()
    const esc = await findBtn(container, 'Esc')
    esc.click()
    expect(onKey).toHaveBeenCalledWith('Esc')
    teardown(container, root)
  })

  it('activates modifier latch on click', async () => {
    const { container, root, onKey } = setup()
    const shift = await findBtn(container, 'Shift')
    shift.click()
    // Clicking Shift alone should not call onKey (it only toggles latch)
    expect(onKey).not.toHaveBeenCalled()
    teardown(container, root)
  })

  it('releases modifier latch on second click', async () => {
    const { container, root, onKey } = setup()
    const shift = await findBtn(container, 'Shift')
    shift.click() // latch
    flushSync()
    shift.click() // release
    flushSync()
    const tab = await findBtn(container, 'Tab')
    tab.click()
    // Latch was released → plain key
    expect(onKey).toHaveBeenCalledWith('Tab')
    teardown(container, root)
  })

  it('sends combo when modifier latched + action key pressed', async () => {
    const { container, root, onKey } = setup()
    const shift = await findBtn(container, 'Shift')
    shift.click() // latch Shift
    const tab = await findBtn(container, 'Tab')
    tab.click()
    expect(onKey).toHaveBeenCalledWith('Shift+Tab')
    teardown(container, root)
  })

  it('releases latch after sending combo', async () => {
    const { container, root, onKey } = setup()
    const ctrl = await findBtn(container, 'Ctrl')
    ctrl.click() // latch Ctrl
    const up = await findBtn(container, '↑')
    up.click()
    expect(onKey).toHaveBeenCalledWith('Ctrl+↑')
    onKey.mockClear()

    // Latch released → next press should be plain
    const down = await findBtn(container, '↓')
    down.click()
    expect(onKey).toHaveBeenCalledWith('↓')
    teardown(container, root)
  })

  it('sends Shift+Tab combo', async () => {
    const { container, root, onKey } = setup()
    const shift = await findBtn(container, 'Shift')
    shift.click() // latch Shift
    const tab = await findBtn(container, 'Tab')
    tab.click()
    expect(onKey).toHaveBeenCalledWith('Shift+Tab')
    teardown(container, root)
  })

  it('sends Ctrl+arrow combo', async () => {
    const { container, root, onKey } = setup()
    const ctrl = await findBtn(container, 'Ctrl')
    ctrl.click() // latch Ctrl
    const left = await findBtn(container, '←')
    left.click()
    expect(onKey).toHaveBeenCalledWith('Ctrl+←')
    teardown(container, root)
  })

  it('switches modifier latch when different mod clicked', async () => {
    const { container, root, onKey } = setup()
    const ctrl = await findBtn(container, 'Ctrl')
    ctrl.click() // latch Ctrl
    const alt = await findBtn(container, 'Alt')
    alt.click() // switch to Alt
    const esc = await findBtn(container, 'Esc')
    esc.click()
    expect(onKey).toHaveBeenCalledWith('Alt+Esc')
    teardown(container, root)
  })
})
