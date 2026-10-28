import { oracle } from './oracle.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';

const count = Number(process.argv[2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('expected positive count');
let state = 151;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = array => array[Math.floor(random() * array.length)];
// Statement families observed in the 5,153-call study. Each cell has a distinct
// binding suffix and an injected input. No generated source executes.
const gaps = [';\n', '; ', ';\r\n', ';\u2028', ';\u2029', '; /*gap*/ '];
const run = oracle({ label: 'corpus-shaped seed=151' });
for (let i = 0; i < count; i++) {
  const suffix = `c${i}`, gap = pick(gaps);
  const shapes = [
    `let ${suffix}=await cua.getApp("Fixture")`,
    'await app.click(3)',
    'await app.getAXState()',
    `const ${suffix}=await app.getAXState(); nodeRepl.write(${suffix}.split("\\n").filter(l=>/Save|Open/i.test(l)).slice(0,40).join("\\n"))`,
    'await nodeRepl.emitImage(await app.getScreenshot())',
    `const ${suffix}=await app.getAXState(); nodeRepl.write(JSON.stringify(${suffix}))`,
    'await app.pressKey("super+s")',
    'await new Promise(r=>setTimeout(r,800))',
    'await app.getAXState().catch(()=>{})',
    'for(const n of [1,2]) { await app.click(n) }',
    `const ${suffix}=await cua.listWindows?.(); nodeRepl.write(${suffix}??[])`,
    '`${app.click(3)}`',
  ];
  const payload = 'app.typeText("PAYLOAD")';
  const injected = pick([`await ${payload}`, '`${' + payload + '}`', `true && ${payload}`, `for(const x of [1]) ${payload}`]);
  const code = pick([`${pick(shapes)}${gap}${injected}`, `${injected}${gap}${pick(shapes)}`]);
  if (parseCell(code).error) throw new Error(`invalid corpus-shaped generator case ${i}`);
  run.check(code, null);
  if ((i + 1) % 10000 === 0) console.log(JSON.stringify({ progress: i + 1 }));
}
run.finish();
