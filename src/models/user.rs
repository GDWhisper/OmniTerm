use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    /// 缺省 / 空串 / 全空白 → 回退 `"admin"`，与「仅密码」时代的老库与脚本等价（D1）。
    pub username: Option<String>,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    /// 缺省 / 空串 → 按 `"admin"` 比对；用户名与密码均须匹配（统一 401）。
    pub username: Option<String>,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct ChangeUsernameRequest {
    pub current_password: String,
    pub new_username: String,
}

/// 设置口部分更新（D5）：仅提交需要变更的项；两项都缺 → handler 返回 400。
#[derive(Debug, Deserialize)]
pub struct AuthSettingsRequest {
    pub auth_enabled: Option<bool>,
    pub local_auth_required: Option<bool>,
}
