import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { join, basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { startHost } from './battery/runtime.mjs';
import { writeDocument } from './battery/documents.mjs';
import { tasks } from './battery/tasks.mjs';
import { probeClient } from './double-keys-client.mjs';
import { benchmarkDecision } from './approve.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { speedMarkdown, speedScope } from './app-speed-map.mjs';
import { EDITOR_FLAGS, EDITOR_SETTINGS } from './editor-profile.mjs';

const cleanupCodes = new Set(['FIXTURE_WINDOW_AMBIGUOUS', 'FOREIGN_WINDOW_ON_START', 'DOCUMENT_NOT_MATCHED', 'WINDOW_NOT_RETAINED',
  'SHEET_PRESENT', 'SHEETS_READ_FAILED', 'FIXTURE_WINDOW_NOT_RETAINED', 'CLOSE_BUTTON_MISSING', 'AXPRESS_FAILED',
  'WINDOW_STILL_PRESENT_AFTER_10S', 'SCRIPTING_NOT_OWN_FIXTURE', 'SCRIPTING_FAILED', 'WINDOW_STILL_PRESENT_AFTER_SCRIPTING',
  'APP_IDENTITY_UNCONFIRMED', 'APP_HAS_WINDOWS', 'APP_NOT_TERMINATED', 'WINDOWS_READ_FAILED', 'HOST_ABORTED', 'HOST_TIMEOUT',
  'HOST_PROCESS_UNCONFIRMED', 'HOST_RECEIPT_MISSING', 'HOST_DETAILS_MISSING', 'CLEANUP_FAILED', 'SERVER_CLEANUP_FAILED']);

// Fixed words only: a setup failure is published as codes and counts, never paths, titles or error text.
const setupCodes = new Set(['APP_EXITED', 'APP_NOT_RUNNING', 'APP_INSTANCE_AMBIGUOUS', 'APP_NOT_FINISHED_LAUNCHING', 'WINDOWS_READ_FAILED',
  'FIXTURE_WINDOW_UNIDENTIFIED', 'FIXTURE_WINDOW_ABSENT', 'FOREIGN_WINDOW_ON_START', 'FIXTURE_WINDOW_AMBIGUOUS', 'HOST_DEADLINE', 'HOST_EXITED',
  'HOST_STOP', 'FIXTURE_OPEN_FAILED', 'APP_ALREADY_RUNNING', 'FIXTURE_NOT_OPEN', 'Ref has incompatible type']);
const setupStages = new Set(['baseline', 'armed', 'open', 'retain', 'ready']);
const waitKeys = ['budgetMs', 'elapsedMs', 'polls', 'instances', 'relaunches', 'exited', 'ambiguousPolls', 'launchingPolls', 'finishedLaunching',
  'lastWindowsStatus', 'windowCount', 'pending', 'pendingDocumentStatus', 'pendingTitleStatus'];
export function setupDiagnosis(startError) {
  if (!startError || typeof startError !== 'object') return undefined;
  const out = { message: setupCodes.has(startError.message) ? startError.message : 'OTHER',
    stage: setupStages.has(startError.stage) ? startError.stage : 'other',
    windowCount: Number.isInteger(startError.windowCount) ? startError.windowCount : null };
  if (Number.isInteger(startError.axStatus)) out.axStatus = startError.axStatus;
  const wait = startError.startWait;
  if (wait && typeof wait === 'object') {
    out.startWait = {};
    for (const key of waitKeys) if (typeof wait[key] === 'boolean' || Number.isInteger(wait[key])) out.startWait[key] = wait[key];
    if (wait.windowsStatus && typeof wait.windowsStatus === 'object') out.startWait.windowsStatus = Object.fromEntries(Object.entries(wait.windowsStatus)
      .filter(([status, count]) => /^-?\d+$/.test(status) && Number.isInteger(count)));
  }
  return out;
}

const bundleId = value => value == null ? null : typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/.test(value) ? value : 'other';
// Focus and cover changes seen in the host's 200 ms samples, with the phase they happened in. sleight never takes focus
// (LAWS), but before the first engine call the only actor is the fixture app's own launch: an app that activates itself
// or puts its window over the owner's then is classified (launch-activation, launch-cover) and published, not stopped.
// A cover by the fixture app during its own cleanup is cleanup-cover, and focus leaving a self-activated fixture app during
// cleanup is quit-handoff, both published the same way.
// Focus returning to the owner's app is recorded as focus-restored. Every other change stops the run as before.
export function attentionTracker(task, { onEvent } = {}) {
  let phase = 'setup', baseline, lastFront, lastCover = false, launchActivated = false, handedOff = false;
  const tracker = { events: [], count: 0, stopped: false, setPhase(next) { phase = next; },
    observe(sample) {
      const front = bundleId(sample.front), cover = sample.targetOverOwner === true;
      let stop = false;
      const record = (kind, from, to, name) => {
        const event = { phase, hostStage: typeof sample.stage === 'string' ? sample.stage : null,
          atMs: Number.isFinite(sample.atMs) ? sample.atMs : null, kind, from, to, class: name };
        tracker.count++; if (tracker.events.length < 20) tracker.events.push(event);
        if (name === 'focus-change' || name === 'cover') stop = true;
        onEvent?.(event);
      };
      if (baseline === undefined) baseline = lastFront = front;
      else if (front !== lastFront) {
        // When the fixture app took focus at its own launch and cleanup closes or quits it, macOS hands focus to an app
        // of its choosing, not necessarily the baseline: that one change is quit-handoff.
        const handoff = phase === 'cleanup' && launchActivated && !handedOff && lastFront === task.bundle;
        const name = front !== null && front === baseline ? 'focus-restored'
          : phase === 'setup' && front === task.bundle ? 'launch-activation' : handoff ? 'quit-handoff' : 'focus-change';
        if (name === 'launch-activation') launchActivated = true;
        if (name === 'quit-handoff') handedOff = true;
        record('focus', lastFront, front, name);
        lastFront = front;
      }
      // The cover flag means the fixture app's own window lies over the owner's. During setup that is its launch, and during
      // cleanup it is the app re-showing a window as its document closes (Word, 2026-10-19). During measurement it stops.
      if (cover && !lastCover) record('cover', front, task.bundle, phase === 'setup' ? 'launch-cover' : phase === 'cleanup' ? 'cleanup-cover' : 'cover');
      lastCover = cover;
      if (stop) tracker.stopped = true;
      return stop;
    } };
  return tracker;
}

// The editor's own throwaway profile, inside the fixture folder. Its main IPC socket lives there, so the path stays short.
export function editorProfileArgs(dir) {
  const profile = join(dir, 'p'), extensions = join(dir, 'x');
  if (join(profile, '0000-shared.sock').length > 103) throw Error('FIXTURE_SETUP_FAILED');
  mkdirSync(join(profile, 'User'), { recursive: true, mode: 0o700 }); mkdirSync(extensions, { mode: 0o700 });
  writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(EDITOR_SETTINGS, null, 2), { mode: 0o600 });
  return [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, ...EDITOR_FLAGS];
}

