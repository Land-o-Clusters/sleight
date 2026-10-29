export const cleanupTabsCode = 'nodeRepl.write(await globalThis.__sleightTabs?.cleanup());';
export const cleanupTabsBefore = deadline => `nodeRepl.write(await globalThis.__sleightTabs?.cleanup(${deadline}));`;
export const cleanupTimeoutNote = 'sleight: kept tabs because cleanup did not answer before the deadline.';

function installTabCleanup(cua) {
  if (globalThis.__sleightTabs) return;
  const owned = new Set(), wrapped = new WeakMap(), browsers = new WeakSet();
  const create = cua.createBrowserTab?.bind(cua), get = cua.getTab?.bind(cua), getBrowser = cua.getBrowser?.bind(cua);
  const origin = url => {
    try { const parsed = new URL(url); return parsed.origin === 'null' ? parsed.href : parsed.origin; }
    catch { return undefined; }
  };
  const wrap = (tab, record) => {
    if (!record) return tab;
    if (wrapped.has(tab)) return wrapped.get(tab);
    const proxy = new Proxy(tab, { get(raw, name) {
      const value = Reflect.get(raw, name, raw);
      if (typeof value !== 'function') return value;
      if (name === 'markDeliverable' || name === 'markHandoff') return async (...args) => {
        record.keep = true;
        return value.apply(raw, args);
      };
      if (name === 'close') return async (...args) => {
        const result = await value.apply(raw, args);
        owned.delete(record);
        return result;
      };
      if (name === 'goto') return async (...args) => {
        const result = await value.apply(raw, args);
        record.origin = origin(args[0]);
        return result;
      };
      return value.bind(raw);
    } });
    wrapped.set(tab, proxy);
    return proxy;
  };
  const remember = (browser, tab, url = 'about:blank') => {
    let record = [...owned].find(r => r.browser === browser && r.tab.id === tab.id);
    if (!record) { record = { browser, tab, origin: origin(url), keep: false }; owned.add(record); }
    return wrap(tab, record);
  };
  if (create) cua.createBrowserTab = async (browser, ...args) => remember(browser, await create(browser, ...args), args[0]);
  if (getBrowser) cua.getBrowser = async (...args) => {
    const browser = await getBrowser(...args);
    if (!browsers.has(browser) && browser.tabs) {
      browsers.add(browser);
      if (typeof browser.tabs.new === 'function') {
        const make = browser.tabs.new.bind(browser.tabs);
        browser.tabs.new = async (...values) => remember(browser.browserId, await make(...values));
      }
      if (typeof browser.tabs.get === 'function') {
        const getTab = browser.tabs.get.bind(browser.tabs);
        browser.tabs.get = async (...values) => {
          const tab = await getTab(...values);
          const matches = [...owned].filter(r => r.browser === browser.browserId && r.tab.id === tab.id);
          return wrap(tab, matches.length === 1 ? matches[0] : undefined);
        };
      }
    }
    return browser;
  };
  if (get) cua.getTab = async (...args) => {
    const tab = await get(...args);
    const matches = [...owned].filter(r => r.tab.id === tab.id && (!args[1]?.browser || r.browser === args[1].browser));
    return wrap(tab, matches.length === 1 ? matches[0] : undefined);
  };
  globalThis.__sleightTabs = { async cleanup(deadline = Date.now() + 2000) {
    if (globalThis.__sleightOpenedThisCall) globalThis.__sleightOpenedThisCall.length = 0;
    const notes = [];
    const bounded = async work => {
      let timer;
      try {
        return await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('cleanup deadline')), Math.max(0, deadline - Date.now()));
        })]);
      } finally { clearTimeout(timer); }
    };
    for (const record of [...owned]) {
      if (Date.now() >= deadline) break;
      // Explicit handoffs and deliverables leave cleanup ownership permanently.
      if (record.keep) { owned.delete(record); continue; }
      let unread = 'its form state could not be read';
      try {
        const browser = await bounded(cua.getBrowser({ id: record.browser }));
        const state = await bounded(record.tab.playwright.evaluate(() => ({
          loading: document.readyState !== 'complete',
          edited: [...document.querySelectorAll('input, textarea, select')].some(el => {
            if (el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'color')) return false;
            if (el.tagName !== 'SELECT') return el.value !== el.defaultValue ||
              (el.tagName === 'INPUT' && el.checked !== (el.defaultChecked ?? el.hasAttribute('checked')));
            const options = [...el.options];
            if (el.multiple) return options.some(option => option.selected !== option.defaultSelected);
            const marked = options.reduce((index, option, i) => option.defaultSelected ? i : index, -1);
            const first = el.size > 1 ? -1 : options.findIndex(option => !option.disabled &&
              !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled));
            return el.selectedIndex !== (marked < 0 ? first : marked);
          }),
        })));
        if (Date.now() >= deadline) break;
        if (!state || state.loading || state.edited) {
          notes.push(`sleight: kept tab ${record.tab.id} because ${state?.loading ? 'it is still loading' : 'it has form input'}.`);
          continue;
        }
        if (typeof record.tab.close !== 'function') continue;
        unread = 'its tab identity could not be confirmed';
        const listed = await bounded(browser.tabs.list());
        const matches = listed.filter(tab => tab.id === record.tab.id);
        if (Date.now() >= deadline) break;
        if (!record.origin || matches.length !== 1 || origin(matches[0].url) !== record.origin) {
          notes.push(`sleight: kept tab ${record.tab.id} because its tab identity changed or is missing.`);
          owned.delete(record);
          continue;
        }
        unread = undefined;
        await bounded(record.tab.close());
        owned.delete(record);
      } catch {
        if (unread) notes.push(`sleight: kept tab ${record.tab.id} because ${unread}.`);
      }
    }
    return notes.join('\n');
  } };
}

export function tabCleanupCode(code, force = false) {
  return force || /\bcua\.(?:createBrowserTab|getBrowser)\s*\(|\.tabs\.new\s*\(/.test(code)
    ? `(${installTabCleanup.toString()})(cua);\n${code}` : code;
}
