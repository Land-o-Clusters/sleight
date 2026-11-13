import { stopNoticeInventory } from '../plugins/sleight/hooks/stop-notice.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRICT_TEXT_CONTROL_REFUSAL } from '../plugins/sleight/lib/mac-driver/preserve.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { packageSkip } from './requirements.mjs';
import { MAC_DRIVER_ERRORS, MAC_DRIVER_LOCAL_ERRORS, MAC_DRIVER_SENTENCES, MAC_DRIVER_NEXT, MAC_DRIVER_PARAM_NOTICE, GLIDE_INTERRUPT_NOTICE, normalizeMacDriverError, formatMacDriverError }
  from '../plugins/sleight/lib/mac-driver/errors.mjs';

import { DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { personWaitNotice } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';

const typescriptSkip = packageSkip('typescript');
const ts = typescriptSkip ? undefined : (await import('typescript')).default;
const root = new URL('../plugins/sleight/lib/mac-driver/', import.meta.url);
const source = readFileSync(new URL('errors.mjs', root), 'utf8');
test('UC2B wait receipts use bounded numbers and fixed wording on success and failure', () => {
  assert.equal(personWaitNotice(3020), 'sleight waited 3020 ms for the person to pause');
  for (const value of [undefined, 0, -1, 0.5, Infinity, 30001, 'private']) assert.equal(personWaitNotice(value), undefined);
  const failure = { code: 'PERSON_TOOK_OVER', delivery: 'not-sent', retry: 'safe', waitedForPersonMs: 8000, reason: 'person-pointer' };
  assert.match(formatMacDriverError(failure), /The pointer is over the target window\./);
  assert.equal(formatMacDriverError(failure).split('\n')[1], 'sleight waited 8000 ms for the person to pause');
});
test('the closed helper table and sentence keys match exactly', () => {
  assert.deepEqual(Object.keys(MAC_DRIVER_SENTENCES).sort(), Object.keys(DRIVER_CODES).sort());
  assert.deepEqual(Object.keys(MAC_DRIVER_ERRORS).sort(),
    [...Object.keys(DRIVER_CODES), ...Object.keys(MAC_DRIVER_LOCAL_ERRORS)].sort());
  for (const [code, row] of Object.entries(DRIVER_CODES)) {
    assert.equal(MAC_DRIVER_ERRORS[code].next, row.next, code);
    assert.equal(MAC_DRIVER_ERRORS[code].unhealthy, row.unhealthy, code);
  }
  // A newly thrown helper fault must also fail before its doc row is written.
  const native = new URL('native/', root);
  for (const file of readdirSync(native).filter(name => /^Driver.*\.swift$/.test(name))) {
    const swift = readFileSync(new URL(file, native), 'utf8');
    for (const [, code] of swift.matchAll(/DriverFault\("([A-Z_]+)"/g)) {
      if (code === 'FIXTURE_SECRET_READ') continue; // test-only planted-secret assertion
      assert.ok(Object.hasOwn(MAC_DRIVER_ERRORS, code), `${file}: ${code}`);
    }
  }
});

test('the eleven client-local codes match all literal fault arguments, including conditional exit codes',
  { skip: typescriptSkip }, () => {
  // Audit the callers, not the compatibility shim's vocabulary constructors.
  const client = readFileSync(new URL('../driver-client.mjs', root), 'utf8');
  const ast = ts.createSourceFile('driver-client.mjs', client, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set();
  function visitCode(node) {
    if (ts.isStringLiteral(node)) found.add(node.text);
    else if (ts.isConditionalExpression(node)) { visitCode(node.whenTrue); visitCode(node.whenFalse); }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ['fault', 'macFault'].includes(node.expression.getText(ast)) && node.arguments[0]) visitCode(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Stop admission forwards this typed local fault from the consent-host client.
  const hand = readFileSync(new URL('../hand/client.mjs', root), 'utf8');
  assert.match(hand, /code: 'HAND_HOST_UNAVAILABLE', delivery: 'not-sent', retry: 'safe'/);
  found.add('HAND_HOST_UNAVAILABLE');
  const literals = [...found];
  assert.ok(literals.includes('DRIVER_EXIT'), 'clean EOF and child exit still emit DRIVER_EXIT');
  assert.equal(Object.keys(MAC_DRIVER_LOCAL_ERRORS).length, 11);
  assert.deepEqual(literals.filter(code => !Object.hasOwn(DRIVER_CODES, code)).sort(),
    Object.keys(MAC_DRIVER_LOCAL_ERRORS).sort());
  for (const code of literals) assert.ok(Object.hasOwn(MAC_DRIVER_ERRORS, code), code);
});

test('normalization never loosens the helper table or clears required retirement', () => {
  for (const [code, row] of Object.entries(DRIVER_CODES)) {
    for (const unhealthy of [false, true]) for (const delivery of ['not-sent', 'sent-unverified', 'sent-verified', 'unknown']) {
      const result = normalizeMacDriverError({ code, unhealthy, delivery, retry: 'safe', next: 'retry-safe' }, { action: true });
      const allowed = new Set([row.next]);
      if (row.next === 'retry-safe') allowed.add('read-again');
      if (['retry-safe', 'read-again'].includes(row.next)) allowed.add('restart-helper');
      assert.ok(allowed.has(result.next), `${code}: ${row.next} became ${result.next}`);
      assert.equal(result.unhealthy, row.unhealthy || unhealthy, code);
    }
  }
});

test('takeover, secure fields and invalid requests cannot invite another automated attempt', () => {
  for (const [code, next] of [['PERSON_TOOK_OVER', 'stop-tell-user'], ['SECURE_FIELD', 'none'], ['INVALID_PARAMS', 'none']]) {
    for (const unhealthy of [false, true]) {
      const failure = { code, unhealthy, next: 'retry-safe', delivery: 'not-sent', retry: 'safe' };
      assert.equal(normalizeMacDriverError(failure).next, next);
      assert.ok(!formatMacDriverError(failure).includes('before repeating any input'));
    }
  }
  assert.match(MAC_DRIVER_SENTENCES.SECURE_FIELD, /Stop automation.*The user must type/);
});

test('GLS3 INVALID_PARAMS names a trusted request and field, with safe read recovery and no values', () => {
  for (const method of ['getApp', 'getAXState', 'getAXStateAndScreenshot']) {
    const failure = { code: 'INVALID_PARAMS', field: 'menuRequests', message: 'PRIVATE VALUE', next: 'none' };
    const line = formatMacDriverError(failure, { method });
    assert.match(line, new RegExp('INVALID_PARAMS on ' + method + ', field menuRequests'));
    assert.match(line, /next=(?:retry-safe|read-again)/);
    assert.doesNotMatch(line, /PRIVATE|next=none|Do not retry/);
  }
  const input = formatMacDriverError({ code: 'INVALID_PARAMS', field: 'args', delivery: 'not-sent', retry: 'safe' },
    { method: 'click', action: true });
  assert.match(input, /INVALID_PARAMS on click, field args/); assert.match(input, /next=none/);
  for (const field of ['PRIVATE VALUE', 'menuRequests\nPRIVATE', '__proto__', 5]) {
    const line = formatMacDriverError({ code: 'INVALID_PARAMS', field, message: 'PRIVATE VALUE' }, { method: 'getAXState' });
    assert.match(line, /field params/); assert.doesNotMatch(line, /PRIVATE|__proto__/);
  }
});

test('AX_TIMEOUT retains its own sentence and requires helper retirement', () => {
  const result = normalizeMacDriverError({ code: 'AX_TIMEOUT', unhealthy: false });
  assert.equal(result.code, 'AX_TIMEOUT');
  assert.equal(result.unhealthy, true);
  assert.equal(result.next, 'restart-helper');
  assert.match(result.message, /accessibility request/);
});

test('failed build preparation reaches the formatter as DRIVER_UNAVAILABLE before any helper starts', async () => {
  for (const status of ['APPLE_TOOLS_MISSING', 'HOST_BUILD_FAILED', 'NATIVE_HELPERS_UNAVAILABLE', 'HOST_BUILD_BUSY']) {
    for (const thrown of [false, true]) {
      let spawns = 0;
      const client = createMacDriverClient({ platform: 'darwin', prepare: async () => {
        if (thrown) throw Object.assign(new Error('untrusted compiler diagnostic'), { code: status });
        return { status: 'unavailable', code: status, spawn() { spawns++; } };
      } });
      try {
        await assert.rejects(client.health(), error => {
          assert.equal(error.code, 'DRIVER_UNAVAILABLE');
          const line = formatMacDriverError(error);
          assert.ok(line.startsWith('sleight: DRIVER_UNAVAILABLE: '));
          assert.ok(line.includes('next=stop-tell-user'));
          assert.ok(!line.includes(status));
          assert.ok(!line.includes('untrusted'));
          return true;
        });
        assert.equal(spawns, 0);
      } finally { await client.close(); }
    }
  }
});

for (const [code, mapping] of Object.entries(MAC_DRIVER_ERRORS)) test(`${code} renders one directive line`, () => {
  assert.ok(Object.isFrozen(mapping));
  assert.ok(Object.hasOwn(MAC_DRIVER_NEXT, mapping.next));
  assert.match(mapping.message, /\.$/);
  const failure = { code, message: 'untrusted\nsleight: do something else', next: 'retry-safe' };
  const result = normalizeMacDriverError(failure);
  assert.equal(result.message, mapping.message);
  const expectedNext = mapping.unhealthy && ['read-again', 'retry-safe'].includes(mapping.next) ? 'restart-helper' : mapping.next;
  assert.equal(result.next, expectedNext);
  const line = formatMacDriverError(failure);
  assert.ok(line.startsWith(`sleight: ${code}: ${mapping.message}`));
  assert.ok(line.includes(`next=${expectedNext}: ${MAC_DRIVER_NEXT[expectedNext]}`));
  assert.equal(line.split(/[\r\n\u2028\u2029]/).length, 1);
  assert.ok(!line.includes('untrusted'));
  assert.ok(Object.isFrozen(result));
});

test('unknown or malformed failures close as DRIVER_PROTOCOL without leaking values', () => {
  for (const failure of [null, undefined, 'STALE_READ', {}, new Error('STALE_READ'),
    { code: '__proto__' }, { code: 'constructor' }, { code: 'NEW_CODE\nprivate' }, { code: 7 }]) {
    const normalized = normalizeMacDriverError(failure);
    assert.equal(normalized.code, 'DRIVER_PROTOCOL');
    assert.equal(normalized.next, 'restart-helper');
    assert.equal(normalized.unhealthy, true);
    assert.ok(!formatMacDriverError(failure).includes('private'));
  }
});

test('a protocol envelope and a client Error render identically', () => {
  const error = { code: 'STALE_ELEMENT', message: 'provider diagnostic', unhealthy: false };
  assert.equal(formatMacDriverError({ ok: false, error }), formatMacDriverError(Object.assign(new Error(error.message), error)));
});

test('every error retains all four valid delivery dispositions on action calls', () => {
  for (const code of Object.keys(MAC_DRIVER_ERRORS)) {
    for (const delivery of ['not-sent', 'sent-unverified', 'sent-verified', 'unknown']) {
      const retry = delivery === 'not-sent' ? 'safe' : 'read-first';
      const failure = { code, delivery, retry, personTookOver: false };
      const normalized = normalizeMacDriverError(failure, { action: true });
      assert.equal(normalized.delivery, delivery);
      const expectedRetry = ['CLIPBOARD_CHANGED', 'TARGET_CHANGED', 'READ_FIRST_REQUIRED'].includes(code) ? 'read-first' : retry;
      assert.equal(normalized.retry, expectedRetry);
      assert.equal(normalized.personTookOver, false);
      const line = formatMacDriverError(failure, { action: true });
      const printedRetry = normalized.next === 'none' && expectedRetry === 'safe' ? '' : ` retry=${expectedRetry};`;
      assert.ok(line.includes(`delivery=${delivery};${printedRetry} personTookOver=false;`));
      if (normalized.next === 'none') assert.doesNotMatch(line, /retry=safe/);
      if (retry === 'read-first') {
        assert.notEqual(normalized.next, 'retry-safe');
        assert.equal(line.includes('before repeating any input'), ['read-again', 'restart-helper'].includes(normalized.next));
      }
    }
  }
});

test('clipboard changes always stop and never invite a safe retry', () => {
  for (const retry of ['safe', 'read-first', undefined]) {
    const result = normalizeMacDriverError({ code: 'CLIPBOARD_CHANGED', delivery: 'not-sent', retry });
    assert.equal(result.next, 'stop-tell-user'); assert.equal(result.retry, 'read-first');
    assert.match(formatMacDriverError(result), /did not write or read it and cannot restore it/);
  }
});

test('missing or invalid action disposition stays unknown and read-first', () => {
  for (const failure of [{ code: 'INVALID_PARAMS' }, { code: 'DRIVER_EXIT' },
    { code: 'AX_UNAVAILABLE', retry: 'safe' }, { code: 'ACTION_UNCONFIRMED', delivery: 'sent', retry: 'safe' }]) {
    const result = normalizeMacDriverError(failure, { action: true });
    assert.equal(result.delivery, 'unknown');
    assert.equal(result.retry, 'read-first');
    assert.notEqual(result.next, 'retry-safe');
  }
  assert.equal(normalizeMacDriverError({ code: 'AX_UNAVAILABLE' }).delivery, undefined);
});

test('safe retry cannot override sent input or explicit read-first evidence', () => {
  for (const delivery of ['sent-unverified', 'sent-verified', 'unknown']) {
    const result = normalizeMacDriverError({ code: 'DRIVER_BUSY', delivery, retry: 'safe' });
    assert.equal(result.retry, 'read-first');
    assert.equal(result.next, 'read-again');
  }
  assert.equal(normalizeMacDriverError({ code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'read-first' }).retry, 'read-first');
  assert.equal(normalizeMacDriverError({ code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'invalid' }).retry, 'read-first');
  const refusal = normalizeMacDriverError({ code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'safe' });
  assert.equal(refusal.next, 'retry-safe');
});

test('unhealthy recovery retires a helper without changing stop and permission rules', () => {
  assert.equal(normalizeMacDriverError({ code: 'AX_UNAVAILABLE', unhealthy: true }).next, 'restart-helper');
  for (const code of ['USER_STOPPED', 'SECURE_FIELD', 'SCREEN_LOCKED', 'DRIVER_VERSION_MISMATCH']) {
    assert.equal(normalizeMacDriverError({ code, unhealthy: true }).next, MAC_DRIVER_ERRORS[code].next);
  }
});

test('the taxonomy cannot be changed by a worker consumer', () => {
  assert.ok(Object.isFrozen(MAC_DRIVER_ERRORS));
  assert.ok(Object.isFrozen(MAC_DRIVER_NEXT));
  assert.throws(() => { MAC_DRIVER_ERRORS.STALE_READ.next = 'retry-safe'; }, TypeError);
});

function assertNoProviderTextReads(text, file = 'errors.mjs') {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // Transport grammars are separate from model recovery. These exact expressions
  // validate the build fingerprint and split stderr, without reading an error.
  const transportExpressions = new Set([
    String.raw`/^[a-f0-9]{64}$/.test(hello.build ?? '')`,
    String.raw`String(chunk).split(/(?<=\n)/)`,
    String.raw`piece.replace(/\n$/, '')`,
    // Shape checks on the Windows refusal envelope (UC3B). They reject a malformed reply and never choose a recovery.
    String.raw`/^[a-z][a-z-]{0,79}$/.test(error.reason)`,
    String.raw`/[\x00-\x1f\x7f]/.test(limit)`,
  ]);
  // These existing copies carry diagnostics into Error objects, without selecting
  // recovery. Pin the whole call so a comparison or another use cannot hide here.
  const faultCopies = new Set([
    'fault(error.code, error.message, error.unhealthy)',
    'fault(value.error.code, value.error.message, value.error.unhealthy)',
    "fault(changed ? 'CLIPBOARD_CHANGED' : busy ? 'DRIVER_BUSY' : value.error.code,\n        changed ? MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED : busy ? undefined : value.error.message, value.error.unhealthy)",
  ]);
  const messageKey = node => (ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === 'message';
  function messageCopy(node) {
    if (file !== 'driver-client.mjs') return false;
    const parent = node.parent;
    if (ts.isTypeOfExpression(parent) && node.getText(ast) === 'value.error?.message') return true;
    let argument = node;
    while (ts.isConditionalExpression(argument.parent) && argument.parent.whenFalse === argument) argument = argument.parent;
    const call = argument.parent;
    return ts.isCallExpression(call) && faultCopies.has(call.getText(ast)) &&
      call.arguments[1] === argument;
  }
  function mappedMessage(node) {
    // Only the fixed normalizer's returned message is rendered. A wire read
    // planted elsewhere in this function, or inside a comparison, still fails.
    if (file !== 'errors.mjs' || node.getText(ast) !== 'error.message' ||
        !ts.isTemplateSpan(node.parent) || node.parent.expression !== node) return false;
    const statement = node.parent.parent.parent, block = statement.parent;
    return ts.isReturnStatement(statement) && ts.isBlock(block) &&
      ts.isFunctionDeclaration(block.parent) && block.parent.name?.text === 'formatMacDriverError' &&
      block.statements[0]?.getText(ast) === 'const error = normalizeMacDriverError(failure, options);';
  }
  let regexes = 0, providerMessageReads = 0;
  function visit(node, transport = false, inJSONParser = false) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseDriverJSON') inJSONParser = true;
    if (file === 'driver-client.mjs' && ts.isFunctionDeclaration(node) &&
        ['parseDriverJSON', 'rendererDiagnostic'].includes(node.name?.text)) transport = true;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && !transport &&
        !(file === 'driver-client.mjs' && transportExpressions.has(
          (ts.isPropertyAccessExpression(node.parent) ? node.parent.parent : node.parent).getText(ast)))) regexes++;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        ['RegExp', 'globalThis.RegExp'].includes(node.expression.getText(ast))) regexes++;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'message' && !messageCopy(node) && !mappedMessage(node)) providerMessageReads++;
    if (ts.isElementAccessExpression(node) &&
        (messageKey(node.argumentExpression) || node.expression.getText(ast) === 'source' &&
          (!inJSONParser || ts.isStringLiteral(node.argumentExpression)))) providerMessageReads++;
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && messageKey(node.propertyName ?? node.name)) {
      const declaration = node.parent.parent;
      if (!(file === 'errors.mjs' && ts.isVariableDeclaration(declaration) &&
          declaration.initializer?.getText(ast) === 'MAC_DRIVER_ERRORS[code]')) providerMessageReads++;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
      const hasMessage = object => object.properties.some(property =>
        messageKey(property.name) || ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) && hasMessage(property.initializer));
      if (hasMessage(node.left) || node.right.getText(ast) === 'source') providerMessageReads++;
    }
    ts.forEachChild(node, child => visit(child, transport, inJSONParser));
  }
  visit(ast);
  assert.equal(regexes, 0, file + ': recovery regexes');
  assert.equal(providerMessageReads, 0, file + ': provider message reads');
}

