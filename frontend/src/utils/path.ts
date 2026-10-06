// frontend/src/utils/path.ts
//
// Pure path utilities. Currently only used by file browsing UIs
// (FileManager, new-project modal) but kept generic for future reuse.

/**
 * Return the parent directory of `path`, or '' if `path` is root or empty.
 *
 * - ''  /  '/'  → '' (root has no parent)
 * - '/a'         → '/'  (first-level dir's parent is the filesystem root, not "nothing")
 * - '/a/b'       → '/a'
 * - '/a/b/'      → '/a'
 * - 'a'          → ''   (bare relative segment has nothing above it)
 * - 'a/b'        → 'a'  (relative paths work too)
 * - 'G:/Codes'   → 'G:/' (Windows drive root stays rooted; bare 'G:' is drive-relative)
 * - 'G:/'        → ''  (drive root has no parent)
 */
export function getParentPath(path: string): string {
  if (!path || path === '/') return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  if (/^[A-Za-z]:$/.test(trimmed)) return ''
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return '' // bare relative segment ('a') has no parent
  // idx === 0 → first-level dir ('/a'); its parent is the filesystem root '/'
  const parent = idx === 0 ? '/' : trimmed.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? parent + '/' : parent
}

/**
 * 拼接目录与条目名为完整路径（文件浏览 UI 的单一真源，勿在组件里再写
 * `dir ? \`${dir}/${name}\` : name`——根目录 '/' 会拼出 '//' 双斜杠）。
 *
 * - `joinPath('/a', 'b')`  → '/a/b'
 * - `joinPath('/', 'b')`   → '/b'（根目录不产生 '//'）
 * - `joinPath('G:/', 'b')` → 'G:/b'
 * - `joinPath('', 'b')`    → 'b'
 */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** POSIX `/…` 或 Windows `C:/…` 视为绝对路径（分隔符已归一为 `/`）。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

/**
 * 把外部报告的文件路径归一为绝对路径，基准为 session 的 workspace root。
 *
 * 用于 ACP `ToolCallLocation.path` 一类 agent 上报的路径：agent 子进程的 OS cwd
 * 就是 session 的 `workspace_path`（后端 spawn 时固定；`src/api/files.rs` 中 ACP
 * session 取 `workspace_path` 作为 FileManager cwd 的注释记录了这一致性），因此
 * 相对路径一律以 workspaceRoot 解析。
 *
 * - 已是绝对路径 → 仅归一分隔符后原样返回（含 Windows 盘符形式）
 * - `./x` / `x` / `a/b` → `<root>/x`
 * - workspaceRoot 缺省（会话无 workspace_path / 尚未加载）→ 无基准可用，原样返回
 *
 * 不解析 `..`、不做越界判断：那是安全决策，权威在后端 `fs::sanitize_path`
 * （canonicalize 后校验前缀），前端解析只会给出与后端不一致的第二份事实。
 */
