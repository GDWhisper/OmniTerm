//! Filesystem operations: path sanitization, directory listing, file I/O, search.
//!
//! ## Attribution
//!
//! This module's API shape and key algorithms were modeled after
//! [sigoden/dufs](https://github.com/sigoden/dufs) (MIT OR Apache-2.0).
//! Patterns adapted:
//!
//! - `PathType` / `FileEntry` field names and JSON shape (mirrors dufs's
//!   `PathType` / `PathItem`).
//! - mtime resolution with fallback to created time.
//! - Directory `size` = child entry count, capped by `MAX_SUBPATHS_COUNT`.
//! - Sort order: directories first, then by chosen key.
//! - Path normalization to forward slashes.
//!
//! No code is copied verbatim. Rust idioms, async I/O style, and the
//! public API surface were rewritten for OmniTerm's needs.

use anyhow::{Result, anyhow};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::fs;
use tokio::io::AsyncReadExt;

const MAX_SUBPATHS_COUNT: u64 = 1000;

/// 文本探测窗口大小：读取文件头部此字节数判定是否为 UTF-8 文本。
/// 非文本（二进制）文件在窗口内即命中非法序列，可避免把大型二进制文件整体读入内存。
const TEXT_PROBE_BYTES: usize = 64 * 1024;

/// Expand a leading `~` / `~/` to the user's home directory. Other paths
/// pass through unchanged. Single source of truth for `~` expansion
/// (used by project creation, session workspace resolution, path-validity checks).
pub fn expand_home(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        path.replacen('~', &home, 1)
    } else {
        path.to_string()
    }
}

/// Whether the (possibly `~`-prefixed) path currently points to an existing
/// directory. Used to flag project paths that were moved/renamed/deleted.
pub fn dir_exists(path: &str) -> bool {
    Path::new(&expand_home(path)).is_dir()
}

/// Sanitize a requested path against a base directory.
/// Prevents directory traversal attacks. The path must already exist.
pub fn sanitize_path(base: &Path, requested: &str) -> Result<PathBuf> {
    sanitize_path_inner(base, requested, false)
}

/// Like [`sanitize_path`], but allows the resolved path to escape the base
/// directory. Only use for trusted callers that explicitly need unrestricted
/// filesystem access (e.g. sessions pinned to an absolute path outside the
/// workspace). Null-byte validation and the existence requirement still apply.
pub fn sanitize_path_allow_escape(base: &Path, requested: &str) -> Result<PathBuf> {
    sanitize_path_inner(base, requested, true)
}

fn sanitize_path_inner(base: &Path, requested: &str, allow_escape: bool) -> Result<PathBuf> {
    let joined = join_and_validate(base, requested)?;

    if !joined.exists() {
        return Err(anyhow!("path does not exist: {}", joined.display()));
    }

    let canonical = joined.canonicalize().map_err(|e| anyhow!("path resolution failed: {}", e))?;

    if !allow_escape {
        let canonical_base =
            base.canonicalize().map_err(|e| anyhow!("base path resolution failed: {}", e))?;
        if !canonical.starts_with(&canonical_base) {
            // 兜底：绝对路径且不在 base 内（典型场景：session.adopt 时
            // workspace_path 存错 / 跨 worktree 浏览），若该路径有祖先 git repo
            // 且 toplevel 存在，视为在工作区内放行。与 listFiles2 的
            // `resolve_effective_workspace_root` 兜底语义保持一致——前端不弹
            // 越界提示时后端也不应拒绝，否则 user 视角"在工作区内"的操作会
            // 莫名其妙 403。FileDrawer 等调用方在 effective_workspace_root 命中
            // 时不传 allow_escape（不弹即不传），依赖此兜底完成写入。
            if is_inside_git_toplevel(&canonical) {
                return Ok(canonical);
            }
            return Err(anyhow!("access denied: path escapes workspace root"));
        }
    }

    Ok(canonical)
}

/// Sanitize a path for creation (write, mkdir, upload).
/// Does NOT require the path to exist — only validates the parent is within base.
pub fn sanitize_path_new(base: &Path, requested: &str) -> Result<PathBuf> {
    sanitize_path_new_inner(base, requested, false)
}

