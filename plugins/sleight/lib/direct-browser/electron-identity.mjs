import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, normalize } from 'node:path';
import { canonical } from './authority.mjs';

// Typed identity for documents inside an opted-in Electron app. The trusted app
// adapter derives it from the actual owned frame and the reviewed launch recipe.
// Tool arguments and page content never reach createAppBinding, and a document
// that is not a real HTTPS origin never gets an HTTPS-looking string.
//
// Identity layout used by the shared v3 join:
//   browserIncarnation = binding.incarnation (app build, profile, PID birth, window epoch, debugger grant)
//   origin             = real HTTPS origin for a remote frame, or APP_DOCUMENT_PREFIX + digest for an app document
// The digest covers the whole principal, so two file documents that both report the
// opaque origin "null" differ whenever their path, window, PID or build differ.
export const APP_DOCUMENT_PREFIX = 'app-document:v1:';
const INCARNATION = /^app:v1:[0-9a-f]{64}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
// Schemes that never name an app document, even when a recipe lists them.
const NEVER = new Set(['http', 'https', 'file', 'blob', 'data', 'about', 'javascript', 'chrome', 'chrome-extension', 'chrome-untrusted',
  'chrome-search', 'devtools', 'view-source', 'ws', 'wss', 'ftp', 'filesystem', 'mailto', 'tel', 'app-document']);
const brands = new WeakSet(), minted = new Map();
const fail = code => { throw Error(code); };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const printable = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 1;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactly = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absolutePath = value => printable(value) && isAbsolute(value) && normalize(value) === value;
const bundleId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);

// executable and cdhash bind consent to code: the canonical executable path and the code directory hash
// from its signature. A changed binary is a different app for every grant and Always record.
const displayKeys = ['name', 'bundleId', 'signer', 'version', 'runtime', 'profile', 'pid', 'pidBirth', 'executable', 'cdhash'];
const cdhash = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
// The not-yet-launched form names the build and profile a debugger card asks about before any process exists.
// It is pid 0 with birth 'unlaunched' and nothing else; a real process never carries that birth.
export const UNLAUNCHED = 'unlaunched';
const processKnown = app => natural(app.pid) ? app.pidBirth !== UNLAUNCHED : app.pid === 0 && app.pidBirth === UNLAUNCHED;
function shown(app) {
  if (!exactly(app, displayKeys) || !printable(app.name, 256) || !bundleId(app.bundleId) || !printable(app.signer, 256) ||
      !printable(app.version, 128) || !printable(app.runtime, 128) || !absolutePath(app.profile) || !processKnown(app) || !printable(app.pidBirth, 64) ||
      !absolutePath(app.executable) || !cdhash(app.cdhash))
    fail('INVALID_APP_INSTANCE');
  return Object.fromEntries(displayKeys.map(key => [key, app[key]]));
}

// The app the debugger consent names. Exact keys, no extra approval fields.
export function validateAppInstance(app) {
  if (!plain(app) || Object.keys(app).length !== displayKeys.length + 1 || typeof app.temporary !== 'boolean') fail('INVALID_APP_INSTANCE');
  const { temporary, ...rest } = app;
  return Object.freeze({ ...shown(rest), temporary });
}

// What an Always allow persists: the code (executable and cdhash), the build and the profile, never a process.
export const appKey = app => {
  const { bundleId: id, signer, version, runtime, profile, executable, cdhash: hash } = validateAppInstance(app);
  return 'k' + digest({ bundleId: id, signer, version, runtime, profile, executable, cdhash: hash });
};

