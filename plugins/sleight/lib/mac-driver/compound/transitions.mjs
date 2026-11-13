import { COMPOUND_TRANSITIONS } from './contracts.mjs';
import { compoundEqual, compoundMeaning, compoundDomain } from './observation.mjs';
import { requireCompound } from './intent.mjs';

const node = (snapshot, token) => snapshot.nodes.find(n => n.token === token);
const equalEffect = (expected, after) => {
  expected.epoch = after.epoch;
  return compoundEqual(compoundMeaning(expected), compoundMeaning(after));
};
const destination = panel => (panel.directory.path === '/' ? '' : panel.directory.path) + '/' + panel.basename;
function descendant(snapshot, token, ancestor) {
  const seen = new Set();
  while (token !== null && !seen.has(token)) {
    if (token === ancestor) return true;
    seen.add(token); token = node(snapshot, token)?.parent ?? null;
  }
  return false;
}
function revealOwnedDomain(expected, after, key, owner, allowedNewRoles) {
  const domain = compoundDomain(after, key, owner), container = node(after, domain.container);
  requireCompound(container?.role === (key === 'panel' ? 'AXSheet' : 'AXMenu'), 'UNSUPPORTED_TRANSITION');
  requireCompound(domain.active === true && container.active === true, 'EFFECT_UNVERIFIED');
  const existing = new Set(expected.nodes.map(n => n.token));
  for (const candidate of after.nodes) if (!existing.has(candidate.token)) {
    requireCompound(descendant(after, candidate.token, domain.container) && allowedNewRoles.includes(candidate.role), 'EFFECT_UNVERIFIED');
    expected.nodes.push(structuredClone(candidate));
  }
  for (const n of expected.nodes) if (n.token === domain.container || n.parent === domain.container) n.active = true;
  expected.domains[key] = structuredClone(domain);
  const relations = after.relations.filter(r => r.kind === key && r.child === domain.container);
  const previous = expected.relations.filter(r => r.kind === key && r.child === domain.container);
  if (!previous.length) expected.relations.push(structuredClone(relations[0]));
  else requireCompound(compoundEqual(previous, relations), 'EFFECT_UNVERIFIED');
  return domain;
}

