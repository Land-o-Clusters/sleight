// Offline byte comparison only. Does not start an engine, fixture app or benchmark runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as current from '../../plugins/sleight/lib/document-scope.mjs';
import { replSetupCode } from '../../plugins/sleight/lib/repl-warmup.mjs';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';

const base = 'ad5367d4';
const lib = fileURLToPath(new URL('../../plugins/sleight/lib/', import.meta.url));
const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sb3-bytes-')));
try {
  for (const file of readdirSync(lib)) if (file !== 'document-scope.mjs') symlinkSync(join(lib, file), join(dir, file));
  writeFileSync(join(dir, 'document-scope.mjs'), execFileSync('/usr/bin/git', ['show', `${base}:plugins/sleight/lib/document-scope.mjs`], { cwd: lib }));
  const previous = await import(pathToFileURL(join(dir, 'document-scope.mjs')));
  const code = 'await app.setValue(26, "street");', window = { title: 'Form', app: 'Fixture', url: null };
  const cases = [
    ['cold-default', m => m.guardedCode(code, window)],
    ['cold-lean', m => m.guardedCode(code, window, undefined, undefined, { prompt: 'lean' })],
    ['outcomes-cold', m => m.guardedCode(code, window, undefined, undefined, { outcomes: true })],
    ['outcomes-warm', m => m.guardedCode(code, window, undefined, undefined, { outcomes: true, reuseSetup: true, acknowledge: true })],
    ['warm-default', m => m.guardedCode(code, window, undefined, undefined, { reuseSetup: true, acknowledge: true })],
    ['read-setup', m => m.readCode('void 0;', { acknowledge: true })],
  ];
  const rows = cases.map(([name, build]) => {
    const a = build(previous), b = build(current);
    if (!name.startsWith('outcomes-')) assert.equal(b, a, `${name}: tracing-off payload changed`);
    return { name, baseBytes: Buffer.byteLength(a), bytes: Buffer.byteLength(b), delta: Buffer.byteLength(b) - Buffer.byteLength(a) };
  });
  const oldRepl = previous.readCode('void 0;', { acknowledge: true }), newRepl = replSetupCode();
  assert.equal(newRepl, oldRepl);
  rows.push({ name: 'repl-setup', baseBytes: Buffer.byteLength(oldRepl), bytes: Buffer.byteLength(newRepl), delta: 0 });
  console.log(JSON.stringify({ offline: true, base, trace: false, defaultOutcomes: false, rows }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
