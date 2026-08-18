import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useChatStore,
  readQueuedFromStorageForSession,
  messagesToSyncPayload,
  turnToSyncPayload,
  MAX_PENDING_PERMISSIONS,
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
