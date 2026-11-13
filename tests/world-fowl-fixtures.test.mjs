import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createBrowserFixture, browserKinds } from '../bench/world/browser-fixtures.mjs';

const load = async () => {
  const module = await import('../bench/world/fowl-fixtures.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(module, 'Fowl fixture adapter is absent');
  return module;
};

test('all seven local claims use the same fixture instructions for each direct browser arm', async () => {
  const { fixtureTask, FIXTURE_ARMS } = await load();
  for (const arm of FIXTURE_ARMS) for (const kind of browserKinds) {
    const fixture = createBrowserFixture(kind, { nonce: kind, seed: 'fixed' });
    const task = fixtureTask(fixture, '/tmp/fixture/upload.txt', 'chrome');
    assert.equal(task.name, kind);
    assert.equal(task.worldFixture, kind);
    assert.equal(task.budgetSeconds, 300);
    assert.match(task.prompt, /\{browser\}/);
    assert.match(task.site.log, /127\.0\.0\.1:5432/);
    assert.ok(!task.prompt.includes(JSON.stringify(fixture.expected)), 'answers stay out of the prompt');
    if (kind === 'file-upload') assert.match(task.prompt, /\/tmp\/fixture\/upload.txt/);
  }
  const suite = JSON.parse(readFileSync(new URL('../bench/world/suite.json', import.meta.url)));
  assert.deepEqual(Object.keys(suite.notRun), ['codex-cu', 'devtools']);
  assert.ok(suite.browser.filter(task => !browserKinds.includes(task.task)).every(task => task.support.codex === false));
  for (const task of suite.browser.filter(task => browserKinds.includes(task.task))) {
    assert.equal(task.support.codex, true);
    assert.equal(task.browserRunner, 'bench/world/fowl-fixtures.mjs');
    assert.equal(task.support['claude-in-chrome'], true);
    assert.equal(task.support['claude-cu'], true);
  }
});

test('Fowl fixture grade rejects missing reads, wrong pairs and absent posts despite correct answers', async () => {
  const { gradeFixture } = await load();
  for (const kind of browserKinds) {
    const fixture = createBrowserFixture(kind, { nonce: kind, seed: 'fixed' });
    const task = { worldFixture: kind };
    const answer = `Narration\nRESULT: ${JSON.stringify(fixture.expected)}`;
    assert.equal(gradeFixture({ task, site: fixture, expected: fixture.expected, answer }).ok, false);
    fixture.views = ['', 'second', 'record/2'];
    if (['file-upload', 'tab-switching', 'form-controls'].includes(kind)) {
      assert.equal(gradeFixture({ task, site: fixture, expected: fixture.expected, answer }).ok, false);
      fixture.posted = fixture.expected;
    }
    assert.deepEqual(gradeFixture({ task, site: fixture, expected: fixture.expected, answer }).problems, []);
    const wrong = { ...fixture, expected: { wrong: true } };
    assert.equal(gradeFixture({ task, site: wrong, expected: wrong.expected, answer }).ok, false);
    assert.equal(gradeFixture({ task, site: { error: 'offline' }, answer }).ok, false);
  }
  const fixture = createBrowserFixture('table-scrape', { nonce: 'table', seed: 'fixed' });
  fixture.views = [''];
  const answer = JSON.stringify({ rows: fixture.expected.rows.map((row, i, rows) => ({ ...row, hours: rows[(i + 1) % rows.length].hours })) });
  assert.equal(gradeFixture({ task: { worldFixture: 'table-scrape' }, site: fixture, expected: fixture.expected, answer }).ok, false);
});

test('fixture log reads do not count as agent page views and reject other hosts', async () => {
  const { fixtureHandler } = await load();
  const fixture = createBrowserFixture('local-mdn', { nonce: 'mdn', seed: 'fixed' });
  const handle = fixtureHandler(fixture);
  const get = async (url, host = '127.0.0.1:5432') => {
    const response = {};
    const res = { writeHead(code) { response.code = code; return this; }, end(body) { response.body = body; } };
    await handle({ url, method: 'GET', headers: { host } }, res);
    return response;
  };
  const log = JSON.parse((await get('/mdn/api/log')).body);
  assert.deepEqual(Object.keys(log).sort(), ['kind', 'views']);
  assert.equal(log.expected, undefined);
  assert.equal(log.token, undefined);
  assert.deepEqual(fixture.views, []);
  assert.equal((await get('/mdn/')).code, 200);
  assert.deepEqual(JSON.parse((await get('/mdn/api/log')).body).views, ['']);
  assert.equal((await get('/mdn/api/log', 'other:5432')).code, 404);
});

test('fixture dry-run builds 35 rows, no server or round or files, and names excluded bridges', async t => {
  const { runFixtureClaims } = await load();
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-fixture-test-')));
  t.after(() => removeTemp(root));
  const out = join(root, 'absent');
  const plan = await runFixtureClaims({ outRoot: out, runs: 5, arms: ['playwright-mcp'], dryRun: true,
    serve: () => { throw Error('server started'); }, run: () => { throw Error('round started'); } });
  assert.equal(plan.rows.length, 35);
  assert.equal(existsSync(out), false);
  assert.deepEqual(plan.notRun.map(row => row.arm), ['codex-cu', 'devtools']);
  for (const row of plan.rows) {
    assert.ok(row.args.includes('--world'));
    assert.equal(row.args[row.args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(row.args[row.args.indexOf('--effort') + 1], 'high');
  }
});

test('fixture rounds clean their owned server on failure and keep task records for grading', async t => {
  const { runFixtureClaims } = await load();
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-fixture-test-')));
  t.after(() => removeTemp(root));
  let closed = 0, calls = 0;
  const result = await runFixtureClaims({ outRoot: root, arms: ['browser-use'], kinds: ['file-upload', 'local-mdn'],
    serve: async () => () => { closed++; }, run: async ({ args, fixture }) => {
      assert.ok(fixture.expected);
      assert.equal(fixture.kind, calls === 0 ? 'file-upload' : 'local-mdn');
      calls++;
      const task = JSON.parse(readFileSync(args[args.indexOf('--tasks') + 1], 'utf8'))[0];
      assert.equal(task.worldFixture, task.name);
      assert.ok(task.site.log);
      if (calls === 1) throw Error('fake failure');
      return 0;
    } });
  assert.equal(calls, 2);
  assert.equal(closed, 2);
  assert.deepEqual(result.rows.map(row => row.code), [1, 0]);
});

test('both public CLI dry runs emit the complete matrix without touching the requested output', async t => {
  await load();
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-fixture-test-')));
  t.after(() => removeTemp(root));
  for (const [module, count] of [['../bench/world/fowl-fixtures.mjs', 315], ['../bench/fowl/handoff-runner.mjs', 45]]) {
    const out = join(root, 'absent');
    const result = spawnSync(process.execPath, [new URL(module, import.meta.url).pathname, '--dry-run', '--runs', '5',
      '--model', 'haiku', '--effort', 'high', '--out', out, ...(module.includes('handoff') ? ['--world'] : [])],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const plan = module.includes('handoff') ? result.stdout.trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(result.stdout).rows;
    assert.equal(plan.length, count);
    assert.equal(existsSync(out), false);
  }
});

test('coverage is persisted after each round, including interruption, and printed paths omit home', async t => {
  const { runFixtureClaims } = await load();
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-fixture-test-')));
  t.after(() => removeTemp(root));
  const stamp = 'checkpoint';
  let calls = 0;
  const result = await runFixtureClaims({ outRoot: root, stamp, arms: ['browser-use'], kinds: ['local-mdn'], runs: 2,
    serve: async () => () => {}, run: async () => {
      if (++calls === 1) throw Error(`fake failure at ${homedir()}/private`);
      const saved = JSON.parse(readFileSync(join(root, `fixture-coverage-${stamp}.json`)));
      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0].code, 1);
      assert.ok(!JSON.stringify(saved).includes(homedir()));
      return 130;
    } });
  assert.equal(calls, 2);
  assert.equal(result.rows[1].code, 130);
  assert.equal(JSON.parse(readFileSync(join(root, `fixture-coverage-${stamp}.json`))).rows.length, 2);
  const plan = await runFixtureClaims({ outRoot: join(homedir(), 'fixture-plan'), arms: ['browser-use'], kinds: ['local-mdn'], dryRun: true });
  assert.ok(!JSON.stringify(plan).includes(homedir()));
});

test('the grader reads its answer key from an inherited descriptor, outside the HTTP log', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-fixture-test-')));
  t.after(() => removeTemp(root));
  const fixture = createBrowserFixture('local-mdn', { nonce: 'private', seed: 'fixed' });
  const { fixtureGradeDescriptor } = await import('../bench/world/fowl-fixture-grade.mjs');
  const fd = fixtureGradeDescriptor(fixture);
  try {
    const result = spawnSync('/bin/sh', ['-c', 'exec /usr/bin/env -i "$@"', 'fixture-grade', process.execPath, '--input-type=module', '-e', `
      import { readFixtureExpected, gradeFixture } from './bench/world/fowl-fixture-grade.mjs';
      const task = { worldFixture: 'local-mdn' };
      const expected = readFixtureExpected(task);
      const site = { kind: 'local-mdn', views: [''] };
      if (!gradeFixture({ task, site, expected, answer: JSON.stringify(expected) }).ok) throw Error('private answer failed');
      if (gradeFixture({ task, site, expected, answer: '{}'}).ok) throw Error('wrong answer passed');
      if (readFixtureExpected({ worldFixture: 'file-upload' }) !== undefined) throw Error('mismatched key accepted');
    `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] });
    assert.equal(result.status, 0, result.stderr);
  } finally { closeSync(fd); }
});

test('an HTTP snapshot cannot supply the grader answer key', async () => {
  const { gradeFixture } = await load();
  const site = { kind: 'local-mdn', views: [''], expected: { code: 123 } };
  assert.equal(gradeFixture({ task: { worldFixture: 'local-mdn' }, site, answer: '{"code":123}' }).ok, false);
});
