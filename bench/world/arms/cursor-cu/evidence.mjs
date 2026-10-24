import { createHash } from 'node:crypto';

const browserNames = new Set(['com.google.Chrome', 'Google Chrome', 'Chrome']);
function browserBound(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) return value.some(v => browserBound(v, depth + 1));
  for (const key of ['app', 'appId', 'appName', 'application', 'applicationId', 'bundleId', 'bundleIdentifier', 'appBundleId', 'targetApp'])
    if (browserNames.has(value[key])) return true;
  return ['actions', 'action', 'app', 'application', 'result', 'value', 'data'].some(key => browserBound(value[key], depth + 1));
}

// Cursor's persisted ToolFormer rows, not assistant prose. Both desktop tool encodings
// seen in the shipped interface are accepted; unknown/pending/error rows prove nothing.
export function cursorBrowserCalls(event) {
  if (event.type !== 'cursor_state' || !event.composerId || !event.generationId) return [];
  return (event.tools ?? []).flatMap(row => {
    const wire = row.toolCall?.tool ?? row.toolCall;
    const computer = row.tool === 'computer_use' || wire?.case === 'computerUseToolCall';
    const params = row.params?.value ?? row.params ?? wire?.value?.args ?? row.input;
    const mcp = /(?:^|__)cursor[-_]computer[-_]use(?:__|$)/.test(row.toolName ?? row.name ?? '') ||
      params?.providerIdentifier === 'cursor-computer-use';
    if (!computer && !mcp) return [];
    const payload = wire?.case === 'computerUseToolCall' ? wire.value : row;
    const result = row.result?.value ?? row.result ?? payload?.result;
    const outcome = result?.result?.case ?? result?.case;
    if (row.isError || row.error || result?.is_error || result?.isError || result?.error || result?.success === false || outcome === 'error' ||
      !result || !(row.status === 'completed' || outcome === 'success') || ['error', 'cancelled', 'pending', 'running'].includes(row.status)) return [];
    const text = JSON.stringify({ params, result });
    // Screen-coordinate work may omit app metadata. Only explicitly browser-bound calls
    // count; a shell call or an assistant mentioning a URL cannot establish a visit.
    if (!browserBound(params) && !browserBound(result)) return [];
    const id = row.toolCallId ?? row.bubbleId ?? createHash('sha256').update(JSON.stringify(row)).digest('hex');
    return [{ id: `${event.composerId}:${event.generationId}:${id}`, text }];
  });
}
