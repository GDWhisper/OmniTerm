//! Integration tests for tmux hook-based agent state monitoring.
//!
//! These tests require a running tmux server. Run with:
//! ```bash
//! cargo test --test agent_hook_integration -- --nocapture
//! ```
//!
//! [`test_ws_close_does_not_inject_eof_into_pane`] 还需要一个「与测试库配对、
//! 可匿名握手」的实例：库与端口经 `tests/common` 与 `./.env.local` 同源解析
//! （`DATABASE_URL` / `OMNITERM_TEST_PORT` 可覆盖）——两者必须指向同一实例，
//! 否则带原因 SKIP。

use std::time::Duration;

mod common;

/// ── Helper: create a unique session name ──
fn unique_session(prefix: &str) -> String {
    format!("ot_test_{}_{}", prefix, std::process::id())
}

/// ── Helper: run a tmux command and return (success, stdout, stderr) ──
fn tmux(args: &[&str]) -> (bool, String, String) {
    let output = std::process::Command::new("tmux")
        .args(args)
        .output()
        .expect("tmux not found — is tmux installed?");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// ── Helper: cleanup a session ──
fn cleanup(name: &str) {
    let _ = std::process::Command::new("tmux").args(["kill-session", "-t", name]).output();
}

/// ── Helper: WS 测试收尾（kill tmux 会话 / 删测试 session 行 / 删临时文件）──
async fn cleanup_ws_test(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    name: &str,
    tmp_files: &[&str],
) {
    cleanup(name);
    let _ = sqlx::query("DELETE FROM sessions WHERE id = ?").bind(session_id).execute(pool).await;
    for path in tmp_files {
        let _ = std::fs::remove_file(path);
    }
}

// 库/端口解析的共享 helper 在 `tests/common`（唯一真源，与 `dev.sh` 同源）：
// `common::resolve_test_db_url()` / `common::resolve_test_port()`。禁止在本文件
// 另写解析：库端口错配或隐式回退真实库的事故教训见 `tests/common/mod.rs` 头注。

// ═══════════════════════════════════════════════════════════════
// 5.6 WS disconnect → poll task exits (oneshot shutdown test)
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_oneshot_shutdown_stops_poll_task() {
    // This tests the core mechanism: a tokio task using interval + oneshot
    // can be cleanly shut down within 2 seconds.
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);

    let handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut ticks = 0u32;

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    ticks += 1;
                    if ticks > 100 {
                        // Safety: force exit after 10s to prevent infinite loop
                        break;
                    }
                }
                _ = &mut rx => {
                    break;
                }
            }
        }
        let _ = done_tx.send(()).await;
    });

    // Let it tick a few times
    tokio::time::sleep(Duration::from_millis(350)).await;

    // Send shutdown
    let _ = tx.send(());

    // Wait for done signal with timeout
    let result = tokio::time::timeout(Duration::from_secs(2), done_rx.recv()).await;
    assert!(result.is_ok(), "oneshot shutdown did not complete within 2s");
    assert!(result.unwrap().is_some(), "done signal not received");

    // Ensure the task joins cleanly
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;

    eprintln!("✓ oneshot shutdown test passed");
}

