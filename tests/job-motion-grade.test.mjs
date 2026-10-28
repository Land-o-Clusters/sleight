import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { gradeJob, jobColors, createJobFixture, jobHandler } from '../bench/world/job-fixtures.mjs';
import { regradeJobMotionBank } from '../bench/fowl/regrade-job-motion.mjs';

const phases = ['amber', 'teal', 'violet'];
const input = (answer = phases, order = phases) => ({ task: { name: 'job-motion', worldFixture: 'job-motion' },
  expected: { phases: order }, answer: `RESULT: ${JSON.stringify({ phases: answer })}`,
  site: { kind: 'job-motion', views: [''], events: [{ kind: 'motion', phases: order, reduced: false }] } });

test('JM1 fixes the vocabulary beside the exact fixture RGB fills', async () => {
  assert.deepEqual(jobColors, {
    amber: { hex: '#ffbf26', names: ['amber', 'yellow', 'gold', 'orange'] },
    teal: { hex: '#138d86', names: ['teal', 'turquoise', 'blue-green'] },
    violet: { hex: '#8753d8', names: ['violet', 'purple'] },
  });
  const names = Object.values(jobColors).flatMap(color => color.names);
  assert.equal(new Set(names).size, names.length);
  assert.ok(Object.isFrozen(jobColors));
  for (const color of Object.values(jobColors)) assert.ok(Object.isFrozen(color) && Object.isFrozen(color.names));
  const fixture = createJobFixture('job-motion', { nonce: 'jm1', seed: 'held-out' });
  let html;
  const req = Readable.from([]); Object.assign(req, { method: 'GET', url: '/jm1/', headers: { host: '127.0.0.1:5432' } });
  await jobHandler(fixture, 'http://127.0.0.1:5432')(req, { writeHead() { return this; }, end(body) { html = body; } });
  assert.match(html, /const palette=(\{[^}]+\})/);
  assert.deepEqual(JSON.parse(html.match(/const palette=(\{[^}]+\})/)[1]), Object.fromEntries(Object.entries(jobColors).map(([key, color]) => [key, color.hex])));
});

for (const order of [phases, ['teal', 'violet', 'amber'], ['violet', 'amber', 'teal']]) {
  for (const amber of jobColors.amber.names) for (const teal of jobColors.teal.names) for (const violet of jobColors.violet.names) {
    const synonyms = { amber, teal, violet };
    test(`JM1 accepts ${order.map(color => synonyms[color]).join('/')} with exact order`, () => {
      const value = input(order.map(color => synonyms[color]), order), before = structuredClone(value);
      assert.equal(gradeJob(value).ok, true);
      assert.deepEqual(value, before);
    });
  }
}
test('JM1 normalizes only name case and surrounding whitespace', () => {
  assert.equal(gradeJob(input([' YELLOW ', 'TeAl', 'PURPLE'])).ok, true);
  for (const answer of [['yellow', 'purple', 'teal'], ['yellow', 'yellow', 'purple'], ['yellow', 'teal'],
    ['yellow', 'teal', 'purple', 'gray'], ['yellow', null, 'purple'], null, 'yellow/teal/purple',
    ['yellow', 'green', 'purple'], ['yellow', 'cyan', 'purple'], ['yellowish', 'teal', 'purple'],
    ['yellow', 'teal', 'lavender'], ['#ffbf26', 'teal', 'purple'], ['yellow', 'teal', {}]]) {
    assert.deepEqual(gradeJob(input(answer)).problems, ['JOB_ANSWER_MISMATCH']);
  }
  const extra = input(); extra.answer = JSON.stringify({ phases, extra: true });
  assert.deepEqual(gradeJob(extra).problems, ['JOB_ANSWER_MISMATCH']);
});
test('JM1 synonyms still need canonical completion evidence and a page visit', () => {
  const value = input(['yellow', 'teal', 'purple']);
  for (const events of [[], [{ kind: 'motion', phases, reduced: true }],
    [{ kind: 'motion', phases: ['yellow', 'teal', 'purple'], reduced: false }],
    [{ kind: 'motion', phases: [...phases].reverse(), reduced: false }]]) {
    assert.deepEqual(gradeJob({ ...value, site: { ...value.site, events } }).problems, ['JOB_MOTION_NOT_PROVED']);
  }
  assert.deepEqual(gradeJob({ ...value, site: { ...value.site, views: [] } }).problems, ['JOB_PAGE_NOT_READ']);
});
test('JM1 leaves the dark badge answer contract exact', () => {
  const media = { kind: 'media', width: 1000, height: 800, scheme: 'light', reduced: false };
  const value = { task: { worldFixture: 'job-dark' }, expected: { scheme: 'dark', badge: 'amber' },
    site: { kind: 'job-dark', views: [''], events: [media, { ...media, scheme: 'dark' }, media] } };
  assert.equal(gradeJob({ ...value, answer: JSON.stringify(value.expected) }).ok, true);
  assert.equal(gradeJob({ ...value, answer: JSON.stringify({ scheme: 'dark', badge: 'yellow' }) }).ok, false);
});

