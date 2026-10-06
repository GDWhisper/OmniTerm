import { describe, it, expect } from 'vitest'
import { getParentPath, joinPath, isPathOutsideWorkspace, resolveRenamedPath, toAbsolutePath, findCoveringProject, findExactProject, parseLocalFilePath, looksLikeDirectory, isLikelyPathString } from './path'

describe('getParentPath', () => {
  it('returns empty for root and empty input', () => {
    expect(getParentPath('')).toBe('')
    expect(getParentPath('/')).toBe('')
  })

  it('handles unix paths', () => {
    // First-level dir's parent is the filesystem root, not "nothing"
    expect(getParentPath('/a')).toBe('/')
    expect(getParentPath('/home')).toBe('/')
    expect(getParentPath('/a/b')).toBe('/a')
    expect(getParentPath('/a/b/')).toBe('/a')
    expect(getParentPath('a/b')).toBe('a')
    // Bare relative segment has nothing above it
    expect(getParentPath('a')).toBe('')
  })

  it('handles windows drive paths', () => {
    // Parent of a first-level dir is the rooted drive, not drive-relative 'G:'
    expect(getParentPath('G:/Codes')).toBe('G:/')
    expect(getParentPath('g:/Codes/ot')).toBe('g:/Codes')
    // Drive root has no parent
    expect(getParentPath('G:/')).toBe('')
    expect(getParentPath('G:')).toBe('')
  })
})

describe('joinPath', () => {
  it('joins dir and name with a single slash', () => {
    expect(joinPath('/a', 'b')).toBe('/a/b')
    expect(joinPath('/home/pax', 'coding')).toBe('/home/pax/coding')
    expect(joinPath('', 'b')).toBe('b')
  })

  it('does not produce a double slash at the filesystem root', () => {
    expect(joinPath('/', 'home')).toBe('/home')
    expect(joinPath('/', 'bin')).toBe('/bin')
  })

  it('keeps windows drive roots rooted without doubling the slash', () => {
    expect(joinPath('G:/', 'Codes')).toBe('G:/Codes')
    expect(joinPath('G:/Codes', 'ot')).toBe('G:/Codes/ot')
  })
})

describe('isPathOutsideWorkspace', () => {
  it('treats undefined/null/empty workspaceRoot as outside (safe default)', () => {
    expect(isPathOutsideWorkspace('/any/path', undefined)).toBe(true)
    expect(isPathOutsideWorkspace('/any/path', null)).toBe(true)
    expect(isPathOutsideWorkspace('/any/path', '')).toBe(true)
  })

  it('returns false for a file inside the workspace', () => {
    expect(isPathOutsideWorkspace('/home/user/proj/src/main.rs', '/home/user/proj')).toBe(false)
    expect(isPathOutsideWorkspace('/home/user/proj', '/home/user/proj')).toBe(false)
  })

  it('does not match a sibling prefix as inside (boundary check)', () => {
    // /home/a 不得误匹配 /home/ab
    expect(isPathOutsideWorkspace('/home/ab/file.txt', '/home/a')).toBe(true)
    expect(isPathOutsideWorkspace('/home/a/file.txt', '/home/a')).toBe(false)
  })

  it('normalizes trailing slashes on workspaceRoot', () => {
    expect(isPathOutsideWorkspace('/home/user/proj/file.txt', '/home/user/proj/')).toBe(false)
    expect(isPathOutsideWorkspace('/home/user/proj2/file.txt', '/home/user/proj/')).toBe(true)
  })

  it('treats filesystem root as containing everything', () => {
    expect(isPathOutsideWorkspace('/etc/hosts', '/')).toBe(false)
    expect(isPathOutsideWorkspace('/', '/')).toBe(false)
  })

  it('treats a file above the workspace root as outside', () => {
    expect(isPathOutsideWorkspace('/home/user/other.txt', '/home/user/proj')).toBe(true)
    expect(isPathOutsideWorkspace('/tmp/x', '/home/user/proj')).toBe(true)
  })
})

describe('resolveRenamedPath', () => {
  it('resolves a same-directory rename to the new absolute path', () => {
    expect(resolveRenamedPath('/root/img/a.png', 'img/a.png', 'img/b.png')).toBe('/root/img/b.png')
    // File at watch root
    expect(resolveRenamedPath('/root/a.png', 'a.png', 'b.png')).toBe('/root/b.png')
    // File at filesystem root
    expect(resolveRenamedPath('/a.png', 'a.png', 'b.png')).toBe('/b.png')
  })

  it('resolves a cross-directory move to the new absolute path', () => {
    expect(resolveRenamedPath('/root/img/a.png', 'img/a.png', 'new/b.png')).toBe('/root/new/b.png')
  })

  it('returns null when the rename does not point at absPath (same basename, different dir)', () => {
    // watch 树内其他目录的同名文件被改名，不应误切 drawer 路径
    expect(resolveRenamedPath('/root/a.png', 'sub/a.png', 'sub/b.png')).toBeNull()
    expect(resolveRenamedPath('/root/img/a.png', 'other/a.png', 'other/b.png')).toBeNull()
  })

  it('returns null when absPath is relative (no reliable watch-root derivation)', () => {
    expect(resolveRenamedPath('a.png', 'a.png', 'b.png')).toBeNull()
  })
})

