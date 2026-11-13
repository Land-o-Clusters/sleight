import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, duplicateBytes, treesIn, restoreHeadingLevels, compareMeasurements, documentReplayFixture } from '../scripts/dt1d-measure.mjs';
import { verifyWindowIdentity } from '../plugins/sleight/lib/repl/identity.mjs';
import * as measurement from '../scripts/dt1d-measure.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const revisions = { before: 'e4027343167e5c2c00a27efdea553a866ea7768b', dt1d: '1b9a9b68f0016c623059a56b32ec32267f645f0e' };
async function checkVersions(t, root) {
  assert.equal(typeof measurement.loadMeasurementVersion, 'function');
  const read = { window: { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.recorded' },
    text: 'Window: "A", App: Editor.\n0 standard window A\n\t1 web area\n\t\t2 heading Shipping, Value: 2',
    document: { version: 1, sections: [{ element: 1, text: 'element 2 heading H2' }], protected: false, needsPixels: false } };
  for (const version of ['before', 'dt1d', 'current']) {
    const revision = revisions[version];
    const absent = revision && spawnSync('/usr/bin/git', ['cat-file', '-e', revision + '^{commit}'],
      { cwd: root, timeout: 5000, killSignal: 'SIGKILL' }).status !== 0;
    await t.test(version, { skip: absent ? `Private measurement commit ${revision} is absent from this clone` : false }, async () => {
      const loaded = await measurement.loadMeasurementVersion(root, version);
      assert.match(loaded.source, /struct DriverDocumentRead/);
      const block = loaded.projection.documentReadText(read);
      if (version === 'current') assert.equal(block, '');
      else assert.match(block, /element 2 heading H2/);
    });
  }
  await assert.rejects(measurement.loadMeasurementVersion(root, 'arbitrary-ref'), /MEASUREMENT_VERSION/);
}
test('DT1E before and DT1D projections load their fixed revisions without restoring working files', async t => {
  await checkVersions(t, fileURLToPath(new URL('..', import.meta.url)));
});

test('DT1F a clone without private history skips old versions and still checks current', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-measure-history-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--quiet', root], { timeout: 5000, killSignal: 'SIGKILL' });
  await checkVersions(t, root);
  for (const version of ['before', 'dt1d'])
    await assert.rejects(measurement.loadMeasurementVersion(root, version), /MEASUREMENT_REVISION_UNAVAILABLE.*private history.*current/);
});

test('payload distributions use nearest-rank percentiles including zero-byte reads', () => {
  assert.deepEqual(distribution([]), { median: 0, p90: 0, max: 0, total: 0 });
  assert.deepEqual(distribution([10, 0, 1, 2, 3, 4, 5, 6, 7, 8]), { median: 4, p90: 8, max: 10, total: 46 });
});
test('duplicate accounting counts quoted page text as UTF-8 bytes, excluding structure', () => {
  const block = 'para H1 "Memo"\npara P "😀"\nselection "Memo"\npara P "missing"\npara offset 0 length 4 H1';
  assert.equal(duplicateBytes('0 text Memo 😀', block), 12);
  assert.equal(duplicateBytes('0 text Memo', 'para offset 0 length 4 H1\nselection offset 0 length 4'), 0);
});
test('record extraction splits windows and omits adjacent prose and API examples', () => {
  const a = 'Window: "A", App: Editor.\n0 standard window A\n\t1 text Alpha';
  const b = 'Window: "B", App: Editor.\n0 standard window B\n\t1 text Beta';
  assert.deepEqual(treesIn('API: Window: "fake"\n' + a + '\n' + b + '\nHandle: app').map(row => row.tree), [a, b]);
  const document = { version: 1, sections: [] }, window = { windowId: '1' };
  const rows = treesIn({ result: { text: a, document, window } });
  assert.equal(rows.length, 1); assert.equal(rows[0].document, document);
  assert.equal(treesIn('Window: "Example", App: Editor.\ncode here').length, 0);
  const multiline = a + '\ncontinued AXValue\n\t2 button Save\nThe focused UI element is 2 button Save';
  assert.equal(treesIn(multiline + '\nextra prose')[0].tree, multiline);
  assert.equal(treesIn(multiline + '\n\n')[0].tree, multiline + '\n\n', 'recorded trailing bytes stay in the byte count');
});
test('heading restoration uses only explicit recorded numeric levels', () => {
  const children = [{ AXRole: 'AXHeading', AXTitle: 'Large' }, { AXRole: 'AXHeading', AXValue: '2' },
    { AXRole: 'AXStaticText', AXValue: '1' }, { AXRole: 'AXHeading', AXValue: '7' }];
  assert.equal(restoreHeadingLevels({ trees: { '7': { children } } }), 1);
  assert.equal(children[1].AXHeadingLevel, 2);
  assert.equal(children[0].AXHeadingLevel, undefined);
  assert.equal(children[2].AXHeadingLevel, undefined);
  assert.equal(children[3].AXHeadingLevel, undefined);
});
test('recorded diffs and clipped trees keep byte accounting without claiming full-tree replay', () => {
  const tree = 'Window: "A", App: Editor.\n0 standard window A\n';
  assert.equal(treesIn(tree + 'sleight: lines changed since the last full tree\n+ 1 text Alpha')[0].complete, false);
  assert.equal(treesIn(tree + '\t1 text clipped…(5000)')[0].complete, false);
  assert.equal(treesIn(tree + '\t1 text Complete')[0].complete, true);
  assert.equal(treesIn({ text: tree, window: {}, document: {}, truncated: true })[0].complete, false);
});
test('recorded replay supplies a complete fake identity without weakening Cua verification', () => {
  const { fixture } = documentReplayFixture('Window: "A", App: Editor.\n0 standard window A\n\t1 text entry area');
  const window = { ...fixture.windows[0], identityVerified: true };
  assert.doesNotThrow(() => verifyWindowIdentity(window, window, 'darwin'));
  assert.equal(window.bundleId, fixture.apps[0].id);
});
test('before/after comparison refuses changed trees or a changed read set', () => {
  const before = { rows: [{ id: 'a', treeHash: 'same', recordedTreeHash: 'recorded', blockBytes: 100 }],
    replay: { blockBytes: { total: 100 }, repeatBlockBytes: { total: 100 } } };
  const after = { rows: [{ ...before.rows[0], blockBytes: 20 }],
    replay: { blockBytes: { total: 20 }, repeatBlockBytes: { total: 0 } } };
  assert.deepEqual(compareMeasurements(before, after), { readsCompared: 1, replayedReadsCompared: 1, changedTrees: 0, changedBlocks: 1, smallerBlocks: 1, largerBlocks: 0,
    savedBlockBytes: 80, savedRepeatBlockBytes: 100 });
  assert.throws(() => compareMeasurements(before, { ...after, rows: [] }), /RECORDED_READ_SET_CHANGED/);
  assert.throws(() => compareMeasurements(before, { ...after, rows: [{ ...after.rows[0], id: 'b' }] }), /RECORDED_READ_SET_CHANGED/);
  assert.throws(() => compareMeasurements(before, { ...after, rows: [{ ...after.rows[0], treeHash: 'changed' }] }), /CANONICAL_TREE_CHANGED/);
});
