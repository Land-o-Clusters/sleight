import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { recordTranscript } from '../plugins/sleight/lib/record-transcript.mjs';
import { writeOutsideSettings } from '../plugins/sleight/lib/person-gate.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function bank(t) {
  const path = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-record-transcript-')));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('mod converter reads a saved transcript without replaying its code, writes privately and refuses overwrite', t => {
  const home = bank(t), source = join(home, 'saved.jsonl'), out = join(home, 'out.json');
  const entries = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'mcp__plugin_sleight_computer__js', input: { code: 'throw new Error("never execute")' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
  ];
  writeFileSync(source, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const options = { write: (path, text, config) => writeOutsideSettings(path, text, { ...config, home }) };
  assert.equal(recordTranscript([source, out], options), 1);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).steps[0].args.code, 'throw new Error("never execute")');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.throws(() => recordTranscript([source, out], options), { code: 'EEXIST' });
});
test('mod converter rejects live recording and replay-shaped arguments before any library work', () => {
  for (const args of [[], ['--watch', 'com.example.App', 'out.json'], ['--watch', 'out.json'],
    ['record', 'session', 'out.json'], ['replay', 's.json', '--allow-positions'], ['session'], ['session', '--watch']])
    assert.throws(() => recordTranscript(args, { convert: () => assert.fail('conversion must not start'),
      write: () => assert.fail('write must not start') }), /Expected a saved transcript/);
});
test('mod converter keeps scripts over the 4 MiB stdout cap on the file route', t => {
  const home = bank(t), path = join(home, 'large.json');
  const code = 'x'.repeat(4 * 1024 * 1024);
  const script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code } }] };
  assert.equal(recordTranscript(['session', path], { convert: () => script,
    write: (file, text, config) => writeOutsideSettings(file, text, { ...config, home }) }), 1);
  assert.ok(statSync(path).size > 4 * 1024 * 1024);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).steps[0].args.code, code);
});
test('mod offline executable calls the converter and emits no script to stdout', t => {
  const home = bank(t), transcript = join(home, 'empty.jsonl'), output = join(home, 'out.json');
  writeFileSync(transcript, '');
  const run = spawnSync(new URL('../plugins/sleight/bin/sleight-record-transcript', import.meta.url).pathname, [transcript, output],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).steps, []);
});
test('broken variant caught: converter allows a live flag', () => {
  const code = readFileSync(new URL('../plugins/sleight/lib/record-transcript.mjs', import.meta.url), 'utf8');
  const before = " || arg.startsWith('-')";
  assert.ok(code.includes(before));
  const body = code.slice(code.indexOf('export function'), code.indexOf('\nif (isMainModule'))
    .replace('export function', 'function').replace(before, '');
  const mutant = Function('record', 'writeOutsideSettings', body + '\nreturn recordTranscript;')(() => ({ steps: [] }), () => {});
  assert.throws(() => assert.throws(() => mutant(['--watch', 'out.json']), /Expected/), { code: 'ERR_ASSERTION' });
});
test('broken variant caught: converter output loses exclusivity or privacy', () => {
  const options = [];
  recordTranscript(['session', 'out.json'], { convert: () => ({ steps: [] }), write: (...args) => options.push(args[2]) });
  const assertOptions = found => assert.deepEqual(found, { exclusive: true, mode: 0o600 });
  assertOptions(options[0]);
  const code = readFileSync(new URL('../plugins/sleight/lib/record-transcript.mjs', import.meta.url), 'utf8');
  for (const before of ['exclusive: true', 'mode: 0o600']) {
    assert.ok(code.includes(before));
    const body = code.slice(code.indexOf('export function'), code.indexOf('\nif (isMainModule'))
      .replace('export function', 'function').replace(before, before.startsWith('mode') ? 'mode: 0o644' : 'exclusive: false');
    const mutant = Function('record', 'writeOutsideSettings', body + '\nreturn recordTranscript;')(() => ({ steps: [] }), (...args) => assertOptions(args[2]));
    assert.throws(() => mutant(['session', 'out.json']), { code: 'ERR_ASSERTION' });
  }
});
