import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { benchmarkProfile } from '../world/arms/chrome.mjs';

const execFileAsync = promisify(execFile);

// The browsers' own data folders. The gate reads them and never launches a browser on them.
const SUPPORT = { chrome: 'Library/Application Support/Google/Chrome', helium: 'Library/Application Support/net.imput.helium' };
const EXECUTABLES = { chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', helium: '/Applications/Helium.app/Contents/MacOS/Helium' };
export const EXTENSION_SURFACES = ['fowlbrowser', 'claude-in-chrome'];
const CLAUDE_HOST = 'com.anthropic.claude_code_browser_extension', FOWL_HOST = 'com.fowl.browser';
// Caches and the last session stay behind: a copy starts like a relaunch with nothing to restore.
const SKIPPED = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'Sessions', 'Session Storage']);

// Chrome and Helium rounds start from a fresh private profile. profile 'benchmark' copies Chrome's "sleight benchmark"
// profile (extensions, their sign-ins and settings) into that private folder at launch, since Chrome refuses remote
// debugging on its default data folder and has no --load-extension. The FowlBrowser arm on Helium loads the installed
// unpacked extension into the fresh profile instead. Either way the owner's own profiles are only read, never opened.
export function realBrowserPlan({ browser, round, home = homedir(), profile = 'fresh', surface }) {
  if (!['chrome', 'helium', 'firefox', 'safari'].includes(browser)) throw Error('real browser must be chrome, helium, firefox or safari');
  if (typeof round !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(round)) throw Error('invalid round identity');
  if (!['fresh', 'benchmark'].includes(profile)) throw Error('real profile must be fresh or benchmark');
  if (profile === 'benchmark' && browser !== 'chrome') throw Error('Only Chrome has the "sleight benchmark" profile');
  const extension = EXTENSION_SURFACES.includes(surface) ? surface : undefined;
  if (extension && !['chrome', 'helium'].includes(browser)) throw Error(`${extension} runs in Chrome or Helium only`);
  if (extension === 'claude-in-chrome' && browser !== 'chrome') throw Error('Claude in Chrome runs in Chrome only');
  if (extension && browser === 'chrome' && profile !== 'benchmark') throw Error(`${extension} on Chrome needs --real-profile benchmark: Chrome has no --load-extension`);
  const profileRoot = join(home, 'Library/Caches/sleight-bench/real-browser', round, 'profile');
  const executable = browser === 'chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : browser === 'helium' ? '/Applications/Helium.app/Contents/MacOS/Helium'
    : browser === 'safari' ? '/Applications/Safari.app/Contents/MacOS/Safari' : '/Applications/Firefox.app/Contents/MacOS/firefox';
  const marker = `Sleight Gate ${round}`;
  const url = 'data:text/html,' + encodeURIComponent(`<title>${marker}</title><h1>${marker}</h1>`);
  if (browser === 'safari') return { browser, executable, profileRoot, marker, markerUrl: url,
    profileName: 'sleight benchmark', profileOwned: false, headless: false, connectionMode: 'engine-computer',
    launchMode: 'NSWorkspace-background', resetMode: 'fresh-profile-window', inventoryMode: 'AX-tab-bar',
    quitMode: 'NSRunningApplication-owned-pid-and-launch-date', unavailableGraders: ['completed downloads', 'device viewport'] };
  // Firefox spawned as our child shows "Profile Missing" and never writes the profile;
  // through LaunchServices (open -n) the same profile works. -g keeps focus where it is.
  if (browser === 'firefox') return { browser, executable, profileRoot, marker, command: '/usr/bin/open',
    launchArgs: ['-n', '-g', '-a', '/Applications/Firefox.app', '--env', 'MOZ_CRASHREPORTER_DISABLE=1', '--args',
      '-profile', profileRoot, '-no-remote', '-new-instance', url],
    args: ['-profile', profileRoot, '-no-remote', '-new-instance', url], launchMode: 'LaunchServices-open-new-instance',
    headless: false, connectionMode: 'engine-computer', version: '157', versionVerified: false,
    resetMode: 'quit-and-fresh-profile-relaunch', inventoryMode: 'sessionstore-after-graceful-quit',
    quitMode: 'normal-quit-by-owned-pid', unavailableGraders: ['completed downloads'] };
  const plan = { browser, executable, profileRoot, marker, command: executable,
    args: ['--user-data-dir=' + profileRoot, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--use-mock-keychain',
      '--password-store=basic', '--new-window', url],
    headless: false, connectionMode: 'product-remote-debugging' };
  if (profile === 'fresh' && !extension) return plan;
  const source = join(home, SUPPORT[browser]);
  // The copy keeps Chrome's own keychain key: Claude in Chrome re-authorizes through claude.ai's cookies, which the
  // mock keychain cannot decrypt (live smoke 2026-10-17: signed out, no connected browser).
  const args = profile === 'benchmark' ? plan.args.filter(arg => !['--use-mock-keychain', '--password-store=basic'].includes(arg)) : plan.args;
  return { ...plan, args, ...(extension ? { surface: extension } : {}),
    profileMode: profile === 'benchmark' ? 'benchmark-copy' : 'fresh',
    ...(profile === 'benchmark' ? { profileSource: { userDataDir: source, profileName: 'sleight benchmark',
      copy: 'per round; caches and the last session left out', keychain: 'Chrome Safe Storage in the login keychain (needs it unlocked)' } } : {}),
    // Chrome looks for native messaging hosts under the data folder it runs on, so the round's folder gets its own.
    nativeHosts: extension === 'fowlbrowser' ? [{ name: FOWL_HOST, copiedFrom: join(source, 'NativeMessagingHosts', FOWL_HOST + '.json') }]
      : extension === 'claude-in-chrome' ? [{ name: CLAUDE_HOST, host: join(dirname(profileRoot), 'claude-native-host'),
        command: join(home, '.config/sleight-bench/world/arms/claude-in-chrome/node_modules/.bin/claude'),
        configDir: join(home, '.config/sleight-bench/world/arms/claude-in-chrome/claude-config') }] : [],
    loadExtensions: extension === 'fowlbrowser' && profile === 'fresh' ? [join(home, 'Library/Application Support/FowlBrowser/extension')] : [],
    // FowlBrowser's tools reach every browser running its extension, so the other one must be closed too.
    ...(extension === 'fowlbrowser' ? { alsoQuit: [EXECUTABLES[browser === 'chrome' ? 'helium' : 'chrome']] } : {}) };
}

