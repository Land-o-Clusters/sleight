import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { runContainerChecks, runOwnedCommand } from '../scripts/linux-preflight.mjs';
import { preflight, main, createReviewedRunner, manifestFiles } from '../scripts/release-preflight.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const identity = { home: '/home/private-fixture', username: 'private-fixture' };
const tap = '# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const ok = stdout => ({ status: 0, stdout, collected: true });
const parserReceipt = JSON.stringify({ id: 'cell-parser', status: 'pass', version: '7.0.0' });

// A6 calls the real A5 checkout and receipt producer; replace only process execution.
function processBoundary(root, overrides = {}) {
  let runId;
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === process.execPath && args[0] === 'bench/results-hub.mjs') return ok('');
    if (command === process.execPath && args[0] === 'bench/compat/parser.mjs') return ok(parserReceipt);
    if (command === process.execPath && args[0] === 'scripts/release-history-scan.mjs') {
      return ok('Release history scan: 0 added line(s) contain private identity data.\n');
    }
    if (command === '/usr/bin/git') {
      if (args[0] === 'rev-parse') return ok(args[1] === '--show-toplevel' ? root : head);
      if (args[0] === 'ls-files') return ok('README.md\0');
      return ok('');
    }
    assert.equal(command, 'docker');
    if (args[0] === 'create') { runId = args[args.indexOf('--name') + 1]; return ok('d'.repeat(64)); }
    if (args[0] === 'inspect') return ok(`sha256:${'e'.repeat(64)}`);
    if (args[0] === 'start') {
      if (overrides.start) return overrides.start(options);
      const receipt = await runContainerChecks({ platform: 'linux', commit: head, runId,
        prepare() {}, makeConfig: () => '/container/config', removeConfig() {}, log() {},
        execute: async (command, args) => {
          if (command === '/usr/bin/git') return ok(args[0] === 'rev-parse' ? head : 'README.md\0');
          assert.equal(command, 'npm');
          assert.deepEqual(args, ['test'], 'release Linux leg must match public CI without installing packages');
          return ok(tap);
        } });
      return { ...ok(JSON.stringify(receipt)), status: receipt.exitCode };
    }
    if (args[0] === 'rm') return ok('removed');
    if (args[0] === 'container') return ok('');
    throw Error('Unexpected process boundary');
  };
  return { execute, calls };
}
function fixture(overrides = {}) {
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-release-contract-'))));
  class Files extends Map {
    set(file, text) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); return super.set(file, text); }
    delete(file) { rmSync(join(root, file), { force: true }); return super.delete(file); }
  }
  const files = new Files([
    ['README.md', '# sleight\nReady to install.\n'],
    ['CHANGELOG.md', '# Changelog\n\n## 1.4.1 (2026-10-21)\n\n- Fix release checks.\n\n## 1.4.0 (2026-10-20)\nOld notes.\n'],
    ...manifestFiles.map(file => [file, JSON.stringify(file.endsWith('marketplace.json')
      ? { name: 'sleight', plugins: [{ name: 'sleight', ...(file.startsWith('.agents/')
        ? { source: { source: 'local', path: './plugins/sleight' } } : { version: '1.4.1', source: './plugins/sleight' }) }] }
      : { name: 'sleight', version: '1.4.1' })]),
  ]);
  const boundary = processBoundary(root), reviewed = createReviewedRunner(root, { execute: boundary.execute });
  const calls = [];
  const runner = async request => {
    calls.push(request);
    if (overrides[request.step]) return overrides[request.step](request);
    if (request.step === 'linux') return reviewed(request);
    return { status: 0, stdout: { head, base, tag: head, status: '', sources: '', ancestor: '',
      'cell-parser': parserReceipt, history: 'Release history scan: 0 added line(s) contain private identity data.\n' }[request.step] };
  };
  files.set('private-terms.json', '["Private Fixture Name"]');
  const options = { root, mode: 'release', tag: 'v1.4.1', identity, runner, privateTerms: ['Private Fixture Name'],
    readFile: async path => readFileSync(path, 'utf8') };
  return { files, calls, options, boundary };
}
const steps = calls => calls.map(call => call.step);

test('repair regression: snapshot precedes every release input read', async () => {
  const { options, calls } = fixture();
  const readFile = options.readFile;
  await preflight({ ...options, readFile: path => {
    assert.deepEqual(steps(calls).slice(0, 2), ['status', 'head']);
    return readFile(path);
  } });
  assert.equal(calls[0]?.step, 'status');
});

test('repair regression: candidate permits an empty Unreleased heading above dated notes', async () => {
  const { options, files } = fixture();
  files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('# Changelog', '# Changelog\n\n## Unreleased'));
  assert.equal((await preflight({ ...options, mode: 'candidate', tag: undefined, version: '1.4.1' })).ok, true);
});

