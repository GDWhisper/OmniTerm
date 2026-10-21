import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { ChatSearchBar } from './ChatSearchBar'
import { advanceClock } from '../../test/timers'
import en from '../../locales/en/translation.json'

/**
 * 搜索条组件（F06）：防抖检索、结果列表、以及**预算说明必须如实展示**
 * （超预算被截断 / 命中过多 / 关键词被丢）——静默截断会让用户以为搜全了，
 * 比搜不到更糟（计划 D4）。
 */

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

const HITS = [
  {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-08-10T00:00:00Z',
    snippet: '这里有上下文的说明',
    cursor: '2026-08-10T00:00:00Z|m1',
  },
]

function renderBar(overrides: Partial<Parameters<typeof ChatSearchBar>[0]> = {}) {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChatSearchBar
          sessionId="s1"
          onJump={vi.fn()}
          onClose={vi.fn()}
          {...overrides}
        />
      </I18nextProvider>,
    )
  })
}

async function typeQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      hits: HITS,
      matchCount: 1,
      moreMatches: false,
      scannedRows: 120,
      scannedBytes: 4096,
      truncated: false,
      termsTruncated: false,
    }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ChatSearchBar', () => {
  it('输入后经防抖发起检索并列出命中', async () => {
    renderBar()
    const input = container.querySelector<HTMLInputElement>('.chat-search-input')!
    await typeQuery(input, '上下文')

    // 防抖期内不发请求
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      await advanceClock(1000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/messages/search?q=')
    expect(container.querySelectorAll('.chat-search-hit')).toHaveLength(1)
    expect(container.querySelector('.chat-search-mark')?.textContent).toBe('上下文')
  })

  it('预算触顶时如实写明省略量（不静默截断）', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        hits: HITS,
        matchCount: 1,
        moreMatches: false,
        scannedRows: 120,
        scannedBytes: 4096,
        truncated: true,
        termsTruncated: true,
      }),
    }))
    renderBar()
    const input = container.querySelector<HTMLInputElement>('.chat-search-input')!
    await typeQuery(input, '上下文')
    await act(async () => {
      await advanceClock(1000)
    })
    const status = container.querySelector('.chat-search-status')!.textContent!
    expect(status).toContain('120')
    expect(status).toContain(en['chat.search.truncated'].replace('{{rows}}', '120'))
    expect(status).toContain(en['chat.search.termsTruncated'])
  })

  it('无结果时给明确空态文案（不是空白）', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        hits: [],
        matchCount: 0,
        moreMatches: false,
        scannedRows: 10,
        scannedBytes: 100,
        truncated: false,
        termsTruncated: false,
      }),
    }))
    renderBar()
    const input = container.querySelector<HTMLInputElement>('.chat-search-input')!
    await typeQuery(input, '不存在的词')
    await act(async () => {
      await advanceClock(1000)
    })
    expect(container.querySelector('.chat-search-status')!.textContent).toContain(
      en['chat.search.noResults'],
    )
    expect(container.querySelectorAll('.chat-search-hit')).toHaveLength(0)
  })

  it('Esc 关闭搜索条', async () => {
    const onClose = vi.fn()
    renderBar({ onClose })
    const input = container.querySelector<HTMLInputElement>('.chat-search-input')!
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(onClose).toHaveBeenCalled()
  })
})
