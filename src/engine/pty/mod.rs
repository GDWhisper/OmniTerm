//! 自管 pty 引擎（Phase 2 切片 A：常驻会话；切片 B：VT 模拟器）。
//!
//! 生命周期语义与复用器引擎对齐（计划 §1.2 "detach 不杀进程"）：
//! - 会话进程由引擎常驻持有（会话 map），**WS 断开只解绑订阅、不杀进程**；
//! - attach = 订阅输出 + 补屏帧下发（原始字节尾进 scrollback + 清可见屏 +
//!   VT grid 重渲染当前屏，见 `vt.rs` 补屏说明）；重连另有 resize nudge
//!   重绘；VT grid（alacritty_terminal，D8 v5）承担 capture/title/
//!   render_screen/resize 与切片 C 的 ANSI seed 回放；模拟器应答
//!   （DSR/DA 等）由读循环按 attach 状态门控回写（`should_server_respond`）；
//! - 子进程退出（读循环 EOF / child.wait）时自动从 map 注销（幂等、
//!   Arc 指针比对防止误删同名重建会话），下次 attach 自动重建（D5 重建
//!   语义的过渡形态）。

pub mod agent_events;
pub mod agent_hooks;
pub mod cwd;
pub mod ring;
pub mod scrollback;
pub mod session;
pub mod terminal_ws;
pub mod vt;
pub mod frame;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use portable_pty::{CommandBuilder, PtySize};
use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

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
/// ANSI 历史去抖落盘周期（D5：herdr 5s debounce）。
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// 前台进程 cwd 采样回写周期（D5：30s；会话操作时的回写由退出 flush 覆盖）。
const CWD_SAMPLE_INTERVAL: Duration = Duration::from_secs(30);

/// 输出汇聚点：补屏环 + 广播。读循环与 attach 在同一把锁下操作，
/// 保证「快照 + 订阅」无重复无丢失（先 push 后 send，attach 先 snapshot
/// 后 subscribe，两侧被本锁串行化）。
///
/// **锁序契约：out → vt**（读循环与 attach 均按此嵌套；vt 不得反向包住
/// out）。ring 快照、grid 渲染、订阅三者在 attach 的同一临界区内完成，
/// 否则「渲染帧已含字节 X 而 rx 再投递 X」会重复、「渲染落后于快照」会缺失。
struct Output {
    ring: ByteRing,
    tx: broadcast::Sender<Vec<u8>>,
}

