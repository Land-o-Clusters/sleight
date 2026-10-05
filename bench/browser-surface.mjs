// Interactive, owner-supervised browser probe. Owns and drains its launcher.
// Commands arrive as JSONL data in a private directory; approvals use Sleight's dialog.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const bank = await mkdtemp('/private/tmp/sleight-browser-live-');
const commands = join(bank, 'commands.jsonl');
await writeFile(commands, '');
console.log(JSON.stringify({ bank, commands }));
const child = spawn(fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url)), [], {
  stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(process.argv.includes('--force-browser') ? { SLEIGHT_SURFACES: 'browser,computer' } : {}), SLEIGHT_APPROVAL_PROMPT: 'dialog', SLEIGHT_TRACE: bank, SLEIGHT_IDLE_TURN_END_MS: '0' },
});
const stopped = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
let closed = false, cancelled = false, id = 0;
stopped.then(() => { closed = true; });
const pending = new Map(), owned = new Set();
child.stdin.on('error', () => {});
child.on('error', error => { console.error(error.message); cancelled = true; });
createInterface({ input: child.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const waiter = pending.get(msg.id);
  if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); waiter.resolve(msg); }
});
async function request(method, params) {
  if (closed) throw new Error('launcher closed');
  const next = ++id;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('request timed out')); }, 320000);
    pending.set(next, { resolve, reject, timer });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  const msg = await result;
  await appendFile(join(bank, 'results.jsonl'), JSON.stringify({ method, params, response: msg }) + '\n');
  return msg;
}
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
function print(msg) {
  const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  console.log(JSON.stringify({ id: msg.id, error: msg.error, isError: msg.result?.isError, meta: msg.result?._meta ? JSON.parse(JSON.stringify(msg.result._meta, (key, value) => key === 'screenshot' ? undefined : value)) : undefined, text: text.slice(-18000) }));
}
process.once('SIGINT', () => { cancelled = true; });
process.once('SIGTERM', () => { cancelled = true; });
let count = 0;
try {
  print(await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-browser-live', version: '1' } }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  print(await call('js', { code: 'await cua.listBrowsers()' }));
  while (!cancelled && !closed) {
    const rows = (await readFile(commands, 'utf8')).trim().split('\n').filter(Boolean);
    for (; count < rows.length && !cancelled; count++) {
      const command = JSON.parse(rows[count]);
      if (command.stop) { cancelled = true; break; }
      const handle = command.code?.match(/(?:let|var)\s+(\w+)\s*=\s*await cua.createBrowserTab\(/)?.[1];
      const result = await call(command.name ?? 'js', command.name ? {} : { code: command.code });
      if (handle && !result.error && !result.result?.isError) owned.add(handle);
      if (command.name === 'turn_ended' && !result.error && !result.result?.isError) owned.clear();
      print(result);
    }
    if (!cancelled) await new Promise(resolve => setTimeout(resolve, 200));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  for (const handle of owned) {
    try { print(await call('js', { code: `await ${handle}.close()` })); }
    catch (error) { console.error(`tab cleanup: ${error.message}`); process.exitCode = 1; }
  }
  if (!closed) { try { print(await call('turn_ended')); } catch (error) { console.error(error.message); process.exitCode = 1; } }
  child.stdin.end();
  const exit = await stopped;
  console.log(JSON.stringify({ phase: 'launcher-collected', ...exit, bank }));
  if (exit.code !== 0) process.exitCode = 1;
}