/// Like [`sanitize_path_new`], but allows creating paths outside the base
/// directory. Only use for trusted callers that explicitly need unrestricted
/// filesystem access. Null-byte validation and the parent-ancestor resolution
/// still apply.
pub fn sanitize_path_new_allow_escape(base: &Path, requested: &str) -> Result<PathBuf> {
    sanitize_path_new_inner(base, requested, true)
}

fn sanitize_path_new_inner(base: &Path, requested: &str, allow_escape: bool) -> Result<PathBuf> {
    let joined = join_and_validate(base, requested)?;

    let canonical_base =
        base.canonicalize().map_err(|e| anyhow!("base path resolution failed: {}", e))?;

    // Walk up until we find an existing ancestor
    let mut check = joined.as_path();
    let mut tail = Vec::new();
    loop {
        if check.exists() {
            let canonical =
                check.canonicalize().map_err(|e| anyhow!("path resolution failed: {}", e))?;
            if !allow_escape && !canonical.starts_with(&canonical_base) {
                // 同 sanitize_path_inner：绝对路径 + git_toplevel 兜底
                if is_inside_git_toplevel(&canonical) {
                    let mut result = canonical;
                    for component in tail.into_iter().rev() {
                        result = result.join(component);
                    }
                    return Ok(result);
                }
                return Err(anyhow!("access denied: path escapes workspace root"));
            }
            let mut result = canonical;
            // tail 从最深到最浅压栈，需反转后按「浅→深」拼接
            // （历史 bug：漏掉 .rev() 会把多层缺失目录拼成反序，如 a/b/c → a/c/b）
            for component in tail.into_iter().rev() {
                result = result.join(component);
            }
            return Ok(result);
        }
        match check.file_name() {
            Some(name) => {
                tail.push(name.to_owned());
                check = check.parent().unwrap_or(check);
            }
            None => {
                let mut result = canonical_base;
                for component in tail.into_iter().rev() {
                    result = result.join(component);
                }
                return Ok(result);
            }
        }
    }
}

/// 兜底检查：`path` 是否位于某个祖先 git 仓库的 toplevel 之下。
/// 用于 session.adopt workspace_path 存错 / 跨 worktree 浏览时，sanitize_path
/// 拒绝 base 外的写操作的兜底放行——与 listFiles2 `resolve_effective_workspace_root`
/// 的 git_toplevel 兜底语义保持一致。
/// 失败/非 git repo 返回 false（仍走原拒绝路径，行为不变）。
fn is_inside_git_toplevel(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    let Some(path_str) = path.to_str() else {
        return false;
    };
    let output = Command::new("git")
        .args(["-C", path_str, "rev-parse", "--show-toplevel"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let Ok(out) = output else { return false };
    if !out.status.success() {
        return false;
    }
    let Ok(s) = String::from_utf8(out.stdout) else { return false };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(toplevel) = std::path::Path::new(trimmed).canonicalize() else {
        return false;
    };
    path.starts_with(&toplevel)
}

/// Shared helper: strip null bytes and join against base.
fn join_and_validate(base: &Path, requested: &str) -> Result<PathBuf> {
    if requested.as_bytes().contains(&0) {
        return Err(anyhow!("invalid path: contains null byte"));
    }

    let requested_path = Path::new(requested);
    // ponytail: absolute paths under base are used directly (canonicalize + starts_with still guards traversal)
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        base.join(requested_path)
    };

    Ok(joined)
}

/// 按 `allow_escape` 分发到严格版或放行版（读路径）。文件操作以 `base` 为根时
/// 统一走这里，避免各调用点重复 if/else。
fn sanitize_read(base: &Path, requested: &str, allow_escape: bool) -> Result<PathBuf> {
    if allow_escape {
        sanitize_path_allow_escape(base, requested)
    } else {
        sanitize_path(base, requested)
    }
}

/// 按 `allow_escape` 分发到严格版或放行版（新建路径）。
fn sanitize_new(base: &Path, requested: &str, allow_escape: bool) -> Result<PathBuf> {
    if allow_escape {
        sanitize_path_new_allow_escape(base, requested)
    } else {
        sanitize_path_new(base, requested)
    }
}

/// Path type of a filesystem entry.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum PathType {
    #[serde(rename = "Dir")]
    Dir,
    #[serde(rename = "File")]
    File,
    #[serde(rename = "SymlinkDir")]
    SymlinkDir,
    #[serde(rename = "SymlinkFile")]
    SymlinkFile,
}

