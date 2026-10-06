/**
 * 文件预览链路的共享件：扩展名分类、下载端点 URL、相对引用解析、刷新去抖与渲染上限。
 * FileDrawer / FilePreview / MarkdownPreview / HtmlPreview 四处共用，避免端点字符串和策略常量各写一份。
 */

import { getParentPath } from '../../utils/path'

/**
 * 预览刷新去抖：agent 连续写同一文件时 SSE 会连发事件，合并成一次请求 + 一次全量重解析。
 * 图片路径早已用 500ms（历史值），文本/渲染预览现在共用同一个常量。
 */
export const FILE_REFRESH_DEBOUNCE_MS = 500

/**
 * markdown 渲染的行数上限，超限退回 CodeMirror 源码视图。
 * 依据：react-markdown 无虚拟滚动，整篇同步解析 + 全量建 DOM，实测 ~0.1ms/字符
 * （1738 行 ≈ 180ms）；3000 行约 300ms 阻塞，再往上「打开即顿」开始明显。
 * 与 CodeMirror（只渲染视口）不同，这里是全量，故需要一个上限。
 */
export const MAX_MARKDOWN_PREVIEW_LINES = 3000

/** 支持预览的图片扩展名 */
export const IMAGE_EXTS: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, svg: true, webp: true, bmp: true, ico: true }

/** 按 markdown 渲染的扩展名 —— 与 FileEditor 的 langLoaders 口径保持一致 */
export const MARKDOWN_EXTS: Record<string, true> = { md: true, markdown: true }

/** 走渲染预览（sandboxed iframe）的扩展名 */
export const HTML_EXTS: Record<string, true> = { html: true, htm: true }

/**
 * HTML 渲染预览的字节上限。DOMParser 改写 + innerHTML 序列化会把整篇文档
 * 在内存里复制一份，srcdoc 再复制一份，超限直接退回源码视图（见
 * shouldRenderHtml）。上限维度取字节而非行数：单行可以无限长的压缩产物
 * 同样能撑爆渲染（§P1 上限维度必须匹配真实增长维度）。
 */
export const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024

/**
 * 是否目录（含软链接目录）。`FileEntry.path_type` 的目录判据在全文件有 5 处
 * 使用者（FileManager 表格 / drag / 键盘 / canInlineEdit / isDir 判定），
 * 故收敛到此处作单一真源，勿再各处字面量写法。
 */
export function isDirEntry(pathType: string): boolean {
  return pathType === 'Dir' || pathType === 'SymlinkDir'
}

/**
 * 行内编辑入口的字节上限。CodeMirror 一次性把全文载入内存并建装饰树，
 * 大文件会明显卡顿（与 MAX_MARKDOWN_PREVIEW_LINES 同一类「入口侧容量」判据）。
 * 注意这不影响后端写入口：`write_file` 与上传共用 ≈200MiB body limit。
 * 取 1MiB 覆盖绝大多数配置文件/脚本，超过的建议用终端编辑器。
 */
export const MAX_INLINE_EDIT_BYTES = 1024 * 1024

/**
 * 该文件是否**提供**行内编辑入口（FileManager 行内按钮的显隐判据）。
 * 目录一律不给：其 `size` 语义是条目数而非字节，没有「内容」可编辑
 * （调用方若想区分「不给入口」与「给了但禁用」，用 [`isDirEntry`] 判）。
 */
export function canInlineEdit(size: number | null, pathType: string): boolean {
  if (isDirEntry(pathType)) return false
  // size 未知时放行：与「非文本由后端探测」同一保守取向，
  // 真不能编辑时由 FileDrawer 兜底提示，不在入口处预先拒绝。
  return size === null || size <= MAX_INLINE_EDIT_BYTES
}

export function getExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || ''
}

export function isImageFile(fileName: string): boolean {
  return Object.hasOwn(IMAGE_EXTS, getExtension(fileName))
}

export function isMarkdownFile(fileName: string): boolean {
  return Object.hasOwn(MARKDOWN_EXTS, getExtension(fileName))
}

export function isHtmlFile(fileName: string): boolean {
  return Object.hasOwn(HTML_EXTS, getExtension(fileName))
}

/** 行数（与状态栏口径一致：按 \n 计数，尾随换行算作多一行） */
export function countLines(text: string): number {
  return text.split('\n').length
}

/** 是否走 markdown 渲染视图：扩展名匹配且未超渲染上限 */
export function shouldRenderMarkdown(fileName: string, content: string): boolean {
  return isMarkdownFile(fileName) && countLines(content) <= MAX_MARKDOWN_PREVIEW_LINES
}

/**
 * 是否走 HTML 渲染视图（view 模式下的 iframe 预览）：扩展名匹配且未超字节上限。
 * 上限判据用字节而非行数——压缩/打包产物可以单行无限长（§P1）。
 */
export function shouldRenderHtml(fileName: string, content: string): boolean {
  return isHtmlFile(fileName) && countUtf8Bytes(content) <= MAX_HTML_PREVIEW_BYTES
}

/** UTF-8 字节数（与 FileDrawer 状态栏 byteSize 同一口径） */
function countUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** iframe srcdoc 里要改写的 URL 属性。srcset 刻意不收：多候选语法解析成本高于收益，生成的页面极少用 */
const HTML_URL_ATTRS = ['src', 'href'] as const

