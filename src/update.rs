use anyhow::{Context, Result, bail};
use clap::Parser;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// npm 包名的单一真源（宏形式以便 `concat!` 编译期拼接 spec）。
macro_rules! npm_package {
    () => {
        "@gdwhisper/omniterm"
    };
}

/// 全局 CLI 升级统一用 `npm install -g <pkg>@latest`，不用 `npm update -g`：
/// `update` 受已安装的 semver range 约束（不跨 major），且对本包分发平台二进制所用的
/// optionalDependencies 重解析不可靠；`install @latest` 语义明确、幂等、可跨 major。
pub(crate) const NPM_UPGRADE_ARGS: &[&str] = &["install", "-g", concat!(npm_package!(), "@latest")];
const CRATE_NAME: &str = "omniterm";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = concat!("omniterm-update/", env!("CARGO_PKG_VERSION"));

#[derive(Parser)]
pub struct UpdateArgs {
    /// 只检查是否有新版本，不执行更新
    #[arg(long)]
    check: bool,
}

#[derive(Debug, PartialEq, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Channel {
    Npm,
    Cargo,
    GithubRelease,
}

#[derive(Deserialize)]
pub(crate) struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Deserialize)]
struct ReleaseInfo {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}

pub(crate) struct LatestRelease {
    pub(crate) version: Version,
    assets: Vec<ReleaseAsset>,
}

fn repo_slug() -> &'static str {
    env!("CARGO_PKG_REPOSITORY").trim_start_matches("https://github.com/")
}

pub(crate) fn current_exe_channel() -> Result<(PathBuf, Channel)> {
    let exe = std::env::current_exe()
        .context("failed to locate current executable")?
        .canonicalize()
        .context("failed to canonicalize executable path")?;
    let channel = detect_channel(
        &exe,
        std::env::var_os("CARGO_HOME").map(PathBuf::from).as_deref(),
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .as_deref(),
    );
    Ok((exe, channel))
}

pub async fn run(args: UpdateArgs) -> Result<()> {
    let current = Version::parse(env!("CARGO_PKG_VERSION"))?;
    eprintln!("Checking for updates... (current: v{current})");

    let release = fetch_latest().await?;
    match release.version.cmp(&current) {
        Ordering::Equal => {
            eprintln!("Already up to date (v{current}).");
            return Ok(());
        }
        Ordering::Less => {
            eprintln!(
                "Current version v{current} is newer than the latest release v{} (development build?). Nothing to do.",
                release.version
            );
            return Ok(());
        }
        Ordering::Greater => {}
    }

    let (exe, channel) = current_exe_channel()?;

    eprintln!("New version available: v{current} -> v{} (channel: {channel:?})", release.version);
    if args.check {
        return Ok(());
    }

    match channel {
        Channel::Npm => {
            eprintln!("Detected npm installation. Running: npm {}", NPM_UPGRADE_ARGS.join(" "));
            delegate("npm", NPM_UPGRADE_ARGS).await?;
            // Windows 上 npm 升级本包必伴 cleanup EPERM warn，但那是成功路径：npm 先把旧
            // 包目录 rename 为 `.omniterm-<hash>`（retire）再装新的，最后删 retire 目录时因
            // 里面的 omniterm.exe 正被本进程/服务器进程持有而 unlink 失败。退出码仍为 0，
            // 不加这句用户会把成功误读为失败。
            if cfg!(windows) {
                eprintln!(
                    "Note: any 'npm warn cleanup ... EPERM ... unlink omniterm.exe' above is harmless. \
                     npm moved the old binary aside and a running omniterm process still holds it; \
                     the new version is already installed."
                );
            }
            eprintln!(
                "Run 'omniterm --version' to verify — the npm package may lag behind the GitHub release."
            );
            eprintln!(
                "If a server is running, restart it to pick up the new version: omniterm stop && omniterm start"
            );
            Ok(())
        }
        Channel::Cargo => {
            eprintln!(
                "Detected cargo installation. Running: cargo install {CRATE_NAME}\n\
                 This will recompile from source (may take several minutes). For a prebuilt binary, reinstall via install.sh."
            );
            delegate("cargo", &["install", CRATE_NAME]).await
        }
        Channel::GithubRelease => {
            self_replace(&exe, &release).await?;
            eprintln!(
                "Updated omniterm v{current} -> v{}. Restart any running server (omniterm stop && omniterm start) to use the new version.",
                release.version
            );
            Ok(())
        }
    }
}

