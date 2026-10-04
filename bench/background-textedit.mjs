// Owns only five temporary TextEdit documents. Never changes other documents.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const call = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
const wait = ms => new Promise(r => setTimeout(r, ms));
if (process.argv[2] === '--cleanup') {
  const results = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const run of results.runs) {
    if (!/^\/private\/tmp\/sleight-background-textedit-[^/]+\/sleight-background-\d+\.txt$/.test(run.path)) throw new Error('not a fixture path');
    call('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', run.path]);
  }
  console.log('Closed only documents listed in the fixture results');
  process.exit(0);
}
const dir = mkdtempSync('/private/tmp/sleight-background-textedit-');
mkdirSync(join(root, '.dev'), { recursive: true });
const fixture = join(root, '.dev/textedit-drag-fixture');
const drag = join(root, '.dev/background-drag');
call('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-swift-cache', '-o', fixture, 'bench/textedit-drag-fixture.swift']);
call('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-swift-cache', '-o', drag, 'plugins/sleight/lib/background-drag.swift']);
const results = { macOS: call('/usr/bin/sw_vers', []), runs: [] };
const output = process.argv[2] || join(root, '.dev/background-textedit-results.json');
const mode = process.argv[3] || 'window-location';
const selectByMouse = process.argv[4] === 'mouse-select';
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
for (let n = 1; n <= 5 && !stopping; n++) {
  const path = join(dir, `sleight-background-${n}.txt`);
  writeFileSync(path, 'alpha beta gamma\n');
  const title = basename(path);
  let run = { n, path };
  let opened = false;
  try {
    call('/usr/bin/open', ['-g', '-a', 'TextEdit', path]);
    opened = true;
    await wait(1200);
    const selection = JSON.parse(call(fixture, [path, 'select']));
    run.selection = selection;
    if (!selection.ok || selection.selected !== 'alpha' || !selection.from || !selection.to || !selection.windowId) throw new Error('selection or bounds unavailable');
    run.drag = JSON.parse(call(drag, [JSON.stringify({ app: 'TextEdit', windowId: selection.windowId, from: selection.from, to: selection.to, mode, select: selectByMouse, steps: 25 })]));
    await wait(1000);
    run.after = JSON.parse(call(fixture, [path, 'read']));
    run.moved = /^\s*beta gamma\s*alpha\s*$/.test(run.after.text);
  } catch (e) { run.error = e.message; run.stdout = e.stdout?.toString(); }
  finally {
    // Exact path, with no save dialog and no edits to unrelated documents.
    if (opened) {
      try { call('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', path]); }
      catch (e) { run.cleanupError = e.message; }
    }
  }
  results.runs.push(run);
  writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ n, moved: run.moved, selected: run.selection?.selected, after: run.after?.text, pointerUnchanged: run.drag?.pointerUnchanged, error: run.error }));
}
