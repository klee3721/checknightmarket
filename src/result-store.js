const fs = require('fs');
const path = require('path');
const { ensureDir, safeFilename, timestampForFile, relativeWebPath } = require('./utils');

function csvCell(value) {
  const text = String(value ?? '');
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function parseCsvRow(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells.map((cell) => cell.replace(/^'(?=[=+\-@])/, ''));
}

class ResultStore {
  constructor(root) {
    this.root = ensureDir(root);
    this.csvPath = path.join(root, 'results.csv');
    if (!fs.existsSync(this.csvPath)) {
      fs.writeFileSync(this.csvPath, '\uFEFFid,image,status,worker,timestamp,message\r\n', 'utf8');
    }
  }

  imagePath(accountId) {
    const folder = ensureDir(path.join(this.root, safeFilename(accountId)));
    return path.join(folder, `nightmarket_${timestampForFile()}.png`);
  }

  append({ id, image = '', status, workerId, message = '' }) {
    const timestamp = new Date().toISOString();
    const relativeImage = image ? relativeWebPath(this.root, image) : '';
    const row = [id, relativeImage, status, workerId, timestamp, message].map(csvCell).join(',');
    fs.appendFileSync(this.csvPath, `${row}\r\n`, 'utf8');
    return relativeImage;
  }

  successfulResults() {
    const completed = new Map();
    if (!fs.existsSync(this.csvPath)) return completed;
    const lines = fs.readFileSync(this.csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line) continue;
      const [id, image, status] = parseCsvRow(line);
      if (status === 'success') completed.set(id, image);
    }
    return completed;
  }

  listSuccessfulResults() {
    const metadataByImage = new Map();
    if (fs.existsSync(this.csvPath)) {
      const lines = fs.readFileSync(this.csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1);
      for (const line of lines) {
        if (!line) continue;
        const [id, image, status, workerId, timestamp, message] = parseCsvRow(line);
        if (status === 'success' && image) {
          metadataByImage.set(image, { id, image, workerId, timestamp, message });
        }
      }
    }

    const candidates = [];
    for (const directory of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const folder = path.join(this.root, directory.name);
      for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!file.isFile() || !/^nightmarket_.*\.png$/i.test(file.name)) continue;
        const image = relativeWebPath(this.root, path.join(folder, file.name));
        const metadata = metadataByImage.get(image);
        const stats = fs.statSync(path.join(folder, file.name));
        candidates.push({
          id: metadata?.id || directory.name,
          image,
          workerId: metadata?.workerId || '',
          timestamp: metadata?.timestamp || stats.mtime.toISOString(),
          message: metadata?.message || 'Ảnh kết quả trong workspace'
        });
      }
    }

    const latestByAccount = new Map();
    for (const result of candidates) {
      const current = latestByAccount.get(result.id);
      if (!current || Date.parse(result.timestamp) >= Date.parse(current.timestamp)) {
        latestByAccount.set(result.id, result);
      }
    }
    return [...latestByAccount.values()].sort((left, right) => (
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
    ));
  }
}

module.exports = { ResultStore, parseCsvRow };
