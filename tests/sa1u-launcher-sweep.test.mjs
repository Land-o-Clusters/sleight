import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preapprovedWriteTarget, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const guardSource = fs.readFileSync(new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url), 'utf8');
const benchSource = fs.readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8');
const launchSource = fs.readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
const options = { home: '/fixture', cwd: '/repo', platform: 'darwin', stat: async path => ({ realPath: path }) };
const check = (command, guard = preapprovedWriteTarget) => guard({ tool: 'Bash', command }, options);
const names = ['sleight', 'sleight-mcp', 'launch.mjs', '.sleight-shim-v1'];
const paths = ['', './', '../bin/', '.local/bin/', '/opt/bin/', '~/.local/bin/'];
const cases = [word => word, word => word.toUpperCase(), word => word[0].toUpperCase() + word.slice(1),
  word => [...word].map((c, i) => i % 2 ? c.toUpperCase() : c).join('')];
const wrappers = [
  command => command, ...['env', 'exec', 'nohup', 'time', 'nice', 'command'].map(prefix => command => `${prefix} ${command}`),
  command => `env -i FLAG=1 ${command}`, command => `nice -n 20 ${command}`, command => `command -p ${command}`,
  command => `sh -c '${command}'`,
];
const actions = ['replay s.json', 'record', 'turbo on', 'hand on', 'permissions block x', 'menu', 'link', 'unlink',
  'cursor style ring', 'cursor import /tmp/pet', 'permissions revoke x', 'permissions unblock x'];
const flags = ['', '+x', '+e', '+o pipefail', '+O extglob', '-e', '2>&1', '2>/dev/null'];

for (const command of ['bash +x sleight replay s.json', 'sh +x sleight record', 'bash +o pipefail sleight turbo on',
  'bash 2>&1 sleight turbo on', 'bash 2>/dev/null ./sleight record', 'bash ./sleight<&- turbo on',
  'env bash +x sleight turbo on', 'bash +x ../bin/sleight turbo on', 'SLEIGHT turbo on',
  '~/.local/bin/Sleight replay s.json', 'bash script.sh sleight replay', 'sh -c "echo replay" sleight',
  'sh -c "echo replay" < sleight', 'bash +x -c "sleight record"', 'bash 2>&1 -c "sleight turbo on"',
  'env bash +o pipefail -c "../bin/Sleight replay s.json"'])
  test(`SA1U exact review refusal ${command}`, async () => assert.ok(await check(command), command));
test('SA1U interpreter replay reason survives options, case and fd redirections', async () => {
  for (const command of ['bash +x sleight replay s.json', 'sh +x sleight record',
    'bash 2>/dev/null ./sleight record', 'bash ./sleight<&- replay s.json', 'bash 2>&1 -c "Sleight record"'])
    assert.equal(await check(command), PROTECTED.replay, command);
});

// 384 generated shapes expand across 11 wrappers and 24 launcher spellings. Payloads are strings only.
for (const shell of ['bash', 'sh', 'zsh', 'dash']) for (const flag of flags) for (const action of actions) {
  test(`SA1U sweep ${shell} ${flag} LAUNCHER ${action}`, async t => {
    let rows = 0;
    for (const [n, name] of names.entries()) for (const [p, path] of paths.entries()) for (const wrap of wrappers) {
      const spelling = path + cases[(n + p) % cases.length](name);
      const command = wrap(`${shell} ${flag} ${spelling} ${action}`);
      assert.ok(await check(command), command);
      rows++;
    }
    t.diagnostic(`${rows} launcher rows refused`);
  });
}

