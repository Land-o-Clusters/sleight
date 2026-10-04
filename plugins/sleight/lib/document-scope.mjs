// Header identity is a cooperative runtime observation, not an OS capability.
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

export const documentKey = window => window && JSON.stringify(window);
export const documentLabel = window => `${JSON.stringify(window.title)} in ${window.app}${window.url ? ` (${window.url})` : ''}`;

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
export function guardedCode(code, window, reason = 'Document scope stopped this action: window or URL changed. Read the window and ask the user with document_scope.', lease) {
  return guardSetup({ window, reason, lease }) + `\n${code}
if (globalThis.__sleightDocumentGuard.activeApp) {
  nodeRepl.write(await globalThis.__sleightDocumentGuard.activeApp.getAXState({ disableDiffing: true, emit: false }));
}`;
}

function guardSetup(update) {
  return `(() => {
    const parse = ${windowFromText.toString()};
    const state = globalThis.__sleightDocumentGuard ||= {
      getApp: cua.getApp.bind(cua), proxies: new WeakSet(), wrapped: new WeakMap()
    };
    ${update ? `state.expected = ${JSON.stringify(update.window)}; state.reason = ${JSON.stringify(update.reason)};
    state.lease = ${JSON.stringify(update.lease) ?? 'undefined'};` : ''}
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
        if (['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(name)) return async (...args) => {
          const result = await value.apply(raw, args);
          state.activeApp = proxy;
          return result;
        };
        if (!['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction',
          'paste', 'pressKey', 'typeText'].includes(name)) return value.bind(raw);
        return async (...args) => {
          await checkLease();
          const observed = parse(await raw.getAXState({ disableDiffing: true, emit: false }));
          if (!observed || ['title', 'app', 'url'].some(key => observed[key] !== state.expected[key])) {
            throw new Error(state.reason + ' Observed ' + JSON.stringify(observed));
          }
          await checkLease();
          state.activeApp = proxy;
          return value.apply(raw, args);
        };
      } });
      state.proxies.add(proxy); state.wrapped.set(target, proxy);
      return proxy;
    };
    cua.getApp = async (...args) => state.activeApp = wrap(await state.getApp(...args));
    ${update ? "if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function' && !state.proxies.has(app)) { app = wrap(app); state.activeApp ||= app; }" : ''}
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