// Version from the app bundle, read without launching it.
export function browserVersion(executable, { read = execFileSync } = {}) {
  try {
    const plist = join(dirname(dirname(executable)), 'Info.plist');
    const value = String(read('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8', timeout: 5000 })).trim();
    return /^[\w.-]{1,40}$/.test(value) ? value : null;
  } catch { return null; }
}

// What a launch would need from the owner's machine, checked without launching or writing anything.
export function profileSourceProblems(plan) {
  const problems = [];
  if (plan.profileMode === 'benchmark-copy') {
    try { benchmarkProfile(join(plan.profileSource.userDataDir, 'Local State')); }
    catch (error) {
      problems.push(/missing/.test(error.message) ? `${error.message} (make it in Chrome: Add profile, name it "sleight benchmark")`
        : `Cannot read Chrome's profile list: ${error.message}`);
    }
  }
  for (const host of plan.nativeHosts || []) {
    if (host.copiedFrom && !existsSync(host.copiedFrom)) problems.push(`FowlBrowser's native host is not registered for ${plan.browser}: run FowlBrowser's install.sh`);
    if (host.command && !existsSync(host.command)) problems.push(`Claude in Chrome arm is not installed at ${dirname(dirname(dirname(host.command)))}`);
  }
  for (const folder of plan.loadExtensions || []) if (!existsSync(join(folder, 'manifest.json'))) problems.push(`No unpacked extension at ${folder}: run FowlBrowser's install.sh`);
  return problems;
}

