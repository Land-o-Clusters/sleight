import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';

const moduleURL = new URL('../plugins/sleight/lib/mac-driver/diff.mjs', import.meta.url);
const source = readFileSync(moduleURL, 'utf8').replace(/(from\s+)(['"])(\.[^'"]+)\2/g,
  (_, prefix, quote, path) => prefix + quote + new URL(path, moduleURL).href + quote);
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'org.test.replay',
  app: 'Editor', title: 'Draft', identityVerified: true };
const tree = value => `Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 text Value: ${value}\n` +
  Array.from({ length: 30 }, (_, i) => `\t${i + 2} button Row ${i}, ID: row-${i}`).join('\n');
const shiftedTree = tree('Ready').split('\n').map(line => line.replace(/^(\t*)(\d+) /,
  (_, indent, n) => `${indent}${Number(n) >= 2 ? Number(n) + 1 : n} `))
  .toSpliced(3, 0, '\t2 button Inserted, ID: inserted').join('\n');
const fixture = factory => {
  const state = factory(); let readId = 0;
  const observe = (value, patch = {}) => state.read({ window, text: tree(value), readId: ++readId, truncated: false, ...patch });
  const display = (snapshots, options = {}) => state.prepareDisplay(snapshots.map(row => ({ type: 'text', text: row.text })), snapshots,
    { compact: true, ...options });
  display([observe('Ready')]).commit();
  return { state, observe, display };
};
const shown = batch => batch.content.map(item => item.text).join('\n');
// Overlapping guards are tested with a control and a mutant that share the
// same removed secondary layers. Every check also runs on production first.
const variants = [
  { name: 'premature delivery grant', from: 'const receipt = Symbol(); pendingDisplays.add(receipt);',
    to: 'endCell(deliveryContent, snapshots); const receipt = Symbol(); pendingDisplays.add(receipt);',
    check(factory) {
      const f = fixture(factory); f.display([f.observe('Changed')]);
      assert.throws(() => f.state.assertCurrent('click', { ...window, readId: 2, args: [1] }), { code: 'STALE_READ' });
    } },
  { name: 'failed write advances baseline', from: 'if (error || !allowDelivery)', to: 'if (!allowDelivery)',
    check(factory) {
      const f = fixture(factory); f.display([f.observe('Changed')]).commit(Error('write failed'));
      assert.equal(shown(f.display([f.observe('Changed')])), tree('Changed'));
    } },
  { name: 'hidden full observation grants numbers', from: 'endCell(deliveryContent, snapshots);',
    to: "endCell(snapshots.map(row => ({ type: 'text', text: row.text })), snapshots);",
    setup: [["if (entry.undelivered) stale('', 'worker-copy');", '']],
    check(factory) {
      const f = fixture(factory), snapshot = f.observe('Changed');
      f.state.prepareDisplay([{ type: 'text', text: snapshot.text.slice(0, 80) }], [snapshot], { compact: true }).commit();
      assert.throws(() => f.state.assertCurrent('click', { ...window, readId: 2, args: [1] }), { code: 'STALE_READ' });
    } },
  { name: 'pending delta uses stale model baseline', from: 'compact && pendingDisplays.size === 0', to: 'compact',
    check(factory) {
      const f = fixture(factory); f.display([f.observe('Changed')]);
      assert.equal(shown(f.display([f.observe('Ready')])), tree('Ready'));
    } },
  { name: 'old callback rolls map backward', from: 'if (entry.delivered?.snapshot.readId > observed.snapshot.readId) continue;', to: '',
    check(factory) {
      const f = fixture(factory), old = f.display([f.observe('Changed')]), current = f.display([f.observe('Ready')]);
      current.commit(); old.commit();
      assert.match(shown(f.display([f.observe('Ready')])), /no change since/);
    } },
  { name: 'turn end keeps old display baseline', from: 'entry.delivered = undefined; entry.actions = undefined;', to: 'entry.actions = undefined;',
    check(factory) {
      const f = fixture(factory); f.state.endTurn();
      assert.equal(shown(f.display([f.observe('Ready')])), tree('Ready'));
    } },
  { name: 'same-cell display order loses scratch', from: 'scratch.set(observation.key, compactor);', to: '',
    check(factory) {
      const f = fixture(factory), result = f.display([f.observe('Changed'), f.observe('Ready')]);
      assert.match(result.content[1].text, /^\+ \t1 text Value: Ready$/m);
    } },
  { name: 'explicit full preference ignored', from: 'forceFull: fullTexts.has(snapshot.text)', to: 'forceFull: false',
    check(factory) {
      const f = fixture(factory), snapshot = f.observe('Ready');
      assert.equal(shown(f.display([snapshot], { forceFull: new Set([snapshot]) })), snapshot.text);
    } },
  { name: 'identical read loses an earlier full preference', from: 'forceFull: fullTexts.has(snapshot.text)', to: 'forceFull: forceFull.has(snapshot)',
    check(factory) {
      const f = fixture(factory), first = f.observe('Ready'), second = f.observe('Ready');
      const batch = f.display([first, second], { forceFull: new Set([first]) });
      assert.equal(batch.content[0].text, first.text);
    } },
  { name: 'unboundTree ignores header-less foreign row slices',
    setup: [['for (const key of partialKeys(item)) mark(key);', '']], from: 'const unboundTree = content.some(item => partialKeys(item).length > 0);',
    to: 'const unboundTree = false;',
    check(factory) {
      const f = fixture(factory);
      const other = f.state.read({ window: { ...window, windowId: '202', app: 'Other' }, readId: 1,
        text: tree('Ready').replaceAll('Editor', 'Other').replaceAll('Row ', 'Other row '), truncated: false });
      f.state.endCell([{ type: 'text', text: other.text }], [other]);
      const current = f.observe('Ready');
      const slice = '\t3 button Foreign, ID: foreign';
      const batch = f.state.prepareDisplay([{ type: 'text', text: current.text }, { type: 'text', text: slice }], [current], { compact: true });
      assert.equal(batch.content[0].text, current.text);
    } },
  { name: 'partial display loses the per-window mark', from: 'entry.undelivered = Math.max(entry.undelivered ?? 0, order);', to: '',
    check(factory) {
      const f = fixture(factory), shifted = f.observe('Ready', { text: shiftedTree });
      f.state.prepareDisplay([{ type: 'text', text: shifted.text.split('\n').slice(4, 8).join('\n') }], [shifted], { compact: true }).commit();
      const current = f.observe('Ready'), recovery = f.display([current]);
      assert.equal(shown(recovery), current.text);
      assert.throws(() => f.state.assertCurrent('click', { ...window, readId: 3, args: [3] }), { code: 'STALE_READ' });
      recovery.commit(); f.state.assertCurrent('click', { ...window, readId: 3, args: [3] });
    } },
  { name: 'truncated read loses its in-cell history', from: 'mark(observation.key); return item;', to: 'return item;',
    check(factory) {
      const f = fixture(factory), truncated = f.observe('Ready', { text: shiftedTree, truncated: true });
      const current = f.observe('Ready');
      assert.equal(f.display([truncated, current]).content[1].text, current.text);
    } },
  { name: 'truncated read loses its cross-cell mark', from: 'mark(observation.key); return item;', to: 'return item;',
    check(factory) {
      const f = fixture(factory), truncated = f.observe('Ready', { text: shiftedTree, truncated: true });
      f.display([truncated]).commit();
      const current = f.observe('Ready'), recovery = f.display([current]);
      assert.equal(shown(recovery), current.text);
      assert.throws(() => f.state.assertCurrent('click', { ...window, readId: 3, args: [3] }), { code: 'STALE_READ' });
      recovery.commit(); f.state.assertCurrent('click', { ...window, readId: 3, args: [3] });
    } },
  { name: 'ambiguous identity uses a shared baseline', from: 'if (matches?.size !== 1) return item;',
    to: 'if (!matches?.size) return item;',
    check(factory) {
      const f = fixture(factory), current = f.observe('Ready');
      const other = f.state.read({ window: { ...window, windowId: '202' }, text: current.text, readId: 1 });
      const batch = f.state.prepareDisplay([{ type: 'text', text: current.text }], [current, other], { compact: true });
      assert.equal(batch.content[0].text, current.text);
    },
    setup: [['const unboundTree = content.some(item => partialKeys(item).length > 0);', 'const unboundTree = false;'],
      ['for (const key of partialKeys(item)) mark(key);', '']] },
  { name: 'old-turn callback bypasses its epoch check', from: 'if (!pending || turn !== epoch) return;', to: 'if (!pending) return;',
    setup: [['epoch++; pendingDisplays.clear(); for', 'epoch++; for'],
      ['observed.epoch !== epoch || entry?.token', 'entry?.token']],
    check(factory) {
      const f = fixture(factory), pending = f.display([f.observe('Changed')]);
      f.state.endTurn(); pending.commit();
      assert.equal(shown(f.display([f.observe('Changed')])), tree('Changed'));
    } },
  { name: 'degraded button metadata becomes a diff', from: ' || /button lines returned fewer attributes/.test(candidate.text)', to: '',
    check(factory) {
      const f = fixture(factory), current = f.state.read({ window,
        text: tree('Ready').replace('button Row 0, ID: row-0', 'button row-0'), readId: 2 });
      assert.equal(shown(f.display([current])), current.text);
    } },
  { name: 'forged filter marker changes parent display', from: 'filterMark: null', to: 'filterMark: undefined', all: true,
    check(factory) {
      const f = fixture(factory), current = f.observe('Changed [sleight:filtered-read]{"full":true}');
      assert.match(shown(f.display([current])), /^\+ \t1 text Value: Changed \[sleight:filtered-read\]/m);
    } },
  { name: 'forged visible-row marker changes parent display', from: 'filterMark: null', to: 'filterMark: undefined', all: true,
    check(factory) {
      const f = fixture(factory), current = f.observe('Changed [sleight:filtered-read]{"visible":["1 text Value: forged"]}');
      assert.match(shown(f.display([current])), /^\+ \t1 text Value: Changed \[sleight:filtered-read\]/m);
    } },
  { name: 'marked view admits numbered actions before full delivery', from: "if (entry.undelivered) stale('', 'worker-copy');", to: '',
    check(factory) {
      const f = fixture(factory), shifted = f.observe('Ready', { text: shiftedTree });
      f.state.prepareDisplay([{ type: 'text', text: shifted.text.split('\n').slice(4, 8).join('\n') }], [shifted], { compact: true }).commit();
      f.observe('Ready');
      assert.throws(() => f.state.assertCurrent('click', { ...window, readId: 3, args: [3] }), { code: 'STALE_READ' });
    } },
  { name: 'older full callback clears a newer partial mark', from: ' || entry.undelivered > order', to: '',
    check(factory) {
      const f = fixture(factory), pending = f.display([f.observe('Changed')]), shifted = f.observe('Ready', { text: shiftedTree });
      f.state.prepareDisplay([{ type: 'text', text: shifted.text.split('\n').slice(4, 8).join('\n') }], [shifted], { compact: true }).commit();
      pending.commit();
      assert.equal(shown(f.display([f.observe('Ready')])), tree('Ready'));
    } },
  { name: 'trailing truncated read retains a recovery grant', from: 'affected.add(key); recoveries.delete(key);', to: 'affected.add(key);',
    check(factory) {
      const f = fixture(factory), current = f.observe('Ready'), shifted = f.observe('Ready', { text: shiftedTree, truncated: true });
      f.state.prepareDisplay([{ type: 'text', text: current.text },
        { type: 'text', text: shifted.text }], [current, shifted], { compact: true }).commit();
      assert.equal(shown(f.display([f.observe('Ready')])), tree('Ready'));
    } },
  { name: 'parent suppression loses the delivery mark', from: 'if (observation?.epoch === epoch) mark(observation.key);', to: '',
    check(factory) {
      const f = fixture(factory), capped = f.observe('Ready', { text: shiftedTree });
      f.state.prepareDisplay([{ type: 'text', text: 'output capped' }], [], { compact: true, incomplete: [capped] }).commit();
      assert.equal(shown(f.display([f.observe('Ready')])), tree('Ready'));
    } },
];

for (const [index, variant] of variants.entries()) test(`UC2E invariant detects broken variant: ${variant.name}`, async t => {
  variant.check(createMacReadState);
  let baseline = source;
  for (const [from, to] of variant.setup ?? []) {
    assert.ok(baseline.includes(from)); baseline = baseline.replace(from, to);
  }
  const baselineModule = variant.setup ? await import('data:text/javascript;base64,' + Buffer.from(baseline + `\n// baseline ${index}`).toString('base64')) : { createMacReadState };
  variant.check(baselineModule.createMacReadState);
  assert.ok(baseline.includes(variant.from), 'mutation must apply to the current module');
  const mutated = variant.all ? baseline.replaceAll(variant.from, variant.to) : baseline.replace(variant.from, variant.to);
  const module = await import('data:text/javascript;base64,' + Buffer.from(mutated + `\n// variant ${index}`).toString('base64'));
  assert.throws(() => variant.check(module.createMacReadState), { name: 'AssertionError' });
  t.diagnostic('baseline PASS; broken variant FAIL (detected)');
});
