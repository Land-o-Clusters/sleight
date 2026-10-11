import { analyzeTranscript } from '../turn-study.mjs';

export function callMetrics(rows) {
  const analyzed = analyzeTranscript(rows);
  return { calls: analyzed.calls, unknownWallCalls: analyzed.unknownWallCalls, unknownGapCalls: analyzed.unknownGapCalls };
}
// Allowlist publication fields. Cleanup includes document URLs and the owned scripting path.
// No driver result, prompt, code, title or stderr survives.
export function publicResult(row) {
  const result = {};
  for (const key of ['arm', 'task', 'run', 'passed', 'seconds', 'turns', 'modelMs', 'modelGapMs',
    'modelTimeSource', 'footprint', 'calls', 'unknownWallCalls', 'unknownGapCalls', 'windows',
    'exitCode', 'groupClean', 'cleanupConfirmed', 'checkCode', 'cleanupDetails', 'costUsd']) if (row[key] !== undefined) result[key] = row[key];
  return result;
}
// Normalize CLI streams to the turn study's input in memory. Never save the raw stream.
export function streamMetrics(arm) {
  let buffer = '', result, answer = '', threadId, catalog;
  const rows = [{ type: 'user', timestamp: new Date().toISOString(), message: { content: '' } }];
  const events = new Map();
  return {
    receive(chunk) {
      buffer += String(chunk);
      for (let n; (n = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        const timestamp = event.timestamp ?? new Date().toISOString();
        if (arm === 'sleight') {
          if (event.type === 'system' && event.subtype === 'init') catalog = event;
          if (event.message?.content) rows.push({ ...event, timestamp });
          if (event.type === 'result') result = event;
        } else {
          if (event.type === 'thread.started') threadId = event.thread_id;
          if (event.type === 'turn.completed') result = event;
          const item = event.item;
          if (!item) continue;
          if (item.type === 'agent_message') answer = item.text ?? answer;
          if (['command_execution', 'file_change'].includes(item.type)) events.set('forbidden', true);
          if (item.type !== 'mcp_tool_call') continue;
          let input = item.arguments ?? {}; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
          if (!events.has(item.id)) {
            events.set(item.id, true);
            rows.push({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: item.id, name: item.tool ?? 'js', input }] } });
          }
          if (event.type === 'item.completed' && Object.keys(input).length) {
            const started = rows.find(row => row.message?.content?.[0]?.id === item.id);
            if (started) started.message.content[0].input = input;
          }
          if (event.type === 'item.completed') rows.push({ type: 'user', timestamp, message: { content: [
            { type: 'tool_result', tool_use_id: item.id, content: item.result?.content ?? item.result ?? '', is_error: Boolean(item.error || item.result?.isError) },
          ] } });
        }
      }
    },
    finish() {
      const metrics = callMetrics(rows);
      return { ...metrics, result, catalog, answer: arm === 'sleight' ? result?.result ?? '' : answer, threadId,
        forbidden: events.has('forbidden'), modelMs: arm === 'sleight' ? result?.duration_api_ms ?? null : null,
        modelTimeSource: arm === 'sleight' ? 'driver duration_api_ms' : 'unavailable; modelGapMs includes host scheduling',
        modelGapMs: metrics.calls.some(c => c.modelGapMs === null) ? null : metrics.calls.reduce((s, c) => s + c.modelGapMs, 0) };
    },
  };
}
