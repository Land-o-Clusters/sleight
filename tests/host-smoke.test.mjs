// The host smoke's verdict logic with the claude process replaced. The live run itself is scripts/host-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { hostSmokeCases } from '../scripts/release-preflight.mjs';
import { smokeCases, judge, parseStream, runSmoke, claudeArgs, claudeEnv, parseArgs, sameInput, defaultConfig, SLEIGHT_REFUSAL } from '../scripts/host-smoke.mjs';

const pluginDir = realpathSync(new URL('../plugins/sleight', import.meta.url).pathname);
const temp = prefix => realpathSync(trackTemp(mkdtempSync(join(tmpdir(), prefix))));
const settingsRefusal = "Only the user changes sleight's settings files (~/Library/Application Support/sleight). Ask them to make this change.";
const logRefusal = "Only the user turns on sleight's action log and outcome lines. Ask them to make this change.";
const unresolved = 'sleight cannot resolve this protected path. Its directory or filesystem metadata is unknown.';
const ok = (calls, extra = {}) => ({ stdout: stream({ calls, ...extra }), exitCode: 0, seconds: 1 });

// A stream-json transcript like `claude -p --output-format stream-json --verbose` prints.
function stream({ plugins = [{ name: 'sleight', path: pluginDir, version: '1.6.0' }], mcp = [], calls = [] } = {}) {
  const lines = [{ type: 'system', subtype: 'init', claude_code_version: '2.1.309', model: 'claude-haiku-5-5', session_id: 's1', plugins, mcp_servers: mcp }];
  calls.forEach(({ name, input, result }, index) => {
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${index}`, name, input }] } });
    if (result) lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${index}`, is_error: result.isError, content: result.text }] } });
  });
  lines.push({ type: 'result', subtype: 'success' });
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

