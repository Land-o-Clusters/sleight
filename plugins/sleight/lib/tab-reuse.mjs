const CREATED = /\bcua\.createBrowserTab\s*\(|\.tabs\.new\s*\(/;
const NOTE = /This call opened tab /;
const TAB_LINE = /Browser tab: (\d+)(?:, Title: "[^"]*")?, URL: "([^"]+)"/;

export function readOpened(callId = '') {
  const token = JSON.stringify(String(callId));
  return `nodeRepl.write(JSON.stringify((globalThis.__sleightOpenedThisCall||[]).filter(row => String(row.call??'') === ${token})))`;
}

export const READ_OPENED = readOpened('');

export function createOpenedTabs() {
  const list = [];
  return {
    list,
    record(id, url, browser, call) {
      if (id == null || id === '') return;
      const item = { id: String(id), url: String(url || 'about:blank') };
      if (browser != null && browser !== '') item.browser = String(browser);
      if (call != null && call !== '') item.call = String(call);
      const i = list.findIndex(row => row.id === item.id);
      if (i === -1) list.push(item);
      else list[i] = item;
    },
    forget(id) {
      const key = String(id);
      for (let i = list.length - 1; i >= 0; i--) if (list[i].id === key) list.splice(i, 1);
    },
    clear() { list.length = 0; },
    last() { return list[list.length - 1]; },
  };
}

export function recordOpenedTabs(opened, text) {
  if (!opened || typeof text !== 'string') return opened;
  for (const line of text.split('\n')) {
    const match = TAB_LINE.exec(line);
    if (match) opened.record(match[1], match[2]);
  }
  return opened;
}

export function parseOpenedPayload(text, callId) {
  const opened = createOpenedTabs();
  try {
    const rows = JSON.parse(String(text || '[]').trim() || '[]');
    if (Array.isArray(rows)) for (const row of rows) {
      if (callId !== undefined && String(row?.call ?? '') !== String(callId)) continue;
      opened.record(row?.id, row?.url, row?.browser, row?.call);
    }
  } catch {}
  return opened;
}

export function openedTabNote(text, { code = '', opened } = {}) {
  if (typeof text !== 'string' || NOTE.test(text) || !CREATED.test(code)) return text;
  const last = opened?.last?.() ?? opened?.last;
  if (!last?.id) return text;
  const id = String(last.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|\\n)Browser tab: ${id}\\b`).test(text)) return text;
  const browser = last.browser
    ? `, { browser: ${JSON.stringify(last.browser)} }`
    : '';
  return text.replace(/\s*$/, '') +
    `\nThis call opened tab ${last.id} (${last.url}). Reuse it with cua.getTab(${JSON.stringify(last.id)}${browser}).`;
}

function installOpenedTabs(cua) {
  if (globalThis.__sleightOpenedInstalled) return;
  globalThis.__sleightOpenedInstalled = true;
  const opened = (globalThis.__sleightOpenedThisCall = []);
  const forget = id => {
    const key = String(id);
    for (let i = opened.length - 1; i >= 0; i--) if (opened[i].id === key) opened.splice(i, 1);
  };
  const browserHint = value => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return value?.browserId ?? value?.id;
  };
  const remember = (tab, url, browser) => {
    if (!tab || tab.id == null) return tab;
    const record = {
      id: String(tab.id),
      url: String(url || 'about:blank'),
      call: String(globalThis.__sleightOpenedCall ?? ''),
    };
    const id = tab.browserId ?? browser;
    if (id != null && id !== '') record.browser = String(id);
    opened.push(record);
    const close = tab.close?.bind(tab);
    try {
      if (typeof close === 'function') tab.close = async (...args) => {
        const result = await close(...args);
        forget(record.id);
        return result;
      };
    } catch {}
    const goto = tab.goto?.bind(tab);
    try {
      if (typeof goto === 'function') tab.goto = async (next, ...rest) => {
        const result = await goto(next, ...rest);
        record.url = String(next || record.url);
        return result;
      };
    } catch {}
    return tab;
  };
  const create = cua.createBrowserTab?.bind(cua);
  if (create) cua.createBrowserTab = async (browser, url, ...rest) =>
    remember(await create(browser, url, ...rest), url, browserHint(browser));
  const getBrowser = cua.getBrowser?.bind(cua);
  if (getBrowser) cua.getBrowser = async (...args) => {
    const browser = await getBrowser(...args);
    if (browser?.tabs && !browser.tabs.__sleightOpened) {
      browser.tabs.__sleightOpened = true;
      if (typeof browser.tabs.new === 'function') {
        const make = browser.tabs.new.bind(browser.tabs);
        browser.tabs.new = async (...values) =>
          remember(await make(...values), values[0], browserHint(browser));
      }
      if (typeof browser.tabs.close === 'function') {
        const closeTab = browser.tabs.close.bind(browser.tabs);
        browser.tabs.close = async (id, ...rest) => {
          const result = await closeTab(id, ...rest);
          forget(id);
          return result;
        };
      }
    }
    return browser;
  };
}

export function tabReuseCode(code, callId = '', force = false) {
  if (!force && !CREATED.test(code)) return code;
  return `(${installOpenedTabs.toString()})(cua);\n` +
    `globalThis.__sleightOpenedCall = ${JSON.stringify(String(callId))};\n` +
    'globalThis.__sleightOpenedThisCall && (globalThis.__sleightOpenedThisCall.length = 0);\n' +
    code;
}

export function createdTabCall(code = '') {
  return CREATED.test(code);
}
