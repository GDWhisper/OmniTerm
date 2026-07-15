use agent_client_protocol::schema::v1::SessionNotification;
use tokio::sync::broadcast;

/// Broadcast a session/update notification to all WebSocket subscribers.
pub fn handle_session_update(
    tx: &broadcast::Sender<SessionNotification>,
    notification: SessionNotification,
) -> Result<(), agent_client_protocol::Error> {
    let _ = tx.send(notification);
    Ok(())
}
