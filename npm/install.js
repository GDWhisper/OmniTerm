const https = require('https');
const fs = require('fs');
const path = require('path');

const PLATFORM_MAP = {
  'linux-x64': 'omniterm-linux-x86_64',
  'linux-arm64': 'omniterm-linux-aarch64',
  'darwin-x64': 'omniterm-macos-x86_64',
  'darwin-arm64': 'omniterm-macos-aarch64',
};

const platform = `${process.platform}-${process.arch}`;
const binaryName = PLATFORM_MAP[platform];

if (!binaryName) {
  console.log(`Skipping binary download: unsupported platform ${platform}`);
  console.log('OmniTerm supports: linux (x64, arm64), macos (x64, arm64)');
  console.log('Build from source: cargo install omniterm');
  process.exit(0);
}

const dest = path.join(__dirname, binaryName);

if (fs.existsSync(dest)) {
  console.log(`omniterm binary already exists: ${dest}`);
  process.exit(0);
}

const version = require('./package.json').version;
const url = `https://github.com/pax/OmniTerm/releases/download/v${version}/${binaryName}`;

console.log(`Downloading omniterm v${version} for ${platform}...`);

function handleResponse(res) {
  if (res.statusCode === 302 || res.statusCode === 301) {
    https.get(res.headers.location, handleResponse).on('error', (err) => {
      console.error(`Download failed (redirect): ${err.message}`);
      process.exit(0);
    });
    return;
  }
  
  if (res.statusCode !== 200) {
    console.error(`Binary not available: HTTP ${res.statusCode}`);
    console.error('Build from source: cargo install omniterm');
    process.exit(0);
  }

  const file = fs.createWriteStream(dest, { mode: 0o755 });
  let downloaded = 0;
  res.on('data', (chunk) => { downloaded += chunk.length; });
  res.pipe(file);

  file.on('finish', () => {
    file.close();
    fs.chmodSync(dest, 0o755);
    console.log(`omniterm v${version} installed (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
  });

  file.on('error', (err) => {
    console.error(`Write failed: ${err.message}`);
    process.exit(0);
  });
}

https.get(url, (res) => {
  if (res.statusCode === 302 || res.statusCode === 301) {
    https.get(res.headers.location, handleResponse).on('error', (err) => {
      console.error(`Download failed: ${err.message}`);
      process.exit(0);
    });
    return;
  }
  handleResponse(res);
}).on('error', (err) => {
  console.error(`Download failed: ${err.message}`);
  console.error('Build from source: cargo install omniterm');
  process.exit(0);
});
