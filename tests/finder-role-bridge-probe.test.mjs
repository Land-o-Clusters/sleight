import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = new URL('../bench/finder-role-bridge-probe.js', import.meta.url);
function calibration(options = {}) {
  assert.equal(existsSync(script), true, 'the fixed-value bridge calibration script is missing');
  const calls = [], object = text => ({ kind: 'object', text, isNil: () => false });
  const native = text => {
    assert.ok(['AXWindow', 'AXRole'].includes(text), 'only fixed local role strings may be created');
    calls.push(['string', text]); return object(text);
  };
  const text = value => value?.kind === 'ref' ? value.object.text : value?.text;
  Object.assign(native, {
    CFGetTypeID: value => {
      calls.push(['type', value.kind]);
      if (options.typeUnavailable && value.kind === 'ref') throw new Error('owner-private-error');
      return options.refTypeOther && value.kind === 'ref' ? 8 : 7;
    },
    CFStringGetTypeID: () => 7,
    CFEqual: (a, b) => {
      assert.ok(a && b, 'native equality cannot receive nil');
      calls.push(['equal', a.kind, b.kind]); return text(a) === text(b);
    },
    NSAccessibilityWindowRole: options.constantsMissing ? undefined : object('AXWindow'),
    NSAccessibilityRoleAttribute: options.constantsMissing ? undefined : object('AXRole'),
  });
  const permittedNative = new Proxy(native, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `unexpected native capability ${String(key)}`);
    return target[key];
  } });
  const sandbox = { $: permittedNative, ObjC: {
    import: name => {
      calls.push(['import', name]); assert.ok(['AppKit', 'CoreFoundation'].includes(name));
      if (options.importUnavailable) throw new Error('owner-private-framework-error');
    },
    castObjectToRef: value => {
      calls.push(['to-ref', value.kind]); assert.equal(value.kind, 'object');
      if (options.castUnavailable) throw new Error('owner-private-cast-error');
      return { kind: 'ref', object: value };
    },
    castRefToObject: value => {
      calls.push(['to-object', value.kind]); assert.equal(value.kind, 'ref'); return value.object;
    },
    unwrap: value => {
      calls.push(['unwrap', value.kind]);
      if (value.kind === 'ref') throw new Error('owner-private-ref-error');
      return options.shallowOther ? 'owner-private-role' : value.text;
    },
    deepUnwrap: value => {
      calls.push(['deep', value.kind]);
      if (value.kind === 'ref') throw new Error('owner-private-ref-error');
      return value.text;
    },
  } };
  runInNewContext(readFileSync(script, 'utf8'), sandbox);
  const run = args => JSON.parse(sandbox.run(args ?? []));
  return { run, calls };
}

test('bridge calibration reports only six fixed local routes and constant equality', () => {
  const f = calibration(), result = f.run();
  assert.equal(result.probe, 'finder-role-bridge');
  assert.equal(result.importState, 'available');
  assert.deepEqual(result.constants, { roleAttributeEqual: 'yes', windowRoleEqual: 'yes' });
  assert.equal(result.routes.length, 6);
  assert.deepEqual(result.routes.map(row => [row.value, row.route]), [
    ['AXWindow', 'bridged-nsstring'], ['AXWindow', 'cast-object-to-ref'], ['AXWindow', 'cast-ref-to-object-roundtrip'],
    ['AXRole', 'bridged-nsstring'], ['AXRole', 'cast-object-to-ref'], ['AXRole', 'cast-ref-to-object-roundtrip'],
  ]);
  for (const row of result.routes) {
    assert.equal(row.nativeType, 'cf-string');
    assert.equal(row.nativeExpectedEqual, 'yes');
    assert.equal(row.nativeOtherEqual, 'no');
    assert.equal(row.unwrap, row.route === 'cast-object-to-ref' ? 'unavailable' : 'expected');
    assert.equal(row.deepUnwrap, row.route === 'cast-object-to-ref' ? 'unavailable' : 'expected');
    assert.deepEqual(Object.keys(row).sort(), ['deepUnwrap', 'nativeExpectedEqual', 'nativeOtherEqual', 'nativeType', 'route', 'unwrap', 'value']);
  }
  assert.equal(f.calls.filter(row => row[0] === 'to-ref').length, 2);
  assert.equal(f.calls.filter(row => row[0] === 'to-object').length, 2);
});

