// A small live check, independent of bench/run.mjs and its approval hook.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { judgePreapproval } from './preapproved-result.mjs';
import { runOwned } from './preapproved-process.mjs';

const mode = process.argv[2];
if (!['listed', 'unlisted'].includes(mode)) throw new Error('expected listed or unlisted');
const auditRead = process.argv[3] === '--audit-read';
const auditOnly = auditRead || process.argv[3] === '--audit-only';
if (auditOnly && mode !== 'listed') throw new Error('audit-only evidence requires a listed trial');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = new Date().toISOString();
const clean = text => text.split(userInfo().homedir).join('~');
const output = join(root, 'docs/benchmarks', `${started.replace(/[:.]/g, '-')}-preapproved-${mode}${auditRead ? '-audit-read' : auditOnly ? '-audit-only' : ''}.json`);
try {
  const listed = loadPreapproved().allows('com.apple.calculator', 'low');
  if (listed !== (mode === 'listed')) throw new Error(`Calculator must be ${mode} in the user file before this run`);
} catch (error) {
  writeFileSync(output, JSON.stringify({ started, mode, launched: false, passed: false, error: clean(error.message) }, null, 2) + '\n');
  console.error(clean(JSON.stringify({ output, error: error.message }))); process.exit(1);
}
const bank = mkdtempSync(join(tmpdir(), 'sleight-preapproved-live-'));
const cwd = join(bank, 'empty'); mkdirSync(cwd);
const trace = join(bank, 'trace'); mkdirSync(trace);
const config = { mcpServers: { sleight: { command: join(root, 'plugins/sleight/bin/sleight-mcp'),
  env: { SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: auditOnly ? '' : trace } } } };
const prompt = auditRead ? 'Use only sleight js and Calculator. First call exactly: let app = await cua.getApp("com.apple.calculator"). ' +
  'Read its returned API documentation. If approval is refused, stop and report it. ' +
  'If approved, make one separate js tool call containing only await app.getAXState({disableDiffing:true}). ' +
  'Report the window title and whether the tool result says the user list preapproved the app. Do not click, type or change any app.' :
  'Use only the sleight js tool and Calculator. First select it with exactly one call: ' +
  'let app = await cua.getApp("com.apple.calculator"). Read the returned API instructions. ' +
  'If app approval is refused, stop and report that refusal; do not retry or work around it. ' +
  'If approved, calculate 12 times 12 by clicking Calculator buttons, clearing its previous answer first. ' +
  'Finally make a separate js tool call containing only await app.getAXState({disableDiffing:true}). ' +
  'Do not combine that final read with clicks or other statements in the same tool call. ' +
  'Report its displayed result. Do not use other apps.';
const args = ['-p', prompt, '--model', 'claude-sonnet-5-5', '--effort', 'medium',
  '--setting-sources', '', '--settings', '{"enabledPlugins":{"sleight@sleight":false}}',
  '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--tools', '',
  '--allowedTools', 'mcp__sleight__js', '--disable-slash-commands', '--permission-prompts', 'none',
  '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
const { exit, timedOut, cancelled, spawnError, stdout, stderr, groupClean } = await runOwned('claude', args, { cwd, signal: controller.signal });
// Publish every launched attempt, including timeouts and errors, with home paths removed.
const traces = readdirSync(trace).filter(file => file.endsWith('.jsonl')).map(file => ({
  file, text: clean(readFileSync(join(trace, file), 'utf8')),
}));
const events = traces.flatMap(file => file.text.trim().split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return { direction: 'malformed', raw: line }; }
}));
const messages = stdout.trim().split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});
const logDirectory = join(userInfo().homedir, 'Library/Logs/sleight');
let auditRecords = [], auditError, fullTraceDisabled = false;
if (auditOnly) {
  try {
    auditRecords = readdirSync(logDirectory).filter(name => /^preapproved-\d+\.jsonl(?:\.1)?$/.test(name)).flatMap(name => {
      const file = join(logDirectory, name);
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        .filter(record => record.t >= started && record.grant?.app === 'com.apple.calculator');
    });
    const pids = [...new Set(auditRecords.map(record => record.pid))];
    fullTraceDisabled = pids.length === 1 && pids.every(pid => {
      const file = join(logDirectory, `trace-${pid}.jsonl`);
      return !existsSync(file) || statSync(file).mtimeMs < Date.parse(started);
    });
  } catch (error) { auditError = clean(error.message); }
  events.push(...auditRecords.map(record => ({ direction: 'preapproved-app', msg: record.grant })));
  // Full tool results supply the final UI evidence when relay tracing is off.
  for (const message of messages) for (const block of message.message?.content ?? []) {
    if (message.type === 'user' && block.type === 'tool_result') events.push({ direction: 'to-client', msg: {
      result: { content: typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content,
        isError: block.is_error },
    } });
  }
}
const verdict = judgePreapproval(auditRead ? 'listed-read' : mode, exit, events, timedOut, messages);
const { grants, declines, cancels, reported } = verdict;
const passed = verdict.passed && groupClean && (!auditOnly || (fullTraceDisabled && !auditError));
const result = { started, mode, auditRead, auditOnly, fullTraceDisabled, auditRecords, auditError, prompt, command: ['claude', ...args].map(clean), exit, timedOut, cancelled, groupClean, spawnError,
  grants, declines, cancels, reported, passed, stdout: clean(stdout), stderr: clean(stderr), traces };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(clean(JSON.stringify({ output, exit, timedOut, grants, declines, cancels, reported, passed })));
process.exitCode = passed ? 0 : 1;