// Construct only in reviewed embedding code, with its independent mechanism
// qualification. A role, action name or caller-written safe flag cannot call
// this factory through any model or native schema. Production constructs zero.
// These postconditions constrain observable effects; they do not prove arbitrary
// callbacks safe or make separate AX reads and actions atomic.
export function createCompoundTransitionContract({ id, kind, token, controlToken,
  display = 'stable-title', dependentChanges = [], qualifies, basis }) {
  const shape = COMPOUND_TRANSITIONS[kind];
  requireCompound(shape && typeof token === 'string' && typeof qualifies === 'function' &&
    ['stable-title', 'value-as-title'].includes(display) && Array.isArray(dependentChanges), 'INVALID_CONTRACT');
  const deltas = structuredClone(dependentChanges);
  requireCompound(deltas.every(d => d && typeof d.token === 'string' &&
    ['enabled', 'value', 'title', 'description'].includes(d.field) && Object.hasOwn(d, 'from') && Object.hasOwn(d, 'to')),
    'INVALID_CONTRACT');
  return {
    id, version: 1, kind, primitive: shape[0], effectClass: shape[1], background: true, noClipboard: true,
    scope: 'whole-window', basis,
    qualifies(context) { return context.transition.node.token === token && qualifies(context) === true; },
    effect({ before, after, transition, intent }) {
      try {
        const expected = structuredClone(before), target = node(expected, token);
        requireCompound(target && transition.node.token === token, 'EFFECT_UNVERIFIED');
        let code;
        if (kind === 'menu.open' || kind === 'menu.expand') {
          requireCompound(after.domains.menu?.container !== before.domains.menu?.container, 'EFFECT_UNVERIFIED');
          revealOwnedDomain(expected, after, 'menu', token, ['AXMenu', 'AXMenuItem', 'AXSeparator']);
          target.expanded = true; code = kind === 'menu.open' ? 'menu-open-observed' : 'submenu-open-observed';
        } else if (kind === 'menu.command' || kind === 'menu.direct') {
          // Initial terminal contract: local Find UI in the existing document.
          // New windows, sheets and replacement commands have no such contract.
          requireCompound(compoundEqual(after.findUI, { document: before.binding.document,
            fields: ['find', 'replace'], localOnly: true }), 'EFFECT_UNVERIFIED');
          expected.findUI = structuredClone(after.findUI);
          for (const n of kind === 'menu.direct' ? [] : expected.nodes) {
            if (n.role === 'AXMenuBarItem' || n.role === 'AXMenuItem') n.expanded = false;
            if (n.role === 'AXMenu' || n.role === 'AXMenuItem') n.active = false;
          }
          requireCompound(expected.domains.menu, 'EFFECT_UNVERIFIED');
          if (kind !== 'menu.direct') expected.domains.menu.active = false;
          code = 'find-ui-observed';
        } else if (kind === 'choose.open') {
          requireCompound(target.role === 'AXPopUpButton', 'EFFECT_UNVERIFIED');
          revealOwnedDomain(expected, after, 'options', token, ['AXMenu', 'AXMenuItem', 'AXSeparator']);
          target.expanded = true; code = 'options-open-observed';
        } else if (kind === 'choose.select') {
          const domain = compoundDomain(before, 'options', controlToken), control = node(expected, controlToken);
          requireCompound(control?.role === 'AXPopUpButton' && target[intent.option.source] === intent.option.label &&
            after.domains.options?.container === domain.container && after.domains.options?.complete === true &&
            after.domains.options?.active === false, 'EFFECT_UNVERIFIED');
          control.value = intent.option.label; control.expanded = false;
          if (display === 'value-as-title') control.title = intent.option.label;
          for (const n of expected.nodes) {
            if (n.parent === domain.container) { n.selected = n.token === token; n.active = false; }
            if (n.token === domain.container) n.active = false;
          }
          expected.domains.options.active = false;
          if (before.selection !== undefined) expected.selection = { complete: true, control: controlToken,
            source: intent.option.source, label: intent.option.label };
          for (const change of deltas) {
            const dependent = node(expected, change.token);
            requireCompound(dependent && compoundEqual(dependent[change.field], change.from), 'EFFECT_UNVERIFIED');
            dependent[change.field] = structuredClone(change.to);
          }
          code = 'selection-observed';
        } else if (kind === 'save.open') {
          const panel = after.panel;
          requireCompound(!before.panel && panel?.standard === true && panel.acquired === true &&
            panel.attachedTo === before.binding.document && panel.pid === before.binding.pid &&
            panel.processStart === before.binding.processStart && panel.conflict === false &&
            panel.authentication === false && panel.commitSent === false, 'EFFECT_UNVERIFIED');
          revealOwnedDomain(expected, after, 'panel', before.binding.root,
            ['AXSheet', 'AXTextField', 'AXButton', 'AXPopUpButton', 'AXStaticText', 'AXGroup']);
          expected.panel = structuredClone(panel); code = 'save-panel-observed';
        } else {
          requireCompound(target.role === 'AXTextField' && target.actions.includes('AXSetValue') && before.panel && after.panel &&
            before.panel.token === after.panel.token && after.panel.commitSent === false && after.panel.conflict === false &&
            after.panel.authentication === false && after.panel.extensionChanged === false && after.panel.formatChanged === false,
            'EFFECT_UNVERIFIED');
          target.value = transition.value;
          if (kind === 'save.directory') {
            const directory = after.panel.directory;
            requireCompound(transition.value === intent.directory && directory?.path === intent.directory &&
              directory.kind === 'literal-local' && directory.resolved === true && typeof directory.identity === 'string' &&
              directory.identity.length > 0, 'DESTINATION_UNVERIFIED');
            expected.panel.directory = structuredClone(directory);
          } else {
            requireCompound(kind === 'save.basename' && transition.value === intent.basename, 'INVALID_CONTRACT');
            expected.panel.basename = intent.basename;
          }
          expected.panel.destination = destination(expected.panel); code = 'panel-field-observed';
        }
        return { observed: equalEffect(expected, after), code };
      } catch (error) { return { observed: false, code: 'effect-unverified', reason: error.code }; }
    },
  };
}
