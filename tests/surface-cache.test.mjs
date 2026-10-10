import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { selectSurfaces } from '../plugins/sleight/lib/launch.mjs';
import { refreshAfterInitialize } from '../plugins/sleight/lib/surface-cache.mjs';

test('the initialize observer leaves later tool replies flowing through the relay stream', () => {
  const output = new PassThrough();
  const received = []; let refreshes = 0;
  output.on('data', data => received.push(data.toString()));
  refreshAfterInitialize(output, { refresh() { refreshes++; } });
  output.write('{"id":0,"result":');
  assert.equal(refreshes, 0);
  output.write('{"protocolVersion":"2025-06-18"}}\n');
  assert.equal(refreshes, 1);
  output.write('{"id":1,"result":{"content":[]}}\n');
  assert.equal(received.length, 3);
  assert.equal(output.isPaused(), false);
  assert.equal(output.listenerCount('data'), 1);
});

function setup(t, discover) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-surface-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 100000;
  const file = join(directory, 'extensions.json');
  const server = () => ({ command: 'engine', args: ['server'], version: '1', env: {} });
  return { file, server, time: value => { now = value; }, options: { file, now: () => now, discover } };
}

test('background inventory informs only the next session and a fresh cache avoids another engine', async t => {
  let calls = 0;
  const f = setup(t, async () => { calls++; return [{ type: 'extension', metadata: { extensionInstanceId: 'connected' } }]; });
  const first = f.server(); const cache = selectSurfaces(first, {}, f.options);
  assert.equal(first.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(calls, 0);
  await cache.refresh();
  assert.equal(first.env.CUA_REPL_ENABLED_SURFACES, 'computer', 'session tool description stays fixed');
  assert.equal(JSON.parse(readFileSync(f.file)).checkedAt, 100000);
  const next = f.server(); const nextCache = selectSurfaces(next, {}, f.options);
  assert.equal(next.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  await nextCache.refresh(); assert.equal(calls, 1);
});

test('stale, future, malformed and other-engine caches cannot enable browser control', async t => {
  const f = setup(t, async () => [{ type: 'extension', metadata: { extensionInstanceId: 'connected' } }]);
  await selectSurfaces(f.server(), {}, f.options).refresh();
  const valid = JSON.parse(readFileSync(f.file));
  for (const change of [{ checkedAt: 39999 }, { checkedAt: 100001 }, { connected: 'yes' }, { engine: 'different' }]) {
    writeFileSync(f.file, JSON.stringify({ ...valid, ...change }));
    const server = f.server(); selectSurfaces(server, {}, f.options);
    assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  }
  writeFileSync(f.file, 'broken');
  const server = f.server(); selectSurfaces(server, {}, f.options);
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
});

test('discovery and collection time count against the cache lifetime', async t => {
  const f = setup(t, async () => {
    f.time(160001);
    return [{ type: 'extension', metadata: { extensionInstanceId: 'connected' } }];
  });
  await selectSurfaces(f.server(), {}, f.options).refresh();
  const server = f.server(); selectSurfaces(server, {}, f.options);
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(JSON.parse(readFileSync(f.file)).checkedAt, 100000);
});

test('negative and failed discovery stay computer-only, and shutdown cancels owned discovery', async t => {
  for (const inventory of [[], [{ type: 'iab' }], [{ type: 'extension' }]]) {
    const f = setup(t, async () => inventory);
    await selectSurfaces(f.server(), {}, f.options).refresh();
    const server = f.server(); selectSurfaces(server, {}, f.options);
    assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  }
  const f = setup(t, (_server, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true })));
  const cache = selectSurfaces(f.server(), {}, f.options);
  const refresh = cache.refresh(); await cache.close(); await refresh;
  assert.throws(() => readFileSync(f.file), { code: 'ENOENT' });
  const failure = setup(t, async () => { throw new Error('failed'); });
  await selectSurfaces(failure.server(), {}, failure.options).refresh();
  assert.equal(JSON.parse(readFileSync(failure.file)).connected, false);
});

test('unsafe cache files fail closed without following links or reading special files', { skip: process.platform === 'win32' }, async t => {
  const f = setup(t, async () => [{ type: 'extension', metadata: { extensionInstanceId: 'connected' } }]);
  await selectSurfaces(f.server(), {}, f.options).refresh();
  const valid = readFileSync(f.file);
  const positive = `${f.file}.positive`; writeFileSync(positive, valid, { mode: 0o600 });
  for (const prepare of [
    () => symlinkSync(positive, f.file),
    () => writeFileSync(f.file, Buffer.alloc(2048)),
    () => { writeFileSync(f.file, valid); chmodSync(f.file, 0o666); },
    () => execFileSync('/usr/bin/mkfifo', [f.file]),
  ]) {
    rmSync(f.file, { force: true }); prepare();
    const server = f.server(); selectSurfaces(server, {}, f.options);
    assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  }
});

test('a symlinked cache directory cannot supply or receive an inventory', async t => {
  const f = setup(t, async () => []);
  const link = `${f.file}.link`; symlinkSync(join(f.file, '..'), link, 'dir');
  const file = join(link, 'through-link.json');
  const server = f.server(); const cache = selectSurfaces(server, {}, { ...f.options, file });
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  await cache.refresh(); assert.equal(existsSync(file), false);
});
