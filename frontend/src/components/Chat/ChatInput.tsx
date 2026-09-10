import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { OverlayScroll } from '../Common/OverlayScroll'
import { useChatStore, readQueuedFromStorageForSession, type SlashCommand } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { getDraft, saveDraft, deleteDraft } from '../../utils/chatDraft'
import { api, type FileEntry } from '../../api/client'
import { findAtToken, replaceAtToken, type AtToken } from '../../utils/atReference'
import {
  processImageFile,
  extractImageFiles,
  ImageAttachmentError,
  imageSrc,
  type ImageAttachment,
} from '../../utils/imageAttachment'
import { processFile, formatFileSize, type FileAttachment } from '../../utils/fileAttachment'
import { hapticTap } from '../../utils/haptics'
import { IconFile, IconPlus } from '../FileManager/icons'
import { ChatAttachDrawer } from './ChatAttachDrawer'

interface ChatInputProps {
  sessionId: string
  disabled: boolean
  onSend: (text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void
  onCancel: () => void
  /** Clicked when the user taps ✕ on the queued-message chip above the input. */
  onCancelQueued: () => void
  /**
   * Clicked when the user taps ▶ on the queued-message chip. ChatView forwards
   * to the in-flight `cancel()` — the existing `prompt_done`-driven drain in
   * `useAcpChat` then auto-sends the queued text once the cancelled prompt
   * finishes. No new state machine, no race with the in-flight's `markDone`.
   */
  onSendNow: () => void
  sending: boolean
  /** N=1 single-slot queued message buffer; rendered as a chip above the textarea. */
  queuedMessage: string | null
  commands?: SlashCommand[]
  /** Agent 是否声明支持 image prompt capability（§8：未声明则置灰相册卡片）。 */
  imageSupported?: boolean
  /** Agent 是否声明支持 embeddedContext（§8：未声明则置灰文件卡片）。 */
  fileSupported?: boolean
}

const QUEUE_PREVIEW_CHARS = 40
/** 输入行基准高度：textarea 单行 minHeight 与按钮高度一致，保证垂直居中对齐。 */
const INPUT_ROW_HEIGHT = 36
/** @ 文件补全弹窗展示的最大条数（后端搜索上限 100，取前 N）。 */
const MAX_AT_RESULTS = 20
/** @ 补全搜索防抖间隔。 */
const AT_SEARCH_DEBOUNCE_MS = 200
/** 隐藏文件选择器：离屏但可点击（`display:none` 会让部分移动端浏览器拒绝程序化 click）。 */
const HIDDEN_INPUT_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: -9999,
  top: 0,
  width: 1,
  height: 1,
  opacity: 0,
}

