use agent_client_protocol::schema::v1::SessionNotification;
use tokio::sync::broadcast;

/// A `SessionNotification` tagged with the per-client monotonic sequence number the
/// turn accumulator assigned when folding it. `seq` is `Some` only for frames folded
/// during an active turn (the ones persisted into the streaming row); frames outside a
/// turn (config / commands / replay) carry `None` and need no reconnect reconciliation.
///
/// Carrying the seq on the broadcast payload lets a reconnecting WS client de-duplicate
/// live frames against the `turn_snapshot` it receives on connect (see `turn_accumulator`
/// and the WS `turn_snapshot` frame): apply frames with `seq` greater than the snapshot's,
/// drop the rest.
#[derive(Clone)]
pub struct SeqNotification {
    pub seq: Option<u64>,
    pub notification: SessionNotification,
}

/// Broadcast a session/update notification (with its accumulator seq) to all WebSocket
/// subscribers.
pub fn handle_session_update(
    tx: &broadcast::Sender<SeqNotification>,
    notification: SeqNotification,
) -> Result<(), agent_client_protocol::Error> {
    let _ = tx.send(notification);
    Ok(())
}
