#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const BIN_NAME = process.platform === 'win32' ? 'omniterm.exe' : 'omniterm';

// 1. Look for binary next to shim.js (postinstall download location)
const localBin = path.join(__dirname, BIN_NAME);
if (existsSync(localBin)) {
  const result = spawnSync(localBin, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// 2. Fallback: look in PATH
const result = spawnSync('omniterm', process.argv.slice(2), { stdio: 'inherit' });
if (result.error && result.error.code === 'ENOENT') {
  console.error(
    'omniterm: native binary not found.\n' +
    'Run "npm install -g omniterm" to download it, or install via:\n' +
    '  curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash\n' +
    '  cargo install omniterm'
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