test('actual release checks all manifests, tag, history and Linux, then rechecks identity', async () => {
  const { options, calls } = fixture();
  const result = await preflight(options);
  assert.equal(result.ok, true);
  assert.equal(result.releaseReady, true);
  assert.equal(result.head, head);
  assert.deepEqual(steps(calls), ['status', 'head', 'status', 'head', 'tag', 'base', 'ancestor', 'sources', 'cell-parser', 'hub', 'history', 'linux', 'status', 'head', 'tag']);
  assert.equal(calls.find(c => c.step === 'history').range, `${base}..${head}`);
});

test('candidate check never queries or claims a tag and still requires Linux', async () => {
  const { options, calls } = fixture();
  const result = await preflight({ ...options, mode: 'candidate', tag: undefined, version: '1.4.1' });
  assert.equal(result.ok, true);
  assert.equal(result.releaseReady, false);
  assert.equal(result.mode, 'candidate');
  assert.equal(steps(calls).includes('tag'), false);
  assert.ok(steps(calls).includes('linux'));
});

test('parser incompatibility or an invalid receipt stops release before the hub and Linux', async () => {
  for (const response of [
    { status: 1, stdout: JSON.stringify({ id: 'cell-parser', status: 'fail' }) },
    { status: 0, stdout: JSON.stringify({ id: 'cell-parser', status: 'fail' }) },
    { status: 0, stdout: '{}' }, { status: 0, stdout: 'not JSON' },
  ]) {
    const { options, calls } = fixture({ 'cell-parser': () => response });
    const result = await preflight(options);
    assert.equal(result.ok, false);
    assert.equal(result.releaseReady, false);
    assert.equal(result.failures[0].check, 'cell-parser');
    assert.equal(steps(calls).at(-1), 'cell-parser');
    assert.equal(steps(calls).includes('linux'), false);
  }
});

test('every plugin manifest version is mandatory and must agree', async () => {
  for (const file of manifestFiles.filter(file => file.endsWith('/plugin.json'))) {
    for (const content of [{ name: 'sleight' }, { name: 'sleight', version: '1.4.0' }, null]) {
      const { files, calls, options } = fixture();
      files.set(file, JSON.stringify(content));
      assert.equal((await preflight(options)).ok, false, file);
      assert.deepEqual(steps(calls), ['status', 'head']);
    }
  }
});

test('marketplace version fields agree when present, with exactly one sleight entry', async () => {
  for (const file of manifestFiles.filter(file => file.endsWith('marketplace.json'))) {
    for (const content of [
      { version: '1.4.0', plugins: [{ name: 'sleight' }] },
      { metadata: { version: '1.4.0' }, plugins: [{ name: 'sleight' }] },
      { plugins: [{ name: 'sleight', version: '1.4.0' }] },
      { plugins: [] }, { plugins: [{ name: 'sleight' }, { name: 'sleight' }] },
    ]) {
      const { files, options, calls } = fixture();
      files.set(file, JSON.stringify(content));
      assert.equal((await preflight(options)).ok, false, JSON.stringify(content));
      assert.deepEqual(steps(calls), ['status', 'head']);
    }
    const { files, options } = fixture();
    files.set(file, JSON.stringify({ version: '1.4.1', metadata: { version: '1.4.1' }, plugins: [{ name: 'sleight', version: '1.4.1', source: file.startsWith('.agents/') ? { source: 'local', path: './plugins/sleight' } : './plugins/sleight' }] }));
    assert.equal((await preflight(options)).ok, true);
  }
});

test('missing, invalid, mismatched and unreleased release headings fail after snapshot', async () => {
  for (const text of ['', '## Unreleased\n\n## 1.4.1 (2026-10-21)', '## 1.4.0 (2026-10-21)',
    '## 1.4.1 (2026-02-30)', '## 1.4.1 (TBD)', '## 1.4.1 (2026-10-21)\n\n## 1.4.1 (2026-10-20)']) {
    const { files, options, calls } = fixture();
    files.set('CHANGELOG.md', text);
    assert.equal((await preflight(options)).ok, false, text);
    assert.deepEqual(steps(calls), ['status', 'head']);
  }
});

test('README and CHANGELOG placeholders fail, including comments and old release markers', async () => {
  for (const file of ['README.md', 'CHANGELOG.md']) {
    for (const marker of ['TODO(1.4.1-validation)', 'TBD', 'FIXME', 'CHANGEME', '<!-- GB14 pending -->',
      '<!-- GB12 -->', '<!-- cursor-row: pending -->', 'vX.Y.Z', '{{release_version}}', '[INSERT results]']) {
      const { files, options, calls } = fixture();
      files.set(file, files.get(file) + `\n${marker}\n`);
      const result = await preflight(options);
      assert.equal(result.ok, false, marker);
      assert.ok(result.failures.some(f => f.code === 'placeholder' && f.file === file));
      assert.deepEqual(steps(calls), ['status', 'head']);
    }
  }
});

