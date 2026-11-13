import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { compilerDiagnostics, compilerDiagnosticLine } from '../plugins/sleight/lib/direct-browser/compiler-diagnostics.mjs';

test('GLINT4 doctor diagnostic contains the first primary error and no following source', () => {
  const stderr = 'warning: preceding warning\nDriver.swift:9:3: error: circular reference\n' +
    '9 | PRIVATE SOURCE\n  | `- error: PRIVATE ANNOTATION\nerror: SECOND ERROR';
  assert.deepEqual(compilerDiagnostics(stderr), ['circular reference', 'SECOND ERROR']);
  assert.equal(compilerDiagnosticLine(stderr), 'error: circular reference');
  assert.equal(compilerDiagnosticLine('9 | let s = "error: PRIVATE SOURCE"'), undefined);
  assert.equal(compilerDiagnosticLine(undefined), undefined);
});
test('GLINT4 doctor diagnostic removes home paths and terminal controls before bounding UTF-8 bytes', () => {
  const otherHome = '/' + ['Users', 'fixture-owner'].join('/');
  const stderr = `Driver.swift:9:3: error: '${userInfo().homedir}/local' '${otherHome}/other'\u001b[31m\u0007\u202e` + 'é'.repeat(300);
  const line = compilerDiagnosticLine(stderr);
  assert.ok(line.startsWith("error: '~/local' '~/other'"), line);
  assert.equal(Buffer.byteLength(line), 240);
  assert.equal(line, Buffer.from(line).toString('utf8'));
  assert.doesNotMatch(line, /fixture-owner|\u001b|\u0007|\u202e|\ufffd/);
  assert.ok(Buffer.byteLength(JSON.stringify({ diagnostic: line, key: 'a'.repeat(64), toolchain: 'b'.repeat(64),
    failedAt: Date.now(), code: 'HOST_COMPILE_FAILED' })) < 1024);
});
