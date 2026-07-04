const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'GDWhisper';
const REPO = 'OmniTerm';
const VERSION = require('./package.json').version;
const BIN_DIR = __dirname;
const BIN_NAME = process.platform === 'win32' ? 'omniterm.exe' : 'omniterm';

function platformMap() {
  const p = process.platform;
  const a = process.arch;

  if (p === 'win32') {
    console.error('omniterm: Windows is not supported (requires tmux).');
    process.exit(1);
  }

  const map = {
    'linux-x64': 'linux-x86_64',
    'linux-arm64': 'linux-aarch64',
    'darwin-arm64': 'macos-aarch64',
  };

  const key = `${p}-${a}`;
  const suffix = map[key];
  if (!suffix) {
    console.error(`omniterm: Unsupported platform: ${p}-${a}`);
    process.exit(1);
  }
  return suffix;
}

function checkTmux() {
  try {
    execSync('which tmux', { stdio: 'ignore' });
  } catch {
    console.warn(
      '⚠️  tmux is not installed. omniterm requires tmux to function.\n' +
      '    Install it:  sudo apt install tmux  (Linux) /  brew install tmux  (macOS)\n' +
      '    Then restart omniterm.'
    );
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

async function main() {
  const suffix = platformMap();
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/omniterm-${suffix}`;
  const dest = path.join(BIN_DIR, BIN_NAME);

  if (fs.existsSync(dest)) {
    console.log(`omniterm: binary already installed at ${dest}`);
    fs.chmodSync(dest, 0o755);
    checkTmux();
    return;
  }

  console.log(`omniterm: downloading native binary for ${suffix}...`);
  try {
    await download(url, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`omniterm: installed to ${dest}`);
  } catch (err) {
    console.error(`omniterm: failed to download binary: ${err.message}`);
    console.error(`    URL: ${url}`);
    console.error('    Try installing via: cargo install omniterm');
    process.exit(1);
  }

  checkTmux();
}

main();
