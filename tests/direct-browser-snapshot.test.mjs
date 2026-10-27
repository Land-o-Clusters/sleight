import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultReadBaseline, sha256 } from './fixtures/default-read-baseline.mjs';
import { EventEmitter } from 'node:events';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';
import { withMT } from './fixtures/mt-env.mjs';

const rawModule = await import('../plugins/sleight/lib/direct-browser/snapshot.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

const module = { ...rawModule, snapshot: (page, options) => rawModule.snapshot(page, { completeness: true, ...options }) };

function nativeSnapshot(secrets) {
  const strings = ['#document', 'INPUT', '', 'type', 'password', 'http://127.0.0.1/fixture', 'UTF-8', 'frame'];
  const values = secrets.map(value => { strings.push(value); return strings.length - 1; });
  return { strings, documents: [{ documentURL: 5, title: 2, baseURL: 5, contentLanguage: 2, encodingName: 6,
    publicId: 2, systemId: 2, frameId: 7, scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { parentIndex: [-1, ...values.map(() => 0)], nodeType: [9, ...values.map(() => 1)],
      nodeName: [0, ...values.map(() => 1)], nodeValue: [2, ...values.map(() => 2)],
      backendNodeId: [1, ...values.map((_, i) => i + 2)], attributes: [[], ...values.map(() => [3, 4])],
      inputValue: { index: values.map((_, i) => i + 1), value: values } },
    layout: { nodeIndex: [], styles: [], bounds: [], text: [], stackingContexts: { index: [] } },
    textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] } }] };
}

// A CDP-shaped capture of the same pierced DOM fixture, including closed-root
// markers and native attributes. Production must decide from this capture.
function capturedDOM(root, secrets = []) {
  const capture = nativeSnapshot(secrets), { strings } = capture;
  const indices = new Map(strings.map((value, index) => [value, index]));
  const intern = value => {
    if (!indices.has(value)) { indices.set(value, strings.length); strings.push(value); }
    return indices.get(value);
  };
  const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], backendNodeId: [], attributes: [],
    shadowRootType: { index: [], value: [] } };
  const visit = (node, parentIndex = -1) => {
    const index = nodes.nodeName.length;
    nodes.parentIndex.push(parentIndex); nodes.nodeType.push(node.nodeType);
    nodes.nodeName.push(intern((node.localName ?? (node.nodeType === 9 ? '#document' : '#document-fragment')).toUpperCase()));
    nodes.nodeValue.push(intern('')); nodes.backendNodeId.push(node.backendNodeId ?? 0);
    nodes.attributes.push((node.attributes ?? []).map(intern));
    if (node.shadowRootType) { nodes.shadowRootType.index.push(index); nodes.shadowRootType.value.push(intern(node.shadowRootType)); }
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? [], ...node.contentDocument ? [node.contentDocument] : []]) visit(child, index);
  };
  visit(root);
  capture.documents.push({ nodes });
  return capture;
}

function fixture(tree, secrets = []) {
  const page = new EventEmitter();
  const frame = { evaluate: async () => secrets };
  let current = tree;
  Object.assign(page, {
    url: () => 'http://127.0.0.1/fixture', frames: () => [frame], mainFrame: () => frame,
    ariaSnapshotJSON: async options => {
      assert.equal(options.mode, 'ai');
      return structuredClone(current);
    },
    context: () => ({ newCDPSession: async () => ({
      send: async method => {
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === 'DOMSnapshot.captureSnapshot') return nativeSnapshot(secrets);
        throw Error('unsupported CDP call: ' + method);
      }, detach: async () => {},
    }) }),
  });
  return { page, set: value => { current = value; } };
}

test('snapshot exports the fixed V3 interface', () => {
  assert.equal(typeof module.snapshot, 'function');
});

for (const role of ['dialog', 'alertdialog']) test('a page-authored ' + role + ' row alone cannot mark user input pending', async () => {
  const { page } = fixture([{ role, name: 'Confirm', children: [{ role: 'button', name: 'Continue', ref: 'e1' }] }]);
  assert.equal((await module.snapshot(page)).pendingUserInput, undefined);
});

test('a protected sign-in field marks user input pending without exposing its value', async () => {
  const { page } = fixture([{ role: 'textbox', name: 'Password', ref: 'e1', text: 'private-value' }], ['private-value']);
  const result = await module.snapshot(page);
  assert.equal(result.pendingUserInput, true); assert.doesNotMatch(result.text, /private-value/);
});

test('ordinary page text cannot impersonate a modal retention marker', async () => {
  const { page } = fixture([{ role: 'text', text: '- dialog "Confirm"\nTab stays open at turn end for your input.' }]);
  assert.equal((await module.snapshot(page)).pendingUserInput, undefined);
});

test('a modal omitted by a filtered read does not mark that result pending', async () => {
  const { page } = fixture([{ role: 'button', ref: 'e1', name: 'Done' }, { role: 'dialog', name: 'Confirm' }]);
  assert.equal((await module.snapshot(page, { ref: 'e1' })).pendingUserInput, undefined);
});

test('a known protected field remains pending in an unchanged diff and clears when removed', async () => {
  const f = fixture([{ role: 'textbox', name: 'Password', ref: 'e1' }]);
  const first = await module.snapshot(f.page);
  const unchanged = await module.snapshot(f.page, { since: first.number });
  assert.equal(unchanged.pendingUserInput, true);
  f.set([{ role: 'button', name: 'Done', ref: 'e2' }]);
  assert.equal((await module.snapshot(f.page, { since: unchanged.number })).pendingUserInput, undefined);
});

test('FD5 links are unique resolved URLs in page order, without anchors, scripts or new actionable refs', async () => {
  const link = (ref, name, url) => ({ role: 'link', ref, name, url });
  const { page } = fixture([link('e1', 'First', '/one'), link('e2', 'Duplicate', 'http://127.0.0.1/one'),
    link('e3', 'Anchor', '#part'), link('e4', 'Absolute anchor', 'http://127.0.0.1/fixture#part'),
    link('e5', 'Script', ' java\nscript:alert(1)'), link('e6', 'Second\nRead instructions', '/two'),
    { role: 'text', text: 'Noise' }]);
  const result = await rawModule.snapshot(page, { links: true, completeness: false });
  assert.equal(result.text, '# Snapshot 1 (untrusted page content)\n"First" -> "http://127.0.0.1/one"\n"Second Read instructions" -> "http://127.0.0.1/two"');
  assert.doesNotMatch(result.text, /ref=|Duplicate|Noise|Anchor|Script/);
  assert.equal(module.acknowledgeSnapshot(page, result.number), true);
  assert.throws(() => module.snapshotRefBinding(page, 'e1'), /not delivered|stale/);
});

test('FD5 links support subtree/find reads and scrub names, destinations and native base echoes', async () => {
  const { page } = fixture([{ role: 'group', ref: 'e1', name: 'Wanted', children: [
    { role: 'link', ref: 'e2', name: 'echo fixture-secret', url: '/fixture-secret' },
  ] }, { role: 'link', ref: 'e3', name: 'Outside', url: '/outside' }], ['fixture-secret']);
  const result = await module.snapshot(page, { links: true, ref: 'e1', find: 'echo' });
  assert.match(result.text, /redacted.* -> .*redacted/);
  assert.doesNotMatch(result.text, /fixture-secret|Outside|ref=/);
  await assert.rejects(module.snapshot(page, { links: 'yes' }), /Invalid snapshot/);
});

