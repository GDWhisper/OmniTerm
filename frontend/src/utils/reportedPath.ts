import { useAppStore } from '../stores/appStore'
import { looksLikeDirectory } from './path'

/**
 * 把 agent / 消息里出现的路径在右侧文件管理器中展示出来。
 *
 * 目录（`looksLikeDirectory`）→ FM 切 `mode:'manual'` 浏览该目录；
 * 文件 → 在抽屉里只读打开。判定失败时（无 activeSessionId）静默返回。
 *
 * **为什么抽这里**：聊天气泡的 Markdown 行内代码与 ACP `ToolCallLocation.path`
 * 两条入口都要「getState → 判目录 → reveal」这同四步，是同一判断出现 ≥2 处
 * （AGENTS.md 工程准则 7 信号 ①），判定规则演进时只改这一处。
 *
 * **性能契约**：不订阅 store，调用时才 `getState()`，因此不影响
 * `ChatMessageView` 的 memo 契约与流式期渲染成本。
 */
export function revealReportedPath(rawPath: string): void {
  const { activeSessionId, revealPathInFileManager } = useAppStore.getState()
  if (!activeSessionId) return
  revealPathInFileManager(activeSessionId, rawPath, looksLikeDirectory(rawPath))
}
