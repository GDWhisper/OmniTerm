const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'GDWhisper';
const REPO = 'OmniTerm';
const VERSION = '0.1.0'; // Updated by CI/release script
const BIN_DIR = __dirname;
const BIN_NAME = process.platform === 'win32' ? 'omniterm.exe' : 'omniterm';

function platformMap() {
  const p = process.platform;
  const a = process.arch;

  const map = {
    'linux-x64': { suffix: 'linux-x86_64', ext: '' },
    'linux-arm64': { suffix: 'linux-aarch64', ext: '' },
    'darwin-arm64': { suffix: 'macos-aarch64', ext: '' },
    'win32-x64': { suffix: 'windows-x86_64', ext: '.zip' },
    'win32-arm64': { suffix: 'windows-aarch64', ext: '.zip' },
  };

  const key = `${p}-${a}`;
  const entry = map[key];
  if (!entry) {
    console.error(`omniterm: Unsupported platform: ${p}-${a}`);
    process.exit(1);
  }
  return entry;
}

function checkMultiplexer() {
  if (process.platform === 'win32') {
    try {
      execSync('where tmux', { stdio: 'ignore' });
    } catch {
      try {
        execSync('where psmux', { stdio: 'ignore' });
      } catch {
        console.warn(
          '⚠️  psmux (tmux) is not installed. omniterm requires a terminal multiplexer.\n' +
          '    Install it:  winget install psmux   (recommended)\n' +
          '                 scoop install psmux\n' +
          '                 cargo install psmux\n' +
          '    Then restart omniterm.'
        );
      }
    }
  } else {
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

function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
      stdio: 'ignore',
    });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
  }
}

async function main() {
  const { suffix, ext } = platformMap();
  const assetName = `omniterm-${suffix}${ext}`;
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/${assetName}`;
  const dest = path.join(BIN_DIR, BIN_NAME);

  if (fs.existsSync(dest)) {
    console.log(`omniterm: binary already installed at ${dest}`);
    fs.chmodSync(dest, 0o755);
    checkMultiplexer();
    return;
  }

  console.log(`omniterm: downloading native binary for ${suffix}...`);
  try {
    if (ext === '.zip') {
      const tmpZip = path.join(BIN_DIR, assetName);
      await download(url, tmpZip);
      extractZip(tmpZip, BIN_DIR);
      fs.unlinkSync(tmpZip);
    } else {
      await download(url, dest);
    }
    fs.chmodSync(dest, 0o755);
    console.log(`omniterm: installed to ${dest}`);
  } catch (err) {
    console.error(`omniterm: failed to download binary: ${err.message}`);
    console.error(`    URL: ${url}`);
    console.error('    Try installing via: cargo install omniterm');
    process.exit(1);
  }

  checkMultiplexer();
}

main();
