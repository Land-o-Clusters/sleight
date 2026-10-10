import { fileURLToPath } from 'node:url';
import { createNativeClipboardIO } from './clipboard.mjs';

// A collected child cannot post again, but Paste already queued in TextEdit may still run.
// Keep original bytes private while recovery is pending, with a ten-second reservation cap.
let pending;
const sameItems = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function richPasteChildState(stderr, truncated = false) {
  return String(stderr ?? '').split(/\r?\n/).includes('sleight:rich-paste-posted') ? 'pending' : truncated ? 'unknown' : 'not-posted';
}
async function releaseHeld(held) {
  held.timers.clearTimeout(held.deadline); held.timers.clearTimeout(held.poll);
  if (pending === held) pending = undefined;
  try { await held.io({ op: 'release' }); } finally { await held.io.close?.({ timeoutMs: 250 }); held.finishRecovery(true); }
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
  const held = pending;
  if (held.abandoned) { await held.finishing; return true; }
  if (held.recovery) return Promise.race([held.recovery, held.finished]);
  held.recovery = (async () => {
    if (held.waitForExit) {
      let status;
      try { status = await held.runLocal('drag.js', { op: 'rich-paste-status', pid: held.pid }, { cleanup: true }); } catch { return false; }
      if (!status.ok || status.terminated !== true) return false;
      held.waitForExit = false;
    }
    if (held.abandoned) return true;
    if (held.ambiguousWrite) {
      let current;
      try { current = await held.io({ op: 'read' }); } catch { return false; }
      if (held.abandoned) return true;
      if (sameItems(current.items, held.original.items)) { await releaseHeld(held); return true; }
      if (held.fence === undefined) { held.fence = current.count; return false; }
      if (current.count !== held.fence) { await releaseHeld(held); return true; }
      return false;
    }
    try { await held.io({ op: 'write', expectedCount: held.ownedCount, items: held.original.items }); }
    catch (error) { if (!held.abandoned) await failedWrite(held, error); return !pending; }
    if (held.abandoned) return true;
    await releaseHeld(held);
    return true;
  })();
  const attempt = held.recovery;
  try { return await Promise.race([attempt, held.finished]); }
  finally { if (held.recovery === attempt) held.recovery = undefined; }
}
function scheduleRecovery(held) {
  held.poll = held.timers.setTimeout(async () => {
    try { await recoverPendingRichTextMove(); } catch {}
    if (pending === held && !held.abandoned) scheduleRecovery(held);
  }, 5000);
  held.poll.unref?.();
}
async function expireHeld(held) {
  if (pending !== held) return;
  if (held.finishing) return held.finishing;
  held.abandoned = true;
  held.timers.clearTimeout(held.poll); held.timers.clearTimeout(held.deadline);
  held.finishing = (async () => {
    let restored = false, stopped = false, timer;
    const restore = async () => {
      try {
        const current = await held.io({ op: 'read' });
        if (stopped) return;
        if (sameItems(current.items, held.original.items)) { restored = true; return; }
        // Both bytes and generation must still be ours. Never overwrite a newer identical Copy.
        if (current.count !== held.stagedCount || !sameItems(current.items, held.stagedItems)) return;
        await held.io({ op: 'write', expectedCount: current.count, items: held.original.items });
        if (!stopped) restored = true;
      } catch {}
    };
    const deadline = new Promise(resolve => { timer = held.timers.setTimeout(resolve, 250); });
    try { await Promise.race([restore(), deadline]); }
    finally { stopped = true; held.timers.clearTimeout(timer); }
    // Start at nine seconds: 250 ms for conditional restoration, then at most 750 ms
    // to terminate and collect the helper before its SQLite reservation is released.
    try {
      if (held.io.close) await held.io.close({ timeoutMs: 250 });
      else await held.io({ op: 'release' });
    } finally {
      held.outcome = { clipboardLeft: !restored };
      if (pending === held) pending = undefined;
      held.finishRecovery(true);
      held.notice(restored
        ? 'sleight: clipboard restored after the ten-second recovery limit; shared clipboard lock released. TextEdit Paste consumption remains unconfirmed. Read the window before continuing.'
        : 'sleight: clipboard left as it is after the ten-second recovery limit; original restoration was not confirmed, the private snapshot was discarded, and the shared clipboard lock was released. Read the window before continuing.');
      held.original = undefined;
    }
    return held.outcome;
  })();
  return held.finishing;
}
const queued = [];
// A recovery that ends between calls reaches Claude in its next tool result, and stderr for the logs.
export const queueRichTextNotice = message => { queued.push(message); console.error(message); };
export const takeRichTextNotices = () => queued.splice(0);
export async function drainRichTextMoves({ timeoutMs = 3000, wait = () => new Promise(resolve => setTimeout(resolve, 100)),
  notice = message => console.error(message) } = {}) {
  if (!pending) return { clipboardLeft: false };
  const held = pending;
  let timer, expired = false;
  const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, timeoutMs); });
  const recover = async () => {
    while (!expired && !(await recoverPendingRichTextMove())) await wait();
  };
  try { await Promise.race([recover(), deadline]); }
  finally { clearTimeout(timer); }
  if (pending !== held) return held.outcome ?? { clipboardLeft: false };
  if (held.finishing) return held.finishing;
  held.abandoned = true;
  held.timers.clearTimeout(held.deadline); held.timers.clearTimeout(held.poll);
  pending = undefined;
  notice('sleight: clipboard was left as it is after the shutdown recovery deadline. An unconfirmed TextEdit Paste may still be queued; original clipboard restoration was not confirmed and its private snapshot will be discarded.');
  // close collects any native writer before releasing its SQLite reservation.
  if (held.io.close) await held.io.close({ timeoutMs: 250 });
  else await held.io({ op: 'release' });
  held.finishRecovery(true);
  return { clipboardLeft: true };
}

