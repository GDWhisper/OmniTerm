use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthSettingsRequest {
    pub auth_enabled: bool,
}
