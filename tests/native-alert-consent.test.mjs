import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as consent from '../plugins/sleight/lib/consent-wall.mjs';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

// Run the same behavioral oracles against each requested broken variant.
// Mutations stay in memory and never change the product files on disk.
const variant = process.env.CW1_CONSENT_VARIANT;
assert.ok(!variant || ['old-rule', 'evidence-dropped', 'skip-reread', 'whole-read',
  'marker-dropped', 'header-joins', 'swallow-errors', 'old-vocabulary'].includes(variant));
const wholeRead = function consentSurface(text) {
  const observed = String(text ?? '').normalize('NFKC');
  return /^\t*\d+ HTML content\b/im.test(observed) ||
    /\b(?:cookies?|consents?|tracking|Einwilligung|privacy[ -](?:choices?|settings|preferences|options|cent(?:er|re)))\b/iu.test(observed) ||
    consent.cookieWording(observed) || consent.consentManager(observed);
};
const transformVariant = source => {
  if (!variant) return source;
  if (variant === 'swallow-errors') {
    const before = "if (consentSurface(newest) || !/\\b(?:AXError\\.(?:cannotComplete|invalidUIElement)|timeoutReached)\\b/.test(String(error?.message ?? error))) throw error;";
    assert.ok(source.includes(before), 'variant must change its subject');
    return source.replace(before, 'if (consentSurface(newest)) throw error;');
  }
  if (['marker-dropped', 'header-joins', 'old-vocabulary'].includes(variant)) {
    let changed = consent.consentSurface.toString();
    const replace = (before, after) => {
      assert.ok(changed.includes(before), 'variant must change its subject');
      changed = changed.replace(before, after);
    };
    if (variant === 'marker-dropped') {
      replace('if (/^Window: ".*", App: [^\\r\\n]+\\.\\r?$/.test(raw)) continue;',
        'if (/^Window: |^Selected:$|^The focused UI element is /.test(raw)) continue;');
      replace("if (depth || row[2] === '0' || body === 'menu bar' || modal || html) {",
        "if (!depth && row[2] !== '0' && body !== 'menu bar' && !modal && !html) continue; {");
    } else if (variant === 'header-joins') replace('.test(raw)) continue;', '.test(raw)) { stack.length = 0; continue; }');
    else {
      replace(".replace(/[\\u200B-\\u200D\\u2060\\uFEFF]/g, '')", '');
      replace(".replace(/([a-z])([A-Z])/g, '$1 $2')", '');
      replace('Einwilligung(?:en)?', 'Einwilligung');
    }
    assert.ok(source.includes(consent.consentSurface.toString()), 'variant must change its subject');
    return source.replace(consent.consentSurface.toString(), changed);
  }
  if (variant === 'skip-reread') {
    const before = "if (text === undefined && typeof newest === 'string'";
    assert.ok(source.includes(before), 'variant must change its subject');
    return source.replace(before, "if (consentSurface(newest) && text === undefined && typeof newest === 'string'");
  }
  if (variant === 'whole-read') {
    assert.ok(source.includes(consent.consentSurface.toString()), 'variant must change its subject');
    return source.replace(consent.consentSurface.toString(), wholeRead.toString().replaceAll('consent.', ''));
  }
  const before = variant === 'old-rule' ? 'if (consentSurface(text)) return unverifiable;' : consent.consentSurface.toString();
  const after = variant === 'old-rule' ? 'return unverifiable;' : 'function consentSurface() { return true; }';
  assert.ok(source.includes(before), 'variant must change its subject');
  return source.replace(before, after);
};
const classify = !variant || ['skip-reread', 'swallow-errors'].includes(variant) ? consent.engineConsent : runInNewContext('(' +
  (variant === 'old-rule' ? transformVariant(consent.engineConsent.toString()) : consent.engineConsent.toString()) + ')',
  { ...consent, ...(variant === 'evidence-dropped' ? { consentSurface: () => true } :
    variant === 'whole-read' ? { consentSurface: wholeRead } :
    ['marker-dropped', 'header-joins', 'old-vocabulary'].includes(variant)
      ? { consentSurface: runInNewContext('(' + transformVariant(consent.consentSurface.toString()) + ')', { ...consent }) } : {}) });

