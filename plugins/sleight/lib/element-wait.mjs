// Serialized into the engine's realm alongside the cooperative app guard.
export function elementWait({ read, parse, elements, hasIdentifier, hasLabel, expected, observe, acceptWindow = () => false }) {
  return async (selector, options = {}) => {
    const keys = selector && typeof selector === 'object' ? Object.keys(selector) : [];
    const timeoutMs = options?.timeoutMs ?? 10000;
    if (keys.length !== 1 || !['id', 'label', 'line'].includes(keys[0]) ||
        typeof selector[keys[0]] !== 'string' || !selector[keys[0]] ||
        !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000) {
      throw new Error('waitFor needs exactly one nonempty id, label or line and timeoutMs from 0 to 10000.');
    }
    const kind = keys[0], value = selector[kind];
    const match = kind === 'id' ? hasIdentifier : kind === 'label' ? hasLabel : (line, wanted) => line === wanted;
    const deadline = Date.now() + timeoutMs;
    let identity = expected, text;
    for (;;) {
      text = await read();
      const current = parse(text);
      const changed = identity && current && ['title', 'app', 'url'].some(key => current[key] !== identity[key]);
      if (!current || (changed && !acceptWindow(current, text))) {
        throw new Error('waitFor stopped: window changed or its full header is missing.\n' + text);
      }
      identity = current;
      observe(text);
      const found = [...elements(text)].filter(([, line]) => match(line, value));
      if (found.length > 1) throw new Error(`waitFor ambiguous: ${found.length} elements match ${kind} ${JSON.stringify(value)}.\n${text}`);
      if (found.length === 1) return text;
      // Never abandon an engine read: it could still be changing the engine's diff baseline.
      if (Date.now() + 250 > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms waiting for ${kind} ${JSON.stringify(value)}.\n${text}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };
}
