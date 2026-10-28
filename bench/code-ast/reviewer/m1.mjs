// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative.
import {run} from './h.mjs';
const cases = {
 repro: 'if (a) {}\n/[/*]/.test(s); app.typeText("SECRET"); /[*/]/.test(s)',
 a: 'var a=1;if(a){}\n/[/*]/.test(s); app.typeText("S1"); /[*/]/.test(s)',
 label: 'x: {}\n/[/*]/.test(s); app.typeText("S2"); /[*/]/.test(s)',
 fn: 'function f(){}\n/[/*]/.test(s); app.typeText("S3"); /[*/]/.test(s)',
 arrow: 'const f=()=>{}\n/[/*]/.test(s); app.typeText("S4"); /[*/]/.test(s)',
 cls: 'class A{}\n/[/*]/.test(s); app.typeText("S5"); /[*/]/.test(s)',
 obj: 'var o={}\n/[/*]/.test(s); app.typeText("S6"); /[*/]/.test(s)',
 prop: 'var a={in:1,typeof:2};var s=1; a.in / 2; a.typeof/2; app.typeText("S7"); /x/',
 pp: 'var a=1,b=1;a++\n/x/\nb; app.typeText("S8");/y/',
 yieldid: 'var yield=2; yield /2/ 1; app.typeText("S9") /1/ 1',
 awaitid: 'function g(){var await=2; return await /2/ 1;} app.typeText("S10")',
 paren: 'var a=4,g=2; (a) /2/ g; app.typeText("S11") /1/1',
 ifparen: 'if(1) /[/*]/.test(s); app.typeText("S12"); /[*/]/.test(s)',
};
for (const [k,v] of Object.entries(cases)) { const r=await run(v); console.log(k, 'syntax',r.syntax, r.err??'', 'calls',JSON.stringify(r.calls), 'inv',r.inv, 'strs',JSON.stringify(r.strs)); }
