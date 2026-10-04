// A small live check, independent of bench/run.mjs and its approval hook.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { judgePreapproval } from './preapproved-result.mjs';
import { runOwned } from './preapproved-process.mjs';

const mode = process.argv[2];
if (!['listed', 'unlisted'].includes(mode)) throw new Error('expected listed or unlisted');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = new Date().toISOString();
const clean = text => text.split(userInfo().homedir).join('~');
const output = join(root, 'docs/benchmarks', `${started.replace(/[:.]/g, '-')}-preapproved-${mode}.json`);
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
  env: { SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: trace } } } };
const prompt = 'Use only the sleight js tool and Calculator. First select it with exactly one call: ' +
  'let app = await cua.getApp("com.apple.calculator"). Read the returned API instructions. ' +
  'If app approval is refused, stop and report that refusal; do not retry or work around it. ' +
  'If approved, calculate 12 times 12 by clicking Calculator buttons, clearing its previous answer first. ' +
  'Finally make one standalone full read: await app.getAXState({disableDiffing:true}). ' +
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
const verdict = judgePreapproval(mode, exit, events, timedOut, messages);
const { grants, declines, cancels, reported } = verdict;
const passed = verdict.passed && groupClean;
const result = { started, mode, prompt, command: ['claude', ...args].map(clean), exit, timedOut, cancelled, groupClean, spawnError,
  grants, declines, cancels, reported, passed, stdout: clean(stdout), stderr: clean(stderr), traces };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(clean(JSON.stringify({ output, exit, timedOut, grants, declines, cancels, reported, passed })));
process.exitCode = passed ? 0 : 1;