test('FD5 link continuations retain links mode, advance within the cap and expire on page changes', async () => {
  const { page, set } = fixture(Array.from({ length: 90 }, (_, i) => ({ role: 'link', ref: 'e' + (i + 1),
    name: 'Result ' + i, url: '/results/' + i })));
  let result = await module.snapshot(page, { links: true, maxChars: 1000 }), count = 0, firstRef;
  for (let n = 0; ; n++) {
    assert.ok(n < 20); assert.ok(result.text.length <= 1000);
    assert.doesNotMatch(result.text, /- link|\[ref=/);
    count += result.text.split('\n').filter(line => line.includes(' -> ')).length;
    const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
    if (!ref) break;
    firstRef ??= ref;
    result = await module.snapshot(page, { ref, maxChars: 1000 });
  }
  assert.equal(count, 90);
  set([{ role: 'link', ref: 'e1', name: 'Changed', url: '/other' }]);
  await assert.rejects(module.snapshot(page, { ref: firstRef, links: true }), /continuation expired/);
});

test('FD5 empty links and links diffs stay separate from full snapshots', async () => {
  const { page, set } = fixture([{ role: 'button', ref: 'e1', name: 'Button' }]);
  assert.match((await module.snapshot(page, { links: true })).text, /No matching content/);
  set([{ role: 'link', ref: 'e2', name: 'First', url: '/one' }]);
  const first = await module.snapshot(page, { links: true });
  assert.match((await module.snapshot(page, { links: true, since: first.number })).text, /No visible changes/);
  assert.doesNotMatch((await module.snapshot(page, { since: first.number })).text, /Changes since|No visible changes/);
});

test('every read ends in completeness, including filtered, empty and shortened final rows', async () => {
  const { page, set } = fixture([{ role: 'button', name: 'Next', ref: 'e1' }]);
  assert.match((await module.snapshot(page)).text, /# complete \(returned view\)$/);
  assert.match((await module.snapshot(page, { find: 'absent' })).text, /# complete \(filtered view\)$/);
  set([{ role: 'text', text: 'x'.repeat(60000) }]);
  const shortened = await module.snapshot(page, { maxChars: 1000 });
  assert.match(shortened.text, /# cut at 1000 chars/);
  assert.doesNotMatch(shortened.text, /# complete/);
});

test('a shortened row stays incomplete across continuations and can be recovered with a larger cap', async () => {
  const long = 'recoverable '.repeat(700);
  const { page } = fixture([{ role: 'text', text: long }, { role: 'button', name: 'End', ref: 'e1' }]);
  const first = await module.snapshot(page, { maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)[1];
  const end = await module.snapshot(page, { ref, maxChars: 1000 });
  assert.match(end.text, /"End"/);
  assert.doesNotMatch(end.text, /# complete/);
  const retry = /Continue with ref="([^"]+)"/.exec(end.text)[1];
  const recovered = await module.snapshot(page, { ref: retry, maxChars: 40000 });
  assert.ok(recovered.text.includes(long));
  assert.match(recovered.text, /# complete \(filtered view\)$/);
});

test('delta reads, find continuations and subtree continuations keep their scope', async () => {
  const { page, set } = fixture([{ role: 'button', name: 'Before', ref: 'e1' }]);
  const first = await module.snapshot(page);
  set([{ role: 'button', name: 'After', ref: 'e1' }]);
  const delta = await module.snapshot(page, { since: first.number });
  assert.match(delta.text, /# Changes since snapshot 1/);
  assert.match(delta.text, /# complete \(changes only\)$/);
  const unchanged = await module.snapshot(page, { since: delta.number });
  assert.match(unchanged.text, /# complete \(changes only\)$/);
  set([{ role: 'main', ref: 'e1', children: Array.from({ length: 80 }, (_, i) =>
    ({ role: 'button', ref: 'e' + (i + 2), name: 'Choice ' + i })) }]);
  for (const options of [{ find: 'Choice' }, { ref: 'e1' }, {}]) {
    let result = await module.snapshot(page, { ...options, maxChars: 1000 }), chunks = 0;
    for (;;) {
      assert.ok(result.text.length <= 1000);
      const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
      if (!ref) break;
      assert.ok(chunks++ < 20);
      result = await module.snapshot(page, { ref, maxChars: 1000 });
    }
    assert.ok(chunks > 0);
    assert.match(result.text, /# complete \(filtered view\)$/);
  }
});

test('snapshot renders compact untrusted YAML with usable iframe refs', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: [
    { role: 'button', name: 'Next', ref: 'e2', disabled: true },
    { role: 'iframe', ref: 'e3', children: [{ role: 'textbox', name: 'City', ref: 'f2e1', text: 'Portland' }] },
  ] }]);
  const result = await module.snapshot(page);
  assert.equal(result.number, 1);
  assert.match(result.text, /untrusted/i);
  assert.match(result.text, /- main \[ref=e1\]:\n  - button "Next" \[disabled\] \[ref=e2\]/);
  assert.match(result.text, /textbox "City" \[ref=f2e1\]: "Portland"/);
  assert.ok(result.text.length < 400);
});

test('password and card values are removed from all output and subsequent diffs', async () => {
  const { page, set } = fixture([{ role: 'textbox', name: 'Password', ref: 'e1', text: 'fixture-secret' },
    { role: 'textbox', name: 'Account', ref: 'f2e2', text: '4111 1111 1111 1111' },
    { role: 'text', text: 'echo fixture-secret' }], ['fixture-secret', '4111 1111 1111 1111']);
  const first = await module.snapshot(page);
  assert.doesNotMatch(first.text, /fixture-secret|4111/);
  assert.match(first.text, /redacted/);
  set([{ role: 'textbox', name: 'Password', ref: 'e1', text: 'new-secret' }]);
  const next = await module.snapshot(page, { since: first.number });
  assert.doesNotMatch(next.text, /fixture-secret|new-secret|4111/);
});

test('a failed sensitive-value read refuses without exposing the upstream error', async () => {
  const { page } = fixture([{ role: 'text', text: 'fixture-secret' }]);
  page.frames = () => [{ evaluate: async () => { throw Error('fixture-secret'); } }];
  page.context = () => ({ newCDPSession: async () => ({ send: async () => { throw Error('fixture-secret'); }, detach: async () => {} }) });
  await assert.rejects(module.snapshot(page), error => !error.message.includes('fixture-secret'));
});

test('snapshot options reject malformed or unbounded requests', async () => {
  const { page } = fixture([]);
  for (const options of [{ maxChars: 999 }, { maxChars: 40001 }, { maxChars: NaN }, { find: [] }, { since: 0 }, { ref: 'css=body' }]) {
    await assert.rejects(module.snapshot(page, options), /Invalid snapshot/);
  }
});

test('ref-keyed diffs keep sibling reorders and changed parents visible', async () => {
  const a = { role: 'button', name: 'A', ref: 'e2' }, b = { role: 'button', name: 'B', ref: 'e3' };
  const { page, set } = fixture([{ role: 'main', ref: 'e1', children: [a, b] }]);
  const first = await module.snapshot(page);
  set([{ role: 'main', ref: 'e1', children: [b, { ...a, name: 'A changed' }] }]);
  const diff = await module.snapshot(page, { since: first.number });
  assert.match(diff.text, /Changes since snapshot 1/);
  assert.match(diff.text, /\+ .*button "B".*ref=e3/);
  assert.match(diff.text, /\+ .*button "A changed".*ref=e2/);
  assert.ok(diff.text.indexOf('"B"') < diff.text.indexOf('"A changed"'));
  set([{ role: 'group', ref: 'e4', children: [a] }]);
  const moved = await module.snapshot(page, { since: diff.number });
  assert.match(moved.text, /group \[ref=e4\]/);
  assert.match(moved.text, /Removed.*ref=e3/s);
});

test('unchanged diffs and page histories are isolated by page', async () => {
  const { page } = fixture([{ role: 'button', ref: 'e1', name: 'Keep' }]);
  const first = await module.snapshot(page);
  assert.match((await module.snapshot(page, { since: first.number })).text, /No visible changes/);
  const other = fixture([{ role: 'button', ref: 'e2', name: 'Other' }]).page;
  assert.match((await module.snapshot(other, { since: first.number })).text, /"Other"/);
});

test('find and ref reads include matching controls and their ancestors only', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: [
    { role: 'group', name: 'Travel', ref: 'e2', children: [{ role: 'button', name: 'Norcrest', ref: 'e3' }] },
    { role: 'button', name: 'Elsewhere', ref: 'e4' },
  ] }]);
  const found = await module.snapshot(page, { find: 'norcrest' });
  assert.match(found.text, /main.*Travel.*Norcrest/s);
  assert.doesNotMatch(found.text, /Elsewhere/);
  const scoped = await module.snapshot(page, { ref: 'e2' });
  assert.match(scoped.text, /Travel.*Norcrest/s);
  assert.doesNotMatch(scoped.text, /Elsewhere/);
  await assert.rejects(module.snapshot(page, { ref: 'e999' }), /Snapshot unavailable/);
  assert.match((await module.snapshot(page, { find: 'missing' })).text, /No matching/);
  // An alternation finds rows matching any term, as the model writes it; one without a match still says so.
  const either = await module.snapshot(page, { find: 'missing | NORCREST' });
  assert.match(either.text, /Norcrest/); assert.doesNotMatch(either.text, /Elsewhere/);
  assert.match((await module.snapshot(page, { find: 'Elsewhere|norcrest' })).text, /Norcrest[\s\S]*Elsewhere/);
  assert.match((await module.snapshot(page, { find: 'missing|absent' })).text, /No matching/);
});

test('find inside a ref reads the matching rows of that subtree, and a missing ref says it is gone', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: [
    { role: 'group', name: 'Teams', ref: 'e2', children: [{ role: 'link', name: 'MAO Ops', ref: 'e3' }, { role: 'link', name: 'Other', ref: 'e4' }] },
    { role: 'link', name: 'MAO outside', ref: 'e5' },
  ] }]);
  const both = await module.snapshot(page, { ref: 'e2', find: 'MAO' });
  assert.match(both.text, /Teams.*MAO Ops/s); assert.doesNotMatch(both.text, /Other|outside/);
  await assert.rejects(module.snapshot(page, { ref: 'e186', find: 'MAO' }), /^Error: Snapshot unavailable: ref e186 is not on the page now; read again without ref/);
  page.ariaSnapshotJSON = async () => { throw Error('timeout'); };
  await assert.rejects(module.snapshot(page), /^Error: Snapshot unavailable; try browser_read again$/);
});

