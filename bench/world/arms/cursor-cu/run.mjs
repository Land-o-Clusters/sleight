import { CURSOR_PIN, requireOwnerFree } from './contract.mjs';
import { detectRun } from './state.mjs';
import { scrubCursor } from './scrub.mjs';

export async function runDesktop(plan, { driver, signal, now = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)), onEvent } = {}) {
  if (!driver) throw Error('Cursor desktop driver is required');
  let opened = false, submitted = false, completed = false, clean = true, found, pinnedRun, reason, submittedAt, bound;
  let lastState;
  const seenTools = new Map();
  try {
    requireOwnerFree(plan);
    signal?.throwIfAborted();
    opened = true; clean = false; await driver.open(plan, { signal });
    bound = await driver.setup(plan, { signal });
    signal?.throwIfAborted();
    await driver.submit(plan, { signal, onSubmit: () => { submittedAt = now(); submitted = true; } });
    if (!submitted) throw Error('Cursor driver did not record its submit boundary');
    for (;;) {
      signal?.throwIfAborted();
      await driver.guard?.(plan);
      found = detectRun(await driver.readState(), { prompt: plan.prompt, submittedAt, baselineIds: bound.baselineIds,
        calibration: driver.calibration, ...pinnedRun });
      if (found.started && !pinnedRun) pinnedRun = { composerId: found.composerId, generationId: found.generationId };
      if (found.started && onEvent) {
        const tools = scrubCursor(found.tools), changed = [];
        for (const [i, tool] of tools.entries()) {
          const key = tool.toolCallId ?? tool.bubbleId ?? i, json = JSON.stringify(tool);
          if (seenTools.get(key) !== json) { changed.push(tool); seenTools.set(key, json); }
        }
        const state = JSON.stringify([tools.length, found.answer, found.ended]);
        if (state !== lastState || changed.length) {
          onEvent({ type: 'cursor_state', composerId: found.composerId, generationId: found.generationId,
            started: true, ended: found.ended, toolCount: tools.length, answer: scrubCursor(found.answer), tools: changed });
          lastState = state;
        }
      }
      if (found.ended) { completed = true; break; }
      if (now() - submittedAt >= plan.timeoutMs) throw Error('Cursor run timeout: no persisted end');
      await pause(100);
    }
  } catch (error) { reason = error.message; if (!submitted && error.cleanupConfirmed === true) { opened = false; clean = true; } }
  finally {
    if (opened) {
      if (submitted && !completed) { try { await driver.cancel(plan); } catch (error) { reason ??= error.message; } }
      try { clean = await driver.close(plan) === true; } catch (error) { reason ??= error.message; clean = false; }
      if (!clean) reason = [reason, 'Cursor selection restoration or run cancellation unverified'].filter(Boolean).join('; ');
    }
  }
  reason = scrubCursor(reason);
  return { type: 'result', is_error: !!reason || !completed, result: found?.answer ?? '', reason, groupClean: clean,
    ...(reason && !/Cursor run timeout/.test(reason) && { safetyStop: reason }),
    route: 'desktop', cursorVersion: CURSOR_PIN.version, cursorCommit: CURSOR_PIN.commit, cursorCdhash: CURSOR_PIN.cdhash,
    model: found?.model?.model ?? null, effort: found?.model?.effort ?? plan.effort, speed: found?.model?.speed ?? plan.speed,
    modelRequested: plan.modelLabel, composerId: found?.composerId ?? null, generationId: found?.generationId ?? null,
    submittedAt: submittedAt ?? null, recordedEndAt: completed ? found.endedAt : null,
    duration_ms: completed ? found.endedAt - submittedAt : null, setupExcluded: true,
    agentSeconds: completed ? (found.endedAt - submittedAt) / 1000 : null,
    agentTiming: { start: 'submit', end: 'persisted-clientSettleTime', startupIncluded: false },
    startDetection: found?.started ? 'persisted human prompt and generation' : null,
    endDetection: completed ? 'persisted clientSettleTime' : null,
    calls: found?.tools?.length ?? 0, tools: scrubCursor(found?.tools ?? []), usage: found?.usage ?? null,
    total_cost_usd: found?.costUsd ?? null, rawCursorUsage: null };
}
