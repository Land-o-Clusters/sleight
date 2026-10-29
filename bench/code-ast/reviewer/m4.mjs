// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 forawait: "for await (var c of [1]) /'/.test(c); app.typeText(\"FA1\"); /'/.test(c)",
 tplstr: "var z = `${ \"`\" }`; app.typeText(\"T1\"); var w = `${ \"`\" }`",
 tplcomment: "var z = `${ 1 /* ` */ }`; app.typeText(\"T2\"); var w = `${ 1 /* ` */ }`",
 tplregex: "var z = `${ /`/.source }`; app.typeText(\"T3\"); var w = `${ /`/.source }`",
 objdiv: "var o = {}; var n = 4; var q = o\n/n/ app.typeText('x')",
 kwprop: "var a={in:1}; a.in\n/ 2; app.typeText('K1')",
 kwprop2: "var a={new:1}; a\n.new /'/.test; app.typeText('K2'); /'/",
 getter: "var a={get in(){return 1}}; a.in / 2; app.typeText('K3'); '/'",
 async_: "var async=2; async /'/.x; app.typeText('K4'); var t=/'/",
 let_: "var let1=2;",
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls.filter(c=>!c[0].includes('Symbol'))), 'inv',r.inv, 'strs',JSON.stringify(r.strs), r.ts); }