/// A file or directory entry returned by [`list_dir`].
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path_type: PathType,
    pub name: String,
    pub mtime: u64,
    pub size: u64,
    /// 相对搜索根的路径（仅 [`search_files`] 填充；目录列表为 None 不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
}

impl FileEntry {
    pub fn is_dir(&self) -> bool {
        self.path_type == PathType::Dir || self.path_type == PathType::SymlinkDir
    }
}

/// Convert `SystemTime` to unix milliseconds.
fn to_timestamp(time: &SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// Normalize a path for API responses / frontend display.
///
/// On Windows, `canonicalize()` returns verbatim paths (`\\?\G:\...`) and
/// psmux reports backslash paths (`G:\...`); the frontend splits paths on
/// `/`. Strip the verbatim prefix and use forward slashes so Windows paths
/// come out as `G:/...`. Unix paths pass through unchanged.
pub fn display_path(path: &Path) -> String {
    display_path_str(&path.to_string_lossy())
}

/// String variant of [`display_path`] for paths already held as strings
/// (e.g. pane CWD from the multiplexer).
pub fn display_path_str(path: &str) -> String {
    if !cfg!(windows) {
        return path.to_string();
    }
    let s = path.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = s.strip_prefix("//?/") {
        rest.to_string()
    } else {
        s
    }
}

/// Sort key for directory listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Mtime,
    Size,
}

/// List directory contents.
pub async fn list_dir(
    base: &Path,
    rel_path: &str,
    sort: SortKey,
    desc: bool,
) -> Result<Vec<FileEntry>> {
    let dir = sanitize_path(base, rel_path)?;

    let mut entries = Vec::new();
    let mut read_dir = fs::read_dir(&dir).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // 单条目 metadata 失败（如 Windows 用户目录下 ACL 拒绝访问的遗留
        // junction「Application Data」等）只跳过该条目，不让整个列表失败
        let Ok(meta) = fs::metadata(entry.path()).await else {
            continue;
        };
        let Ok(meta2) = fs::symlink_metadata(entry.path()).await else {
            continue;
        };
        let is_symlink = meta2.is_symlink();
        let is_dir = meta.is_dir();

        let path_type = match (is_symlink, is_dir) {
            (true, true) => PathType::SymlinkDir,
            (false, true) => PathType::Dir,
            (true, false) => PathType::SymlinkFile,
            (false, false) => PathType::File,
        };

        // mtime: prefer modified, fallback to created
        let mtime = meta
            .modified()
            .ok()
            .or_else(|| meta.created().ok())
            .map(|t| to_timestamp(&t))
            .unwrap_or(0);

        // For directories, count entries (capped by MAX_SUBPATHS_COUNT)
        let size = if is_dir {
            let mut count: u64 = 0;
            if let Ok(mut sub) = fs::read_dir(entry.path()).await {
                while let Ok(Some(_sub_entry)) = sub.next_entry().await {
                    count += 1;
                    if count >= MAX_SUBPATHS_COUNT {
                        break;
                    }
                }
            }
            count
        } else {
            meta.len()
        };

        entries.push(FileEntry { path_type, name, mtime, size, rel_path: None });
    }

    // Sort: directories first, then by chosen key
    entries.sort_by(|a, b| {
        let dir_cmp = b.is_dir().cmp(&a.is_dir());
        if dir_cmp != std::cmp::Ordering::Equal {
            return dir_cmp;
        }
        let key_cmp = match sort {
            SortKey::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            SortKey::Mtime => a.mtime.cmp(&b.mtime),
            SortKey::Size => a.size.cmp(&b.size),
        };
        if desc { key_cmp.reverse() } else { key_cmp }
    });

    Ok(entries)
}

