#!/usr/bin/env node
// Host smoke: load the plugin's mod in a real Claude Code and run ordinary tool calls through its hooks.
// 1.6.0 refused every Bash command or Write naming a path that did not exist yet inside Claude Code 2.1.309, while every
// unit test passed against hand-written fakes of the mod API. This runs the real host instead (docs/release-preflight.md).
//
//   node scripts/host-smoke.mjs --plugin-dir <tree>/plugins/sleight [--config <logged-in config dir>] [--out <file.json>]
//     [--claude ~/.local/bin/claude]
//
// Each case is one headless `claude -p` call whose prompt names the exact tool input. No MCP server, no user settings,
// only the case's tools, and a Bash case may run only its exact command. The stream must show that one call (plus the
// Read before an Edit) or the case does not pass. Its tool_result decides allowed or refused, and the bank's files must
// agree. Exit 0 only when every case matches. The config must be an isolated logged-in one (the benchmark's sleight arm
// by default), never ~/.claude.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLogin } from '../bench/preflight.mjs';

const SETTINGS_DIR = 'home/Library/Application Support/sleight';
const ATTEMPTS = 2, CONCURRENCY = 4, TIMEOUT_MS = 120_000;
const quoted = path => `"${path.replace(/(["\\$`])/g, '\\$1')}"`;
const read = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

// Refusals sleight's mod returns, across 1.5.x and 1.6.x wording. A host permission denial or a failed command is not one.
export const SLEIGHT_REFUSAL = /sleight cannot resolve|sleight guard unavailable|sleight's shell guard|Only the user (?:changes|turns on)|Unknown directory before a write to a protected name|outside the literal read-only allowance|Use the replay tool in this session/;

