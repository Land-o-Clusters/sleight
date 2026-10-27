// Offline DOM boundary for consent classification. No browser or host APIs.
import { runInNewContext } from 'node:vm';
import { inspectConsent } from '../../plugins/sleight/lib/direct-browser/consent-wall.mjs';

export function consentDOM(inspect = inspectConsent) {
  const scans = new Map(), reads = new Map();
  const view = { getComputedStyle: (node, pseudo) => pseudo
    ? { content: node.pseudo[pseudo] ?? 'none' }
    : { display: 'block', visibility: 'visible', position: 'static', ...node.css } };
  const document = { defaultView: view, getElementById: id => all.find(n => n.attrs.id === id) };
  const all = [];
  function node(tag = 'button', text = '', attrs = {}, children = []) {
    const el = { localName: tag, tagName: tag.toUpperCase(), nodeType: 1,
      namespaceURI: 'http://www.w3.org/1999/xhtml', attrs, childNodes: [],
      innerText: text, textContent: text, value: '', type: attrs.type ?? 'text',
      isConnected: true, disabled: false, readOnly: false, checked: false,
      labels: [], css: {}, pseudo: {}, ownerDocument: document, querySelector: () => null,
      getAttribute(key) { return this.attrs[key] ?? null; },
      getRootNode() { return document; }, closest: () => null,
      getBoundingClientRect: () => ({ width: 20, height: 10 }),
      querySelectorAll(selector) {
        if (selector !== '*') throw Error('unmodeled selector: ' + selector);
        scans.set(this, (scans.get(this) ?? 0) + 1);
        const descend = n => n.childNodes.filter(c => c.nodeType === 1).flatMap(c => [c, ...descend(c)]);
        return descend(this);
      },
    };
    if (text) el.childNodes.push({ nodeType: 3, textContent: text, parentElement: el });
    for (const child of children) { el.childNodes.push(child); child.parentElement = el; }
    el.children = el.childNodes.filter(c => c.nodeType === 1);
    all.push(el); return el;
  }
  const read = (el, key) => {
    reads.set(key, (reads.get(key) ?? 0) + 1);
    const value = el?.[key]; return typeof value === 'function' ? value.bind(el) : value;
  };
  function locator(el, metadata = {}, actions = []) {
    const loc = {
      count: async () => 1,
      click: async () => { actions.push(['click', el.localName]); },
      fill: async value => { actions.push(['fill', value]); el.value = value; },
      setChecked: async value => { actions.push(['check', value]); el.checked = value; },
      ownerFrame: async () => ({ parentFrame: () => null }),
      dispose: async () => {},
    };
    const serverNode = { _frame: { utilityContext: async () => ({ world: 'utility',
      async evaluateExpression(source, options, args) {
        if (!options.isFunction) throw Error('function required');
        const name = /function (\w+)/.exec(source)?.[1];
        if (name === 'inspectConsent') return inspect(el, args[1], read);
        if (name === 'inspectTarget') return { tag: el.localName, name: el.innerText, ...metadata };
        if (name === 'overlaySignature') return { count: 0, hash: 1 };
        if (name === 'placeClear') return 'clear';
        // Fill's unchanged classifier also receives this explicit DOM boundary.
        const match = /^\(\[el, arg\]\) => \(([\s\S]*?)\)\(el, arg, \(function nativeReader\(/.exec(source);
        if (name === 'inspect' && match) return runInNewContext('(' + match[1] + ')')(el, args[1], read);
        throw Error('unmodeled reader: ' + name);
      },
    }) } };
    loc._connection = { toImpl: handle => { if (handle !== loc) throw Error('wrong handle'); return serverNode; } };
    return loc;
  }
  return { node, read, locator, scans, reads, inspect: (el, options) => inspect(el, options, read) };
}