test('notes reject private identity, home paths, emails, phones and supplied private terms without echoing them', async () => {
  for (const text of [identity.home, identity.username, ['', 'Users', 'some-person', 'doc'].join('/'), '/home/some-person/doc',
    'person@example.invalid', '+1 (212) 555-0199', 'Private Fixture Name']) {
    const { files, options, calls } = fixture();
    files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('- Fix release checks.', `- ${text}`));
    const result = await preflight({ ...options, privateTerms: ['Private Fixture Name'] });
    assert.equal(result.ok, false);
    const output = JSON.stringify(result);
    assert.ok(result.failures.some(f => f.code === 'private-notes' && f.file === 'CHANGELOG.md' && f.line === 5));
    assert.equal(output.includes(text), false);
    assert.deepEqual(steps(calls), ['status', 'head']);
  }
});

test('PII check covers only the notes for this release and allows public URLs and measured numbers', async () => {
  const { files, options } = fixture();
  files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('Old notes.', identity.home)
    .replace('- Fix release checks.', '- 11,073 tests, 242.3 s; https://example.invalid/releases/v1.4.1'));
  assert.equal((await preflight(options)).ok, true);
});

test('invalid modes, tags, refs and incomplete injection fail without commands or unsafe diagnostics', async () => {
  for (const extra of [ { tag: undefined }, { tag: '--all' }, { tag: 'v01.4.1' },
    { mode: 'candidate', tag: 'v1.4.1', version: '1.4.1' }, { mode: 'plan' },
    { historyBase: '--all' }, { historyBase: 'HEAD..HEAD' }, { historyBase: 'HEAD@{1}' },
    { runner: undefined }, { privateTerms: [''] }, { privateTerms: [] }]) {
    const { options, calls } = fixture();
    assert.equal((await preflight({ ...options, ...extra })).ok, false, JSON.stringify(extra));
    assert.deepEqual(calls, []);
  }
});

test('missing or malformed source files fail with fixed locations, never exception text', async () => {
  for (const file of ['README.md', 'CHANGELOG.md', ...manifestFiles]) {
    const { files, options, calls } = fixture();
    files.delete(file);
    const result = await preflight(options);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('private missing path'), false);
    assert.deepEqual(steps(calls), ['status', 'head']);
  }
  const { files, options } = fixture();
  files.set(manifestFiles[0], '{ private content');
  assert.equal(JSON.stringify(await preflight(options)).includes('private content'), false);
});

test('each command failure stops all subsequent execution and preserves its exit status', async () => {
  for (const step of ['status', 'head', 'tag', 'base', 'ancestor', 'sources', 'cell-parser', 'hub', 'history', 'linux']) {
    const { options, calls } = fixture({ [step]: () => ({ status: 17, stdout: identity.home, stderr: identity.username }) });
    const result = await preflight(options);
    assert.equal(result.ok, false, step);
    assert.equal(result.failures.at(-1).exitCode, 17);
    assert.equal(calls.at(-1).step, step);
    assert.equal(JSON.stringify(result).includes(identity.home), false);
    assert.equal(JSON.stringify(result).includes(identity.username), false);
  }
});

test('dirty tree, tag at another commit, malformed SHA and runner exceptions fail closed', async () => {
  for (const [step, response] of [['status', { status: 0, stdout: '?? private-file' }],
    ['tag', { status: 0, stdout: base }], ['head', { status: 0, stdout: 'not a hash' }],
    ['linux', { status: null, signal: 'SIGTERM' }], ['history', { status: 0, stdout: 'unexpected' }]]) {
    const { options, calls } = fixture({ [step]: () => response });
    assert.equal((await preflight(options)).ok, false);
    assert.equal(calls.at(-1).step, step);
  }
  const { options } = fixture({ history: () => { throw Error(identity.home); } });
  assert.equal(JSON.stringify(await preflight(options)).includes(identity.home), false);
});

test('history findings stop before Linux even if a broken scanner exits zero', async () => {
  const { options, calls } = fixture({ history: () => ({ status: 0,
    stdout: `${identity.home}:7 private\nRelease history scan: 1 added line(s) contain private identity data.\n` }) });
  assert.equal((await preflight(options)).ok, false);
  assert.equal(steps(calls).includes('linux'), false);
});

test('stale benchmark hub output fails with its own code, before history and Linux, and never echoes runner output', async () => {
  const { options, calls } = fixture({ hub: () => ({ status: 1, stdout: `would change ${identity.home}/docs/results/native-claim.md`, stderr: identity.username }) });
  const result = await preflight(options);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [{ check: 'hub', code: 'stale-output' }]);
  assert.equal(steps(calls).at(-1), 'hub');
  assert.equal(JSON.stringify(result).includes(identity.home), false);
  assert.equal(JSON.stringify(result).includes(identity.username), false);
});

test('a hub check that crashes or cannot run is a hub-error, never stale-output, and a runner that throws fails closed without exception text', async () => {
  for (const [hub, code] of [[() => ({ status: 1, stdout: '', stderr: `Error: boom at ${identity.home}` }), 'hub-error'],
    [() => ({ status: 2, stdout: 'would change README.md' }), 'hub-error'], [() => ({ status: null, signal: 'SIGTERM' }), 'hub-error'],
    [() => ({ status: 1 }), 'hub-error'], [() => { throw Error(identity.home); }, 'runner-error']]) {
    const { options, calls } = fixture({ hub });
    const result = await preflight(options);
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].check, 'hub');
    assert.equal(result.failures[0].code, code);
    assert.equal(steps(calls).includes('history'), false);
    assert.equal(JSON.stringify(result).includes(identity.home), false);
  }
});

