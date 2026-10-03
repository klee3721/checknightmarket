const elements = {
  uploadForm: document.querySelector('#upload-form'),
  accountsFile: document.querySelector('#accounts-file'),
  workerCount: document.querySelector('#worker-count'),
  headless: document.querySelector('#headless'),
  previewEnabled: document.querySelector('#preview-enabled'),
  closeRiotAfterToken: document.querySelector('#close-riot-after-token'),
  applyConfig: document.querySelector('#apply-config'),
  start: document.querySelector('#start'),
  stop: document.querySelector('#stop'),
  retry: document.querySelector('#retry'),
  selectAllAccounts: document.querySelector('#select-all-accounts'),
  selectionSummary: document.querySelector('#selection-summary'),
  removeCompletedAccounts: document.querySelector('#remove-completed-accounts'),
  clearAccountSelection: document.querySelector('#clear-account-selection'),
  deleteSelectedAccounts: document.querySelector('#delete-selected-accounts'),
  tabRunning: document.querySelector('#tab-running'),
  tabCompleted: document.querySelector('#tab-completed'),
  pageRunning: document.querySelector('#page-running'),
  pageCompleted: document.querySelector('#page-completed'),
  completedCount: document.querySelector('#completed-count'),
  completedResults: document.querySelector('#completed-results'),
  refreshResults: document.querySelector('#refresh-results'),
  workers: document.querySelector('#workers'),
  accounts: document.querySelector('#accounts'),
  logs: document.querySelector('#logs'),
  runState: document.querySelector('#run-state'),
  toast: document.querySelector('#toast')
};

let latestState = null;
let localLogsClearedAt = null;
let toastTimer = null;
let lastCompletionEventAt = null;
let resultsRequest = null;
let selectedAccountIds = new Set();
let startAccountId = null;
let selectionAnchorIndex = null;

function toast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.className = ''; }, 3500);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : {};
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function text(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function statusLabel(status) {
  return ({
    closed: 'Đã đóng', launching: 'Đang mở', idle: 'Sẵn sàng', running: 'Đang chạy',
    stopping: 'Đang dừng', manual_login: 'Đăng nhập Riot thủ công', needs_setup: 'Cần đăng nhập', needs_attention: 'Cần kiểm tra', queued: 'Đang chờ',
    success: 'Thành công', failed: 'Lỗi'
  })[status] || status;
}

function resultUrl(relative) {
  return `/results/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function showPage(name) {
  const completed = name === 'completed';
  elements.pageRunning.hidden = completed;
  elements.pageCompleted.hidden = !completed;
  elements.tabRunning.classList.toggle('active', !completed);
  elements.tabCompleted.classList.toggle('active', completed);
  elements.tabRunning.setAttribute('aria-selected', String(!completed));
  elements.tabCompleted.setAttribute('aria-selected', String(completed));
  if (completed) refreshCompletedResults();
}

async function refreshCompletedResults() {
  if (resultsRequest) return resultsRequest;
  elements.refreshResults.disabled = true;
  resultsRequest = api('/api/results')
    .then(({ results }) => renderCompletedResults(results))
    .catch((error) => toast(error.message, true))
    .finally(() => {
      resultsRequest = null;
      elements.refreshResults.disabled = false;
    });
  return resultsRequest;
}

function renderCompletedResults(results) {
  elements.completedCount.textContent = results.length;
  elements.completedResults.replaceChildren();
  if (!results.length) {
    const row = document.createElement('tr');
    const cell = text('td', 'Chưa có ảnh Night Market thành công trong workspace.', 'empty');
    cell.colSpan = 5;
    row.append(cell);
    elements.completedResults.append(row);
    return;
  }
  results.forEach((result, index) => {
    const row = document.createElement('tr');
    row.append(text('td', index + 1));
    row.append(text('td', result.id));
    const imageCell = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'result-preview';
    link.href = resultUrl(result.image);
    link.target = '_blank';
    link.rel = 'noopener';
    const image = document.createElement('img');
    image.src = resultUrl(result.image);
    image.alt = `Night Market ${result.id}`;
    image.loading = 'lazy';
    link.append(image, text('span', 'Mở ảnh'));
    imageCell.append(link);
    row.append(imageCell);
    row.append(text('td', new Date(result.timestamp).toLocaleString('vi-VN', { hour12: false })));
    row.append(text('td', result.workerId || '—'));
    elements.completedResults.append(row);
  });
}

function render(state) {
  latestState = state;
  const { queue, manager } = state;
  for (const key of ['total', 'queued', 'running', 'success', 'failed']) {
    document.querySelector(`#stat-${key}`).textContent = queue[key];
  }
  elements.runState.textContent = manager.running ? 'Đang chạy' : 'Đang nghỉ';
  elements.runState.className = `pill ${manager.running ? 'running' : 'muted'}`;
  elements.start.disabled = manager.running || queue.queued === 0;
  elements.stop.disabled = !manager.running;
  elements.applyConfig.disabled = manager.running;
  elements.retry.disabled = manager.running || queue.failed === 0;
  elements.workerCount.value = manager.workers.length;
  elements.headless.checked = manager.defaultHeadless;
  elements.previewEnabled.checked = manager.previewEnabled;
  elements.closeRiotAfterToken.checked = manager.closeRiotAfterToken;
  elements.closeRiotAfterToken.disabled = manager.running || manager.defaultHeadless;
  renderWorkers(manager.workers, queue.queued);
  renderAccounts(state.accounts);
  renderLogs(state.logs);
  const completion = [...state.logs].reverse().find((entry) => entry.level === 'success' && /^Hoàn tất, ảnh:/.test(entry.message));
  if (completion?.at && completion.at !== lastCompletionEventAt) {
    lastCompletionEventAt = completion.at;
    refreshCompletedResults();
  }
}

