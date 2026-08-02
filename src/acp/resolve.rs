//! Agent command resolution: PATH → private dir → lazy npm install.

use std::path::PathBuf;

use tokio::process::Command;
use tracing::info;

const PRIVATE_DIR_NAME: &str = ".omniterm/agents";

/// Resolve the agent's command to an absolute binary path.
///
/// Priority:
/// 1. `command` found in user's PATH (respects their environment)
/// 2. `command` found in `~/.omniterm/agents/node_modules/.bin/`
/// 3. Auto-install `npm_package` into the private dir, then use from `.bin/`
///
/// Returns the resolved absolute path, or an error message suitable for display.
pub async fn resolve_command(command: &str, npm_package: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = which(command).await {
        return Ok(path);
    }

    let private_bin = private_bin_dir().join(command);
    if private_bin.exists() {
        return Ok(private_bin);
    }

    let Some(pkg) = npm_package else {
        return Err(format!(
            "command '{}' not found in PATH. Install it manually or set an npm_package for auto-install.",
            command
        ));
    };

    install_npm_package(pkg).await?;

    let installed = private_bin_dir().join(command);
    if installed.exists() {
        Ok(installed)
    } else {
        Err(format!(
            "npm package '{}' installed but binary '{}' not found in {}. The package may expose a differently-named bin.",
            pkg,
            command,
            private_bin_dir().display()
        ))
    }
}

fn private_bin_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(PRIVATE_DIR_NAME).join("node_modules").join(".bin")
}

fn private_prefix() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(PRIVATE_DIR_NAME)
}

async fn which(cmd: &str) -> Option<PathBuf> {
    let output = Command::new("which").arg(cmd).output().await.ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

async fn install_npm_package(pkg: &str) -> Result<(), String> {
    if which("npm").await.is_none() {
        return Err(
            "Node.js/npm is required to auto-install agent packages but was not found in PATH. \
             Please install Node.js first: https://nodejs.org/"
                .to_string(),
        );
    }

    let prefix = private_prefix();
    tokio::fs::create_dir_all(&prefix)
        .await
        .map_err(|e| format!("failed to create {}: {}", prefix.display(), e))?;

    info!("auto-installing npm package '{}' into {}", pkg, prefix.display());

    let output = Command::new("npm")
        .args(["install", "--prefix", &prefix.to_string_lossy(), pkg])
        .output()
        .await
        .map_err(|e| format!("failed to run npm install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install '{}' failed: {}", pkg, stderr.trim()));
    }

    Ok(())
}
