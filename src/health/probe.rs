//! tmux server 健康探针（引擎无关：直接跑 `tmux list-sessions`，不经引擎门面——
//! D4 冻结边界，`docs/architecture/backend.md`）。
//!
//! 探针拿到命令退出码/stdout/stderr；失败且可疑（不是明摆着的 `no server running`）
//! 时用 socket 探针复核，最后由 [`classify::classify`] 出四态。
//!
//! socket 路径（实测口径 + 多实现差异，工程准则 8）：`<base>/tmux-<uid>/default`，
//! `base` 读 `TMUX_TMPDIR` env 可覆盖（tmux(1) 文档口径），否则 `/tmp`；uid 用
//! `libc::getuid`。多实现/部署差异如实注明：
//! - 本机实测（tmux 3.4，2026-09-22）：`TMUX_TMPDIR` 指向空目录时客户端仍连到
//!   默认 socket 的 server——该变量是否参与客户端 socket 解析**存疑（不确定）**，
//!   按 tmux(1) 文档口径实现 env 覆盖；即便路径推错，分类主判据是 stderr 签名，
//!   socket 探针只是复核，最坏退化为 `Inconclusive`/`NoServer` 证据缺失，不会
//!   把非聋判成聋；
//! - `-L`/`-S` 自定义 socket 名不在探测范围（omniterm 一律用默认 socket）；
//! - Windows（psmux）无 unix domain socket 路径语义：探针明确降级为
//!   `Inconclusive` + WARN（一次性），不静默假装成功。

use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::warn;

use super::classify::{self, NO_SERVER_SIGNATURE, ServerHealth, SocketProbe};

/// socket 探针 connect 超时（命名常量，禁魔法数字）。超时归
/// [`SocketProbe::Inconclusive`]：可能是 listen backlog 满，不作自愈依据。
#[cfg(unix)]
const SOCKET_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// socket 探针「阻塞无输出 = 正常」的读窗口（命名常量）。正常 server 等客户端
/// 先发握手、窗口内无输出；聋 server accept 后立即 close ⇒ 立即 EOF。
#[cfg(unix)]
const SOCKET_SILENCE_WINDOW: Duration = Duration::from_millis(500);

/// `tmux list-sessions` 的原始观测（None = 命令未能执行，如 tmux 缺失）。
#[derive(Debug, Clone)]
pub struct CommandObservation {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// 一次健康探针的结果：判定 + 原始观测（取证/诊断用）。
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub health: ServerHealth,
    pub command: Option<CommandObservation>,
    pub socket: Option<SocketProbe>,
}

/// 跑一轮健康探针：`tmux list-sessions` →（失败且可疑时）socket 探针复核 → 四态。
pub async fn probe() -> ProbeResult {
    // 直接 tokio::process（D4：不经 engine/tmux 门面）。
    let output = tokio::process::Command::new("tmux").arg("list-sessions").output().await;
    let out = match output {
        Ok(out) => out,
        Err(e) => {
            // 命令根本没能执行（tmux 缺失 / psmux 未安装 / spawn 失败）⇒ 恒为
            // Other（计划 P1-1：tmux 缺失 = 其余失败，不触发自愈）。
            warn!(stage = "probe", error = %e, "tmux list-sessions 无法执行，判为 other（不触发自愈）");
            return ProbeResult { health: ServerHealth::Other, command: None, socket: None };
        }
    };
    let command = CommandObservation {
        success: out.status.success(),
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    };
    // 失败且可疑 = 命令失败 ∧ stderr 不是明摆着的 `no server running`（聋嫌疑 /
    // 未识别失败）时用 socket 探针复核；成功或明摆着无 server 都不必复核。
    let socket = if !command.success && !command.stderr.contains(NO_SERVER_SIGNATURE) {
        Some(socket_probe(socket_path().as_deref()).await)
    } else {
        None
    };
    let health = classify::classify(command.success, &command.stdout, &command.stderr, socket);
    ProbeResult { health, command: Some(command), socket }
}

/// tmux 默认 socket 路径（见模块文档的多实现差异注记）。
/// Windows（psmux）无 unix socket 路径语义 ⇒ `None`（探针降级）。
pub fn socket_path() -> Option<PathBuf> {
    platform::socket_path_impl()
}

/// socket 探针：connect 后看「立即 EOF / 阻塞无输出 / 拒绝」（语义见
/// [`SocketProbe`] 与计划 P1-1 实测口径）。
async fn socket_probe(path: Option<&Path>) -> SocketProbe {
    let Some(path) = path else {
        warn_platform_degraded();
        return SocketProbe::Inconclusive;
    };
    socket_probe_impl(path).await
}

/// 平台降级 WARN（一次性，避免每 30s 巡检刷屏；不静默假装成功）。
fn warn_platform_degraded() {
    static WARN_ONCE: std::sync::Once = std::sync::Once::new();
    WARN_ONCE.call_once(|| {
        warn!("socket 健康探针在本平台不可用（无 unix domain socket 路径语义），降级为 Inconclusive（不触发自愈）");
    });
}