// The first child prepares RTF without input. The second revalidates the plan before pasting.
export async function runRichTextMove(args, plan, runLocal,
  io = createNativeClipboardIO(fileURLToPath(new URL('./clipboard.js', import.meta.url))),
  { timers = { setTimeout, clearTimeout }, notice = queueRichTextNotice } = {}) {
  let reserved = false, original, ownedCount, inputStarted = false, retained = false, disposed = false;
  // The helper reports the types macOS added to the staged RTF, which recovery compares against.
  let staged = [[{ type: 'public.rtf', data: plan.rtf }]];
  let result = { ok: false, path: 'accessibility' };
  const fail = error => { result = { ...result, ok: false, error: [result.error, String(error.message || error)].filter(Boolean).join('; ') }; };
  const retain = async (waitForExit, error) => {
    const held = pending = { io, original, ownedCount, stagedCount: ownedCount,
      stagedItems: staged, runLocal, pid: plan.pid, waitForExit, timers, notice };
    held.finished = new Promise(resolve => { held.finishRecovery = resolve; });
    retained = true;
    held.deadline = timers.setTimeout(() => expireHeld(held).catch(() => {}), 9000);
    held.deadline.unref?.();
    if (error) await failedWrite(held, error);
    retained = pending === held;
    if (!retained) disposed = true;
    if (retained) {
      result.clipboardRestored = false; result.clipboardRecoveryRequired = true;
      fail(waitForExit
        ? 'Paste consumption is unconfirmed. Original clipboard bytes remain private for at most ten seconds. At the limit, restoration requires the exact staged bytes and generation; otherwise the clipboard is left as it is. Read the window before continuing.'
        : 'Clipboard restoration is unconfirmed. Original bytes remain private for at most ten seconds. Recovery never overwrites a newer Copy; the shared clipboard lock is released at the limit.');
      scheduleRecovery(held);
    }
  };
  try {
    await recoverPendingRichTextMove();
    if (pending) throw new Error('Previous clipboard recovery is pending. Keep that relay running and follow its recovery advice before continuing.');
    if (!Number.isInteger(plan.pid) || plan.pid <= 0) throw new Error('Rich text preparation did not identify the target process; nothing was changed');
    await io({ op: 'acquire' }); reserved = true;
    original = await io({ op: 'read' });
    try {
      const written = await io({ op: 'write', expectedCount: original.count, items: staged });
      ownedCount = written.count;
      if (Array.isArray(written.items)) staged = written.items;
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
