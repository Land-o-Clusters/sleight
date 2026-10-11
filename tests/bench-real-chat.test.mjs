import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_APPS, setupChat, cleanupChat, expectedChat, labelsChat, observationFromAX, promptChat } from '../bench/real-chat.mjs';

// Invented AX titles only. The decoy is deliberately last, as in the old parser's failure.
function tree() {
  return [
    { role: 'row', identifier: 'conversation-7', selected: true, title: 'Invented channel' },
    { role: 'AXList', identifier: 'chat-messages', scroll: { value: 1, min: 0, max: 1 }, children: [
      { role: 'AXGroup', identifier: 'message-10', children: [{ role: 'AXStaticText', identifier: 'message-author-10', title: 'Invented Older' }] },
      { role: 'AXGroup', identifier: 'message-11', children: [{ role: 'AXStaticText', identifier: 'message-author-11', title: 'Invented Author' },
        { role: 'static text', title: 'Private body decoy' }] },
    ] },
    { role: 'static text', title: 'Private body decoy' },
  ];
}
function host(kind, { initiallyOpen = true, observation = () => ({ nodes: tree(), diagnostics: { nodeCount: 9, roles: { AXGroup: 2 } } }), launchError, afterFront = 'com.example.owner' } = {}) {
  const bundle = CHAT_APPS[kind].bundle, calls = [];
  let processes = initiallyOpen ? [{ pid: 42, launchedAt: 100 }] : [];
  let frontmost = 'com.example.owner';
  return {
    calls,
    options: {
      running: async () => initiallyOpen,
      native: async (_ctx, _kind, operation, identity) => {
        calls.push(operation);
        if (operation === 'table') return { processes: structuredClone(processes), frontmost };
        if (operation === 'observe') { assert.deepEqual(identity, { pid: 42, launchedAt: 100 }); return observation(); }
        if (operation === 'quit') { assert.deepEqual(identity, { pid: 42, launchedAt: 100 }); processes = []; return { quit: true }; }
        throw new Error('unexpected native operation');
      },
      open: async (id, target) => {
        assert.equal(id, bundle); assert.equal(target, undefined); calls.push('open');
        processes = [{ pid: 42, launchedAt: 100 }]; frontmost = afterFront;
        if (launchError) throw new Error('Private launch error decoy');
      },
    },
  };
}

for (const kind of ['slack', 'discord', 'whatsapp']) {
  test(`${kind}: default setup uses native AX and leaves an open process alone`, async () => {
    const fake = host(kind), ctx = { ownerPresent: true };
    await setupChat(ctx, kind, fake.options);
    assert.equal(expectedChat(ctx), 'Invented Author');
    assert.deepEqual(labelsChat(ctx), ['Invented channel', 'Invented Author']);
    assert.match(promptChat(ctx), /Invented channel/);
    assert.doesNotMatch(promptChat(ctx), /Private body decoy/);
    assert.equal(ctx.fixtureDiagnostics[0].launched, false);
    await cleanupChat(ctx);
    await ctx.windowLeases[0].quit(); // Also safe through the pass's final cleanup.
    assert.deepEqual(fake.calls, ['table', 'observe']);
    assert.doesNotMatch(JSON.stringify(ctx), /Invented|Private body/);
  });
  test(`${kind}: closed app launches in background and cleanup quits once`, async () => {
    const fake = host(kind, { initiallyOpen: false }), ctx = { ownerPresent: true };
    await setupChat(ctx, kind, fake.options);
    const diagnostic = ctx.fixtureDiagnostics[0];
    assert.equal(diagnostic.launched, true);
    assert.equal(diagnostic.frontmostChanged, false);
    assert.equal(diagnostic.frontmostBefore, 'com.example.owner');
    assert.equal(diagnostic.frontmostAfter, 'com.example.owner');
    await cleanupChat(ctx); await cleanupChat(ctx); await ctx.windowLeases[0].quit();
    assert.deepEqual(fake.calls, ['table', 'open', 'table', 'observe', 'quit']);
    assert.equal(diagnostic.appQuit, true);
  });
}