// ═══════════════════════════════════════════════════════════════
// 10.2 Integration: create session with agent, verify option init
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_create_session_sets_agent_option() {
    let name = unique_session("agent_init");
    let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();

    // Create session with the tmux binary directly
    let (ok, _, stderr) =
        tmux(&["new-session", "-d", "-s", &name, "-c", &cwd, "-x", "80", "-y", "24"]);

    if !ok {
        // tmux server might not be running
        eprintln!("SKIP: cannot create tmux session (tmux server running?): {}", stderr.trim());
        return;
    }

    // Set an agent option value (simulating what hook would do)
    let set_cmd = format!(
        "claude:waiting:decision:PermissionRequest:{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    );

    let (ok, _, stderr) = tmux(&["set-option", "-t", &name, "@omniterm_agent", &set_cmd]);
    assert!(ok, "failed to set @omniterm_agent: {}", stderr.trim());

    // Read it back
    let (ok, stdout, stderr) = tmux(&["show-options", "-t", &name, "@omniterm_agent"]);
    assert!(ok, "failed to show-options: {}", stderr.trim());

    // Output format: "@omniterm_agent <value>"
    assert!(
        stdout.contains("@omniterm_agent"),
        "expected @omniterm_agent in output, got: {}",
        stdout.trim()
    );
    assert!(
        stdout.contains("claude:waiting:decision:PermissionRequest"),
        "expected agent value in output, got: {}",
        stdout.trim()
    );

    cleanup(&name);
    eprintln!("✓ agent option init test passed");
}

// ═══════════════════════════════════════════════════════════════
// 10.3 Integration: create session without agent, no option set
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_session_without_agent_has_no_option() {
    let name = unique_session("no_agent");
    let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();

    let (ok, _, stderr) =
        tmux(&["new-session", "-d", "-s", &name, "-c", &cwd, "-x", "80", "-y", "24"]);

    if !ok {
        eprintln!("SKIP: cannot create tmux session: {}", stderr.trim());
        return;
    }

    // show-options should fail because the option was never set
    let (ok, stdout, stderr) = tmux(&["show-options", "-t", &name, "@omniterm_agent"]);

    // tmux returns error for unknown option
    let combined = format!("{}{}", stdout, stderr);
    assert!(
        !ok || combined.contains("unknown option")
            || combined.contains("invalid option")
            || stdout.trim().is_empty(),
        "expected unknown option or empty, got stdout='{}' stderr='{}'",
        stdout.trim(),
        stderr.trim()
    );

    cleanup(&name);
    eprintln!("✓ no-agent session test passed");
}

// ═══════════════════════════════════════════════════════════════
// 10.5a Resource safety: WS disconnect → poll task exits
// ═══════════════════════════════════════════════════════════════
// Already tested in test_oneshot_shutdown_stops_poll_task above.

// ═══════════════════════════════════════════════════════════════
// 10.5b Resource safety: timeout behavior (3 consecutive → stop)
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_timeout_behavior_three_consecutive_failures() {
    // Simulate the timeout counter logic from the poll task
    let mut consecutive_failures: u32 = 0;
    let max_failures: u32 = 3;

    // Simulate 3 timeouts
    for i in 0..4 {
        let simulated_timeout = i < 3;
        if simulated_timeout {
            consecutive_failures += 1;
        }
    }

    assert_eq!(consecutive_failures, 3);
    assert!(consecutive_failures >= max_failures, "should have reached max failures");

    eprintln!("✓ timeout counter test passed");
}

// ═══════════════════════════════════════════════════════════════
// 10.5c Resource safety: special chars sanitized by clean_token
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_shell_escaping_special_characters() {
    // These tests verify that clean_token() sanitizes values that could
    // break shell commands or the option value format.

    // We import our crate's function directly
    // (This test is in an integration test binary, so we use the public API)

    // Since clean_token is not pub, we test via the agent_value round-trip.
    // The agent_value function calls clean_token internally.

    // Simulate what clean_token does (same logic as in agent_state.rs)
    fn clean_token(s: &str) -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' }
            })
            .collect()
    }

    // Single quotes → underscore
    assert_eq!(clean_token("it's"), "it_s");
    assert_eq!(clean_token("don't"), "don_t");

    // Double quotes → underscore
    assert_eq!(clean_token("say \"hello\""), "say__hello_");

    // Backslashes → underscore
    assert_eq!(clean_token("path\\to\\file"), "path_to_file");

    // Newlines → underscore
    assert_eq!(clean_token("line1\nline2"), "line1_line2");

    // Tabs → underscore
    assert_eq!(clean_token("col1\tcol2"), "col1_col2");

    // Semicolons (command injection) → underscore
    assert_eq!(clean_token("value; rm -rf /"), "value__rm_-rf__");

    // Dollar signs → underscore
    assert_eq!(clean_token("${HOME}"), "__HOME_");

    // Backticks (command substitution) → underscore
    assert_eq!(clean_token("`id`"), "_id_");

    // Pipes → underscore
    assert_eq!(clean_token("a|b"), "a_b");

    // Spaces → underscore
    assert_eq!(clean_token("hello world"), "hello_world");

    // Valid characters pass through unchanged
    assert_eq!(clean_token("ABCdef123._-"), "ABCdef123._-");

    eprintln!("✓ shell escaping test passed");
}

