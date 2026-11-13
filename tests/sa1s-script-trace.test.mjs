import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preapprovedWriteTarget, preapprovedWriteReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const guardSource = fs.readFileSync(new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url), 'utf8');
const launchSource = fs.readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
const settings = '/fixture/Library/Application Support/sleight';
const options = { home: '/fixture', cwd: '/repo', platform: 'darwin', stat: async path => ({ realPath: path }) };
const check = (command, guard = preapprovedWriteTarget) => guard({ tool: 'Bash', command }, options);

// Commands are parser input only. No shell, launcher, app or copy command executes.
const scriptCommands = [
  'bash sleight turbo on', 'sh sleight hand on', 'bash sleight permissions block x',
  'bash sleight menu', 'bash sleight link', 'bash sleight replay s.json', 'sh sleight record',
  'cd ~/.local/bin && bash sleight turbo on', 'cd ~/.local/bin && sh sleight hand on',
  'cd ~ && bash .local/bin/sleight turbo on', 'cd ~/.local && sh bin/sleight permissions block site',
  'bash ../bin/sleight hand on', 'bash .local/bin/sleight record', 'bash bin/sleight-mcp replay s.json',
  'bash /bin/sleight-mcp record', 'bash <(cat sleight) turbo on',
];
const wrappers = [command => command, ...['env', 'exec', 'nohup', 'time', 'nice', 'command'].map(word => command => `${word} ${command}`),
  command => `if true; then ${command}; fi`, command => `sh -c "${command}"`];
for (const command of scriptCommands) for (const wrap of wrappers) {
  const input = wrap(command);
  test(`SA1S refuses script launcher: ${input}`, async () => assert.ok(await check(input), input));
}
for (const program of ['sh', 'bash', 'zsh', 'python3', 'node', 'ruby', 'perl', 'swift', 'deno', 'bun']) {
  for (const script of ['sleight', 'sleight-mcp', 'launch.mjs', '.sleight-shim-v1', '../bin/sleight', '.local/bin/sleight']) {
    const command = `${program} ${script} replay s.json`;
    test(`SA1S refuses interpreter launcher: ${command}`, async () => assert.ok(await check(command), command));
  }
}
for (const script of ['$SCRIPT', '${SCRIPT}', '$(cat launcher)', '`cat launcher`', '<(cat launcher)', '"$SCRIPT"', 'sl*ight', 'slei?ht']) {
  const command = `bash ${script} record`;
  test(`SA1S refuses nonliteral script: ${command}`, async () => assert.ok(await check(command), command));
}
for (const command of ['bash script.sh replay', 'bash script.sh record', 'node bench/replay/run.mjs',
  'bash bench/replay/run.sh', 'node tools/record/x.mjs', 'sh -c "node bench/replay/run.mjs"',
  'node tools/run.mjs hand', 'node x.mjs turbo on', 'bash /tmp/sleight-work/run.sh record',
  "bash '/tmp/a replay/run.sh' record", 'bash script.sh --label=sleight'])
  test(`SA1S allows ordinary script: ${command}`, async () => assert.equal(await check(command), undefined, command));
test('SA1S interpreter replay and record refusals name the replay tool', async () => {
  for (const command of ['bash sleight replay s.json', 'sh sleight record', 'env bash sleight replay s.json',
    'sh -c "bash sleight record"', 'python3 ../bin/sleight replay s.json'])
    assert.match(preapprovedWriteReason(await check(command)), /replay tool/, command);
});

const cpioCommands = [
  ...['-pdl', '-pl', '-p -d -l', '--pass-through --link', '--link --pass-through', '-lp', '-p --link']
    .map(flags => `printf '%s\\n' '${settings}/permissions.json' | cpio ${flags} /tmp/copy`),
  `echo '${settings}/permissions.json' | command cpio -pdl /tmp/copy`,
  `find '${settings}/routines' -type f | cpio -pdl /tmp/copy`,
  `cd '${settings}' && printf '%s\\n' permissions.json | cpio -pdl /tmp/copy`,
];
for (const command of cpioCommands)
  test(`SA1S refuses cpio protected link source: ${command}`, async () => assert.ok(await check(command), command));
