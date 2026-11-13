import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preapprovedWriteTarget, preapprovedWriteReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const guardUrl = new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url);
const launchSource = fs.readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
const guardSource = fs.readFileSync(guardUrl, 'utf8');
const settings = '/fixture/Library/Application Support/sleight';
const options = { home: '/fixture', cwd: '/repo', platform: 'darwin', stat: async path => ({ realPath: path }) };
const check = (command, guard = preapprovedWriteTarget) => guard({ tool: 'Bash', command }, options);
function bank(t) {
  const dir = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sa1n-'))));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const word of ['replay', 'record', 'hand', 'turbo']) {
  test(`SA1N allows ordinary scripts with ${word} paths and arguments`, async () => {
    for (const command of [`node bench/${word}/run.mjs`, `bash bench/${word}/run.sh`, `node tools/${word}/x.mjs`,
      `sh -c "node bench/${word}/run.mjs"`, `node tools/run.mjs ${word}`, `bash tools/run.sh --output=/tmp/${word}/out`,
      `node '/tmp/a ${word}/run.mjs' '${word}'`, `node tools/run.mjs --label=${word}-example`])
      assert.equal(await check(command), undefined, command);
  });
  test(`SA1N still refuses the launcher's ${word} subcommand`, async () => {
    for (const program of ['sleight-mcp', '/repo/plugins/sleight/bin/sleight-mcp', '~/.local/bin/sleight',
      'node /repo/plugins/sleight/lib/launch.mjs', 'node /repo/plugins/sleight/bin/sleight-mcp']) {
      const command = `${program} ${word} on`;
      assert.ok(await check(command), command);
      assert.ok(await check(`sh -c '${command}'`), command);
    }
  });
}
test('SA1N refusal reason follows the launcher subcommand', async () => {
  for (const command of ['sleight-mcp turbo on --label record', 'sleight-mcp hand on /tmp/replay/out',
    'sh -c "sleight-mcp turbo on record"']) {
    const label = await check(command);
    assert.ok(label, command);
    assert.doesNotMatch(preapprovedWriteReason(label), /replay tool/, command);
  }
  for (const command of ['sleight-mcp replay s.json', 'sleight-mcp record',
    'sh -c "sleight-mcp record"', 'cat s.json | sleight-mcp replay -'])
    assert.match(preapprovedWriteReason(await check(command)), /replay tool/, command);
});

const linkForms = [
  ...['--link=always', '--sym', '--li', '--symbolic-link'].map(flag => `cp ${flag} '${settings}/permissions.json' /tmp/alias`),
  `pax -rw -l '${settings}/permissions.json' /tmp/copy`,
  `pax -rwl '${settings}/' /tmp/copy`,
  ...['-aL', '--copy-links', '--copy-li'].map(flag => `rsync ${flag} '${settings}/' /tmp/copy/`),
];
for (const command of linkForms) test(`SA1N refuses link-copy source ${command}`, async () => assert.ok(await check(command), command));
test('SA1N ordinary copy and link-looking operands remain allowed', async () => {
  for (const command of [`pax -rw '${settings}/permissions.json' /tmp/copy`,
    `pax -f /tmp/list '${settings}/permissions.json'`, `pax -rw -l /repo/a /tmp/copy`,
    `cp -- --sym /tmp/copy`, `rsync -- --copy-links /tmp/copy`, `pax -rw -- -l /tmp/copy`,
    `rsync -a '${settings}/' /tmp/copy/`]) assert.equal(await check(command), undefined, command);
});

// Load only production logging functions. No launcher, worker or app starts.
function loggingFactory(source = launchSource, overrides = {}) {
  const body = source.slice(source.indexOf('function traceTo('), source.indexOf('// Asks about an app approval'))
    .replace('export function approvalLogging', 'function approvalLogging');
  const { default: ignored, ...filesystem } = fs;
  const lines = [];
  const bindings = { ...filesystem, join, homedir: () => '/unused', createGrantAudit: () => undefined,
    process: { pid: process.pid, getuid: () => process.getuid(), stderr: { write: line => lines.push(line) } }, ...overrides };
  const logging = Function(...Object.keys(bindings), body + '\nreturn approvalLogging;')(...Object.values(bindings));
  return { start: dir => logging({ size: 0 }, { SLEIGHT_TRACE: dir }), lines };
}
function tightenedTrace(t, source = launchSource) {
  const root = bank(t), dir = join(root, 'Library', 'Logs', 'sleight');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const { start, lines } = loggingFactory(source, { homedir: () => root });
  const { trace } = start('1');
  assert.equal(typeof trace, 'function');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  trace('sent', { fixture: true });
  const file = join(dir, `trace-${process.pid}.jsonl`);
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).msg.fixture, true);
  assert.equal(lines.length, 1);
}
test('SA1N startup tightens the owned 0755 default trace directory and records', t => tightenedTrace(t));
function declinedTrace(t, kind, source = launchSource) {
  const root = bank(t), dir = join(root, 'Library', 'Logs', 'sleight');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const overrides = { homedir: () => root };
  let path = dir, changes = 0;
  if (kind === 'unowned') overrides.lstatSync = name => {
    const info = fs.lstatSync(name); info.uid = process.getuid() + 1; return info;
  };
  if (kind === 'symlink') {
    const target = join(root, 'trace'); fs.renameSync(dir, target); fs.symlinkSync(target, dir);
  }
  if (kind === 'chmod denied') overrides.fchmodSync = () => { changes++; throw Error('fixture chmod denied\nprivate detail'); };
  if (kind === 'existing file') fs.writeFileSync(join(dir, `trace-${process.pid}.jsonl`), 'unchanged', { mode: 0o600 });
  const { start, lines } = loggingFactory(source, overrides);
  let result;
  assert.doesNotThrow(() => { result = start(path); });
  assert.equal(result.trace, undefined);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split('\n').length, 2, 'one diagnostic line');
  assert.match(lines[0], /trac.*disabled|continuing without trac/i);
  if (kind === 'chmod denied') assert.equal(changes, 1);
  if (kind !== 'existing file') {
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
  } else assert.equal(fs.readFileSync(join(dir, `trace-${process.pid}.jsonl`), 'utf8'), 'unchanged');
}
for (const kind of ['unowned', 'symlink', 'chmod denied', 'existing file'])
  test(`SA1N startup continues untraced for ${kind}`, t => declinedTrace(t, kind));

