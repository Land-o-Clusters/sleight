// Small native TextEdit benchmark. The shell launcher compiles before taking
// the shared live lock. No engine process, foreground activation or HID posting.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { validateBackgroundDrag, textDragPoints, judgeTextDrag, runTextDragTrial, textDragExitCode } from './background-drag/helper.mjs';

const root = new URL('../', import.meta.url).pathname;
const execute = promisify(execFile);
const [operation, bank, pair] = process.argv.slice(2);
if (!['prepare', 'run'].includes(operation) || !/^\/private\/tmp\/sleight-text-drag-followup-[A-Za-z0-9]+$/.test(bank ?? '') ||
    (pair !== undefined && pair !== '--geometry-pair')) {
  throw new Error('expected prepare|run and the launcher-owned temporary bank');
}
const output = join(bank, 'results.json');
const redact = value => JSON.stringify(value, null, 2).split(homedir()).join('~') + '\n';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
let results = operation === 'prepare' ? { startedAt: new Date().toISOString(), commands: [], runs: [] } : JSON.parse(await readFile(output, 'utf8'));
async function save() { await writeFile(output, redact(results)); }
async function call(command, args, options = {}) {
  const { cleanup = false, ...childOptions } = options;
  if (stopping && !cleanup) throw new Error('cancelled');
  const record = { command, args, startedAt: new Date().toISOString() };
  results.commands.push(record);
  try {
    const value = await execute(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20000, ...childOptions });
    Object.assign(record, value, { exitCode: 0 });
    return value.stdout;
  } catch (error) {
    Object.assign(record, { stdout: error.stdout, stderr: error.stderr, exitCode: error.code, signal: error.signal, error: error.message });
    throw error;
  } finally { record.endedAt = new Date().toISOString(); await save(); }
}
const fixture = (path, op) => call(join(bank, 'fixture'), [path, op]).then(JSON.parse);
try {
  if (operation === 'prepare') {
    results.platform = await call('/usr/bin/sw_vers', []);
    for (const [name, source] of [['fixture', 'bench/textedit-drag-fixture.swift'], ['drag', 'bench/background-drag/background-drag.swift']]) {
      await call('/usr/bin/swiftc', ['-O', '-module-cache-path', join(bank, 'module-cache'), '-o', join(bank, name), source], { timeout: 180000 });
    }
    results.prepared = true;
  } else {
    // Use the benchmark approval hook itself, rather than adding an approval policy.
    const approval = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['bench/approve.mjs'], { cwd: root, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin.end(JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "TextEdit"?' }));
    });
    results.approval = JSON.parse(approval);
    if (results.approval.hookSpecificOutput?.action !== 'accept') throw new Error('benchmark allowlist refused TextEdit');
    if (!results.prepared) throw new Error('helpers were not compiled');
    const trials = pair ? [
      { id: 'old-endpoint', holdMs: 500, command: true, posting: 'pid' },
      { id: 'corrected-endpoint', holdMs: 500, command: true, posting: 'pid' },
    ] : [
      { id: 'corrected-control', holdMs: 500, command: true, posting: 'pid' },
      { id: 'two-second-hold', holdMs: 2000, command: true, posting: 'pid' },
      { id: 'five-second-hold', holdMs: 5000, command: true, posting: 'pid' },
      { id: 'no-command', holdMs: 2000, command: false, posting: 'pid' },
      { id: 'psn-posting', holdMs: 2000, command: true, posting: 'psn' },
      { id: 'ax-drag' },
    ];
    for (const trial of trials) {
      if (stopping) throw new Error('cancelled');
      const path = join(bank, `${basename(bank)}-${trial.id}.txt`);
      const run = { ...trial, path, startedAt: new Date().toISOString() };
      results.runs.push(run);
      await save();
      try {
        await runTextDragTrial({ cancelled: () => stopping, wait,
          open: async () => {
            await writeFile(path, 'alpha beta gamma\n');
            await call('/usr/bin/open', ['-g', '-a', 'TextEdit', path]);
          },
          select: async () => {
            run.selection = await fixture(path, 'select');
            if (!run.selection.ok || run.selection.selected !== 'alpha' || run.selection.active || !run.selection.windowId) {
              throw new Error('exact background fixture selection unavailable');
            }
          },
          drag: async () => {
            if (trial.id === 'ax-drag') { run.ax = await fixture(path, 'ax-drag'); }
            else {
              const { id: _id, ...settings } = trial;
              run.request = validateBackgroundDrag({ app: 'TextEdit', windowId: run.selection.windowId,
                ...(trial.id === 'old-endpoint' ? { from: run.selection.from, to: run.selection.to } : textDragPoints(run.selection)),
                ...settings, steps: 25, settleMs: 1500 });
              try { run.drag = JSON.parse(await call(join(bank, 'drag'), [JSON.stringify(run.request)])); }
              catch (error) {
                if (error.stdout?.trim()) run.drag = JSON.parse(error.stdout);
                else throw error;
              }
            }
          },
          read: async () => { run.after = await fixture(path, 'read'); },
          close: async () => {
            try { await call('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', path], { cleanup: true }); run.fixtureClosed = true; }
            catch (error) { run.cleanupError = error.message; stopping = true; }
          },
        });
        Object.assign(run, judgeTextDrag(run.drag, run.after));
      } catch (error) { run.error = error.message; }
      finally {
        run.endedAt = new Date().toISOString();
        await save();
        console.log(JSON.stringify({ id: run.id, moved: run.moved, backgroundMove: run.backgroundMove, text: run.after?.text,
          dragError: run.drag?.error, error: run.error, cleanupError: run.cleanupError, ax: run.ax }));
      }
    }
    results.summary = { attempted: results.runs.length, moved: results.runs.filter(r => r.moved).length,
      backgroundMoves: results.runs.filter(r => r.backgroundMove).length,
      closed: results.runs.filter(r => r.fixtureClosed).length };
    // Finding one background move is sufficient only when every trial completed
    // without unexpected errors. An unavailable AX drag action is expected.
    process.exitCode = textDragExitCode(results.runs, stopping);
  }
} catch (error) { results.error = error.message; process.exitCode = 1; }
finally {
  results.exitCode = process.exitCode ?? 0;
  await save();
  console.log(`Evidence: ${output}`);
}
