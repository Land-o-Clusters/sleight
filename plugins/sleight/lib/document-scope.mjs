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
  if (!windows.length || windows.some(w => !w.title || !w.app)) return undefined;
  if (windows.some(w => JSON.stringify(w) !== JSON.stringify(windows[0]))) return undefined;
  return windows[0];
}

export const documentKey = window => window && JSON.stringify(window);
export const documentLabel = window => `${JSON.stringify(window.title)} in ${window.app}${window.url ? ` (${window.url})` : ''}`;

// Only a standalone acquisition or inventory read can cross a closed gate.
// No comments, arbitrary expressions, extra statements or alternate handles.
export function isDocumentRead(code = '') {
  return /^(?:(?:let|var)\s+app\s*=\s*)?await\s+cua\.getApp\(\s*(?:"(?:[^"\\]|\\.)*"|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})\s*\)\s*;?$/.test(code.trim()) ||
    /^await\s+cua\.(?:getState|listApps|listWindows)\(\s*\)\s*;?$/.test(code.trim());
}

export function readCode(code) {
  return 'if (globalThis.__sleightDocumentGuard) cua.getApp = globalThis.__sleightDocumentGuard.getApp;\n' + code;
}

// Advisory only: all of this runs in the same mutable JS realm as Claude's code.
export function guardedCode(code, window, stopMessage = 'Document scope stopped this action: window or URL changed. Read the window and ask the user with document_scope.') {
  return `(() => {
    const parse = ${windowFromText.toString()};
    const state = globalThis.__sleightDocumentGuard ||= {
      getApp: cua.getApp.bind(cua), proxies: new WeakSet(), wrapped: new WeakMap()
    };
    state.expected = ${JSON.stringify(window)};
    const wrap = target => {
      if (state.proxies.has(target)) return target;
      if (state.wrapped.has(target)) return state.wrapped.get(target);
      const proxy = new Proxy(target, { get(raw, name) {
        const value = Reflect.get(raw, name);
        if (typeof value !== 'function') return value;
        if (!['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction',
          'paste', 'pressKey', 'typeText'].includes(name)) return value.bind(raw);
        return async (...args) => {
          const observed = parse(await raw.getAXState({ disableDiffing: true, emit: false }));
          if (JSON.stringify(observed) !== JSON.stringify(state.expected)) {
            throw new Error(${JSON.stringify(stopMessage)});
          }
          return value.apply(raw, args);
        };
      } });
      state.proxies.add(proxy); state.wrapped.set(target, proxy);
      return proxy;
    };
    cua.getApp = async (...args) => wrap(await state.getApp(...args));
    if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function') app = wrap(app);
  })();
${code}
if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function') {
  nodeRepl.write(await app.getAXState({ disableDiffing: true, emit: false }));
}`;
}

export const DOCUMENT_TOOL = {
  name: 'document_scope',
  description: 'Ask the user to approve the last observed document or window for this session. ' +
    'First use js with only let app = await cua.getApp("App") or let app = await cua.getApp({ windowId: 123 }). ' +
    'Actions require an approved matching Window and URL. Window changes stop further actions. ' +
    'This is a mistake guard, not isolation from arbitrary JavaScript.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