export function validateSpeedReceipt(task, receipt) {
  if (task.fixture === 'browser') {
    if (receipt?.ownerApproved !== true || typeof receipt.browserId !== 'string' || !receipt.browserId.trim() ||
        typeof receipt.profileName !== 'string' || !receipt.profileName.trim()) throw Error('BROWSER_PROFILE_RECEIPT_REQUIRED');
    return { browserId: receipt.browserId, profileName: receipt.profileName };
  }
  if (task.fixture !== 'local-container') return {};
  if (receipt?.local !== true || typeof receipt.id !== 'string' || !receipt.id.trim() ||
      typeof receipt.marker !== 'string' || !receipt.marker.trim() || receipt.marker.length > 200) throw Error('LOCAL_CONTAINER_RECEIPT_REQUIRED');
  return { containerId: receipt.id, containerMarker: receipt.marker };
}
export function speedEnvironment(inherited) {
  const keys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']);
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => keys.has(key))),
    SLEIGHT_SURFACES: 'computer,browser', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: '', SLEIGHT_RECEIPTS: '0',
    BENCH_HOOK_LOG: '', BENCH_SUITE: 'app-speed-map', BENCH_ARM_SERVERS: JSON.stringify(['plugin:sleight:computer']) };
}
export function speedLauncher(root, env) {
  return { command: join(root, 'plugins/sleight/bin/sleight-mcp'), args: [], env, inheritEnvironment: false };
}

