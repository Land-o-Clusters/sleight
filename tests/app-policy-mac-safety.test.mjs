import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAppPolicy } from '../plugins/sleight/lib/app-policy.mjs';
import { knownNonAppAncestorPath } from '../plugins/sleight/lib/app-policy/ancestry.mjs';
import { PASS_THROUGH } from '../plugins/sleight/lib/platform/darwin-ancestry.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import * as ancestryPolicy from '../plugins/sleight/lib/app-policy/ancestry.mjs';

test('SA2S evaluator refuses an empty ancestry chain', () => {
  const result = evaluateAppPolicy({ bundleId: 'com.apple.TextEdit', executableName: 'TextEdit',
    processAncestry: [], windowTitle: 'Document', operation: 'getAXState' });
  assert.equal(result.allow, false);
  assert.equal(result.code, 'APP_POLICY_INVALID_METADATA');
  assert.equal(result.cause, 'processAncestry');
});

test('SA2S mapper uses the outermost bundle and leaves bare binaries non-app', () => {
  assert.equal(typeof ancestryPolicy.classifyAncestorPath, 'function');
  const reads = [];
  const read = path => { reads.push(path); return 'com.microsoft.VSCode'; };
  assert.deepEqual(ancestryPolicy.classifyAncestorPath(
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', read),
  { bundleId: 'com.microsoft.VSCode' });
  assert.deepEqual(reads, ['/Applications/Visual Studio Code.app/Contents/Info.plist']);
  for (const path of ['/bin/zsh', '/opt/homebrew/bin/node', '/fixture/bin/zsh', '/fixture/.local/share/claude/versions/2.1.309'])
    assert.deepEqual(ancestryPolicy.classifyAncestorPath(path, read), { kind: 'non-app' });
  assert.equal(reads.length, 1);
});

test('SA2S mapper never calls the plist reader for malformed paths', () => {
  assert.equal(typeof ancestryPolicy.classifyAncestorPath, 'function');
  let reads = 0;
  for (const path of [null, '', 'relative/node', '/Applications/../Host.app/Contents/MacOS/Host',
    '/Applications/Host.app/Contents/MacOS/Host/', '/Applications/Host.app//Contents/MacOS/Host',
    '/Applications/./Host.app/Contents/MacOS/Host', '/Applications/Host.app/Contents/MacOS/Host\u0000', '/a'.repeat(9000)])
    assert.equal(ancestryPolicy.classifyAncestorPath(path, () => { reads++; return 'test.host'; }), null);
  assert.equal(reads, 0);
});

// Every OS boundary is injected. These checks never query or drive a real app.
function fixture(ancestry, rawPolicy, apps) {
  const window = { windowId: '42', pid: 50, processStart: '100.25', bundleId: 'test.editor',
    app: 'Editor', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 500, height: 500 } };
  let reads = 0, approvals = 0;
  const chains = [];
  const safety = createMacSafety({
    ancestry, targetParents: () => [1],
    // The base has a positional policy call. Bridge it explicitly in this fixture;
    // production API integration belongs to the lane that owns mac-safety.
    policy: rawPolicy ?? ((bundleId, processAncestry, windowTitle) => {
      chains.push(processAncestry);
      return evaluateAppPolicy({ bundleId, processAncestry, windowTitle, executableName: 'Editor',
        operation: 'getAXState', secureInput: false, focusedSecureField: false });
    }),
    driver: { async request(method) {
      if (method === 'getState') return { apps: apps ?? [{ id: window.bundleId, name: 'Editor', pid: window.pid,
        processStart: window.processStart, path: '/Applications/Editor.app' }] };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: 'Editor', pid: window.pid,
        processStart: window.processStart, path: '/Applications/Editor.app' }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window: structuredClone(window) };
      assert.equal(method, 'getAXState');
      reads++;
      return { window: structuredClone(window), text: 'fixture content', readId: reads };
    } },
    lease: { acquire: () => 'fixture-lease', renew() {}, release() {}, close() {} },
    approve: async () => { approvals++; return true; },
    allowForbidden: () => true,
    permissions: { app() {}, page() {}, sitesLimited: () => false },
  });
  return { safety, chains, reads: () => reads, approvals: () => approvals };
}

