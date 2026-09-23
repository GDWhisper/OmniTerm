// 鼠标上报模式中继逻辑测试（2026-09-23，docs/dev/debug-patterns/terminal-pty.md
// 模式 9 家族第三例）：cell_frame 架构下 raw 流不转发，TUI 的鼠标上报 DECSET
// 到不了 xterm，`term.modes.mouseTrackingMode` 恒 'none' → useTerminal 的
// wheel 放行分支永不触发，opencode 类 TUI 滚轮完全失效。修复 = 帧消费处按
// `mouse_mode`/`mouse_encoding` 写 DECSET 同步 xterm 解析态（与 bracketed_paste
// 中继同型）。本文件用共享 FakeXterm 验证：
//   ① 帧带模式真值 → write 收到同步串；
//   ② xterm 解析态（fake modes 手动置值模拟）一致后同帧幂等 → 无写放大；
//   ③ 帧缺 mouse_mode（旧后端）→ 跳过同步；
//   ④ encoding 变化经 lastMouseEncRef 记账触发重写（xterm IModes 无 encoding 读口）；
//   ⑤ wheel 放行分支：mouseTrackingMode 非 'none' 时 handler 返回 true；
//   ⑥ 非白名单取值（mouse_mode / mouse_encoding 任一）→ 运行期白名单整体
//      跳过（performance-and-safety.md S1：枚举外部输入显式白名单校验）。
// 真实 xterm 解析态翻转契约见 useTerminal.mouseSync.test.ts。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useTerminal } from './useTerminal'
import { FakeXterm } from '../components/Terminal/fakeXterm'

// Probe-component pattern（无 @testing-library/react），与 useTerminal.test.ts
// 同款；xterm fake 用共享的 components/Terminal/fakeXterm.ts（工厂内动态
// import 与测试代码共享同一类身份，instances 注册表才对得上）。
vi.mock('@xterm/xterm', async () => {
  const { FakeXterm: FakeTerminal } = await import('../components/Terminal/fakeXterm')
  return { Terminal: FakeTerminal }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    dispose(): void {}
  },
}))
vi.mock('./useAttention', () => ({
  useAttention: () => ({ fire: () => {}, clearAlert: () => {} }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { t: (k: string) => k } }),
}))

