import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useChatStore,
  readQueuedFromStorageForSession,
  messagesToSyncPayload,
  turnToSyncPayload,
  storedRawRowToSyncPayload,
  buildReplayMessages,
  MAX_PENDING_PERMISSIONS,
  type ChatMessage,
  type ConfigOption,
  type ContentBlock,
  type SessionUpdateAction,
} from './chatStore'
import { clearTurnClock, turnElapsedMs } from '../utils/turnClock'

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

  describe('commitReplay (双缓冲原子提交)', () => {
    it('replaces existing messages with staged replay result atomically', () => {
      useChatStore.getState().addUserMessage('s1', 'old message')
      useChatStore.getState().commitReplay('s1', [
        { kind: 'addUserMessage', text: 'replayed user' },
        { kind: 'appendText', text: 'replayed answer' },
      ])
      const msgs = useChatStore.getState().states['s1'].messages
      expect(msgs).toHaveLength(2)
      expect(msgs[0].text).toBe('replayed user')
      expect(msgs[1].text).toBe('replayed answer')
      // 重放消息视为已完成，不残留 streaming 光标态
      expect(msgs[1].streaming).toBe(false)
    })

    it('keeps existing messages when staged frames produce no messages', () => {
      useChatStore.getState().addUserMessage('s1', 'precious history')
      useChatStore.getState().commitReplay('s1', [
        { kind: 'setMode', mode: 'code' },
      ])
      const msgs = useChatStore.getState().states['s1'].messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].text).toBe('precious history')
    })

    it('merges top-level fields (mode/todos) from staged frames', () => {
      useChatStore.getState().commitReplay('s1', [
        { kind: 'appendText', text: 'hi' },
        { kind: 'setMode', mode: 'plan' },
      ])
      expect(useChatStore.getState().states['s1'].mode).toBe('plan')
    })

    it('preserves capability flags (not replayed by the agent)', () => {
      useChatStore.getState().setImageSupported('s1', true)
      useChatStore.getState().setEmbeddedContextSupported('s1', true)
      useChatStore.getState().commitReplay('s1', [
        { kind: 'addUserMessage', text: 'replayed user' },
      ])
      const state = useChatStore.getState().states['s1']
      expect(state.imageSupported).toBe(true)
      expect(state.embeddedContextSupported).toBe(true)
    })
  })

  describe('history pagination (上拉加载更早历史)', () => {
    const mk = (id: string): ChatMessage => ({
      id,
      role: 'assistant',
      text: id,
      blocks: [{ type: 'text', text: id }],
      createdAt: 0,
    })

    it('hydrate records the cursor for the first page', () => {
      useChatStore.getState().hydrate('s1', [mk('m9')], 'ts|m9')
      expect(useChatStore.getState().states['s1'].historyCursor).toBe('ts|m9')
    })

    it('prepends older messages before existing ones and advances the cursor', () => {
      useChatStore.getState().hydrate('s1', [mk('m3')], 'ts|m3')
      useChatStore.getState().beginLoadHistory('s1')
      expect(useChatStore.getState().states['s1'].loadingHistory).toBe(true)

      useChatStore.getState().prependMessages('s1', [mk('m1'), mk('m2')], 'ts|m1')
      const st = useChatStore.getState().states['s1']
      expect(st.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      expect(st.historyCursor).toBe('ts|m1')
      expect(st.loadingHistory).toBe(false)
    })

    it('drops ids already present (live frames / overlapping page)', () => {
      useChatStore.getState().hydrate('s1', [mk('m2'), mk('m3')], 'ts|m2')
      useChatStore.getState().prependMessages('s1', [mk('m1'), mk('m2')], null)
      expect(useChatStore.getState().states['s1'].messages.map((m) => m.id)).toEqual([
        'm1',
        'm2',
        'm3',
      ])
    })

    it('null cursor marks the start of history (stops further loading)', () => {
      useChatStore.getState().hydrate('s1', [mk('m2')], 'ts|m2')
      useChatStore.getState().prependMessages('s1', [mk('m1')], null)
      expect(useChatStore.getState().states['s1'].historyCursor).toBeNull()
    })

    it('empty page still clears the in-flight flag so 上拉 does not deadlock', () => {
      useChatStore.getState().hydrate('s1', [mk('m2')], 'ts|m2')
      useChatStore.getState().beginLoadHistory('s1')
      useChatStore.getState().prependMessages('s1', [], 'ts|m2')
      const st = useChatStore.getState().states['s1']
      expect(st.loadingHistory).toBe(false)
      expect(st.historyCursor).toBe('ts|m2')
      expect(st.messages.map((m) => m.id)).toEqual(['m2'])
    })

    it('commitReplay clears the cursor (replay is the full history)', () => {
      useChatStore.getState().hydrate('s1', [mk('m2')], 'ts|m2')
      useChatStore.getState().commitReplay('s1', [{ kind: 'appendText', text: 'replayed' }])
      expect(useChatStore.getState().states['s1'].historyCursor).toBeNull()
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

  describe('file attachments', () => {
    it('addUserMessage stores file blocks after image blocks', () => {
      useChatStore.getState().addUserMessage(
        's1',
        'see these',
        [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
        [{ type: 'file', name: 'a.pdf', mimeType: 'application/pdf', size: 12 }],
      )
      const msg = useChatStore.getState().states['s1'].messages[0]
      expect(msg.blocks).toEqual([
        { type: 'text', text: 'see these' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'file', name: 'a.pdf', mimeType: 'application/pdf', size: 12 },
      ])
    })

    it('addUserMessage with only files keeps no empty text block', () => {
      useChatStore.getState().addUserMessage('s1', '', undefined, [
        { type: 'file', name: 'a.bin', mimeType: 'application/octet-stream', size: 0 },
      ])
      const msg = useChatStore.getState().states['s1'].messages[0]
      expect(msg.blocks).toEqual([
        { type: 'file', name: 'a.bin', mimeType: 'application/octet-stream', size: 0 },
      ])
    })

    it('setEmbeddedContextSupported flips the capability flag', () => {
      useChatStore.getState().addUserMessage('s1', 'x')
      expect(useChatStore.getState().states['s1'].embeddedContextSupported).toBeUndefined()
      useChatStore.getState().setEmbeddedContextSupported('s1', true)
      expect(useChatStore.getState().states['s1'].embeddedContextSupported).toBe(true)
      useChatStore.getState().setEmbeddedContextSupported('s1', false)
      expect(useChatStore.getState().states['s1'].embeddedContextSupported).toBe(false)
    })
  })

  describe('pending permission queue lifecycle', () => {
    const perm = (id: string) => ({
      id,
      options: [{ option_id: 'allow', name: 'Allow', kind: 'allow_once' }],
    })

    it('markDone preserves the queue (turn end ≠ approval invalidated)', () => {
      // 回归：会话 A 的 turn 挂在未决审批上时，另一 turn 结束（或重连时缓冲的
      // turn_state{active:false} 落定）触发 markDone，不得清掉仍在等待的审批
      // banner——后端 PermissionManager 才是未决审批的权威，合法清除路径只有
      // permission_resolved 广播 / permissions_synced 对账与 markError。
      useChatStore.getState().setPermission('s1', perm('perm-1'))
      useChatStore.getState().beginPrompt('s1')
      useChatStore.getState().markDone('s1')
      const st = useChatStore.getState().states['s1']
      expect(st.sending).toBe(false)
      expect(st.pendingPermissions.map((p) => p.id)).toEqual(['perm-1'])
    })

    it('markError clears the queue (turn error invalidates the requests)', () => {
      useChatStore.getState().setPermission('s1', perm('perm-1'))
      useChatStore.getState().markError('s1', 'boom')
      expect(useChatStore.getState().states['s1'].pendingPermissions).toEqual([])
    })

    it('concurrent approvals queue in arrival order (no overwrite)', () => {
      // 回归：后端支持并发多个 request_permission，单槽会互相覆盖导致被覆盖项
      // 无 UI 入口、会话卡死——必须按到达序排队。
      const s = useChatStore.getState()
      s.setPermission('s1', perm('a'))
      s.setPermission('s1', perm('b'))
      s.setPermission('s1', perm('c'))
      expect(useChatStore.getState().states['s1'].pendingPermissions.map((p) => p.id))
        .toEqual(['a', 'b', 'c'])
    })

    it('setPermission with existing id replaces in place (replay does not duplicate)', () => {
      const s = useChatStore.getState()
      s.setPermission('s1', perm('a'))
      s.setPermission('s1', perm('b'))
      s.setPermission('s1', { ...perm('a'), toolName: 'updated' })
      const q = useChatStore.getState().states['s1'].pendingPermissions
      expect(q.map((p) => p.id)).toEqual(['a', 'b'])
      expect(q[0].toolName).toBe('updated')
    })

    it('removePermission dequeues by id, others advance', () => {
      const s = useChatStore.getState()
      s.setPermission('s1', perm('a'))
      s.setPermission('s1', perm('b'))
      s.removePermission('s1', 'a')
      const q = useChatStore.getState().states['s1'].pendingPermissions
      expect(q.map((p) => p.id)).toEqual(['b'])
      // 未知 id 是 no-op
      s.removePermission('s1', 'nope')
      expect(useChatStore.getState().states['s1'].pendingPermissions.map((p) => p.id)).toEqual(['b'])
    })

    it('reconcilePermissions keeps only ids in the authoritative set', () => {
      // permissions_synced 对账：断连窗口错过 permission_resolved 广播的陈旧项被清除
      const s = useChatStore.getState()
      s.setPermission('s1', perm('stale'))
      s.setPermission('s1', perm('alive'))
      s.reconcilePermissions('s1', new Set(['alive']))
      expect(useChatStore.getState().states['s1'].pendingPermissions.map((p) => p.id)).toEqual(['alive'])
      // 空集合 = 后端无未决审批，全部清除
      s.reconcilePermissions('s1', new Set())
      expect(useChatStore.getState().states['s1'].pendingPermissions).toEqual([])
    })

    it('queue is capped: overflow drops the newcomer with a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const s = useChatStore.getState()
      for (let i = 0; i < MAX_PENDING_PERMISSIONS + 3; i++) {
        s.setPermission('s1', perm(`p${i}`))
      }
      const q = useChatStore.getState().states['s1'].pendingPermissions
      expect(q).toHaveLength(MAX_PENDING_PERMISSIONS)
      expect(q[0].id).toBe('p0')
      expect(q[MAX_PENDING_PERMISSIONS - 1].id).toBe(`p${MAX_PENDING_PERMISSIONS - 1}`)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})

describe('messagesToSyncPayload', () => {
  function mkMsg(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
    return {
      id: overrides.id ?? `m-${Math.random()}`,
      dbId: overrides.dbId,
      text: overrides.text ?? '',
      blocks: overrides.blocks ?? [{ type: 'text', text: overrides.text ?? '' }],
      createdAt: overrides.createdAt ?? 0,
      streaming: overrides.streaming,
      undelivered: overrides.undelivered,
      role: overrides.role,
    }
  }

  it('forwards dbId as the payload id so the backend updates that exact row', () => {
    const msg = mkMsg({ role: 'assistant', text: 'hi', id: 'local-1', dbId: 'row-1' })
    expect(messagesToSyncPayload([msg])[0].id).toBe('row-1')
  })

  it('omits id for locally minted messages (a local id matches no DB row)', () => {
    const msg = mkMsg({ role: 'assistant', text: 'hi', id: 'local-1' })
    const entry = messagesToSyncPayload([msg])[0]
    expect(entry).not.toHaveProperty('id')
  })

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

  it('drops system messages (backend writes them; frontend never syncs them back)', () => {
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

describe('turnToSyncPayload', () => {
  function mk(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
    return {
      id: overrides.id ?? `m-${Math.random()}`,
      dbId: overrides.dbId,
      text: overrides.text ?? '',
      blocks: overrides.blocks ?? [{ type: 'text', text: overrides.text ?? '' }],
      createdAt: overrides.createdAt ?? 0,
      streaming: overrides.streaming,
      role: overrides.role,
    }
  }

  it('targets the backend row id and carries the cooked blocks', () => {
    const msgs = [
      mk({ role: 'user', text: 'q' }),
      mk({ role: 'assistant', text: 'a', streaming: true }),
    ]
    expect(turnToSyncPayload(msgs, 'row-1')).toEqual([
      {
        id: 'row-1',
        role: 'assistant',
        text: 'a',
        blocks: JSON.stringify([{ type: 'text', text: 'a' }]),
      },
    ])
  })

  it('ignores finished messages from earlier turns', () => {
    const msgs = [
      mk({ role: 'assistant', text: 'old turn' }),
      mk({ role: 'user', text: 'q' }),
      mk({ role: 'assistant', text: 'this turn', streaming: true }),
    ]
    const payload = turnToSyncPayload(msgs, 'row-1')
    expect(payload[0].text).toBe('this turn')
    expect(payload[0].blocks).toBe(JSON.stringify([{ type: 'text', text: 'this turn' }]))
  })

  it('collapses a multi-message turn into one row (DB keeps one row per turn)', () => {
    const msgs = [
      mk({ role: 'assistant', text: 'part1', streaming: true }),
      mk({ role: 'assistant', text: 'part2', streaming: true }),
    ]
    const payload = turnToSyncPayload(msgs, 'row-1')
    expect(payload).toHaveLength(1)
    expect(payload[0].text).toBe('part1part2')
    expect(payload[0].blocks).toBe(
      JSON.stringify([
        { type: 'text', text: 'part1' },
        { type: 'text', text: 'part2' },
      ]),
    )
  })

  it('keeps tool-only turns (empty text, fat blocks) \u2014 those are the big rows', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_call', toolCallId: 't1', title: 'read', status: 'completed' },
    ]
    const payload = turnToSyncPayload([mk({ role: 'assistant', blocks, streaming: true })], 'row-1')
    expect(payload).toHaveLength(1)
    expect(payload[0].text).toBe('')
    expect(payload[0].blocks).toBe(JSON.stringify(blocks))
  })

  it('returns nothing when the turn has no blocks (do not blank out the backend row)', () => {
    expect(turnToSyncPayload([mk({ role: 'assistant', blocks: [], streaming: true })], 'row-1')).toEqual([])
    expect(turnToSyncPayload([mk({ role: 'assistant', text: 'done' })], 'row-1')).toEqual([])
    expect(turnToSyncPayload([], 'row-1')).toEqual([])
  })
})

describe('storedRawRowToSyncPayload (方案 B：hydrate 后收敛 RAW 残留行)', () => {
  function mk(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
    return {
      id: overrides.id ?? `m-${Math.random()}`,
      dbId: overrides.dbId,
      text: overrides.text ?? '',
      blocks: overrides.blocks ?? [{ type: 'text', text: overrides.text ?? '' }],
      createdAt: overrides.createdAt ?? 0,
      streaming: overrides.streaming,
      rawStored: overrides.rawStored,
      role: overrides.role,
    }
  }

  it('targets the real dbId and carries the cooked blocks (UPDATE, never INSERT)', () => {
    const m = mk({
      role: 'assistant',
      text: 'partial',
      dbId: 'row-1',
      rawStored: true,
      blocks: [
        { type: 'text', text: 'partial' },
        { type: 'tool_call', toolCallId: 'tc-1', title: 'read', status: 'completed' },
      ],
    })
    expect(storedRawRowToSyncPayload(m)).toEqual({
      id: 'row-1',
      role: 'assistant',
      text: 'partial',
      blocks: JSON.stringify(m.blocks),
    })
  })

  it('returns null for rows not marked rawStored (already cooked)', () => {
    const m = mk({ role: 'assistant', text: 'cooked', dbId: 'row-1' })
    expect(storedRawRowToSyncPayload(m)).toBeNull()
  })

  it('returns null without a dbId (locally minted id matches no DB row)', () => {
    const m = mk({ role: 'assistant', text: 'x', rawStored: true })
    expect(storedRawRowToSyncPayload(m)).toBeNull()
  })

  it('skips streaming rows — the in-progress turn is still owned by the accumulator', () => {
    const m = mk({ role: 'assistant', text: 'in flight', dbId: 'row-2', rawStored: true, streaming: true })
    expect(storedRawRowToSyncPayload(m)).toBeNull()
  })

  it('skips empty cooked blocks — a blank write would destroy the raw frames', () => {
    const m = mk({ role: 'assistant', text: 'unparsed', dbId: 'row-3', rawStored: true, blocks: [] })
    expect(storedRawRowToSyncPayload(m)).toBeNull()
  })
})

describe('pushSystemEvent (后端系统通知：权限超时回收告知)', () => {
  beforeEach(() => {
    useChatStore.setState({ states: {} })
  })

  it('appends a system message with the given label', () => {
    useChatStore.getState().hydrate('s1', [], null)
    useChatStore.getState().pushSystemEvent('s1', '权限请求超时')
    const msgs = useChatStore.getState().states['s1'].messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].blocks).toEqual([{ type: 'system', label: '权限请求超时' }])
    expect(msgs[0].text).toBe('[权限请求超时]')
  })

  it('is excluded from sync payloads (backend rows are authoritative for system rows)', () => {
    useChatStore.getState().hydrate('s1', [], null)
    useChatStore.getState().pushSystemEvent('s1', '权限请求超时')
    const msgs = useChatStore.getState().states['s1'].messages
    expect(messagesToSyncPayload(msgs)).toEqual([])
  })
})

// 流式实时计时的生命周期守卫：计时器必须和 sending / 审批队列严格同生死，
// 停表路径漏一条就会在气泡上留下一个永不落定的数字（或让条目卡在表里泄漏）。
describe('turnClock 接线（计时器与 sending / 审批队列同生命周期）', () => {
  const T0 = 1_700_000_000_000
  const perm = (id: string) => ({ id, options: [] })

  beforeEach(() => {
    useChatStore.setState({ states: {} })
    clearTurnClock()
    vi.useFakeTimers({ now: T0 })
  })

  afterEach(() => {
    vi.useRealTimers()
    clearTurnClock()
  })

  it('beginPrompt 起表，markDone 停表', () => {
    useChatStore.getState().beginPrompt('s1')
    vi.advanceTimersByTime(5_000)
    expect(turnElapsedMs('s1')).toBe(5_000)
    useChatStore.getState().markDone('s1', { workMs: 5_000, waitMs: 0 })
    expect(turnElapsedMs('s1')).toBeNull()
  })

  it('markError / markEnded 同样停表', () => {
    useChatStore.getState().beginPrompt('s1')
    useChatStore.getState().markError('s1', 'boom')
    expect(turnElapsedMs('s1')).toBeNull()

    useChatStore.getState().beginPrompt('s2')
    useChatStore.getState().markEnded('s2')
    expect(turnElapsedMs('s2')).toBeNull()
  })

  it('reset 停表（守住表内条目泄漏）', () => {
    useChatStore.getState().beginPrompt('s1')
    useChatStore.getState().reset('s1')
    expect(turnElapsedMs('s1')).toBeNull()
  })

  it('审批挂起期间冻住，队列见底后从冻结值续跳', () => {
    useChatStore.getState().beginPrompt('s1')
    vi.advanceTimersByTime(10_000)
    useChatStore.getState().setPermission('s1', perm('p1'))
    vi.advanceTimersByTime(30_000)
    expect(turnElapsedMs('s1')).toBe(10_000)
    useChatStore.getState().removePermission('s1', 'p1')
    vi.advanceTimersByTime(5_000)
    expect(turnElapsedMs('s1')).toBe(15_000)
  })

  it('并发审批只 resolve 一个时仍冻住（镜像后端 wait_depth）', () => {
    useChatStore.getState().beginPrompt('s1')
    vi.advanceTimersByTime(3_000)
    useChatStore.getState().setPermission('s1', perm('p1'))
    useChatStore.getState().setPermission('s1', perm('p2'))
    useChatStore.getState().removePermission('s1', 'p1')
    vi.advanceTimersByTime(20_000)
    expect(turnElapsedMs('s1')).toBe(3_000)
    useChatStore.getState().removePermission('s1', 'p2')
    vi.advanceTimersByTime(2_000)
    expect(turnElapsedMs('s1')).toBe(5_000)
  })

  it('对账后仍有未决审批时保持冻住', () => {
    useChatStore.getState().beginPrompt('s1')
    vi.advanceTimersByTime(4_000)
    useChatStore.getState().setPermission('s1', perm('p1'))
    useChatStore.getState().setPermission('s1', perm('p2'))
    useChatStore.getState().reconcilePermissions('s1', new Set(['p1']))
    vi.advanceTimersByTime(20_000)
    expect(turnElapsedMs('s1')).toBe(4_000)
  })

  it('重连接回半程 turn：锚点取在建行的 createdAt，不从 0 起跳', () => {
    const streaming: ChatMessage = {
      id: 'a',
      role: 'assistant',
      text: '',
      blocks: [],
      createdAt: T0 - 40_000,
      streaming: true,
    }
    useChatStore.getState().hydrate('s1', [streaming], null)
    useChatStore.getState().beginPrompt('s1')
    expect(turnElapsedMs('s1')).toBe(40_000)
  })

  it('无在建 turn 时审批帧 no-op', () => {
    useChatStore.getState().setPermission('s1', perm('p1'))
    expect(turnElapsedMs('s1')).toBeNull()
  })
})

// 流式 prose 合并策略：修复「同一次 agent 思考被切成多个 ◆ thinking 折叠块」。
//
// 实测 codebuddy（ACP 实现之一）把同一 turn 的 reasoning（agent_thought_chunk）与
// message（agent_message_chunk）两条逻辑流按 token 粒度交错下发，且两条流共用同一
// messageId。旧策略「只与紧邻块合并」会把一段连续思考切成成百上千个 thinking 块
// （tps 越高交错越密，故用户观察「高输出速度时更明显」）。
//
// 新策略：同一 prose 区域（连续 text/thought 块）内按类型累积；tool_call/plan 等
// 结构化块终止区域，工具前后的推理各自成块（保留「想→做→想」的转录顺序）。
describe('流式 prose 块合并（thought 分段修复）', () => {
  const T = (text: string): SessionUpdateAction => ({ kind: 'appendThought', text })
  const M = (text: string): SessionUpdateAction => ({ kind: 'appendText', text })
  const TOOL = (id: string): SessionUpdateAction => ({ kind: 'upsertTool', toolCallId: id })

  const asTypes = (blocks: ContentBlock[]) => blocks.map((b) => b.type)
  const textAt = (blocks: ContentBlock[], i: number) => (blocks[i] as { text: string }).text

  const replayBlocks = (actions: SessionUpdateAction[]): ContentBlock[] =>
    buildReplayMessages(actions).flatMap((m) => m.blocks)

  const liveState = (actions: SessionUpdateAction[]) => {
    useChatStore.setState({ states: {} })
    useChatStore.getState().applyReplayBatch('s1', actions)
    return useChatStore.getState().states['s1']
  }

  beforeEach(() => {
    useChatStore.setState({ states: {} })
  })

  it('thought,thought → 单块累积', () => {
    const blocks = replayBlocks([T('思考'), T('续写')])
    expect(asTypes(blocks)).toEqual(['thought'])
    expect(textAt(blocks, 0)).toBe('思考续写')
  })

  it('thought,空 text,thought → 空块不落地，仍是单块（假设 A/D）', () => {
    const blocks = replayBlocks([T('思考'), M(''), T('续写')])
    expect(asTypes(blocks)).toEqual(['thought'])
    expect(textAt(blocks, 0)).toBe('思考续写')
  })

  it('thought,纯空白 text,thought → 空白块被丢弃，不切断思考', () => {
    const blocks = replayBlocks([T('思考'), M(' '), M('\n'), T('续写')])
    expect(asTypes(blocks)).toEqual(['thought'])
    expect(textAt(blocks, 0)).toBe('思考续写')
  })

  it('thought,text,thought（无工具分隔）→ 合并为 1 思考 + 1 正文，而非 2 个思考块', () => {
    const blocks = replayBlocks([T('思考一'), M('中间正文'), T('思考二')])
    expect(asTypes(blocks)).toEqual(['thought', 'text'])
    expect(textAt(blocks, 0)).toBe('思考一思考二')
    expect(textAt(blocks, 1)).toBe('中间正文')
  })

  it('回归：token 粒度交错的 reasoning/正文流只产出一个 thinking 块', () => {
    // 复刻实测帧序列：thought 与 message 片段逐词交替（同一 prose 区域，无工具）
    const actions: SessionUpdateAction[] = [
      T('I now have '), M('现在读取'), T('all the info'), M('关键区域的'),
      T(' needed. Let me'), M('实现细节：'), T(' also check the'), M(' Sidebar 的'),
      T(' precedent'), M(' releaseSessionNow'),
    ]
    const blocks = replayBlocks(actions)
    expect(asTypes(blocks)).toEqual(['thought', 'text'])
    expect(textAt(blocks, 0)).toBe('I now have all the info needed. Let me also check the precedent')
    expect(textAt(blocks, 1)).toBe('现在读取关键区域的实现细节： Sidebar 的 releaseSessionNow')
  })

  it('thought,tool,thought → 工具分隔的两个推理段各自成块（区域不跨工具合并）', () => {
    const blocks = replayBlocks([T('想一'), TOOL('t1'), T('想二')])
    expect(asTypes(blocks)).toEqual(['thought', 'tool_call', 'thought'])
    expect(textAt(blocks, 0)).toBe('想一')
    expect(textAt(blocks, 2)).toBe('想二')
  })

  it('工具前后各成一段：顺序与块数都稳定', () => {
    const blocks = replayBlocks([
      T('a'), M('x'), TOOL('t1'),
      T('b'), M('y'), TOOL('t2'),
    ])
    expect(asTypes(blocks)).toEqual([
      'thought', 'text', 'tool_call',
      'thought', 'text', 'tool_call',
    ])
    expect(textAt(blocks, 0)).toBe('a')
    expect(textAt(blocks, 3)).toBe('b')
  })

  it('live 分帧提交与一次性 replay 结果一致（rAF 批边界不影响合并）', () => {
    const actions = [T('一'), M('x'), T('二'), M('y'), T('三')]
    const expected = replayBlocks(actions)
    useChatStore.setState({ states: {} })
    // 模拟每 rAF 一批，分批提交
    useChatStore.getState().applyReplayBatch('s1', actions.slice(0, 2))
    useChatStore.getState().applyReplayBatch('s1', actions.slice(2, 3))
    useChatStore.getState().applyReplayBatch('s1', actions.slice(3))
    const live = useChatStore.getState().states['s1'].messages.flatMap((m) => m.blocks)
    expect(live).toEqual(expected)
    expect(asTypes(live)).toEqual(['thought', 'text'])
  })

  it('appendChunk / appendThought 单块 action 走同一合并策略', () => {
    useChatStore.getState().appendThought('s1', 'a')
    useChatStore.getState().appendChunk('s1', 'x')
    useChatStore.getState().appendThought('s1', 'b')
    const msg = useChatStore.getState().states['s1'].messages[0]
    expect(msg.blocks.map((b) => b.type)).toEqual(['thought', 'text'])
    // 思考不进正文累加器，只累积思考块
    expect(msg.text).toBe('x')
    expect((msg.blocks[0] as { text: string }).text).toBe('ab')
  })

  it('空 / 纯空白 chunk 不新建消息、不产空块', () => {
    const s = useChatStore.getState()
    s.appendChunk('s1', '')
    s.appendChunk('s1', '   \n')
    s.appendThought('s1', '')
    expect(useChatStore.getState().states['s1']).toBeUndefined()
  })

  it('正文累加器 message.text 仍只累积 text chunk', () => {
    const st = liveState([T('t1'), M('a'), T('t2'), M('b')])
    const msg = st.messages[0]
    expect(msg.text).toBe('ab')
    expect(msg.blocks.map((b) => b.type)).toEqual(['thought', 'text'])
    expect((msg.blocks[0] as { text: string }).text).toBe('t1t2')
    expect((msg.blocks[1] as { text: string }).text).toBe('ab')
  })
})

// 已结束会话的配置快照：hydrate 注入最后已知 configOptions 并置灰只读；
// 任一 live/replay 配置帧（applyReplayBatch → applyTopLevelActions）解除只读。
describe('config snapshot (ended-session readonly toolbar)', () => {
  const MODEL_OPTION: ConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'm1',
    options: [
      { value: 'm1', name: 'm1' },
      { value: 'm2', name: 'm2' },
    ],
  }

  beforeEach(() => {
    useChatStore.setState({ states: {} })
  })

  it('setConfigSnapshot(true) stores options and marks readonly', () => {
    useChatStore.getState().setConfigSnapshot('s1', [MODEL_OPTION], true)
    const st = useChatStore.getState().states['s1']
    expect(st.configOptions).toEqual([MODEL_OPTION])
    expect(st.configReadOnly).toBe(true)
  })

  it('setConfigSnapshot(false) injects values without readonly (live-session refresh)', () => {
    useChatStore.getState().setConfigSnapshot('s1', [MODEL_OPTION], false)
    const st = useChatStore.getState().states['s1']
    expect(st.configOptions).toEqual([MODEL_OPTION])
    expect(st.configReadOnly).toBe(false)
  })

  it('live config frame via applyReplayBatch overwrites snapshot and clears readonly', () => {
    useChatStore.getState().setConfigSnapshot('s1', [MODEL_OPTION], true)
    const updated: ConfigOption = { ...MODEL_OPTION, currentValue: 'm2' }
    useChatStore
      .getState()
      .applyReplayBatch('s1', [{ kind: 'setConfigOptions', options: [updated] }])
    const st = useChatStore.getState().states['s1']
    expect(st.configOptions).toEqual([updated])
    expect(st.configReadOnly).toBe(false)
  })
})