test('mac-safety maps known system executables to the explicit non-app sentinel', async () => {
  const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }, { pid: 80, path: '/usr/bin/env' },
    { pid: 70, path: '/Applications/Host.app/Contents/MacOS/Host', bundleId: 'test.host' }]);
  try {
    assert.equal((await h.safety.request('getApp', { selector: 'Editor' })).readId, 1);
    assert.equal(h.reads(), 1);
    assert.equal(h.approvals(), 1);
    assert.equal(h.chains.length, 4);
    for (const chain of h.chains) assert.deepEqual(chain,
      [{ kind: 'non-app' }, { kind: 'non-app' }, { bundleId: 'test.host' }]);
  } finally { h.safety.close(); }
});

for (const bundleId of [null, undefined, '', 7, false, {}, []]) {
  test(`mac-safety preserves failed bundle lookup ${String(bundleId)} as a refusal`, async () => {
    const h = fixture(() => [{ pid: 90, path: '/Applications/Host.app/Contents/MacOS/Host', bundleId }]);
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }),
        { code: 'APP_POLICY_INVALID_METADATA', cause: 'processAncestry[0]', delivery: 'not-sent' });
      assert.equal(h.reads(), 0);
      assert.equal(h.approvals(), 0);
      assert.deepEqual(h.chains, []);
    } finally { h.safety.close(); }
  });
}

test('mac-safety emits null when an app ancestor has no bundle lookup result', async () => {
  const h = fixture(() => [{ pid: 90, path: '/Applications/Host.app/Contents/MacOS/Host' }]);
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }), { code: 'APP_POLICY_INVALID_METADATA' });
    assert.deepEqual(h.chains, [[null]]);
    assert.equal(h.reads(), 0);
    assert.equal(h.approvals(), 0);
  } finally { h.safety.close(); }
});

for (const metadata of [{ kind: 'lookup-error' }, { kind: 'non-app', bundleId: null },
  { kind: 'non-app', bundleId: 'test.editor' }]) {
  test(`mac-safety refuses contradictory or failed ancestor metadata ${JSON.stringify(metadata)}`, async () => {
    const h = fixture(() => [{ pid: 90, path: '/bin/zsh', ...metadata }]);
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }), { code: 'APP_POLICY_INVALID_METADATA' });
      assert.deepEqual(h.chains, metadata.bundleId === null ? [] : [[null]]);
      assert.equal(h.reads(), 0);
      assert.equal(h.approvals(), 0);
    } finally { h.safety.close(); }
  });
}

test('mac-safety forwards a known non-app classification as the exact sentinel', async () => {
  const h = fixture(() => [{ pid: 90, path: '/Fixtures/known-shell', kind: 'non-app' }]);
  try {
    assert.equal((await h.safety.request('getApp', { selector: 'Editor' })).readId, 1);
    for (const chain of h.chains) assert.deepEqual(chain, [{ kind: 'non-app' }]);
  } finally { h.safety.close(); }
});

test('mac-safety classifies a bare executable as non-app', async () => {
  const h = fixture(() => [{ pid: 90, path: '/Fixtures/unknown' }]);
  try {
    await h.safety.request('getApp', { selector: 'Editor' });
    assert.deepEqual(h.chains[0], [{ kind: 'non-app' }]);
    assert.equal(h.reads(), 1);
  } finally { h.safety.close(); }
});

test('mac-safety refuses a thrown ancestry lookup before policy, approvals or content', async () => {
  const h = fixture(() => { throw Error('lookup failed'); });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }), { code: 'ANCESTRY_UNAVAILABLE' });
    assert.equal(h.chains.length, 0);
    assert.equal(h.approvals(), 0);
    assert.equal(h.reads(), 0);
  } finally { h.safety.close(); }
});

test('mac-safety keeps a verified app ancestor refused under the override', async () => {
  const h = fixture(() => [{ pid: 90, path: '/Applications/Editor.app/Contents/MacOS/Editor', bundleId: 'test.editor' }]);
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }), { code: 'FORBIDDEN_TARGET' });
    assert.equal(h.reads(), 0);
    assert.equal(h.approvals(), 0);
  } finally { h.safety.close(); }
});

