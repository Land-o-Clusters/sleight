// Small paired comparison, independent of run.mjs. Run through the lock wrapper.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './tasks.mjs';
import { actionVerdict } from './action-notes-verdict.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [arm, taskId, repetition, attempt = '1'] = process.argv.slice(2);
if (!['on', 'off'].includes(arm) || !['calculator-click', 'calculator-menu', 'textedit-save'].includes(taskId) || !/^[12]$/.test(repetition ?? '') || !/^\d+$/.test(attempt)) throw new Error('Expected on|off task 1|2 [attempt]');
const task = tasks.find(t => t.id === taskId);
const bank = mkdtempSync('/private/tmp/sleight-action-notes-');
const cwd = join(bank, 'empty'); mkdirSync(cwd);
const traces = join(bank, 'traces'); mkdirSync(traces);
const nonce = `${arm}-${taskId}-${repetition}`;
const context = { dir: bank, nonce };
const file = join(root, 'docs/benchmarks', `2026-10-04-action-notes-${attempt}-${arm}-${taskId}-${repetition}.json`);
const config = JSON.stringify({ mcpServers: { 'plugin:sleight:computer': { command: join(root, 'plugins/sleight/bin/sleight-mcp') } } });
const args = ['-p', task.prompt(context),
  '--settings', join(root, 'bench/settings.json'), '--tools', '',
  '--setting-sources', '',
  '--strict-mcp-config', '--mcp-config', config,
  '--allowedTools', 'mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__js_reset,mcp__plugin_sleight_computer__turn_ended',
  '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--effort', 'medium'];
const run = { arm, task: taskId, repetition: Number(repetition), attempt, started: new Date().toISOString(),
  cwd, prompt: task.prompt(context), args, model: 'claude-sonnet-5-5', effort: 'medium',
  node: process.version, claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  events: [], traces: [], stderr: '', passed: false };
const redact = value => {
  if (typeof value === 'string') return value.replaceAll(homedir(), '~').replace(/\/Users\/[^/\s"\\]+/g, '~').replace(/(Description: home, Value: )[^\r\n\\]+/g, '$1[home user]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value.type === 'image' || value.mimeType?.startsWith('image/')) return { type: 'image', omitted: 'image bytes excluded; AX evidence retained' };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
};
const save = () => writeFileSync(file, JSON.stringify(redact(run), null, 2) + '\n');
save();
const started = Date.now();
let child, timer, force, cancelled = false, timeout = false;
const stop = () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  force ??= setTimeout(() => child.kill('SIGKILL'), 15000);
};
process.once('SIGINT', () => { cancelled = true; stop(); });
process.once('SIGTERM', () => { cancelled = true; stop(); });
try {
  child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, BENCH_ROOT: root, SLEIGHT_APPROVAL_PROMPT: 'client',
    SLEIGHT_ACTION_NOTES: arm === 'on' ? '1' : '0', SLEIGHT_TRACE: traces,
    SLEIGHT_MENU_BAR: '0', SLEIGHT_DRAG: '0', SLEIGHT_CHANGE_REVIEW: '0',
    SLEIGHT_FLOW_RULES: '0', BENCH_HOOK_LOG: join(bank, 'approvals.jsonl'),
  } });
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { run.events.push(JSON.parse(line)); } catch { run.events.push({ unparsed: line }); }
      save();
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { run.stderr += chunk; save(); });
  timer = setTimeout(() => { timeout = true; stop(); }, 240000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  Object.assign(run, exit, { timeout, cancelled, seconds: (Date.now() - started) / 1000 });
  const init = run.events.find(e => e.type === 'system' && e.subtype === 'init');
  run.servers = init?.mcp_servers;
  const result = run.events.findLast(e => e.type === 'result');
  run.turns = result?.num_turns; run.answer = result?.result; run.cost = result?.total_cost_usd;
  const judged = task.check({ ...context, answer: run.answer ?? '' });
  run.verdict = judged;
  Object.assign(run, actionVerdict(run.events, task, judged, { ...exit, cancelled, timeout }));
} catch (err) { run.error = err.message; }
finally {
  clearTimeout(timer); clearTimeout(force);
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(traces)) run.traces.push({ file: name, events: readFileSync(join(traces, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) });
  try { run.approvals = readFileSync(join(bank, 'approvals.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { run.approvals = []; }
  run.finished = new Date().toISOString(); save();
  console.log(JSON.stringify({ arm, task: taskId, repetition, attempt, code: run.code, passed: run.passed, turns: run.turns, seconds: run.seconds, evidence: file.replaceAll(homedir(), '~') }));
  process.exitCode = run.passed ? 0 : 1;
}
