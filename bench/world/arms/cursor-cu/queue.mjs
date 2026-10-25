// CQ1 serial qualification. Importing this module never starts a runner or reads host state.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = fileURLToPath(import.meta.url);
const W = join(homedir(), 'Projects/sleight-wt');
// The release build's own harness, frozen during the sitting (one build for every queue).
export const ROOT = join(W, 'p143');
export const OUT = join(W, 'race-1017/cursor150');
export const NATIVE = 'calculator-click,calculator-menu,textedit-save,textedit-drag,finder-move,preview-read,textedit-calculator,word-edit,excel-edit,vscode-edit,textedit-edit,finder-rename,finder-create-folder,textedit-two-windows,textedit-window-drag,textedit-replace-save,textedit-insert-line,word-memo,word-brief,textedit-notes-table,cc-list-native';
export const CHROME = 'form-travel,form-settings,form-checkout,form-settings-helium,shipping-link,size-guide,demoid,mobile,handoff,inject-order,inject-mail,wikipedia,mdn';
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const atomic = (file, value) => { writeFileSync(file + '.tmp', value, { mode: 0o600 }); renameSync(file + '.tmp', file); };
const git = (root, ...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

export function readSteps(file) {
  const steps = readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    const row = line.trim();
    if (!row || row.startsWith('#')) return [];
    const [id, kind, tasks, extra] = row.split(/\s+/);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !['probe', 'native', 'chrome'].includes(kind) || extra ||
        (kind === 'probe' ? tasks !== '-' : !/^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/.test(tasks ?? '')))
      throw Error(`Bad step at ${file}:${index + 1}`);
    return [{ id, kind, tasks: kind === 'probe' ? [] : tasks.split(',') }];
  });
  if (steps.length !== 7 || steps[0].kind !== 'probe' || steps.slice(1).some(s => s.kind === 'probe') ||
      new Set(steps.map(s => s.id)).size !== steps.length) throw Error('Expected probe first, then six unique rounds');
  for (const [kind, expected] of [['native', NATIVE], ['chrome', CHROME]]) {
    const rounds = steps.filter(s => s.kind === kind);
    if (rounds.length !== 3 || rounds.some(s => s.tasks.join(',') !== expected)) throw Error(`Expected three exact ${kind} task lists`);
  }
  return steps;
}

export function invocation(step, { root = ROOT, out = OUT } = {}) {
  const result = join(out, step.id + (step.kind === 'chrome' ? '' : '.json'));
  let command = 'node', args;
  if (step.kind === 'probe') args = ['bench/world/arms/cursor-cu/probe.mjs', '--owner-away', '--out', result];
  else if (step.kind === 'native') args = ['bench/run.mjs', '--suite', 'world', '--arm', 'cursor-cu', '--tasks', step.tasks.join(','),
    '--runs', '1', '--model', 'Grok 4.7 High', '--effort', 'high', '--owner-away', '--no-hub', '--out', result];
  else {
    command = '/bin/sh';
    args = ['bench/fowl/rounds.sh', '--surface', 'cursor-cu', '--real-browser', 'chrome', '--only', step.tasks.join(','),
      '--model', 'Grok 4.7 High', '--effort', 'high', '--owner-away', '--no-hub', '--out', result];
  }
  return { root, command, args, result };
}

export function cleanEnv(config, host = process.env) {
  return { ...Object.fromEntries(Object.entries(host).filter(([key]) => !key.startsWith('CLAUDE'))),
    CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1' };
}
export function commandText(call, config) {
  const unset = [...new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_AGENT_SDK_VERSION',
    ...Object.keys(process.env).filter(k => k.startsWith('CLAUDE'))])].sort();
  return `cd ${quote(call.root)} && env ${unset.map(k => '-u ' + quote(k)).join(' ')} ` +
    `CLAUDE_CONFIG_DIR=${config ? quote(config) : '"$cfg"'} DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 ` +
    `${[call.command, ...call.args].map(quote).join(' ')} < /dev/null`;
}