describe('toAbsolutePath', () => {
  const root = '/home/u/proj'

  it('joins a relative path onto the workspace root', () => {
    expect(toAbsolutePath('docs/a.md', root)).toBe('/home/u/proj/docs/a.md')
    expect(toAbsolutePath('a.md', root)).toBe('/home/u/proj/a.md')
  })

  it('strips a leading ./', () => {
    expect(toAbsolutePath('./docs/a.md', root)).toBe('/home/u/proj/docs/a.md')
  })

  it('leaves an already-absolute path untouched', () => {
    expect(toAbsolutePath('/etc/hosts', root)).toBe('/etc/hosts')
    expect(toAbsolutePath('/home/u/proj/a.md', root)).toBe('/home/u/proj/a.md')
  })

  it('treats a windows drive path as absolute and normalizes separators', () => {
    expect(toAbsolutePath('C:\\Codes\\a.md', root)).toBe('C:/Codes/a.md')
    expect(toAbsolutePath('g:/Codes/a.md', root)).toBe('g:/Codes/a.md')
  })

  it('normalizes windows separators in relative paths and in the root', () => {
    expect(toAbsolutePath('docs\\a.md', 'C:\\Codes\\proj')).toBe('C:/Codes/proj/docs/a.md')
  })

  it('normalizes a trailing slash on the root', () => {
    expect(toAbsolutePath('a.md', '/home/u/proj/')).toBe('/home/u/proj/a.md')
    expect(toAbsolutePath('a.md', '/home/u/proj///')).toBe('/home/u/proj/a.md')
  })

  it('handles a filesystem-root workspace', () => {
    expect(toAbsolutePath('a.md', '/')).toBe('/a.md')
  })

  it('returns the relative path unchanged when no root is available', () => {
    // 无基准时不造假绝对路径，交后端 sanitize_path 判定
    expect(toAbsolutePath('docs/a.md', undefined)).toBe('docs/a.md')
    expect(toAbsolutePath('docs/a.md', null)).toBe('docs/a.md')
    expect(toAbsolutePath('docs/a.md', '')).toBe('docs/a.md')
  })

  it('returns empty for blank input', () => {
    expect(toAbsolutePath('', root)).toBe('')
    expect(toAbsolutePath('   ', root)).toBe('')
  })

  it('does not resolve .. — traversal is the backend\'s call', () => {
    expect(toAbsolutePath('../outside/a.md', root)).toBe('/home/u/proj/../outside/a.md')
  })
})

describe('findCoveringProject', () => {
  const projects = [
    { id: 'p-home', path: '/home/user' },
    { id: 'p-proj', path: '/home/user/proj' },
    { id: 'p-sibling', path: '/home/a' },
  ]

  it('matches exact project path', () => {
    expect(findCoveringProject('/home/user/proj', projects)?.id).toBe('p-proj')
  })

  it('matches a child directory', () => {
    expect(findCoveringProject('/home/user/proj/src', projects)?.id).toBe('p-proj')
    expect(findCoveringProject('/home/user/docs', projects)?.id).toBe('p-home')
  })

  it('returns the deepest covering project when nested', () => {
    expect(findCoveringProject('/home/user/proj/src/deep', projects)?.id).toBe('p-proj')
  })

  it('does not match a sibling prefix (boundary check)', () => {
    // /home/a 不得误覆盖 /home/ab
    expect(findCoveringProject('/home/ab/x', projects)).toBeUndefined()
  })

  it('normalizes trailing slashes on project paths', () => {
    expect(findCoveringProject('/data/x', [{ id: 'p', path: '/data/' }])?.id).toBe('p')
  })

  it('treats a root project as covering any absolute path', () => {
    expect(findCoveringProject('/etc/hosts', [{ id: 'p', path: '/' }])?.id).toBe('p')
  })

  it('returns undefined when nothing covers', () => {
    expect(findCoveringProject('/tmp/scratch', projects)).toBeUndefined()
    expect(findCoveringProject('/tmp/scratch', [])).toBeUndefined()
  })
})

