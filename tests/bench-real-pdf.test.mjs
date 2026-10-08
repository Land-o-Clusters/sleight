import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pdf from '../bench/real-pdf.mjs';

test('PDF compilation awaits owned process collection, forwards cancellation and removes a collected failed cache', async t => {
  const root = mkdtempSync(join(tmpdir(), 'real-pdf-process-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const tool = pdf.createPDFTool({ temporaryRoot: root, run: async (command, args, options) => {
    assert.equal(command, '/usr/bin/xcrun');
    assert.equal(args[0], 'swiftc');
    assert.equal(options.signal, signal);
    assert.equal(options.timeoutMs, 180000);
    return { exit: { code: null, signal: 'SIGTERM' }, timedOut: true, groupClean: true, stderr: '' };
  } });
  await assert.rejects(tool.writeTestPDF(join(root, 'fixture.pdf'), [0, 0], signal), /timed out/);
  assert.deepEqual(readdirSync(root), []);
});

test('an uncollected PDF process preserves its private cache and refuses to use its output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'real-pdf-process-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tool = pdf.createPDFTool({ temporaryRoot: root, run: async () => ({
    exit: { code: 0, signal: null }, groupClean: false, stdout: '{}', stderr: '',
  }) });
  await assert.rejects(tool.writeTestPDF(join(root, 'fixture.pdf')), /cleanup unconfirmed/);
  assert.equal(readdirSync(root).length, 1);
});