/** The fixed cases. Each attempt gets its own folder under the bank, so cases run in parallel and retries start clean. */
export function smokeCases() {
  const bash = (id, expect, command, { setup, effect, reason } = {}) => ({ id, tool: 'Bash', expect, input: dir => ({ command: command(dir) }), setup, effect, reason });
  const settingsFile = (dir, name) => join(dir, SETTINGS_DIR, name);
  const seedSettings = dir => {
    mkdirSync(join(dir, SETTINGS_DIR), { recursive: true });
    for (const name of ['preapproved.json', 'turbo.json', 'permissions.json']) writeFileSync(settingsFile(dir, name), '{}\n');
    writeFileSync(join(dir, 'existing.txt'), 'existing\n');
  };
  const unchanged = name => dir => read(settingsFile(dir, name)) === '{}\n';
  const settings = /Only the user changes sleight's settings files/;
  const wrote = (name, text = 'x\n') => dir => read(join(dir, name)) === text;
  return [
    bash('bash-echo-stderr', 'allowed', () => 'echo x 2>&1', { effect: (_, output) => output.trim() === 'x' }),
    bash('bash-stderr-null', 'allowed', () => 'echo x 2>/dev/null', { effect: (_, output) => output.trim() === 'x' }),
    bash('bash-all-null', 'allowed', () => 'echo x &>/dev/null', { effect: (_, output) => !output.includes('x') }),
    bash('bash-redirect-new', 'allowed', dir => `echo x > ${join(dir, 'new.txt')}`, { effect: wrote('new.txt') }),
    bash('bash-redirect-spaces', 'allowed', dir => `echo x > ${quoted(join(dir, 'a b', 'new file.txt'))}`,
      { setup: dir => mkdirSync(join(dir, 'a b')), effect: wrote('a b/new file.txt') }),
    // The bank is realpath'd under /private/tmp; this spells it through the /tmp link.
    bash('bash-redirect-tmp-link', 'allowed', dir => `echo x > ${join(dir.replace(/^\/private\/tmp\//, '/tmp/'), 'linked.txt')}`, { effect: wrote('linked.txt') }),
    // Claude Code starts in the bank, the case folder's parent.
    bash('bash-redirect-relative', 'allowed', dir => `echo x > ${basename(dir)}/relative.txt`, { effect: wrote('relative.txt') }),
    bash('bash-mkdir-new', 'allowed', dir => `mkdir -p ${join(dir, 'newdir')}`, { effect: dir => existsSync(join(dir, 'newdir')) }),
    bash('bash-cp-new', 'allowed', dir => `cp ${join(dir, 'existing.txt')} ${join(dir, 'copy.txt')}`,
      { setup: dir => writeFileSync(join(dir, 'existing.txt'), 'existing\n'), effect: wrote('copy.txt', 'existing\n') }),
    bash('bash-touch-new', 'allowed', dir => `touch ${join(dir, 't.txt')}`, { effect: dir => existsSync(join(dir, 't.txt')) }),
    bash('bash-git-worktree', 'allowed', dir => `git -C ${join(dir, 'repo')} worktree add ${join(dir, 'wt')} -b smoke`, {
      setup: dir => {
        const env = { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
        const git = args => execFileSync('/usr/bin/git', args, { env, stdio: 'ignore', timeout: 30_000 });
        git(['init', '-q', join(dir, 'repo')]);
        git(['-C', join(dir, 'repo'), '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
      },
      effect: dir => existsSync(join(dir, 'wt', '.git')) }),
    bash('bash-heredoc-new', 'allowed', dir => `cat > ${join(dir, 'heredoc.txt')} <<'EOF'\nline one\nline two\nEOF`,
      { effect: wrote('heredoc.txt', 'line one\nline two\n') }),
    bash('bash-npm-version', 'allowed', () => 'npm --version 2>&1 | head -1', { effect: (_, output) => /^\d+\.\d+\.\d+/.test(output.trim()) }),
    { id: 'write-new', tool: 'Write', expect: 'allowed', input: dir => ({ file_path: join(dir, 'written.txt'), content: 'hello from write' }),
      effect: dir => read(join(dir, 'written.txt'))?.trim() === 'hello from write' },
    { id: 'edit-existing', tool: 'Edit', readFirst: true, expect: 'allowed', input: dir => ({ file_path: join(dir, 'edit-me.txt'), old_string: 'alpha', new_string: 'beta' }),
      setup: dir => writeFileSync(join(dir, 'edit-me.txt'), 'alpha\n'), effect: wrote('edit-me.txt', 'beta\n') },
    // Must be refused, so the gate cannot pass with the mod missing. The paths end the way the guard's protected suffixes do.
    // Claude Code wants a Read before a Write over an existing file.
    { id: 'write-protected', tool: 'Write', readFirst: true, expect: 'refused', reason: settings,
      input: dir => ({ file_path: settingsFile(dir, 'preapproved.json'), content: '{"apps":["Calculator"]}' }),
      setup: seedSettings, effect: unchanged('preapproved.json') },
    bash('bash-protected-redirect', 'refused', dir => `echo '{"enabled":true}' > ${quoted(settingsFile(dir, 'turbo.json'))}`,
      { setup: seedSettings, effect: unchanged('turbo.json'), reason: settings }),
    bash('bash-protected-redirect-2', 'refused', dir => `echo '{"never":[]}' > ${quoted(settingsFile(dir, 'permissions.json'))}`,
      { setup: seedSettings, effect: unchanged('permissions.json'), reason: settings }),
    bash('bash-protected-tee', 'refused', dir => `echo '{"apps":["Calculator"]}' | tee ${quoted(settingsFile(dir, 'preapproved.json'))}`,
      { setup: seedSettings, effect: unchanged('preapproved.json'), reason: settings }),
    bash('bash-protected-cp', 'refused', dir => `cp ${join(dir, 'existing.txt')} ${quoted(settingsFile(dir, 'turbo.json'))}`,
      { setup: seedSettings, effect: unchanged('turbo.json'), reason: settings }),
    bash('bash-protected-sed', 'refused', dir => `sed -i '' 's/{}/{"never":[]}/' ${quoted(settingsFile(dir, 'permissions.json'))}`,
      { setup: seedSettings, effect: unchanged('permissions.json'), reason: settings }),
    bash('bash-action-log-zshrc', 'refused', dir => `echo 'export SLEIGHT_ACTION_LOG=1' >> ${join(dir, 'home', '.zshrc')}`, {
      setup: dir => { mkdirSync(join(dir, 'home'), { recursive: true }); writeFileSync(join(dir, 'home', '.zshrc'), '# smoke\n'); },
      effect: dir => read(join(dir, 'home', '.zshrc')) === '# smoke\n', reason: /Only the user turns on sleight's action log/ }),
  ];
}

export function casePrompt(smokeCase, input) {
  const rules = 'This is an automated check of the tool pipeline. Do not retry, do not try another way, and do not make any other ' +
    'tool call, even if the call is refused or fails. Afterwards reply with one word: DONE.';
  if (smokeCase.tool === 'Bash') return `Make exactly one Bash tool call. Its command parameter must be exactly the text between the ` +
    `BEGIN and END lines below, character for character (it may span several lines):\nBEGIN\n${input.command}\nEND\n${rules}`;
  if (smokeCase.tool === 'Write') return `${smokeCase.readFirst ? `Use the Read tool once on ${input.file_path}. Then make` : 'Make'} exactly one Write tool call with file_path ${input.file_path} and content exactly ` +
    `the text between the BEGIN and END lines below, with no trailing newline:\nBEGIN\n${input.content}\nEND\n${rules}`;
  return `Use the Read tool once on ${input.file_path}. Then make exactly one Edit tool call on that file with old_string ` +
    `${input.old_string} and new_string ${input.new_string}. ${rules}`;
}

// The tool_use that carries the case's exact input. Extra fields (Bash's description) are allowed; the named ones must match.
export function sameInput(smokeCase, expected, actual) {
  if (!actual || typeof actual !== 'object') return false;
  if (smokeCase.tool === 'Bash') return typeof actual.command === 'string' && actual.command.trim() === expected.command.trim();
  if (smokeCase.tool === 'Write') return actual.file_path === expected.file_path && typeof actual.content === 'string'
    && actual.content.replace(/\n$/, '') === expected.content;
  return actual.file_path === expected.file_path && actual.old_string === expected.old_string
    && actual.new_string === expected.new_string && !actual.replace_all;
}

const resultText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';

/** Parse a stream-json transcript: the init event, then each tool_use with its tool_result. */
export function parseStream(text) {
  const init = {}, uses = [], results = new Map();
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init') Object.assign(init, {
      claudeCode: event.claude_code_version, model: event.model, sessionId: event.session_id,
      plugins: Array.isArray(event.plugins) ? event.plugins : [], mcpServers: event.mcp_servers });
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event.type === 'assistant' && block?.type === 'tool_use') uses.push({ id: block.id, name: block.name, input: block.input });
      if (event.type === 'user' && block?.type === 'tool_result') results.set(block.tool_use_id, { isError: block.is_error === true, text: resultText(block.content) });
    }
  }
  return { init, calls: uses.map(use => ({ ...use, result: results.get(use.id) })) };
}

