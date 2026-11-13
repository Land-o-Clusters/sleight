// The launcher's third check, after the guard hook and the terminal check (person-gate.mjs): high-stakes settings changes,
// replay and recording wait for the platform's own identity sheet. An agent can type a command into a terminal it opened, and
// then the process chain looks like a person's, but it can't give a fingerprint or the account password. The sheet comes
// from the consent host's --confirm-person mode, whose reason text is the host's own fixed table (consent-host.swift, PERSON
// CONFIRM). Tests inject the confirmation as a function. Nothing in the environment turns this off.
import { settingsCommand } from './person-gate.mjs';
import { getPlatform } from './platform/index.mjs';
import { sameListed, siteOrigin } from './permissions.mjs';

// The browsers `turbo on --browser <id>` takes (direct-browser/browsers.mjs), by the name the sheet shows. The host keeps the
// same names and refuses any other.
const BROWSER_NAMES = { chrome: 'Google Chrome', helium: 'Helium', 'chrome-beta': 'Google Chrome Beta', 'chrome-dev': 'Google Chrome Dev',
  'chrome-canary': 'Google Chrome Canary', chromium: 'Chromium', brave: 'Brave Browser', edge: 'Microsoft Edge', vivaldi: 'Vivaldi' };
// Only bounded identifiers, canonical origins and a site count reach the sheet.
const bundle = value => typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) ? value : undefined;
const change = (key, subject) => subject ? { key, subject } : { key };

/** { key, subject? } when args (the launcher's argv after the script) make a high-stakes change, else undefined. Read-only
 *  forms (person-gate.mjs) and the low-stakes ones, which only take access away or change how sleight looks (hand, cursor,
 *  turning turbo or an app off, blocking, revoking, allow remove, clearing site memory, removing a routine or watch), are
 *  undefined. Any other form of a high-stakes family is high-stakes under the generic key,
 *  so a writer added later asks before anyone lists it here. */
export function highStakesChange(args) {
  if (!Array.isArray(args) || settingsCommand(args) === undefined) return undefined;
  const [family, ...rest] = args.map(String), [op, value] = rest;
  if (family === 'turbo') {
    if (op === 'off' && rest.length === 1 || op === 'app' && value === 'off' && rest.length === 3) return undefined;
    if (op === 'app' && value === 'on') return change('turbo-app-on', rest.length === 3 && bundle(rest[2]));
    if (op === 'on') return change('turbo-on', rest.length === 3 && rest[1] === '--browser' && Object.hasOwn(BROWSER_NAMES, rest[2]) && BROWSER_NAMES[rest[2]]);
  } else if (family === 'permissions') {
    if (op === 'block' && rest.length === 2 || op === 'memory') return undefined;
    if (op === 'unblock' && rest.length === 2) {
      const site = siteOrigin(value);
      return site ? change('permissions-unblock-site', site) : change('permissions-unblock', bundle(value));
    }
    if (op === 'revoke' && rest.length === 2) return undefined;
    if (op === 'sites' && value === 'all' && rest.length === 2) return change('permissions-sites-all');
    if (op === 'sites' && value === 'only' && rest.length > 2 && rest.length <= 258) {
      const sites = rest.slice(2).map(siteOrigin);
      if (sites.every(Boolean)) return change('permissions-sites-only', String(sites.filter((site, at) =>
        sites.findIndex(other => sameListed(other, site)) === at).length));
    }
    if (op === 'repair' && rest.length === 2 && value === '--discard') return change('permissions-repair-discard');
    if (op === 'repair' && rest.length === 1) return change('permissions-repair');
  } else if (family === 'allow') {
    if (op === 'remove' && rest.length === 2) return undefined;
  } else if (family === 'routine') {
    if (['remove', '--remove'].includes(op) && rest.length === 2) return undefined;
    if (op === 'add') return change('routine-add');
    if (op === 'unlock') return change('routine-unlock');
  } else if (family === 'watch') {
    if (op === 'remove' && rest.length === 2) return undefined;
    if (op === 'unlock') return change('watch-unlock');
    if (op === 'record' || value === '--find') return change('watch-add');
  } else if (family === 'replay' || family === 'record') return change(family);
  else return undefined; // hand and cursor only change how sleight looks
  return change('settings');
}

