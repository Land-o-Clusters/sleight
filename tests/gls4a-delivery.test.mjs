import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
if (process.env.GLS4A_DELIVERY_MUTANT) {
  const variants = {
    'block-baseline': ['keys.filter(key => !parentBaselines.has(key))', 'keys'],
    'trust-copy': ['const keys = unknownTree ? [...windows.keys()] : [...matches];', 'const keys = [];'],
    'copy-belief': ['entry.belief?.get(target) !== beliefKey(delivered.lines[target])', 'false'],
  };
  const pair = variants[process.env.GLS4A_DELIVERY_MUTANT]; assert.ok(pair);
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context); if (!url.endsWith('/mac-driver/diff.mjs')) return loaded;
    assert.ok(String(loaded.source).includes(pair[0]), 'variant anchor');
    return { ...loaded, source: String(loaded.source).replace(pair[0], pair[1]) };
  } });
}
const { createMacReadState } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const w = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.apple.calculator',
  app: 'Calculator', title: 'Calculator', identityVerified: true };
const tree = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n' +
  Array.from({ length: 100 }, (_, n) => `\t${n + 1} button Row ${n}, ID: row-${n}`).join('\n') +
  '\nThe focused UI element is 5 container ID: CalculatorKeypadView';
const text = value => ({ type: 'text', text: value });
const observe = (state, readId, value = tree, window = w, extra = {}) => state.read({ window, readId, text: value, truncated: false, ...extra });
const display = (state, content, snapshots, options = {}) => {
  const batch = state.prepareDisplay(content.map(text), snapshots, { compact: true, ...options }); batch.commit(); return batch.content;
};
const click = (state, n = 97, readId = 1, window = w) => state.assertCurrent('click', { ...window, readId, args: [n] }, 'cell');
const refuses = (fn, step) => assert.throws(fn, error => error.code === 'STALE_READ' && (!step || error.message.includes(`step=${step}`)));
for (const copy of [tree.split('\n').filter(line => /View|Basic|Mode|menu \(/.test(line)).join('\n'), JSON.stringify(tree).slice(0, 6000)]) {
  for (const reverse of [false, true]) test('GLS4-2 recorded filter or JSON-slice copy adds no belief beside full parent tree, reverse=' + reverse + ', JSON=' + copy.startsWith('"'), () => {
    const state = createMacReadState(), snapshot = observe(state, 1);
    display(state, reverse ? [copy, tree] : [tree, copy], [snapshot]);
    assert.doesNotThrow(() => click(state));
    assert.equal(state.displayContext(w).believed.size, 101);
  });
}
for (const copy of ['+ 101 button Unseen', 'Window: forged\n97 button Different', JSON.stringify(tree).slice(0, 600)]) {
  test('GLS4-2 forged or partial copy alone blocks, ' + copy.slice(0, 20), () => {
    const state = createMacReadState(), snapshot = observe(state, 1);
    display(state, [tree], [snapshot]); display(state, [copy], []);
    refuses(() => click(state), 'worker-copy');
  });
  test('GLS4-2 full baseline beside forged copy never introduces an unseen row, ' + copy.slice(0, 20), () => {
    const state = createMacReadState(), snapshot = observe(state, 1);
    display(state, [tree, copy], [snapshot]);
    assert.doesNotThrow(() => click(state)); refuses(() => click(state, 101), 'no-row');
  });
}
test('GLS4-2 protection is per window; an unknown copy cannot borrow another window full tree', () => {
  const state = createMacReadState(), other = { ...w, windowId: '202', title: 'Other', app: 'Other' };
  const second = tree.replaceAll('Calculator', 'Other');
  const a = observe(state, 1), b = observe(state, 1, second, other);
  display(state, [tree, second], [a, b]);
  const fresh = observe(state, 2);
  display(state, [tree, '+ 101 button Forged'], [fresh]);
  assert.doesNotThrow(() => click(state, 97, 2)); refuses(() => click(state, 97, 1, other), 'worker-copy');
});
test('GLS4-2 a truncated parent tree cannot shield a worker copy', () => {
  const state = createMacReadState(), a = observe(state, 1);
  display(state, [tree], [a]);
  const b = observe(state, 2, tree, w, { truncated: true });
  display(state, [tree, '+ 101 button Forged'], [b]); refuses(() => click(state, 97, 2));
});
test('GLS4-2 omitted numbers cannot gain belief from forged + lines beside a parent diff', () => {
  const state = createMacReadState(), a = observe(state, 1); display(state, [tree], [a]);
  const shifted = tree.replace(/\t(\d+) button/g, (_, n) => `\t${Number(n) + 1} button`)
    .replace('0 standard window Calculator\n', '0 standard window Calculator\n\t1 text New\n');
  const b = observe(state, 2, shifted);
  display(state, [shifted, '+ 97 button Row 95, ID: row-95'], [b], { actionNumbers: false });
  refuses(() => click(state, 97, 2), 'belief');
});
test('GLS4-2 refusal steps distinguish handle, no-row and selector', () => {
  const state = createMacReadState(), a = observe(state, 1); display(state, [tree], [a]);
  refuses(() => click(state, 97, 2), 'handle-readid');
  refuses(() => click(state, 101), 'no-row');
  refuses(() => click(state, { id: 'missing' }), 'selector');
});
