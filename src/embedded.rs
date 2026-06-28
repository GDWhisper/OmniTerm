use rust_embed::RustEmbed;

/// Frontend dist/ embedded at compile time.
/// Falls back to filesystem when FRONTEND_DIR env is set (dev mode).
#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
pub struct FrontendAssets;

/// Serve a static file from embedded assets with correct MIME type.
/// Returns None if the file is not found.
pub fn serve_embedded(path: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    FrontendAssets::get(path).map(|file| {
        let mime = mime_type(path);
        (file.data.to_vec(), mime)
    })
}

/// SPA fallback: serve index.html for any path without an exact file match.
pub fn serve_spa_fallback(path: &str) -> Option<(Vec<u8>, &'static str)> {
    // Only fallback for paths that look like SPA routes (no file extension)
    let path = path.trim_start_matches('/');
    if path.contains('.') {
        return None; // Likely a missing asset, not an SPA route
    }
    FrontendAssets::get("index.html").map(|file| {
        (file.data.to_vec(), "text/html; charset=utf-8")
    })
}

fn mime_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
