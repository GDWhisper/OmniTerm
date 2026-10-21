import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatInput } from './ChatInput'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { saveDraft } from '../../utils/chatDraft'
import { clearAllAttachmentDrafts } from '../../utils/chatAttachmentDraft'
import '../../i18n'

// jsdom 没有 createImageBitmap/canvas：图片管线直接 mock 掉，聚焦本组件的行为
// （加号入口、附件 chip、发送与入队门控、会话切换清理）。
vi.mock('../../utils/imageAttachment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/imageAttachment')>()
  return {
    ...actual,
    processImageFile: vi.fn(async (file: File) => ({
      id: `img-${file.name}`,
      data: 'AAAA',
      mimeType: file.type || 'image/png',
    })),
  }
})

vi.mock('../../utils/fileAttachment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/fileAttachment')>()
  return {
    ...actual,
    processFile: vi.fn(async (file: File) => ({
      id: `file-${file.name}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      data: 'BBBB',
    })),
  }
})

interface RenderOverrides {
  sessionId?: string
  disabled?: boolean
  sending?: boolean
  imageSupported?: boolean
  fileSupported?: boolean
  workspacePath?: string
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useChatStore.setState({ pendingInsert: null, pendingMention: null })
  useToastStore.setState({ toasts: [] })
  sessionStorage.clear()
  clearAllAttachmentDrafts()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(overrides: RenderOverrides = {}, strict = false) {
  const props = {
    sessionId: 's1',
    disabled: false,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onCancelQueued: vi.fn(),
    onSendNow: vi.fn(),
    sending: false,
    queuedMessage: null as string | null,
    imageSupported: true,
    fileSupported: true,
    workspacePath: '/repo',
    ...overrides,
  }
  act(() => {
    const element = <ChatInput {...props} />
    root.render(strict ? <StrictMode>{element}</StrictMode> : element)
  })
  return props
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!
}

function typeText(value: string, caret = value.length) {
  act(() => {
    const el = textarea()
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.setSelectionRange(caret, caret)
    // React 的 onSelect 由 SelectEventPlugin 合成（selectionchange/mouseup 等），
    // 单纯派发原生 select 事件不会触发。
    document.dispatchEvent(new Event('selectionchange'))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

function requestMention(sessionId: string, paths: string[]) {
  act(() => {
    useChatStore.getState().requestMention(sessionId, paths)
  })
}

function attachButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-toggle="chat-attach"]')
}

function drawer(): HTMLElement | null {
  return document.body.querySelector('.pixel-float')
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

/** 相册 input 在前、文件 input 在后。 */
function fileInput(): HTMLInputElement {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]')
  return inputs[1]
}

function imageInput(): HTMLInputElement {
  return container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0]
}

function removeFileButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[title="Remove file"]')
}

async function pickFile(name: string, type: string, body = 'hello') {
  const input = fileInput()
  const file = new File([body], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function pickImage(name = 'a.png', type = 'image/png') {
  const input = imageInput()
  const file = new File(['img'], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function imageThumbs(): HTMLImageElement[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>('img'))
}

describe('ChatInput attach entry', () => {
  it('renders the plus button when a capability is supported', () => {
    render()
    expect(attachButton()).toBeTruthy()
  })

  it('renders the plus button when only file attachments are supported', () => {
    render({ imageSupported: false, fileSupported: true })
    expect(attachButton()).toBeTruthy()
  })

  it('hides the plus button when neither capability is supported', () => {
    render({ imageSupported: false, fileSupported: false })
    expect(attachButton()).toBeNull()
  })

  it('opens and closes the drawer on repeated clicks', () => {
    render()
    expect(drawer()).toBeNull()
    act(() => attachButton()!.click())
    expect(drawer()).toBeTruthy()
    act(() => attachButton()!.click())
    expect(drawer()).toBeNull()
  })

  it('closes the drawer after picking from the file card', () => {
    render()
    act(() => attachButton()!.click())
    const fileCard = Array.from(drawer()!.querySelectorAll('button'))[1]
    act(() => fileCard.click())
    expect(drawer()).toBeNull()
  })
})

describe('ChatInput file attachments', () => {
  it('adds a file chip after the file input changes', async () => {
    render()
    await pickFile('a.pdf', 'application/pdf')
    expect(container.textContent).toContain('a.pdf')
    expect(removeFileButton()).toBeTruthy()
  })

  it('removes the file chip', async () => {
    render()
    await pickFile('a.pdf', 'application/pdf')
    act(() => removeFileButton()!.click())
    expect(container.textContent).not.toContain('a.pdf')
    expect(removeFileButton()).toBeNull()
  })

  it('sends a file-only message (no text required)', async () => {
    const props = render()
    await pickFile('a.pdf', 'application/pdf')
    const send = buttons()[buttons().length - 1]
    act(() => send.click())
    expect(props.onSend).toHaveBeenCalledTimes(1)
    const [, images, files] = props.onSend.mock.calls[0]
    expect(images).toBeUndefined()
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('a.pdf')
    // 发送后附件清空
    expect(removeFileButton()).toBeNull()
  })

  it('disables the queue button while a file attachment is present', async () => {
    render({ sending: true })
    await pickFile('a.pdf', 'application/pdf')
    const queue = buttons()[buttons().length - 1]
    expect(queue.textContent).toBe('Queue')
    expect(queue.disabled).toBe(true)
  })

  it('keeps attachments per session and restores them when switching back', async () => {
    const props = render()
    await pickFile('a.pdf', 'application/pdf')
    expect(container.textContent).toContain('a.pdf')

    act(() => {
      root.render(<ChatInput {...props} sessionId="s2" />)
    })
    // 新会话看不到旧会话的附件……
    expect(container.textContent).not.toContain('a.pdf')

    // ……切回原会话时恢复（不再像以前那样清空）。
    act(() => {
      root.render(<ChatInput {...props} sessionId="s1" />)
    })
    expect(container.textContent).toContain('a.pdf')
    expect(removeFileButton()).toBeTruthy()
  })

  it('restores image attachments across a remount of ChatInput', async () => {
    const props = render()
    await pickImage()
    expect(imageThumbs()).toHaveLength(1)

    // production 路径：ChatView 用 key=sessionId 重挂载组件。
    act(() => {
      root.render(<ChatInput key="s1-remounted" {...props} />)
    })
    expect(imageThumbs()).toHaveLength(1)
    expect(imageThumbs()[0].getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('does not restore attachments that were already sent', async () => {
    const props = render()
    await pickFile('a.pdf', 'application/pdf')
    act(() => buttons()[buttons().length - 1].click())

    act(() => {
      root.render(<ChatInput {...props} sessionId="s2" />)
    })
    act(() => {
      root.render(<ChatInput {...props} sessionId="s1" />)
    })
    expect(container.textContent).not.toContain('a.pdf')
  })
})

describe('ChatInput file drag mention', () => {
  it('inserts a workspace-relative @ reference without sending', () => {
    const props = render()
    requestMention('s1', ['/repo/src/main.rs'])

    expect(textarea().value).toBe('@src/main.rs ')
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('inserts at the last collapsed caret', () => {
    render()
    typeText('hello world', 5)
    requestMention('s1', ['/repo/src/a.ts'])

    expect(textarea().value).toBe('hello @src/a.ts  world')
  })

  it('appends to a never-focused draft', () => {
    saveDraft('s1', 'draft text')
    render()
    requestMention('s1', ['/repo/src/a.ts'])

    expect(textarea().value).toBe('draft text @src/a.ts ')
  })

  it('replaces an active @ token', () => {
    render()
    typeText('look @src', 9)
    requestMention('s1', ['/repo/src/main.rs'])

    expect(textarea().value).toBe('look @src/main.rs ')
  })

  it('skips paths outside the workspace and reports a warning', () => {
    render()
    requestMention('s1', ['/other/a.ts'])

    expect(textarea().value).toBe('')
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'warning' }),
    ])
  })

  it('skips paths that cannot be represented as @ tokens', () => {
    render()
    requestMention('s1', ['/repo/a b.ts'])

    expect(textarea().value).toBe('')
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'warning' }),
    ])
  })

  it('ignores mentions for another session', () => {
    render()
    requestMention('s2', ['/repo/a.ts'])

    expect(textarea().value).toBe('')
    expect(useChatStore.getState().pendingMention?.sessionId).toBe('s2')
  })

  it('consumes but does not insert while disabled', () => {
    render({ disabled: true })
    requestMention('s1', ['/repo/a.ts'])

    expect(textarea().value).toBe('')
    expect(useChatStore.getState().pendingMention).toBeNull()
    expect(container.querySelector('[data-at-mention-drop="true"]')).toBeNull()
  })

  it('inserts exactly once under StrictMode', () => {
    render({}, true)
    requestMention('s1', ['/repo/a.ts'])

    expect(textarea().value).toBe('@a.ts ')
  })
})