test('AX baseline rejects generic static text instead of calling a body an author', () => {
  const nodes = tree(); delete nodes[1].children[1].children[0].identifier;
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects a scrolled-up list even when the visible final author is known', () => {
  const nodes = tree(); nodes[1].scroll.value = 0.5;
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects absent scroll proof', () => {
  const nodes = tree(); delete nodes[1].scroll;
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects two selected conversations', () => {
  const nodes = tree(); nodes.push({ ...nodes[0], title: 'Other invented channel' });
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects two message lists', () => {
  const nodes = tree(); nodes.push(structuredClone(nodes[1]));
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline refuses an authorless newest message instead of inheriting an older author', () => {
  const nodes = tree(); nodes[1].children.push({ role: 'AXGroup', identifier: 'message-12', children: [] });
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects multiple author controls in the newest message', () => {
  const nodes = tree(); nodes[1].children[1].children.push({ role: 'AXButton', identifier: 'message-author-12', title: 'Other invented author' });
  assert.equal(observationFromAX(nodes), null);
});

test('launch frontmost changes and sanitized AX diagnostics survive setup', async () => {
  const fake = host('slack', { initiallyOpen: false, afterFront: CHAT_APPS.slack.bundle,
    observation: () => ({ nodes: tree(), diagnostics: { nodeCount: 9, roles: { AXGroup: 2 },
      accessibility: { AXManualAccessibility: { set: 'unsupported' }, AXEnhancedUserInterface: { set: 'enabled', restored: true } }, secret: 'Private body decoy' } }) });
  const ctx = { ownerPresent: true };
  await setupChat(ctx, 'slack', fake.options);
  assert.equal(ctx.fixtureDiagnostics[0].frontmostChanged, true);
  assert.equal(ctx.fixtureDiagnostics[0].ax.nodeCount, 9);
  assert.equal(ctx.fixtureDiagnostics[0].ax.accessibility.AXManualAccessibility.set, 'unsupported');
  assert.doesNotMatch(JSON.stringify(ctx), /Private body/);
  await cleanupChat(ctx);
});

for (const category of ['signin', 'update', 'permission', 'unrelated-modal']) {
  test(`launch ${category} dialog stops with sanitized diagnostics and owned cleanup`, async () => {
    const fake = host('discord', { initiallyOpen: false, observation: () => ({ nodes: tree(), dialogs: [category], privateTitle: 'Private dialog decoy' }) });
    const ctx = { ownerPresent: true };
    await assert.rejects(setupChat(ctx, 'discord', fake.options), e => e.code === 'CHAT_APP_DIALOG_STOP');
    assert.deepEqual(ctx.fixtureDiagnostics[0].dialogs, [category]);
    assert.doesNotMatch(JSON.stringify(ctx), /Private dialog/);
    await cleanupChat(ctx);
    assert.equal(ctx.fixtureDiagnostics[0].appQuit, true);
  });
}
test('baseline failure after launch retains cleanup ownership and a clear code', async () => {
  const fake = host('whatsapp', { initiallyOpen: false, observation: () => ({ nodes: [] }) }), ctx = { ownerPresent: true };
  await assert.rejects(setupChat(ctx, 'whatsapp', fake.options), e => e.code === 'CHAT_CONVERSATION_UNPROVED' && e.noMutation === false);
  await cleanupChat(ctx);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, true);
});
test('an open command that starts a process then fails still leaves an owned cleanup path', async () => {
  const fake = host('slack', { initiallyOpen: false, launchError: true }), ctx = { ownerPresent: true };
  await assert.rejects(setupChat(ctx, 'slack', fake.options), e => e.code === 'CHAT_LAUNCH_FAILED');
  await cleanupChat(ctx);
  assert.deepEqual(fake.calls, ['table', 'open', 'table', 'quit']);
});
test('duplicate initial processes fail closed without opening or quitting them', async () => {
  const ctx = { ownerPresent: true }, calls = [];
  await assert.rejects(setupChat(ctx, 'slack', { running: async () => true, native: async (_ctx, _kind, operation) => {
    calls.push(operation); return { processes: [{ pid: 42, launchedAt: 100 }, { pid: 43, launchedAt: 101 }], frontmost: null };
  }, open: async () => assert.fail('must not launch') }), e => e.code === 'CHAT_PROCESS_AMBIGUOUS');
  await cleanupChat(ctx);
  assert.deepEqual(calls, ['table']);
});
test('quit failure remains unconfirmed and never leaks a native error', async () => {
  const fake = host('slack', { initiallyOpen: false }), ctx = { ownerPresent: true };
  const native = fake.options.native;
  fake.options.native = async (...args) => {
    if (args[2] === 'quit') throw new Error('Private native error decoy');
    return native(...args);
  };
  await setupChat(ctx, 'slack', fake.options);
  await assert.rejects(cleanupChat(ctx), e => e.code === 'CHAT_CLEANUP_UNCONFIRMED' && e.message === e.code);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
});

