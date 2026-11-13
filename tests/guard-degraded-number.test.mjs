import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { guardedCode, elementLines, elementParents } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const recording = JSON.parse(readFileSync(new URL('fixtures/dropdown-stale-number.json', import.meta.url)));
const window = { title: 'Dropdown fixture', app: 'Safari', url: null };

// Only the engine boundary is replaced. The real injected guard chooses reads, stops and dispatch arguments.
function fixture({ first = recording.before, next = recording.after, reads } = {}) {
  const calls = [], output = [];
  let acted = false;
  const raw = {
    getAXState: async () => { calls.push(['read']); return reads?.shift() ?? (acted ? next : first); },
    click: async number => { calls.push(['click', number]); acted = true; },
  };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(value) } };
  return { calls, output, run: (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, window, 'window changed', undefined, options)} })()`, context) };
}

for (const batch of [false, true]) test(`recorded dropdown menu selection reads before the next number, batch=${batch}`, async () => {
  const f = fixture();
  let stopped;
  try { await f.run('await app.click(17); await app.click(13);', {
    bind: true, literals: [17, 13], literalOrder: batch ? [17, 13] : [],
    seenLines: Object.fromEntries(elementLines(recording.before)),
    seenParents: Object.fromEntries(elementParents(recording.before)), uniqueSeen: [17, 13],
  }); } catch (error) { stopped = error; }
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), [['click', 17]]);
  assert.match(stopped?.message ?? JSON.stringify(f.calls), /sleight stopped before click\(13\)/);
  assert.match(stopped.message, /Use the current numbers in the window below\./);
  assert.deepEqual(f.calls.slice(0, 3), [['read'], ['click', 17], ['read']]);
});

const header = 'Window: "Dropdown fixture", App: Safari.\n';
const full = header + '0 standard window Dropdown fixture\n\t1 button Next\n\t2 button Target';
for (const [label, first] of [
  ['target missing', header + '0 standard window Dropdown fixture'],
  ['root missing', header + '\t2 button Target'],
]) test(`a ${label} guard read cannot authorize a number without a baseline`, async () => {
  const f = fixture({ first });
  await assert.rejects(f.run('await app.click(2);'), error => {
    assert.match(error.message, /sleight stopped before click\(2\)[\s\S]*Read again/);
    assert.doesNotMatch(error.message, /changed|was "missing"/);
    return true;
  });
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), []);
});

test('existing compactor behavior labels the complete dropdown comparison as a degraded read', () => {
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: recording.before }]);
  const action = compactor.beginAction('await app.click(17); await app.click(13);');
  const content = compactor.process([{ type: 'text', text: GUARD_MARK + recording.after + GUARD_END }], { action });
  assert.match(content.map(item => item.text ?? '').join('\n'), /UI unverified \(degraded read\)/);
});

for (const nested of [false, true]) test(`a role-less menu option invalidates its capture, nested=${nested}`, async () => {
  const first = header + '0 standard window Dropdown fixture\n\t1 menu Secondary Actions: Cancel\n' +
    (nested ? '\t\t2 container Choices\n\t\t\t3 Coast' : '\t\t3 Coast') + '\n\t4 button Target, ID: target';
  const next = header + '0 standard window Dropdown fixture\n\t1 text Ready\n\t4 button Other\n\t5 button Target, ID: target';
  const f = fixture({ first, next });
  await f.run('await app.click(3); await app.click(4);', { bind: true });
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), [['click', 3], ['click', 5]]);
  assert.equal(f.calls.filter(call => call[0] === 'read').length, 3);
  assert.match(f.output.join(''), /went to element 5/);
});

for (const next of [header, header + '\t2 button Target']) test(`an incomplete read after a menu selection never dispatches its second number, chars=${next.length}`, async () => {
  const first = header + '0 standard window Dropdown fixture\n\t1 menu\n\t\t3 Coast\n\t2 button Target';
  const f = fixture({ first, next });
  await assert.rejects(f.run('await app.click(3); await app.click(2);', { bind: true }), /sleight stopped before click\(2\)/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), [['click', 3]]);
});

test('guard-only header reads without a numbered baseline preserve engine dispatch', async () => {
  const f = fixture({ first: header, next: header });
  await f.run('await app.click(2); await app.click(2);');
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), [['click', 2], ['click', 2]]);
});

for (const explicit of [false, true]) test(`a header-only read with model-visible evidence refuses, explicit=${explicit}`, async () => {
  const f = fixture({ first: header });
  await assert.rejects(f.run((explicit ? 'await app.getAXState(); ' : '') + 'await app.click(2);',
    explicit ? {} : { seenLines: Object.fromEntries(elementLines(full)) }), /Read again/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), []);
});

test('a rootless read names the unique moved element without claiming a change', async () => {
  const first = header + '\t5 button Target, ID: target';
  const f = fixture({ first });
  await assert.rejects(f.run('await app.click(2);', {
    seenLines: { 2: 'button Target, ID: target' }, uniqueSeen: [2],
  }), error => {
    assert.match(error.message, /Use element 5 by ID or label/);
    assert.doesNotMatch(error.message, /changed|Read again/);
    return true;
  });
  assert.deepEqual(f.calls.filter(call => call[0] === 'click'), []);
});

for (const prompt of [undefined, 'lean']) for (const site of ['seen', 'batch', 'code', 'earlier']) {
  test(`the ${site} stale-number stop keeps its old message, prompt=${prompt ?? 'default'}`, async () => {
    const current = full.replace('2 button Target', '2 button Other');
    const f = fixture({ first: site === 'earlier' ? full : current, next: current,
      reads: site === 'code' ? [full, current] : undefined });
    const code = site === 'code' ? 'const n = Number((await app.getAXState()).match(/(2) button Target/)[1]); await app.click(1); await app.click(n);'
      : (site === 'earlier' ? 'await app.click(1); ' : '') + 'await app.click(2);';
    const options = { prompt, ...(site === 'code' ? { literals: [] }
      : site === 'earlier' ? {} : { seenLines: Object.fromEntries(elementLines(full)),
        ...(site === 'batch' ? { literalOrder: [2, 1] } : {}) }) };
    const reason = site === 'earlier' ? (prompt === 'lean' ? 'an earlier action changed what element 2 is' : 'an earlier action in this call changed what element 2 is')
      : 'element 2 ' + (site === 'code' ? (prompt === 'lean' ? "changed since this call's read" : 'changed since this call read the window')
        : (prompt === 'lean' ? 'changed since your read' : 'changed since you read the window'));
    const expected = 'sleight stopped before click(2): ' + reason + ' (was "button Target", now "button Other"). Use the current numbers' +
      (prompt === 'lean' ? ' below.' : ' in the window below.');
    await assert.rejects(f.run(code, options), error => {
      assert.equal(error.message.split('\n')[0], expected);
      return true;
    });
  });
}
