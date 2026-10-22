import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useFileDrag } from './useFileDrag'

const mocks = vi.hoisted(() => ({
  moveFiles2: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: { moveFiles2: mocks.moveFiles2 },
}))

interface HarnessProps {
  onDropAtMention: (paths: string[]) => void
  onSendClick: () => void
}

function Harness({ onDropAtMention, onSendClick }: HarnessProps) {
  const { handlePointerDown } = useFileDrag({
    cwd: '/repo',
    selected: new Set<string>(),
    fmSource: { type: 'session', id: 's1' },
    activeProjectId: null,
    onMoveComplete: vi.fn(),
    onDropAtMention,
  })
  const entry = { path_type: 'File' as const, name: 'a.ts', mtime: 0, size: 1 }
  return (
    <div>
      <span data-testid="source" onPointerDown={(e) => handlePointerDown(e, entry)}>file</span>
      <div data-testid="chat" data-at-mention-drop="true" />
      <div data-testid="folder" data-drop-path="/repo/dir" />
      <button data-testid="send" onClick={onSendClick}>Send</button>
    </div>
  )
}

let container: HTMLDivElement
let root: Root
let originalElementFromPoint: PropertyDescriptor | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  mocks.moveFiles2.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  // Consume the one-shot click suppressor installed by the hook, so it does not
  // leak into the next test (the hook removes it after the first click).
  window.dispatchEvent(new MouseEvent('click'))
  if (originalElementFromPoint) {
    Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint)
  } else {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
  }
})

function stubElementFromPoint(el: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: vi.fn(() => el),
  })
}

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
  })
}

async function dragTo(x: number, y: number) {
  const source = container.querySelector('[data-testid="source"]')!
  await act(async () => {
    source.dispatchEvent(pointerEvent('pointerdown', 0, 0))
    document.dispatchEvent(pointerEvent('pointermove', x, y))
    document.dispatchEvent(pointerEvent('pointerup', x, y))
  })
}

function render(
  onDropAtMention: (paths: string[]) => void,
  onSendClick: () => void = vi.fn(),
) {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <Harness onDropAtMention={onDropAtMention} onSendClick={onSendClick} />
      </I18nextProvider>,
    )
  })
}

describe('useFileDrag @ mention drop', () => {
  it('drops onto a mention target without moving the file', async () => {
    const onDropAtMention = vi.fn()
    const onSendClick = vi.fn()
    render(onDropAtMention, onSendClick)
    stubElementFromPoint(container.querySelector('[data-testid="chat"]')!)

    await dragTo(20, 20)

    expect(onDropAtMention).toHaveBeenCalledWith(['/repo/a.ts'])
    expect(mocks.moveFiles2).not.toHaveBeenCalled()

    // 触摸/浏览器可能在落点合成 click：第一次必须被吞掉，第二次恢复。
    const send = container.querySelector<HTMLButtonElement>('[data-testid="send"]')!
    act(() => send.click())
    expect(onSendClick).not.toHaveBeenCalled()
    act(() => send.click())
    expect(onSendClick).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the pointer is not over a drop target', async () => {
    const onDropAtMention = vi.fn()
    render(onDropAtMention)
    stubElementFromPoint(null)

    await dragTo(20, 20)

    expect(onDropAtMention).not.toHaveBeenCalled()
    expect(mocks.moveFiles2).not.toHaveBeenCalled()
  })

  it('still moves files onto a data-drop-path target', async () => {
    const onDropAtMention = vi.fn()
    render(onDropAtMention)
    stubElementFromPoint(container.querySelector('[data-testid="folder"]')!)

    await dragTo(20, 20)

    expect(onDropAtMention).not.toHaveBeenCalled()
    expect(mocks.moveFiles2).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ['/repo/a.ts'],
        destination: '/repo/dir',
      }),
    )
  })
})
