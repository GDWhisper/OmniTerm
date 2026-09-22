//! tmux server 健康四态分类（纯函数，引擎无关）。
//!
//! 背景（`docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md` §3.3/§3.4）：
//! tmux 3.4 server 收到 SIGTERM 进入关闭流程后，被「停止 drain 但不退出」的孤儿
//! `tmux -C` 控制客户端无限期冻结（`control_all_done()` 无超时），进入「聋 server
//! （deaf server）」半死态：`server_exit=1`、accept 新连接后立即 close、所有新
//! tmux 命令稳定报 `server exited unexpectedly`。
//!
//! 四态分类（计划 P1-1）：[`ServerHealth`] = `Healthy / NoServer / Deaf / Other`。
//! **只有 `Deaf` 允许触发自愈**；`Other`（EACCES / socket 属主冲突 / tmux 缺失 /
//! psmux 等其余失败）一律不触发——误分类的尾部风险是 SIGKILL 健康 server、毁掉
//! 全部 tmux 会话与运行中 agent（计划 §5 / §7 风险表）。
//!
//! 签名判据只在 **stderr** 上取（多实现差异，AGENTS 工程准则 8）：stdout 是会话
//! 列表数据通道，会话名可为任意字符串——在 stdout 上做子串匹配会让名字恰含签名串
//! 的会话把健康 server 误判成聋（自愈误杀入口）。tmux 客户端错误（`fatalx` 族）
//! 走 stderr；若某实现（psmux 等）把错误打到 stdout，由 socket 探针
//! （[`SocketProbe::ConnectThenEof`]）兜底复核。

use std::fmt;

/// 聋签名（tmux 3.x 聋 server 判据串，事故实录见计划 §2/附录 A）。
pub const DEAF_SIGNATURE: &str = "server exited unexpectedly";

/// 无 server 判据串（tmux 3.x：`no server running on <path>`）。
pub const NO_SERVER_SIGNATURE: &str = "no server running";

/// tmux server 健康四态（计划 P1-1 失败语义分类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerHealth {
    /// 命令成功执行：server 正常应答。
    Healthy,
    /// 无 server 在听（正常空态，首条命令会自动拉起新 server）。
    NoServer,
    /// 聋 server 半死态（签名或 socket 探针实锤）——唯一允许触发自愈的状态。
    Deaf,
    /// 其余失败（EACCES / socket 属主冲突 / tmux 缺失 / psmux 等）：一律不触发自愈。
    Other,
}

impl ServerHealth {
    /// 线格式词（HTTP 契约 `GET /api/v1/tmux/health.state` 逐字固定）。
    pub fn as_str(self) -> &'static str {
        match self {
            ServerHealth::Healthy => "healthy",
            ServerHealth::NoServer => "no_server",
            ServerHealth::Deaf => "deaf",
            ServerHealth::Other => "other",
        }
    }
}

impl fmt::Display for ServerHealth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// socket 探针观测（计划 P1-1 实测口径，探针语义见 `super::probe`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketProbe {
    /// connect 成功后**立即 EOF**（read 返回 0 字节）：server accept 后立刻
    /// close（tmux `server_accept()` 的 `if (server_exit) close(newfd)` 分支）
    /// ——聋签名。
    ConnectThenEof,
    /// connect 成功且读窗口内未 EOF（阻塞无输出 / 有任意输出）——正常 server。
    /// tmux 握手由客户端先发，server 不主动发版本行，「阻塞无输出」即正常
    /// （判据勘误见计划 §10-5）。
    ConnectAlive,
    /// connect 被拒（ECONNREFUSED）/ socket 文件不存在：无 server 在听
    /// （或只剩 stale socket）。
    ConnectRefused,
    /// 其余失败（EACCES / socket 属主冲突 / connect 超时 / 平台无 unix socket）：
    /// 证据不足，一律不作自愈依据。
    Inconclusive,
}