test('the committed hub output is fresh, and a data file that moved on without its pages fails the same check', () => {
  const hub = new URL('../bench/results-hub.mjs', import.meta.url).pathname;
  const run = (...extra) => spawnSync(process.execPath, [hub, '--render-only', '--hub-only', '--check', ...extra], { encoding: 'utf8' });
  assert.equal(run().status, 0, run().stdout);
  const results = new URL('../docs/results', import.meta.url).pathname;
  const copy = mkdtempSync(join(tmpdir(), 'hub-stale-'));
  try {
    cpSync(results, copy, { recursive: true });
    assert.equal(run('--out', copy).status, 0);
    const file = join(copy, 'data/validation.json'), data = JSON.parse(readFileSync(file, 'utf8'));
    data.studies[0].cells[0].expected += 1;
    writeFileSync(file, JSON.stringify(data));
    const stale = run('--out', copy);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /would change data\/validation\.json/);
    assert.match(stale.stdout, /would change validation\.md/);
    // A crash is not a stale tree: no "would change" line, so the preflight reports it as hub-error.
    const empty = mkdtempSync(join(tmpdir(), 'hub-crash-'));
    try {
      const crashed = run('--out', empty);
      assert.equal(crashed.status, 1);
      assert.doesNotMatch(crashed.stdout, /^would change /m);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test('release hub collection rejects stale data even when every page matches that data, and hub-only preserves the root README', () => {
  const root = new URL('..', import.meta.url).pathname;
  const hub = join(root, 'bench/results-hub.mjs');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const out = mkdtempSync(join(tmpdir(), 'hub-collect-check-'));
  const run = (...args) => spawnSync(process.execPath, [hub, '--hub-only', '--out', out, ...args], { encoding: 'utf8' });
  try {
    cpSync(join(root, 'docs/results'), out, { recursive: true });
    const file = join(out, 'data/release-passes.json'), data = JSON.parse(readFileSync(file, 'utf8'));
    data.runs[0].seconds += 1;
    writeFileSync(file, JSON.stringify(data));
    assert.equal(run('--render-only').status, 0);
    assert.equal(run('--render-only', '--check').status, 0, 'render consistency alone accepts stale data');
    const checked = run('--check', '--wt', join(out, 'no-external-banks'));
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /would change data\/release-passes\.json/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), readme, 'temp output never rewrites the root README');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('Linux receipt must confirm Linux npm test success, not a plan or local Mac result', async () => {
  for (const receipt of [{}, { platform: 'darwin', command: ['npm', 'test'], exitCode: 0, executed: true },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 1, executed: true },
    { platform: 'linux', command: ['npm', 'test', '--ignore-scripts'], exitCode: 0, executed: true },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 0 },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 0, executed: false }]) {
    const { options, calls } = fixture({ linux: () => ({ status: 0, stdout: JSON.stringify(receipt) }) });
    assert.equal((await preflight(options)).ok, false, JSON.stringify(receipt));
    assert.equal(calls.at(-1).step, 'linux');
  }
});

test('tree, HEAD and tag are checked again after Linux to catch changes during execution', async () => {
  for (const step of ['status', 'head', 'tag']) {
    let count = 0;
    const changedAt = step === 'tag' ? 2 : 3;
    const { options, calls } = fixture({ [step]: () => ({ status: 0, stdout: ++count < changedAt
      ? (step === 'status' ? '' : head) : (step === 'status' ? ' M file' : base) }) });
    assert.equal((await preflight(options)).ok, false, step);
    assert.equal(count, changedAt);
    assert.equal(steps(calls).includes('linux'), true);
  }
});

test('CLI returns one nonzero result for any failure and refuses ambiguous or extra arguments', async () => {
  for (const args of [[], ['--tag', 'v1.4.1', '--candidate', '1.4.1'], ['--tag', 'v1.4.1', '--skip-linux'],
    ['--tag', 'v1.4.1', '--tag', 'v1.4.1']]) {
    const output = [];
    assert.equal(await main(args, { log: value => output.push(value) }), 1);
    assert.equal(JSON.parse(output[0]).ok, false);
  }
  const { options } = fixture();
  const output = [];
  const terms = ['--private-terms', join(options.root, 'private-terms.json')];
  assert.equal(await main(['--tag', 'v1.4.1', ...terms], { ...options, log: value => output.push(value) }), 0);
  assert.equal(JSON.parse(output[0]).releaseReady, true);
  assert.equal(await main(['--candidate', '1.4.1', ...terms], { ...options, log: () => {} }), 0);
  assert.equal(await main(['--candidate', '1.4.2', ...terms], { ...options, log: () => {} }), 1);
  for (const value of ['[]', 'null', '[""]', 'private malformed json']) {
    const { files, options: bad } = fixture();
    files.set('private-terms.json', value);
    const output = [];
    assert.equal(await main(['--tag', 'v1.4.1', ...terms], { ...bad, readFile: async path => path === terms[1] ? value : readFileSync(path, 'utf8'), log: value => output.push(value) }), 1);
    assert.equal(output.join('').includes('private malformed json'), false);
  }
});

test('reviewed runner rejects unknown or unsafe operations before processes', async () => {
  const calls = [];
  const runner = createReviewedRunner('/fixture', { execute: (...args) => { calls.push(args); } });
  await assert.rejects(runner({ step: 'push' }));
  await assert.rejects(runner({ step: 'tag', tag: '--all' }));
  await assert.rejects(runner({ step: 'history', range: 'HEAD..HEAD' }));
  await assert.rejects(runner({ step: 'linux', head: 'HEAD' }));
  assert.deepEqual(calls, []);
});

test('reviewed runner owns fixed Git/history argv and throwaway config cleanup', async () => {
  const calls = [];
  const runner = createReviewedRunner('/fixture', { execute: (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(existsSync(options.env.CLAUDE_CONFIG_DIR), true);
    return { status: 0, stdout: '' };
  } });
  for (const request of [{ step: 'status' }, { step: 'head' }, { step: 'tag', tag: 'v1.4.1' },
    { step: 'base', ref: 'origin/main' }, { step: 'ancestor', base, head }, { step: 'sources' }, { step: 'cell-parser' }, { step: 'hub' },
    { step: 'history', range: `${base}..${head}` }]) await runner(request);
  for (const { command, args, options } of calls) {
    assert.equal(options.cwd, '/fixture');
    assert.equal(options.shell, false);
    assert.equal(options.env.npm_config_offline, 'true');
    assert.equal(existsSync(options.env.CLAUDE_CONFIG_DIR), false);
    assert.ok(['/usr/bin/git', process.execPath].includes(command));
    assert.equal(args.includes('push'), false);
    assert.equal(args.includes('fetch'), false);
  }
  assert.deepEqual(calls.map(call => call.args), [
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['rev-parse', '--verify', 'refs/tags/v1.4.1^{commit}'],
    ['rev-parse', '--verify', 'origin/main^{commit}'],
    ['merge-base', '--is-ancestor', base, head],
    ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs', 'bench/results-hub.mjs', 'bench/compat/parser.mjs'],
    ['bench/compat/parser.mjs'],
    ['bench/results-hub.mjs', '--check'],
    ['scripts/release-history-scan.mjs', `${base}..${head}`],
  ]);
  assert.equal(new Set(calls.map(c => c.options.env.CLAUDE_CONFIG_DIR)).size, calls.length);
});

test('reviewed runner cleans its config when the executor throws', async () => {
  let config;
  const runner = createReviewedRunner('/fixture', { execute: (_command, _args, options) => {
    config = options.env.CLAUDE_CONFIG_DIR;
    throw Error('fixture executor failed');
  } });
  await assert.rejects(runner({ step: 'head' }));
  assert.equal(existsSync(config), false);
});

test('integrated A1 discovery rejects extra manifests, missing entry versions, escaping/mismatched sources and doctor failure', async () => {
  const changes = [
    files => files.set('plugins/extra/.claude-plugin/plugin.json', '{"name":"extra","version":"1.3.1"}'),
    files => files.set('.claude-plugin/marketplace.json', '{"plugins":[{"name":"sleight","source":"./plugins/sleight"}]}'),
    files => files.set('.cursor-plugin/marketplace.json', '{"plugins":[{"name":"sleight","source":"./plugins/sleight"}]}'),
    files => files.set('.agents/plugins/marketplace.json', '{"plugins":[{"name":"sleight","source":{"source":"local","path":"../escape"}}]}'),
    files => files.set('.agents/plugins/marketplace.json', '{"plugins":[{"name":"wrong","source":{"source":"local","path":"./plugins/sleight"}}]}'),
    files => files.set('plugins/sleight/.claude-plugin/plugin.json', '{"name":"sleight","version":"invalid"}'),
    files => files.set('support/.cursor-plugin/plugin.json', '{"name":"extra","version":"1.3.1"}'),
  ];
  for (const change of changes) {
    const { files, options, calls } = fixture(); change(files);
    const result = await preflight(options);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === 'release-version-inspection-failed'));
    assert.deepEqual(steps(calls), ['status', 'head']);
  }
});

