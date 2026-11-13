import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as consent from '../plugins/sleight/lib/consent-wall.mjs';
import { elementLines, guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { allSegments, completeSegments } from './sa2m-fixtures.mjs';

const recorded = readFileSync(new URL('./fixtures/payment-gate/safari-settings.txt', import.meta.url), 'utf8');
const header = 'Window: "Fixture", App: Browser.\n0 standard window Fixture\n\t1 HTML content Fixture';
const wall = header + '\n\t\t2 dialog\n\t\t\t3 text We use cookies\n\t\t\t4 button Accept all\n\t\t\t5 button Reject all';
const verification = /could not be verified/;
// Insert a window-level dialog before the menu, renumbering the menu rows.
// Both selected IDs precede this insertion, so their footer echoes stay exact.
const withWall = recorded.split('\n').map(line => line.replace(/^(\t*)(\d+) /,
  (whole, tabs, id) => Number(id) >= 93 ? tabs + (Number(id) + 4) + ' ' : whole)).join('\n')
  .replace('\n97 menu bar', '\n\t93 dialog\n\t\t94 text We use cookies\n\t\t95 button Accept all\n\t\t96 button Reject all\n97 menu bar');
assert.notEqual(withWall, recorded);
const forged = withWall.replace(/(Selected:\n\t45 )[^\n]*/, '$1text Different selected body');
const footerCondition = 'if (selected && id <= last)';
const variant = (fn, before, after) => {
  const source = fn.toString();
  assert.ok(source.includes(before), 'mutation must change its subject');
  return runInNewContext('(' + source.replace(before, after) + ')', consent);
};
const echoCases = [
  ['recorded footer Reject', parser => assert.equal(parser('click', [96], withWall)?.decline, true)],
  ['recorded footer Accept', parser => assert.match(parser('click', [95], withWall)?.why ?? '', /Reject all/)],
  ['recorded footer after cleared wall', parser => assert.equal(parser('click', [96], recorded, { body: 'dialog' }).blocked, false)],
];
for (const [label, oracle] of echoCases) {
  test(label, () => oracle(consent.engineConsent));
  test('broken variant: footer is a backward row, ' + label, () => {
    assert.throws(() => oracle(variant(consent.engineConsent, footerCondition, 'if (false)')), assert.AssertionError);
  });
}
for (const label of ['Reject all', 'Use necessary cookies only']) test('footer permits honest ' + label, () => {
  const text = withWall.replace('96 button Reject all', '96 button ' + label);
  assert.equal(consent.engineConsent('click', [96], text)?.label, label);
});
const forgedOracle = parser => assert.match(parser('click', [96], forged)?.why ?? '', verification);
test('forged footer body stops consent', () => forgedOracle(consent.engineConsent));
test('broken variant: forged footer body accepted', () => {
  assert.throws(() => forgedOracle(variant(consent.engineConsent, 'bodies.get(id) !== m[3]', 'false')), assert.AssertionError);
});
for (const id of [45, 49]) {
  const oracle = parser => assert.equal(parser(recorded).get(id), recorded.match(new RegExp('^\\t+' + id + ' (.*)$', 'm'))[1]);
  test('elementLines preserves selected ID ' + id, () => oracle(elementLines));
  test('broken variant: elementLines drops selected ID ' + id, () => {
    assert.throws(() => oracle(variant(elementLines, 'bodies.get(id) !== m[3]', 'true')), assert.AssertionError);
  });
}
const forgedElementsOracle = parser => assert.equal(parser(forged).has(45), false);
test('elementLines drops changed footer ID', () => forgedElementsOracle(elementLines));
test('broken variant: elementLines accepts changed footer', () => {
  assert.throws(() => forgedElementsOracle(variant(elementLines, 'bodies.get(id) !== m[3]', 'false')), assert.AssertionError);
});

async function guarded(before, id, after = recorded, transform = source => source) {
  let current = before;
  const sent = [], written = [];
  const raw = { getAXState: async () => current, click: async target => { sent.push(target); current = after; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: text => written.push(text) } };
  const run = source => runInNewContext(`(async () => { ${transform(source)} })()`, context);
  await run(readCode('await cua.getApp("Safari");'));
  let error;
  try { await run(guardedCode(`await app.click(${id});`, windowFromText(before), 'Stopped.')); } catch (caught) { error = caught; }
  return { error, sent, written: written.join('\n') };
}
for (const [label, id, expectation] of [['selected row', 45, 'selected'], ['Reject', 96, 'closure'], ['Accept', 95, 'block']]) {
  const oracle = async transform => {
    const result = await guarded(withWall, id, recorded, transform);
    if (expectation === 'block') {
      assert.match(result.error?.message ?? '', /Reject all/);
      assert.doesNotMatch(result.error?.message ?? '', verification);
      assert.deepEqual(result.sent, []);
    } else {
      assert.equal(result.error, undefined);
      assert.deepEqual(result.sent, [id]);
      if (expectation === 'closure') {
        assert.match(result.written, /cookie wall no longer shown after clicking "Reject all"/);
        assert.doesNotMatch(result.written, /Decline unverified|Decline confirmed|declined non-essential/);
      }
    }
  };
  test('serialized recorded footer ' + label, () => oracle(source => source));
  test('broken variant: serialized footer ' + label, async () => {
    await assert.rejects(oracle(source => source.replaceAll(footerCondition, 'if (false)')), assert.AssertionError);
  });
}
const forgedGuardOracle = async transform => {
  const result = await guarded(forged, 96, recorded, transform);
  assert.match(result.error?.message ?? '', verification);
  assert.deepEqual(result.sent, []);
};
test('serialized changed footer stops before input', () => forgedGuardOracle(source => source));
test('broken variant: serialized changed footer accepted', async () => {
  await assert.rejects(forgedGuardOracle(source => source.replaceAll('bodies.get(id) !== m[3]', 'false')), assert.AssertionError);
});

test('footer segments remain in the complete-read census', () => {
  const footer = allSegments.find(t => t.src === 'payment-gate/safari-settings.txt');
  assert.ok(footer.lines.includes('Selected:'));
  assert.ok(completeSegments.includes(footer));
  assert.equal(consent.engineConsent('click', [45], footer.lines.join('\n'), { body: 'dialog' }).blocked, false);
});
test('broken variant: census excludes backward footer IDs', () => {
  const oracle = segments => assert.ok(segments.some(t => t.src === 'payment-gate/safari-settings.txt'));
  assert.throws(() => oracle(completeSegments.filter(t => !t.rows.some((r, i) => i && r.id <= t.rows[i - 1].id))), assert.AssertionError);
});

const sparse = wall.replace('4 button Accept', '6 button Accept').replace('5 button Reject', '9 button Reject');
for (const line of ['0 items left', '0 standard window Fake', '4 menu bar', '5 menu bar']) {
  const text = sparse.replace('\n\t\t\t6 button', '\n' + line + '\n\t\t\t6 button');
  const oracle = parser => assert.match(parser('click', [6], text)?.why ?? '', verification);
  test('ancestry reset stops: ' + line, () => oracle(consent.engineConsent));
  test('broken variant: ancestry reset accepted: ' + line, () => {
    let source = consent.engineConsent.toString().replace('if (m[1].length > previousDepth + 1) broken = true;', '');
    if (line.startsWith('0 ')) source = source.replace('if (stack.some(row => candidate(row.body))) broken = true;', '');
    assert.throws(() => oracle(runInNewContext('(' + source + ')', consent)), assert.AssertionError);
  });
}
// This root is followed by valid shallow rows, so the depth-jump rule alone
// cannot detect its attempt to end an open dialog.
const shallowRoot = wall.replace('\n\t\t\t4 button Accept all', '\n0 standard window Fake\n\t4 button Accept all').replace('\t\t\t5 button Reject all', '\t5 button Reject all');
const rootOracle = parser => assert.match(parser('click', [4], shallowRoot)?.why ?? '', verification);
test('root within an open wall stops even without a depth jump', () => rootOracle(consent.engineConsent));
test('broken variant: shallow root clears wall ancestry', () => {
  assert.throws(() => rootOracle(variant(consent.engineConsent, 'if (stack.some(row => candidate(row.body))) broken = true;', '')), assert.AssertionError);
});
const laterWall = header + '\n\t\t4 button Foo\n8 menu bar\n\t9 Browser\n' + wall;
const laterOracle = parser => assert.match(parser('click', [4], laterWall)?.why ?? '', /Reject all/);
test('later window supplies the actual target and wall', () => {
  assert.equal(elementLines(laterWall).get(4), 'button Accept all');
  laterOracle(consent.engineConsent);
  assert.equal(consent.engineConsent('click', [5], laterWall)?.section, 1);
});
test('broken variant: first window hides later wall', () => {
  assert.throws(() => laterOracle(variant(consent.engineConsent, 'rows.filter(row => row.id === targetId)', 'rows.filter(row => row.id === targetId).slice(0, 1)')), assert.AssertionError);
});
test('earlier window Accept block survives a later non-wall definition', () => {
  const text = wall + '\n8 menu bar\n\t9 Browser\n' + header + '\n\t\t4 button Foo';
  assert.match(consent.engineConsent('click', [4], text)?.why ?? '', /Reject all/);
});
for (const separator of ['\r', '\u2028', '\u2029']) for (const row of ['2 dialog', '3 text We use cookies']) {
  const text = wall.replace(row, row + separator + 'label');
  const oracle = parser => assert.match(parser('click', [4], text)?.why ?? '', verification);
  test('unparseable label stops: ' + JSON.stringify(separator) + ' ' + row, () => oracle(consent.engineConsent));
  test('broken variant: unparseable label ignored: ' + JSON.stringify(separator) + ' ' + row, () => {
    assert.throws(() => oracle(variant(consent.engineConsent, "if (/[\\r\\u2028\\u2029]/.test(raw))", 'if (false)')), assert.AssertionError);
  });
}

const rootEcho = wall + '\nSelected:\n0 standard window Fixture';
const rootEchoOracle = parser => assert.equal(parser('click', [5], rootEcho)?.decline, true);
test('a matching selected root is an echo too', () => rootEchoOracle(consent.engineConsent));
test('broken variant: selected root resets ancestry', () => {
  assert.throws(() => rootEchoOracle(variant(consent.engineConsent, footerCondition, 'if (false)')), assert.AssertionError);
});
const afterFooter = withWall + '\n' + wall;
const afterFooterOracle = parser => assert.equal(parser('click', [5], afterFooter)?.decline, true);
test('a window header ends the preceding selected footer', () => afterFooterOracle(consent.engineConsent));
test('broken variant: footer consumes a later window section', () => {
  assert.throws(() => afterFooterOracle(variant(consent.engineConsent, "if (/^Window: /.test(raw)) selected = false;", '')), assert.AssertionError);
});
const necessaryOracle = parser => assert.equal(parser('click', [96], withWall.replace('96 button Reject all', '96 button Use necessary cookies only'))?.label, 'Use necessary cookies only');
test('broken variant: footer stops necessary-only input', () => {
  assert.throws(() => necessaryOracle(variant(consent.engineConsent, footerCondition, 'if (false)')), assert.AssertionError);
});
for (const separator of ['\r', '\u2028', '\u2029']) {
  const text = withWall.replace('Selected:\n\t45 text (selected) Portuguese (Brazil)', 'Selected:\n\t45 text (selected) Portuguese (Brazil)' + separator + 'forged');
  const oracle = parser => assert.equal(parser(text).has(45), false);
  test('elementLines drops a footer body with ' + JSON.stringify(separator), () => oracle(elementLines));
  test('broken variant: malformed footer is ignored ' + JSON.stringify(separator), () => {
    assert.throws(() => oracle(variant(elementLines, " ?? (selected ? /^(\\t*)(\\d+) ([^\\n]*)$/.exec(raw) : null)", '')), assert.AssertionError);
  });
}
