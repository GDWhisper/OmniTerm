const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'GDWhisper';
const REPO = 'OmniTerm';
const VERSION = require('./package.json').version;
const BIN_DIR = __dirname;
const BIN_NAME = process.platform === 'win32' ? 'omniterm.exe' : 'omniterm';

const CONNECT_TIMEOUT = 30_000; // 连接超时 30s
const DOWNLOAD_TIMEOUT = 300_000; // 下载超时 5min
const MAX_REDIRECTS = 5;

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
      '\x1b[33m⚠  tmux is not installed. omniterm requires tmux.\n' +
      '    Install:  sudo apt install tmux  /  brew install tmux\x1b[0m'
    );
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let downloaded = 0;
    let total = 0;
    let lastLog = 0;
    let dlTimeout;

    const req = https.get(url, { timeout: CONNECT_TIMEOUT }, (res) => {
      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        if (redirects >= MAX_REDIRECTS) {
          clearTimeout(dlTimeout);
          reject(new Error('Too many redirects'));
          return;
        }
        download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        clearTimeout(dlTimeout);
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      total = parseInt(res.headers['content-length'], 10) || 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        // 每秒最多输出一次进度
        if (now - lastLog > 1000 || downloaded === total) {
          lastLog = now;
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(1);
            process.stdout.write(
              `\r  omniterm: ${formatBytes(downloaded)} / ${formatBytes(total)} (${pct}%)`
            );
          } else {
            process.stdout.write(`\r  omniterm: ${formatBytes(downloaded)} downloaded...`);
          }
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        clearTimeout(dlTimeout);
        process.stdout.write('\n');
        resolve();
      });
    });

    req.on('error', (err) => {
      clearTimeout(dlTimeout);
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });

    req.on('timeout', () => {
      clearTimeout(dlTimeout);
      req.destroy();
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(new Error('Connection timed out'));
    });

    dlTimeout = setTimeout(() => {
      req.destroy();
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(new Error('Download timed out'));
    }, DOWNLOAD_TIMEOUT);
  });
}

async function main() {
  const suffix = platformMap();
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/omniterm-${suffix}`;
  const dest = path.join(BIN_DIR, BIN_NAME);

  if (fs.existsSync(dest)) {
    console.log(`omniterm: binary already installed`);
    fs.chmodSync(dest, 0o755);
    checkTmux();
    return;
  }

  console.log(`omniterm: downloading native binary for ${suffix}...`);
  console.log(`  from: ${url}`);

  try {
    await download(url, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`omniterm: installed successfully`);
  } catch (err) {
    console.error(`\nomniterm: failed to download: ${err.message}`);
    console.error('  Try alternative install methods:');
    console.error('    curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash');
    process.exit(1);
  }

  checkTmux();
}

main();
