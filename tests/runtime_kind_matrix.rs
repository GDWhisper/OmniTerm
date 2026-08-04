//! Cross-runtime_kind verification of file endpoints.
//!
//! **不在日常开发流程**——`#[ignore]` 标记，默认 `cargo test` 跳过。
//! 触发时机见下文，运行方式见底部。
//!
//! # 何时运行
//!
//! 仅在以下**主动验证**场景跑：
//! 1. 给 `runtime_kind` 枚举加新变体（tmux → acp → ???）—— 本测试失败说明
//!    老 call site 没适配新变体
//! 2. 调查跨 runtime 的 bug（典型案例：2026-07-23 FileManager 对 ACP session
//!    返 404，commit `dde6298`）
//! 3. 审计重构是否破坏多 runtime 支持（如改了 `sessions` 表 schema、
//!    `resolve_session_base`、FileManager API 等任何"跨 runtime 假设"代码）
//!
//! 跑这个测试 ≠ 改它。改它 = 加新 runtime_kind 时加新 case。
//!
//! # 运行方式
//!
//! ```bash
//! # 1) 启动 dev server（如未运行）
//! ./dev.sh start
//!
//! # 2) 单独跑这个测试
//! cargo test --test runtime_kind_matrix -- --ignored
//!
//! # 3) 跑全部（包括 ignored）
//! cargo test -- --include-ignored
//! ```
//!
//! # 为什么 #[ignore]
//!
//! - 依赖运行中的 dev server（默认 :9777）
//! - 创建真实 session（即使测试结束会清理，中断可能残留）
//! - 慢（每个 case 一次 HTTP round-trip + 一次 sqlite3 查表）
//! - 日常 `cargo test` 跑 71 个单测已经够，不要让"按需深度验证"污染日常反馈
//!
//! # 不覆盖什么
//!
//! Bug A 类（spawn 抽象的 OS 实际状态）这里**不测**——要起真 agent + 读
//! /proc/<pid>/cwd，5-50 行模板见
//! `docs/workflows/integration-checklist.md` §A.1。需要时把模板复制到本文件
//! 或单独的 `tests/_spawn_reality_check.rs`，不要写死在 run-everything 里。
//!
//! # 触发的具体 bug 复盘
//!
//! 2026-07-23：`resolve_session_base` 写于「只有 tmux session」时代。
//! Phase 3 加 ACP runtime 时没人去 audit 它的 call site，
//! `SELECT tmux_session_name` 对 ACP session 返 NULL → 整个函数返 None →
//! `/files?session=…` 404。本测试就是为防止这类「老代码假设某 runtime 字段
//! 一定非 NULL」再发生——每加一个 runtime_kind case 跑一遍主流程。

use std::process::Command;

/// 端口。OMNITERM_TEST_PORT 可覆盖，默认 9777（与 .env.local 一致）。
fn test_port() -> String {
    std::env::var("OMNITERM_TEST_PORT").unwrap_or_else(|_| "9777".into())
}

fn api_url(path: &str) -> String {
    // 所有 OmniTerm v1 端点都在 /api/v1 前缀下
    let p = if path.starts_with('/') { path } else { "/" };
    format!("http://localhost:{}/api/v1{}", test_port(), p)
}

/// 跑 shell 命令并返回 stdout（trim）。
fn cmd_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 找到 omniterm.db 路径。优先用 DATABASE_URL，fallback 到 ~/.omniterm/<binary>.db。
fn db_path() -> String {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        // strip "sqlite:" prefix and "?mode=rwc" suffix
        let p = url.strip_prefix("sqlite:").unwrap_or(&url).split('?').next().unwrap_or(&url);
        return p.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.omniterm/{}.db", env!("CARGO_PKG_NAME"))
}

