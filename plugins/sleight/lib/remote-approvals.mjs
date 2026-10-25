// Only authenticated prompt.submit text enters parseTypedApps. Catalog data is app metadata, never page or model text.
const fold = value => value.trim().replace(/\.app$/i, '').toLocaleLowerCase('en-US');
const names = app => [...new Set([app.name, ...(app.names ?? [])].filter(n => typeof n === 'string' && n.trim()))];
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f",]/.test(name);
const installed = apps => (Array.isArray(apps) ? apps : []).filter(a => typeof a?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(a.id) && safeName(a.name));
export function resolveApp(name, apps) {
  if (typeof name !== 'string') return undefined;
  const matches = installed(apps).filter(a => names(a).some(n => fold(n) === fold(name)));
  return matches.length === 1 ? matches[0] : undefined;
}
export function parseTypedApps(text, apps) {
  if (typeof text !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return [];
  const granted = new Set();
  for (const line of [text.split(/\r?\n/, 1)[0]]) {
    const match = /^allow[ \t]+(.+)$/i.exec(line.trim());
    if (!match) continue;
    // Resolve the whole phrase first, for an app whose name itself includes "and".
    const whole = resolveApp(match[1], apps);
    const parts = whole ? [whole] : match[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map(n => resolveApp(n, apps));
    if (parts.length && parts.every(Boolean)) for (const app of parts) granted.add(app.id);
  }
  return [...granted];
}
export function isPresent(state, origin) {
  if (origin === 'bridge') return false;
  // Missing metadata preserves the host's existing physical-card behavior.
  if (typeof state?.locked !== 'boolean' || !Number.isFinite(state.idleSeconds) || state.idleSeconds < 0) return true;
  return !state.locked && state.idleSeconds < 120;
}
const implied = [
  ['mailto:', /\b(?:e-?mail|mail to\s+\S+)\b/i], ['.docx', /\.docx\b|\bWord doc(?:ument)?\b/i],
  ['.xlsx', /\.xlsx\b|\b(?:spreadsheet|workbook)\b/i], ['.pptx', /\.pptx\b|\b(?:slides|deck|presentation)\b/i],
  ['.ics', /\.ics\b|\b(?:calendar invite|meeting invite|schedule a meeting)\b/i],
];
export function predictApps(text, catalog = {}) {
  const apps = installed(catalog.apps), found = new Map();
  const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inContext = name => {
    const n = escaped(name.replace(/\.app$/i, ''));
    return new RegExp(`(?:\\b(?:in|with|using|open|app)\\s+${n}(?:\\.app)?(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])${n}(?:\\.app)?\\s+app\\b)`, 'iu').test(text);
  };
  for (const app of apps) if (names(app).some(n => inContext(n) && resolveApp(n, apps)?.id === app.id)) found.set(app.id, app);
  for (const [key, pattern] of implied) if (pattern.test(text)) {
    const app = apps.find(a => a.id === catalog.defaults?.[key]); if (app) found.set(app.id, app);
  }
  return [...found.values()];
}
// These conditional lines are inventoried separately so they add nothing to the ordinary prompt.
export const upfrontAsk = apps => apps.length ? `sleight: Ask the user to reply: allow ${apps.map(a => a.name).join(', ')}` : undefined;
export const physicalApprovalNotice = 'This step needs the user at the Mac. Approval requires physical input. The card remains open.';
export const remoteApprovalNotice = app => `"${app}" needs approval on the Mac. Ask the user to reply: allow ${app}`;

export function createRemoteApprovals({ run }) {
  return {
    presence: () => run('remote-approvals.js', { operation: 'presence' }),
    catalog: () => run('remote-approvals.js', { operation: 'catalog' }),
  };
}