export function toAbsolutePath(reported: string, workspaceRoot: string | undefined | null): string {
  const path = reported.replace(/\\/g, '/').trim()
  if (!path) return ''
  if (isAbsolutePath(path)) return path
  if (!workspaceRoot) return path
  const root = workspaceRoot.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  const rel = path.replace(/^\.\//, '')
  // root 归一后为空 = workspaceRoot 是文件系统根 '/'
  return root ? `${root}/${rel}` : `/${rel}`
}

/**
 * 判断 `filePath` 是否超出 `workspaceRoot` 边界（用于越界写拦截）。
 *
 * - workspaceRoot 为 undefined/null/空：视为越界（安全默认——project 模式拿不到
 *   workspace_root，宁可每次都确认）。
 * - 路径分隔符边界：用「等于 root 或 root + '/' 前缀」判断，避免 `/home/a`
 *   误匹配 `/home/ab`。
 * - workspaceRoot 尾随斜杠先归一化；root 为 `/`（文件系统根）时任何绝对路径都在内。
 * - Windows 大小写敏感差异忽略（后端有最终防线）。
 */
export function isPathOutsideWorkspace(filePath: string, workspaceRoot: string | undefined | null): boolean {
  if (!workspaceRoot) return true
  const root = workspaceRoot.replace(/\/+$/, '') || '/'
  if (root === '/') return false
  return !(filePath === root || filePath.startsWith(root + '/'))
}

/**
 * 外部改名事件路径还原：drawer 打开文件的绝对路径 `absPath` 以「/ + from（相对 watch 根的
 * 旧路径）」结尾时，前缀即 watch 根，据此把 `to`（相对 watch 根的新路径）还原成新的绝对路径。
 *
 * - 匹配：`resolveRenamedPath('/root/img/a.png', 'img/a.png', 'img/b.png')` → `/root/img/b.png`
 * - 跨目录 move：`resolveRenamedPath('/root/img/a.png', 'img/a.png', 'new/b.png')` → `/root/new/b.png`
 * - 不匹配（rename 与 absPath 无关，如同名文件在别的目录被改名）：返回 `null`
 *
 * 比 basename 匹配更精确：要求目录结构对齐，避免 watch 树内同名文件被改名时误切路径。
 */
export function resolveRenamedPath(absPath: string, from: string, to: string): string | null {
  const suffix = `/${from}`
  if (!absPath.endsWith(suffix)) return null
  const watchRoot = absPath.slice(0, absPath.length - from.length - 1)
  return `${watchRoot}/${to}`
}

/**
 * 在已加载项目中找出路径**覆盖** `dir` 的项目（路径相等或子目录前缀），
 * 多个覆盖时返回最深（路径最长）的一个；无覆盖返回 `undefined`。
 *
 * - 前缀判断带分隔符边界，避免 `/home/a` 误覆盖 `/home/ab`（同
 *   [`isPathOutsideWorkspace`]）；尾随斜杠先归一，`/` 覆盖一切绝对路径。
 * - 仅为前端快路径探测：git worktree 兄弟目录可能不在项目根前缀下，
 *   后端 `POST /projects` 的同仓库覆盖判定（409 already_covered）更权威，
 *   调用方需以其兜底。
 */
export function findCoveringProject<T extends { path: string }>(
  dir: string,
  projects: readonly T[],
): T | undefined {
  let best: T | undefined
  let bestLen = -1
  for (const p of projects) {
    const root = p.path.replace(/\/+$/, '') || '/'
    const covers = root === '/' ? dir.startsWith('/') : dir === root || dir.startsWith(root + '/')
    if (covers && root.length > bestLen) {
      best = p
      bestLen = root.length
    }
  }
  return best
}

/**
 * 在已加载项目中找出根路径与 `dir` **完全相等**的项目（尾随斜杠先归一）。
 * 覆盖判断见 `findCoveringProject`（含子目录）；本函数只答「这个路径本身
 * 是不是某个项目的根」——「在此打开终端」确认弹窗据此判断是否需要
 * 「创建新项目并打开终端」入口：路径已是项目根时，打开终端即挂该项目。
 */
export function findExactProject<T extends { path: string }>(
  dir: string,
  projects: readonly T[],
): T | undefined {
  const target = dir.replace(/\/+$/, '') || '/'
  return projects.find((p) => (p.path.replace(/\/+$/, '') || '/') === target)
}

/**
 * 校验 href 是否为本地文件系统路径，并解析出清洁路径（剥离可选的 :line 或 #L 行号与 query/hash）。
 *
 * 如果是网络协议（http:, https:, ws:, wss:, mailto:, data:, blob:, file: 等）、
 * 协议相对（//）、纯锚点（#hash）或空字符串，则返回 null。
 *
 * 常见 agent 输出格式示例：
 * - `src/main.rs` -> `src/main.rs`
 * - `src/main.rs:24` -> `src/main.rs`
 * - `src/main.rs:24:10` -> `src/main.rs`
 * - `docs/plan.md#L10-L20` -> `docs/plan.md`
 * - `/home/user/repo/a.txt` -> `/home/user/repo/a.txt`
 * - `./a.txt` -> `./a.txt`
 */
export function parseLocalFilePath(href: string | undefined | null): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  // 排除以网络 scheme（http:, mailto: 等）或 // 开头的链接（注意排除 Windows 盘符如 C:/、D:\）
  if (trimmed.startsWith('//')) return null
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(trimmed)
  if (!isWindowsDrive && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

  // 剥离 Markdown 链接末尾可能带有的 #L12 或 #hash
  let path = trimmed.split('#')[0]
  // 剥离可能带有的 ?query
  path = path.split('?')[0]
  if (!path) return null

  // 尝试 decodeURI，以防 react-markdown / URL 对空格及特殊字符做了百分号编码（如 %20）
  try {
    path = decodeURIComponent(path)
  } catch {
    // 畸形编码则使用原串
  }

  // 剥离行号后缀，如 :24 或 :24:10 或 :24-30
  // 注意：Windows 盘符如 C:/ 不应被当作行号误切（: 后必须全为数字或行区间）
  path = path.replace(/:\d+(?::\d+)?(?:-\d+)?$/, '')

  return path.trim() || null
}

/**
 * 行内代码路径识别的上限：超过这个长度的文本不可能是路径（是长段散文/代码）。
 */
const MAX_PATH_HINT_LENGTH = 500
/** 行内代码路径识别允许的最大空格数：真路径几乎不含空格，含多个空格的多是命令行。 */
const MAX_PATH_HINT_SPACES = 3

/** 命令词黑名单：首词命中即判为命令行而非路径（行内代码里 `npm run build` 这类极高频）。 */
const COMMAND_FIRST_WORDS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'git', 'cd', 'ls', 'echo', 'rm', 'mv', 'cp', 'cat',
  'node', 'deno', 'sed', 'awk', 'grep', 'find', 'mkdir', 'touch', 'chmod', 'sudo', 'make', 'docker',
  'python', 'python3', 'pip', 'go', 'rustc', 'java', 'mvn', 'gradle', 'just',
])

