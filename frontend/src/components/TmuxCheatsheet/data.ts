/**
 * tmux cheatsheet — single source of truth.
 *
 * ── Agent 维护指引 / Maintenance guide ──
 *   1. 改/加/删命令 → 改本文件的 `SECTIONS` 数组
 *   2. 同步更新两个 locale 文件：
 *        - frontend/src/locales/en/translation.json
 *        - frontend/src/locales/zh/translation.json
 *   3. `cmd` 字段保留为英文字符串 (tmux 原生键, ASCII)。
 *      如需多语言本地化按键 (例如中文显示「Ctrl+b 然后 d」), 需把 cmd 也搬进 i18n。
 *
 *   To add/change a command: edit the `SECTIONS` array below, then update
 *   the matching i18n keys in both `frontend/src/locales/{en,zh}/translation.json`.
 *
 *   Kept as typed TS (not JSON) so the compiler catches missing keys
 *   and shape mismatches when items are added or renamed.
 */

export interface CheatsheetItem {
  /** i18n key for the human description (must exist in both en + zh locales) */
  labelKey: string
  /** The command / shortcut itself, displayed as monospace code */
  cmd: string
}

export interface CheatsheetSection {
  /** i18n key for the section heading (must exist in both en + zh locales) */
  titleKey: string
  items: CheatsheetItem[]
  /** Optional i18n key for a hint paragraph below the section */
  hintKey?: string
}

export const SECTIONS: CheatsheetSection[] = [
  {
    titleKey: 'tmuxCheatsheet.sessions',
    items: [
      { labelKey: 'tmuxCheatsheet.newSession', cmd: 'tmux new -s <name>' },
      { labelKey: 'tmuxCheatsheet.listSessions', cmd: 'tmux ls' },
      { labelKey: 'tmuxCheatsheet.attachSession', cmd: 'tmux attach -t <name>' },
      { labelKey: 'tmuxCheatsheet.detach', cmd: 'Prefix + d' },
      { labelKey: 'tmuxCheatsheet.sessionChooser', cmd: 'Prefix + s' },
    ],
  },
  {
    titleKey: 'tmuxCheatsheet.windows',
    items: [
      { labelKey: 'tmuxCheatsheet.newWindow', cmd: 'Prefix + c' },
      { labelKey: 'tmuxCheatsheet.nextWindow', cmd: 'Prefix + n' },
      { labelKey: 'tmuxCheatsheet.prevWindow', cmd: 'Prefix + p' },
      { labelKey: 'tmuxCheatsheet.gotoWindow', cmd: 'Prefix + 0–9' },
      { labelKey: 'tmuxCheatsheet.closeWindow', cmd: 'Prefix + &' },
    ],
  },
  {
    titleKey: 'tmuxCheatsheet.panes',
    items: [
      { labelKey: 'tmuxCheatsheet.splitVertical', cmd: 'Prefix + %' },
      { labelKey: 'tmuxCheatsheet.splitHorizontal', cmd: 'Prefix + "' },
      { labelKey: 'tmuxCheatsheet.focusPane', cmd: 'Prefix + ←↑↓→' },
      { labelKey: 'tmuxCheatsheet.closePane', cmd: 'Prefix + x' },
      { labelKey: 'tmuxCheatsheet.zoomPane', cmd: 'Prefix + z' },
    ],
  },
  {
    titleKey: 'tmuxCheatsheet.copyMode',
    items: [
      { labelKey: 'tmuxCheatsheet.enterCopy', cmd: 'Prefix + [' },
      { labelKey: 'tmuxCheatsheet.quitCopy', cmd: 'q' },
    ],
    hintKey: 'tmuxCheatsheet.copyHint',
  },
]
