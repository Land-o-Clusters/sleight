// Judge the task from file checks and returned app state, never arithmetic in prose.
export function actionVerdict(events, task, judged, exit) {
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  const result = events.findLast(e => e.type === 'result');
  const servers = init?.mcp_servers;
  const own = servers?.find(s => s.name === 'plugin:sleight:computer');
  const leaked = servers?.filter(s => s.name !== 'plugin:sleight:computer');
  const uses = events.flatMap(e => e.type === 'assistant' ? e.message?.content ?? [] : []).filter(c => c.type === 'tool_use');
  const replies = events.flatMap(e => e.type === 'user' ? e.message?.content ?? [] : []).filter(c => c.type === 'tool_result');
  const successfulActions = replies.filter(r => !r.is_error && uses.some(u => u.id === r.tool_use_id && /\.(?:click|pressKey|typeText)\(/.test(u.input?.code ?? ''))).length;
  const expected = task.id === 'calculator-click' ? '391' : '1024';
  const displayEvidence = task.app === 'Calculator' ? replies.filter(r => !r.is_error).flatMap(r => {
    const text = typeof r.content === 'string' ? r.content : (r.content ?? []).map(c => c.text ?? '').join('\n');
    return [...text.matchAll(/text Description: Edit field, Value: ([^\r\n]+)/g)].map(m => m[1]);
  }).filter(v => v.replace(/[,\u202f\u00a0 ]/g, '') === expected) : undefined;
  return { servers, successfulActions, displayEvidence,
    passed: exit.code === 0 && !result?.is_error && !exit.cancelled && !exit.timeout && own?.status === 'connected' && !leaked?.length && judged === true && successfulActions > 0 && (task.app !== 'Calculator' || displayEvidence.length > 0) };
}
