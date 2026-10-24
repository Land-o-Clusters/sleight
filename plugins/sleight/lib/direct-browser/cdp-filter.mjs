// Turbo v3's private CDP boundary. Ownership is supplied by the trusted tab
// registry, never by a tool argument or page text. No upstream browser-wide
// auto-attach is installed: it would attach to the user's other tabs too.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const refuse = () => { throw Error('CDP_COMMAND_REFUSED'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
// Cookie jars, device-bound sessions and download configuration belong to the
// browser profile/context. A page route cannot scope their URL/domain arguments.
const forbidden = new Set(['Page.bringToFront', 'Target.activateTarget',
  'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.getAllCookies',
  'Network.deleteCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies',
  'Network.enableDeviceBoundSessions', 'Network.deleteDeviceBoundSession', 'Page.deleteCookie', 'Page.setDownloadBehavior']);
// CDP Fetch patterns use glob wildcards, with backslash escaping.
function fetchMatch(pattern, params) {
  if (pattern.resourceType && pattern.resourceType !== params.resourceType) return false;
  const stage = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined ? 'Response' : 'Request';
  if ((pattern.requestStage ?? 'Request') !== stage) return false;
  let source = '^', escaped = false;
  for (const char of pattern.urlPattern ?? '*') {
    if (!escaped && char === '\\') { escaped = true; continue; }
    source += !escaped && char === '*' ? '.*' : !escaped && char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = false;
  }
  if (escaped) source += '\\\\';
  return new RegExp(source + '$', 's').test(params.request?.url ?? '');
}
// An opted-in Electron app's pages are its windows: the filter never creates or closes them, never closes or crashes a
// renderer, and leaves focus emulation off until a build qualifies it (electron-v3-plan, EPV3-3).
const appForbidden = new Set(['Target.createTarget', 'Target.closeTarget', 'Page.close', 'Page.crash', 'Emulation.setFocusEmulationEnabled']);
const domains = new Set(['Page', 'Runtime', 'DOM', 'DOMSnapshot', 'CSS', 'Accessibility', 'Input',
  'Network', 'Fetch', 'Log', 'Emulation', 'Inspector', 'Debugger', 'Performance']);
// A page session's Fetch can't pause a popup's first request: the browser makes
// the popup and sends its navigation before any session can attach to it. So
// each upstream connection also gets one browser-level Fetch guard, shared by
// its filters and kept for the connection's life. Its patterns match only the
// selected port (loopback hosts when that port is 80 or 443), so no other
// request from the user's tabs is paused.
const browserGuards = new WeakMap();
function guardBrowser(upstream, port, isProtected) {
  if (browserGuards.has(upstream)) return browserGuards.get(upstream);
  // Fetch reports URLs with userinfo, and the debug server speaks plain http even on 443.
  const patterns = ![80, 443].includes(port) ? [{ urlPattern: '*://*:' + port + '/*', requestStage: 'Request' }] :
    ['127.0.0.1', 'localhost', '*.localhost', 'localhost.', '*.localhost.', '[::1]', '0.0.0.0', '[::ffff:7f00:1]']
      .flatMap(host => [host, '*@' + host].map(spelled => ({ urlPattern: (port === 80 ? 'http' : 'https') + '://' + spelled + '/*', requestStage: 'Request' })))
      .concat(port === 443 ? [{ urlPattern: '*://*:443/*', requestStage: 'Request' }] : []);
  const paused = frame => {
    if (frame?.sessionId !== undefined || frame?.method !== 'Fetch.requestPaused' || !id(frame.params?.requestId)) return;
    const blocked = isProtected(frame.params.request?.url), requestId = frame.params.requestId;
    const fail = () => upstream.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    // A request left paused would hang its tab. A failed continue falls back to failing it.
    (blocked ? fail() : upstream.send('Fetch.continueRequest', { requestId }).catch(fail)).catch(() => {});
  };
  upstream.on('event', paused);
  const ready = upstream.send('Fetch.enable', { patterns }).then(() => {}, () => {
    upstream.off('event', paused); browserGuards.delete(upstream); throw Error('CDP_DEVTOOLS_GUARD_UNAVAILABLE');
  });
  browserGuards.set(upstream, ready);
  return ready;
}

