// Offline broken variants in disposable processes. Production has no switches.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const controls = {
  inspection: ['code-ast.mjs', 'code-ast'],
  rebindings: ['repl/rebindings.mjs', 'glint4-rebindings'],
};
const variant = controls[process.env.GLINT4_MUTANT];
assert.ok(variant, 'select a named GLINT4_MUTANT');
const [file, suite] = variant;
const before = "if (program.body.length !== 1 || wrapper?.type !== 'FunctionDeclaration' ||\n" +
  '            wrapper.start !== 0 || wrapper.end !== source.length ||\n' +
  '            wrapper.body.start !== prefix.length - 2 || wrapper.body.end !== source.length)';
const target = new URL('../../plugins/sleight/lib/' + file, import.meta.url).href;
let applied = false;
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== target) return loaded;
  // Rebindings has a different indentation, but the same complete condition.
  const anchor = file.startsWith('repl/') ? before.replaceAll('\n            ', '\n          ') : before;
  assert.ok(String(loaded.source).includes(anchor), 'GLINT4 exactness mutation anchor');
  applied = true;
  return { ...loaded, source: String(loaded.source).replace(anchor, 'if (false)') };
} });
process.on('exit', () => { hook.deregister(); assert.ok(applied, 'GLINT4 mutation was applied'); });
await import('../' + suite + '.test.mjs');
