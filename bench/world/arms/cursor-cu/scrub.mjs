const privateKey = /auth|credential|secret|password|token|cookie|account|email|(?:user|owner|org|tenant).?id|^(?:user|owner|org|organization|tenant)$|api.?key|access.?key|signature|session.?id|image|screenshot|base64|binary/i;
function safeText(text) {
  return text
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/gi, '[credential header removed]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:authorization|access[_-]?token|refresh[_-]?token|token|cookie|password|credential|secret|account[_-]?id|user[_-]?id|api[_-]?key|access[_-]?key|signature)\s*["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&;,"'<>]+)/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{160,}/g, '[opaque data removed]');
}
// Persist only scrubbed JSON. Images and opaque byte payloads have no grading value.
export function scrubCursor(value, depth = 0) {
  if (depth > 20 || value === undefined || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (typeof value === 'string') {
    if (/^data:(?:image|audio|video|application\/octet-stream)/i.test(value)) return undefined;
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(scrubCursor(JSON.parse(value), depth + 1)); } catch {}
    }
    return safeText(value);
  }
  if (Array.isArray(value)) return value.map(v => scrubCursor(v, depth + 1)).filter(v => v !== undefined);
  if (value && typeof value === 'object') {
    if (['image', 'image_url', 'input_image', 'screenshot', 'binary'].includes(value.type)) return undefined;
    if (/^(?:image|audio|video)\/|^application\/octet-stream/i.test(value.mimeType ?? value.mime_type ?? '')) return undefined;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !privateKey.test(k))
      .map(([k, v]) => [k, scrubCursor(v, depth + 1)]).filter(([, v]) => v !== undefined));
  }
  return value;
}