test('recovery uses typed codes with zero regex constructors, literals or provider message reads', { skip: typescriptSkip }, () => {
  assertNoProviderTextReads(source);
  for (const file of ['driver-client.mjs', 'mac-driver/client.mjs']) {
    assertNoProviderTextReads(readFileSync(new URL('../' + file, root), 'utf8'), file);
  }
});

test('every recovery file audit detects planted wire message reads and recovery regexes', { skip: typescriptSkip }, () => {
  for (const [file, seam] of [['driver-client.mjs', 'function response(g, bytes) {'],
    ['mac-driver/client.mjs', 'export function macClientFault(code, ...args) {'],
    ['mac-driver/errors.mjs', 'export function normalizeMacDriverError(failure, { action = false, method } = {}) {']]) {
    const text = readFileSync(new URL('../' + file, root), 'utf8');
    const auditFile = file === 'mac-driver/errors.mjs' ? 'errors.mjs' : file;
    // A clean control makes each plant prove its own added violation.
    assertNoProviderTextReads(text, auditFile);
    for (const expression of ['value.error.message', 'value.error?.message', 'error.message', 'error?.message', 'source?.message',
      'retirementFailure.message', 'fault(retirementFailure.code, retirementFailure.message, true)',
      'fault(retirementFailure.code, retirementFailure.message === "DRIVER_BUSY", true)',
      'source["message"]', 'value.error["message"]', 'const { message: detail } = value.error',
      '({ message } = envelope)', 'const { error: { message } } = value',
      'value.error.message === "DRIVER_BUSY"', 'fault(value.error.code, value.error.message === "DRIVER_BUSY", value.error.unhealthy)',
      'new RegExp("message")', '/message/']) {
      const planted = text.replace(seam, seam + ' ' + expression + ';');
      assert.notEqual(planted, text);
      assert.throws(() => assertNoProviderTextReads(planted, auditFile), assert.AssertionError, file + ': ' + expression);
    }
  }
});

