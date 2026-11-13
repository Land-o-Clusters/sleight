// Serialized into the engine realm. A stale first AX snapshot is not evidence
// that typing missed. Read once more, without repeating the input, only when
// the full observation, including focus, still matches the pre-input tree.
export async function settleTyping(read, before, text, typed, current = () => true, limit = 700) {
  const full = value => typeof value === 'string' && /^Window: /m.test(value) &&
    /^\d+ (?:standard window|window|sheet|dialog)\b/m.test(value) &&
    !/…\(\d+\)|sleight: (?:lines changed|no change since)/.test(value);
  if (limit < 700 || !full(before) || !full(text) || typeof typed !== 'string' || !typed.replace(/[\r\n]/g, '').length ||
      /\bsecure\b|\bpassword\b/i.test(before) || before.trim() !== text.trim() ||
      typeof setTimeout !== 'function' || !current()) return text;
  await new Promise(resolve => setTimeout(resolve, 700));
  if (!current()) return text;
  // IN2: finish an engine read once started. The added wait is bounded; the
  // read itself keeps the engine's normal timeout and failure behavior.
  const next = await read();
  return typeof next === 'string' ? next : text;
}