const extraShapes = [
  name => `bash ./${name}<&- turbo on`, name => `bash 2>/dev/null ./${name} record`,
  name => `bash script.sh replay ${name}`, name => `bash script.sh ${name} turbo on`,
  name => `bash script.sh record < ${name}`, name => `sh /dev/stdin turbo on < ${name}`,
  name => `cd ~/.local/bin && bash ${name} turbo on`, name => `if true; then bash ${name} record; fi`,
  name => `for i in 1; do sh ${name} record; done`, name => `while false; do sh ${name} record; done`,
  name => `( bash ${name} record )`, name => `{ bash ${name} record; }`,
  name => `bash ${name} record && true`, name => `bash ${name} record &`,
  name => `bash ${name} record | cat`, name => `bash ${name} record > /tmp/out`,
  name => `env -u FLAG bash ${name} record`, name => `time -p bash ${name} record`,
  name => `sudo bash ${name} record`, name => `timeout 2 bash ${name} record`,
  name => `caffeinate bash ${name} record`, name => `xargs bash ${name} record`,
  name => `find . -exec bash ${name} record \\;`, name => `source ${name} record`,
  name => `. ${name} record`, name => `eval 'bash ${name} record'`,
  name => `cat ${name} | sh -s record`, name => `bash -s record < ${name}`,
  name => `sh <<'EOF'\nbash ${name} record\nEOF`, name => `sh <<< 'bash ${name} record'`,
  name => `bash\t${name}\trecord`, name => `bash \\\n${name} record`,
  name => `sh -c 'sh -c "bash ${name} record"'`,
];
for (const [at, shape] of extraShapes.entries()) test(`SA1U review syntax ${at}`, async () => {
  for (const name of names) for (const path of paths) assert.ok(await check(shape(path + name)), shape(path + name));
});
for (const name of names) test(`SA1U direct and interpreter case forms ${name}`, async () => {
  for (const path of paths) for (const fold of cases) for (const program of ['', 'node --no-warnings ', 'python3 -u ',
    'perl ', 'ruby ', 'swift ', 'deno run ', 'bun run ']) for (const wrap of wrappers) {
    const command = wrap(`${program}${path}${fold(name)} replay s.json`);
    assert.ok(await check(command), command);
  }
});
for (const spelling of ["'sle''ight'", 'sle\\ight', '$SCRIPT', '${SCRIPT}', '$(cat launcher)', '`cat launcher`',
  '<(cat launcher)', '"$SCRIPT"', 'sl*ight', 'slei?ht', '{sleight,x}', "$'sleight'", '"$(echo sleight)"'])
  test(`SA1U refuses unreadable script ${spelling}`, async () => {
    for (const wrap of wrappers.slice(0, -1)) assert.ok(await check(wrap(`bash ${spelling} record`)), spelling);
  });

const controls = [
  'node --no-warnings bench/replay/run.mjs', 'node --max-old-space-size=4096 bench/replay/run.mjs',
  'bash -e bench/replay/run.sh', 'bash -x bench/replay/run.sh', 'python3 -u bench/replay/x.py',
  'python3 -I tools/x.py record', 'sh -e scripts/x.sh replay', 'python3 -c "print(\'record\')"',
  'node -e "console.log(\'replay\')"', 'bash +x tools/replay/run.sh', 'bash +o pipefail tools/record/run.sh',
  'bash +x -c "node bench/replay/run.mjs"', 'bash 2>&1 -c "node bench/replay/run.mjs"',
  'bash 2>&1 script.sh record', 'bash 2>/dev/null script.sh hand on', 'bash script.sh<&- turbo on',
  'bash script.sh replay', 'bash script.sh record', 'node bench/replay/run.mjs', 'bash bench/replay/run.sh',
  'node tools/record/x.mjs', 'node scripts/record-demo.mjs record', 'bash tools/replay/go.sh replay s.json',
  'bash sleight.sh turbo on', 'bash mysleight turbo on', 'node bench/run.mjs --arm turbo --hand on',
  'node --test tests/replay.test.mjs', 'bash script.sh --label=sleight',
  'git commit -m "sleight replay"', 'grep -rn "replay\\|record" plugins/sleight', 'echo "sleight replay"', 'npm run check',
];
for (const command of controls) test(`SA1U ordinary control ${command}`, async () => {
  // Double quoting preserves these controls' inline single-quoted strings in the nested shell.
  for (const wrap of [...wrappers.slice(0, -1), command => `sh -c "${command.replaceAll('"', '\\"')}"`]) {
    const input = wrap(command);
    assert.equal(await check(input), undefined, input);
  }
});
test('SA1U documents conservative refusals and unresolved command names', async () => {
  for (const command of ['bash script.sh sleight replay', 'bash script.sh record < sleight',
    'node -e "console.log(\'sleight replay\')"', 'bash scr\'ip\'t.sh replay', 'bash script.sh replay "$VALUE"'])
    assert.ok(await check(command), command);
  for (const command of ['bash /tmp/ordinary-script.sh turbo on', 'saved_alias replay s.json', 'saved_function turbo on'])
    assert.equal(await check(command), undefined, command);
});

