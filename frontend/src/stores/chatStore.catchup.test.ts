import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, type ChatMessage, type ContentBlock } from './chatStore'

// 聚焦补拉（docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md D3）：
// mergeLatestMessages 的五条合并规则 + markDone 的 rowId→dbId 落值。每条规则
// 防一类真实故障，删任一条都会静默回归：
//   - 同 dbId 不精确替换 → 靠文本猜身份（2026-08-10 Phase 0 污染 bug 同族）
//   - streaming 行不跳过 → 进行中 turn 的 live cooked 结构被原始帧覆盖
//   - user echo 不去重 → optimistic 气泡与 DB 行双显示
//   - assistant 前缀不对账 → 断连期间跑完的半截 turn 永不补全
//   - markDone 不落 dbId → 健康结束的 turn 也退化成文本猜测
// 纯函数级单测；ChatView/hook 侧接线由 `ChatView.catchup.test.tsx` 与
// `useAcpChat.catchup.test.tsx` 覆盖。

function mk(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
  return {
    id: overrides.id ?? `local-${Math.random()}`,
    dbId: overrides.dbId,
    role: overrides.role,
    text: overrides.text ?? '',
    blocks: overrides.blocks ?? [],
    createdAt: overrides.createdAt ?? 0,
    streaming: overrides.streaming,
    rawStored: overrides.rawStored,
    undelivered: overrides.undelivered,
    durationMs: overrides.durationMs,
    waitMs: overrides.waitMs,
  }
}

/** `GET /messages` 一页（经 toChatMessages 转换后）的等价构造：dbId = id。 */
const row = (id: string, role: ChatMessage['role'], text: string, extra?: Partial<ChatMessage>) =>
  mk({ id, dbId: id, role, text, ...extra })

const seed = (messages: ChatMessage[]) => {
  useChatStore.setState({ states: {} })
  useChatStore.getState().hydrate('s1', messages, null)
}

const state = () => useChatStore.getState().states['s1']

