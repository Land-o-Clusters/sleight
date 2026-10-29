// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 unary: 'var a = +/ // app.typeText("U1")',
 unary2: 'var a = 1 - /x/ / app.typeText("U2")\n',
 tilde: 'var a = ~/ // app.typeText("U3")',
 yieldid: 'var yield = 4; yield / app.typeText("Y1") /1',
 of: "for (var c of /'/.exec('x') || [1]) app.typeText(\"O1\"); var q = /'/",
 of2: "for (var c of /'/.exec('x') || [1]) { app.typeText(\"O2\") } /'/",
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls), 'inv',r.inv, 'strs',JSON.stringify(r.strs), r.ts); }
