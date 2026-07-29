#!/usr/bin/env node
const { spawnSync } = require('child_process');

// Native binary ships in a per-platform optionalDependency
// (@gdwhisper/omniterm-<platform>-<arch>), esbuild-style.
const PKG = `@gdwhisper/omniterm-${process.platform}-${process.arch}`;
const BIN = process.platform === 'win32' ? 'omniterm.exe' : 'omniterm';
const args = process.argv.slice(2);

// 1. Resolve the native binary from the installed platform package.
let binPath = null;
try {
  binPath = require.resolve(`${PKG}/bin/${BIN}`);
} catch {
  // platform package not installed (e.g. --omit=optional / unsupported platform)
}
if (binPath) {
  const result = spawnSync(binPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// 2. Fallback: a binary already on PATH. Guard against re-entering this shim
//    (the global `omniterm` launcher is this file — no guard = fork bomb).
if (!process.env.OMNITERM_SHIM) {
  const result = spawnSync(BIN, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, OMNITERM_SHIM: '1' },
  });
  if (!result.error) process.exit(result.status ?? 1);
}

console.error(
  `omniterm: native binary not found (${PKG} is not installed).\n` +
  'If you installed with --omit=optional / --no-optional, reinstall without it:\n' +
  '  npm install -g @gdwhisper/omniterm\n' +
  'Supported platforms: linux-x64, linux-arm64, darwin-arm64, win32-x64. Alternatives:\n' +
  '  curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash\n' +
  '  cargo install omniterm'
);
process.exit(1);
