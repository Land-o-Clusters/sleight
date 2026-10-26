// The launcher's third check, after the guard hook and the terminal check (person-gate.mjs): a high-stakes settings change
// runs only after macOS's own Touch ID or password sheet passes. An agent can type a command into a terminal it opened, and
// then the process chain looks like a person's, but it can't give a fingerprint or the account password. The sheet comes
// from the consent host's --confirm-person mode, whose reason text is the host's own fixed table (consent-host.swift, PERSON
// CONFIRM). Tests inject the confirmation as a function. Nothing in the environment turns this off.
import { settingsCommand } from './person-gate.mjs';

// The browsers `turbo on --browser <id>` takes (direct-browser/browsers.mjs), by the name the sheet shows. The host keeps the
// same names and refuses any other.
const BROWSER_NAMES = { chrome: 'Google Chrome', helium: 'Helium', 'chrome-beta': 'Google Chrome Beta', 'chrome-dev': 'Google Chrome Dev',
  'chrome-canary': 'Google Chrome Canary', chromium: 'Chromium', brave: 'Brave Browser', edge: 'Microsoft Edge', vivaldi: 'Vivaldi' };
// A bundle id is the only argument text that reaches the sheet. Anything else leaves the sheet's plain wording.
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
    if (op === 'unblock') return change('permissions-unblock', rest.length === 2 && bundle(value));
    if (op === 'revoke' && rest.length === 2) return undefined;
    if (op === 'sites') return change('permissions-sites');
    if (op === 'repair') return change('permissions-repair');
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
  } else return undefined; // hand and cursor only change how sleight looks
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
export const confirmationLine = (command, code = 'failed') =>
  `sleight: ${command} needs Touch ID or your password, so nothing changed. Reason: ${REASONS[code] ?? REASONS.failed}.${NEXT[code] ?? ''}`;

/** undefined when args are not high-stakes or the person confirmed, else the refusal line. The order holds: presence first
 *  (a Mac nobody is at refuses outright, and nothing is sent to the phone), then one confirmation. confirm(change, options)
 *  may build its helper first: options.ready() starts the sheet's clock (timeoutMs, plus graceMs for the helper to exit),
 *  and until then only buildMs runs. options.abandoned() turns true once this has given up, so a build that finishes later
 *  never shows a sheet. confirm resolves to ok, failed, cancelled, timeout, invalid, unverified, unavailable or no helper;
 *  presence() to true, false or anything else for unknown. Anything that throws refuses. */
export async function confirmationRefusal(args, { confirm, presence = async () => undefined, notice = () => {}, timeoutMs = 60000, graceMs = 5000,
  buildMs = 330000 } = {}) {
  const found = highStakesChange(args);
  if (!found) return undefined;
  const command = settingsCommand(args);
  let present;
  try { present = await presence(); } catch {}
  if (present === false) return confirmationLine(command, 'away');
  if (typeof confirm !== 'function') return confirmationLine(command, 'no helper');
  let result, timer, gaveUp = false;
  try {
    notice(`sleight: ${command}${found.subject ? ` (${found.subject})` : ''} changes what sleight may do. Confirm with Touch ID or your password in the macOS dialog (60 s, Cancel or Ctrl-C stops it).\n`);
    result = await new Promise(resolve => {
      const settle = value => { clearTimeout(timer); resolve(value); };
      timer = setTimeout(() => settle('build timeout'), buildMs);
      const ready = () => { clearTimeout(timer); timer = setTimeout(() => settle('timeout'), timeoutMs + graceMs); };
      Promise.resolve().then(() => confirm(found, { timeoutMs, ready, abandoned: () => gaveUp })).then(settle, () => settle('failed'));
    });
  } catch { result = 'failed'; }
  finally { clearTimeout(timer); gaveUp = true; }
  return result === 'ok' ? undefined : confirmationLine(command, result);
}

// The helper's exit codes (consent-host.swift, PersonConfirmResult).
const EXITS = { 0: 'ok', 1: 'failed', 2: 'cancelled', 3: 'timeout', 64: 'invalid', 69: 'unavailable' };
/** The production confirmation: the host binary's --confirm-person mode, built from sleight's own sources into its helper
 *  cache like the ghost hand's, and run from a private copy (host.mjs prepareConfirmHost). The helper's first line names
 *  the file it runs and its hash; an answer counts only when they match the copy (child.sleightExpected). The helper
 *  withdraws its sheet at timeoutMs; this kills it a little later if it hasn't exited. prepare() resolves to
 *  { status: 'ready', spawn(key, subject) } or anything else when the helper can't run. */
export async function helperConfirm(found, { timeoutMs = 60000, notice = () => {}, ready = () => {}, abandoned = () => false,
  prepare = async () => (await import('./direct-browser/host.mjs')).prepareConfirmHost({ notice }) } = {}) {
  let host;
  try { host = await prepare(); } catch { return 'no helper'; }
  // A caller that gave up during the build already printed its refusal: no sheet after that.
  if (abandoned()) return 'no helper';
  if (host?.status !== 'ready' || typeof host.spawn !== 'function') return 'no helper';
  ready();
  return new Promise(resolve => {
    let child, timer, first, text = '', done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
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
    timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish('timeout'); }, timeoutMs + 2000);
    child.once('error', () => finish('failed'));
    // exit can come before stdout's last data, so the answer waits for the pipe to close.
    // 64 is the helper refusing its arguments before it prints anything; it's a refusal either way, so it says so.
    child.once('close', code => finish(code === 64 ? 'invalid' : first !== undefined && verified() ? EXITS[code] ?? 'failed' : 'unverified'));
  });
}