function nativeRows(result, tasks) {
  const rows = result.results;
  if (result.groupClean !== true || !Array.isArray(rows) || rows.length !== tasks.length ||
      tasks.some(t => rows.filter(r => r.task === t && r.arm === 'cursor-cu' && r.run === 1).length !== 1) ||
      rows.some(r => r.groupClean !== true || r.cleanupUnconfirmed || r.liveLockKept || r.safetyStop || r.out?.safetyStop || r.approvalStop ||
        r.permissionPrompt || r.permissionRefusal || r.observerError || r.appDialog || r.cancelled || r.skipped || r.outcome ||
        typeof r.passed !== 'boolean' || !Number.isFinite(r.seconds) || r.seconds < 0)) throw Error('Native round incomplete, stopped or cleanup unproved');
  return rows;
}
function chromeRows(folder, tasks) {
  if (['failure.json', 'harness-failure.json'].some(f => existsSync(join(folder, f)))) throw Error('Chrome STOP or harness failure');
  const rows = json(join(folder, 'results.json')), cleanup = json(join(folder, 'cleanup.json'));
  readFileSync(join(folder, 'report.md'));
  if (cleanup.browserClosed !== true || cleanup.profileDeleted !== true || !Array.isArray(rows) || rows.length !== tasks.length ||
      tasks.some(t => rows.filter(r => r.task?.name === t && r.surface === 'cursor-cu').length !== 1) ||
      rows.some(r => r.status !== 'ran' || r.run?.groupClean !== true || r.run?.safetyStop || r.run?.cancelled ||
        typeof r.outcome?.ok !== 'boolean')) throw Error('Chrome round incomplete, stopped or cleanup unproved');
  return rows;
}
export function completed(step, call, runnerRc, text = '') {
  if (![0, 1].includes(runnerRc) || /^(?:STOP\b|Pass cleanup failed:|Cleanup unproved|Cursor cleanup unverified|Live lock:)/m.test(text))
    throw Error(`Runner stopped or crashed (exit ${runnerRc})`);
  let files, rows;
  const chromeFiles = folder => ['results.json', 'cleanup.json', 'report.md'].map(f => join(folder, f));
  if (step.kind === 'native') {
    rows = nativeRows(json(call.result), step.tasks); files = [call.result];
  } else if (step.kind === 'chrome') {
    rows = chromeRows(call.result, step.tasks); files = chromeFiles(call.result);
  } else {
    if (runnerRc !== 0) throw Error('Probe failed; qualification must stop');
    const probe = json(call.result);
    if (probe.failed !== false || probe.results?.length !== 2 || probe.results.some(r => r.failed || r.groupClean === false)) throw Error('Probe incomplete or failed');
    const native = nativeRows(json(call.result + '.native.json'), ['textedit-edit']);
    const chrome = chromeRows(call.result + '.chrome', ['mdn']);
    if (native.some(r => !r.passed) || chrome.some(r => !r.outcome.ok)) throw Error('Probe tasks must both pass');
    rows = [...native, ...chrome]; files = [call.result, call.result + '.native.json', ...chromeFiles(call.result + '.chrome')];
  }
  return { result: call.result, taskCount: rows.length, failedTasks: rows.filter(r => r.passed === false || r.outcome?.ok === false).length,
    evidence: Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])) };
}

export function identity(script, steps, root = ROOT) {
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw Error(`Tracked changes in ${root}`);
  return { build: git(root, 'rev-parse', 'HEAD'), queueHash: hash(readFileSync(script)),
    helperHash: hash(readFileSync(HERE)), stepsHash: hash(JSON.stringify(steps)) };
}

export async function execute(call, logFile, { planning = false, onChild = () => {} } = {}) {
  const config = mkdtempSync('/tmp/lane-claude-'); let fd;
  try {
    if (logFile) { fd = openSync(logFile, 'a', 0o600); writeFileSync(fd, commandText(call, config) + '\n'); }
    else if (planning) console.log(commandText(call, config));
    return await new Promise(resolveExit => {
      let spawnFailed = false;
      const child = spawn(call.command, call.args, { cwd: call.root, env: cleanEnv(config), stdio: ['ignore', fd ?? 'inherit', fd ?? 'inherit'] });
      onChild(child);
      child.once('error', error => {
        spawnFailed = true;
        if (fd !== undefined) writeFileSync(fd, `spawn failed: ${error.message}\n`);
      });
      child.once('close', (code, signal) => { onChild(undefined); resolveExit({ code: spawnFailed ? 127 : code ?? 130, signal }); });
    });
  } finally { if (fd !== undefined) closeSync(fd); rmSync(config, { recursive: true, force: true }); }
}