test('a cut names a continuation ref that advances with ancestors and bounded output', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: Array.from({ length: 70 }, (_, i) =>
    ({ role: 'button', ref: 'e' + (i + 2), name: 'Choice ' + i + ' x'.repeat(12) })) }]);
  let result = await module.snapshot(page, { maxChars: 1000 });
  const seen = new Set();
  for (let n = 0; ; n++) {
    assert.ok(n < 20, 'continuations must make progress');
    assert.ok(result.text.length <= 1000);
    assert.match(result.text, /main \[ref=e1\]/);
    for (const [, ref] of result.text.matchAll(/\[ref=(e\d+)\]/g)) seen.add(ref);
    const next = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
    if (!next) break;
    result = await module.snapshot(page, { ref: next, maxChars: 1000 });
  }
  assert.equal(seen.size, 71);
});

test('a cut baseline does not claim unseen rows unchanged in the next diff', async () => {
  const { page } = fixture(Array.from({ length: 60 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const diff = await module.snapshot(page, { since: first.number, maxChars: 40000 });
  assert.match(diff.text, /\+ - button "Option 59" \[ref=e60\]/);
});

test('navigation retires prior continuations and rejects mixed-document reads', async () => {
  const { page } = fixture(Array.from({ length: 100 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  assert.ok(ref);
  page.emit('framenavigated', page.mainFrame());
  await assert.rejects(module.snapshot(page, { ref }), /Snapshot unavailable/);
  page.ariaSnapshotJSON = async () => { page.emit('framenavigated', page.mainFrame()); return []; };
  await assert.rejects(module.snapshot(page), /Snapshot unavailable/);
});

test('a changed page invalidates a continuation instead of mixing old and new rows', async () => {
  const { page, set } = fixture(Array.from({ length: 60 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  set([{ role: 'button', ref: 'e1', name: 'Changed' }]);
  await assert.rejects(module.snapshot(page, { ref }), /Snapshot unavailable/);
});

test('long values cannot trap a continuation on a single oversized row', async () => {
  const { page } = fixture([{ role: 'text', text: 'long '.repeat(3000) }, { role: 'button', ref: 'e1', name: 'End' }]);
  const first = await module.snapshot(page, { maxChars: 1000 });
  assert.ok(first.text.length <= 1000);
  assert.match(first.text, /shortened/);
  const shortened = first.text.split('\n').find(line => line.includes('shortened'));
  assert.doesNotThrow(() => JSON.parse(shortened.slice(shortened.indexOf(':') + 1).trim()), 'a shortened YAML scalar must remain quoted');
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  assert.ok(ref);
  assert.match((await module.snapshot(page, { ref, maxChars: 1000 })).text, /"End"/);
});

function closedFixture({ emptyHostQuery = false, checkbox = false } = {}) {
  const base = fixture([{ role: 'main', ref: 'e1' }]);
  let nodes = [{ nodeId: 'switch', backendDOMNodeId: 30, role: { value: 'switch' }, name: { value: 'Secure mode' },
    properties: [{ name: 'checked', value: { value: true } }] },
  { nodeId: 'password', backendDOMNodeId: 31, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'closed-secret' } },
  ...checkbox ? [{ nodeId: 'box', backendDOMNodeId: 32, role: { value: 'checkbox' }, name: { value: 'Newsletter' } }] : []];
  const root = { nodeType: 9, children: [{ nodeType: 1, backendNodeId: 20, localName: 'custom-control', shadowRoots: [
    { nodeType: 11, shadowRootType: 'closed', children: [
      { nodeType: 1, localName: 'button', backendNodeId: 30 },
      { nodeType: 1, localName: 'input', backendNodeId: 31, attributes: ['type', 'password'] },
      ...checkbox ? [{ nodeType: 1, localName: 'input', backendNodeId: 32, attributes: ['type', 'checkbox'] }] : [],
    ] },
  ] }] };
  base.page.context = () => ({ newCDPSession: async () => ({
    send: async (method, params) => {
      if (method === 'DOM.getDocument') return { root };
      if (method === 'DOMSnapshot.captureSnapshot') {
        const capture = capturedDOM(root, ['closed-secret']);
        if (checkbox) {
          // Chromium reports a checkbox's value attribute ("on" by default) as its input value too.
          const { nodes } = capture.documents.at(-1), at = nodes.backendNodeId.indexOf(32);
          capture.strings.push('on'); nodes.inputValue = { index: [at], value: [capture.strings.length - 1] };
        }
        return capture;
      }
      if (method === 'Accessibility.queryAXTree') return { nodes: emptyHostQuery ? [] : structuredClone(nodes) };
      if (method === 'Accessibility.getPartialAXTree') return { nodes: structuredClone(nodes.filter(node => node.backendDOMNodeId === params.backendNodeId)) };
      if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'closed-secret' } };
      if (method === 'Runtime.releaseObject') return {};
      throw Error('unsupported CDP call: ' + method);
    }, detach: async () => {},
  }) });
  return { ...base, setClosed: value => { nodes = value; } };
}

test('closed-root controls get stable refs, flags and redacted values', async () => {
  const { page } = closedFixture();
  assert.match((await module.snapshot(page)).text, /closed shadow roots: controls only/);
  const first = await module.snapshot(page);
  assert.match(first.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(first.text, /closed-secret/);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(first.text)[1];
  const binding = module.closedRefBinding(page, ref);
  assert.equal(binding.backendNodeId, 30);
  assert.equal(binding.frame, page.mainFrame());
  const second = await module.snapshot(page);
  assert.match(second.text, new RegExp('switch.*ref=' + ref));
  assert.match((await module.snapshot(page, { ref })).text, /Secure mode/);
});

test('the closed-root scope survives size cuts and roots containing no controls', async () => {
  const { page } = closedFixture();
  page.ariaSnapshotJSON = async () => [{ role: 'text', text: 'long '.repeat(10000) }];
  const cut = await module.snapshot(page, { maxChars: 40000 });
  assert.ok(cut.text.length <= 40000);
  assert.match(cut.text, /closed shadow roots: controls only/);
  assert.doesNotMatch(cut.text, /# complete/);
  const ref = /Continue with ref="([^"]+)"/.exec(cut.text)[1];
  const end = await module.snapshot(page, { ref, maxChars: 40000 });
  assert.match(end.text, /closed shadow roots: controls only/);
  assert.doesNotMatch(end.text, /# complete/);
  const empty = nativeClosedFixture({ nodeType: 9, children: [element(100, { shadowRoots: [closedRoot([element(101)])] })] }, []);
  assert.match((await module.snapshot(empty.page)).text, /closed shadow roots: controls only/);
});

test('a closed-root checkbox value is a label, not a secret that blanks the same letters elsewhere', async () => {
  const { page, set } = closedFixture({ checkbox: true });
  set([{ nodeId: 'box', backendDOMNodeId: 32, role: { value: 'checkbox' }, name: { value: 'Newsletter' } }]);
  const tree = [{ role: 'heading', ref: 'e2', name: 'Notification controls', text: 'Notification controls on sale' }];
  page.ariaSnapshotJSON = async () => structuredClone(tree);
  const result = await module.snapshot(page);
  assert.match(result.text, /Notification controls on sale/);
  assert.match(result.text, /checkbox "Newsletter" \[ref=s\d+\]/);
});

test('a short secret in a closed-root field blanks only that field, not the same letters elsewhere', async () => {
  const { page } = closedFixture();
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = async (method, params) => {
      const result = await send(method, params);
      if (method !== 'DOMSnapshot.captureSnapshot') return result;
      result.strings.push('o'); result.documents.at(-1).nodes.inputValue = { index: [result.documents.at(-1).nodes.backendNodeId.indexOf(31)], value: [result.strings.length - 1] };
      return result;
    };
    return session;
  } });
  page.ariaSnapshotJSON = async () => [{ role: 'heading', ref: 'e2', name: 'Account controls', text: 'Account controls: more options, old notes' }];
  const result = await module.snapshot(page);
  assert.match(result.text, /Account controls: more options, old notes/);
  assert.match(result.text, /textbox "Password" \[ref=s\d+\]: "\[redacted\]"/);
});

test('a long secret echoed in a label is removed while a short one leaves the label alone', async () => {
  const long = fixture([{ role: 'heading', name: 'Code sent: 482913', text: 'Enter 482913' }], ['482913']);
  const longText = (await module.snapshot(long.page)).text;
  assert.doesNotMatch(longText, /482913/);
  const short = fixture([{ role: 'heading', name: 'Code 913 sent', text: 'Enter 913' }], ['913']);
  assert.match((await module.snapshot(short.page)).text, /Code 913 sent.*Enter 913/);
});

test('a number field in a sensitive field keeps its own value hidden when the secret is short', async () => {
  const { page } = fixture([{ role: 'spinbutton', name: 'CVV', ref: 'e1', text: '123' }, { role: 'spinbutton', name: 'Quantity', ref: 'e2', text: '123' }], ['123']);
  const text = (await module.snapshot(page)).text;
  assert.match(text, /spinbutton "CVV" \[ref=e1\]: "\[redacted\]"/);
  assert.match(text, /spinbutton "Quantity".*: "123"/);
});

test('an ignored closed-root host cannot hide its native actionable descendants', async () => {
  const { page } = closedFixture({ emptyHostQuery: true });
  const result = await module.snapshot(page);
  assert.match(result.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(result.text, /closed-secret/);
});

test('closed refs disappear on node removal and are never reused after navigation', async () => {
  const { page, setClosed } = closedFixture();
  const first = await module.snapshot(page);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(first.text)?.[1];
  assert.ok(ref);
  setClosed([]);
  await module.snapshot(page);
  assert.throws(() => module.closedRefBinding(page, ref), /stale/i);
  page.emit('framenavigated', page.mainFrame());
  assert.throws(() => module.closedRefBinding(page, ref), /stale/i);
});

test('failure to scan closed roots fails closed and detaches its owned CDP session', async () => {
  const { page } = fixture([]);
  let detached = false;
  page.context = () => ({ newCDPSession: async () => ({
    send: async () => { throw Error('closed-secret'); }, detach: async () => { detached = true; },
  }) });
  await assert.rejects(module.snapshot(page), error => !error.message.includes('closed-secret'));
  assert.equal(detached, true);
});

test('same-process child frames use the parent CDP tree for closed controls', async () => {
  const { page } = closedFixture();
  const child = { evaluate: async () => [] };
  const context = page.context();
  page.frames = () => [page.mainFrame(), child];
  page.context = () => ({ newCDPSession: frame => {
    if (frame === child) throw Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
    return context.newCDPSession(frame);
  } });
  const result = await module.snapshot(page);
  assert.match(result.text, /Secure mode/);
});

test('redaction also covers a protected value that changed immediately after the snapshot', async () => {
  const { page } = fixture([{ role: 'textbox', name: 'Account', ref: 'e1', text: 'old-secret' }]);
  let value = 'old-secret';
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => method === 'DOMSnapshot.captureSnapshot' ? nativeSnapshot([value]) : send(method, params);
    return session;
  } });
  page.frames = () => [{ evaluate: async () => [value] }];
  page.ariaSnapshotJSON = async () => { value = 'new-secret'; return [{ role: 'textbox', name: 'Account', ref: 'e1', text: 'old-secret' }]; };
  assert.doesNotMatch((await module.snapshot(page)).text, /old-secret|new-secret/);
});

test('page-overridden getters cannot hide the native protected value from redaction', async () => {
  const { page } = fixture([{ role: 'text', text: 'echo native-password' }], ['native-password']);
  page.mainFrame().evaluate = async () => ['page-decoy'];
  assert.doesNotMatch((await module.snapshot(page)).text, /native-password/);
});

test('card expiry values are masked even without autocomplete or a password type', async () => {
  const { page } = fixture([{ role: 'textbox', name: 'Expiry', ref: 'e1', text: '08/30' },
    { role: 'text', text: 'echo 08/30' }]);
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => {
      if (method !== 'DOMSnapshot.captureSnapshot') return send(method, params);
      const data = nativeSnapshot(['08/30']);
      data.strings[4] = 'text'; data.strings.push('name', 'expiry');
      data.documents[0].nodes.attributes[1].push(9, 10);
      return data;
    };
    return session;
  } });
  assert.doesNotMatch((await module.snapshot(page)).text, /08\/30/);
});

