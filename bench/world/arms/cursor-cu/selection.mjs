// Pure selection contract shared by the CLI and desktop driver.
import { CURSOR_PIN, resolveModel } from './contract.mjs';

const roots = new Set(['contextAttachments', 'attachments', 'context', 'selectedContext', 'subagentType', 'selectedSubagents', 'selectedMcp', 'mcp', 'target', 'environment', 'location', 'computerUse', 'isComputerUse']);
// Field names are data too. Keep only known schema keys, never dynamic identifiers.
const markerKeys = new Set([...roots, 'type', 'kind', 'name', 'provider', 'providerIdentifier', 'targetType']);
const shapeKeys = new Set([...markerKeys, 'composer', 'bubbles', 'modelConfig', 'selectedModels', 'parameters', 'maxMode', 'value',
  'status', 'generatingBubbleIds', 'fullConversationHeadersOnly', 'timingInfo', 'clientStartTime', 'clientSettleTime',
  'toolFormerData', 'toolCall', 'tool', 'case', 'args', 'result', 'params', 'additionalData', 'operation', 'details', 'computerUseApp', 'success', 'isError']);
const values = { attachment: ['computer-use', 'computerUse', 'Computer Use', 'cursor-computer-use'], target: ['local', 'This Mac', 'this-mac'] };
const safePath = path => Array.isArray(path) && path.length > 0 && path.length < 16 && roots.has(path[0]) &&
  path.every(k => (Number.isSafeInteger(k) && k >= 0 && k < 100) || markerKeys.has(k));
const at = (row, path) => path.reduce((v, k) => v?.[k], row);
function markers(row, kind) {
  const found = [];
  const walk = (v, path) => {
    if (!safePath(path)) return;
    if (values[kind].includes(v)) { found.push({ path, value: v }); return; }
    if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) walk(child, [...path, Array.isArray(v) ? Number(key) : key]);
  };
  for (const [key, value] of Object.entries(row)) walk(value, [key]);
  if (found.length !== 1) throw Error(`Cursor calibration ${kind} marker missing or ambiguous in persisted selection`);
  return found[0];
}
function shape(value, depth = 0) {
  if (depth > 12) return 'nested';
  if (Array.isArray(value)) return [...new Map(value.map(v => { const s = shape(v, depth + 1); return [JSON.stringify(s), s]; })).values()];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => shapeKeys.has(k))
    .map(([k, v]) => [k, shape(v, depth + 1)]));
  return value === null ? 'null' : typeof value;
}
export function makeCalibration(composer, { settled, ownerModelLabel, bubbles = [] } = {}) {
  if (!settled) throw Error('Cursor calibration requires a settled harmless turn');
  if (ownerModelLabel !== 'Grok 4.7 High') throw Error('Cursor calibration requires the visible Grok 4.7 High selection');
  const id = composer.modelConfig?.selectedModels?.[0]?.modelId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(id) || /^(auto|default)$/i.test(id)) throw Error('unsupported calibrated model id');
  const resolved = resolveModel(composer.modelConfig, { modelId: id });
  // Save only the parameters the benchmark uses, never account-supplied freeform metadata.
  const model = { ...resolved, parameters: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }] };
  const selection = { model, attachment: markers(composer, 'attachment'), target: markers(composer, 'target') };
  return validateCalibration({ version: 2, session: 'owner-installed', pin: CURSOR_PIN, selection, shapes: { composer: shape(composer), bubbles: shape(bubbles) } });
}
export function validateCalibration(c) {
  if (!c || c.version !== 2 || c.session !== 'owner-installed' || Object.keys(c).sort().join() !== 'pin,selection,session,shapes,version') throw Error('invalid Cursor calibration shape');
  for (const [k, v] of Object.entries(CURSOR_PIN)) if (c.pin?.[k] !== v) throw Error('Cursor calibration pin mismatch');
  if (Object.keys(c.pin).length !== Object.keys(CURSOR_PIN).length || Object.keys(c.selection ?? {}).sort().join() !== 'attachment,model,target') throw Error('invalid Cursor calibration shape');
  for (const kind of ['attachment', 'target']) {
    const marker = c.selection[kind];
    if (Object.keys(marker ?? {}).sort().join() !== 'path,value' || !safePath(marker.path) || !values[kind].includes(marker.value)) throw Error(`invalid calibration ${kind} marker`);
  }
  const m = c.selection.model;
  if (!m || Object.keys(m).sort().join() !== 'effort,label,model,parameters,speed' || m.label !== 'Grok 4.7 High' || m.effort !== 'high' || m.speed !== 'normal' ||
    typeof m.model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(m.model) || /^(auto|default)$/i.test(m.model) ||
    JSON.stringify(m.parameters) !== JSON.stringify([{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }])) throw Error('invalid calibration model shape');
  const checkShape = (v, depth = 0) => {
    if (depth > 16) throw Error('invalid calibration shape depth');
    if (typeof v === 'string') { if (!['string', 'number', 'boolean', 'undefined', 'null', 'nested'].includes(v)) throw Error('invalid calibration shape value'); }
    else if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) {
      if (!Array.isArray(v) && !shapeKeys.has(k)) throw Error('invalid calibration shape field');
      checkShape(child, depth + 1);
    } else throw Error('invalid calibration shape');
  };
  checkShape(c.shapes);
  return c;
}
export function verifySelection(composer, calibration) {
  const { selection } = validateCalibration(calibration), selected = composer?.modelConfig?.selectedModels;
  const actual = selected?.length === 1 && selected[0];
  const params = new Map((actual?.parameters ?? []).map(p => [p.id, p.value]));
  const differences = [];
  if (actual?.modelId !== selection.model.model) differences.push('model id differs');
  if (params.get('effort') !== 'high') differences.push('effort must be high');
  if (params.get('fast') !== 'false') differences.push('fast must be off');
  if (composer?.modelConfig?.maxMode === true) differences.push('model maxMode must be off');
  if (params.size !== (actual?.parameters ?? []).length) differences.push('model parameters are ambiguous');
  for (const kind of ['attachment', 'target']) if (at(composer, selection[kind].path) !== selection[kind].value) differences.push(`${kind} differs from calibration`);
  if (differences.length) throw Error('Cursor selection mismatch: ' + differences.join('; '));
  return resolveModel(composer.modelConfig, { modelId: selection.model.model });
}
