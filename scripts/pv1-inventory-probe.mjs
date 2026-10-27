// Offline only: read the current package with the pinned baseline and current verifier.
// No installed configuration, helpers, servers or browser connections are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { acceptedInstalledPackage } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';

const base = 'cab7138b5a716308fc228b09ea3bcc424cdd2b7e';
const folder = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const source = name => execFileSync('/usr/bin/git', ['show', `${base}:plugins/sleight/lib/direct-browser/${name}`], { encoding: 'utf8' });
const moduleURL = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const imports = code => code.replace(/from '(\.\/[^']+)'/g, (_match, path) => `from '${new URL(path, folder).href}'`);
const oldInventory = moduleURL(imports(source('session-host.mjs')));
const oldConfig = imports(source('installed-config.mjs').replace("'./session-host.mjs'", `'${oldInventory}'`))
  .replaceAll('import.meta.url', JSON.stringify(new URL('installed-config.mjs', folder).href));
const baseline = await import(moduleURL(oldConfig));
const pluginRoot = fileURLToPath(new URL('../plugins/sleight', import.meta.url));
const config = buildReceipt({ pluginRoot });
const rows = [baseline.acceptedInstalledPackage, acceptedInstalledPackage].map((accept, i) => {
  const start = performance.now(), accepted = accept(config, { pluginRoot });
  return { label: i ? 'identity-cache' : 'baseline', initialMs: performance.now() - start, accepted, samples: [] };
});
for (let round = 0; round < 50; round++) for (const i of round % 2 ? [1, 0] : [0, 1]) {
  const start = performance.now(); assert.equal(rows[i].accepted.current(), true);
  rows[i].samples.push(performance.now() - start);
}
for (const { accepted, samples, ...row } of rows) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(JSON.stringify({ ...row, files: config.receipt.files.length,
    bytes: config.receipt.files.reduce((sum, file) => sum + file.bytes, 0),
    medianMs: (sorted[24] + sorted[25]) / 2, minMs: sorted[0], maxMs: sorted[49], samples }));
}