fn detect_channel(exe: &Path, cargo_home: Option<&Path>, home: Option<&Path>) -> Channel {
    if exe.components().any(|c| c.as_os_str() == "node_modules") {
        return Channel::Npm;
    }
    let cargo_bin =
        cargo_home.map(|h| h.join("bin")).or_else(|| home.map(|h| h.join(".cargo").join("bin")));
    if let Some(bin) = cargo_bin
        && exe.parent() == Some(bin.as_path())
    {
        return Channel::Cargo;
    }
    Channel::GithubRelease
}

fn asset_name() -> Result<&'static str> {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("omniterm-linux-x86_64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Ok("omniterm-linux-aarch64")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("omniterm-macos-aarch64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("omniterm-windows-x86_64.zip")
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Ok("omniterm-windows-aarch64.zip")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        bail!("macOS Intel is not supported.")
    } else {
        bail!("No release asset for this platform. See https://github.com/{}/releases", repo_slug())
    }
}

pub(crate) async fn fetch_latest() -> Result<LatestRelease> {
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo_slug());
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .with_context(|| {
            format!(
                "failed to reach GitHub API. You can update manually: curl -fsSL https://raw.githubusercontent.com/{}/main/install.sh | bash",
                repo_slug()
            )
        })?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        bail!("GitHub API rate limit reached. Try again later.");
    }
    let info: ReleaseInfo = resp
        .error_for_status()
        .context("GitHub API returned an error")?
        .json()
        .await
        .context("failed to parse GitHub API response")?;
    let version = Version::parse(info.tag_name.trim_start_matches('v'))
        .with_context(|| format!("unexpected release tag: {}", info.tag_name))?;
    Ok(LatestRelease { version, assets: info.assets })
}

/// 解析外部命令到**绝对路径**再交给 `Command`，而不是传裸名。
///
/// Windows 必需：`std::process::Command` 只按 PATH 补 `.exe`，不读 `PATHEXT`，
/// 而 npm 在 Windows 上只有 `npm.cmd`/`npm.ps1` → 裸名 spawn 报 `program not found`。
/// `which` 遵循 PATHEXT 能解析到 `npm.cmd`，且 std（≥1.77.2）对 `.bat`/`.cmd`
/// 结尾的 program 会自动用 cmd.exe 包装并做 CVE-2024-24576 的参数转义。
fn resolve_program(cmd: &str) -> Result<PathBuf> {
    which::which(cmd).with_context(|| format!("{cmd} not found in PATH"))
}