function replace(source, before, after) {
  assert.ok(before instanceof RegExp ? before.test(source) : source.includes(before), `mutation precondition: ${before}`);
  if (before instanceof RegExp) before.lastIndex = 0;
  return source.replace(before, after);
}
async function mutantGuard(before, after) {
  const source = replace(guardSource, before, after);
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).preapprovedWriteTarget;
}
for (const word of ['replay', 'record', 'hand', 'turbo'])
  test(`SA1N broken variant caught: ordinary ${word} path refused`, async () => {
    const mutant = await mutantGuard('if (!segNamed && scriptWord && !scriptWord.operator) continue;', '');
    await assert.rejects(async () => assert.equal(await check(`node bench/${word}/run.mjs`, mutant), undefined), { code: 'ERR_ASSERTION' });
  });
test('SA1N broken variant caught: replay reason selected from an argument', async () => {
  const mutant = await mutantGuard('launcherRefusal === PROTECTED.replay', '/replay|record/.test(command)');
  await assert.rejects(async () => assert.doesNotMatch(preapprovedWriteReason(await check('sleight-mcp turbo on record', mutant)), /replay tool/),
    { code: 'ERR_ASSERTION' });
});
for (const [name, before, after, command] of [
  ['cp attached option', "['--link', '--symbolic-link'].some(option => longOption(arg, option))", "['--link', '--symbolic-link'].includes(arg)", linkForms[0]],
  ['cp abbreviated symbolic option', "['--link', '--symbolic-link'].some(option => longOption(arg, option))", "['--link', '--symbolic-link'].includes(arg)", linkForms[1]],
  ['cp abbreviated hard-link option', "['--link', '--symbolic-link'].some(option => longOption(arg, option))", "['--link', '--symbolic-link'].includes(arg)", linkForms[2]],
  ['pax link source', "if (links) files.slice(0, -1).forEach(path => add(path, false, true));", '', linkForms[4]],
  ['rsync short dereference option', "name === 'rsync' && 'HL'.includes(arg[at])", "name === 'rsync' && 'H'.includes(arg[at])", linkForms[6]],
  ['rsync long dereference option', "if (name === 'rsync' && longOption(arg, '--copy-links')) links = true;", '', linkForms[7]],
  ['rsync abbreviated dereference option', "longOption(arg, '--copy-links')", "arg === '--copy-links'", linkForms[8]],
]) test(`SA1N broken variant caught: ${name}`, async () => {
  const mutant = await mutantGuard(before, after);
  await assert.rejects(async () => assert.ok(await check(command, mutant)), { code: 'ERR_ASSERTION' });
});
test('SA1N broken variant caught: owned directory not tightened', t => {
  const mutant = replace(launchSource, 'fchmodSync(directoryFd, 0o700)', 'undefined');
  assert.throws(() => tightenedTrace(t, mutant), { code: 'ERR_ASSERTION' });
});
test('SA1N broken variant caught: unowned trace directory admitted', t => {
  const mutant = replace(launchSource, 'directory.uid !== process.getuid()', 'false');
  assert.throws(() => declinedTrace(t, 'unowned', mutant), { code: 'ERR_ASSERTION' });
});
test('SA1N broken variant caught: trace directory symlink followed', t => {
  const mutant = replace(launchSource, 'const directory = lstatSync(dir);', 'const directory = statSync(dir);')
    .replace('constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK', 'constants.O_RDONLY | constants.O_NONBLOCK')
    .replace('current = lstatSync(dir)', 'current = statSync(dir)');
  assert.throws(() => declinedTrace(t, 'symlink', mutant), { code: 'ERR_ASSERTION' });
});
for (const kind of ['unowned', 'symlink', 'chmod denied', 'existing file'])
  test(`SA1N broken variant caught: ${kind} aborts startup`, t => {
    const mutant = replace(launchSource, "catch { process.stderr.write('sleight: tracing disabled; continuing without tracing.\\n'); }", 'catch (error) { throw error; }');
    assert.throws(() => declinedTrace(t, kind, mutant), { code: 'ERR_ASSERTION' });
  });
