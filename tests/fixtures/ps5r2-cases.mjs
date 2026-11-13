import cells1 from './ps5r2-review/cells1.mjs';
import cells2 from './ps5r2-review/cells2.mjs';
import cells3 from './ps5r2-review/cells3.mjs';
import cells4 from './ps5r2-review/cells4.mjs';
import cells5 from './ps5r2-review/cells5.mjs';
import cells6 from './ps5r2-review/cells6.mjs';
import cells7 from './ps5r2-review/cells7.mjs';
// Review cells are parsed as data and never dispatched to a browser.
const reject = (id, code) => ({ id: `r2-${id}`, code, write: true,
  reason: 'PS5R2 checks every receiver and refuses unproved arguments and indirect evaluation references.' });
const click = '() => { document.body.click(); }';
export const round2Cases = [
  reject('helper-mutation', `const h = {}; function mut(o){ Object.setPrototypeOf(o, tab); } mut(h); await h.evaluate(${click});`),
  ...[
    'const h = {}; const alias = h; Object.setPrototypeOf(alias, tab);',
    'const h = {mut(){ Object.setPrototypeOf(this, tab); }}; h.mut();',
    'const h = {}; [h].forEach(o => Object.setPrototypeOf(o, tab));',
    'const h = {}; (0, Object.setPrototypeOf)(h, tab);',
    'const h = {}; const {setPrototypeOf} = Object; setPrototypeOf(h, tab);',
    'const h = {}; Object.prototype.evaluate = tab.evaluate;',
  ].map((prefix, i) => reject(`prototype-${i}`, `${prefix} await h.evaluate(${click});`)),
  reject('array-argument', 'await tab.evaluate(["document.body.click()"]);'),
  reject('object-argument', 'await tab.evaluate({toString(){ return "document.body.click()"; }});'),
  reject('tagged-call', 'await tab.evaluate`document.body.click()`;'),
  reject('tagged-argument', 'await tab.evaluate(tag`document.body.click()`);'),
  reject('member-argument', 'await tab.evaluate(callbacks.read);'),
  reject('call-argument', 'await tab.evaluate(makeCallback());'),
  reject('unknown-argument', 'await tab.evaluate(unknown);'),
  reject('null-argument', 'await tab.evaluate(null);'),
  reject('number-argument', 'await tab.evaluate(42);'),
  reject('string-alias', 'const cb = "() => document.title"; await tab.evaluate(cb);'),
  reject('method-alias', `const ev = tab.evaluate; ev.call(tab, ${click});`),
  reject('destructure', `const {evaluate} = tab; await evaluate(${click});`),
  reject('destructure-alias', `const {evaluate: ev} = tab; await ev(${click});`),
  reject('destructure-string-key', `const {"evaluate": ev} = tab; await ev(${click});`),
  reject('pass-method', 'pass(tab.evaluate);'),
  reject('reflect-apply', `Reflect.apply(tab.evaluate, tab, [${click}]);`),
  reject('reflect-get', `const ev = Reflect.get(tab, "evaluate"); ev(${click});`),
  reject('reflect-apply-elsewhere', 'Reflect.apply(read, null, []); await tab.evaluate(() => document.title);'),
  reject('reflect-get-elsewhere', 'Reflect.get(data, "title"); await tab.evaluate(() => document.title);'),
  reject('reflect-computed', 'Reflect[`get`](tab, "evaluate");'),
  reject('reflect-reference', 'const get = Reflect.get; await tab.evaluate(() => document.title);'),
  reject('optional-reference', 'const ev = tab?.evaluate;'),
  reject('bare-reference', 'pass(evaluate);'),
  reject('assignment-reference', 'tab.evaluate = read;'),
  reject('returned-reference', 'function get() { return tab.evaluate; }'),
  ...['evaluate', 'evaluateAll', 'evaluateHandle', '$eval', '$$eval', 'addInitScript',
    'waitForFunction', 'addScriptTag', 'addStyleTag', 'setContent', 'exposeFunction', 'route'].flatMap(method => {
      const prefix = ['$eval', '$$eval', 'exposeFunction', 'route'].includes(method) ? '"body", ' : '';
      return [
        reject(`method-${method}`, `await unknown.${method}(${prefix}${click});`),
        reject(`source-${method}`, `await unknown.${method}(${prefix}"document.body.click()");`),
        reject(`unknown-${method}`, `await unknown.${method}(${prefix}external);`),
        reject(`reference-${method}`, `const ev = unknown.${method};`),
      ];
    }),
  reject('script-content', 'await tab.addScriptTag({content:"document.body.click()"});'),
  reject('style-content', 'await tab.addStyleTag({content:"body {display:none}"});'),
  reject('html-content', 'await tab.setContent("<script>document.body.click()</script>");'),
  reject('plain-content', 'await tab.setContent("hello");'),
  reject('empty-content', 'await tab.setContent("");'),
];
export const round2Controls = [
  {id:'r2-function-reference', code:'function read(){ return document.title; } await tab.evaluate(read);', write:false},
  {id:'r2-arrow-reference', code:'const read = () => document.title; await tab.evaluate(read);', write:false},
  {id:'r2-wait-read', code:'await tab.waitForFunction(() => document.readyState === "complete");', write:false},
  {id:'r2-expose-read', code:'await tab.exposeFunction("read", () => 1);', write:false},
  {id:'r2-route-read', code:'await tab.route("**/*", () => 1);', write:false},
  {id:'r2-reflect-no-evaluation', code:'Reflect.get(data, "title"); Reflect.apply(read, null, []);', write:false},
  {id:'r2-bare-direct', code:'await evaluate(() => document.title);', write:false},
];

export const reviewerCells = [cells1, cells2, cells3, cells4, cells5, cells6, cells7].flatMap((cells, i) =>
  Object.entries(cells).map(([id, code]) => ({id: `reviewer-${i + 1}-${id}`, code,
    bank: i === 6 ? 'awkward' : i === 5 ? 'read-controls' : 'adversarial'})));