// The fields of `codesign -dvvv` sleight relies on. Anything missing means no code identity.
export function parseCodesign(text) {
  const field = name => { const match = String(text).match(new RegExp('^' + name + '=(.+)$', 'm')); return match?.[1].trim(); };
  const authority = field('Authority'), team = field('TeamIdentifier');
  const out = { executable: field('Executable'), identifier: field('Identifier'), cdhash: field('CDHash'), team: team === 'not set' ? undefined : team, authority };
  if (!absolutePath(out.executable) || !bundleId(out.identifier) || !cdhash(out.cdhash)) fail('CODE_IDENTITY_UNAVAILABLE');
  return out;
}
const tool = (path, args) => {
  const result = spawnSync(path, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } });
  if (result.error) fail('CODE_IDENTITY_UNAVAILABLE');
  return result;
};
const plist = path => {
  const result = tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path]);
  if (result.status !== 0) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
};
// Production facts for one bundle: a strict signature check, the signature's own fields, and the two plists.
export function inspectCode(bundle) {
  const verified = tool('/usr/bin/codesign', ['--verify', '--strict', '--', bundle]).status === 0;
  const shown = tool('/usr/bin/codesign', ['-dvvv', '--', bundle]);
  return { verified, codesign: shown.status === 0 ? parseCodesign(shown.stderr) : undefined, info: plist(join(bundle, 'Contents', 'Info.plist')),
    electron: plist(join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist')) };
}
// The app instance for a running process. Name, bundle id, signer, version, runtime and cdhash come from the
// signature and the bundle, and the executable must be the one the signature names. A caller supplies only where
// the process lives and which process it is.
export function deriveAppInstance(process, { inspect = inspectCode } = {}) {
  if (!exactly(process, ['bundle', 'executable', 'profile', 'temporary', 'pid', 'pidBirth']) || !absolutePath(process.bundle) || !process.bundle.endsWith('.app') ||
      !absolutePath(process.executable) || !process.executable.startsWith(process.bundle + '/Contents/MacOS/') || typeof process.temporary !== 'boolean')
    fail('INVALID_APP_PROCESS');
  let facts;
  try { facts = inspect(process.bundle); } catch { fail('CODE_IDENTITY_UNAVAILABLE'); }
  const { verified, codesign, info, electron } = facts ?? {};
  if (verified !== true || !codesign || codesign.executable !== process.executable || !printable(codesign.team, 64) || !plain(info) ||
      info.CFBundleIdentifier !== codesign.identifier || !plain(electron) || !printable(electron.CFBundleVersion, 64) || !printable(info.CFBundleShortVersionString, 128))
    fail('CODE_IDENTITY_UNAVAILABLE');
  return validateAppInstance({ name: info.CFBundleDisplayName ?? info.CFBundleName ?? codesign.identifier, bundleId: codesign.identifier, signer: codesign.team,
    version: info.CFBundleShortVersionString, runtime: 'electron/' + electron.CFBundleVersion, profile: process.profile, pid: process.pid, pidBirth: process.pidBirth,
    executable: process.executable, cdhash: codesign.cdhash, temporary: process.temporary });
};

const recipeSchemes = value => {
  if (!Array.isArray(value) || value.length > 16 || value.some(scheme => typeof scheme !== 'string' || !/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) || NEVER.has(scheme)) ||
      new Set(value).size !== value.length) fail('INVALID_APP_RECIPE');
  return [...value];
};
const recipeRoots = value => {
  if (!Array.isArray(value) || value.length > 16 || value.some(root => !absolutePath(root) || root === '/') || new Set(value).size !== value.length) fail('INVALID_APP_RECIPE');
  return value.map(root => root.replace(/\/$/, '') + '/');
};

function parts(href) {
  let url;
  try { url = new URL(href); } catch { fail('APP_DOCUMENT_UNSUPPORTED'); }
  if (url.username || url.password) fail('APP_DOCUMENT_UNSUPPORTED');
  return url;
}

function scheme(url, recipe) {
  const name = url.protocol.slice(0, -1);
  if (name === 'https') return { kind: 'web' };
  if (name === 'file') {
    if (url.host !== '' || !recipe.fileRoots.length) fail('APP_DOCUMENT_UNSUPPORTED');
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { fail('APP_DOCUMENT_UNSUPPORTED'); }
    if (/%2f/i.test(url.pathname) || path.includes('\0') || normalize(path) !== path || !recipe.fileRoots.some(root => path.startsWith(root))) fail('APP_DOCUMENT_UNSUPPORTED');
    return { kind: 'app-document', scheme: 'file', host: '', path, observed: ['null', 'file://'] };
  }
  if (recipe.schemes.includes(name) && !NEVER.has(name) && url.host) return { kind: 'app-document', scheme: name, host: url.host, path: '', observed: ['null', `${name}://${url.host}`] };
  return fail('APP_DOCUMENT_UNSUPPORTED');
}

// Checks a recipe once, for callers that classify many URLs against it.
export const appRecipe = recipe => {
  if (!plain(recipe)) fail('INVALID_APP_RECIPE');
  return Object.freeze({ schemes: Object.freeze(recipeSchemes(recipe.schemes ?? [])), fileRoots: Object.freeze(recipeRoots(recipe.fileRoots ?? [])) });
};
// What a top-level URL could be inside the app, before any frame exists: 'web' (real HTTPS) or
// 'app-document' (a recipe file root or custom scheme). Anything else throws APP_DOCUMENT_UNSUPPORTED.
export const documentKind = (href, rules) => scheme(parts(href), rules).kind;

// The trusted adapter calls this once per app instance and window. authority
// carries the debugger grant (session, turn or null for a session-wide grant) and
// any live PID birth or window recheck. A false current() fences every context.
export function createAppBinding({ instance, window, brokerEpoch, recipe, authority } = {}) {
  const app = validateAppInstance(instance);
  // A binding names a running process and its window; the unlaunched form has neither.
  // ElectronBroker starts at epoch 0. Window epochs start at 1; the broker counter has its own domain.
  if (app.pid === 0 || !exactly(window, ['id', 'epoch']) || !natural(window.id) || !natural(window.epoch) ||
      !Number.isSafeInteger(brokerEpoch) || brokerEpoch < 0 ||
      !plain(recipe) || !plain(authority) || !printable(authority.id, 128) || !SESSION.test(authority.session ?? '') ||
      authority.turn !== null && !printable(authority.turn, 4096) || typeof authority.current !== 'function') fail('INVALID_APP_BINDING');
  const schemes = recipeSchemes(recipe.schemes ?? []), fileRoots = recipeRoots(recipe.fileRoots ?? []), rules = { schemes, fileRoots };
  const display = shown(Object.fromEntries(displayKeys.map(key => [key, app[key]])));
  const frozenWindow = Object.freeze({ id: window.id, epoch: window.epoch });
  const incarnation = 'app:v1:' + digest({ app, window: frozenWindow, brokerEpoch, grant: authority.id, session: authority.session, turn: authority.turn });
  const current = () => { try { return authority.current() === true; } catch { return false; } };
  // frame.url() and frame.parentFrame() are the owned Playwright frame's. observed is the page's
  // location.origin from the same read; undefined re-derives the identity from the URL alone.
  function classify(frame, observed) {
    if (!current() || typeof frame?.url !== 'function') fail('APP_DOCUMENT_UNSUPPORTED');
    const url = parts(frame.url()), kind = scheme(url, rules);
    let principal;
    if (kind.kind === 'web') {
      if (observed !== undefined && observed !== url.origin) fail('APP_DOCUMENT_UNSUPPORTED');
      principal = { kind: 'web-in-app', incarnation, app: display, window: frozenWindow, origin: url.origin };
    } else {
      if (observed !== undefined && !kind.observed.includes(observed)) fail('APP_DOCUMENT_UNSUPPORTED');
      // An app document hosted under a remote page would borrow its authority.
      let depth = 0;
      for (let parent = frame.parentFrame?.(); parent; parent = parent.parentFrame?.()) {
        if (++depth > 16 || scheme(parts(parent.url()), rules).kind !== 'app-document') fail('APP_DOCUMENT_UNSUPPORTED');
      }
      principal = { kind: 'app-document', incarnation, app: display, window: frozenWindow, scheme: kind.scheme, host: kind.host, path: kind.path };
    }
    const origin = principal.kind === 'web-in-app' ? principal.origin : APP_DOCUMENT_PREFIX + digest(principal);
    if (principal.kind === 'app-document') {
      minted.set(origin, true);
      if (minted.size > 4096) minted.delete(minted.keys().next().value);
    }
    return Object.freeze({ origin, principal: Object.freeze({ ...principal, app: Object.freeze(principal.app), window: frozenWindow }) });
  }
  const binding = Object.freeze({ incarnation, session: authority.session, turn: authority.turn, instance: app, window: frozenWindow, current, classify });
  brands.add(binding); return binding;
}
export const isAppBinding = value => !!value && brands.has(value);
// True only for an origin string a trusted binding in this process derived.
export const knownAppDocument = origin => typeof origin === 'string' && minted.has(origin);

// Self-verifying checks for the consent UI: the operation carries its own typed
// principal, and origin and destination must match it exactly.
export function validateOperationPrincipal(operation) {
  const principal = operation.principal;
  if (!plain(principal) || principal.incarnation !== operation.browserIncarnation || !INCARNATION.test(principal.incarnation)) fail('INVALID_APP_PRINCIPAL');
  shown(principal.app);
  if (!exactly(principal.window, ['id', 'epoch']) || !natural(principal.window.id) || !natural(principal.window.epoch)) fail('INVALID_APP_PRINCIPAL');
  const web = () => { const url = new URL(principal.origin); return url.protocol === 'https:' && url.origin === principal.origin && !url.username && !url.password; };
  if (principal.kind === 'web-in-app') {
    if (!exactly(principal, ['kind', 'incarnation', 'app', 'window', 'origin']) || !web() || operation.origin !== principal.origin) fail('INVALID_APP_PRINCIPAL');
    const destination = new URL(operation.destination);
    if (destination.protocol !== 'https:' || destination.username || destination.password) fail('INVALID_DESTINATION');
    return principal;
  }
  if (!exactly(principal, ['kind', 'incarnation', 'app', 'window', 'scheme', 'host', 'path']) || principal.kind !== 'app-document' ||
      !/^[a-z][a-z0-9+.-]{0,31}$/.test(principal.scheme) || NEVER.has(principal.scheme) && principal.scheme !== 'file') fail('INVALID_APP_PRINCIPAL');
  if (principal.scheme === 'file' ? principal.host !== '' || !absolutePath(principal.path) : !printable(principal.host, 253) || principal.path !== '') fail('INVALID_APP_PRINCIPAL');
  if (operation.origin !== APP_DOCUMENT_PREFIX + digest(principal) || operation.destination !== operation.origin + '/') fail('INVALID_APP_PRINCIPAL');
  return principal;
}

// Text for the native card. Callers escape it; the document kind is never inferred from the label.
export function describeOperationDocument(operation) {
  const principal = operation.principal;
  if (!principal) return { documentKind: 'web', origin: operation.origin, destinationOrigin: new URL(operation.destination).origin, app: null };
  const app = `${principal.app.name} ${principal.app.version} (pid ${principal.app.pid})`;
  if (principal.kind === 'web-in-app') return { documentKind: 'web', origin: principal.origin, destinationOrigin: new URL(operation.destination).origin, app };
  const label = principal.scheme === 'file' ? 'file://' + principal.path : `${principal.scheme}://${principal.host}`;
  return { documentKind: 'app-document', origin: label, destinationOrigin: 'this app document', app };
}

// The two debugger-class cards name an app and the requesting session and turn.
export function validateCardOperation(kind, operation) {
  if (!['debugger', 'relaunch'].includes(kind) || !exactly(operation, ['app', 'session', 'turn', 'sequence']) || !SESSION.test(operation.session) ||
      !printable(operation.turn, 4096) || !natural(operation.sequence)) fail('INVALID_OPERATION');
  validateAppInstance(operation.app);
  return operation;
}
export const cardChoices = (kind, operation) => kind === 'relaunch' ? ['relaunch', 'cancel']
  : operation.app.temporary ? ['once', 'session', 'cancel'] : ['once', 'session', 'always', 'cancel'];
