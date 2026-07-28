import { useCallback } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConfigOption } from '../stores/chatStore'

interface ChatShortcutContext {
  configOptions: ConfigOption[]
  setConfigOption: (configId: string, value: string) => void
}

/**
 * ACP 会话窗口的键盘快捷键集中管理。
 *
 * 返回的 handler 绑定在 ChatView 根容器上 —— 仅当用户焦点落在会话窗口
 * 内（输入框、按钮、消息区等）时事件才会冒泡到此处，天然满足「聚焦在
 * 会话窗口」的前提，不会全局拦截。
 *
 * 新增快捷键：在下方 switch 中追加分支即可，每支写明触发条件与动作意图，
 * 切勿再把快捷键逻辑散落到组件 JSX 中。
 */
export function useChatShortcuts({ configOptions, setConfigOption }: ChatShortcutContext) {
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