export function ChatInput({
  sessionId,
  disabled,
  onSend,
  onCancel,
  onCancelQueued,
  onSendNow,
  sending,
  queuedMessage,
  commands = [],
  imageSupported = false,
  fileSupported = false,
}: ChatInputProps) {
  const { t } = useTranslation()
  // 移动端无物理键盘：水印里的 Enter/Shift+Enter 提示是桌面专属操作，换成中性文案。
  const isMobile = useAppStore((s) => s.isMobile)
  const [text, setText] = useState(() => getDraft(sessionId) || '')
  const [showCommands, setShowCommands] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // @ 文件补全：光标处的 @token / Esc 关闭标记 / 搜索结果
  const [atToken, setAtToken] = useState<AtToken | null>(null)
  const [atDismissedStart, setAtDismissedStart] = useState<number | null>(null)
  const [fileResults, setFileResults] = useState<FileEntry[]>([])
  const [fileSearching, setFileSearching] = useState(false)
  const [fileActiveIndex, setFileActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const fileItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const atCursorRef = useRef(0)
  const attachErrorTimerRef = useRef<number | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // D7「引用到输入框」通道：动作写入 pendingInsert，本组件按 sessionId 消费。
  // 订阅而非 getState：挂载时若已有未消费值（跨会话切换），effect 能读到。
  const pendingInsert = useChatStore((s) => s.pendingInsert)

  useEffect(() => {
    if (!pendingInsert || pendingInsert.sessionId !== sessionId) return
    const quote = pendingInsert.text
    setText(quote)
    useChatStore.getState().consumeInsert()
    textareaRef.current?.focus()
    // 光标置末尾：引用块应可直接继续输入追问
    const el = textareaRef.current
    if (el) {
      const len = quote.length
      requestAnimationFrame(() => el.setSelectionRange(len, len))
    }
  }, [pendingInsert, sessionId])

  // Persist unsent text per session and restore when switching back.
  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      // Save the draft for the outgoing session before applying the new one.
      if (text.trim() !== '') {
        saveDraft(prevSessionIdRef.current, text)
      }
      prevSessionIdRef.current = sessionId
      setText(getDraft(sessionId))
      setAttachments([])
      setFiles([])
      setDrawerOpen(false)
      setAttachError(null)
      setAtToken(null)
      setAtDismissedStart(null)
      setFileResults([])
      textareaRef.current?.focus()
      return
    }

    // While staying in the same session, persist current draft so it survives
    // abrupt unmounts (e.g. layout key changes) or navigation.
    if (text.trim() !== '') {
      saveDraft(sessionId, text)
    } else {
      deleteDraft(sessionId)
    }
  }, [sessionId, text])

  // Hydrate queued message from sessionStorage on session switch / F5. The
  // sessionStorage cache survives page refreshes within the same tab (per Q6);
  // `hydrateQueuedMessage` is a no-op if the slot is already populated, so a
  // fresh `enqueueMessage` always wins over stale cache.
  useEffect(() => {
    const cached = readQueuedFromStorageForSession(sessionId)
    if (cached) {
      useChatStore.getState().hydrateQueuedMessage(sessionId, cached)
    }
  }, [sessionId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 18
    const maxHeight = lineHeight * 6
    const next = Math.min(maxHeight, el.scrollHeight)
    el.style.height = `${next}px`
  }, [text])

  const filteredCommands = text.startsWith('/')
    ? commands.filter((c) => c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()))
    : []

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && text.startsWith('/') && !text.includes(' '))
  }, [text, commands])

  // 命令列表长度变化时，钳制高亮索引避免越界；关闭弹窗时复位。
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filteredCommands.length - 1)))
  }, [filteredCommands.length])
  useEffect(() => {
    if (!showCommands) setActiveIndex(0)
  }, [showCommands])

  // 高亮项移出可视区时，滚动到最近可见位置。
  useEffect(() => {
    if (showCommands) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, showCommands])

  // ── @ 文件补全 ──────────────────────────────────────────────
  // 斜杠弹窗优先；Esc 关闭后同一 token（start 不变）不再弹出。
  const showFilePopup =
    atToken !== null && !showCommands && atToken.start !== atDismissedStart

  const updateAtToken = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length
    atCursorRef.current = pos
    const token = findAtToken(el.value, pos)
    setAtToken(token)
    if (token === null) setAtDismissedStart(null)
  }

  const atQuery = showFilePopup && atToken ? atToken.query : null
  useEffect(() => {
    if (atQuery === null) {
      setFileResults([])
      setFileSearching(false)
      return
    }
    setFileSearching(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .searchFilesBySession(sessionId, atQuery)
        .then((entries) => {
          if (cancelled) return
          setFileResults(
            entries
              .filter(
                (e) =>
                  (e.path_type === 'File' || e.path_type === 'SymlinkFile') && e.rel_path,
              )
              .slice(0, MAX_AT_RESULTS),
          )
        })
        .catch(() => {
          if (!cancelled) setFileResults([])
        })
        .finally(() => {
          if (!cancelled) setFileSearching(false)
        })
    }, AT_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [atQuery, sessionId])

  useEffect(() => {
    setFileActiveIndex((i) => Math.min(i, Math.max(0, fileResults.length - 1)))
  }, [fileResults.length])
  useEffect(() => {
    if (!showFilePopup) setFileActiveIndex(0)
  }, [showFilePopup])
  useEffect(() => {
    if (showFilePopup) fileItemRefs.current[fileActiveIndex]?.scrollIntoView({ block: 'nearest' })
  }, [fileActiveIndex, showFilePopup])

  const selectFile = (relPath: string) => {
    if (!atToken) return
    const { text: next, cursor } = replaceAtToken(text, atToken.start, atCursorRef.current, relPath)
    setText(next)
    setAtToken(null)
    const el = textareaRef.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(cursor, cursor))
    }
  }

  const hasAttachments = attachments.length > 0 || files.length > 0
  const canSend = !disabled && !sending && (text.trim().length > 0 || hasAttachments)
  // N=1 约束：队列满时 Queue 按钮 disabled，强制用户先 ✕。
  // 附件只支持 idle 直发（queuedMessage 是纯 string 槽），带附件时禁止入队。
  const canQueue = !disabled && sending && !queuedMessage && text.trim().length > 0 && !hasAttachments
  const previewText = queuedMessage
    ? queuedMessage.length > QUEUE_PREVIEW_CHARS
      ? queuedMessage.slice(0, QUEUE_PREVIEW_CHARS) + '…'
      : queuedMessage
    : ''

  const showAttachError = (message: string) => {
    setAttachError(message)
    if (attachErrorTimerRef.current !== null) window.clearTimeout(attachErrorTimerRef.current)
    attachErrorTimerRef.current = window.setTimeout(() => {
      setAttachError(null)
      attachErrorTimerRef.current = null
    }, 2500)
  }

  useEffect(() => () => {
    if (attachErrorTimerRef.current !== null) window.clearTimeout(attachErrorTimerRef.current)
  }, [])

  const addImageFiles = async (picked: File[]) => {
    if (!imageSupported || disabled || picked.length === 0) return
    for (const file of picked) {
      try {
        const attachment = await processImageFile(file)
        setAttachments((prev) => [...prev, attachment])
      } catch (err) {
        showAttachError(
          err instanceof ImageAttachmentError && err.code === 'read_failed'
            ? t('chat.input.attachReadFailed')
            : t('chat.input.attachUnsupported'),
        )
      }
    }
  }

  // 管道原则：不按 MIME/体积过滤，选中什么就发什么；读取失败只影响该文件本身。
  const addFiles = async (picked: File[]) => {
    if (!fileSupported || disabled || picked.length === 0) return
    for (const file of picked) {
      try {
        const attachment = await processFile(file)
        setFiles((prev) => [...prev, attachment])
      } catch {
        showAttachError(t('chat.input.attachReadFailed'))
      }
    }
  }

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // 打开抽屉前先 blur：移动端收起软键盘（避免 sheet 与键盘争位），桌面端同时
  // 关闭可能开着的斜杠命令 / @ 补全浮层（它们挂在 textarea 的 blur 上）。
  const toggleDrawer = () => {
    hapticTap()
    textareaRef.current?.blur()
    setDrawerOpen((v) => !v)
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imageSupported) return
    const files = extractImageFiles(e.clipboardData.items)
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!imageSupported) return
    const files = extractImageFiles(e.dataTransfer.items)
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!imageSupported) return
    if (Array.from(e.dataTransfer.items).some((item) => item.kind === 'file')) {
      e.preventDefault()
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const doSend = () => {
    onSend(
      text,
      attachments.length > 0 ? attachments : undefined,
      files.length > 0 ? files : undefined,
    )
    setText('')
    setAttachments([])
    setFiles([])
    deleteDraft(sessionId)
    setShowCommands(false)
    setAtToken(null)
  }

  const sendFromEnter = () => {
    // busy + 队列满：Enter 静默 noop（Queue 按钮也 disabled，UI 一致）
    if (sending && queuedMessage) return
    if (canSend || canQueue) {
      doSend()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      // Enter / Tab 选中当前高亮命令（Tab 默认会跳走焦点，这里拦截）。
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[activeIndex]
        if (cmd) selectCommand(cmd)
        return
      }
      if (e.key === 'Escape') {
        setShowCommands(false)
        return
      }
    } else if (showFilePopup) {
      if (e.key === 'Escape') {
        if (atToken) setAtDismissedStart(atToken.start)
        return
      }
      if (fileResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setFileActiveIndex((i) => (i + 1) % fileResults.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setFileActiveIndex((i) => (i - 1 + fileResults.length) % fileResults.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const entry = fileResults[fileActiveIndex]
          if (entry?.rel_path) selectFile(entry.rel_path)
          return
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // 无匹配结果时 Enter 走正常发送，不困住用户
        e.preventDefault()
        sendFromEnter()
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendFromEnter()
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    setText('/' + cmd.name + ' ')
    setShowCommands(false)
    textareaRef.current?.focus()
  }

  const handleClickSend = () => {
    if (!canSend) return
    doSend()
    textareaRef.current?.focus()
  }

  const handleClickQueue = () => {
    if (!canQueue) return
    doSend()
    textareaRef.current?.focus()
  }

  // Edit: 把队列里的文本回填到 textarea，然后撤回队列。用户看到 chip 消失、
  // 文本出现在输入框，可继续编辑后 send（idle）或 queue（busy）。
  const handleClickEditQueued = () => {
    if (!queuedMessage) return
    setText(queuedMessage)
    setShowCommands(false)
    onCancelQueued()
    textareaRef.current?.focus()
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    resize: 'none',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    padding: '8px 10px',
    fontFamily: READER_FONT,
    fontSize: 13,
    lineHeight: '18px',
    outline: 'none',
    overflowY: 'auto',
    minHeight: INPUT_ROW_HEIGHT,
  }

  const buttonBase: React.CSSProperties = {
    border: 'none',
    borderRadius: 0,
    padding: '0 12px',
    height: INPUT_ROW_HEIGHT,
    fontFamily: READER_FONT,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        padding: '8px 12px',
      }}
    >
      {attachError && (
        <div
          style={{
            marginBottom: 6,
            padding: '4px 8px',
            fontFamily: READER_FONT,
            fontSize: 11,
            color: 'var(--danger, #FF7B72)',
          }}
        >
          {attachError}
        </div>
      )}
      {attachments.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
        >
          {attachments.map((att) => (
            <div
              key={att.id}
              style={{
                position: 'relative',
                width: 56,
                height: 56,
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                overflow: 'hidden',
                background: 'var(--bg-elevated)',
                flexShrink: 0,
              }}
            >
              <img
                src={imageSrc(att)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              <button
                onClick={() => removeAttachment(att.id)}
                title={t('chat.input.attachRemove')}
                aria-label={t('chat.input.attachRemove')}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 16,
                  height: 16,
                  padding: 0,
                  border: 'none',
                  borderRadius: 2,
                  background: 'rgba(0,0,0,0.6)',
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '16px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
        >
          {files.map((f) => (
            <div
              key={f.id}
              title={f.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 240,
                height: 32,
                padding: '0 4px 0 8px',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                background: 'var(--bg-elevated)',
                fontFamily: READER_FONT,
                fontSize: 12,
                color: 'var(--text-primary)',
                flexShrink: 0,
              }}
            >
              <IconFile
                width={14}
                height={14}
                style={{ flexShrink: 0, color: 'var(--text-faint)' }}
              />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {f.name}
              </span>
              <span style={{ color: 'var(--text-faint)', fontSize: 10, flexShrink: 0 }}>
                {formatFileSize(f.size)}
              </span>
              <button
                onClick={() => removeFile(f.id)}
                title={t('chat.input.attachRemoveFile')}
                aria-label={t('chat.input.attachRemoveFile')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-faint)',
                  cursor: 'pointer',
                  padding: '0 4px',
                  height: '100%',
                  fontSize: 12,
                  lineHeight: 1,
                  fontFamily: 'inherit',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger, #FF7B72)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {queuedMessage && (
        <div
          className="chat-queue-chip"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 6,
            padding: '4px 8px',
            background: 'var(--accent-14)',
            border: '1px solid var(--accent)',
            borderLeft: '2px solid var(--accent)',
            borderRadius: 4,
            fontFamily: READER_FONT,
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          <span
            style={{
              color: 'var(--accent)',
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: '0.08em',
              flexShrink: 0,
            }}
          >
            {t('chat.input.queueNext')}
          </span>
          <span
            title={queuedMessage}
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {previewText}
          </span>
          <button
            onClick={onSendNow}
            title={t('chat.input.queueSendNow')}
            aria-label={t('chat.input.queueSendNow')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-faint)',
              cursor: 'pointer',
              padding: '0 4px',
              fontSize: 12,
              lineHeight: 1,
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
          >
            ▶
          </button>
          <button
            onClick={handleClickEditQueued}
            title={t('chat.input.queueEdit')}
            aria-label={t('chat.input.queueEdit')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-faint)',
              cursor: 'pointer',
              padding: '0 4px',
              fontSize: 12,
              lineHeight: 1,
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
          >
            ✎
          </button>
          <button
            onClick={onCancelQueued}
            title={t('chat.input.queueWithdraw')}
            aria-label={t('chat.input.queueWithdraw')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-faint)',
              cursor: 'pointer',
              padding: '0 4px',
              fontSize: 14,
              lineHeight: 1,
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger, #FF7B72)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)' }}
          >
            ✕
          </button>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          position: 'relative',
        }}
      >
        {showCommands && (
          <OverlayScroll
            className="pixel-float"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              background: 'var(--bg-elevated)',
              zIndex: 10,
            }}
            contentStyle={{ flex: '0 0 auto', maxHeight: 160 }}
          >
            {filteredCommands.map((cmd, index) => {
              const isActive = index === activeIndex
              return (
                <button
                  key={cmd.name}
                  ref={(el) => { itemRefs.current[index] = el }}
                  onClick={() => selectCommand(cmd)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    background: isActive ? 'var(--accent-14)' : 'none',
                    border: 'none',
                    color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                    fontFamily: READER_FONT,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'var(--bg-surface)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isActive ? 'var(--accent-14)' : 'none'
                  }}
                >
                  <span style={{ flexShrink: 0 }}>/{cmd.name}</span>
                  {cmd.description && (
                    <span
                      style={{
                        color: isActive ? 'var(--accent)' : 'var(--text-faint)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cmd.description}
                    </span>
                  )}
                </button>
              )
            })}
          </OverlayScroll>
        )}
        {showFilePopup && (fileResults.length > 0 || !fileSearching) && (
          <OverlayScroll
            className="pixel-float"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              background: 'var(--bg-elevated)',
              zIndex: 10,
            }}
            contentStyle={{ flex: '0 0 auto', maxHeight: 160 }}
          >
            {fileResults.length === 0 ? (
              <div
                style={{
                  padding: '6px 12px',
                  fontFamily: READER_FONT,
                  fontSize: 12,
                  color: 'var(--text-faint)',
                }}
              >
                {t('chat.input.atNoResults')}
              </div>
            ) : (
              fileResults.map((f, index) => {
                const isActive = index === fileActiveIndex
                return (
                  <button
                    key={f.rel_path}
                    ref={(el) => { fileItemRefs.current[index] = el }}
                    // 防止点击夺走 textarea 焦点（光标位置用于 token 替换）
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => f.rel_path && selectFile(f.rel_path)}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 12px',
                      background: isActive ? 'var(--accent-14)' : 'none',
                      border: 'none',
                      color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                      fontFamily: READER_FONT,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'var(--bg-surface)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isActive ? 'var(--accent-14)' : 'none'
                    }}
                  >
                    <span style={{ flexShrink: 0 }}>{f.name}</span>
                    <span
                      style={{
                        color: isActive ? 'var(--accent)' : 'var(--text-faint)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {f.rel_path}
                    </span>
                  </button>
                )
              })
            )}
          </OverlayScroll>
        )}
        <textarea
          ref={textareaRef}
          className="overlay-scroll-content"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            updateAtToken(e.currentTarget)
          }}
          onSelect={(e) => updateAtToken(e.currentTarget)}
          onBlur={() => setAtToken(null)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t(isMobile ? 'chat.input.placeholderMobile' : 'chat.input.placeholder')}
          disabled={disabled}
          rows={1}
          style={{
            ...inputStyle,
            opacity: disabled ? 0.6 : 1,
          }}
        />
        {(imageSupported || fileSupported) && (
          <button
            type="button"
            data-toggle="chat-attach"
            onClick={toggleDrawer}
            disabled={disabled}
            className="pixel-press"
            title={t('chat.input.attachOpen')}
            aria-label={t('chat.input.attachOpen')}
            aria-expanded={drawerOpen}
            style={{
              ...buttonBase,
              width: INPUT_ROW_HEIGHT,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: drawerOpen ? 'var(--accent)' : 'var(--bg-elevated)',
              color: drawerOpen ? '#fff' : 'var(--text-primary)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            <IconPlus width={16} height={16} />
          </button>
        )}
        {sending ? (
          <>
            <button
              onClick={onCancel}
              className="pixel-press"
              style={{
                ...buttonBase,
                background: 'var(--danger, #FF7B72)',
                color: '#fff',
              }}
            >
              {t('chat.input.cancel')}
            </button>
            <button
              onClick={handleClickQueue}
              disabled={!canQueue}
              className="pixel-press"
              title={
                queuedMessage
                  ? t('chat.input.queueFullTitle')
                  : hasAttachments
                    ? t('chat.input.attachNoQueue')
                    : !text.trim()
                      ? t('chat.input.queueEmptyTitle')
                      : t('chat.input.queueTitle')
              }
              style={{
                ...buttonBase,
                background: canQueue ? 'var(--accent)' : 'var(--bg-elevated)',
                color: canQueue ? '#fff' : 'var(--text-faint)',
                cursor: canQueue ? 'pointer' : 'not-allowed',
              }}
            >
              {t('chat.input.queue')}
            </button>
          </>
        ) : (
          <button
            onClick={handleClickSend}
            disabled={!canSend}
            className="pixel-press"
            style={{
              ...buttonBase,
              background: canSend ? 'var(--accent)' : 'var(--bg-elevated)',
              color: canSend ? '#fff' : 'var(--text-faint)',
              cursor: canSend ? 'pointer' : 'not-allowed',
            }}
          >
            {t('chat.input.send')}
          </button>
        )}
      </div>
      {/* 隐藏的系统选择器：相册（image/*）与文件（任意类型）。离屏而非 `display:none`
          ——部分移动端浏览器不允许对 display:none 的 input 触发程序化 click()。 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void addImageFiles(Array.from(e.target.files ?? []))
          // 清空 value：同一文件再次选中也要触发 change。
          e.target.value = ''
        }}
        style={HIDDEN_INPUT_STYLE}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
        style={HIDDEN_INPUT_STYLE}
      />
      {drawerOpen && (
        <ChatAttachDrawer
          onClose={closeDrawer}
          onSelectAlbum={() => imageInputRef.current?.click()}
          onSelectFile={() => fileInputRef.current?.click()}
          albumSupported={imageSupported}
          fileSupported={fileSupported}
        />
      )}
    </div>
  )
}
