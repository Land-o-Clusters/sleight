// VC5S: the launcher refuses a settings-changing command unless a person started it in a terminal (lib/person-gate.mjs).
// Every chain here is injected; the only real ps calls are the read-only smoke walk at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATED_COMMANDS, agentProcess, refusalLine, rowArgs, settingsCommand, settingsRefusal, systemPs, walkAncestors } from '../plugins/sleight/lib/person-gate.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';
import { handConfigPath, readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';

const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
const tty = { isTTY: true }, pipe = { isTTY: false };
const person = () => ({ ok: true });
const underClaude = () => ({ ok: false, reason: 'claude' });
const clean = { env: {} };

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

test('the refusal is one line that names the reason, with exit code 3 from the launcher', () => {
  const start = "sleight: hand on changes sleight's settings, so run it yourself in a terminal (or use the menu bar). Reason: ";
  assert.equal(refusalLine('hand on', 'no terminal'), start + 'no terminal.');
  for (const code of ['claude', 'openai', 'agent']) assert.equal(refusalLine('hand on', code), start + 'started under an agent.');
  assert.equal(refusalLine('hand on', 'timeout'), start + 'check timed out.');
  assert.equal(refusalLine('hand on', 'multiplexer'), start + 'inside a terminal multiplexer.');
  for (const code of ['no tty', 'no terminal app', 'unknown ancestor', 'session', 'orphaned', 'too deep']) assert.equal(refusalLine('hand on', code), start + 'not started from a terminal app.');
  for (const code of ['ps failed', 'unreadable', undefined, 'anything']) assert.equal(refusalLine('hand on', code), start + 'check failed.');
  // permissions frobnicate writes nothing even if the gate were missing, so the real launcher is safe to run here.
  const run = spawnSync(process.execPath, [launch, 'permissions', 'frobnicate'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 3, run.stderr);
  assert.equal(run.stderr, refusalLine('permissions frobnicate', 'no terminal') + '\n');
  assert.equal(run.stdout, '');
});

test('the launcher lists the same command families as the gate', () => {
  const listed = /const SETTINGS_COMMANDS = (\[[^\]]*\]);/.exec(readFileSync(launch, 'utf8'));
  assert.ok(listed);
  assert.deepEqual(JSON.parse(listed[1].replace(/'/g, '"')), GATED_COMMANDS);
});

test('TTY rule: stdin and stdout must both be terminals', () => {
  assert.equal(settingsRefusal(['hand', 'on'], { ...clean, stdin: tty, stdout: tty, ancestors: person }), undefined);
  for (const [stdin, stdout] of [[pipe, tty], [tty, pipe], [{}, {}]]) {
    assert.equal(settingsRefusal(['hand', 'on'], { ...clean, stdin, stdout, ancestors: person }), refusalLine('hand on', 'no terminal'));
  }
  let walked = false;
  settingsRefusal(['hand', 'on'], { ...clean, stdin: pipe, stdout: pipe, ancestors: () => { walked = true; return { ok: true }; } });
  assert.equal(walked, false, 'a missing terminal refuses before any ps call');
});

test('Claude Code\'s environment markers refuse on top of the walk, as a daemon started from its shell inherits them', () => {
  for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }]) {
    assert.equal(settingsRefusal(['turbo', 'off'], { env, stdin: tty, stdout: tty, ancestors: person }), refusalLine('turbo off', 'agent'), JSON.stringify(env));
  }
  assert.equal(settingsRefusal(['turbo', 'off'], { env: { CLAUDECODE: '' }, stdin: tty, stdout: tty, ancestors: person }), undefined, 'an empty value is unset');
  assert.equal(settingsRefusal(['turbo', 'status'], { env: { CLAUDECODE: '1' }, stdin: pipe, stdout: pipe }), undefined, 'reads still run');
});

test('every settings-changing form is refused under an agent, even in a terminal, and when the walk throws', () => {
  for (const args of WRITES) {
    const command = settingsCommand(args), options = { ...clean, stdin: tty, stdout: tty };
    assert.equal(settingsRefusal(args, { ...options, ancestors: underClaude }), refusalLine(command, 'claude'), args.join(' '));
    assert.equal(settingsRefusal(args, { ...options, ancestors: () => { throw Error('boom'); } }), refusalLine(command), args.join(' '));
    assert.equal(settingsRefusal(args, { ...options, ancestors: () => undefined }), refusalLine(command), args.join(' '));
    assert.equal(settingsRefusal(args, { ...options, ancestors: person }), undefined, args.join(' '));
  }
});

test('every read-only and ungated form runs anywhere, without a terminal and under Claude', () => {
  for (const args of [...READS, ...UNGATED]) {
    assert.equal(settingsRefusal(args, { env: { CLAUDECODE: '1' }, stdin: pipe, stdout: pipe, ancestors: () => { throw Error('never called'); } }), undefined, args.join(' '));
  }
});

// Rows exactly as macOS prints `ps -o ppid=,comm=,args= -p <pid>`: comm is argv[0] cut to 16 characters, then the full args.
// argv0 defaults to the first word of args; pass it for a path with spaces.
const row = (ppid, args, argv0 = args.split(' ')[0]) => `${ppid} ${argv0.slice(0, 16)} ${args}`;
// A fake ps and lsof over a process table: pid -> [ppid, args, argv0?, executable?]. The executable defaults to argv0, as it
// is for a process nobody started with `exec -a`. tty is the launcher's controlling tty, and session the "pid stat" rows
// `ps -t <tty> -o pid=,stat=` prints for it.
const SELF = 400;
function machine(table, { tty = 'ttys006', session = ['200 Ss', '300 S+', `${SELF} R+`] } = {}) {
  const calls = [];
  const entry = pid => { if (!(pid in table)) throw Error('no such process'); return table[pid]; };
  const ps = argv => {
    calls.push(argv.join(' '));
    if (argv[0] === '-o' && argv[1] === 'tty=') return `${tty}\n`;
    if (argv[0] === '-t') { if (argv[1] !== tty) throw Error('wrong tty'); return session.join('\n') + '\n'; }
    const value = entry(Number(argv.at(-1)));
    return (typeof value === 'string' ? value : row(value[0], value[1], value[2])) + '\n';
  };
  const executable = pid => {
    calls.push(`lsof ${pid}`);
    const value = entry(pid);
    if (typeof value === 'string') return rowArgs(value.replace(/^\s*\d+ /, '')).split(' ')[0];
    return value.length > 3 ? value[3] : value[2] ?? value[1].split(' ')[0];
  };
  return { ps, executable, calls };
}
const HOME = '/Users/someone';
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
// Captured from this Mac's Terminal (2026-10-26), with the account name replaced and comm re-cut to 16 characters.
const TERMINAL = { 300: '200 -zsh -zsh', 200: '100 login login -pf someone', 100: `    1 /System/Applicat ${TERMINAL_APP}` };
const walk = (table, options = {}, extra = {}) => {
  const fake = machine(table, options);
  return { result: walkAncestors({ pid: 300, self: SELF, home: HOME, ps: fake.ps, executable: fake.executable, ...extra }), calls: fake.calls };
};
const CLAUDE_SHELL = [200, '/bin/zsh -c source snapshot.sh && eval run-the-launcher'];

test('rows split into args however comm was cut', () => {
  assert.equal(rowArgs('-zsh -zsh'), '-zsh');
  assert.equal(rowArgs('login login -pf someone'), 'login -pf someone');
  assert.equal(rowArgs(`/System/Applicat ${TERMINAL_APP}`), TERMINAL_APP);
  assert.equal(rowArgs('/Users/someone/M /Users/someone/My Tools/claude --resume'), '/Users/someone/My Tools/claude --resume');
  assert.equal(rowArgs('/Applications/Cl /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility'),
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility');
  assert.equal(rowArgs('My Tool My Tool --flag'), 'My Tool --flag', 'a comm with a space');
  assert.equal(rowArgs('bash'), 'bash', 'a row ps printed without the cut');
});

test('a person\'s Terminal chain reaches the terminal app through shells, then launchd, one ps call per level', () => {
  const { result, calls } = walk(TERMINAL);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [`-o tty= -p ${SELF}`, '-o ppid=,comm=,args= -p 300', '-o ppid=,comm=,args= -p 200', '-o ppid=,comm=,args= -p 100',
    'lsof 100', '-t ttys006 -o pid=,stat=']);
});

test('each listed GUI terminal passes by bundle path, in /Applications or ~/Applications, with its own helpers above it', () => {
  for (const app of ['/Applications/iTerm.app/Contents/MacOS/iTerm2', '/Applications/Ghostty.app/Contents/MacOS/ghostty',
    '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui', '/Applications/kitty.app/Contents/MacOS/kitty',
    '/Applications/Alacritty.app/Contents/MacOS/alacritty',
    `${HOME}/Applications/Ghostty.app/Contents/MacOS/ghostty`, '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal']) {
    assert.deepEqual(walk({ ...TERMINAL, 100: [1, app] }).result, { ok: true }, app);
  }
  // iTerm2 starts login from its own server process, under the iTerm2 app.
  const server = '/Applications/iTerm.app/Contents/MacOS/iTermServer-3.5.0';
  const iterm = { ...TERMINAL, 100: [90, `${server} /Users/someone/Library/Application Support/iTerm2/iterm2-daemon-1.socket`, server],
    90: [1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'] };
  const both = walk(iterm);
  assert.deepEqual(both.result, { ok: true });
  assert.deepEqual(both.calls.filter(call => call.startsWith('lsof')), ['lsof 100', 'lsof 90'], 'every terminal process is confirmed by its file');
});

test('editors and terminals that host their own agents refuse: VS Code, Cursor and Warp', () => {
  const vscodeHelper = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';
  const cursorHelper = '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)';
  for (const [args, argv0] of [[`${vscodeHelper} --type=utility`, vscodeHelper], [`${cursorHelper} --type=utility`, cursorHelper],
    ['/Applications/Warp.app/Contents/MacOS/stable'], [`${HOME}/Applications/Warp.app/Contents/MacOS/stable`]]) {
    assert.deepEqual(walk({ 300: [150, '/bin/zsh -il'], 150: [1, args, argv0] }, { session: ['300 Ss'] }).result, { ok: false, reason: 'unknown ancestor' }, args);
  }
});

test('a process that only claims a terminal\'s path with exec -a refuses: lsof shows the file it runs', () => {
  const fake = { ...TERMINAL, 100: [1, TERMINAL_APP, TERMINAL_APP, '/private/tmp/pty-host'] };
  assert.deepEqual(walk(fake).result, { ok: false, reason: 'unknown ancestor' });
  assert.deepEqual(walk({ ...TERMINAL, 100: [1, TERMINAL_APP, TERMINAL_APP, undefined] }, {}, { executable: () => undefined }).result, { ok: false, reason: 'unknown ancestor' });
  assert.deepEqual(walk(TERMINAL, {}, { executable: () => { throw Error('lsof: no such process'); } }).result, { ok: false, reason: 'ps failed' });
});

test('a terminal named right but outside an app bundle path refuses, as does anything else above the shells', () => {
  for (const args of ['/tmp/Terminal.app/Contents/MacOS/Terminal', '/Users/other/Applications/iTerm.app/Contents/MacOS/iTerm2',
    'Terminal', '/usr/local/bin/ghostty', '/usr/bin/python3 agent.py', 'sshd: someone@ttys006', '/Applications/SomeAgent.app/Contents/MacOS/SomeAgent']) {
    assert.deepEqual(walk({ ...TERMINAL, 100: [1, args] }).result, { ok: false, reason: 'unknown ancestor' }, args);
  }
  assert.deepEqual(walk({ ...TERMINAL, 200: [150, '/usr/bin/python3 pty-spawn.py'], 150: TERMINAL[100] }).result, { ok: false, reason: 'unknown ancestor' });
});

test('a terminal app started from an agent\'s shell refuses: everything above the terminal must be the terminal\'s own', () => {
  const table = { ...TERMINAL, 100: [90, TERMINAL_APP], 90: [80, '/bin/zsh -c open-it'], 80: [1, '/usr/local/bin/some-agent'] };
  assert.deepEqual(walk(table).result, { ok: false, reason: 'unknown ancestor' });
});

test('a chain that reaches launchd without a terminal app refuses', () => {
  assert.deepEqual(walk({ 300: [200, '/bin/zsh'], 200: [1, 'login -pf someone'] }).result, { ok: false, reason: 'no terminal app' });
});

test('real rows captured from the Code tab on this Mac refuse as Claude', () => {
  // 2026-10-26, read-only ps: the Code tab's shell, its claude.app, the disclaimer helper and Claude.app (account name replaced).
  const claudeApp = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.308/a93ded4b1b47/claude.app/Contents/MacOS/claude';
  const captured = {
    300: `59170 /bin/zsh /bin/zsh -c source /Users/someone/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'run-the-launcher'`,
    59170: `59169 /Users/someone/L ${claudeApp} --output-format stream-json --verbose --input-format stream-json`,
    59169: `5320 /Applications/Cl /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${claudeApp} --output-format stream-json`,
    5320: '    1 /Applications/Cl /Applications/Claude.app/Contents/MacOS/Claude',
  };
  assert.deepEqual(walk(captured).result, { ok: false, reason: 'claude' });
  for (const pid of [59170, 59169, 5320]) assert.equal(agentProcess(rowArgs(captured[pid].replace(/^\s*\d+ /, ''))), 'claude', String(pid));
  // The Code tab's terminal panel: a shell under Claude Helper.
  const panel = { 300: '5467 /bin/zsh /bin/zsh', 5467: ' 5320 /Applications/Cl /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility --utility-sub-type=node.mojom.NodeService' };
  assert.deepEqual(walk(panel).result, { ok: false, reason: 'claude' });
});

test('Claude Code anywhere in the chain refuses: native installer, npm node CLI, process title, a path with spaces', () => {
  const above = entry => ({ 300: CLAUDE_SHELL, 200: entry, 100: TERMINAL[100] });
  for (const entry of [
    [100, '/Users/someone/.local/bin/claude'],
    [100, '/Users/someone/.local/share/claude/versions/2.1.309 --resume'],
    [100, 'claude', 'claude'],
    [100, 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    [100, 'node /opt/homebrew/bin/claude --resume'],
    [100, 'node claude'],
    [100, '/Users/someone/My Tools/claude --resume', '/Users/someone/My Tools/claude'],
    [100, '/Users/someone/My Tools/node /Users/someone/My Tools/claude', '/Users/someone/My Tools/node'],
  ]) assert.deepEqual(walk(above(entry)).result, { ok: false, reason: 'claude' }, entry[1]);
});

test('the Codex CLI, ChatGPT.app and Codex.app refuse the same way', () => {
  const above = entry => ({ 300: CLAUDE_SHELL, 200: entry, 100: TERMINAL[100] });
  for (const entry of [
    [100, '/opt/homebrew/bin/codex exec'],
    [100, 'node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'],
    [100, 'node /opt/homebrew/bin/codex'],
    [1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'],
    [1, '/Applications/Codex.app/Contents/Resources/codex app-server'],
  ]) assert.deepEqual(walk(above(entry)).result, { ok: false, reason: 'openai' }, entry[1]);
});

test('a pseudo-terminal wrapper started from Claude\'s shell refuses', () => {
  const claudeShell = { 210: [100, '/bin/zsh -c source snapshot.sh'], 100: [1, '/Users/someone/.local/bin/claude'] };
  for (const wrapper of ['/usr/bin/script -q /dev/null', '/usr/bin/expect -f run.exp', '/opt/homebrew/bin/unbuffer x', '/usr/bin/python3 -c import pty']) {
    // The wrapper isn't a shell, so the walk refuses there, before it reaches claude.
    assert.deepEqual(walk({ 300: [220, '/bin/zsh'], 220: [210, wrapper], ...claudeShell }).result, { ok: false, reason: 'unknown ancestor' }, wrapper);
  }
});

test('tmux: a client under Claude drives a server under launchd, and the session it reaches refuses', () => {
  // The client runs send-keys from Claude's shell (pid 210 under claude). The server it started daemonized and re-parented to
  // launchd, and the command runs in a pane shell the server started, so the client never shows in the launcher's chain.
  const topology = {
    210: [100, '/bin/zsh -c tmux send-keys -t work run-the-launcher Enter'], 100: [1, '/Users/someone/.local/bin/claude'],
    211: [210, 'tmux send-keys -t work run-the-launcher Enter'],
    300: [250, '-zsh'], 250: [1, 'tmux new-session -d -s work'],
  };
  assert.deepEqual(walk(topology, { tty: 'ttys011', session: ['300 Ss', `${SELF} R+`] }).result, { ok: false, reason: 'multiplexer' });
  // A tmux server a person started from Terminal refuses too: anyone's client can drive it.
  assert.deepEqual(walk({ 300: [250, '-zsh'], 250: [100, 'tmux'], 100: TERMINAL[100] }).result, { ok: false, reason: 'multiplexer' });
  for (const name of ['SCREEN -dmS work', '/usr/bin/screen -dmS work', '/opt/homebrew/bin/zellij', '/usr/local/bin/abduco -n s', '/usr/local/bin/dtach -n /tmp/s zsh']) {
    assert.deepEqual(walk({ 300: [250, '/bin/zsh'], 250: [100, name], 100: TERMINAL[100] }).result, { ok: false, reason: 'multiplexer' }, name);
  }
});

test('the controlling tty\'s session leader must be a shell in the launcher\'s own chain, below the terminal', () => {
  // A tty whose session another process leads (a pty handed to the launcher from elsewhere) refuses.
  assert.deepEqual(walk(TERMINAL, { session: ['900 Ss', `${SELF} R+`] }).result, { ok: false, reason: 'session' });
  assert.deepEqual(walk(TERMINAL, { session: [`${SELF} R+`] }).result, { ok: false, reason: 'session' }, 'no leader');
  assert.deepEqual(walk(TERMINAL, { session: ['200 Ss', '300 Ss'] }).result, { ok: false, reason: 'session' }, 'two leaders');
  assert.deepEqual(walk(TERMINAL, { session: ['100 Ss'] }).result, { ok: false, reason: 'session' }, 'the terminal app itself');
  assert.deepEqual(walk(TERMINAL, { session: [] }).result, { ok: false, reason: 'session' });
  for (const tty of ['??', '', 'ttys006; rm', '-'.repeat(40)]) assert.deepEqual(walk(TERMINAL, { tty }).result, { ok: false, reason: 'no tty' }, tty);
});

test('words that only mention claude or tmux in arguments do not refuse a person', () => {
  const table = { ...TERMINAL, 300: [200, '-zsh -c echo claude tmux'] };
  assert.deepEqual(walk(table).result, { ok: true });
  assert.equal(agentProcess('/bin/zsh -c echo claude codex'), undefined);
  assert.equal(agentProcess('tmux new -s claude'), undefined);
  assert.equal(agentProcess(undefined), 'unreadable');
});

test('a walk that fails, can\'t be read or runs out of time refuses', () => {
  assert.deepEqual(walk({ 300: [200, '-zsh'] }).result, { ok: false, reason: 'ps failed' }, 'process 200 vanished');
  assert.deepEqual(walk({ 300: '' }).result, { ok: false, reason: 'unreadable' });
  assert.deepEqual(walk({ 300: 'garbage' }).result, { ok: false, reason: 'unreadable' });
  assert.deepEqual(walkAncestors({ pid: 300, self: SELF, ps: () => 42 }), { ok: false, reason: 'no tty' });
  assert.deepEqual(walkAncestors({ pid: 300, self: SELF, ps: () => { throw Error('EPERM'); } }), { ok: false, reason: 'ps failed' });
  const fake = machine(TERMINAL);
  let clock = 0;
  const slow = fn => (value, left) => { clock += 300; return fn(value, left); };
  assert.deepEqual(walkAncestors({ pid: 300, self: SELF, home: HOME, now: () => clock, ps: slow(fake.ps), executable: slow(fake.executable) }),
    { ok: false, reason: 'timeout' }, 'calls at 300 ms each run past 1 s');
  clock = 0;
  const budgets = [];
  const counted = fn => (value, left) => { budgets.push(left); clock += 100; return fn(value, left); };
  assert.deepEqual(walkAncestors({ pid: 300, self: SELF, home: HOME, now: () => clock, ps: counted(fake.ps), executable: counted(fake.executable) }), { ok: true });
  assert.deepEqual(budgets, [1000, 900, 800, 700, 600, 500], 'each call gets only the budget left');
});

test('an orphaned launcher (parent is launchd) refuses', () => {
  assert.deepEqual(walkAncestors({ pid: 1, ps: () => { throw Error('never called'); } }), { ok: false, reason: 'orphaned' });
  assert.deepEqual(walkAncestors({ pid: 0, ps: () => { throw Error('never called'); } }), { ok: false, reason: 'orphaned' });
});

test('the walk stops at 32 levels: a 32-level chain passes and 33 levels refuse', () => {
  const deep = levels => Object.fromEntries(Array.from({ length: levels }, (_, i) => [1000 + i, i === levels - 1 ? [1, TERMINAL_APP] : [1001 + i, '/bin/zsh']]));
  const run = levels => { const fake = machine(deep(levels), { session: ['1000 Ss'] }); return { result: walkAncestors({ pid: 1000, self: SELF, home: HOME, ps: fake.ps, executable: fake.executable }), calls: fake.calls }; };
  const ok = run(32);
  assert.deepEqual(ok.result, { ok: true });
  assert.equal(ok.calls.filter(call => call.startsWith('-o ppid=')).length, 32);
  const tooDeep = run(33);
  assert.deepEqual(tooDeep.result, { ok: false, reason: 'too deep' });
  assert.equal(tooDeep.calls.filter(call => call.startsWith('-o ppid=')).length, 32);
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
  if (process.platform === 'darwin' && process.env.CLAUDECODE === '1') {
    assert.equal(result.ok, false);
    // The walk stops at the test runner's node, so read the real rows above it and check the agent match finds Claude.
    const agents = [];
    for (let pid = process.ppid, level = 0; pid > 1 && level < 32; level++) {
      const [, ppid, rest] = /^\s*(\d+) (.+)$/.exec(systemPs(['-o', 'ppid=,comm=,args=', '-p', String(pid)], 1000).trim());
      agents.push(agentProcess(rowArgs(rest)));
      pid = Number(ppid);
    }
    assert.ok(agents.includes('claude'), agents.join(','));
  }
});