// CLI 专用：继承 stdio 直通用户终端，失败时透传子进程退出码（会终止本进程）。
// 服务器进程内严禁使用，Web 端点请用 delegate_captured。
async fn delegate(cmd: &str, cmd_args: &[&str]) -> Result<()> {
    let program = resolve_program(cmd).with_context(|| {
        format!(
            "the binary appears to be {cmd}-managed but {cmd} is unavailable. Update manually or reinstall via install.sh."
        )
    })?;
    let status = tokio::process::Command::new(program)
        .args(cmd_args)
        .status()
        .await
        .with_context(|| format!("failed to run {cmd}"))?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

// 服务器内安全版：捕获输出、失败返回 Err（携带 stderr 尾部），绝不退出进程
pub(crate) async fn delegate_captured(cmd: &str, cmd_args: &[&str]) -> Result<String> {
    let program = resolve_program(cmd)?;
    let output = tokio::process::Command::new(program)
        .args(cmd_args)
        .output()
        .await
        .with_context(|| format!("failed to run {cmd}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String =
            stderr.chars().rev().take(2048).collect::<Vec<_>>().into_iter().rev().collect();
        bail!("{cmd} exited with {}: {}", output.status, tail.trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(crate) async fn self_replace(exe: &Path, release: &LatestRelease) -> Result<()> {
    let asset_name = asset_name()?;
    let asset = release.assets.iter().find(|a| a.name == asset_name).with_context(|| {
        format!(
            "No release asset '{asset_name}' for your platform. See https://github.com/{}/releases",
            repo_slug()
        )
    })?;

    let dir = exe.parent().context("executable has no parent directory")?;
    let file_name = exe.file_name().context("executable has no file name")?.to_string_lossy();
    let tmp = dir.join(format!("{}.update-{}", file_name, std::process::id()));

    // 下载前探测目录可写性，避免白下 20MB 后才失败
    if let Err(e) = std::fs::File::create(&tmp) {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            bail!(
                "Permission denied writing to {}. Re-run with: sudo omniterm update",
                dir.display()
            );
        }
        return Err(e).with_context(|| format!("failed to create {}", tmp.display()));
    }

    let result = download_and_install(asset, exe, &tmp, &release.version).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

async fn download_and_install(
    asset: &ReleaseAsset,
    exe: &Path,
    tmp: &Path,
    new_version: &Version,
) -> Result<()> {
    eprintln!("Downloading {}...", asset.name);
    // 大文件下载不设总超时（慢网络下会误杀），只限制连接与读间隔
    let client = reqwest::Client::builder()
        .connect_timeout(HTTP_TIMEOUT)
        .read_timeout(HTTP_TIMEOUT)
        .build()?;
    let bytes = client
        .get(&asset.browser_download_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .context("download failed")?
        .error_for_status()
        .context("download failed")?
        .bytes()
        .await
        .context("download interrupted")?;

    match &asset.digest {
        Some(digest) => {
            verify_digest(&bytes, digest)?;
            eprintln!("Checksum verified.");
        }
        None => eprintln!("No checksum published for this asset; relying on --version validation."),
    }

    let binary =
        if asset.name.ends_with(".zip") { extract_exe_from_zip(&bytes)? } else { bytes.to_vec() };

    std::fs::write(tmp, &binary).with_context(|| format!("failed to write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(0o755))?;
    }

    // 替换前验证新 binary 可执行且版本正确（防架构错配/损坏下载）
    let output = tokio::process::Command::new(tmp)
        .arg("--version")
        .output()
        .await
        .context("downloaded binary failed to execute (wrong architecture?)")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.contains(&new_version.to_string()) {
        bail!("downloaded binary reports unexpected version: {}", stdout.trim());
    }

    replace_exe(tmp, exe)
}

fn verify_digest(bytes: &[u8], digest: &str) -> Result<()> {
    let expected = digest
        .strip_prefix("sha256:")
        .with_context(|| format!("unsupported digest format: {digest}"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        bail!(
            "Checksum verification failed — download may be corrupted. Aborting (nothing was replaced)."
        );
    }
    Ok(())
}

#[cfg(unix)]
fn replace_exe(tmp: &Path, exe: &Path) -> Result<()> {
    // Unix 下 rename 覆盖运行中的 binary 是合法的：旧 inode 由进程持有至退出
    std::fs::rename(tmp, exe).with_context(|| format!("failed to replace {}", exe.display()))
}

#[cfg(windows)]
fn replace_exe(tmp: &Path, exe: &Path) -> Result<()> {
    // Windows 不能覆盖运行中的 exe，但可以 rename：自身让位为 .old，再把新文件就位
    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old)
        .with_context(|| format!("failed to move aside {}", exe.display()))?;
    if let Err(e) = std::fs::rename(tmp, exe) {
        let _ = std::fs::rename(&old, exe); // 回滚
        return Err(e).with_context(|| format!("failed to install {}", exe.display()));
    }
    if std::fs::remove_file(&old).is_err() {
        eprintln!(
            "Note: previous binary left at {}; it will be cleaned up on the next update.",
            old.display()
        );
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn extract_exe_from_zip(bytes: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("failed to open release zip")?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name().ends_with(".exe") {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }
    bail!("no .exe found in release zip")
}

#[cfg(not(any(windows, test)))]
fn extract_exe_from_zip(_bytes: &[u8]) -> Result<Vec<u8>> {
    bail!("zip assets are only published for Windows")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_npm_channel_from_node_modules_path() {
        let exe = Path::new("/usr/lib/node_modules/@gdwhisper/omniterm/omniterm");
        assert_eq!(detect_channel(exe, None, None), Channel::Npm);
    }

    #[test]
    fn detects_cargo_channel_from_cargo_home() {
        let exe = Path::new("/custom/cargo/bin/omniterm");
        assert_eq!(detect_channel(exe, Some(Path::new("/custom/cargo")), None), Channel::Cargo);
    }

    #[test]
    fn detects_cargo_channel_from_home_fallback() {
        let exe = Path::new("/home/user/.cargo/bin/omniterm");
        assert_eq!(detect_channel(exe, None, Some(Path::new("/home/user"))), Channel::Cargo);
    }

    #[test]
    fn falls_back_to_github_release_channel() {
        for p in ["/usr/local/bin/omniterm", "/tmp/foo/omniterm"] {
            assert_eq!(
                detect_channel(Path::new(p), None, Some(Path::new("/home/user"))),
                Channel::GithubRelease
            );
        }
    }

    #[test]
    fn asset_name_matches_current_platform() {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(asset_name().unwrap(), "omniterm-linux-x86_64");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(asset_name().unwrap(), "omniterm-macos-aarch64");
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert_eq!(asset_name().unwrap(), "omniterm-windows-x86_64.zip");
    }

    #[test]
    fn verify_digest_accepts_matching_sha256() {
        let digest = format!("sha256:{:x}", Sha256::digest(b"hello"));
        assert!(verify_digest(b"hello", &digest).is_ok());
    }

    #[test]
    fn verify_digest_rejects_mismatch() {
        let digest = format!("sha256:{:x}", Sha256::digest(b"hello"));
        assert!(verify_digest(b"tampered", &digest).is_err());
    }

    #[test]
    fn verify_digest_rejects_unknown_algorithm() {
        assert!(verify_digest(b"hello", "sha512:abc").is_err());
    }

    #[test]
    fn extracts_exe_from_zip_archive() {
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("omniterm.exe", options).unwrap();
            writer.write_all(b"fake-binary").unwrap();
            writer.finish().unwrap();
        }
        let extracted = extract_exe_from_zip(cursor.get_ref()).unwrap();
        assert_eq!(extracted, b"fake-binary");
    }

    #[test]
    fn extract_rejects_zip_without_exe() {
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("readme.txt", options).unwrap();
            writer.write_all(b"hi").unwrap();
            writer.finish().unwrap();
        }
        assert!(extract_exe_from_zip(cursor.get_ref()).is_err());
    }

    #[test]
    fn npm_upgrade_uses_install_latest_not_update() {
        assert_eq!(NPM_UPGRADE_ARGS, &["install", "-g", "@gdwhisper/omniterm@latest"]);
    }

    #[test]
    fn resolve_program_rejects_missing_command() {
        assert!(resolve_program("omniterm-no-such-program-xyz").is_err());
    }

    #[test]
    fn resolve_program_returns_absolute_path() {
        // cargo 一定存在于测试环境（CARGO 由 cargo 自身注入）
        let cargo = std::env::var("CARGO").expect("CARGO env var set by cargo test");
        let name = Path::new(&cargo).file_stem().unwrap().to_string_lossy().into_owned();
        let resolved = resolve_program(&name).expect("cargo resolvable via PATH/which");
        assert!(resolved.is_absolute(), "expected absolute path, got {}", resolved.display());
    }

    #[test]
    fn channel_serializes_snake_case() {
        assert_eq!(serde_json::to_value(Channel::GithubRelease).unwrap(), "github_release");
        assert_eq!(serde_json::to_value(Channel::Npm).unwrap(), "npm");
        assert_eq!(serde_json::to_value(Channel::Cargo).unwrap(), "cargo");
    }

    #[test]
    fn semver_ordering_covers_three_states() {
        let local = Version::parse("0.1.9").unwrap();
        assert_eq!(Version::parse("0.1.9").unwrap().cmp(&local), Ordering::Equal);
        assert_eq!(Version::parse("0.2.0").unwrap().cmp(&local), Ordering::Greater);
        assert_eq!(Version::parse("0.1.8").unwrap().cmp(&local), Ordering::Less);
    }
}