function renderWorkers(workers, queuedCount) {
  elements.workers.replaceChildren();
  for (const worker of workers) {
    const card = document.createElement('article');
    card.className = 'worker';
    const head = document.createElement('div');
    head.className = 'worker-head';
    head.append(text('h3', `Luồng ${worker.id}${worker.headless === true ? ' · ngầm' : worker.headless === false ? ' · hiện' : ''}`));
    head.append(text('span', worker.currentAccount || statusLabel(worker.status), `pill ${['running', 'manual_login'].includes(worker.status) ? 'running' : ['needs_setup', 'needs_attention'].includes(worker.status) ? 'failed' : 'muted'}`));
    card.append(head);

    const screen = document.createElement('div');
    screen.className = 'worker-screen';
    if (worker.hasPreview && latestState.manager.previewEnabled) {
      const image = document.createElement('img');
      image.alt = `Màn hình luồng ${worker.id}`;
      image.src = `/api/workers/${worker.id}/preview?t=${Date.now()}`;
      screen.append(image);
    } else {
      screen.append(text('span', latestState.manager.previewEnabled ? 'Chưa có ảnh xem trước' : 'Đã tắt ảnh xem trước', 'empty'));
    }
    card.append(screen);

    const actions = document.createElement('div');
    actions.className = 'worker-actions';
    const busy = ['running', 'stopping', 'launching', 'manual_login'].includes(worker.status);
    actions.append(workerButton('Mở / đăng nhập Menzu', worker.id, 'open', busy));
    actions.append(workerButton('Kiểm tra phiên', worker.id, 'verify', busy || !worker.launched));
    actions.append(workerButton('Chạy luồng này', worker.id, 'run', busy || queuedCount === 0));
    actions.append(workerButton('Đã đăng nhập Riot · tiếp tục', worker.id, 'resume', worker.status !== 'manual_login'));
    actions.append(workerButton('Đóng', worker.id, 'close', busy || !worker.launched));
    card.append(actions);
    elements.workers.append(card);
  }
}

