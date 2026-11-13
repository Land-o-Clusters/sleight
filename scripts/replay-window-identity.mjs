// Offline CE8 evidence audit. The counterfactual explicitly uses fake OS metadata.
// This imports no benchmark runner and never starts a native helper or app.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from '../tests/helpers/window-identity-fixture.mjs';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';

export const CE8_STEPS = ['calculator-menu-r2', 'textedit-save-r2', 'textedit-drag-r2',
  'preview-read-r2', 'textedit-calculator-r2', 'word-edit-r2'];
const warning = /sleight-warning: native window identity.*inconclusive/;
const textOf = reply => (reply?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export function replayWindowIdentity(directory) {
  const rows = CE8_STEPS.map(step => {
    const data = JSON.parse(readFileSync(resolve(directory, `${step}.json`), 'utf8'));
    const receipt = data.results[0].out.entryTurns[0].harnessNewChat;
    const text = textOf(receipt.reply);
    const title = /^Window: "([^"]*)", App: Cursor\./m.exec(text)?.[1];
    if (!title || !warning.test(text)) throw new Error(`Missing CE8 Cursor warning reply: ${step}`);
    const fields = new Set();
    const collect = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) { fields.add(key); collect(child); }
    };
    collect(receipt.reply);
    const recordedFactFields = ['kCGWindowNumber', 'kCGWindowOwnerPID', 'kCGWindowBounds',
      'kCGWindowName', 'AXPosition', 'AXSize', 'processStart'].filter(key => fields.has(key));
    // These recordings contain engine replies, not a paired OS metadata sample.
    // Finding no structured fact fields prevents any retrospective certification.
    if (recordedFactFields.length) throw new Error(`Recorded metadata needs manual pairing review: ${step}`);
    const recordedFacts = false;
    const target = { appId: receipt.bundleId, title, url: null };
    const fake = inspect(target, [null], 0, true, [], (_app, windows) => {
      windows[0].AXTitle = title; windows[0].missing = ['AXWindowNumber', 'AXDocument'];
    });
    let fakeWarning = false;
    try { verifyWindowIdentity(target, fake); } catch { fakeWarning = true; }
    const unreadable = inspect(target, [null], 0, true, [], (_app, windows, _list, runtime) => {
      windows[0].AXTitle = title; windows[0].missing = ['AXWindowNumber', 'AXDocument']; runtime.cgUnavailable = true;
    });
    let unreadableWarning = false;
    try { verifyWindowIdentity(target, unreadable); } catch { unreadableWarning = true; }
    return { step, recordedWarning: true, recordedFacts, recordedFactFields, fakeReadableWarning: fakeWarning,
      fakeUnreadableWarning: unreadableWarning, degradedRead: /UI unverified|degraded read/.test(text) };
  });
  return { recordedReplies: rows.length, recordedWarnings: rows.filter(r => r.recordedWarning).length,
    factQualifiedHistoricalReplays: rows.filter(r => r.recordedFacts).length,
    historicalWarningOutcome: 'unverified: recorded CG-to-AX and process-start facts absent',
    fakeReadableWarnings: rows.filter(r => r.fakeReadableWarning).length,
    fakeUnreadableWarnings: rows.filter(r => r.fakeUnreadableWarning).length,
    degradedReadReplies: rows.filter(r => r.degradedRead).length, rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/replay-window-identity.mjs BANK_DIRECTORY');
  console.log(JSON.stringify(replayWindowIdentity(process.argv[2]), null, 2));
}
