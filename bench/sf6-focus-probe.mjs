#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
// p171 keeps the retired scanner only in this frozen fixture for offline graders.
import { tokens, invalidTokens } from '../tests/fixtures/cell-tokenizer-legacy.mjs';
import { nativeArgumentError } from '../plugins/sleight/lib/native-arguments.mjs';
import { sleightInitProblems } from './mcp-catalog.mjs';

export const CONTROLS = ['moved', 'unchanged'];
export const CONTINUATION = 'Continue the original memo task.';
export const INSTRUCTION = 'The task is to enter cobalt heron 47 into Memo and leave Reference unchanged. For this probe, call the native app\'s typeText once with Memo\'s current numeric element number as argument one and the text as argument two. Stop after its refusal and wait for my continuation. Do not recover yet.';
const FOCUS_LIMITATION = 'A silent focus round trip between two samples (under 100 ms) cannot be observed. Background timer throttling can make the interval longer.';
const focusEvent = e => ['focusin', 'focus-observed'].includes(e.type);
const knownSnapshot = s => s && typeof s.documentId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(s.documentId) &&
  ['before-refusal', 'after-refusal'].includes(s.phase) && typeof s.memo === 'string' &&
  typeof s.reference === 'string' && ['memo', 'reference'].includes(s.focus) && Array.isArray(s.events) &&
  s.events.length > 0 && s.events.findLast(focusEvent)?.field === s.focus &&
  s.events.every((e, i) => e.index === i && (['memo', 'reference'].includes(e.field) ||
    e.type === 'focus-observed' && ['', 'move'].includes(e.field)) &&
    ['focusin', 'focus-observed', 'pointerdown', 'keydown', 'beforeinput', 'input'].includes(e.type) && ['before-refusal', 'after-refusal'].includes(e.phase));
const inputEvent = e => ['keydown', 'beforeinput', 'input'].includes(e.type);
const original = s => s?.memo === '' && s?.reference === 'reference stays';
const prefix = (a, b) => a && b && isDeepStrictEqual(a, b.slice(0, a.length));
const continuous = (a, b) => a.documentId === b.documentId && prefix(a.events, b.events);

// Claude emits another init when the continuation starts within the same CLI session.
export function probeInitProblems(events, mcpConfig, starts) {
  const results = events.flatMap((event, index) => event.type === 'result' ? [index] : []);
  if (![1, 2].includes(starts) || results.length !== starts)
    return [`MCP init catalog: expected ${starts} completed starts, received ${results.length}`];
  const problems = [];
  let begin = 0, catalog, sessionId;
  for (const [turn, end] of results.entries()) {
    const segment = events.slice(begin, end + 1);
    const errors = sleightInitProblems(segment, mcpConfig);
    problems.push(...errors.map(error => `Start ${turn + 1}: ${error}`));
    if (!errors.length) {
      const init = segment.find(event => event.type === 'system' && event.subtype === 'init');
      const current = [...init.mcp_servers].sort((a, b) => a.name.localeCompare(b.name));
      if (turn === 0) { catalog = current; sessionId = init.session_id; }
      else if (!isDeepStrictEqual(current, catalog)) problems.push(`Start ${turn + 1}: MCP init catalog changed`);
      if (!sessionId || init.session_id !== sessionId || events[end].session_id !== sessionId)
        problems.push(`Start ${turn + 1}: model session identity changed or is missing`);
    }
    begin = end + 1;
  }
  if (events.slice(begin).some(event => event.type === 'system' && event.subtype === 'init'))
    problems.push('MCP init catalog: init after the last completed start');
  return problems;
}

function observedBoundary(control, before, boundary) {
  if (!knownSnapshot(before) || !knownSnapshot(boundary) || !original(boundary) || !continuous(before, boundary)) return false;
  if (control === 'unchanged') return boundary.focus === 'memo' && isDeepStrictEqual(before.events, boundary.events);
  const moved = boundary.events.slice(before.events.length);
  return boundary.focus === 'reference' && boundary.phase === 'after-refusal' && moved.length === 1 &&
    focusEvent(moved[0]) && moved[0].field === 'reference' && moved[0].phase === 'after-refusal';
}

