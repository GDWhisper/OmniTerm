/**
 * 统一剪贴板复制入口（D1）。
 *
 * 优先 `navigator.clipboard.writeText`（异步 API，安全上下文可用）；缺失或抛错
 * 时回退隐藏 textarea + `document.execCommand('copy')`（裸 http / 旧浏览器）。
 *
 * 本 util 不依赖 i18n / toast store：成功/失败文案由调用方决定（FileManager 与
 * chat 的文案不同），也避免把纯工具绑到全局 store。
 *
 * @returns 复制是否成功；两条路径都失败时返回 `false`（调用方负责 toast 提示，
 *   不静默）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false
  if (text === '') return true

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒或写入失败 → 继续尝试 execCommand 兜底
    }
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    // 避免聚焦时页面滚动到该元素
    ta.style.top = '0'
    ta.style.left = '0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