test('the base positional policy call fails closed without the metadata adapter', async () => {
  const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }], evaluateAppPolicy);
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }), { code: 'APP_POLICY_INVALID_METADATA' });
    assert.equal(h.reads(), 0);
    assert.equal(h.approvals(), 0);
  } finally { h.safety.close(); }
});

const passThrough = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'sudo', 'su', 'env', 'nice'];
test('the ancestry sentinel shares exactly the 13 reviewed pass-through names', () => {
  assert.deepEqual([...PASS_THROUGH].sort(), [...passThrough].sort());
});

for (const directory of ['/bin', '/sbin', '/usr/bin', '/usr/sbin']) {
  for (const name of passThrough) test(`only pass-through launcher ${directory}/${name} gets the sentinel`, async () => {
    const path = `${directory}/${name}`;
    assert.equal(knownNonAppAncestorPath(path), true);
    const h = fixture(() => [{ pid: 90, path }]);
    try {
      assert.equal((await h.safety.request('getApp', { selector: 'Editor' })).readId, 1);
      for (const chain of h.chains) assert.deepEqual(chain, [{ kind: 'non-app' }]);
    } finally { h.safety.close(); }
  });
}

for (const path of [
  ...['python3', 'ruby', 'perl', 'osascript', 'ssh', 'sshd', 'script', 'expect', 'node', 'tclsh']
    .flatMap(name => ['/bin', '/sbin', '/usr/bin', '/usr/sbin'].map(directory => `${directory}/${name}`)),
  '/usr/local/bin/zsh', '/usr/bin/x/y', '/usr/bin/ZSH', '/usr/bin/zsh.link', '/usr/bin/alias/zsh',
]) test(`bare executable ${path} is non-app without a shell allowlist`, async () => {
  assert.equal(knownNonAppAncestorPath(path), false);
  const h = fixture(() => [{ pid: 90, path }]);
  try {
    assert.equal((await h.safety.request('getApp', { selector: 'Editor' })).readId, 1);
    assert.deepEqual(h.chains[0], [{ kind: 'non-app' }]);
  } finally { h.safety.close(); }
});
for (const path of ['/usr/bin/../bin/zsh', '/usr/bin/..', '/usr/bin/.', '/usr/bin/./zsh',
  '/usr//bin/zsh', '//usr/bin/zsh', 'usr/bin/zsh', '/usr/bin/zsh/']) {
  test(`malformed executable ${path} remains unknown`, async () => {
    const h = fixture(() => [{ pid: 90, path }]);
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'Editor' }),
        { code: 'APP_POLICY_INVALID_METADATA', cause: 'processAncestry[0]' });
      assert.equal(h.reads(), 0); assert.equal(h.approvals(), 0);
    } finally { h.safety.close(); }
  });
}