/// 判定字节流能否视为 UTF-8 文本（探测用途）。
///
/// 只校验「完整前缀」：忽略窗口末尾可能被截断的多字节序列，避免把恰好
/// 跨越探测窗口边界的多字节字符（如中文）误判为二进制。窗口内出现
/// NUL 字节（二进制强信号，快检短路）或非法 UTF-8 序列即判定为非文本。
fn probe_is_utf8_text(buf: &[u8]) -> bool {
    // NULL 快检：正常文本文件不含 NUL 字节，而二进制数据几乎都含。
    // 在完整 UTF-8 校验前先线性扫描，命中即判定非文本——扫描单字节
    // 比跑完整 UTF-8 状态机校验便宜得多（性能优化）。
    if buf.contains(&0) {
        return false;
    }
    let mut end = buf.len();
    // 去掉末尾连续的 continuation 字节（0b10xxxxxx）
    while end > 0 && (buf[end - 1] & 0xC0) == 0x80 {
        end -= 1;
    }
    // 结尾是多字节字符的起始字节 → 是被截断的序列，一并舍去
    if end > 0 {
        let b = buf[end - 1];
        if b & 0xE0 == 0xC0 || b & 0xF0 == 0xE0 || b & 0xF8 == 0xF0 {
            end -= 1;
        }
    }
    std::str::from_utf8(&buf[..end]).is_ok()
}