test('the syntax guard rejects destructuring and regex constructors too', { skip: typescriptSkip }, () => {
  for (const text of ['const { message } = source;', '({ message } = source);',
    'const { message: detail } = envelope;', 'const { error: { message } } = value;',
    '({ message: detail } = value.error);', 'value.error.message', 'error.message',
    'new RegExp("message")', 'RegExp("message")', 'new globalThis.RegExp("message")',
    'source.message', 'source["message"]', '/message/']) {
    assert.throws(() => assertNoProviderTextReads(text), assert.AssertionError, text);
  }
  assertNoProviderTextReads('const fault = (code, message = code) => new Error(message);');
});

test('conditional Mac error notices have a pinned hash and measured size', () => {
  const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url), 'utf8'));
  const notices = JSON.stringify({ errors: MAC_DRIVER_ERRORS, next: MAC_DRIVER_NEXT, interrupt: GLIDE_INTERRUPT_NOTICE, stop: stopNoticeInventory(), params: MAC_DRIVER_PARAM_NOTICE });
  assert.equal(createHash('sha256').update(notices).digest('hex'), baseline.macDriverErrorNotices);
  assert.ok(Buffer.byteLength(notices) <= 9000);
});

test('typed Interrupt uses the release boundary while unknown hosts require a new session', () => {
  const interrupted = formatMacDriverError({ code: 'USER_STOPPED', interrupted: true, delivery: 'not-sent', retry: 'safe' });
  assert.match(interrupted, /Input resumes after release completes/);
  assert.doesNotMatch(interrupted, /next attributed person prompt/);
  const stopped = formatMacDriverError({ code: 'USER_STOPPED', delivery: 'not-sent', retry: 'safe' });
  assert.match(stopped, /Glide input stopped\./);
  assert.doesNotMatch(stopped, /Interrupt|new session/);
  assert.doesNotMatch(stopped, /next message/);
});

