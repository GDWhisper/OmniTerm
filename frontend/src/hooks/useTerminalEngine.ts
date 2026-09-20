import { useAppStore } from '../stores/appStore'
import { resolveTerminalEngine, type TerminalEngine } from '../utils/terminalEngine'

/**
 * 当前应使用的终端引擎：设置里的默认引擎按宿主复用器可用性收敛后的实际值。
 *
 * 「在此打开终端」这类快捷入口没有点选环节，期望引擎直接来自默认值，又必须
 * 和创建会话弹窗一样在宿主缺 tmux 时回落 pty——两处判定同一真源（见
 * `utils/terminalEngine.ts`），勿各自读 `multiplexerAvailable`。
 */
export function useTerminalEngine(): TerminalEngine {
  const pref = useAppStore((s) => s.defaultTerminalEngine)
  const multiplexerAvailable = useAppStore((s) => s.multiplexerAvailable)
  return resolveTerminalEngine(pref, multiplexerAvailable)
}
