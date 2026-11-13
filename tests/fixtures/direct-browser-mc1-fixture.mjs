import vm from 'node:vm';
import { hookSource, newHook } from '../../plugins/sleight/lib/direct-browser/page.mjs';

// Offline DOM/event boundary. Run the production signed hook, including its native readers and capture listeners.
export function mc1Fixture() {
  const hook = newHook(), context = vm.createContext({ setTimeout, clearTimeout, URL });
  vm.runInContext(`
    class Event {
      constructor(type) { this.kind = type; }
      get type() { return this.kind; }
      get defaultPrevented() { return !!this.prevented; }
      preventDefault() { this.prevented = true; }
      stopPropagation() { this.stopped = true; }
      stopImmediatePropagation() { this.stopped = true; }
      composedPath() { return this.path ?? []; }
    }
    class MouseEvent extends Event {
      get ctrlKey() { return false; }
      get metaKey() { return false; }
      getModifierState() { return false; }
    }
    class KeyboardEvent extends Event {
      get key() { return ''; }
      get ctrlKey() { return false; }
      get metaKey() { return false; }
      getModifierState() { return false; }
    }
    class EventTarget {
      constructor() { this.listeners = new Map(); }
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
      removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
      dispatchEvent(event) { for (const fn of this.listeners.get(event.type) ?? []) { fn(event); if (event.stopped) break; } return !event.prevented; }
    }
    class Node extends EventTarget {
      constructor() { super(); this.parent = null; this.nodes = []; this.live = true; this.text = ''; }
      get nodeType() { return this instanceof Document ? 9 : 1; }
      get isConnected() { return this.live; }
      get parentNode() { return this.parent; }
      get parentElement() { return this.parent instanceof Element ? this.parent : null; }
      get ownerDocument() { return document; }
      get textContent() { return this.text + this.nodes.map(n => n.textContent).join(''); }
      get baseURI() { return 'https://fixture.invalid/'; }
      getRootNode() { return document; }
    }
    class NodeList { constructor(nodes) { nodes.forEach((n, i) => { this[i] = n; }); this.size = nodes.length; } get length() { return this.size; } }
    class Element extends Node {
      constructor(tag, attrs = {}, parent = null) { super(); this.tag = tag; this.attrs = attrs; this.parent = parent; parent?.nodes.push(this);
        this.box = { x: 20, y: 20, width: 20, height: 20, top: 20, left: 20, right: 40, bottom: 40 }; }
      get localName() { return this.tag; }
      get namespaceURI() { return 'http://www.w3.org/1999/xhtml'; }
      getAttribute(name) { return this.attrs[name] ?? null; }
      hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
      getAttributeNS(ns, name) { return this.getAttribute(name); }
      hasAttributeNS(ns, name) { return this.hasAttribute(name); }
      closest(selector) { for (let n = this; n instanceof Element; n = n.parent) if (n.matches(selector)) return n; return null; }
      matches(selector) { return selector.split(',').some(s => {
        if (s === 'input' || s === 'label' || s === 'button' || s === 'form' || s === 'select' || s === 'textarea') return this.tag === s;
        if (s === 'a[*|href]' || s === 'a[href]') return this.tag === 'a' && this.hasAttribute('href');
        return false;
      }); }
      querySelectorAll(selector) { return new NodeList(this.nodes.flatMap(n => [n, ...n.descendants()]).filter(n => n.matches(selector))); }
      descendants() { return this.nodes.flatMap(n => [n, ...n.descendants()]); }
      scrollIntoView() {}
      getBoundingClientRect() { return { ...this.box }; }
      get isContentEditable() { return false; }
      blur() { document.activeElement = null; }
    }
    class HTMLInputElement extends Element {
      constructor(attrs, parent) { super('input', attrs, parent); }
      get type() { return this.attrs.type ?? 'text'; }
      get form() { return this.closest('form'); }
    }
    class HTMLButtonElement extends Element {
      constructor(attrs, parent) { super('button', attrs, parent); }
      get type() { return this.attrs.type ?? 'submit'; }
      get form() { return this.closest('form'); }
    }
    class HTMLSelectElement extends Element { get type() { return 'select-one'; } get form() { return null; } get multiple() { return false; } }
    class HTMLLabelElement extends Element { constructor(parent) { super('label', {}, parent); } get control() { return this.target; } }
    class Document extends Node {
      get URL() { return 'https://fixture.invalid/'; }
      get defaultView() { return window; }
      get body() { return this.nodes[0]; }
      get documentElement() { return this.nodes[0]; }
      querySelectorAll(selector) { return Element.prototype.querySelectorAll.call(this, selector); }
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
      elementFromPoint() { return this.hit; }
      open() {}
      write() {}
    }
    class MutationObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.live = true; }
      disconnect() { this.live = false; }
    }
    const observers = [];
    const window = new EventTarget(), document = new Document();
    document.scripts = []; document.designMode = 'off';
    window.parent = window; window.top = window; window.open = () => null;
    window.getComputedStyle = el => ({ visibility: el.hidden ? 'hidden' : 'visible', display: 'block', position: 'static' });
    window.requestAnimationFrame = fn => setTimeout(fn, 1);
    Object.assign(globalThis, { window, document, Node, NodeList, Element, HTMLElement: Element, Document,
      HTMLInputElement, HTMLButtonElement, HTMLLabelElement, HTMLSelectElement,
      Event, MouseEvent, KeyboardEvent, EventTarget, MutationObserver, innerHeight: 600, innerWidth: 800,
      navigator: { userActivation: { isActive: true } } });
    const root = new Element('main', {}, document), label = new HTMLLabelElement(root), radio = new HTMLInputElement({ type: 'radio', name: 'shipping', value: 'overnight' }, label);
    label.text = 'Overnight Next business day $29'; label.target = radio;
    const other = new Element('div', {}, root);
    document.hit = radio;
    globalThis.fixture = { root, label, radio, other, mutate() { for (const o of observers) if (o.live) o.callback([]); },
      send(type, target) {
        const event = new MouseEvent(type); event.isTrusted = true; event.path = [];
        for (let at = target; at; at = at.parent) event.path.push(at);
        window.dispatchEvent(event); return event;
      } };
  `, context);
  vm.runInContext(hookSource(hook), context);
  const f = context.fixture;
  const evaluate = async (fn, arg) => {
    context.argument = arg;
    return vm.runInContext(`(${fn})(argument)`, context);
  };
  const page = { evaluate, keyboard: { up: async () => {} }, isClosed: () => false };
  const locator = {
    ownerFrame: async () => page,
    evaluate: async (fn, arg) => { context.argument = arg; return vm.runInContext(`(${fn})(fixture.radio, argument)`, context); },
  };
  return { ...f, context, page, locator, entry: { page, hook },
    mutate: f.mutate, send: f.send,
    run(source) { return vm.runInContext(source, context); } };
}