// ──────────────────────────────────────────────────────────
// FakeWebSocket：记录 send 内容，暴露手动事件触发器
// （与 useTerminal.test.ts 同型——vi.mock/类均为文件级，无法跨测试文件复用）
// ──────────────────────────────────────────────────────────

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
  __open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  __message(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

// rAF stub（useCellFrame enqueue 依赖；收而不 flush，帧不入 xterm）
let rafQueue: Array<() => void> = []

type HookResult = ReturnType<typeof useTerminal>

function Probe(props: { sessionId: string | null; onResult: (r: HookResult) => void }) {
  const r = useTerminal({ sessionId: props.sessionId, runtimeKind: 'pty' })
  props.onResult(r)
  return null
}

describe('useTerminal 鼠标上报模式中继（cell_frame → DECSET 同步 xterm）', () => {
  let root: Root
  let hook: HookResult

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: () => void) => (rafQueue.push(cb), rafQueue.length),
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    FakeXterm.instances = []
    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(
        createElement(Probe, {
          sessionId: 's1',
          onResult: (r) => {
            hook = r
          },
        }),
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
    rafQueue = []
  })

  /** 建 terminal + WS 连接并 open，返回 {ws, term}。 */
  async function mountAndConnect(): Promise<{ ws: FakeWebSocket; term: FakeXterm }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      hook.initTerminal(container)
      for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
    })
    const ws = FakeWebSocket.instances.at(-1)
    expect(ws).toBeDefined()
    const term = FakeXterm.instances.at(-1)
    expect(term).toBeDefined()
    act(() => (ws as FakeWebSocket).__open())
    // 隔离 write 记录：状态行走 writeln（不记录），rAF 未 flush 帧渲染也不入 writes；
    // 显式清空保证断言只看同步块的写入。
    ;(term as FakeXterm).writes.length = 0
    return { ws: ws as FakeWebSocket, term: term as FakeXterm }
  }

  /** 一帧与 FakeXterm 尺寸一致的全帧（不触发 resize 补发）。 */
  function frame(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      t: 'cell_frame',
      width: 80,
      height: 24,
      full: true,
      rows: [{ runs: ['', 'ok '] }],
      ...extra,
    }
  }

  it('帧携带 motion+sgr → write 收到含 ?1003h 与 ?1006h 的同步串；解析态生效后同帧幂等不再写', async () => {
    const { ws, term } = await mountAndConnect()

    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'sgr' })))
    expect(term.writes).toHaveLength(1)
    expect(term.writes[0]).toContain('?1003h')
    expect(term.writes[0]).toContain('?1006h')

    // 模拟 xterm 解析已生效（真实翻转契约见 useTerminal.mouseSync.test.ts）
    term.modes.mouseTrackingMode = 'any'
    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'sgr' })))
    // 幂等：模式与 encoding 均一致 → 不再 write（无写放大）
    expect(term.writes).toHaveLength(1)
  })

  it('帧缺 mouse_mode（旧后端缺省）→ 跳过同步不 write', async () => {
    const { ws, term } = await mountAndConnect()

    act(() => ws.__message(frame()))
    expect(term.writes).toHaveLength(0)
  })

  it('mouse_mode 为非白名单值 → 运行期白名单拦截：不 write、不产生每帧写放大', async () => {
    const { ws, term } = await mountAndConnect()

    // 未知取值若只靠编译期 as 断言：XTERM_TRACKING['bogus'] 索引出 undefined
    // → 比对恒真 → 每帧全量 reset 写放大，且把 TUI 的鼠标跟踪静默复位。
    act(() => ws.__message(frame({ mouse_mode: 'bogus', mouse_encoding: 'sgr' })))
    expect(term.writes).toHaveLength(0)
    act(() => ws.__message(frame({ mouse_mode: 'bogus', mouse_encoding: 'sgr' })))
    expect(term.writes).toHaveLength(0)
  })

  it('mouse_mode 合法但 mouse_encoding 非白名单 → 整体跳过本次同步不 write', async () => {
    const { ws, term } = await mountAndConnect()

    // 任一字段非白名单即整体跳过（与「旧后端缺字段」同款显式回退），
    // 不得只校验 mouse_mode 后让非法 encoding 进入序列生成。
    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'bogus' })))
    expect(term.writes).toHaveLength(0)
    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'bogus' })))
    expect(term.writes).toHaveLength(0)
  })

  it('tracking 已一致但 encoding 变化 → 经 lastMouseEncRef 记账触发重写（IModes 无 encoding 读口）', async () => {
    const { ws, term } = await mountAndConnect()

    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'sgr' })))
    expect(term.writes).toHaveLength(1)
    term.modes.mouseTrackingMode = 'any' // xterm 解析已生效

    // tracking 读口一致，仅 encoding 变化：靠 ref 记账检测，仍须整段重写
    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'utf8' })))
    expect(term.writes).toHaveLength(2)
    expect(term.writes[1]).toContain('?1005h')

    // 再发同帧幂等
    act(() => ws.__message(frame({ mouse_mode: 'motion', mouse_encoding: 'utf8' })))
    expect(term.writes).toHaveLength(2)
  })

  it('wheel 放行：mouseTrackingMode 非 none 时 handler 返回 true（交回 xterm 鼠标上报路径，不进 ViewportController）', async () => {
    const { term } = await mountAndConnect()

    expect(term.wheelHandler).toBeTruthy()
    term.modes.mouseTrackingMode = 'drag'
    expect(term.wheelHandler!({} as WheelEvent)).toBe(true)
  })
})
