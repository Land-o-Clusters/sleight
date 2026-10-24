// A watch can only attach, read accessibility metadata and detach. No page JavaScript or input.
import { readInstalledConfig, acceptedInstalledPackage } from './direct-browser/installed-config.mjs';
import { prepareNativeHelpers } from './direct-browser/host.mjs';
import { createSelectedConnection } from './direct-browser/selected-connection.mjs';
import { endpointTarget, endpointURL } from './direct-browser/endpoint-guard.mjs';
import { createPermissionCheck } from './permissions.mjs';
import { browserApplicationName, browserBundleId } from './direct-browser/browsers.mjs';

const protectedFields = ['input[type="password" i]', ...['current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'webauthn'].map(token => `[autocomplete~="${token}" i]`)].join(',');
const readMethods = new Set(['Target.getTargets', 'Target.getTargetInfo', 'Target.attachToTarget',
  'Page.getFrameTree', 'DOM.enable', 'DOM.performSearch', 'DOM.discardSearchResults', 'Accessibility.getFullAXTree']);

export function watchQuery(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'find,sleightWatch,url' || value.sleightWatch !== 1 ||
      typeof value.url !== 'string' || value.url.length > 8192 || /[\u0000-\u0020\u007f]/.test(value.url) ||
      typeof value.find !== 'string' || !value.find.trim() || value.find.length > 512 || /[\u0000-\u001f\u007f]/.test(value.find))
    throw Error('watch needs only sleightWatch:1, an HTTP(S) url and find text (1 to 512 characters)');
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== value.url)
    throw Error('watch URL must be canonical HTTP(S) without credentials');
  // Decode nested URL encodings too. Treat credential keys and opaque bearer-like values as private.
  let suffix = (url.search + url.hash).replace(/\+/g, ' ');
  for (let n = 0; n < 4; n++) {
    if (/(?:token|secret|password|passwd|credential|authorization|api[_-]?key|session|cookie|signature|(?:^|[?&#/;])(?:auth|key|sid|code|otp|pin|jwt|csrf|nonce)\s*=)/i.test(suffix) ||
        /bearer\s|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|[A-Za-z0-9_~-]{24,}/i.test(suffix))
      throw Error('watch URL query or fragment looks like a secret; use a public URL without credentials');
    let decoded;
    try { decoded = decodeURIComponent(suffix); } catch { throw Error('watch URL query or fragment has invalid encoding'); }
    if (decoded === suffix) break;
    suffix = decoded.replace(/\+/g, ' ');
    if (n === 3) throw Error('watch URL query or fragment looks like an encoded secret');
  }
  return { sleightWatch: 1, url: value.url, find: value.find };
}

// Same case-insensitive literal alternation as browser_read.find. Never regex, code or instructions.
export function watchMatch(nodes, find) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 10000 || Buffer.byteLength(JSON.stringify(nodes)) > 1048576)
    throw Error('WATCH_READ_INCOMPLETE');
  const terms = [find, ...find.split('|')].map(term => term.trim().toLowerCase()).filter(Boolean);
  if (nodes.some(node => /password/i.test(node.role?.value ?? '') ||
      node.properties?.some(p => p.name === 'protected' && p.value?.value === true))) throw Error('WATCH_PROTECTED_FIELDS');
  if (!nodes.some(node => node.role?.value === 'RootWebArea' && !node.ignored)) throw Error('WATCH_READ_INCOMPLETE');
  return nodes.some(node => !node.ignored &&
    !['RootWebArea', 'InlineTextBox'].includes(node.role?.value) && typeof node.name?.value === 'string' &&
    terms.some(term => node.name.value.toLowerCase().includes(term)));
}

function bounded(run, ms) {
  let timer;
  return Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('WATCH_READ_TIMEOUT')), ms);
  })]).finally(() => clearTimeout(timer));
}

