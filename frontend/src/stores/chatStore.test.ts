import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useChatStore,
  readQueuedFromStorageForSession,
  messagesToSyncPayload,
  type ChatMessage,
  type ContentBlock,
} from './chatStore'

const QUEUE_PREFIX = 'omniterm_chat_queue:'

describe('chatStore — queued follow-up actions', () => {
  beforeEach(() => {
    // 清掉所有 session 的 store 状态 + sessionStorage
    useChatStore.setState({ states: {} })
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  describe('enqueueMessage', () => {
    it('stores trimmed text in queuedMessage slot', () => {
      useChatStore.getState().enqueueMessage('s1', '  hello world  ')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('hello world')
    })

    it('mirrors to sessionStorage under omniterm_chat_queue:{sid}', () => {
      useChatStore.getState().enqueueMessage('s1', 'queued text')
      expect(sessionStorage.getItem(`${QUEUE_PREFIX}s1`)).toBe('queued text')
    })

    it('is a no-op for empty / whitespace-only text', () => {
      useChatStore.getState().enqueueMessage('s1', '')
      useChatStore.getState().enqueueMessage('s1', '   \n\t  ')
      expect(useChatStore.getState().states['s1']).toBeUndefined()
      expect(sessionStorage.getItem(`${QUEUE_PREFIX}s1`)).toBeNull()
    })

    it('replaces existing queued message (N=1 single slot)', () => {
      useChatStore.getState().enqueueMessage('s1', 'first')
      useChatStore.getState().enqueueMessage('s1', 'second')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('second')
      expect(sessionStorage.getItem(`${QUEUE_PREFIX}s1`)).toBe('second')
    })

    it('isolates state per sessionId', () => {
      useChatStore.getState().enqueueMessage('s1', 'one')
      useChatStore.getState().enqueueMessage('s2', 'two')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('one')
      expect(useChatStore.getState().states['s2'].queuedMessage).toBe('two')
    })

    it('swallows sessionStorage write errors (quota / private mode)', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
      // 不应该抛错
      expect(() => useChatStore.getState().enqueueMessage('s1', 'queued')).not.toThrow()
      // 内存中仍应有值（store 写入与 storage 副作用解耦）
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('queued')
      setItemSpy.mockRestore()
    })
  })

  describe('clearQueuedMessage', () => {
    it('clears the slot and removes sessionStorage entry', () => {
      useChatStore.getState().enqueueMessage('s1', 'queued')
      useChatStore.getState().clearQueuedMessage('s1')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBeNull()
      expect(sessionStorage.getItem(`${QUEUE_PREFIX}s1`)).toBeNull()
    })

    it('is a no-op when slot is already null', () => {
      // 先确保没有这个 session
      useChatStore.getState().clearQueuedMessage('s1')
      expect(useChatStore.getState().states['s1']).toBeUndefined()
    })

    it('does not touch other sessions queues', () => {
      useChatStore.getState().enqueueMessage('s1', 'keep')
      useChatStore.getState().enqueueMessage('s2', 'drop')
      useChatStore.getState().clearQueuedMessage('s2')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('keep')
      expect(useChatStore.getState().states['s2'].queuedMessage).toBeNull()
    })
  })

  describe('hydrateQueuedMessage', () => {
    it('populates empty slot from sessionStorage cache', () => {
      sessionStorage.setItem(`${QUEUE_PREFIX}s1`, 'cached')
      useChatStore.getState().hydrateQueuedMessage('s1', 'cached')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('cached')
    })

    it('does NOT overwrite a freshly-enqueued message (active wins over stale cache)', () => {
      // 模拟 F5 后场景：用户先 enqueue 了一条，hydrate 又读到同 session 的旧 cache
      useChatStore.getState().enqueueMessage('s1', 'fresh')
      useChatStore.getState().hydrateQueuedMessage('s1', 'stale-from-cache')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('fresh')
    })

    it('trims whitespace', () => {
      useChatStore.getState().hydrateQueuedMessage('s1', '  cached  ')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('cached')
    })

    it('is a no-op for empty / whitespace-only cache', () => {
      useChatStore.getState().hydrateQueuedMessage('s1', '   \n  ')
      expect(useChatStore.getState().states['s1']).toBeUndefined()
    })
  })

  describe('addUndeliveredMessage', () => {
    it('appends a user message with undelivered: true', () => {
      useChatStore.getState().addUndeliveredMessage('s1', 'lost text')
      const msg = useChatStore.getState().states['s1'].messages[0]
      expect(msg.role).toBe('user')
      expect(msg.text).toBe('lost text')
      expect(msg.undelivered).toBe(true)
    })

    it('does not affect queuedMessage slot', () => {
      useChatStore.getState().enqueueMessage('s1', 'in queue')
      useChatStore.getState().addUndeliveredMessage('s1', 'lost')
      expect(useChatStore.getState().states['s1'].queuedMessage).toBe('in queue')
      expect(useChatStore.getState().states['s1'].messages).toHaveLength(1)
    })
  })

  describe('reset', () => {
    it('removes session state AND its sessionStorage entry', () => {
      useChatStore.getState().enqueueMessage('s1', 'queued')
      useChatStore.getState().reset('s1')
      expect(useChatStore.getState().states['s1']).toBeUndefined()
      expect(sessionStorage.getItem(`${QUEUE_PREFIX}s1`)).toBeNull()
    })

    it('is a no-op for unknown sessionId', () => {
      expect(() => useChatStore.getState().reset('unknown')).not.toThrow()
    })
  })

  describe('sessionStorage helper', () => {
    it('readQueuedFromStorageForSession returns the cached value', () => {
      sessionStorage.setItem(`${QUEUE_PREFIX}s1`, 'cached')
      expect(readQueuedFromStorageForSession('s1')).toBe('cached')
    })

    it('readQueuedFromStorageForSession returns null when absent', () => {
      expect(readQueuedFromStorageForSession('missing')).toBeNull()
    })
  })

  describe('markEdited (F02)', () => {
    it('marks the targeted user message as edited', () => {
      useChatStore.getState().addUserMessage('s1', 'original')
      const msg = useChatStore.getState().states['s1'].messages[0]
      useChatStore.getState().markEdited('s1', msg.id)
      expect(useChatStore.getState().states['s1'].messages[0].edited).toBe(true)
    })

    it('does not touch assistant messages or unknown ids', () => {
      useChatStore.getState().addUserMessage('s1', 'u1')
      useChatStore.getState().appendChunk('s1', 'assistant reply')
      useChatStore.getState().markEdited('s1', 'nonexistent-id')
      const msgs = useChatStore.getState().states['s1'].messages
      expect(msgs.every((m) => !m.edited)).toBe(true)
    })
  })

  describe('image attachments (F03)', () => {
    it('addUserMessage stores image blocks after the text block', () => {
      useChatStore.getState().addUserMessage('s1', 'look at this', [
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'image', mimeType: 'image/jpeg', data: 'BBBB' },
      ])
      const msg = useChatStore.getState().states['s1'].messages[0]
      expect(msg.blocks).toEqual([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'image', mimeType: 'image/jpeg', data: 'BBBB' },
      ])
    })

    it('addUserMessage without images keeps a single text block', () => {
      useChatStore.getState().addUserMessage('s1', 'plain')
      const msg = useChatStore.getState().states['s1'].messages[0]
      expect(msg.blocks).toEqual([{ type: 'text', text: 'plain' }])
    })

    it('setImageSupported flips the capability flag', () => {
      useChatStore.getState().addUserMessage('s1', 'x')
      expect(useChatStore.getState().states['s1'].imageSupported).toBeUndefined()
      useChatStore.getState().setImageSupported('s1', true)
      expect(useChatStore.getState().states['s1'].imageSupported).toBe(true)
      useChatStore.getState().setImageSupported('s1', false)
      expect(useChatStore.getState().states['s1'].imageSupported).toBe(false)
    })
  })
})