/// 创建/获取一个测试用 project。返回 project_id。
/// workspace_path 用 /tmp 下独立目录避免污染真实项目。
fn ensure_test_project(name: &str, workspace: &str) -> Option<String> {
    let db = db_path();

    // 查已存在
    let existing =
        cmd_output("sqlite3", &[&db, &format!("SELECT id FROM projects WHERE name='{name}'")])?;
    if !existing.is_empty() {
        return Some(existing);
    }

    // 不存在则创建
    let new_id = uuid_v4();
    let sql = format!(
        "INSERT INTO projects (id, name, path, created_at) VALUES ('{new_id}', '{name}', '{workspace}', datetime('now'))"
    );
    let out = Command::new("sqlite3").args([&db, &sql]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(new_id)
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("test-{nanos:x}")
}

/// 找一个 ACP-capable agent（args 含 '--acp' 或 'acp'）。
/// `agents` 表没有 runtime_kind 列，靠 args 里的 'acp' 字符串判别。
fn first_acp_agent_id() -> Option<String> {
    let db = db_path();
    let stdout = cmd_output(
        "sqlite3",
        &[&db, "SELECT id FROM agents WHERE args LIKE '%acp%' OR args LIKE '%--acp%' LIMIT 1"],
    )?;
    if stdout.is_empty() { None } else { Some(stdout) }
}

/// 调后端 API，返回 (http_code, body)。auth 用现成 session。
fn http_get(path: &str) -> Option<(u16, String)> {
    let output = Command::new("curl")
        .args(["-s", "-w", "\n__HTTP_STATUS__:%{http_code}", "-o", "-", &api_url(path)])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (body, status_line) = stdout.rsplit_once("\n__HTTP_STATUS__:")?;
    let code: u16 = status_line.trim().parse().ok()?;
    Some((code, body.to_string()))
}

fn http_post(path: &str, body: &str) -> Option<(u16, String)> {
    let output = Command::new("curl")
        .args([
            "-s",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-w",
            "\n__HTTP_STATUS__:%{http_code}",
            "-o",
            "-",
            &api_url(path),
            "-d",
            body,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (body, status_line) = stdout.rsplit_once("\n__HTTP_STATUS__:")?;
    let code: u16 = status_line.trim().parse().ok()?;
    Some((code, body.to_string()))
}

fn http_delete(path: &str) {
    let _ = Command::new("curl").args(["-s", "-X", "DELETE", &api_url(path)]).output();
}

fn auth_check() -> bool {
    // 用简单 curl 调（不分拆 body/status），认证状态有就是有。
    let output = match Command::new("curl")
        .args(["-s", "-w", "\n%{http_code}", &api_url("/auth/check")])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout.lines().next_back().unwrap_or("");
    last.trim() == "200" && stdout.contains("\"authenticated\":true")
}

fn db_exists() -> bool {
    std::path::Path::new(&db_path()).exists()
}

// ═══════════════════════════════════════════════════════════════
//  Pre-flight: 跳过条件集中处理
// ═══════════════════════════════════════════════════════════════

fn preflight() -> Option<&'static str> {
    if !db_exists() {
        return Some("omniterm.db not found");
    }
    if !auth_check() {
        return Some("dev server not authenticated (run auth/setup first)");
    }
    None
}

// ═══════════════════════════════════════════════════════════════
//  Cases
// ═══════════════════════════════════════════════════════════════

/// Case 1: ACP session 调 /files?session=… 必须 200 且 cwd = workspace_path。
/// 复盘 2026-07-23 Bug B（commit dde6298 修复）。
#[tokio::test]
#[ignore]
async fn acp_session_file_endpoint_returns_workspace_path() {
    if let Some(reason) = preflight() {
        eprintln!("SKIP: {reason}");
        return;
    }

    let workspace = format!("/tmp/omniterm-matrix-acp-{}", uuid_v4());
    std::fs::create_dir_all(&workspace).ok();
    let project_id = match ensure_test_project("matrix_acp", &workspace) {
        Some(p) => p,
        None => {
            eprintln!("SKIP: cannot ensure test project");
            return;
        }
    };
    let agent_id = match first_acp_agent_id() {
        Some(a) => a,
        None => {
            eprintln!("SKIP: no ACP-capable agent registered in agents table");
            return;
        }
    };

    // 创建 ACP session
    let body = format!(
        r#"{{"name":"matrix_test","workspace_path":"{workspace}","runtime_kind":"acp","agent_id":"{agent_id}"}}"#
    );
    let (code, body) = match http_post(&format!("/projects/{project_id}/sessions"), &body) {
        Some(r) => r,
        None => {
            eprintln!("SKIP: POST /sessions failed (server down?)");
            return;
        }
    };
    if code != 201 {
        eprintln!("SKIP: session create returned {code}: {body}");
        return;
    }
    let v: serde_json::Value = serde_json::from_str(&body).expect("parse session response");
    let session_id = v["id"].as_str().expect("session id").to_string();

    // 核心断言：调文件列表，必须 200 + cwd = workspace
    let (code, body) =
        http_get(&format!("/files?path=.&session={session_id}&workspace={project_id}&sort=name"))
            .expect("curl /files");
    assert_eq!(
        code, 200,
        "BUG REGRESSION: /files for ACP session returned {code} (expected 200).\n\
         This is the 2026-07-23 Bug B pattern — resolve_session_base likely\n\
         hardcoded tmux_session_name lookup without handling non-tmux runtimes.\n\
         Response: {body}"
    );
    let v: serde_json::Value = serde_json::from_str(&body).expect("parse files response");
    assert_eq!(
        v["cwd"].as_str(),
        Some(workspace.as_str()),
        "BUG REGRESSION: FileManager cwd {:?} != session workspace {workspace:?}",
        v["cwd"]
    );
    assert_eq!(
        v["is_outside_workspace"].as_bool(),
        Some(false),
        "BUG: is_outside_workspace should be false for ACP session on its own workspace"
    );

    // 清理
    http_delete(&format!("/sessions/{session_id}"));
    let _ = std::fs::remove_dir_all(&workspace);
}

/// Case 2: 嵌套路径 `/files?path=src&session=…` 也走同一 resolve 路径。
/// 防止有人在 fix Bug B 时只修了「根目录 .」的路径，忘了子目录也走 resolve_session_base。
#[tokio::test]
#[ignore]
async fn acp_session_file_endpoint_nested_path() {
    if let Some(reason) = preflight() {
        eprintln!("SKIP: {reason}");
        return;
    }

    let workspace = format!("/tmp/omniterm-matrix-nested-{}", uuid_v4());
    let nested = format!("{workspace}/subdir");
    std::fs::create_dir_all(&nested).ok();
    let project_id = match ensure_test_project("matrix_nested", &workspace) {
        Some(p) => p,
        None => return,
    };
    let agent_id = match first_acp_agent_id() {
        Some(a) => a,
        None => return,
    };

    let body = format!(
        r#"{{"name":"matrix_nested","workspace_path":"{workspace}","runtime_kind":"acp","agent_id":"{agent_id}"}}"#
    );
    let (code, body) = match http_post(&format!("/projects/{project_id}/sessions"), &body) {
        Some(r) => r,
        None => return,
    };
    if code != 201 {
        eprintln!("SKIP: session create returned {code}: {body}");
        return;
    }
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let session_id = v["id"].as_str().unwrap().to_string();

    let (code, body) =
        http_get(&format!("/files?path=subdir&session={session_id}&workspace={project_id}"))
            .expect("curl /files");
    assert_eq!(code, 200, "nested /files returned {code}: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["cwd"].as_str(),
        Some(nested.as_str()),
        "nested path cwd = {:?}, expected {nested:?}",
        v["cwd"]
    );

    http_delete(&format!("/sessions/{session_id}"));
    let _ = std::fs::remove_dir_all(&workspace);
}

/// Case 3: 未知 / 未来新 runtime_kind 也不应让后端整体崩溃。
/// 测"防御性"行为：post 一个 runtime_kind="unknown" 的 session（如果后端允许），
/// 至少 API 不应 500，至少 resolve_session_base 走 fallback 不死锁。
///
/// 当前后端默认 RuntimeKind 仅 `tmux` / `acp`，非法值会被 serde reject。
/// 本测试只验证「非法值不被静默接受为某个有效 runtime」——前端不会误判。
#[tokio::test]
#[ignore]
async fn invalid_runtime_kind_is_rejected_not_silently_accepted() {
    if let Some(reason) = preflight() {
        eprintln!("SKIP: {reason}");
        return;
    }

    let workspace = "/tmp/omniterm-matrix-invalid".to_string();
    std::fs::create_dir_all(&workspace).ok();
    let project_id = match ensure_test_project("matrix_invalid", &workspace) {
        Some(p) => p,
        None => return,
    };
    let agent_id = match first_acp_agent_id() {
        Some(a) => a,
        None => return,
    };

    // 故意传非法 runtime_kind
    let body = format!(
        r#"{{"name":"matrix_invalid","workspace_path":"{workspace}","runtime_kind":"docker","agent_id":"{agent_id}"}}"#
    );
    let (code, _) =
        http_post(&format!("/projects/{project_id}/sessions"), &body).expect("curl POST");

    // 后端应该拒绝（400）而不是静默接受为 default（201/200）
    assert!(
        code == 400 || code == 422,
        "invalid runtime_kind returned {code}, expected 4xx reject (not silent default)"
    );

    let _ = std::fs::remove_dir_all(&workspace);
}

/// Case 4: DELETE /projects/{id} 必须连带清理该项目下 tmux/psmux 会话的进程资源。
/// 复盘 2026-08-04 bug：`delete_project` 只删 DB 不 kill session，导致会话进程
/// 残留（Windows 上 psmux 是独立进程，症状更明显）。
#[tokio::test]
#[ignore]
async fn delete_project_kills_tmux_sessions() {
    if let Some(reason) = preflight() {
        eprintln!("SKIP: {reason}");
        return;
    }
    if cmd_output("tmux", &["list-sessions"]).is_none() {
        eprintln!("SKIP: tmux not available");
        return;
    }

    let workspace = format!("/tmp/omniterm-matrix-delproj-{}", uuid_v4());
    std::fs::create_dir_all(&workspace).ok();
    let project_id = match ensure_test_project("matrix_delproj", &workspace) {
        Some(p) => p,
        None => {
            eprintln!("SKIP: cannot ensure test project");
            return;
        }
    };

    // 创建 tmux session
    let body = format!(
        r#"{{"name":"matrix_delproj","workspace_path":"{workspace}","runtime_kind":"tmux"}}"#
    );
    let (code, body) = match http_post(&format!("/projects/{project_id}/sessions"), &body) {
        Some(r) => r,
        None => {
            eprintln!("SKIP: POST /sessions failed (server down?)");
            return;
        }
    };
    if code != 201 {
        eprintln!("SKIP: session create returned {code}: {body}");
        return;
    }
    let v: serde_json::Value = serde_json::from_str(&body).expect("parse session response");
    let tmux_name = match v["tmux_session_name"].as_str() {
        Some(n) => n.to_string(),
        None => {
            eprintln!("SKIP: session response lacks tmux_session_name");
            return;
        }
    };

    // 前序确认：session 确实存在
    let listed =
        cmd_output("tmux", &["list-sessions", "-F", "#{session_name}"]).unwrap_or_default();
    assert!(
        listed.lines().any(|l| l.trim() == tmux_name),
        "precondition: session {tmux_name} should exist in tmux"
    );

    // 删除 project（应连带清理其下所有 session 的运行时）
    http_delete(&format!("/projects/{project_id}"));

    // 核心断言：tmux/psmux 会话进程已被 kill
    let listed_after =
        cmd_output("tmux", &["list-sessions", "-F", "#{session_name}"]).unwrap_or_default();
    assert!(
        !listed_after.lines().any(|l| l.trim() == tmux_name),
        "BUG REGRESSION: deleting project left tmux session {tmux_name} alive.\n\
         delete_project must kill all sessions under the project before removing DB rows."
    );

    let _ = std::fs::remove_dir_all(&workspace);
}
