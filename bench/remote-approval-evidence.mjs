// RA1 diagnostics only. Never read login/config/keychain files or persist a raw process environment.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { scrubText } from './release-pass.mjs';

export const FIRST_NOTICE_MS = 45000;
const sensitive = /(?:keychain|credential|password|secret|token|authorization|api[_-]?key|cookie)/i;
const privatePayload = /(?:keychain|\.credentials(?:\.json)?|security\s+(?:find|dump|export)|-----BEGIN [A-Z ]*PRIVATE KEY)/i;
const bytes = (text, limit) => {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, limit - 3)).replace(/\uFFFD$/, '') + '…';
};
export function scrubRemoteValue(value, { home = homedir(), names = [userInfo().username] } = {}) {
  if (typeof value === 'string') {
    if (privatePayload.test(value)) return '<redacted private payload>';
    return scrubText(value, home, names)
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '<redacted>')
      .replace(/\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, '<redacted>')
      .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer <redacted>')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>')
      .replace(/(["']?)([A-Za-z_][\w.-]{0,79})\1\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,}\n]+)/g,
        (match, _quote, key) => sensitive.test(key) ? key + ': <redacted>' : match);
  }
  if (Array.isArray(value)) return value.map(item => scrubRemoteValue(item, { home, names }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [scrubRemoteValue(key, { home, names }), sensitive.test(key) ? '<redacted>' : scrubRemoteValue(item, { home, names })]));
  return value;
}
const plain = block => typeof block.content === 'string' ? block.content
  : (Array.isArray(block.content) ? block.content : []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export function transcriptRows(events = [], options) {
  return events.flatMap(event => (event.message?.content ?? []).flatMap(block => {
    const base = { t: event.t, role: event.type };
    if (block.type === 'tool_use') return [{ ...base, type: 'tool_use', name: block.name, input: scrubRemoteValue(block.input, options) }];
    if (block.type === 'tool_result') return [{ ...base, type: 'tool_result', text: bytes(scrubRemoteValue(plain(block), options), 4096) }];
    if (block.type === 'text' && event.type === 'assistant') return [{ ...base, type: 'text', text: scrubRemoteValue(block.text, options) }];
    return [];
  }));
}

// Capture only trace routing/timing fields. Payloads, code, app content and account metadata never enter this trace.
export function createServerEvidence({ now = Date.now } = {}) {
  let stderr = '', privateSeen = false;
  const trace = [];
  return {
    stderr(chunk) {
      stderr += String(chunk);
      privateSeen ||= privatePayload.test(stderr);
      stderr = stderr.slice(-65536);
    },
    trace(direction, msg = {}) {
      const row = { t: now(), direction };
      for (const key of ['id', 'method', 'stage', 'helper', 'status', 'elapsedMs', 'cached'])
        if (['string', 'number', 'boolean'].includes(typeof msg[key])) row[key] = msg[key];
      trace.push(row); if (trace.length > 2000) trace.shift();
    },
    snapshot() { return { stderr: privateSeen ? '<redacted private payload>' : new TextDecoder().decode(Buffer.from(scrubRemoteValue(stderr)).subarray(-16384)).replace(/^\uFFFD+/, ''),
      trace: scrubRemoteValue(trace), stderrScope: 'MCP server JavaScript stderr; inherited engine stderr is unavailable' }; },
  };
}

export function noticeTiming(events = [], trace = [], submitAt, observedAt) {
  const firstToolAt = events.find(e => e.message?.content?.some(b => b.type === 'tool_use'))?.t;
  const firstResultAt = events.find(e => e.message?.content?.some(b => b.type === 'tool_result'))?.t;
  const noticeAt = events.find(e => e.message?.content?.some(b => b.type === 'tool_result' && plain(b).includes('needs approval on the Mac')))?.t;
  const noticeMs = Number.isFinite(noticeAt) && Number.isFinite(firstToolAt) ? noticeAt - firstToolAt : null;
  const noticeWaitMs = Number.isFinite(firstToolAt) && Number.isFinite(observedAt) ? observedAt - firstToolAt : null;
  const timing = { submitAt, firstToolAt: firstToolAt ?? null, firstResultAt: firstResultAt ?? null, noticeAt: noticeAt ?? null, noticeMs };
  if (noticeAt === undefined) timing.noticeWaitMs = noticeWaitMs;
  if ((noticeMs ?? noticeWaitMs) > 10000) {
    const components = [], unverified = [], pending = [];
    const interval = (component, from, to) => {
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) components.push({ component, ms: to - from, from, to });
      else {
        unverified.push(component);
        if (Number.isFinite(from) && !Number.isFinite(to) && Number.isFinite(observedAt) && observedAt >= from)
          pending.push({ component, from, observedAt, ms: observedAt - from });
      }
    };
    const started = trace.find(e => e.direction === 'engine-started');
    const init = trace.find(e => e.direction === 'to-server' && e.method === 'initialize');
    const ready = init && trace.find(e => e.direction === 'from-server' && e.id === init.id && !e.method && e.t >= init.t);
    interval('cold engine start', started?.t, ready?.t);
    const compile = trace.find(e => e.stage === 'compile' && e.helper === 'consent-host');
    const built = compile && trace.find(e => e.status === 'ready' && e.t >= compile.t);
    interval('consent host compile', compile?.t, built?.t);
    const call = trace.find(e => e.direction === 'to-server' && e.method === 'tools/call' && e.t >= firstToolAt);
    const elicitation = call && trace.find(e => e.direction === 'from-server' && e.method === 'elicitation/create' && e.t >= call.t);
    interval('approval elicitation', call?.t, elicitation?.t);
    if (elicitation) interval('approval notice delivery', elicitation.t, noticeAt);
    components.sort((a, b) => a.from - b.from);
    timing.slowNotice = { components, unverified, pending,
      basis: 'Trace intervals, not proof of CPU cost. Engine startup can precede submit; approval elicitation includes engine processing.' };
  }
  return timing;
}

function privateParents(path) {
  const parent = dirname(path);
  if (parent !== path) privateParents(parent);
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe evidence directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}
export function writeRemoteEvidence({ started, sessions = [], report = {} }, { root = join(homedir(), 'Library/Logs/sleight'), ...options } = {}) {
  const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
  root = resolve(root); privateParents(root);
  const directory = join(root, 'ra1-' + stamp);
  mkdirSync(directory, { mode: 0o700 });
  const selected = sessions.map(session => ({ rows: transcriptRows(session.rows, options),
    turns: (session.turns ?? []).map(turn => ({ ...noticeTiming(turn.rows, session.server?.trace, turn.submitAt, turn.observedAt),
      presence: { idleSeconds: turn.presence?.idleSeconds ?? null, locked: turn.presence?.locked ?? null },
      presenceError: turn.presenceError })),
    server: { stderr: session.server?.stderr ?? null, trace: session.server?.trace ?? [], stderrScope: session.server?.stderrScope },
    diagnosticError: session.diagnosticError }));
  for (const [file, value] of [['sessions.json', selected], ['failure.json', { error: report.error ?? null, prewarm: report.prewarm ?? null }]])
    writeFileSync(join(directory, file), JSON.stringify(scrubRemoteValue(value, options), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return directory;
}