describe('messagesToSyncPayload', () => {
  function mkMsg(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
    return {
      id: overrides.id ?? `m-${Math.random()}`,
      text: overrides.text ?? '',
      blocks: overrides.blocks ?? [{ type: 'text', text: overrides.text ?? '' }],
      createdAt: overrides.createdAt ?? 0,
      streaming: overrides.streaming,
      undelivered: overrides.undelivered,
      role: overrides.role,
    }
  }

  it('returns empty array for empty input', () => {
    expect(messagesToSyncPayload([])).toEqual([])
  })

  it('keeps user and assistant messages in order', () => {
    const msgs = [
      mkMsg({ role: 'user', text: 'hi' }),
      mkMsg({ role: 'assistant', text: 'hello' }),
    ]
    const payload = messagesToSyncPayload(msgs)
    expect(payload).toEqual([
      { role: 'user', text: 'hi', blocks: JSON.stringify([{ type: 'text', text: 'hi' }]) },
      { role: 'assistant', text: 'hello', blocks: JSON.stringify([{ type: 'text', text: 'hello' }]) },
    ])
  })

  it('drops system messages (UI-only events, not in DB)', () => {
    const msgs = [
      mkMsg({ role: 'user', text: 'hi' }),
      mkMsg({ role: 'system', text: '[ToolCall]' }),
      mkMsg({ role: 'assistant', text: 'hello' }),
    ]
    const payload = messagesToSyncPayload(msgs)
    expect(payload).toHaveLength(2)
    expect(payload.map((p) => p.role)).toEqual(['user', 'assistant'])
  })

  it('drops undelivered messages (lives only in memory, not DB)', () => {
    const msgs = [
      mkMsg({ role: 'user', text: 'normal' }),
      mkMsg({ role: 'user', text: 'lost on disconnect', undelivered: true }),
      mkMsg({ role: 'assistant', text: 'reply' }),
    ]
    const payload = messagesToSyncPayload(msgs)
    expect(payload).toHaveLength(2)
    expect(payload.map((p) => p.text)).toEqual(['normal', 'reply'])
  })

  it('drops undelivered even when it is the only message', () => {
    const msgs = [mkMsg({ role: 'user', text: 'lost', undelivered: true })]
    expect(messagesToSyncPayload(msgs)).toEqual([])
  })

  it('omits blocks key when blocks array is empty', () => {
    const msg = mkMsg({ role: 'user', text: 'hi', blocks: [] })
    const payload = messagesToSyncPayload([msg])
    expect(payload[0]).toEqual({ role: 'user', text: 'hi' })
    expect(payload[0]).not.toHaveProperty('blocks')
  })

  it('stringifies blocks when non-empty', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'thought', text: 'b' },
    ]
    const msg = mkMsg({ role: 'assistant', text: 'a', blocks })
    const payload = messagesToSyncPayload([msg])
    expect(payload[0].blocks).toBe(JSON.stringify(blocks))
  })

  it('handles mixed real / undelivered / system messages', () => {
    const msgs = [
      mkMsg({ role: 'user', text: '1' }),
      mkMsg({ role: 'assistant', text: '2' }),
      mkMsg({ role: 'user', text: '3-lost', undelivered: true }),
      mkMsg({ role: 'system', text: '[Event]' }),
      mkMsg({ role: 'assistant', text: '4' }),
    ]
    const payload = messagesToSyncPayload(msgs)
    expect(payload.map((p) => p.text)).toEqual(['1', '2', '4'])
  })
})
