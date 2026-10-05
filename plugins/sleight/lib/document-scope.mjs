// Header identity is a cooperative runtime observation, not an OS capability.
// Mark full trees the guard writes, which the relay compacts (compact-reads.mjs).
export const GUARD_MARK = '[sleight:guard-read]\n';
export const GUARD_END = '\n[/sleight:guard-read]\n';

export function windowFromText(text) {
  const headers = [...text.matchAll(/^Window: ("(?:[^"\\]|\\.)*"), App: (.+)\r?$/gm)];
  const windows = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const section = text.slice(header.index + header[0].length, headers[i + 1]?.index);
    const urls = [...section.matchAll(/^(?:URL: (.+)|0 [^\r\n]*?\bURL: (.*?)(?:, (?:Secondary Actions|ID|Help):.*)?)\r?$/gm)];
    if (urls.length > 1) return undefined;
    try {
      windows.push({ title: JSON.parse(header[1]), app: header[2].trim().replace(/\.$/, ''), url: (urls[0]?.[1] ?? urls[0]?.[2])?.trim() || null });
    } catch { return undefined; }
  }
  if (!windows.length || windows.some(w => !w.app)) return undefined;
  if (windows.some(w => JSON.stringify(w) !== JSON.stringify(windows[0]))) return undefined;
  return windows[0];
}

// Element number -> line text without the number, for one tree.
export function elementLines(text) {
  return new Map(text.split('\n').map(line => /^(\t*)(\d+) (.*)$/.exec(line)).filter(Boolean).map(m => [Number(m[2]), m[3]]));
}

export const documentKey = window => window && JSON.stringify(window);
export const documentLabel = window => `${JSON.stringify(window.title)} in ${window.app}${window.url ? ` (${window.url})` : ''}`;

export function isCancelAction(name, args, text = '') {
  if (name === 'pressKey') return /^(?:Escape|esc)$/i.test(args[0]);
  if (name !== 'click' || !Number.isInteger(Number(args[0]))) return false;
  return text.split('\n').some(line => {
    const button = /^\s*(\d+) button(?: \(.*?\))? Cancel(?:,|$)/.exec(line);
    return button && Number(button[1]) === Number(args[0]);
  });
}

// Only a standalone acquisition or inventory read can cross a closed gate.
// No comments, arbitrary acquisition arguments or extra statements.
export function isDocumentRead(code = '') {
  return /^(?:(?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})\s*\)\s*;?$/.test(code.trim()) ||
    /^await\s+cua\.(?:getState|listApps|listWindows)\(\s*\)\s*;?$/.test(code.trim());
}