/**
 * One attempt's verdict. pass: the exact call (and nothing else) ran and was allowed or refused as expected, and the files
 * agree. fail: the hooks decided the other way, the files contradict the outcome, or the session made other tool calls.
 * inconclusive: the plugin did not load once, an MCP server started, the model did not issue the exact call, no result came
 * back, or the call failed for a reason that is not a sleight refusal (a host permission denial, a failed command).
 * Inconclusive never passes.
 */
export function judge(smokeCase, { dir, pluginDir, stream, timedOut = false, exitCode = null }) {
  const expected = smokeCase.input(dir);
  const { init, calls } = parseStream(stream);
  const base = { id: smokeCase.id, tool: smokeCase.tool, expect: smokeCase.expect, expectedInput: expected, mcpServers: init.mcpServers ?? null };
  const sleights = init.plugins?.filter(plugin => plugin?.name === 'sleight') ?? [];
  if (!init.claudeCode) return { ...base, outcome: timedOut ? 'timeout' : 'no-session', verdict: 'inconclusive', reason: `claude exited ${exitCode} before its init event` };
  if (sleights.length !== 1 || typeof sleights[0].path !== 'string' || !samePath(sleights[0].path, pluginDir))
    return { ...base, outcome: 'plugin-not-loaded', verdict: 'inconclusive', reason: 'the init event does not list exactly this plugin dir as sleight' };
  if (!Array.isArray(init.mcpServers) || init.mcpServers.length)
    return { ...base, outcome: 'mcp-servers', verdict: 'inconclusive', reason: 'the init event lists MCP servers' };
  const call = calls.find(candidate => candidate.name === smokeCase.tool && sameInput(smokeCase, expected, candidate.input));
  if (!call) return { ...base, outcome: 'not-issued', verdict: 'inconclusive', reason: timedOut ? 'timed out' : 'the model did not issue the exact call',
    toolInput: calls.filter(candidate => candidate.name === smokeCase.tool).map(candidate => candidate.input)[0] ?? null };
  const out = { ...base, toolInput: call.input };
  if (!call.result) return { ...out, outcome: 'no-result', verdict: 'inconclusive', reason: timedOut ? 'timed out' : 'no tool_result for the call' };
  const { isError, text } = call.result;
  const refused = isError && SLEIGHT_REFUSAL.test(text);
  const outcome = !isError ? 'allowed' : refused ? 'refused' : 'error';
  const reason = text.slice(0, 500);
  // Only the exact call, and the one Read an Edit or an overwrite needs. Anything else could have made the files agree.
  const extra = calls.filter(candidate => candidate !== call && !(smokeCase.readFirst && candidate.name === 'Read'
    && candidate.input?.file_path === expected.file_path && calls.filter(other => other.name === 'Read').length === 1));
  if (extra.length) return { ...out, outcome, verdict: 'fail', reason, note: 'other tool calls in the session', extraCalls: extra.map(({ name, input }) => ({ name, input })) };
  if (outcome === 'error') return { ...out, outcome, verdict: 'inconclusive', reason };
  if (outcome !== smokeCase.expect) return { ...out, outcome, verdict: 'fail', reason };
  if (refused && smokeCase.reason && !smokeCase.reason.test(text)) return { ...out, outcome, verdict: 'fail', reason, note: 'refused for another reason' };
  let effect;
  try { effect = smokeCase.effect ? smokeCase.effect(dir, text) === true : true; } catch { effect = false; }
  if (!effect) return { ...out, outcome, verdict: 'fail', reason, note: refused ? 'refused, but the protected file changed' : 'allowed, but the expected file change is missing' };
  return { ...out, outcome, verdict: 'pass', reason };
}

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
}