// Fills the round's empty profile folder: the benchmark profile copy, its native hosts and the extension flags.
export function prepareRealProfile(plan, { copy = cpSync } = {}) {
  const spawnArgs = [...plan.args], url = spawnArgs.pop(), record = {};
  if (plan.profileMode === 'benchmark-copy') {
    const localState = join(plan.profileSource.userDataDir, 'Local State');
    const folder = benchmarkProfile(localState), from = join(plan.profileSource.userDataDir, folder);
    if (!statSync(from).isDirectory()) throw Error('BENCH_PROFILE_SOURCE_INVALID');
    copy(from, join(plan.profileRoot, folder), { recursive: true, mode: constants.COPYFILE_FICLONE, filter: path => {
      const rel = relative(from, path);
      return !SKIPPED.has(rel.split(sep)[0]) && !lstatSync(path).isSymbolicLink();
    } });
    // Only the benchmark profile is listed, so nothing about the owner's other profiles reaches the copy.
    const state = JSON.parse(readFileSync(localState, 'utf8'));
    const info = state.profile?.info_cache?.[folder];
    state.profile = { ...state.profile, info_cache: { [folder]: info }, last_used: folder, last_active_profiles: [folder], profiles_order: [folder] };
    writeFileSync(join(plan.profileRoot, 'Local State'), JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    spawnArgs.push('--profile-directory=' + folder);
    record.profileFolder = folder;
    if (plan.surface === 'claude-in-chrome') {
      // The extension's bridge device ID lives in its own storage, copied with the profile. The arm's device pin
      // follows this copy, so a stale pin cannot point the arm at another browser or at nothing (live smoke 2026-10-17).
      const id = claudeDeviceId(join(plan.profileRoot, folder));
      if (id) {
        record.claudeDeviceFile = join(dirname(plan.profileRoot), 'claude-in-chrome-device');
        writeFileSync(record.claudeDeviceFile, id + '\n', { mode: 0o600, flag: 'wx' });
        record.claudeDeviceId = id;
      } else record.claudeDeviceId = null;
    }
  }
  if (plan.nativeHosts?.length) {
    const hosts = join(plan.profileRoot, 'NativeMessagingHosts');
    mkdirSync(hosts, { mode: 0o700 });
    for (const host of plan.nativeHosts) {
      let manifest;
      if (host.copiedFrom) {
        manifest = JSON.parse(readFileSync(host.copiedFrom, 'utf8'));
        if (manifest.name !== host.name || !isAbsolute(manifest.path || '')) throw Error('BENCH_NATIVE_HOST_INVALID');
      } else {
        // The pinned arm's own native host, with its isolated config, in place of Claude Code's wrapper in ~/.claude.
        const sh = value => "'" + value.replaceAll("'", "'\\''") + "'";
        writeFileSync(host.host, `#!/bin/sh\nCLAUDE_CONFIG_DIR=${sh(host.configDir)}\nexport CLAUDE_CONFIG_DIR\nexec ${sh(host.command)} --chrome-native-host\n`, { mode: 0o700, flag: 'wx' });
        manifest = claudeHostManifest(host.host);
      }
      writeFileSync(join(hosts, host.name + '.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    }
    record.nativeHosts = plan.nativeHosts.map(host => host.name);
  }
  for (const folder of plan.loadExtensions || []) {
    if (!existsSync(join(folder, 'manifest.json'))) throw Error('BENCH_EXTENSION_MISSING');
    spawnArgs.push('--load-extension=' + folder);
  }
  if (plan.loadExtensions?.length) record.loadedExtensions = plan.loadExtensions;
  spawnArgs.push(url);
  return { spawnArgs, record };
}

// Claude in Chrome keeps bridgeDeviceId in chrome.storage.local (LevelDB). The newest uncompressed record wins.
export function claudeDeviceId(profile) {
  const dir = join(profile, 'Local Extension Settings', 'fcoeoabgfenejglbffodgkkbkcdhcgfn');
  let files;
  try { files = readdirSync(dir).filter(name => /^\d+\.(?:log|ldb)$/.test(name)).sort((a, b) => parseInt(a) - parseInt(b)); } catch { return null; }
  let found = null;
  for (const name of files) {
    const text = readFileSync(join(dir, name)).toString('latin1');
    for (const match of text.matchAll(/bridgeDeviceId[\s\S]{0,24}?"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/gi)) found = match[1].toLowerCase();
  }
  return found;
}

// The manifest Claude Code writes for its browser extension, same fields and order.
export function claudeHostManifest(path) {
  return { name: CLAUDE_HOST, description: 'Claude Code Browser Extension Native Host', path, type: 'stdio',
    allowed_origins: ['chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/'] };
}

export function browserProcesses() {
  const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (!output.trim()) throw Error('BENCH_PROCESS_LIST_UNAVAILABLE');
  return output.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw Error('BENCH_PROCESS_LIST_INVALID');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: match[4] };
  });
}

export function matchesBrowserProcess(plan, row) {
  const name = row.executable.replace(/^\((.*)\)$/, '$1');
  const canonical = path => (existsSync(path) ? realpathSync(path) : path).toLowerCase();
  if (plan.browser === 'safari' && (name.toLowerCase().startsWith('/applications/safari.app/') ||
      /^(?:safari\b|com\.apple\.webkit\.webcontent\b)/i.test(basename(name)))) return true;
  return isAbsolute(name) ? canonical(name) === canonical(plan.executable)
    : basename(name).toLowerCase().startsWith(basename(plan.executable).toLowerCase());
}

// WebKit's XPC services serve every app's web views, so for Safari they count only
// when macOS names a Safari process responsible for them.
const webkitService = /^com\.apple\.webkit\.(?:webcontent|networking|gpu)\b/i;
const responsibleScript = 'function run(argv) { ObjC.bindFunction("responsibility_get_pid_responsible_for_pid", ["int", ["int"]]);' +
  ' return argv.map(pid => pid + " " + $.responsibility_get_pid_responsible_for_pid(Number(pid))).join("\\n"); }';

// pid -> responsible pid through libquarantine's responsibility_get_pid_responsible_for_pid.
// A pid the call cannot answer (-1) is left out and stays unknown.
export async function responsiblePids(pids) {
  if (!pids.length) return new Map();
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', responsibleScript, ...pids.map(String)],
    { encoding: 'utf8', timeout: 5000 });
  const result = new Map();
  for (const line of stdout.trim().split('\n')) {
    const match = /^(\d+) (-?\d+)$/.exec(line);
    if (match && Number(match[2]) > 0) result.set(Number(match[1]), Number(match[2]));
  }
  return result;
}

function safariApp(plan, row) {
  const name = row.executable.replace(/^\((.*)\)$/, '$1');
  return name.toLowerCase().includes('/safari.app/') || (!isAbsolute(name) && /^safari\b/i.test(name)) ||
    (isAbsolute(name) && matchesBrowserProcess({ ...plan, browser: undefined }, row));
}

export async function checkBrowserOwner(plan, { listProcesses = browserProcesses, ownedPid, responsibleFor = responsiblePids } = {}) {
  const ownerCheck = { executable: plan.executable, checkedAt: new Date().toISOString(), ok: false, otherPids: [] };
  try {
    const processes = await listProcesses();
    if (!Array.isArray(processes) || processes.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
        typeof row.executable !== 'string' || !row.executable)) throw Error('BENCH_PROCESS_LIST_INVALID');
    const byPid = new Map(processes.map(row => [row.pid, row]));
    const services = new Set(plan.browser === 'safari' ? processes.filter(row =>
      webkitService.test(basename(row.executable.replace(/^\((.*)\)$/, '$1')))) : []);
    let responsible = new Map();
    if (services.size) {
      try { responsible = await responsibleFor([...services].map(row => row.pid)); }
      catch (error) { ownerCheck.responsibleError = error.message; }
    }
    // An unknown or vanished responsible process keeps the name rule (fail closed).
    const known = row => services.has(row) && byPid.has(responsible.get(row.pid));
    const others = (plan.alsoQuit || []).map(executable => ({ browser: 'other', executable }));
    const matches = row => known(row)
      ? responsible.get(row.pid) !== row.pid && safariApp(plan, byPid.get(responsible.get(row.pid)))
      : matchesBrowserProcess(plan, row);
    if (services.size) ownerCheck.sharedWebKit = [...services].filter(row => known(row) && !matches(row))
      .map(row => ({ pid: row.pid, responsible: responsible.get(row.pid) }));
    const blocking = row => matches(row) || others.some(other => matchesBrowserProcess(other, row));
    const parents = new Map(processes.map(row => [row.pid, row.ppid]));
    if (ownedPid !== undefined && (!Number.isSafeInteger(ownedPid) || ownedPid <= 0 || parents.size !== processes.length ||
        !processes.some(row => row.pid === ownedPid && matches(row)) ||
        processes.some(row => !Number.isSafeInteger(row.ppid) || row.ppid < 0))) throw Error('BENCH_PROCESS_LIST_INVALID');
    const owned = pid => {
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        if (pid === ownedPid) return true;
        seen.add(pid); pid = parents.get(pid);
      }
      return false;
    };
    // launchd parents WebKit services; the owned Safari is responsible for its own.
    const ownedRow = row => owned(row.pid) || (known(row) && owned(responsible.get(row.pid)));
    ownerCheck.otherPids = processes.filter(row => blocking(row) && !ownedRow(row)).map(row => row.pid);
    if (others.length) ownerCheck.alsoQuit = plan.alsoQuit;
    if (ownerCheck.otherPids.length) throw Error(`Quit ${[plan.browser, ...others.map(other => basename(other.executable))].join(' and ')} before starting this round; another process uses the browser executable (PID ${ownerCheck.otherPids.join(', ')}).`);
    ownerCheck.ok = true;
    return ownerCheck;
  } catch (error) { ownerCheck.error = error.message; error.ownerCheck = ownerCheck; throw error; }
}

