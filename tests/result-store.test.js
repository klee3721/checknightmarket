const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResultStore } = require('../src/result-store');

test('reads successful results for queue resume', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmarket-results-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ResultStore(directory);
  store.append({ id: 'done', image: path.join(directory, 'done', 'night.png'), status: 'success', workerId: 1 });
  store.append({ id: 'failed', status: 'failed', workerId: 1 });
  assert.deepEqual([...store.successfulResults()], [['done', 'done/night.png']]);
});

test('lists the latest successful image per account from the results workspace', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmarket-results-list-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ResultStore(directory);
  const accountFolder = path.join(directory, 'done');
  const orphanFolder = path.join(directory, 'workspace-only');
  fs.mkdirSync(accountFolder, { recursive: true });
  fs.mkdirSync(orphanFolder, { recursive: true });
  const first = path.join(accountFolder, 'nightmarket_2026-01-01.png');
  const latest = path.join(accountFolder, 'nightmarket_2026-01-02.png');
  const orphan = path.join(orphanFolder, 'nightmarket_2026-01-03.png');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(latest, 'latest');
  fs.writeFileSync(orphan, 'orphan');
  store.append({ id: 'done', image: first, status: 'success', workerId: 1 });
  store.append({ id: 'done', image: latest, status: 'success', workerId: 2 });

  const results = store.listSuccessfulResults();
  assert.equal(results.length, 2);
  assert.equal(results.find((result) => result.id === 'done').image, 'done/nightmarket_2026-01-02.png');
  assert.equal(results.find((result) => result.id === 'done').workerId, '2');
  assert.equal(results.find((result) => result.id === 'workspace-only').image, 'workspace-only/nightmarket_2026-01-03.png');
});