function replace(source, before, after) {
  assert.ok(source.includes(before), `mutation precondition: ${before}`);
  return source.replace(before, after);
}
async function mutant(before, after) {
  return (await import('data:text/javascript;base64,' + Buffer.from(replace(guardSource, before, after)).toString('base64')))
    .preapprovedWriteTarget;
}

// Only the trace-directory statements and logging functions execute, with real fs calls in a private bank.
function benchTrace(t, mode, source = benchSource) {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sa1u-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'bench-trace');
  if (mode !== undefined) { fs.mkdirSync(dir); fs.chmodSync(dir, mode); }
  const statements = source.match(/        mkdirSync\(dir, \{ recursive: true[^\n]*\n(?:        chmodSync\(dir, 0o700\);\n)?/)?.[0];
  assert.ok(statements, 'bench directory setup must exist');
  Function('mkdirSync', 'chmodSync', 'dir', statements)((path, config) => {
    assert.equal(config.mode, 0o700, 'bench bank must be private at creation, before chmod');
    fs.mkdirSync(path, config);
  }, fs.chmodSync, dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const body = launchSource.slice(launchSource.indexOf('function traceTo('), launchSource.indexOf('// Asks about an app approval'))
    .replace('export function approvalLogging', 'function approvalLogging');
  const { default: ignored, ...filesystem } = fs;
  const lines = [], bindings = { ...filesystem, join, homedir: () => root, createGrantAudit: () => undefined,
    process: { pid: process.pid, getuid: () => process.getuid(), stderr: { write: line => lines.push(line) } } };
  const logging = Function(...Object.keys(bindings), body + '\nreturn approvalLogging;')(...Object.values(bindings));
  const { trace } = logging({ size: 0 }, { SLEIGHT_TRACE: dir });
  assert.equal(typeof trace, 'function');
  trace('sent', { bench: true });
  const file = join(dir, `trace-${process.pid}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).msg.bench, true);
  assert.equal(lines.some(line => line.includes('disabled')), false);
}
for (const mode of [undefined, 0o755]) test(`SA1U bench trace works with initial mode ${mode?.toString(8) ?? 'absent'}`, t => benchTrace(t, mode));

for (const [name, before, after, command] of [
  ['segment scan omitted', 'if (segment.some((word, at) => at !== codeAt && !word.operator && launcher(word.text.split(\'/\').at(-1)))) return true;', '', 'bash +x sleight turbo on'],
  ['only first argument scanned', 'segment.some((word, at) => at !== codeAt && !word.operator && launcher(word.text.split(\'/\').at(-1)))',
    "launcher(segment[index + 1]?.text.split('/').at(-1) ?? '')", 'bash 2>&1 sleight turbo on'],
  ['case fold omitted', '.includes(name.toLowerCase())', '.includes(name)', 'bash +x ../bin/Sleight turbo on'],
  ['process substitution allowed', "if (segment.some(word => /^[<>]\\(/.test(word.text))) return true;",
    '', 'bash <(cat launcher) turbo on'],
  ['inline constructed launcher allowed', 'if (inline && plain.slice(index + 1).some(word => /sleight|launch\\.mjs/i.test(unescaped(word)))) return true;',
    '', 'python3 -c "import os; os.system(\'sl\'+\'eight-mcp record\')"'],
  ['ordinary option exemption omitted', 'if (!segNamed && scriptWord && !scriptWord.operator) continue;', '', 'node --no-warnings bench/replay/run.mjs'],
]) test(`SA1U broken variant caught: ${name}`, async () => {
  const guard = await mutant(before, after);
  await assert.rejects(async () => {
    const result = await check(command, guard);
    if (name === 'ordinary option exemption omitted') assert.equal(result, undefined, command);
    else assert.ok(result, command);
  }, { code: 'ERR_ASSERTION' });
});
test('SA1U broken variant caught: bench mkdir mode omitted', t => {
  const source = replace(benchSource, 'mkdirSync(dir, { recursive: true, mode: 0o700 });', 'mkdirSync(dir, { recursive: true });');
  assert.throws(() => benchTrace(t, undefined, source), { code: 'ERR_ASSERTION' });
});
test('SA1U broken variant caught: bench existing directory chmod omitted', t => {
  assert.throws(() => benchTrace(t, 0o755, replace(benchSource, '        chmodSync(dir, 0o700);\n', '')), { code: 'ERR_ASSERTION' });
});
