import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * ConfirmDialog renders through Modal → createPortal(document.body).
 * Queries target document.body; React removes portal content on unmount.
 */
describe('ConfirmDialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
    vi.restoreAllMocks()
  })

  // root.render + portal 挂载是异步的（React 19），用 waitFor 等待 DOM 出现
  async function render(props: Parameters<typeof ConfirmDialog>[0]) {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ConfirmDialog {...props} />
      </I18nextProvider>,
    )
    if (props.open) {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(props.message)
      })
    }
  }

  function clickButtonByText(text: string) {
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === text)
    expect(btn, `button "${text}" not found`).toBeTruthy()
    btn!.click()
  }

  it('renders nothing when closed', async () => {
    await render({ open: false, onClose: () => {}, title: 'T', message: 'M', confirmText: 'OK' })
    expect(document.body.textContent).not.toContain('M')
  })

  it('renders message and confirm button when open', async () => {
    await render({ open: true, onClose: () => {}, title: 'T', message: 'Are you sure?', confirmText: 'OK' })
    expect(document.body.textContent).toContain('Are you sure?')
    clickButtonByText('OK')
  })

  it('without checkboxLabel calls onConfirm (legacy behavior unchanged)', async () => {
    const onConfirm = vi.fn()
    const onConfirmWithChecked = vi.fn()
    await render({ open: true, onClose: () => {}, onConfirm, onConfirmWithChecked, title: 'T', message: 'M', confirmText: 'OK' })
    expect(document.body.querySelector('input[type=checkbox]')).toBeNull()
    clickButtonByText('OK')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirmWithChecked).not.toHaveBeenCalled()
  })

  it('renders checkbox when checkboxLabel provided', async () => {
    await render({ open: true, onClose: () => {}, onConfirmWithChecked: () => {}, title: 'T', message: 'M', checkboxLabel: 'Skip', confirmText: 'OK' })
    const box = document.body.querySelector('input[type=checkbox]')
    expect(box).toBeTruthy()
    expect(document.body.textContent).toContain('Skip')
  })

  it('passes checked=false to onConfirmWithChecked when unchecked', async () => {
    const onConfirmWithChecked = vi.fn()
    await render({ open: true, onClose: () => {}, onConfirmWithChecked, title: 'T', message: 'M', checkboxLabel: 'Skip', confirmText: 'OK' })
    clickButtonByText('OK')
    expect(onConfirmWithChecked).toHaveBeenCalledWith(false)
  })

  it('passes checked=true to onConfirmWithChecked after checking the box', async () => {
    const onConfirmWithChecked = vi.fn()
    await render({ open: true, onClose: () => {}, onConfirmWithChecked, title: 'T', message: 'M', checkboxLabel: 'Skip', confirmText: 'OK' })
    const box = document.body.querySelector('input[type=checkbox]') as HTMLInputElement
    box.click()
    await vi.waitFor(() => expect(box.checked).toBe(true))
    clickButtonByText('OK')
    expect(onConfirmWithChecked).toHaveBeenCalledWith(true)
  })

  it('resets the checkbox to unchecked on reopen', async () => {
    const onConfirmWithChecked = vi.fn()
    const props = { open: true, onClose: () => {}, onConfirmWithChecked, title: 'T', message: 'M', checkboxLabel: 'Skip', confirmText: 'OK' }
    await render(props)
    const box = document.body.querySelector('input[type=checkbox]') as HTMLInputElement
    box.click()
    await vi.waitFor(() => expect(box.checked).toBe(true))
    // Close → reopen；每次重新查询节点（React 会重建 portal DOM）
    await render({ ...props, open: false })
    await vi.waitFor(() => expect(document.body.querySelector('input[type=checkbox]')).toBeNull())
    await render(props)
    const reopened = () => document.body.querySelector('input[type=checkbox]') as HTMLInputElement
    await vi.waitFor(() => expect(reopened().checked).toBe(false))
    reopened().click()
    await vi.waitFor(() => expect(reopened().checked).toBe(true))
    clickButtonByText('OK')
    expect(onConfirmWithChecked).toHaveBeenCalledWith(true)
  })
})