describe('mergeLatestMessages — 聚焦补拉的 DB 最新页合并', () => {
  beforeEach(() => {
    useChatStore.setState({ states: {} })
  })

  it('同 dbId 原位替换（DB 权威，连结算时长一起更新）', () => {
    seed([
      mk({ id: 'u1', dbId: 'u1', role: 'user', text: 'q', createdAt: 10 }),
      mk({ id: 'a1', dbId: 'a1', role: 'assistant', text: 'ans', createdAt: 20 }),
    ])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('u1', 'user', 'q', { createdAt: 10 }),
      row('a1', 'assistant', 'ans', { createdAt: 20, durationMs: 5000, waitMs: 1200 }),
    ])
    const msgs = state().messages
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(msgs[1].durationMs).toBe(5000)
    expect(msgs[1].waitMs).toBe(1200)
  })

  it('跳过 status=streaming 的行：进行中 turn 归 live 路径所有', () => {
    seed([mk({ id: 'live-1', role: 'assistant', text: 'partial', streaming: true, createdAt: 30 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-live', 'assistant', 'partial', { createdAt: 30, streaming: true }),
      row('row-done', 'assistant', 'earlier turn', { createdAt: 20 }),
    ])
    const msgs = state().messages
    // streaming 行不追加、不改写；已完成的旧行按 createdAt 插到它前面。
    expect(msgs.map((m) => m.id)).toEqual(['row-done', 'live-1'])
    expect(msgs[1].streaming).toBe(true)
    expect(msgs[1].dbId).toBeUndefined()
  })

  it('user 行按尾部 optimistic echo 去重，不产生双气泡', () => {
    seed([mk({ id: 'u-echo', role: 'user', text: 'fix build', createdAt: 10 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-u', 'user', 'fix build', { createdAt: 10 }),
      row('row-a', 'assistant', 'done', { createdAt: 20 }),
    ])
    const msgs = state().messages
    expect(msgs.map((m) => m.id)).toEqual(['row-u', 'row-a'])
    expect(msgs[0].dbId).toBe('row-u')
  })

  it('user echo 只认 text 全等：不同文本照常插入', () => {
    seed([mk({ id: 'u-echo', role: 'user', text: 'fix build', createdAt: 10 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-u', 'user', 'fix build please', { createdAt: 10 }),
    ])
    expect(state().messages.map((m) => m.id)).toEqual(['u-echo', 'row-u'])
  })

  it('assistant 按精确前缀对账：断连期间跑完的半截 turn 被补齐', () => {
    // turn_state(false) 定稿后的半截消息：无 dbId、streaming=false。
    seed([mk({ id: 'a-partial', role: 'assistant', text: 'hello wor', createdAt: 20 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-a', 'assistant', 'hello world, done', { createdAt: 20 }),
    ])
    const msgs = state().messages
    expect(msgs.map((m) => m.id)).toEqual(['row-a'])
    expect(msgs[0].dbId).toBe('row-a')
    expect(msgs[0].text).toBe('hello world, done')
  })

  it('assistant 前缀失配宁添不缺（丢整轮正文比多一个气泡更糟）', () => {
    seed([mk({ id: 'a-partial', role: 'assistant', text: 'unrelated', createdAt: 20 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-a', 'assistant', 'hello world', { createdAt: 20 }),
    ])
    expect(state().messages.map((m) => m.id)).toEqual(['a-partial', 'row-a'])
  })

  it('空 store 尾（非 assistant）时 assistant 行直接追加', () => {
    seed([mk({ id: 'u1', dbId: 'u1', role: 'user', text: 'q', createdAt: 10 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-a', 'assistant', 'answer', { createdAt: 20 }),
    ])
    expect(state().messages.map((m) => m.id)).toEqual(['u1', 'row-a'])
  })

  it('按 createdAt 顺序插入，不打乱 live 消息位置', () => {
    seed([
      mk({ id: 'm1', dbId: 'm1', role: 'user', text: 'a', createdAt: 10 }),
      mk({ id: 'live-3', role: 'user', text: 'c', createdAt: 30 }),
    ])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('m2', 'assistant', 'b', { createdAt: 20 }),
    ])
    expect(state().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'live-3'])
  })

  it('空页是 no-op：不动 messages、不碰 needsCatchUp', () => {
    seed([mk({ id: 'm1', dbId: 'm1', role: 'user', text: 'a', createdAt: 10 })])
    useChatStore.getState().setNeedsCatchUp('s1', true)
    const before = state().messages
    useChatStore.getState().mergeLatestMessages('s1', [])
    expect(state().messages).toBe(before)
    expect(state().needsCatchUp).toBe(true)
  })

  it('幂等：同一页合并两次不产生重复行', () => {
    seed([mk({ id: 'a-partial', role: 'assistant', text: 'hello wor', createdAt: 20 })])
    const page = [row('row-a', 'assistant', 'hello world', { createdAt: 20 })]
    useChatStore.getState().mergeLatestMessages('s1', page)
    useChatStore.getState().mergeLatestMessages('s1', page)
    expect(state().messages.map((m) => m.id)).toEqual(['row-a'])
  })

  it('合并行里的最新 todo 看板同步到顶层（与 hydrate 同口径）', () => {
    const todos = [{ content: 'step 1', status: 'completed' as const, priority: 'high' as const }]
    const blocks: ContentBlock[] = [{ type: 'todo', title: 'plan', entries: todos }]
    seed([mk({ id: 'u1', dbId: 'u1', role: 'user', text: 'q', createdAt: 10 })])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-a', 'assistant', 'working', { createdAt: 20, blocks }),
    ])
    expect(state().todos).toEqual(todos)
    expect(state().todosTitle).toBe('plan')
  })

  it('undelivered 留痕不被 DB 行顶掉（它只活在内存）', () => {
    seed([
      mk({ id: 'lost-1', role: 'user', text: 'lost on disconnect', undelivered: true, createdAt: 30 }),
    ])
    useChatStore.getState().mergeLatestMessages('s1', [
      row('row-u', 'user', 'lost on disconnect', { createdAt: 30 }),
    ])
    // DB 里没有这条（它从未送达），合并只新增自己的行；echo 去重显式排除 undelivered。
    expect(state().messages.map((m) => m.id)).toEqual(['lost-1', 'row-u'])
  })
})

describe('断连标记与 markDone 的 rowId 落值', () => {
  beforeEach(() => {
    useChatStore.setState({ states: {} })
  })

  it('setNeedsCatchUp 置位/清除', () => {
    useChatStore.getState().setNeedsCatchUp('s1', true)
    expect(state().needsCatchUp).toBe(true)
    useChatStore.getState().setNeedsCatchUp('s1', false)
    expect(state().needsCatchUp).toBe(false)
  })

  it('markDone 带 rowId → 定稿消息落 dbId 与结算时长', () => {
    seed([mk({ id: 'a-1', role: 'assistant', text: 'ans', streaming: true, createdAt: 20 })])
    useChatStore.getState().markDone('s1', { workMs: 4200, waitMs: 300 }, 'row-7')
    const m = state().messages[0]
    expect(m.streaming).toBe(false)
    expect(m.dbId).toBe('row-7')
    expect(m.durationMs).toBe(4200)
    expect(m.waitMs).toBe(300)
  })

  it('markDone 不传 rowId 时保留已有 dbId（turn_state(false) 离线定稿路径）', () => {
    seed([mk({ id: 'row-1', dbId: 'row-1', role: 'assistant', text: 'ans', streaming: true, createdAt: 20 })])
    useChatStore.getState().markDone('s1')
    expect(state().messages[0].dbId).toBe('row-1')
    expect(state().messages[0].streaming).toBe(false)
  })
})