// Owned process groups, so a timeout or our own SIGTERM collects Claude and every shell it started, and nothing else.
const live = new Set();
let aborted = false;
function killGroup(child, signal) { try { process.kill(-child.pid, signal); } catch {} }
export function killAll() { aborted = true; for (const child of live) killGroup(child, 'SIGKILL'); }

export function runClaude({ claude, args, cwd, env, timeoutMs }) {
  return new Promise(done => {
    let stdout = '', timedOut = false, escalation;
    const started = Date.now();
    const child = spawn(claude, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    live.add(child);
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGTERM'); escalation = setTimeout(() => killGroup(child, 'SIGKILL'), 5_000); }, timeoutMs);
    child.stdout.on('data', data => { stdout += data; });
    child.once('error', () => {});
    // After close the group id may belong to someone else, so no signal is sent after it.
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation); live.delete(child);
      done({ stdout, exitCode: code, timedOut, seconds: (Date.now() - started) / 1000 });
    });
  });
}

// Only the case's tools. A Bash case may run only its exact command (each part of a pipeline, as Claude Code checks them).
// acceptEdits lets redirections and file tools write inside the working folders, which are the bank alone.
export function claudeArgs({ prompt, pluginDir, bank, smokeCase, input }) {
  const rules = smokeCase.tool === 'Bash' ? [...new Set([input.command, ...input.command.split(' | ')])].map(part => `Bash(${part})`)
    : [smokeCase.tool, ...(smokeCase.readFirst ? ['Read'] : [])];
  return ['-p', prompt, '--plugin-dir', pluginDir, '--model', 'haiku', '--effort', 'low',
    '--output-format', 'stream-json', '--verbose', '--max-turns', '4',
    '--tools', [smokeCase.tool, ...(smokeCase.readFirst ? ['Read'] : [])].join(','), '--allowedTools', ...rules,
    '--permission-mode', 'acceptEdits', '--add-dir', bank,
    '--strict-mcp-config', '--setting-sources', ''];
}

// The CLI's environment: login lookup needs HOME and USER. Nothing from this session (CLAUDECODE, entrypoints, Node
// options), and no global or system git config, so the owner's git hooks never run on the bank's repo.
export function claudeEnv(config, env = process.env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL'];
  return { ...Object.fromEntries(keep.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])),
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

export const defaultConfig = (env = process.env, home = homedir()) =>
  join(env.SLEIGHT_ARM_DIR || join(env.BENCH_ARM_HOME || join(home, 'Library', 'Caches', 'sleight-bench'), 'sleight-arm'), 'claude');