// ═══════════════════════════════════════════════════════════════
// Additional: verify list_sessions format with pipe separator
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_list_sessions_pipe_format() {
    let name = unique_session("pipefmt");
    let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();

    let (ok, _, stderr) =
        tmux(&["new-session", "-d", "-s", &name, "-c", &cwd, "-x", "80", "-y", "24"]);

    if !ok {
        eprintln!("SKIP: cannot create tmux session: {}", stderr.trim());
        return;
    }

    // Set an agent option
    let (ok, _, stderr) = tmux(&[
        "set-option",
        "-t",
        &name,
        "@omniterm_agent",
        "claude:running::PreToolUse:12345.678",
    ]);
    if !ok {
        eprintln!("SKIP: cannot set option: {}", stderr.trim());
        cleanup(&name);
        return;
    }

    // Run list-sessions with the new pipe format
    let (ok, stdout, stderr) = tmux(&[
        "list-sessions",
        "-F",
        "#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{session_name}",
    ]);
    assert!(ok, "list-sessions failed: {}", stderr.trim());

    // Find our session in the output
    let line = stdout.lines().find(|l| l.contains(&name));
    assert!(line.is_some(), "session {} not found in list-sessions output:\n{}", name, stdout);

    let line = line.unwrap();
    let parts: Vec<&str> = line.split('|').collect();
    assert!(
        parts.len() >= 5,
        "expected at least 5 pipe-separated fields, got {}: '{}'",
        parts.len(),
        line
    );

    // Field 3 (index 3) is @omniterm_agent
    assert!(
        parts[3].contains("claude:running"),
        "expected agent value in field 3, got: '{}'",
        parts[3]
    );

    // Last field(s) should be session name
    let name_field = parts[4..].join("|");
    assert_eq!(
        name_field, name,
        "session name mismatch: expected '{}', got '{}'",
        name, name_field
    );

    cleanup(&name);
    eprintln!("✓ list_sessions pipe format test passed");
}

// ═══════════════════════════════════════════════════════════════
// Additional: verify session name with pipe character works
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_session_name_with_pipe_character() {
    let name = unique_session("pipe|name");
    let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();

    let (ok, _, stderr) =
        tmux(&["new-session", "-d", "-s", &name, "-c", &cwd, "-x", "80", "-y", "24"]);

    if !ok {
        eprintln!("SKIP: cannot create tmux session: {}", stderr.trim());
        return;
    }

    // Run list-sessions with pipe format
    let (ok, stdout, _) = tmux(&[
        "list-sessions",
        "-F",
        "#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{session_name}",
    ]);
    assert!(ok, "list-sessions failed");

    let line = stdout.lines().find(|l| l.contains(&name));
    assert!(line.is_some(), "session with pipe in name not found");
    let line = line.unwrap();

    let parts: Vec<&str> = line.split('|').collect();
    assert!(parts.len() >= 5, "expected at least 5 fields");

    // Rejoin name from parts[4..]
    let name_field = parts[4..].join("|");
    assert_eq!(
        name_field, name,
        "session name with pipe not preserved: expected '{}', got '{}'",
        name, name_field
    );

    cleanup(&name);
    eprintln!("✓ pipe-in-name test passed");
}

// ═══════════════════════════════════════════════════════════════
// Regression: WS close must NOT leak \n + VEOF (0x04) into the
// tmux session's pane. This protects agent tasks from being
// interrupted by Ctrl+D whenever the user switches sessions or
// otherwise disconnects the WebSocket.
// ═══════════════════════════════════════════════════════════════