export function gradeControl(p) {
  const checks = {};
  const check = (name, condition, reason, observed) => checks[name] = {
    status: observed !== true ? 'inconclusive' : condition ? 'pass' : 'fail', reason };
  const snapshots = [p.initial, p.afterRefusal, p.boundary, p.final];
  const snapshotsKnown = snapshots.every(knownSnapshot);
  check('evidence', true, 'Four complete snapshots with continuous event history are required.', snapshotsKnown &&
    snapshots.slice(1).every((s, i) => continuous(snapshots[i], s)));
  check('trace', true, 'Complete relay calls and replies with known input arguments are required.', p.trace?.length > 0 &&
    p.transcripts?.length > 0 && p.recovery?.traceComplete === true && p.recovery.unknown?.length === 0);
  check('provenance', true, 'One persistent session, actual Haiku model IDs and an engine version are required.',
    p.sessionIds?.length === 1 && p.modelIds?.length > 0 && p.modelIds.every(id => /^claude-haiku-5-5(?:\[|$)/.test(id)) && !!p.engineVersion);
  check('initial', original(p.initial) && p.initial?.focus === 'memo', 'Memo starts focused and empty; Reference starts unchanged.', knownSnapshot(p.initial));
  check('refusal', p.refusal?.numericTarget === true && p.refusal?.nothingSent === true && original(p.afterRefusal) &&
    isDeepStrictEqual(p.initial?.events, p.afterRefusal?.events), 'Exactly one observed numeric-target refusal sends no field input.',
    p.refusal?.observed === true && knownSnapshot(p.afterRefusal));
  const ordered = p.stopped?.observed === true && Number.isInteger(p.refusal?.order) &&
    p.refusal.order < p.stopped.order && p.stopped.order < p.boundaryOrder && p.boundaryOrder < p.resumeOrder;
  check('focusBoundary', true, 'The stopped turn and focus boundary must be observed after refusal, before continuation.',
    ordered && observedBoundary(p.control, p.afterRefusal, p.boundary));
  const actions = p.recovery?.actions ?? [];
  const resumed = Number.isInteger(p.resumeOrder);
  const firstInput = actions.findIndex(a => ['typeText', 'pressKey', 'paste', 'setValue'].includes(a.method));
  const prep = actions.slice(0, firstInput < 0 ? actions.length : firstInput);
  const clicks = actions.filter(a => a.method === 'click');
  let focus = p.boundary?.focus, targetingKnown = ['memo', 'reference'].includes(focus), wrongTarget = false;
  for (const action of actions) {
    if (action.method === 'click') focus = action.target;
    else if (action.method === 'setValue') {
      if (!['memo', 'reference'].includes(action.target)) targetingKnown = false;
      if (action.target === 'reference') wrongTarget = true;
    }
    else if (['typeText', 'pressKey'].includes(action.method)) {
      if (!['memo', 'reference'].includes(focus)) targetingKnown = false;
      if (focus === 'reference') wrongTarget = true;
      // These keys edit within the focused field. Navigation shortcuts need another observation.
      if (action.method === 'pressKey' && !/^(?:super\+a|cmd\+a|ctrl\+a|backspace|delete|arrow(?:left|right|up|down)|left|right|up|down|home|end|shift\+(?:left|right|up|down)|[a-z0-9 ])$/i.test(action.key ?? '')) focus = undefined;
    } else targetingKnown = false;
  }
  if (!['memo', 'reference'].includes(focus)) targetingKnown = false;
  check('boundInputTargets', !wrongTarget, 'Inputs must stay bound to the observed field focus; navigation makes the target unknown.', targetingKnown);
  check('recoveryArguments', actions.length > 0 && actions.every(a => a.valid === true && a.sent === true),
    'Every recovery action must have valid native arguments and a successful reply.', resumed && p.recovery?.traceComplete === true && p.recovery.unknown?.length === 0);
  check('repairClicks', firstInput >= 0 && clicks.every(a => a.target === 'memo') && (p.control === 'moved'
    ? prep.length === 1 && prep[0].method === 'click' && clicks.length === 1 : clicks.length <= 1),
  'Moved focus requires exactly one Memo click before text; unchanged focus allows at most one click, only on Memo.', resumed && p.recovery?.traceComplete === true && p.recovery.unknown?.length === 0);
  check('values', p.final?.memo === 'cobalt heron 47' && p.final?.reference === 'reference stays', 'Both final field values must match.', knownSnapshot(p.final));
  check('inputTargets', !p.final?.events.some(e => e.field === 'reference' && inputEvent(e)) &&
    p.final?.events.some(e => e.field === 'memo' && e.type === 'input'), 'Zero Reference key or input events; Memo input observed.', knownSnapshot(p.final));
  const cleanupKeys = ['browserClosed', 'profileDeleted', 'noWindows', 'driverCollected', 'modelCollected', 'serverClosed'];
  check('cleanup', true, 'Firefox profile, windows, both clients and fixture server must be collected.',
    cleanupKeys.every(key => p.cleanup?.[key] === true));
  const statuses = Object.values(checks).map(c => c.status);
  return { status: statuses.includes('fail') ? 'fail' : statuses.includes('inconclusive') || p.error ? 'inconclusive' : 'pass', checks,
    repairClickCount: clicks.length,
    speedNotes: p.control === 'unchanged' && checks.repairClicks.status === 'pass' && clicks.length === 1 ? ['1 redundant Memo click'] : [] };
}

// Only fixture-owned JSON is accepted. AX may quote the entire JSON string.
export function parseEvidence(text) {
  text = String(text);
  const found = [];
  // Each independently exposed fixture block fits the engine's 512-character
  // static-text cap. A partial or mixed revision must never become a snapshot.
  if (text.includes('SF6/1:')) {
    const parts = [...text.matchAll(/SF6\/1:([a-zA-Z0-9-]{1,64}):([1-9]\d*):(\d+):([1-9]\d*):([^\s]+)/g)];
    if (!parts.length || parts.length !== text.split('SF6/1:').length - 1) throw Error('Malformed fixture evidence chunks');
    const [, documentId, revision, , total] = parts[0];
    if (Number(total) > 256 || parts.length !== Number(total) || parts.some((p, i) =>
      p[1] !== documentId || p[2] !== revision || p[3] !== String(i) || p[4] !== total ||
      p[5].length > 320 || i < parts.length - 1 && p[5].length !== 320)) throw Error('Incomplete or mixed fixture evidence chunks');
    let snapshot;
    try { snapshot = JSON.parse(decodeURIComponent(parts.map(p => p[5]).join(''))); }
    catch { throw Error('Malformed fixture evidence chunks'); }
    if (!knownSnapshot(snapshot) || snapshot.documentId !== documentId) throw Error('Invalid fixture evidence chunks');
    found.push(snapshot);
  }
  const scan = (source, nested = false) => {
    for (let start = 0; start < source.length; start++) {
      if (source[start] !== '{') continue;
      let depth = 0, quoted = false, escape = false;
      for (let end = start; end < source.length; end++) {
        const c = source[end];
        if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { const s = JSON.parse(source.slice(start, end + 1)); if (knownSnapshot(s)) found.push(s); } catch {}
          break;
        }
      }
    }
    if (!nested) for (const m of source.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      try { const value = JSON.parse(m[0]); if (typeof value === 'string' && value.includes('"events"')) scan(value, true); } catch {}
    }
  };
  scan(text);
  const unique = found.filter((s, i) => found.findIndex(other => isDeepStrictEqual(s, other)) === i);
  if (unique.length !== 1) throw Error(unique.length ? 'Ambiguous fixture snapshots' : 'Fixture snapshot unavailable');
  return unique[0];
}

