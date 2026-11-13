import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsRefusal, refusalLine, walkAncestors } from '../plugins/sleight/lib/person-gate.mjs';
import { settingsChangeRefusal } from '../plugins/sleight/lib/launch.mjs';
import { preapprovedWriteTarget, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const gateURL = new URL('../plugins/sleight/lib/person-gate.mjs', import.meta.url);
const gateSource = fs.readFileSync(gateURL, 'utf8');
const guardSource = fs.readFileSync(new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url), 'utf8');
const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
const launchSource = fs.readFileSync(launch, 'utf8');
const tty = { isTTY: true };
const options = { home: '/fixture', cwd: '/repo', platform: 'darwin', stat: async path => ({ realPath: path }) };
const check = (command, guard = preapprovedWriteTarget) => guard({ tool: 'Bash', command }, options);
const terminal = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';

// Inject the actual ancestor walker, including its tty/session checks. No host process is inspected here.
function ancestors(kind, age = '01:00') {
  const table = { 300: [200, '/bin/zsh'], 200: [100, 'login -pf fixture'], 100: [1, terminal] };
  if (kind === 'claude') table[200] = [100, '/opt/bin/claude'];
  if (kind === 'multiplexer') table[200] = [1, '/opt/bin/tmux'];
  return ({ freshMs = 10000 } = {}) => walkAncestors({ freshMs, platform: 'darwin', pid: kind === 'orphaned' ? 1 : 300, self: 400, home: '/fixture',
    ps: args => {
      if (args[1] === 'tty=') return 'ttys006';
      if (args[0] === '-t') return '200 Ss\n300 S+\n400 R+';
      if (args[1] === 'etime=') return age;
      const row = table[Number(args.at(-1))];
      if (!row) throw Error('missing fixture process');
      return `${row[0]} ${row[1].slice(0, 16)} ${row[1]}`;
    }, executable: pid => table[pid][1] });
}
const kinds = { terminal: undefined, claude: 'started under an agent', orphaned: 'not started from a terminal app',
  multiplexer: 'inside a terminal multiplexer' };
const forms = [['replay', 's.json'], ['record', 'session', 'out.json'], ['record', '--watch', 'com.example.App', 'out.json'],
  ['replay'], ['record'], ['replay', '--help'], ['record', '--help'], ['record', 'future-form']];
for (const family of ['replay', 'record']) for (const [age, fresh] of [['00:00', true], ['00:09', true], ['00:10', false], ['01:00', false]])
  test(`INT27G ${family} terminal session age ${age}`, async () => {
    let observed;
    const refusal = await settingsChangeRefusal([family, 's.json'], {
      gate: (argv, options) => {
        observed = options.freshMs;
        return settingsRefusal(argv, { ...options, stdin: tty, stdout: tty, env: {}, ancestors: ancestors('terminal', age) });
      },
      confirmation: { presence: () => { assert.equal(fresh, false); return true; },
        confirm: () => { assert.equal(fresh, false); return 'ok'; }, notice: () => {} },
    });
    assert.equal(observed, 10000, 'the launcher must pass the age bar to the real ancestor walk');
    assert.equal(refusal, fresh ? refusalLine(`${family} s.json`, 'fresh session') : undefined);
  });
for (const args of forms) for (const [kind, reason] of Object.entries(kinds))
  test(`SA1W process gate ${kind}: ${args.join(' ')}`, () => {
    const refusal = settingsRefusal(args, { stdin: tty, stdout: tty, env: {}, ancestors: ancestors(kind) });
    if (reason) assert.ok(refusal?.endsWith(`Reason: ${reason}.`), refusal);
    else assert.equal(refusal, undefined);
  });

