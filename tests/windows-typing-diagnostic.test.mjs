import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPING_DIAGNOSTIC, typingReadMetadata } from '../bench/windows/typing-diagnostic.mjs';
import { guestDiagnosticPlan, guestSelftestPlan } from '../bench/windows/uc3f-selftest.mjs';
import { GUEST_OPERATIONS } from '../bench/windows/uc3f-collect.mjs';
import { readFileSync } from 'node:fs';

test('typing metadata is opt-in and outside the 27 lifecycle jobs', () => {
  assert.equal(guestSelftestPlan().length, 27);
  assert.equal(guestSelftestPlan().some(j => j.typingDiagnostic), false);
  assert.deepEqual(guestDiagnosticPlan().find(j => j.id === 'diagnostic-typing-fixtures'),
    { id: 'diagnostic-typing-fixtures', rowId: 'person-idle', typingDiagnostic: true });
});

test('product focus projection retains counts and roles while excluding text and names', () => {
  assert.deepEqual(typingReadMetadata({ focusedElement: null, partialTree: false,
    text: 'Window: private\n0 standard window (focused)\n\t1 text entry area PRIVATE (focused), ID: SECRET\n\t2 group (focused)\n\t3 button (focused)\n' }),
  { focusedElement: null, partialTree: false, focusedRows: [
    { depth: 0, index: 0, role: 'standard window' }, { depth: 1, index: 1, role: 'text entry area' },
    { depth: 1, index: 2, role: 'group' }, { depth: 1, index: 3, role: 'other' },
  ] });
});

test('typing diagnostic reads only an owned tree and cannot inject input or collect document text', () => {
  assert.equal(GUEST_OPERATIONS.includes(TYPING_DIAGNOSTIC), true);
  assert.equal(TYPING_DIAGNOSTIC.match(/WindowIdentity \$r.fixture/g)?.length, 2);
  assert.match(TYPING_DIAGNOSTIC, /GetGUIThreadInfo/);
  assert.match(TYPING_DIAGNOSTIC, /GetSupportedPatterns/);
  assert.match(TYPING_DIAGNOSTIC, /ProcessId -ne \$r.fixture.pid/);
  assert.doesNotMatch(TYPING_DIAGNOSTIC, /SendInput|PostMessage|SendMessage|SetFocus|SetForegroundWindow|\.Invoke\(|\.Select\(|\.SetValue\(|\.GetText\(|\.Current\.Name|CurrentValue|\.Text\b/);
});
