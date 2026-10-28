import { dragTo } from './drag-to.mjs';

function installAliases(cua) {
  if (globalThis.__sleightBrowserAliases) return;
  const state = globalThis.__sleightBrowserAliases = { tabs: new WeakMap(), browsers: new WeakSet(),
    raw: new WeakMap(), owners: new WeakMap(), noted: new Set() };
  const factories = new Set(['locator', 'frameLocator', 'getByRole', 'getByText', 'getByLabel',
    'getByPlaceholder', 'getByTestId', 'filter', 'first', 'last', 'nth', 'and', 'or', 'all']);
  const note = (from, to) => {
    if (state.noted.has(from)) return;
    state.noted.add(from);
    nodeRepl.write(`sleight: API alias ${from} forwards to ${to}.`);
  };
  const unsupported = (name, next) => () => { throw new Error(`sleight: ${name} is unavailable. Use ${next}.`); };
  const unwrap = value => {
    if (value && typeof value === 'object') {
      if (state.raw.has(value)) return state.raw.get(value);
      if (Array.isArray(value)) return value.map(unwrap);
      if (Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, unwrap(v)]));
    }
    return value;
  };
  const wrapTab = tab => {
    if (!tab || typeof tab !== 'object') return tab;
    if (state.tabs.has(tab)) return state.tabs.get(tab);
    const wrapped = new WeakMap();
    const object = (raw, kind) => {
      if (!raw || typeof raw !== 'object') return raw;
      if (wrapped.has(raw)) return wrapped.get(raw);
      const result = value => value?.then ? value.then(result)
        : Array.isArray(value) ? value.map(value => object(value, 'locator')) : object(value, 'locator');
      const proxy = new Proxy(raw, { get(target, name) {
        const value = Reflect.get(target, name, target);
        if (typeof value === 'function') return (...args) => {
          const out = value.apply(target, args.map(unwrap));
          return factories.has(name) ? result(out) : out;
        };
        if (value !== undefined || typeof name !== 'string' || name === 'then') return value;
        if (kind === 'playwright' && name === 'press') return (key, options) => {
          if (typeof options === 'string') throw new Error('sleight: tab.playwright.press takes a key, not a selector and key. Use tab.playwright.locator(selector).press(key).');
          if (typeof tab.pressKey !== 'function') throw new Error('sleight: tab.playwright.press is unavailable. Use a locator.press(key) on the intended element.');
          note('tab.playwright.press', 'tab.pressKey(null, key)');
          return tab.pressKey(null, key, options);
        };
        if (name === 'keyboard' || name === 'mouse') return new Proxy({}, { get(_, action) {
          if (typeof action !== 'string' || action === 'then') return undefined;
          const next = name === 'keyboard' ?
            action === 'press' ? 'tab.pressKey(null, key)' :
              ['type', 'insertText'].includes(action) ? 'tab.typeText(null, text)' : 'tab.getAXState() and a documented tab action' :
            ['move', 'drag'].includes(action) ? 'sleight.dragTo(tab, from, to) for a drag' :
              action === 'click' ? 'tab.click(index) or locator.click()' : 'tab.getAXState() and a documented tab action';
          return unsupported(`${kind === 'tab' ? 'tab' : 'tab.' + kind}.${name}.${action}`, next);
        } });
        if (kind === 'locator' && name === 'dragTo') return target => {
          const owner = state.owners.get(target);
          if (owner && owner !== tab) throw new Error('sleight: locator.dragTo needs both locators in the same tab. Use locators from that tab.');
          const drag = globalThis.sleight?.dragTo;
          if (typeof drag !== 'function') throw new Error('sleight: locator.dragTo needs sleight.dragTo(tab, from, to). Call that helper directly.');
          note('locator.dragTo', 'sleight.dragTo(tab, locator, target)');
          return drag(tab, raw, unwrap(target));
        };
        const hints = kind === 'locator' ? {
          hover: 'locator.click() when you intend to click', focus: 'locator.click() when you intend to focus by clicking',
          boundingBox: 'locator.evaluate(el => el.getBoundingClientRect())',
          drag: 'sleight.dragTo(tab, locator, target)', move: 'sleight.dragTo(tab, locator, target)',
          typeText: 'locator.pressSequentially(text, options)',
          inputValue: 'locator.evaluate(el => el.value)', isChecked: 'locator.evaluate(el => el.checked)',
          innerHTML: 'locator.evaluate(el => el.innerHTML)',
          allInnerTexts: 'locator.evaluateAll(els => els.map(el => el.innerText))',
        } : kind === 'playwright' ? { waitForResponse: 'tab.playwright.waitForLoadState({ state: "load" }) to wait for page load',
          getAXState: 'tab.getAXState()', readState: 'tab.getAXState()' }
          : { getNetworkActivity: 'tab.playwright.waitForLoadState({ state: "load" }) to wait for page load' };
        return Object.hasOwn(hints, name) ? unsupported(`${kind === 'playwright' ? 'tab.playwright' : kind}.${name}`, hints[name]) : undefined;
      } });
      wrapped.set(raw, proxy); state.raw.set(proxy, raw); state.owners.set(proxy, tab);
      return proxy;
    };
    const proxy = new Proxy(tab, { get(raw, name) {
      const value = Reflect.get(raw, name, raw);
      if (name === 'playwright') return object(value, 'playwright');
      if (name === 'dev') return object(value, 'dev');
      if (typeof value === 'function') return value.bind(raw);
      if (value !== undefined || typeof name !== 'string' || name === 'then') return value;
      if (typeof raw.playwright?.[name] === 'function') return (...args) => {
        note(`tab.${name}`, `tab.playwright.${name}`);
        return object(raw.playwright, 'playwright')[name](...args);
      };
      const hints = { readState: 'tab.getAXState()', readDOMState: 'tab.playwright.domSnapshot()',
        getDOMSnapshot: 'tab.playwright.domSnapshot()', readDOM: 'tab.playwright.domSnapshot()',
        waitForLoad: 'tab.playwright.waitForLoadState({ state: "load" })' };
      if (name === 'keyboard' || name === 'mouse') return object({}, 'tab')[name];
      return Object.hasOwn(hints, name) ? unsupported(`tab.${name}`, hints[name]) : undefined;
    } });
    state.tabs.set(tab, proxy); state.raw.set(proxy, tab);
    return proxy;
  };
  for (const name of ['getTab', 'createBrowserTab']) if (typeof cua[name] === 'function') {
    const get = cua[name].bind(cua);
    cua[name] = async (...args) => wrapTab(await get(...args));
  }
  if (typeof cua.getBrowser === 'function') {
    const get = cua.getBrowser.bind(cua);
    cua.getBrowser = async (...args) => {
      const browser = await get(...args);
      if (!state.browsers.has(browser) && browser.tabs) {
        state.browsers.add(browser);
        for (const name of ['new', 'get']) if (typeof browser.tabs[name] === 'function') {
          const make = browser.tabs[name].bind(browser.tabs);
          browser.tabs[name] = async (...values) => wrapTab(await make(...values));
        }
      }
      return browser;
    };
  }
  for (const name of ['getAXState', 'readBrowserTab', 'getTabState']) if (cua[name] === undefined) {
    cua[name] = unsupported(`cua.${name}`, 'tab.getAXState() for a tab, or app.getAXState() for an app');
  }
}

export function browserAliasesCode(code, force = false) {
  const drag = force || /\.\s*dragTo\b/.test(code) && !/\bsleight\s*\.\s*dragTo\s*\(/.test(code)
    ? `globalThis.sleight ??= {}; globalThis.sleight.dragTo ??= (${dragTo.toString()});\n` : '';
  return `${drag}try { (${installAliases.toString()})(cua); } catch {}\n${code}`;
}

export function createBrowserAliasNotices() {
  const seen = new Set();
  return content => content.flatMap(item => {
    if (item.type !== 'text' || typeof item.text !== 'string') return [item];
    const text = item.text.split('\n').filter(line => {
      const alias = /^sleight: API alias (.+) forwards to .+\.$/.exec(line)?.[1];
      if (!alias) return true;
      if (seen.has(alias)) return false;
      seen.add(alias); return true;
    }).join('\n');
    return text === item.text ? [item] : text ? [{ ...item, text }] : [];
  });
}
