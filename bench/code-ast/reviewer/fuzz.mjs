// FR2 reviewer reproducer, copied 2026-10-28; imports made repository-relative; shared oracle checks call tokens and exits nonzero on a miss.
import { oracle } from '../oracle.mjs';
const seed0 = Number(process.argv[2]||1), N = Number(process.argv[3]||500000), offset = Number(process.argv[5]||0);
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('expected nonnegative offset');
let s = seed0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2**32;
const pick = a => a[Math.floor(rnd()*a.length)];
const html = process.argv[4]==='html';
const pool = [
 '{','}','{}','(',')','[',']',';',',','\n','\n','\n',' ','/','/','/','//','/*','*/','/ 2','/2/','/a/','/[/*]/','/[*/]/','/x/g','/=/','/\\//',
 'if (a)','if (a) {}','else','else {}','while (a)','for (;;)','do','do {} while (a)','function f(){}','function(){}','class A{}','class A extends B{}','x = {}','x = {a:1}','x = () => {}','x = () => ({})','=>','=> {}',
 'typeof','void','in','new','delete','instanceof','yield','await','return','throw','case','default','default:','switch (a)','try {}','catch (e) {}','finally {}','label:','async',
 'a','b','s','x','a.in','a.typeof','a.new','a.void','a.delete','a?.in','++','--','+','-','*','=','==','!','?',':','&&','||','.','`t`','`${a}`','`${ {} }`','`${ `i` }`','"s"',"'s'",'1','0',
 'x = `${}`','({})','[]','a = b','var v','let l','const c = 1','get','set','static','of','as','=> /re/','!/re/','+/re/',
 ...(html?['<!--','-->','<!-- /*','--> /*']:[]),
];
const payload = 'app.typeText("PAYLOAD")';
const run = oracle({ label: 'reviewer fuzz.mjs seed=' + seed0, caseOffset: offset });
for (let it = 0; it < N + offset; it++) {
  const len = 3 + Math.floor(rnd()*10);
  const parts = []; for (let k = 0; k < len; k++) parts.push(pick(pool));
  parts.splice(Math.floor(rnd()*(parts.length+1)), 0, payload);
  const sep = pick([' ','\n','',' ','\n']);
  const code = parts.join(sep);
  if (it < offset) continue;
  run.check(code);
  if ((it + 1) % 100000 === 0) console.log(JSON.stringify({ progress: it + 1, failOpen: run.counts.failOpen }));
}
run.finish();
