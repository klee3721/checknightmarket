const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAccounts, AccountQueue } = require('../src/account-store');
const { safeFilename } = require('../src/utils');
const { isTokenUrl } = require('../src/automation');

function csvBuffer(rows) {
  return Buffer.from(rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
}

test('parses named id/pass columns as text', async () => {
  const accounts = await parseAccounts(csvBuffer([
    ['id', 'pass'],
    ['00123', 'secret'],
    ['second', 'p@ss']
  ]), 'accounts.csv');
  assert.deepEqual(accounts, [
    { id: '00123', password: 'secret' },
    { id: 'second', password: 'p@ss' }
  ]);
});

test('parses a headerless two-column sheet', async () => {
  assert.deepEqual(await parseAccounts(csvBuffer([['alpha', 'beta']]), 'accounts.csv'), [{ id: 'alpha', password: 'beta' }]);
});

test('rejects duplicates and never exposes passwords', async () => {
  await assert.rejects(() => parseAccounts(csvBuffer([['id', 'pass'], ['a', 'x'], ['a', 'y']]), 'accounts.csv'), /trùng/);
  const queue = new AccountQueue();
  queue.load([{ id: 'a', password: 'secret' }]);
  assert.equal(queue.publicItems()[0].password, undefined);
});

test('restores completed accounts without exposing passwords', () => {
  const queue = new AccountQueue();
  queue.load(
    [{ id: 'done', password: 'secret' }, { id: 'next', password: 'secret-2' }],
    new Map([['done', 'done/nightmarket.png']])
  );
  assert.deepEqual(queue.summary(), { total: 2, queued: 1, running: 0, success: 1, failed: 0 });
  assert.equal(queue.publicItems()[0].image, 'done/nightmarket.png');
  assert.equal(queue.publicItems()[0].password, undefined);
});

test('removes selected accounts and reindexes the queue', () => {
  const queue = new AccountQueue();
  queue.load([
    { id: 'a', password: '1' },
    { id: 'b', password: '2' },
    { id: 'c', password: '3' }
  ]);
  assert.equal(queue.remove(['b']), 1);
  assert.deepEqual(queue.publicItems().map(({ id, index }) => ({ id, index })), [
    { id: 'a', index: 1 },
    { id: 'c', index: 2 }
  ]);
});

test('rotates the queue so the selected account is claimed first', () => {
  const queue = new AccountQueue();
  queue.load([
    { id: 'a', password: '1' },
    { id: 'b', password: '2' },
    { id: 'c', password: '3' },
    { id: 'd', password: '4' }
  ]);
  queue.startFrom('c');
  assert.deepEqual(queue.publicItems().map((account) => account.id), ['c', 'd', 'a', 'b']);
  assert.equal(queue.claim(1).id, 'c');
  assert.equal(queue.claim(2).id, 'd');
});

test('token URL recognition is strict and filenames are safe', () => {
  assert.equal(isTokenUrl('http://localhost/redirect#access_token=abc&scope=x'), true);
  assert.equal(isTokenUrl('https://evil.test/#access_token=abc'), false);
  assert.equal(safeFilename('a/b:c*'), 'a_b_c_');
});

test('CSV parser supports semicolons and quoted delimiters', async () => {
  const csv = Buffer.from('id;pass\r\n"name;one";"p;ass"');
  assert.deepEqual(await parseAccounts(csv, 'accounts.csv'), [{ id: 'name;one', password: 'p;ass' }]);
});
