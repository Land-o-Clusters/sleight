// App-free engine protocol check. Owns its lock, child collection and published receipt.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { plainProbe } from './other-hosts-client.mjs';

const lock = '/tmp/sleight-live.lock', hold = '/tmp/sleight-hold';
const receipt = { started: new Date().toISOString(), appAccess: false, pointerInput: false, passed: false };
const events = [];
const abort = new AbortController();
let owned = false, bank;
const interrupt = () => abort.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const scrub = value => String(value).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[user]')
  .replace(/\/Users\/[^/\s]+/g, '~').replace(/\/private\/var\/folders\/[^\s"']+/g, '[temporary path]');
try {
  if (existsSync(hold)) throw new Error('sleight-hold exists; no engine started');
  await mkdir(lock); owned = true;
  if (existsSync(hold)) throw new Error('sleight-hold appeared; no engine started');
  bank = await mkdtemp('/private/tmp/sleight-other-hosts-');
  const result = await plainProbe({ command: fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url)),
    env: { SLEIGHT_TRACE: bank, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_IDLE_TURN_END_MS: '30000' },
  }, { signal: abort.signal, record: event => {
    // Publish protocol coordinates and counts, excluding runtime docs and unrelated app data.
    if (event.event === 'server-close') events.push(event);
    else if (event.direction) events.push({ direction: event.direction, id: event.msg.id,
      method: event.msg.method, tool: event.msg.params?.name, error: !!event.msg.error, isError: !!event.msg.result?.isError });
  } });
  const traces = (await readdir(bank)).filter(name => name.startsWith('trace-'));
  const trace = (await Promise.all(traces.map(name => readFile(join(bank, name), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
  const calls = trace.filter(e => e.direction === 'to-server' && e.msg.params?.name === 'js');
  const metadata = calls.map(e => JSON.parse(e.msg.params._meta['x-codex-turn-metadata']));
  const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  receipt.protocolVersion = result.protocolVersion;
  receipt.tools = result.tools;
  receipt.arithmetic = [result.first, result.second].map(r => /\b42\b/.test(text(r)));
  receipt.idleEnds = trace.filter(e => e.direction === 'idle-turn-end').length;
  receipt.sessionStable = metadata.length === 2 && metadata[0].session_id === metadata[1].session_id;
  receipt.turnRotated = metadata.length === 2 && metadata[0].turn_id !== metadata[1].turn_id;
  receipt.optionalRequests = events.filter(e => e.direction === 'received' && e.method && e.id !== undefined).length;
  receipt.events = events;
  receipt.passed = receipt.arithmetic.every(Boolean) && receipt.idleEnds === 1 && receipt.sessionStable && receipt.turnRotated &&
    receipt.optionalRequests === 0 && events.at(-1)?.code === 0;
  if (!receipt.passed) throw new Error('protocol receipt did not prove arithmetic, idle cleanup and clean server exit');
} catch (error) {
  receipt.error = scrub(error.message);
  receipt.events = events;
  process.exitCode = 1;
} finally {
  if (bank) await rm(bank, { recursive: true, force: true });
  if (owned) await rmdir(lock);
  receipt.finished = new Date().toISOString();
  const out = fileURLToPath(new URL(`../docs/benchmarks/2026-10-09-other-hosts-${Date.now()}.json`, import.meta.url));
  process.stdout.write(scrub(JSON.stringify(receipt, null, 2)) + '\n');
  await writeFile(out, scrub(JSON.stringify(receipt, null, 2)) + '\n', { flag: 'wx' });
}