test('commit switch during release input loading is caught before history or Linux', async () => {
  let current = head;
  const { options, calls } = fixture({ head: () => ok(current) });
  const readFile = options.readFile;
  const result = await preflight({ ...options, readFile: async path => {
    const text = await readFile(path); current = base; return text;
  } });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.code === 'changed-during-check'));
  assert.equal(steps(calls).includes('linux'), false);
  assert.equal(steps(calls).includes('history'), false);
});

test('CLI snapshot also precedes loading private release terms', async () => {
  const { options, calls } = fixture(), readFile = options.readFile, output = [];
  assert.equal(await main(['--candidate', '1.4.1', '--private-terms', join(options.root, 'private-terms.json')],
    { ...options, readFile: async path => {
      assert.deepEqual(steps(calls).slice(0, 2), ['status', 'head']); return readFile(path);
    }, log: text => output.push(text) }), 0);
  assert.equal(JSON.parse(output[0]).releaseReady, false);
});

test('candidate Unreleased notes receive the same privacy and placeholder checks', async () => {
  for (const text of ['Private Fixture Name', 'TODO']) {
    const { files, options } = fixture();
    files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('# Changelog', `# Changelog\n\n## Unreleased\n\n${text}`));
    assert.equal((await preflight({ ...options, mode: 'candidate', tag: undefined, version: '1.4.1' })).ok, false);
  }
});