test('deep continuation context always leaves space to advance to the next row', async () => {
  let tree = [{ role: 'button', name: 'Target', ref: 'e99' }];
  for (let n = 50; n >= 1; n--) tree = [{ role: 'group', ref: 'e' + n, name: 'Ancestor ' + n, children: tree }];
  const { page } = fixture(tree);
  let result = await module.snapshot(page, { maxChars: 1000 });
  for (let n = 0; !result.text.includes('"Target"'); n++) {
    assert.ok(n < 60, 'deep continuations must advance');
    assert.ok(result.text.length <= 1000);
    const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
    assert.ok(ref);
    result = await module.snapshot(page, { ref, maxChars: 1000 });
  }
});

test('V3R: an oversized child advances past retained ancestor context', async () => {
  const {page}=fixture([{role:'main',ref:'e1',children:[{role:'paragraph',ref:'e2',text:'x'.repeat(1000)},{role:'button',ref:'e3',name:'End'}]}]);
  let result=await module.snapshot(page,{maxChars:1000});
  for(let n=0; !result.text.includes('"End"');n++) {
    assert.ok(n<5,'ancestor rows must not stall continuation');
    const ref=/Continue with ref="([^"]+)"/.exec(result.text)?.[1]; assert.ok(ref);
    result=await module.snapshot(page,{ref,maxChars:1000});
  }
});