export function speedOutput(root, requested) {
  const resultsRoot = resolve(root, 'bench/results');
  const output = resolve(requested ?? join(resultsRoot, `am1-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (!output.startsWith(resultsRoot + '/')) throw Error('OUTPUT_OUTSIDE_BENCH_RESULTS');
  for (let path = dirname(output); path !== resolve(root); path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw Error('OUTPUT_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of [output + '.json', output + '.md']) {
    try { lstatSync(path); throw Error('OUTPUT_ALREADY_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return output;
}

// The engine helper's crash reports, by name only: a report is written as .SkyComputerUseService-<time>.ips and then
// renamed without the dot. The helper segfaulted 21 times in concurrent Excel acquisitions on 2026-10-19, and only these
// reports showed it, since sleight resends a read that met the crash once.
export const crashReportDirectory = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
export function helperCrashReports(list = () => readdirSync(crashReportDirectory)) {
  return new Set(list().filter(name => /^\.?SkyComputerUseService-[\d-]+(?:\.\d+)?\.ips$/.test(name)).map(name => name.replace(/^\./, '')));
}

export async function liveSpeedRuntime(plan, options, {
  platform = process.platform, repositoryRoot = fileURLToPath(new URL('..', import.meta.url)),
  takeLock = acquireLiveLock, makeBank = () => mkdtempSync('/private/tmp/sleight-battery-am1-'),
  startFixtureHost = startHost, makeClient = probeClient, crashReports = () => helperCrashReports(),
} = {}) {
  if (platform !== 'darwin') throw Error('MACOS_REQUIRED');
  if (existsSync('/tmp/sleight-hold')) throw Error('HOLD');
  for (const task of plan.apps) speedScope(plan, task);
  const receipts = options.receipts ? JSON.parse(readFileSync(options.receipts, 'utf8')) : {};
  // Validate account boundaries before any child, fixture, server or lock.
  for (const task of plan.apps) validateSpeedReceipt(task, receipts[task.id]);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const root = repositoryRoot, output = speedOutput(root, options.out);
  const unlock = await takeLock(undefined, { signal: controller.signal });
  let bank;
  try { bank = makeBank(); }
  catch (error) { await unlock(); throw error; }
  const env = { ...speedEnvironment(process.env), BENCH_ROOT: root, BENCH_OWNER_PRESENT: plan.ownerPresent ? '1' : '' };
  const resources = new Set(); let activeSessions = 0, closed = false, cleanupFault = false, attentionFault = false, approvalStopped = false;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const held = () => controller.signal.aborted || attentionFault || approvalStopped || existsSync('/tmp/sleight-hold');
  const boundary = () => { if (held()) throw Error('HOLD'); };
  return {
    held, now: () => performance.now(), log: line => console.error(line),
    helperCrashMark: () => crashReports(),
    helperCrashesSince: mark => [...crashReports()].filter(name => !mark.has(name)).length,
    async prepare(task) {
      boundary();
      speedScope(plan, task);
      const dir = join(bank, randomUUID()); mkdirSync(dir, { mode: 0o700 });
      const fixture = { dir, task, ...validateSpeedReceipt(task, receipts[task.id]) };
      resources.add(fixture);
      try {
        const name = 'AM1-' + randomUUID();
        if (['txt', 'docx', 'xlsx'].includes(task.fixture)) {
          fixture.path = fixture.target = join(dir, name + '.' + task.fixture);
          // The unique name without its extension: some apps title a document window without it. The document's own text
          // starts with it too, so the scroll target is the scroll area around that text (Word also has a Ribbon one).
          fixture.marker = fixture.windowMarker = fixture.scrollMarker = name;
          writeDocument(fixture.path, task.fixture, name);
        } else if (task.fixture === 'workspace' || task.fixture === 'folder') {
          fixture.target = join(dir, name); mkdirSync(fixture.target);
          fixture.marker = fixture.windowMarker = name;
          fixture.scrollMarker = name + '-row';
          if (task.fixture === 'folder') fixture.requiredText = fixture.scrollMarker;
          writeFileSync(join(fixture.target, fixture.scrollMarker), name + '\n'.repeat(100), { mode: 0o600 });
          if (task.fixture === 'workspace') {
            // The folder goes in argv: with --new-window and no path there, VS Code opens an empty window instead.
            fixture.launchArgs = [...editorProfileArgs(dir), fixture.target]; fixture.targetInArgs = true;
            fixture.ownedArg = fixture.launchArgs[0];
            // The instance runs on this fixture's own profile, so any of its regions may take the measured scroll.
            fixture.anyRegion = true;
          }
        } else if (task.fixture === 'browser') {
          fixture.marker = name;
          const server = createServer((req, res) => {
            if (req.url !== '/fixture' || req.method !== 'GET') { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
            res.end(`<!doctype html><title>${name}</title><div style="width:400px;height:400px;overflow:auto">${'<p>AM1 fixture</p>'.repeat(200)}</div>`);
          });
          fixture.closeServer = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          fixture.url = `http://127.0.0.1:${server.address().port}/fixture`;
        }
        fixture.requireStopped = task.fixture === 'workspace';
        fixture.requireRunning = ['existing', 'local-container', 'browser'].includes(task.fixture);
        fixture.attention = attentionTracker(task, { onEvent: event =>
          console.error(`AM1_ATTENTION ${task.id} ${event.class} phase=${event.phase} host=${event.hostStage} from=${event.from} to=${event.to} atMs=${event.atMs}`) });
        fixture.onSample = sample => { if (fixture.attention.observe(sample)) attentionFault = true; };
        fixture.hostAttempted = true;
        // No AppleScript fallback in cleanup: it would send Apple events to an app that may lack an Automation grant (LAWS).
        fixture.host = await startFixtureHost({ bundle: task.bundle, fixtureKind: fixture.path ? 'doc-file' : 'read', noScripting: true }, fixture, controller.signal);
        // How long the app took to show an identified fixture window, from the host's readiness receipt.
        fixture.setupWaitMs = fixture.host.startup?.waitMs ?? null; fixture.setupRelaunches = fixture.host.startup?.relaunches ?? null;
        return fixture;
      } catch (error) {
        let serverClean = true;
        try { await fixture.closeServer?.(); } catch { serverClean = false; }
        const confirmed = (!fixture.hostAttempted || error.hostCleanup?.confirmed === true) && serverClean;
        if (confirmed) resources.delete(fixture); else cleanupFault = true;
        const safe = Error(/^(APP_ALREADY_RUNNING|FIXTURE_NOT_OPEN)$/.test(error.message) ? error.message : 'FIXTURE_SETUP_FAILED');
        safe.cleanupConfirmed = confirmed;
        if (fixture.attention?.events.length) safe.attention = fixture.attention.events;
        const details = error.hostCleanup?.details;
        if (details) {
          safe.setup = setupDiagnosis(details.startError);
          safe.cleanupReasons = [...new Set([...(details.reasons ?? []), ...(details.windows ?? []).flatMap(row => row.reasons ?? [])]
            .filter(reason => cleanupCodes.has(reason)))];
        }
        throw safe;
      }
    },
    async openSession(task, fixture) {
      boundary();
      speedScope(plan, task);
      const aliases = tasks.find(item => item.bundle === task.bundle)?.aliases ?? [];
      let client;
      try { client = await makeClient(speedLauncher(root, env), { relay: false, record: () => {}, timeoutMs: 90000,
        approve: async params => {
          let reply = { action: 'decline' };
          const app = /^Allow Computer Use to use "(.+)"\?$/.exec(params.message ?? '')?.[1];
          if ([task.app, task.bundle, ...aliases].includes(app)) {
            const decision = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message: params.message,
              requested_schema: params.requestedSchema, mode: params.mode }, env)?.hookSpecificOutput;
            if (decision) reply = { action: decision.action, ...(decision.content && { content: decision.content }) };
          } else if (task.fixture === 'browser' && params.mode !== 'url' &&
              params.message === `Allow Browser use to access ${new URL(fixture.url).origin}?`) {
            const properties = params.requestedSchema?.properties ?? {}, required = params.requestedSchema?.required ?? [];
            const keys = Object.keys(properties), content = {};
            let valid = keys.length <= 1 && keys.every(key => ['choice', 'persist'].includes(key)) && required.every(key => keys.includes(key));
            for (const key of keys) {
              const choices = properties[key].enum ?? [];
              if (choices.includes('session')) content[key] = 'session';
              else if (choices.includes('once')) content[key] = 'once';
              else valid = false;
            }
            if (valid) reply = { action: 'accept', content };
          }
          if (reply.action !== 'accept') approvalStopped = true;
          return reply;
        } }); } catch (error) { if (error.cleanupConfirmed !== true) cleanupFault = true; throw error; }
      activeSessions++;
      let sessionClosed = false;
      // The first engine call ends the launch phase: from here on any focus or cover change is sleight's to answer for.
      return { js: code => { fixture.attention?.setPhase('measure'); return client.call('js', { code, timeout_ms: 60000, title: 'AM1 counts only' }); },
        close: async () => {
          if (sessionClosed) return; sessionClosed = true;
          let tabClosed = true;
          try {
            if (task.fixture === 'browser') tabClosed = !(await client.call('js', { code: 'if (typeof am1Tab !== "undefined") await am1Tab.close();', timeout_ms: 10000 })).isError;
          } catch { tabClosed = false; }
          try { await client.close(); activeSessions--; }
          catch { cleanupFault = true; throw Error('SESSION_CLEANUP_UNCONFIRMED'); }
          if (!tabClosed) { cleanupFault = true; throw Error('TAB_CLEANUP_UNCONFIRMED'); }
        } };
    },
    async closeFixture(fixture) {
      let cleanup;
      fixture.attention?.setPhase('cleanup');
      try { cleanup = await fixture.host.finish(); }
      catch { cleanup = { confirmed: false, samples: [], details: { reasons: ['CLEANUP_FAILED'] } }; }
      const reasons = [...new Set([...(cleanup.details?.reasons ?? []), ...(cleanup.details?.windows ?? []).flatMap(row => row.reasons ?? [])]
        .filter(reason => cleanupCodes.has(reason)))];
      try { await fixture.closeServer?.(); } catch { cleanup.confirmed = false; reasons.push('SERVER_CLEANUP_FAILED'); }
      const confirmed = cleanup.confirmed === true;
      if (confirmed) resources.delete(fixture); else cleanupFault = true;
      // Per-window cleanup codes for the report: booleans and AX codes only, never a document path or title.
      const windows = (cleanup.details?.windows ?? []).slice(0, 10).map(row => Object.fromEntries([
        ...['retained', 'present', 'matched', 'gone', 'stillPresentAfter10s'].filter(key => typeof row[key] === 'boolean').map(key => [key, row[key]]),
        ...['documentStatus', 'sheetStatus', 'axPressStatus', 'scriptingStatus'].filter(key => Number.isInteger(row[key])).map(key => [key, row[key]]),
        ['reasons', (row.reasons ?? []).filter(reason => cleanupCodes.has(reason))]]));
      return { confirmed, reasons, windows, focusChanged: fixture.attention?.stopped === true, attention: fixture.attention?.events ?? [] };
    },
    async publish(report) {
      report.approvalStopped = approvalStopped;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      writeFileSync(output + '.md', speedMarkdown(report), { mode: 0o600 });
    },
    async close() {
      if (closed) return; closed = true;
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      if (resources.size || activeSessions || cleanupFault) {
        console.error('AM1_CLEANUP_UNCONFIRMED: retained bank ' + bank + ' and /tmp/sleight-live.lock');
        throw Error('CLEANUP_UNCONFIRMED');
      }
      removeTemp(bank); if (existsSync(bank)) throw Error('TEMP_CLEANUP_UNCONFIRMED'); await unlock();
    },
  };
}