test('candidate accepts versioned unreleased notes while tagged release still requires a date', async () => {
  const { files, options } = fixture();
  files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('1.4.1 (2026-10-21)', '1.4.1 (unreleased)'));
  const candidate = await preflight({ ...options, mode: 'candidate', tag: undefined, version: '1.4.1' });
  assert.equal(candidate.ok, true);
  assert.equal(candidate.releaseReady, false);
  assert.equal((await preflight(options)).ok, false);
});

test('reviewed Linux runner calls actual helper on this host and rejects wrong commit/tree or unconfirmed cleanup receipts', async () => {
  const { options, boundary } = fixture();
  const runner = createReviewedRunner(options.root, { execute: boundary.execute });
  const produced = await runner({ step: 'linux', head });
  assert.equal(produced.status, 0);
  const receipt = JSON.parse(produced.stdout);
  assert.equal(receipt.commit, head);
  assert.equal(receipt.counts.tests, 2);
  for (const mutate of [r => { r.commit = base; }, r => { r.worktree += '-other'; }, r => { r.cleanupConfirmed = false; },
    r => { r.childCollected = false; }, r => { r.counts.tests = 0; }, r => { r.executed = false; }]) {
    const changed = structuredClone(receipt); mutate(changed);
    const runner = async request => request.step === 'linux' ? ok(JSON.stringify(changed)) : options.runner(request);
    assert.equal((await preflight({ ...options, runner })).ok, false);
  }
});

test('actual A6 CLI connects its signal handler to the Linux owner and waits for cleanup', async () => {
  const { options } = fixture(), signals = new EventEmitter(), output = [];
  const boundary = processBoundary(options.root, { start: options => new Promise(resolveResult => {
    options.signal.addEventListener('abort', () => resolveResult({ status: null, collected: true }), { once: true });
    signals.emit('SIGINT');
  }) });
  const status = await main(['--candidate', '1.4.1', '--private-terms', join(options.root, 'private-terms.json')],
    { root: options.root, signals, execute: boundary.execute, log: text => output.push(text) });
  assert.equal(status, 1);
  assert.equal(JSON.parse(output[0]).releaseReady, false);
  assert.deepEqual(boundary.calls.filter(c => c.command === 'docker').slice(-2).map(c => c.args[0]), ['rm', 'container']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('successful A6 JSON keeps the host worktree and supplied private terms out of the result', async () => {
  const { options } = fixture();
  const result = await preflight(options);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(options.root), false);
  assert.equal(JSON.stringify(result).includes(options.privateTerms[0]), false);
});

test('A6 signal channel waits for actual helper cancellation and confirmed Docker cleanup', async () => {
  const { options } = fixture(), controller = new AbortController();
  const boundary = processBoundary(options.root, { start: options => new Promise(resolveResult => {
    options.signal.addEventListener('abort', () => resolveResult({ status: null, collected: true }), { once: true });
    controller.abort();
  }) });
  const runner = createReviewedRunner(options.root, { execute: boundary.execute, signal: controller.signal });
  const result = await runner({ step: 'linux', head });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).cleanupConfirmed, true);
  assert.deepEqual(boundary.calls.filter(c => c.command === 'docker').slice(-2).map(c => c.args[0]), ['rm', 'container']);
});