export function readCode(code) {
  // Every acquired handle, including const bindings, must receive the proxy
  // before it escapes. A bare acquisition also restores the conventional handle.
  const read = /^await\s+cua\.getApp\(/.test(code.trim()) ? 'globalThis.app = ' + code.trim() : code;
  return guardSetup() + '\n' + read;
}

// Advisory only: all of this runs in the same mutable JS realm as Claude's code.
export function guardedCode(code, window, reason = 'Document scope stopped this action: window or URL changed. Read the window and ask the user with document_scope.', lease, options = {}) {
  // The lease needs a full header after the call. A read Claude made after its
  // last action already wrote one, so the guard reads again only without it.
  return guardSetup({ window, reason, lease, ...options }) +
    (options.browserCandidate ? '\nglobalThis.__sleightDocumentGuard.activeApp = undefined;' : '') + `\n${code}
{
  const guard = globalThis.__sleightDocumentGuard, last = guard.activeApp && guard.reads.get(guard.activeApp);
  if (guard.activeApp && !last?.emitted) {
    const text = last?.text ?? await guard.activeApp.getAXState({ disableDiffing: true, emit: false });
    nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
  }
}`;
}

function guardSetup(update) {
  return `(() => {
    const parse = ${windowFromText.toString()};
    const isCancel = ${isCancelAction.toString()};
    const state = globalThis.__sleightDocumentGuard ||= {
      getApp: cua.getApp.bind(cua), proxies: new WeakSet(), wrapped: new WeakMap()
    };
    ${update ? `state.expected = ${JSON.stringify(update.window)}; state.reason = ${JSON.stringify(update.reason)};
    state.lease = ${JSON.stringify(update.lease) ?? 'undefined'};
    state.fileOnly = ${!!update.fileOnly}; state.cancelOnly = ${!!update.cancelOnly};
    state.adoptUrl = ${!!update.adoptUrl};` : ''}
    state.nativeDenied = ${JSON.stringify(update?.nativeDenied) ?? 'undefined'};
    // Full reads taken in this call since the handle's last action. A new call
    // always reads again, because the user may have changed the window between.
    state.reads = new WeakMap();
    // Element lines at this call's first action, which Claude's numbers refer to.
    state.callElements = new WeakMap();
    const elements = ${elementLines.toString()};
    const checkNative = () => { if (state.nativeDenied) throw new Error(state.nativeDenied); };
    const checkLease = async () => {
      if (!state.lease) return;
      const fs = await import('node:fs/promises');
      let record;
      try { record = JSON.parse(await fs.readFile(state.lease.path, 'utf8')); }
      catch { throw new Error('Input lease stopped this action: the lease file is unavailable. End the turn and read the window again.'); }
      if (record.token !== state.lease.token || record.expires <= Date.now()) {
        throw new Error('Input lease stopped this action: ownership lost or expired. End the turn and read the window again.');
      }
    };
    const wrap = target => {
      if (state.proxies.has(target)) return target;
      if (state.wrapped.has(target)) return state.wrapped.get(target);
      const proxy = new Proxy(target, { get(raw, name) {
        const value = Reflect.get(raw, name);
        if (typeof value !== 'function') return value;
        // Claude's tree reads are full reads the relay turns into changed lines,
        // and they double as the guard's own read until the next action.
        if (name === 'getAXState') return async (options = {}) => {
          checkNative();
          const text = await raw.getAXState({ ...options, disableDiffing: true, emit: false });
          const emitted = options?.emit !== false;
          if (emitted) nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
          state.reads.set(proxy, { text, emitted });
          state.activeApp = proxy;
          return text;
        };
        if (['getAXStateAndScreenshot', 'getScreenshot'].includes(name)) return async (...args) => {
          checkNative();
          const result = await value.apply(raw, args);
          if (name === 'getAXStateAndScreenshot') state.reads.delete(proxy);
          state.activeApp = proxy;
          return result;
        };
        if (!['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction',
          'paste', 'pressKey', 'typeText'].includes(name)) return (...args) => { checkNative(); return value.apply(raw, args); };
        return async (...args) => {
          checkNative();
          await checkLease();
          if (state.fileOnly && name === 'pressKey' && isCancel(name, args)) {
            state.activeApp = proxy;
            state.reads.delete(proxy);
            return value.apply(raw, args);
          }
          const text = state.reads.get(proxy)?.text ?? await raw.getAXState({ disableDiffing: true, emit: false });
          const observed = parse(text);
          // An earlier action in this call can renumber the window (Calculator closes
          // its history and every button shifts), so a batch of numbers goes stale.
          if (!state.callElements.has(proxy)) state.callElements.set(proxy, elements(text));
          else if (typeof args[0] === 'number') {
            const was = state.callElements.get(proxy).get(args[0]), now = elements(text).get(args[0]);
            if (was !== now) throw new Error('sleight stopped before ' + name + '(' + args[0] + '): an earlier action in this call changed what element ' + args[0] + ' is (was ' + JSON.stringify(was ?? 'missing') + ', now ' + JSON.stringify(now ?? 'missing') + '). Read the window again and use its current numbers.');
          }
          const cancel = state.fileOnly && isCancel(name, args, text);
          if (state.cancelOnly && !cancel) throw new Error('Change review: Cancel target changed. Read the current window before retrying.');
          const dialog = state.fileOnly && observed?.app === state.expected?.app && !observed.url?.startsWith('file://');
          // An untitled document that autosave gives a URL mid-call is the same
          // window. Document scope and change review stay strict about URLs.
          if (state.adoptUrl && observed && state.expected && state.expected.url == null && observed.url &&
            observed.app === state.expected.app && observed.title === state.expected.title) state.expected = observed;
          if (!cancel && !dialog && (!observed || ['title', 'app', 'url'].some(key => observed[key] !== state.expected[key]))) {
            throw new Error(state.reason + ' Observed ' + JSON.stringify(observed));
          }
          await checkLease();
          state.activeApp = proxy;
          state.reads.delete(proxy);
          return value.apply(raw, args);
        };
      } });
      state.proxies.add(proxy); state.wrapped.set(target, proxy);
      return proxy;
    };
    cua.getApp = async (...args) => { checkNative(); return state.activeApp = wrap(await state.getApp(...args)); };
    ${update && !update.skipAppWrap ? "if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function' && !state.proxies.has(app)) { app = wrap(app); state.activeApp ||= app; }" : ''}
  })();`;
}

export const DOCUMENT_TOOL = {
  name: 'document_scope',
  description: 'Ask the user to approve the last observed document or window for this session. ' +
    'First use js with only let app = await cua.getApp("App") or let app = await cua.getApp({ windowId: 123 }). ' +
    'Actions require an approved matching Window and URL. Window changes stop further actions. ' +
    'This is a mistake guard, not isolation from arbitrary JavaScript.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