function bank(t) { return registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-jm1-'))); }
function save(root, arm, repetition, value = input(['yellow', 'teal', 'purple']), problems = ['JOB_ANSWER_MISMATCH'], group = 'jobs') {
  const dir = join(root, group, `fixtures-2026-10-28T17-16-42-265Z-${repetition}-${arm}-job-motion`, 'round');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'results.json');
  writeFileSync(file, JSON.stringify([{ task: value.task, surface: arm, site: value.site, wallMs: 16000,
    run: { exitCode: 0, result: { result: value.answer } }, outcome: { ok: !problems.length, problems } }]));
  return file;
}
test('JM1 regrades both arms identically, includes top-ups, preserves failures and recorded bytes', t => {
  const root = bank(t), files = [];
  for (const arm of ['fowlbrowser', 'sleight-turbo']) {
    files.push(save(root, arm, 1));
    files.push(save(root, arm, 2, input(['purple', 'teal', 'yellow'])));
    files.push(save(root, arm, 3, input(), []));
    files.push(save(root, arm, 4, input(['yellow', 'teal', 'purple']), ['JOB_ANSWER_MISMATCH', 'unrelated failure'], 'jobs-topup'));
  }
  const raw = files.map(file => readFileSync(file)), report = regradeJobMotionBank(root);
  for (const arm of ['fowlbrowser', 'sleight-turbo']) assert.deepEqual(report.totals[arm], { before: 1, after: 2, total: 4, unverified: 0 });
  assert.equal(report.rows.length, 8);
  assert.equal(report.rows.filter(row => row.afterProblems.includes('unrelated failure')).length, 2);
  assert.match(report.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(regradeJobMotionBank(root), report);
  files.forEach((file, index) => assert.deepEqual(readFileSync(file), raw[index]));
  writeFileSync(files[0], readFileSync(files[0], 'utf8') + '\n');
  assert.notEqual(regradeJobMotionBank(root).evidenceSha256, report.evidenceSha256);
});
for (const kind of ['missing', 'conflicting', 'reduced', 'partial', 'duplicate']) test(`JM1 regrade refuses ${kind} fixture order`, t => {
  const root = bank(t), value = input(['yellow', 'teal', 'purple']);
  if (kind === 'missing') value.site.events = [];
  if (kind === 'conflicting') value.site.events.push({ kind: 'motion', phases: [...phases].reverse(), reduced: false });
  if (kind === 'reduced') value.site.events[0].reduced = true;
  if (kind === 'partial') value.site.events[0].phases = ['amber', 'teal'];
  if (kind === 'duplicate') value.site.events[0].phases = ['amber', 'amber', 'teal'];
  save(root, 'fowlbrowser', 1, value);
  const report = regradeJobMotionBank(root);
  assert.equal(report.rows[0].after, false);
  assert.equal(report.totals.fowlbrowser.unverified, 1);
  assert.ok(report.rows[0].afterProblems.includes('JM1_EXPECTED_ORDER_UNAVAILABLE'));
});
test('JM1 regrade reports missing rounds, excludes aborted banks, and rejects malformed rows', t => {
  const root = bank(t);
  save(join(root, 'jobs.aborted-123'), 'fowlbrowser', 1);
  assert.equal(regradeJobMotionBank(root).status, 'no recorded job-motion rounds');
  const file = save(root, 'fowlbrowser', 1);
  const rows = JSON.parse(readFileSync(file)); rows[0].surface = 'sleight-turbo';
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(() => regradeJobMotionBank(root), /invalid recorded/);
  writeFileSync(file, '[]');
  assert.throws(() => regradeJobMotionBank(root), /expected one recorded/);
});
