#!/usr/bin/env node
// Live, operator-run probe. Lane validation uses --compile-only and never opens its card.
// Run: CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/consent-guard-probe.mjs
// JSONL stdout is the receipt. Redirect it to an evidence file if it must outlive temporary-state cleanup.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const hostUrl = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
export function probeHostSource(source = readFileSync(hostUrl, 'utf8')) {
  const entry = '// No arguments: the consent host.';
  const refusal = 'func refuseConsentInput(_ button: NSButton? = nil, tooSoon: Bool = false) {';
  if (source.split(entry).length !== 2 || source.split(refusal).length !== 2) throw new Error('CONSENT_PROBE_SOURCE_DRIFT');
  // Only add a refusal receipt and replace the entry point in the private build. The production guard, action
  // dispatch, feedback and modal implementation remain intact. No production test switch is installed.
  return source.slice(0, source.indexOf(entry)).replace(refusal, refusal + '\n    probeReceipt("refused", ["reason": tooSoon ? "timing" : "provenance"])') +
    readFileSync(new URL('./consent-guard-card.swift', import.meta.url), 'utf8');
}
export function compileProbe(directory) {
  const swift = join(directory, 'main.swift'), host = join(directory, 'consent-host'), poster = join(directory, 'poster');
  writeFileSync(swift, probeHostSource(), { flag: 'wx', mode: 0o600 });
  for (const [source, binary] of [[swift, host], [fileURLToPath(new URL('./consent-guard-poster.swift', import.meta.url)), poster]]) {
    const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'cache'), source, '-o', binary],
      { encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) throw new Error(result.stderr || 'CONSENT_PROBE_COMPILE_FAILED');
  }
  return { host, poster };
}
export function stepVerdict(receipts) {
  if (receipts.some(record => record.outcome === 'accepted')) return 'accepted';
  if (receipts.some(record => record.outcome === 'refused' && record.reason !== 'timing')) return 'refused';
  if (receipts.some(record => record.outcome === 'refused' && record.reason === 'timing')) return 'too-soon';
  return 'no-receipt';
}

export async function runProbe({ directory, binaries, say = record => console.log(JSON.stringify(record)) }) {
  const child = spawn(binaries.host, [], { cwd: directory,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: directory, TMPDIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let ended = false, failure, interrupted = false;
  const abort = () => { interrupted = true; };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const closed = new Promise(resolve => {
    child.once('error', error => { failure = error; ended = true; });
    child.once('exit', code => { ended = true; if (code !== 0) failure = new Error(`CONSENT_HOST_EXIT_${code}`); });
    child.once('close', resolve);
  });
  child.stdin.on('error', error => { failure = error; });
  const records = [], lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const record = JSON.parse(line); records.push(record); say({ cardReceipt: record }); }
    catch { failure = new Error('INVALID_CARD_RECEIPT'); }
  });
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  const until = async (predicate, timeout) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (interrupted) throw new Error('CONSENT_PROBE_INTERRUPTED');
      if (failure) throw failure;
      if (ended) throw new Error('CONSENT_HOST_CLOSED');
      if (Date.now() >= deadline) return false;
      await pause();
    }
    return true;
  };
  const send = command => child.stdin.write(JSON.stringify(command) + '\n');
  const arm = async step => {
    const start = records.length;
    send({ step });
    if (!await until(() => records.slice(start).some(r => r.outcome === 'armed' && r.step === step), 10000)) throw new Error('CARD_ARM_TIMEOUT');
    return start;
  };
  let ready;
  const waitReady = async start => {
    if (!await until(() => records.slice(start).some(r => r.outcome === 'ready'), 10000)) throw new Error('CARD_READY_TIMEOUT');
    ready = records.slice(start).findLast(r => r.outcome === 'ready');
  };
  const steps = [];
  try {
    await waitReady(0);
    for (const mode of ['ax', 'pid', 'hid', 'hidpid']) {
      const start = await arm(mode);
      // Each poster gets a fully armed card, including a newly shown replacement card.
      await new Promise(resolve => setTimeout(resolve, 600));
      const posted = spawnSync(binaries.poster, [mode, String(ready.pid), String(ready.x), String(ready.y)],
        { cwd: directory, encoding: 'utf8', timeout: 15000 });
      say({ poster: mode, exit: posted.status, attempted: posted.stdout?.trim(), error: posted.stderr?.trim() });
      await until(() => stepVerdict(records.slice(start)) !== 'no-receipt', 5000);
      // Leave time for mouse-up delivery and re-arming after an unexpected acceptance.
      await new Promise(resolve => setTimeout(resolve, 500));
      const verdict = stepVerdict(records.slice(start));
      const ok = posted.status === 0 && verdict === 'refused';
      steps.push({ step: mode, verdict, ok }); say(steps.at(-1));
      if (verdict === 'accepted' || records.slice(start).some(r => r.outcome === 'cancelled')) await waitReady(start);
    }
    for (const [step, prompt] of [['person-click', 'click Always allow now'],
      ['person-return', 'focus the confirmation field, type the displayed Always allow word, then press Return']]) {
      const start = await arm(step);
      await new Promise(resolve => setTimeout(resolve, 600));
      console.error(prompt);
      const received = await until(() => records.slice(start).some(r => ['accepted', 'refused', 'cancelled'].includes(r.outcome)), 120000);
      const verdict = stepVerdict(records.slice(start));
      steps.push({ step, verdict, ok: received && verdict === 'accepted' }); say(steps.at(-1));
      if (verdict === 'accepted' || records.slice(start).some(r => r.outcome === 'cancelled')) await waitReady(start);
    }
    return { passed: steps.every(step => step.ok), steps };
  } finally {
    // EOF asks the owned host to abort its modal, hide the card and exit. Wait before deleting its state.
    if (!ended && !child.stdin.destroyed) { send({ finish: 'yes' }); child.stdin.end(); }
    await closed;
    lines.close();
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (process.platform !== 'darwin' || (args.length && (args.length !== 1 || args[0] !== '--compile-only'))) {
    console.error('usage on macOS: node bench/consent-guard-probe.mjs [--compile-only]'); process.exitCode = 2;
  } else {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-consent-guard-')));
    try {
      const binaries = compileProbe(directory);
      if (args[0] === '--compile-only') console.log('consent host and poster compiled; neither launched');
      else {
        console.error('Only the fake consent card is targeted. Do not interact until the click prompt. Existing AX/post-event permissions are required; this probe requests none.');
        const result = await runProbe({ directory, binaries });
        console.log(JSON.stringify({ summary: result }));
        process.exitCode = process.exitCode || (result.passed ? 0 : 1);
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
