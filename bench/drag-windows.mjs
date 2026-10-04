// Before/after checks on two owned TextEdit documents. No shared engine child.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const root = resolve(import.meta.dirname, '..');
const call = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 30000, ...options });
const fixture = join(root, '.dev/textedit-drag-fixture');
const legacy = join(root, '.dev/drag-a01e3d8.js');
const sanitize = value => JSON.stringify(value, null, 2).split(homedir()).join('~') + '\n';
if (process.argv[2] === '--prepare') {
  mkdirSync(join(root, '.dev'), { recursive: true });
  writeFileSync(legacy, call('/usr/bin/git', ['show', 'a01e3d8:plugins/sleight/lib/drag.js']));
  call('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-drag-polish-swift-cache', '-o', fixture, 'bench/textedit-drag-fixture.swift']);
  process.exit(0);
}
const output = process.argv[2];
if (!/^docs\/benchmarks\/[a-z0-9.-]+\.json$/.test(output ?? '')) throw new Error('Use a docs/benchmarks results filename');
const dir = mkdtempSync('/private/tmp/sleight-drag-windows-');
const results = { started: new Date().toISOString(), beforeSha: 'a01e3d8', runs: [], trace: [], approvals: [] };
const save = () => writeFileSync(join(root, output), sanitize(results));
let stopping = false, useLegacy = false, failed = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
const pending = new Map(); let nextId = 1, buffer = '';
clientOut.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const text = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.ok ? {} : { isError: true }) });
const relay = createRelay({
  clientIn, clientOut, serverIn, serverOut, sessionId: `drag-windows-${process.pid}`,
  inputLease: new InputLease({ holder: `drag windows live ${process.pid}` }),
  localTools: {
    tools: [{ name: 'drag' }],
    call: async (name, args, approve) => {
      if (!useLegacy) return callLocalTool(name, args, approve);
      if (!await approve(['drag', args.app], `Allow Claude to drag in ${args.app}? It moves your pointer for a few seconds.`)) return text({ ok: false, error: 'Benchmark approval declined' });
      return text(JSON.parse(call('/usr/bin/osascript', ['-l', 'JavaScript', legacy, JSON.stringify(args)])));
    },
    target: async args => {
      const reply = JSON.parse(call('/usr/bin/osascript', ['-l', 'JavaScript', 'plugins/sleight/lib/lease-target.js', JSON.stringify(args)]));
      if (!reply.ok) throw new Error(reply.error);
      return reply.target;
    },
  },
  ask: async message => {
    const input = { mcp_server_name: 'plugin:sleight:computer', message };
    const answer = call(process.execPath, ['bench/approve.mjs'], { input: JSON.stringify(input) });
    const action = answer ? JSON.parse(answer).hookSpecificOutput.action : 'decline';
    results.approvals.push({ message, action }); save(); return action;
  },
  trace: (direction, msg) => { results.trace.push({ t: new Date().toISOString(), direction, msg }); save(); },
});
const drag = args => new Promise(resolve => {
  const id = nextId++; pending.set(id, resolve);
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'drag', arguments: args } }) + '\n');
});
const cases = ['before-wrong-window', 'before-title-bar', 'after-ambiguous', 'after-title-bar', 'after-valid-1', 'after-valid-2'];
try {
  for (const kind of cases) {
    if (stopping) break;
    const paths = [join(dir, `${kind}-source.txt`), join(dir, `${kind}-other.txt`)];
    const run = { kind, paths, before: 'alpha beta gamma\n', expected: 'beta gamma alpha\n' };
    results.runs.push(run); save();
    try {
      for (let i = 0; i < paths.length; i++) {
        writeFileSync(paths[i], run.before);
        call('/usr/bin/open', ['-g', '-a', 'TextEdit', paths[i]]);
        await new Promise(r => setTimeout(r, 800));
        if (stopping) throw new Error('Run interrupted');
        const place = JSON.parse(call(fixture, [paths[i], 'place', i ? 'other' : 'source']));
        if (!place.ok) throw new Error('Fixture placement failed');
      }
      run.selection = JSON.parse(call(fixture, [paths[0], 'select-drag']));
      run.otherSelection = JSON.parse(call(fixture, [paths[1], 'select-drag'])); save();
      if (!run.selection.ok || !run.otherSelection.ok || !run.selection.windowId || !run.selection.from || !run.selection.to || run.selection.windowId === run.otherSelection.windowId) throw new Error('Two distinct fixture windows are required');
      useLegacy = kind.startsWith('before-');
      // The old largest-window helper must never act on an unrelated document.
      if (useLegacy && !run.otherSelection.isStrictlyLargestWindow) throw new Error('Owned other window is not strictly largest; legacy drag refused by fixture');
      const args = { app: 'TextEdit', windowId: run.selection.windowId, from: run.selection.from, to: kind.endsWith('title-bar') ? [119, 10] : run.selection.to };
      if (kind === 'after-ambiguous') delete args.windowId;
      run.request = args; run.reply = await drag(args); save();
      run.sourceAfter = JSON.parse(call(fixture, [paths[0], 'read']));
      run.otherAfter = JSON.parse(call(fixture, [paths[1], 'read']));
      const isError = Boolean(run.reply.result?.isError);
      if (useLegacy) {
        run.reproduced = run.sourceAfter.text === run.before && run.otherAfter.text !== run.before;
        run.lostWord = !run.otherAfter.text.includes('alpha');
      } else if (kind === 'after-ambiguous' || kind === 'after-title-bar') {
        run.passed = isError && run.sourceAfter.text === run.before && run.otherAfter.text === run.before;
      } else {
        run.passed = !isError && run.sourceAfter.text === run.expected && run.otherAfter.text === run.before;
      }
      if (useLegacy ? !run.reproduced : !run.passed) failed = true;
    } catch (e) { run.error = e.message; run.stdout = e.stdout?.toString(); failed = true; }
    finally {
      for (const path of paths) {
        try { call('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', path]); }
        catch (e) { (run.cleanupErrors ??= []).push(e.message); failed = true; }
      }
      save(); console.log(sanitize(run));
    }
  }
} finally {
  relay.close(); results.finished = new Date().toISOString(); results.interrupted = stopping;
  results.exitCode = stopping ? 130 : failed ? 1 : 0; save();
}
process.exitCode = results.exitCode;
