//! 自管 pty 引擎（Phase 2 切片 A：常驻会话；切片 B：VT 模拟器）。
//!
//! 生命周期语义与复用器引擎对齐（计划 §1.2 "detach 不杀进程"）：
//! - 会话进程由引擎常驻持有（会话 map），**WS 断开只解绑订阅、不杀进程**；
//! - attach = 订阅输出 + 重放补屏环窗口（原始 ANSI 字节回放）；重连另有
//!   resize nudge 重绘；VT grid（wezterm-term）承担 capture/title/resize
//!   与切片 C 的 ANSI seed 回放；
//! - 子进程退出（读循环 EOF / child.wait）时自动从 map 注销（幂等、
//!   Arc 指针比对防止误删同名重建会话），下次 attach 自动重建（D5 重建
//!   语义的过渡形态）。

pub mod cwd;
pub mod ring;
pub mod session;
pub mod terminal_ws;
pub mod vt;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use portable_pty::{CommandBuilder, PtySize};
use tokio::sync::broadcast;
use tracing::{debug, info};

use crate::agent::state::AgentSnapshot;
use crate::engine::pty::ring::{ByteRing, DEFAULT_REPLAY_BYTES};
use crate::engine::pty::session::PtySession;
use crate::engine::pty::vt::VtState;
use crate::engine::pty_io;
use crate::engine::{EngineSessionInfo, SessionEngine, WatchTarget};
use crate::models::session::RuntimeKind;

/// 输出广播通道在途帧上限（P1 有界；慢消费者 Lagged 丢帧保连接）。
const OUTPUT_CHANNEL_FRAMES: usize = 256;
/// 活跃度判定窗口，与复用器 control-mode 2s 口径一致（计划 §4 多实现差异）。
const ACTIVE_WINDOW: Duration = Duration::from_secs(2);
/// 无尺寸输入时的默认视口（trait create 路径用；attach 会按客户端尺寸 resize）。
const DEFAULT_SIZE: PtySize = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };

/// 输出汇聚点：补屏环 + 广播。读循环与 attach 在同一把锁下操作，
/// 保证「快照 + 订阅」无重复无丢失（先 push 后 send，attach 先 snapshot
/// 后 subscribe，两侧被本锁串行化）。
struct Output {
    ring: ByteRing,
    tx: broadcast::Sender<Vec<u8>>,
}

struct SessionState {
    session: Arc<PtySession>,
    out: Mutex<Output>,
    /// 服务端 VT grid（capture/title/resize；切片 C 接 ANSI seed 回放）。
    vt: Mutex<VtState>,
    last_activity: Mutex<Instant>,
    /// 输出序号（agent 检测跳扫描用，等值比较语义，见 agent::watch）。
    output_seq: AtomicU64,
    size: Mutex<PtySize>,
    created: String,
    /// spawn 时的工作目录（cwd 采样不可用时的回退）。
    spawn_cwd: String,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<SessionState>>>,
}

/// 自管 pty 引擎。Clone 共享同一会话 map。
#[derive(Clone)]
pub struct PtyEngine {
    inner: Arc<Inner>,
}

impl Default for PtyEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// WS 连接持有的 attach 句柄。drop = detach（解绑订阅），不触碰会话进程。
/// Clone = 同一会话再开一个订阅（写线程用），不重放补屏。
pub struct PtyAttach {
    /// attach 时刻的补屏窗口快照（原始字节回放；VT grid 供 capture/title）。
    pub replay: Vec<u8>,
    /// 后续输出订阅。Lagged = 慢消费丢帧（补屏回放可兜底）。
    pub rx: broadcast::Receiver<Vec<u8>>,
    /// attach 的是既有会话（非本次新建）→ WS 层据此做 resize nudge 重绘。
    pub reconnected: bool,
    state: Arc<SessionState>,
}

impl Clone for PtyAttach {
    fn clone(&self) -> Self {
        let rx = self.state.out.lock().unwrap().tx.subscribe();
        Self { replay: Vec::new(), rx, reconnected: false, state: Arc::clone(&self.state) }
    }
}

impl PtyAttach {
    /// 写输入到 pty（循环写尽；master 已关闭时报错）。
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut written = 0;
        while written < data.len() {
            match self.state.session.write(&data[written..]) {
                Ok(0) => return Err(anyhow!("pty write returned 0")),
                Ok(n) => written += n,
                Err(e) => return Err(anyhow!("pty write failed: {e}")),
            }
        }
        Ok(())
    }

    /// 覆盖式 resize（最新值生效，连续 resize 天然去抖）；VT grid 同步。
    pub fn resize(&self, size: PtySize) -> Result<()> {
        self.state.session.resize(size).map_err(|e| anyhow!("pty resize failed: {e}"))?;
        self.state.vt.lock().unwrap().resize(size.rows, size.cols);
        *self.state.size.lock().unwrap() = size;
        Ok(())
    }
}