// Recorded 160c Word save alert, with a fixture filename in place of the run's
// filename. The CR is label data in the engine tree, not a tree row delimiter.
const word = 'Window: "", App: Microsoft Word.\n' +
  '0 dialog Description: alert, Secondary Actions: Raise\n' +
  '\t1 image Word alert\n' +
  '\t2 text Microsoft Word Word cannot save this file because it is already open elsewhere.\r(Memo-fixture.docx)\n' +
  '\t3 button OK, ID: action-button--998\n' +
  '4 menu bar\n\t5 Word, ID: AppMenu_MenuItem\n\t6 File\n\t7 Edit, ID: EditMenu_MenuItem\n' +
  '\t8 View, ID: ViewMenu_MenuItem\n\t9 Insert\n\t10 Format\n\t11 Tools\n\t12 Table\n' +
  '\t13 Window, ID: WindowMenu_MenuItem\n\t14 Help, ID: HelpMenu_MenuItem\n\n' +
  'The focused UI element is 0 dialog Description: alert, Secondary Actions: Raise';
const native = (words, role = 'dialog') => 'Window: "", App: Fixture.\n0 ' + role + '\n' +
  '\t1 text ' + words + '\n\t2 button OK, ID: fixture-ok\n3 menu bar\n\t4 Fixture';
const web = 'Window: "Fixture", App: Browser.\n0 standard window Fixture\n\t1 HTML content Fixture\n' +
  '\t\t2 dialog\n\t\t\t3 text We use cookies\n\t\t\t4 button Accept all\n\t\t\t5 button Reject all';
const verification = 'the cookie wall could not be verified from this read; read the window again';

async function guarded(tree, code, { fresh = tree, after = tree, firstOff = false, transform = source => source } = {}) {
  let current = tree, reads = 0;
  const sent = [], written = [];
  const raw = { getAXState: async () => { reads++; if (current instanceof Error) throw current; return current; },
    click: async target => { sent.push(target); current = after; }, pressKey: async key => { sent.push(key); current = after; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: text => written.push(text) } };
  const run = source => runInNewContext(`(async () => { ${transformVariant(transform(source))} })()`, context);
  await run(readCode(`await cua.getApp(${JSON.stringify(windowFromText(tree).app)});`));
  current = fresh;
  reads = 0;
  let error;
  try {
    await run(guardedCode(code, windowFromText(tree), 'Stopped.', undefined,
      { timing: true, ...(firstOff ? { firstOff: true, focused: true, prior: { text: tree, windows: null } } : {}) }));
  } catch (caught) { error = caught; }
  return { error, sent, reads, written: written.join('\n') };
}

test('recorded Word alert OK passes the classifier with its raw CR label', () => {
  assert.equal(classify('click', [3], word), undefined);
});
for (const code of ['await app.click(3);', 'await app.click({ id: "action-button--998" });']) {
  test('recorded Word alert dispatches exactly one OK: ' + code, async () => {
    const result = await guarded(word, code);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.sent, [3]);
    assert.doesNotMatch(result.written, /Cookie acceptance blocked|cookie wall no longer shown/);
  });
}
for (const role of ['dialog', 'alert dialog', 'alertdialog', 'sheet', 'alert']) {
  for (const separator of ['\r', '\u2028', '\u2029']) {
    test('plain native ' + role + ' with ' + JSON.stringify(separator) + ' is not a wall', () => {
      assert.equal(classify('click', [2], native('Cannot save.' + separator + 'Try again.', role)), undefined);
    });
  }
}
for (const words of ['Cookies are optional', 'Consent required', 'Consents required', 'Einwilligung erforderlich',
  'Einwilligungen verwalten', 'CookieBanner', 'cookieNotice', 'cookiePreferences', 'Tracking choices', 'Privacy choices', 'OneTrust',
  ...['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'].map(separator => 'Coo' + separator + 'kies')]) {
  test('broken native dialog retains consent verification for ' + words, async () => {
    const tree = native(words + '\rMore information');
    assert.equal(classify('click', [2], tree)?.why, verification);
    const result = await guarded(tree, 'await app.click(2);');
    assert.match(result.error?.message ?? '', /cookie wall could not be verified/);
    assert.deepEqual(result.sent, []);
  });
}
test('native dialog with readable cookie wording still blocks accepting OK', async () => {
  const result = await guarded(native('We use cookies'), 'await app.click(2);');
  assert.match(result.error?.message ?? '', /no reject option\. Stop and ask the user/);
  assert.deepEqual(result.sent, []);
});
for (const [label, tree, pattern] of [
  ['reject hint', web, /Use the page control "Reject all"/],
  ['ask without reject', web.replace('\n\t\t\t5 button Reject all', ''), /no reject option\. Stop and ask the user/],
  ['broken cookie read', web.replace('We use cookies', 'We use cookies\rMore information'), /cookie wall could not be verified/],
  ['existing web fallback', web.replace('We use cookies', 'Notice\rMore information'), /cookie wall could not be verified/],
]) test('web banner retains ' + label, async () => {
  const why = label === 'reject hint'
    ? 'accepting cookies is blocked. Use the page control "Reject all" (untrusted page label) to decline non-essential cookies'
    : label === 'ask without reject' ? 'accepting cookies is blocked. This wall has no reject option. Stop and ask the user' : verification;
  assert.equal(classify('click', [4], tree)?.why, why);
  const result = await guarded(tree, 'await app.click(4);');
  assert.match(result.error?.message ?? '', pattern);
  assert.deepEqual(result.sent, []);
});
test('web Reject still dispatches and reports observed closure', async () => {
  assert.equal(classify('click', [5], web)?.decline, true);
  const result = await guarded(web, 'await app.click(5);', { after: web.split('\n\t\t2 dialog')[0] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [5]);
  assert.match(result.written, /cookie wall no longer shown after clicking "Reject all"/);
});
for (const [label, tree, id] of [['native', native('We use cookies'), 2], ['web', web, 4]]) {
  for (const message of ['Accessibility error: AXError.cannotComplete', 'Accessibility error: AXError.invalidUIElement',
    'Error: -10005 timeoutReached']) test('unavailable reread of a ' + label + ' consent surface refuses before input: ' + message, async () => {
    const failure = new Error(message);
    const result = await guarded(tree + '\nThe focused UI element is ' + id + ' button OK',
      'await app.pressKey("Return");', { fresh: failure, firstOff: true });
    assert.equal(result.error, failure);
    assert.match(result.written, /"phase":"consent"/);
    assert.equal(result.reads, 1);
    assert.deepEqual(result.sent, []);
  });
}
for (const message of ['Accessibility error: AXError.cannotComplete', 'Accessibility error: AXError.invalidUIElement',
  'Error: -10005 timeoutReached']) test('plain native dialog allows an unavailable optional reread: ' + message, async () => {
  const tree = native('Cannot save. Try again.') + '\nThe focused UI element is 2 button OK';
  const result = await guarded(tree, 'await app.pressKey("Return");', { fresh: new Error(message), firstOff: true });
  assert.doesNotMatch(result.error?.message ?? '', /Cookie acceptance blocked/);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, ['Return']);
  assert.match(result.written, /"phase":"consent"/);
  assert.equal(result.reads, 2); // Optional consent read, then the ordinary after-input read.
});