function workerButton(label, id, action, disabled) {
  const button = text('button', label, 'small');
  button.disabled = disabled;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const options = { method: 'POST' };
      if (action === 'run') {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ startAccountId });
      }
      await api(`/api/workers/${id}/${action}`, options);
      toast(action === 'open' ? `Đã mở profile luồng ${id}.` : 'Đã thực hiện.');
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderAccounts(accounts) {
  const activeAccounts = accounts.filter((account) => account.status !== 'success');
  const visibleIds = new Set(activeAccounts.map((account) => account.id));
  selectedAccountIds = new Set([...selectedAccountIds].filter((id) => visibleIds.has(id)));
  if (!startAccountId || !selectedAccountIds.has(startAccountId)) {
    startAccountId = activeAccounts.find((account) => account.status === 'queued' && selectedAccountIds.has(account.id))?.id || null;
  }
  elements.accounts.replaceChildren();
  if (!activeAccounts.length) {
    const row = document.createElement('tr');
    const cell = text('td', accounts.length ? 'Không còn tài khoản đang chờ hoặc đang chạy.' : 'Chưa nạp file', 'empty');
    cell.colSpan = 6;
    row.append(cell);
    elements.accounts.append(row);
    updateSelectionControls(activeAccounts);
    return;
  }
  activeAccounts.forEach((account, accountIndex) => {
    const row = document.createElement('tr');
    if (selectedAccountIds.has(account.id)) row.classList.add('account-selected');
    if (account.id === startAccountId) row.classList.add('account-start');
    const selectCell = document.createElement('td');
    selectCell.className = 'account-select-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedAccountIds.has(account.id);
    checkbox.disabled = Boolean(latestState?.manager.running);
    checkbox.setAttribute('aria-label', `Chọn ${account.id}`);
    checkbox.addEventListener('click', (event) => {
      const checked = checkbox.checked;
      if (event.shiftKey && selectionAnchorIndex !== null) {
        const from = Math.min(selectionAnchorIndex, accountIndex);
        const to = Math.max(selectionAnchorIndex, accountIndex);
        for (let index = from; index <= to; index += 1) {
          const rangedAccount = activeAccounts[index];
          if (checked) selectedAccountIds.add(rangedAccount.id);
          else selectedAccountIds.delete(rangedAccount.id);
        }
      } else if (checked) {
        selectedAccountIds.add(account.id);
      } else {
        selectedAccountIds.delete(account.id);
      }
      selectionAnchorIndex = accountIndex;
      if (checked && !startAccountId && account.status === 'queued') startAccountId = account.id;
      if (!selectedAccountIds.has(startAccountId)) {
        startAccountId = activeAccounts.find((candidate) => candidate.status === 'queued' && selectedAccountIds.has(candidate.id))?.id || null;
      }
      renderAccounts(latestState.accounts);
    });
    selectCell.append(checkbox);
    row.append(selectCell);
    row.append(text('td', account.index));
    const idCell = text('td', account.id);
    if (account.id === startAccountId) idCell.append(text('span', 'Bắt đầu', 'start-badge'));
    row.append(idCell);
    row.append(text('td', statusLabel(account.status), `status-${account.status}`));
    row.append(text('td', account.workerId || '—'));
    const result = document.createElement('td');
    if (account.image) {
      const link = text('a', 'Mở ảnh', 'result-link');
      link.href = resultUrl(account.image);
      link.target = '_blank';
      link.rel = 'noopener';
      result.append(link);
    }
    if (account.message) result.append(text('div', account.message, 'message'));
    row.append(result);
    elements.accounts.append(row);
  });
  updateSelectionControls(activeAccounts);
}

function updateSelectionControls(activeAccounts) {
  const selectedCount = selectedAccountIds.size;
  const disabled = Boolean(latestState?.manager.running) || activeAccounts.length === 0;
  elements.selectAllAccounts.disabled = disabled;
  elements.selectAllAccounts.checked = activeAccounts.length > 0 && selectedCount === activeAccounts.length;
  elements.selectAllAccounts.indeterminate = selectedCount > 0 && selectedCount < activeAccounts.length;
  elements.clearAccountSelection.disabled = disabled || selectedCount === 0;
  elements.deleteSelectedAccounts.disabled = disabled || selectedCount === 0;
  elements.removeCompletedAccounts.disabled = Boolean(latestState?.manager.running) || !latestState?.queue.total;
  elements.selectionSummary.classList.toggle('has-selection', selectedCount > 0);
  elements.selectionSummary.textContent = selectedCount
    ? `Đã chọn ${selectedCount}${startAccountId ? ` · Bắt đầu từ: ${startAccountId}` : ''}`
    : 'Chưa chọn tài khoản · sẽ bắt đầu từ đầu danh sách';
}

function renderLogs(logs) {
  const visible = localLogsClearedAt ? logs.filter((entry) => entry.at > localLogsClearedAt) : logs;
  const wasNearBottom = elements.logs.scrollHeight - elements.logs.scrollTop - elements.logs.clientHeight < 70;
  elements.logs.replaceChildren();
  if (!visible.length) {
    elements.logs.append(text('p', 'Chưa có sự kiện', 'empty'));
    return;
  }
  for (const entry of visible) {
    const line = document.createElement('p');
    line.className = `log log-${entry.level}`;
    const time = new Date(entry.at).toLocaleTimeString('vi-VN', { hour12: false });
    line.append(text('time', `[${time}] `));
    line.append(text('span', entry.workerId ? `L${entry.workerId}` : 'APP', 'worker-label'));
    line.append(document.createTextNode(`${entry.accountId ? ` · ${entry.accountId}` : ''} — ${entry.message}`));
    elements.logs.append(line);
  }
  if (wasNearBottom) elements.logs.scrollTop = elements.logs.scrollHeight;
}