describe('findExactProject', () => {
  const projects = [
    { id: 'p-home', path: '/home/user' },
    { id: 'p-proj', path: '/home/user/proj' },
  ]

  it('matches only the project whose root equals the dir', () => {
    expect(findExactProject('/home/user/proj', projects)?.id).toBe('p-proj')
    expect(findExactProject('/home/user', projects)?.id).toBe('p-home')
  })

  it('does not match a child directory (that is covering, not exact)', () => {
    expect(findExactProject('/home/user/proj/src', projects)).toBeUndefined()
  })

  it('does not match a sibling prefix (boundary check)', () => {
    expect(findExactProject('/home/ab', projects)).toBeUndefined()
  })

  it('normalizes trailing slashes on both sides', () => {
    expect(findExactProject('/data/', [{ id: 'p', path: '/data' }])?.id).toBe('p')
    expect(findExactProject('/data', [{ id: 'p', path: '/data/' }])?.id).toBe('p')
  })

  it('matches the root project for root dirs', () => {
    expect(findExactProject('/', [{ id: 'p', path: '/' }])?.id).toBe('p')
    expect(findExactProject('/', projects)).toBeUndefined()
  })
})

describe('parseLocalFilePath', () => {
  it('identifies and cleans relative and absolute file paths', () => {
    expect(parseLocalFilePath('src/main.rs')).toBe('src/main.rs')
    expect(parseLocalFilePath('./docs/spec.md')).toBe('./docs/spec.md')
    expect(parseLocalFilePath('/home/user/project/file.ts')).toBe('/home/user/project/file.ts')
    expect(parseLocalFilePath('C:/workspace/test.py')).toBe('C:/workspace/test.py')
  })

  it('strips line numbers (:24, :24:10, :24-30)', () => {
    expect(parseLocalFilePath('src/main.rs:24')).toBe('src/main.rs')
    expect(parseLocalFilePath('src/main.rs:24:10')).toBe('src/main.rs')
    expect(parseLocalFilePath('src/main.rs:24-30')).toBe('src/main.rs')
    expect(parseLocalFilePath('/home/user/a.ts:100')).toBe('/home/user/a.ts')
  })

  it('strips hash fragments (#L10, #L10-L20, #heading) and query strings', () => {
    expect(parseLocalFilePath('docs/plan.md#L10')).toBe('docs/plan.md')
    expect(parseLocalFilePath('docs/plan.md#L10-L20')).toBe('docs/plan.md')
    expect(parseLocalFilePath('docs/plan.md#heading')).toBe('docs/plan.md')
    expect(parseLocalFilePath('docs/plan.md?v=1#L5')).toBe('docs/plan.md')
  })

  it('decodes uri percent-encoded paths', () => {
    expect(parseLocalFilePath('my%20documents/notes.md')).toBe('my documents/notes.md')
  })

  it('rejects external scheme urls and protocol-relative urls', () => {
    expect(parseLocalFilePath('https://example.com/test.md')).toBeNull()
    expect(parseLocalFilePath('http://localhost:3000')).toBeNull()
    expect(parseLocalFilePath('mailto:test@example.com')).toBeNull()
    expect(parseLocalFilePath('ftp://files/a.txt')).toBeNull()
    expect(parseLocalFilePath('//cdn.example.com/lib.js')).toBeNull()
  })

  it('rejects in-page anchors and empty/whitespace strings', () => {
    expect(parseLocalFilePath('#heading')).toBeNull()
    expect(parseLocalFilePath('#L24')).toBeNull()
    expect(parseLocalFilePath('')).toBeNull()
    expect(parseLocalFilePath('   ')).toBeNull()
    expect(parseLocalFilePath(undefined)).toBeNull()
    expect(parseLocalFilePath(null)).toBeNull()
  })
})

describe('looksLikeDirectory', () => {
  it('identifies trailing slashes as directory', () => {
    expect(looksLikeDirectory('/home/pax/dir/')).toBe(true)
    expect(looksLikeDirectory('src/components/')).toBe(true)
  })

  it('identifies paths without file extensions as directory', () => {
    expect(looksLikeDirectory('/home/pax/coding/OmniTerm-dev')).toBe(true)
    expect(looksLikeDirectory('frontend/src')).toBe(true)
    expect(looksLikeDirectory('./docs')).toBe(true)
  })

  it('identifies paths with extensions or dotfiles as files', () => {
    expect(looksLikeDirectory('/home/pax/file.txt')).toBe(false)
    expect(looksLikeDirectory('src/main.rs')).toBe(false)
    expect(looksLikeDirectory('.gitignore')).toBe(false)
    expect(looksLikeDirectory('/repo/.env')).toBe(false)
  })

  it('does not treat extensionless *files* as directories', () => {
    // 回归：曾把「无扩展名 ⇒ 目录」，导致点 Makefile/Dockerfile/LICENSE 被送去列目录
    // （后端 read_dir 对文件返回 ENOTDIR → 500 + error toast），本该开抽屉。
    expect(looksLikeDirectory('Makefile')).toBe(false)
    expect(looksLikeDirectory('/repo/Makefile')).toBe(false)
    expect(looksLikeDirectory('Dockerfile')).toBe(false)
    expect(looksLikeDirectory('LICENSE')).toBe(false)
    expect(looksLikeDirectory('README')).toBe(false)
    expect(looksLikeDirectory('CONTRIBUTING')).toBe(false)
    // 有扩展名的普通文件仍判文件
    expect(looksLikeDirectory('src/main.rs')).toBe(false)
    // 目录语义不受影响
    expect(looksLikeDirectory('/repo/src')).toBe(true)
  })
})