test('SA1W launcher gate stays before conversion, relay startup and every dispatch', async () => {
  for (const family of ['record', 'replay']) {
    const args = [family, '/nonexistent/sa1w-input.json'];
    assert.match(await settingsChangeRefusal(args, {
      gate: argv => settingsRefusal(argv, { stdin: tty, stdout: tty, env: {}, ancestors: ancestors('claude') }),
      confirmation: { presence: () => assert.fail('no presence probe'), confirm: () => assert.fail('no sheet') },
    }), /Reason: started under an agent\.$/);
    // A real executable with pipes must stop before reading the deliberately nonexistent input.
    const run = spawnSync(process.execPath, [launch, ...args], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    assertChildStatus(run, 3, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, refusalLine(`${family} ${args[1]}`, 'no terminal') + '\n');
  }
});

test('SA1W no environment flag can turn a refusing walk into a person', () => {
  for (const env of [{}, { SLEIGHT_PERSON_GATE: '0', SLEIGHT_SHELL_GUARD: '0', SLEIGHT_SKIP_PERSON: '1' },
    { CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', TERM: 'xterm', TMUX: '', CI: '' }])
    for (const family of ['replay', 'record'])
      assert.match(settingsRefusal([family, 's.json'], { stdin: tty, stdout: tty, env, ancestors: ancestors('claude') }),
        /Reason: started under an agent\.$/);
});

test('SA1W executable gates replay before the separate Windows dispatcher too', () => {
  for (const family of ['replay', 'record']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === './windows-launch.mjs') throw Error('refused command reached the Windows dispatcher');
        return next(specifier, context);
      } });
      process.argv = [process.execPath, ${JSON.stringify(launch)}, ${JSON.stringify(family)}, 's.json'];
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await import(${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)});
    `], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    assertChildStatus(run, 3, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Reason: no terminal\./);
  }
});
test('SA1W broken variant caught: Windows dispatch precedes the gate', () => {
  const before = "process.platform === 'win32' && ['replay', 'record'].includes(process.argv[2])";
  assert.ok(launchSource.includes(before));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === './windows-launch.mjs') return { shortCircuit: true,
          url: 'data:text/javascript,export async function windowsCommand() { return 64; }' };
        return next(specifier, context);
      },
      load(url, context, next) {
        const result = next(url, context);
        if (url === ${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)})
          return { ...result, source: String(result.source).replace(${JSON.stringify(before)}, 'false') };
        return result;
      }
    });
    process.argv = [process.execPath, ${JSON.stringify(launch)}, 'replay', 's.json'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await import(${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)});
  `], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 64, run.stderr);
  assert.throws(() => assertChildStatus(run, 3, run.stderr), { code: 'ERR_ASSERTION' });
});

function replace(source, before, after) {
  assert.ok(source.includes(before), `mutation precondition: ${before}`);
  return source.replace(before, after);
}
async function gateMutant(family) {
  const source = replace(gateSource, `${family}: () => false,`, '')
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, gateURL).href}'`);
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).settingsRefusal;
}
for (const family of ['replay', 'record']) test(`SA1W broken variant caught: ${family} family omitted`, async () => {
  const gate = await gateMutant(family);
  assert.throws(() => assert.match(gate([family, 's.json'], { stdin: tty, stdout: tty, env: {}, ancestors: ancestors('claude') }),
    /Reason: started under an agent/), { code: 'ERR_ASSERTION' });
});

