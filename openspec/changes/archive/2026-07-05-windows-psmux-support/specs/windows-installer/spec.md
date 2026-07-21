## ADDED Requirements

### Requirement: 提供 PowerShell 安装脚本 install.ps1
The project MUST ship a PowerShell installation script `install.ps1` that is equivalent to `install.sh` and allows Windows users to install OmniTerm with a one-liner (`irm ... | iex`).

#### Scenario: 一行安装
- **WHEN** a Windows user runs `irm https://example.com/install.ps1 | iex` in PowerShell
- **THEN** the script SHALL download the omniterm binary matching the current architecture (`x86_64` or `aarch64`), extract it to a user directory, and add it to `PATH`

#### Scenario: 自动检测架构
- **WHEN** the user runs the script on an `x86_64` or `aarch64` Windows device
- **THEN** the script SHALL detect the architecture via `$env:PROCESSOR_ARCHITECTURE` and download the matching binary

#### Scenario: 检测并提示 psmux 依赖
- **WHEN** the install script runs and neither `tmux` nor `psmux` is in `PATH`
- **THEN** the script SHALL print `winget install psmux` (preferred) / `scoop install psmux` / `cargo install psmux` hints and MUST NOT install them automatically

### Requirement: npm-package 支持 Windows 平台
`npm-package/install.js` MUST continue the download-and-install flow on `win32` instead of `process.exit(1)` as it does today.

#### Scenario: Windows x86_64 npm 安装
- **WHEN** a user runs `npm i -g omniterm` on Windows x86_64
- **THEN** `install.js` SHALL select the `windows-x86_64` binary package, download it, and extract it into the npm package directory so the install succeeds

#### Scenario: Windows aarch64 npm 安装
- **WHEN** a user runs `npm i -g omniterm` on Windows aarch64
- **THEN** `install.js` SHALL select the `windows-aarch64` binary package (or fall back to `x86_64` with a printed hint if the release does not provide it)

#### Scenario: Windows 安装后 multiplexer 检查
- **WHEN** `install.js` has finished installing the binary on Windows
- **THEN** it SHALL perform the multiplexer detection and print the psmux install hint if missing (without failing the npm install itself)

### Requirement: Release workflow 产出 Windows 二进制
`.github/workflows/release.yml` MUST build and publish Windows platform binaries on release for `install.ps1` and `install.js` to download.

#### Scenario: x86_64-pc-windows-msvc 构建
- **WHEN** a release tag (`v*`) is pushed
- **THEN** the workflow SHALL build `omniterm.exe` on `windows-latest` with target `x86_64-pc-windows-msvc` and upload it as a release asset named `omniterm-windows-x86_64.zip`

#### Scenario: aarch64-pc-windows-msvc 构建
- **WHEN** a release tag is pushed
- **THEN** the workflow SHALL build `omniterm.exe` on an ARM64-capable runner with target `aarch64-pc-windows-msvc` and upload it as a release asset named `omniterm-windows-aarch64.zip`

#### Scenario: npm 包同步更新
- **WHEN** the release workflow completes
- **THEN** the platform map in `npm-package/install.js` SHALL include Windows entries matching the newly published asset names
