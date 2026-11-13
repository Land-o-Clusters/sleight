import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacClipboardPreserver } from '../plugins/sleight/lib/mac-driver/preserve.mjs';

function fixture() {
  const calls = [], counts = { factory: 0, reads: 0, clears: 0, writes: 0, providers: 0 };
  const io = () => { counts.factory++; throw Error('pasteboard access forbidden'); };
  const preserver = createMacClipboardPreserver({ io, dispatchPaste: async (_target, ...args) => {
    calls.push(['strict-paste', ...args]); return { delivery: 'unknown', retry: 'read-first', clipboard: 'untouched' };
  } });
  const app = preserver.wrap({
    async pressKey(key) { calls.push(key); return { delivery: 'sent-unverified' }; },
    async paste(...args) { calls.push(['paste', ...args]); return { delivery: 'unknown', retry: 'read-first', clipboard: 'untouched' }; },
  });
  return { calls, counts, app, preserver };
}

test('strict preservation wrapper refuses Copy, Cut and clipboard-only Paste without factory access', async () => {
  const f = fixture();
  for (const mod of ['super', 'cmd', 'command', 'meta', 'Super_L', 'Meta_R']) {
    for (const key of ['c', 'x', 'v']) await assert.rejects(f.app.pressKey(`${mod}+${key}`), error =>
      error.code === 'ACTION_UNSUPPORTED' && error.delivery === 'not-sent' && /read again/i.test(error.message));
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.counts, { factory: 0, reads: 0, clears: 0, writes: 0, providers: 0 });
});

test('explicit text delegates once to strict native paste and keeps unknown delivery', async () => {
  const f = fixture(); const result = await f.app.paste('A😀e\u0301', { format: 'text' });
  assert.deepEqual(f.calls, [['strict-paste', 'A😀e\u0301', { format: 'text' }]]);
  assert.equal(result.delivery, 'unknown'); assert.equal(result.retry, 'read-first'); assert.equal(result.clipboard, 'untouched');
  assert.equal(f.counts.factory, 0);
});

test('reset and close retain no clipboard state and expire wrappers without IO', async () => {
  const f = fixture(); await f.preserver.reset(); await f.app.pressKey('super+s'); await f.preserver.close();
  await assert.rejects(f.app.paste('text'), { code: 'DRIVER_CLOSED' });
  await assert.rejects(f.app.pressKey('super+c'), { code: 'DRIVER_CLOSED' });
  assert.deepEqual(f.calls, ['super+s']); assert.equal(f.counts.factory, 0);
});


test('a raw engine or browser paste method cannot become a preservation fallback', async () => {
  let sends = 0;
  const preserver = createMacClipboardPreserver();
  const app = preserver.wrap({ get paste() { sends++; throw Error('hidden clipboard fallback'); } });
  await assert.rejects(app.paste('text'), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
  assert.equal(sends, 0);
});

test('clipboard predicate covers native and browser codes, modifier orders, aliases and case', async t => {
  const { isClipboardChord } = await import('../plugins/sleight/lib/mac-driver/preserve.mjs');
  const { clipboardChords } = await import('./fixtures/clipboard-chords.mjs');
  for (const chord of clipboardChords) assert.equal(isClipboardChord(chord), true, chord);
  for (const chord of [undefined, null, 1, '', 'c', 'KeyC', 'Insert', 'Delete', 'super+s', 'Control+a', 'Shift+c', 'Alt+v', 'super+Insert'])
    assert.equal(isClipboardChord(chord), false, String(chord));
  t.diagnostic(`clipboardChordTable=${clipboardChords.length}`);
});
