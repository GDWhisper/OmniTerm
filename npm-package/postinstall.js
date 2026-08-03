#!/usr/bin/env node
// postinstall.js — npm 全局安装完成后打印引导提示。
// 必须是纯提示：任何失败都不能导致 npm install 报错（try/catch 兜底）。
try {
  const msg = [
    '',
    'OmniTerm installed successfully!',
    '',
    'Open a NEW terminal and run:',
    '    omniterm start',
    '',
    'The server prints its URL on startup.',
    '',
  ].join('\n');
  process.stderr.write(msg);
} catch (err) {
  // never fail the install
}