function treeInfo(pluginDir) {
  const git = args => { try { return execFileSync('/usr/bin/git', ['-C', pluginDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim(); } catch { return null; } };
  let pluginVersion = null;
  try { pluginVersion = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null; } catch {}
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return { pluginVersion, treeCommit: git(['rev-parse', 'HEAD']), treeDirty: status === null ? null : status !== '' };
}

async function pool(items, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length && !aborted) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

/** Run every case. invoke is the process boundary (tests replace it); everything else is real. */
export async function runSmoke({ pluginDir, config, claude, cases = smokeCases(), invoke = runClaude, env = process.env,
  login = assertLogin, bankRoot = existsSync('/private/tmp') ? '/private/tmp' : tmpdir() } = {}) {
  const started = Date.now();
  pluginDir = realpathSync(pluginDir);
  const childEnv = claudeEnv(config, env);
  login({ command: claude, env: childEnv });
  let claudeVersion = null;
  try { claudeVersion = execFileSync(claude, ['--version'], { env: childEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const bank = realpathSync(mkdtempSync(join(bankRoot, 'sleight-host-smoke-')));
  try {
    const rows = await pool(cases, async smokeCase => {
      const tries = [];
      // Only an inconclusive attempt is retried: a retry can settle whether the call ran, never turn a fail into a pass.
      for (let attempt = 1; attempt <= ATTEMPTS && !aborted && tries.at(-1)?.verdict !== 'pass' && tries.at(-1)?.verdict !== 'fail'; attempt++) {
        const dir = join(bank, `${smokeCase.id}-${attempt}`);
        mkdirSync(dir, { recursive: true });
        smokeCase.setup?.(dir);
        const input = smokeCase.input(dir);
        const run = await invoke({ smokeCase, input, claude, args: claudeArgs({ prompt: casePrompt(smokeCase, input), pluginDir, bank, smokeCase, input }),
          cwd: bank, env: childEnv, timeoutMs: TIMEOUT_MS });
        const verdict = judge(smokeCase, { dir, pluginDir, stream: run.stdout, timedOut: run.timedOut, exitCode: run.exitCode });
        tries.push({ ...verdict, attempt, seconds: run.seconds, sessionId: parseStream(run.stdout).init.sessionId ?? null });
      }
      return { ...tries.at(-1), attemptVerdicts: tries.map(entry => entry.verdict) };
    });
    if (aborted) throw Error('stopped by a signal');
    const counts = { pass: 0, fail: 0, inconclusive: 0 };
    for (const row of rows) counts[row.verdict]++;
    const passed = expect => rows.filter(row => row.expect === expect && row.verdict === 'pass').length;
    return { ok: counts.pass === rows.length, claudeCode: claudeVersion, ...treeInfo(pluginDir), pluginDir,
      startedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000, counts,
      allowed: passed('allowed'), refused: passed('refused'), cases: rows };
  } finally {
    rmSync(bank, { recursive: true, force: true });
    // Our sessions' transcripts: the project folder Claude Code keys by the bank's path. Nothing else in the config.
    const project = join(config, 'projects', bank.replace(/[^A-Za-z0-9]/g, '-'));
    if (/-sleight-host-smoke-[A-Za-z0-9]{6}$/.test(project)) rmSync(project, { recursive: true, force: true });
  }
}

export function parseArgs(argv, env = process.env) {
  const options = { config: defaultConfig(env), claude: join(homedir(), '.local', 'bin', 'claude') };
  const flags = { '--plugin-dir': 'pluginDir', '--config': 'config', '--out': 'out', '--claude': 'claude' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]], value = argv[index + 1];
    if (!key || value === undefined || value.startsWith('--')) throw Error(`usage: unknown or empty flag ${argv[index]}`);
    options[key] = isAbsolute(value) ? value : resolve(value);
  }
  if (!options.pluginDir) throw Error('--plugin-dir is required');
  if (!existsSync(join(options.pluginDir, '.claude-plugin', 'plugin.json'))) throw Error('--plugin-dir has no .claude-plugin/plugin.json');
  return options;
}

// One stdout line the release preflight reads. The full record goes to --out.
export const summaryOf = (result, out) => ({ ok: result.ok, claudeCode: result.claudeCode, pluginVersion: result.pluginVersion,
  treeCommit: result.treeCommit, treeDirty: result.treeDirty, counts: result.counts, allowed: result.allowed, refused: result.refused,
  cases: result.cases.length, seconds: result.seconds, out });

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const out = options.out ?? join(realpathSync(tmpdir()), `sleight-host-smoke-${Date.now()}.json`);
  process.once('SIGINT', killAll); process.once('SIGTERM', killAll);
  let result;
  try { result = await runSmoke(options); }
  catch (error) { console.error(`host smoke could not run: ${error.message.split('\n')[0]}`); return 2; }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  for (const row of result.cases) console.error(`${row.verdict.padEnd(12)} ${row.id.padEnd(28)} expect ${row.expect}, got ${row.outcome}` +
    (row.verdict === 'pass' ? '' : `: ${String(row.note ?? row.reason ?? '').slice(0, 160)}`));
  console.log(JSON.stringify(summaryOf(result, out)));
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