/**
 * 把本地 HTML 改写成可直接进 sandboxed iframe srcdoc 的形式：
 *
 * - 相对引用（`./app.css`、`img/a.png`、`main.js`）解析成绝对文件路径，
 *   换成 `/api/v1/files/download` 的 **inline 模式** URL（`inline=1`：
 *   真实 MIME、无 attachment）——srcdoc 没有自己的 base URL，相对引用会
 *   打到 OmniTerm 自己的路由上 404；而附件模式下浏览器按 MIME 拒载
 *   css/js（图片预览走同一端点不踩坑是因为浏览器对图片嗅探 MIME）。
 * - `<base href>` 一律剥掉：它会改变整篇文档的相对解析基准，
 *   与改写后的绝对 URL 语义冲突，也给了内容作者把引用指向站外的口子。
 * - 外链（http/https/mailto）、协议相对 `//`、锚点、绝对路径引用不碰
 *   （判据复用 resolveRelativeRef 的保守语义）。
 *
 * 安全边界由调用方保证：渲染方必须带 `sandbox="allow-scripts"`
 * （**不给 allow-same-origin**），内容因此跑在 opaque origin，
 * 读不到 OmniTerm 的 localStorage / cookie / DOM。
 */
export function rewriteHtmlForPreview(html: string, filePath: string, scope: FileScope): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const baseDir = getParentPath(filePath)
  doc.querySelectorAll('base').forEach((el) => el.remove())
  doc.querySelectorAll<HTMLElement>('[src],[href]').forEach((el) => {
    for (const attr of HTML_URL_ATTRS) {
      const raw = el.getAttribute(attr)
      if (!raw) continue
      const abs = resolveRelativeRef(baseDir, raw)
      if (abs) el.setAttribute(attr, buildFileInlineUrl(abs, scope))
    }
  })
  // DOMParser 序列化会丢 doctype，缺了进 quirks mode，布局/盒模型都变；
  // 补回来保证预览与浏览器直接打开一致。
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

/** 文件读取/下载所归属的 API 作用域（session 模式优先，否则 workspace 模式） */
export interface FileScope {
  sessionId?: string
  workspaceId?: string
  projectId?: string | null
}

/**
 * 构造 `/api/v1/files/download` 的绝对 URL（图片预览与 markdown 内嵌图片共用）。
 * `version` 是 cache-bust 版本号，外部变更后自增让浏览器绕开缓存。
 */
export function buildFileDownloadUrl(filePath: string, scope: FileScope, version = 0): string {
  const encoded = encodeURIComponent(filePath)
  return scope.sessionId
    ? `/api/v1/files/download?session=${scope.sessionId}&path=${encoded}&v=${version}`
    : `/api/v1/files/download?workspace_id=${scope.workspaceId}&workspace=${scope.projectId}&path=${encoded}&v=${version}`
}

/**
 * 构造 inline 模式的下载 URL（同一端点加 `inline=1`）：真实 MIME、
 * 无 `Content-Disposition: attachment`。html 预览的 iframe 子资源
 * （css/js/字体）必须走这个——附件模式下浏览器按 MIME 拒载样式表与脚本
 * （图片因嗅探仍可用，故图片/markdown 预览沿用 buildFileDownloadUrl）。
 */
export function buildFileInlineUrl(filePath: string, scope: FileScope, version = 0): string {
  return `${buildFileDownloadUrl(filePath, scope, version)}&inline=true`
}

/**
 * 把 markdown 内的相对引用（`./img.png`、`docs/x.md`、`a%20b.md`）解析成绝对文件路径。
 *
 * 返回 `null` 表示**不要重写**，交给默认行为（外链开新标签 / 锚点原生滚动）。刻意保守：
 * - 带 scheme（`http:`、`mailto:`…）或协议相对 `//` → null
 * - 锚点 `#…` → null（由 heading id 原生跳转处理）
 * - 文件系统绝对路径 `/…`、`C:/…` → null（语义歧义：文档作者可能指仓库根，也可能指
 *   真实的 FS 根；猜错的代价是读到无关文件，不如不解析）
 * - 含 `..` 段 → null。**不在前端折叠 `..`**：与 `utils/path.ts` 的 `toAbsolutePath`
 *   同一原则（前端不产出与后端不一致的第二份路径事实）。而且读端点没有兜底 ——
 *   `src/api/files.rs` 的 `read_file` / `download_file` 在 path 为绝对路径时直接
 *   `fs::read_text_file(path)` 绕过 sanitize（实测 `/files/download?workspace=id&path=/…/../../../etc/passwd`
 *   返回 passwd 内容；绝对路径不设边界是文件浏览器跨 worktree 浏览的既定行为）。
 *   折叠 `..` 等于把仓库外的文件渲染进预览或让抽屉跳过去，没有第二道防线，
 *   所以这类引用预览里点不开即可，不算缺陷。
 *
 * query / fragment 对本地文件无意义，剥掉；`%XX` 需解码后才能作为 path 参数传下去。
 */
export function resolveRelativeRef(baseDir: string, ref: string): string | null {
  const raw = ref.trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return null

  const clean = stripQueryAndFragment(raw)
  if (!clean) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    // 畸形百分号编码：保持原样不解析，避免抛错打断整篇渲染
    return null
  }

  const segments = decoded.split('/')
  if (segments.includes('..')) return null

  const rel = decoded.replace(/^\.\//, '')
  const dir = baseDir.endsWith('/') ? baseDir.slice(0, -1) : baseDir
  return dir ? `${dir}/${rel}` : `/${rel}`
}

/**
 * 标题 → 锚点 id，贴近 GitHub 的规则：转小写、剥掉非「字母/数字/空白/-/_」字符、
 * 空白折叠成单个 `-`、首尾去 `-` 与空白。保留 CJK（本仓库文档标题多为中文）。
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function stripQueryAndFragment(ref: string): string {
  const hashIdx = ref.indexOf('#')
  const qIdx = ref.indexOf('?')
  const cuts = [hashIdx, qIdx].filter((i) => i >= 0)
  if (cuts.length === 0) return ref
  return ref.slice(0, Math.min(...cuts))
}