impl PtyEngine {
    pub fn new() -> Self {
        Self { inner: Arc::new(Inner { sessions: Mutex::new(HashMap::new()) }) }
    }

    /// resolve-or-create + attach。会话已存在则直接订阅（WS 层据
    /// `reconnected` 做 resize nudge 重绘）；不存在则以 `cwd`/`size` spawn。
    pub fn attach(&self, key: &str, cwd: &str, size: PtySize) -> Result<PtyAttach> {
        let (state, reconnected) = self.resolve_or_create(key, cwd, size)?;
        // 同一把锁内「先快照后订阅」：与读循环「先 push 后 send」串行，
        // 补屏与增量不重不漏。
        let (replay, rx) = {
            let g = state.out.lock().unwrap();
            (g.ring.snapshot(), g.tx.subscribe())
        };
        Ok(PtyAttach { replay, rx, reconnected, state })
    }

    fn get(&self, key: &str) -> Option<Arc<SessionState>> {
        self.inner.sessions.lock().unwrap().get(key).cloned()
    }

    /// 返回 (会话状态, 是否为既有会话)。
    fn resolve_or_create(
        &self,
        key: &str,
        cwd: &str,
        size: PtySize,
    ) -> Result<(Arc<SessionState>, bool)> {
        let mut sessions = self.inner.sessions.lock().unwrap();
        if let Some(existing) = sessions.get(key) {
            return Ok((Arc::clone(existing), true));
        }
        let state = self.spawn_session(key, cwd, size)?;
        sessions.insert(key.to_string(), Arc::clone(&state));
        info!("pty session created: {} (cwd: {}, {}x{})", key, cwd, size.cols, size.rows);
        Ok((state, false))
    }

    fn spawn_session(&self, key: &str, cwd: &str, size: PtySize) -> Result<Arc<SessionState>> {
        let mut cmd = CommandBuilder::new(if cfg!(windows) { "cmd.exe" } else { "bash" });
        cmd.cwd(cwd);
        // VERIFIED 2026-08-12: TERM 固定 xterm-256color（herdr TERM 策略），
        // 见 docs/reference/herdr-reference.md「可移植边角处理」。
        cmd.env("TERM", "xterm-256color");

        let session = Arc::new(PtySession::spawn(cmd, size).map_err(|e| anyhow!("{e}"))?);
        // VERIFIED 2026-08-12: /proc/<child_pid>/cwd == spawn cwd（child_pid 见
        // PtySession::child_pid；integration-checklist §A.1，回归测试见
        // tests::spawn_cwd_matches_requested）
        let mut reader = session.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
        let vt = VtState::new(size.rows, size.cols, Arc::clone(&session));

        let (tx, _rx) = broadcast::channel::<Vec<u8>>(OUTPUT_CHANNEL_FRAMES);
        let state = Arc::new(SessionState {
            session,
            out: Mutex::new(Output { ring: ByteRing::new(DEFAULT_REPLAY_BYTES), tx }),
            vt: Mutex::new(vt),
            last_activity: Mutex::new(Instant::now()),
            output_seq: AtomicU64::new(0),
            size: Mutex::new(size),
            created: chrono::Utc::now().to_rfc3339(),
            spawn_cwd: cwd.to_string(),
        });

        // 读循环：push 补屏环 → broadcast → feed VT grid。EOF/EIO 时注销（幂等）。
        let reader_state = Arc::clone(&state);
        let reader_inner = Arc::clone(&self.inner);
        let reader_key = key.to_string();
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        {
                            let mut g = reader_state.out.lock().unwrap();
                            g.ring.push(&chunk);
                            let _ = g.tx.send(chunk.clone()); // 无接收者时 send 报错即丢弃
                        }
                        reader_state.vt.lock().unwrap().feed(&chunk);
                        *reader_state.last_activity.lock().unwrap() = Instant::now();
                        reader_state.output_seq.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            unregister_if_same(&reader_inner, &reader_key, &reader_state);
            debug!("pty reader exited: session={reader_key}");
        });

        // child 收割：wait 检测退出（防僵尸）+ 注销。
        if let Some(mut child) = state.session.take_child() {
            let reaper_inner = Arc::clone(&self.inner);
            let reaper_state = Arc::clone(&state);
            let reaper_key = key.to_string();
            tokio::task::spawn_blocking(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                info!("pty session exited: {reaper_key} code={code:?}");
                unregister_if_same(&reaper_inner, &reaper_key, &reaper_state);
            });
        }

        Ok(state)
    }
}

/// 幂等注销：仅当 map 中该 key 仍是同一个 Arc 时移除
/// （防止误删 kill 后同名重建的新会话）。
fn unregister_if_same(inner: &Inner, key: &str, state: &Arc<SessionState>) {
    let mut sessions = inner.sessions.lock().unwrap();
    if sessions.get(key).is_some_and(|s| Arc::ptr_eq(s, state)) {
        sessions.remove(key);
    }
}

