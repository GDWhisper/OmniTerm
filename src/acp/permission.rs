use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::Responder;
use agent_client_protocol::schema::v1::{
    PermissionOptionId, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct PermissionRequestEvent {
    pub id: String,
    pub request: serde_json::Value,
}

/// 未决审批：应答句柄 + 原始请求（供 WS 重连时重放 banner）。
struct PendingEntry {
    responder: Responder<RequestPermissionResponse>,
    request: serde_json::Value,
}

pub struct PermissionManager {
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    request_tx: broadcast::Sender<PermissionRequestEvent>,
    /// 审批解决（用户应答 / cancel_all）时广播其 id：审批可能由另一条 WS
    /// 连接（其他标签页/设备）应答，所有连接都要即时清除对应 banner。
    resolved_tx: broadcast::Sender<String>,
}

impl PermissionManager {
    pub fn new() -> Self {
        let (request_tx, _) = broadcast::channel(16);
        let (resolved_tx, _) = broadcast::channel(16);
        Self { pending: Arc::new(Mutex::new(HashMap::new())), request_tx, resolved_tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.request_tx.subscribe()
    }

    /// 订阅审批解决事件（载荷为审批 id）。
    pub fn resolved_subscribe(&self) -> broadcast::Receiver<String> {
        self.resolved_tx.subscribe()
    }

    /// 当前未决（等待用户响应）的权限请求数量。用于活跃度守卫判断 agent
    /// 是否处于 requires_action 状态。
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    /// 登记权限请求并广播给前端，等待用户经 [`Self::resolve`] 应答。
    ///
    /// 不设超时自动应答：ACP 规范规定 `Cancelled` outcome 仅用于响应
    /// `session/cancel`（见 [`Self::cancel_all`]），审批必须等真人决策。
    /// 长期无人应答的兜底回收由 reaper 负责（30 分钟 cancel + disconnect）。
    pub async fn handle_request(
        &self,
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let id = Uuid::new_v4().to_string();
        let request = serde_json::to_value(&request).unwrap_or_default();

        let event = PermissionRequestEvent { id: id.clone(), request: request.clone() };

        self.pending.lock().await.insert(id, PendingEntry { responder, request });
        let _ = self.request_tx.send(event);

        Ok(())
    }

    /// 所有未决审批的事件快照（WS 连接/重连时重放，恢复前端 banner）。
    pub async fn pending_events(&self) -> Vec<PermissionRequestEvent> {
        self.pending
            .lock()
            .await
            .iter()
            .map(|(id, entry)| PermissionRequestEvent {
                id: id.clone(),
                request: entry.request.clone(),
            })
            .collect()
    }

    /// 以 `Cancelled` outcome 应答所有未决权限请求。
    ///
    /// ACP 规范：client 发送 `session/cancel` 后 MUST 用 `Cancelled` 回复
    /// 所有 pending 的 `session/request_permission`。由 `AcpClient::cancel`
    /// 在发出 CancelNotification 时调用。
    pub async fn cancel_all(&self) {
        let mut map = self.pending.lock().await;
        for (id, entry) in map.drain() {
            let _ = entry
                .responder
                .respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            let _ = self.resolved_tx.send(id);
        }
    }

    pub async fn resolve(&self, id: &str, option_id: &str) -> bool {
        let mut map = self.pending.lock().await;
        if let Some(entry) = map.remove(id) {
            let _ = entry.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::new(option_id),
                )),
            ));
            let _ = self.resolved_tx.send(id.to_string());
            true
        } else {
            false
        }
    }
}

/// 自动推进模式（权限超时设置）下挑选应答选项的 kind 优先级：
/// `allow_always` 优先——无人值守时一次放行、避免同一请求在后续回合反复
/// 挂起；其次 `allow_once`（最小授权）；无 allow 选项时才退到 reject 两态
/// （不放行但让 agent 继续回合）；最后兜底取第一个可选项。实际选中项会写进
/// system 消息明示，授权代价对用户可见（2026-09-21 用户拍板：allow_always
/// 优先于 allow_once）。
const AUTO_OPTION_KIND_PRIORITY: [&str; 4] =
    ["allow_always", "allow_once", "reject_once", "reject_always"];

/// system 消息详情里请求内容预览的最大字符数（§P1：外部输入体积必须显式
/// 设限——toolCall.content 由 agent 实现决定，可达数十 KB；按 char 边界切，
/// 省略量随 detail 下发由前端本地化标注）。
pub const PERM_NOTICE_CONTENT_MAX_CHARS: usize = 400;