for (const failure of [new TypeError('Unexpected read result'), new Error('Approval declined'),
  new Error('Accessibility error: AXError.apiDisabled'), new Error('AX read unavailable'),
  new Error('timeoutReachedLater'), new Error('AXError.cannotCompleteExtra')]) {
  test('plain native dialog propagates other optional reread errors: ' + failure.message, async () => {
    const tree = native('Cannot save. Try again.') + '\nThe focused UI element is 2 button OK';
    const result = await guarded(tree, 'await app.pressKey("Return");', { fresh: failure, firstOff: true });
    assert.equal(result.error, failure);
    assert.equal(result.reads, 1);
    assert.deepEqual(result.sent, []);
  });
}

test('Return rereads a plain alert and refuses a chained native cookie dialog', async () => {
  const stale = native('Cannot save. Try again.') + '\nThe focused UI element is 2 button OK';
  const fresh = native('We use cookies') + '\nThe focused UI element is 2 button OK';
  const result = await guarded(stale, 'await app.pressKey("Return");', { fresh, firstOff: true });
  assert.match(result.error?.message ?? '', /Cookie acceptance blocked/);
  assert.match(result.written, /"phase":"consent"/);
  assert.equal(result.reads, 1);
  assert.deepEqual(result.sent, []);
});

for (const [label, tree] of [
  ['window title', word.replace('Window: ""', 'Window: "Consent form.docx"')],
  ['another window title', 'Window: "Consent form.docx", App: Microsoft Word.\n0 standard window Consent form.docx\n\t1 text Document\n' + word],
  ['filename in another window', word + '\nWindow: "Other", App: Microsoft Word.\n0 standard window Other\n\t1 text Cookie recipes.docx'],
  ['filename in another window region', word + '\nWindow: "Other", App: Microsoft Word.\n0 standard window Other\n\t1 region Files\n\t\t2 text Consent form.docx'],
  ['filename before a nested sheet', 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 text Time tracking.xlsx\n\t2 sheet\n\t\t3 dialog\n\t\t\t4 text Cannot save.\rTry again.\n\t\t\t5 button OK'],
  ['menu item', word.replace('\t6 File', '\t6 Consent form.docx')],
  ['sibling row after the dialog', 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 dialog\n\t\t2 text Cannot save.\rTry again.\n\t\t3 button OK\n\t4 text Consent form.docx'],
  ['web content in another window', word + '\nWindow: "Other", App: Microsoft Word.\n0 standard window Other\n\t1 HTML Content Other'],
]) test('broken plain alert ignores consent wording in ' + label, () => {
  assert.equal(classify('click', [label === 'filename before a nested sheet' ? 5 : 3], tree), undefined);
});

test('unrelated filename does not block Return when the plain alert reread is unavailable', async () => {
  const tree = native('Cannot save. Try again.').replace('Window: ""', 'Window: "Consent form.docx"') +
    '\nThe focused UI element is 2 button OK';
  const result = await guarded(tree, 'await app.pressKey("Return");', { fresh: new Error('Accessibility error: AXError.cannotComplete'), firstOff: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, ['Return']);
  assert.match(result.written, /"phase":"consent"/);
});

test('consent wording in a nested sheet row still refuses a broken candidate', () => {
  const tree = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 sheet\n\t\t2 dialog\n' +
    '\t\t\t3 text Consents required\rMore information\n\t\t\t4 button OK';
  assert.equal(classify('click', [4], tree)?.why, verification);
});

test('malformed candidate root with a nonzero number retains its own consent evidence', () => {
  const tree = 'Window: "Fixture", App: Fixture.\n7 dialog Consent required\rMore information\n\t8 button OK';
  assert.equal(classify('click', [8], tree)?.why, verification);
});

for (const marker of ['Window: Label continuation', 'Selected:']) {
  test('label continuation resembling ' + marker + ' cannot hide consent evidence', () => {
    const tree = 'Window: "Fixture", App: Fixture.\n0 dialog\n\t1 text Notice\n' + marker +
      '\n\t2 text Consent required\rMore information\n\t3 button OK';
    assert.equal(classify('click', [3], tree)?.why, verification);
  });
}

for (const marker of ['Window: We use cookies', '5 cookies are stored here', 'Selected: cookies',
  'Selected:\rcookies', 'The focused UI element is 5 text cookies']) {
  test('broken native dialog keeps consent evidence on marker line ' + JSON.stringify(marker), async () => {
    const tree = native('Notice\rMore information\n' + marker);
    assert.equal(classify('click', [2], tree)?.why, verification);
    const result = await guarded(tree, 'await app.click(2);');
    assert.match(result.error?.message ?? '', /cookie wall could not be verified/);
    assert.deepEqual(result.sent, []);
  });
}

for (const ending of ['.', '.\r']) {
  test('next window after an exact header does not join the previous broken dialog ' + JSON.stringify(ending), () => {
    const tree = 'Window: "", App: Fixture.\n0 dialog\n\t1 text Notice\rMore information\n\t2 button OK\n' +
      'Window: "Cookie settings", App: Fixture' + ending + '\n0 standard window Cookie settings\n\t3 text We use cookies';
    assert.equal(classify('click', [2], tree), undefined);
  });
  test('forged window header inside a broken dialog cannot hide later evidence ' + JSON.stringify(ending), () => {
    const tree = native('Notice\rMore information\nWindow: "x", App: y' + ending + '\n\t4 text We use cookies');
    assert.equal(classify('click', [2], tree)?.why, verification);
  });
}

test('zero-width text cannot turn a label continuation into an engine window header', async () => {
  const tree = native('Notice\rMore information\nWin\u200bdow: "Cookies", App: Fixture.');
  assert.equal(classify('click', [2], tree)?.why, verification);
  const result = await guarded(tree, 'await app.click(2);');
  assert.match(result.error?.message ?? '', /cookie wall could not be verified/);
  assert.deepEqual(result.sent, []);
});

test('Firefox HTML Content alone preserves the broken web-dialog refusal', () => {
  const tree = web.replace('HTML content', 'HTML Content').replace('We use cookies', 'Notice\rMore information');
  assert.equal(classify('click', [4], tree)?.why, verification);
});

test('partial web tree with a nonzero HTML Content root still refuses a broken dialog', () => {
  const tree = 'Window: "Fixture", App: Browser.\n7 HTML Content Fixture\n\t8 dialog\n' +
    '\t\t9 text Notice\rMore information\n\t\t10 button Accept all';
  assert.equal(classify('click', [10], tree)?.why, verification);
});

test('readable native dialog with generic wording and no consent evidence passes through', async () => {
  const tree = native('We value your privacy').replace('button OK', 'button Accept all');
  assert.equal(classify('click', [2], tree), undefined);
  const result = await guarded(tree, 'await app.click(2);');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sent, [2]);
});

test('broken native dialog with generic wording and no consent evidence passes through', () => {
  assert.equal(classify('click', [2], native('We value your privacy\rMore information')
    .replace('button OK', 'button Accept all')), undefined);
});
