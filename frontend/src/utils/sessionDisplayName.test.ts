import { describe, expect, it } from 'vitest'
import { defaultSessionName, sessionDisplayName } from './sessionDisplayName'

const agents = [
  { id: 'a-codebuddy', display_name: 'CodeBuddy' },
  { id: 'a-opencode', display_name: 'OpenCode' },
]

/** 固定为本地时区解析（与生产口径一致：默认名用浏览器本地时间）。 */
const CREATED_AT = '2026-10-14T11:45:32.000Z'

describe('sessionDisplayName', () => {
  it('用户手写名优先级最高——agent 有标题也不覆盖', () => {
    expect(
      sessionDisplayName(
        { name: '我自己的名字', agent_title: 'agent 自动标题', agent_id: 'a-codebuddy', created_at: CREATED_AT },
        agents,
        '未命名',
      ),
    ).toBe('我自己的名字')
  })

  it('用户没命名时用 agent 侧标题', () => {
    expect(
      sessionDisplayName(
        { name: null, agent_title: '检查待提交改动', agent_id: 'a-codebuddy', created_at: CREATED_AT },
        agents,
        '未命名',
      ),
    ).toBe('检查待提交改动')
  })

  it('空串 name 不算用户命名（trim 后为空）', () => {
    expect(
      sessionDisplayName(
        { name: '   ', agent_title: 'agent 标题', agent_id: 'a-codebuddy', created_at: CREATED_AT },
        agents,
        '未命名',
      ),
    ).toBe('agent 标题')
  })

  it('agent 也没有标题时回落到宿主默认名', () => {
    expect(
      sessionDisplayName(
        { name: undefined, agent_title: null, agent_id: 'a-codebuddy', created_at: CREATED_AT },
        agents,
        '未命名',
      ),
    ).toBe(defaultSessionName(agents[0], CREATED_AT))
  })

  it('tmux/pty 会话（无 agent_id）回落到引擎会话名', () => {
    expect(
      sessionDisplayName(
        { name: undefined, tmux_session_name: 'lt_abc123', created_at: CREATED_AT },
        agents,
        '未命名',
      ),
    ).toBe('lt_abc123')
  })

  it('全空时给「未命名」', () => {
    expect(sessionDisplayName({ created_at: CREATED_AT }, agents, '未命名')).toBe('未命名')
  })

  it('agent_id 指向已删除的 agent 时不崩，回落到未命名', () => {
    expect(
      sessionDisplayName({ agent_id: 'gone', created_at: CREATED_AT }, agents, '未命名'),
    ).toBe('未命名')
  })

  it('created_at 非法时不渲染 Invalid Date', () => {
    expect(
      sessionDisplayName({ agent_id: 'a-codebuddy', created_at: 'not-a-date' }, agents, '未命名'),
    ).toBe('未命名')
  })
})

describe('defaultSessionName', () => {
  it('形态是 ${agent}_${MMdd-HHmm}（本地时间，与历史 CreateSessionModal 逐字一致）', () => {
    // 2026-10-14T11:45:32Z 在 UTC+8 下是 19:45；在 UTC 下是 11:45。这里只断言
    // 形态与自洽性（月份补零、分隔符），具体数值随时区而变是预期行为。
    const d = new Date(CREATED_AT)
    const expected = `${agents[0].display_name}_${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    expect(defaultSessionName(agents[0], CREATED_AT)).toBe(expected)
    expect(defaultSessionName(agents[0], CREATED_AT)).toMatch(/^CodeBuddy_\d{4}-\d{4}$/)
  })

  it('缺 agent 或 created_at 时返回空串（让调用方走下一级兜底）', () => {
    expect(defaultSessionName(undefined, CREATED_AT)).toBe('')
    expect(defaultSessionName(agents[0], undefined)).toBe('')
  })
})
