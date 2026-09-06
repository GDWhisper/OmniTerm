/** 文件管理器面板最小宽度（拖拽钳制下界，与侧栏 MIN_SIDEBAR_WIDTH 无关） */
export const MIN_FILE_MANAGER_WIDTH = 240

/**
 * 文件管理器宽度钳制：[MIN_FILE_MANAGER_WIDTH, innerWidth / 2]。
 *
 * 布局里的竖向拖拽条（Layout）与 DRAWER 左上角角标（DrawerShell）共用这一
 * 真源，避免两处各写一份上下界而漂移。
 */
export function clampFileManagerWidth(width: number): number {
  return Math.max(MIN_FILE_MANAGER_WIDTH, Math.min(Math.floor(window.innerWidth / 2), width))
}