// Exercise the real A6, Colima and Linux APIs; only external command execution is replaced.
async function colimaFixture(t, overrides = {}) {
  const f = fixture(), root = f.options.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  f.files.delete('private-terms.json');
  const termsBank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'a6-colima-terms-'))));
  t.after(() => rmSync(termsBank, { recursive: true, force: true }));
  const terms = join(termsBank, 'terms.json'); writeFileSync(terms, '["Private Fixture Name"]');
  for (const name of ['release-history-scan', 'linux-preflight', ...(overrides.missingHelper ? [] : ['linux-preflight-colima'])]) {
    f.files.set(`scripts/${name}.mjs`, '// tracked fixture source\n');
  }
  f.files.set('bench/results-hub.mjs', '// tracked fixture source\n');
  f.files.set('bench/compat/parser.mjs', '// tracked fixture source\n');
  const env = { PATH: process.env.PATH, HOME: termsBank, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = async args => {
    const result = await runOwnedCommand('/usr/bin/git', args, { cwd: root, env });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '--quiet']); await git(['add', '--', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  const calls = [], banks = new Set(); let state, profile, checkout, runId, control;
  const execute = async (command, originalArgs, options = {}) => {
    calls.push({ command, args: originalArgs, options });
    if (command === '/usr/bin/git') {
      if (options.cwd.includes('sleight-linux-')) banks.add(trackTemp(options.cwd));
      return runOwnedCommand(command, originalArgs, options);
    }
    if (command === process.execPath) {
      if (originalArgs[0] === 'bench/results-hub.mjs') return ok('');
      if (originalArgs[0] === 'bench/compat/parser.mjs') return ok(parserReceipt);
      assert.equal(originalArgs[0], 'scripts/release-history-scan.mjs');
      return ok('Release history scan: 0 added line(s) contain private identity data.\n');
    }
    const args = command === 'docker' && originalArgs[0] === '--host' ? originalArgs.slice(2) : originalArgs;
    if (options.env?.COLIMA_HOME) { control = dirname(options.env.COLIMA_HOME); banks.add(trackTemp(control)); }
    if (command === 'colima') {
      if (args[0] === 'list') return ok(state ? JSON.stringify({ name: profile, status: state,
        arch: 'aarch64', cpus: 2, memory: 4294967296, disk: 10737418240, runtime: 'docker' }) : '');
      profile = args[args.indexOf('--profile') + 1];
      if (args[0] === 'start') {
        state = 'Running';
        for (const [directory, file] of [[join(options.env.COLIMA_HOME, profile), 'colima.yaml'],
          [join(options.env.LIMA_HOME, `colima-${profile}`), 'lima.yaml']]) {
          mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, file), 'owned config\n');
        }
        return ok('');
      }
      if (args[0] === 'stop') {
        if (overrides.stop) return overrides.stop(options, () => { state = 'Stopped'; return ok(''); });
        state = 'Stopped'; return ok('');
      }
      if (args[0] === 'delete') {
        state = undefined;
        rmSync(join(options.env.COLIMA_HOME, profile), { recursive: true, force: true });
        rmSync(join(options.env.LIMA_HOME, `colima-${profile}`), { recursive: true, force: true });
        return ok('');
      }
    }
    assert.equal(command, 'docker');
    const socket = `unix://${join(options.env.COLIMA_HOME, profile, 'docker.sock')}`;
    if (args[0] === 'context') return ok(JSON.stringify([{ Name: args[2], Endpoints: { docker: { Host: socket } } }]));
    assert.deepEqual(originalArgs.slice(0, 2), ['--host', socket]);
    if (args[0] === 'info') return ok('linux');
    if (args[0] === 'create') {
      assert.equal(args[args.indexOf('--workdir') + 1], '/');
      checkout = args[args.indexOf('--mount') + 1].match(/source=(.*),target=/)[1];
      runId = args[args.indexOf('--name') + 1]; return ok('d'.repeat(64));
    }
    if (args[0] === 'inspect') return ok(`sha256:${'e'.repeat(64)}`);
    if (args[0] === 'start') {
      if (overrides.attach) return overrides.attach(options);
      const receipt = await runContainerChecks({ platform: 'linux', commit, runId, source: checkout,
        root: join(termsBank, 'container-workspace'), log() {},
        makeConfig: () => mkdtempSync(join(termsBank, 'config-')),
        execute: async (program, argv, config) => {
          assert.equal(config.cwd, join(termsBank, 'container-workspace'));
          if (program === '/usr/bin/git') return runOwnedCommand(program, argv, config);
          assert.equal(program, 'npm');
          assert.deepEqual(argv, ['test'], 'Colima release leg must match public CI without installing packages');
          assert.equal(existsSync(join(config.cwd, 'node_modules')), false);
          return ok(tap);
        } });
      overrides.receipt?.(receipt); overrides.attached?.();
      return { ...ok(JSON.stringify(receipt)), status: receipt.exitCode };
    }
    if (args[0] === 'rm' || args[0] === 'container') return ok('');
    assert.fail('Unexpected external operation');
  };
  t.after(() => { for (const bank of banks) rmSync(bank, { recursive: true, force: true }); });
  return { root, terms, commit, calls, execute, control: () => control,
    args: ['--candidate', '1.4.1', '--history-base', 'HEAD', '--private-terms', terms, '--linux-runtime', 'colima'] };
}

test('Linux runtime validation precedes custom runners and source reads', async () => {
  assert.throws(() => createReviewedRunner('/fixture', { linuxRuntime: 'unknown' }));
  const f = fixture(); let invoked = false;
  const result = await preflight({ ...f.options, linuxRuntime: 'unknown', runner() { invoked = true; assert.fail('Invalid runtime'); } });
  assert.equal(result.ok, false); assert.equal(invoked, false);
  for (const runtime of ['unknown', 'Colima', 'colima\n']) {
    const output = [];
    assert.equal(await main(['--candidate', '1.4.1', '--private-terms', '/not-read', '--linux-runtime', runtime],
      { root: f.options.root, runner() { assert.fail('Invalid runtime must not invoke a runner'); }, log: text => output.push(text) }), 1);
    assert.equal(JSON.parse(output[0]).ok, false);
  }
});

