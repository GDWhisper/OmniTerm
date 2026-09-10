import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatInput } from './ChatInput'
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
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(overrides: RenderOverrides = {}) {
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
    ...overrides,
  }
  act(() => {
    root.render(<ChatInput {...props} />)
  })
  return props
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

  it('clears attachments when the session changes', async () => {
    const props = render()
    await pickFile('a.pdf', 'application/pdf')
    expect(container.textContent).toContain('a.pdf')
    act(() => {
      root.render(<ChatInput {...props} sessionId="s2" />)
    })
    expect(container.textContent).not.toContain('a.pdf')
  })
})
