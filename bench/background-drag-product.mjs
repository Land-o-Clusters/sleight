// A few locked product trials, using only benchmark approvals. Never bench/run.mjs.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, writeFile, access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { createHoverRedactor, publishHoverImage } from './hover-publication.mjs';
import { runChessTrial } from './background-drag-product-chess.mjs';

const exec = promisify(execFile), [mode, label] = process.argv.slice(2);
if (!['prepare', 'text', 'chess-read', 'chess', 'chess-control', 'chess-image', 'chess-finish'].includes(mode) || !/^[a-z0-9-]{1,60}$/.test(label ?? 'prepare')) throw new Error('Use a product trial mode and a fresh label');
const fixture = '.dev/textedit-drag-fixture';
if (mode === 'prepare') {
  await mkdir('.dev', { recursive: true });
  await exec('swiftc', ['-O', '-module-cache-path', '/private/tmp/sleight-product-drag-swift-cache', '-o', fixture, 'bench/textedit-drag-fixture.swift']);
} else {
  const output = `docs/benchmarks/${label}.json`;
  try { await access(output); throw new Error('Evidence label already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const clean = createHoverRedactor(), receipt = { mode, started: new Date().toISOString(), runs: [], approvals: [], transcript: [] };
  const save = () => writeFile(output, JSON.stringify(clean(receipt), null, 2).split(homedir()).join('~') + '\n');
  const command = async (cmd, args) => (await exec(cmd, args, { timeout: 30000 })).stdout;
  const approve = async (_key, message, schema) => {
    const hook = spawn(process.execPath, ['bench/approve.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = ''; hook.stdout.on('data', c => stdout += c);
    hook.stdin.end(JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message, requested_schema: schema }));
    await new Promise(r => hook.once('close', r));
    const decision = stdout ? JSON.parse(stdout).hookSpecificOutput : { action: 'decline' };
    receipt.approvals.push({ message, decision }); await save(); return decision;
  };
  let locked = false, child, closed, lockChild, cancelled = false;
  process.on('SIGINT', () => { cancelled = true; lockChild?.kill('SIGTERM'); child?.stdin.end(); });
  process.on('SIGTERM', () => { cancelled = true; lockChild?.kill('SIGTERM'); child?.stdin.end(); });
  const pending = new Map(); let id = 0;
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('RPC timeout')); }, 60000);
    pending.set(key, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
    send({ id: key, method, params });
  });
  const tool = (name, args) => rpc('tools/call', { name, arguments: args });
  let imageId = 0;
  const js = async code => {
    const result = await tool('js', { code });
    for (const block of result.content ?? []) if (block.type === 'image') {
      const bank = await mkdtemp('/private/tmp/sleight-product-image-');
      await writeFile(join(bank, `${++imageId}.png`), Buffer.from(block.data, 'base64'));
      await publishHoverImage('Chess', block, `${label}-${imageId}.png`, async () => {});
    }
    receipt.transcript.push({ code, result }); await save();
    if (result.isError) throw new Error('Engine call failed');
    return result;
  };
  const observeDrag = async (run, args, drag) => {
    const samples = exec('/usr/bin/osascript', ['-l', 'JavaScript', 'bench/drag-pointer-samples.js', '6500'], { timeout: 15000 });
    // Attach a handler immediately so observer failures cannot escape cleanup.
    const observed = samples.then(x => ({ samples: JSON.parse(x.stdout) }), e => ({ sampleError: e.message }));
    try { run.reply = await drag(args); }
    finally { Object.assign(run, await observed); }
    run.before = run.samples?.[0]; run.after = run.samples?.at(-1);
    run.pointerUnchanged = run.samples?.every(x => x.pointer.x === run.before.pointer.x && x.pointer.y === run.before.pointer.y);
    run.frontUnchanged = run.samples?.every(x => x.frontPid === run.before.frontPid);
    await save();
  };
  try {
    console.log('Waiting for shared live lock');
    const waiting = exec('/bin/sh', ['-c', 'until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done']);
    lockChild = waiting.child;
    await waiting; lockChild = undefined;
    locked = true; console.log('Acquired shared live lock');
    if (cancelled) throw new Error('cancelled');
    if (mode === 'text') {
      const dir = await mkdtemp('/private/tmp/sleight-product-text-');
      const decision = await approve(null, 'Allow Claude to drag in TextEdit? Background product fixtures.');
      if (decision.action !== 'accept') throw new Error('TextEdit not approved');
      for (let n = 1; n <= 3; n++) {
        if (cancelled) throw new Error('cancelled');
        const path = join(dir, `product-drag-${n}.txt`), run = { n, path }; receipt.runs.push(run);
        await writeFile(path, 'alpha beta gamma\n');
        try {
          await command('/usr/bin/open', ['-g', '-a', 'TextEdit', path]);
          await new Promise(r => setTimeout(r, 1500));
          run.selection = JSON.parse(await command(fixture, [path, 'select-drag'])); await save();
          if (!run.selection.ok || run.selection.active || run.selection.selected !== 'alpha') throw new Error('Fixture not selected in background');
          await observeDrag(run, { app: 'TextEdit', windowId: run.selection.windowId, from: run.selection.from, to: run.selection.to },
            args => callLocalTool('drag', args, async (key, msg) => (await approve(key, msg)).action === 'accept'));
          run.readback = JSON.parse(await command(fixture, [path, 'read']));
          const result = JSON.parse(run.reply.content[0].text);
          run.passed = !run.reply.isError && result.path === 'background' && run.readback.text === 'beta gamma alpha\n' && !run.readback.active && run.frontUnchanged;
          if (!run.passed) throw new Error('Text background trial failed');
        } catch (e) { run.error = e.message; run.stdout = e.stdout; receipt.exitCode = 1; }
        finally {
          try { await command('/usr/bin/osascript', ['bench/close-textedit-fixture.applescript', path]); run.closed = true; }
          catch (e) { run.cleanupError = e.message; receipt.exitCode = 1; }
          await save(); console.log(JSON.stringify(clean(run)));
        }
      }
    } else {
      child = spawn(process.execPath, ['plugins/sleight/lib/launch.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client' } });
      closed = new Promise(r => child.once('close', (code, signal) => r({ code, signal })));
      child.stderr.on('data', c => receipt.transcript.push({ stderr: String(c) }));
      child.on('close', () => { for (const p of pending.values()) p.reject(new Error('launcher closed')); pending.clear(); });
      createInterface({ input: child.stdout }).on('line', async line => {
        const msg = JSON.parse(line);
        if (msg.method === 'elicitation/create') {
          const decision = await approve(null, msg.params.message, msg.params.requestedSchema);
          send({ id: msg.id, result: { action: decision.action, content: decision.content } });
        } else if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      });
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'background-drag-product', version: '1' } });
      send({ method: 'notifications/initialized' });
      await js('var chess = await cua.getApp("Chess")');
      await js('await chess.getAXState({disableDiffing:true})');
      if (["chess", "chess-control", "chess-image", "chess-finish"].includes(mode)) {
        await runChessTrial({ mode, resumeId: Number(process.argv[4]),
          resumeSaveDirectory: mode === 'chess-finish' ? process.argv[5] : undefined,
          plan: process.argv[5] && mode !== 'chess-finish' ? JSON.parse(await readFile(process.argv[5], "utf8")) : undefined,
          receipt, save, js, tool, observeDrag, command,
          fixture: async args => JSON.parse(await command("/usr/bin/osascript", ["-l", "JavaScript", "bench/drag-chess-fixture.js", JSON.stringify(args)])),
          makeDirectory: () => mkdtemp("/private/tmp/sleight-product-chess-"), listFiles: readdir,
        });
      }
    }
  } catch (e) { receipt.error = e.message; receipt.exitCode = 1; }
  finally {
    if (child) { child.stdin.end(); receipt.launcherExit = await closed; }
    if (locked) { await exec('/bin/rmdir', ['/tmp/sleight-live.lock']); receipt.lockReleased = true; }
    receipt.finished = new Date().toISOString(); receipt.exitCode ??= 0; await save(); process.exitCode = receipt.exitCode;
  }
}
