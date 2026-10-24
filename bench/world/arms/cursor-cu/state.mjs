import { existsSync } from 'node:fs';
import { ordinaryPath, resolveModel } from './contract.mjs';

export async function retryBusy(read, { now = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 2000 } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (!/database (?:is )?(?:locked|busy)/i.test(error.message) || now() >= deadline) throw error;
      await pause(Math.min(100, Math.max(1, deadline - now())));
    }
  }
}

export function readCursorState(paths, { exists = existsSync, open } = {}) {
  ordinaryPath(paths.database);
  if (!exists(paths.database)) return { composers: [], bubbles: {} };
  if (!open) throw Error('Cursor state reader needs a readonly SQLite opener');
  const db = open(paths.database, { readOnly: true, timeout: 100 });
  try {
    // No auth values, file contents or unrelated app state are selected.
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
    const composers = rows.map(r => JSON.parse(String(r.value)));
    const bubbles = {};
    for (const c of composers) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(c.composerId)) throw Error('unsupported Cursor composer id');
      bubbles[c.composerId] = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${c.composerId}:%'`).all()
        .map(r => JSON.parse(String(r.value)));
    }
    return { composers, bubbles };
  } finally { db.close(); }
}

export async function profileState(paths) {
  const { DatabaseSync } = await import('node:sqlite');
  return retryBusy(() => readCursorState(paths, { open: (file, opts) => new DatabaseSync(file, opts) }));
}

export function pendingAppApprovals(snapshot, composerId) {
  const composer = snapshot.composers.find(c => c.composerId === composerId);
  if (!composer || !composer.latestChatGenerationUUID) return [];
  const byId = new Map((snapshot.bubbles[composerId] ?? []).map(b => [b.bubbleId, b]));
  const ordered = (composer.fullConversationHeadersOnly ?? []).map(h => byId.get(h.bubbleId)).filter(Boolean);
  const human = ordered.findLastIndex(b => b.type === 1);
  if (human < 0) return [];
  const rows = ordered.slice(human + 1).filter(b => b.type === 2).map(b => b.toolFormerData).filter(Boolean);
  const out = [];
  for (const row of rows) {
    if (!['pending', 'awaiting-approval', 'needs_user_approval'].includes(row.status) && row.approval?.status !== 'pending') continue;
    const app = row.additionalData?.computerUseApp ?? row.operation?.details?.computerUseApp ?? row.approval?.operation?.details?.computerUseApp;
    if (typeof app?.bundleId !== 'string' || typeof app.name !== 'string' || !row.toolCallId) continue;
    out.push({ bundleId: app.bundleId, name: app.name, toolCallId: row.toolCallId, generationId: composer.latestChatGenerationUUID });
  }
  return out;
}

export function detectRun(snapshot, { prompt, submittedAt, baselineIds = [], composerId, generationId, calibration, allowUncalibratedModel = false } = {}) {
  const candidates = snapshot.composers.filter(c => (!composerId || c.composerId === composerId) && !baselineIds.includes(c.composerId) &&
    (snapshot.bubbles[c.composerId] ?? []).some(b => b.type === 1 && b.text === prompt));
  if (candidates.length > 1) throw Error('Cursor run state is ambiguous');
  const c = candidates[0];
  if (!c) return { started: false, ended: false };
  const headers = c.fullConversationHeadersOnly;
  if (!Array.isArray(headers)) throw Error('unsupported Cursor conversation headers');
  const byId = new Map((snapshot.bubbles[c.composerId] ?? []).map(b => [b.bubbleId, b]));
  const ordered = headers.map(h => byId.get(h.bubbleId)).filter(Boolean);
  const human = ordered.findLastIndex(b => b.type === 1 && b.text === prompt);
  const responses = ordered.slice(human + 1).filter(b => b.type === 2);
  const startedAt = responses.map(b => b.timingInfo?.clientStartTime).find(Number.isFinite);
  if (human < 0 || !Number.isFinite(startedAt) || startedAt < submittedAt) return { started: false, ended: false };
  const turn = c.latestChatGenerationUUID;
  if (!turn || generationId && generationId !== turn) throw Error('Cursor generation binding changed');
  const model = resolveModel(c.modelConfig, { modelId: calibration?.selection?.model?.model ?? (allowUncalibratedModel ? c.modelConfig?.selectedModels?.[0]?.modelId : undefined) });
  const last = responses.at(-1), endedAt = last?.timingInfo?.clientSettleTime;
  const ended = c.status === 'completed' && (!c.generatingBubbleIds || c.generatingBubbleIds.length === 0) &&
    Number.isFinite(endedAt) && endedAt >= startedAt;
  const tools = responses.flatMap(b => b.toolFormerData ? [{ ...b.toolFormerData, bubbleId: b.bubbleId }] : []);
  return { started: true, ended, composerId: c.composerId, generationId: turn, startedAt, model,
    ...(ended && { endedAt }), answer: last?.text ?? '', tools,
    // Cursor's contextTokensUsed is context occupancy, not billed usage. Preserve unknowns.
    usage: null, costUsd: null, rawUsage: c.usageData ?? null };
}
