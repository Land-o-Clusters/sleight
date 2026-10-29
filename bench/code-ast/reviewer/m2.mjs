// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 html1: '<!-- /*\napp.typeText("H1");\n// */',
 html2: '<!-- `\napp.typeText("H2");\n// `',
 html3: 'var x=1;\n--> /*\napp.typeText("H3");\n// */',
 html4: 'var x=1;\n/* c */ --> /*\napp.typeText("H4");\n// */',
 html5: '<!-- "\napp.typeText("H5");\n// "',
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls), 'inv',r.inv, 'strs',JSON.stringify(r.strs)); }
