// FR3 structured generator, all three wrappers per case; no generated code executes.
import { oracle } from './oracle.mjs';
const seed = Number(process.argv[2] ?? 3), count = Number(process.argv[3] ?? 1000000);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(count) || count < 1) throw new Error('expected seed and positive count');
let state = seed >>> 0;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = items => items[Math.floor(random() * items.length)];
const run = oracle({ label: `structured seed=${seed}` });
const payload = 'app.typeText("PAYLOAD")';
const regex = ['/\'/','/[/*]/','/[*/]/','/x/g','/[\\/]/','/a\\/b/','/}/','/`/'];
const gap = [' ', '\n', '\r', '\u2028', '\u2029', '/*gap*/', '/*\ngap*/', '//gap\n'];
const operators = ['+', '-', '~', '*', '%', '/', '**', '<<', '>>', '>>>', '===', '!=', '??', '&&', '||', '&', '|', '^'];
const keywords = ['yield', 'await', 'of', 'async', 'get', 'set', 'static', 'as', 'from', 'let', 'in', 'typeof', 'void', 'delete', 'new', 'instanceof'];
const boundaries = ['var v', 'let v', 'var v, w', 'var a=1, w', 'debugger', 'if(ok){}', 'function f(){}',
  'class A{}', 'do{}while(ok)', 'if(ok)', 'for(var c of [1])', 'for await(var c of [1])', 'while(ok)'];
const numbers = ['1.', '1.e3', '1.e+3', '1.e-3', '.5', '.5e2', '1.5e-2', '1_000.', '0x10', '0b10', '0o10'];
const spreadWords = ['typeof', 'await', 'yield', 'void', 'new'];
const template = expression => '`${' + expression + '}`';
const generated = Array(15).fill(0);
for (let n = 0; n < count; n++) {
  const r = pick(regex), sep = pick(gap), word = pick(keywords), op = pick(operators);
  const variant = Math.floor(random() * generated.length);
  generated[variant]++;
  let code;
  switch (variant) {
    case 0: code = `${pick(boundaries)}${pick(['\n', '\r', '\u2028', '\u2029', '/*\n*/'])}${r}.test(s); ${payload}; ${r}.test(s)`; break;
    case 1: code = `var a=2 ${op}${sep}${r} / ${payload}; var q=${r}`; break;
    case 2: code = `var ${word}=4; ${word}${sep}/ ${payload} /1`; break;
    case 3: code = `s.replace(${JSON.stringify(pick(['.', '#', 'x']))},${sep}${r}); ${payload}; s.replace('.',${r})`; break;
    case 4: code = `${pick(['<!--', '-->'])}${sep}${pick(['/*', '`', '"', "'"])}\n${payload};\n// */`; break;
    case 5: {
      const expr = pick(['"`"', "'`'", '/`/.source', '1 /* ` */', '1 // `\n', '`nested`', 'n / 2', '({x: "}"}).x']);
      code = 'var z=`${' + sep + expr + '}`; ' + payload + '; var w=`${' + expr + '}`'; break;
    }
    case 6: code = `${pick(['x', 'obj.' + word, 'obj?.' + word, 'this.#' + word, '(a+b)', 'a[0]', '"12"', '`12`', 'x++', 'x--'])}${sep}/ ${payload} / 2;`; break;
    case 7: code = `for ${pick(['', 'await '])}(var c of${sep}${r}.exec(s)||[1]) ${payload}; var q=${r}`; break;
    case 8: code = `outer: while(ok) { ${pick(['break', 'continue'])} outer${sep}\n${r}.test(s); ${payload}; ${r}.test(s) }`; break;
    case 9: code = `const ratio=${pick(['a / b / c', 'x++ / 2', 'width\n / height / 2', 'text.split("/").length', 'text.replace(/[/]/g, "-").length'])}; ${payload};`; break;
    case 10: code = `${pick(numbers)}${sep}/ ${payload} / ${pick(numbers)};`; break;
    case 11: code = `[...${pick(spreadWords)}${sep}${r}, ${payload}, ${r}];`; break;
    case 12: {
      const [open, close] = pick([['f(', ')'], ['[', ']'], ['({...items, value: [', ']})']]);
      code = `${open}...${pick(spreadWords)}${sep}${r}, ${payload}, ${r}${close};`; break;
    }
    case 13: code = template(pick([payload, `(${payload}, ${payload})`, `f(${payload})`, `cua.getApp("Fixture"), ${payload}`])) + `; ${payload};`; break;
    case 14: code = template(pick([template(payload), `f(${template(payload)})`, template(`(${payload}, ${template(payload)})`)])) + `; ${payload};`; break;
  }
  for (const wrapper of ['async function f()', 'function f()', 'function* f()']) run.check(code, wrapper);
  if ((n + 1) % 100000 === 0) console.log(JSON.stringify({ progress: n + 1, failOpen: run.counts.failOpen }));
}
console.log(JSON.stringify({ generatedByVariant: generated }));
run.finish();
