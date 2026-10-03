const readXlsxFile = require('read-excel-file/node');

const ID_HEADERS = new Set(['id', 'username', 'user', 'account', 'tai khoan', 'tài khoản']);
const PASS_HEADERS = new Set(['pass', 'password', 'mat khau', 'mật khẩu']);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

async function parseAccounts(buffer, filename = 'accounts.xlsx') {
  let rows;
  if (/\.csv$/i.test(filename)) {
    rows = parseCsv(buffer.toString('utf8'));
  } else if (/\.xlsx$/i.test(filename)) {
    const workbookResult = await readXlsxFile(buffer);
    rows = Array.isArray(workbookResult)
      && workbookResult.length > 0
      && !Array.isArray(workbookResult[0])
      && Array.isArray(workbookResult[0]?.data)
      ? workbookResult[0].data
      : workbookResult;
  } else {
    throw new Error('Định dạng chưa hỗ trợ. Hãy dùng file .xlsx hoặc .csv.');
  }
  rows = rows.filter((row) => row.some((cell) => String(cell ?? '').trim()));
  if (!rows.length) throw new Error('File không có dữ liệu.');

  function parseCsv(source) {
    const text = source.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const candidates = [',', ';', '\t'];
    const delimiter = candidates.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
    const parsed = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(cell);
        cell = '';
      } else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cell);
        parsed.push(row);
        row = [];
        cell = '';
      } else {
        cell += character;
      }
    }
    if (cell.length || row.length) {
      row.push(cell);
      parsed.push(row);
    }
    return parsed;
  }

  let idColumn = 0;
  let passwordColumn = 1;
  let startAt = 0;
  const first = rows[0].map(normalized);
  const detectedId = first.findIndex((value) => ID_HEADERS.has(value));
  const detectedPassword = first.findIndex((value) => PASS_HEADERS.has(value));
  if (detectedId >= 0 && detectedPassword >= 0) {
    idColumn = detectedId;
    passwordColumn = detectedPassword;
    startAt = 1;
  }

  const accounts = [];
  const seen = new Set();
  for (let index = startAt; index < rows.length; index += 1) {
    const id = String(rows[index][idColumn] ?? '').trim();
    const password = String(rows[index][passwordColumn] ?? '').trim();
    if (!id && !password) continue;
    if (!id || !password) {
      throw new Error(`Dòng ${index + 1} thiếu ID hoặc mật khẩu.`);
    }
    if (seen.has(id)) {
      throw new Error(`ID bị trùng tại dòng ${index + 1}: ${id}`);
    }
    seen.add(id);
    accounts.push({ id, password });
  }
  if (!accounts.length) throw new Error('Không tìm thấy tài khoản hợp lệ.');
  return accounts;
}

class AccountQueue {
  constructor(onChange = () => {}) {
    this.items = [];
    this.onChange = onChange;
  }

  load(accounts, completed = new Map()) {
    this.items = accounts.map((account, index) => ({
      index: index + 1,
      id: account.id,
      password: account.password,
      status: completed.has(account.id) ? 'success' : 'queued',
      workerId: null,
      attempts: 0,
      message: completed.has(account.id) ? 'Đã hoàn tất ở lần chạy trước' : '',
      image: completed.get(account.id) || null,
      updatedAt: new Date().toISOString()
    }));
    this.onChange();
  }

  remove(ids) {
    const selected = new Set(Array.isArray(ids) ? ids.map(String) : []);
    if (!selected.size) return 0;
    const running = this.items.find((item) => selected.has(item.id) && item.status === 'running');
    if (running) throw new Error(`Không thể xóa tài khoản đang chạy: ${running.id}`);
    const before = this.items.length;
    this.items = this.items.filter((item) => !selected.has(item.id));
    this.reindex();
    const removed = before - this.items.length;
    if (removed) this.onChange();
    return removed;
  }

  startFrom(id) {
    if (!id) return false;
    const targetIndex = this.items.findIndex((item) => item.id === String(id) && item.status === 'queued');
    if (targetIndex < 0) throw new Error('Tài khoản bắt đầu không còn ở trạng thái chờ.');
    if (targetIndex > 0) {
      this.items = [...this.items.slice(targetIndex), ...this.items.slice(0, targetIndex)];
      this.reindex();
      this.onChange();
    }
    return true;
  }

  reindex() {
    this.items.forEach((item, index) => {
      item.index = index + 1;
    });
  }

  claim(workerId) {
    const account = this.items.find((item) => item.status === 'queued');
    if (!account) return null;
    account.status = 'running';
    account.workerId = workerId;
    account.attempts += 1;
    account.message = 'Đang xử lý';
    account.updatedAt = new Date().toISOString();
    this.onChange();
    return account;
  }

  update(account, status, fields = {}) {
    Object.assign(account, fields, { status, updatedAt: new Date().toISOString() });
    this.onChange();
  }

  release(account, message) {
    this.update(account, 'queued', { workerId: null, message });
  }

  retryFailures() {
    let count = 0;
    for (const item of this.items) {
      if (item.status === 'failed') {
        item.status = 'queued';
        item.workerId = null;
        item.message = 'Chờ chạy lại';
        item.updatedAt = new Date().toISOString();
        count += 1;
      }
    }
    if (count) this.onChange();
    return count;
  }

  publicItems() {
    return this.items.map(({ password, ...safe }) => safe);
  }

  summary() {
    const summary = { total: this.items.length, queued: 0, running: 0, success: 0, failed: 0 };
    for (const item of this.items) {
      if (Object.prototype.hasOwnProperty.call(summary, item.status)) summary[item.status] += 1;
    }
    return summary;
  }
}

module.exports = { parseAccounts, AccountQueue };
