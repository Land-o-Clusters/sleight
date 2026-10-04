// Small, planned hover trials. This is separate from bench/run.mjs.
// node bench/hover-live.mjs <repository-relative plan.json> <output label>
// Plan: [{op:'read',app:'Calculator'}, {op:'hover',app:'Calculator',at:[x,y],waitMs:1500}]
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { BENCH_APPS } from './tasks.mjs';
import { createHoverRedactor, publishHoverImage } from './hover-publication.mjs';

const exec = promisify(execFile);
const [planFile, label] = process.argv.slice(2);
if (!planFile || !/^[a-z0-9-]{1,60}$/.test(label ?? '') || relative(process.cwd(), resolve(planFile)).startsWith('..')) {
  throw new Error('Supply a repository-contained plan and a short output label');
}
const plan = JSON.parse(await readFile(planFile, 'utf8'));
if (!Array.isArray(plan) || !plan.length || plan.length > 12 || plan.some(step =>
  !BENCH_APPS.includes(step.app) || !['read', 'windows', 'hover', 'key', 'click', 'raise', 'activate', 'arrange'].includes(step.op) ||
  (step.op === 'activate' && step.app !== 'Calculator') ||
  (step.op === 'arrange' && !['Calculator', 'Chess'].includes(step.app)))) {
  throw new Error('Plan needs up to 12 steps in Calculator, TextEdit or Chess');
}
if (plan.filter(step => step.op === 'arrange').length > 1) throw new Error('Arrange one window per run so its original position stays saved');
const output = join(process.cwd(), 'docs/benchmarks', label);
// A label is one attempt. Never overwrite an earlier result.
await mkdir(output);
const attempts = [], transcript = [];
const clean = createHoverRedactor();
let child, locked = false, cancelled = false;
const pending = new Map(); let id = 0;
let lockChild;
process.once('SIGINT', () => { cancelled = true; lockChild?.kill('SIGINT'); child?.stdin.end(); });
process.once('SIGTERM', () => { cancelled = true; lockChild?.kill('SIGTERM'); child?.stdin.end(); });
const send = msg => { transcript.push({ direction: 'client', msg: clean(msg) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
function request(method, params) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('request timed out')); }, 60000);
    pending.set(key, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ id: key, method, params });
  });
}
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
let closed;
let checkpoint;
let windowCheckpoint;
const fixture = async request => JSON.parse((await exec('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/hover-fixture.js', JSON.stringify(request)])).stdout);
const windowFixture = async request => JSON.parse((await exec('bench/results/hover-window-fixture', [JSON.stringify(request)])).stdout);
try {
  // Same shared lock as the other Codex sessions; hold it only for this run.
  console.log('Waiting for the shared live lock');
  await new Promise((resolve, reject) => {
    lockChild = execFile('/bin/sh', ['-c', 'until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done'], err => err ? reject(err) : resolve());
  });
  lockChild = undefined; locked = true;
  console.log('Acquired the shared live lock');
  if (cancelled) throw new Error('cancelled');
  checkpoint = await fixture({ op: 'checkpoint' });
  attempts.push({ checkpoint });
  if (!checkpoint.ok) throw new Error('cannot checkpoint live test');
  child = spawn(process.execPath, ['plugins/sleight/lib/launch.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client' },
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const rejectPending = err => { for (const waiter of pending.values()) waiter.reject(err); pending.clear(); };
  child.on('error', rejectPending);
  child.on('close', () => rejectPending(new Error('launcher closed')));
  child.stderr.on('data', chunk => transcript.push({ direction: 'stderr', text: clean(String(chunk)) }));
  createInterface({ input: child.stdout }).on('line', async line => {
    try {
      const msg = JSON.parse(line);
      const logged = structuredClone(msg);
      // Image publication is decided per app below; never log base64 pixels.
      for (const block of logged.result?.content ?? []) if (block.type === 'image') block.data = '<image handled in step result>';
      transcript.push({ direction: 'server', msg: clean(logged) });
      if (msg.method === 'elicitation/create') {
        // Run the existing hook with its exact request, without extra approvals.
        const hook = spawn(process.execPath, ['bench/approve.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
        let answer = '';
        hook.stdout.on('data', chunk => answer += chunk);
        hook.stdin.end(JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message: msg.params.message,
          requested_schema: msg.params.requestedSchema }));
        await new Promise(resolve => hook.once('close', resolve));
        const decision = answer ? JSON.parse(answer).hookSpecificOutput : { action: 'decline', content: {} };
        transcript.push({ direction: 'benchmark-approval', message: msg.params.message, decision });
        send({ id: msg.id, result: { action: decision.action, content: decision.content } });
      } else if (pending.has(msg.id)) {
        const waiter = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      }
    } catch (err) { attempts.push({ protocolError: err.message }); }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-hover-live', version: '1' } });
  send({ method: 'notifications/initialized' });
  let selected;
  for (const [index, step] of plan.entries()) {
    if (cancelled) throw new Error('cancelled');
    const trial = { index, step, results: [] }; attempts.push(trial);
    if (step.app !== selected) {
      const result = await call('js', { code: `${selected ? 'app =' : 'let app ='} await cua.getApp(${JSON.stringify(step.windowId === undefined ? step.app : { windowId: step.windowId })})` });
      trial.results.push(result);
      if (result.isError) throw new Error('app acquisition failed');
      selected = step.app;
    }
    let result;
    if (step.op === 'arrange') {
      const setup = await windowFixture({ op: 'prepare', app: step.app, windowTitle: step.windowTitle });
      windowCheckpoint = setup.checkpoint;
      result = { content: [{ type: 'text', text: JSON.stringify(setup) }], ...(setup.ok ? {} : { isError: true }) };
      if (!setup.ok) { trial.results.push(result); throw new Error('Window arrangement failed'); }
    } else if (step.op === 'activate') {
      const setup = await fixture({ op: 'activate', app: step.app });
      result = { content: [{ type: 'text', text: JSON.stringify(setup) }], ...(setup.ok ? {} : { isError: true }) };
      if (!setup.ok) { trial.results.push(result); throw new Error('Calculator did not become front; stopping this attempt'); }
    } else if (step.op === 'hover') result = await call('hover', { app: step.app, at: step.at,
      ...(step.windowTitle === undefined ? {} : { windowTitle: step.windowTitle }),
      ...(step.waitMs === undefined ? {} : { waitMs: step.waitMs }) });
    else result = await call('js', { code: step.op === 'windows' ? `nodeRepl.write((await cua.listApps({emit:false})).filter(x => x.displayName === ${JSON.stringify(step.app)}))` :
      step.op === 'raise' ? 'await app.performSecondaryAction(0,"Raise"); await app.getAXState()' :
      step.op === 'read' ? 'await app.getAXState({disableDiffing:true}); await app.getScreenshot()' :
      `${step.op === 'key' ? `await app.pressKey(${JSON.stringify(step.key)})` : `await app.click(${JSON.stringify(step.element)})`}; await app.getAXState()` });
    trial.results.push(result);
    for (const [r, reply] of trial.results.entries()) for (const [b, block] of (reply.content ?? []).entries()) {
      if (block.type !== 'image') continue;
      const filename = `step-${index}-${r}-${b}.png`;
      await publishHoverImage(step.app, block, filename, (name, bytes) => writeFile(join(output, name), bytes));
    }
    console.log(JSON.stringify(clean({ index, step, isError: result.isError ?? false, text: result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') })));
    if (result.isError) process.exitCode = 1;
  }
} catch (err) { attempts.push({ error: err.message }); process.exitCode = 1; }
finally {
  if (child) {
    child.stdin.end();
    // The launcher drains calls and collects its own engine, as in ordinary use.
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 10000);
    const exit = await closed; clearTimeout(timeout); attempts.push({ launcherExit: exit });
  }
  if (locked) {
    if (windowCheckpoint) {
      try {
        const restoredWindow = await windowFixture(windowCheckpoint);
        attempts.push({ restoredWindow });
        if (!restoredWindow.ok) process.exitCode = 1;
      } catch (err) { attempts.push({ windowRestoreError: err.message }); process.exitCode = 1; }
    }
    if (checkpoint?.ok) {
      try {
        const restored = await fixture({ ...checkpoint, op: 'restore' });
        attempts.push({ restored });
        if (!restored.ok || !restored.frontRestored || !restored.pointerRestored) process.exitCode = 1;
      } catch (err) { attempts.push({ restoreError: err.message }); process.exitCode = 1; }
    }
    try { await exec('/bin/rmdir', ['/tmp/sleight-live.lock']); attempts.push({ lockReleased: true }); }
    catch (err) { attempts.push({ lockReleaseError: err.message }); process.exitCode = 1; }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(clean({ plan, attempts, transcript, exitCode: process.exitCode ?? 0 }), null, 2) + '\n');
  console.log(`Evidence: ${clean(output)}/results.json`);
}