/** 合法路径段的字符：拒绝 `const x = a/b`、`array[i]/2`、`sed -i s/a/b/ f` 这类代码片段。 */
const PATH_SEGMENT_CHARS = /^[\w.@+~%^=,-]+$/

/**
 * 已知的项目根下一级目录名。出现在首段时可豁免「末段需含扩展名」的严格要求。
 *
 * **刻意不含 `client` / `server` / `app`** 这类高频英文词：它们会让
 * `client/server`、`app/config` 这类散文组合被误判成路径（假可点击 + 误点弹
 * toast）。代价：`client/` 目录形态不可点，但 `client/main.tsx` 因末段有
 * 扩展名仍可点——只有目录形态受损。
 *
 * **已知假阳性**（白名单方案的固有代价，记录在此以免后人误以为漏修）：
 * 首段命中 + 末段恰好是裸词的组合会双判 true，如 `src/and`、`docs/or`、
 * `docs/read`、`lib/app`、`api/api`、`migrations/0001`。误点后果是
 * `list_files` 对不存在目录报错弹 toast（数据无损、位置可恢复）；收紧到
 * 「末段必须像真实目录名」没有稳定判据，且会损失 `src/utils`、`docs/plans`
 * 这类高频真实目录。若后续要根治，方向是改用后端 `path_type` 做权威判定
 * （`list_files` 已返回，`isDirEntry()` 是 FileManager 侧单一真源）。
 */
const KNOWN_TOP_DIRS = new Set([
  'src', 'docs', 'frontend', 'backend', 'test', 'tests', 'lib', 'libs', 'pkg',
  'packages', 'components', 'utils', 'hooks', 'stores', 'api', 'scripts',
  'migrations', 'dist', 'build', 'public', 'static', 'assets', 'config', 'configs', 'tools',
  'cmd', 'internal', 'crates', 'target', 'node_modules', '.github', '.vscode', 'vendor',
])

/** 常见「无扩展名但确实是文件」的文件名（agent 会在仓库根输出这些，不能当目录）。 */
const EXTENSIONLESS_FILE_NAMES = new Set([
  'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'LICENCE',
  'COPYING', 'NOTICE', 'README', 'CONTRIBUTING', 'CODEOWNERS', 'AUTHORS', 'CHANGELOG', 'TODO',
  'INSTALL', 'NEWS', 'VERSION', 'Procfile', 'Brewfile', 'Gemfile', 'Rakefile', 'Cargo.lock',
  'go.sum', 'poetry.lock', 'yarn.lock', 'package-lock.json', 'requirements.txt',
])

/**
 * 判断一段简短文本（例如行内代码 `...`）是否像一个本地文件或目录路径。
 *
 * 判定从严，宁可漏判也不误判：行内代码被误判成路径会挂上「可打开」的假象
 * （accent 色 + 下划线 + title），误点还会弹 read_dir 失败的 toast。
 * 因此普通双词斜杠组合（`and/or`、`true/false`、`read/write`）与代码片段
 * （`const x = a/b`、`array[i]/2`）一律不作为路径。
 *
 * 命中条件（满足其一）：
 * - 绝对路径：`/home/...`、`C:/...`
 * - 显式相对路径：`./...`、`../...`
 * - 相对路径且**末段含 `.` 扩展名**（`src/main.rs`、`docs/plan.md`）
 * - 相对路径且**首段是已知项目目录**（`src/utils`、`src/` → 目录）
 *
 * 尾斜杠只豁免「末段需有扩展名」与「至少两段」这两项，**不豁免** scheme /
 * 空格 / 命令词 / 段字符等检查——否则 `and/or/`、`foo/bar/` 加个尾斜杠
 * 就把双词斜杠组合全放过去了（此缺陷被复查抓出并修掉，见测试
 * `still applies all guards to trailing-slash strings`）。
 */
