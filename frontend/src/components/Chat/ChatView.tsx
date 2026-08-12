import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useChatStore, selectChatState, type ChatMessage } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { useAgentStore } from '../../stores/agentStore'
import { useChatShortcuts } from '../../hooks/useChatShortcuts'
import { ChatMessageView } from './ChatMessage'
import { ChatInput } from './ChatInput'
import type { ImageAttachment } from '../../utils/imageAttachment'
import { PermissionBanner } from './PermissionBanner'
import { ConfigToolbar } from './ConfigToolbar'
import { TodoBoard } from './TodoBoard'
import { OverlayScroll } from '../Common/OverlayScroll'
import { READER_FONT } from '../../utils/fonts'
import { decodeStoredBlocks } from '../../hooks/useAcpChat'

/** 距顶部多少像素内触发加载更早历史（留余量，不等滚到绝对顶部）。 */
const TOP_LOAD_THRESHOLD_PX = 200

/** `GET /messages` 响应里的单条消息。 */
interface StoredMessage {
  id: string
  role: string
  text: string
  createdAt: string
  blocks?: string | null
  status?: string | null
}

/**
 * DB 行 → `ChatMessage`。首屏 hydrate 与上拉分页共用同一转换，避免两份平行的
 * blocks 解码/兜底逻辑跑偏。blocks 解不出结构时回退纯文本（text 列
 * 超长会被后端折叠成头尾 + 「已省略 N 字符」标记，故兜底文本可能不完整，但一定可读）。
 */
function toChatMessages(rows: StoredMessage[]): ChatMessage[] {
  return rows.map((m) => {
    let blocks = m.blocks ? decodeStoredBlocks(m.blocks) : null
    if (!blocks || blocks.length === 0) {
      blocks = [{ type: 'text' as const, text: m.text }]
    }
    return {
      id: m.id,
      // Hydrated rows carry their real DB id, so a later sync can target them exactly.
      dbId: m.id,
      role: m.role as 'user' | 'assistant',
      text: m.text,
      blocks,
      createdAt: new Date(m.createdAt).getTime(),
      // 进行中 turn 的行以 streaming 还原，供 turn_snapshot / live 帧无缝续接。
      streaming: m.status === 'streaming',
    }
  })
}

/**
 * ChatView — the ACP-runtime counterpart to `Terminal.tsx`. Renders a
 * vertically stacked title bar + message list + input row.
 *
 * Lifecycle:
 *   - Mounts when `activeSessionId` points at a session whose
 *     `runtime_kind === 'acp'` (the Layout dispatcher, see P4-09).
 *   - `useAcpChat` opens the WS and writes into `chatStore`.
 *   - This component reads from `chatStore` and renders.
 *
 * Auto-scroll follows the common chat pattern: stick to the bottom
 * while the user is at the bottom; stop if they scroll up to read
 * history. Re-stick on next explicit send.
 */
