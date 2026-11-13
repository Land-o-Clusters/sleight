import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { auditGuestStdin, scanGuestStdin } from './fixtures/guest-stdin-audit.mjs';

test('all bench and plugin PowerShell stdin senders end with a blank line', { skip: parserSkip }, t => {
  const result = scanGuestStdin(fileURLToPath(new URL('..', import.meta.url)));
  assert.ok(result.sites.length >= 3);
  t.diagnostic(`${result.files} source files; ${result.sites.join(', ')}`);
  assert.deepEqual(result.violations, []);
});

test('audit catches spelling, flag order, argv, template, alias, spread and stream variants', () => {
  for (const executable of ['powershell', 'pwsh', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'PWSH.EXE']) {
    for (const flag of ['-Command', '-c', '-Co', '-Com', '-Comm', '-Comma', '-Comman', '-File', '-f', '-Fi', '-Fil']) {
      for (const before of [true, false]) {
        const args = before ? ['-NonInteractive', flag, '-'] : [flag, '-', '-NonInteractive'];
        const input = 'const input = `& {\n${body}\n}\n`;';
        const prefix = `const exe = ${JSON.stringify(executable)}, argv = ${JSON.stringify(args)}; ${input}\n`;
        for (const call of ['run(exe, argv, { input });', 'const opts = {input}; alias(exe, argv, {...opts});',
          "const child = spawn(exe, argv, {stdio:['pipe','pipe','pipe']}); child.stdin.end(input);"]) {
          const bad = prefix + call;
          assert.equal(auditGuestStdin(bad).violations.length, 1, bad);
          assert.equal(auditGuestStdin(bad.replace('}\n`', '}\n\n`')).violations.length, 0);
        }
      }
    }
  }
  const ssh = "const cmd = `pwsh -c - -NonInteractive`; run('/usr/bin/ssh', ['vm', cmd], {input: 'script\\n'});";
  assert.equal(auditGuestStdin(ssh).violations.length, 1);
  assert.equal(auditGuestStdin(ssh.replace('script\\n', 'script\\n\\n')).violations.length, 0);
});

test('abbreviations, colon arguments, default stdin and unresolved executables cannot evade framing', () => {
  const cases = [
    "run('powershell', ['-Command:-'], {input: SCRIPT});",
    "run('pwsh', ['-Com:-'], {input: SCRIPT});",
    "run('powershell', ['-NoProfile'], {input: SCRIPT});",
    "const c = spawn('powershell', ['-NoProfile']); c.stdin.end(SCRIPT);",
    "const c = spawn('pwsh', []); c.stdin.write(SCRIPT);",
    "const exe = process.env.PS; run(exe, ['-Co', '-'], {input: SCRIPT});",
    "function send(shell) { const c = spawn(shell, ['-c','-']); c.stdin.end(SCRIPT); }",
    "function send(shell) { run(shell, ['-'], {input: SCRIPT}); }",
  ];
  for (const source of cases) {
    const bad = source.replace('SCRIPT', JSON.stringify('Get-Date\n'));
    const good = source.replace('SCRIPT', JSON.stringify('Get-Date\n\n'));
    assert.ok(auditGuestStdin(bad).violations.length >= 1, bad);
    const result = auditGuestStdin(good);
    assert.ok(result.sites.length >= 1, good);
    assert.deepEqual(result.violations, [], good);
  }
});

test('array join must produce a final blank line and uses the value at the launch', () => {
  for (const input of ["['x'].join('\\n\\n')", "['x','y'].join('\\n\\n')", "['x',''].join('\\n')"]) {
    const source = `run('pwsh', ['-c','-'], {input: ${input}});`;
    assert.equal(auditGuestStdin(source).violations.length, 1, source);
  }
  for (const input of ["['x',''].join('\\n\\n')", "['x','',''].join('\\n')", "['x','\\n\\n'].join('')"]) {
    assert.deepEqual(auditGuestStdin(`run('pwsh', ['-c','-'], {input: ${input}});`).violations, []);
  }
  for (const call of ["run('pwsh', ['-c','-'], {input});", "const c=spawn('pwsh',['-c','-']); c.stdin.end(input);"]) {
    assert.equal(auditGuestStdin(`let input='x'; ${call} input='y\\n\\n';`).violations.length, 1);
    assert.deepEqual(auditGuestStdin(`let input='x'; input='y\\n\\n'; ${call} input='z';`).violations, []);
  }
});

test('argument scripts, files and encoded workers receiving JSON are outside stdin-source framing', () => {
  for (const args of [[ '-Command', 'Get-Date'], ['-File', 'worker.ps1'], ['-EncodedCommand', 'AAAA']]) {
    const s = `run('powershell.exe', ${JSON.stringify(args)}, {input: '{"json":true}'});`;
    assert.deepEqual(auditGuestStdin(s), { sites: [], violations: [] });
  }
});

test('unrecognized stdin aliases and unresolved launches fail closed', () => {
  for (const tail of ['const {stdin} = c; stdin.end(s);', 'const stream = c.stdin; stream.end(s);',
    'createReadStream(f).pipe(c.stdin);', '']) {
    const source = "const c = spawn('powershell',['-c','-'],{stdio:['pipe','pipe','pipe']}); " + tail;
    assert.equal(auditGuestStdin(source).sites.length, 1);
    assert.equal(auditGuestStdin(source).violations.length, 1);
  }
  assert.equal(auditGuestStdin('execute(ps, args, {input: "script\\n"})').violations.length, 1);
  assert.equal(auditGuestStdin('execute(ps, args, {input: "script\\n\\n"})').violations.length, 0);
});

test('repository traversal checks new bench and plugin paths, including TypeScript hooks', { skip: parserSkip }, t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'uc3gfix1-audit-')));
  mkdirSync(join(root, 'bench/new'), { recursive: true });
  mkdirSync(join(root, 'plugins/new'), { recursive: true });
  writeFileSync(join(root, 'bench/new/job.mjs'), "const script = 'Get-Date\\n'; run('pwsh', ['-c','-'], {input: script});");
  writeFileSync(join(root, 'plugins/new/hook.tsx'), "const script: string = 'Get-Date\\n'; run('powershell.exe', ['-File','-'], {input: script});");
  const bad = scanGuestStdin(root);
  assert.equal(bad.files, 2); assert.equal(bad.violations.length, 2);
  for (const file of ['bench/new/job.mjs', 'plugins/new/hook.tsx']) {
    writeFileSync(join(root, file), "run('pwsh', ['-c','-'], {input: 'Get-Date\\n\\n'});");
  }
  assert.deepEqual(scanGuestStdin(root).violations, []);
});


test('JavaScript-only repository traversal runs without the developer parser', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'uc3gfix1-js-audit-')));
  mkdirSync(join(root, 'bench'));
  mkdirSync(join(root, 'plugins'));
  writeFileSync(join(root, 'bench/job.mjs'), "run('pwsh', ['-c','-'], {input: 'Get-Date\\n'});");
  const bad = scanGuestStdin(root);
  assert.equal(bad.files, 1); assert.equal(bad.violations.length, 1);
  writeFileSync(join(root, 'bench/job.mjs'), "run('pwsh', ['-c','-'], {input: 'Get-Date\\n\\n'});");
  assert.deepEqual(scanGuestStdin(root).violations, []);
});