elements.uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = elements.accountsFile.files[0];
  if (!file) return;
  const data = new FormData();
  data.append('accounts', file);
  try {
    const result = await api('/api/import', { method: 'POST', body: data });
    selectedAccountIds.clear();
    startAccountId = null;
    selectionAnchorIndex = null;
    toast(`Đã nạp ${result.count} tài khoản.`);
  } catch (error) { toast(error.message, true); }
});

elements.applyConfig.addEventListener('click', async () => {
  try {
    await api('/api/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerCount: Number(elements.workerCount.value),
        headless: elements.headless.checked,
        previewEnabled: elements.previewEnabled.checked,
        closeRiotAfterToken: elements.closeRiotAfterToken.checked
      })
    });
    toast('Đã áp dụng cấu hình luồng.');
  } catch (error) { toast(error.message, true); }
});
elements.headless.addEventListener('change', () => {
  elements.closeRiotAfterToken.disabled = elements.headless.checked || Boolean(latestState?.manager.running);
});

elements.start.addEventListener('click', async () => {
  try {
    await api('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startAccountId })
    });
    toast(startAccountId ? `Đã bắt đầu từ ${startAccountId}.` : 'Đã bắt đầu từ đầu hàng đợi.');
  }
  catch (error) { toast(error.message, true); }
});
elements.stop.addEventListener('click', async () => {
  try { await api('/api/stop', { method: 'POST' }); toast('Các luồng sẽ dừng sau bước hiện tại.'); }
  catch (error) { toast(error.message, true); }
});
elements.retry.addEventListener('click', async () => {
  try { const result = await api('/api/retry', { method: 'POST' }); toast(`Đã đưa ${result.count} tài khoản về hàng đợi.`); }
  catch (error) { toast(error.message, true); }
});
elements.selectAllAccounts.addEventListener('change', () => {
  const activeAccounts = (latestState?.accounts || []).filter((account) => account.status !== 'success');
  if (elements.selectAllAccounts.checked) {
    selectedAccountIds = new Set(activeAccounts.map((account) => account.id));
    startAccountId ||= activeAccounts.find((account) => account.status === 'queued')?.id || null;
  } else {
    selectedAccountIds.clear();
    startAccountId = null;
  }
  selectionAnchorIndex = null;
  renderAccounts(latestState.accounts);
});
elements.clearAccountSelection.addEventListener('click', () => {
  selectedAccountIds.clear();
  startAccountId = null;
  selectionAnchorIndex = null;
  renderAccounts(latestState.accounts);
});
elements.deleteSelectedAccounts.addEventListener('click', async () => {
  const ids = [...selectedAccountIds];
  if (!ids.length || !window.confirm(`Xóa ${ids.length} tài khoản đã chọn khỏi hàng đợi hiện tại? Bạn có thể nạp lại file để khôi phục.`)) return;
  try {
    const result = await api('/api/accounts/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    selectedAccountIds.clear();
    startAccountId = null;
    selectionAnchorIndex = null;
    toast(`Đã xóa ${result.count} tài khoản khỏi hàng đợi.`);
  } catch (error) { toast(error.message, true); }
});
elements.removeCompletedAccounts.addEventListener('click', async () => {
  elements.removeCompletedAccounts.disabled = true;
  try {
    const result = await api('/api/accounts/remove-completed', { method: 'POST' });
    selectedAccountIds.clear();
    startAccountId = null;
    selectionAnchorIndex = null;
    toast(result.count
      ? `Đã xóa ${result.count} tài khoản trùng với danh sách thành công.`
      : 'Không tìm thấy tài khoản trùng với danh sách thành công.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (!latestState?.manager.running && latestState?.queue.total) elements.removeCompletedAccounts.disabled = false;
  }
});
elements.tabRunning.addEventListener('click', () => showPage('running'));
elements.tabCompleted.addEventListener('click', () => showPage('completed'));
elements.refreshResults.addEventListener('click', refreshCompletedResults);
document.querySelector('#clear-log').addEventListener('click', () => {
  localLogsClearedAt = new Date().toISOString();
  if (latestState) renderLogs(latestState.logs);
});

const source = new EventSource('/api/events');
source.addEventListener('state', (event) => render(JSON.parse(event.data)));
source.onerror = () => { elements.runState.textContent = 'Mất kết nối'; elements.runState.className = 'pill failed'; };

setInterval(() => {
  if (!latestState?.manager.previewEnabled) return;
  document.querySelectorAll('.worker-screen img').forEach((image) => {
    const workerId = image.alt.match(/\d+/)?.[0];
    if (workerId) image.src = `/api/workers/${workerId}/preview?t=${Date.now()}`;
  });
}, 1800);

Promise.all([
  api('/api/state').then(render),
  refreshCompletedResults()
]).catch((error) => toast(error.message, true));