export function ChatView() {
  const { t } = useTranslation()
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const chatFontSize = useAppStore((s) => s.chatFontSize)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession =
    activeSessionId
      ? Object.values(sessions).flat().find((s) => s.id === activeSessionId)
      : null

  // 兜底 agent 显示名：会话关联的 agents.display_name（已释放/未连接时无 capabilities
  // 帧，chatState.agentName 为空；恢复连接后 capabilities 帧的 agent_name 覆盖它）。
  const agents = useAgentStore((s) => s.agents)
  const loaded = useAgentStore((s) => s.loaded)
  const loadAgents = useAgentStore((s) => s.loadAgents)
  const fallbackAgentName = agents.find((a) => a.id === activeSession?.agent_id)?.display_name

  const conn = useAcpConnectionStore((s) =>
    activeSessionId ? s.connections[activeSessionId] : undefined,
  )
  const connectionState = conn?.connectionState ?? 'disconnected'
  // 连接回调经 AcpConnectionManager 注册为稳定引用；`?? (() => {})` 兜底若直接内联
  // 会在每次渲染新建函数，使依赖它们的 useCallback 引用漂移、ChatMessageView memo
  // 失效——故用 useMemo 缓存兜底。
  const sendPrompt = useMemo(() => conn?.sendPrompt ?? (() => {}), [conn])
  const cancel = useMemo(() => conn?.cancel ?? (() => {}), [conn])
  const restore = conn?.restore ?? (() => {})
  const respondPermission = conn?.respondPermission ?? (() => {})
  const setConfigOption = conn?.setConfigOption ?? (() => {})
  const chatState = useChatStore(selectChatState(activeSessionId))
  const isReplaying = chatState.replaying

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [autoStick, setAutoStick] = useState(true)
  // 前插更早历史前的 scrollHeight，用于在布局落定后补偿 scrollTop（保住阅读位置）。
  const prependAnchorRef = useRef<number | null>(null)

  useEffect(() => {
    // agent 配置列表是聊天气泡兜底名称的来源（agents.display_name）。已释放会话
    // 没有 capabilities 帧（未连接），agentName 缺失时用它回退，避免显示 "agent"。
    if (!loaded) loadAgents()
  }, [loaded, loadAgents])

  useEffect(() => {
    if (!activeSessionId) return
    const sid = activeSessionId
    // 已 hydrate 过的会话不再重复拉取。GET /messages 下发 blocks 列（单个 turn
    // 可达数百 KB，存量旧行更大），而 hydrate 自身有「messages 非空即 bail」守卫
    // ——重复拉取的结果会被整份丢弃，纯浪费一次传输 + JSON.parse + 逐条
    // decodeStoredBlocks，切换会话因此明显卡顿。
    // 跳过是安全的：切换不拆 WS（AcpConnectionManager 持久 slot），live 帧持续进
    // store；commitReplay 重建条目时刻意保留 hydrated；chatStore 无 persist，刷新
    // 页面 states 清空 → hydrated 回 false 自然重新拉取。
    if (useChatStore.getState().states[sid]?.hydrated) return
    let cancelled = false
    // 不传 limit：页大小与字节预算由后端守（只有它知道行实际多大）。
    fetch(`/api/v1/sessions/${encodeURIComponent(sid)}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.messages?.length) return
        useChatStore.getState().hydrate(sid, toChatMessages(data.messages), data.nextCursor ?? null)
      })
      .catch(() => {})
      .finally(() => {
        // GET 落定（成功/空/失败）后放行 useAcpChat 的 preHydrateBuffer。
        if (!cancelled) useChatStore.getState().setHydrated(sid, true)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  // 上拉加载更早的一页历史。首屏只取最近一页（后端按条数 + 字节双预算切页），
  // 用户滚到顶部才继续向前取——绝大多数切换只关心最新那批记录。
  const loadOlderHistory = useCallback(async () => {
    const sid = activeSessionId
    if (!sid) return
    const s = useChatStore.getState()
    const st = s.states[sid]
    const cursor = st?.historyCursor
    // cursor 为 null/undefined = 已到历史开头；loadingHistory = 已有请求在飞。
    if (!cursor || st?.loadingHistory) return
    s.beginLoadHistory(sid)
    try {
      const r = await fetch(
        `/api/v1/sessions/${encodeURIComponent(sid)}/messages?before=${encodeURIComponent(cursor)}`,
      )
      const data = r.ok ? await r.json() : null
      // 前插前记录当前 scrollHeight，供 layout effect 补偿滚动位置。
      prependAnchorRef.current = scrollRef.current?.scrollHeight ?? null
      useChatStore
        .getState()
        .prependMessages(sid, toChatMessages(data?.messages ?? []), data?.nextCursor ?? null)
    } catch {
      // 网络失败：清 in-flight 但保留游标，用户再次上拉即重试。
      prependAnchorRef.current = null
      useChatStore.getState().prependMessages(sid, [], cursor)
    }
  }, [activeSessionId])

  // 前插补偿：内容变高后把 scrollTop 前移同样的量，视口停在用户原来读的那一行。
  // 必须用 layout effect（在浏览器绘制前改 scrollTop），否则会闪一帧跳动。
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = prependAnchorRef.current
    if (!el || anchor === null) return
    prependAnchorRef.current = null
    const delta = el.scrollHeight - anchor
    if (delta !== 0) el.scrollTop += delta
  }, [chatState.messages])

  // Re-stick whenever a new chunk/message lands while autoStick is on.
  useEffect(() => {
    if (!autoStick) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatState.messages, autoStick])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setAutoStick(atBottom)
    // 触顶加载更早历史。要求容器真的可滚动：内容不足一屏时 scrollTop 恒为 0，
    // 否则会在 autoStick 仍为 true 的状态下自动拉取并被贴底逻辑拽回底部。
    const scrollable = el.scrollHeight > el.clientHeight + TOP_LOAD_THRESHOLD_PX
    if (scrollable && el.scrollTop < TOP_LOAD_THRESHOLD_PX) void loadOlderHistory()
  }

  // ACP 会话窗口键盘快捷键集中管理（Shift+Tab 切换 mode 等）。
  // 必须置于所有提前 return 之前，遵守 React Hooks 调用顺序规则。
  const onKeyDown = useChatShortcuts({
    configOptions: chatState.configOptions,
    setConfigOption,
  })

  const handleSend = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      // busy 时不直接发送，而是排队：agent 跑完这一轮 (prompt_done) 后 useAcpChat 自动 drain。
      // 详见 docs/adr/0001-acp-queue-drain-location.md。N=1 约束：队列满时 ChatInput
      // 里的 Queue 按钮已 disabled，这里是 belt-and-suspenders 兜底（理论上进入这里的
      // 路径只走 idle 态；busy 走 enqueue 路径不调用 handleSend）。
      // 附件仅支持 idle 直发（队列槽是纯 string），busy 入队时丢弃 images 是预期行为
      // ——ChatInput 已在带附件时禁用 Queue，此路径不会带 images 进入。
      // 从 store 读 sending（而非闭包 chatState），保证回调引用稳定供 ChatMessageView
      // memo 命中，语义不变：两者都是调用时刻的当前状态。
      if (!activeSessionId) return
      const s = useChatStore.getState()
      if (s.states[activeSessionId]?.sending) {
        s.enqueueMessage(activeSessionId, text)
        return
      }
      sendPrompt(text, images)
      // Re-stick so the user's own message is visible + next chunk scrolls in.
      setAutoStick(true)
    },
    [activeSessionId, sendPrompt],
  )

  // F02 编辑重发：原消息标 edited，编辑稿作为全新 prompt 走 handleSend
  // （sending 时自动进 N=1 队列，无需特判）。ACP 无编辑历史语义，见计划 §3.2。
  const handleEditResend = useCallback(
    (messageId: string, newText: string) => {
      if (!activeSessionId) return
      useChatStore.getState().markEdited(activeSessionId, messageId)
      handleSend(newText)
    },
    [activeSessionId, handleSend],
  )

  // F02 重新生成：取最后一条用户消息重发，assistant 回复追加不替换。
  // sending 时走 enqueue+cancel（同 Send Now 的 drain 路径，天然规避与队列的竞态）。
  const handleRegenerate = useCallback(() => {
    if (!activeSessionId) return
    const s = useChatStore.getState()
    const msgs = s.states[activeSessionId]?.messages ?? []
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && !m.undelivered)
    if (!lastUser) return
    if (s.states[activeSessionId]?.sending) {
      s.enqueueMessage(activeSessionId, lastUser.text)
      cancel()
      return
    }
    sendPrompt(lastUser.text)
    setAutoStick(true)
  }, [activeSessionId, sendPrompt, cancel])

  // No session: empty-state placeholder matching Terminal.tsx's look.
  if (!activeSession) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-base)',
          color: 'var(--text-faint)',
          fontFamily: READER_FONT,
        }}
      >
        <div className="panel-title-bar">
          <span>◆</span>
          <span>chat</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            {t('chat.noSession')}
          </div>
        </div>
      </div>
    )
  }

  const handleCancelQueued = () => {
    if (!activeSessionId) return
    useChatStore.getState().clearQueuedMessage(activeSessionId)
  }

  // Send Now on queued chip: 调 cancel() 打断当前 in-flight prompt。
  // 不需要手动调 sendPrompt——现有 useAcpChat 的 prompt_done 分支已经有 drain
  // 逻辑（加 queuedMessage → 调 sendPrompt），cancelled prompt 结束时 drain 自动
  // 触发，队列里的消息随后发出。选这个路径避免 cancel+sendPrompt 的 race condition
  // （旧 prompt_done 在新 in-flight 期间到达会把 sending 拉成 false，造成 UI 闪烁）。
  const handleSendNowQueued = () => {
    cancel()
  }

  // 进程已被释放（手动 release / reaper 自动回收 / 后端重启）且未重新连接时，
  // 也应展示「恢复会话」按钮。acp_process_alive 由 Sidebar 的会话列表轮询刷新，
  // 因而释放后能即时（最多一个轮询周期）反映到 UI，无需刷新页面。
  const released =
    activeSession?.runtime_kind === 'acp' && activeSession?.acp_process_alive === false
  const showRestore = chatState.sessionEnded || released

  const titleChip = (() => {
    if (chatState.sessionEnded) {
      return <span className="title-bar-badge badge-danger">● DEAD</span>
    }
    if (released) {
      return <span className="title-bar-badge badge-danger">● DEAD</span>
    }
    switch (connectionState) {
      case 'connecting':
        return <span className="title-bar-badge">● LINK</span>
      case 'connected':
        return <span className="title-bar-badge">● LIVE</span>
      case 'error':
        return <span className="title-bar-badge">● FAIL</span>
      case 'disconnected':
      default:
        return <span className="title-bar-badge">● OFF</span>
    }
  })()

  const inputDisabled = chatState.sessionEnded || connectionState !== 'connected'

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base)',
        fontFamily: READER_FONT,
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>chat</span>
        {chatState.mode && (
          <span
            style={{
              marginLeft: 8,
              padding: '1px 8px',
              fontSize: 10,
              background: 'var(--accent-14)',
              color: 'var(--accent)',
              borderRadius: 4,
              letterSpacing: '0.08em',
            }}
          >
            {chatState.mode.toUpperCase()}
          </span>
        )}
        <span className="title-bar-spacer" />
        {titleChip}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--bg-base)',
          border: '2px solid var(--wood-shadow, #3A2E1F)',
          boxShadow: '3px 3px 0 var(--pixel-shadow, #8B7755)',
          display: 'flex',
          flexDirection: 'column',
          // 不复用 .terminal-panel-pixel（Terminal/xterm 专用）：其 overflow clip
          // 会在空间不足时静默裁掉输入区，touch-action: none 会禁用聊天列表触摸
          // 滚动。这里只复刻像素面板外观；clip 仅作极端溢出兜底（正常情况由
          // 底部功能区的 flexShrink 策略保证输入区可见，见 TodoBoard/ChatInput）。
          overflow: 'clip',
        }}
      >

      {chatState.error && (
        <div
          style={{
            flexShrink: 0,
            padding: '6px 12px',
            background: 'rgba(255, 123, 114, 0.12)',
            color: 'var(--danger, #FF7B72)',
            fontSize: 12,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {chatState.error}
        </div>
      )}

      <OverlayScroll
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ display: 'flex', flexDirection: 'column', padding: '8px 0', fontSize: chatFontSize }}
      >
        {chatState.loadingHistory && (
          <div className="chat-replay-indicator">
            <span className="replay-spinner" />
            <span>{t('chat.loadingHistory')}</span>
          </div>
        )}
        {chatState.messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: '1em',
              padding: 16,
            }}
          >
            {t('chat.empty')}
          </div>
        )}
        {(() => {
          const lastAssistantId = [...chatState.messages].reverse().find((m) => m.role === 'assistant')?.id
          return chatState.messages.map((m) => (
            <ChatMessageView
              key={m.id}
              message={m}
              agentName={chatState.agentName || fallbackAgentName}
              onEditResend={inputDisabled ? undefined : handleEditResend}
              onRegenerate={inputDisabled || chatState.sending ? undefined : handleRegenerate}
              isLastAssistant={m.id === lastAssistantId}
            />
          ))
        })()}
        {chatState.sending && <ThinkingIndicator />}
        {isReplaying && (
          <div className="chat-replay-indicator">
            <span className="replay-spinner" />
            <span>{t('chat.replaying')}</span>
          </div>
        )}
        {chatState.terminalEvents.map((ev) => (
          <div
            key={ev.id}
            style={{
              margin: '2px 12px',
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.923em',
              fontFamily: 'var(--reader-font, monospace)',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
              borderLeft: '2px solid var(--accent)',
              borderRadius: 4,
              color: 'var(--text-muted)',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>▸</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.command} {ev.args.join(' ')}
            </span>
            <span
              style={{
                flexShrink: 0,
                color:
                  ev.status === 'exited'
                    ? ev.exit_code === 0
                      ? 'var(--success, #3fb950)'
                      : 'var(--danger, #FF7B72)'
                    : 'var(--text-faint)',
              }}
            >
              {ev.status === 'exited'
                ? `exit ${ev.exit_code ?? '?'}`
                : 'running…'}
            </span>
          </div>
        ))}
      </OverlayScroll>

      {chatState.pendingPermissions[0] && (
        <div style={{ flexShrink: 0 }}>
          <PermissionBanner
            permission={chatState.pendingPermissions[0]}
            remaining={chatState.pendingPermissions.length - 1}
            onRespond={respondPermission}
          />
        </div>
      )}

      {showRestore && (
        <div
          style={{
            flexShrink: 0,
            padding: '6px 12px',
            background: 'rgba(255, 255, 255, 0.04)',
            color: 'var(--text-muted)',
            fontSize: 12,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>{t('chat.session.ended')}</span>
          <button
            onClick={restore}
            disabled={connectionState !== 'connected'}
            style={{
              marginLeft: 'auto',
              padding: '2px 10px',
              fontSize: 11,
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              background: 'var(--accent-14)',
              color: 'var(--accent)',
              cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
              opacity: connectionState === 'connected' ? 1 : 0.5,
            }}
          >
            {t('chat.session.restore')}
          </button>
        </div>
      )}

      {/* TodoBoard 允许压缩（flexShrink 1 + overflow hidden）：空间不足时
          优先收缩看板而非输入区，用户可点 header 折叠后查看完整内容。 */}
      <div style={{ flexShrink: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <TodoBoard entries={chatState.todos} title={chatState.todosTitle} />
      </div>

      {/* ChatInput / ConfigToolbar 不参与收缩：输入必须始终可见。 */}
      <div style={{ flexShrink: 0 }}>
        <ChatInput
          key={activeSessionId}
          sessionId={activeSessionId!}
          disabled={inputDisabled}
          sending={chatState.sending}
          queuedMessage={chatState.queuedMessage}
          onSend={handleSend}
          onCancel={cancel}
          onCancelQueued={handleCancelQueued}
          onSendNow={handleSendNowQueued}
          commands={chatState.commands}
          imageSupported={chatState.imageSupported}
        />
      </div>

      <div style={{ flexShrink: 0 }}>
        <ConfigToolbar
          configOptions={chatState.configOptions}
          usage={chatState.usage}
          onSetConfigOption={setConfigOption}
        />
      </div>

      </div>
    </div>
  )
}

/**
 * Terminal-style status line shown at the bottom of the message stream for the
 * whole duration the agent is busy (`sending` === true, i.e. from prompt send
 * until `prompt_done`). Mimics a terminal's live last line so long-running
 * agent tasks (tool calls, waiting, thinking) never leave the view silent.
 * Renders a continuously scrambling hex stream ("decoding" noise, matching the
 * FileManager path-bar look) that never locks into readable text.
 *
 * 该动画属于状态指示器本身，与「像素动效」（马里奥弹跳/金币等游戏化特效）
 * 无关——不应被那个默认关闭的开关抑制，故恒为动画。
 */
const SCRAMBLE_HEX = '0123456789abcdef'
const SCRAMBLE_LEN = 16

const ThinkingIndicator = memo(function ThinkingIndicator() {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const startTimeRef = useRef(0)

  useEffect(() => {
    startTimeRef.current = Date.now()
    // 自适应帧率上限：rAF 回调频率本身等于浏览器实际刷新率，无需主动检测。
    // 高刷屏（>60Hz）压到 60fps 以削减无谓的 layout 抖动；低刷屏跟着屏走。
    const MAX_FPS = 90
    let raf = 0
    let lastDraw = 0
    let minInterval = 1000 / MAX_FPS
    let lastTs = 0
    const tick = (ts: number) => {
      // 首帧 + 顺带用两次 rAF 间隔推算刷新率（零额外测量成本）。
      if (lastTs > 0) {
        const interval = ts - lastTs
        if (interval > 0 && interval < minInterval) {
          minInterval = Math.max(1000 / MAX_FPS, 1000 / Math.round(1000 / interval))
        }
      }
      lastTs = ts
      // 直接写 DOM，不进 React state：避免 thinking 阶段高频 appendThought
      // 重渲染挤占本动画的帧（setInterval 宏任务会被密集渲染推迟）。rAF 与
      // 渲染同调度，且本函数零 React 开销，主线程再忙也只占一帧极小成本。
      if (textRef.current && ts - lastDraw >= minInterval) {
        lastDraw = ts
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        const len = elapsed < 3 ? SCRAMBLE_LEN
          : elapsed < 10 ? 24
          : elapsed < 30 ? 36
          : 54
        let s = ''
        for (let i = 0; i < len; i++) s += SCRAMBLE_HEX[(Math.random() * 16) | 0]
        textRef.current.textContent = s
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 12px 6px',
        fontFamily: 'var(--pixel-font-static)',
        fontSize: '0.923em',
        lineHeight: '20px',
        color: 'var(--text-faint)',
        letterSpacing: 'var(--pixel-tracking-sm)',
        userSelect: 'none',
      }}
    >
      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>▌</span>
      <span ref={textRef} style={{ fontFamily: READER_FONT, letterSpacing: 0 }} />
    </div>
  )
})
