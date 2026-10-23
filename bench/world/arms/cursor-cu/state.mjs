import { existsSync } from 'node:fs';
import { ordinaryPath, resolveModel } from './contract.mjs';

export function readCursorState(paths, { exists = existsSync, open } = {}) {
  ordinaryPath(paths.database);
  if (!exists(paths.database)) return { composers: [], bubbles: {} };
  if (!open) throw Error('Cursor state reader needs a readonly SQLite opener');
  const db = open(paths.database, { readOnly: true });
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
  return readCursorState(paths, { open: (file, opts) => new DatabaseSync(file, opts) });
}

export function detectRun(snapshot, { prompt, submittedAt, baselineIds = [], composerId, generationId } = {}) {
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
  const model = resolveModel(c.modelConfig);
  const last = responses.at(-1), endedAt = last?.timingInfo?.clientSettleTime;
  const ended = c.status === 'completed' && (!c.generatingBubbleIds || c.generatingBubbleIds.length === 0) &&
    Number.isFinite(endedAt) && endedAt >= startedAt;
  const tools = responses.flatMap(b => b.toolFormerData ? [b.toolFormerData] : []);
  return { started: true, ended, composerId: c.composerId, generationId: turn, startedAt, model,
    ...(ended && { endedAt }), answer: last?.text ?? '', tools,
    // Cursor's contextTokensUsed is context occupancy, not billed usage. Preserve unknowns.
    usage: null, costUsd: null, rawUsage: c.usageData ?? null };
}
