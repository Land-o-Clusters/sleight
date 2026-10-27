// Read-only package verification timings. Never accepts an installed package,
// writes configuration, starts a server or connects to a browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve, join } from 'node:path';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { acceptedInstalledPackage } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';

const roots = process.argv.slice(2).map(root => resolve(root));
assert.equal(roots.length, 2, 'supply A and B worktree roots');
const rows = roots.map(root => {
  const pluginRoot = join(root, 'plugins/sleight');
  const config = buildReceipt({ pluginRoot });
  const accepted = acceptedInstalledPackage(config, { pluginRoot });
  const files = config.receipt.files;
  return { root, sha: execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    accepted, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 12), milliseconds: [] };
});
for (let round = 0; round < 10; round++) for (const i of round % 2 ? [1, 0] : [0, 1]) {
  const start = performance.now(); assert.equal(rows[i].accepted.current(), true);
  rows[i].milliseconds.push(Number((performance.now() - start).toFixed(3)));
}
for (const row of rows) {
  const { accepted, ...result } = row;
  console.log(JSON.stringify(result));
}
