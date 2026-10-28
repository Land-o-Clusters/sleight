// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 asi1: "var s = '';\nvar v\n/[/*]/.test(s); app.typeText(\"A1\"); /[*/]/.test(s)",
 asi2: "var s = '';\nlet v\n/[/*]/.test(s); app.typeText(\"A2\"); /[*/]/.test(s)",
 asi3: "var s = '';\nl: while (1) { break l\n/[/*]/.test(s); app.typeText(\"A3\"); /[*/]/.test(s) }",
 asi4: "var s = '';\nl: for (var i=0;i<1;i++) { continue l\n/[/*]/.test(s); app.typeText(\"A4\"); /[*/]/.test(s) }",
 asi5: "var s = '';\nvar v, w\n/[/*]/.test(s); app.typeText(\"A5\"); /[*/]/.test(s)",
 binslash: "var b = 4; var a = b / /'/ / app.typeText(\"B1\"); var t = /'/",
 star: "var a = 2 * /'/ / app.typeText(\"B2\"); var t = /'/",
 dowhile: "var s='';do {} while (0)\n/[/*]/.test(s); app.typeText(\"A6\"); /[*/]/.test(s)",
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls.filter(c=>!c[0].includes('Symbol'))), 'inv',r.inv, 'strs',JSON.stringify(r.strs)); }