/// `list-sessions` 非零退出分支的空态收窄判定（纯函数；真源消费方 =
/// `src/engine/tmux/mod.rs::list_sessions`，S2 禁吞异常）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListSessionsFailure {
    /// stderr 含聋签名：必须上抛 Err，**不得**归空态。
    Deaf,
    /// stderr 含 `no server running`：正常空态。
    NoServer,
    /// 空 stdout 且无签名：空态（psmux/Windows 多实现差异）。
    EmptyStdout,
    /// 其余失败：Err。
    Other,
}

/// `list-sessions` 非零退出时「归空态还是上抛 Err」的判定真源
/// （`src/engine/tmux/mod.rs::list_sessions` 失败分支收窄，S2 禁吞异常）。
///
/// 判定顺序即安全顺序：
/// 1. stderr 含聋签名 ⇒ [`ListSessionsFailure::Deaf`]——必须上抛 Err。旧判据
///    「stderr 含 no server running ∨ stdout 为空 ⇒ 无会话」会把聋 server 吞成
///    「无会话」（stdout 为空恰好成立），正是本次事故的 S2 吞异常点；
/// 2. stderr 含 `no server running` ⇒ [`ListSessionsFailure::NoServer`]（正常空态）；
/// 3. stdout 为空且无签名 ⇒ [`ListSessionsFailure::EmptyStdout`]——**保留**的
///    多实现行为（工程准则 8）：psmux/Windows 可能以非零退出 + 空 stdout 表示
///    无会话（`mod.rs` 历史注记；Windows 行为未验证，标注「不确定」）；
/// 4. 其余 ⇒ [`ListSessionsFailure::Other`]。
pub fn classify_list_sessions_failure(stdout: &str, stderr: &str) -> ListSessionsFailure {
    // 只查 stderr（见模块文档）：stdout 是数据通道，会话名可以含签名串。
    if stderr.contains(DEAF_SIGNATURE) {
        return ListSessionsFailure::Deaf;
    }
    if stderr.contains(NO_SERVER_SIGNATURE) {
        return ListSessionsFailure::NoServer;
    }
    if stdout.trim().is_empty() {
        return ListSessionsFailure::EmptyStdout;
    }
    ListSessionsFailure::Other
}