for (const raw of [' alpha  beta ', ' alpha\u200B  be\u00ADta ', '\talpha\n\nbeta\t'])
  test('V3R: normalized native password never reaches a snapshot', async () => {
    const {page}=fixture([{role:'textbox',name:'PIN',ref:'e1',text:'alpha beta'},{role:'text',text:'echo alpha beta'}],[raw]);
    const result=await module.snapshot(page); assert.doesNotMatch(result.text,/alpha beta/); assert.match(result.text,/redacted/);
  });

test('V3R: native password type masks a neutral named textbox even with blank or overridden text', async () => {
  const {page}=fixture([{role:'textbox',name:'PIN',ref:'e1',text:'page-decoy'}],['']);
  const context=page.context();
  page.context=()=>({newCDPSession:async frame=>{const session=await context.newCDPSession(frame),send=session.send;
    session.send=(method,params)=> {if(method!=='DOMSnapshot.captureSnapshot')return send(method,params);
      const data=nativeSnapshot(['']);data.strings.push('aria-label','PIN');data.documents[0].nodes.attributes[1].push(9,10);return data;};return session;}});
  const result=await module.snapshot(page);assert.doesNotMatch(result.text,/page-decoy/);assert.match(result.text,/redacted/);
});

test('V3R: overlapping native secrets redact longest first and deduplicate', async () => {
  const {page}=fixture([{role:'text',text:'hunter2xyz and hunter2'}],['hunter2','hunter2xyz','hunter2']);
  const result=await module.snapshot(page);assert.doesNotMatch(result.text,/xyz|hunter2/);
});

for(const name of ['Discard changes?','Scorecard','Postcard']) test('V3R: a nonscalar sensitive-looking name keeps its subtree: '+name,async()=>{
  const {page}=fixture([{role:'dialog',name,ref:'e1',children:[{role:'button',name:'Keep editing',ref:'e2'},{role:'button',name:'Discard',ref:'e3'}]}]);
  const result=await module.snapshot(page);assert.match(result.text,/Keep editing/);assert.match(result.text,/Discard/);
});

test('V3R: navigation cannot retarget a delivered ref, even after the next snapshot',async()=>{
  assert.equal(typeof module.snapshotRefBinding,'function');assert.equal(typeof module.acknowledgeSnapshot,'function');
  const {page,set}=fixture([{role:'button',ref:'e2',name:'Buy'}]);page.locator=selector=>({selector});
  const first=await module.snapshot(page);
  assert.equal(typeof page.getByRef,'function','the snapshot installs the action-path resolver');
  assert.throws(()=>page.getByRef('e2'),/delivered|read/i);
  module.acknowledgeSnapshot(page,first.number);
  assert.equal(module.snapshotRefBinding(page,'e2').selector,'aria-ref=e2');
  page.emit('framenavigated',page.mainFrame());set([{role:'button',ref:'e2',name:'Delete account'}]);
  assert.throws(()=>module.snapshotRefBinding(page,'e2'),/snapshot|read/i);
  assert.throws(()=>page.getByRef('e2'),/snapshot|read/i);
  const second=await module.snapshot(page);const ref=/\[ref=([^\]]+)\]/.exec(second.text)[1];assert.notEqual(ref,'e2');
  assert.throws(()=>module.snapshotRefBinding(page,ref),/delivered|snapshot|read/i);
  assert.equal(module.acknowledgeSnapshot(page,first.number),false);
  assert.equal(module.acknowledgeSnapshot(page,second.number),true);
  assert.equal(module.snapshotRefBinding(page,ref).selector,'aria-ref=e2');
  assert.throws(()=>module.snapshotRefBinding(page,'e2'),/snapshot|read/i);
});

