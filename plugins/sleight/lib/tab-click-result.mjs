export function isDiffTree(text) {
  const cut = text.search(/\n(?:The focused UI element |\t*\d+ )/m);
  const head = cut < 0 ? text : text.slice(0, cut);
  return /^The following is a diff\b/m.test(head) ||
    /^[+~-][ \t]/m.test(head) ||
    /\bdiff\b|\bno changes?\b|\bunchanged\b|\bchanges? since\b/i.test(head.replace(/^Browser tab: .*\n?/, ''));
}

function installClickResults(cua, agent, snapshots, isDiffTree) {
  if (globalThis.__sleightClickResults) return globalThis.__sleightClickResults.attach(cua, agent, snapshots);
  const views = new WeakMap(), rawFor = new WeakMap(), browsers = new WeakSet(), attached = new WeakSet();
  const hints = new WeakMap(), trees = new Map();
  const submitName = /\b(?:submit|pay|purchase|checkout|book|confirm|send|save|register|continue|next|place order|sign in|log in)\b/i;
  const factories = new Set(['locator', 'frameLocator', 'getByRole', 'getByLabel', 'getByText',
    'getByPlaceholder', 'getByTestId', 'filter', 'first', 'last', 'nth', 'and', 'or']);
  const note = text => { try { nodeRepl.write(text); } catch {} };
  const bounded = (read, timeout = 1500) => {
    let timer;
    try {
      const value = read();
      return Promise.race([Promise.resolve(value).catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, timeout); })]).finally(() => clearTimeout(timer));
    } catch { return Promise.resolve(undefined); }
  };
  const read = tab => Promise.all([bounded(() => tab.url()), bounded(() => tab.playwright.domSnapshot())])
    .then(([url, tree]) => typeof url === 'string' && typeof tree === 'string' && tree.trim() ? { url, tree } : undefined);
  // Before a locator click: the engine scrolls the target to the center, waits for a stable box and inputs
  // at its center with no in-page hit test (resolvePointerActionTarget; its own check covers only iframe
  // borders). Do the same scroll and wait, then hit-test that point. Returns a cover's description or nothing.
  const clickCover = async el => {
    const doc = el.ownerDocument, view = doc.defaultView;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const frame = () => new Promise(resolve => {
      const timer = view?.setTimeout?.(resolve, 50);
      if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(() => { view.clearTimeout?.(timer); resolve(); });
      else if (timer === undefined) resolve();
    });
    let rect = el.getBoundingClientRect();
    for (let i = 0, same = 0; i < 10 && same < 2; i++) {
      await frame();
      const next = el.getBoundingClientRect();
      same = next.left === rect.left && next.top === rect.top && next.width === rect.width && next.height === rect.height ? same + 1 : 0;
      rect = next;
    }
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (!(rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 &&
      x < doc.documentElement.clientWidth && y < doc.documentElement.clientHeight)) return;
    // An open shadow root hit-tests inside its own tree; the document would answer with its host.
    const root = el.getRootNode?.();
    const hit = (root && root !== doc && typeof root.elementFromPoint === 'function' ? root : doc).elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains?.(el)) return;
    for (let node = el; node;) {
      if (node === hit) return;
      node = node.parentElement ?? node.getRootNode?.().host;
    }
    // A click on the target's own label, or on the control of a label target, activates the target.
    if (Array.from(el.labels ?? []).some(label => label.contains(hit)) || el.control === hit ||
      Array.from(hit.labels ?? []).includes(el)) return;
    const describe = node => {
      const name = node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '';
      return ((node.getAttribute('role') || node.tagName.toLowerCase()) + ' ' + name.replace(/\s+/g, ' ').trim().slice(0, 60)).trim();
    };
    const owner = hit.parentElement?.closest('[role],[aria-label]');
    return (describe(hit) + (owner ? ' in ' + describe(owner) : '')).slice(0, 160);
  };
  const submitControl = (el, action) => {
    if (!el?.tagName && el?.active) { action = el.action; el = document.activeElement; }
    else if (!el?.tagName && Array.isArray(el?.point)) { action = el.action; el = document.elementFromPoint(...el.point); }
    if (!el?.getAttribute) return false;
    el = el.closest('button,input,select,textarea,[role]') ?? el;
    const role = el.getAttribute('role') ?? '', popup = el.getAttribute('aria-haspopup');
    if (/^(?:switch|checkbox|radio|menu|menuitem|menuitemcheckbox|menuitemradio|option|combobox)$/.test(role) ||
        (popup && popup !== 'false') || el.getAttribute('aria-pressed') !== null || /^(?:checkbox|radio|reset)$/.test(el.type)) return false;
    if (action === 'click' && /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(?:submit|image)$/.test(el.type)) return false;
    if (/^(?:BUTTON|INPUT)$/.test(el.tagName) && /^(?:submit|image)$/.test(el.type)) return true;
    return !!el.closest('form') && (el.tagName === 'BUTTON' || role === 'button' || (action === 'enter' && el.tagName === 'INPUT'));
  };
  const submitTarget = async (tab, target, kind, action, args) => {
    if (kind === 'locator') return target.evaluate(submitControl, action);
    if (kind === 'playwright' || args[0] === null) return tab.playwright.evaluate(submitControl, { active: true, action });
    if (Array.isArray(args[0])) return tab.playwright.evaluate(submitControl, { point: args[0], action });
    if (!Number.isInteger(args[0])) return false;
    const tree = trees.get(String(tab.id)) ?? '';
    const line = tree.split('\n').find(line => new RegExp('^\\t*' + args[0] + ' ').test(line));
    const id = /\bID: (.*?)(?=, (?:Value|Help|Description):|$)/.exec(line ?? '')?.[1];
    const label = /\bDescription: (.*?)(?=, (?:Value|Help|ID):|$)/.exec(line ?? '')?.[1];
    const button = /^\t*\d+ button (.*?)(?=, (?:ID|Value|Help|Description):|$)/.exec(line ?? '')?.[1];
    const loc = id ? tab.playwright.locator('[id=' + JSON.stringify(id) + ']') : button ? tab.playwright.getByRole('button', { name: label ?? button, exact: true })
      : label ? tab.playwright.getByLabel(label, { exact: true }) : undefined;
    if (!loc || await loc.count() !== 1) return false;
    return loc.evaluate(submitControl, action);
  };
  const unwrap = value => {
    if (!value || typeof value !== 'object') return value;
    if (rawFor.has(value)) return rawFor.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    if (Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
    return value;
  };
  const formSelector = selector => typeof selector === 'string' && !/[,~+:]|xpath=|\.\./.test(selector) &&
    /^\s*form(?:[.#][\w-]+)*(?=\s|>|$)/.test(selector);
  const submitLike = (tab, target, kind, args, action = 'click') => {
    if (action === 'enter') return kind === 'locator' && hints.get(target)?.inForm === true;
    if (kind === 'locator') {
      const hint = hints.get(target) ?? {};
      if (hint.role) return hint.role === 'button' && submitName.test(String(hint.name ?? ''));
      return /\btype\s*=\s*["']?submit\b/i.test(hint.selector ?? '') ||
        /#(?:pay|submit|checkout|confirm|send|save|register)\b/i.test(hint.selector ?? '') ||
        (/\bbutton\b/i.test(hint.selector ?? '') && submitName.test(hint.selector));
    }
    if (kind !== 'tab' || !Number.isInteger(args[0])) return false;
    const line = (trees.get(String(tab.id)) ?? '').split('\n').find(line => new RegExp('^\\t*' + args[0] + ' button ').test(line));
    const label = line?.replace(/^\t*\d+ button /, '').split(', ')[0];
    return !!label && submitName.test(label);
  };
  const wrap = (raw, tab = raw, kind = 'tab', hint) => {
    if (!raw || typeof raw !== 'object') return raw;
    if (rawFor.has(raw)) return raw;
    if (hint) hints.set(raw, hint);
    if (views.has(raw)) return views.get(raw);
    const proxy = new Proxy(raw, { get(target, name) {
      let value = Reflect.get(target, name, target);
      if (kind === 'tab' && name === 'playwright') return wrap(value, tab, 'playwright');
      if (kind === 'playwright' && name === 'press' && value === undefined && typeof tab.pressKey === 'function') {
        value = (key, options) => {
          if (typeof options === 'string') throw new Error('Use locator.press(key), not playwright.press(selector, key).');
          return tab.pressKey(null, key, options);
        };
      }
      if (typeof value !== 'function') return value;
      if (kind === 'tab' && name === 'getAXState') return async (...args) => {
        const tree = await value.apply(target, args.map(unwrap));
        if (typeof tree === 'string' && !isDiffTree(tree)) trees.set(String(tab.id), tree);
        return tree;
      };
      if ((name === 'click' && kind !== 'playwright') || name === 'press' || (kind === 'tab' && name === 'pressKey')) return async (...args) => {
        const action = name === 'click' ? 'click' : 'enter';
        if (action === 'click' && kind === 'locator' && args[0]?.force !== true && args[0]?.trial !== true) {
          const cover = await bounded(() => target.evaluate(clickCover, undefined, { timeoutMs: 1000 }), 1000);
          if (typeof cover === 'string' && cover) throw new Error(`sleight: click target is covered by ${cover}. Dismiss or move the cover before clicking.`);
        }
        if (action === 'enter' ? !/^(?:(?:Control|Meta)\+)?(?:Enter|Return)$/i.test(String(args[kind === 'tab' ? 1 : 0])) || !submitLike(tab, target, kind, args, action)
            : !submitLike(tab, target, kind, args)) return value.apply(target, args.map(unwrap));
        const before = read(tab), submit = bounded(() => submitTarget(tab, target, kind, action, args));
        let result;
        try { result = await value.apply(target, args.map(unwrap)); }
        catch (error) {
          if (await submit) note(`sleight: ${name} failed: ${String(error?.message ?? error).slice(0, 300)}. Read the page before retrying.`);
          throw error;
        }
        const [a, b, candidate] = await Promise.all([before, read(tab), submit]);
        if (candidate && a && b && a.url === b.url && a.tree === b.tree)
          note('sleight: the page showed no change yet; read it before retrying, since a retry may submit twice. Network activity is unknown.');
        return result;
      };
      if (kind !== 'tab' && factories.has(name)) return (...args) => {
        const inherited = hints.get(target) ?? {};
        const hint = name === 'getByRole' ? { ...inherited, role: args[0], name: args[1]?.name }
          : name === 'locator' ? { ...inherited, selector: args[0], inForm: formSelector(args[0]) ||
            (inherited.inForm === true && typeof args[0] === 'string' && !/[,~+:]|xpath=|\.\./.test(args[0])) }
          : ['frameLocator', 'or'].includes(name) ? { ...inherited, inForm: false } : inherited;
        return wrap(value.apply(target, args.map(unwrap)), tab, 'locator', hint);
      };
      if (kind !== 'tab' && name === 'all') return async (...args) => (await value.apply(target, args.map(unwrap))).map(item => wrap(item, tab, 'locator', hints.get(target)));
      return (...args) => value.apply(target, args.map(unwrap));
    } });
    views.set(raw, proxy); rawFor.set(proxy, raw);
    return proxy;
  };
  const browser = value => {
    if (!value || browsers.has(value)) return value;
    browsers.add(value);
    for (const name of ['get', 'new']) if (typeof value.tabs?.[name] === 'function') {
      const method = value.tabs[name].bind(value.tabs);
      value.tabs[name] = async (...args) => wrap(await method(...args));
    }
    return value;
  };
  function attach(cua, agent, snapshots) {
    for (const [id, tree] of Object.entries(snapshots ?? {})) trees.set(id, tree);
    if (cua && !attached.has(cua)) {
      attached.add(cua);
      for (const name of ['getTab', 'createBrowserTab']) if (typeof cua[name] === 'function') {
        const method = cua[name].bind(cua);
        cua[name] = async (...args) => wrap(await method(...args));
      }
      if (typeof cua.getBrowser === 'function') {
        const get = cua.getBrowser.bind(cua);
        cua.getBrowser = async (...args) => browser(await get(...args));
      }
    }
    if (typeof agent?.browsers?.get === 'function' && !attached.has(agent.browsers)) {
      attached.add(agent.browsers);
      const get = agent.browsers.get.bind(agent.browsers);
      agent.browsers.get = async (...args) => browser(await get(...args));
    }
  }
  globalThis.__sleightClickResults = { attach };
  attach(cua, agent, snapshots);
}

export function clickResultCode(code, snapshots = {}, force = false) {
  return force || /\.(?:click|press|pressKey)\s*\(|\bcua\.(?:getTab|createBrowserTab|getBrowser)\s*\(|\bagent\.browsers\.get\s*\(/.test(code)
    ? `(${installClickResults.toString()})(typeof cua === 'undefined' ? undefined : cua, typeof agent === 'undefined' ? undefined : agent, ${JSON.stringify(snapshots)}, (${isDiffTree.toString()}));\n${code}` : code;
}

export class TabClickResults {
  trees = new Map();
  observe(result) {
    const text = (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    for (const part of text.split(/(?=^Browser tab: )/m)) {
      const id = /^Browser tab: ([^,\n]+)/.exec(part)?.[1];
      if (!id) continue;
      if (isDiffTree(part)) continue;
      this.trees.delete(id);
      this.trees.set(id, part.split('\n').filter(line => /^\t*\d+ button /.test(line)).slice(0, 200).join('\n'));
      while (this.trees.size > 20) this.trees.delete(this.trees.keys().next().value);
    }
  }
  code(code, force = false) { return clickResultCode(code, Object.fromEntries(this.trees), force); }
}
