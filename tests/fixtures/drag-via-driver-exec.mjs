import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runScript } from '../../plugins/sleight/lib/launch.mjs';

const script = readFileSync(new URL('../../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');

export function runFakeDragLocal(script, request, options) {
  // runScript owns DP flags. Select each scenario's launcher configuration so
  // the direct and wrapped arms execute the same predicates.
  const previous = { SLEIGHT_DP2: process.env.SLEIGHT_DP2, SLEIGHT_DP7: process.env.SLEIGHT_DP7 };
  try {
    process.env.SLEIGHT_DP2 = request.dp2 === false ? '0' : '1';
    process.env.SLEIGHT_DP7 = request.dp7 === false ? '0' : '1';
    return runScript(script, request, options);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// Replace only execFile. The production launcher still serializes the request,
// sets its deadline and strips untrusted handPid values. Never start osascript.
export function fakeDragExecutor(fixture) {
  return (command, args, options, callback) => {
    assert.equal(command, 'osascript');
    assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
    if (args[2] === '-e') {
      assert.equal(args[3], script, 'the engine script is loaded without edits');
      assert.equal(args[4], '-e');
      assert.equal(args.length, 7);
      vm.runInContext(args[5], fixture.context);
    } else {
      assert.match(args[2], /\/drag\.js$/);
      assert.equal(args.length, 4);
    }
    const result = fixture.run(JSON.parse(args.at(-1)));
    callback(null, JSON.stringify(result), '');
    return null;
  };
}

export function driverScriptRunner(fixture, bindings, current = () => {}) {
  const { source, destination } = bindings;
  return {
    driver: {
      resolveApp: async () => ({ app: { id: source.bundleId, pid: source.pid, processStart: source.processStart, running: true } }),
      verifyWindowIdentity: async id => ({ window: id === source.windowId ? source : destination }),
    },
    runLocal: runFakeDragLocal, bindings: () => bindings, current,
  };
}