for (const command of [`printf '%s\\n' '${settings}/permissions.json' | cpio -pd /tmp/copy`,
  `printf '%s\\n' '${settings}/permissions.json' | cpio -it`,
  "printf '%s\\n' /repo/source | cpio -pdl /tmp/copy",
  `printf '%s\\n' '${settings}/permissions.json' | cpio -- -pdl /tmp/copy`,
  `printf '%s\\n' '${settings}/permissions.json' | cpio -p -R nobody:people /tmp/copy`,
  `printf '%s\\n' '${settings}/permissions.json' | cpio -p -F -l /tmp/copy`,
  `printf '%s\\n' '${settings}/permissions.json' | cpio -p --file -l /tmp/copy`])
  test(`SA1S allows ordinary cpio: ${command}`, async () => assert.equal(await check(command), undefined, command));

function bank(t) {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sa1s-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function loggingFactory(root, source = launchSource, overrides = {}) {
  const body = source.slice(source.indexOf('function traceTo('), source.indexOf('// Asks about an app approval'))
    .replace('export function approvalLogging', 'function approvalLogging');
  const { default: ignored, ...filesystem } = fs;
  const lines = [];
  const bindings = { ...filesystem, join, homedir: () => root, createGrantAudit: () => undefined,
    process: { pid: process.pid, getuid: () => process.getuid(), stderr: { write: line => lines.push(line) } }, ...overrides };
  const logging = Function(...Object.keys(bindings), body + '\nreturn approvalLogging;')(...Object.values(bindings));
  return { start: setting => logging({ size: 0 }, { SLEIGHT_TRACE: setting }), lines };
}
function customTrace(t, mode, source = launchSource) {
  const root = bank(t), dir = join(root, 'custom');
  fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode);
  let changes = 0;
  const { start, lines } = loggingFactory(root, source, { fchmodSync: (...args) => { changes++; fs.fchmodSync(...args); } });
  const { trace } = start(dir);
  assert.equal(changes, 0, 'custom directory mode must never change');
  assert.equal(fs.lstatSync(dir).mode & 0o777, mode);
  if (mode === 0o700) {
    assert.equal(typeof trace, 'function');
    trace('sent', { fixture: true });
    assert.equal(fs.lstatSync(join(dir, `trace-${process.pid}.jsonl`)).mode & 0o777, 0o600);
  } else {
    assert.equal(trace, undefined);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(lines, ['sleight: tracing disabled; continuing without tracing.\n']);
  }
}
for (const mode of [0o700, 0o755, 0o750, 0o777])
  test(`SA1S custom trace mode ${mode.toString(8)} is preserved`, t => customTrace(t, mode));
function defaultTrace(t, explicit, source = launchSource) {
  const root = bank(t), dir = join(root, 'Library', 'Logs', 'sleight');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const { start } = loggingFactory(root, source);
  const { trace } = start(explicit ? dir : '1');
  assert.equal(typeof trace, 'function');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
}
for (const explicit of [false, true])
  test(`SA1S default trace directory tightens, explicit=${explicit}`, t => defaultTrace(t, explicit));
test('SA1S creates a missing custom trace directory at 0700', t => {
  const root = bank(t), dir = join(root, 'new');
  assert.equal(typeof loggingFactory(root).start(dir).trace, 'function');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
});