export function isLikelyPathString(str: string): boolean {
  const raw = str.trim()
  // 尾斜杠是明确的「目录意图」，先剥掉再走同一套判定；`hadTrailingSlash` 留住
  // 这个信号供下方「无分隔符」与「单段」两个豁免判定使用。
  const hadTrailingSlash = /[\\/]$/.test(raw)
  const trimmed = raw.replace(/[\\/]+$/, '')
  if (!trimmed || str.includes('\n') || trimmed.length > MAX_PATH_HINT_LENGTH) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) return false
  if (trimmed.startsWith('//')) return false

  // 代码/命令行特征字符（含 shell 重定向、管道、引号、`$`）
  if (/[;"`$><|]/.test(trimmed)) return false
  const spaceCount = (trimmed.match(/\s/g) || []).length
  if (spaceCount > MAX_PATH_HINT_SPACES) return false
  if (spaceCount > 0) {
    const firstWord = trimmed.split(/\s+/)[0]
    if (COMMAND_FIRST_WORDS.has(firstWord)) return false
  }

  // 必须含路径分隔符（尾斜杠本身也算：`src/` 剥完是 `src`）
  if (!trimmed.includes('/') && !trimmed.includes('\\') && !hadTrailingSlash) return false

  // 绝对路径（POSIX / Windows 盘符）
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return true

  // 显式相对路径
  if (trimmed.startsWith('./') || trimmed.startsWith('.\\') || trimmed.startsWith('../') || trimmed.startsWith('..\\')) {
    return true
  }

  const segments = trimmed.split(/[\\/]/)
  // 尾斜杠（目录意图）时允许单段（`src/`）；否则必须多段才是相对路径
  if (segments.length < 2 && !hadTrailingSlash) return false
  // 任一段含非法字符（`=`、`(`、`[`、空格…）即非路径：挡住代码片段
  if (!segments.every((s) => s.length > 0 && PATH_SEGMENT_CHARS.test(s))) return false

  // 走到这里的都是相对形态。末段有扩展名或命中无扩展名文件白名单 → 文件路径。
  const last = segments[segments.length - 1]
  if (last.includes('.')) return true
  if (EXTENSIONLESS_FILE_NAMES.has(last)) return true
  // 末段是「无扩展名的裸词」：只有首段是已知项目目录才敢认它是目录
  // （`src/utils`、`docs/plans`、`src/`）。尾斜杠与非尾斜杠一视同仁——
  // 否则 `and/or/`、`foo/bar/` 加个尾斜杠就把散文组合全放过去了。
  return KNOWN_TOP_DIRS.has(segments[0])
}

/**
 * 快速判断一个路径是否显式为目录：
 * - 以 `/` 或 `\` 结尾（如 `/home/pax/dir/`）
 * - 或者常见目录名（无扩展名，如 `/home/pax/coding/OmniTerm-dev`、`src/api`）
 * - 排除两类「无扩展名但是文件」的末段：常见无扩展名文件（`Makefile`/`Dockerfile`/`LICENSE`）
 *   与隐藏文件（`.gitignore`、`.env`）
 *
 * 这是**启发式**，不是权威判定：误判成目录会把本该开抽屉的文件送去列目录
 * （`ENOTDIR` → 500 + toast）。调用方需要权威 `Dir`/`File` 时应以后端
 * `list_files` 的 `path_type` 为准（FileManager 侧已收敛为 `isDirEntry()`）。
 */
export function looksLikeDirectory(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').trim()
  if (!normalized) return false
  if (normalized.endsWith('/')) return true
  const lastSegment = normalized.split('/').pop() || ''
  // 像 `.gitignore`、`.env` 这种以点开头且只有一个点的视为隐藏文件
  if (lastSegment.startsWith('.') && !lastSegment.slice(1).includes('.')) {
    return false
  }
  // 常见无扩展名文件（Makefile / Dockerfile / LICENSE …）是文件不是目录
  if (EXTENSIONLESS_FILE_NAMES.has(lastSegment)) return false
  // 含有标准文件后缀（如 .rs, .ts, .json, .md, .toml, .txt 等）
  return !lastSegment.includes('.')
}


