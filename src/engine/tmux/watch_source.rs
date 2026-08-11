//! 引擎侧屏幕检测枚举源：一次 `list-panes -a` 拿全部会话的活动 pane。

use tokio::process::Command;

/// -F 字段分隔符。不能用控制字符（tmux 会把格式串里的非打印字节
/// 八进制转义为字面 `\037` 输出）；':' 安全：会话名禁止含 ':'（
/// session_check_name 会替换为 '_'），中间字段均为数字，自由文本的
/// pane_title 放最后由 splitn 整体保留。
const FIELD_SEP: char = ':';

pub struct PaneInfo {
    pub session: String,
    pub pane_pid: u32,
    pub activity: String,
    pub title: String,
}

pub async fn list_active_panes() -> Vec<PaneInfo> {
    let format = format!(
        "#{{session_name}}{s}#{{window_active}}{s}#{{pane_active}}{s}#{{pane_pid}}{s}#{{window_activity}}{s}#{{pane_title}}",
        s = FIELD_SEP
    );
    let output = match Command::new("tmux").args(["list-panes", "-a", "-F", &format]).output().await
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, FIELD_SEP).collect();
            if parts.len() < 6 || parts[1] != "1" || parts[2] != "1" {
                return None;
            }
            Some(PaneInfo {
                session: parts[0].to_string(),
                pane_pid: parts[3].parse().ok()?,
                activity: parts[4].to_string(),
                title: parts[5].to_string(),
            })
        })
        .collect()
}