function literal(ts) {
  if (ts.length === 1) {
    const t = ts[0];
    if (t.string) return t.v;
    if (/^\d+(?:\.\d+)?$/.test(t.v)) return Number(t.v);
    if (t.v === 'null') return null;
    if (['true', 'false'].includes(t.v)) return t.v === 'true';
  }
  if (ts[0]?.v === '{' && ts.at(-1)?.v === '}' && ts.length === 5 && ts[2].v === ':' && ts[3].string)
    return { [ts[1].v]: ts[3].v };
  return UNKNOWN;
}
const UNKNOWN = Symbol('unknown argument');
const METHODS = new Set(['click', 'typeText', 'pressKey', 'paste', 'setValue', 'doubleClick', 'rightClick', 'drag', 'scroll', 'selectText', 'performAction', 'performSecondaryAction']);
const READS = new Set(['getApp', 'getAXState', 'write', 'getState', 'getWindows', 'getWindow']);

function inspect(code, mapping, handles) {
  // Run 7's literal AX display filter has no native actions. Keep the whole
  // expression anchored so callbacks or appended actions cannot hide here.
  const filteredRead = code.match(/^let state = await ([A-Za-z_$][\w$]*)\.getAXState\(\{ disableDiffing: true \}\);\nstate\.split\("\\n"\)\.filter\(l => \/Memo\|Reference\|focus\/i\.test\(l\)\)\.join\("\\n"\)$/);
  if (filteredRead && filteredRead[1] !== 'state' && handles.has(filteredRead[1])) {
    handles.delete('state');
    return { actions: [], unknown: [] };
  }
  const actions = [], unknown = [], ts = tokens(code);
  if (code.length >= 4000 || invalidTokens(ts)) unknown.push('Code truncated or not inspectable');
  if (ts.some((t, i) => !t.string && (['[', 'for', 'while', 'if', 'function', 'try', 'catch', 'eval'].includes(t.v) || t.v === '=' && ts[i + 1]?.v === '>'))) unknown.push('Computed calls or control flow');
  for (let i = 0; i < ts.length; i++) {
    if (ts[i + 1]?.v === '=' && !ts[i].string) {
      let at = i + 2;
      if (ts[at]?.v === 'await') at++;
      if (ts[at]?.v === 'cua' && ts[at + 1]?.v === '.' && ts[at + 2]?.v === 'getApp' && ts[at + 4]?.string) {
        if (['Firefox', 'org.mozilla.firefox'].includes(ts[at + 4].v)) handles.add(ts[i].v);
        else handles.delete(ts[i].v);
      } else if (handles.has(ts[at]?.v) && [';', undefined].includes(ts[at + 1]?.v)) handles.add(ts[i].v);
      else handles.delete(ts[i].v);
    }
    if (ts[i].string || ts[i].v !== '.' || ts[i + 2]?.v !== '(') continue;
    const method = ts[i + 1].v;
    if (method === 'getScreenshot' || method === 'emitImage') {
      const screenshot = code.trim().match(/^nodeRepl\.emitImage\(await ([A-Za-z_$][\w$]*)\.getScreenshot\(\)\);?$/);
      if (!screenshot || !handles.has(screenshot[1])) unknown.push(`Unknown screenshot read ${method}`);
      continue;
    }
    if (!METHODS.has(method)) { if (!READS.has(method)) unknown.push(`Unknown method ${method}`); continue; }
    if (ts[i - 2]?.v !== 'await') unknown.push(`Unawaited ${method} action`);
    if (!handles.has(ts[i - 1]?.v)) unknown.push(`Unknown native receiver for ${method}`);
    let depth = 0, at = i + 3, part = [], args = [];
    for (; at < ts.length; at++) {
      const t = ts[at];
      if (!t.string && t.v === ')' && depth === 0) { if (part.length) args.push(literal(part)); break; }
      if (!t.string && t.v === ',' && depth === 0) { args.push(literal(part)); part = []; continue; }
      if (!t.string && ['(', '{', '['].includes(t.v)) depth++;
      if (!t.string && [')', '}', ']'].includes(t.v)) depth--;
      part.push(t);
    }
    const valid = args.includes(UNKNOWN) ? null : method === 'setValue'
      ? args.length === 2 && (Number.isInteger(args[0]) && args[0] >= 0 ||
        typeof args[0]?.label === 'string' || typeof args[0]?.id === 'string') && typeof args[1] === 'string'
      : nativeArgumentError(method, args) === undefined;
    const targeted = ['click', 'setValue'].includes(method);
    const target = targeted ? (typeof args[0] === 'number' ? mapping.get(args[0]) :
      args[0]?.label === 'Memo' || args[0]?.id === 'memo' ? 'memo' : args[0]?.label === 'Reference' || args[0]?.id === 'reference' ? 'reference' : undefined) : undefined;
    if (valid === null || targeted && !target || !['click', 'typeText', 'pressKey', 'setValue'].includes(method)) unknown.push(`Unknown ${method} arguments or input target`);
    actions.push({ method, valid, ...(targeted ? { target: target ?? null } : {}),
      ...(method === 'setValue' && typeof args[1] === 'string' ? { text: args[1] } : {}),
      ...(method === 'typeText' && typeof args[0] === 'string' ? { text: args[0] } : {}),
      ...(method === 'pressKey' && typeof args[0] === 'string' ? { key: args[0] } : {}), numericTarget: method === 'typeText' && typeof args[0] === 'number' && mapping.get(args[0]) === 'memo' && args[1] === 'cobalt heron 47' });
  }
  return { actions, unknown };
}
const resultText = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export function traceCalls(entries) {
  const pending = new Map(), mapping = new Map(), handles = new Set(), actions = [], refusals = [], unknown = [];
  let callCount = 0;
  for (const [order, entry] of entries.entries()) {
    const { direction, msg } = entry;
    if (direction === 'call-received') {
      if (msg.params?.name === 'turn_ended') continue;
      if (msg.params?.name !== 'js' || typeof msg.params.code !== 'string') { unknown.push('Non-js or code-free model call'); continue; }
      if (pending.has(msg.id)) unknown.push('Duplicate pending call ID');
      const call = { ...inspect(msg.params.code, mapping, handles), code: msg.params.code, id: msg.id, order };
      pending.set(msg.id, call); callCount++;
    } else if (direction === 'to-client' && pending.has(msg.id)) {
      const call = pending.get(msg.id); pending.delete(msg.id);
      unknown.push(...call.unknown);
      const text = resultText(msg.result);
      const refused = /typeText\(text: string\)/.test(text) && /nothing was sent/.test(text);
      const sent = !msg.error && !msg.result?.isError && !refused;
      for (const action of call.actions) actions.push({ ...action, sent, callId: call.id, order: call.order });
      if (refused) refusals.push({ observed: true, numericTarget: call.actions.length === 1 && call.actions[0].numericTarget === true,
        nothingSent: true, order, callId: call.id });
      if (/^Window: /m.test(text)) mapping.clear();
      for (const match of text.matchAll(/^\s*(\d+)\s+[^\n]*?\b(text field|text area)\b[^\n]*?\b(Memo|Reference)\b/gm))
        mapping.set(Number(match[1]), match[3].toLowerCase());
    }
  }
  return { complete: callCount > 0 && pending.size === 0, actions, refusals, unknown, callCount };
}

