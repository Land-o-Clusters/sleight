// Live flow check. The person must click Allow Once; this script cannot grant it.
// Owns its MCP child and closes only its two temporary TextEdit documents.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, appendFile, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-flow-rules-');
const nonce = basename(bank).split('-').at(-1);
const first = join(bank, `SOURCE-${nonce}.txt`);
const second = join(bank, `DESTINATION-${nonce}.txt`);
const rulesFile = join(bank, 'rules.json');
const secret = `FLOW PROTECTED VALUE ${nonce}\n`;
const safe = `Allowed new total: 42 ${nonce}\n`;
const traceFile = join(bank, 'trace.jsonl');
const stages = [];
const pending = new Map();
let child, closed, nextId = 0;
const trace = record => appendFile(traceFile, JSON.stringify(record) + '\n');
const fixture = operation => execute('osascript', ['-l', 'JavaScript', join(ROOT, 'bench/document-scope-fixture.js'), operation, operation === 'select' ? second : first, operation === 'select' ? first : second], { timeout: 30000 });
const texts = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const send = msg => { trace({ direction: 'client', msg }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
  send({ id, method, params });
});
const call = async (name, args, expectedError = false) => {
  const id = nextId;
  const result = await request('tools/call', { name, arguments: args }, name === 'flow_exception' ? 360000 : 60000);
  stages.push({ id, name, args, isError: result?.isError ?? false, window: windowFromText(texts(result)) ?? null,
    text: (result?.content ?? []).filter(c => c.type === 'text' && !c.text.includes('## API')).map(c => c.text) });
  assert.equal(Boolean(result?.isError), expectedError, texts(result).split('\n## Computer Use')[0]);
  return result;
};

try {
  await writeFile(first, secret); await writeFile(second, 'DESTINATION ORIGINAL\n');
  await writeFile(rulesFile, JSON.stringify({ version: 1, rules: [{ id: 'textedit-private', kind: 'source', sources: ['TextEdit'], destinations: ['TextEdit'] }] }));
  await fixture('open');
  console.log(`Fixtures: ${bank}\nApprove TextEdit. When the flow exception panel appears, click Allow Once. Only the user can make that decision.`);
  child = spawn(join(ROOT, 'plugins/sleight/bin/sleight-mcp'), [], { stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SLEIGHT_APPROVAL_SCOPE: 'session', SLEIGHT_APPROVAL_PROMPT: 'dialog',
      SLEIGHT_FLOW_RULES: rulesFile, SLEIGHT_IDLE_TURN_END_MS: '0', SLEIGHT_TRACE: bank } });
  closed = new Promise(resolve => child.once('close', resolve));
  const rejectAll = err => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  child.on('error', rejectAll); child.on('exit', code => rejectAll(new Error(`MCP exited ${code}`)));
  process.once('SIGINT', () => rejectAll(new Error('cancelled')));
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line); trace({ direction: 'server', msg });
    if (msg.method === 'elicitation/create') send({ id: msg.id, result: { action: 'decline' } });
    else if (!msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-flow-rules-benchmark', version: '1' } });
  send({ method: 'notifications/initialized' });
  const source = await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.equal(windowFromText(texts(source))?.url, pathToFileURL(first).href);
  assert.ok(texts(source).includes(secret.trim()), 'protected source value was returned');
  await fixture('select');
  const dest = await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.equal(windowFromText(texts(dest))?.url, pathToFileURL(second).href);
  const args = { code: `await app.pressKey("super+a"); await app.typeText(${JSON.stringify(secret)}); await app.pressKey("super+s");` };
  assert.match(texts(await call('js', args, true)), /textedit-private/);
  assert.equal(await readFile(second, 'utf8'), 'DESTINATION ORIGINAL\n');
  await call('js', { code: `await app.pressKey("super+a"); await app.typeText(${JSON.stringify(safe)}); await app.pressKey("super+s");` });
  assert.equal(await readFile(second, 'utf8'), safe);
  await call('js', args, true);
  console.log('Protected transfer refused; allowed total saved. The next panel needs your Allow Once decision.');
  await call('flow_exception', {});
  await call('js', args);
  assert.equal(await readFile(second, 'utf8'), secret);
  await call('js', args, true);
  const contents = { source: await readFile(first, 'utf8'), destination: await readFile(second, 'utf8') };
  assert.equal(contents.source, secret);
  stages.push({ contents, verdict: 'PASS' });
  console.log(`PASS: protected transfer refused, allowed total saved, user exception worked once, next retry refused.\nContents: ${JSON.stringify(contents)}\nEvidence: ${bank}`);
} catch (err) {
  stages.push({ verdict: 'FAIL', error: err.message });
  console.error(`FAIL: ${err.message}. Evidence: ${bank}`); process.exitCode = 1;
} finally {
  if (child) {
    child.stdin.end(); const timer = setTimeout(() => child.kill('SIGTERM'), 6000);
    await closed; clearTimeout(timer);
    try {
      const relayTrace = (await readFile(join(bank, `trace-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
      const refused = stages.filter(s => s.name === 'js' && s.isError).map(s => s.id);
      assert.equal(refused.length, 3);
      assert.ok(refused.every(id => !relayTrace.some(e => e.direction === 'to-server' && e.msg.id === id)), 'refused calls never forwarded');
      assert.equal(relayTrace.filter(e => e.direction === 'flow-exception-decision' && e.msg.action === 'accept').length, 1);
      for (const directory of new Set(relayTrace.filter(e => e.direction === 'snapshot-before-call').map(e => e.msg.directory))) {
        assert.equal(await access(directory).then(() => true, () => false), false, 'session backups removed');
      }
      stages.push({ relayProof: 'PASS' });
    } catch (err) { stages.push({ relayProof: 'FAIL', error: err.message }); process.exitCode = 1; }
  }
  try { await fixture('close'); } catch (err) { stages.push({ cleanupError: err.message }); process.exitCode = 1; }
  await writeFile(join(bank, 'results.json'), JSON.stringify({ stages, traceFile }, null, 2) + '\n');
}
