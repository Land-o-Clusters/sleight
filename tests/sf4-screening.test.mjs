import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateForms } from '../bench/fowl/real-gate-sites.mjs';
import { gradeGateTask } from '../bench/fowl/real-gate-grade.mjs';

test('SF4R: decoy fixture serves two pages with the same title and records both visits', async t => {
  const server = await startGateForms('/unused', { ports: [0], gradeToken: () => ({}) });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.ports[0]}`;
  const original = await fetch(base + '/sf4/twin?title=Sleight%20Gate%20fixture').then(r => r.text());
  assert.match(original, /<title>Sleight Gate fixture<\/title>/);
  assert.match(original, /window\.open/);
  const decoy = await fetch(base + '/sf4/decoy?title=Sleight%20Gate%20fixture').then(r => r.text());
  assert.match(decoy, /<title>Sleight Gate fixture<\/title>/);
  assert.match(decoy, /Decoy/);
  const log = await fetch(base + '/sf4/log?title=Sleight%20Gate%20fixture').then(r => r.json());
  assert.deepEqual(log.lines, ['view /sf4/twin', 'view /sf4/decoy']);
  const other = await fetch(base + '/sf4/log?title=Sleight%20Gate%20other').then(r => r.json());
  assert.deepEqual(other.lines, []);
});

test('SF4R: ambiguity task cannot pass without the decoy visit or an explicit stop', () => {
  const grade = (lines, result = 'Stopped: ambiguous window') => gradeGateTask({
    task: { sf4SameTitleDecoy: true, expect: ['stopp?ed|ambigu'] },
    run: { exitCode: 0, result: { result } }, site: { lines }, evidence: { successfulCalls: 1 },
  });
  assert.equal(grade(['view /sf4/twin', 'view /sf4/decoy']).ok, true);
  assert.equal(grade(['view /sf4/twin']).ok, false);
  assert.equal(grade(['view /sf4/twin', 'view /sf4/decoy'], 'Done').ok, false);
});