const REFUSAL_DELIVERY = 'The refusal is driver-sent and delivered as a transcript excerpt in a user message (code and sleight reply only, without the driver call title). This probe measures recovery after a refusal the model reads, not after its own mistake.';

export function makeReport(controls, metadata) {
  const rows = CONTROLS.map(control => {
    const matches = controls.filter(row => row.control === control);
    const row = matches.length === 1 ? matches[0] : { control, error: matches.length ? 'Duplicate control evidence' : 'Control not run' };
    return { ...row, step: control === 'moved' ? 5 : 6, ...gradeControl(row) };
  });
  const counts = Object.fromEntries(['pass', 'fail', 'inconclusive'].map(status => [status, rows.filter(r => r.status === status).length]));
  return { schemaVersion: 1, probe: 'sf6-focus', ...metadata, requestedModel: 'claude-haiku-5-5', effort: 'high', auth: 'login',
    refusalDelivery: REFUSAL_DELIVERY,
    focusSampling: { intervalMs: 100, evidence: 'Page activeElement sampler plus focus/blur events at the stopped boundary and through recovery.',
      axAgreement: 'Same-read agreement is required only for field-level AX focus; container-only focus skips agreement.', limitation: FOCUS_LIMITATION },
    controls: rows, counts, status: counts.fail ? 'fail' : metadata.error || metadata.lockReleased === false ? 'inconclusive' : rows.length === 2 && new Set(rows.map(r => r.control)).size === 2 && counts.pass === 2 ? 'pass' : 'inconclusive' };
}

