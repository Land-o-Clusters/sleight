import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCellParser, checkInstalledCellParser } from '../bench/compat/parser.mjs';

// Synthetic contract fixture, not engine source.
const block = 'parseModule(code, {next:true,module:true,ranges:true,loc:false,disableWebCompat:true,onToken:diagnosticTokens,onComment(_kind,_value,start,end){ diagnosticComments.push({start,end}); }})';
const binary = `Meriyah v7.0.0\0${block}\0${block}`;
test('parser contract reports version and exact options without engine source', () => {
  const check = checkCellParser(binary);
  assert.equal(check.status, 'pass'); assert.equal(check.version, '7.0.0'); assert.equal(check.blocks, 2);
  assert.deepEqual(check.options, { next: true, module: true, ranges: true, loc: false, disableWebCompat: true });
  assert.ok(!JSON.stringify(check).includes('diagnosticComments'));
});
test('installed parser check reads the pinned binary and fails closed if unreadable', () => {
  let path;
  assert.equal(checkInstalledCellParser({ app: '/fixture/ChatGPT.app', readFile: file => {
    path = file; return Buffer.from(binary);
  } }).status, 'pass');
  assert.ok(path.startsWith('/fixture/ChatGPT.app/'));
  assert.ok(path.endsWith('/node_repl'));
  assert.deepEqual(checkInstalledCellParser({ readFile: () => { throw Error('PRIVATE'); } }), {
    id: 'cell-parser', status: 'fail', reason: 'node_repl cell parser is unreadable',
  });
});
for (const [name, mutation] of [
  ['new version', binary.replace('7.0.0', '7.1.0')],
  ['missing banner', binary.replace('Meriyah v7.0.0', '')],
  ['one parser block', `Meriyah v7.0.0\0${block}`],
  ['changed next', binary.replace('next:true', 'next:false')],
  ['changed module', binary.replace('module:true', 'module:false')],
  ['changed ranges', binary.replace('ranges:true', 'ranges:false')],
  ['changed loc', binary.replace('loc:false', 'loc:true')],
  ['changed web compat', binary.replace('disableWebCompat:true', 'disableWebCompat:false')],
  ['extra option', binary.replace('onToken:', 'jsx:true,onToken:')],
  ['extra trailing option', binary.replace('}); }})', '}); },jsx:true})')],
  ['wrong callback shape', binary.replace('onComment(', 'otherCallback(')],
]) test(`parser contract fails closed: ${name}`, () => assert.equal(checkCellParser(mutation).status, 'fail'));
