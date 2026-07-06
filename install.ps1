# ── OmniTerm install script (Windows) ─────────────────────────────
# irm https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "GDWhisper/OmniTerm"
$BinName = "omniterm.exe"
$Version = if ($env:OMNITERM_VERSION) { $env:OMNITERM_VERSION } else { "latest" }
$InstallDir = if ($env:OMNITERM_INSTALL_DIR) { $env:OMNITERM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "omniterm" }

function Write-Info  { param($Msg) Write-Host "[omniterm] $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "[omniterm] $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "[omniterm] $Msg" -ForegroundColor Red }

# ── Architecture detection ─────────────────────────────────────────
function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64"  { return "x86_64" }
        "ARM64"  { return "aarch64" }
        default {
            Write-Err "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
            exit 1
        }
    }
}

# ── Download URL ───────────────────────────────────────────────────
function Get-DownloadUrl {
    param($Arch)
    $Asset = "omniterm-windows-${Arch}.zip"

    if ($Version -eq "latest") {
        $ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
        $Headers = @{ "User-Agent" = "omniterm-installer" }
        $Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers
        $AssetInfo = $Release.assets | Where-Object { $_.name -eq $Asset }
        if (-not $AssetInfo) {
            Write-Err "Could not find release asset: $Asset"
            Write-Err "Check https://github.com/$Repo/releases for available binaries."
            exit 1
        }
        return $AssetInfo.browser_download_url
    } else {
        return "https://github.com/$Repo/releases/download/v$Version/$Asset"
    }
}

# ── Multiplexer check ──────────────────────────────────────────────
function Test-Multiplexer {
    $found = $false
    foreach ($cmd in @("tmux", "psmux")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            $found = $true
            break
        }
    }
    if (-not $found) {
        Write-Warn "Terminal multiplexer (tmux/psmux) not found in PATH."
        Write-Warn "Install one of:"
        Write-Warn "  winget install psmux   (recommended)"
        Write-Warn "  scoop install psmux"
        Write-Warn "  cargo install psmux"
    }
}

# ── Main ───────────────────────────────────────────────────────────
function Install-OmniTerm {
    $Arch = Get-Arch
    $DownloadUrl = Get-DownloadUrl -Arch $Arch
    $ZipName = "omniterm-windows-${Arch}.zip"

    Write-Info "Downloading omniterm ($ZipName)..."
    Write-Info "  $DownloadUrl"

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $TmpZip = Join-Path $env:TEMP $ZipName
    try {
        $Headers = @{ "User-Agent" = "omniterm-installer" }
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpZip -Headers $Headers
    } catch {
        Write-Err "Download failed: $_"
        exit 1
    }

    Write-Info "Extracting to $InstallDir..."
    Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
    Remove-Item $TmpZip -ErrorAction SilentlyContinue

    $BinPath = Join-Path $InstallDir $BinName
    if (-not (Test-Path $BinPath)) {
        Write-Err "Binary not found after extraction: $BinPath"
        exit 1
    }

    # Add to user PATH if not already present
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Info "Added $InstallDir to user PATH"
    }

    # Verify
    try {
        $ver = & $BinPath --version 2>&1
        Write-Info "omniterm installed successfully! ($ver)"
    } catch {
        Write-Err "Installation verification failed"
        exit 1
    }

    Test-Multiplexer

    Write-Host ""
    Write-Info "Run 'omniterm' to start, then open http://localhost:9077"
    Write-Info "Note: restart your terminal for PATH changes to take effect."
}

Install-OmniTerm
