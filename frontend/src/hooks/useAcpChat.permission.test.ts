import { describe, it, expect } from 'vitest'
import { parsePermissionRequest } from './useAcpChat'

// F01 permission banner diff 预览：覆盖各实现的 permission request wire format
// 差异（见 docs/dev/plans/2026-07-27-acp-session-enhancements.md §3.1 / §7）。

describe('parsePermissionRequest', () => {
  it('parses standard v1 camelCase request with diff content', () => {
    const req = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc1',
        title: 'Edit src/main.rs',
        kind: 'edit',
        content: [
          { type: 'diff', path: 'src/main.rs', oldText: 'old line', newText: 'new line' },
        ],
        locations: [{ path: 'src/main.rs', line: 3 }],
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    }
    const p = parsePermissionRequest(req)
    expect(p.toolName).toBe('Edit src/main.rs')
    expect(p.toolKind).toBe('edit')
    expect(p.options).toEqual([
      { option_id: 'allow', kind: 'allow_once', name: 'Allow' },
      { option_id: 'reject', kind: 'reject_once', name: 'Reject' },
    ])
    expect(p.locations).toEqual(['src/main.rs'])
    expect(p.content).toContain('--- src/main.rs')
    expect(p.content).toContain('-old line')
    expect(p.content).toContain('+new line')
  })

  it('parses snake_case tool_call / option_id variant', () => {
    const req = {
      tool_call: {
        title: 'Run command',
        kind: 'execute',
        content: [],
        rawInput: { command: 'cargo build' },
      },
      options: [{ option_id: 'a1', kind: 'allow_once' }],
    }
    const p = parsePermissionRequest(req)
    expect(p.toolName).toBe('Run command')
    expect(p.options).toEqual([{ option_id: 'a1', kind: 'allow_once', name: undefined }])
    expect(p.content).toContain('cargo build')
  })

  it('falls back to rawInput JSON when content is absent', () => {
    const req = {
      toolCall: { toolCallId: 'tc2', title: 'Write file', kind: 'write', rawInput: { path: 'a.txt', text: 'hello' } },
      options: [],
    }
    const p = parsePermissionRequest(req)
    expect(p.content).toContain('"path": "a.txt"')
    expect(p.content).toContain('"hello"')
  })

  it('supports string-shaped locations', () => {
    const req = {
      toolCall: { title: 'Read', kind: 'read', locations: ['a.rs', 'b.rs'] },
      options: [],
    }
    expect(parsePermissionRequest(req).locations).toEqual(['a.rs', 'b.rs'])
  })

  it('degrades to text-only banner for legacy flat tool_name requests', () => {
    const req = { tool_name: 'bash', options: [{ optionId: 'y', kind: 'allow_once' }] }
    const p = parsePermissionRequest(req)
    expect(p.toolName).toBe('bash')
    expect(p.toolKind).toBeUndefined()
    expect(p.content).toBeUndefined()
    expect(p.locations).toBeUndefined()
  })

  it('handles empty / malformed request without throwing', () => {
    const p = parsePermissionRequest({})
    expect(p.options).toEqual([])
    expect(p.toolName).toBeUndefined()
    expect(p.content).toBeUndefined()
    expect(parsePermissionRequest({ toolCall: 'not-an-object', options: [null, 42] }).options).toEqual([])
  })
})
