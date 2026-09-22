//! 共享测试支撑（仅 `#[cfg(test)]` 编译；参照 `src/test_utils.rs` 的共享模式，
//! 供 `health` 各模块测试复用，避免逐模块复制假进程技巧）。
//!
//! 护栏注记：所有 fixture 都指向**临时路径**的私有 unix socket，绝不触碰默认
//! tmux socket（`/tmp/tmux-<uid>/default`）；假进程不经 tmux 二进制。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::process_identity::process_identity;

/// 有界轮询等待条件成立（默认预算见调用点，25ms 轮询）。
pub fn wait_until(mut pred: impl FnMut() -> bool, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// 临时目录（tag + 测试进程 pid + uuid：并行测试不互撞）。
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omniterm_health_test_{tag}_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// 起一个 argv 结构化恰为 `["tmux","-C",…]` 的假客户端（技巧出处与两个坑见
/// `engine/tmux/client_registry.rs::tests`：bash 把 `-C`(noclobber) 吃成自己标志
/// 以保 argv 形状；命令体必须是**复合命令** `sleep N & wait`，否则
/// `bash -c '单条简单命令'` 会 exec 顶替、argv 换影）。spawn 返回 ≠ execv 换影
/// 完成，登记/断言前用 [`wait_argv0`] 有界轮询。
pub fn spawn_fake_tmux_control(sleep_secs: u32) -> Child {
    Command::new("python3")
        .args([
            "-c",
            &format!(
                "import os; os.execv('/bin/bash', ['tmux', '-C', '-c', 'sleep {sleep_secs} & wait'])"
            ),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fake tmux -C")
}

/// 有界等待 `execv` 换影完成（按目标 argv[0] 轮询，杜绝时序 flaky）。
pub fn wait_argv0(pid: u32, argv0: &str) {
    let ready = wait_until(
        || process_identity(pid).and_then(|i| i.argv.first().cloned()).as_deref() == Some(argv0),
        Duration::from_secs(5),
    );
    assert!(ready, "execv 换影超时：pid={pid} argv0 未变为 {argv0:?}");
}

/// 有界等待直系子进程退出并顺手收割（否则 SIGKILL 后留僵尸、/proc 视角进程仍在）。
pub fn wait_child_exit(child: &mut Child) -> bool {
    wait_until(|| matches!(child.try_wait(), Ok(Some(_))), Duration::from_secs(5))
}

/// 持有 LISTEN unix socket 的假进程：把 python3 复制为 `exe_basename` 再运行
/// （`/proc/<pid>/exe` 基名复核的身份真值），bind + listen 后 sleep。
/// exe_basename = "tmux" 模拟 tmux server 身份；其他名（如 "python3"）用于
/// 「身份不符必须放弃击杀」反例。
pub struct FakeSocketHolder {
    pub child: Child,
    pub socket_path: PathBuf,
    dir: PathBuf,
}

/// exec「刚写完的可执行文件」偶发 ETXTBSY（errno 26）的有界重试上限（实测：
/// 内核 7.0 上 copy→exec 存在写句柄回收与 exec 的 deny_write_access 竞态，
/// 2026-09-22 干净压测 8×30 次复现 3 次，每次都是独立文件——与调用方逻辑无关；
/// ETXTBSY 标准处理即有界重试）。
const SPAWN_BUSY_RETRIES: u32 = 40;

/// ETXTBSY 重试间隔（与 [`SPAWN_BUSY_RETRIES`] 共 2s 预算）。
const SPAWN_BUSY_BACKOFF: Duration = Duration::from_millis(50);

impl FakeSocketHolder {
    pub fn spawn(tag: &str, exe_basename: &str) -> Self {
        let dir = temp_dir(tag);
        let exe_path = dir.join(exe_basename);
        let python = which::which("python3").expect("tests require python3");
        std::fs::copy(&python, &exe_path).expect("copy python3 as fake exe");
        let socket_path = dir.join("fake.sock");
        // 路径经 Rust debug 引号成 Python 字符串字面量（临时路径只含安全字符）。
        let script = format!(
            "import socket,time;s=socket.socket(socket.AF_UNIX);s.bind({:?});s.listen(4);time.sleep(120)",
            socket_path.display().to_string()
        );
        let mut cmd = Command::new(&exe_path);
        cmd.arg("-c").arg(&script).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = None;
        for attempt in 0..SPAWN_BUSY_RETRIES {
            match cmd.spawn() {
                Ok(c) => {
                    child = Some(c);
                    break;
                }
                // copy→exec 竞态（见 SPAWN_BUSY_RETRIES 注释）：有界重试。
                Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    assert!(attempt + 1 < SPAWN_BUSY_RETRIES, "ETXTBSY 重试耗尽：{e:?}");
                    std::thread::sleep(SPAWN_BUSY_BACKOFF);
                }
                Err(e) => panic!("spawn fake socket holder: {e:?}"),
            }
        }
        let child = child.expect("fake socket holder 应已 spawn");
        let holder = Self { child, socket_path, dir };
        let bound = wait_until(|| holder.socket_path.exists(), Duration::from_secs(5));
        assert!(bound, "假 socket 未按时 bind：{}", holder.socket_path.display());
        holder
    }
}

impl Drop for FakeSocketHolder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