// Why a confirmation didn't pass, for the refusal's one line.
const REASONS = {
  failed: 'Touch ID or the password did not match', cancelled: 'the confirmation was cancelled', timeout: 'nobody confirmed within 60 s',
  away: 'nobody is at the Mac, and settings changes never go to remote approvals',
  unavailable: "this Mac can't ask for Touch ID or a password", 'no helper': "the confirmation helper couldn't be built",
  invalid: 'the confirmation helper refused the request', 'build timeout': 'building the confirmation helper took too long, so no dialog was shown', unverified: "the confirmation helper isn't the file sleight checked",
};
// What a person can do when the Mac can't ask (docs/settings.md).
const NEXT = { unavailable: ' Set a login password to make this change.',
  'no helper': " Apple's command-line tools build it (xcode-select --install)." };
export const confirmationLine = (command, code = 'failed', platform = process.platform) => {
  const startsRun = /^(?:replay|record)(?: |$)/.test(command);
  const outcome = startsRun ? 'nothing ran' : 'nothing changed';
  const purpose = startsRun ? 'run this command' : 'make this change';
  if (platform === 'win32') {
    const reasons = { ...REASONS, failed: 'Windows Hello or the password did not verify you',
      away: 'the Windows session is locked, idle, disconnected or unreadable',
      unavailable: "Windows can't ask for Windows Hello or your password" };
    const next = code === 'unavailable' ? ` Configure Windows Hello or a login password in Windows Settings to ${purpose}.` : '';
    return `sleight: ${command} needs Windows Hello or your password, so ${outcome}. Reason: ${reasons[code] ?? reasons.failed}.${next}`;
  }
  const reason = startsRun && code === 'away' ? 'nobody is at the Mac, and these commands never go to remote approvals' : REASONS[code] ?? REASONS.failed;
  const next = startsRun && code === 'unavailable' ? ` Set a login password to ${purpose}.` : NEXT[code] ?? '';
  return `sleight: ${command} needs Touch ID or your password, so ${outcome}. Reason: ${reason}.${next}`;
};

/** undefined when args are not high-stakes or the person confirmed, else the refusal line. The order holds: presence first
 *  (a Mac nobody is at refuses outright, and nothing is sent to the phone), then one confirmation. confirm(change, options)
 *  may build its helper first: options.ready() starts the sheet's clock (timeoutMs, plus graceMs for the helper to exit),
 *  and until then only buildMs runs. options.abandoned() turns true once this has given up, so a build that finishes later
 *  never shows a sheet. confirm resolves to ok, failed, cancelled, timeout, invalid, unverified, unavailable or no helper;
 *  presence() to true, false or anything else for unknown. Anything that throws refuses. */
export async function confirmationRefusal(args, { confirm, presence = async () => undefined, notice = () => {}, timeoutMs = 60000, graceMs = 5000,
  buildMs = 330000, platform = process.platform } = {}) {
  const found = highStakesChange(args);
  if (!found) return undefined;
  const command = settingsCommand(args);
  const action = found.key === 'replay' ? 'runs a saved script' : found.key === 'record' ? 'records or converts a run' : 'changes what sleight may do';
  const result = await personConfirmationResult(found, { confirm, presence, timeoutMs, graceMs, buildMs, platform,
    notice: () => notice(`sleight: ${command}${found.subject ? ` (${found.subject})` : ''} ${action}. Confirm with ${platform === 'win32' ? 'Windows Hello in the Windows dialog, or your Windows password if Hello is unavailable' : 'Touch ID or your password in the macOS dialog'} (60 s, Cancel or Ctrl-C stops it).\n`) });
  return result === 'ok' ? undefined : confirmationLine(command, result, platform);
}

