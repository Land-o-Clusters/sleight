// Owns the probe launch, native helper and cleanup. Every attempted run is kept.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { runBackgroundDrag } from '../plugins/sleight/lib/background-drag.mjs';

const root = resolve(import.meta.dirname, '..');
const app = join(root, '.dev/DragProbe.app');
const log = join(homedir(), 'Library/Logs/sleight/drag-probe.log');
const runs = [];
const output = process.argv[2] || join(root, '.dev/background-drag-results.json');
const modes = (process.argv[3] || 'pid,window,key-window,nsevent,nsevent-command,window-location').split(',');
const count = Number(process.argv[4] || 5);
if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('runs must be 1..20');
const call = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
let launched = false;
try {
  const alreadyRunning = call('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/background-fixture.js', 'running', app]).trim() === 'true';
  call('/usr/bin/open', ['-g', app]);
  launched = !alreadyRunning;
  await wait(1000);
  trials: for (const mode of modes) {
    for (let n = 1; n <= count; n++) {
      if (stopping) break trials;
      const before = existsSync(log) ? readFileSync(log, 'utf8') : '';
      let result;
      console.log(JSON.stringify({ stage: 'trial-start', mode, n }));
      try {
        result = await runBackgroundDrag({ app, from: [60, 80], to: [300, 150], steps: 12, mode,
          ...(process.argv[5] && process.argv[5] !== '-' ? { abortAfterStep: Number(process.argv[5]) } : {}),
          ...(process.argv[6] ? { holdMs: Number(process.argv[6]) } : {}) });
      } catch (e) { result = { ok: false, error: e.message, stdout: e.stdout?.toString() }; }
      await wait(300);
      const events = readFileSync(log, 'utf8').slice(before.length);
      const types = [...events.matchAll(/ (down|dragged|up) /g)].map(m => m[1]);
      const delivered = types[0] === 'down' && types.at(-1) === 'up' && types.filter(t => t === 'dragged').length === 12 && types.length === 14;
      const run = { mode, n, result, events, delivered, abortReleased: ['requested probe abort', 'drag cancelled'].includes(result.error) && types[0] === 'down' && types.at(-1) === 'up' };
      runs.push(run);
      writeFileSync(output, JSON.stringify({ macOS: call('/usr/bin/sw_vers', []), interrupted: stopping, runs }, null, 2) + '\n');
      console.log(JSON.stringify({ mode, n, delivered, pointerUnchanged: result.pointerUnchanged, stayedBackground: result.stayedBackground, error: result.error }));
    }
  }
} finally {
  // Quit only the probe app this script opened; never signal unrelated apps.
  if (launched) call('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/background-fixture.js', 'quit', app]);
  if (stopping) process.exitCode = 130;
}
