const fs = require('fs');
const path = require('path');
const os = require('os');

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function safeFilename(value) {
  const result = String(value)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return result || 'account';
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function findBrowserExecutable() {
  const platformCandidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  const candidates = [process.env.NIGHTMARKET_BROWSER, ...platformCandidates].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('Không tìm thấy Chrome/Edge. Đặt biến NIGHTMARKET_BROWSER tới file chạy của trình duyệt.');
  }
  return executable;
}

function relativeWebPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

module.exports = { ensureDir, safeFilename, timestampForFile, findBrowserExecutable, relativeWebPath };
