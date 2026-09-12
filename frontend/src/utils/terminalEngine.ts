/**
 * 终端引擎偏好的单一真源。
 *
 * 「默认引擎」是一个值、两处消费：创建会话弹窗的初始高亮，与文件管理器
 * 「在此打开终端」。用户可在设置 → 终端里显式改它，创建成功后也按所用引擎
 * 更新它（沿用原「记住上次引擎」的体验）——因此不存在「记忆 vs 设置」两条
 * 优先级链，也就不会出现弹窗开 tmux、FM 开 pty 的分裂。
 *
 * tmux 仍是 beta 期的 pty 的反面：pty 在宿主缺复用器时是唯一选择，故所有
 * 消费点必须走 `resolveTerminalEngine` 收敛回落，勿各自判 `multiplexerAvailable`。
 */

export type TerminalEngine = 'pty' | 'tmux'

/** 可选项，数组顺序即展示顺序：稳定实现 tmux 在前，beta 期的 pty 居后
 *  （设置面板由本数组驱动，创建会话弹窗的卡片位序与之保持一致）。 */
export const TERMINAL_ENGINES: TerminalEngine[] = ['tmux', 'pty']

/** pty 仍在 beta 期，稳定实现 tmux 兜底。 */
export const DEFAULT_TERMINAL_ENGINE: TerminalEngine = 'tmux'

/** 默认引擎存档键。 */
export const ENGINE_PREF_STORAGE_KEY = 'omniterm_default_terminal_engine'

/**
 * 旧键（2026-08-28 的「上次创建的引擎」记忆）——默认引擎设置收编该语义后
 * 只作一次性迁移读取源，新值恒写 `ENGINE_PREF_STORAGE_KEY`。
 */
const LEGACY_ENGINE_STORAGE_KEY = 'omniterm_last_terminal_engine'

/** 严格白名单：存档值损坏时回落 null，绝不把脏值当引擎提交。 */
export function parseTerminalEngine(raw: string | null): TerminalEngine | null {
  return raw === 'pty' || raw === 'tmux' ? raw : null
}

/**
 * 读取默认引擎：新键 > 旧「上次使用」键 > `DEFAULT_TERMINAL_ENGINE`。
 * 两个键都做过白名单校验，任一命中非法值即视为未命中继续回落。
 */
export function readTerminalEnginePref(storage: Storage = localStorage): TerminalEngine {
  return (
    parseTerminalEngine(storage.getItem(ENGINE_PREF_STORAGE_KEY)) ??
    parseTerminalEngine(storage.getItem(LEGACY_ENGINE_STORAGE_KEY)) ??
    DEFAULT_TERMINAL_ENGINE
  )
}

/**
 * 把「期望引擎」收敛为该宿主实际可用的引擎：宿主探测无复用器时 tmux 不可兑现，
 * 回落 pty（pty 无外部依赖，恒可用）。
 */
export function resolveTerminalEngine(
  preferred: TerminalEngine,
  multiplexerAvailable: boolean,
): TerminalEngine {
  return preferred === 'tmux' && !multiplexerAvailable ? 'pty' : preferred
}

/** 引擎展示名（i18n）。设置面板、创建会话弹窗与 FM「在此打开终端」的弹窗共用，
 *  勿再各写一份 `sessionTypeTmuxLabel`/`sessionTypePtyLabel` 三元映射。 */
export function terminalEngineLabel(
  engine: TerminalEngine,
  t: (key: string) => string,
): string {
  return t(engine === 'tmux' ? 'sidebar.sessionTypeTmuxLabel' : 'sidebar.sessionTypePtyLabel')
}