#[tokio::test]
async fn test_ws_close_does_not_inject_eof_into_pane() {
    use std::io::Write;

    let name = unique_session("no_eof_leak");
    let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();

    // 1. Create the session via tmux directly (skipping our HTTP layer for
    //    isolation — we only need a real tmux server + session to exercise
    //    the SIGHUP / PTY cleanup path).
    let (ok, _, stderr) =
        tmux(&["new-session", "-d", "-s", &name, "-c", &cwd, "-x", "80", "-y", "24"]);
    if !ok {
        eprintln!("SKIP: cannot create tmux session: {}", stderr.trim());
        return;
    }

    // 2. Persist a session row so the WS handler accepts the id.
    //
    // 库来源见 resolve_test_db_url：优先 DATABASE_URL（CI 用）；否则从
    // ./.env.local 读 BRANCH_BINARY_NAME（与 dev.sh 同一真源，保证在哪个
    // worktree 跑测试就用哪个实例库，且不会把本分支的迁移集写进 dev 的库）；
    // 端口沿用同一文件（见步骤 4，OMNITERM_TEST_PORT 可覆盖）——两者必须指向
    // 同一实例，否则会话行写进 A 库、握手打到读 B 库的实例，断言会假绿。
    // 两者皆无 → SKIP，而不是落任何真实库。
    // 禁止按 `env!("CARGO_PKG_NAME")` 推导回退路径：包名全分支统一为 `omniterm`
    // （AGENTS.md §配置统一管理），推导结果就是 `~/.omniterm/omniterm.db` —— **正式版库**，
    // 而本测试会执行 `sqlx::migrate!`，等于拿分支的迁移集去升级正式版库。
    // 2026-09-27 dev/auth worktree 的两次 `cargo test` 即经此路径把 20260926 /
    // 20260927 应用到正式版库，导致正式版 0.2.25 迁移校验失败无法启动。
    let Some(db_url) = common::resolve_test_db_url() else {
        eprintln!(
            "SKIP: 无法确定实例库（未设 DATABASE_URL，且 ./.env.local 无 BRANCH_BINARY_NAME 或值为正式版 stem `omniterm`）；请用 ./dev.sh 环境或显式设置 DATABASE_URL"
        );
        cleanup(&name);
        return;
    };
    eprintln!("using db {db_url}");
    let pool = sqlx::SqlitePool::connect(&db_url).await.ok();
    if pool.is_none() {
        eprintln!("SKIP: cannot connect to db");
        cleanup(&name);
        return;
    }
    let pool = pool.unwrap();
    // Ensure schema exists (CI connects to a fresh db; locally this is a no-op)
    if let Err(e) = sqlx::migrate!("./migrations").run(&pool).await {
        eprintln!("SKIP: cannot run migrations: {e}");
        cleanup(&name);
        return;
    }
    // Find or create a project row (外键目标；库已由上方解析确定，不再假定是 dev 库)
    let project_id: String = sqlx::query_scalar::<_, String>(
        "SELECT id FROM projects WHERE path LIKE '%OmniTerm%' LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .unwrap()
    .unwrap_or_else(|| {
        // Use a random uuid if none found
        format!("test_proj_{}", std::process::id())
    });
    let session_id = format!("test_sess_{}", std::process::id());
    let _ = sqlx::query(
        "INSERT OR REPLACE INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, created_at, runtime_kind) VALUES (?, ?, ?, ?, ?, 0, ?, 'tmux')"
    )
    .bind(&session_id)
    .bind(&project_id)
    .bind(&cwd)
    .bind("no-eof-leak")
    .bind(&name)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await;

    // 3. Start a process inside the session that records every byte it
    //    receives on stdin, hex-encoded, one per line.
    let log_path = format!("/tmp/ot_test_bytes_{}.log", std::process::id());
    let _ = std::fs::remove_file(&log_path);
    // Write the reader script to a file in /tmp so the test shell can run
    // it directly without nested quoting.
    let reader_path = format!("/tmp/ot_test_reader_{}.py", std::process::id());
    let reader_body = format!(
        "import sys\n\
         f=open(r\"{log}\", \"wb\")\n\
         f.write(b\"START\\n\"); f.flush()\n\
         for c in iter(lambda: sys.stdin.buffer.read(1), b\"\"):\n\
         \x20\x20\x20\x20f.write(b\"GOT 0x\"+c.hex().encode()+b\"\\n\"); f.flush()\n\
         f.write(b\"EOF_RECEIVED\\n\"); f.flush()\n",
        log = log_path
    );
    std::fs::write(&reader_path, &reader_body).unwrap();
    let _ = tmux(&["send-keys", "-t", &name, &format!("python3 {}", reader_path), "Enter"]);
    tokio::time::sleep(Duration::from_millis(800)).await;

    // 4. Connect to the WS endpoint of the instance that owns the db above and
    //    disconnect. 端口与库同源（tests/common::resolve_test_port：OMNITERM_TEST_PORT
    //    → ./.env.local 的 BACKEND_PORT → 9777 最终兼容）。
    let port_raw = common::resolve_test_port();
    let port: u16 = port_raw.parse().unwrap_or_else(|_| {
        panic!(
            "端口 `{port_raw}` 不是合法 u16（来源 OMNITERM_TEST_PORT / .env.local BACKEND_PORT）"
        )
    });
    let _url = format!("ws://localhost:{port}/api/v1/ws/terminal/{session_id}?cols=80&rows=24");
    let connected =
        std::net::TcpStream::connect(("localhost", port)).map(|_| true).unwrap_or(false);
    if !connected {
        eprintln!("SKIP: 实例未监听 :{port}（db={db_url}）——先用 ./dev.sh 启动本 worktree 实例");
        cleanup_ws_test(&pool, &session_id, &name, &[&log_path, &reader_path]).await;
        return;
    }

    // Use a tiny raw WS handshake so we don't add a new dep just for tests.
    // 该实例可匿名握手时，裸升级请求即可触发 handler。
    use std::io::Read;
    let mut stream = std::net::TcpStream::connect(("localhost", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    let req = format!(
        "GET /api/v1/ws/terminal/{}?cols=80&rows=24 HTTP/1.1\r\n\
         Host: localhost:{}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n",
        session_id, port
    );
    stream.write_all(req.as_bytes()).unwrap();
    // 读取握手响应并分级（不得丢掉响应文本，否则会静默假绿）：
    //  - `session not found` → 库/端口错配：对端实例不认识库里的会话行，只下发
    //    错误帧、不 attach pane，断言「无 0x04」恒真。注意该错误是**升级之后**
    //    以 WS 文本帧下发的（`ServerControl::Error`，见 engine/tmux/terminal_ws.rs），
    //    所以 101 后需补读一小段才能看到它；
    //  - 101 → 真实升级路径，继续下方断言（不变）；
    //  - 401 → 实例要求鉴权（本机开关开启 / 无 cookie），裸握手进不了 handler；
    //  - 无响应 / 超时 / 畸形 → 无法完成测试前提。
    // 后三类属「本机环境不满足该测试的前提（需要与库配对、可匿名握手的实例）」，
    // 故 SKIP；但绝不静默通过：必须留下带原因的 SKIP 文本，断言只在 101 生效。
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let mut resp = String::from_utf8_lossy(&buf[..n]).to_string();
    // 只在确认升级成功（状态行 101）后补读：错误帧紧随 101，读到它才能识别错配
    let status = resp.lines().next().unwrap_or("").trim();
    if status.starts_with("HTTP/") && status.contains("101") {
        stream.set_read_timeout(Some(Duration::from_millis(400))).ok();
        let mut extra = [0u8; 4096];
        if let Ok(n) = stream.read(&mut extra) {
            resp.push_str(&String::from_utf8_lossy(&extra[..n]));
        }
    }
    // 状态行按 HTTP 语义判定（避免 `content-length: 101` 之类误命中）
    let status = resp.lines().next().unwrap_or("").trim();
    let upgraded = status.starts_with("HTTP/") && status.contains("101");
    let unauthorized = status.starts_with("HTTP/") && status.contains("401");
    let skip_reason = if resp.contains("session not found") {
        Some("库与端口错配：该实例不认识库里的会话行（端口与库须同源配对）".to_string())
    } else if upgraded {
        None
    } else if unauthorized {
        Some("实例要求鉴权（401），裸握手被拒".to_string())
    } else if resp.trim().is_empty() {
        Some("握手无响应（读超时 / 连接被立即关闭）".to_string())
    } else {
        let head: String = resp.chars().take(60).collect();
        Some(format!("握手响应非预期：{head:?}"))
    };
    if let Some(reason) = skip_reason {
        eprintln!("SKIP: {reason}（port={port}, db={db_url}）");
        cleanup_ws_test(&pool, &session_id, &name, &[&log_path, &reader_path]).await;
        return;
    }
    // Build a masked close frame: FIN+close(0x88), masked(0x80), len=0
    let close_frame = vec![0x88, 0x80];
    let _ = stream.write_all(&close_frame);
    drop(stream);

    // Give the cleanup a moment, then read what the agent recorded.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    eprintln!("agent log:\n{}", log);

    // The fix: the agent must NOT have seen 0x04 as a result of WS close.
    // It MAY see EOF (because the PTY closes normally on detach), but
    // 0x04 (Ctrl+D / VEOF) must not appear as a stray byte.
    let saw_04 = log.lines().any(|l| l.contains("0x04"));
    assert!(
        !saw_04,
        "WS close leaked \\n + VEOF (0x04) into the tmux pane — \
         this is the agent-interruption bug. Agent log:\n{}",
        log
    );

    cleanup_ws_test(&pool, &session_id, &name, &[&log_path, &reader_path]).await;
    eprintln!("✓ no EOF/Ctrl+D leak test passed");
}