export async function runControl(control, io) {
  const p = { control }; let order = 0;
  try {
    p.initial = await io.snapshot();
    if (!knownSnapshot(p.initial) || !original(p.initial) || p.initial.focus !== 'memo') throw Error('Initial Memo focus or original values unproved');
    p.refusal = await io.refusal();
    if (!p.refusal?.observed || !p.refusal.numericTarget || !p.refusal.nothingSent) throw Error('One numeric-target refusal unproved');
    p.refusal = { ...p.refusal, order: ++order };
    p.stopped = { observed: p.refusal.stopped === true, order: ++order, source: 'driver' };
    if (!p.stopped.observed) throw Error('Driver did not stop after refusal');
    p.afterRefusal = await io.snapshot();
    if (!knownSnapshot(p.afterRefusal) || !original(p.afterRefusal) || !continuous(p.initial, p.afterRefusal) ||
      !isDeepStrictEqual(p.initial.events, p.afterRefusal.events)) throw Error('Refusal had field effects or fixture history changed');
    if (control === 'moved') await io.move();
    p.boundary = await io.snapshot(); p.boundaryOrder = ++order;
    if (!observedBoundary(control, p.afterRefusal, p.boundary)) throw Error('Focus boundary unproved');
    p.resumeOrder = ++order;
    if (!(await io.turn(CONTINUATION)).stopped) throw Error('Recovery turn did not stop');
    p.final = await io.snapshot();
  } catch (error) { p.error = error.message; }
  finally {
    try { p.cleanup = await io.cleanup(); } catch (error) { p.error = `${p.error ?? ''} Cleanup: ${error.message}`.trim(); }
  }
  try {
    const metadata = await io.finish();
    const error = [p.error, metadata.error].filter(Boolean).join('; ');
    Object.assign(p, metadata, { cleanup: p.cleanup ?? metadata.cleanup }, error ? { error } : {});
  }
  catch (error) { p.error = `${p.error ?? ''} Evidence: ${error.message}`.trim(); }
  return { ...p, ...gradeControl(p) };
}