#[cfg(unix)]
mod platform {
    use std::path::PathBuf;

    /// `<TMUX_TMPDIR|/tmp>/tmux-<uid>/default`（uid = `libc::getuid`）。
    pub fn socket_path_impl() -> Option<PathBuf> {
        let uid = unsafe { libc::getuid() };
        let base = std::env::var_os("TMUX_TMPDIR")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        Some(base.join(format!("tmux-{uid}")).join("default"))
    }
}

#[cfg(not(unix))]
mod platform {
    use std::path::PathBuf;

    /// Windows（psmux）：无 unix domain socket 路径语义，探针降级（模块文档）。
    pub fn socket_path_impl() -> Option<PathBuf> {
        None
    }
}

#[cfg(unix)]
async fn socket_probe_impl(path: &Path) -> SocketProbe {
    use tokio::io::AsyncReadExt;

    let connected =
        tokio::time::timeout(SOCKET_CONNECT_TIMEOUT, tokio::net::UnixStream::connect(path)).await;
    let mut stream = match connected {
        Err(_) => return SocketProbe::Inconclusive, // connect 超时：证据不足
        Ok(Err(e)) => {
            return match e.kind() {
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound => {
                    SocketProbe::ConnectRefused
                }
                // EACCES / socket 属主冲突等权限类失败：计划明确归「其余失败」，
                // 不作自愈依据。
                _ => SocketProbe::Inconclusive,
            };
        }
        Ok(Ok(stream)) => stream,
    };
    let mut buf = [0u8; 1];
    match tokio::time::timeout(SOCKET_SILENCE_WINDOW, stream.read(&mut buf)).await {
        Err(_) => SocketProbe::ConnectAlive, // 读窗口内无输出 = 正常（握手由客户端先发）
        Ok(Ok(0)) => SocketProbe::ConnectThenEof, // 立即 EOF = accept 后即 close = 聋签名
        Ok(Ok(_)) => SocketProbe::ConnectAlive, // 有输出 = 有活应答，同样不是聋
        Ok(Err(_)) => SocketProbe::Inconclusive,
    }
}

#[cfg(not(unix))]
async fn socket_probe_impl(_path: &Path) -> SocketProbe {
    warn_platform_degraded();
    SocketProbe::Inconclusive
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::test_support::{FakeSocketHolder, temp_dir};

    /// 真实 unix socket 探针口径（计划 §9「socket inode 反查」同族实测）：
    /// 有 server 监听、探针窗口内无输出 ⇒ ConnectAlive（正常）。
    #[cfg(unix)]
    #[tokio::test]
    async fn live_listener_probes_as_alive() {
        let holder = FakeSocketHolder::spawn("probe_alive", "tmux");
        let result = socket_probe(Some(&holder.socket_path)).await;
        assert_eq!(result, SocketProbe::ConnectAlive, "阻塞无输出 = 正常");
    }

    /// connect 拒绝（stale socket / 无 server）⇒ ConnectRefused。
    #[cfg(unix)]
    #[tokio::test]
    async fn missing_socket_probes_as_refused() {
        let dir = temp_dir("probe_refused");
        let result = socket_probe(Some(&dir.join("missing.sock"))).await;
        assert_eq!(result, SocketProbe::ConnectRefused);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 立即 EOF = 聋签名口径：server 侧 accept 后立刻 close 的对端 ⇒ ConnectThenEof。
    #[cfg(unix)]
    #[tokio::test]
    async fn accept_then_close_probes_as_eof() {
        let dir = temp_dir("probe_eof");
        let path = dir.join("s.sock");
        let listener = tokio::net::UnixListener::bind(&path).expect("bind");
        // accept 后立刻 drop = close(newfd)，精确模拟聋 server 的 server_accept 分支。
        let accept = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            drop(stream);
        });
        let result = socket_probe(Some(&path)).await;
        assert_eq!(result, SocketProbe::ConnectThenEof, "connect 成功后立即 EOF = Deaf");
        let _ = accept.await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 平台无 socket 路径（Windows 语义）⇒ Inconclusive（不作自愈依据）。
    #[tokio::test]
    async fn absent_socket_path_probes_inconclusive() {
        assert_eq!(socket_probe(None).await, SocketProbe::Inconclusive);
    }

    // 注：[`probe`] 会执行裸 `tmux list-sessions`（默认 socket）——单测刻意不调它
    // （护栏：测试禁止触碰默认 tmux socket），其判定与 [`classify::classify`] 的
    // 一致性由 classify 单测与本模块的路径注入设计保证。

    /// socket 路径形状：`<base>/tmux-<uid>/default`（uid 用 libc::getuid）。
    #[cfg(unix)]
    #[test]
    fn socket_path_shape_matches_tmux_convention() {
        let path = socket_path().expect("unix 有路径");
        let uid = unsafe { libc::getuid() };
        assert!(path.ends_with(format!("tmux-{uid}/default")), "got {}", path.display());
    }
}
