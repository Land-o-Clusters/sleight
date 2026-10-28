// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const ok = [
 "const rows=[1,2]; let total=0; for (const r of rows) { total += r }\nconst pct = total / rows.length / 2; app.typeText('a')",
 "const o={w:4,h:2}; const ratio = o.w / o.h / 2; app.typeText('a')",
 "const f = () => { return 4 }; const x = f() / 2 / 1; app.typeText('a')",
 "if (1) { }\nconst m = /ab/.exec('ab'); app.typeText('a')",
 "if (1) { }\n/ab/.test('ab') && app.typeText('a')",
 "try { x() } catch (e) { }\n/ab/.test('ab') && app.typeText('a')",
 "const a = [1,2].map(n => { return n * 2 }).length / 2 / 1; app.typeText('a')",
 "const t = `${1}` / 2 / 3; app.typeText('a')",
 "const v = (typeof 4) + (4 in {}) ; app.typeText('a')",
 "const o = {default: 1, in: 2}; const d = o.default / o.in / 1; app.typeText('a')",
 "const w = { a: 1 }.a / 2 / 3; app.typeText('a')",
];
for (const c of ok) { const r = await run(c); console.log(r.inv ? 'REFUSED' : 'ok     ', JSON.stringify(c).slice(0,100)); }