/// 读取文件内容；文件不是合法 UTF-8 文本时返回 `Ok(None)`（供调用方降级为
/// 「无法预览」，而非报错）。文本兜底依赖此内容判定，不依赖扩展名白名单。
///
/// 先探测头部避免把大型二进制文件整体读入内存，全量解码时再做严格校验
/// （头部合法不代表整个文件合法）。
pub async fn read_text_file(path: &Path) -> Result<Option<String>> {
    let mut file = fs::File::open(path).await?;
    let mut probe = vec![0u8; TEXT_PROBE_BYTES];
    let n = file.read(&mut probe).await?;
    probe.truncate(n);
    if !probe_is_utf8_text(&probe) {
        return Ok(None);
    }
    let mut bytes = probe;
    file.read_to_end(&mut bytes).await?;
    // 全量 NULL 快检：探测窗口通过但文件后部混入 NUL（如文本尾随二进制
    // 数据）时提前返回，避免 `String::from_utf8` 全量校验的额外开销。
    if bytes.contains(&0) {
        return Ok(None);
    }
    match String::from_utf8(bytes) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

/// Read file content as UTF-8 string. Returns `Ok(None)` when the file is not
/// valid UTF-8 text (caller should degrade to "cannot preview").
pub async fn read_file(base: &Path, rel_path: &str) -> Result<Option<String>> {
    let path = sanitize_path(base, rel_path)?;
    read_text_file(&path).await
}

/// Write content to a file. Creates the file if it doesn't exist.
pub async fn write_file(base: &Path, rel_path: &str, content: &[u8]) -> Result<()> {
    write_file_impl(base, rel_path, content, false).await
}

/// Like [`write_file`], but allows the target to escape `base` for trusted
/// callers that explicitly request unrestricted access
/// (see [`sanitize_path_new_allow_escape`]).
pub async fn write_file_allow_escape(base: &Path, rel_path: &str, content: &[u8]) -> Result<()> {
    write_file_impl(base, rel_path, content, true).await
}

async fn write_file_impl(
    base: &Path,
    rel_path: &str,
    content: &[u8],
    allow_escape: bool,
) -> Result<()> {
    let path = sanitize_new(base, rel_path, allow_escape)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::write(&path, content).await?;
    Ok(())
}

/// Create a directory (and parents).
pub async fn create_dir(base: &Path, rel_path: &str) -> Result<()> {
    create_dir_impl(base, rel_path, false).await
}

/// Like [`create_dir`], but allows creating directories outside `base`
/// for trusted callers (see [`sanitize_path_new_allow_escape`]).
pub async fn create_dir_allow_escape(base: &Path, rel_path: &str) -> Result<()> {
    create_dir_impl(base, rel_path, true).await
}

async fn create_dir_impl(base: &Path, rel_path: &str, allow_escape: bool) -> Result<()> {
    let path = sanitize_new(base, rel_path, allow_escape)?;
    fs::create_dir_all(&path).await?;
    Ok(())
}

/// Delete a file or directory.
pub async fn delete_path(base: &Path, rel_path: &str) -> Result<()> {
    delete_path_impl(base, rel_path, false).await
}

/// Like [`delete_path`], but allows deleting paths outside `base` for
/// trusted callers (see [`sanitize_path_allow_escape`]).
pub async fn delete_path_allow_escape(base: &Path, rel_path: &str) -> Result<()> {
    delete_path_impl(base, rel_path, true).await
}

async fn delete_path_impl(base: &Path, rel_path: &str, allow_escape: bool) -> Result<()> {
    let path = sanitize_read(base, rel_path, allow_escape)?;
    let metadata = fs::metadata(&path).await?;

    if metadata.is_dir() {
        fs::remove_dir_all(&path).await?;
    } else {
        fs::remove_file(&path).await?;
    }

    Ok(())
}

/// Rename/move a file or directory to a new path.
/// `new_rel_path` is the full new relative path, not just a name.
pub async fn move_path(base: &Path, old_rel: &str, new_rel: &str) -> Result<()> {
    move_path_impl(base, old_rel, new_rel, false).await
}

/// Like [`move_path`], but allows moving between paths outside `base` for
/// trusted callers (see [`sanitize_path_allow_escape`]).
pub async fn move_path_allow_escape(base: &Path, old_rel: &str, new_rel: &str) -> Result<()> {
    move_path_impl(base, old_rel, new_rel, true).await
}

async fn move_path_impl(
    base: &Path,
    old_rel: &str,
    new_rel: &str,
    allow_escape: bool,
) -> Result<()> {
    let old = sanitize_read(base, old_rel, allow_escape)?;
    let new = sanitize_new(base, new_rel, allow_escape)?;

    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::rename(&old, &new).await?;
    Ok(())
}

/// Copy files/directories to a destination directory.
pub async fn copy_paths(base: &Path, paths: &[String], dest: &str) -> Result<()> {
    copy_paths_impl(base, paths, dest, false).await
}

/// Like [`copy_paths`], but allows copying from/to paths outside `base` for
/// trusted callers (see [`sanitize_path_allow_escape`]).
pub async fn copy_paths_allow_escape(base: &Path, paths: &[String], dest: &str) -> Result<()> {
    copy_paths_impl(base, paths, dest, true).await
}

async fn copy_paths_impl(
    base: &Path,
    paths: &[String],
    dest: &str,
    allow_escape: bool,
) -> Result<()> {
    let dest_dir = sanitize_new(base, dest, allow_escape)?;

    fs::create_dir_all(&dest_dir).await?;

    for p in paths {
        let src = sanitize_read(base, p, allow_escape)?;
        let file_name = src.file_name().ok_or_else(|| anyhow!("invalid path"))?;
        let target = dest_dir.join(file_name);

        let metadata = fs::metadata(&src).await?;
        if metadata.is_dir() {
            copy_dir_recursive(&src, &target).await?;
        } else {
            fs::copy(&src, &target).await?;
        }
    }

    Ok(())
}

/// Recursively copy a directory.
async fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest).await?;
    let mut read_dir = fs::read_dir(src).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dest_path)).await?;
        } else {
            fs::copy(&src_path, &dest_path).await?;
        }
    }

    Ok(())
}

/// Search for files matching a query string.
pub async fn search_files(base: &Path, rel_path: &str, query: &str) -> Result<Vec<FileEntry>> {
    // Absolute paths (from session mode) use the path directly; relative paths join against base.
    let dir = if Path::new(rel_path).is_absolute() {
        PathBuf::from(rel_path)
    } else if rel_path.is_empty() || rel_path == "." {
        base.to_path_buf()
    } else {
        sanitize_path(base, rel_path)?
    };
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    search_recursive(&dir, &query_lower, "", &mut results, 100, 8).await?;

    Ok(results)
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".cache",
    "vendor",
];