// app: { admit(targetInfo), current(targetId) } from electron-targets.mjs. With it, a top-level target is owned only after
// admit() and current() agree, an initial owned list is refused, and children are frames only.
export function createCDPFilter({ session: upstream, ownedTargets = [], protectedPort, app } = {}) {
  if (!upstream || !id(upstream.sessionId) || !['send', 'on', 'off'].every(name => typeof upstream[name] === 'function') ||
      !Array.isArray(ownedTargets) || !ownedTargets.every(id)) throw Error('CDP_CONNECTION_REQUIRED');
  if (app !== undefined && (typeof app?.admit !== 'function' || typeof app?.current !== 'function' || ownedTargets.length || protectedPort !== undefined))
    throw Error('CDP_CONNECTION_REQUIRED');
  const childTypes = app ? ['iframe'] : ['iframe', 'worker'];
  if (protectedPort !== undefined && (!Number.isInteger(protectedPort) || protectedPort < 1 || protectedPort > 65535)) throw Error('CDP_CONNECTION_REQUIRED');
  const guardPatterns = protectedPort === undefined ? [] : [{ urlPattern: '*://*:' + protectedPort + '/*', requestStage: 'Request' },
    ...([80,443].includes(protectedPort) ? [{ urlPattern: (protectedPort === 80 ? 'http' : 'https') + '://*/*', requestStage: 'Request' }] : [])];
  const protectedUrl = url => {
    try { const parsed = new URL(url); return Number(parsed.port || (['https:','wss:'].includes(parsed.protocol) ? 443 : 80)) === protectedPort; }
    catch { return false; }
  };
  const owned = new Set(ownedTargets), routes = new Map(), listeners = new Set(), attaching = new Map(), bridges = new Set(), browserRoutes = new Set(), attachmentParents = new Map();
  const endpointTargets = new Set();
  const attachments = new Map(), outstanding = new Set(), collectedSessions = new Set();
  const navigationWatches = new Map();
  let closed = false, autoAttach = false, disposal, listening = true;
  const root = upstream.sessionId;
  const live = () => { if (closed) throw Error('CDP_FILTER_CLOSED'); };
  const owns = target => owned.has(target) || [...routes.values()].some(route => route.target === target);
  const checkTarget = target => { if (!id(target) || !owns(target)) throw Error('CDP_TARGET_NOT_OWNED'); };
  const autoAttachParams = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [...childTypes.map(type => ({ type })), { exclude: true }] };
  const routed = (frame, parent) => {
    const value = { ...frame };
    if (parent === undefined) delete value.sessionId; else value.sessionId = parent;
    return value;
  };
  function emit(event) { for (const listener of listeners) try { listener(event); } catch {} }
  function finishEvents() {
    if (closed && listening && !attachments.size && !outstanding.size) {
      upstream.off('event', event); listening = false;
    }
  }
  function removeRoute(name) {
    for (const [child, route] of routes) if (route.parent === name) removeRoute(child);
    routes.delete(name);
  }
  // Input authority can disappear before a session is physically detached.
  // Keep the actual upstream parent, not the virtual browser route, for cleanup.
  function acquired(name, target, parent = root, virtualParent) {
    if (collectedSessions.has(name)) return false;
    if (!attachments.has(name)) attachments.set(name, { target, parent, virtualParent });
    return true;
  }
  function collected(name) {
    for (const [child, attachment] of attachments) if (attachment.parent === name) collected(child);
    attachments.delete(name); collectedSessions.add(name); removeRoute(name);
    finishEvents();
  }
  async function detach(name) {
    const attachment = attachments.get(name);
    if (!attachment) return true;
    if (attachment.detaching) return attachment.detaching;
    attachment.detaching = (async () => {
      try {
        await upstream.send('Target.detachFromTarget', { sessionId: name }, attachment.parent);
        collected(name); return true;
      } catch { return !attachments.has(name); }
    })();
    try { return await attachment.detaching; } finally { attachment.detaching = undefined; }
  }
  function revoke(target) {
    owned.delete(target);
    navigationWatches.delete(target);
    for (const [name, route] of routes) if (route.target === target || route.owner === target) removeRoute(name);
  }
  function event(frame) {
    if (!object(frame) || typeof frame.method !== 'string' || !object(frame.params) ||
        frame.sessionId !== undefined && !id(frame.sessionId)) return;
    const params = frame.params;
    // Collection proof uses the physical attachment bank even after routes are
    // revoked. Only its exact upstream parent can report this session detached.
    if (frame.method === 'Target.detachedFromTarget') {
      const detached = id(params.sessionId) && attachments.get(params.sessionId);
      if (!detached || (frame.sessionId ?? root) !== detached.parent ||
          params.targetId !== undefined && params.targetId !== detached.target) return;
      const virtualParent = detached.virtualParent;
      collected(params.sessionId);
      if (!closed && !detached.private) emit(routed({ ...frame, params: { ...params, targetId: detached.target } }, virtualParent));
      return;
    }
    if (closed && frame.method !== 'Target.attachedToTarget') return;
    const parent = frame.sessionId === undefined ? undefined : (closed ? attachments : routes).get(frame.sessionId);
    if (frame.sessionId !== undefined && !parent) return;
    if (!closed && parent?.type === 'iframe' && !parent.private && frame.method === 'Page.frameRequestedNavigation') {
      for (const listener of navigationWatches.get(parent.owner) ?? []) try {
        listener(params, () => routes.get(frame.sessionId) === parent && owned.has(parent.owner)
          ? upstream.send('Page.stopLoading', {}, frame.sessionId) : Promise.resolve());
      } catch { /* Observers cannot change event routing. */ }
    }
    if (parent && protectedPort !== undefined && frame.method === 'Fetch.requestPaused') {
      const protectedRequest = protectedUrl(params.request?.url);
      if (protectedRequest && params.resourceType === 'Document') endpointTargets.add(parent.owner);
      if (protectedRequest || !(parent.fetchPatterns ?? []).some(pattern => fetchMatch(pattern, params))) {
        upstream.send(protectedRequest ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          { requestId: params.requestId, ...(protectedRequest ? { errorReason: 'BlockedByClient' } : {}) }, frame.sessionId)
          .catch(error => {
            // Cancellation can invalidate a paused request before its reply.
            // Only that protocol error proves this interception already ended.
            if (/^Invalid InterceptionId\.?$/.test(error.message)) return;
            removeRoute(frame.sessionId); detach(frame.sessionId).catch(() => {});
          });
        return;
      }
    }
    if (frame.method === 'Target.attachedToTarget') {
      const info = params.targetInfo;
      if (!object(info) || !id(info.targetId) || !id(params.sessionId)) return;
      // In app mode a top-level session counts only while this filter's own attach for it is in flight, so a
      // private read session on the same pipe (electron-targets.mjs) never becomes a Playwright route.
      const allowed = parent ? childTypes.includes(info.type) :
        (closed ? attachmentParents.has(info.targetId) : owned.has(info.targetId) && (!app || attachmentParents.has(info.targetId))) && info.type === 'page';
      if (!allowed) {
        // Unrelated targets never acquire a route or expose their metadata.
        if (parent && !closed) {
          if (params.waitingForDebugger) upstream.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
          upstream.send('Target.detachFromTarget', { sessionId: params.sessionId }, frame.sessionId).catch(() => {});
        }
        return;
      }
      if (routes.has(params.sessionId)) return;
      const virtualParent = parent ? info.type === 'page' ? parent.browserParent : frame.sessionId : attachmentParents.get(info.targetId);
      if (!acquired(params.sessionId, info.targetId, frame.sessionId ?? root, virtualParent)) return;
      if (closed) return; // Late attachments stay private and grant no input route.
      const route = { target: info.targetId, owner: parent?.owner ?? info.targetId, parent: virtualParent,
        browserParent: parent ? parent.browserParent : virtualParent, type: info.type, scripts: new Map(), live: false };
      attachments.get(params.sessionId).private = route.private;
      routes.set(params.sessionId, route);
      frame = routed(frame, virtualParent);
      if (protectedPort !== undefined) {
        route.ready = (async () => {
          // One burst, then wait for the answers. Commands on a session run in the order sent, so the port guard, the child
          // auto-attach, the caller's scripts (frames.addScript: in place before the frame's first script runs, which Playwright's
          // own init scripts do not guarantee) and the resume are ordered without a round trip between them. The pause matters:
          // the browser replaces an iframe's first target a few milliseconds after creating it, and in 3 of 3 runs with one more
          // round trip before the resume the replacement never attached to the filter.
          // Chrome drops a nested frame's pending load when Target.setAutoAttach reaches a session above it a second time, or
          // from a second session on the same page while that frame loads, and the page then stays "interactive" for good (a
          // cross-site frame in a cross-site frame: 20 to 22 of 24 loads stuck at depth 2; without the filter or Playwright, a repeat on an
          // iframe session left 5 to 7 of 30 stuck and none without it). So every session gets it once, and a page gets it
          // from one session: the first, here, before the page is announced; a later session of the same page (a probe, a
          // snapshot read, the registry's handle) only when its caller asks, and a repeat from a caller is answered without
          // sending (see Target.setAutoAttach below). A frame or worker session gets it here, so its children are caught at once.
          route.autoAttached = !(route.type === 'page' && [...routes.values()].some(other => other !== route && other.target === route.target && other.autoAttached));
          const sends = [upstream.send('Fetch.enable', { patterns: guardPatterns }, params.sessionId),
            ...(route.type === 'iframe' && navigationWatches.get(route.owner)?.size ? [upstream.send('Page.enable', {}, params.sessionId)] : []),
            ...(route.autoAttached ? [upstream.send('Target.setAutoAttach', autoAttachParams, params.sessionId)] : []),
            ...(route.type === 'iframe' ? installScripts(params.sessionId, route) : [])];
          const resume = params.waitingForDebugger ? upstream.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId) : undefined;
          resume?.catch(() => {});
          await Promise.all(sends);
          if (closed || routes.get(params.sessionId) !== route) return;
          if (!route.private) emit(frame);
          await resume;
          route.live = true;
        })();
        route.ready.catch(() => { removeRoute(params.sessionId); detach(params.sessionId).catch(() => {}); });
        return;
      }
    } else if (frame.method.startsWith('Target.')) {
      const target = params.targetInfo?.targetId ?? params.targetId;
      if (!owns(target)) return;
      if (frame.method === 'Target.targetDestroyed') revoke(target);
    } else if (!parent) return; // No browser-global events or foreign sessions.
    if (!parent?.private) emit(frame);
  }
  upstream.on('event', event);
  // Scripts for the iframe sessions (any depth) of one owned page: owner -> entries. A session gets each entry once, before it
  // is resumed (new frames) or when the entry is added (frames already running, whose later documents it reaches).
  const frameScripts = new Map();
  // Sends the entries this session lacks, in this call (no await before the sends), and returns the pending answers.
  function installScripts(name, route) {
    const sent = [];
    for (const entry of frameScripts.get(route.owner) ?? []) {
      if (route.scripts.has(entry)) continue;
      // Without the Page domain enabled on the session, the browser takes the script and never runs it (measured: the hook was
      // missing from every document it was meant for).
      if (!route.pageEnabled) { route.pageEnabled = true; const enabled = upstream.send('Page.enable', {}, name); enabled.catch(() => {}); sent.push(enabled); }
      const pending = upstream.send('Page.addScriptToEvaluateOnNewDocument', { source: entry.source }, name)
        .then(result => { if (!id(result?.identifier)) throw Error('CDP_FRAME_SCRIPT_FAILED'); return result.identifier; });
      pending.catch(() => {});
      route.scripts.set(entry, pending); sent.push(pending);
    }
    return sent;
  }
  // Private routes are the read-only sessions attach() hands out for an owned page's iframes; they carry no hook and are never counted.
  const frameRoutes = owner => [...routes].filter(([, route]) => route.type === 'iframe' && route.owner === owner && !route.private);
  const frames = Object.freeze({
    async watchNavigations(owner, listener) {
      live(); checkTarget(owner);
      if (typeof listener !== 'function') throw Error('CDP_FRAME_WATCH_REQUIRED');
      const bank = navigationWatches.get(owner) ?? new Set();
      bank.add(listener); navigationWatches.set(owner, bank);
      const remove = () => { bank.delete(listener); if (!bank.size && navigationWatches.get(owner) === bank) navigationWatches.delete(owner); };
      try { await Promise.all(frameRoutes(owner).map(([name]) => upstream.send('Page.enable', {}, name))); }
      catch (error) { remove(); throw error; }
      return Object.freeze({ remove });
    },
    // The running iframe sessions of an owned page, at any depth: the frames in other processes.
    sessions(owner) { live(); checkTarget(owner); return frameRoutes(owner).filter(([, route]) => route.live).map(([name]) => name); },
    // Install source in every iframe session of the page, now and for every one that attaches before remove() is called.
    async addScript(owner, source) {
      live(); checkTarget(owner);
      if (typeof source !== 'string' || !source) throw Error('CDP_FRAME_SCRIPT_FAILED');
      const entry = { source }, entries = frameScripts.get(owner) ?? new Set();
      entries.add(entry); frameScripts.set(owner, entries);
      const remove = async () => {
        entries.delete(entry);
        await Promise.all([...routes].map(async ([name, route]) => {
          const pending = route.scripts.get(entry);
          if (pending === undefined) return;
          route.scripts.delete(entry);
          const identifier = await pending.catch(() => undefined);
          if (identifier !== undefined) await upstream.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, name).catch(() => {});
        }));
      };
      try {
        await Promise.all(frameRoutes(owner).map(([name, route]) => {
          installScripts(name, route);
          // A session that is already gone (the browser replaces an iframe's first target at once) has nothing to install.
          return route.scripts.get(entry)?.catch(error => { if (routes.get(name) === route) throw error; });
        }));
      }
      catch (error) { await remove(); throw error; }
      return Object.freeze({ remove });
    },
    // Evaluate a fixed expression in the main world of the session's top frame; returns its value.
    async evaluate(owner, name, expression) {
      live(); checkTarget(owner);
      const route = routes.get(name);
      if (!route || route.type !== 'iframe' || route.private || route.owner !== owner || !route.live || typeof expression !== 'string') throw Error('CDP_SESSION_NOT_OWNED');
      const result = await upstream.send('Runtime.evaluate', { expression, returnByValue: true }, name);
      if (result?.exceptionDetails) throw Error('CDP_COMMAND_FAILED');
      return result?.result?.value;
    },
  });
  // The only non-page target the filter attaches to: an iframe that its own auto-attach chain from an owned page's session
  // delivered (its route has the iframe type and an owner that is still owned). Anything else (another tab, a popup that is
  // not adopted, a worker, a service worker, the browser) has no such route and is refused before the upstream attach.
  const ownedFrame = target => [...routes.values()].find(route => route.target === target && route.type === 'iframe' &&
    !route.private && owned.has(route.owner));
  async function attach(target, virtualParent) {
    checkTarget(target);
    const frameOwner = owned.has(target) ? undefined : ownedFrame(target)?.owner;
    if (!owned.has(target) && frameOwner === undefined) throw Error('CDP_ATTACHMENT_INVALID');
    const previous = attaching.get(target);
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      live(); checkTarget(target);
      if (protectedPort !== undefined) { await guardBrowser(upstream, protectedPort, protectedUrl); live(); checkTarget(target); }
      attachmentParents.set(target, virtualParent);
      let name;
      try {
        const request = {}; outstanding.add(request);
        let result;
        try { result = await upstream.send('Target.attachToTarget', { targetId: target, flatten: true }); }
        finally { outstanding.delete(request); }
        if (!id(result?.sessionId)) throw Error('CDP_ATTACHMENT_INVALID');
        name = result.sessionId;
        if (!acquired(name, target, root, virtualParent)) throw Error('CDP_SESSION_NOT_OWNED');
        live(); checkTarget(target);
        if (virtualParent && !browserRoutes.has(virtualParent)) throw Error('CDP_SESSION_NOT_OWNED');
        if (!routes.has(result.sessionId)) {
          const { targetInfo } = await upstream.send('Target.getTargetInfo', { targetId: target });
          live(); checkTarget(target);
          if (targetInfo?.targetId !== target) throw Error('CDP_ATTACHMENT_INVALID');
          if (frameOwner !== undefined) {
            // A second, private session on an owned page's iframe, for reading (the snapshot scans every frame). Playwright never
            // sees an attach or detach event for it (it would adopt the iframe's target as a new frame), it takes no child
            // auto-attach and no hook, and it gets the same port guard as the frame's own session before its first command.
            if (targetInfo.type !== 'iframe' || ownedFrame(target)?.owner !== frameOwner) throw Error('CDP_ATTACHMENT_INVALID');
            const route = { target, owner: frameOwner, parent: virtualParent, browserParent: virtualParent, type: 'iframe', private: true,
              scripts: new Map(), live: false };
            attachments.get(name).private = true;
            routes.set(name, route);
            route.ready = (async () => {
              if (protectedPort !== undefined) await upstream.send('Fetch.enable', { patterns: guardPatterns }, name);
              if (closed || routes.get(name) !== route) return;
              route.live = true;
            })();
            route.ready.catch(() => { removeRoute(name); detach(name).catch(() => {}); });
          } else {
            if (targetInfo.type !== 'page') throw Error('CDP_ATTACHMENT_INVALID');
            event({ method: 'Target.attachedToTarget', params: { sessionId: result.sessionId, targetInfo, waitingForDebugger: false } });
          }
        }
        if (routes.get(name)?.target !== target) throw Error('CDP_ATTACHMENT_INVALID');
        await routes.get(name).ready;
        live(); checkTarget(target);
        return result;
      } catch (error) {
        if (name) await detach(name);
        throw error;
      } finally { attachmentParents.delete(target); finishEvents(); }
    })();
    attaching.set(target, pending);
    try { return await pending; } finally { if (attaching.get(target) === pending) attaching.delete(target); }
  }
  async function own(target) {
    live(); if (!id(target)) throw Error('CDP_TARGET_NOT_OWNED');
    const { targetInfo } = await upstream.send('Target.getTargetInfo', { targetId: target });
    live();
    if (targetInfo?.targetId !== target || targetInfo.type !== 'page') throw Error('CDP_TARGET_NOT_OWNED');
    if (app) {
      const admitted = await app.admit(targetInfo);
      live();
      if (admitted !== true || app.current(target) !== true) throw Error('CDP_TARGET_NOT_OWNED');
    }
    owned.add(target);
    if (autoAttach && ![...routes.values()].some(route => route.target === target)) await attach(target);
  }
  const session = Object.freeze({ sessionId: root,
    async send(method, params = {}, route = root) {
      live();
      if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(method) || !object(params) || forbidden.has(method) ||
          app && appForbidden.has(method)) refuse();
      const isRoot = route === undefined || route === root || browserRoutes.has(route);
      if (!isRoot && !routes.has(route)) throw Error('CDP_SESSION_NOT_OWNED');
      if (!isRoot) {
        const ownedRoute = routes.get(route);
        await ownedRoute.ready;
        live(); if (routes.get(route) !== ownedRoute) throw Error('CDP_SESSION_NOT_OWNED');
      }
      const [domain] = method.split('.');
      if (domain === 'Browser') {
        if (!isRoot || method !== 'Browser.getVersion') refuse();
        return upstream.send(method, {});
      }
      if (domain === 'Target') {
        if (method === 'Target.attachToBrowserTarget' && isRoot) {
          const sessionId = 'sleight-browser-' + randomBytes(16).toString('hex');
          browserRoutes.add(sessionId); return { sessionId };
        }
        if (method === 'Target.setAutoAttach') {
          if (typeof params.autoAttach !== 'boolean' || params.flatten !== true) refuse();
          if (!isRoot && routes.get(route).private) refuse();
          if (!isRoot && protectedPort !== undefined) {
            // The parameters are fixed, so a repeat changes nothing the browser keeps, and the repeat itself can stall a
            // nested frame that is loading (see the burst).
            const ownedRoute = routes.get(route);
            if (ownedRoute.autoAttached) return {};
            ownedRoute.autoAttached = true;
            try { return await upstream.send(method, autoAttachParams, route); }
            catch (error) { ownedRoute.autoAttached = false; throw error; }
          }
          if (!isRoot) return upstream.send(method, { autoAttach: params.autoAttach, waitForDebuggerOnStart: true, flatten: true,
            ...(app ? { filter: autoAttachParams.filter } : {}) }, route);
          autoAttach = params.autoAttach;
          if (autoAttach) for (const target of owned) if (![...routes.values()].some(r => r.target === target)) await attach(target);
          return {};
        }
        if (method === 'Target.getTargets' && isRoot) {
          const { targetInfos } = await upstream.send(method, {});
          live(); return { targetInfos: targetInfos.filter(info => owns(info.targetId)) };
        }
        if (method === 'Target.setDiscoverTargets' && isRoot) return {}; // No global discovery side effects.
        if (method === 'Target.getTargetInfo') {
          if (isRoot && params.targetId === undefined) return { targetInfo: { targetId: 'sleight-browser', type: 'browser', title: '', url: '', attached: true } };
          const target = params.targetId ?? routes.get(route)?.target;
          checkTarget(target);
          const result = await upstream.send(method, { targetId: target }); live(); checkTarget(target); return result;
        }
        if (method === 'Target.createTarget' && isRoot) {
          if (typeof params.url !== 'string' || Object.keys(params).some(key => !['url', 'background'].includes(key)) || params.background === false) refuse();
          // Attach the port guard before the first untrusted navigation. The
          // owned registry creates blank targets and navigates after admission.
          if (protectedPort !== undefined && params.url !== 'about:blank') refuse();
          const result = await upstream.send(method, { url: params.url, background: true });
          await own(result.targetId); return result;
        }
        if (method === 'Target.attachToTarget' && isRoot) {
          if (params.flatten !== true) refuse();
          return attach(params.targetId, browserRoutes.has(route) ? route : undefined);
        }
        if (method === 'Target.closeTarget' && isRoot) {
          checkTarget(params.targetId); const result = await upstream.send(method, { targetId: params.targetId });
          if (result.success) revoke(params.targetId); return result;
        }
        if (method === 'Target.detachFromTarget') {
          if (browserRoutes.has(params.sessionId)) {
            const name = params.sessionId; browserRoutes.delete(name);
            const children = [...attachments].filter(([, child]) => child.virtualParent === name && child.parent === root);
            for (const [child] of children) { removeRoute(child); if (!await detach(child)) throw Error('CDP_DETACH_UNCONFIRMED'); }
            emit({ method: 'Target.detachedFromTarget', params: { sessionId: name } }); return {};
          }
          const child = routes.get(params.sessionId);
          if (!child || !isRoot && child.parent !== route) throw Error('CDP_SESSION_NOT_OWNED');
          removeRoute(params.sessionId);
          if (!await detach(params.sessionId)) throw Error('CDP_DETACH_UNCONFIRMED');
          return {};
        }
        refuse();
      }
      // Page-domain commands can never run on the browser connection. Unknown
      // domains stay closed, including SystemInfo, Tethering and window APIs.
      // DOMDebugger stays closed (its breakpoints pause the page) except the one read-only listing the rules use to see whether script
      // listens on a link (closed-handle.mjs clickListeners). Without it that answer is "unavailable" and every checkout link asks.
      if (isRoot || !(domains.has(domain) || method === 'DOMDebugger.getEventListeners')) refuse();
      if (protectedPort !== undefined && domain === 'Fetch') {
        if (method === 'Fetch.enable' || method === 'Fetch.disable') {
          const ownedRoute = routes.get(route), previous = ownedRoute.fetchPatterns;
          const patterns = method === 'Fetch.disable' ? [] : params.patterns?.length ? params.patterns : [{ urlPattern: '*' }];
          ownedRoute.fetchPatterns = patterns;
          try { return await upstream.send('Fetch.enable', { ...(method === 'Fetch.enable' ? params : {}), patterns: [...patterns, ...guardPatterns] }, route); }
          catch (error) { if (ownedRoute.fetchPatterns === patterns) ownedRoute.fetchPatterns = previous; throw error; }
        }
        if (['Fetch.continueRequest','Fetch.continueResponse'].includes(method) && params.url && protectedUrl(params.url)) refuse();
      }
      // Playwright normally evaluates with userGesture:true. Reads and guard
      // evaluations must never lend that activation to timers or chooser APIs.
      if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') params = { ...params, userGesture: false };
      return upstream.send(method, params, route);
    },
    on(name, listener) { live(); if (name !== 'event' || typeof listener !== 'function') throw Error('INVALID_CDP_EVENT'); listeners.add(listener); },
    off(name, listener) { if (name !== 'event') throw Error('INVALID_CDP_EVENT'); listeners.delete(listener); },
  });
  async function listen() {
    live();
    // The WS implementation is from the already bundled, pinned Playwright.
    // Loading the filter alone never loads Playwright or opens a listener.
    const { wsServer } = createRequire(import.meta.url)('../../vendor/playwright-core/lib/utilsBundle.js');
    const path = '/sleight/' + randomBytes(32).toString('hex');
    let client, closing;
    const server = new wsServer({ host: '127.0.0.1', port: 0, maxPayload: 1048576,
      verifyClient: ({ req }) => !closed && !client && req.url === path && !req.headers.origin });
    const listening = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const write = frame => { if (client?.readyState === 1) client.send(JSON.stringify(frame)); };
    const forward = frame => write(frame);

    server.on('connection', socket => {
      if (client) { socket.close(); return; }
      client = socket;
      socket.on('error', () => {});
      socket.on('message', async bytes => {
        let frame;
        try {
          frame = JSON.parse(bytes.toString());
          if (!object(frame) || !Number.isSafeInteger(frame.id) || frame.id < 1) throw Error();
        } catch { socket.close(1008); return; }
        const route = frame.sessionId;
        try {
          const result = await session.send(frame.method, frame.params ?? {}, route);
          write({ id: frame.id, result, ...(route === undefined ? {} : { sessionId: route }) });
        } catch (error) {
          write({ id: frame.id, error: { code: -32000, message: /^CDP_/.test(error.message) ? error.message : 'CDP_COMMAND_FAILED' },
            ...(route === undefined ? {} : { sessionId: route }) });
        }
      });
    });
    const bridge = Object.freeze({ get endpoint() { return 'ws://127.0.0.1:' + server.address().port + path; },
      close() {
        if (closing) return closing;
        session.off('event', forward);
        closing = (async () => {
          await listening;
          for (const socket of server.clients) socket.terminate();
          await new Promise(resolve => server.close(resolve));
          bridges.delete(bridge);
        })().catch(error => { closing = undefined; throw error; });
        return closing;
      } });
    bridges.add(bridge);
    try {
      await listening;
      if (closed) { await bridge.close(); live(); }
      session.on('event', forward); return bridge;
    } catch (error) { bridges.delete(bridge); throw error; }
  }
  function dispose() {
    if (disposal) return disposal;
    if (!closed) {
      closed = true; listeners.clear(); navigationWatches.clear();
      routes.clear(); owned.clear(); browserRoutes.clear();
      finishEvents();
    }
    const detaching = [...attachments].filter(([, attachment]) => !attachments.has(attachment.parent))
      .map(([name]) => detach(name));
    const closing = [...bridges].map(bridge => bridge.close().then(() => true, () => false));
    disposal = Promise.all([...detaching, ...closing]).then(results => results.every(Boolean) && !outstanding.size && !attachments.size && !bridges.size)
      .finally(() => { disposal = undefined; });
    return disposal;
  }
  return Object.freeze({ session, owns, own, release: revoke, frames, listen, dispose, endpointBlocked: target => endpointTargets.has(target) });
}