/// 单个超时系统消息最多摘要几笔未决审批（§P1：agent 异常时可能连发多笔
/// 请求，消息写入必须有上限；超出的笔数仅计数不展开）。
pub const MAX_PERM_NOTICE_REQUESTS: usize = 5;

/// 选项展示标签：`name` 优先（agent 本地化文案），缺失回退 kind 原值。
fn option_label(option: &serde_json::Value) -> String {
    option
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| option.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("?")
        .to_string()
}

/// 从 `RequestPermissionRequest` 序列化值中挑选自动应答的选项，返回
/// `(option_id, 展示标签)`。选项数组缺失/为空/无合法 id 时返回 `None`，
/// 调用方据此降级（不能解析就绝不瞎猜）。
pub fn pick_auto_option(request: &serde_json::Value) -> Option<(String, String)> {
    let options = request.get("options")?.as_array()?;
    let pick = |o: &serde_json::Value| -> Option<(String, String)> {
        let id = o
            .get("optionId")
            .or_else(|| o.get("option_id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())?;
        Some((id.to_string(), option_label(o)))
    };
    for kind in AUTO_OPTION_KIND_PRIORITY {
        if let Some(picked) = options
            .iter()
            .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some(kind))
            .and_then(pick)
        {
            return Some(picked);
        }
    }
    options.first().and_then(pick)
}

/// 未决审批请求的可读摘要：超时系统消息据此向用户说明"错过了什么"
/// （工具、内容预览、当时的可选项）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PermissionRequestSummary {
    /// 工具名（toolCall.title），缺失时回退 kind。
    pub tool: Option<String>,
    /// 工具类型（toolCall.kind，如 execute / read / edit）。
    pub kind: Option<String>,
    /// 请求内容预览（已截断；diff 等富形态只取文本，不重排）。
    pub content: Option<String>,
    /// 内容预览被省略的字符数（0 = 未截断）。
    pub content_omitted: usize,
    /// 当时的可选项标签（顺序保持协议原序）。
    pub options: Vec<String>,
}

/// 截断到 `max_chars` 个字符（char 边界安全，不在 UTF-8 中间切开），
/// 返回 `(保留文本, 省略字符数)`。
fn truncate_chars(s: &str, max_chars: usize) -> (String, usize) {
    let total = s.chars().count();
    if total <= max_chars {
        return (s.to_string(), 0);
    }
    (s.chars().take(max_chars).collect(), total - max_chars)
}