impl SessionEngine for PtyEngine {
    async fn create_session(&self, name: &str, cwd: &str, command: Option<&str>) -> Result<bool> {
        let (state, _) = self.resolve_or_create(name, cwd, DEFAULT_SIZE)?;
        if let Some(cmd) = command {
            // 与复用器 send-keys 语义一致：发命令文本 + 回车。
            let mut bytes = cmd.as_bytes().to_vec();
            bytes.push(b'\r');
            let rx = state.out.lock().unwrap().tx.subscribe();
            let attach = PtyAttach { replay: Vec::new(), rx, reconnected: false, state };
            attach.write(&bytes)?;
        }
        Ok(false) // hook 注入为 Phase 3（HTTP 信道，D7）
    }

    async fn kill_session(&self, name: &str) -> Result<()> {
        let state = self.inner.sessions.lock().unwrap().remove(name);
        let Some(state) = state else {
            // 进程已自行退出并注销——幂等成功
            return Ok(());
        };
        let pid = state.session.child_pid();
        // 三级信号升级会短暂阻塞，放阻塞池跑
        tokio::task::spawn_blocking(move || {
            if let Some(pid) = pid {
                pty_io::kill_process_escalating(pid);
            }
        })
        .await
        .map_err(|e| anyhow!("kill task join failed: {e}"))?;
        state.session.close_master();
        info!("pty session killed: {name}");
        Ok(())
    }

    async fn session_exists(&self, name: &str) -> bool {
        self.inner.sessions.lock().unwrap().contains_key(name)
    }