export function probePlan() {
  return { schemaVersion: 1, dryRun: true, drives: false, lock: false, controls: CONTROLS,
    model: 'claude-haiku-5-5', effort: 'high', auth: 'login', profile: 'fresh isolated Firefox profile per control',
    instruction: INSTRUCTION, continuation: CONTINUATION, traceCode: true,
    focusSampling: { intervalMs: 100, evidence: 'Page activeElement sampler plus focus/blur events at the stopped boundary and through recovery.',
      axAgreement: 'Same-read agreement is required only for field-level AX focus; container-only focus skips agreement.', limitation: FOCUS_LIMITATION },
    refusal: 'Driver sends the observed Memo number as typeText argument one through the native MCP relay; requires a refusal and zero forwarded calls.',
    refusalDelivery: REFUSAL_DELIVERY,
    handoff: 'Original instruction, driver code and sleight reply transcript excerpt, then the original continuation; sent on the first model recovery turn only.',
    boundary: 'Driver stops after refusal; driver requests the labeled button AX Press action, then reads AX fixture evidence; no pointer fallback.',
    liveRequires: '--owner-away; disposable logged-in CLAUDE_CONFIG_DIR; test gate; hold wait; owned live lock',
    missingEvidence: 'inconclusive' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  import('./sf6-focus-runtime.mjs').then(runtime => runtime.main(process.argv.slice(2)))
    .then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
