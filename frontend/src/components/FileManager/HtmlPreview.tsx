import { useMemo } from 'react'
import { rewriteHtmlForPreview } from './filePreviewShared'

interface HtmlPreviewProps {
  /** 文件全文文本（FileDrawer 已按 is_text 探测过） */
  content: string
  /** 当前 html 的绝对路径 —— 相对引用解析基准 */
  filePath: string
  /** API 作用域（session 模式优先，否则 workspace 模式——与 FilePreview 同一组参数） */
  sessionId?: string
  workspaceId?: string
  projectId?: string | null
}

/**
 * 文件抽屉的 HTML 渲染视图：本地 html 在远程开发机上的唯一直接预览手段
 * （下载端点恒返 Content-Disposition: attachment，浏览器不会内联渲染它；
 *  端口转发代理只对「已在监听的服务」有效，静态文件没有服务可转）。
 *
 * 安全模型（改动前必读，勿删 sandbox）：
 * - srcdoc + `sandbox="allow-scripts"`，**不给 allow-same-origin** ⇒ 文档跑在
 *   opaque origin：读不到 OmniTerm 的 localStorage（含 token）、cookie、DOM，
 *   也发不出同源 XHR/fetch。给 allow-scripts 是因为页面自身的内联/外链脚本
 *   是渲染语义的一部分（agent 生成的对比页常带切换交互）。
 * - subresource 加载（img/link/script src）不受 sandbox 阻断，故相对引用已由
 *   rewriteHtmlForPreview 改写成 download URL，同目录资源才能加载。
 * - 不做「新标签页打开」入口：顶层导航没有 opaque origin 保护，
 *   页面脚本将获得与应用同源的完整权限。
 *
 * 内容刷新由 FileDrawer 的 SSE 去抖链路驱动（重新拉全文 → 新 prop），
 * 本组件不持自己的内容副本。
 */
export function HtmlPreview({ content, filePath, sessionId, workspaceId, projectId }: HtmlPreviewProps) {
  const srcdoc = useMemo(
    () => rewriteHtmlForPreview(content, filePath, { sessionId, workspaceId, projectId }),
    [content, filePath, sessionId, workspaceId, projectId],
  )

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={filePath.split('/').pop() || filePath}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        border: 'none',
        background: 'var(--bg-base)',
      }}
    />
  )
}
