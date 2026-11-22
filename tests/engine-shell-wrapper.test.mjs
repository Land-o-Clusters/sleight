import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { offlineDoctor } from './fixtures/preapproved-storage.mjs';
import { test as macTest } from './macos-only.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { doctor, resolveServer, restartLaunchFiles, shellExecWrapper, unwrappedLaunch } from '../plugins/sleight/lib/launch.mjs';
import { HELPER_REL, NODE_REL, NODE_REPL_REL, REPL_REL, setup } from '../plugins/sleight/lib/setup.mjs';
import { launchShapeCheck } from '../bench/compat.mjs';
import { captureIdentity } from '../bench/hand/event-channel-live.mjs';
import { engineIdentity } from '../bench/acquisition-probe.mjs';

// Recording: ~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1117.41037/.mcp.json, written by ChatGPT
// 26.1117.41037 (build 29803) on 2026-11-20 23:14 local time, copied 2026-11-22 with the home directory as __HOME__.
const RECORDED = readFileSync(fileURLToPath(new URL('./fixtures/engine-26.1117.41037-mcp.json', import.meta.url)), 'utf8');
const SNIPPET = 'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"';
const APP_REPL = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl';

const plist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
const recorded = (home, app) => JSON.parse(RECORDED.split('__HOME__').join(home).split('/Applications/ChatGPT.app').join(app)).mcpServers.cua_repl;

test('the recorded 26.1117 launch is the shell exec wrapper around the app node_repl', () => {
  const server = JSON.parse(RECORDED).mcpServers.cua_repl;
  assert.equal(server.command, '/bin/sh');
  assert.deepEqual(server.args, ['-c', SNIPPET, 'cua-repl', APP_REPL]);
  assert.equal(server.env.CUA_REPL_NODE_REPL_PATH, undefined);
  assert.deepEqual(shellExecWrapper(server.command, server.args),
    { shell: '/bin/sh', exports: ['BROWSER_USE_ACCESS_EXECUTOR_ID'], label: 'cua-repl', program: APP_REPL, programArgs: [] });
  assert.deepEqual(unwrappedLaunch(server.command, server.args).runtime, APP_REPL);
  assert.equal(unwrappedLaunch(server.command, server.args).nodeRepl, true);
});

test('several exports and program arguments unwrap', () => {
  const wrapper = shellExecWrapper('/bin/sh', ['-c', 'export A="${A-}"; export B_2="${B_2-}"; exec "$@"', 'x', '/p/node', '/p/s.mjs', '--y']);
  assert.deepEqual(wrapper.exports, ['A', 'B_2']);
  assert.deepEqual(wrapper.programArgs, ['/p/s.mjs', '--y']);
});

test('malformed wrappers do not unwrap', () => {
  const variants = [
    ['/bin/sh', ['-c', SNIPPET + '; rm -rf /tmp/x', 'cua-repl', APP_REPL]], // a command after exec "$@"
    ['/bin/sh', ['-c', 'export A="${A-}" && exec "$@"', 'cua-repl', APP_REPL]], // && chain
    ['/bin/sh', ['-c', 'export A="${A-}"; touch /tmp/x; exec "$@"', 'cua-repl', APP_REPL]], // ; chain
    ['/bin/sh', ['-c', 'export A="${A-}"; "$@"', 'cua-repl', APP_REPL]], // no exec
    ['/bin/sh', ['-c', 'exec "$@"', 'cua-repl', APP_REPL]], // no export
    ['/bin/sh', ['-c', 'export A="${B-}"; exec "$@"', 'cua-repl', APP_REPL]], // names differ
    ['/bin/sh', ['-c', 'export a="${a-}"; exec "$@"', 'cua-repl', APP_REPL]], // lowercase name
    ['/bin/sh', ['-c', SNIPPET + '\n', 'cua-repl', APP_REPL]], // trailing newline
    ['/bin/sh', ['-c', 'export A="${A-}";  exec "$@"', 'cua-repl', APP_REPL]], // separator differs
    ['/bin/sh', ['-c', 'export A="$(id)"; exec "$@"', 'cua-repl', APP_REPL]], // command substitution
    ['/bin/sh', ['-ec', SNIPPET, 'cua-repl', APP_REPL]], // other flag
    ['/bin/sh', ['-c', SNIPPET, 'cua-repl', 'node_repl']], // relative program
    ['/bin/sh', ['-c', SNIPPET, 'cua-repl']], // missing program
    ['/bin/sh', ['-c', SNIPPET, '', APP_REPL]], // empty $0 label
    ['/bin/bash', ['-c', SNIPPET, 'cua-repl', APP_REPL]], // other shell
    ['/bin/zsh', ['-c', SNIPPET, 'cua-repl', APP_REPL]],
    ['sh', ['-c', SNIPPET, 'cua-repl', APP_REPL]],
    ['/bin/sh', ['-c', SNIPPET, 'cua-repl', APP_REPL, 7]], // non-string argument
  ];
  for (const [command, args] of variants) {
    assert.equal(shellExecWrapper(command, args), undefined, JSON.stringify([command, args]));
    assert.equal(unwrappedLaunch(command, args).wrapper, undefined);
  }
});