function ordinaryParents(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw Error('BENCH_PROFILE_UNSAFE');
    }
    if (dirname(current) === current) break;
  }
}

// The runner owns this exact child and profile. A failed collection retains the
// profile and live lock so the next round cannot hide an orphaned window.
export function initialBrowserPage(plan, page) {
  if (page === undefined) return plan;
  const url = new URL(page.url);
  if (!['firefox', 'safari'].includes(plan.browser) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !url.port || url.username || url.password || typeof page.title !== 'string' || !page.title || page.title.length > 200) throw Error('BENCH_INITIAL_PAGE_UNSAFE');
  // Keep the race's profile, launch, ownership and cleanup checks. Only the initial page changes.
  if (plan.browser === 'safari') {
    // Bind the helper to this run's fixture before launch. Data-page redirects to loopback did not acquire Safari.
    if (url.href !== page.url || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/held-out\/[a-z-]+\/[A-Za-z0-9_-]{1,80}\/$/.test(page.url)) throw Error('BENCH_INITIAL_PAGE_UNSAFE');
    return { ...plan, acquisitionPage: { title: page.title, url: url.href } };
  }
  return { ...plan, marker: page.title, args: [...plan.args.slice(0, -1), url.href], launchArgs: [...plan.launchArgs.slice(0, -1), url.href] };
}

