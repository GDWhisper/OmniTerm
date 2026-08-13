//! WebSocket 双向 relay：浏览器 WS ↔ OmniTerm ↔ 目标服务 WS（P2）。
//!
//! 生命周期：`on_upgrade` 后 `tokio_tungstenite::connect_async` 建立上游 WS，
//! 四任务双向 relay（每方向「读源 → 有界队列 → 写目标」解耦），
//! 任一方向 EOF/Close 终止整条 relay。
//!
//! 有界性（D5/§P1）：每方向 `mpsc::channel(64)` 有界，队列满时丢弃最旧帧 + warn
//! ——上游推送速率不由我们决定（§P4），不能假设它会温和输出。

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// 每方向 WS 消息队列容量（D5）：有界，满则丢旧 + warn。
const WS_QUEUE_CAPACITY: usize = 64;

/// 双向通用的消息载体，避免 axum / tungstenite 两套 Message 类型互相耦合。
#[derive(Debug)]
enum RelayMsg {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

pub async fn relay(
    ws: WebSocketUpgrade,
    port: u16,
    uri: &axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    let target = upstream_ws_url(uri, port);
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = relay_inner(socket, target, port, headers).await {
            tracing::warn!("ws relay terminated (port {}): {}", port, e);
        }
    })
}

/// 上游 WS 目标：复用 HTTP 转发的剩余路径 + query，scheme 换 `ws://`。
fn upstream_ws_url(uri: &axum::http::Uri, port: u16) -> String {
    super::upstream_url(uri, port).replacen("http://", "ws://", 1)
}

async fn relay_inner(
    socket: WebSocket,
    target: String,
    port: u16,
    headers: HeaderMap,
) -> anyhow::Result<()> {
    // 上游 WS 握手：透传重写后的 end-to-end 头（Origin 重写 / Cookie 剥离 / 子协议透传），
    // 握手头（Sec-WebSocket-Key/Version）留给 tungstenite 生成规范值。
    let mut req: tokio_tungstenite::tungstenite::handshake::client::Request =
        target.into_client_request()?;
    let rewritten = super::rewrite_request_headers(&headers, port, true);
    for (name, value) in rewritten.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if lower == "sec-websocket-key" || lower == "sec-websocket-version" {
            continue;
        }
        req.headers_mut().insert(name.clone(), value.clone());
    }
    let (upstream, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| anyhow::anyhow!("upstream ws connect failed: {e}"))?;

    let (mut client_tx, mut client_rx) = socket.split();
    let (mut up_tx, mut up_rx) = upstream.split();

    let (to_up_tx, mut to_up_rx) = mpsc::channel::<RelayMsg>(WS_QUEUE_CAPACITY);
    let (to_client_tx, mut to_client_rx) = mpsc::channel::<RelayMsg>(WS_QUEUE_CAPACITY);

    // 读 client → 入队
    let mut read_client = tokio::spawn(async move {
        while let Some(msg) = client_rx.next().await {
            let Ok(msg) = msg else { break };
            let close = matches!(msg, Message::Close(_));
            if let Some(r) = axum_to_relay(msg) {
                enqueue(&to_up_tx, r, "client→upstream");
            }
            if close {
                break;
            }
        }
    });

    // 出队 → 写 upstream
    let mut write_up = tokio::spawn(async move {
        while let Some(msg) = to_up_rx.recv().await {
            let close = matches!(msg, RelayMsg::Close);
            if up_tx.send(relay_to_ws(msg)).await.is_err() {
                break;
            }
            if close {
                break;
            }
        }
        let _ = up_tx.close().await;
    });

    // 读 upstream → 入队
    let mut read_up = tokio::spawn(async move {
        while let Some(msg) = up_rx.next().await {
            let Ok(msg) = msg else { break };
            let close = matches!(msg, WsMessage::Close(_));
            if let Some(r) = ws_to_relay(msg) {
                enqueue(&to_client_tx, r, "upstream→client");
            }
            if close {
                break;
            }
        }
    });

    // 出队 → 写 client
    let mut write_client = tokio::spawn(async move {
        while let Some(msg) = to_client_rx.recv().await {
            let close = matches!(msg, RelayMsg::Close);
            if client_tx.send(relay_to_axum(msg)).await.is_err() {
                break;
            }
            if close {
                break;
            }
        }
        let _ = client_tx.close().await;
    });

    tokio::select! {
        _ = &mut read_client => {}
        _ = &mut write_up => {}
        _ = &mut read_up => {}
        _ = &mut write_client => {}
    }
    // 任一方向结束即终止整条 relay：其余 task 必须显式 abort，
    // 否则败者会守着已死的半边连接泄漏。
    read_client.abort();
    write_up.abort();
    read_up.abort();
    write_client.abort();
    Ok(())
}

