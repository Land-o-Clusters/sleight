// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 strdot: "var s='x'; s.replace(\".\", /'/); app.typeText(\"D1\"); s.replace(\".\", /'/)",
 strdot2: "var s='x'; \".\" in /'/ || app.typeText(\"D2\"); var t = /'/",
 hash: "var s='x'; s.replace(\"#\", /'/); app.typeText(\"D3\"); s.replace(\"#\", /'/)",
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls.filter(c=>!c[0].includes('Symbol'))), 'inv',r.inv, 'strs',JSON.stringify(r.strs), r.ts); }