test('CR1 keeps the clean-room declaration without an adaptation claim', async () => {
  const { readFileSync } = await import('node:fs');
  const notice = readFileSync(new URL('../plugins/sleight/THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  const section = notice.split('## Turbo v3 background popups and closed roots')[1];
  assert.match(section, /No FowlBrowser code is included/);
  assert.doesNotMatch(section, /adapted from|Copyright/);
});

function nativeClosedFixture(root, axNodes) {
  const f = fixture([]), calls = [];
  const frame = f.page.mainFrame();
  f.page.context = () => ({ newCDPSession: async () => ({
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'DOMSnapshot.captureSnapshot') return capturedDOM(root);
      if (method === 'DOM.getDocument') return { root };
      if (method === 'Accessibility.getPartialAXTree') {
        assert.equal(params.fetchRelatives, false);
        return { nodes: structuredClone(axNodes.filter(node => node.backendDOMNodeId === params.backendNodeId)) };
      }
      throw Error('unsupported CDP call: ' + method);
    }, detach: async () => calls.push(['detach']),
  }) });
  return { ...f, calls, frame };
}
const closedRoot = children => ({ nodeType: 11, shadowRootType: 'closed', children });
const element = (backendNodeId, extra = {}) => ({ nodeType: 1, localName: 'button', backendNodeId, ...extra });
const axControl = (backendDOMNodeId, role, name, extra = {}) => ({ backendDOMNodeId, role: { value: role }, name: { value: name }, ...extra });

test('CR2 WAI-ARIA 1.2 widget roles and Chromium native input mappings expose operable closed controls', async () => {
  // w3.org/TR/wai-aria-1.2/#widget_roles; Chromium AXNodeObject::NativeRoleIgnoringAria.
  const roles = ['button', 'checkbox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'radio', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
    'combobox', 'grid', 'listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid',
    'ColorWell', 'Date', 'DateTime', 'InputTime', 'DisclosureTriangle', 'DisclosureTriangleGrouped'];
  const excluded = ['progressbar', 'tabpanel', 'group', 'generic', 'paragraph', 'separator'];
  const all = [...roles, ...excluded];
  const nodes = all.map((role, i) => axControl(i + 1, role, 'Control ' + i,
    role === 'separator' && i < roles.length ? { properties: [{ name: 'focusable', value: { value: true } }] } : {}));
  const root = { nodeType: 9, children: [element(100, { shadowRoots: [closedRoot(all.map((_, i) => element(i + 1)))] })] };
  const { page } = nativeClosedFixture(root, nodes);
  const result = await module.snapshot(page, { maxChars: 40000 });
  for (let i = 0; i < roles.length; i++) assert.ok(result.text.includes('"Control ' + i + '"'), roles[i]);
  for (let i = roles.length; i < all.length; i++) assert.ok(!result.text.includes('"Control ' + i + '"'), all[i]);
});

test('CR1 probes nested closed controls and same-process frame documents without host AX data', async () => {
  const root = { nodeType: 9, children: [element(10, { contentDocument: { nodeType: 9, children: [element(20, {
    shadowRoots: [closedRoot([element(21, { shadowRoots: [closedRoot([element(22)])] })])],
  })] } })] };
  const { page, calls, frame } = nativeClosedFixture(root, [axControl(21, 'generic', ''), axControl(22, 'switch', 'Nested')]);
  const result = await module.snapshot(page);
  const ref = /switch "Nested" \[ref=(s\d+)\]/.exec(result.text)?.[1];
  assert.ok(ref); assert.equal(module.closedRefBinding(page, ref).frame, frame);
  assert.deepEqual(calls.filter(call => call[0] === 'Accessibility.getPartialAXTree').map(call => call[1].backendNodeId), [21, 22]);
});

test('CR1 emits only native controls, flags and protected scalar roles', async () => {
  const children = Array.from({ length: 7 }, (_, i) => element(i + 1));
  const root = { nodeType: 9, children: [element(20, { shadowRoots: [closedRoot(children)] })] };
  const { page } = nativeClosedFixture(root, [
    axControl(1, 'button', 'State', { properties: ['disabled', 'expanded', 'selected'].map(name => ({ name, value: { value: true } }))
      .concat([{ name: 'pressed', value: { value: 'mixed' } }]) }),
    axControl(2, 'checkbox', 'Choice', { properties: [{ name: 'checked', value: { value: 'mixed' } }] }),
    axControl(3, 'textbox', 'Field', { value: { value: 'private-text' } }),
    axControl(4, 'searchbox', 'Search', { value: { value: 'private-search' } }),
    axControl(5, 'combobox', 'Combo', { value: { value: 'private-combo' } }),
    axControl(6, 'button', 'Ignored', { ignored: true }), axControl(7, 'paragraph', 'Not a control'),
  ]);
  const result = await module.snapshot(page);
  assert.match(result.text, /button "State" \[disabled\] \[expanded\] \[pressed="mixed"\] \[selected\]/);
  assert.match(result.text, /checkbox "Choice" \[checked="mixed"\]/);
  for (const name of ['Field', 'Search', 'Combo']) assert.match(result.text, new RegExp('"' + name + '".*redacted'));
  assert.doesNotMatch(result.text, /private-|Ignored|Not a control/);
});

for (const [count, closed, expectedProbes] of [[50001, false, 0]])
  test('CR1 refuses bounded native acquisition at ' + count + ' nodes', async () => {
    const children = Array.from({ length: count }, (_, i) => element(i + 1));
    const root = { nodeType: 9, children: closed ? [element(60000, { shadowRoots: [closedRoot(children)] })] : children };
    const { page, calls } = nativeClosedFixture(root, []);
    await assert.rejects(module.snapshot(page), /Snapshot unavailable/);
    assert.equal(calls.filter(call => call[0] === 'Accessibility.getPartialAXTree').length, expectedProbes);
    assert.equal(calls.at(-1)[0], 'detach');
  });

test('CR1 backend numbers are isolated by frame and retire when a frame disappears', async () => {
  const { page } = nativeClosedFixture({ nodeType: 9, children: [element(10, { shadowRoots: [closedRoot([element(1)])] })] },
    [axControl(1, 'button', 'Per frame')]);
  const main = page.mainFrame(), child = {};
  page.frames = () => [main, child];
  const first = await module.snapshot(page);
  const refs = [...first.text.matchAll(/button "Per frame" \[ref=(s\d+)\]/g)].map(match => match[1]);
  assert.equal(refs.length, 2); assert.notEqual(refs[0], refs[1]);
  assert.equal(module.closedRefBinding(page, refs[1]).frame, child);
  page.frames = () => [main];
  await module.snapshot(page);
  assert.throws(() => module.closedRefBinding(page, refs[1]), /stale/i);
  assert.equal(module.closedRefBinding(page, refs[0]).frame, main);
});

test('CR3 captures each frame once and omits pierced DOM and AX work without closed roots', async () => {
  const { page } = fixture([{ role: 'button', name: 'Continue', ref: 'e1' }]);
  const context = page.context(), calls = [];
  page.context = () => ({ newCDPSession: async frame => {
    calls.push('attach');
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => { calls.push(method); return send(method, params); };
    session.detach = async () => { calls.push('detach'); };
    return session;
  } });
  await module.snapshot(page);
  // The same main-frame session also reads the viewport size for the offscreen markers; no pierced DOM or AX call joins it.
  assert.deepEqual(calls, ['attach', 'DOMSnapshot.captureSnapshot', 'Page.getLayoutMetrics', 'detach']);
});