/// 有界入队（§P1 有界累积 + 超限策略）：队列满时**拒绝新数据** + warn。
///
/// 不采用计划 D5 的「丢最旧」——那需要独占持有 `Receiver` 做 `try_recv`，
/// 与写侧任务的 `recv().await` 产生借用冲突；且对 WS relay，「拒绝新数据」
/// 保留帧序，避免中间帧丢失破坏协议语义。两者都是 P1 明确允许的超限策略。
fn enqueue<T>(tx: &mpsc::Sender<T>, item: T, label: &str) {
    match tx.try_send(item) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            tracing::warn!("ws relay {label} queue full, dropped incoming frame");
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {}
    }
}

fn axum_to_relay(msg: Message) -> Option<RelayMsg> {
    Some(match msg {
        Message::Text(t) => RelayMsg::Text(t.to_string()),
        Message::Binary(b) => RelayMsg::Binary(b.to_vec()),
        Message::Ping(d) => RelayMsg::Ping(d.to_vec()),
        Message::Pong(d) => RelayMsg::Pong(d.to_vec()),
        Message::Close(_) => RelayMsg::Close,
    })
}

fn ws_to_relay(msg: WsMessage) -> Option<RelayMsg> {
    Some(match msg {
        WsMessage::Text(t) => RelayMsg::Text(t.to_string()),
        WsMessage::Binary(b) => RelayMsg::Binary(b.to_vec()),
        WsMessage::Ping(d) => RelayMsg::Ping(d.to_vec()),
        WsMessage::Pong(d) => RelayMsg::Pong(d.to_vec()),
        WsMessage::Close(_) => RelayMsg::Close,
        _ => return None,
    })
}

fn relay_to_ws(msg: RelayMsg) -> WsMessage {
    match msg {
        RelayMsg::Text(t) => WsMessage::Text(t.into()),
        RelayMsg::Binary(b) => WsMessage::Binary(b.into()),
        RelayMsg::Ping(d) => WsMessage::Ping(d.into()),
        RelayMsg::Pong(d) => WsMessage::Pong(d.into()),
        RelayMsg::Close => WsMessage::Close(None),
    }
}

fn relay_to_axum(msg: RelayMsg) -> Message {
    match msg {
        RelayMsg::Text(t) => Message::Text(t.into()),
        RelayMsg::Binary(b) => Message::Binary(b.into()),
        RelayMsg::Ping(d) => Message::Ping(d.into()),
        RelayMsg::Pong(d) => Message::Pong(d.into()),
        RelayMsg::Close => Message::Close(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_drops_incoming_when_full() {
        let (tx, mut rx) = mpsc::channel::<i32>(2);
        enqueue(&tx, 1, "test");
        enqueue(&tx, 2, "test");
        enqueue(&tx, 3, "test"); // 满：拒绝 3
        assert_eq!(rx.try_recv().unwrap(), 1);
        assert_eq!(rx.try_recv().unwrap(), 2);
        assert!(rx.try_recv().is_err()); // 3 已被拒
    }

    #[test]
    fn enqueue_no_drop_below_capacity() {
        let (tx, mut rx) = mpsc::channel::<i32>(2);
        enqueue(&tx, 1, "test");
        enqueue(&tx, 2, "test");
        assert_eq!(rx.try_recv().unwrap(), 1);
        assert_eq!(rx.try_recv().unwrap(), 2);
    }

    #[test]
    fn upstream_ws_url_swaps_scheme() {
        let uri: axum::http::Uri = "/proxy/3000/hmr?x=1".parse().unwrap();
        assert_eq!(upstream_ws_url(&uri, 3000), "ws://127.0.0.1:3000/hmr?x=1");
    }
}