for (const family of ['replay', 'record']) test(`SA1W broken variant caught: ${family} omitted from executable dispatch gate`, () => {
  const declaration = /const SETTINGS_COMMANDS = \[[^\n]+;/.exec(launchSource)?.[0];
  assert.ok(declaration?.includes(`'${family}', `));
  const broken = replace(declaration, `'${family}', `, '');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url === ${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)})
        return { ...result, source: String(result.source).replace(${JSON.stringify(declaration)}, ${JSON.stringify(broken)}) };
      return result;
    } });
    process.argv = [process.execPath, ${JSON.stringify(launch)}, ${JSON.stringify(family)}, '/nonexistent/sa1w-input.json'];
    await import(${JSON.stringify(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).href)});
  `], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /Reason: no terminal/);
  assert.throws(() => assertChildStatus(run, 3, run.stderr), { code: 'ERR_ASSERTION' });
});

// Names built at runtime are outside literal text inspection. Feed their resolved argv to the same process gate.
const builtNames = [
  ['Perl dot join', `perl -e 'system("sl"."eight record")'`, 'record'],
  ['Perl comma list', `perl -e 'system("sl","eight","record")'`, 'record'],
  ['AppleScript ampersand', `osascript -e 'do shell script "sl" & "eight record"'`, 'record'],
  ['PHP dot join', `php -r 'system("sl"."eight record");'`, 'record'],
  ['Lua dot join', `lua -e 'os.execute("sl".."eight record")'`, 'record'],
  ['Python chr', `python3 -c 'import os; os.system(chr(115)+"leight replay s.json")'`, 'replay'],
  ['shell function', 'function f { sleight "$@"; }; f record', 'record'],
];
for (const [name, command, family] of builtNames) test(`SA1W process refuses text-unenforced ${name}`, async () => {
  assert.equal(await check(command), undefined, 'courtesy layer does not claim to enforce this spelling');
  assert.match(settingsRefusal([family, 's.json'], { stdin: tty, stdout: tty, env: {}, ancestors: ancestors('claude') }),
    /Reason: started under an agent\.$/);
});

const wrappers = [command => command, ...['env', 'exec', 'nohup', 'time', 'nice', 'command'].map(prefix => command => `${prefix} ${command}`),
  command => `env -i FLAG=1 ${command}`, command => `nice -n 20 ${command}`, command => `command -p ${command}`,
  command => `sh -c '${command.replaceAll("'", "'\\''")}'`];
const flags = ['-e', '+x', '-f', '-u', '+e', '-x', '-o pipefail', '+o pipefail', '-O extglob', '+O extglob',
  '--norc', '--noprofile', '-e --', '-e -u', '-o pipefail -e', '-e -o pipefail', '-e --norc'];
// 4 shells x 17 options x 11 wrappers x 2 commands = 1496, plus 102 nested and settings rows = 1598.
const rows = [];
for (const shell of ['bash', 'sh', 'zsh', 'dash']) for (const flag of flags) for (const wrap of wrappers)
  for (const action of ['record', 'replay s.json']) rows.push([wrap(`${shell} -c ${flag} 'sleight ${action}'`), PROTECTED.replay]);
for (const flag of flags) for (const command of [
  `bash -c ${flag} 'bash -c -e "sleight record"'`, `env bash -c ${flag} './sleight record'`,
  `nohup sh -c ${flag} 'sleight replay s.json'`, `zsh -c ${flag} 'sleight turbo on'`,
  `dash -c ${flag} 'sleight hand on'`, `bash 2>&1 -c ${flag} 'sleight record'`,
]) rows.push([command, /record|replay/.test(command) ? PROTECTED.replay : undefined]);
test('SA1W all 1598 option-after-c rows refuse, with replay reason when applicable', async () => {
  assert.equal(rows.length, 1598);
  for (const [command, reason] of rows) {
    const found = await check(command);
    assert.ok(found, command);
    if (reason) assert.equal(found, reason, command);
  }
});
test('SA1W source options refuse behind all 32 supported prefix families', async () => {
  const prefixes = ['env -i', 'sudo -n', 'timeout 2', 'nice -n 20', 'nohup', 'time -p', 'stdbuf -oL',
    'caffeinate -i', 'command -p', 'exec -a fixture', 'builtin', 'busybox', 'doas -n', 'xargs', 'arch -arm64',
    'taskpolicy -b', 'script -q /dev/null', 'chroot /fixture', 'setsid', 'unbuffer', 'noglob', 'nocorrect',
    'lockf /tmp/fixture-lock', 'sandbox-exec -p fixture', 'watch -x', 'reattach-to-user-namespace -l',
    'gtimeout 2', 'gnice -n 20', 'genv -i', 'gstdbuf -oL', 'gtime -p', 'gxargs'];
  assert.equal(prefixes.length, 32);
  for (const prefix of prefixes) for (const shell of ['bash', 'sh', 'zsh', 'dash']) for (const flag of flags)
    for (const action of ['record', 'replay s.json']) {
      const command = `${prefix} ${shell} -c ${flag} 'sleight ${action}'`;
      assert.ok(await check(command), command);
    }
});
for (const shell of ['bash', 'sh', 'zsh', 'dash']) test(`SA1W ${shell} source options preserve ordinary programs and exact reads`, async () => {
  for (const flag of flags) for (const source of ['node bench/replay/run.mjs', 'sleight hand status'])
    assert.equal(await check(`${shell} -c ${flag} '${source}'`), undefined, `${flag}: ${source}`);
  assert.ok(await check(`${shell} -c -e "$SCRIPT" record`), 'nonliteral source beside a protected command refuses');
});

const inlinePrograms = [
  ['node -p', `require("child_process").execSync("sleight record")`],
  ['node --print', `require("child_process").execSync("sleight record")`],
  ['php -r', `system("sleight record");`], ['php -R', `system("sleight record");`],
  ['php -F', 'sleight record'],
];
for (const [program, code] of inlinePrograms) test(`SA1W courtesy inline program ${program}`, async () => {
  for (const wrap of wrappers) assert.ok(await check(wrap(`${program} '${code}'`)), program);
  assert.equal(await check(`${program} 'print("record")'`), undefined, 'ordinary inline text remains data');
});

async function guardMutant(before, after) {
  return (await import('data:text/javascript;base64,' + Buffer.from(replace(guardSource, before, after)).toString('base64'))).preapprovedWriteTarget;
}

// Review commands are data for the courtesy classifier, never shell execution.
const clusterLayouts = ['-eo pipefail -c', '-euo pipefail -c', '-co pipefail', '-eco pipefail', '-cO extglob',
  '-c -eo pipefail', '-c -euo pipefail', '-c -eco pipefail', '-c +eo pipefail', '+eo pipefail -c',
  '+euo pipefail -c', '-c +euo pipefail', '-eO extglob -c', '-c -eO extglob'];
const clusterCases = [];
for (const shell of ['bash', 'sh', 'zsh', 'dash']) for (const layout of clusterLayouts)
  for (const action of ['record s.json', 'replay s.json'])
    clusterCases.push({ command: `${shell} ${layout} 'sleight ${action}'`, refuse: true });
const integrationFlags = [...flags, '-eo pipefail', '-euo pipefail', '-co pipefail', '-cO extglob', '-- -e'];
const optionCases = [];
for (const shell of ['bash', 'sh', 'zsh', 'dash']) for (const flag of integrationFlags) for (const wrap of wrappers)
  for (const action of ['record s.json', 'replay s.json', 'turbo on', 'hand on', 'permissions allow fixture.App'])
    optionCases.push({ command: wrap(`${shell} -c ${flag} 'sleight ${action}'`), refuse: flag !== '-- -e' });
async function bankVerdicts(cases, guard = preapprovedWriteTarget) {
  const misses = []; let refused = 0, allowed = 0;
  for (const { command, refuse } of cases) {
    const found = Boolean(await check(command, guard));
    if (found) refused++; else allowed++;
    if (found !== refuse) misses.push(command);
  }
  return { rows: cases.length, refused, allowed, misses };
}
test('INT27G 112 review cluster rows refuse', async t => {
  assert.equal(clusterCases.length, 112);
  const result = await bankVerdicts(clusterCases);
  assert.deepEqual(result.misses, []);
  assert.equal(result.refused, 112);
  t.diagnostic(JSON.stringify({ bank: 'clusters', rows: result.rows, refused: result.refused, allowed: result.allowed }));
});
test('INT27G 4840 option rows retain the non-executing -- -e controls', async t => {
  assert.equal(integrationFlags.length, 22); assert.equal(wrappers.length, 11); assert.equal(optionCases.length, 4840);
  const result = await bankVerdicts(optionCases);
  assert.deepEqual(result.misses, []);
  assert.equal(result.refused, 4620); assert.equal(result.allowed, 220);
  t.diagnostic(JSON.stringify({ bank: 'options', rows: result.rows, refused: result.refused, allowed: result.allowed }));
});
test('INT27G broken trailing-option parser fails both banks', async t => {
  const broken = await guardMutant('/^[+-][a-zA-Z]+[oO]$/.test(word)', 'false');
  const clusters = await bankVerdicts(clusterCases, broken), options = await bankVerdicts(optionCases, broken);
  assert.equal(clusters.misses.length, 112);
  assert.ok(options.misses.length > 0, 'the broad bank must detect the missing option-value consumption');
  t.diagnostic(JSON.stringify({ brokenClusterMisses: clusters.misses.length, brokenOptionMisses: options.misses.length }));
});
test('SA1W broken variant caught: option after c read as source', async () => {
  const guard = await guardMutant("if (word === '--') return source ? words[i + 1] ?? '' : null;",
    "if (source) return words[i]; if (word === '--') return null;");
  await assert.rejects(async () => assert.ok(await check("bash -c -e 'sleight record'", guard)), { code: 'ERR_ASSERTION' });
});
test('SA1W broken variant caught: o option value read as source', async () => {
  const guard = await guardMutant("['-o', '-O', '+o', '+O', '--rcfile', '--init-file'].includes(word)",
    "!source && ['-o', '-O', '+o', '+O', '--rcfile', '--init-file'].includes(word)");
  await assert.rejects(async () => assert.ok(await check("bash -c -o pipefail 'sleight record'", guard)), { code: 'ERR_ASSERTION' });
});
for (const [program, code] of inlinePrograms) test(`SA1W broken variant caught: missing inline flag ${program}`, async () => {
  const guard = await guardMutant('const INLINE_FLAG = /^-(?:[a-zA-Z]*[ceEprRF]|-eval|-print)(?:=|$)/;',
    'const INLINE_FLAG = /^-(?:[a-zA-Z]*[ceE]|-eval)(?:=|$)/;');
  await assert.rejects(async () => assert.ok(await check(`${program} '${code}'`, guard)), { code: 'ERR_ASSERTION' });
});

const traceSources = ['bench/plugin-arm-proof.mjs', 'bench/preapproved-live.mjs', 'bench/hand/h8-hidden-tab.mjs'];
function traceDirectory(t, file, mutate = false) {
  let source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const expression = file.includes('h8-') ? /mkdirSync\(plan.env.SLEIGHT_TRACE, \{[^\n]+\}\);/ : /mkdirSync\(trace, \{[^\n]+\}\);/;
  const statement = source.match(expression)?.[0];
  assert.ok(statement, file);
  source = mutate ? replace(statement, 'mode: 0o700', 'mode: 0o755') : statement;
  const bank = trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sa1w-trace-'))), trace = join(bank, 'trace');
  t.after(() => fs.rmSync(bank, { recursive: true, force: true }));
  Function('mkdirSync', 'trace', 'plan', source)((path, config) => {
    assert.equal(config.mode, 0o700, 'creation requests 0700 even under a restrictive umask');
    fs.mkdirSync(path, config);
  }, trace, { env: { SLEIGHT_TRACE: trace } });
  assert.equal(fs.statSync(trace).mode & 0o777, 0o700, file);
  const body = launchSource.slice(launchSource.indexOf('function traceTo('), launchSource.indexOf('// Asks about an app approval'))
    .replace('export function approvalLogging', 'function approvalLogging');
  const { default: ignored, ...filesystem } = fs;
  const messages = [];
  const bindings = { ...filesystem, join, homedir: () => bank, createGrantAudit: () => undefined,
    process: { pid: process.pid, getuid: () => process.getuid(), stderr: { write: line => messages.push(line) } } };
  const logging = Function(...Object.keys(bindings), body + '\nreturn approvalLogging;')(...Object.values(bindings));
  const writer = logging({ size: 0 }, { SLEIGHT_TRACE: trace }).trace;
  assert.equal(typeof writer, 'function');
  writer('sent', { sa1w: true });
  const path = join(trace, `trace-${process.pid}.jsonl`);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).msg.sa1w, true);
  assert.equal(messages.some(line => line.includes('disabled')), false);
}
for (const file of traceSources) {
  test(`SA1W private trace accepted: ${file}`, t => traceDirectory(t, file));
  test(`SA1W broken variant caught: public trace folder ${file}`, t => {
    assert.throws(() => traceDirectory(t, file, true), { code: 'ERR_ASSERTION' });
  });
}
