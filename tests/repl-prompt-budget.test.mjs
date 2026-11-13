import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAC_REPL_DOCS, replDocumentation } from '../plugins/sleight/lib/repl/docs.mjs';
import { MAC_SAFETY_UNAVAILABLE, REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';
import { TRUNCATED_READ_NOTICE, MAC_HANDLE_LINE } from '../plugins/sleight/lib/repl/cua.mjs';

test('Mac REPL notices have a separate budget and content pin', t => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/prompt-default.json', import.meta.url), 'utf8'));
  const notices = [MAC_REPL_DOCS, MAC_SAFETY_UNAVAILABLE, REPL_NODE_UNSUPPORTED, TRUNCATED_READ_NOTICE, 'Mac JavaScript session reset.', MAC_HANDLE_LINE];
  assert.equal(createHash('sha256').update(JSON.stringify(notices)).digest('hex'), baseline.macReplNotices);
  assert.ok(Buffer.byteLength(MAC_REPL_DOCS) <= 4000);
  assert.ok(Buffer.byteLength(notices.join('\n')) <= 4500);
  assert.equal(replDocumentation('darwin'), MAC_REPL_DOCS);
  assert.throws(() => replDocumentation('linux'), /PLATFORM/);
  assert.doesNotMatch(MAC_REPL_DOCS, /UI Automation|PrintWindow|Notepad|HWND|confirmation: "unconfirmed"/);
  t.diagnostic(`Mac docs ${Buffer.byteLength(MAC_REPL_DOCS)} bytes; notices ${Buffer.byteLength(notices.join('\n'))} bytes`);
});