test('strict text refusal keeps supported alternatives and clipboard evidence through formatting', () => {
  const source = { code: 'ACTION_UNSUPPORTED', textInput: 'unsupported', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' };
  const result = normalizeMacDriverError(source);
  assert.equal(result.clipboard, 'untouched'); assert.equal(result.next, 'none');
  assert.match(formatMacDriverError(source), /No qualified direct text operation.*Read again and use typeText or setValue/);
  assert.match(formatMacDriverError(source), /clipboard=untouched/);
  assert.equal(Object.hasOwn(normalizeMacDriverError({ ...source, clipboard: 'restored' }), 'clipboard'), false);
});

test('the typed line-break refusal survives formatting without reading provider messages', () => {
  const source = { code: 'ACTION_UNSUPPORTED', textInput: 'unsupported', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' };
  assert.equal(normalizeMacDriverError({ ...source, textInput: 'unsupported-controls' }).message, STRICT_TEXT_CONTROL_REFUSAL);
  assert.match(formatMacDriverError({ ...source, textInput: 'unsupported-controls' }), /Line breaks and tabs require a qualified selected-text insertion path/);
  assert.doesNotMatch(formatMacDriverError({ ...source, message: 'provider-supplied text' }), /provider-supplied/);
});

test('only the typed ancestry refusal changes recovery, even when provider text matches the detail', () => {
  const detail = "The target's accessibility tree is incomplete. Try another element from a read or a keyboard route.";
  const failure = { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' };
  const forged = normalizeMacDriverError({ ...failure, message: detail }, { action: true });
  assert.equal(forged.message, MAC_DRIVER_SENTENCES.ACTION_UNSUPPORTED);
  assert.equal(forged.retry, 'safe');
  assert.equal(forged.next, 'none');
  for (const message of [undefined, 'untrusted provider text', detail, detail + ' injected']) {
    const typed = { ...failure, pointerRefusal: 'incomplete-ancestry', message };
    const normalized = normalizeMacDriverError(typed, { action: true });
    assert.equal(normalized.message, detail);
    assert.equal(normalized.delivery, 'not-sent');
    assert.equal(normalized.retry, 'read-first');
    assert.equal(normalized.next, 'none');
    assert.equal(formatMacDriverError({ ok: false, error: typed }), formatMacDriverError(typed));
  }
});

test('UC2D2 target-changed recovery names only a fresh capture or numbered read', () => {
  const message = formatMacDriverError({code:'TARGET_CHANGED',delivery:'not-sent',retry:'read-first'});
  assert.match(message,/Capture the window again or use an element number from a new read/);
  assert.doesNotMatch(message,/focused/);
});