export async function launchRealBrowser(plan, { spawnBrowser = spawn, openBrowser, listArguments, signalProcess, listProcesses, timeoutMs = 15000, stopMs = 5000, quitMs = 25000, quitBrowser, profileMetadata, safariBridge, restoreWait, readVersion = browserVersion, copy, initialPage } = {}) {
  const expected = realBrowserPlan({ browser: plan.browser, round: plan.marker?.slice('Sleight Gate '.length),
    profile: plan.profileMode === 'benchmark-copy' ? 'benchmark' : 'fresh', surface: plan.surface });
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw Error('BENCH_PROFILE_UNSAFE');
  plan = initialBrowserPage(plan, initialPage);
  const ownerCheck = await checkBrowserOwner(plan, { listProcesses });
  const version = readVersion(plan.executable);
  // Firefox and Safari update their returned object in place on reset, so the version goes onto that same object.
  const versioned = browser => version ? Object.assign(browser, { version, versionVerified: true, versionSource: 'app Info.plist CFBundleShortVersionString' }) : browser;
  try {
    if (plan.browser === 'safari') {
      ordinaryParents(plan.profileRoot);
      const { launchSafari } = await import('./safari-browser.mjs');
      return versioned(await launchSafari(plan, { spawnBrowser, listProcesses, timeoutMs, quitMs, ownerCheck, safariBridge, restoreWait }));
    }
    if (plan.browser === 'firefox') {
      ordinaryParents(plan.profileRoot);
      const { launchFirefox } = await import('./firefox-browser.mjs');
      return versioned(await launchFirefox(plan, { openBrowser, listArguments, signalProcess, listProcesses, timeoutMs, stopMs, quitMs, quitBrowser, ownerCheck, profileMetadata }));
    }
    return versioned({ ...await startRealBrowser(plan, { spawnBrowser, timeoutMs, stopMs, copy }), ownerCheck });
  }
  catch (error) { error.ownerCheck ??= ownerCheck; throw error; }
}