describe('isLikelyPathString', () => {
  it('detects unix and windows absolute paths', () => {
    expect(isLikelyPathString('/home/pax/coding/OmniTerm-dev')).toBe(true)
    expect(isLikelyPathString('C:\\Users\\pax\\coding\\app')).toBe(true)
    expect(isLikelyPathString('C:/Users/pax/coding/app')).toBe(true)
  })

  it('detects relative paths', () => {
    expect(isLikelyPathString('./src/main.rs')).toBe(true)
    expect(isLikelyPathString('../docs/readme.md')).toBe(true)
    expect(isLikelyPathString('frontend/src/App.tsx')).toBe(true)
  })

  it('detects extensionless known project directories', () => {
    expect(isLikelyPathString('src/utils')).toBe(true)
    expect(isLikelyPathString('docs/plans')).toBe(true)
    expect(isLikelyPathString('frontend/src')).toBe(true)
  })

  it('detects trailing-slash directories', () => {
    // 尾斜杠即目录意图（agent 高频输出「看 `frontend/`」）
    expect(isLikelyPathString('src/')).toBe(true)
    expect(isLikelyPathString('frontend/')).toBe(true)
    expect(isLikelyPathString('docs/')).toBe(true)
    expect(isLikelyPathString('frontend/src/')).toBe(true)
    expect(isLikelyPathString('/home/pax/dir/')).toBe(true)
  })

  it('still applies all guards to trailing-slash strings', () => {
    // 回归：尾斜杠分支曾排在 scheme / 空格 / 命令词黑名单之前，`and/or/` 这类
    // 散文组合加个尾斜杠就绕过全部防护，把 MAJOR-1 修掉的假阳性整批复活。
    for (const s of [
      'and/or/', 'true/false/', 'he/she/', 'either/or/', 'yes/no/', 'client/server/',
      'input/output/', 'on/off/', 'TCP/IP/', 'GET/POST/', 'sync/async/', 'read/write/',
      'up/down/', 'x/y/', 'foo/bar/', 'ui/ux/', 'docs and/or tests/',
      'const x = a/b/', 'array[i]/2/', 'node dist/index.js/', 'https://example.com/a/',
    ]) {
      expect(isLikelyPathString(s), s).toBe(false)
    }
  })

  it('rejects web urls, multi-line, or non-paths', () => {
    expect(isLikelyPathString('https://github.com/foo/bar')).toBe(false)
    expect(isLikelyPathString('//example.com/a')).toBe(false)
    expect(isLikelyPathString('hello world')).toBe(false)
    expect(isLikelyPathString('npm install foo/bar is cool')).toBe(false)
    expect(isLikelyPathString('console.log("hi")')).toBe(false)
  })

  it('rejects double-word slash combos (prose, not paths)', () => {
    // 回归：曾把「任一段非空即路径」，导致 and/or、true/false、TCP/IP、read/write
    // 全被挂成可点击路径，误点还会弹 read_dir 失败 toast。
    for (const s of [
      'and/or', 'true/false', 'he/she', 'either/or', 'yes/no', 'client/server',
      'input/output', 'on/off', 'TCP/IP', 'GET/POST', 'sync/async', 'read/write',
      'docs and/or tests', 'foo/bar/baz',
    ]) {
      expect(isLikelyPathString(s), s).toBe(false)
    }
  })

  it('rejects code fragments that merely contain a slash', () => {
    for (const s of [
      'const x = a/b',
      'array[i]/2',
      'a{b} / c',
      "sed -i s/a/b/ f",
      'let x = p / q',
      'node dist/index.js',
      'json.path/to',
    ]) {
      expect(isLikelyPathString(s), s).toBe(false)
    }
  })

  it('rejects path-like strings that are over the length or space budget', () => {
    expect(isLikelyPathString(`src/${'a'.repeat(600)}`)).toBe(false)
    expect(isLikelyPathString('src / a / b / c / d')).toBe(false)
  })
})