/// Recursive search with result and depth limits.
/// `prefix` 是当前目录相对搜索根的路径（根为空串），用于填充 [`FileEntry::rel_path`]。
fn search_recursive<'a>(
    dir: &'a Path,
    query: &'a str,
    prefix: &'a str,
    results: &'a mut Vec<FileEntry>,
    max_results: usize,
    max_depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if results.len() >= max_results || max_depth == 0 {
            return Ok(());
        }

        let mut read_dir = match fs::read_dir(dir).await {
            Ok(rd) => rd,
            Err(_) => return Ok(()), // skip unreadable directories
        };

        while let Some(entry) = read_dir.next_entry().await? {
            if results.len() >= max_results {
                break;
            }

            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden dirs and common heavy directories
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }

            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };

            let meta = match fs::metadata(entry.path()).await {
                Ok(m) => m,
                Err(_) => continue, // skip inaccessible entries
            };
            let meta2 = fs::symlink_metadata(entry.path()).await;
            let is_symlink = meta2.map(|m| m.is_symlink()).unwrap_or(false);
            let is_dir = meta.is_dir();

            if name.to_lowercase().contains(query) {
                let path_type = match (is_symlink, is_dir) {
                    (true, true) => PathType::SymlinkDir,
                    (false, true) => PathType::Dir,
                    (true, false) => PathType::SymlinkFile,
                    (false, false) => PathType::File,
                };
                let mtime = meta
                    .modified()
                    .ok()
                    .or_else(|| meta.created().ok())
                    .map(|t| to_timestamp(&t))
                    .unwrap_or(0);

                results.push(FileEntry {
                    path_type,
                    name,
                    mtime,
                    size: if is_dir { 0 } else { meta.len() },
                    rel_path: Some(rel.clone()),
                });
            }

            if is_dir && !is_symlink {
                search_recursive(&entry.path(), query, &rel, results, max_results, max_depth - 1)
                    .await?;
            }
        }

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_sanitize_valid() {
        let base = Path::new("/tmp/omniterm_test");
        // sanitize_path 是“读路径”变体：被校验路径必须实际存在（sanitize_path_new 才用于创建）
        fs::create_dir_all(base.join("foo/bar")).unwrap();
        assert!(sanitize_path(base, "foo/bar").is_ok());
    }

    #[test]
    fn test_sanitize_traversal() {
        let base = Path::new("/tmp/omniterm_test");
        fs::create_dir_all(base).unwrap();
        let err = sanitize_path(base, "../../../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
    }

    #[test]
    fn test_sanitize_null_byte() {
        let base = Path::new("/tmp/omniterm_test");
        assert!(sanitize_path(base, "foo\0bar").is_err());
    }

    /// 构造 (base, outside) 夹具：两个同级目录，outside 位于 base 之外。
    fn escape_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("omniterm_fs_escape_{tag}"));
        let base = root.join("base");
        let outside = root.join("outside");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&outside).unwrap();
        (base, outside)
    }

    #[test]
    fn test_sanitize_allow_escape_reads_outside_base() {
        let (base, outside) = escape_fixture("read");
        // 严格版拒绝逃逸
        let err = sanitize_path(&base, "../outside").unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        // allow_escape 放行
        let resolved = sanitize_path_allow_escape(&base, "../outside").unwrap();
        assert_eq!(resolved, outside.canonicalize().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn test_sanitize_allow_escape_etc_passwd() {
        // 验收标准：路径存在时 "../../../etc/passwd" 放行并解析到 /etc/passwd
        let base = Path::new("/tmp/omniterm_test");
        fs::create_dir_all(base).unwrap();
        let resolved = sanitize_path_allow_escape(base, "../../../etc/passwd").unwrap();
        assert_eq!(resolved, Path::new("/etc/passwd"));
    }

    #[test]
    fn test_sanitize_new_allow_escape_creates_outside_base() {
        let (base, outside) = escape_fixture("new");
        // 严格版：父目录解析后逃逸 → 拒绝
        let err = sanitize_path_new(&base, "../outside/newfile").unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        // allow_escape：允许创建 base 之外的路径
        let target = sanitize_path_new_allow_escape(&base, "../outside/newfile").unwrap();
        assert_eq!(target, outside.join("newfile"));
    }

    /// 回归：多层缺失目录必须按原始顺序拼接（曾因 tail 漏 .rev() 变成 a/c/b）。
    #[test]
    fn test_sanitize_new_nested_missing_components_keep_order() {
        let (base, _outside) = escape_fixture("nested");
        std::fs::create_dir_all(base.join("a")).unwrap();
        let resolved = sanitize_path_new(&base, "a/b/c").unwrap();
        let expected = base.canonicalize().unwrap().join("a").join("b").join("c");
        assert_eq!(resolved, expected);
    }

    #[cfg(windows)]
    #[test]
    fn test_display_path_windows() {
        assert_eq!(display_path_str(r"\\?\G:\Codes\ot"), "G:/Codes/ot");
        assert_eq!(display_path_str(r"G:\Codes\ot"), "G:/Codes/ot");
        assert_eq!(display_path_str(r"\\?\UNC\server\share\x"), "//server/share/x");
        assert_eq!(display_path_str("G:/already/normal"), "G:/already/normal");
    }

    #[cfg(unix)]
    #[test]
    fn test_display_path_unix_passthrough() {
        assert_eq!(display_path_str("/home/user/proj"), "/home/user/proj");
    }

    // ── *_allow_escape 操作变体：严格版拒绝逃逸，allow_escape 版放行 ──

    #[tokio::test]
    async fn test_write_file_allow_escape_creates_outside_base() {
        let (base, outside) = escape_fixture("op_write");
        // 严格版拒绝逃逸写入
        let err = write_file(&base, "../outside/strict.txt", b"x").await.unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        assert!(!outside.join("strict.txt").exists());
        // allow_escape 放行
        write_file_allow_escape(&base, "../outside/allowed.txt", b"hi").await.unwrap();
        assert_eq!(fs::read_to_string(outside.join("allowed.txt")).unwrap(), "hi");
    }

    #[tokio::test]
    async fn test_delete_path_allow_escape_deletes_outside_base() {
        let (base, outside) = escape_fixture("op_delete");
        let target = outside.join("to_delete.txt");
        fs::write(&target, b"x").unwrap();
        // 严格版拒绝
        let err = delete_path(&base, "../outside/to_delete.txt").await.unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        assert!(target.exists());
        // allow_escape 放行
        delete_path_allow_escape(&base, "../outside/to_delete.txt").await.unwrap();
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn test_create_dir_allow_escape_creates_outside_base() {
        let (base, outside) = escape_fixture("op_mkdir");
        let err = create_dir(&base, "../outside/strict").await.unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        assert!(!outside.join("strict").exists());
        // allow_escape 放行
        create_dir_allow_escape(&base, "../outside/allowed").await.unwrap();
        assert!(outside.join("allowed").is_dir());
    }

    #[tokio::test]
    async fn test_move_path_allow_escape_moves_outside_base() {
        let (base, outside) = escape_fixture("op_move");
        fs::write(base.join("src.txt"), b"x").unwrap();
        // 目标在 base 外：严格版拒绝且源文件保留
        let err = move_path(&base, "src.txt", "../outside/dst.txt").await.unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        assert!(base.join("src.txt").exists());
        // allow_escape 放行
        move_path_allow_escape(&base, "src.txt", "../outside/dst.txt").await.unwrap();
        assert!(outside.join("dst.txt").exists());
        assert!(!base.join("src.txt").exists());
    }

    #[tokio::test]
    async fn test_copy_paths_allow_escape_copies_outside_base() {
        let (base, outside) = escape_fixture("op_copy");
        fs::write(base.join("a.txt"), b"x").unwrap();
        // 目标在 base 外：严格版拒绝
        let err = copy_paths(&base, &["a.txt".to_string()], "../outside").await.unwrap_err();
        assert!(err.to_string().contains("access denied: path escapes workspace root"));
        assert!(!outside.join("a.txt").exists());
        // allow_escape 放行
        copy_paths_allow_escape(&base, &["a.txt".to_string()], "../outside").await.unwrap();
        assert!(outside.join("a.txt").exists());
    }

    // ── expand_home / dir_exists ──

    #[test]
    fn test_expand_home() {
        // 无 ~ 前缀原样返回
        assert_eq!(expand_home("/home/user/proj"), "/home/user/proj");
        assert_eq!(expand_home(""), "");
        assert_eq!(expand_home("relative/path"), "relative/path");
        // 仅在路径首位的 ~ 展开（不展开中间或尾部的 ~）
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(expand_home("~"), home);
            assert_eq!(expand_home("~/proj"), format!("{home}/proj"));
        }
    }

    #[test]
    fn test_dir_exists() {
        let (base, _outside) = escape_fixture("dir_exists");
        let base_str = base.to_str().unwrap();
        assert!(dir_exists(base_str));
        assert!(!dir_exists(&format!("{base_str}/nope")));
        // 普通文件不算目录
        let f = base.join("file.txt");
        fs::write(&f, b"x").unwrap();
        assert!(!dir_exists(f.to_str().unwrap()));
    }

    // ── probe_is_utf8_text ──

    #[test]
    fn test_probe_is_utf8_text_ascii() {
        assert!(probe_is_utf8_text(b"hello world"));
        assert!(probe_is_utf8_text(b""));
    }

    #[test]
    fn test_probe_is_utf8_text_multibyte() {
        // 完整多字节字符
        assert!(probe_is_utf8_text("中文".as_bytes()));
        // 窗口末尾被截断的多字节序列 → 不应误判为二进制
        let cut = &"中文".as_bytes()[..4]; // "中"完整 + "文"的前一字节
        assert!(probe_is_utf8_text(cut));
        assert!(probe_is_utf8_text(&[0xE4, 0xB8])); // "中" 截断两字节
    }

    #[test]
    fn test_probe_is_utf8_text_binary() {
        // NUL 字节：快检命中 → 非文本（NUL 在 UTF-8 语义上合法，但二进制强信号）
        assert!(!probe_is_utf8_text(&[0x00, 0x01, 0x02]));
        // PNG 魔数含 0x89（非法单字节）→ 非文本
        assert!(!probe_is_utf8_text(b"\x89PNG\x0d\x0a\x1a\x0a"));
        // 多字节起始字节后跟非 continuation 字节（0xC3 期待 0x80-0xBF）
        assert!(!probe_is_utf8_text(&[0xC3, 0x28]));
        // 文本中混入非法字节 → 非文本
        assert!(!probe_is_utf8_text(b"abc\xffxyz"));
    }

    // ── read_text_file ──

    #[tokio::test]
    async fn test_read_text_file_utf8_vs_binary() {
        let (base, _outside) = escape_fixture("read_text_file");
        let text = base.join("a.txt");
        let bin = base.join("a.bin");
        fs::write(&text, "hello 中文").unwrap();
        fs::write(&bin, [0x89, b'P', b'N', b'G', 0x00, 0x01]).unwrap();
        assert_eq!(read_text_file(&text).await.unwrap(), Some("hello 中文".to_string()));
        assert_eq!(read_text_file(&bin).await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_read_text_file_full_null_rejected() {
        let (base, _outside) = escape_fixture("read_text_file_null");
        // 探测窗口内无 NUL 且为合法 UTF-8，但文件后部混入 NUL
        // → 全量 NULL 快检判定非文本
        let mut content = vec![b'a'; TEXT_PROBE_BYTES];
        content.push(0);
        let f = base.join("tail_null.txt");
        fs::write(&f, &content).unwrap();
        assert_eq!(read_text_file(&f).await.unwrap(), None);
    }
}
