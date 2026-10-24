// A watch can only attach, read accessibility metadata and detach. No page JavaScript or input.
import { readInstalledConfig, acceptedInstalledPackage } from './direct-browser/installed-config.mjs';
import { prepareNativeHelpers, createNativeUi } from './direct-browser/host.mjs';
import { createSelectedConnection } from './direct-browser/selected-connection.mjs';
import { endpointTarget, endpointURL } from './direct-browser/endpoint-guard.mjs';
import { createPermissionCheck } from './permissions.mjs';
import { browserApplicationName, browserBundleId } from './direct-browser/browsers.mjs';

export function watchQuery(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'find,sleightWatch,url' || value.sleightWatch !== 1 ||
      typeof value.url !== 'string' || value.url.length > 8192 || /[\u0000-\u0020\u007f]/.test(value.url) ||
      typeof value.find !== 'string' || !value.find.trim() || value.find.length > 512 || /[\u0000-\u001f\u007f]/.test(value.find))
    throw Error('watch needs only sleightWatch:1, an HTTP(S) url and find text (1 to 512 characters)');
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== value.url)
    throw Error('watch URL must be canonical HTTP(S) without credentials');
  return { sleightWatch: 1, url: value.url, find: value.find };
}

// Same case-insensitive literal alternation as browser_read.find. Never regex, code or instructions.
export function watchMatch(nodes, find) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 10000 || Buffer.byteLength(JSON.stringify(nodes)) > 1048576)
    throw Error('WATCH_READ_INCOMPLETE');
  const terms = [find, ...find.split('|')].map(term => term.trim().toLowerCase()).filter(Boolean);
  const protectedIds = new Set(nodes.filter(node => node.role?.value === 'password' ||
    node.properties?.some(p => p.name === 'protected' && p.value?.value === true)).map(node => node.nodeId));
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const protection = new Map();
  const protectedNode = node => {
    const seen = new Set(); let blocked = false;
    for (let at = node; at; at = byId.get(at.parentId)) {
      if (protection.has(at.nodeId)) { blocked = protection.get(at.nodeId); break; }
      if (protectedIds.has(at.nodeId)) { blocked = true; break; }
      if (seen.has(at.nodeId)) throw Error('WATCH_READ_INCOMPLETE');
      seen.add(at.nodeId);
    }
    for (const id of seen) protection.set(id, blocked);
    return blocked;
  };
  if (!nodes.some(node => node.role?.value === 'RootWebArea' && !node.ignored)) throw Error('WATCH_READ_INCOMPLETE');
  return nodes.some(node => !node.ignored && !protectedNode(node) &&
    !['RootWebArea', 'InlineTextBox'].includes(node.role?.value) && typeof node.name?.value === 'string' &&
    terms.some(term => `${node.role?.value ?? ''} ${node.name.value}`.toLowerCase().includes(term)));
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
  createUi = createNativeUi, timeoutMs = 10000 } = {}) {
  const spec = watchQuery(query), config = readConfig();
  if (!config) throw Error('WATCH_TURBO_OFF');
  const accepted = acceptPackage(config);
  // Scheduled reads may reuse prepared turbo helpers, but never start an unattended compiler/setup prompt.
  const built = await prepareHelpers({ inventory: config.receipt, compile: async () => { throw Error('WATCH_HELPERS_UNAVAILABLE'); } });
  if (built.status !== 'ready') throw Error('WATCH_HELPERS_UNAVAILABLE');
  const selected = await selectConnection({ config, nativeReceipt: built.receipt });
  let session, attached, ui, stopped = false, finishing = false;
  const name = browserApplicationName(config.executable);
  const check = async () => {
    if (stopped || !accepted.current() || JSON.stringify(readConfig()) !== JSON.stringify(config) ||
        permissions.app({ name, bundleId: browserBundleId(name) }) || permissions.site(spec.url) ||
        session && !await selected.verifyConnection(session)) throw Error('WATCH_PERMISSION_OR_CONNECTION_CHANGED');
  };
  const send = (method, params = {}, route) => bounded(async () => {
    await check();
    return session.send(method, params, route);
  }, timeoutMs);
  const targetCheck = (target, expected) => {
    if (!target || target.type !== 'page' || target.url !== spec.url || endpointTarget(target, selected.endpoint) ||
        expected && target.targetId !== expected ||
        [target.pendingUrl, target.pendingURL].some(url => url && url !== spec.url)) throw Error('WATCH_TARGET_CHANGED');
  };
  try {
    await check();
    const stop = () => { if (!finishing) { stopped = true; selected.disconnect().catch(() => {}); } };
    ui = createUi(built.receipt, stop);
    session = await bounded(() => selected.connect(), timeoutMs);
    await check();
    ui.present('watch-connection', { status: 'connected', browser: name }, ['pause', 'disconnect'], event => {
      if (ui.authenticate(event) === true) stop();
    });
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
    // Main-document accessibility names only. Child frames, values, hidden/virtual rows and pixels are outside the predicate.
    const { nodes } = await send('Accessibility.getFullAXTree', { frameId: before.frame.id }, attached);
    const { frameTree: after } = await send('Page.getFrameTree', {}, attached);
    targetCheck((await send('Target.getTargetInfo', { targetId: target.targetId })).targetInfo, target.targetId);
    if (after?.frame?.id !== before.frame.id || after.frame.loaderId !== before.frame.loaderId || after.frame.url !== spec.url)
      throw Error('WATCH_TARGET_CHANGED');
    await check();
    return { matched: watchMatch(nodes, spec.find), binding, scope: 'main-document accessibility names' };
  } finally {
    // Closing a debugger connection never closes, reloads or navigates the watched tab.
    try { if (attached) await bounded(() => session.send('Target.detachFromTarget', { sessionId: attached }), timeoutMs); }
    finally {
      try {
        if (await selected.disconnect() !== true) throw Object.assign(Error('WATCH_CLEANUP_UNCONFIRMED'), { cleanupUnconfirmed: true });
      } finally { finishing = true; ui?.close(); }
    }
    if (stopped) throw Error('WATCH_STOPPED');
  }
}
