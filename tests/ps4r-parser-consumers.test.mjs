import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldWrites } from '../plugins/sleight/lib/write-effect.mjs';
import { hasWrite, writeCodeTrace } from '../plugins/sleight/lib/write-trace.mjs';

const tree = 'Window: "Form", App: Fixture.\n0 standard window Form\n\t26 text field Address\n';

test('invalid cells cannot establish a field write or retain trace source', () => {
  const source = 'const broken = ; await app.setValue(26, "secret")';
  assert.deepEqual(fieldWrites(source, tree), []);
  assert.equal(writeCodeTrace(source).code, '[unparseable code redacted]');
  assert.equal(hasWrite('const broken = ;'), true);
});

test('trace ranges hide complete templates, every literal and encoder arguments', () => {
  const source = '/* private */ const a = `private ${nested("private")}`; const b = /private/giu; const c = [.125, 0xffn, true, false, null]; const d = Buffer.from(payload).toString(); app.paste(a); // private';
  const trace = writeCodeTrace(source);
  assert.doesNotMatch(trace.code, /private|nested|125|0xff|true|false|null|payload/);
  assert.match(trace.code, /app.paste\(a\)/);
});

test('input presence includes escaped and computed method references', () => {
  for (const source of ['app.cl\\u0069ck(26)', 'app["\\x70aste"](value)', 'const input = app?.typeText'])
    assert.equal(hasWrite(source), true, source);
  assert.equal(hasWrite('const title = "read only"; title.trim()'), false);
});

test('control flow and functions cannot establish field effects', () => {
  for (const source of [
    'if (ready) await app.setValue(26, "secret")',
    'for (;;) { await app.setValue(26, "secret"); break; }',
    'while (ready) await app.setValue(26, "secret")',
    'do { await app.setValue(26, "secret"); } while (ready)',
    'function write() { app.setValue(26, "secret") }',
    'const write = () => app.setValue(26, "secret")',
    'switch (ready) { case true: app.setValue(26, "secret") }',
    'class Writer { write() { app.setValue(26, "secret") } }',
  ]) assert.deepEqual(fieldWrites(source, tree), [], source);
});