async function startRealBrowser(plan, { spawnBrowser, timeoutMs, stopMs, copy }) {
  ordinaryParents(plan.profileRoot);
  mkdirSync(dirname(dirname(plan.profileRoot)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(plan.profileRoot), { mode: 0o700 });
  mkdirSync(plan.profileRoot, { mode: 0o700 });
  let child, prepared;
  try {
    prepared = plan.profileMode || plan.surface ? prepareRealProfile(plan, copy ? { copy } : {}) : { spawnArgs: plan.args, record: {} };
    child = spawnBrowser(plan.command, prepared.spawnArgs, { stdio: 'ignore' });
  }
  catch (error) { rmSync(dirname(plan.profileRoot), { recursive: true }); throw error; }
  let closed = false, spawnError;
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', () => { closed = true; resolve(); });
  });
  const wait = async ms => {
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!closed) { child.kill('SIGTERM'); await wait(stopMs); }
    if (!closed) { child.kill('SIGKILL'); await wait(stopMs); }
    if (!closed) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    rmSync(dirname(plan.profileRoot), { recursive: true });
    return { browserClosed: true, profileDeleted: true };
  })();
  const deadline = Date.now() + timeoutMs, file = join(plan.profileRoot, 'DevToolsActivePort');
  try {
    for (;;) {
      if (closed || spawnError || Date.now() > deadline) throw Error('BENCH_BROWSER_START_FAILED');
      if (existsSync(file) && /^\d+\n\/devtools\/browser\/[^\s]+\n?$/.test(readFileSync(file, 'utf8'))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ...plan, ...prepared.record, ...(prepared.spawnArgs !== plan.args ? { spawnArgs: prepared.spawnArgs } : {}), pid: child.pid, stop };
  } catch (error) { await stop(); throw error; }
}

export function validateRealBrowser(browser) {
  const round = browser?.marker?.slice('Sleight Gate '.length);
  const expected = realBrowserPlan({ browser: browser?.browser, round });
  if (browser.profileRoot !== expected.profileRoot || browser.executable !== expected.executable ||
      !Number.isSafeInteger(browser.pid) || browser.pid <= 0) throw Error('BENCH_PROFILE_UNSAFE');
  ordinaryParents(browser.profileRoot);
  const stat = lstatSync(browser.profileRoot);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('BENCH_PROFILE_UNSAFE');
  return browser;
}

// Only the runner's exact private profile supplies this connection, never browser discovery.
export async function realBrowserCommands(browser, { Socket = globalThis.WebSocket, validate = validateRealBrowser, timeoutMs = 5000 } = {}) {
  validate(browser);
  const portFile = readFileSync(join(browser.profileRoot, 'DevToolsActivePort'), 'utf8');
  const match = /^(\d+)\n(\/devtools\/browser\/[^\s]+)\n?$/.exec(portFile);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error('BENCH_BROWSER_ENDPOINT_INVALID');
  const socket = new Socket(`ws://127.0.0.1:${match[1]}${match[2]}`);
  let serial = 0;
  const pending = new Map(), listeners = new Set();
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  socket.addEventListener('message', event => {
    try {
      const frame = JSON.parse(event.data), entry = pending.get(frame.id);
      if (frame.method && frame.id === undefined) for (const listener of listeners) try { listener(frame); } catch {}
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(Error(frame.error.message)); else entry.resolve(frame.result);
    } catch (error) { fail(error); }
  });
  socket.addEventListener('close', () => fail(Error('BENCH_BROWSER_CONNECTION_CLOSED')));
  socket.addEventListener('error', () => fail(Error('BENCH_BROWSER_CONNECTION_ERROR')));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('BENCH_BROWSER_CONNECTION_TIMEOUT')), timeoutMs);
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('BENCH_BROWSER_CONNECTION_ERROR')), { once: true });
      socket.addEventListener('close', () => reject(Error('BENCH_BROWSER_CONNECTION_CLOSED')), { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  finally { clearTimeout(timer); }
  return {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(method, params = {}) {
      const id = ++serial;
      let timer;
      try {
        if (socket.readyState !== 1) throw Error('BENCH_BROWSER_CONNECTION_CLOSED');
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(Error('BENCH_BROWSER_COMMAND_TIMEOUT')), timeoutMs);
          socket.send(JSON.stringify({ id, method, params }));
        });
      } catch (error) {
        // Keep the caller's method, never its target or page parameters.
        throw Object.assign(new Error(error.message, { cause: error }), { cdpMethod: method });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
    async close() {
      if (socket.readyState === 3) return;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('BENCH_BROWSER_DISCONNECT_TIMEOUT')), timeoutMs);
          socket.addEventListener('close', resolve, { once: true }); socket.close();
        });
      } finally { clearTimeout(timer); }
    },
  };
}

