use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use agent_client_protocol::Responder;

/// Phase 3: all permission requests are auto-allowed.
/// Phase 4 will add a manual queue with oneshot channels for frontend approval.
pub struct PermissionManager;

impl PermissionManager {
    pub fn resolve(
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let allow_option = request
            .options
            .iter()
            .find(|opt| {
                matches!(
                    opt.kind,
                    PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                )
            })
            .or(request.options.first());

        match allow_option {
            Some(opt) => responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    opt.option_id.clone(),
                )),
            )),
            None => responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            )),
        }
    }
}
