use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::fs;

const MAX_SUBPATHS_COUNT: u64 = 1000;

/// Sanitize a requested path against a base directory.
/// Prevents directory traversal attacks. The path must already exist.
pub fn sanitize_path(base: &Path, requested: &str) -> Result<PathBuf> {
    let joined = join_and_validate(base, requested)?;

    if !joined.exists() {
        return Err(anyhow!("path does not exist: {}", joined.display()));
    }

    let canonical = joined
        .canonicalize()
        .map_err(|e| anyhow!("path resolution failed: {}", e))?;

    let canonical_base = base
        .canonicalize()
        .map_err(|e| anyhow!("base path resolution failed: {}", e))?;

    if !canonical.starts_with(&canonical_base) {
        return Err(anyhow!("access denied: path escapes workspace root"));
    }

    Ok(canonical)
}

/// Sanitize a path for creation (write, mkdir, upload).
/// Does NOT require the path to exist — only validates the parent is within base.
pub fn sanitize_path_new(base: &Path, requested: &str) -> Result<PathBuf> {
    let joined = join_and_validate(base, requested)?;

    let canonical_base = base
        .canonicalize()
        .map_err(|e| anyhow!("base path resolution failed: {}", e))?;

    // Walk up until we find an existing ancestor
    let mut check = joined.as_path();
    let mut tail = Vec::new();
    loop {
        if check.exists() {
            let canonical = check
                .canonicalize()
                .map_err(|e| anyhow!("path resolution failed: {}", e))?;
            if !canonical.starts_with(&canonical_base) {
                return Err(anyhow!("access denied: path escapes workspace root"));
            }
            let mut result = canonical;
            for component in tail {
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

/// Shared helper: strip null bytes and join against base.
fn join_and_validate(base: &Path, requested: &str) -> Result<PathBuf> {
    if requested.as_bytes().contains(&0) {
        return Err(anyhow!("invalid path: contains null byte"));
    }

    let requested_path = Path::new(requested);
    let joined = if requested_path.is_absolute() {
        let stripped = requested_path
            .strip_prefix("/")
            .unwrap_or(requested_path);
        base.join(stripped)
    } else {
        base.join(requested_path)
    };

    Ok(joined)
}

/// Path type — mirrors dufs PathType.
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

/// File/directory entry — mirrors dufs PathItem.
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path_type: PathType,
    pub name: String,
    pub mtime: u64,
    pub size: u64,
}

impl FileEntry {
    pub fn is_dir(&self) -> bool {
        self.path_type == PathType::Dir || self.path_type == PathType::SymlinkDir
    }
}

/// Convert SystemTime to unix millis (like dufs to_timestamp).
fn to_timestamp(time: &SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Normalize path separators to forward slashes (like dufs normalize_path).
fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Sort key for directory listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Mtime,
    Size,
}

/// List directory contents — modeled after dufs list_dir + to_pathitem.
pub async fn list_dir(
    base: &Path,
    rel_path: &str,
    sort: SortKey,
    desc: bool,
    include_hidden: bool,
) -> Result<Vec<FileEntry>> {
    let dir = sanitize_path(base, rel_path)?;

    let mut entries = Vec::new();
    let mut read_dir = fs::read_dir(&dir).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files unless requested
        if !include_hidden && name.starts_with('.') {
            continue;
        }

        let meta = fs::metadata(entry.path()).await?;
        let meta2 = fs::symlink_metadata(entry.path()).await?;
        let is_symlink = meta2.is_symlink();
        let is_dir = meta.is_dir();

        let path_type = match (is_symlink, is_dir) {
            (true, true) => PathType::SymlinkDir,
            (false, true) => PathType::Dir,
            (true, false) => PathType::SymlinkFile,
            (false, false) => PathType::File,
        };

        // mtime: prefer modified, fallback to created (like dufs)
        let mtime = meta
            .modified()
            .ok()
            .or_else(|| meta.created().ok())
            .map(|t| to_timestamp(&t))
            .unwrap_or(0);

        // For directories, count visible entries (like dufs)
        let size = if is_dir {
            let mut count: u64 = 0;
            if let Ok(mut sub) = fs::read_dir(entry.path()).await {
                while let Some(sub_entry) = sub.next_entry().await? {
                    let sub_name = sub_entry.file_name().to_string_lossy().to_string();
                    if !include_hidden && sub_name.starts_with('.') {
                        continue;
                    }
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

        entries.push(FileEntry {
            path_type,
            name,
            mtime,
            size,
        });
    }

    // Sort: directories first, then by chosen key (like dufs)
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

/// Read file content as UTF-8 string.
pub async fn read_file(base: &Path, rel_path: &str) -> Result<String> {
    let path = sanitize_path(base, rel_path)?;
    let content = fs::read_to_string(&path).await?;
    Ok(content)
}

/// Write content to a file. Creates the file if it doesn't exist.
pub async fn write_file(base: &Path, rel_path: &str, content: &[u8]) -> Result<()> {
    let path = sanitize_path_new(base, rel_path)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::write(&path, content).await?;
    Ok(())
}

/// Create a directory (and parents).
pub async fn create_dir(base: &Path, rel_path: &str) -> Result<()> {
    let path = sanitize_path_new(base, rel_path)?;
    fs::create_dir_all(&path).await?;
    Ok(())
}

/// Delete a file or directory.
pub async fn delete_path(base: &Path, rel_path: &str) -> Result<()> {
    let path = sanitize_path(base, rel_path)?;
    let metadata = fs::metadata(&path).await?;

    if metadata.is_dir() {
        fs::remove_dir_all(&path).await?;
    } else {
        fs::remove_file(&path).await?;
    }

    Ok(())
}

/// Rename/move a file or directory to a new path (like dufs MOVE).
/// `new_rel_path` is the full new relative path, not just a name.
pub async fn move_path(base: &Path, old_rel: &str, new_rel: &str) -> Result<()> {
    let old = sanitize_path(base, old_rel)?;
    let new = sanitize_path_new(base, new_rel)?;

    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::rename(&old, &new).await?;
    Ok(())
}

/// Copy files/directories to a destination directory.
pub async fn copy_paths(base: &Path, paths: &[String], dest: &str) -> Result<()> {
    let dest_dir = sanitize_path_new(base, dest)?;

    fs::create_dir_all(&dest_dir).await?;

    for p in paths {
        let src = sanitize_path(base, p)?;
        let file_name = src
            .file_name()
            .ok_or_else(|| anyhow!("invalid path"))?;
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

    search_recursive(&dir, &query_lower, &mut results, 100, 8).await?;

    Ok(results)
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "__pycache__", ".venv", "venv",
    ".next", ".nuxt", "dist", "build", ".cache", "vendor",
];

/// Recursive search with result and depth limits.
fn search_recursive<'a>(
    dir: &'a Path,
    query: &'a str,
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
            Err(_) => return Ok(()),  // skip unreadable directories
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

            let meta = match fs::metadata(entry.path()).await {
                Ok(m) => m,
                Err(_) => continue,  // skip inaccessible entries
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
                });
            }

            if is_dir && !is_symlink {
                search_recursive(&entry.path(), query, results, max_results, max_depth - 1).await?;
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
        fs::create_dir_all(base).unwrap();
        assert!(sanitize_path(base, "foo/bar").is_ok());
    }

    #[test]
    fn test_sanitize_traversal() {
        let base = Path::new("/tmp/omniterm_test");
        fs::create_dir_all(base).unwrap();
        assert!(sanitize_path(base, "../../../etc/passwd").is_err());
    }

    #[test]
    fn test_sanitize_null_byte() {
        let base = Path::new("/tmp/omniterm_test");
        assert!(sanitize_path(base, "foo\0bar").is_err());
    }
}