const inventory = (browser, targets) => Object.fromEntries(targets.filter(target => target.type === 'page')
  .map(target => [`${browser.browser}:${target.targetId}`, { url: target.url, title: target.title }]));

export async function observeRealBrowser(browser, { connect = realBrowserCommands } = {}) {
  if (['firefox', 'safari'].includes(browser.browser)) return browser.observe();
  const connection = await connect(browser);
  try { return inventory(browser, (await connection.send('Target.getTargets')).targetInfos); }
  finally { await connection.close(); }
}

// Every page URL the browser reports while an agent runs, whichever arm drives it. Graders use it as visit evidence.
export async function watchNavigations(browser, { connect = realBrowserCommands } = {}) {
  const connection = await connect(browser), urls = new Set();
  const note = info => { if (info?.type === 'page' && typeof info.url === 'string' && /^https?:/i.test(info.url)) urls.add(info.url); };
  connection.on(frame => { if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(frame.method)) note(frame.params?.targetInfo); });
  try {
    await connection.send('Target.setDiscoverTargets', { discover: true });
    for (const info of (await connection.send('Target.getTargets')).targetInfos) note(info);
  } catch (error) { await connection.close().catch(() => {}); throw error; }
  return { urls: () => [...urls], close: () => connection.close() };
}

export async function resetRealBrowser(browser, { connect = realBrowserCommands, timeoutMs = 5000 } = {}) {
  if (['firefox', 'safari'].includes(browser.browser)) return browser.reset();
  const connection = await connect(browser);
  const closeTarget = async targetId => {
    try {
      if (!(await connection.send('Target.closeTarget', { targetId })).success) throw Error('BENCH_BROWSER_RESET_FAILED');
    } catch (error) {
      // An old tab can disappear after inventory, including while Chrome handles this call.
      // Only closing an old tab is idempotent here. The final inventory still has to prove reset.
      if (error.message !== 'No target with given id found') throw error;
    }
  };
  try {
    const previous = (await connection.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
    const { targetId } = await connection.send('Target.createTarget', { url: browser.args.at(-1) });
    if (typeof targetId !== 'string' || !targetId || previous.some(target => target.targetId === targetId)) throw Error('BENCH_BROWSER_RESET_FAILED');
    // Create first so closing the last old tab cannot exit the owned browser.
    for (const target of previous) await closeTarget(target.targetId);
    await connection.send('Target.activateTarget', { targetId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const targets = (await connection.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
      if (targets.length === 1 && targets[0].targetId === targetId && targets[0].title === browser.marker) return inventory(browser, targets);
      if (Date.now() >= deadline) throw Error('BENCH_BROWSER_RESET_FAILED');
      for (const target of targets.filter(target => target.targetId !== targetId)) {
        if (Date.now() >= deadline || typeof target.targetId !== 'string' || !target.targetId) throw Error('BENCH_BROWSER_RESET_FAILED');
        await closeTarget(target.targetId);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { await connection.close(); }
}
