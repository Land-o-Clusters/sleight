import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkBrowserOwner } from './real-browser.mjs';

const execute = promisify(execFile), limit = 16 * 1024 * 1024;
const invalid = () => Error('BENCH_FIREFOX_SESSIONSTORE_INVALID');
export function decodeMozLz4(bytes) {
  if (bytes.length < 13 || !bytes.subarray(0, 8).equals(Buffer.from('mozLz40\0'))) throw invalid();
  const size = bytes.readUInt32LE(8);
  if (!size || size > limit || bytes.length > limit) throw invalid();
  const out = Buffer.alloc(size); let source = 12, dest = 0;
  const length = initial => {
    let value = initial;
    if (initial === 15) {
      let next;
      do { if (source >= bytes.length) throw invalid(); next = bytes[source++]; value += next; } while (next === 255);
    }
    return value;
  };
  while (source < bytes.length) {
    const token = bytes[source++], literals = length(token >>> 4);
    if (source + literals > bytes.length || dest + literals > size) throw invalid();
    bytes.copy(out, dest, source, source + literals); source += literals; dest += literals;
    if (source === bytes.length) break;
    if (source + 2 > bytes.length) throw invalid();
    const offset = bytes.readUInt16LE(source); source += 2;
    const count = length(token & 15) + 4;
    if (!offset || offset > dest || dest + count > size) throw invalid();
    for (let i = 0; i < count; i++) { out[dest] = out[dest - offset]; dest++; }
  }
  if (dest !== size) throw invalid();
  try { return JSON.parse(out.toString('utf8')); } catch { throw invalid(); }
}

export function firefoxTabs(state) {
  if (!Array.isArray(state?.windows)) throw invalid();
  const tabs = {};
  for (const [w, window] of state.windows.entries()) {
    if (!Array.isArray(window.tabs)) throw invalid();
    for (const [t, tab] of window.tabs.entries()) {
      if (!Number.isSafeInteger(tab.index) || tab.index < 1 || !Array.isArray(tab.entries)) throw invalid();
      const entry = tab.entries[tab.index - 1];
      if (typeof entry?.url !== 'string' || !entry.url) throw invalid();
      tabs[`firefox:${w + 1}:${t + 1}`] = { url: entry.url, title: entry.title || '', initialUrl: tab.entries[0]?.url };
    }
  }
  return tabs;
}

function readInventory(profile, notBefore = 0, recovery = false) {
  // A clean quit moves recovery to sessionstore.jsonlz4. Never read previous or
  // backup sessions, which could falsely certify a page from an earlier task.
  const sources = [join(profile, 'sessionstore.jsonlz4')];
  if (recovery) sources.push(join(profile, 'sessionstore-backups/recovery.jsonlz4'));
  const source = sources.find(existsSync);
  if (!source) throw Error('BENCH_FIREFOX_SESSIONSTORE_MISSING');
  for (let path = dirname(source); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    if (path === profile) break;
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw invalid();
  if (stat.mtimeMs < notBefore) throw Error('BENCH_FIREFOX_SESSIONSTORE_STALE');
  return { tabs: firefoxTabs(decodeMozLz4(readFileSync(source))), source };
}

const prefs = {
  'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0,
  'browser.startup.homepage_override.mstone': 'ignore', 'startup.homepage_welcome_url': '',
  'startup.homepage_welcome_url.additional': '', 'browser.aboutwelcome.enabled': false,
  'browser.shell.checkDefaultBrowser': false, 'browser.sessionstore.resume_from_crash': false,
  'browser.sessionstore.resume_session_once': false, 'browser.sessionstore.interval': 250,
  'browser.warnOnQuit': false, 'browser.tabs.warnOnClose': false, 'browser.tabs.warnOnCloseOtherTabs': false,
  'toolkit.telemetry.enabled': false, 'toolkit.telemetry.unified': false,
  'datareporting.healthreport.uploadEnabled': false, 'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'app.update.auto': false, 'app.update.staging.enabled': false, 'app.update.background.scheduling.enabled': false,
  'app.update.interval': 2147483647, 'extensions.update.enabled': false,
  'extensions.systemAddon.update.enabled': false,
  'app.normandy.enabled': false, 'app.shield.optoutstudies.enabled': false,
  // The start marker is a data: page from the command line. Firefox 157 blocks that
  // load by default and records the URL as the title (measured 2026-10-17).
  'security.data_uri.block_toplevel_data_uri_navigations': false,
};

export function firefoxProfileMetadata(home = homedir()) {
  return Object.fromEntries(['Library/Application Support/Firefox', 'Library/Caches/Mozilla'].map(relative => {
    const root = join(home, relative);
    try {
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('unsafe metadata root');
      return [root, readdirSync(root).sort().map(name => ({ name, mtimeMs: lstatSync(join(root, name)).mtimeMs }))];
    } catch (error) { return [root, { error: error.code || error.message }]; }
  }));
}

// pid, start time and full argv string for every process. LC_ALL=C pins lstart's format.
export async function processArguments() {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,lstart=,args='],
    { encoding: 'utf8', timeout: 5000, maxBuffer: limit, env: { ...process.env, LC_ALL: 'C' } });
  if (!stdout.trim()) throw Error('BENCH_PROCESS_LIST_UNAVAILABLE');
  return stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\w{3} \w{3} +\d{1,2} \d\d:\d\d:\d\d \d{4})\s*(.*)$/.exec(line);
    const startedMs = match && Date.parse(match[2]);
    if (!match || !Number.isFinite(startedMs)) throw Error('BENCH_PROCESS_LIST_INVALID');
    return { pid: Number(match[1]), startedMs, args: match[3] };
  });
}

