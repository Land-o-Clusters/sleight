import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostLabel, hostName, isGrokClient } from '../plugins/sleight/lib/host-label.mjs';
import { grokDoctorLines, grokStatus } from '../plugins/sleight/lib/grok-host.mjs';
import { doctor, hostWording } from '../plugins/sleight/lib/launch.mjs';

const info = JSON.parse(readFileSync(new URL('fixtures/grok/host-client-info.json', import.meta.url)));
const directInfo = JSON.parse(readFileSync(new URL('fixtures/grok/host-client-info-direct.json', import.meta.url)));
test('Grok detection fails closed for any grok-shell prefix and labels long server keys', () => {
  for (const key of ['a'.repeat(30), 'a'.repeat(64), 'a'.repeat(65), 'server.key', 'key/other', '', 'key\nother']) {
    const client = { name: 'grok-shell-' + key, version: '1.0.13' };
    assert.equal(isGrokClient(client), true, key);
    assert.equal(hostName(client), 'Grok', key);
    assert.equal(hostLabel(client), 'Grok 1.0.13', key);
  }
  for (const name of ['grok', 'grok-shell', 'other-grok-shell-key']) assert.equal(isGrokClient({ name }), false);
});
test('GL1 clientInfo names Grok in the dropdown and panel', () => {
  for (const client of [info, directInfo]) {
    assert.equal(hostName(client), 'Grok');
    assert.equal(hostLabel(client), 'Grok 1.0.13');
    assert.equal(hostWording(client).host, 'Grok');
    assert.equal(hostWording(client).panel, 'Grok');
  }
});

const fake = (files, env = {}) => ({ home: '/home', env, version: () => 'grok 1.0.13',
  read: path => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; },
  list: path => Object.keys(files).filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]),
});
const imported = {
  '/home/.claude/plugins/known_marketplaces.json': JSON.stringify({ sleight: { installLocation: '/repo' } }),
  '/repo/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'sleight', source: './plugins/sleight' }] }),
  '/repo/plugins/sleight/.claude-plugin/plugin.json': JSON.stringify({ version: '1.3.1' }),
  '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'sleight@sleight': [{ version: '1.3.0' }] } }),
};
test('doctor explains the Claude marketplace import and its different cached version', () => {
  const status = grokStatus(fake(imported));
  assert.equal(status.version, '1.0.13');
  const lines = grokDoctorLines(status).join('\n');
  assert.match(lines, /Claude.*marketplace.*1\.3\.1/);
  assert.match(lines, /Claude Code.*1\.3\.0/);
  assert.match(lines, /different copies/);
  assert.match(lines, /compat\.claude/);
});
test('doctor honors the Grok home and disabled Claude import, without reading auth', () => {
  const files = { ...imported, '/temp/config.toml': '[compat.claude]\nenabled = false\n[mcp_servers."sleight"]\ncommand = "/repo/plugins/sleight/bin/sleight-mcp"\n' };
  const io = fake(files, { GROK_HOME: '/temp' });
  const read = io.read;
  io.read = path => { assert.doesNotMatch(path, /auth|credential/); assert.ok(!path.startsWith('/home/.grok')); return read(path); };
  const lines = grokDoctorLines(grokStatus(io)).join('\n');
  assert.match(lines, /"sleight"/);
  assert.match(lines, /Claude import is off/);
  assert.doesNotMatch(lines, /different copies/);
});

test('launcher prints the Grok section before an unavailable engine stops doctor', async () => {
  const lines = [];
  const code = await doctor({ settings: () => [], env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' },
    turbo: async () => [], hand: async () => [], permissions: async () => [], codex: () => [], cursor: () => [],
    grok: () => grokDoctorLines(grokStatus(fake(imported))), grokbot: () => [], log: line => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines[0], /^sleight \d+\.\d+\.\d+$/);
  assert.equal(lines[1], 'Grok CLI 1.0.13');
  assert.ok(lines.some(line => line.includes('different copies')));
});