/// 四态分类器（纯函数）：命令成功与否 + stdout + stderr + 可选 socket 探针结果。
///
/// 优先级：命令成功是硬证据（socket 探针只是**失败时**的复核，矛盾组合以命令
/// 为准）→ stderr 聋签名 → stderr 无 server 签名 → socket 探针证据（立即 EOF =
/// Deaf、拒绝/不存在 = NoServer）→ 其余归 `Other`。计划 P1-1 的 Deaf 判据是
/// 「聋签名 **或** 立即 EOF」任一成立；即便两者矛盾（如签名在但探针说无 server），
/// 自愈侧仍有「重探针 + inode 反查失败即放弃击杀」兜底（`super::heal`）。
pub fn classify(
    success: bool,
    stdout: &str,
    stderr: &str,
    socket: Option<SocketProbe>,
) -> ServerHealth {
    if success {
        return ServerHealth::Healthy;
    }
    match classify_list_sessions_failure(stdout, stderr) {
        ListSessionsFailure::Deaf => ServerHealth::Deaf,
        ListSessionsFailure::NoServer => ServerHealth::NoServer,
        // 空 stdout 兜底 / 其余失败：psmux 等「其余失败」按计划归 Other（不触发
        // 自愈），但允许 socket 探针实锤把它升级为 Deaf / NoServer。
        ListSessionsFailure::EmptyStdout | ListSessionsFailure::Other => match socket {
            Some(SocketProbe::ConnectThenEof) => ServerHealth::Deaf,
            Some(SocketProbe::ConnectRefused) => ServerHealth::NoServer,
            _ => ServerHealth::Other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四态两两可分（计划 §9）：`server exited unexpectedly` ≠ `no server running`
    /// ≠ 其它失败 ≠ 成功。
    #[test]
    fn four_states_are_pairwise_distinct() {
        let deaf = classify(false, "", "tmux: server exited unexpectedly\n", None);
        let no_server = classify(false, "", "no server running on /tmp/tmux-1000/default\n", None);
        let other = classify(false, "", "error connecting to socket: Permission denied\n", None);
        let healthy = classify(true, "sess: 1 windows\n", "", None);

        assert_eq!(deaf, ServerHealth::Deaf);
        assert_eq!(no_server, ServerHealth::NoServer);
        assert_eq!(other, ServerHealth::Other);
        assert_eq!(healthy, ServerHealth::Healthy);
        assert_ne!(deaf, no_server);
        assert_ne!(deaf, other);
        assert_ne!(deaf, healthy);
        assert_ne!(no_server, other);
        assert_ne!(no_server, healthy);
        assert_ne!(other, healthy);
    }

    /// socket 探针分类（计划 P1-1 实测口径）：connect 后立即 EOF = Deaf；
    /// connect 后阻塞无输出 = 正常；connect 拒绝/文件不存在 = NoServer；
    /// 其余 = Other（不触发自愈）。
    #[test]
    fn socket_probe_results_classify_as_documented() {
        let f = |sock| classify(false, "", "", Some(sock));
        assert_eq!(f(SocketProbe::ConnectThenEof), ServerHealth::Deaf);
        assert_eq!(f(SocketProbe::ConnectRefused), ServerHealth::NoServer);
        assert_eq!(f(SocketProbe::ConnectAlive), ServerHealth::Other);
        assert_eq!(f(SocketProbe::Inconclusive), ServerHealth::Other);
        assert_eq!(classify(false, "", "", None), ServerHealth::Other, "无任何证据 ⇒ Other");
    }

    /// 命令成功是硬证据，优先于 socket 探针的矛盾观测（探针只是失败时的复核）。
    #[test]
    fn command_success_dominates_probe() {
        assert_eq!(
            classify(true, "", "", Some(SocketProbe::ConnectThenEof)),
            ServerHealth::Healthy
        );
    }

    /// `src/engine/tmux/mod.rs` 失败分支收窄（原 :208 空 stdout 兜底）：stderr
    /// 含聋签名 + 空 stdout **不得**归空态——必须判 Deaf 让上层返回 Err。
    #[test]
    fn deaf_signature_with_empty_stdout_is_not_empty_state() {
        assert_eq!(
            classify_list_sessions_failure("", "tmux: server exited unexpectedly\n"),
            ListSessionsFailure::Deaf,
            "聋签名必须压过空 stdout 兜底（S2 禁吞异常）"
        );
    }

    /// `list_sessions` 失败分支完整判定表（多实现差异注明在
    /// [`classify_list_sessions_failure`] 文档）。
    #[test]
    fn list_sessions_failure_taxonomy() {
        use ListSessionsFailure::*;
        assert_eq!(classify_list_sessions_failure("", "no server running"), NoServer);
        assert_eq!(
            classify_list_sessions_failure("", ""),
            EmptyStdout,
            "psmux/Windows 空 stdout 行为保留"
        );
        assert_eq!(
            classify_list_sessions_failure("", "weird error"),
            EmptyStdout,
            "空 stdout 且无签名 ⇒ 空态（历史行为保留）"
        );
        assert_eq!(classify_list_sessions_failure("data", "weird error"), Other);
    }

    /// 签名只在 stderr 判定：会话名恰含签名串（stdout 数据）不得把健康 server
    /// 误判成聋——那是自愈误杀健康 server 的入口。
    #[test]
    fn signature_in_stdout_data_is_not_deaf() {
        assert_eq!(
            classify_list_sessions_failure("s: 1 windows\nno server running\n", ""),
            ListSessionsFailure::Other
        );
        assert_eq!(
            classify(false, "x: server exited unexpectedly\n", "", None),
            ServerHealth::Other
        );
    }

    /// 线格式词逐字固定（HTTP 契约，前端代理并行开发中）。
    #[test]
    fn as_str_matches_http_contract_words() {
        assert_eq!(ServerHealth::Healthy.as_str(), "healthy");
        assert_eq!(ServerHealth::NoServer.as_str(), "no_server");
        assert_eq!(ServerHealth::Deaf.as_str(), "deaf");
        assert_eq!(ServerHealth::Other.as_str(), "other");
    }
}
