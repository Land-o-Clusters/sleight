import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
export const rules = await import('../plugins/sleight/lib/direct-browser/rules.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
export const terms = { item: 'Fixture item', method: 'Fixture card', amount: '18.00', payee: 'Fixture shop', currency: 'USD' };
export const input = extra => ({ tag: 'input', kind: 'text', connected: true, visible: true, enabled: true, hit: true,
  payment: false, submit: false, form: false, formPayment: false, ...extra });
export function fixture(payment) {
  assert.equal(typeof rules.check, 'function', 'v3 rule check is required');
  const f = { state: { snapshotNo: 0, submitUnconfirmed: false }, ctx: { userMessage: payment ?
    { id: 'request', session: 'session', turn: 'turn', source: 'user', text: 'Pay for Fixture item with Fixture card', payment } : undefined } };
  f.target = (extra = {}) => ({ state: f.state, session: 'session', turn: 'turn', document: 'document', origin: 'https://fixture.invalid',
    ref: 'e1', element: input(), terms: { page: { ...terms }, method: terms.method }, ...extra });
  f.pay = extra => f.target({ element: input({ tag: 'button', kind: 'button', payment: true, submit: true }), ...extra });
  f.submit = extra => f.target({ element: input({ tag: 'button', kind: 'button', submit: true }), ...extra });
  return f;
}

// A small DOM fake for the pure, closure-free locator inspector. No engine APIs.
export function classify(build, inspector = rules.inspectElement) {
  assert.equal(typeof rules.inspectElement, 'function');
  const ctx = { URL };
  runInNewContext(`
    class Element {
      constructor(tag, attrs = {}, text = '', parent = null) { this.localName = tag; this.attrs = attrs; this.text = text; this.parent = parent; this.children = []; parent?.children.push(this); this.isConnected = true; this.ownerDocument = { baseURI: 'https://fixture.invalid/' }; }
      getAttributeNames() { return Object.keys(this.attrs); }
      getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10 }; }
      matches() { return false; }
      closest(sel) { for (let n = this; n; n = n.parent) if (n.localName === sel) return n; return null; }
      get textContent() { return this.text; }
      querySelectorAll() { return this.children.flatMap(n => [n, ...n.querySelectorAll()]); }
    }
    class HTMLInputElement extends Element { get type() { return this.attrs.type ?? 'text'; } get value() { return this.attrs.value ?? ''; } }
    class HTMLButtonElement extends Element { get type() { return this.attrs.type ?? 'submit'; } get form() { return this.closest('form'); } }
    var location = { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/' };
    var getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    var document = { elementFromPoint: () => globalThis.target };
    globalThis.mk = { Element, HTMLInputElement, HTMLButtonElement };
  `, ctx);
  ctx.target = build(ctx.mk); ctx.URL = URL;
  return runInNewContext(`(${inspector.toString()})(target)`, ctx);
}