// Shared by settings and the owner-present sitting. Only a verified zero exit
// becomes ok; the caller decides how to report any refusal.
export async function personConfirmationResult(found, { confirm, presence = async () => undefined, notice = () => {},
  timeoutMs = 60000, graceMs = 5000, buildMs = 330000, platform = process.platform, signal } = {}) {
  if (signal?.aborted) return 'cancelled';
  let present;
  try { present = await presence(); } catch {}
  if (signal?.aborted) return 'cancelled';
  if (present === false || platform === 'win32' && present !== true) return 'away';
  if (typeof confirm !== 'function') return 'no helper';
  let result, timer, gaveUp = false, abort;
  try {
    notice();
    result = await new Promise(resolve => {
      const settle = value => { gaveUp = true; clearTimeout(timer); resolve(value); };
      abort = () => settle('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => settle('build timeout'), buildMs);
      const ready = () => { if (gaveUp) return; clearTimeout(timer); timer = setTimeout(() => settle('timeout'), timeoutMs + graceMs); };
      Promise.resolve().then(() => gaveUp ? 'cancelled' : confirm(found, { timeoutMs, ready, signal, notice,
        abandoned: () => gaveUp })).then(settle, () => settle('failed'));
    });
  } catch { result = 'failed'; }
  finally { clearTimeout(timer); gaveUp = true; signal?.removeEventListener('abort', abort); }
  return result;
}

// The helper's exit codes (consent-host.swift, PersonConfirmResult).
const EXITS = { 0: 'ok', 1: 'failed', 2: 'cancelled', 3: 'timeout', 64: 'invalid', 69: 'unavailable' };
/** The production confirmation: the host binary's --confirm-person mode, built from sleight's own sources into its helper
 *  cache like the ghost hand's, and run from a private copy (host.mjs prepareConfirmHost). The helper's first line names
 *  the file it runs and its hash; an answer counts only when they match the copy (child.sleightExpected). The helper
 *  withdraws its sheet at timeoutMs; this kills it a little later if it hasn't exited. prepare() resolves to
 *  { status: 'ready', spawn(key, subject) } or anything else when the helper can't run. */
export async function helperConfirm(found, { timeoutMs = 60000, notice = () => {}, ready = () => {}, abandoned = () => false,
  platform = process.platform, signal, prepare = () => getPlatform(platform).person.prepareConfirm({ notice }) } = {}) {
  if (signal?.aborted) return 'cancelled';
  let host;
  try { host = await prepare(); } catch { return 'no helper'; }
  // A caller that gave up during the build already printed its refusal: no sheet after that.
  if (signal?.aborted) return 'cancelled';
  if (abandoned()) return 'no helper';
  if (host?.status !== 'ready' || typeof host.spawn !== 'function') return 'no helper';
  ready();
  return new Promise(resolve => {
    let child, timer, force, first, text = '', done = false;
    const stop = result => {
      try { child.kill('SIGTERM'); } catch {}
      finish(result);
      force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      force.unref?.();
    };
    const abort = () => stop('cancelled');
    const finish = result => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result); };
    try { child = host.spawn(found.key, found.subject); } catch { finish('no helper'); return; }
    const expected = child?.sleightExpected;
    const verified = () => {
      try { const report = JSON.parse(first); return !!expected && report?.path === expected.path && report?.sha256 === expected.sha256; }
      catch { return false; }
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => {
      if (first !== undefined) return;
      text += chunk;
      if (text.includes('\n')) first = text.slice(0, text.indexOf('\n'));
      else if (text.length > 8192) first = '';
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs + 2000);
    child.once('error', () => finish('failed'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // exit can come before stdout's last data, so the answer waits for the pipe to close.
    // 64 is the helper refusing its arguments before it prints anything; it's a refusal either way, so it says so.
    child.once('close', code => {
      clearTimeout(force);
      finish(code === 64 ? 'invalid' : first !== undefined && verified() ?
        platform === 'win32' && code === 4 ? 'away' : EXITS[code] ?? 'failed' : 'unverified');
    });
  });
}