function replace(source, before, after) {
  assert.ok(before instanceof RegExp ? before.test(source) : source.includes(before), `mutation precondition: ${before}`);
  if (before instanceof RegExp) before.lastIndex = 0;
  return source.replace(before, after);
}
async function mutantGuard(before, after) {
  const source = replace(guardSource, before, after);
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).preapprovedWriteTarget;
}
const guardMutants = [
  ['unchecked script exemption', 'if (!segNamed && scriptWord && !scriptWord.operator) continue;',
    'if (scriptWord && !scriptWord.operator) continue;', 'bash sleight turbo on'],
  ['launcher script basename omitted', "if (segment.some((word, at) => at !== codeAt && !word.operator && launcher(word.text.split('/').at(-1)))) return true;", '', 'bash sleight turbo on'],
  ['launcher basename compared as whole path', "launcher(word.text.split('/').at(-1))", 'launcher(word.text)',
    'bash ../bin/sleight hand on'],
  ['process substitution treated as a script', "if (segment.some((word, at) => word.operator && /^[<>]$/.test(word.text) && segment[at + 1]?.text === '(')) return true;",
    '', 'bash <(cat launcher) turbo on'],
  ['cpio source checks omitted', 'if (passThrough && links && piped)', 'if (false)', cpioCommands[0]],
  ['cpio short link flag omitted', "links ||= arg[flag] === 'l'", 'links ||= false', cpioCommands[0]],
  ['cpio short pass flag omitted', "passThrough ||= arg[flag] === 'p'", 'passThrough ||= false', cpioCommands[0]],
  ['cpio long link flag omitted', "if (longOption(arg, '--link')) links = true;", '', cpioCommands[3]],
  ['cpio long pass flag omitted', "if (longOption(arg, '--pass-through')) passThrough = true;", '', cpioCommands[3]],
  ['interpreter replay reason omitted', /      if \(SHELLS\.has\(segment\[index\][^\n]*\n        launchAt = segment\.findIndex[^\n]*\n/, '', null],
];
for (const [name, before, after, command] of guardMutants)
  test(`SA1S broken variant caught: ${name}`, async () => {
    const mutant = await mutantGuard(before, after);
    if (command) await assert.rejects(async () => assert.ok(await check(command, mutant), command), { code: 'ERR_ASSERTION' });
    else await assert.rejects(async () => assert.match(preapprovedWriteReason(await check('bash sleight replay s.json', mutant)), /replay tool/),
      { code: 'ERR_ASSERTION' });
  });
for (const [name, before, after, command] of [
  ['cpio ordinary copies treated as links', 'if (passThrough && links && piped)', 'if (piped)',
    `printf '%s\\n' '${settings}/permissions.json' | cpio -pd /tmp/copy`],
  ['cpio short option value treated as flags', "'CDFHILOR'.includes(arg[flag])", 'false',
    `printf '%s\\n' '${settings}/permissions.json' | cpio -p -F -l /tmp/copy`],
  ['cpio long option value treated as flags', "longOption(arg, option) && !arg.includes('=')", 'false',
    `printf '%s\\n' '${settings}/permissions.json' | cpio -p --file -l /tmp/copy`],
  ['cpio options parsed past terminator', /const arg = texts\[at\];\n        if \(arg === '--'\) break;\n        if \(longOption\(arg, '--pass-through'\)\)/,
    "const arg = texts[at];\n        if (longOption(arg, '--pass-through'))",
    `printf '%s\\n' '${settings}/permissions.json' | cpio -- -pdl /tmp/copy`],
]) test(`SA1S broken variant caught: ${name}`, async () => {
  const mutant = await mutantGuard(before, after);
  await assert.rejects(async () => assert.equal(await check(command, mutant), undefined, command), { code: 'ERR_ASSERTION' });
});
test('SA1S broken variant caught: custom directory chmod allowed', t => {
  const mutant = replace(launchSource, "if (dir !== defaultDir) throw Error('Unsafe trace directory');", '');
  assert.throws(() => customTrace(t, 0o755, mutant), { code: 'ERR_ASSERTION' });
});
test('SA1S broken variant caught: custom directory validation silently omitted', t => {
  const mutant = replace(launchSource, "if (dir !== defaultDir) throw Error('Unsafe trace directory');", 'if (dir === defaultDir)')
    .replace('(tightened.mode & 0o777) !== 0o700', 'false');
  assert.throws(() => customTrace(t, 0o755, mutant), { code: 'ERR_ASSERTION' });
});
test('SA1S broken variant caught: explicit default path treated as custom', t => {
  const mutant = replace(launchSource, "if (dir !== defaultDir)", "if (setting !== '1')");
  assert.throws(() => defaultTrace(t, true, mutant), { code: 'ERR_ASSERTION' });
});