test('older launch shapes read as before', () => {
  for (const [command, args] of [['/a/node', ['/a/cua-repl.mjs']], ['/a/node', ['--import', 'file:///a/hook.mjs', '/a/cua-repl.mjs']], ['node', []]]) {
    assert.deepEqual(unwrappedLaunch(command, args), { runtime: command, args });
  }
  assert.deepEqual(restartLaunchFiles('/a/node', ['--import', 'file:///a/hook.mjs', '/a/cua-repl.mjs']),
    [['runtime', '/a/node'], ['script', '/a/cua-repl.mjs'], ['argument', '/a/hook.mjs']]);
});

test('an engine restart checks the shell and node_repl, and fails closed on an unrecognized wrapper', () => {
  assert.deepEqual(restartLaunchFiles('/bin/sh', ['-c', SNIPPET, 'cua-repl', APP_REPL]), [['runtime', '/bin/sh'], ['program', APP_REPL]]);
  assert.deepEqual(restartLaunchFiles('/bin/sh', ['-c', 'export A="${A-}"; exec "$@"', 'x', '/p/node', '/p/s.mjs']),
    [['runtime', '/bin/sh'], ['program', '/p/node'], ['script', '/p/s.mjs']]);
  // The inline script is read as the script, which never exists, so prepareEngine refuses the restart.
  assert.deepEqual(restartLaunchFiles('/bin/sh', ['-c', SNIPPET + '; id', 'cua-repl', APP_REPL])[1], ['script', SNIPPET + '; id']);
});

