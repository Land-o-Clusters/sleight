// Live benchmark: auto-approve only the named temporary TextEdit fixture.
// Owns the MCP child and closes only the documents it creates.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-document-scope-');
const first = join(bank, `sleight-approved-${basename(bank)}.txt`);
const second = join(bank, `sleight-blocked-${basename(bank)}.txt`);
const traceFile = join(bank, 'trace.jsonl');
const stages = [];
let child;
let closed;
const pending = new Map();
let nextId = 0;
let expectedApproval;
const trace = async record => appendFile(traceFile, JSON.stringify(record) + '\n');
const fixture = operation => execute('osascript', ['-l', 'JavaScript', join(ROOT, 'bench/document-scope-fixture.js'), operation, first, second]);
const texts = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const send = msg => { trace({ direction: 'client', msg }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
  send({ id, method, params });
});
const call = async (name, args) => {
  const result = await request('tools/call', { name, arguments: args });
  stages.push({ name, args, isError: result?.isError ?? false, window: windowFromText(texts(result)) ?? null,
    text: (result?.content ?? []).filter(c => c.type === 'text' && !c.text.includes('## API')).map(c => c.text) });
  return result;
};

try {
  await writeFile(first, 'approved original\n');
  await writeFile(second, 'blocked original\n');
  await fixture('open');
  child = spawn(join(ROOT, 'plugins/sleight/bin/sleight-mcp'), [], { stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SLEIGHT_APPROVAL_SCOPE: 'document', SLEIGHT_APPROVAL_PROMPT: 'client',
      SLEIGHT_IDLE_TURN_END_MS: '0', SLEIGHT_TRACE: bank } });
  closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', err => { for (const p of pending.values()) p.reject(err); pending.clear(); });
  child.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`MCP exited ${code}`)); pending.clear(); });
  process.once('SIGINT', () => { for (const p of pending.values()) p.reject(new Error('cancelled')); pending.clear(); });
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    trace({ direction: 'server', msg });
    if (msg.method === 'elicitation/create') {
      const question = msg.params.message;
      const read = /^Read one window in (?:TextEdit|com\.apple\.TextEdit) to identify its document\?/.test(question);
      const document = expectedApproval === 'first' && question.includes(`${JSON.stringify(basename(first))} in TextEdit`) && question.includes(pathToFileURL(first).href);
      const action = read || document ? 'accept' : 'decline';
      stages.push({ prompt: question, action });
      if (document) expectedApproval = undefined;
      send({ id: msg.id, result: { action, ...(action === 'accept' ? { content: {} } : {}) } });
    } else if (!msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-document-benchmark', version: '1' } });
  send({ method: 'notifications/initialized' });
  const firstRead = await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.equal(windowFromText(texts(firstRead))?.url, pathToFileURL(first).href);
  expectedApproval = 'first';
  const approval = await call('document_scope', {});
  assert.ok(!approval.isError, texts(approval));
  const edit = await call('js', { code: 'await app.pressKey("super+a"); await app.typeText("SLEIGHT APPROVED CHANGED\\n"); await app.pressKey("super+s");' });
  assert.ok(!edit.isError, texts(edit));
  await fixture('select'); // first stays selected; verify the approved edit.
  const afterFirst = JSON.parse((await fixture('read')).stdout);
  assert.equal(afterFirst.first, 'SLEIGHT APPROVED CHANGED\n');
  assert.equal(afterFirst.second, 'blocked original\n');
  await execute('osascript', ['-l', 'JavaScript', join(ROOT, 'bench/document-scope-fixture.js'), 'select', second, first]);
  const secondRead = await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.equal(windowFromText(texts(secondRead))?.url, pathToFileURL(second).href);
  const refused = await call('js', { code: 'await app.typeText("MUST NOT APPEAR")' });
  assert.equal(refused.isError, true);
  assert.match(texts(refused), /document_scope/);
  const after = JSON.parse((await fixture('read')).stdout);
  assert.equal(after.second, 'blocked original\n');
  assert.equal(await readFile(second, 'utf8'), 'blocked original\n');
  console.log(`PASS: approved first document edited; second document action refused. Evidence: ${bank}`);
  stages.push({ verdict: 'PASS', after });
} catch (err) {
  stages.push({ verdict: 'FAIL', error: err.message });
  console.error(`FAIL: ${err.message}. Evidence: ${bank}`);
  process.exitCode = 1;
} finally {
  if (child) {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 6000);
    await closed;
    clearTimeout(timer);
  }
  try { await fixture('close'); } catch (err) { stages.push({ cleanupError: err.message }); process.exitCode = 1; }
  await writeFile(join(bank, 'results.json'), JSON.stringify({ stages, traceFile }, null, 2) + '\n');
}
