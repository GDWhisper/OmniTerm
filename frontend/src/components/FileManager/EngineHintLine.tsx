import { useTranslation } from 'react-i18next'
import { useTerminalEngine } from '../../hooks/useTerminalEngine'
import { terminalEngineLabel } from '../../utils/terminalEngine'

/**
 * 「引擎：<名>，可在 设置 → 终端 → 默认引擎 中更改」提示行，引擎名用
 * `--text-primary` 提亮（非交互文字的强调约定，accent 只给交互元素）。
 * OpenTerminalDialog（无归属引导）与 OpenTerminalConfirmDialog（有归属确认）
 * 共用，改文案/样式只动本文件与两个 locale 的 enginePrefix/engineSuffix。
 */
export function EngineHintLine() {
  const { t } = useTranslation()
  const terminalEngine = useTerminalEngine()
  return (
    <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
      {t('fm.openTerminalDialog.enginePrefix')}
      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
        {terminalEngineLabel(terminalEngine, t)}
      </span>
      {t('fm.openTerminalDialog.engineSuffix')}
    </p>
  )
}
