import { vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import type { ChatMessage } from '../../stores/chatStore'
import type { Session } from '../../api/client'
import '../../i18n'

/**
 * ChatView 行为测试共用脚手架：预置 appStore / agentStore 的最小状态（免真实
 * fetch）、按 hydrate 完成态灌入消息、复位相关 store、驱动滚动容器度量与
 * ResizeObserver 回调。createRoot 的挂载/卸载生命周期由各测试文件自管——
 * 各用例的容器与断言布局不同，这里只共享数据准备与滚动路径的模拟手法。
 */

export const SESSION_ID = 's1'

const session: Session = {
  id: SESSION_ID,
  project_id: 'p1',
  workspace_path: '/tmp/ws',
  hook_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  runtime_kind: 'acp',
  acp_process_alive: true,
}

export function userMsg(id: string, text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id, role: 'user', text, blocks: [], createdAt: Date.now(), ...extra }
}

export function assistantMsg(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', text, blocks: [], createdAt: Date.now() }
}

/** 预置最小 store 状态：activeSessionId 指向 ACP 会话、agents 已加载（免兜底请求）。 */
export function setupChatViewStores() {
  useAppStore.setState({ activeSessionId: SESSION_ID, sessions: { p1: [session] } })
  // 置为已加载，避免 ChatView 的兜底 effect 触发真实的 agents 请求。
  useAgentStore.setState({ loaded: true })
}

/** 复位 ChatView 相关 store（chatStore 无 persist，states 需显式清空）。 */
export function resetChatViewStores() {
  useChatStore.setState({ states: {} })
  useAppStore.setState({ activeSessionId: null, sessions: {} })
}

/** hydrated: true 让 ChatView 的 hydrate effect 直接跳过 GET /messages（无需 mock fetch）。 */
export function seedChatMessages(messages: ChatMessage[]) {
  const s = useChatStore.getState()
  s.hydrate(SESSION_ID, messages, null)
  s.setHydrated(SESSION_ID, true)
}

/** ChatView 的消息滚动容器（.overlay-scroll-content 即 scrollRef 指向的节点）。 */
export function chatScrollEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('.overlay-scroll-content')
  if (!el) throw new Error('未找到消息滚动容器')
  return el
}

/**
 * 把滚动容器度量 mock 成给定状态（实例属性遮蔽 jsdom 原生访问器——jsdom 不做
 * 布局，scrollHeight/clientHeight 恒为 0，贴底判定只能靠显式 mock 驱动）。
 * `setClientHeight` / `setScrollHeight` 单独改视口高度与内容高度，用来模拟
 * 「容器收缩」或「内容长高但滚动位置不动、也没有 scroll 事件」这类布局变化。
 */
export function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  let top = metrics.scrollTop
  let client = metrics.clientHeight
  let scroll = metrics.scrollHeight
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scroll })
  return {
    getTop: () => top,
    setTop: (v: number) => {
      top = v
    },
    setClientHeight: (v: number) => {
      client = v
    },
    setScrollHeight: (v: number) => {
      scroll = v
    },
  }
}

/** 派发消息区 scroll 事件（滚动才走 handleScroll）。 */
export function fireScroll(host: HTMLElement) {
  chatScrollEl(host).dispatchEvent(new Event('scroll'))
}

/**
 * 记录 ResizeObserver 的 (目标元素, 回调)：jsdom 不跑布局也不派发 RO 回调，
 * 「容器尺寸变化」路径只能由用例手动触发 ChatView 观察滚动容器的那一个回调。
 * 用完需 `vi.unstubAllGlobals()` 复位。
 */
export function installResizeObserverSpy() {
  const observed: { target: Element; cb: ResizeObserverCallback }[] = []
  class SpyResizeObserver {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }
    observe(target: Element) {
      observed.push({ target, cb: this.cb })
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', SpyResizeObserver as unknown as typeof ResizeObserver)
  return {
    /** 触发观察该元素的回调（未被观察即抛，避免用例静默失效）。 */
    fire(target: Element) {
      const hits = observed.filter((o) => o.target === target)
      if (hits.length === 0) throw new Error('该元素未被 ResizeObserver 观察')
      for (const hit of hits) hit.cb([], null as unknown as ResizeObserver)
    },
  }
}