test('bridge calibration keeps a raw-reference type disagreement visible', () => {
  const result = calibration({ refTypeOther: true }).run();
  assert.deepEqual(result.routes.map(row => row.nativeType), ['cf-string', 'other', 'cf-string', 'cf-string', 'other', 'cf-string']);
  assert.equal(result.routes[1].nativeExpectedEqual, 'yes', 'native equality is a separate observation');
});

test('bridge calibration separates shallow conversion disagreement from deep conversion', () => {
  const result = calibration({ shallowOther: true }).run();
  assert.equal(result.routes[0].unwrap, 'other-string');
  assert.equal(result.routes[0].deepUnwrap, 'expected');
  assert.doesNotMatch(JSON.stringify(result), /owner-private/);
});

test('bridge calibration contains framework failures without native calls', () => {
  const f = calibration({ importUnavailable: true }), result = f.run();
  assert.deepEqual(result, { probe: 'finder-role-bridge', importState: 'unavailable', routes: [],
    constants: { roleAttributeEqual: 'unavailable', windowRoleEqual: 'unavailable' } });
  assert.equal(f.calls.some(row => row[0] === 'string'), false);
});

test('bridge calibration reports missing constants without passing nil to native equality', () => {
  const result = calibration({ constantsMissing: true }).run();
  assert.deepEqual(result.constants, { roleAttributeEqual: 'unavailable', windowRoleEqual: 'unavailable' });
  assert.equal(result.routes.length, 6);
});

test('bridge calibration keeps failed casts closed without losing the bridged route', () => {
  const result = calibration({ castUnavailable: true }).run();
  assert.equal(result.routes[0].nativeType, 'cf-string');
  for (const index of [1, 2, 4, 5]) {
    assert.equal(result.routes[index].nativeType, 'unavailable');
    assert.equal(result.routes[index].nativeExpectedEqual, 'unavailable');
    assert.equal(result.routes[index].unwrap, 'unavailable');
  }
  assert.doesNotMatch(JSON.stringify(result), /owner-private/);
});

test('bridge calibration keeps type lookup failure separate from equality', () => {
  const result = calibration({ typeUnavailable: true }).run();
  assert.equal(result.routes[1].nativeType, 'unavailable');
  assert.equal(result.routes[1].nativeExpectedEqual, 'yes');
});

test('bridge calibration refuses arguments before imports or string construction', () => {
  const f = calibration(), result = f.run(['owner-private-input']);
  assert.deepEqual(result, { probe: 'finder-role-bridge', importState: 'unavailable', routes: [],
    constants: { roleAttributeEqual: 'unavailable', windowRoleEqual: 'unavailable' }, error: 'arguments-not-supported' });
  assert.deepEqual(f.calls, []);
});

test('macOS fixed-string bridge calibration validates native object routes', { skip: process.platform !== 'darwin' }, () => {
  const child = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(script)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.importState, 'available');
  assert.deepEqual(result.constants, { roleAttributeEqual: 'yes', windowRoleEqual: 'yes' });
  assert.equal(result.routes.length, 6);
  for (const row of result.routes) {
    if (row.route === 'cast-object-to-ref') {
      assert.notEqual(row.nativeType, 'cf-string', 'a raw reference is not a valid native diagnostic object');
      assert.notEqual(row.nativeExpectedEqual, 'yes');
    } else {
      assert.equal(row.nativeType, 'cf-string');
      assert.equal(row.nativeExpectedEqual, 'yes');
      assert.equal(row.nativeOtherEqual, 'no');
      assert.equal(row.unwrap, 'expected');
      assert.equal(row.deepUnwrap, 'expected');
    }
  }
});