// Carry out the call the way Claude Code would, from the bank, so the files are real.
function perform(smokeCase, input, cwd) {
  if (smokeCase.tool === 'Write') { writeFileSync(input.file_path, input.content); return { isError: false, text: 'File created' }; }
  if (smokeCase.tool === 'Edit') {
    writeFileSync(input.file_path, readFileSync(input.file_path, 'utf8').replace(input.old_string, input.new_string));
    return { isError: false, text: 'The file has been updated.' };
  }
  if (input.command.startsWith('npm ')) return { isError: false, text: '10.9.2' };
  const ran = spawnSync('/bin/bash', ['-c', input.command], { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  return { isError: ran.status !== 0, text: (ran.stdout + ran.stderr).trim() || '(Bash completed with no output)' };
}
const reads = (smokeCase, input) => smokeCase.readFirst ? [{ name: 'Read', input: { file_path: input.file_path }, result: { isError: false, text: '1\tx' } }] : [];
const refusalFor = smokeCase => smokeCase.id.includes('action-log') ? logRefusal : settingsRefusal;
// A host where the mod works: protected calls refused, the rest carried out.
const working = ({ smokeCase, input, cwd }) => ok([...reads(smokeCase, input), { name: smokeCase.tool, input: { ...input, description: 'x' },
  result: smokeCase.expect === 'refused' ? { isError: true, text: refusalFor(smokeCase) } : perform(smokeCase, input, cwd) }]);

const smoke = options => runSmoke({ pluginDir, config: temp('sleight-smoke-config-'), claude: '/usr/bin/true', login: () => {},
  bankRoot: temp('sleight-smoke-bank-'), ...options });

test('the fixed cases cover the 1.6.0 new-path commands and match the counts the release preflight requires', () => {
  const cases = smokeCases();
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.equal(cases.filter(item => item.expect === 'allowed').length, hostSmokeCases.allowed);
  assert.equal(cases.filter(item => item.expect === 'refused').length, hostSmokeCases.refused);
  // The macOS bank spelling, as data: the live bank is the realpath under it, reached through the /tmp link.
  const linked = ['', 'tmp', 'b', 'c-1'].join('/'), dir = ['', 'private'].join('/') + linked;
  const commands = cases.filter(item => item.tool === 'Bash').map(item => item.input(dir).command);
  for (const command of ['echo x 2>&1', 'echo x 2>/dev/null', 'echo x &>/dev/null', `echo x > ${dir}/new.txt`,
    `echo x > "${dir}/a b/new file.txt"`, `echo x > ${linked}/linked.txt`, 'echo x > c-1/relative.txt',
    `mkdir -p ${dir}/newdir`, `touch ${dir}/t.txt`, 'npm --version 2>&1 | head -1']) assert.ok(commands.includes(command), command);
  assert.ok(commands.some(command => command.includes("<<'EOF'")));
  for (const pattern of [/\| tee "/, /^cp .* "[^"]*sleight\/turbo\.json"$/, /^sed -i '' /, /SLEIGHT_ACTION_LOG/])
    assert.ok(cases.some(item => item.expect === 'refused' && pattern.test(item.input('/b').command ?? '')), String(pattern));
  assert.ok(cases.some(item => item.expect === 'refused' && item.tool === 'Write'));
});

test('a working host passes every case and cleans its bank and transcripts', async () => {
  const config = temp('sleight-smoke-config-'), bankRoot = temp('sleight-smoke-bank-');
  const result = await smoke({ invoke: working, config, bankRoot });
  assert.equal(result.ok, true, JSON.stringify(result.cases.filter(row => row.verdict !== 'pass'), null, 1));
  assert.deepEqual(result.counts, { pass: smokeCases().length, fail: 0, inconclusive: 0 });
  assert.deepEqual([result.allowed, result.refused], [hostSmokeCases.allowed, hostSmokeCases.refused]);
  assert.deepEqual(readdirSync(bankRoot), []);
  for (const row of result.cases) { assert.deepEqual(row.attemptVerdicts, ['pass']); assert.deepEqual(row.mcpServers, []); }
});

test('the 1.6.0 shape fails: new-path calls refused with the unresolved-path notice', async () => {
  const broken = args => args.smokeCase.expect === 'allowed' && args.smokeCase.id !== 'edit-existing'
    ? ok([{ name: args.smokeCase.tool, input: args.input, result: { isError: true, text: unresolved } }]) : working(args);
  const result = await smoke({ invoke: broken });
  assert.equal(result.ok, false);
  const failed = result.cases.filter(row => row.verdict === 'fail');
  assert.equal(failed.length, hostSmokeCases.allowed - 1);
  for (const row of failed) { assert.equal(row.outcome, 'refused'); assert.equal(row.reason, unresolved); }
});

test('a missing mod fails the protected cases instead of passing vacuously', async () => {
  const open = ({ smokeCase, input, cwd }) => ok([...reads(smokeCase, input), { name: smokeCase.tool, input, result: perform(smokeCase, input, cwd) }]);
  const result = await smoke({ invoke: open });
  assert.equal(result.ok, false);
  for (const row of result.cases.filter(item => item.expect === 'refused')) assert.notEqual(row.verdict, 'pass', row.id);
});

test('an uncooperative model is inconclusive, never a pass, and only inconclusive attempts retry once', async () => {
  const seen = new Map();
  const flaky = args => {
    const count = (seen.get(args.smokeCase.id) ?? 0) + 1;
    seen.set(args.smokeCase.id, count);
    // Every case's first attempt runs some other command; the second complies.
    return count === 1 ? ok([{ name: 'Bash', input: { command: 'ls' }, result: { isError: false, text: '' } }]) : working(args);
  };
  const retried = await smoke({ invoke: flaky });
  assert.equal(retried.ok, true);
  for (const row of retried.cases) assert.deepEqual(row.attemptVerdicts, ['inconclusive', 'pass']);
  const never = await smoke({ invoke: () => ok([{ name: 'Bash', input: { command: 'ls' }, result: { isError: false, text: '' } }]) });
  assert.equal(never.ok, false);
  assert.equal(never.counts.inconclusive, smokeCases().length);
  for (const row of never.cases) { assert.equal(row.outcome, 'not-issued'); assert.equal(row.attemptVerdicts.length, 2); }
  // A fail is final: no retry can turn it into a pass.
  let calls = 0;
  const refuseAll = args => { calls++; return ok([{ name: args.smokeCase.tool, input: args.input, result: { isError: true, text: unresolved } }]); };
  const cases = smokeCases().filter(item => item.id === 'bash-mkdir-new');
  assert.deepEqual((await smoke({ invoke: refuseAll, cases })).cases[0].attemptVerdicts, ['fail']);
  assert.equal(calls, 1);
});

test('judge: extra calls, MCP servers, plugin identity, host denials, timeouts and contradicting files', () => {
  const dir = temp('sleight-smoke-judge-');
  const byId = id => smokeCases().find(item => item.id === id);
  const mkdir = byId('bash-mkdir-new'), turbo = byId('bash-protected-redirect'), edit = byId('edit-existing');
  const input = mkdir.input(dir);
  const verdict = (smokeCase, options) => judge(smokeCase, { dir, pluginDir, ...options });
  const made = () => { spawnSync('/bin/mkdir', ['-p', join(dir, 'newdir')], { timeout: 10_000, killSignal: 'SIGKILL' }); return { isError: false, text: '' }; };
  assert.equal(verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input, result: made() }] }) }).verdict, 'pass');
  // Another call in the same session could have made the files agree.
  const extra = verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input, result: made() }, { name: 'Bash', input: { command: 'ls' }, result: { isError: false, text: '' } }] }) });
  assert.equal(extra.verdict, 'fail');
  assert.deepEqual(extra.extraCalls, [{ name: 'Bash', input: { command: 'ls' } }]);
  assert.equal(verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input, result: made() }, { name: 'Bash', input, result: made() }] }) }).verdict, 'fail');
  // An Edit may Read its own file once, nothing else.
  edit.setup(dir);
  const editInput = edit.input(dir), read = { name: 'Read', input: { file_path: editInput.file_path }, result: { isError: false, text: '' } };
  const edited = () => { writeFileSync(editInput.file_path, 'beta\n'); return { isError: false, text: 'updated' }; };
  assert.equal(verdict(edit, { stream: stream({ calls: [read, { name: 'Edit', input: editInput, result: edited() }] }) }).verdict, 'pass');
  assert.equal(verdict(edit, { stream: stream({ calls: [read, read, { name: 'Edit', input: editInput, result: edited() }] }) }).verdict, 'fail');
  assert.equal(verdict(edit, { stream: stream({ calls: [{ ...read, input: { file_path: '/etc/hosts' } }, { name: 'Edit', input: editInput, result: edited() }] }) }).verdict, 'fail');
  const good = [{ name: 'Bash', input, result: made() }];
  assert.equal(verdict(mkdir, { stream: stream({ mcp: [{ name: 'plugin:sleight:computer', status: 'connected' }], calls: good }) }).outcome, 'mcp-servers');
  assert.equal(verdict(mkdir, { stream: stream({ mcp: null, calls: good }) }).outcome, 'mcp-servers');
  assert.equal(verdict(mkdir, { stream: stream({ plugins: [{ name: 'sleight', path: '/elsewhere' }], calls: good }) }).outcome, 'plugin-not-loaded');
  assert.equal(verdict(mkdir, { stream: stream({ plugins: [{ name: 'sleight', path: pluginDir }, { name: 'sleight', path: '/cache/sleight' }], calls: good }) }).outcome, 'plugin-not-loaded');
  assert.equal(verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input, result: { isError: true,
    text: 'This command requires approval' } }] }) }).verdict, 'inconclusive');
  assert.equal(verdict(mkdir, { stream: '', timedOut: true }).outcome, 'timeout');
  assert.equal(verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input }] }), timedOut: true }).outcome, 'no-result');
  assert.equal(verdict(mkdir, { stream: stream({ calls: [{ name: 'Bash', input: { command: input.command + ' extra' }, result: { isError: false, text: '' } }] }) }).outcome, 'not-issued');
  // Allowed but nothing on disk: the result contradicts the bank.
  const other = temp('sleight-smoke-judge-');
  assert.equal(judge(mkdir, { dir: other, pluginDir, stream: stream({ calls: [{ name: 'Bash', input: mkdir.input(other), result: { isError: false, text: '' } }] }) }).verdict, 'fail');
  // A refusal for another reason than the case's.
  turbo.setup(dir);
  const protectedInput = turbo.input(dir);
  const wrong = verdict(turbo, { stream: stream({ calls: [{ name: 'Bash', input: protectedInput, result: { isError: true, text: unresolved } }] }) });
  assert.equal(wrong.verdict, 'fail');
  assert.equal(wrong.note, 'refused for another reason');
  assert.equal(verdict(turbo, { stream: stream({ calls: [{ name: 'Bash', input: protectedInput, result: { isError: true, text: settingsRefusal } }] }) }).verdict, 'pass');
  assert.ok(existsSync(join(dir, 'home/Library/Application Support/sleight/turbo.json')));
});

