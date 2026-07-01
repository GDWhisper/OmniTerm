/** Shared constants for sidebar bottom-bar popup panels.
 *  Both desktop popups (Settings, TmuxCheatsheet) and their mobile
 *  bottom-sheet counterparts use the same layout anchors.
 */

/** Gap between popup and trigger button / viewport edges */
export const GAP = 8

/** Mobile bottom nav bar height:
 *  padding(6px × 2) + nav pill padding(5px × 2) + button(32px) */
export const MOBILE_NAV_HEIGHT = 54

/** Desktop sidebar bottom status bar — reused on mobile as the gap
 *  between the MobileNav and the popup's bottom edge.
 *  padding(12px × 2) + button(26px) */
export const SIDEBAR_BOTTOM_BAR_HEIGHT = 50

/** Mobile status bar height at the viewport top (padding 30px).
 *  Added via `+ 30` in maxHeight calcs so the popup doesn't overlap it. */
export const MOBILE_STATUS_BAR_RESERVE = 30
