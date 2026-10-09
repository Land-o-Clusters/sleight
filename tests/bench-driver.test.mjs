import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('private driver suppresses transcripts and inherited trace destinations', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-private-driver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const response = await runDriver(process.execPath, ['-e', `
    console.log(JSON.stringify({result:process.env.SLEIGHT_TRACE || 'no trace', hookLog:process.env.BENCH_HOOK_LOG || null}));
  `], { privateMail: true, evidenceDir: dir, env: { ...process.env, SLEIGHT_TRACE: dir, BENCH_HOOK_LOG: join(dir, 'hooks.jsonl') } });
  assert.equal(response.out.result, 'no trace');
  assert.equal(response.out.hookLog, null);
  assert.equal(existsSync(join(dir, 'transcript.jsonl')), false);
});

test('private driver closes inherited telemetry and diagnostic destinations while preserving required runtime keys', async () => {
  const { runDriver } = await import('../bench/driver.mjs');
  const response = await runDriver(process.execPath, ['-e', `
    console.log(JSON.stringify({result:'okay', env:Object.fromEntries([
      'OTEL_LOG_RAW_API_BODIES','OTEL_LOG_USER_PROMPTS','OTEL_LOG_ASSISTANT_RESPONSES',
      'OTEL_LOG_TOOL_CONTENT','OTEL_LOG_TOOL_DETAILS','OTEL_LOGS_EXPORTER','OTEL_METRICS_EXPORTER',
      'OTEL_TRACES_EXPORTER','ENABLE_BETA_TRACING_DETAILED','CLAUDE_CODE_ENABLE_TELEMETRY','DISABLE_TELEMETRY',
      'CLAUDE_DEBUG_PATH','BENCH_ROOT','BENCH_SUITE','SLEIGHT_SURFACES','PATH','HOME'
    ].map(key=>[key,process.env[key] ?? null]))}));
  `], { privateMail: true, env: { ...process.env, OTEL_LOG_RAW_API_BODIES: 'file:/private/tmp/private-debug',
    OTEL_LOGS_EXPORTER: 'otlp', CLAUDE_DEBUG_PATH: '/private/tmp/private-debug', BENCH_ROOT: '/fixture', BENCH_SUITE: 'real', SLEIGHT_SURFACES: 'computer' } });
  for (const key of ['OTEL_LOG_RAW_API_BODIES','OTEL_LOG_USER_PROMPTS','OTEL_LOG_ASSISTANT_RESPONSES',
    'OTEL_LOG_TOOL_CONTENT','OTEL_LOG_TOOL_DETAILS','ENABLE_BETA_TRACING_DETAILED','CLAUDE_CODE_ENABLE_TELEMETRY']) assert.equal(response.out.env[key], '0', key);
  for (const key of ['OTEL_LOGS_EXPORTER','OTEL_METRICS_EXPORTER','OTEL_TRACES_EXPORTER']) assert.equal(response.out.env[key], 'none', key);
  assert.equal(response.out.env.DISABLE_TELEMETRY, '1');
  assert.equal(response.out.env.CLAUDE_DEBUG_PATH, null);
  assert.equal(response.out.env.BENCH_ROOT, '/fixture');
  assert.equal(response.out.env.BENCH_SUITE, 'real');
  assert.equal(response.out.env.SLEIGHT_SURFACES, 'computer');
  assert.equal(response.out.env.PATH, process.env.PATH);
  assert.equal(response.out.env.HOME, process.env.HOME);
});

test('default driver cancellation collects the driver while the pass lock remains held', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-driver-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lock'), receipt = join(dir, 'receipt');
  writeFileSync(lock, 'held');
  const controller = new AbortController();
  const response = await runDriver(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(receipt)}, String(fs.existsSync(${JSON.stringify(lock)})));
      process.exit(0);
    }, 150));
    setInterval(() => {}, 1000);
    console.log(JSON.stringify({result:'ready'}));
  `], { format: 'json', signal: controller.signal, graceMs: 2000,
    onStdout: () => controller.abort() });
  assert.equal(response.groupClean, true);
  assert.equal(response.cancelled, true);
  assert.equal(readFileSync(receipt, 'utf8'), 'true');
  assert.equal(existsSync(lock), true);
});

test('a streamed browser permission refusal stops before another driver action', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-permission-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'another-action'), controller = new AbortController();
  let refusals = 0;
  const event = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true,
    content: 'Browser Use could not complete this action because a browser security check was unavailable. Reason: The permission request was dismissed before a decision was made.' }] } };
  const response = await runDriver(process.execPath, ['-e', `
    console.log(JSON.stringify({message:{content:{unexpected:'frame'}}}));
    console.log(JSON.stringify({message:{content:[{type:'tool_result',content:'Browser Use could not complete this action: permission request dismissed',is_error:false}]}}));
    console.log(${JSON.stringify(JSON.stringify(event))});
    setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong'), 200);
    setInterval(() => {}, 1000);
  `], { format: 'stream-json', signal: controller.signal, timeoutMs: 1500, graceMs: 500,
    onPermissionRefusal: () => { refusals++; controller.abort(); } });
  assert.equal(refusals, 1);
  assert.equal(response.cancelled, true);
  assert.equal(response.groupClean, true);
  assert.equal(existsSync(marker), false);
});

test('private driver rechecks policy at initialization and collects before any later action', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-private-policy-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'another-action'), controller = new AbortController();
  let checks = 0;
  const response = await runDriver(process.execPath, ['-e', `
    console.log(JSON.stringify({type:'system',subtype:'init'}));
    setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong'),200);
    setInterval(()=>{},1000);
  `], { privateMail: true, format: 'stream-json', signal: controller.signal, timeoutMs: 1000,
    privatePolicyCheck: () => { checks++; throw new Error('private policy text'); }, onPermissionRefusal: () => controller.abort() });
  assert.equal(checks, 1);
  assert.equal(response.cancelled, true);
  assert.equal(response.groupClean, true);
  assert.equal(existsSync(marker), false);
});

test('explicit native and local approval refusals stop, while ordinary tool errors continue', async () => {
  const { runDriver } = await import('../bench/driver.mjs');
  for (const content of ["Computer Use is not allowed to use the app 'Terminal' for safety reasons.",
    'Computer Use was not approved to use Safari',
    "The user didn't allow dragging in Safari. Stop and tell them; don't work around it.",
    'The user did not approve this document', 'approval declined', 'permission denied',
    'AX fixture read failed: -25204']) {
    const controller = new AbortController();
    let refusals = 0;
    const frame = { message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: content }] }] } };
    const response = await runDriver(process.execPath, ['-e', `
      console.log(${JSON.stringify(JSON.stringify(frame))});
      setTimeout(() => console.log(JSON.stringify({type:'result', result:'continued'})), 150);
    `], { format: 'stream-json', signal: controller.signal, timeoutMs: 2000, graceMs: 500,
      onPermissionRefusal: () => { refusals++; controller.abort(); } });
    const ordinary = content.startsWith('AX fixture');
    assert.equal(refusals, ordinary ? 0 : 1, content);
    assert.equal(response.cancelled, !ordinary, content);
    assert.equal(response.groupClean, true);
    if (ordinary) assert.equal(response.out.result, 'continued');
  }
});
