import test from 'node:test';
import assert from 'node:assert/strict';
import { rebindCell } from '../plugins/sleight/lib/repl/rebindings.mjs';

for (const tail of ['}\nfoo();\n{', '}\nfoo();\nasync function z(){', '}\n//', '}\n/* tail */'])
  test('GLINT4 rebinding refuses an escaped await wrapper: ' + JSON.stringify(tail), () => {
    const declared = new Set(['app']);
    assert.throws(() => rebindCell('await foo();\n' + tail, declared), SyntaxError);
    assert.deepEqual([...declared], ['app']);
  });
test('GLINT4 rebinding preserves a complete await body and sloppy await identifiers', () => {
  const result = rebindCell('let app = await foo();\n{ bar(); }', new Set(['app']));
  assert.equal(result.code, '(app = (await foo()));\n{ bar(); }');
  assert.deepEqual([...result.names], ['app']);
  assert.equal(rebindCell('var await = 1; await;', new Set()).code, 'var await = 1; await;');
});