// The round's profile path is unique, so the exact "-profile <root>" pair names our Firefox.
export const ownsProfile = (plan, row) => typeof row?.args === 'string' && row.args.startsWith(plan.executable + ' ') &&
  (row.args + ' ').includes(` -profile ${plan.profileRoot} `);

export function requestFirefoxQuit(executable, browser) {
  return execute(executable, [String(browser.pid), browser.executable, browser.profileRoot,
    String(Math.floor(browser.startedMs / 1000))], { timeout: 5000 });
}

async function quitHelper(root) {
  const executable = join(root, 'quit-firefox'), cache = join(root, 'module-cache');
  try {
    await execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache,
      fileURLToPath(new URL('./firefox-quit.swift', import.meta.url)), '-o', executable], { timeout: 60000 });
  } finally { rmSync(cache, { recursive: true, force: true }); }
  return browser => requestFirefoxQuit(executable, browser);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Firefox spawned as our child is denied its profile ("Profile Missing"), so it
// starts through LaunchServices and is tracked by pid, start time and profile argv.
// This lifecycle owns that process, the empty-profile seed, and its quit helper.
// Reset never reads an owner profile and never reuses a task's browsing state.
export async function launchFirefox(plan, { openBrowser = (command, args) => execute(command, args, { timeout: 15000 }),
  listProcesses, listArguments = processArguments, signalProcess = (pid, signal) => process.kill(pid, signal),
  timeoutMs, stopMs, quitMs, quitBrowser, ownerCheck, profileMetadata = firefoxProfileMetadata }) {
  const root = dirname(plan.profileRoot);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  let current, stopping;
  const owned = () => current && !current.closed;
  const browser = { ...plan, get pid() { return owned() ? current.pid : undefined; },
    get startedMs() { return owned() ? current.startedMs : undefined; }, ownerCheck, collections: [], profileAudit: {},
    reset: async () => {
      await collect();
      await start();
      return current.start;
    },
    observe: async () => {
      let refusal;
      try { browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid: browser.pid }); }
      catch (error) { browser.ownerCheck = error.ownerCheck; refusal = error; }
      const graceful = await collect();
      const unobserved = reason => ({ observed: false, tabs: {}, reason,
        unavailableGraders: ['tab retention', 'handoff', 'downloads'] });
      if (refusal) return { ...unobserved(refusal.message), ownerCheck: refusal.ownerCheck };
      if (!graceful) return unobserved('Firefox graceful quit not proven; forced or unexpected exit');
      try { return { observed: true, ...readInventory(plan.profileRoot, current.quitAt), unavailableGraders: ['downloads'] }; }
      catch (error) { return unobserved(error.message); }
    },
    stop: () => stopping ??= (async () => {
      await collect(); rmSync(root, { recursive: true });
      return { browserClosed: true, profileDeleted: true };
    })(),
  };
  // Closed means the exact pid with its recorded start time and profile argv is gone.
  const live = async () => {
    const row = (await listArguments()).find(row => row.pid === current.pid);
    if (!row || row.startedMs !== current.startedMs || !ownsProfile(plan, row)) current.closed = true;
    return !current.closed;
  };
  const wait = async ms => {
    const until = Date.now() + ms;
    while (await live() && Date.now() < until) await sleep(Math.min(50, Math.max(1, until - Date.now())));
  };
  // Signals go only to the pid that live() just matched by start time and profile argv.
  const force = async signal => { if (await live()) signalProcess(current.pid, signal); };
  const auditAfter = () => {
    browser.profileAudit.after = profileMetadata();
    browser.profileAudit.changed = JSON.stringify(browser.profileAudit.before) !== JSON.stringify(browser.profileAudit.after);
  };
  const collect = async () => {
    if (!current) return false;
    if (current.restartUnproved) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    if (!current.pid || current.closed || !(await live())) { auditAfter(); return current.graceful; }
    let requested = false;
    current.quitAt = Date.now();
    const receipt = { pid: current.pid, quit: {} }; browser.collections.push(receipt);
    try {
      try {
        const result = await quitBrowser(browser); requested = true;
        receipt.quit = { exitCode: 0, stderr: result?.stderr || '' };
      } catch (error) { receipt.quit = { exitCode: error.code ?? null, stderr: error.stderr || '', error: error.message }; }
      await wait(Math.max(0, quitMs - (Date.now() - current.quitAt)));
      receipt.quit.durationMs = Date.now() - current.quitAt;
      // launchd reaps Firefox, so its exit status is unavailable. A requested quit
      // is graceful when the pid leaves within the budget, before any signal.
      if (current.closed) { current.graceful = requested; return current.graceful; }
      await force('SIGTERM'); await wait(stopMs);
      if (!current.closed) { await force('SIGKILL'); await wait(stopMs); }
      if (!current.closed) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
      return false;
    } finally {
      receipt.collectionMs = Date.now() - current.quitAt;
      auditAfter(); receipt.profileAudit = browser.profileAudit;
    }
  };
  const start = async () => {
    rmSync(plan.profileRoot, { recursive: true, force: true }); mkdirSync(plan.profileRoot, { mode: 0o700 });
    const fresh = { ...prefs, 'app.update.lastUpdateTime.background-update-timer': Math.floor(Date.now() / 1000) };
    writeFileSync(join(plan.profileRoot, 'user.js'), Object.entries(fresh).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n', { mode: 0o600 });
    browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses });
    browser.profileAudit = { before: profileMetadata() };
    // lstart has one-second resolution; anything started before this second predates the request.
    const requestedAt = Date.now(), state = current = { closed: false, graceful: false, requestedAt,
      notBefore: Math.floor(requestedAt / 1000) * 1000 };
    try { await openBrowser(plan.command, plan.launchArgs); } catch (error) { state.error = error; }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ours = (await listArguments()).filter(row => ownsProfile(plan, row) && row.startedMs >= state.notBefore);
      if (!state.pid && !state.error && ours.length === 1) Object.assign(state, { pid: ours[0].pid, startedMs: ours[0].startedMs });
      else if (state.pid && !ours.some(row => row.pid === state.pid && row.startedMs === state.startedMs)) state.closed = true;
      if (state.closed || state.error || Date.now() >= deadline) {
        await collectStrays();
        throw Error('BENCH_BROWSER_START_FAILED', state.error ? { cause: state.error } : undefined);
      }
      if (state.pid) {
        try {
          const { tabs } = readInventory(plan.profileRoot, 0, true), values = Object.values(tabs);
          if (values.length === 1 && values[0].title === plan.marker && values[0].url === plan.args.at(-1)) state.start = tabs;
        } catch {}
      }
      if (state.start) {
        browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid: state.pid });
        return;
      }
      await sleep(50);
    }
  };
  // A failed start can leave other processes on this profile (a Firefox restart, or
  // two seen at once). Quit each exact one; an uncollected one keeps the profile.
  const collectStrays = async () => {
    current.restartUnproved = true;
    const strays = (await listArguments()).filter(row => row.pid !== current.pid && ownsProfile(plan, row) &&
      row.startedMs >= current.notBefore);
    for (const row of strays) {
      const receipt = { pid: row.pid, restarted: true, quit: {} }, started = Date.now(); browser.collections.push(receipt);
      try {
        const result = await quitBrowser({ ...plan, pid: row.pid, startedMs: row.startedMs });
        receipt.quit = { exitCode: 0, stderr: result?.stderr || '' };
      } catch (error) { receipt.quit = { exitCode: error.code ?? null, stderr: error.stderr || '', error: error.message }; }
      const deadline = started + quitMs;
      try {
        while ((await listArguments()).some(candidate => candidate.pid === row.pid && candidate.startedMs === row.startedMs)) {
          if (Date.now() >= deadline) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
          await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
        }
      } finally {
        receipt.quit.durationMs = Date.now() - started;
        auditAfter(); receipt.profileAudit = browser.profileAudit;
      }
    }
    current.restartUnproved = false;
    auditAfter();
  };
  try { quitBrowser ??= await quitHelper(root); await start(); return browser; }
  catch (error) {
    // An unproved restart may still own the profile; never erase its evidence.
    if (error.message !== 'BENCH_BROWSER_CLEANUP_UNPROVED') {
      try { await browser.stop(); } catch (cleanup) { error = cleanup; }
    }
    error.browserReceipt = { ...plan, ownerCheck: error.ownerCheck || browser.ownerCheck,
      collections: browser.collections, profileAudit: browser.profileAudit };
    throw error;
  }
}

