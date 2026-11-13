import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveServer, doctor } from '../plugins/sleight/lib/launch.mjs';
import { offlineDoctor } from './fixtures/preapproved-storage.mjs';
import { REPL_REL, NODE_REL } from '../plugins/sleight/lib/setup.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture(t) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-engine-version-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app'), script = join(app, REPL_REL), command = join(app, NODE_REL);
  for (const file of [script, command]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
  const plist = join(app, 'Contents/Info.plist');
  const version = value => writeFileSync(plist, `<plist><dict><key>CFBundleShortVersionString</key><string>${value}</string></dict></plist>`);
  version('26.1027.51404');
  const config = join(root, 'plugins/cache/openai-bundled/unified-computer-use/26.1027.30824/.mcp.json');
  mkdirSync(dirname(config), { recursive: true });
  const configure = (args = [script], executable = command) => writeFileSync(config,
    JSON.stringify({ mcpServers: { cua_repl: { command: executable, args, env: {} } } }));
  configure();
  return { root, app, script, command, plist, version, configure, env: { CODEX_HOME: root, SLEIGHT_CHATGPT_APP: app } };
}

for (const form of ['plain', 'import', 'url', 'symlink']) test(`resolved ${form} app launch reports its installed version, not the stale cache version`, t => {
  const f = fixture(t);
  if (form === 'import') f.configure(['--import', join(f.root, 'bootstrap.mjs'), f.script]);
  if (form === 'url') f.configure([pathToFileURL(f.script).href]);
  if (form === 'symlink') { const link = join(f.root, 'linked-repl.mjs'); symlinkSync(f.script, link); f.configure([link]); }
  assert.equal(resolveServer(f.env).version, '26.1027.51404');
  assert.equal(resolveServer(f.env).configVersion, '26.1027.30824');
  f.version('26.1101.10000');
  assert.equal(resolveServer(f.env).version, '26.1101.10000');
});

for (const variant of ['unrelated-script', 'other-runtime', 'missing-plist', 'invalid-version', 'binary-plist']) test(`version evidence refuses ${variant}`, t => {
  const f = fixture(t);
  if (variant === 'unrelated-script') { const script = join(f.root, 'other.mjs'); writeFileSync(script, ''); f.configure([script]); }
  if (variant === 'other-runtime') f.configure([f.script], process.execPath);
  if (variant === 'missing-plist') rmSync(f.plist);
  if (variant === 'invalid-version') f.version('../../not-a-version');
  if (variant === 'binary-plist') writeFileSync(f.plist, Buffer.from('bplist00\0\x01'));
  assert.equal(resolveServer(f.env).version, '26.1027.30824');
  assert.equal(resolveServer(f.env).appVersionUnreadable, ['missing-plist', 'invalid-version', 'binary-plist'].includes(variant) ? true : undefined);
});

for (const variant of ['installed', 'missing-plist', 'binary-plist']) test(`doctor explains ${variant} version evidence without launching an app`, async t => {
  const f = fixture(t);
  if (variant === 'missing-plist') rmSync(f.plist);
  if (variant === 'binary-plist') writeFileSync(f.plist, Buffer.from('bplist00\0\x01'));
  const none = () => [], lines = [];
  // Missing helper paths stop the doctor before its live probe.
  assert.equal(await doctor({ ...offlineDoctor, env: { ...f.env, SLEIGHT_SURFACES: 'computer' },
    runtime: () => ({ selected: 'engine', ok: true, lines: [] }), documentation: () => {},
    turbo: none, codex: none, cursor: none, grok: none, grokbot: none, forbiddenTargets: () => '0',
    log: line => lines.push(line), app: undefined,
  }), 1);
  assert.ok(lines.some(line => line.startsWith('MISSING   node_repl')));
  if (variant === 'installed') {
    assert.ok(lines.includes('Codex computer-use 26.1027.51404'));
    assert.ok(lines.includes('config version  26.1027.30824 (installed ChatGPT app: 26.1027.51404)'));
    assert.ok(!lines.some(line => line.includes('app version is unreadable')));
  } else {
    assert.ok(lines.includes('Codex computer-use 26.1027.30824'));
    assert.ok(lines.includes('WARNING: ChatGPT app version is unreadable; using configured version 26.1027.30824.'));
  }
});