test('CR3 600 closed-root divs spend only one candidate probe and expose the button', async () => {
  const children = Array.from({ length: 600 }, (_, i) => element(i + 1, { localName: 'div' }));
  children.push(element(601));
  const { page, calls } = nativeClosedFixture({ nodeType: 9, children: [element(900, { shadowRoots: [closedRoot(children)] })] },
    [axControl(601, 'button', 'Only command')]);
  const result = await module.snapshot(page);
  assert.match(result.text, /button "Only command" \[ref=s\d+\]/);
  assert.deepEqual(calls.filter(([method]) => method === 'Accessibility.getPartialAXTree').map(([, params]) => params.backendNodeId), [601]);
  assert.equal(calls.filter(([method]) => method === 'DOMSnapshot.captureSnapshot').length, 1);
  assert.equal(calls.filter(([method]) => method === 'DOM.getDocument').length, 1);
});

test('CR3 native tags and role attributes are candidates while inert divs and hidden inputs are not', async () => {
  const tags = ['button', 'input', 'textarea', 'select', 'option', 'a', 'area', 'summary'];
  const children = tags.map((localName, i) => element(i + 1, { localName, attributes: ['href', '/next'] }));
  children.push(element(20, { localName: 'div', attributes: ['role', 'switch'] }),
    element(21, { localName: 'div' }), element(22, { localName: 'input', attributes: ['type', 'hidden'] }));
  const { page, calls } = nativeClosedFixture({ nodeType: 9, children: [element(900, { shadowRoots: [closedRoot(children)] })] }, []);
  await module.snapshot(page);
  assert.deepEqual(calls.filter(([method]) => method === 'Accessibility.getPartialAXTree').map(([, params]) => params.backendNodeId),
    [1, 2, 3, 4, 6, 7, 8, 20]);
});

test('CR3 runs up to four frame sessions alongside the aria read and detaches every session', async () => {
  const { page } = fixture([]), frames = Array.from({ length: 6 }, () => ({}));
  let active = 0, peak = 0, ariaStarted = false, captures = 0, detaches = 0, releasing = false;
  const held = [];
  page.frames = () => frames; page.mainFrame = () => frames[0];
  page.ariaSnapshotJSON = async () => { ariaStarted = true; return []; };
  page.context = () => ({ newCDPSession: async () => {
    active++; peak = Math.max(peak, active);
    return { send: async method => {
      assert.equal(method, 'DOMSnapshot.captureSnapshot'); captures++;
      if (!releasing) await new Promise(resolve => held.push(resolve));
      return nativeSnapshot([]);
    }, detach: async () => { active--; detaches++; } };
  } });
  const pending = module.snapshot(page);
  try {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(ariaStarted, true); assert.equal(captures, 4); assert.equal(peak, 4);
  } finally {
    releasing = true;
    for (const release of held.splice(0)) release();
    await pending.catch(() => {});
  }
  assert.equal(captures, 6); assert.equal(detaches, 6); assert.equal(active, 0); assert.equal(peak, 4);
});

test('snapshot refuses endpoint pages before DOM reads, including pending navigation', async () => {
  const { bindEndpointPage } = await import('../plugins/sleight/lib/direct-browser/endpoint-guard.mjs');
  for (const pending of [false, true]) {
    const { page } = fixture([{ role: 'text', text: 'private endpoint data' }]);
    if (!pending) page.url = () => 'http://alias.invalid:9222/json/list';
    let reads = 0;
    page.ariaSnapshotJSON = async () => { reads++; throw Error('endpoint DOM must not be read'); };
    bindEndpointPage(page, 'ws://127.0.0.1:9222/devtools/browser/private', {
      send: async method => { assert.equal(method, 'Target.getTargetInfo'); return { targetInfo: { url: page.url(), ...(pending ? { pendingUrl: 'http://localhost:9222/json/list' } : {}) } }; },
    });
    await assert.rejects(module.snapshot(page), /blocked: DevTools endpoint/);
    assert.equal(reads, 0);
  }
});

test('CR4 closed select with 600 options probes only its select node', async () => {
  const options = Array.from({ length: 600 }, (_, i) => element(i + 2, { localName: 'option', attributes: ['role', 'option'] }));
  const root = { nodeType: 9, children: [element(900, { shadowRoots: [closedRoot([
    element(1, { localName: 'select', children: options }),
  ])] })] };
  const { page, calls } = nativeClosedFixture(root, [axControl(1, 'combobox', 'Destination')]);
  const result = await module.snapshot(page);
  assert.match(result.text, /combobox "Destination"/);
  assert.equal(calls.filter(([method]) => method === 'Accessibility.getPartialAXTree').length, 1);
});

test('CR4 closed candidate overflow returns first 512 controls and an omitted-count note', async () => {
  const children = Array.from({ length: 600 }, (_, i) => element(i + 1));
  const root = { nodeType: 9, children: [element(900, { shadowRoots: [closedRoot(children)] })] };
  const nodes = children.map((_, i) => axControl(i + 1, 'button', 'Command ' + i));
  const { page, calls } = nativeClosedFixture(root, nodes);
  const result = await module.snapshot(page, { maxChars: 40000 });
  assert.match(result.text, /Command 0/); assert.match(result.text, /Command 511/);
  assert.doesNotMatch(result.text, /Command 512/);
  assert.match(result.text, /88.*(?:omitted|left out)/i);
  assert.equal(calls.filter(([method]) => method === 'Accessibility.getPartialAXTree').length, 512);
});

// A page whose main-frame session also answers Page.getLayoutMetrics, like Chromium.
function withViewport(page, width, height) {
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => method === 'Page.getLayoutMetrics'
      ? Promise.resolve({ cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: width, clientHeight: height } }) : send(method, params);
    return session;
  } });
  return page;
}
const boxed = (box, props) => ({ role: 'button', ...props, box: { x: 0, y: 0, width: 100, height: 40, ...box } });

for (const [name, node, metrics, marker] of [
  ['outside', boxed({ y: 900 }, { ref: 'e1' }), true, ' [offscreen]'],
  ['partly outside', boxed({ y: 820 }, { ref: 'e1' }), true, ' [partly offscreen]'],
  ['frame', boxed({ y: 900 }, { ref: 'f2e1' }), true, ''],
  ['zero area', boxed({ y: 900, width: 0 }, { ref: 'e1' }), true, ''],
  ['missing box', { role: 'button', ref: 'e1' }, true, ''],
  ['failed metrics', boxed({ y: 900 }, { ref: 'e1' }), false, ''],
]) test(`MTb viewport guidance makes no visibility inference for ${name}`, async () => withMT(undefined, async () => {
  const { page } = fixture([{ ...node, name: 'Target' }]);
  let size = { width: 1280, height: 720 };
  page.setViewportSize = async next => { size = next; };
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => method === 'Runtime.evaluate' ? Promise.resolve({ result: { value: [size.width, size.height] } })
      : method === 'Page.getLayoutMetrics' && metrics ? Promise.resolve({ cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: size.width, clientHeight: size.height } }) : send(method, params);
    return session;
  } });
  const guidance = await setViewport(page, { width: 390, height: 844 });
  assert.equal(guidance, metrics
    ? 'viewport 390x844 (was 1280x720; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.'
    : 'viewport 390x844; previous size unknown');
  const result = await module.snapshot(page);
  assert.ok(result.text.split('\n').some(line => line.endsWith(`[ref=${node.ref}]${marker}`)), result.text);
}));

