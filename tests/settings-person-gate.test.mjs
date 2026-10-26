// VC5S: the launcher refuses a settings-changing command unless a person started it in a terminal (lib/person-gate.mjs).
// Every chain here is injected; the only real ps calls are the read-only smoke walk at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATED_COMMANDS, claudeProcess, refusalLine, settingsCommand, settingsRefusal, walkAncestors } from '../plugins/sleight/lib/person-gate.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';
import { handConfigPath, readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';

const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
const tty = { isTTY: true }, pipe = { isTTY: false };
const person = () => ({ ok: true });
const underClaude = () => ({ ok: false, reason: 'claude' });

const WRITES = [
  ['hand', 'on'], ['hand', 'off'], ['hand', 'capture', 'hidden'], ['hand', 'capture', 'visible'],
  ['turbo', 'on'], ['turbo', 'on', '--browser', 'chrome'], ['turbo', 'off'], ['turbo', 'app', 'on', 'com.example.app'], ['turbo', 'app', 'off', 'com.example.app'],
  ['permissions', 'block', 'com.example.app'], ['permissions', 'unblock', 'https://example.com'], ['permissions', 'revoke', 'all'],
  ['permissions', 'revoke', 'turbo'], ['permissions', 'sites', 'only', 'https://example.com'], ['permissions', 'sites', 'all'],
  ['permissions', 'repair'], ['permissions', 'repair', '--discard'], ['permissions', 'memory', 'clear', 'all'],
  ['cursor', 'style', 'ring'], ['cursor', 'style', 'sprite', 'test-cat'], ['cursor', 'import', '/tmp/x', '--yes'], ['cursor', 'remove', 'test-cat'],
  ['allow', 'remove', 'TextEdit'],
  ['routine', 'add', 'script.json', '--every', '1h'], ['routine', 'remove', 'r1'], ['routine', '--remove', 'r1'], ['routine', 'unlock', 'r1'],
  ['watch', 'https://example.com', '--find', 'x', '--every', '1h'], ['watch', 'record', 't.jsonl', '--every', '1h'], ['watch', 'remove', 'w1'], ['watch', 'unlock', 'w1'],
  // Forms the modules would reject as usage are refused too, so a writer added later is covered before anyone lists it.
  ['hand'], ['turbo'], ['cursor'], ['hand', 'status', 'extra'], ['permissions', 'frobnicate'],
];
const READS = [
  ['hand', 'status'], ['turbo', 'status'], ['cursor', 'list'], ['cursor', 'status'], ['cursor', 'check', 'test-cat'],
  ['permissions'], ['permissions', 'list'], ['permissions', 'memory'], ['permissions', 'memory', 'list'],
  ['allow', 'list'], ['routine', 'list'], ['routine', 'run-now', 'r1'], ['watch', 'list'], ['watch', 'notes'], ['watch', 'run-now', 'w1', '--scheduled'],
];
// Launcher commands outside the gate: the server, --doctor, stats, replays and the shell route.
const UNGATED = [[], ['--doctor'], ['--doctor', 'TextEdit'], ['stats'], ['turbo-state'], ['setup', '--dry-run'], ['session'], ['js', '1'], ['js_reset'],
  ['record', 'x.jsonl'], ['replay', 'x.json'], ['--socket-relay']];

test('every settings-changing form is named for the refusal, and every read or ungated form is not', () => {
  for (const args of WRITES) assert.equal(typeof settingsCommand(args), 'string', args.join(' '));
  for (const args of [...READS, ...UNGATED]) assert.equal(settingsCommand(args), undefined, args.join(' '));
  assert.equal(settingsCommand(['hand', 'on']), 'hand on');
  assert.equal(settingsCommand(['turbo', 'app', 'on', 'com.example.app']), 'turbo app on');
  assert.equal(settingsCommand(['permissions', 'memory', 'clear', 'all']), 'permissions memory clear');
  assert.equal(settingsCommand(['cursor', 'style\u001b[2J', 'ring']), 'cursor style2J', 'control characters never reach the line');
});

test('the refusal is one line with exit code 3 from the launcher', () => {
  assert.equal(refusalLine('hand on'), "sleight: hand on changes sleight's settings, so run it yourself in a terminal (or use the menu bar).");
  // permissions frobnicate writes nothing even if the gate were missing, so the real launcher is safe to run here.
  const run = spawnSync(process.execPath, [launch, 'permissions', 'frobnicate'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 3, run.stderr);
  assert.equal(run.stderr, refusalLine('permissions frobnicate') + '\n');
  assert.equal(run.stdout, '');
});

test('the launcher lists the same command families as the gate', () => {
  const listed = /const SETTINGS_COMMANDS = (\[[^\]]*\]);/.exec(readFileSync(launch, 'utf8'));
  assert.ok(listed);
  assert.deepEqual(JSON.parse(listed[1].replace(/'/g, '"')), GATED_COMMANDS);
});

test('TTY rule: stdin and stdout must both be terminals', () => {
  assert.equal(settingsRefusal(['hand', 'on'], { stdin: tty, stdout: tty, ancestors: person }), undefined);
  assert.equal(settingsRefusal(['hand', 'on'], { stdin: pipe, stdout: tty, ancestors: person }), refusalLine('hand on'));
  assert.equal(settingsRefusal(['hand', 'on'], { stdin: tty, stdout: pipe, ancestors: person }), refusalLine('hand on'));
  assert.equal(settingsRefusal(['hand', 'on'], { stdin: {}, stdout: {}, ancestors: person }), refusalLine('hand on'));
  let walked = false;
  settingsRefusal(['hand', 'on'], { stdin: pipe, stdout: pipe, ancestors: () => { walked = true; return { ok: true }; } });
  assert.equal(walked, false, 'a missing terminal refuses before any ps call');
});

test('every settings-changing form is refused under Claude, even in a terminal, and when the walk throws', () => {
  for (const args of WRITES) {
    const line = refusalLine(settingsCommand(args));
    assert.equal(settingsRefusal(args, { stdin: tty, stdout: tty, ancestors: underClaude }), line, args.join(' '));
    assert.equal(settingsRefusal(args, { stdin: tty, stdout: tty, ancestors: () => { throw Error('boom'); } }), line, args.join(' '));
    assert.equal(settingsRefusal(args, { stdin: tty, stdout: tty, ancestors: () => undefined }), line, args.join(' '));
    assert.equal(settingsRefusal(args, { stdin: tty, stdout: tty, ancestors: person }), undefined, args.join(' '));
  }
});

test('every read-only and ungated form runs anywhere, without a terminal and under Claude', () => {
  for (const args of [...READS, ...UNGATED]) {
    assert.equal(settingsRefusal(args, { stdin: pipe, stdout: pipe, ancestors: () => { throw Error('never called'); } }), undefined, args.join(' '));
  }
});

// A fake ps over a table of pid -> "ppid comm args", as `ps -o ppid=,comm=,args= -p <pid>` prints it.
function chain(rows) {
  const calls = [];
  const ps = pid => { calls.push(pid); if (!(pid in rows)) throw Error('no such process'); return rows[pid] + '\n'; };
  return { ps, calls };
}
const TERMINAL = { 300: '200 -zsh -zsh', 200: '100 login login -pfl someone /bin/zsh', 100: '1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' };
const walk = (rows, start = 300, extra = {}) => { const fake = chain(rows); return { result: walkAncestors({ pid: start, ps: fake.ps, ...extra }), calls: fake.calls }; };

test('a person\'s Terminal chain walks to launchd with one ps call per level', () => {
  const { result, calls } = walk(TERMINAL);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [300, 200, 100]);
});

test('Claude Code anywhere in the chain refuses: native binary, npm node CLI, process title, bundled claude.app', () => {
  const above = row => ({ 300: '200 /bin/zsh /bin/zsh -c sleight-mcp hand on', 200: row, 100: TERMINAL[100] });
  for (const row of [
    '100 /Users/someone/.local/bin/claude claude',
    '100 /Users/someone/Library/Application Support/Claude/claude-code/2.1.308/abc/claude.app/Contents/MacOS/claude /Users/someone/Library/Application Support/Claude/claude-code/2.1.308/abc/claude.app/Contents/MacOS/claude --output-format stream-json',
    '100 node node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '100 /opt/homebrew/bin/node node /opt/homebrew/bin/claude --resume',
    '100 node claude',
    '100 claude claude',
  ]) assert.deepEqual(walk(above(row)).result, { ok: false, reason: 'claude' }, row);
});

test('the desktop app and its helpers refuse, including the Code tab\'s terminal panel under them', () => {
  for (const row of [
    '1 /Applications/Claude.app/Contents/MacOS/Claude /Applications/Claude.app/Contents/MacOS/Claude',
    '1 /Applications/Claude.app/Contents/Helpers/disclaimer /Applications/Claude.app/Contents/Helpers/disclaimer',
    '1 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility',
  ]) assert.deepEqual(walk({ 300: '200 -zsh -zsh', 200: row }).result, { ok: false, reason: 'claude' }, row);
});

test('a pseudo-terminal wrapper started from Claude\'s shell still sits under claude and refuses', () => {
  const claudeShell = { 210: '100 /bin/zsh /bin/zsh -c source snapshot.sh', 100: '1 /Users/someone/.local/bin/claude claude' };
  for (const wrapper of ['/usr/bin/script script -q /dev/null sleight-mcp hand on', '/usr/bin/expect expect -f run.exp',
    '/opt/homebrew/bin/unbuffer unbuffer sleight-mcp hand on', 'tmux tmux new -d -s work', '/usr/bin/screen screen -dmS work']) {
    const rows = { 300: '220 /bin/zsh /bin/zsh', 220: `210 ${wrapper}`, ...claudeShell };
    assert.deepEqual(walk(rows).result, { ok: false, reason: 'claude' }, wrapper);
  }
});

test('words that only mention claude in arguments do not refuse a person', () => {
  const rows = { 300: '250 -zsh -zsh', 250: '200 tmux tmux new -s claude', 200: '100 /usr/bin/less less notes-about-claude.txt', 100: TERMINAL[100] };
  assert.deepEqual(walk(rows).result, { ok: true });
  assert.equal(claudeProcess('/bin/zsh /bin/zsh -c echo claude'), false);
  assert.equal(claudeProcess(undefined), true);
});

test('a walk that fails, can\'t be read or runs out of time refuses', () => {
  assert.deepEqual(walk({ 300: '200 -zsh -zsh' }).result, { ok: false, reason: 'ps failed' }, 'process 200 vanished');
  assert.deepEqual(walk({ 300: '' }).result, { ok: false, reason: 'unreadable' });
  assert.deepEqual(walk({ 300: 'garbage' }).result, { ok: false, reason: 'unreadable' });
  assert.deepEqual(walkAncestors({ pid: 300, ps: () => 42 }), { ok: false, reason: 'unreadable' });
  let clock = 0;
  const slow = walk(TERMINAL, 300, { now: () => clock, ps: pid => { clock += 400; return TERMINAL[pid]; } });
  assert.deepEqual(slow.result, { ok: false, reason: 'timeout' });
  clock = 0;
  const budgets = [];
  walkAncestors({ pid: 300, now: () => clock, ps: (pid, left) => { budgets.push(left); clock += 100; return TERMINAL[pid]; } });
  assert.deepEqual(budgets, [1000, 900, 800], 'each ps call gets only the budget left');
});

test('an orphaned launcher (parent is launchd) refuses', () => {
  assert.deepEqual(walkAncestors({ pid: 1, ps: () => { throw Error('never called'); } }), { ok: false, reason: 'orphaned' });
  assert.deepEqual(walkAncestors({ pid: 0, ps: () => { throw Error('never called'); } }), { ok: false, reason: 'orphaned' });
});

test('the walk stops at 32 levels: a 32-level chain passes and 33 levels refuse', () => {
  const deep = levels => Object.fromEntries(Array.from({ length: levels }, (_, i) => [1000 + i, `${i === levels - 1 ? 1 : 1001 + i} /bin/zsh /bin/zsh`]));
  const ok = walk(deep(32), 1000);
  assert.deepEqual(ok.result, { ok: true });
  assert.equal(ok.calls.length, 32);
  const tooDeep = walk(deep(33), 1000);
  assert.deepEqual(tooDeep.result, { ok: false, reason: 'too deep' });
  assert.equal(tooDeep.calls.length, 32);
});

test('the menu bar path writes through the host\'s writers, which the gate never sees', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-gate-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = handConfigPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The turbo menu's Ghost Hand row calls writeHandSetting from the session (worker.mjs setHand), here without a terminal.
  writeHandSetting({ enabled: true }, { path });
  assert.equal(readHandConfig(path).state, 'on');
  writeHandSetting({ enabled: false }, { path });
  assert.equal(readHandConfig(path).state, 'off');
});

test('the real walk on this machine finishes inside its budget, and finds Claude Code when this test runs under it', () => {
  const started = Date.now(), result = walkAncestors();
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  assert.equal(typeof result.ok, 'boolean');
  if (process.platform === 'darwin' && process.env.CLAUDECODE === '1') assert.deepEqual(result, { ok: false, reason: 'claude' });
});