test('explicit Docker runtime keeps the original fixed source gate and Docker route', async () => {
  const { options, boundary } = fixture();
  const runner = createReviewedRunner(options.root, { execute: boundary.execute, linuxRuntime: 'docker' });
  await runner({ step: 'sources' });
  assert.deepEqual(boundary.calls[0].args, ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs', 'bench/results-hub.mjs', 'bench/compat/parser.mjs']);
  assert.equal((await runner({ step: 'linux', head })).status, 0);
  assert.equal(boundary.calls.some(call => call.command === 'colima'), false);
});

test('A6 Colima CLI owns actual producers, requires tracked helper and rechecks final identity', async t => {
  const f = await colimaFixture(t), output = [];
  assert.equal(await main(f.args, { root: f.root, execute: f.execute, log: text => output.push(text) }), 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.ok, true); assert.equal(result.releaseReady, false); assert.equal(result.linux.commit, f.commit);
  assert.equal(output.join('').includes(f.root), false);
  const sources = f.calls.find(call => call.args[0] === 'ls-files' && call.args.includes('--error-unmatch'));
  assert.deepEqual(sources.args, ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs', 'bench/results-hub.mjs', 'bench/compat/parser.mjs', 'scripts/linux-preflight-colima.mjs']);
  assert.ok(f.calls.some(call => call.command === 'colima' && call.args[0] === 'delete'));
  assert.deepEqual(f.calls.slice(-2).map(call => call.args), [
    ['status', '--porcelain=v1', '--untracked-files=all'], ['rev-parse', '--verify', 'HEAD^{commit}'],
  ]);
  assert.equal(existsSync(f.control()), false);
});

test('Colima selection refuses an untracked helper before VM commands', async t => {
  const f = await colimaFixture(t, { missingHelper: true }), output = [];
  assert.equal(await main(f.args, { root: f.root, execute: f.execute, log: text => output.push(text) }), 1);
  assert.equal(f.calls.some(call => call.command === 'colima'), false);
  assert.equal(JSON.parse(output[0]).failures[0].check, 'sources');
});

test('Colima Linux success cannot pass failed or uncollected VM teardown', async t => {
  for (const stop of [() => ok(''), () => ({ status: null, stdout: '', collected: false })]) {
    const f = await colimaFixture(t, { stop }), output = [];
    assert.equal(await main(f.args, { root: f.root, execute: f.execute, log: text => output.push(text) }), 1);
    assert.equal(JSON.parse(readFileSync(join(f.control(), 'linux-receipt.json'))).exitCode, 0);
    assert.equal(JSON.parse(output[0]).ok, false);
    assert.equal(f.calls.some(call => call.command === 'colima' && call.args[0] === 'delete'), false);
  }
});

test('Colima composite deadline failure survives a passing Linux receipt and completed VM cleanup', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await colimaFixture(t, { attached() { now += 17 * 60_000; } }), output = [];
  assert.equal(await main(f.args, { root: f.root, execute: f.execute, log: text => output.push(text) }), 1);
  assert.equal(JSON.parse(readFileSync(join(f.control(), 'linux-receipt.json'))).exitCode, 0);
  assert.equal(JSON.parse(readFileSync(join(f.control(), 'vm-cleanup.json'))).cleanupConfirmed, true);
  assert.equal(JSON.parse(output[0]).ok, false);
});

test('Colima route rejects a mismatched actual container receipt', async t => {
  const f = await colimaFixture(t, { receipt(value) { value.commit = 'c'.repeat(40); } }), output = [];
  assert.equal(await main(f.args, { root: f.root, execute: f.execute, log: text => output.push(text) }), 1);
  assert.equal(JSON.parse(output[0]).ok, false);
});

test('A6 Colima cancellation waits for VM cleanup with one OS signal owner', async t => {
  const signals = new EventEmitter(); let release, entered;
  const stopped = new Promise(resolve => { entered = resolve; });
  const f = await colimaFixture(t, {
    attach(options) {
      assert.equal(signals.listenerCount('SIGINT'), 1);
      return new Promise(resolve => {
        options.signal.addEventListener('abort', () => resolve({ status: null, stdout: '', collected: true }), { once: true });
        signals.emit('SIGINT');
      });
    },
    stop(options, finish) {
      assert.equal(options.signal.aborted, false);
      entered(); return new Promise(resolve => { release = () => resolve(finish()); });
    },
  });
  let settled = false;
  const result = main(f.args, { root: f.root, execute: f.execute, signals, log() {} }).then(value => { settled = true; return value; });
  await stopped; await Promise.resolve(); assert.equal(settled, false);
  release(); assert.equal(await result, 1);
  assert.equal(JSON.parse(readFileSync(join(f.control(), 'vm-cleanup.json'))).cleanupConfirmed, true);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});