test('AX baseline rejects reversed message order', () => {
  const nodes = tree(); nodes[1].children.reverse();
  assert.equal(observationFromAX(nodes), null);
});
test('AX baseline rejects nested message containers instead of reading a thread as the newest message', () => {
  const nodes = tree(); nodes[1].children[1].children.push({ role: 'AXGroup', identifier: 'message-12', children: [
    { role: 'AXStaticText', identifier: 'message-author-12', title: 'Invented Thread Author' },
  ] });
  assert.equal(observationFromAX(nodes), null);
});
test('AX restoration failure remains unconfirmed for an app the owner opened', async () => {
  const fake = host('slack', { observation: () => ({ nodes: [], failureCode: 'CHAT_AX_RESTORE_UNCONFIRMED' }) });
  const ctx = { ownerPresent: true };
  await assert.rejects(setupChat(ctx, 'slack', fake.options), e => e.code === 'CHAT_AX_RESTORE_UNCONFIRMED' && e.noMutation === false);
  await assert.rejects(cleanupChat(ctx), e => e.code === 'CHAT_AX_RESTORE_UNCONFIRMED');
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
});
test('ambiguous processes after launch remain unconfirmed and are never quit', async () => {
  const fake = host('slack', { initiallyOpen: false }), ctx = { ownerPresent: true };
  const native = fake.options.native;
  fake.options.native = async (...args) => {
    const result = await native(...args);
    if (args[2] === 'table' && result.processes.length) result.processes.push({ pid: 43, launchedAt: 101 });
    return result;
  };
  await assert.rejects(setupChat(ctx, 'slack', fake.options), e => e.code === 'CHAT_PROCESS_AMBIGUOUS');
  await assert.rejects(cleanupChat(ctx), e => e.code === 'CHAT_CLEANUP_UNCONFIRMED');
  assert.deepEqual(fake.calls, ['table', 'open', 'table']);
});
test('cleanup honors a permission stop and does not quit the owned app through final cleanup', async () => {
  const fake = host('slack', { initiallyOpen: false }), controller = new AbortController();
  const ctx = { ownerPresent: true, cleanupSignal: controller.signal };
  await setupChat(ctx, 'slack', fake.options);
  controller.abort();
  await assert.rejects(cleanupChat(ctx), e => e.code === 'CHAT_CLEANUP_UNCONFIRMED');
  await assert.rejects(ctx.windowLeases[0].quit(), e => e.code === 'CHAT_CLEANUP_UNCONFIRMED');
  assert.deepEqual(fake.calls, ['table', 'open', 'table', 'observe']);
});

test('native launch recheck preserves an app the owner opened during preparation', async () => {
  const fake = host('slack'), ctx = { ownerPresent: true }, calls = [];
  const native = async (...args) => {
    calls.push(args[2]);
    if (args[2] === 'table') return { processes: [], frontmost: 'com.example.owner' };
    if (args[2] === 'launch') return { launched: false, processes: [{ pid: 42, launchedAt: 100 }], frontmost: 'com.example.owner' };
    return fake.options.native(...args);
  };
  await setupChat(ctx, 'slack', { running: async () => false,
    open: async () => assert.fail('use the native launch receipt'), native, launch: () => native(ctx, 'slack', 'launch') });
  assert.equal(ctx.fixtureDiagnostics[0].launched, false);
  assert.equal(ctx.fixtureDiagnostics[0].actionTaken, false);
  await cleanupChat(ctx); await ctx.windowLeases[0].quit();
  assert.deepEqual(calls, ['table', 'launch', 'observe']);
});

test('an observer lost before its restoration receipt leaves the owner app unconfirmed', async () => {
  const fake = host('slack'), ctx = { ownerPresent: true }, native = fake.options.native;
  fake.options.native = async (...args) => {
    if (args[2] === 'observe') throw Object.assign(new Error('Private observer decoy'), { code: 'CHAT_NATIVE_TIMEOUT' });
    return native(...args);
  };
  await assert.rejects(setupChat(ctx, 'slack', fake.options), e => e.code === 'CHAT_NATIVE_TIMEOUT' && e.noMutation === false);
  await assert.rejects(cleanupChat(ctx), e => e.code === 'CHAT_AX_RESTORE_UNCONFIRMED');
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
  assert.deepEqual(fake.calls, ['table']);
});
