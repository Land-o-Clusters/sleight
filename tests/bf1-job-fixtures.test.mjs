import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

async function load() {
  const module = await import('../bench/world/job-fixtures.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(module, 'BF1 local job fixtures must exist');
  return module;
}
const kinds = ['job-canvas', 'job-kanban', 'job-phone', 'job-dark', 'job-motion'];

async function request(handle, route, { method = 'GET', host = '127.0.0.1:5432', origin, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url: route, method, headers: { host, ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
  const response = {};
  const res = { writeHead(code, headers) { response.code = code; response.headers = headers; return this; }, end(body) { response.body = body; } };
  await handle(req, res);
  return response;
}

test('BF1 jobs cover four gap sections with independent deterministic data and bounded prompts', async () => {
  const { jobKinds, createJobFixture, jobTask } = await load();
  assert.deepEqual(jobKinds, kinds);
  for (const kind of kinds) {
    const fixture = createJobFixture(kind, { nonce: 'trial', seed: 'held-out-a' });
    assert.deepEqual(fixture.expected, createJobFixture(kind, { nonce: 'trial', seed: 'held-out-a' }).expected);
    if (['job-canvas', 'job-kanban', 'job-motion'].includes(kind))
      assert.notDeepEqual(fixture.expected, createJobFixture(kind, { nonce: 'trial', seed: 'held-out-b' }).expected);
    const task = jobTask(fixture, 'http://127.0.0.1:5432', 'chrome');
    assert.equal(task.worldFixture, kind);
    assert.match(task.grade, /\/trial\/api\/log$/);
    assert.ok(task.prompt.length < 1000);
    assert.ok(!task.prompt.includes(JSON.stringify(fixture.expected)));
  }
  assert.throws(() => createJobFixture('foreign', { nonce: 'trial' }));
  assert.throws(() => createJobFixture('job-dark', { nonce: '../escape' }));
});

test('BF1 jobs do not expose private keys in logs and reject cross-origin or malformed evidence', async () => {
  const { createJobFixture, jobHandler } = await load();
  const fixture = createJobFixture('job-kanban', { nonce: 'trial', seed: 'one' });
  const handle = jobHandler(fixture, 'http://127.0.0.1:5432');
  const log = () => request(handle, '/trial/api/log');
  assert.deepEqual(JSON.parse((await log()).body), { kind: 'job-kanban', views: [], events: [] });
  assert.equal((await request(handle, '/trial/', { host: 'other:5432' })).code, 404);
  assert.equal((await request(handle, '/trial/', { origin: 'http://evil.example' })).code, 403);
  assert.equal((await request(handle, '/trial/unknown')).code, 404);
  assert.equal((await request(handle, '/trial/')).code, 200);
  assert.equal((await request(handle, '/trial/event', { method: 'POST', body: { kind: 'not-real' } })).code, 400);
  assert.equal((await request(handle, '/trial/event', { method: 'POST', origin: 'http://evil.example', body: { kind: 'drag' } })).code, 403);
  assert.deepEqual(JSON.parse((await log()).body).views, ['']);
  assert.equal(JSON.parse((await log()).body).expected, undefined);
});

test('BF1 graders require page/action evidence and exact answers rather than narration or wrong answers', async () => {
  const { createJobFixture, gradeJob } = await load();
  const evidence = fixture => ({ kind: fixture.kind, views: [''], events: {
    'job-canvas': [],
    'job-kanban': [{ kind: 'drag', card: fixture.expected.card, from: 'Queue', to: 'Review', points: 6 }],
    'job-phone': [{ kind: 'media', width: 390, height: 844, scheme: 'light', reduced: false }],
    'job-dark': [{ kind: 'media', width: 1200, height: 900, scheme: 'dark', reduced: false }],
    'job-motion': [{ kind: 'motion', phases: fixture.expected.phases, reduced: false }],
  }[fixture.kind] });
  for (const kind of kinds) {
    const fixture = createJobFixture(kind, { nonce: 'trial', seed: 'one' });
    const site = evidence(fixture);
    const input = { task: { worldFixture: kind }, site, expected: fixture.expected, answer: `RESULT: ${JSON.stringify(fixture.expected)}` };
    assert.equal(gradeJob(input).ok, true, kind);
    assert.equal(gradeJob({ ...input, answer: 'RESULT: {}' }).ok, false, kind);
    assert.equal(gradeJob({ ...input, expected: undefined }).ok, false, kind);
    assert.equal(gradeJob({ ...input, site: { ...site, views: [] } }).ok, false, kind);
    assert.equal(gradeJob({ ...input, site: { ...site, kind: 'other' } }).ok, false, kind);
    if (kind !== 'job-canvas') assert.equal(gradeJob({ ...input, site: { ...site, events: [] } }).ok, false, kind);
  }
  const fixture = createJobFixture('job-kanban', { nonce: 'trial', seed: 'one' });
  const site = evidence(fixture); site.events[0].points = 0;
  assert.equal(gradeJob({ task: { worldFixture: fixture.kind }, site, expected: fixture.expected, answer: JSON.stringify(fixture.expected) }).ok, false);
});

test('BF1 integrates its graders with the existing private descriptor contract', async () => {
  const { createJobFixture } = await load();
  const { gradeFixture } = await import('../bench/world/fowl-fixture-grade.mjs');
  const fixture = createJobFixture('job-canvas', { nonce: 'trial', seed: 'one' });
  const input = { task: { worldFixture: fixture.kind }, site: { kind: fixture.kind, views: [''], events: [] }, expected: fixture.expected,
    answer: `RESULT: ${JSON.stringify(fixture.expected)}` };
  assert.equal(gradeFixture(input).ok, true);
  assert.equal(gradeFixture({ ...input, answer: 'RESULT: {}' }).ok, false);
});

test('BF1 media graders require restoration after the requested phone or dark probe', async () => {
  const { createJobFixture, gradeJob } = await load();
  const initial = { kind: 'media', width: 1200, height: 900, scheme: 'light', reduced: false };
  for (const kind of ['job-phone', 'job-dark']) {
    const fixture = createJobFixture(kind, { nonce: 'trial', seed: 'one' });
    const probe = { ...initial, ...(kind === 'job-phone' ? { width: 390, height: 844 } : { scheme: 'dark' }) };
    const input = { task: { worldFixture: kind }, site: { kind, views: [''], events: [initial, probe] }, expected: fixture.expected, answer: JSON.stringify(fixture.expected) };
    assert.equal(gradeJob(input).ok, false, 'a probe without restoration must fail');
    assert.equal(gradeJob({ ...input, site: { ...input.site, events: [initial, probe, initial] } }).ok, true);
    assert.equal(gradeJob({ ...input, site: { ...input.site, events: [probe, initial] } }).ok, false, 'no known initial state');
  }
});

test('BF1 jobs use the existing matrix, log adapter and private answer descriptor without changing defaults', async t => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runFixtureClaims, fixtureOptions, fixtureHandler, fixtureTask } = await import('../bench/world/fowl-fixtures.mjs');
  const { createJobFixture } = await load();
  const dir = mkdtempSync(join(tmpdir(), 'bf1-jobs-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = fixtureOptions(['--kinds', kinds.join(','), '--arm', 'sleight-turbo,fowlbrowser', '--runs', '3', '--dry-run']);
  assert.deepEqual(options.kinds, kinds);
  const plan = await runFixtureClaims({ ...options, outRoot: join(dir, 'absent'), run: () => assert.fail('no live round'), serve: () => assert.fail('no server') });
  assert.equal(plan.rows.length, 30);
  assert.equal(existsSync(join(dir, 'absent')), false);
  let closed = 0;
  const result = await runFixtureClaims({ outRoot: dir, kinds: ['job-canvas'], arms: ['sleight-turbo'],
    serve: async fixture => {
      assert.match(fixtureTask(fixture, '', 'chrome').prompt, /six-digit routing/);
      assert.equal((await request(fixtureHandler(fixture), `/${fixture.nonce}/`)).code, 200);
      return () => { closed++; };
    }, run: async ({ args, fixture }) => {
      const task = JSON.parse(readFileSync(args[args.indexOf('--tasks') + 1]))[0];
      assert.equal(task.worldFixture, 'job-canvas');
      assert.ok(fixture.expected.code);
      throw Error('injected round failure');
    } });
  assert.equal(result.rows[0].code, 1);
  assert.equal(closed, 1);
});

test('BF1 jobs can plan the real Chrome or Helium race while leaving launch and setup to the existing gate', async t => {
  const { runFixtureClaims, fixtureOptions } = await import('../bench/world/fowl-fixtures.mjs');
  for (const realBrowser of ['chrome', 'helium']) {
    const options = fixtureOptions(['--kinds', kinds.join(','), '--arm', 'sleight-turbo,fowlbrowser', '--real-browser', realBrowser, '--dry-run']);
    assert.equal(options.realBrowser, realBrowser);
    const plan = await runFixtureClaims({ ...options, outRoot: '/private/tmp/bf1-real-plan', run: () => assert.fail('no live run'), serve: () => assert.fail('no server') });
    assert.equal(plan.rows.length, 10);
    for (const row of plan.rows) {
      assert.equal(row.args[row.args.indexOf('--real-browser') + 1], realBrowser);
      assert.equal(row.args[row.args.indexOf('--real-profile') + 1], realBrowser === 'chrome' ? 'benchmark' : 'fresh');
      assert.equal(row.browser, realBrowser);
    }
  }
  for (const options of [{ realBrowser: 'owner-chrome' }, { realBrowser: 'helium', realProfile: 'benchmark' }, { realProfile: 'benchmark' }, { realBrowser: 'chrome', swap: true }]) {
    await assert.rejects(runFixtureClaims({ ...options, kinds, arms: ['fowlbrowser'], dryRun: true }), /browser|profile|swap/i);
  }
});

test('BF1 gives each arm the same generated job data within a repetition', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runFixtureClaims } = await import('../bench/world/fowl-fixtures.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bf1-paired-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  await runFixtureClaims({ outRoot: dir, kinds: ['job-canvas', 'job-motion'], arms: ['sleight-turbo', 'fowlbrowser'], runs: 2,
    serve: async () => () => {}, run: async ({ fixture }) => { seen.push(structuredClone(fixture.expected)); return 0; } });
  for (const offset of [0, 4]) {
    assert.deepEqual(seen[offset], seen[offset + 2], 'canvas input must match across the two arms');
    assert.deepEqual(seen[offset + 1], seen[offset + 3], 'motion input must match across the two arms');
  }
});
