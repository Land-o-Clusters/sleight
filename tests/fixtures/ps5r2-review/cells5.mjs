// Frozen PS5R review data. Cell strings are never executed.
const click='() => { document.querySelector("#pay").click(); }';
export default {
l1: `let h; h = {evaluate: f => f()}; await h.evaluate(${click});`,
l2: `var h = {evaluate: f => f()}; var h = tab; await h.evaluate(${click});`,
l3: `const h = flag ? {evaluate: f => f()} : tab; await h.evaluate(${click});`,
l4: `function h(){} function h(){ return tab; } await h.evaluate(${click});`,
l5: `await h.evaluate(${click}); const h = {evaluate: f => f()};`,
l6: `const {h} = {h: {evaluate: f => f()}}; await h.evaluate(${click});`,
l7: `const [h] = [tab]; await h.evaluate(${click});`,
l8: `const h = {evaluate: f => f()}; const {evaluate} = h; await evaluate(${click});`,
l9: `const h = {evaluate: f => f()}; for (const x of [h]) { Object.setPrototypeOf(x, tab); } await h.evaluate(${click});`,
l10: `const h = {}; const g = h; Object.setPrototypeOf(g, tab); await h.evaluate(${click});`,
l11: `const h = {}; await (async (o) => { Object.setPrototypeOf(o, tab); })(h); await h.evaluate(${click});`,
l12: `const h = {}; h['__proto__'] = tab; await h.evaluate(${click});`,
l13: `const h = {}; h.constructor = 1; ({}).__proto__.evaluate = tab.evaluate; await h.evaluate(${click});`,
l14: `Object.prototype.evaluate = tab.playwright.evaluate; const h = {}; await h.evaluate(${click});`,
l15: `Object.prototype.evaluate = tab.playwright.evaluate; const h = {evaluate: undefined}; delete h.evaluate; await h.evaluate(${click});`,
l16: `const h = {x:1}; Object.prototype.evaluate = tab.playwright.evaluate; await h.evaluate(${click});`,
l17: `const h = {}; Function.prototype.evaluate = tab.playwright.evaluate; function g(){}; await g.evaluate(${click});`,
l18: `Object.defineProperty(Object.prototype, 'evaluate', {value: tab.playwright.evaluate}); const h = {}; await h.evaluate(${click});`,
};
