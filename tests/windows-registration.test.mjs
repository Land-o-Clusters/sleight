import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { windowsManifest, registerWindowsPlugin } from '../plugins/sleight/lib/windows-register.mjs';

const manifest = JSON.parse(readFileSync(new URL('../plugins/sleight/.claude-plugin/plugin.json', import.meta.url)));
test('macOS keeps its existing launcher and mod module registration', async () => {
  assert.deepEqual(manifest.mcpServers.computer, { command: '${CLAUDE_PLUGIN_ROOT}/bin/sleight-mcp' });
  const hooks = JSON.parse(readFileSync(new URL('../plugins/sleight/hooks/hooks.json', import.meta.url)));
  assert.deepEqual(hooks, { modules: ['./register.tsx'] });
  await assert.rejects(registerWindowsPlugin({ platform: 'darwin' }), /WINDOWS_ONLY/);
});
for (const root of ['C:\\Users\\Some Person\\Plugin Cache\\sleight', 'D:/plugins/sleight']) test(`Windows MCP resolution uses one real executable for ${root}`, () => {
  const before = structuredClone(manifest), node = 'C:\\Program Files\\nodejs\\node.exe';
  const after = windowsManifest(manifest, { root, node, version: '24.3.0' });
  assert.deepEqual(after.mcpServers.computer, { command: node, args: [win32.join(root, 'lib', 'launch.mjs')], env: { NODE_OPTIONS: '', NODE_PATH: '' } });
  assert.deepEqual(manifest, before); assert.equal(after.types, before.types);
  assert.doesNotMatch(after.mcpServers.computer.command, /\.cmd$|\$\{/);
});
test('invalid executable, version or root cannot be registered', () => {
  for (const change of [{ version: '22.0.0' }, { version: 'x' }, { root: 'relative/plugin' }, { node: 'node' }, { node: 'C:\\bin\\node.cmd' }, { node: '\\\\server\\node.exe' }]) {
    assert.throws(() => windowsManifest(manifest, { root: 'C:\\plugins\\sleight', node: 'C:\\Program Files\\nodejs\\node.exe', version: '24.0.0', ...change }));
  }
});
test('CMD launcher quotes its installed path and invokes only an absolute selected Node', () => {
  const source = readFileSync(new URL('../plugins/sleight/bin/sleight-mcp.cmd', import.meta.url), 'utf8');
  assert.match(source, /setlocal DisableDelayedExpansion/i);
  assert.match(source, /"%SLEIGHT_NODE%" "%~dp0\.\.\\lib\\launch\.mjs" %\*/);
  assert.match(source, /set "NODE_OPTIONS="/); assert.match(source, /set "NODE_PATH="/);
  assert.match(source, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(source, /windows-node\.ps1/); assert.match(source, /Node 24 or later/);
  assert.doesNotMatch(source, /^node |npx|where node/im);
});
test('register refuses before inspecting Node or touching the manifest when its person gate refuses', async () => {
  const calls = [];
  const code = await registerWindowsPlugin({ platform: 'win32',
    refuse: async args => { calls.push(args); return 'terminal refused'; },
    inspectNode: () => assert.fail('Node inspected before gate'), out: text => calls.push(text),
  });
  assert.equal(code, 3); assert.deepEqual(calls, [['register'], 'terminal refused\n']);
});
test('register refuses an untrusted Node before any manifest access with a readable error', async () => {
  const lines = [];
  assert.equal(await registerWindowsPlugin({ platform: 'win32', root: 'C:\\plugins\\sleight', node: 'C:\\project\\node.exe',
    refuse: async () => undefined, inspectNode: () => false, out: text => lines.push(text),
  }), 1);
  assert.match(lines.join(''), /Node.*location|location.*Node/);
  assert.match(lines.join(''), /in Program Files/);
  assert.doesNotMatch(lines.join(''), /PATH folder/);
});
test('register uses the discovery location validator with request data on stdin', async () => {
  const { inspectWindowsNode } = await import('../plugins/sleight/lib/windows-register.mjs');
  const node = 'C:\\Users\\Menéndez\\tools\\node.exe'; let observed;
  assert.equal(inspectWindowsNode(node, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    run: (file, args, options) => { observed = { file, args, options }; return '{"ok":true}'; } }), true);
  assert.equal(JSON.parse(observed.options.input).node, node);
  assert.ok(Buffer.from(observed.args.at(-1), 'base64').toString('utf16le').includes('Test-NodeLocation'));
});
test('register requires terminal, fresh session, presence and settings confirmation in order', async () => {
  const { windowsSettingsRefusal } = await import('../plugins/sleight/lib/windows-settings.mjs');
  const calls = [];
  assert.equal(await windowsSettingsRefusal(['register'], { gate: async (_args, opts) => { calls.push(['gate', opts.freshMs]); },
    adapter: { person: { presence: () => { calls.push('presence'); return true; } } },
    confirm: async change => { calls.push(change); return 'ok'; }, notice: () => {},
  }), undefined);
  assert.deepEqual(calls, [['gate', 10000], 'presence', { key: 'settings' }]);
});


test('parsed discovery decisions reject links and projects, skip old Node and accept per-user Node below a stray home package', async () => {
  const { discoveryModel, cmdModel } = await import('./fixtures/windows-node-model.mjs');
  const source = readFileSync(new URL('../plugins/sleight/lib/windows-node.ps1', import.meta.url), 'utf8');
  const model = discoveryModel(source);
  const home = 'C:\\Users\\Menéndez', userBin = home + '\\tools';
  const regular = 'C:\\Program Files\\nodejs\\node.exe', other = userBin + '\\node.exe';
  const files = new Map([[regular.toLowerCase(), { file: true, major: 22 }], [other.toLowerCase(), { file: true, major: 24 }], [home.toLowerCase(), { package: true }]]);
  const options = { knownFolders: ['C:\\Program Files'], entries: ['relative', userBin], home, files };
  assert.equal(model(options), other);
  files.set(userBin.toLowerCase(), { reparse: true }); assert.equal(model(options), undefined);
  files.set(userBin.toLowerCase(), { package: true }); assert.equal(model(options), undefined);
  files.set(userBin.toLowerCase(), { git: true }); assert.equal(model(options), undefined);
  files.delete(userBin.toLowerCase()); files.set(regular.toLowerCase(), { file: true, major: 24 });
  assert.equal(model(options), regular);
  const cmd = readFileSync(new URL('../plugins/sleight/bin/sleight-mcp.cmd', import.meta.url), 'utf8');
  assert.deepEqual(cmdModel(cmd), { exit: 1 }); assert.equal(cmdModel(cmd, regular).node, regular);
  assert.notDeepEqual(cmdModel(cmd.replace('if not defined', 'if defined'), regular), cmdModel(cmd, regular));
});

test('shell launcher refuses Git Bash Windows kernels and keeps Darwin arguments unchanged', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'windows-sh-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Contents/Resources/cua_node/bin'), { recursive: true });
  writeFileSync(join(root, 'Contents/Resources/cua_node/bin/node'), '#!/bin/sh\nprintf "node:%s\\n" "$@"\n', { mode: 0o700 });
  const script = new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url);
  for (const kernel of ['MINGW64_NT-10.0', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0', 'Darwin']) {
    writeFileSync(join(root, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${kernel}'\n`, { mode: 0o700 });
    const result = spawnSync('/bin/sh', [script.pathname, '--doctor'], { encoding: 'utf8',
      env: { ...process.env, PATH: root + ':/usr/bin:/bin', SLEIGHT_CHATGPT_APP: root }, timeout: 60000, killSignal: 'SIGKILL' });
    if (kernel === 'Darwin') {
      assertChildStatus(result, 0); assert.equal(result.stderr, '');
      assert.equal(result.stdout, `node:${new URL('../plugins/sleight/bin/../lib/launch.mjs', import.meta.url).pathname.replace('/lib/', '/bin/../lib/')}\nnode:--doctor\n`);
    } else { assertChildStatus(result, 1); assert.match(result.stderr, /sleight-mcp\.cmd/); assert.equal(result.stdout, ''); }
  }
});

test('discovery model observes inverted project, reparse and version branches', async () => {
  const { discoveryModel } = await import('./fixtures/windows-node-model.mjs');
  const source = readFileSync(new URL('../plugins/sleight/lib/windows-node.ps1', import.meta.url), 'utf8');
  const node = 'C:\\tools\\node.exe';
  const fixture = parent => ({ entries: ['C:\\tools'], home: 'C:\\Users\\Person',
    files: new Map([[node.toLowerCase(), { file: true, major: 24 }], ['c:\\tools', parent]]) });
  assert.equal(discoveryModel(source)(fixture({ git: true })), undefined);
  const and = source.replace("'.git'))) -or", "'.git'))) -and");
  assert.equal(discoveryModel(and)(fixture({ git: true })), node);
  const reparse = source.replace(/(ReparsePoint\)[^\n]+return )\$false/, '$1$true');
  assert.equal(discoveryModel(reparse)(fixture({ reparse: true })), node);
  const old = fixture({}); old.files.get(node.toLowerCase()).major = 22;
  assert.equal(discoveryModel(source)(old), undefined);
  assert.equal(discoveryModel(source.replace('$Matches[1] -lt 24', '$Matches[1] -gt 24'))(old), node);
});
