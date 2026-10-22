import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { ConfigOption } from '../stores/chatStore'

interface ChatShortcutContext {
  configOptions: ConfigOption[]
  setConfigOption: (configId: string, value: string) => void
  /** Ctrl/Cmd+F：打开会话内搜索（F06，计划 D11）。 */
  onSearch?: () => void
  /**
   * 聊天面板根容器（判定「键盘事件是否落在会话内」用）。
   *
   * Ctrl+F 绑在 **document 冒泡阶段**而不是面板容器上：消息区不可聚焦、只读
   * 会话的输入框是 `disabled`，这两种情况下键盘事件的目标是 `body`——绑在容器
   * 上根本收不到（实测：焦点在输入框/消息区都收不到）。挂在 document 才能覆盖
   * 「用户在读历史、焦点哪儿都没落」这个最常见的使用姿态。
   *
   * 冒泡阶段还带来一个好处：**有自己 Ctrl+F 的面板（文件编辑器 `FileEditor.tsx`）
   * 在捕获阶段 `stopPropagation`**，事件到不了 document —— 它们的 Ctrl+F
   * 不受影响（编辑器里仍是「编辑器内查找」）。
   */
  rootRef?: RefObject<HTMLElement | null>
}

/**
 * ACP 会话窗口的键盘快捷键集中管理。
 *
 * 两类快捷键分两种绑法：
 * - **面板内作用域**（Shift+Tab 切 mode 等）：handler 绑在 ChatView 根容器上——
 *   仅当用户焦点落在会话窗口内（输入框、按钮、消息区等）时事件才会冒泡到此处，
 *   天然满足「聚焦在会话窗口」的前提，不会全局拦截。
 * - **document 冒泡阶段**（Ctrl/Cmd+F）：见 [`ChatShortcutContext.rootRef`] 的
 *   说明——面板容器收不到「焦点没落在任何控件上」的那部分事件。
 *
 * 新增快捷键：在下方 switch 中追加分支即可，每支写明触发条件与动作意图，
 * 切勿再把快捷键逻辑散落到组件 JSX 中。
 */
export function useChatShortcuts({
  configOptions,
  setConfigOption,
  onSearch,
  rootRef,
}: ChatShortcutContext) {
  // 回调存 ref：document 监听器只注册一次，不随父组件重渲染反复挂卸。
  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      const target = e.target as globalThis.Node | null
      const root = rootRef?.current
      const inChat = !!root && !!target && root.contains(target)
      // 焦点在别的控件上（终端、侧栏输入框、其它面板）→ 不接管，浏览器原生查找照旧。
      const active = document.activeElement
      const focusedElsewhere =
        !!active && active !== document.body && active !== document.documentElement
      if (!inChat && focusedElsewhere) return
      e.preventDefault()
      onSearchRef.current?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [rootRef])

  return useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Shift+Tab —— 循环切换会话 mode（category === 'mode' 的配置项）。
      // 无 mode 配置或仅一种 mode 时不拦截，保留原生 Tab 焦点导航。
      if (e.shiftKey && e.key === 'Tab') {
        const modeOption = configOptions.find((o) => o.category === 'mode')
        if (modeOption && modeOption.options.length >= 2) {
          e.preventDefault()
          const idx = modeOption.options.findIndex((o) => o.value === modeOption.currentValue)
          const next = modeOption.options[(idx + 1) % modeOption.options.length]
          setConfigOption(modeOption.id, next.value)
        }
      }
    },
    [configOptions, setConfigOption],
  )
}