test('each case runs with only its tools, and a Bash case only with its exact command', () => {
  const byId = id => smokeCases().find(item => item.id === id);
  const argsFor = smokeCase => { const input = smokeCase.input('/b/c-1'); return claudeArgs({ prompt: 'p', pluginDir: '/p', bank: '/b', smokeCase, input }); };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  const npm = argsFor(byId('bash-npm-version'));
  assert.equal(after(npm, '--tools'), 'Bash');
  assert.deepEqual(npm.slice(npm.indexOf('--allowedTools') + 1, npm.indexOf('--permission-mode')),
    ['Bash(npm --version 2>&1 | head -1)', 'Bash(npm --version 2>&1)', 'Bash(head -1)']);
  const write = argsFor(byId('write-new')), edit = argsFor(byId('edit-existing'));
  assert.equal(after(write, '--tools'), 'Write');
  assert.equal(after(edit, '--tools'), 'Edit,Read');
  for (const args of [npm, write, edit]) {
    for (const flag of ['--plugin-dir', '--strict-mcp-config', '--add-dir', '--max-turns']) assert.ok(args.includes(flag), flag);
    assert.equal(after(args, '--permission-mode'), 'acceptEdits');
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args.some(arg => arg === 'Bash'), args === npm);
  }
});

test('refusal recognition, input matching and the CLI surface', () => {
  for (const text of [unresolved, settingsRefusal, logRefusal, 'sleight guard unavailable. The tool call was refused.',
    "sleight's shell guard for this turn blocked a launch that could take focus."]) assert.match(text, SLEIGHT_REFUSAL);
  for (const text of ['Claude requested permissions to edit /x/.zshrc which is a sensitive file.', 'cp: /x/sleight/a: No such file or directory'])
    assert.doesNotMatch(text, SLEIGHT_REFUSAL);
  const write = smokeCases().find(item => item.id === 'write-new');
  assert.equal(sameInput(write, { file_path: '/a', content: 'hi' }, { file_path: '/a', content: 'hi\n' }), true);
  assert.equal(sameInput(write, { file_path: '/a', content: 'hi' }, { file_path: '/b', content: 'hi' }), false);
  const env = claudeEnv('/cfg', { HOME: '/h', USER: 'u', PATH: '/bin', CLAUDECODE: '1', NODE_OPTIONS: '--x', CLAUDE_CONFIG_DIR: '/other' });
  assert.deepEqual(env, { HOME: '/h', USER: 'u', PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg', DISABLE_AUTOUPDATER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(defaultConfig({}, '/h'), '/h/Library/Caches/sleight-bench/sleight-arm/claude');
  // The config never comes from CLAUDE_CONFIG_DIR: the release runner sets a fresh, logged-out one there.
  assert.equal(parseArgs(['--plugin-dir', pluginDir], { CLAUDE_CONFIG_DIR: '/fresh' }).config.endsWith('/sleight-arm/claude'), true);
  assert.equal(parseArgs(['--plugin-dir', pluginDir, '--config', '/c']).config, '/c');
  for (const argv of [[], ['--plugin-dir', '/nonexistent'], ['--plugin-dir', pluginDir, '--attempts', '2'], ['--plugin-dir', pluginDir, '--config']])
    assert.throws(() => parseArgs(argv));
});

test('parseStream pairs each tool_use with its result and keeps the MCP server list', () => {
  const parsed = parseStream(stream({ calls: [{ name: 'Bash', input: { command: 'a' }, result: { isError: false, text: 'ok' } }, { name: 'Read', input: {} }] }) + 'not json\n');
  assert.equal(parsed.init.claudeCode, '2.1.309');
  assert.deepEqual(parsed.init.mcpServers, []);
  assert.deepEqual(parsed.calls.map(call => [call.name, call.result?.text]), [['Bash', 'ok'], ['Read', undefined]]);
});
