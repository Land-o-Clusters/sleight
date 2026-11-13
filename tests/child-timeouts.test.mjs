import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { ChangeReview } from '../plugins/sleight/lib/change-review.mjs';
import { serverFromChatGPTApp, setup, NODE_REL, REPL_REL, HELPER_REL } from '../plugins/sleight/lib/setup.mjs';
import { encodeSheet, sheetEncoding } from '../plugins/sleight/skills/make-character/tool/build.mjs';

const timeout = () => Object.assign(Error('injected timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null });
function replaceExec(t, run) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = run;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
}
function reviewFixture(t) {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-child-timeouts-')));
  const path = join(bank, 'document.txt'); writeFileSync(path, 'before\n');
  const review = new ChangeReview(); t.after(() => review.dispose());
  return { bank, path, review, doc: { title: 'document.txt', url: pathToFileURL(path).href } };
}

test('ditto timeout removes a partial snapshot and refuses a partial restore', { skip: process.platform !== 'darwin' }, t => {
  const f = reviewFixture(t);
  let fail = true;
  replaceExec(t, (command, args, options) => {
    assert.equal(command, '/usr/bin/ditto');
    assert.equal(options.timeout, 120000); assert.equal(options.killSignal, 'SIGKILL');
    if (fail) { writeFileSync(args.at(-1), 'partial'); throw timeout(); }
    cpSync(args.at(-2), args.at(-1)); return Buffer.alloc(0);
  });
  assert.throws(() => f.review.before(f.doc), { code: 'ETIMEDOUT' });
  assert.deepEqual(readdirSync(f.review.directory), []);
  assert.equal(f.review.entries.size, 0);
  fail = false;
  const entry = f.review.before(f.doc);
  writeFileSync(f.path, 'after\n'); f.review.after(entry);
  fail = true;
  assert.throws(() => f.review.decide(entry, 'undo'), { code: 'ETIMEDOUT' });
  assert.equal(readFileSync(f.path, 'utf8'), 'after\n');
  assert.equal(entry.status, 'pending');
  assert.deepEqual(readdirSync(f.bank), ['document.txt']);
});

test('diff timeout makes review unavailable and refuses undo', t => {
  const f = reviewFixture(t);
  replaceExec(t, (command, args, options) => {
    if (command === '/usr/bin/ditto') { cpSync(args.at(-2), args.at(-1)); return Buffer.alloc(0); }
    assert.equal(command, '/usr/bin/diff');
    assert.equal(options.timeout, 30000); assert.equal(options.killSignal, 'SIGKILL');
    throw timeout();
  });
  const entry = f.review.before(f.doc);
  writeFileSync(f.path, 'after\n'); f.review.after(entry);
  assert.match(f.review.describe(entry), /^Review unavailable:\n  injected timeout\nUndo will refuse\.$/m);
  assert.deepEqual(readdirSync(f.review.directory), ['0']);
  assert.throws(() => f.review.decide(entry, 'undo'), /review unavailable/);
  assert.equal(readFileSync(f.path, 'utf8'), 'after\n');
});

test('SA2K preview bank is removed after a successful diff', t => {
  const f = reviewFixture(t);
  const entry = f.review.before(f.doc);
  writeFileSync(f.path, 'after\n'); f.review.after(entry);
  assert.match(f.review.describe(entry), /^  -before\n  \+after$/m);
  assert.deepEqual(readdirSync(f.review.directory), ['0']);
  assert.equal(readFileSync(entry.snapshot, 'utf8'), 'before\n');
});

test('SA2K preview bank is removed after a diff error', t => {
  const f = reviewFixture(t);
  replaceExec(t, (command, args, options) => {
    if (command === '/usr/bin/ditto') { cpSync(args.at(-2), args.at(-1)); return Buffer.alloc(0); }
    assert.equal(command, '/usr/bin/diff');
    assert.equal(options.timeout, 30000); assert.equal(options.killSignal, 'SIGKILL');
    throw Object.assign(Error('injected diff error'), { status: 2 });
  });
  const entry = f.review.before(f.doc);
  writeFileSync(f.path, 'after\n'); f.review.after(entry);
  assert.match(f.review.describe(entry), /^Review unavailable:\n  injected diff error\nUndo will refuse\.$/m);
  assert.deepEqual(readdirSync(f.review.directory), ['0']);
  assert.throws(() => f.review.decide(entry, 'undo'), /review unavailable: injected diff error/);
  assert.equal(readFileSync(f.path, 'utf8'), 'after\n');
});

function fakeBundle(t) {
  const app = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-version-timeout-')));
  for (const path of [NODE_REL, REPL_REL, HELPER_REL]) { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), ''); }
  return app;
}

test('plutil timeout tries defaults, and two timeouts stop setup before installer or UI', async t => {
  const app = fakeBundle(t), commands = [];
  let fallbackFails = false;
  replaceExec(t, (command, _args, options) => {
    commands.push(command);
    assert.equal(options.timeout, 30000); assert.equal(options.killSignal, 'SIGKILL');
    if (command === '/usr/bin/plutil' || fallbackFails) throw timeout();
    assert.equal(command, '/usr/bin/defaults'); return '26.fixture\n';
  });
  assert.equal(serverFromChatGPTApp({ app }).version, '26.fixture');
  assert.deepEqual(commands, ['/usr/bin/plutil', '/usr/bin/defaults']);
  commands.length = 0; fallbackFails = true;
  assert.equal(serverFromChatGPTApp({ app }).version, 'bundle');
  const lines = [];
  const forbidden = () => assert.fail('setup continued after failed version lookup');
  assert.equal(await setup({ env: { SLEIGHT_CHATGPT_APP: app }, log: line => lines.push(line),
    open: forbidden, execFile: forbidden, doctor: forbidden, resolveServer: forbidden }), 1);
  assert.match(lines.join('\n'), /version check timed out \(plutil and defaults/);
  assert.doesNotMatch(lines.join('\n'), /not found/);
  assert.equal(commands.length, 4);
  assert.equal(existsSync(join(app, 'installer.log')), false);
});

test('cwebp timeouts retain custom PNG fallback and fail the pinned build', t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-webp-timeout-')));
  const png = join(bank, 'sheet.png'); writeFileSync(png, 'fixture PNG');
  const run = (_command, args, options) => {
    assert.equal(options.timeout, args.includes('-version') ? 30000 : 300000);
    assert.equal(options.killSignal, 'SIGKILL'); throw timeout();
  };
  assert.equal(sheetEncoding(true, run), 'png');
  assert.throws(() => sheetEncoding(false, run), { code: 'ETIMEDOUT' });
  assert.equal(encodeSheet(png, join(bank, 'sheet.webp'), { extension: 'webp', custom: true, run }).extension, 'png');
  assert.throws(() => encodeSheet(png, join(bank, 'sheet.webp'), { extension: 'webp', custom: false, run }), { code: 'ETIMEDOUT' });
});
