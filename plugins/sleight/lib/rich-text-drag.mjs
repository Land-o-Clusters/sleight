import { fileURLToPath } from 'node:url';
import { createNativeClipboardIO } from './clipboard.mjs';

// A collected child cannot post again, but Paste already queued in TextEdit may still run.
// Keep ambiguous input and unreceipted writes reserved. Original bytes remain in memory.
let pending, recovery;
const sameItems = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function releaseHeld(held) {
  pending = undefined;
  try { await held.io({ op: 'release' }); } finally { await held.io.close?.(); }
}
async function failedWrite(held, error) {
  if (error.clipboardMutation === true && Number.isInteger(error.clipboardCount)) {
    held.ownedCount = error.clipboardCount; return;
  }
  if (error.clipboardMutation === false && Number.isInteger(error.clipboardCount)) {
    // The native helper receipted its refusal before clearing, so a changed count is foreign.
    if (error.clipboardCount !== held.ownedCount) { await releaseHeld(held); return; }
  }
  held.ambiguousWrite = true;
  // Establish a fence after the failed helper has been collected. This generation could be
  // our own unreceipted clear, so never classify it as a user's newer copy.
  try { held.fence = (await held.io({ op: 'read' })).count; } catch {}
}
export async function recoverPendingRichTextMove() {
  if (!pending) return true;
  if (recovery) return recovery;
  const held = pending;
  recovery = (async () => {
    if (held.waitForExit) {
      let status;
      try { status = await held.runLocal('drag.js', { op: 'rich-paste-status', pid: held.pid }, { cleanup: true }); } catch { return false; }
      if (!status.ok || status.terminated !== true) return false;
      held.waitForExit = false;
    }
    if (held.ambiguousWrite) {
      let current;
      try { current = await held.io({ op: 'read' }); } catch { return false; }
      if (sameItems(current.items, held.original.items)) { await releaseHeld(held); return true; }
      if (held.fence === undefined) { held.fence = current.count; return false; }
      if (current.count !== held.fence) { await releaseHeld(held); return true; }
      return false;
    }
    try { await held.io({ op: 'write', expectedCount: held.ownedCount, items: held.original.items }); }
    catch (error) { await failedWrite(held, error); return !pending; }
    await releaseHeld(held);
    return true;
  })();
  try { return await recovery; } finally { recovery = undefined; }
}
function scheduleRecovery() {
  const timer = setTimeout(async () => {
    try { await recoverPendingRichTextMove(); } catch {}
    if (pending) scheduleRecovery();
  }, 5000);
  timer.unref?.();
}
export async function drainRichTextMoves({ wait = () => new Promise(resolve => setTimeout(resolve, 5000)),
  notice = message => console.error(message) } = {}) {
  if (pending) notice('sleight: clipboard recovery is pending. Keep this relay running. Save other work and quit TextEdit for unconfirmed Paste; an unreceipted clipboard write requires a later explicit copy to replace it.');
  while (!(await recoverPendingRichTextMove())) await wait();
}

// The first child prepares RTF without input. The second revalidates the plan before pasting.
export async function runRichTextMove(args, plan, runLocal,
  io = createNativeClipboardIO(fileURLToPath(new URL('./clipboard.js', import.meta.url)))) {
  let reserved = false, original, ownedCount, inputStarted = false, retained = false, disposed = false;
  let result = { ok: false, path: 'accessibility' };
  const fail = error => { result = { ...result, ok: false, error: [result.error, String(error.message || error)].filter(Boolean).join('; ') }; };
  const retain = async (waitForExit, error) => {
    const held = pending = { io, original, ownedCount, runLocal, pid: plan.pid, waitForExit };
    retained = true;
    if (error) await failedWrite(held, error);
    retained = pending === held;
    if (!retained) disposed = true;
    if (retained) {
      result.clipboardRestored = false; result.clipboardRecoveryRequired = true;
      fail(waitForExit
        ? 'Paste consumption is unconfirmed. Original clipboard bytes remain private in sleight memory. Save other work and quit TextEdit before continuing; restoration waits for that process to exit. Keep this relay running.'
        : 'Clipboard restoration is unconfirmed. Original bytes remain private in sleight memory. Keep this relay running. If the write has no receipt, a later explicit Copy replaces the uncertain clipboard and ends recovery without overwriting that new copy.');
      scheduleRecovery();
    }
  };
  try {
    await recoverPendingRichTextMove();
    if (pending) throw new Error('Previous clipboard recovery is pending. Keep that relay running and follow its recovery advice before continuing.');
    if (!Number.isInteger(plan.pid) || plan.pid <= 0) throw new Error('Rich text preparation did not identify the target process; nothing was changed');
    await io({ op: 'acquire' }); reserved = true;
    original = await io({ op: 'read' });
    try {
      ownedCount = (await io({ op: 'write', expectedCount: original.count, items: [[{ type: 'public.rtf', data: plan.rtf }]] })).count;
    } catch (error) {
      if (error.clipboardMutation && error.clipboardCount === original.count + 1) ownedCount = error.clipboardCount;
      else if (error.clipboardMutation !== false) await retain(false, error);
      throw error;
    }
    inputStarted = true;
    result = { ...await runLocal('drag.js', { ...args, windowId: plan.windowId, richTextMove: { ...plan, clipboardCount: ownedCount } }), path: 'accessibility' };
    if (result.richTextMove) { delete result.richTextMove; throw new Error('Rich text preparation changed before input; read the window again'); }
  } catch (error) { fail(error); }
  finally {
    if (original && ownedCount !== undefined && !retained) {
      if (inputStarted && !['consumed', 'not-posted'].includes(result.richPasteState)) await retain(true);
      else {
        try { await io({ op: 'write', expectedCount: ownedCount, items: original.items }); result.clipboardRestored = true; }
        catch (error) { result.clipboardRestored = false; fail(error); await retain(false, error); }
      }
    }
    try { if (reserved && !retained && !disposed) await io({ op: 'release' }); } catch (error) { fail(error); }
    try { if (!retained && !disposed) await io.close?.(); } catch (error) { fail(error); }
  }
  return result;
}
