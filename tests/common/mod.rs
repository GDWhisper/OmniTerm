//! 集成测试共享工具（目录形式 `tests/common/mod.rs`，不会被 cargo 当作独立测试目标）。
//!
//! **库与端口的解析是唯一真源**：与 `dev.sh` 同源（`./.env.local`）。新增集成测试
//! 需要实例库/端口时一律用本模块，禁止各自硬编码或另写一份解析——理由见
//! `docs/dev/performance-and-safety.md` §S6 与
//! `docs/dev/debug-patterns/platform-protocol.md` 模式 11（隐式推导实例身份 +
//! 库端口错配致断言假绿，2026-09-27/28 两次真实事故的教训）。

#![allow(dead_code)] // 各测试目标只用到其中一部分；逐目标独立编译会报未使用

/// 读取 `./.env.local` 中某个键的值。
///
/// 对齐 shell `source` 语义：容忍 `export KEY=...` 前缀、跳过 `#` 注释行、
/// `trim()` 值、去成对单/双引号、重复键**取最后一行**（后者覆盖前者）。
/// 文件缺失或键不存在返回 `None`。
pub fn env_local_value(key: &str) -> Option<String> {
    let content = std::fs::read_to_string("./.env.local").ok()?;
    let mut found = None;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        // `strip_prefix(key)` 紧跟 `=` 才算命中，避免前缀相同的长键误匹配
        let Some(raw) = line.strip_prefix(key).and_then(|rest| rest.strip_prefix('=')) else {
            continue;
        };
        let value = raw.trim();
        // 容忍成对引号包裹（`BRANCH_BINARY_NAME="omniterm-dev"`）
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        found = Some(value.to_string());
    }
    found
}

/// 测试要连的实例库（sqlite URL 形式）。
///
/// 优先级：`DATABASE_URL` → `./.env.local` 的 `BRANCH_BINARY_NAME`（与 `dev.sh`
/// 同一真源：在哪个 worktree 跑测试就落哪个实例库）→ `None`。
/// 库名 sanitize：仅接受 `[A-Za-z0-9_-]+`（防 `.env.local` 塞入 `/` / `..` 拼出
/// 意外路径）；**正式版 stem `omniterm` 一律拒绝**——测试会执行 `sqlx::migrate!`，
/// 绝不能升级正式版库。
///
/// 返回 `None` 时调用方必须**带原因显式 SKIP**，禁止回退任何固定真实库。
pub fn resolve_test_db_url() -> Option<String> {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return Some(url);
    }
    let name = env_local_value("BRANCH_BINARY_NAME")?;
    let valid =
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid || name == "omniterm" {
        return None;
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    Some(format!("sqlite:{home}/.omniterm/{name}.db?mode=rwc"))
}

/// 测试要连的实例端口（字符串，由调用方 parse）。
///
/// 优先级：`OMNITERM_TEST_PORT` → `./.env.local` 的 `BACKEND_PORT` → `9777`
/// （最终兼容）。必须与 [`resolve_test_db_url`] **同源配对**使用——库与端口
/// 指向不同实例时，服务端只回「不认识的会话」错误帧、断言会恒真（假绿）。
pub fn resolve_test_port() -> String {
    std::env::var("OMNITERM_TEST_PORT")
        .ok()
        .or_else(|| env_local_value("BACKEND_PORT"))
        .unwrap_or_else(|| "9777".into())
}

/// 从 sqlite URL 提取文件路径（`sqlite:/a/b.db?mode=rwc` → `/a/b.db`），
/// 供 `sqlite3` 命令行工具使用。
pub fn db_file_path(url: &str) -> String {
    url.strip_prefix("sqlite:").unwrap_or(url).split('?').next().unwrap_or(url).to_string()
}