// Dependencies are code-owned test seams, never saved watch data or CLI options.
export async function readWatch(query, previous, { readConfig = readInstalledConfig, acceptPackage = acceptedInstalledPackage,
  prepareHelpers = prepareNativeHelpers, selectConnection = createSelectedConnection, permissions = createPermissionCheck(),
  publicOrigin, timeoutMs = 10000 } = {}) {
  const spec = watchQuery(query);
  if (publicOrigin !== new URL(spec.url).origin) throw Error('WATCH_PUBLIC_HOST_REQUIRED');
  const config = readConfig();
  if (!config) throw Error('WATCH_TURBO_OFF');
  const accepted = acceptPackage(config);
  // Scheduled reads may reuse prepared turbo helpers, but never start an unattended compiler/setup prompt.
  const built = await prepareHelpers({ inventory: config.receipt, compile: async () => { throw Error('WATCH_HELPERS_UNAVAILABLE'); } });
  if (built.status !== 'ready') throw Error('WATCH_HELPERS_UNAVAILABLE');
  const selected = await selectConnection({ config, nativeReceipt: built.receipt });
  let session, attached;
  const name = browserApplicationName(config.executable);
  const check = async () => {
    if (!accepted.current() || JSON.stringify(readConfig()) !== JSON.stringify(config) ||
        permissions.app({ name, bundleId: browserBundleId(name) }) || permissions.site(spec.url) ||
        session && !await selected.verifyConnection(session)) throw Error('WATCH_PERMISSION_OR_CONNECTION_CHANGED');
  };
  const send = (method, params = {}, route) => bounded(async () => {
    if (!readMethods.has(method)) throw Error('WATCH_COMMAND_REFUSED');
    await check();
    return session.send(method, params, route);
  }, timeoutMs);
  const targetCheck = (target, expected) => {
    if (!target || target.type !== 'page' || target.url !== spec.url || endpointTarget(target, selected.endpoint) ||
        expected && target.targetId !== expected ||
        [target.pendingUrl, target.pendingURL].some(url => url && url !== spec.url)) throw Error('WATCH_TARGET_CHANGED');
  };
  const checkFrameOrigins = tree => {
    if (!tree?.frame || !Array.isArray(tree.childFrames ?? [])) throw Error('WATCH_READ_INCOMPLETE');
    const frame = tree.frame;
    const inherited = ['about:blank', 'about:srcdoc'].includes(frame.url) && frame.securityOrigin === publicOrigin;
    if (!inherited && new URL(frame.url).origin !== publicOrigin) throw Error('WATCH_PUBLIC_HOST_REQUIRED');
    return (tree.childFrames ?? []).reduce((count, child) => count + 1 + checkFrameOrigins(child), 0);
  };
  try {
    await check();
    session = await bounded(() => selected.connect(), timeoutMs);
    await check();
    const { targetInfos } = await send('Target.getTargets');
    const candidates = targetInfos?.filter(target => target.type === 'page' && target.url === spec.url);
    if (candidates?.length !== 1) throw Error('WATCH_NEEDS_ONE_EXISTING_TAB');
    const target = candidates[0]; targetCheck(target);
    const binding = { browser: selected.selectedBrowser, incarnation: selected.browserIncarnation, target: target.targetId };
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw Error('WATCH_TARGET_CHANGED');
    ({ sessionId: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    if (typeof attached !== 'string' || !attached) throw Error('WATCH_TARGET_CHANGED');
    targetCheck((await send('Target.getTargetInfo', { targetId: target.targetId })).targetInfo, target.targetId);
    const { frameTree: before } = await send('Page.getFrameTree', {}, attached);
    if (!before?.frame?.id || !before.frame.loaderId || before.frame.url !== spec.url ||
        endpointURL(before.frame.url, selected.endpoint)) throw Error('WATCH_TARGET_CHANGED');
    const beforeChildren = checkFrameOrigins(before);
    // Chromium AX omits the protected flag for real password inputs. Inspect only the count
    // of a fixed DOM selector, including shadow roots and child documents, never field values.
    await send('DOM.enable', {}, attached);
    const searchCount = async query => {
      const { searchId, resultCount } = await send('DOM.performSearch', { query, includeUserAgentShadowDOM: true }, attached);
      if (typeof searchId !== 'string' || !searchId) throw Error('WATCH_READ_INCOMPLETE');
      try {
        if (!Number.isSafeInteger(resultCount) || resultCount < 0) throw Error('WATCH_READ_INCOMPLETE');
        return resultCount;
      } finally { await send('DOM.discardSearchResults', { searchId }, attached); }
    };
    const checkProtectedFields = async children => {
      // Out-of-process child documents are absent from this renderer's frame tree and DOM
      // search. Refuse unmatched embeds rather than silently overlooking a private child page.
      if (await searchCount('iframe,frame,object,embed,fencedframe') !== children) throw Error('WATCH_PUBLIC_HOST_REQUIRED');
      if (await searchCount(protectedFields)) throw Error('WATCH_PROTECTED_FIELDS');
    };
    await checkProtectedFields(beforeChildren);
    // Main-document accessibility names only. Child frames, values, hidden/virtual rows and pixels are outside the predicate.
    const { nodes } = await send('Accessibility.getFullAXTree', { frameId: before.frame.id }, attached);
    const { frameTree: after } = await send('Page.getFrameTree', {}, attached);
    targetCheck((await send('Target.getTargetInfo', { targetId: target.targetId })).targetInfo, target.targetId);
    if (after?.frame?.id !== before.frame.id || after.frame.loaderId !== before.frame.loaderId || after.frame.url !== spec.url)
      throw Error('WATCH_TARGET_CHANGED');
    await checkProtectedFields(checkFrameOrigins(after));
    await check();
    return { matched: watchMatch(nodes, spec.find), binding, scope: 'main-document accessibility names' };
  } finally {
    // Closing a debugger connection never closes, reloads or navigates the watched tab.
    try { if (attached) await bounded(() => session.send('Target.detachFromTarget', { sessionId: attached }), timeoutMs); }
    finally {
      if (await selected.disconnect() !== true) throw Object.assign(Error('WATCH_CLEANUP_UNCONFIRMED'), { cleanupUnconfirmed: true });
    }
  }
}