for (const method of ['getState', 'listApps']) {
  for (const identity of [{ bundleId: 'test.good' }, { bundleId: 'test.good', id: 'test.driver-alias' }]) {
    test(`${method} identifies an eligible app by its resolved bundle id ${JSON.stringify(identity)}`, async () => {
      const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }], undefined,
        [{ ...identity, name: 'Good', pid: 51, running: true, useCount: 2 }]);
      try {
        const result = await h.safety.request(method, {});
        assert.deepEqual(result.apps, [{ id: 'test.good', name: 'Good', running: true, useCount: 2 }]);
        assert.deepEqual(result.errors, []);
        assert.equal(h.reads(), 0);
        assert.equal(h.approvals(), 0);
      } finally { h.safety.close(); }
    });
  }

  for (const identity of [{ bundleId: 'test.bad' }, { bundleId: 'test.bad', id: 'test.driver-alias' }]) {
    test(`${method} identifies an invalid app by its resolved bundle id ${JSON.stringify(identity)}`, async () => {
      const apps = [{ id: 'test.good', name: 'Good', pid: 51 },
        { ...identity, name: 'Private name', pid: 53, path: '/Private/app', title: 'Private title' }];
      const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }], bundleId =>
        evaluateAppPolicy({ bundleId, processAncestry: [{ kind: 'non-app' }], executableName: bundleId === 'test.bad' ? '2.1.5' : 'Editor',
          windowTitle: '', operation: 'getState' }), apps);
      try {
        const result = await h.safety.request(method, {});
        assert.deepEqual(result.apps, [{ id: 'test.good', name: 'Good', running: undefined, useCount: undefined }]);
        assert.deepEqual(result.errors,
          [{ app: 'test.bad', code: 'APP_POLICY_INVALID_METADATA', cause: 'executablePath' }]);
        assert.doesNotMatch(JSON.stringify(result), /Private|driver-alias/);
        assert.equal(h.reads(), 0);
        assert.equal(h.approvals(), 0);
      } finally { h.safety.close(); }
    });
  }

  for (const row of [{ pid: 90, path: '/Applications/Unknown.app/Contents/MacOS/Unknown' },
    { pid: 90, path: '/Fixtures/Host', bundleId: 7 }]) {
    test(`${method} surfaces invalid ancestry ${JSON.stringify(row)} with its cause`, async () => {
      const h = fixture(() => [row]);
      try {
        const result = await h.safety.request(method, {});
        assert.deepEqual(result.apps, []);
        assert.deepEqual(result.errors,
          [{ app: 'test.editor', code: 'APP_POLICY_INVALID_METADATA', cause: 'processAncestry[0]' }]);
        assert.equal(h.reads(), 0);
        assert.equal(h.approvals(), 0);
      } finally { h.safety.close(); }
    });
  }
  test(`${method} preserves a policy metadata cause without exposing app metadata`, async () => {
    const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }], () =>
      ({ allow: false, code: 'APP_POLICY_INVALID_METADATA', cause: 'executableName' }));
    try {
      const result = await h.safety.request(method, {});
      assert.deepEqual(result.apps, []);
      assert.deepEqual(result.errors,
        [{ app: 'test.editor', code: 'APP_POLICY_INVALID_METADATA', cause: 'executableName' }]);
      assert.equal(h.reads(), 0);
      assert.equal(h.approvals(), 0);
    } finally { h.safety.close(); }
  });

  for (const badIndex of [0, 1, 2]) {
    test(`${method} preserves two valid apps around invalid app at index ${badIndex}`, async () => {
      const apps = [{ id: 'test.first', name: 'First', pid: 51 },
        { id: 'test.last', name: 'Last', pid: 52 }];
      apps.splice(badIndex, 0, { id: 'test.bad', name: 'Private name', pid: 53,
        path: '/Private/app', title: 'Private title', executableName: '2.1.5' });
      const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }], bundleId =>
        evaluateAppPolicy({ bundleId, processAncestry: [{ kind: 'non-app' }], executableName: bundleId === 'test.bad' ? '2.1.5' : 'Editor',
          windowTitle: '', operation: 'getState' }), apps);
      try {
        const result = await h.safety.request(method, {});
        assert.deepEqual(result.apps, [
          { id: 'test.first', name: 'First', running: undefined, useCount: undefined },
          { id: 'test.last', name: 'Last', running: undefined, useCount: undefined },
        ]);
        assert.deepEqual(result.errors,
          [{ app: 'test.bad', code: 'APP_POLICY_INVALID_METADATA', cause: 'executablePath' }]);
        if (method === 'getState') assert.deepEqual(result.windows, []);
        assert.doesNotMatch(JSON.stringify(result), /Private|2\.1\.5/);
        assert.equal(h.reads(), 0);
        assert.equal(h.approvals(), 0);
      } finally { h.safety.close(); }
    });
  }

  test(`${method} returns empty errors when all app metadata is valid`, async () => {
    const h = fixture(() => [{ pid: 90, path: '/bin/zsh' }]);
    try {
      const result = await h.safety.request(method, {});
      assert.equal(result.apps.length, 1);
      assert.deepEqual(result.errors, []);
    } finally { h.safety.close(); }
  });

  for (const code of ['APP_POLICY_UNAVAILABLE', 'ANCESTRY_UNAVAILABLE']) {
    test(`${method} still stops on ${code}`, async () => {
      const h = fixture(() => {
        if (code === 'ANCESTRY_UNAVAILABLE') throw Error('unavailable');
        return [{ pid: 90, path: '/bin/zsh' }];
      }, () => ({ allow: false, code }));
      try {
        await assert.rejects(h.safety.request(method, {}), { code, parentSafety: true, delivery: 'not-sent' });
        assert.equal(h.reads(), 0);
        assert.equal(h.approvals(), 0);
      } finally { h.safety.close(); }
    });
  }
}