struct SessionState {
    session: Arc<PtySession>,
    out: Mutex<Output>,
    /// 服务端 VT grid（capture/title/resize；重建时接受 ANSI seed）。
    vt: Mutex<VtState>,
    last_activity: Mutex<Instant>,
    /// 输出序号（agent 检测跳扫描用，等值比较语义，见 agent::watch）。
    output_seq: AtomicU64,
    /// 已落盘到的 output_seq（去抖 flush 用，避免重复写盘）。
    flushed_seq: AtomicU64,
    /// 最近一次回写 DB 的 cwd（去重用）。
    last_written_cwd: Mutex<Option<String>>,
    size: Mutex<PtySize>,
    created: String,
    /// spawn 时的工作目录（cwd 采样不可用时的回退）。
    spawn_cwd: String,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<SessionState>>>,
    /// hook 信道（D7）：token 注册 + 上报 KV + 变更门铃。
    events: agent_events::AgentEventStore,
    /// 后端监听端口：spawn 时拼 `OMNITERM_HOOK_URL`（回环地址固定 127.0.0.1）。
    listen_port: u16,
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

impl PtyEngine {
    fn with_port(listen_port: u16) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                events: agent_events::AgentEventStore::new(),
                listen_port,
            }),
        }
    }

    /// 无 DB 引擎（单测用）：不落盘、不回写 cwd。
    pub fn new() -> Self {
        Self::with_port(0)
    }

    /// 生产引擎：挂 DB 并启动后台任务——
    /// ① ANSI 历史 5s 去抖落盘（D5）；② 前台 cwd 30s 采样回写 `last_cwd`。
    /// `listen_port` 用于 spawn 时注入 `OMNITERM_HOOK_URL`（hook 信道，D7）。
    pub fn with_db(db: SqlitePool, listen_port: u16) -> Self {
        let engine = Self::with_port(listen_port);
        engine.spawn_flush_task();
        engine.spawn_cwd_sampler(db);
        engine
    }

    /// hook 信道状态库句柄（HTTP 端点与 WS 推送共用）。
    pub fn agent_events(&self) -> agent_events::AgentEventStore {
        self.inner.events.clone()
    }

    /// 去抖落盘：每 [`FLUSH_INTERVAL`] 把有新输出的会话补屏环快照写盘。
    fn spawn_flush_task(&self) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(FLUSH_INTERVAL).await;
                let states: Vec<(String, Arc<SessionState>)> = inner
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), Arc::clone(v)))
                    .collect();
                for (key, state) in states {
                    flush_if_dirty(&key, &state);
                }
            }
        });
    }

    /// cwd 采样回写：每 [`CWD_SAMPLE_INTERVAL`] 采样前台进程 cwd，
    /// 变化时写 `sessions.last_cwd`（后端重启重建的落点，D5）。
    fn spawn_cwd_sampler(&self, db: SqlitePool) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(CWD_SAMPLE_INTERVAL).await;
                let states: Vec<(String, Arc<SessionState>)> = inner
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), Arc::clone(v)))
                    .collect();
                for (key, state) in states {
                    let Some(cwd) = cwd::session_cwd(state.session.child_pid()) else {
                        continue;
                    };
                    let cwd_str = cwd.to_string_lossy().into_owned();
                    if *state.last_written_cwd.lock().unwrap() == Some(cwd_str.clone()) {
                        continue;
                    }
                    // 引擎会话键存于冻结列 tmux_session_name（D10）
                    match sqlx::query(
                        "UPDATE sessions SET last_cwd = ? WHERE tmux_session_name = ?",
                    )
                    .bind(&cwd_str)
                    .bind(&key)
                    .execute(&db)
                    .await
                    {
                        Ok(_) => {
                            *state.last_written_cwd.lock().unwrap() = Some(cwd_str);
                        }
                        Err(e) => warn!("failed to write back last_cwd for {key}: {e}"),
                    }
                }
            }
        });
    }
}

/// WS 连接持有的 attach 句柄。drop = detach（解绑订阅），不触碰会话进程。
/// Clone = 同一会话再开一个订阅（写线程用），不重放补屏。
pub struct PtyAttach {
    /// attach 时刻的补屏帧（raw 尾 + 清可见屏 + grid 重渲染，见 vt.rs 补屏说明）。
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

    /// 覆盖式 resize（最新值生效，连续 resize 天然去抖）。
    pub fn resize(&self, size: PtySize) -> Result<()> {
        resize_state(&self.state, size)
    }
}

/// 覆盖式 resize：pty master + VT grid + 记录尺寸三处同步（最新值生效）。
/// 内核在尺寸未变时不发 SIGWINCH，重复调用无副作用。
fn resize_state(state: &SessionState, size: PtySize) -> Result<()> {
    state.session.resize(size).map_err(|e| anyhow!("pty resize failed: {e}"))?;
    state.vt.lock().unwrap().resize(size.rows, size.cols);
    *state.size.lock().unwrap() = size;
    Ok(())
}

