// Reproduce AD3W -> AD3X -> AD3Y helper-call counts from pinned source objects.
// Git reads and in-memory module imports only; no apps, osascript or benchmark runner.
import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityRelay, settle } from './helpers/native-identity-relay.mjs';

const root = new URL('../', import.meta.url);
const revisions = { AD3W: 'c070d1e41c2b9e30884b5872279ba7448a12c6f1', AD3X: 'bf8e54ebd08f02015419b4a195872709fa6649bf' };
const bound = { timeout: 30000, killSignal: 'SIGKILL' };
// The pinned revisions exist only in the private history. A squashed release or shallow clone skips their baselines.
const present = Object.values(revisions).every(sha => spawnSync('/usr/bin/git', ['cat-file', '-e', `${sha}^{commit}`],
  { cwd: fileURLToPath(root), stdio: 'ignore', ...bound }).status === 0);
const snapshots = {};
if (present) for (const [label, sha] of Object.entries(revisions)) {
  const read = path => execFileSync('/usr/bin/git', ['show', `${sha}:${path}`], { cwd: fileURLToPath(root), encoding: 'utf8', ...bound });
  const relayPath = 'plugins/sleight/lib/relay.mjs';
  const relaySource = read(relayPath).replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_match, before, path, after) => before + new URL(path, new URL(relayPath, root)).href + after);
  const { createRelay } = await import('data:text/javascript;base64,' + Buffer.from(relaySource).toString('base64'));
  snapshots[label] = { relayFactory: createRelay, sources: { source: read('plugins/sleight/lib/window-identity.js'),
    healthSource: read('plugins/sleight/lib/app-health.js') } };
}

for (const label of ['AD3W', 'AD3X', 'AD3Y']) for (const health of [false, true]) {
  for (const status of ['ok', 'unknown']) for (const tree of [true, false]) {
    test(`${label} helper-call receipt, health=${health}, status=${status}, tree=${tree}`,
      { skip: label !== 'AD3Y' && !present ? 'baseline revisions are not in this clone' : false }, async t => {
      const h = identityRelay(t, { ...snapshots[label], health, tree });
      h.state.status = status;
      await h.read('first', 'let app = await cua.getApp("TextEdit")');
      const first = h.requests.length;
      await h.read('again');
      const reread = h.requests.length - first;
      h.send('act', 'await app.typeText("x")'); await settle();
      assert.equal(h.forwarded.at(-1).id, 'act');
      const action = h.requests.length - first - reread;
      h.reply('act'); await settle();
      const initial = status === 'unknown' && tree ? 2 : 1;
      const reuse = status === 'ok' && (label === 'AD3X' || label === 'AD3Y' && health);
      assert.deepEqual([first, reread, action, h.requests.length], [initial, reuse ? 0 : 1, 1, initial + (reuse ? 1 : 2)]);
      t.diagnostic(JSON.stringify({ revision: revisions[label] ?? 'working-tree', label, health, status, tree,
        firstRead: first, unchangedRead: reread, action, total: h.requests.length }));
    });
  }
}
