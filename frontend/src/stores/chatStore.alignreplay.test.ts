import { describe, it, expect } from 'vitest'
import {
  alignReplaySyncPayload,
  type ChatMessage,
  type ContentBlock,
  type SyncMessagePayload,
} from './chatStore'

// 手动恢复重放的 id 对齐（docs/dev/plans/2026-09-19-acp-failure-visibility.md D4 / P1）。
//
// 纯函数单测：对齐规则 = 位置（只前移）+ 角色相等 + 基线 text 是重放 text 的前缀。
// 守卫失败一律降级为「不带 id」——即今天的无 id 文本匹配/INSERT 行为，是可恢复的
// 污染；而纯位置对齐会 UPDATE 到错误行，那是不可恢复的静默数据损坏。
//
// 镜像 messagesToSyncPayload 的既有过滤：system 行从不回写、undelivered 只活内存。

function mk(overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage {
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

/** 期望载荷条目（与 SyncMessagePayload 同形）。 */
const entry = (over: { id?: string; role: string; text: string; blocks?: ContentBlock[] }) => ({
  ...(over.id ? { id: over.id } : {}),
  role: over.role,
  text: over.text,
  ...(over.blocks && over.blocks.length ? { blocks: JSON.stringify(over.blocks) } : {}),
})

/**
 * 调 `alignReplaySyncPayload` 并只取载荷 —— 绝大多数用例只关心 id 对齐结果。
 * 返回值是「数组本体 + 不可枚举的 `degraded` 属性」，取数组本体即与改动前同形
 * （`toEqual` / `JSON.stringify` 都看不见那个属性）。超限信号（`degraded`）由文末
 * 专门的 describe 直接调原函数断言，不经此 helper。
 */
const align = (
  replay: readonly ChatMessage[],
  baseline: readonly ChatMessage[],
): SyncMessagePayload[] => alignReplaySyncPayload(replay, baseline)

describe('alignReplaySyncPayload — 带守卫的位置对齐', () => {
  it('attaches the baseline dbId when the same-role row text is a prefix of the replay text', () => {
    // 事故形态：DB 行的 text 是被 MAX_TEXT_BYTES 折叠/窗口驱逐后的前缀，重放是完整历史。
    // 前缀命中 → 带 id → 后端 UPDATE 该行 blocks，不 INSERT。
    const baseline = [mk({ role: 'assistant', text: 'install the dep', dbId: 'row-1' })]
    const replay = [mk({ role: 'assistant', text: 'install the dep\nnow run the tests' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    expect(payload[0].id).toBe('row-1')
    expect(payload[0].text).toBe('install the dep\nnow run the tests')
    // blocks 复用的是落库序列化（图片只留缩略图），不是本函数另写一份。
    expect(payload[0].blocks).toBe(JSON.stringify(replay[0].blocks))
  })

  it('attaches the dbId on an exact text match too (prefix includes equality)', () => {
    const baseline = [mk({ role: 'user', text: 'fix the build', dbId: 'row-u' })]
    const replay = [mk({ role: 'user', text: 'fix the build' })]
    expect(align(replay, baseline)).toEqual([
      entry({ id: 'row-u', role: 'user', text: 'fix the build', blocks: replay[0].blocks }),
    ])
  })

  it('leaves the message without an id when no same-role prefix match exists', () => {
    // 守卫失败 → 降级为今天的无 id 行为（后端文本匹配 / INSERT）。这是翻盘条件的
    // 兜底路径，必须是单条粒度而不是整份载荷。
    const baseline = [mk({ role: 'assistant', text: 'totally unrelated text', dbId: 'row-1' })]
    const replay = [mk({ role: 'assistant', text: 'the actual reply' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('attaches no id for surplus replay turns beyond the baseline rows', () => {
    // agent 重放的回合比 DB 行多（hydrate 只取最近一页，或新 turn 尚未落库）。
    const baseline = [mk({ role: 'user', text: 'q1', dbId: 'row-1' })]
    const replay = [
      mk({ role: 'user', text: 'q1' }),
      mk({ role: 'assistant', text: 'a1' }),
      mk({ role: 'user', text: 'q2' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.text)).toEqual(['q1', 'a1', 'q2'])
    expect(payload[0].id).toBe('row-1')
    expect(payload[1]).not.toHaveProperty('id')
    expect(payload[2]).not.toHaveProperty('id')
  })

  it('produces no entry for unconsumed baseline rows when the baseline is longer', () => {
    // 基线更长（DB 有更早的历史页）：不因多出的行产生任何 spurious id 或额外条目。
    // 载荷长度只由 replay 决定。
    const baseline = [
      mk({ role: 'user', text: 'older', dbId: 'row-0' }),
      mk({ role: 'assistant', text: 'older reply', dbId: 'row-1' }),
    ]
    const replay = [mk({ role: 'assistant', text: 'older reply and more' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    // 第一行 user 与 assistant 角色不符 → 不消耗；第二行命中。
    expect(payload[0].id).toBe('row-1')
  })

  it('attaches no id when the roles differ at the same position', () => {
    const baseline = [mk({ role: 'user', text: 'hello', dbId: 'row-1' })]
    const replay = [mk({ role: 'assistant', text: 'hello there' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('never emits system or undelivered messages from the replay', () => {
    // 与 messagesToSyncPayload 同一过滤：system 行后端自己写，undelivered 只活内存。
    const baseline = [mk({ role: 'user', text: 'hi', dbId: 'row-1' })]
    const replay = [
      mk({ role: 'system', text: '[ToolCall]' }),
      mk({ role: 'user', text: 'hi', undelivered: true }),
      mk({ role: 'assistant', text: 'hi back' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.role)).toEqual(['assistant'])
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('skips system baseline rows when advancing (they are never synced either)', () => {
    // hydrate 行里混有 system 行（权限超时告知等）：它们在两侧都不参与同步，故基线
    // 指针跨过它们而不是把重放消息判成失配。
    const baseline = [
      mk({ role: 'user', text: 'q', dbId: 'row-1' }),
      mk({ role: 'system', text: '[permission timeout]' }),
      mk({ role: 'assistant', text: 'a prefix', dbId: 'row-2' }),
    ]
    const replay = [
      mk({ role: 'user', text: 'q' }),
      mk({ role: 'assistant', text: 'a prefix extended' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.text)).toEqual(['q', 'a prefix extended'])
    expect(payload[0].id).toBe('row-1')
    expect(payload[1].id).toBe('row-2')
  })

  it('does not attach a baseline row that itself has no dbId (a local id matches no row)', () => {
    const baseline = [mk({ role: 'assistant', text: 'same text' })]
    const replay = [mk({ role: 'assistant', text: 'same text extended' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('does not normalize whitespace — a whitespace-only difference fails the guard', () => {
    // 刻意不做空白归一：归一化会把 "a b"/"a  b" 也算成匹配，扩大误命中面。
    // 失配退化成今天的 INSERT，比误 UPDATE 一行更可接受。
    const baseline = [mk({ role: 'assistant', text: 'a  b', dbId: 'row-1' })]
    const replay = [mk({ role: 'assistant', text: 'a b' })]
    const payload = align(replay, baseline)
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('aligns a multi-turn replay positionally, consuming each baseline row once', () => {
    const baseline = [
      mk({ role: 'user', text: 'q1', dbId: 'row-1' }),
      mk({ role: 'assistant', text: 'a1 partial', dbId: 'row-2' }),
      mk({ role: 'user', text: 'q2', dbId: 'row-3' }),
      mk({ role: 'assistant', text: 'a2 partial', dbId: 'row-4' }),
    ]
    const replay = [
      mk({ role: 'user', text: 'q1' }),
      mk({ role: 'assistant', text: 'a1 partial + tool blocks' }),
      mk({ role: 'user', text: 'q2' }),
      mk({ role: 'assistant', text: 'a2 partial + tool blocks' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.id)).toEqual(['row-1', 'row-2', 'row-3', 'row-4'])
  })

  it('degrades only the mismatching message, not the whole session', () => {
    // 中间一条失配（DB 文本与重放语义漂移）→ 只丢那一条的 id，前后行照常命中。
    const baseline = [
      mk({ role: 'user', text: 'q1', dbId: 'row-1' }),
      mk({ role: 'assistant', text: 'drifted text', dbId: 'row-2' }),
      mk({ role: 'user', text: 'q2', dbId: 'row-3' }),
    ]
    const replay = [
      mk({ role: 'user', text: 'q1' }),
      mk({ role: 'assistant', text: 'replayed text' }),
      mk({ role: 'user', text: 'q2' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.id)).toEqual(['row-1', undefined, 'row-3'])
    expect(payload[1]).not.toHaveProperty('id')
  })

  it('never consumes a baseline row twice (no UPDATE onto an already-written row)', () => {
    // 两条相同文本的重放消息不得都命中同一条基线行——那会把第二条的 blocks 写到
    // 第一条已更新的行上（后端 id 路径只认 id，两条同 id 的二次 UPDATE 是静默覆盖）。
    const baseline = [mk({ role: 'assistant', text: 'same', dbId: 'row-1' })]
    const replay = [
      mk({ role: 'assistant', text: 'same one' }),
      mk({ role: 'assistant', text: 'same two' }),
    ]
    const payload = align(replay, baseline)
    expect(payload[0].id).toBe('row-1')
    expect(payload[1]).not.toHaveProperty('id')
  })

  it('returns an empty payload for an empty replay', () => {
    expect(align([], [mk({ role: 'user', text: 'x', dbId: 'row-1' })])).toEqual([])
    expect(align([], [])).toEqual([])
  })

  it('omits the blocks key when a message has no blocks (matches messagesToSyncPayload)', () => {
    const baseline = [mk({ role: 'user', text: 'q', dbId: 'row-1', blocks: [] })]
    const replay = [mk({ role: 'user', text: 'q', blocks: [] })]
    const payload = align(replay, baseline)
    expect(payload[0]).toEqual({ id: 'row-1', role: 'user', text: 'q' })
    expect(payload[0]).not.toHaveProperty('blocks')
  })

  it('does not align an empty-text baseline row (empty prefix matches everything)', () => {
    // 空 text 的基线行（纯工具调用 turn 在 DB 里 text 为空）对任何重放文本都构成
    // 前缀，是必然的误命中 → 跳过它，让该条消息降级为 INSERT。
    const baseline = [mk({ role: 'assistant', text: '', dbId: 'row-1', blocks: [] })]
    const replay = [mk({ role: 'assistant', text: 'anything' })]
    const payload = align(replay, baseline)
    expect(payload[0]).not.toHaveProperty('id')
  })
})

// 指针策略的边界形态（审核提问补齐的用例，非普通 happy path）：
// 只读扫描 + 命中提交指针，vs. 失配也推进指针。下面三条把两者的差异钉住。

describe('alignReplaySyncPayload — 边界形态（指针推进策略）', () => {
  it('replay shorter than the baseline (agent replays only recent turns)', () => {
    // 形态：重放窗口排除了最早一轮 —— 首条重放消息 q2 在基线里对应的是**第 3 行**，
    // 而 q1/u1/a1 都在它前面且角色相同。
    // 「只读扫描」正是为这个形态设计的：扫描推过 q1/a1（守卫不通过），命中 q2，
    // 且 cursor 一次性提交到 q2 之后，a2 随后照常命中。若失配时也推进指针，
    // 首个消息就会把 cursor 卡在 1，整份载荷退化成全量 INSERT（收益归零）。
    const baseline = [
      mk({ role: 'user', text: 'q1', dbId: 'u1' }),
      mk({ role: 'assistant', text: 'a1', dbId: 'a1' }),
      mk({ role: 'user', text: 'q2', dbId: 'u2' }),
      mk({ role: 'assistant', text: 'a2', dbId: 'a2' }),
    ]
    const replay = [
      mk({ role: 'user', text: 'q2' }),
      mk({ role: 'assistant', text: 'a2' }),
    ]
    const payload = align(replay, baseline)
    expect(payload.map((p) => p.id)).toEqual(['u2', 'a2'])
  })

  it('the same baseline row is never reused for two replay messages (no double UPDATE)', () => {
    // 追问点：两条相同文本的重放消息会不会把同一个 DB 行 UPDATE 两次？
    // 不会：命中即把 cursor 提交到该行**之后**，第二条只能另找一行。失配时才是
    // 「无 id」（退化为 INSERT），而不是「复用同一个 id」。
    const baseline = [mk({ role: 'assistant', text: 'same', dbId: 'row-1' })]
    const replay = [
      mk({ role: 'assistant', text: 'same one' }),
      mk({ role: 'assistant', text: 'same two' }),
    ]
    const payload = align(replay, baseline)
    expect(payload[0].id).toBe('row-1')
    expect(payload[1]).not.toHaveProperty('id')
    expect(payload.filter((p) => p.id === 'row-1')).toHaveLength(1)
  })

  it('replay text that extends an earlier-but-equal-text row still pairs positionally', () => {
    // 相邻两条基线 text 相同、且重放文本同时以两者为前缀（含相等）时：先命中靠前的
    // 那条（扫描顺序 = 数组顺序），后一条消息再命中靠后的那条。配对严格保序，
    // 不会出现「后一条重放消息配到已配对行之前」的交叉配对。
    const baseline = [
      mk({ role: 'assistant', text: 'OK', dbId: 'row-1' }),
      mk({ role: 'assistant', text: 'OK', dbId: 'row-2' }),
    ]
    const replay = [
      mk({ role: 'assistant', text: 'OK' }),
      mk({ role: 'assistant', text: 'OK' }),
    ]
    expect(align(replay, baseline).map((p) => p.id)).toEqual(['row-1', 'row-2'])
  })

  it('a longer replay never matches an earlier row than an already-matched one (ordering invariant)', () => {
    // 安全不变量的直接断言：命中消息的配对基线下标严格递增。
    // 构造「首条重放消息失配」+「后续消息的对应基线行排在一条同名角色行之前」：
    // 失配不能吃掉那条行（否则本条只能降级），且不能反向配到更早的行上。
    // 注意别把基线文本选成重放文本的前缀（'q2'.startsWith('q') 为真）——那是守卫的
    // 合法命中，不是失配，测不出指针策略。
    const baseline = [
      mk({ role: 'user', text: 'first question', dbId: 'u1' }),
      mk({ role: 'assistant', text: 'first answer', dbId: 'a1' }),
      mk({ role: 'user', text: 'second question', dbId: 'u2' }),
    ]
    const replay = [
      mk({ role: 'assistant', text: 'unrelated drift' }),
      mk({ role: 'user', text: 'second question' }),
    ]
    const payload = align(replay, baseline)
    // 第 1 条失配：扫过 u1（角色不符）、a1（守卫不通过）、u2（角色不符）→ 无命中，
    // cursor 原地不动。
    expect(payload[0]).not.toHaveProperty('id')
    // 第 2 条：推过 u1（'first question' 不是前缀）、a1（角色不符），命中 u2。
    expect(payload[1].id).toBe('u2')
  })
})

// 扫描预算 ALIGN_SCAN_BUDGET（性能安全阀）：只读扫描在全失配时是
// O(replay × baseline)，上游分页上限只界住输入不界住这次计算。预算封顶单条消息的
// 候选检查数，耗尽即降级为无 id。断言载荷 id，不探内部计数器。

describe('alignReplaySyncPayload — 扫描预算（性能安全阀）', () => {
  /** 造 N 条同角色、文本互不为前缀的基线行（最坏情况：每条都要被逐个推过）。 */
  const driftRows = (n: number, tag: string) =>
    Array.from(
      { length: n },
      (_, i) => mk({ role: 'assistant', text: `${tag} #${i} drifting further away`, dbId: `${tag}-${i}` }),
    )

  it('a matching row placed beyond the budget is NOT reached (proves the budget actually bites)', () => {
    // 这条是预算的**正向**证明：对应行存在且守卫能通过，但排在 200 个候选之后。
    // 有预算 → 搜索在 100 个候选处停止 → 该条降级为无 id；
    // 若把 `examined < ALIGN_SCAN_BUDGET` 从循环条件里删掉，这条会命中
    // 'row-target' 而失败——即它区分「有预算」与「无预算」，不是空转的断言。
    const baseline = [
      ...driftRows(200, 'bl'),
      mk({ role: 'assistant', text: 'the real target', dbId: 'row-target' }),
    ]
    const replay = [mk({ role: 'assistant', text: 'the real target plus more' })]
    expect(align(replay, baseline)[0]).not.toHaveProperty('id')
  })

  it('degrades to no-id past the scan budget instead of scanning the whole baseline', () => {
    // 远超预算的漂移基线 → 该条消息早失配（不扫完 1000 行），且失配形态是「无 id」。
    const baseline = driftRows(1000, 'bl')
    const replay = [mk({ role: 'assistant', text: 'replay text that matches nothing' })]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(1)
    expect(payload[0]).not.toHaveProperty('id')
  })

  it('a message whose row sits inside the budget still aligns (budget never cuts normal work)', () => {
    // 对应行排在前 100 个候选内 → 照常命中：预算只让「本来就会失配的早点失配」，
    // 不可能把本来能对齐的行判成失配。
    const baseline = driftRows(1000, 'bl')
    baseline[50] = mk({ role: 'assistant', text: 'the real target', dbId: 'row-target' })
    const replay = [mk({ role: 'assistant', text: 'the real target plus more' })]
    expect(align(replay, baseline)[0].id).toBe('row-target')
  })

  it('the budget is per message — later messages get their own full search', () => {
    // 单条消息耗尽预算不得连带惩罚后续消息（每条独立计数）——证明它是安全阀，
    // 不是正确性机制。真实行排在 60 个漂移行之后仍能被后续消息命中。
    const baseline = [
      ...driftRows(60, 'early'),
      mk({ role: 'user', text: 'the right question', dbId: 'uq' }),
      ...driftRows(60, 'late'),
      mk({ role: 'assistant', text: 'the right answer', dbId: 'aa' }),
    ]
    const replay = [
      mk({ role: 'assistant', text: 'no counterpart at all' }),
      mk({ role: 'user', text: 'the right question' }),
      mk({ role: 'assistant', text: 'the right answer' }),
    ]
    const payload = align(replay, baseline)
    // 第 1 条：预算内的候选全是 assistant 且文本不构成前缀 → 耗尽 → 无 id。
    expect(payload[0]).not.toHaveProperty('id')
    // 第 2/3 条：各自独立搜索，越过前面的漂移行命中真实行。
    expect(payload[1].id).toBe('uq')
    expect(payload[2].id).toBe('aa')
  })

  it('does not abort the whole alignment when one message hits the budget', () => {
    // 第一条把预算吃光也不影响后续条目产出：载荷长度恒等于重放条数，
    // 且没有任何一条被误配上 id。
    const baseline = driftRows(500, 'bl')
    const replay = [
      mk({ role: 'assistant', text: 'matches nothing one' }),
      mk({ role: 'assistant', text: 'matches nothing two' }),
      mk({ role: 'assistant', text: 'matches nothing three' }),
    ]
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(3)
    expect(payload.map((p) => p.id)).toEqual([undefined, undefined, undefined])
  })

  it('a happy-path 1:1 alignment never approaches the budget (whole session still aligned)', () => {
    // 与上面的漂移态对照：每条消息第一个候选即命中，整份载荷全带 id。
    // 这条守的是「预算不会把正常会话切出一段无 id 区间」。
    const baseline = Array.from({ length: 100 }, (_, i) =>
      mk({ role: 'assistant', text: `turn ${i}`, dbId: `row-${i}` }),
    )
    const replay = baseline.map((row) => mk({ role: 'assistant', text: `${row.text} plus replayed blocks` }))
    const payload = align(replay, baseline)
    expect(payload).toHaveLength(100)
    expect(payload.every((p) => p.id?.startsWith('row-'))).toBe(true)
  })
})

// ── 整场总量预算 MAX_ALIGN_COMPARISONS（§P1：上限维度必须匹配真实增长维度）──
//
// 单条预算（ALIGN_SCAN_BUDGET）只界住「一次扫描的宽度」，界不住扫描的**次数**：
// 总量 = 重放条数 × 每条预算 × 文本长度，而**重放条数这一维完全没有上限** ——
// `session/load` 重放完整历史，与后端分页预算无关。独立审查实测（全 assistant
// 历史 + 4.8KB 公共前缀）：replay=1000 → 主线程冻结 1404ms；5000 条 → 3498ms。
//
// 超限策略：**整场降级**为不带任何 id 的全量写回（= messagesToSyncPayload 的既有
// 行为），由挂在返回值上的 `degraded` 标志显式表达 —— 不是「返回空数组」那条碰巧
// 的路径（user/assistant 消息只要有一条就产生 entry，纯失配不会让载荷为空）。
//
// 本 describe 的用例**直接调原函数**（不经上面的 align helper），因为要断的正是
// `degraded` 这个信号本身。

describe('alignReplaySyncPayload — 整场总量预算（性能安全阀）', () => {
  /** 同角色、文本互不为前缀的基线行（全失配形态：每条候选都要被逐个推过）。 */
  const driftRows = (n: number, tag: string) =>
    Array.from(
      { length: n },
      (_, i) => mk({ role: 'assistant', text: `${tag} #${i} drifting further away`, dbId: `${tag}-${i}` }),
    )

  it('degrades the whole session (no ids at all) once the total comparison budget is spent', () => {
    // 总量超限的直接断言：replay 远大于 MAX_ALIGN_COMPARISONS / ALIGN_SCAN_BUDGET，
    // 于是「单条预算内永远失配」被重复到总量耗尽。期待 degraded 置位 + 空载荷
    // （调用方据此回落 syncToDb() = messagesToSyncPayload 的既有全量写回行为）。
    const baseline = driftRows(2000, 'bl')
    const replay = Array.from({ length: 60 }, (_, i) =>
      mk({ role: 'assistant', text: `replay #${i} matches nothing at all` }),
    )
    const result = alignReplaySyncPayload(replay, baseline)
    expect(result.degraded).toBe(true)
    // 空载荷 = 「不带任何 id」。降级必须连一个 id 都不剩：留着几条 id 载荷会让
    // 调用方以为这场对齐部分有效。
    expect(result).toEqual([])
    // 显式断「没有任何 id」，不探内部计数器：即便将来降级形态改成别的表达，这条仍成立。
    expect(result.some((p) => p.id !== undefined)).toBe(false)
  })

  it('the degraded signal is observable without relying on the payload being empty by chance', () => {
    // 对照上一条：**未**超限时 degraded 必须为 false，即使载荷因为别的原因为空
    // （空 replay）。证明 degraded 是独立信号，不是「空数组」的同义词。
    expect(alignReplaySyncPayload([], []).degraded).toBe(false)
    // 单条消息 + 短基线：总量远未耗尽。
    expect(
      alignReplaySyncPayload([mk({ role: 'assistant', text: 'x' })], driftRows(50, 'bl')).degraded,
    ).toBe(false)
  })

  it('a total budget that is spent leaves no id-carrying entry behind (id-free write-back)', () => {
    // 上一条的语义加强版：即使被降级前已经有若干消息成功带上 id，超限后整份载荷
    // 也必须是「无 id 全集」——因为调用方要走的是全量写回，混入 id 会造成
    // 「部分 id + 部分无 id」的第三种形态（后端 id 路径与文本匹配路径混用）。
    const baseline = [
      // 前 30 条可命中（重放与基线 1:1，文本互相构成前缀）。
      ...Array.from({ length: 30 }, (_, i) =>
        mk({ role: 'assistant', text: `ok ${i}`, dbId: `row-${i}` }),
      ),
      // 之后 2000 条全失配漂移行，把总量吃光。
      ...driftRows(2000, 'drift'),
    ]
    const replay = [
      ...Array.from({ length: 30 }, (_, i) => mk({ role: 'assistant', text: `ok ${i} extended` })),
      ...Array.from({ length: 60 }, (_, i) => mk({ role: 'assistant', text: `sink #${i} nothing` })),
    ]
    const result = alignReplaySyncPayload(replay, baseline)
    expect(result.degraded).toBe(true)
    expect(result).toEqual([])
    expect(result.every((p) => p.id === undefined)).toBe(true)
  })

  it('a normal-sized session never trips the total budget even when every message mismatches', () => {
    // 反向保护：总量预算不得把「正常规模的病态形态」也一刀切掉。30 条重放 × 100
    // 条单条预算 = 3000 次比较，全部花在失配上仍不到 5000 —— 即总量预算的阈值在
    // 「真实会话重放规模」之上，只拦真正无底的重放条数。
    const baseline = driftRows(100, 'bl')
    const replay = Array.from({ length: 30 }, (_, i) =>
      mk({ role: 'assistant', text: `small session mismatch #${i}` }),
    )
    const result = alignReplaySyncPayload(replay, baseline)
    expect(result.degraded).toBe(false)
    // 未降级 → 载荷即既有语义：每条都在，全部无 id（单条预算内失配）。
    expect(result).toHaveLength(30)
    expect(result.every((p) => p.id === undefined)).toBe(true)
  })

  it('the budget is per whole alignment: a second call starts from a fresh total', () => {
    // 总量预算是**每次调用**的局部状态（函数体内的 let），不是模块级累积：
    // 同一份病态输入连续调两次，两次的结果必须一致（都没有跨调用泄漏预算）。
    const baseline = driftRows(2000, 'bl')
    const replay = Array.from({ length: 60 }, (_, i) =>
      mk({ role: 'assistant', text: `replay #${i} matches nothing at all` }),
    )
    const first = alignReplaySyncPayload(replay, baseline)
    const second = alignReplaySyncPayload(replay, baseline)
    expect(first.degraded).toBe(true)
    expect(second.degraded).toBe(true)
    expect(second).toEqual(first)
    // `degraded` 只是附在数组上的属性，不改变载荷自身的序列化形态。
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('the degraded flag does not leak into the JSON POST body (array identity preserved)', () => {
    // 调用方 `postSync` 序列化的是载荷数组本体；`degraded` 必须只活在内存里，
    // 不进请求体。这样调用点无需任何改动即可继续工作（越界文件的硬约束）。
    const result = alignReplaySyncPayload(
      Array.from({ length: 60 }, (_, i) => mk({ role: 'assistant', text: `replay #${i} nothing` })),
      driftRows(2000, 'bl'),
    )
    expect(result.degraded).toBe(true)
    expect(JSON.parse(JSON.stringify({ messages: result }))).toEqual({ messages: [] })
    // 长度语义与改动前一致：`alignedSync.length > 0` 分支自然落到 else（syncToDb）。
    expect(result.length).toBe(0)
  })
})
