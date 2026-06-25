use std::path::{Path, PathBuf};
use anyhow::{anyhow, Result};

/// Sanitize a requested path against a base directory.
/// Prevents directory traversal attacks by canonicalizing and verifying
/// the resolved path stays within the base directory.
pub fn sanitize_path(base: &Path, requested: &str) -> Result<PathBuf> {
    let requested_path = Path::new(requested);

    // Reject paths with null bytes
    if requested.as_bytes().contains(&0) {
        return Err(anyhow!("invalid path: contains null byte"));
    }

    // Join with base and canonicalize
    // ponytail: absolute paths under base are used directly (canonicalize + starts_with still guards traversal)
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        base.join(requested_path)
    };

    // Canonicalize to resolve symlinks and '..'
    let canonical = joined.canonicalize().map_err(|e| anyhow!("path resolution failed: {}", e))?;

    // Verify the canonical path is within the base directory
    let canonical_base = base.canonicalize().map_err(|e| anyhow!("base path resolution failed: {}", e))?;

    if !canonical.starts_with(&canonical_base) {
        return Err(anyhow!("access denied: path escapes workspace root"));
    }

    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_valid_path() {
        let base = Path::new("/tmp/test_workspace");
        fs::create_dir_all(base).unwrap();
        let result = sanitize_path(base, "foo/bar.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn test_traversal_attack() {
        let base = Path::new("/tmp/test_workspace");
        fs::create_dir_all(base).unwrap();
        let result = sanitize_path(base, "../../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_null_byte() {
        let base = Path::new("/tmp/test_workspace");
        let result = sanitize_path(base, "foo\0bar");
        assert!(result.is_err());
    }
}
