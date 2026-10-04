// Judge the last Calculator UI state, not the agent's prose or echoed code.
export function judgePreapproval(mode, exit, events, timedOut = false, messages = []) {
  const grants = events.filter(event => event.direction === 'preapproved-app');
  const approvals = new Set();
  let declines = 0, cancels = 0;
  for (const event of events) {
    if (event.direction === 'to-client' && event.msg.method === 'elicitation/create' &&
        event.msg.params?._meta?.connector_id === 'computer-use' &&
        event.msg.params._meta.tool_params?.app === 'com.apple.calculator') approvals.add(event.msg.id);
    if (event.direction === 'to-server' && approvals.has(event.msg.id)) {
      if (event.msg.result?.action === 'decline') declines++;
      if (event.msg.result?.action === 'cancel') cancels++;
    }
  }
  const results = events.filter(event => event.direction === 'to-client' && event.msg.result?.content);
  const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const reported = results.some(event => text(event.msg.result).includes('pre-approved by the user'));
  const calculator = results.at(-1);
  const calls = new Map();
  let clicked = false, finalRead = false, finalContent;
  for (const message of messages) {
    for (const block of message.message?.content ?? []) {
      if (message.type === 'assistant' && block.type === 'tool_use' && block.name === 'mcp__sleight__js') calls.set(block.id, block.input?.code ?? '');
      if (message.type === 'user' && block.type === 'tool_result') {
        const code = calls.get(block.tool_use_id) ?? '';
        if (calls.has(block.tool_use_id)) { finalRead = false; finalContent = undefined; }
        if (!block.is_error && /\bapp\.click\s*\(/.test(code)) clicked = true;
        if (clicked && !block.is_error && /^\s*await app\.getAXState\(\{\s*disableDiffing\s*:\s*true\s*\}\)\s*;?\s*$/.test(code)) {
          finalRead = true;
          finalContent = typeof block.content === 'string' ? block.content : text({ content: block.content ?? [] });
        }
      }
    }
  }
  // Trace strings are shortened for debugging. Judge the corresponding full
  // tool result from Claude's stream, where the current edit field is intact.
  const displayed = calculator && /^Window: .*App: Calculator\.?$/m.test(text(calculator.msg.result)) && !calculator.msg.result.isError &&
    /^Window: .*App: Calculator\.?$/m.test(finalContent ?? '') &&
    /^\s*\d+ (?:text entry area .*?Value: |text Description: Edit field, Value: )144\s*$/m.test(finalContent ?? '');
  const passed = exit.code === 0 && !timedOut && (mode === 'listed'
    ? grants.length > 0 && reported && Boolean(displayed) && clicked && finalRead
    : grants.length === 0 && declines + cancels > 0 && results.some(event =>
      text(event.msg.result).includes('Computer Use was not approved to use Calculator')));
  return { grants: grants.length, declines, cancels, reported, passed };
}
