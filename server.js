const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const express = require('express');
const multer = require('multer');
const { parseAccounts, AccountQueue } = require('./src/account-store');
const { ResultStore } = require('./src/result-store');
const { BrowserManager } = require('./src/automation');
const { ensureDir } = require('./src/utils');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
ensureDir(path.join(ROOT, 'runtime'));
ensureDir(path.join(ROOT, 'profiles'));
ensureDir(path.join(ROOT, 'results'));

class AppEvents extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
  }

  log(entry) {
    const safeEntry = {
      at: new Date().toISOString(),
      workerId: entry.workerId,
      accountId: entry.accountId,
      level: entry.level || 'info',
      message: String(entry.message).replace(/access_token=[^&#\s]+/gi, 'access_token=[REDACTED]')
    };
    this.logs.push(safeEntry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.emit('log', safeEntry);
    this.changed();
  }

  changed() {
    this.emit('changed');
  }
}

const events = new AppEvents();
const queue = new AccountQueue(() => events.changed());
const resultStore = new ResultStore(path.join(ROOT, 'results'));
const manager = new BrowserManager({ root: ROOT, config, events, resultStore });
manager.configure(1, false, true, false).catch(console.error);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/results', express.static(path.join(ROOT, 'results'), { fallthrough: false }));

function state() {
  return {
    queue: queue.summary(),
    accounts: queue.publicItems(),
    manager: manager.publicState(),
    logs: events.logs.slice(-200)
  };
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

app.get('/api/state', (request, response) => response.json(state()));

app.get('/api/results', (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({ results: resultStore.listSuccessfulResults() });
});

app.get('/api/events', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  const send = () => response.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
  events.on('changed', send);
  send();
  request.on('close', () => {
    clearInterval(heartbeat);
    events.off('changed', send);
  });
});

app.post('/api/import', upload.single('accounts'), asyncRoute(async (request, response) => {
  if (manager.running) return response.status(409).json({ error: 'Hãy dừng hàng đợi trước khi nhập file mới.' });
  if (!request.file) return response.status(400).json({ error: 'Chưa chọn file Excel/CSV.' });
  try {
    const accounts = await parseAccounts(request.file.buffer, request.file.originalname);
    const completed = request.query.resume === '1' ? resultStore.successfulResults() : new Map();
    queue.load(accounts, completed);
    events.log({ workerId: 0, level: 'success', message: `Đã nạp ${accounts.length} tài khoản từ ${request.file.originalname}.` });
    response.json({ count: accounts.length });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}));

app.post('/api/configure', asyncRoute(async (request, response) => {
  await manager.configure(
    request.body.workerCount,
    request.body.headless,
    request.body.previewEnabled,
    request.body.closeRiotAfterToken
  );
  response.json({ ok: true });
}));

app.post('/api/accounts/delete', (request, response) => {
  if (manager.running) return response.status(409).json({ error: 'Không thể xóa tài khoản khi hàng đợi đang chạy.' });
  const ids = Array.isArray(request.body.ids) ? request.body.ids.slice(0, 10000) : [];
  const count = queue.remove(ids);
  events.log({ workerId: 0, level: 'info', message: `Đã xóa ${count} tài khoản khỏi hàng đợi hiện tại.` });
  response.json({ count });
});

app.post('/api/accounts/remove-completed', (request, response) => {
  if (manager.running) return response.status(409).json({ error: 'Không thể check trùng khi hàng đợi đang chạy.' });
  const normalizeId = (id) => String(id).trim().toLowerCase();
  const completedIds = new Set(resultStore.listSuccessfulResults().map((result) => normalizeId(result.id)));
  const duplicates = queue.publicItems()
    .map((account) => account.id)
    .filter((id) => completedIds.has(normalizeId(id)));
  const count = queue.remove(duplicates);
  events.log({
    workerId: 0,
    level: count ? 'success' : 'info',
    message: count
      ? `Đã check trùng và xóa ${count} tài khoản đã thành công khỏi hàng đợi.`
      : 'Đã check trùng: không có tài khoản thành công nào bị trùng.'
  });
  response.json({ count });
});

app.post('/api/workers/:id/open', asyncRoute(async (request, response) => {
  await manager.openSetup(request.params.id);
  response.json({ ok: true });
}));

app.post('/api/workers/:id/verify', asyncRoute(async (request, response) => {
  await manager.verify(request.params.id);
  response.json({ ok: true });
}));

app.get('/api/workers/:id/inspect-menzu', asyncRoute(async (request, response) => {
  response.json(await manager.inspectMenzuArchive(request.params.id));
}));

app.get('/api/workers/:id/inspect-night-market', asyncRoute(async (request, response) => {
  response.json(await manager.inspectMenzuNightMarket(request.params.id));
}));

app.post('/api/workers/:id/close', asyncRoute(async (request, response) => {
  await manager.close(request.params.id);
  response.json({ ok: true });
}));

app.post('/api/workers/:id/resume', (request, response, next) => {
  try {
    manager.resumeManualLogin(request.params.id);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/workers/:id/run', asyncRoute(async (request, response) => {
  queue.startFrom(request.body?.startAccountId);
  await manager.startWorker(request.params.id, queue);
  response.json({ ok: true });
}));

app.get('/api/workers/:id/preview', (request, response) => {
  try {
    const worker = manager.getWorker(request.params.id);
    if (!fs.existsSync(worker.previewPath)) return response.sendStatus(404);
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(worker.previewPath);
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.post('/api/run', (request, response, next) => {
  try {
    queue.startFrom(request.body?.startAccountId);
    manager.start(queue);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/stop', (request, response) => {
  manager.stop();
  response.json({ ok: true });
});

app.post('/api/retry', (request, response) => {
  if (manager.running) return response.status(409).json({ error: 'Hãy dừng hàng đợi trước khi đưa lỗi vào chạy lại.' });
  const count = queue.retryFailures();
  events.log({ workerId: 0, level: 'info', message: `Đã đưa ${count} tài khoản lỗi về hàng đợi.` });
  response.json({ count });
});

app.use((error, request, response, next) => {
  console.error(error);
  response.status(500).json({ error: error.message || 'Lỗi không xác định.' });
});

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Night Market Checker: http://127.0.0.1:${config.port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, state };