/// 提取 toolCall 的内容预览：`content` 为字符串/数组时取纯文本（diff 富形态
/// 只取 path/text，不重排 diff）；无 content 时兜底 rawInput/raw_input
/// （键名同时覆盖 camel/snake——个别实现/中转层用 snake_case，与前端
/// `extractToolContent` 同源但只取预览，不做完整渲染）。
fn extract_content_preview(tool_call: &serde_json::Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    match tool_call.get("content") {
        Some(serde_json::Value::String(s)) => parts.push(s.clone()),
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                match item {
                    serde_json::Value::String(s) => parts.push(s.clone()),
                    serde_json::Value::Object(map) => {
                        if let Some(serde_json::Value::String(t)) = map.get("text") {
                            parts.push(t.clone());
                        } else if let Some(serde_json::Value::String(p)) = map.get("path") {
                            parts.push(p.clone());
                        } else if let Some(inner) = map.get("content")
                            && let Some(serde_json::Value::String(t)) = inner.get("text")
                        {
                            // {type:'content', content:{type:'text', text:'...'}}
                            parts.push(t.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if parts.is_empty() {
        for key in ["rawInput", "raw_input"] {
            match tool_call.get(key) {
                Some(serde_json::Value::String(s)) => {
                    parts.push(s.clone());
                    break;
                }
                Some(v @ serde_json::Value::Object(_)) => {
                    parts.push(serde_json::to_string(v).unwrap_or_default());
                    break;
                }
                _ => {}
            }
        }
    }
    let joined = parts.join("\n");
    (!joined.trim().is_empty()).then_some(joined)
}

/// 摘要一笔未决审批请求（见 [`PermissionRequestSummary`]）。
pub fn summarize_permission_request(request: &serde_json::Value) -> PermissionRequestSummary {
    let tool_call = request.get("toolCall").or_else(|| request.get("tool_call"));
    let kind = tool_call
        .and_then(|tc| tc.get("kind"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let tool = tool_call
        .and_then(|tc| tc.get("title"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| kind.clone());
    let (content, content_omitted) = match tool_call.and_then(extract_content_preview) {
        Some(c) => {
            let (text, omitted) = truncate_chars(&c, PERM_NOTICE_CONTENT_MAX_CHARS);
            (Some(text), omitted)
        }
        None => (None, 0),
    };
    let options = request
        .get("options")
        .and_then(|o| o.as_array())
        .map(|opts| opts.iter().map(option_label).collect())
        .unwrap_or_default();
    PermissionRequestSummary { tool, kind, content, content_omitted, options }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(options: &[(&str, &str, &str)], content: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "title": "Bash", "kind": "execute", "content": content },
            "options": options
                .iter()
                .map(|(id, kind, name)| serde_json::json!({ "optionId": id, "kind": kind, "name": name }))
                .collect::<Vec<_>>(),
        })
    }

    const STANDARD_OPTIONS: &[(&str, &str, &str)] =
        &[("o1", "allow_once", "允许一次"), ("o2", "reject_once", "拒绝")];

    #[test]
    fn pick_auto_option_prefers_allow_always_then_allow_once() {
        // D2 拍板顺序：allow_always 优先于 allow_once。
        let req = request(
            &[("o1", "allow_once", "允许一次"), ("o2", "allow_always", "总是允许")],
            serde_json::json!("rm -rf build"),
        );
        assert_eq!(pick_auto_option(&req), Some(("o2".to_string(), "总是允许".to_string())));

        let req = request(
            &[("o1", "reject_once", "拒绝"), ("o2", "allow_once", "允许一次")],
            serde_json::json!("rm -rf build"),
        );
        assert_eq!(pick_auto_option(&req), Some(("o2".to_string(), "允许一次".to_string())));
    }

    #[test]
    fn pick_auto_option_falls_back_to_reject_then_first() {
        // 无 allow 选项：退到 reject_once（不放行但让 agent 继续回合）。
        let req = request(
            &[("o1", "reject_always", "总是拒绝"), ("o2", "reject_once", "拒绝")],
            serde_json::json!("x"),
        );
        assert_eq!(pick_auto_option(&req), Some(("o2".to_string(), "拒绝".to_string())));

        // 全是非常规 kind：兜底第一个可选项。
        let req = request(&[("o1", "other", "自定义")], serde_json::json!("x"));
        assert_eq!(pick_auto_option(&req), Some(("o1".to_string(), "自定义".to_string())));
    }

    #[test]
    fn pick_auto_option_returns_none_on_malformed_request() {
        assert_eq!(pick_auto_option(&serde_json::json!({})), None);
        assert_eq!(pick_auto_option(&serde_json::json!({"options": []})), None);
        // 有选项但无合法 id：不能瞎猜，返回 None 让调用方降级。
        let req = serde_json::json!({"options": [{"kind": "allow_once"}]});
        assert_eq!(pick_auto_option(&req), None);
        // option_id（snake_case 中转层）也要认。
        let req = serde_json::json!({"options": [{"option_id": "o9", "kind": "allow_once"}]});
        assert_eq!(pick_auto_option(&req).map(|(id, _)| id), Some("o9".to_string()));
    }

    #[test]
    fn summarize_extracts_tool_kind_options_and_truncates_content() {
        let long = "x".repeat(PERM_NOTICE_CONTENT_MAX_CHARS + 50);
        let req = request(STANDARD_OPTIONS, serde_json::json!(long));
        let s = summarize_permission_request(&req);
        assert_eq!(s.tool.as_deref(), Some("Bash"));
        assert_eq!(s.kind.as_deref(), Some("execute"));
        assert_eq!(s.options, vec!["允许一次".to_string(), "拒绝".to_string()]);
        let content = s.content.expect("content present");
        assert_eq!(content.chars().count(), PERM_NOTICE_CONTENT_MAX_CHARS);
        assert_eq!(s.content_omitted, 50);
    }

    #[test]
    fn summarize_handles_array_content_and_raw_input_fallback() {
        // content 数组（ACP 标准形态）：取 text / path，忽略富形态细节。
        let req = request(
            STANDARD_OPTIONS,
            serde_json::json!([{"type": "content", "content": {"type": "text", "text": "git push"}}]),
        );
        assert_eq!(summarize_permission_request(&req).content.as_deref(), Some("git push"));

        // 无 content：rawInput 字符串兜底。
        let req = serde_json::json!({
            "toolCall": {"title": "Edit", "kind": "edit", "rawInput": "old -> new"},
            "options": [{"optionId": "o1", "kind": "allow_once"}],
        });
        let s = summarize_permission_request(&req);
        assert_eq!(s.content.as_deref(), Some("old -> new"));
        // 缺 name 时选项标签回退 kind 原值。
        assert_eq!(s.options, vec!["allow_once".to_string()]);
    }

    #[test]
    fn summarize_tolerates_empty_request() {
        let s = summarize_permission_request(&serde_json::json!({}));
        assert_eq!(s, PermissionRequestSummary::default());
    }
}