test('refs outside the viewport carry offscreen markers and in-view refs carry none', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', box: { x: 0, y: 0, width: 390, height: 3000 }, children: [
    boxed({ y: 100 }, { name: 'Visible', ref: 'e2' }),
    boxed({ y: 900 }, { name: 'Below fold', ref: 'e3' }),
    boxed({ y: 820 }, { name: 'Cut off', ref: 'e4' }),
    boxed({ x: 500 }, { name: 'Right of view', ref: 'e5' }),
    boxed({ y: -200 }, { name: 'Above view', ref: 'e6' }),
    boxed({ y: 844 }, { name: 'Just below', ref: 'e7' }),
    boxed({ y: 843, height: 1 }, { name: 'Last pixel row', ref: 'e8' }),
    boxed({ y: 2000, width: 0, height: 0 }, { name: 'No area', ref: 'e9' }),
    { role: 'button', name: 'No box', ref: 'e10' },
    boxed({ y: 5000 }, { name: 'Inside a frame', ref: 'f2e1' }),
  ] }]);
  withViewport(page, 390, 844);
  const { text } = await module.snapshot(page);
  const line = name => text.split('\n').find(row => row.includes('"' + name + '"'));
  assert.match(line('Visible'), /\[ref=e2\]$/);
  assert.match(line('Below fold'), /\[ref=e3\] \[offscreen\]$/);
  assert.match(line('Cut off'), /\[ref=e4\] \[partly offscreen\]$/);
  assert.match(line('Right of view'), /\[ref=e5\] \[offscreen\]$/);
  assert.match(line('Above view'), /\[ref=e6\] \[offscreen\]$/);
  assert.match(line('Just below'), /\[ref=e7\] \[offscreen\]$/);
  assert.match(line('Last pixel row'), /\[ref=e8\]$/);
  assert.match(line('No area'), /\[ref=e9\]$/);
  assert.match(line('No box'), /\[ref=e10\]$/);
  assert.match(line('Inside a frame'), /\[ref=f2e1\]$/);
  assert.match(text, /- main \[ref=e1\] \[partly offscreen\]:/);
});

test('find reaches the offscreen marker and a scroll shows up as a diff', async () => {
  const { page, set } = fixture([boxed({ y: 900 }, { name: 'Add to cart', ref: 'e1' })]);
  withViewport(page, 390, 844);
  const first = await module.snapshot(page);
  assert.match(first.text, /Add to cart" \[ref=e1\] \[offscreen\]/);
  assert.match((await module.snapshot(page, { find: 'offscreen' })).text, /Add to cart/);
  set([boxed({ y: 300 }, { name: 'Add to cart', ref: 'e1' })]);
  const diff = await module.snapshot(page, { since: first.number });
  assert.match(diff.text, /\+ .*Add to cart" \[ref=e1\]$/m);
  assert.doesNotMatch(diff.text, /offscreen/);
});

test('boxes are requested, and no markers appear when the page size is unavailable', async () => {
  const { page } = fixture([boxed({ y: 5000 }, { name: 'Far away', ref: 'e1' })]);
  const asked = [], read = page.ariaSnapshotJSON;
  page.ariaSnapshotJSON = options => { asked.push(options); return read(options); };
  const result = await module.snapshot(page);
  assert.equal(asked[0].boxes, true);
  assert.doesNotMatch(result.text, /offscreen/);
  assert.match(result.text, /Far away" \[ref=e1\]/);
});

// RM1: Playwright resolves aria-ref against the latest read of a frame, so a read the model saw only in part (find,
// observe:none) retires a held ref whose role or name changed. The check refuses at once instead of a 1 s locator wait.
test('RM1: a held ref that a later read no longer lists is refused with a re-read hint', async () => {
  const { page, set } = fixture([{ role: 'button', name: 'Save', ref: 'e2' }, { role: 'button', name: 'Other', ref: 'e3' }]);
  page.locator = selector => ({ selector });
  module.acknowledgeSnapshot(page, (await module.snapshot(page)).number);
  set([{ role: 'button', name: 'Saving', ref: 'e7' }, { role: 'button', name: 'Other', ref: 'e3' }]);
  await module.snapshot(page, { find: 'Other' }); // shown only in part: Save's new ref is never delivered
  assert.throws(() => module.snapshotRefBinding(page, 'e2'), /^Error: Ref changed on the page since it was read; use browser_read again\.$/);
  assert.throws(() => page.getByRef('e2'), /changed on the page/);
  assert.equal(module.snapshotRefBinding(page, 'e3').selector, 'aria-ref=e3');
});

test('RM1: an unknown map after a failed read, or a frame the read did not list, falls through to Playwright', async () => {
  const { page, set } = fixture([{ role: 'button', name: 'Save', ref: 'e2' },
    { role: 'iframe', ref: 'e4', children: [{ role: 'textbox', name: 'City', ref: 'f2e1' }] }]);
  page.locator = selector => ({ selector });
  module.acknowledgeSnapshot(page, (await module.snapshot(page)).number);
  set([{ role: 'button', name: 'Saving', ref: 'e7' }]);
  await module.snapshot(page, { find: 'Saving' });
  assert.equal(module.snapshotRefBinding(page, 'f2e1').selector, 'aria-ref=f2e1');
  const read = page.ariaSnapshotJSON;
  page.ariaSnapshotJSON = async () => { throw Error('timeout'); };
  await assert.rejects(module.snapshot(page));
  page.ariaSnapshotJSON = read;
  assert.equal(module.snapshotRefBinding(page, 'e2').selector, 'aria-ref=e2');
});

test('RM1: a ref the latest read lists again binds once more', async () => {
  const { page, set } = fixture([{ role: 'button', name: 'Save', ref: 'e2' }]);
  page.locator = selector => ({ selector });
  module.acknowledgeSnapshot(page, (await module.snapshot(page)).number);
  set([{ role: 'button', name: 'Saving', ref: 'e7' }]);
  await module.snapshot(page, { find: 'zzz' });
  assert.throws(() => module.snapshotRefBinding(page, 'e2'), /changed on the page/);
  set([{ role: 'button', name: 'Save', ref: 'e2' }]);
  await module.snapshot(page, { find: 'zzz' });
  assert.equal(module.snapshotRefBinding(page, 'e2').selector, 'aria-ref=e2');
});

test('default snapshot bytes equal d3db241c across full, filtered, delta and capped reads', async () => {
  const current = fixture([{ role: 'button', ref: 'e1', name: 'Before' }]);
  let index = 0;
  const compare = async options => {
    const actual = await rawModule.snapshot(current.page, { ...options, completeness: false });
    assert.deepEqual({ number: actual.number, hash: sha256(actual.text) }, defaultReadBaseline.snapshot[index++]);
    return actual;
  };
  await compare(); await compare({ find: 'missing' }); await compare({ since: 2 });
  const long = [{ role: 'text', text: 'long '.repeat(20000) }, ...Array.from({ length: 60 }, (_, i) => ({ role: 'button', name: 'Choice ' + i, ref: 'e' + (i + 2) }))];
  current.set(long);
  const cut = await compare({ maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(cut.text)?.[1];
  assert.ok(ref); await compare({ ref, maxChars: 1000 });
});