impl PtyEngine {
    /// resolve-or-create + attach。会话已存在则直接订阅（WS 层据
    /// `reconnected` 做 resize nudge 重绘）；不存在则以 `cwd`/`size` spawn。
    pub fn attach(&self, key: &str, cwd: &str, size: PtySize) -> Result<PtyAttach> {
        let (state, reconnected) = self.resolve_or_create(key, cwd, size)?;
        // 视口先行同步（单视图模型：最后 attach 者决定尺寸）：补屏渲染必须
        // 按本次连接的尺寸出帧，否则断开期间窗口变宽/窄会按旧 cols 渲染。
        resize_state(&state, size)?;
        // 同一把临界区内完成「快照 + 渲染 + 订阅」（锁序 out→vt，与读循环
        // 一致）：补屏与增量不重不漏。
        let (replay, rx) = {
            let g = state.out.lock().unwrap();
            let vt = state.vt.lock().unwrap();
            let mut frame = g.ring.snapshot();
            if !frame.is_empty() {
                // 原始字节尾先进 scrollback 并恢复模式态（DECSET/alt-screen 等），
                // 再清可见屏、以 grid 为真相源重画当前屏——原始 diff 流单独回放
                // 对增量绘制的 TUI 会花屏（见 vt.rs 补屏说明）。
                frame.extend_from_slice(b"\x1b[H\x1b[2J");
                frame.extend_from_slice(&vt.render_screen());
            }
            let rx = g.tx.subscribe();
            (frame, rx)
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
        // hook 信道 env 注入（D7 herdr 三件套之一）：hook 命令引用 env，
        // 不硬编码端口/token。端点路径与 api::agent_events 路由保持一致。
        let token = self.inner.events.register(key);
        cmd.env(
            "OMNITERM_HOOK_URL",
            format!(
                "http://127.0.0.1:{}/api/v1/internal/agent-event?token={token}",
                self.inner.listen_port
            ),
        );
        cmd.env("OMNITERM_SESSION_ID", key);

        let session = Arc::new(PtySession::spawn(cmd, size).map_err(|e| anyhow!("{e}"))?);
        // VERIFIED 2026-08-12: /proc/<child_pid>/cwd == spawn cwd（child_pid 见
        // PtySession::child_pid；integration-checklist §A.1，回归测试见
        // tests::spawn_cwd_matches_requested）
        let mut reader = session.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
        // 应答回写不在模拟器内部闭环：读循环 feed 后 drain 应答并按 attach
        // 状态门控写回（D8 v5 双应答修复，见 should_server_respond）
        let vt = VtState::new(size.rows, size.cols);

        let (tx, _rx) = broadcast::channel::<Vec<u8>>(OUTPUT_CHANNEL_FRAMES);
        let state = Arc::new(SessionState {
            session,
            out: Mutex::new(Output { ring: ByteRing::new(DEFAULT_REPLAY_BYTES), tx }),
            vt: Mutex::new(vt),
            last_activity: Mutex::new(Instant::now()),
            output_seq: AtomicU64::new(0),
            flushed_seq: AtomicU64::new(0),
            last_written_cwd: Mutex::new(None),
            size: Mutex::new(size),
            created: chrono::Utc::now().to_rfc3339(),
            spawn_cwd: cwd.to_string(),
        });

        // 重建回放（D5）：后端重启/进程退出后重建时，把落盘 ANSI seed 进
        // 补屏环与 VT grid（herdr seed_history_ansi 模式）——重连即可见历史。
        if let Some(seed) = scrollback::load(key)
            && !seed.is_empty()
        {
            state.out.lock().unwrap().ring.push(&seed);
            state.vt.lock().unwrap().feed(&seed);
            // 历史里的查询（DSR 等）产生的应答不回写新 pty：重建即有客户端
            // 即将 attach，由浏览器应答（D8 v5 应答归属）
            state.vt.lock().unwrap().take_responses();
            debug!("pty session rebuilt with {} bytes of history: {key}", seed.len());
        }

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
                        // 锁序 out→vt（与 attach 一致）：ring push、广播、grid
                        // feed 原子于 attach 临界区，补屏帧不会重复或缺失字节。
                        let responses = {
                            let mut g = reader_state.out.lock().unwrap();
                            let mut vt = reader_state.vt.lock().unwrap();
                            g.ring.push(&chunk);
                            let _ = g.tx.send(chunk.clone()); // 无接收者时 send 报错即丢弃
                            vt.feed(&chunk);
                            vt.take_responses()
                        };
                        if !responses.is_empty()
                            && should_server_respond(&reader_state)
                            && let Err(e) = reader_state.session.write(&responses)
                        {
                            warn!("failed to write VT response to pty ({reader_key}): {e}");
                        }
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

/// 应答门控（D8 v5 应答归属）：DSR/DA 等查询有两个可能应答主体——浏览器
/// xterm.js（onData 回送）与服务端 VT。有客户端订阅时让浏览器应答，
/// 服务端保持沉默；detach 期间才由服务端应答，保持应答闭环。
/// 复用 `receiver_count` 作 attached 判据（`list_sessions` 同款），不新增实体。
fn should_server_respond(state: &SessionState) -> bool {
    state.out.lock().unwrap().tx.receiver_count() == 0
}

/// 幂等注销：仅当 map 中该 key 仍是同一个 Arc 时移除
/// （防止误删 kill 后同名重建的新会话）。移除前把未落盘的历史写盘
/// （自然退出保留历史供重建；显式 kill 先摘 map，不会走到这里）。
fn unregister_if_same(inner: &Inner, key: &str, state: &Arc<SessionState>) {
    let mut sessions = inner.sessions.lock().unwrap();
    if sessions.get(key).is_some_and(|s| Arc::ptr_eq(s, state)) {
        sessions.remove(key);
        inner.events.unregister(key);
        flush_if_dirty(key, state);
    }
}

/// 有新输出（output_seq 前进）时把补屏环快照写盘（D5 落盘纪律见 scrollback 模块）。
fn flush_if_dirty(key: &str, state: &SessionState) {
    let seq = state.output_seq.load(Ordering::Relaxed);
    if seq == state.flushed_seq.load(Ordering::Relaxed) {
        return;
    }
    let snapshot = state.out.lock().unwrap().ring.snapshot();
    match scrollback::save(key, &snapshot) {
        Ok(()) => {
            state.flushed_seq.store(seq, Ordering::Relaxed);
        }
        Err(e) => warn!("failed to persist pty history for {key}: {e}"),
    }
}

impl SessionEngine for PtyEngine {
    async fn create_session(&self, name: &str, cwd: &str, command: Option<&str>) -> Result<bool> {
        let (state, _) = self.resolve_or_create(name, cwd, DEFAULT_SIZE)?;
        let mut hook_injected = false;
        if let Some(cmd) = command {
            // agent CLI → 增补 hook 配置（curl 上报，D7）；与复用器引擎
            // create_session 的 hook 注入语义对齐。
            let augmented =
                agent_hooks::augment_agent_command(cmd).unwrap_or_else(|| cmd.to_string());
            hook_injected = augmented != cmd;
            // 与复用器 send-keys 语义一致：发命令文本 + 回车。
            let mut bytes = augmented.as_bytes().to_vec();
            bytes.push(b'\r');
            let rx = state.out.lock().unwrap().tx.subscribe();
            let attach = PtyAttach { replay: Vec::new(), rx, reconnected: false, state };
            attach.write(&bytes)?;
        }
        Ok(hook_injected)
    }

    async fn kill_session(&self, name: &str) -> Result<()> {
        let state = self.inner.sessions.lock().unwrap().remove(name);
        // 显式 kill 先摘 map，unregister_if_same 不会再触发，hook 信道在此清理
        self.inner.events.unregister(name);
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
        // 显式 kill = 不需要重建，落盘历史一并删除（先摘 map，退出路径不会再写回）
        scrollback::remove(name);
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

    /// hook 信道读口（D7 HookAuthority）：返回存活窗口内的最近上报；
    /// 过期/无上报返回 `None`，由屏幕检测 fallback（仲裁见 api::sessions 合并处）。
    async fn agent_snapshot(&self, name: &str) -> Result<Option<AgentSnapshot>> {
        Ok(self.inner.events.fresh_snapshot(name))
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

    #[tokio::test]
    async fn dsr_response_gated_by_attach_state() {
        // 应答归属（D8 v5）：attach 时浏览器 xterm.js 应答、服务端沉默；
        // detach 时服务端应答保持闭环。detach 期 DSR 实测走人工回归
        // （pty 行纪律回显会吞转义字节，补屏环观察不到 CPR 应答，不做 e2e）
        let engine = engine();
        let tmp = std::env::temp_dir();
        let attach = engine.attach("dsr-gate", tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        let state = engine.get("dsr-gate").unwrap();
        assert!(!should_server_respond(&state), "attached: server must stay silent");
        drop(attach);
        assert!(should_server_respond(&state), "detached: server must respond");
        engine.kill_session("dsr-gate").await.unwrap();
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
    async fn reconnect_replay_frame_reproduces_screen_exactly() {
        // 补屏验收（2026-08-22 花屏翻盘修复）：增量绘制型 TUI（绝对定位 +
        // 局部擦除）画出的屏幕，经补屏帧（raw 尾 + 清可见屏 + grid 整帧重
        // 渲染）重放到干净客户端后必须与真相源逐行一致；重复 attach 不得
        // 使 grid 漂移（resize nudge 已移除——实测 shrink→expand 会上滚一行）。
        // PS1='' + stty -echo 隔离 bash 提示/回显噪声，保证字节流确定。
        // catch_unwind 兜底：断言失败也要先杀会话再恢复 panic，
        // 否则泄漏的常驻会话让测试进程永不退出（表现为超时假死）。
        let engine = engine();
        let tmp = std::env::temp_dir();
        let size = PtySize { rows: 10, cols: 40, pixel_width: 0, pixel_height: 0 };
        let key = "replay-screen";
        let result = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(async {
            replay_screen_body(&engine, &tmp, size, key).await
        }))
        .await;
        let _ = engine.kill_session(key).await;
        result.unwrap();
    }

    async fn replay_screen_body(
        engine: &PtyEngine,
        tmp: &std::path::Path,
        size: PtySize,
        key: &str,
    ) {
        let attach = engine.attach(key, tmp.to_str().unwrap(), size).unwrap();
        let writer = attach.clone();
        writer.write(b"stty -echo; PS1=''; printf '\\033[2J\\033[1;1HAGENT PANEL v1\\033[3;1Hprogress: [####      ] 40%%\\033[5;1Hstatus: working'\n").unwrap();
        writer
            .write(b"printf '\\033[3;12H########\\033[3;24H80%%\\033[K\\033[5;1Hstatus: DONE \\033[K'\n")
            .unwrap();

        let state = engine.get(key).unwrap();
        // 等第二段 printf 执行完（注意不能拿命令回显里的字面量当标记——
        // 回显先于执行出现在 grid 上），落定后再取最终快照与光标。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let cap = state.vt.lock().unwrap().capture_visible();
            let drawn = cap.contains("progress: [########  ] 80%") && cap.contains("status: DONE");
            if drawn || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await; // 尾部字节落定
        let expected = state.vt.lock().unwrap().capture_visible();
        let expected_cursor = state.vt.lock().unwrap().renderable_cursor_for_test();

        drop(attach);

        // 第一次重连：重放帧 → 干净客户端，屏幕与光标须逐一还原
        let mut client = VtState::new(size.rows, size.cols);
        let replay1 = { engine.attach(key, tmp.to_str().unwrap(), size).unwrap() };
        client.feed(&replay1.replay);
        assert_eq!(client.capture_visible(), expected, "replayed screen diverges from server grid");
        assert_eq!(
            client.renderable_cursor_for_test(),
            expected_cursor,
            "replayed cursor diverges from server grid"
        );

        // 第二次重连（回归：nudge 曾致 grid 上滚一行、顶部混入残片）
        drop(replay1);
        let mut client2 = VtState::new(size.rows, size.cols);
        let replay2 = { engine.attach(key, tmp.to_str().unwrap(), size).unwrap() };
        client2.feed(&replay2.replay);
        assert_eq!(client2.capture_visible(), expected, "grid drifted across reconnects");
    }

    #[tokio::test]
    async fn exit_persists_history_and_rebuild_seeds_it() {
        // 切片 C 验收：自然退出落盘历史 → 重建时 seed 回补屏环与 VT grid
        let engine = engine();
        let tmp = std::env::temp_dir();
        let key = "rebuild-seed-test";

        let attach = engine.attach(key, tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        let writer = attach.clone();
        let mut rx = attach.rx;
        writer.write(b"echo REBUILD_MARK\n").unwrap();
        let out = wait_for_output(&mut rx, b"REBUILD_MARK").await;
        assert!(out.windows(12).any(|w| w == b"REBUILD_MARK"));
        writer.write(b"exit\n").unwrap();
        drop(rx);
        drop(writer);

        // 等注销 + 退出 flush 落盘
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while engine.session_exists(key).await {
            assert!(tokio::time::Instant::now() < deadline, "session not unregistered");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let persisted = scrollback::load(key).expect("history must be persisted on exit");
        assert!(
            persisted.windows(12).any(|w| w == b"REBUILD_MARK"),
            "persisted history must contain the output"
        );

        // 重建：补屏回放与 capture 都带历史
        let attach2 = engine.attach(key, tmp.to_str().unwrap(), DEFAULT_SIZE).unwrap();
        assert!(
            attach2.replay.windows(12).any(|w| w == b"REBUILD_MARK"),
            "rebuild replay must be seeded from persisted history"
        );
        let cap = engine.capture_screen(key).await.unwrap();
        assert!(cap.contains("REBUILD_MARK"), "rebuild capture must see seeded history");

        // 显式 kill：历史文件一并删除（不需要重建）
        engine.kill_session(key).await.unwrap();
        assert!(scrollback::load(key).is_none(), "kill must remove persisted history");
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
        // 自然退出会落盘历史（供重建）；测试收尾清掉
        scrollback::remove("exit-self");
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
