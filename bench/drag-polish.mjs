// Focused checks, not bench/run.mjs. Uses only temporary TextEdit documents.
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
const sanitize = value => JSON.stringify(value, null, 2).split(homedir()).join('~') + '\n';
if (process.argv[2] === '--prepare') {
  mkdirSync(join(root, '.dev'), { recursive: true });
  call('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-drag-polish-swift-cache', '-o', fixture, 'bench/textedit-drag-fixture.swift']);
  process.exit(0);
}
const output = process.argv[2];
if (!output || !output.startsWith('docs/benchmarks/')) throw new Error('Use a docs/benchmarks results path');
const dir = mkdtempSync('/private/tmp/sleight-drag-polish-');
const results = { started: new Date().toISOString(), runs: [], trace: [], approvals: [] };
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const save = () => writeFileSync(join(root, output), sanitize(results));
const clientIn = new PassThrough(), clientOut = new PassThrough();
const serverIn = new PassThrough(), serverOut = new PassThrough();
let nextId = 1, buffer = '';
const pending = new Map();
clientOut.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const relay = createRelay({
  clientIn, clientOut, serverIn, serverOut, sessionId: `drag-polish-${process.pid}`,
  inputLease: new InputLease({ holder: `drag polish live ${process.pid}` }),
  localTools: {
    tools: [{ name: 'drag' }, { name: 'menu_bar' }], call: callLocalTool,
    target: async args => {
      const result = JSON.parse(call('/usr/bin/osascript', ['-l', 'JavaScript', 'plugins/sleight/lib/lease-target.js', JSON.stringify(args)]));
      if (!result.ok) throw new Error(result.error);
      return result.target;
    },
  },
  ask: async message => {
    const input = { mcp_server_name: 'plugin:sleight:computer', message };
    const answer = call(process.execPath, ['bench/approve.mjs'], { input: JSON.stringify(input) });
    const action = answer ? JSON.parse(answer).hookSpecificOutput.action : 'decline';
    results.approvals.push({ message, action }); save();
    return action;
  },
  trace: (direction, msg) => { results.trace.push({ t: new Date().toISOString(), direction, msg }); save(); },
});
const tool = (name, args) => new Promise(resolve => {
  const id = nextId++; pending.set(id, resolve);
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
});
let failed = false;
try {
  const menuOnly = process.argv[3] === '--menu-only';
  for (let n = 1; n <= (menuOnly ? 1 : 3) && !stopping; n++) {
    const path = join(dir, `drag-polish-${n}.txt`);
    const run = { n, path, before: 'alpha beta gamma\n', expected: 'beta gamma alpha\n' };
    results.runs.push(run); save();
    writeFileSync(path, run.before);
    try {
      call('/usr/bin/open', ['-g', '-a', 'TextEdit', path]);
      await new Promise(r => setTimeout(r, 1500));
      if (stopping) throw new Error('Run interrupted');
      if (menuOnly) {
        run.menuReply = await tool('menu_bar', { op: 'open', app: 'TextEdit' }); save();
        const reader = join(root, '.dev/menu-window-read.js');
        writeFileSync(reader, readFileSync(join(root, 'plugins/sleight/lib/menubar.js'), 'utf8') + `\nfunction run(argv) {
          const win = se.processes.byName('TextEdit').windows().find(w => w.name() === argv[0]);
          if (!win) throw new Error('fixture window missing');
          return JSON.stringify(readWindow(win));
        }\n`);
        run.windowElements = JSON.parse(call('/usr/bin/osascript', ['-l', 'JavaScript', reader, `drag-polish-${n}.txt`]));
        run.named = run.windowElements.length > 0 && run.windowElements.every(e => e.text);
        run.unnamedFallbacks = run.windowElements.filter(e => / at \(-?\d+, -?\d+\)$/.test(e.text)).length;
        run.coverage = 'ordinary TextEdit window reader only; no unnamed popover or live press verified';
        run.passed = false;
        failed = true;
        continue;
      }
      run.selection = JSON.parse(call(fixture, [path, 'select-drag'])); save();
      if (!run.selection.ok || run.selection.selected !== 'alpha' || !run.selection.from || !run.selection.to || !run.selection.windowId) throw new Error('No exact fixture selection in the drag tool window');
      run.reply = await tool('drag', { app: 'TextEdit', windowId: run.selection.windowId, from: run.selection.from, to: run.selection.to }); save();
      run.after = JSON.parse(call(fixture, [path, 'read']));
      run.passed = !run.reply.result?.isError && run.after.text === run.expected;
      if (!run.passed) failed = true;
    } catch (e) { run.error = e.message; run.stdout = e.stdout?.toString(); failed = true; }
    finally {
      try { call('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', path]); }
      catch (e) { run.cleanupError = e.message; failed = true; }
      save(); console.log(sanitize(run));
    }
  }
} finally {
  relay.close();
  results.finished = new Date().toISOString(); results.interrupted = stopping; results.exitCode = stopping ? 130 : failed ? 1 : 0; save();
}
process.exitCode = results.exitCode;