test('the real /bin/sh runs the recorded wrapper as exec of its program, with the export set', t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-engine-shell-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, 'node_repl');
  writeFileSync(program, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$0" "$#" "${BROWSER_USE_ACCESS_EXECUTOR_ID-unset}"\n');
  chmodSync(program, 0o755);
  const server = recorded(root, root);
  const args = [...server.args.slice(0, 3), program];
  const env = { PATH: '/usr/bin:/bin' };
  const result = spawnSync(server.command, args, { env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${program}|0|\n`);
});

function world(t, { server: edit = server => server, files = true } = {}) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-engine-wrapper-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), app = join(root, 'ChatGPT.app');
  const codexHome = join(home, '.codex');
  const dir = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/26.1117.41037');
  mkdirSync(dir, { recursive: true });
  const server = edit(recorded(home, app), { root, app });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: server } }));
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), plist('26.1117.41037'));
  if (files) {
    for (const rel of [NODE_REPL_REL, NODE_REL, REPL_REL]) { mkdirSync(join(app, rel, '..'), { recursive: true }); writeFileSync(join(app, rel), ''); }
    mkdirSync(server.env.SKY_CUA_SERVICE_PATH, { recursive: true });
  }
  return { root, home, app, server, env: { CODEX_HOME: codexHome, SLEIGHT_CHATGPT_APP: app, SLEIGHT_SURFACES: 'computer' } };
}

async function runDoctor(w, liveRead = async () => ({ ok: true })) {
  const lines = [], reads = [];
  const none = () => [];
  const rc = await doctor({ ...offlineDoctor, env: w.env, log: line => lines.push(line), app: undefined,
    runtime: () => ({ selected: 'engine', ok: true, lines: [] }), settings: none, documentation: () => {},
    turbo: none, hand: none, permissions: none, codex: none, cursor: none, grok: none, grokbot: none, forbiddenTargets: () => '0',
    liveRead: async (server, options) => { reads.push(server); return liveRead(server, options); } });
  return { rc, lines, text: lines.join('\n'), reads };
}

test('the doctor passes its file checks on the 26.1117 wrapper and reads live through the configured launch', async t => {
  const w = world(t);
  const { rc, lines, text, reads } = await runDoctor(w);
  assert.equal(rc, 0, text);
  assert.ok(lines.includes('ok        shell: /bin/sh'), text);
  assert.ok(lines.includes(`ok        node_repl: ${join(w.app, NODE_REPL_REL)}`), text);
  assert.ok(lines.includes('launch    /bin/sh exec wrapper (exports BROWSER_USE_ACCESS_EXECUTOR_ID)'), text);
  assert.equal(lines.some(line => /server script|MISSING/.test(line)), false, text);
  assert.ok(lines.includes('Codex computer-use 26.1117.41037'), text);
  // The live read spawns exactly what Codex configured.
  assert.equal(reads.length, 1);
  assert.equal(reads[0].command, '/bin/sh');
  assert.deepEqual(reads[0].args, w.server.args);
});

test('the doctor fails closed on malformed wrappers before its live read', async t => {
  for (const [name, edit] of [
    ['extra command', server => ({ ...server, args: ['-c', SNIPPET + '; id', ...server.args.slice(2)] })],
    ['missing exec', server => ({ ...server, args: ['-c', 'export A="${A-}"; "$@"', ...server.args.slice(2)] })],
    ['relative program', server => ({ ...server, args: [...server.args.slice(0, 3), 'node_repl'] })],
  ]) {
    const w = world(t, { server: edit });
    const { rc, text, reads } = await runDoctor(w);
    assert.equal(rc, 1, name);
    assert.match(text, /MISSING {3}engine launch: \/bin\/sh with an unrecognized wrapper/, name);
    assert.equal(reads.length, 0, name);
  }
  // Another shell keeps the plain reading: the inline script is the missing server script.
  const bash = world(t, { server: server => ({ ...server, command: '/bin/bash' }) });
  const other = await runDoctor(bash);
  assert.equal(other.rc, 1);
  assert.match(other.text, /MISSING {3}server script: export BROWSER_USE_ACCESS_EXECUTOR_ID/);
  assert.equal(other.reads.length, 0);
});

test('the doctor reports a missing wrapped program', async t => {
  const w = world(t, { server: (server, { root }) => ({ ...server, args: [...server.args.slice(0, 3), join(root, 'gone/node_repl')] }) });
  const { rc, text, reads } = await runDoctor(w);
  assert.equal(rc, 1);
  assert.match(text, /MISSING {3}node_repl: .*gone\/node_repl/);
  assert.equal(reads.length, 0);
});

test('a wrapped node keeps the script, option-file and CUA_REPL_NODE_REPL_PATH checks', async t => {
  const w = world(t, { server: (server, { app }) => ({ ...server, args: [...server.args.slice(0, 3), join(app, NODE_REL), join(app, REPL_REL)],
    env: { ...server.env, CUA_REPL_NODE_REPL_PATH: join(app, NODE_REPL_REL) } }) });
  const { rc, lines, text } = await runDoctor(w);
  assert.equal(rc, 0, text);
  assert.ok(lines.includes(`ok        node: ${join(w.app, NODE_REL)}`), text);
  assert.ok(lines.includes(`ok        server script: ${join(w.app, REPL_REL)}`), text);
  assert.ok(lines.includes(`ok        node_repl: ${join(w.app, NODE_REPL_REL)}`), text);
});

test('resolveServer keeps the configured launch and relabels a wrapped app node_repl with the installed version', t => {
  const w = world(t);
  // The cache directory lags an in-place app update: the installed version is read from the app.
  writeFileSync(join(w.app, 'Contents/Info.plist'), plist('26.1118.1'));
  const s = resolveServer(w.env);
  assert.equal(s.command, '/bin/sh');
  assert.deepEqual(s.args, w.server.args);
  assert.equal(s.version, '26.1118.1');
  assert.equal(s.configVersion, '26.1117.41037');
  // A wrapped program outside the app keeps the configured version.
  const other = world(t, { server: (server, { root }) => ({ ...server, args: [...server.args.slice(0, 3), join(root, 'node_repl')] }) });
  assert.equal(resolveServer(other.env).version, '26.1117.41037');
});

// Setup reads the app version with plutil or defaults, which only macOS has.
macTest('setup ends with the doctor passing on the 26.1117 wrapper', async t => {
  const w = world(t);
  const installer = join(w.app, HELPER_REL, 'Contents/SharedSupport/Codex Computer Use Installer.app/Contents/MacOS/Codex Computer Use Installer');
  mkdirSync(join(installer, '..'), { recursive: true });
  writeFileSync(installer, '');
  const lines = [], opened = [];
  const code = await setup({ env: w.env, log: line => lines.push(line), open: url => opened.push(url),
    execFile: async () => ({ stdout: 'OK: installed\n', stderr: '' }),
    doctor: async ({ env, log }) => {
      const result = await runDoctor({ env });
      for (const line of result.lines) log(line);
      return result.rc;
    } });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.includes('ok        shell: /bin/sh'), lines.join('\n'));
});

test('compat launch-shape passes the 26.1117 wrapper without running node_repl', async t => {
  const w = world(t);
  const s = resolveServer(w.env);
  const run = async () => { throw new Error('nothing may run'); };
  const { result } = await launchShapeCheck({ server: s, env: w.env, run });
  assert.equal(result.status, 'pass', result.reason);
  assert.deepEqual(result.wrapper, { shell: '/bin/sh', exports: ['BROWSER_USE_ACCESS_EXECUTOR_ID'] });
  assert.deepEqual(result.shape, ['-c', '<value>', '<value>', join(w.app, NODE_REPL_REL)]);
  const bad = await launchShapeCheck({ server: { ...s, args: ['-c', SNIPPET + '; id', 'cua-repl', join(w.app, NODE_REPL_REL)] }, env: w.env, run });
  assert.equal(bad.result.status, 'fail');
  assert.equal(bad.result.reason, 'unrecognized /bin/sh launch wrapper');
  const missing = await launchShapeCheck({ server: { ...s, args: [...s.args.slice(0, 3), join(w.root, 'node_repl')] }, env: w.env, run });
  assert.equal(missing.result.reason, 'missing wrapped program');
  // Any other wrapped program is never run for its option help (the throwing run proves nothing ran).
  const other = await launchShapeCheck({ server: { ...s, args: [...s.args.slice(0, 3), '/bin/ls'] }, env: w.env, run });
  assert.equal(other.result.status, 'fail');
  assert.equal(other.result.reason, 'wrapped program is neither node nor node_repl');
});

test('bench engine identities hash the wrapped program', t => {
  const w = world(t);
  writeFileSync(join(w.app, NODE_REPL_REL), 'node_repl bytes');
  const s = resolveServer(w.env);
  const identity = captureIdentity(s);
  assert.equal(identity.engine.entrypointArgIndex, 3);
  assert.equal(JSON.stringify(identity).includes(w.app), false);
  const acquisition = engineIdentity(s);
  assert.ok(acquisition.files[join(w.app, NODE_REPL_REL)]);
  assert.ok(acquisition.files['/bin/sh']);
});