    async fn list_sessions(&self) -> Result<Vec<EngineSessionInfo>> {
        let sessions = self.inner.sessions.lock().unwrap();
        Ok(sessions
            .iter()
            .map(|(name, st)| {
                let attached = st.out.lock().unwrap().tx.receiver_count() > 0;
                let cwd = cwd::session_cwd(st.session.child_pid())
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| st.spawn_cwd.clone());
                EngineSessionInfo {
                    name: name.clone(),
                    attached,
                    windows: 1,
                    created: st.created.clone(),
                    cwd: Some(cwd),
                    agent_kind: None,
                    agent_state: None,
                    attention_reason: None,
                    agent_event: None,
                    agent_nonce: None,
                }
            })
            .collect())
    }

    async fn current_cwd(&self, name: &str) -> Result<String> {
        let state = self.get(name).ok_or_else(|| anyhow!("pty session '{name}' not found"))?;
        Ok(cwd::session_cwd(state.session.child_pid())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| state.spawn_cwd.clone()))
    }

    /// 服务端 VT grid 的可见屏纯文本（tmux `capture-pane -p` 等价语义）。
    async fn capture_screen(&self, name: &str) -> Result<String> {
        let state = self.get(name).ok_or_else(|| anyhow!("pty session '{name}' not found"))?;
        Ok(state.vt.lock().unwrap().capture_visible())
    }

    /// hook 信道为 Phase 3（HTTP 回调，D7）；此前仅屏幕检测覆盖 pty 会话。
    async fn agent_snapshot(&self, _name: &str) -> Result<Option<AgentSnapshot>> {
        Ok(None)
    }

    async fn is_active(&self, name: &str) -> bool {
        self.get(name)
            .is_some_and(|st| *st.last_activity.lock().unwrap() + ACTIVE_WINDOW > Instant::now())
    }

    async fn track_session(&self, _name: &str) -> Result<()> {
        Ok(()) // pty 无 control mode；读循环自带活跃度时间戳
    }

    async fn untrack_session(&self, _name: &str) {}

    async fn watch_targets(&self) -> Vec<WatchTarget> {
        let sessions = self.inner.sessions.lock().unwrap();
        sessions
            .iter()
            .map(|(name, st)| WatchTarget {
                kind: RuntimeKind::Pty,
                session: name.clone(),
                pane_pid: st.session.child_pid().unwrap_or(0),
                activity: st.output_seq.load(Ordering::Relaxed).to_string(),
                title: st.vt.lock().unwrap().title(), // OSC 0/2（VT 模拟器截获）
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> PtyEngine {
        PtyEngine::new()
    }

    async fn wait_for_output(rx: &mut broadcast::Receiver<Vec<u8>>, needle: &[u8]) -> Vec<u8> {
        let mut acc = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Ok(chunk)) => {
                    acc.extend_from_slice(&chunk);
                    if acc.windows(needle.len()).any(|w| w == needle) {
                        return acc;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => continue,
            }
        }
        acc
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn spawn_cwd_matches_requested() {
        // integration-checklist §A.1：OS 真相校验，不信"spawn 成功"返回值
        let engine = engine();
        let cwd = std::env::temp_dir();
        engine.attach("cwd-check", cwd.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let state = engine.get("cwd-check").unwrap();
        let pid = state.session.child_pid().unwrap();
        let actual = std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap();
        // /tmp 可能是符号链接（如 /private/tmp），canonicalize 后比较
        assert_eq!(std::fs::canonicalize(actual).unwrap(), std::fs::canonicalize(&cwd).unwrap());
        engine.kill_session("cwd-check").await.unwrap();
    }

    #[tokio::test]
    async fn resident_session_survives_detach_and_replays_output() {
        // 切片 A 验收：断开（drop attach）→ 重连后 shell 存活、补屏含历史输出
        let engine = engine();
        let tmp = std::env::temp_dir();

        let attach = engine.attach("reconnect", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        let writer = attach.clone();
        let mut rx = attach.rx;
        writer.write(b"echo MARKER_FIRST\n").unwrap();
        let out = wait_for_output(&mut rx, b"MARKER_FIRST").await;
        assert!(out.windows(12).any(|w| w == b"MARKER_FIRST"), "first attach saw no marker");

        drop(rx);
        drop(writer); // detach：drop 全部句柄，不杀进程

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(engine.session_exists("reconnect").await, "detach must not kill the session");

        // 重连：补屏窗口必须含断开前的输出
        let attach2 = engine.attach("reconnect", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        assert!(
            attach2.replay.windows(12).any(|w| w == b"MARKER_FIRST"),
            "replay after reconnect must contain pre-detach output"
        );

        // 重连后 shell 仍可输入
        let writer2 = attach2.clone();
        let mut rx2 = attach2.rx;
        writer2.write(b"echo MARKER_SECOND\n").unwrap();
        let out2 = wait_for_output(&mut rx2, b"MARKER_SECOND").await;
        assert!(
            out2.windows(13).any(|w| w == b"MARKER_SECOND"),
            "shell must stay interactive after reconnect"
        );

        engine.kill_session("reconnect").await.unwrap();
        assert!(!engine.session_exists("reconnect").await);
    }

    #[tokio::test]
    async fn kill_removes_session_and_terminates_process() {
        let engine = engine();
        let tmp = std::env::temp_dir();
        let attach = engine.attach("killme", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        let state = engine.get("killme").unwrap();
        let pid = state.session.child_pid().unwrap();
        drop(attach);

        engine.kill_session("killme").await.unwrap();
        assert!(!engine.session_exists("killme").await);

        // 等 reaper 收割后进程必须不存在（非僵尸）
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let alive = std::path::Path::new(&format!("/proc/{pid}")).exists();
            if !alive {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "pid {pid} survived kill");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn capture_screen_returns_clean_text_via_vt() {
        // 切片 B 验收：capture 走 VT grid，输出干净文本（无转义序列碎片）
        let engine = engine();
        let tmp = std::env::temp_dir();
        let attach = engine.attach("vt-capture", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        let writer = attach.clone();
        let mut rx = attach.rx;
        // 带颜色的输出：ANSI 经 VT 解析后不应出现在 capture
        writer.write(b"printf '\\033[1;32mVT_MARKER\\033[0m\\n'\n").unwrap();
        let out = wait_for_output(&mut rx, b"VT_MARKER").await;
        assert!(out.windows(9).any(|w| w == b"VT_MARKER"), "echo output missing");

        let cap = engine.capture_screen("vt-capture").await.unwrap();
        assert!(cap.contains("VT_MARKER"), "capture must contain the marker, got: {cap:?}");
        assert!(!cap.contains('\x1b'), "capture must not contain escape bytes");

        engine.kill_session("vt-capture").await.unwrap();
    }

    #[tokio::test]
    async fn child_exit_unregisters_session() {
        let engine = engine();
        let tmp = std::env::temp_dir();
        let attach = engine.attach("exit-self", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        attach.write(b"exit\n").unwrap();
        drop(attach);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while engine.session_exists("exit-self").await {
            assert!(tokio::time::Instant::now() < deadline, "session not unregistered after exit");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn no_fd_leak_across_create_kill_cycle() {
        // herdr backend/unix.rs:72-93 同款回归：openpty/dup 必须收支平衡
        let count_fds = || std::fs::read_dir("/proc/self/fd").unwrap().count();

        let engine = engine();
        let tmp = std::env::temp_dir();
        let baseline = count_fds();

        for i in 0..3 {
            let key = format!("fd-leak-{i}");
            let attach = engine.attach(&key, tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
            drop(attach);
            engine.kill_session(&key).await.unwrap();
        }

        // 等读循环/reaper 退出并释放各自的 clone fd
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let now = count_fds();
            if now <= baseline + 2 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fd leak: baseline={baseline}, now={now}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