export async function admission(preflight) {
  let interrupted = false;
  const stop = () => { interrupted = true; }, hangup = () => {};
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', hangup);
  try {
    // Admission only reads state and may compile the fixed host helper. Let those owned
    // bounded children settle before this process exits, including after an interrupt.
    await preflight(); return interrupted ? 130 : 0;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', hangup);
  }
}

// Tests inject only an in-memory runtime here. CLI execution has no alternate root, inspector or runner.
export async function runQueue({ script, steps, out = OUT, root = ROOT, runtime = {} }) {
  const identify = runtime.identify ?? (() => identity(script, steps, root));
  const held = runtime.held ?? (() => existsSync('/tmp/sleight-hold'));
  const locked = runtime.locked ?? (() => existsSync('/tmp/sleight-live.lock'));
  const pause = runtime.pause ?? (() => sleep(1000));
  const run = runtime.execute ?? execute;
  const pin = identify(), pinText = JSON.stringify(pin);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const owner = join(out, '.queue-owner');
  mkdirSync(owner); // Refuse a concurrent or uncollected queue, even when its PID looks stale.
  writeFileSync(join(owner, 'pid'), String(process.pid));
  const log = text => { const line = `${new Date().toISOString()} ${text}`; appendFileSync(join(out, 'queue.log'), line + '\n'); console.log(line); };
  let child, interrupted = false;
  const interrupt = () => { if (interrupted) return; interrupted = true; child?.kill('SIGINT'); };
  const hangup = () => log('ignored SIGHUP');
  const onChild = value => { child = value; if (child && interrupted) child.kill('SIGINT'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); process.on('SIGHUP', hangup);
  try {
    const identityFile = join(out, 'queue-identity.json');
    if (existsSync(identityFile)) {
      if (JSON.stringify(json(identityFile)) !== pinText) throw Error('Queue, steps or source changed since first launch');
    } else atomic(identityFile, JSON.stringify(pin, null, 2) + '\n');
    for (const step of steps) {
      if (interrupted) return 130;
      const stem = join(out, step.id), call = invocation(step, { root, out });
      if (existsSync(stem + '.rc') && readFileSync(stem + '.rc', 'utf8').trim() === '0') {
        const receipt = json(stem + '.receipt.json');
        const evidence = completed(step, call, receipt.runnerRc, readFileSync(stem + '.log', 'utf8'));
        if (receipt.rc !== 0 || receipt.pin !== pinText || JSON.stringify(receipt.completion) !== JSON.stringify(evidence)) throw Error(`${step.id}: invalid saved receipt`);
        log(`skip ${step.id} (done; ${evidence.failedTasks} failed tasks retained)`); continue;
      }
      let loggedHold = false;
      while (held()) {
        if (!loggedHold) { log(`wait ${step.id}: sleight-hold is active`); loggedHold = true; }
        if (interrupted) return 130;
        await pause();
      }
      if (interrupted) return 130;
      if (JSON.stringify(identify()) !== pinText) throw Error('Source changed during queue');
      if (locked()) throw Error('sleight live lock is held; inspect cleanup before resuming');
      // Preserve every stopped attempt, including the probe's child output banks.
      const suffixes = ['', '.json', '.json.native.json', '.json.chrome', '.log', '.rc', '.receipt.json'];
      const artifacts = suffixes.filter(s => existsSync(stem + s));
      if (artifacts.length) {
        const archive = join(out, 'aborted', step.id + '-' + Date.now()); mkdirSync(archive, { recursive: true, mode: 0o700 });
        for (const suffix of artifacts) renameSync(stem + suffix, join(archive, step.id + suffix));
      }
      const logFile = stem + '.log';
      log(`start ${step.id} kind=${step.kind} build=${pin.build}`);
      const startedAt = new Date().toISOString();
      // The existing project preflight distinguishes the copy by exact executable and launch identity.
      // It refuses the owner's Cursor and pre-existing helper without quitting either process.
      const preflight = { root, command: 'node', args: ['bench/world/arms/cursor-cu/queue.mjs', '--preflight'] };
      const admitted = await run(preflight, logFile, { onChild });
      let exit = admitted, rc = admitted.code ?? 130, reason, completion;
      if (rc === 0 && !admitted.signal && !interrupted) {
        // A hold or source change during preflight must not start the runner.
        if (held() || locked() || JSON.stringify(identify()) !== pinText) { rc = 1; reason = 'Hold, lock or source changed during admission'; }
        else {
          exit = await run(call, logFile, { onChild }); rc = exit.code ?? 130;
          try {
            if (interrupted || exit.signal) throw Error('Queue interrupted; wait for cleanup before resume');
            if (locked()) throw Error('Runner retained the live lock; cleanup unproved');
            if (JSON.stringify(identify()) !== pinText) throw Error('Source changed while runner was active');
            completion = completed(step, call, rc, readFileSync(logFile, 'utf8')); rc = 0;
          } catch (error) { reason = error.message; if (rc === 0) rc = 1; }
        }
      } else reason = 'Cursor admission refused or interrupted; see step log (quit your own Cursor first when named)';
      if (interrupted) rc = 130;
      const receipt = { ...step, pin: pinText, root, command: [call.command, ...call.args], startedAt, endedAt: new Date().toISOString(),
        preflightRc: admitted.code, runnerRc: exit === admitted ? null : exit.code, signal: exit.signal, rc,
        ...(reason ? { reason } : {}), ...(completion ? { completion } : {}) };
      atomic(stem + '.receipt.json', JSON.stringify(receipt, null, 2) + '\n'); atomic(stem + '.rc', rc + '\n');
      log(`end ${step.id} rc=${rc} runnerRc=${receipt.runnerRc}${reason ? ' ' + reason : ''}`);
      if (rc !== 0) return rc;
    }
    log('queue complete'); return 0;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGHUP', hangup);
    rmSync(join(owner, 'pid')); rmdirSync(owner);
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--preflight') {
    const { DesktopDriver } = await import('./desktop.mjs');
    const { armPaths } = await import('./contract.mjs');
    process.exitCode = await admission(() => new DesktopDriver().preflight({ paths: armPaths() })); return;
  }
  const [script, ...options] = argv;
  if (!script) throw Error('Use ledger/p142/cursor150/queue.sh');
  const steps = readSteps(join(dirname(resolve(script)), 'main.steps'));
  if (options.length === 1 && options[0] === '--dry-run') {
    for (const step of steps) {
      console.log(`# ${step.id} kind=${step.kind} tasks=${step.tasks.length}`);
      console.log('# Live admission: refuse the owner Cursor or any unowned Cursor/helper, then verify calibration.');
      console.log('cfg=$(mktemp -d /tmp/lane-claude-XXXXXX); ( ' + commandText(invocation(step)) + ' ); rc=$?; rm -rf "$cfg"; exit "$rc"');
    }
    console.log(`# ${steps.length} steps; 63 native + 39 Chrome qualification trials, plus the two-task probe; no runners executed`); return;
  }
  if (options[0] === '--runner-dry-run' && options.length === 2) {
    const step = steps.find(s => s.kind === options[1]);
    if (!step) throw Error('Use --runner-dry-run probe|native|chrome');
    const call = invocation(step); call.args.push('--dry-run');
    const exit = await execute(call, null, { planning: true }); process.exitCode = exit.code; return;
  }
  if (options.length) throw Error('Usage: queue.sh [--dry-run | --runner-dry-run probe|native|chrome]');
  process.exitCode = await runQueue({ script: resolve(script), steps });
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`cursor queue: ${error.message}`); process.exitCode = 1; }
}
