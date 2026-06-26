#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PLATFORM_MAP = {
  'linux-x64': 'omniterm-linux-x86_64',
  'linux-arm64': 'omniterm-linux-aarch64',
  'darwin-x64': 'omniterm-macos-x86_64',
  'darwin-arm64': 'omniterm-macos-aarch64',
};

const platform = `${process.platform}-${process.arch}`;
const binaryName = PLATFORM_MAP[platform];

if (!binaryName) {
  console.error(`Unsupported platform: ${platform}`);
  console.error('OmniTerm supports: linux (x64, arm64), macos (x64, arm64)');
  process.exit(1);
}

const binaryPath = path.join(__dirname, binaryName);

if (!fs.existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`);
  console.error('Run: npm install -g omniterm  to download the binary');
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

child.on('exit', (code) => { process.exit(code ?? 1); });
child.on('error', (err) => { console.error('Failed to start omniterm:', err.message); process.exit(1); });
