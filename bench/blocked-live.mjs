// A small live check for blocked_app, independent of bench/run.mjs and its
// approval hook. Each run holds the shared live lock (bench/blocked-live.sh)
// and publishes everything it launched, failures included, personal paths
// scrubbed. Consent travels through sleight's own dialog (ask.js), because
// headless Claude can't answer MCP prompts: a person clicks Allow on screen
// within five minutes, or the ask gives up and the attempt is published as
// refused.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeBlockedLive, makeClean } from './blocked-live-result.mjs';

const mode = process.argv[2];
if (!['terminal', 'codex'].includes(mode)) throw new Error('expected terminal or codex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = new Date().toISOString();
const clean = makeClean({ home: userInfo().homedir, user: userInfo().username, host: hostname(), tmp: tmpdir() });
const output = join(root, 'docs/benchmarks', `${started.replace(/[:.]/g, '-')}-blocked-${mode}.json`);

const bank = mkdtempSync(join(tmpdir(), 'sleight-blocked-live-'));
const cwd = join(bank, 'empty'); mkdirSync(cwd);
const trace = join(bank, 'trace'); mkdirSync(trace);
const config = { mcpServers: { sleight: { command: join(root, 'plugins/sleight/bin/sleight-mcp'),
  env: { SLEIGHT_APPROVAL_PROMPT: 'dialog', SLEIGHT_TRACE: trace } } } };
const prompts = {
  terminal: 'Use only the sleight blocked_app tool, and only on Terminal. First call it with op read, ' +
    'app Terminal. Report what came back, verbatim if it is a refusal. If the read returned elements, ' +
    'call it again with op type, app Terminal, and the exact text "echo sleight" followed by a newline ' +
    '(one call). Then read once more and report whether the output line sleight appears. The prompt ' +
    'line may hold leftover text from an earlier check; if the last line shows an unexecuted command, ' +
    'reset it with one call: op key, app Terminal, key ctrl+c. If any prompt is refused or times out, ' +
    'stop and report it.',
  codex: 'Use only the sleight blocked_app tool, and only on the ChatGPT app (bundle com.openai.codex). ' +
    'First call it with op read, app ChatGPT. Report what came back, verbatim if it is a refusal. If the ' +
    'read returned elements, click exactly one button: the one named "New chat" or the closest new-thread ' +
    'button, by element. Never click close, minimize, full screen, or anything that sends a message or ' +
    'changes settings. If no such button exists in the read, click nothing and report the elements you ' +
    'saw. Report the click result. If any prompt is refused or times out, stop and report it.',
};
const args = ['-p', prompts[mode], '--model', 'claude-sonnet-5-5', '--effort', 'medium',
  '--setting-sources', '', '--settings', '{"enabledPlugins":{"sleight@sleight":false}}',
  '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--tools', '',
  '--allowedTools', 'mcp__sleight__blocked_app', '--disable-slash-commands', '--permission-prompts', 'none',
  '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];

const TIMEOUT_MS = 7 * 60 * 1000; // one five-minute ask plus work time
const child = spawn('claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', d => { stdout += d; });
child.stderr.on('data', d => { stderr += d; });
const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, TIMEOUT_MS);
const exit = await new Promise(resolve => child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }));
const timedOut = exit.signal !== null;

// Publish every launched attempt, including timeouts and errors, scrubbed.
const traces = readdirSync(trace).filter(file => file.endsWith('.jsonl')).map(file => ({
  file, text: clean(readFileSync(join(trace, file), 'utf8')),
}));
const events = traces.flatMap(file => file.text.trim().split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return { direction: 'malformed', raw: line }; }
}));
const messages = stdout.trim().split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});
const verdict = judgeBlockedLive(mode, { exit, timedOut, events, messages, stdout: clean(stdout) });
const result = {
  started, mode, prompt: prompts[mode], command: ['claude', ...args.map(clean)],
  ...verdict, reported: verdict.reported.map(clean), stdout: clean(verdict.stdout),
  stderr: clean(stderr).slice(0, 4000), traces,
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(clean(JSON.stringify({
  output, exit, timedOut, passed: result.passed, consentAsked: result.consentAsked,
  readOk: result.readOk, clicked: result.clicked, echoSeen: result.echoSeen,
  assistiveDenied: result.assistiveDenied, traces: traces.length,
})));
process.exitCode = result.passed ? 0 : 1;
