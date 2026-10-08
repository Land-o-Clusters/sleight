import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveForm, tasks } from '../bench/tasks.mjs';

const task = tasks.find(t => t.id === 'simulator-form');
const submit = (url, message) => fetch(url, { method: 'POST', body: new URLSearchParams({ message }) });

test('the simulator form passes only on the exact text, then closes its server', async () => {
  const url = await serveForm('abc123');
  const page = await (await fetch(url)).text();
  assert.match(page, /autocapitalize="off"/);
  await submit(url, 'Sleight bench abc123');
  assert.match(String(task.check({ nonce: 'abc123' })), /received \["Sleight bench abc123"\]/);
  await assert.rejects(fetch(url));

  const again = await serveForm('def456');
  await submit(again, 'sleight bench def456');
  assert.equal(task.check({ nonce: 'def456' }), true);
});
