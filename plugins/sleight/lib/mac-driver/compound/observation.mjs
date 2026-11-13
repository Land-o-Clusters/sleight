import { macIdentityError } from '../../repl/identity-steps.mjs';
import { createHash } from 'node:crypto';
import { COMPOUND_LIMITS, freezeCompound, requireCompound } from './intent.mjs';

export const COMPOUND_BINDING_FIELDS = Object.freeze(['bundleId', 'pid', 'processStart', 'helper', 'windowId',
  'root', 'document', 'responder', 'mainWindowId']);
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && x.isWellFormed() && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(x);
export function compoundBinding(value) {
  requireCompound(value && COMPOUND_BINDING_FIELDS.every(k => k === 'pid' ? Number.isSafeInteger(value[k]) && value[k] > 0 : text(value[k])),
    'IDENTITY_UNVERIFIED');
  return freezeCompound(Object.fromEntries(COMPOUND_BINDING_FIELDS.map(k => [k, value[k]])));
}
export function sameCompoundBinding(a, b) { return COMPOUND_BINDING_FIELDS.every(k => a?.[k] === b?.[k]); }
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) :
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const compoundEqual = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const compoundDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function validateCompoundObservation(observed, bound, previousRead = 0) {
  requireCompound(observed && Number.isSafeInteger(observed.readId) && observed.readId > previousRead &&
    Number.isSafeInteger(observed.epoch) && observed.epoch >= 0, 'INCOHERENT_OBSERVATION');
  if (!sameCompoundBinding(compoundBinding(observed.binding), bound)) throw macIdentityError('compound-binding');
  requireCompound(observed.complete === true && observed.coherent === true && observed.inventoryComplete === true &&
    Array.isArray(observed.gaps) && observed.gaps.length === 0 && Array.isArray(observed.nodes) &&
    observed.nodes.length <= COMPOUND_LIMITS.nodes, 'OBSERVATION_INCOMPLETE');
  requireCompound(Array.isArray(observed.modals) && observed.modals.length === 0, 'MODAL_APPEARED');
  requireCompound(observed.routing?.background === true && observed.routing?.focusChanged === false &&
    observed.routing?.blocked === false, 'BACKGROUND_UNAVAILABLE');
  const tokens = new Set();
  for (const node of observed.nodes) {
    requireCompound(text(node.token) && !tokens.has(node.token), 'INCOHERENT_OBSERVATION'); tokens.add(node.token);
    requireCompound(typeof node.role === 'string' && /^AX[A-Za-z]+$/.test(node.role) &&
      node.childrenComplete === true && typeof node.active === 'boolean' && typeof node.enabled === 'boolean' &&
      typeof node.selected === 'boolean' && typeof node.expanded === 'boolean' && typeof node.secure === 'boolean' &&
      Array.isArray(node.actions) && node.actions.every(text), 'OBSERVATION_INCOMPLETE');
    for (const field of ['subrole', 'title', 'description', 'help', 'value', 'identifier', 'keyEquivalent'])
      requireCompound(node[field] === null || typeof node[field] === 'string' && node[field].length <= 16384 && node[field].isWellFormed(),
        'OBSERVATION_INCOMPLETE');
    requireCompound(node.parent === null || typeof node.parent === 'string', 'OBSERVATION_INCOMPLETE');
    // Secure data must already have been omitted at the provider, before reads.
    if (node.secure) requireCompound(['title', 'description', 'help', 'value', 'identifier'].every(k => node[k] === null), 'SECURE_FIELD');
  }
  const parents = new Map(observed.nodes.map(n => [n.token, n.parent]));
  const nodeByToken = new Map(observed.nodes.map(n => [n.token, n]));
  for (const node of observed.nodes) {
    let current = node.token; const seen = new Set();
    while (current !== null) {
      requireCompound(parents.has(current) && !seen.has(current) && seen.size < 64, 'INCOHERENT_OBSERVATION'); seen.add(current); current = parents.get(current);
    }
    if ([...seen].some(token => nodeByToken.get(token)?.secure))
      requireCompound(['title', 'description', 'help', 'value', 'identifier'].every(k => node[k] === null), 'SECURE_FIELD');
  }
  requireCompound(observed.context && observed.domains && Array.isArray(observed.relations), 'OBSERVATION_INCOMPLETE');
  const modalNodes = observed.nodes.filter(n => n.active && ['AXSheet', 'AXDialog', 'AXPopover', 'AXAlert'].includes(n.role));
  requireCompound(modalNodes.every(n => observed.panel && n.token === observed.panel.token), 'OBSERVATION_INCOMPLETE');
  return freezeCompound(structuredClone(observed));
}

export function compoundDomain(snapshot, key, owner) {
  const domain = snapshot.domains[key];
  requireCompound(domain?.complete === true, key === 'options' ? 'OPTION_SET_INCOMPLETE' : 'OBSERVATION_INCOMPLETE');
  requireCompound(domain.active === true && typeof domain.container === 'string', 'UNEXPECTED_TRANSITION');
  const relations = snapshot.relations.filter(r => r.kind === key && r.child === domain.container);
  requireCompound(relations.length === 1 && relations[0].owner === owner && relations[0].root === snapshot.binding.root &&
    relations[0].document === snapshot.binding.document && relations[0].pid === snapshot.binding.pid &&
    relations[0].processStart === snapshot.binding.processStart && relations[0].proof === 'platform-owner', 'OWNER_UNPROVEN');
  return domain;
}
export function resolveCompoundExact(snapshot, domain, selector) {
  const matches = snapshot.nodes.filter(n => n.parent === domain.container && n.active && n.role === selector.role &&
    n[selector.source] === selector.label);
  requireCompound(matches.length < 2, 'AMBIGUOUS_STEP');
  requireCompound(matches.length === 1, 'STEP_NOT_FOUND');
  const node = matches[0];
  requireCompound(!node.secure, 'SECURE_FIELD'); requireCompound(node.enabled, 'STEP_DISABLED');
  return node;
}

// Whole-window dependencies are the default. Retained tokens make list reorder
// harmless; read IDs are freshness evidence, not semantic differences.
export function compoundMeaning(snapshot) {
  const value = structuredClone(snapshot); delete value.readId;
  value.nodes.sort((a, b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
  return value;
}
export function allowedCompoundDelta(before, after, allowedPaths) {
  const a = compoundMeaning(before), b = compoundMeaning(after); delete a.epoch; delete b.epoch;
  const omit = (value, path) => {
    let at = value;
    for (const key of path.slice(0, -1)) { if (!at || typeof at !== 'object') return; at = at[key]; }
    if (at && typeof at === 'object') delete at[path.at(-1)];
  };
  // Contract paths are trusted arrays of exact fields, never regexes or UI text.
  for (const path of allowedPaths) { omit(a, path); omit(b, path); }
  return compoundEqual(a, b);
}
