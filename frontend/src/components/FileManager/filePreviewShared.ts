/**
 * 文件预览链路的共享件：扩展名分类、下载端点 URL、相对引用解析、刷新去抖与渲染上限。
 * FileDrawer / FilePreview / MarkdownPreview 三处共用，避免端点字符串和策略常量各写一份。
 */

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
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

/** 按 markdown 渲染的扩展名 —— 与 FileEditor 的 langLoaders 口径保持一致 */
export const MARKDOWN_EXTS = new Set(['md', 'markdown'])

export function getExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || ''
}

export function isImageFile(fileName: string): boolean {
  return IMAGE_EXTS.has(getExtension(fileName))
}

export function isMarkdownFile(fileName: string): boolean {
  return MARKDOWN_EXTS.has(getExtension(fileName))
}

/** 行数（与状态栏口径一致：按 \n 计数，尾随换行算作多一行） */
export function countLines(text: string): number {
  return text.split('\n').length
}

/** 是否走 markdown 渲染视图：扩展名匹配且未超渲染上限 */
export function shouldRenderMarkdown(fileName: string, content: string): boolean {
  return isMarkdownFile(fileName) && countLines(content) <= MAX_MARKDOWN_PREVIEW_LINES
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
