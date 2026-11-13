import { createCompoundParent } from './parent.mjs';
import { parseCompoundIntent } from './intent.mjs';
import { compoundBinding, resolveCompoundExact, validateCompoundObservation } from './observation.mjs';

// A rendered row is evidence of printed text only. This parser never invents
// native identity, raw-field provenance, completeness or platform ownership.
const roles = [['menu bar item', 'AXMenuBarItem'], ['menu item', 'AXMenuItem'], ['pop up button', 'AXPopUpButton'],
  ['menu bar', 'AXMenuBar'], ['menu', 'AXMenu'], ['standard window', 'AXWindow'], ['floating window', 'AXWindow'],
  ['text entry area', 'AXTextArea'], ['text field', 'AXTextField'], ['combo box', 'AXComboBox'], ['button', 'AXButton'],
  ['container', 'AXGroup'], ['sheet', 'AXSheet'], ['dialog', 'AXDialog'], ['toolbar', 'AXToolbar'], ['scroll area', 'AXScrollArea'],
  ['separator', 'AXSeparator'], ['text', 'AXStaticText']];
export function parseCompoundRecordedRows(text) {
  if (typeof text !== 'string') throw Error('INVALID_RECORDING');
  const frames = []; let nodes = [], stack = [], sparse = false, unknown = 0;
  const finish = () => { if (nodes.length) frames.push({ nodes, sparse, unknown }); nodes = []; stack = []; sparse = false; unknown = 0; };
  for (const line of text.split('\n')) {
    const match = /^(\t*)(\d+) (.*)$/.exec(line); if (!match) continue;
    const depth = match[1].length, number = Number(match[2]);
    if (number === 0 && nodes.length) finish();
    if (number !== nodes.length) sparse = true;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const body = match[3], parent = stack.at(-1)?.node;
    const explicit = roles.find(([name]) => body === name || body.startsWith(name + ' ') || body.startsWith(name + ','));
    const role = explicit?.[1] ?? (parent?.role === 'AXMenuBar' ? 'AXMenuBarItem' : parent?.role === 'AXMenu' ? 'AXMenuItem' : 'AXUnknown');
    if (role === 'AXUnknown') unknown++;
    const rest = body.slice(explicit?.[0].length ?? 0).replace(/^,? /, '').replace(/^\([^)]*\) ?/, '');
    const pieces = rest.split(/, (?=[A-Za-z][A-Za-z ]*:)/);
    const attr = name => pieces.find(p => p.startsWith(name + ':'))?.slice(name.length + 1).replace(/^ /, '') ?? null;
    const title = pieces[0] && !/^[A-Za-z][A-Za-z ]*:/.test(pieces[0]) ? pieces[0] : null;
    const node = { number, depth, token: `printed-${frames.length}-${number}`, parent: parent?.token ?? null, role,
      title, description: attr('Description'), help: attr('Help'), value: attr('Value'), identifier: attr('ID'),
      active: true, enabled: !/\(disabled(?:,|\))/.test(body), secure: /^secure /.test(body) };
    nodes.push(node); stack.push({ depth, node });
  }
  finish(); return frames;
}
export function resolveCompoundPrintedSelector(frame, selector, rolesAllowed, container) {
  const candidates = frame.nodes.filter(n => rolesAllowed.includes(n.role) && (container === undefined || n.parent === container) && n[selector.source] === selector.label);
  if (!candidates.length) return { status: 'missing' };
  const domains = new Map();
  for (const node of candidates) {
    try {
      const found = resolveCompoundExact({ nodes: frame.nodes }, { container: node.parent }, { ...selector, role: node.role });
      domains.set(node.parent, found);
    } catch (error) { return { status: error.code === 'AMBIGUOUS_STEP' ? 'ambiguous' : 'refused', reason: error.code }; }
  }
  return domains.size === 1 ? { status: 'unique', node: [...domains.values()][0] } : { status: 'ambiguous' };
}
export async function assessCompoundRecording({ kind, texts, intent: input, rawObservations = [], printedSelectors = [] }, services) {
  if (!['menu', 'choose', 'prepareSaveAs'].includes(kind) || !Array.isArray(texts) || texts.some(t => typeof t !== 'string'))
    throw Error('INVALID_RECORDING');
  const frames = texts.flatMap(parseCompoundRecordedRows), missing = [];
  let ambiguous = false, parsedSteps = 0, nativeReason;
  const intent = input ? parseCompoundIntent(input) : undefined;
  const selectors = intent?.operation === 'menu' ? intent.segments : intent?.operation === 'choose' ? [intent.option] : printedSelectors;
  for (const selector of selectors) {
    const resolved = frames.map(frame => resolveCompoundPrintedSelector(frame, selector, [selector.role]));
    ambiguous ||= resolved.some(r => r.status === 'ambiguous');
    if (resolved.some(r => r.status === 'unique')) parsedSteps++;
  }
  if (!intent) missing.push('INTENT_MISSING');
  if (!rawObservations.length) missing.push('RAW_FIELDS_MISSING', 'PROCESS_BINDING_MISSING', 'OWNER_RELATION_MISSING', 'COMPLETENESS_UNPROVEN');
  else {
    let lastRead = 0;
    for (const raw of rawObservations) {
      try {
        const bound = compoundBinding(raw.binding), snapshot = validateCompoundObservation(raw, bound, lastRead); lastRead = snapshot.readId;
      } catch (error) {
        nativeReason = error.code ?? 'INVALID_RECORDING'; ambiguous ||= nativeReason === 'AMBIGUOUS_STEP';
        missing.push(nativeReason); break;
      }
    }
  }
  if (services?.fake !== true) missing.push('MECHANISM_UNQUALIFIED', 'ADMISSION_UNPROVEN', 'POSTCONDITION_UNPROVEN');
  // A JSON recording cannot install trusted services. The optional fake service
  // bundle is supplied by the offline evaluator, outside serialized app data.
  // Complete native recordings then traverse the same parent/helper as input.
  let receipt, binding, mutations = 0;
  try { binding = compoundBinding(rawObservations[0]?.binding); } catch { /* Missing identity stays unproved. */ }
  if (intent && binding) {
    const supported = services?.fake === true && rawObservations.length > 0 && !nativeReason;
    const replayServices = supported ? { ...services, provider: { ...services.provider,
      perform(...args) { mutations++; return services.provider.perform(...args); },
    } } : undefined;
    const parent = createCompoundParent(supported ? replayServices : { admission: {
      consume: () => false, begin() { throw Object.assign(Error('OBSERVATION_INCOMPLETE'), { code: 'OBSERVATION_INCOMPLETE' }); },
      invalidate() {}, current() {},
    } });
    receipt = await parent.run(intent, binding);
  }
  const completed = ['completed', 'prepared'].includes(receipt?.state);
  const attempts = (receipt?.steps ?? []).reduce((n, step) => n + step.attempts, 0);
  const unprovable = missing.length > 0;
  return { eligible: !unprovable && (attempts > 0 || completed), completed, stoppedBeforeFirstInput: !completed && attempts === 0,
    stoppedAfterPrefix: !completed && attempts > 0, ambiguous,
    incomplete: frames.some(f => f.sparse || f.unknown) || missing.includes('COMPLETENESS_UNPROVEN') ||
      missing.includes('OBSERVATION_INCOMPLETE'), unprovable,
    reason: nativeReason ?? (ambiguous ? 'AMBIGUOUS_STEP' : receipt?.stop?.reason ?? (unprovable ? 'UNPROVABLE_RECORDING' : undefined)),
    missing: [...new Set(missing)], mutations, postedEvents: 0, clipboardAccesses: 0, turnsSaved: 0,
    diagnostics: { printedTreeRows: frames.reduce((n, f) => n + f.nodes.length, 0), frames: frames.length, parsedSteps,
      printedMenuRows: frames.reduce((n, f) => n + f.nodes.filter(x => ['AXMenu', 'AXMenuItem', 'AXMenuBarItem'].includes(x.role)).length, 0),
      truncationPrinted: texts.some(t => /truncated|read cap|walk limit/i.test(t)),
      saveSheetPrinted: frames.some(f => f.nodes.some(n => n.role === 'AXSheet' && /save|export/i.test(n.title ?? n.description ?? ''))) } };
}
export function summarizeCompoundReplay(rows) {
  const fields = ['eligible', 'completed', 'stoppedBeforeFirstInput', 'stoppedAfterPrefix', 'ambiguous', 'incomplete', 'unprovable'];
  return Object.fromEntries([['candidates', rows.length], ...fields.map(key => [key, rows.filter(r => r[key]).length]),
    ['mutations', rows.reduce((n, r) => n + r.mutations, 0)], ['turnsSaved', rows.reduce((n, r) => n + r.turnsSaved, 0)]]);
}
