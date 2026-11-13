// Turn-end protocol and the benchmark-exit figures retained for one release.
import { parseModule } from '../../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs';
import { summarizeSamples } from './check4-measurement.mjs';

const actions = new Set(['click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'pressKey', 'typeText', 'paste',
  'setValue', 'selectText', 'performSecondaryAction']);
function bearsAction(call) {
  if (['drag', 'hover', 'select_window', 'open_file', 'menu_bar', 'app_handoff'].includes(call.name)) return true;
  if (call.name !== 'js') return false;
  if (typeof call.arguments?.code !== 'string') return null;
  try {
    const tree = parseModule(call.arguments.code, { next: true, module: true });
    const visit = node => {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
          actions.has(node.callee.computed ? node.callee.property?.value : node.callee.property?.name)) return true;
      return Object.values(node).some(value => Array.isArray(value) ? value.some(visit) : visit(value));
    };
    return visit(tree);
  } catch { return null; }
}

// The benchmark transcript retains untruncated tool input. Match its emission order to relay admission before
// classifying calls. A missing or reordered transcript leaves the ordinal unknown, never guessed from tool titles.
export function earlyScrollWitness({ trace, recordedCalls, hostTrace, start, end, epochToHost }) {
  const calls = trace.filter(e => e.direction === 'call-received' && e.msg?.params?.name && e.msg.params.name !== 'turn_ended' &&
    Number.isFinite(Date.parse(e.t))).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const frames = (hostTrace?.records ?? []).filter(r => r.input?.op === 'receive' && r.input?.event &&
    r.input.now * 1000 >= start && r.input.now * 1000 <= end).sort((a, b) => a.input.now - b.input.now);
  const scroll = frames.find(r => r.input.event.state === 'scroll' || r.input.event.wideReason === 'scroll');
  const absent = reason => ({ ordinal: null, withinFirstTwoActions: null, reason });
  if (!scroll) return absent('No host scroll frame during driving');
  if (!recordedCalls || recordedCalls.length !== calls.length || calls.some((e, i) => e.msg.params.name !== recordedCalls[i].name))
    return absent('Transcript calls do not match relay admission order');
  const open = calls.findIndex(e => e.msg.params.name === 'open_file');
  if (open < 0) return absent('No open_file admission');
  const time = scroll.input.now * 1000;
  // A frame belongs to a call only while that request is outstanding. Thinking between calls is not an action.
  const owners = calls.flatMap((call, i) => {
    const reply = trace.find(e => e.direction === 'to-client' && e.msg?.id === call.msg.id && e.msg.result && Date.parse(e.t) >= Date.parse(call.t));
    return reply && time >= epochToHost(Date.parse(call.t)) && time <= epochToHost(Date.parse(reply.t)) ? [i] : [];
  });
  if (owners.length !== 1 || owners[0] <= open) return absent('Scroll frame has no unique action call after open_file');
  const owner = owners[0], flags = recordedCalls.slice(open + 1, owner + 1).map(bearsAction);
  if (flags.includes(null) || flags.at(-1) !== true) return absent('Action-bearing call evidence incomplete');
  const ordinal = flags.filter(Boolean).length;
  return { ordinal, withinFirstTwoActions: ordinal <= 2, callId: calls[owner].msg.id, tool: calls[owner].msg.params.name,
    hostFrameAt: time, basis: 'host receive inside relay call, transcript action input' };
}

export function turnEndReceipt(trace, startEpochMs, endEpochMs) {
  return trace.filter(e => e.msg?.params?.name === 'turn_ended' && (e.direction === 'call-received' ||
    e.direction === 'to-server' && e.msg?.method === 'tools/call'))
    .filter(e => Number.isFinite(Date.parse(e.t)) && Date.parse(e.t) > startEpochMs && Date.parse(e.t) <= endEpochMs)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))[0];
}

export function protocolFigures({ trace, recordedCalls, hostTrace, rows, start, end, startEpochMs, endEpochMs, epochToHost }) {
  const terminal = turnEndReceipt(trace, startEpochMs, endEpochMs);
  const turnEndEpochMs = terminal ? Date.parse(terminal.t) : endEpochMs, turnEnd = epochToHost(turnEndEpochMs);
  const figures = summarizeSamples(rows, { start, end: turnEnd });
  const exitFigures = summarizeSamples(rows, { start, end });
  return { exitDriving: { start, end, startEpochMs, endEpochMs, endSource: 'benchmark stamps.exitAt',
    durationMs: exitFigures.durationMs, visibleMs: exitFigures.visibleMs, visibleShare: exitFigures.visibleShare,
    fullStageShare: exitFigures.fullStageShare, visibleAnyRung: exitFigures.visibleAnyRung },
    turnEndedDriving: { start, end: turnEnd, startEpochMs, endEpochMs: turnEndEpochMs,
    endSource: terminal === undefined ? 'benchmark stamps.exitAt (no traced turn_ended)' : `relay turn_ended ${terminal.direction}`,
    durationMs: figures.durationMs, visibleMs: figures.visibleMs, visibleShare: figures.visibleShare,
    fullStageShare: figures.fullStageShare, visibleAnyRung: figures.visibleAnyRung },
    earlyScrollWitness: earlyScrollWitness({ trace, recordedCalls, hostTrace, start, end: turnEnd, epochToHost }) };
}
