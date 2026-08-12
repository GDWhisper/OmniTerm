//! pty 会话 ANSI 历史落盘（D5 落盘纪律，herdr persist 模式）。
//!
//! - **ANSI 与结构数据分离**：终端输出可能含密钥，只落盘 ANSI 历史本身，
//!   结构数据（cwd/命令）在 DB，两不混放；
//! - **权限 0600**、目录 0700（unix）；
//! - **tmp + rename 原子写**，不出现半截文件；
//! - 5s 去抖由引擎后台任务驱动（本模块只管单次读写）；
//! - seed 回放前做 **UTF-8 边界截断**（环形窗口按字节淘汰，可能切断多字节字符）。
//!
//! 文件布局：`~/.omniterm/pty-sessions/<session key>/history.ansi`。
//! key 为 DB session id（UUID），跨分支 DB 隔离不冲突。

use std::fs;
use std::io;
use std::path::PathBuf;

const SUBDIR: &str = "pty-sessions";
const HISTORY_FILE: &str = "history.ansi";
const TMP_FILE: &str = "history.ansi.tmp";

/// 会话历史目录（不做 key 合法性之外的路径拼接）。
fn session_dir(key: &str) -> Option<PathBuf> {
    // key 只允许 UUID 字符集，杜绝路径逃逸（S1）
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let home = home_dir()?;
    Some(home.join(".omniterm").join(SUBDIR).join(key))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

pub fn history_path(key: &str) -> Option<PathBuf> {
    session_dir(key).map(|d| d.join(HISTORY_FILE))
}

/// 原子写历史文件（tmp + rename，unix 权限 0600/目录 0700）。
pub fn save(key: &str, bytes: &[u8]) -> io::Result<()> {
    let Some(dir) = session_dir(key) else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid session key"));
    };
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }

    let tmp = dir.join(TMP_FILE);
    fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, dir.join(HISTORY_FILE))
}

/// 读历史（UTF-8 边界截断后返回）。不存在/损坏 → None。
pub fn load(key: &str) -> Option<Vec<u8>> {
    let path = history_path(key)?;
    let bytes = fs::read(path).ok()?;
    Some(trim_to_utf8_boundary(bytes))
}

/// 删除历史（会话被显式 kill 时调用）。
pub fn remove(key: &str) {
    if let Some(dir) = session_dir(key) {
        let _ = fs::remove_dir_all(dir);
    }
}

/// 丢弃头部不构成 UTF-8 字符边界的字节（窗口按字节淘汰的切口）。
/// 只处理头部：尾部切口由下次追加字节自然修复，VT 解析器也容忍。
fn trim_to_utf8_boundary(mut bytes: Vec<u8>) -> Vec<u8> {
    // UTF-8 continuation 字节形如 10xxxxxx；合法起始字节会立即终止扫描，
    // 因此头部连续的 continuation 字节必是字节级窗口切口的残片，全部丢弃
    // （单字符最多 3 个 continuation，放宽到 4 覆盖异常残片）。
    let mut skip = 0;
    while skip < bytes.len().min(4) && is_continuation(bytes[skip]) {
        skip += 1;
    }
    if skip > 0 {
        bytes.drain(..skip);
    }
    bytes
}

fn is_continuation(b: u8) -> bool {
    b & 0b1100_0000 == 0b1000_0000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_key(tag: &str) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("test-{tag}-{nanos:x}")
    }

    #[test]
    fn save_load_roundtrip() {
        let key = unique_key("rt");
        save(&key, b"hello \x1b[31mworld\x1b[0m").unwrap();
        let loaded = load(&key).expect("history must load");
        assert_eq!(loaded, b"hello \x1b[31mworld\x1b[0m");
        remove(&key);
        assert!(load(&key).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn history_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let key = unique_key("perm");
        save(&key, b"secret-ish terminal output").unwrap();
        let path = history_path(&key).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "history file must be owner-only readable");
        remove(&key);
    }

    #[test]
    fn trims_leading_utf8_continuation_bytes() {
        // 「汉」= E6 B1 89；模拟窗口切口落在字符中间（丢掉首字节 E6）
        let trimmed = trim_to_utf8_boundary(vec![0xB1, 0x89, b'o', b'k']);
        assert_eq!(trimmed, b"ok");
        // 正常开头不动
        assert_eq!(trim_to_utf8_boundary(b"ok".to_vec()), b"ok");
        assert!(trim_to_utf8_boundary(vec![0x80, 0x80, 0x80, 0x80]).is_empty());
    }

    #[test]
    fn rejects_path_traversal_keys() {
        assert!(session_dir("../evil").is_none());
        assert!(session_dir("a/b").is_none());
        assert!(session_dir("").is_none());
        assert!(history_path("..").is_none());
    }

    #[test]
    fn load_missing_is_none() {
        assert!(load(&unique_key("missing")).is_none());
    }
}
