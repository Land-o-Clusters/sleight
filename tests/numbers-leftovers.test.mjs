import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { findNumbersLeftovers } from '../bench/tasks-mail-to-sheet.mjs';
import { openFixture } from '../bench/real-fixture.mjs';
import { executeRealTask } from '../bench/real-run.mjs';

function reader() {
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

for (const [document, title, expected] of [
  ['file:///custom/Transfer%20saved.numbers', 'Transfer saved', { path: '/custom/Transfer saved.numbers' }],
  ['', '/custom/Renamed.numbers', { path: '/custom/Renamed.numbers' }],
  ['', 'Renamed.numbers', { name: 'Renamed.numbers' }],
  ['', 'Transfer-nonce', {}],
]) test(`Numbers leftover metadata comes only from the retained window: ${document || title}`, () => {
  const sandbox = reader(), window = {}, reads = [];
  const result = sandbox.numbersDocumentReport(window, { text(element, attribute) {
    assert.equal(element, window); reads.push(attribute);
    return attribute === 'AXDocument' ? document : title;
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'available', ...expected });
  assert.deepEqual(reads, document ? ['AXDocument'] : ['AXDocument', 'AXTitle']);
});

test('a stale or unreadable Numbers window produces an unavailable receipt without throwing', () => {
  const result = reader().numbersDocumentReport({}, { text() { throw new Error('AX unavailable'); } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'unavailable' });
});

test('leftover reporting consumes only the window receipt, including a custom saved path', () => {
  const ctx = { numbers: { diagnostics: { numbersDocument: { status: 'available', path: '/nonexistent/custom/Renamed.numbers' } } } };
  assert.deepEqual(findNumbersLeftovers(ctx), ['/nonexistent/custom/Renamed.numbers']);
  ctx.numbers.diagnostics.numbersDocument = { status: 'available', name: 'Renamed.numbers' };
  assert.deepEqual(findNumbersLeftovers(ctx), ['Renamed.numbers']);
  ctx.numbers.diagnostics.numbersDocument = { status: 'available' };
  assert.deepEqual(findNumbersLeftovers(ctx), []);
});

test('missing window receipts report the unavailable check without any filesystem fallback', () => {
  assert.throws(() => findNumbersLeftovers({}), /^Error: leftover check unavailable$/);
});

test('the original CSV is not reported as a saved leftover', () => {
  const ctx = { mailToSheet: { source: '/run/Transfer.csv' },
    numbers: { diagnostics: { numbersDocument: { status: 'available', path: '/run/Transfer.csv' } } } };
  assert.deepEqual(findNumbersLeftovers(ctx), []);
});

test('the retained helper receipt reaches cleanup diagnostics and the run record before unlock', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'numbers-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, done = Promise.withResolvers();
  let emit, released = false;
  const result = await executeRealTask({
    setup: async current => {
      current.numbers = await openFixture(current, { app: 'Numbers', bundle: 'com.apple.iWork.Numbers',
        mode: 'document', target: '/run/Transfer.csv', reportDocument: true }, {
        helper: async () => ({ command: 'injected-helper', args: [] }), open: async () => {},
        run: (_command, _args, options) => {
          emit = event => options.onStdout(JSON.stringify(event) + '\n');
          emit({ stage: 'armed', running: true }); emit({ stage: 'ready' });
          return done.promise;
        },
      });
    },
    prompt: () => 'fixture', check: () => true,
    cleanup: async current => {
      const closing = current.numbers.close();
      emit({ stage: 'numbers-document', numbersDocument: { status: 'available', path: '/custom/Renamed.numbers' } });
      done.resolve({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' });
      await closing;
      assert.equal(current.numbers.diagnostics.numbersDocument.path, '/custom/Renamed.numbers');
      assert.equal(released, false);
    },
    leftovers: findNumbersLeftovers,
  }, ctx, { retainFixture: true, drive: async () => ({ code: 0, groupClean: true }),
    lock: async () => async () => { released = true; } });
  assert.equal(result.passed, true);
  assert.deepEqual(result.leftovers, ['/custom/Renamed.numbers']);
  assert.equal(result.fixtureDiagnostics[0].numbersDocument.path, '/custom/Renamed.numbers');
  assert.equal(released, true);
});
